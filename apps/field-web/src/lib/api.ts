import { ReportInput, type RouteRecommendation } from "@floodrise/contracts";
import { z } from "zod";
import { DEMO_INCIDENT_ID, DEMO_SCENARIO_TIME, demoAlerts, demoRoutes, type FieldAlert } from "../data/demo";
import type { OfflineReportDraft, ReportReceipt } from "./db";
import {
  DEMO_FIELD_RUNTIME,
  type FieldRuntime,
  type LiveFieldRuntime,
} from "./field-runtime";
import {
  isLiveEligibleLocationAccuracy,
  MAX_LIVE_LOCATION_ACCURACY_M
} from "./location-policy";
import { isForcedOfflineMode } from "./network";
import { cloudFetch } from "./cloud-security";

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, "") ?? "/api/v1";
let activeFieldRuntime: FieldRuntime = DEMO_FIELD_RUNTIME;

export function configureFieldApiRuntime(runtime: FieldRuntime) {
  activeFieldRuntime = runtime;
}

export class ReportSubmissionError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs = 0
  ) {
    super(message);
    this.name = "ReportSubmissionError";
  }
}

class NonRetryableApiError extends ReportSubmissionError {
  constructor(message: string) {
    super(message, false);
  }
}

class RetryableApiError extends ReportSubmissionError {
  constructor(message: string, retryAfterMs = 5_000) {
    super(message, true, retryAfterMs);
  }
}

type MediaUploadStatus =
  | "AWAITING_UPLOAD"
  | "QUARANTINED_PENDING_SCAN"
  | "QUARANTINED_SCANNER_UNAVAILABLE"
  | "READY_PRIVATE"
  | "DUPLICATE_PRIVATE"
  | "REJECTED"
  | "EXPIRED";

type MediaUploadMetadata = {
  upload_id: string;
  status: MediaUploadStatus;
  failure_code?: string | null;
};

type MediaUploadGrant = MediaUploadMetadata & {
  upload_url: string;
  completion_url: string;
  required_headers?: Record<string, string>;
};

export type RouteGuidance = {
  alternatives: RouteRecommendation[];
  availability: "CURRENT" | "UNAVAILABLE";
  source: "API" | "DEMO_FALLBACK" | "LOCAL_POLICY";
  referenceTime: string;
  message: string;
};

export type AlertFeed = {
  items: FieldAlert[];
  source: "API" | "DEMO_FALLBACK" | "UNAVAILABLE";
  referenceTime: string;
  message: string;
};

function isSimulatedOffline() {
  return isForcedOfflineMode() || !navigator.onLine;
}

function apiHeaders(user = "field-pwa") {
  return {
    "X-Demo-Role": "reporter",
    "X-Demo-User": user
  };
}

export function shouldRetrySubmission(error: unknown) {
  if (error instanceof ReportSubmissionError) return error.retryable;
  if (error instanceof TypeError) return true;
  return error instanceof DOMException && error.name === "AbortError";
}

function retryDelay(response: Response, fallbackMs = 5_000) {
  const seconds = Number(response.headers.get("Retry-After"));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : fallbackMs;
}

function isRetryableHttpStatus(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

async function fetchWithDeadline(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 8_000
) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await cloudFetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof TypeError || (error instanceof DOMException && error.name === "AbortError")) {
      throw new RetryableApiError("Network unavailable. The report remains encrypted for retry.");
    }
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function apiUrl(path: string) {
  if (/^https?:\/\//i.test(path)) return path;
  if (!/^https?:\/\//i.test(API_BASE)) return path;
  return new URL(path, new URL(API_BASE).origin).toString();
}

async function problemMessage(response: Response, fallback: string) {
  const problem = (await response.json().catch(() => null)) as {
    detail?: string;
    code?: string;
  } | null;
  const suffix = problem?.code ? ` (${problem.code})` : "";
  return `${problem?.detail ?? fallback}${suffix}`;
}

function decodePhotoDataUrl(dataUrl: string, expectedType: string) {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!match || match[1]?.toLowerCase() !== expectedType.toLowerCase()) {
    throw new NonRetryableApiError("The selected evidence image could not be read safely.");
  }
  try {
    const binary = atob(match[2].replace(/\s/g, ""));
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new NonRetryableApiError("The selected evidence image is not valid base64 data.");
  }
}

async function sha256Hex(bytes: Uint8Array) {
  const stableBytes = new Uint8Array(bytes.byteLength);
  stableBytes.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", stableBytes.buffer);
  return Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
}

function completionAttemptId() {
  return typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function getMediaMetadata(uploadId: string, reporterId: string) {
  const response = await fetchWithDeadline(apiUrl(`${API_BASE}/media/uploads/${encodeURIComponent(uploadId)}`), {
    headers: apiHeaders(reporterId)
  });
  if (!response.ok) {
    const message = await problemMessage(response, "Private media status could not be read.");
    if (isRetryableHttpStatus(response.status)) {
      throw new RetryableApiError(`Private media service unavailable. ${message}`, retryDelay(response));
    }
    throw new NonRetryableApiError(message);
  }
  return (await response.json()) as MediaUploadMetadata;
}

async function uploadPhotoEvidence(draft: OfflineReportDraft) {
  if (!draft.photo) return [];
  const bytes = decodePhotoDataUrl(draft.photo.dataUrl, draft.photo.type);
  const checksum = await sha256Hex(bytes);
  const mediaKey = `${draft.client_report_id}:media:0`;
  const reporterHeaders = apiHeaders(draft.reporter_id);
  const grantResponse = await fetchWithDeadline(apiUrl(`${API_BASE}/media/uploads`), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Idempotency-Key": mediaKey,
      ...reporterHeaders
    },
    body: JSON.stringify({
      incident_id: draft.incident_id,
      filename: draft.photo.name,
      content_type: draft.photo.type,
      size_bytes: bytes.byteLength,
      sha256: checksum
    })
  });
  if (!grantResponse.ok) {
    const message = await problemMessage(grantResponse, "Private media upload could not be created.");
    if (isRetryableHttpStatus(grantResponse.status)) {
      throw new RetryableApiError(`Private media service unavailable. ${message}`, retryDelay(grantResponse));
    }
    throw new NonRetryableApiError(message);
  }
  const grant = (await grantResponse.json()) as MediaUploadGrant;
  let metadata = await getMediaMetadata(grant.upload_id, draft.reporter_id);

  if (metadata.status === "AWAITING_UPLOAD") {
    const contentResponse = await fetchWithDeadline(apiUrl(grant.upload_url), {
      method: "PUT",
      headers: {
        ...grant.required_headers,
        "Content-Type": draft.photo.type,
        "X-Checksum-SHA256": checksum,
        "Idempotency-Key": grant.required_headers?.["Idempotency-Key"] ?? `${mediaKey}:content`,
        ...reporterHeaders
      },
      body: new Blob([bytes], { type: draft.photo.type })
    }, 90_000);
    if (!contentResponse.ok) {
      const message = await problemMessage(contentResponse, "Evidence could not be placed in private quarantine.");
      if (isRetryableHttpStatus(contentResponse.status)) {
        throw new RetryableApiError(`Private media service unavailable. ${message}`, retryDelay(contentResponse));
      }
      throw new NonRetryableApiError(message);
    }
    metadata = (await contentResponse.json()) as MediaUploadMetadata;
  }

  if (metadata.status === "QUARANTINED_PENDING_SCAN" || metadata.status === "QUARANTINED_SCANNER_UNAVAILABLE") {
    const completionResponse = await fetchWithDeadline(apiUrl(grant.completion_url), {
      method: "POST",
      headers: {
        "Idempotency-Key": `${mediaKey}:complete:${completionAttemptId()}`,
        ...reporterHeaders
      }
    }, 60_000);
    const completion = (await completionResponse.json().catch(() => null)) as (MediaUploadMetadata & {
      code?: string;
      detail?: string;
    }) | null;
    if (completionResponse.status === 202 || completion?.status === "QUARANTINED_SCANNER_UNAVAILABLE") {
      throw new RetryableApiError(
        "Media scanner unavailable. The photo remains private in quarantine and the report will retry later.",
        retryDelay(completionResponse, 30_000)
      );
    }
    if (!completionResponse.ok) {
      const failureCode = completion?.failure_code ?? completion?.code;
      const message = completion?.detail
        ?? (failureCode
          ? `The evidence image was rejected (${failureCode}).`
          : "The evidence image could not be sanitized.");
      if (isRetryableHttpStatus(completionResponse.status)) {
        throw new RetryableApiError(`Private media service unavailable. ${message}`, retryDelay(completionResponse));
      }
      throw new NonRetryableApiError(message);
    }
    metadata = completion ?? metadata;
  }

  if (metadata.status === "READY_PRIVATE" || metadata.status === "DUPLICATE_PRIVATE") {
    return [metadata.upload_id];
  }
  if (metadata.status === "REJECTED" || metadata.status === "EXPIRED") {
    throw new NonRetryableApiError(
      metadata.failure_code
        ? `The evidence image was rejected (${metadata.failure_code}).`
        : "The private evidence upload expired or was rejected. Choose the photo again."
    );
  }
  throw new RetryableApiError(
    "Private media service unavailable. Evidence processing is incomplete and the report will retry later."
  );
}

const AuthoritativeReportResponse = z.object({
  receipt: z.object({
    report_id: z.string().min(1),
    client_report_id: z.string().min(8),
    disposition: z.enum(["ELIGIBLE", "DUPLICATE", "LATE", "INVALID"]),
    accepted_at: z.string().datetime(),
    sync_message: z.string().min(1)
  }),
  report: z.object({ id: z.string().min(1) })
});

function normalizeReceipt(body: unknown, draft: OfflineReportDraft): ReportReceipt {
  const parsed = AuthoritativeReportResponse.safeParse(body);
  if (!parsed.success) {
    throw new RetryableApiError(
      "The field API returned an invalid acknowledgement. The report remains encrypted for retry."
    );
  }
  const { receipt, report } = parsed.data;
  if (receipt.client_report_id !== draft.client_report_id || receipt.report_id !== report.id) {
    throw new NonRetryableApiError(
      "The field API acknowledgement did not match this report. Keep the receipt pending and contact the incident desk."
    );
  }
  return {
    id: receipt.report_id,
    clientReportId: draft.client_report_id,
    reference: receipt.report_id,
    receivedAt: receipt.accepted_at,
    placeLabel: draft.place_label,
    status: receipt.disposition === "INVALID" ? "UNDER_REVIEW" : "RECEIVED",
    source: "API",
    message: receipt.sync_message
  };
}

export async function submitReport(draft: OfflineReportDraft): Promise<ReportReceipt> {
  if (isSimulatedOffline()) {
    throw new RetryableApiError("Network unavailable. The report remains encrypted for retry.");
  }
  if (activeFieldRuntime.mode === "live") {
    if (!activeFieldRuntime.incidentId) {
      throw new RetryableApiError(
        "The authority incident is unavailable. The report remains encrypted until incident access is restored.",
      );
    }
    if (
      draft.incident_id !== activeFieldRuntime.incidentId
      || draft.incident_id === DEMO_INCIDENT_ID
      || draft.observed_at === DEMO_SCENARIO_TIME
    ) {
      throw new NonRetryableApiError(
        "This report belongs to a different or deterministic incident and cannot be sent to the live authority service.",
      );
    }
  }
  // Media must reach a private, sanitized terminal state before its identifier
  // enters the authoritative report. Keeping this outside the demo fallback
  // prevents scanner or quarantine failures from becoming a synthetic receipt.
  const media_upload_ids = await uploadPhotoEvidence(draft);
  const validated = ReportInput.parse({ ...draft, media_upload_ids });

  try {
    const response = await fetchWithDeadline(`${API_BASE}/reports`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": draft.client_report_id,
        ...apiHeaders(draft.reporter_id)
      },
      body: JSON.stringify(validated)
    }, 4_000);
    if (!response.ok) {
      const problem = (await response.json().catch(() => null)) as { detail?: string } | null;
      const message = problem?.detail ?? `Report was rejected (${response.status}).`;
      if (isRetryableHttpStatus(response.status)) {
        throw new RetryableApiError(`Field API unavailable. ${message}`, retryDelay(response));
      }
      throw new NonRetryableApiError(message);
    }
    return normalizeReceipt(await response.json(), draft);
  } catch (error) {
    if (error instanceof ReportSubmissionError) throw error;
    if (shouldRetrySubmission(error)) {
      throw new RetryableApiError("Field API unavailable. The report remains encrypted for retry.");
    }
    throw error;
  }
}

const FieldBootstrapResponse = z.object({
  server_time: z.string().datetime(),
  scenario_clock: z.string().datetime().optional(),
  demo_mode: z.boolean(),
  data_label: z.string().min(1),
  incident: z.object({
    id: z.string().min(1),
    name: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    status: z.string().min(1),
    area_name: z.string().min(1).optional(),
    area: z.union([z.string().min(1), z.record(z.string(), z.unknown())]).optional(),
    is_demo: z.boolean(),
    is_simulated: z.boolean(),
    data_label: z.string().min(1),
  }),
});

export class FieldBootstrapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FieldBootstrapError";
  }
}

export async function fetchFieldIncidentBootstrap(
  timeoutMs = 8_000,
): Promise<LiveFieldRuntime> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await cloudFetch(`${API_BASE}/incidents/bootstrap`, {
      headers: apiHeaders(),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new FieldBootstrapError(
        response.status === 404
          ? "No active authority incident is available for Field."
          : "The authority incident bootstrap is unavailable.",
      );
    }
    const parsed = FieldBootstrapResponse.safeParse(await response.json());
    if (!parsed.success) {
      throw new FieldBootstrapError(
        "The authority service returned an invalid incident bootstrap.",
      );
    }
    const { incident } = parsed.data;
    const topLabel = parsed.data.data_label.trim().toUpperCase();
    const incidentLabel = incident.data_label.trim().toUpperCase();
    if (
      parsed.data.demo_mode
      || topLabel !== "LIVE"
      || incident.is_demo
      || incident.is_simulated
      || incidentLabel !== "LIVE"
      || incident.id === DEMO_INCIDENT_ID
    ) {
      throw new FieldBootstrapError(
        "The authority endpoint returned deterministic or simulated incident data. Live Field remains closed.",
      );
    }
    const incidentName = incident.name ?? incident.title;
    const areaName = incident.area_name
      ?? (typeof incident.area === "string" ? incident.area : undefined);
    if (!incidentName || !areaName) {
      throw new FieldBootstrapError(
        "The authority incident bootstrap is missing its incident name or response area.",
      );
    }
    return {
      mode: "live",
      incidentId: incident.id,
      referenceTime: parsed.data.server_time,
      incidentName,
      areaName,
      incidentStatus: incident.status,
    };
  } catch (error) {
    if (error instanceof FieldBootstrapError) throw error;
    throw new FieldBootstrapError(
      error instanceof DOMException && error.name === "AbortError"
        ? "The authority incident bootstrap did not respond in time."
        : "The authority incident bootstrap could not be verified.",
    );
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function fetchAlerts(
  runtime: FieldRuntime = activeFieldRuntime,
): Promise<AlertFeed> {
  if (!runtime.incidentId || !runtime.referenceTime) {
    return {
      items: [],
      source: "UNAVAILABLE",
      referenceTime: new Date().toISOString(),
      message: "No verified authority incident is available. No deterministic alerts are substituted.",
    };
  }
  const referenceTime = runtime.referenceTime;
  try {
    const response = await cloudFetch(`${API_BASE}/alerts?incident_id=${encodeURIComponent(runtime.incidentId)}`, {
      headers: apiHeaders()
    });
    if (!response.ok) throw new Error("Alerts unavailable");
    const payload = AlertListResponse.parse(await response.json());
    if (
      runtime.mode === "live"
      && payload.items.some(
        (alert) => alert.is_demo || alert.incident_id !== runtime.incidentId,
      )
    ) {
      throw new Error("An alert crossed the verified live incident boundary");
    }
    return {
      items: payload.items
        .map(normalizeFieldAlert)
        .filter((alert) => isActiveAt(alert.issuedAt, alert.validUntil, referenceTime)),
      source: "API",
      referenceTime,
      message: "Current alerts loaded from the incident API."
    };
  } catch {
    if (runtime.mode === "live") {
      return {
        items: [],
        source: "UNAVAILABLE",
        referenceTime,
        message: "The live alert feed could not be verified. No deterministic alerts are substituted.",
      };
    }
    return {
      items: demoAlerts.filter((alert) => isActiveAt(alert.issuedAt, alert.validUntil, DEMO_SCENARIO_TIME)),
      source: "DEMO_FALLBACK",
      referenceTime: DEMO_SCENARIO_TIME,
      message:
        "The alert API could not be reached. Showing deterministic DEMO DATA for the scenario checkpoint; this is not a current alert feed."
    };
  }
}

const AlertListResponse = z.object({
  items: z.array(z.object({
    id: z.string().min(1),
    incident_id: z.string().min(1).optional(),
    title: z.string().min(1),
    body: z.string().min(1),
    audience: z.string().min(1),
    caution_only: z.boolean(),
    official: z.boolean(),
    created_at: z.string().datetime(),
    dispatched_at: z.string().datetime().nullable().optional(),
    expires_at: z.string().datetime(),
    is_demo: z.boolean()
  })),
  next_cursor: z.string().nullable().optional()
});

type AuthoritativeAlert = z.infer<typeof AlertListResponse>["items"][number];

function normalizeFieldAlert(alert: AuthoritativeAlert): FieldAlert {
  const kind: FieldAlert["kind"] = alert.official
    ? "OFFICIAL"
    : alert.caution_only
      ? "COMMUNITY_CAUTION"
      : "SYSTEM";
  return {
    id: alert.id,
    kind,
    title: alert.title,
    description: alert.body,
    area: alert.audience,
    issuedAt: alert.dispatched_at ?? alert.created_at,
    validUntil: alert.expires_at,
    severity: kind === "OFFICIAL" ? "DANGER" : kind === "COMMUNITY_CAUTION" ? "CAUTION" : "INFO",
    isSimulated: alert.is_demo
  };
}

function parseTime(value: string) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

export function isActiveAt(issuedAt: string, validUntil: string, referenceTime: string) {
  const issued = parseTime(issuedAt);
  const valid = parseTime(validUntil);
  const reference = parseTime(referenceTime);
  return issued !== null && valid !== null && reference !== null && issued <= reference && valid > reference;
}

export function currentRoutesAt(routes: RouteRecommendation[], referenceTime: string) {
  const reference = parseTime(referenceTime);
  if (reference === null) return [];
  return routes.filter((route) => {
    const expiry = parseTime(route.valid_until);
    return expiry !== null && expiry > reference;
  });
}

export async function fetchRoutes(
  origin: { latitude: number; longitude: number; accuracy_m: number } | undefined = undefined,
  runtime: FieldRuntime = activeFieldRuntime,
): Promise<RouteGuidance> {
  if (!runtime.incidentId || !runtime.referenceTime) {
    return {
      alternatives: [],
      availability: "UNAVAILABLE",
      source: "LOCAL_POLICY",
      referenceTime: new Date().toISOString(),
      message: "No verified authority incident is available. Route guidance remains paused.",
    };
  }
  if (!origin) {
    if (runtime.mode === "live") {
      return {
        alternatives: [],
        availability: "UNAVAILABLE",
        source: "LOCAL_POLICY",
        referenceTime: runtime.referenceTime,
        message: "Use a verified current device location before requesting live route guidance.",
      };
    }
    origin = {
      latitude: 10.1041000,
      longitude: 76.3519000,
      accuracy_m: 12,
    };
  }
  if (!isLiveEligibleLocationAccuracy(origin.accuracy_m)) {
    return {
      alternatives: [],
      availability: "UNAVAILABLE",
      source: "LOCAL_POLICY",
      referenceTime: runtime.referenceTime,
      message: `Location accuracy must be ${MAX_LIVE_LOCATION_ACCURACY_M} m or better before requesting route guidance.`
    };
  }
  try {
    const response = await cloudFetch(`${API_BASE}/routes/recommend`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...apiHeaders() },
      body: JSON.stringify({
        incident_id: runtime.incidentId,
        origin: {
          latitude: origin.latitude,
          longitude: origin.longitude,
          accuracy_m: origin.accuracy_m
        },
        max_alternatives: 3
      })
    });
    if (!response.ok) throw new Error("Routes unavailable");
    const payload = (await response.json()) as {
      incident_id?: string;
      alternatives?: RouteRecommendation[];
      generated_at?: string;
      no_route_reason?: string | null;
      is_simulated?: boolean;
    };
    if (
      runtime.mode === "live"
      && (
        !payload.generated_at
        || payload.incident_id !== runtime.incidentId
        || payload.is_simulated !== false
      )
    ) {
      throw new Error("The live route response is not bound to the verified authority incident");
    }
    const referenceTime = payload.generated_at ?? runtime.referenceTime;
    const alternatives = currentRoutesAt(payload.alternatives ?? [], referenceTime);
    return {
      alternatives,
      availability: alternatives.length ? "CURRENT" : "UNAVAILABLE",
      source: "API",
      referenceTime,
      message: alternatives.length
        ? "Route guidance is bound to the displayed model and evidence versions."
        : payload.no_route_reason ?? "No current lower-risk route is available. Await responder guidance."
    };
  } catch {
    if (runtime.mode === "live") {
      return {
        alternatives: [],
        availability: "UNAVAILABLE",
        source: "LOCAL_POLICY",
        referenceTime: runtime.referenceTime,
        message: "The live route service is unavailable. No deterministic route is substituted; await responder guidance.",
      };
    }
    // The static route fixture is useful for deterministic development, but a
    // backend failure means its freshness cannot be revalidated. Never surface
    // it as current guidance, even when its fixture expiry follows the reset
    // checkpoint.
    const lastKnownExpiry = currentRoutesAt(demoRoutes, DEMO_SCENARIO_TIME)
      .map((route) => route.valid_until)
      .sort()
      .at(0);
    return {
      alternatives: [],
      availability: "UNAVAILABLE",
      source: "DEMO_FALLBACK",
      referenceTime: DEMO_SCENARIO_TIME,
      message: lastKnownExpiry
        ? "The route service is unavailable. Last-known demo routes are withheld because their freshness cannot be verified."
        : "The route service is unavailable and the fallback routes have expired. Await responder guidance."
    };
  }
}
