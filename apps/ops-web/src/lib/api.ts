import { demoSnapshot } from "../data/demo";
import type {
  AuditRecord,
  OperationalAction,
  OperationsSnapshot,
  ShelterRecord,
  SignalDecision,
  StaffApiIdentity,
  StaffRole,
} from "./models";

export const API_ROOT = import.meta.env.VITE_API_ROOT ?? "/api/v1";
const BOOTSTRAP_TIMEOUT_MS = 5_000;

export class ApiRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

const staffIdentities: Record<StaffRole, StaffApiIdentity> = {
  "Incident commander": { role: "incident_commander", userId: "ops-incident-commander" },
  Verifier: { role: "verifier", userId: "ops-verifier" },
  "Field responder": { role: "responder", userId: "ops-field-responder" },
  "Resilience engineer": { role: "engineer", userId: "ops-resilience-engineer" },
  "Shelter manager": { role: "shelter_manager", userId: "ops-shelter-manager" },
  Auditor: { role: "auditor", userId: "ops-auditor" },
  "Identity administrator": { role: "identity_administrator", userId: "ops-identity-administrator" },
};

export function apiIdentityForRole(role: StaffRole): StaffApiIdentity {
  return staffIdentities[role];
}

export function describeApiError(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof DOMException && error.name === "AbortError") {
    return "The API did not respond before the request timeout.";
  }
  return error instanceof Error ? error.message : "The API request failed.";
}

async function request<T>(
  path: string,
  init?: RequestInit,
  timeoutMs = 1_200,
  identity?: StaffApiIdentity,
): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { headers, ...requestInit } = init ?? {};
    const requestHeaders = new Headers(headers);
    if (!requestHeaders.has("Accept")) requestHeaders.set("Accept", "application/json");
    if (!requestHeaders.has("Content-Type")) requestHeaders.set("Content-Type", "application/json");
    if (identity) {
      requestHeaders.set("X-Demo-Role", identity.role);
      requestHeaders.set("X-Demo-User", identity.userId);
    }
    const response = await fetch(`${API_ROOT}${path}`, {
      credentials: "include",
      ...requestInit,
      headers: requestHeaders,
      signal: controller.signal,
    });
    if (!response.ok) {
      let problem: { detail?: string; title?: string; code?: string } = {};
      try {
        problem = await response.json() as typeof problem;
      } catch {
        // Non-JSON upstream errors still receive a clear, status-bound message.
      }
      throw new ApiRequestError(
        problem.detail ?? problem.title ?? `API request failed with status ${response.status}.`,
        response.status,
        problem.code,
      );
    }
    return (await response.json()) as T;
  } finally {
    window.clearTimeout(timeout);
  }
}

function readItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray((value as { items?: unknown[] }).items)) {
    return (value as { items: unknown[] }).items;
  }
  return [];
}

function stringField(record: unknown, key: string): string | undefined {
  if (!record || typeof record !== "object") return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

function numberField(record: unknown, key: string): number | undefined {
  if (!record || typeof record !== "object") return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanField(record: unknown, key: string): boolean | undefined {
  if (!record || typeof record !== "object") return undefined;
  const value = (record as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : undefined;
}

function recordField(record: unknown, key: string): Record<string, unknown> | undefined {
  if (!record || typeof record !== "object") return undefined;
  const value = (record as Record<string, unknown>)[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function formatIst(value: string | undefined, fallback: string): string {
  if (!value) return fallback;
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return fallback;
  return `${date.toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata",
  })} IST`;
}

function actionStatusFromApproval(status: string | undefined): OperationalAction["status"] {
  if (status === "PENDING") return "PENDING_APPROVAL";
  if (status === "APPROVED") return "APPROVED";
  if (status === "EXPIRED" || status === "CANCELLED") return "EXPIRED";
  if (status === "REJECTED") return "REJECTED";
  return "RECOMMENDED";
}

function shelterStatus(value: string | undefined, fallback: ShelterRecord["status"]): ShelterRecord["status"] {
  return value === "OPEN" || value === "LIMITED" || value === "FULL" ? value : fallback;
}

function shelterAccess(value: string | undefined, fallback: ShelterRecord["access"]): ShelterRecord["access"] {
  if (value === "REACHABLE") return "Reachable";
  if (value === "AT_RISK" || value === "RISKY") return "At risk";
  if (value === "UNKNOWN") return "Unknown";
  return fallback;
}

function minutesBetween(later: string | undefined, earlier: string | undefined, fallback: number): number {
  if (!later || !earlier) return fallback;
  const difference = new Date(later).getTime() - new Date(earlier).getTime();
  return Number.isFinite(difference) ? Math.max(0, Math.round(difference / 60_000)) : fallback;
}

function normalizeBootstrap(raw: unknown, incidentId: string): OperationsSnapshot {
  if (!raw || typeof raw !== "object") return demoSnapshot;
  const value = raw as Record<string, unknown>;
  const simulation = value.simulation && typeof value.simulation === "object"
    ? value.simulation as Record<string, unknown>
    : {};
  const scenarioTime = typeof value.scenario_clock === "string"
    ? value.scenario_clock
    : stringField(value.scenario_clock, "current_time") ?? stringField(value.scenario_clock, "scenario_time");

  const rawSignals = readItems(value.signals);
  const primarySignal = rawSignals[0];
  const signalId = stringField(primarySignal, "id");
  const signalState = stringField(primarySignal, "state");
  const reportCount = numberField(primarySignal, "report_count");
  const independentCount = numberField(primarySignal, "independent_report_count");
  const authenticatedCount = numberField(primarySignal, "authenticated_report_count");
  const rawConfidence = numberField(primarySignal, "confidence");
  const signalVersion = numberField(primarySignal, "version");
  const contradictionPresent = booleanField(primarySignal, "contradiction_present") ?? false;
  const signalReports = readItems(value.reports).filter((report) => stringField(report, "signal_id") === signalId);
  const apiEvidence = signalReports.map((report, index) => {
    const waterDepth = stringField(report, "water_depth") ?? "UNKNOWN";
    const roadStatus = stringField(report, "road_status") ?? "UNKNOWN";
    const observedAt = stringField(report, "observed_at") ?? scenarioTime ?? demoSnapshot.scenarioTime;
    const trusted = booleanField(report, "trusted") ?? false;
    return {
      id: stringField(report, "id") ?? `API-${index + 1}`,
      reporter: "Identity protected",
      source: trusted ? "Responder" as const : "Mobile app" as const,
      depth: `${waterDepth.toLowerCase().replaceAll("_", " ")} estimate`,
      roadStatus: roadStatus.toLowerCase().replaceAll("_", " "),
      observedAt: new Date(observedAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }),
      distanceM: 200,
      counted: stringField(report, "disposition") === "ELIGIBLE",
      note: `Privacy-protected ${waterDepth.toLowerCase().replaceAll("_", " ")} depth report; road ${roadStatus.toLowerCase().replaceAll("_", " ")}.`,
    };
  });
  const primaryDemoSignal = demoSnapshot.signals[0];
  const apiStatus = signalState === "COMMUNITY_CORROBORATED"
    ? "COMMUNITY_CORROBORATED" as const
    : signalState === "DISPUTED"
      ? "DISPUTED" as const
      : "NEEDS_REVIEW" as const;
  const apiDecision = signalState === "COMMUNITY_CORROBORATED"
    ? "VERIFIED" as const
    : signalState === "DISPUTED"
      ? "FIELD_CHECK" as const
      : "UNREVIEWED" as const;
  const signals = signalId ? [{
    ...primaryDemoSignal,
    apiId: signalId,
    apiVersion: signalVersion,
    confidence: rawConfidence === undefined ? primaryDemoSignal.confidence : Math.round(rawConfidence * 100),
    independentReports: independentCount ?? primaryDemoSignal.independentReports,
    receivedReports: reportCount ?? primaryDemoSignal.receivedReports,
    authenticatedReports: authenticatedCount ?? primaryDemoSignal.authenticatedReports,
    conflictReports: contradictionPresent ? 1 : 0,
    status: apiStatus,
    decision: apiDecision,
    evidence: apiEvidence.length ? apiEvidence : primaryDemoSignal.evidence,
  }, ...demoSnapshot.signals.slice(1)] : demoSnapshot.signals;

  const rawApprovals = readItems(value.approvals);
  const actions = demoSnapshot.actions.map((action) => {
    const approval = rawApprovals.find((candidate) => {
      const payload = recordField(candidate, "action_payload");
      return stringField(payload, "presentation_id") === action.id
        || (stringField(candidate, "action_type") === action.type
          && stringField(payload, "title") === action.title);
    });
    if (!approval) return action;
    const payload = recordField(approval, "action_payload");
    const requestedBy = stringField(approval, "requested_by");
    const requestedRole = stringField(approval, "requested_role");
    return {
      ...action,
      approvalId: stringField(approval, "id"),
      approvalVersion: numberField(approval, "version"),
      status: actionStatusFromApproval(stringField(approval, "status")),
      requestedBy: requestedBy
        ? `${requestedBy}${requestedRole ? ` · ${requestedRole.replaceAll("_", " ")}` : ""}`
        : action.requestedBy,
      requestedById: requestedBy,
      requestedAt: formatIst(stringField(approval, "requested_at"), action.requestedAt),
      expiresAt: formatIst(stringField(approval, "expires_at"), action.expiresAt),
      audience: stringField(approval, "audience") ?? action.audience,
      evidenceVersion: stringField(approval, "evidence_version") ?? action.evidenceVersion,
      modelVersion: stringField(approval, "model_version") ?? action.modelVersion,
      detail: stringField(payload, "body") ?? action.detail,
      decidedById: stringField(approval, "decided_by"),
      decisionReason: stringField(approval, "decision_reason"),
      executionStatus: stringField(approval, "execution_status"),
    } satisfies OperationalAction;
  });

  const rawShelters = readItems(value.shelters);
  const shelters = demoSnapshot.shelters.map((shelter) => {
    const apiShelter = rawShelters.find((candidate) => {
      const name = stringField(candidate, "name")?.toLowerCase();
      return name === shelter.name.toLowerCase()
        || Boolean(name && (name.includes(shelter.name.toLowerCase()) || shelter.name.toLowerCase().includes(name)));
    });
    if (!apiShelter) return shelter;
    const capacity = numberField(apiShelter, "capacity_total") ?? numberField(apiShelter, "capacity") ?? shelter.capacity;
    const remaining = numberField(apiShelter, "capacity_remaining");
    const occupancy = numberField(apiShelter, "occupancy") ?? (remaining === undefined ? shelter.occupancy : Math.max(0, capacity - remaining));
    return {
      ...shelter,
      apiId: stringField(apiShelter, "id"),
      apiVersion: numberField(apiShelter, "version"),
      status: shelterStatus(stringField(apiShelter, "activation_status") ?? stringField(apiShelter, "availability"), shelter.status),
      occupancy,
      capacity,
      access: shelterAccess(stringField(apiShelter, "access_status"), shelter.access),
      updatedMinutesAgo: minutesBetween(scenarioTime, stringField(apiShelter, "verified_at") ?? stringField(apiShelter, "observed_at"), shelter.updatedMinutesAgo),
    } satisfies ShelterRecord;
  });

  // The deterministic bundle remains the presentation-safe baseline. Current
  // authoritative signal identifiers, versions, counts, and evidence replace
  // fixture values when the API has processed live demo reports.
  return {
    ...demoSnapshot,
    incidentId,
    scenarioTime: scenarioTime ?? demoSnapshot.scenarioTime,
    modelVersion: stringField(simulation, "version") ?? stringField(simulation, "model_version") ?? demoSnapshot.modelVersion,
    signals,
    actions,
    shelters,
  };
}

export async function fetchOperationsSnapshot(identity?: StaffApiIdentity): Promise<{ snapshot: OperationsSnapshot; connected: boolean }> {
  try {
    const incidentsResponse = await request<unknown>("/incidents", undefined, BOOTSTRAP_TIMEOUT_MS, identity);
    const incidents = readItems(incidentsResponse);
    const first = incidents[0];
    const incidentId = stringField(first, "id") ?? demoSnapshot.incidentId;
    const bootstrap = await request<unknown>(`/incidents/${encodeURIComponent(incidentId)}/bootstrap`, undefined, BOOTSTRAP_TIMEOUT_MS, identity);
    return { snapshot: normalizeBootstrap(bootstrap, incidentId), connected: true };
  } catch {
    return { snapshot: structuredClone(demoSnapshot), connected: false };
  }
}

export async function submitSignalDecision(
  signalId: string,
  decision: SignalDecision,
  reason: string,
  expectedVersion: number,
  identity: StaffApiIdentity,
) {
  const apiDecision = decision === "VERIFIED" ? "VERIFY" : decision === "REJECTED" ? "REJECT" : "MODIFY";
  const apiSignalId = signalId.startsWith("signal-") ? signalId : `signal-${signalId.toLowerCase()}`;
  return request<{
    id: string;
    state: string;
    version: number;
    human_decision?: string | null;
  }>(`/signals/${encodeURIComponent(apiSignalId)}/decisions`, {
    method: "POST",
    body: JSON.stringify({ decision: apiDecision, reason, expected_version: expectedVersion }),
    headers: {
      "Idempotency-Key": crypto.randomUUID(),
    },
  }, 1_200, identity);
}

export type ApprovalDecisionResponse = {
  approval: {
    id: string;
    status: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "CANCELLED";
    version: number;
    decided_by?: string | null;
    decision_reason?: string | null;
    execution_status?: string;
  };
  alert: Record<string, unknown> | null;
};

export async function submitApprovalDecision(
  approvalId: string,
  decision: "APPROVE" | "MODIFY" | "REJECT",
  reason: string,
  expectedVersion: number,
  identity: StaffApiIdentity,
) {
  return request<ApprovalDecisionResponse>(`/approvals/${encodeURIComponent(approvalId)}/decisions`, {
    method: "POST",
    body: JSON.stringify({ decision, reason, expected_version: expectedVersion }),
    headers: { "Idempotency-Key": crypto.randomUUID() },
  }, 1_200, identity);
}

export type ShelterUpdateResponse = {
  id: string;
  version: number;
  activation_status: string;
  access_status?: string;
  capacity_total?: number;
  capacity?: number;
  capacity_remaining?: number;
  occupancy?: number;
  verified_at?: string;
};

export async function submitShelterUpdate(
  shelter: ShelterRecord,
  status: ShelterRecord["status"],
  occupancy: number,
  reason: string,
  identity: StaffApiIdentity,
) {
  if (!shelter.apiId || !shelter.apiVersion) {
    throw new ApiRequestError("The authoritative shelter version is unavailable.", 409, "VERSION_UNAVAILABLE");
  }
  return request<ShelterUpdateResponse>(`/shelters/${encodeURIComponent(shelter.apiId)}`, {
    method: "PATCH",
    body: JSON.stringify({
      expected_version: shelter.apiVersion,
      activation_status: status,
      access_status: shelter.access === "Reachable" ? "REACHABLE" : shelter.access === "At risk" ? "AT_RISK" : "UNKNOWN",
      capacity_remaining: Math.max(0, shelter.capacity - occupancy),
      status_reason: reason,
    }),
  }, 1_500, identity);
}

export type AuditStatusResponse = {
  records: AuditRecord[];
  chainValid: boolean;
};

export async function fetchAuditStatus(identity: StaffApiIdentity): Promise<AuditStatusResponse> {
  const response = await request<{ items: unknown[]; chain_valid: boolean }>("/audit?limit=200", undefined, 2_000, identity);
  return {
    chainValid: response.chain_valid === true,
    records: readItems(response).map((event, index) => {
      const eventType = stringField(event, "event_type") ?? "audit.event";
      const eventHash = stringField(event, "event_hash") ?? "";
      const createdAt = stringField(event, "created_at");
      const normalizedType = eventType.toUpperCase().replaceAll(".", "_");
      return {
        id: stringField(event, "id") ?? `audit-${index + 1}`,
        occurredAt: formatIst(createdAt, "Time unavailable"),
        actor: stringField(event, "actor_id") ?? "Unknown actor",
        role: (stringField(event, "actor_role") ?? "unknown role").replaceAll("_", " "),
        event: normalizedType,
        resource: [stringField(event, "aggregate_kind"), stringField(event, "aggregate_id"), numberField(event, "aggregate_version")].filter((part) => part !== undefined).join(" · "),
        outcome: normalizedType.includes("APPROV") ? "APPROVED" : normalizedType.includes("REJECT") ? "REJECTED" : "RECORDED",
        hash: eventHash ? `${eventHash.slice(0, 8)}…${eventHash.slice(-4)}` : "Unavailable",
      } satisfies AuditRecord;
    }),
  };
}

export async function advanceDemo(minutes = 10, identity?: StaffApiIdentity) {
  return request("/demo/advance", {
    method: "POST",
    body: JSON.stringify({ minutes }),
    headers: { "Idempotency-Key": crypto.randomUUID() },
  }, 2_000, identity);
}

export async function resetDemo(identity: StaffApiIdentity) {
  return request("/demo/reset", {
    method: "POST",
    headers: { "Idempotency-Key": crypto.randomUUID() },
  }, 2_000, identity);
}
