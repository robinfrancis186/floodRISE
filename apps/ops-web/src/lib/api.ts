import { demoSnapshot } from "../data/demo";
import type { RouteRecommendation, SourceHealth } from "@floodrise/contracts";
import type {
  AuditRecord,
  FloodSignalRecord,
  IncidentRecord,
  OperationalAction,
  OperationsSnapshot,
  ResiliencePriority,
  ShelterRecord,
  SignalDecision,
  StaffApiIdentity,
  StaffRole,
} from "./models";
import { cloudFetch } from "./cloud-security";

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

const operationalRolePrecedence: readonly StaffApiIdentity["role"][] = [
  "incident_commander",
  "verifier",
  "responder",
  "engineer",
  "shelter_manager",
  "auditor",
  "identity_administrator",
];

const staffRoleByApiRole: Record<StaffApiIdentity["role"], StaffRole> = {
  incident_commander: "Incident commander",
  verifier: "Verifier",
  responder: "Field responder",
  engineer: "Resilience engineer",
  shelter_manager: "Shelter manager",
  auditor: "Auditor",
  identity_administrator: "Identity administrator",
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
    const response = await cloudFetch(`${API_ROOT}${path}`, {
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

export type AuthenticatedOperationsPrincipal = {
  userId: string;
  role: StaffRole;
  roles: readonly StaffRole[];
};

export async function fetchAuthenticatedOperationsPrincipal(): Promise<AuthenticatedOperationsPrincipal> {
  const context = await request<unknown>("/auth/me", undefined, BOOTSTRAP_TIMEOUT_MS);
  const userId = stringField(context, "user_id");
  const authenticated = booleanField(context, "authenticated");
  const rawRoles = context && typeof context === "object" && Array.isArray(
    (context as { roles?: unknown }).roles,
  )
    ? (context as { roles: unknown[] }).roles
    : [];
  const grantedRoles = new Set(
    rawRoles.filter((role): role is StaffApiIdentity["role"] => (
      typeof role === "string"
      && operationalRolePrecedence.includes(role as StaffApiIdentity["role"])
    )),
  );
  const primaryApiRole = operationalRolePrecedence.find((role) => grantedRoles.has(role));

  if (authenticated !== true || !userId || !primaryApiRole) {
    throw new ApiRequestError(
      "The authenticated account does not have an operational floodRISE role.",
      403,
      "OPERATIONAL_ROLE_REQUIRED",
    );
  }

  return {
    userId,
    role: staffRoleByApiRole[primaryApiRole],
    roles: operationalRolePrecedence
      .filter((role) => grantedRoles.has(role))
      .map((role) => staffRoleByApiRole[role]),
  };
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

export function actionStatusFromApproval(status: string | undefined): OperationalAction["status"] {
  if (status === "PENDING") return "PENDING_APPROVAL";
  if (status === "APPROVED") return "APPROVED";
  if (status === "MODIFIED") return "MODIFIED";
  if (status === "EXPIRED" || status === "CANCELLED") return "EXPIRED";
  if (status === "REJECTED") return "REJECTED";
  return "RECOMMENDED";
}

export function signalStatusFromState(state: string): FloodSignalRecord["status"] {
  if (state === "COMMUNITY_CORROBORATED") return "COMMUNITY_CORROBORATED";
  if (state === "DISPUTED") return "DISPUTED";
  if (state === "STALE") return "STALE";
  if (state === "EXPIRED") return "EXPIRED";
  if (state === "RESOLVED") return "RESOLVED";
  return "NEEDS_REVIEW";
}

export function signalDecisionFromState(
  state: string,
  humanDecision?: string,
): SignalDecision {
  if (state === "COMMUNITY_CORROBORATED") return "VERIFIED";
  if (state === "DISPUTED") return "REJECTED";
  if (humanDecision === "FIELD_CHECK" || humanDecision === "MODIFY") return "FIELD_CHECK";
  return "UNREVIEWED";
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

function normalizedRouteShelterDetail(
  candidate: unknown,
  scenarioTime: string,
): RouteRecommendation["shelter_detail"] {
  const rawDetail = recordField(candidate, "shelter_detail");
  const id = stringField(rawDetail, "id");
  const name = stringField(rawDetail, "name");
  if (!id || !name) return null;

  const rawStatus = stringField(rawDetail, "activation_status") ?? stringField(rawDetail, "status");
  const status = rawStatus === "OPEN" || rawStatus === "LIMITED" || rawStatus === "FULL"
    ? rawStatus
    : undefined;
  const rawAccess = stringField(rawDetail, "access_status") ?? stringField(rawDetail, "access");
  const access = rawAccess === "REACHABLE" || rawAccess === "Reachable"
    ? "Reachable" as const
    : rawAccess === "AT_RISK" || rawAccess === "RISKY" || rawAccess === "At risk"
      ? "At risk" as const
      : rawAccess === "UNKNOWN" || rawAccess === "Unknown"
        ? "Unknown" as const
        : undefined;
  const observedAt = stringField(rawDetail, "verified_at") ?? stringField(rawDetail, "observed_at");
  const capacity = numberField(rawDetail, "capacity_total") ?? numberField(rawDetail, "capacity");
  const remainingCapacity = numberField(rawDetail, "remaining_capacity") ?? numberField(rawDetail, "capacity_remaining");
  const rawWarnings = rawDetail?.warnings;
  const warnings = Array.isArray(rawWarnings)
    ? rawWarnings.filter((warning): warning is string => typeof warning === "string")
    : [];

  return {
    id,
    name,
    status,
    access,
    capacity,
    remaining_capacity: remainingCapacity,
    observed_at: observedAt && Number.isFinite(Date.parse(observedAt)) ? observedAt : undefined,
    updated_minutes_ago: observedAt && Number.isFinite(Date.parse(observedAt))
      ? minutesBetween(scenarioTime, observedAt, 0)
      : undefined,
    version: numberField(rawDetail, "version"),
    warnings,
  };
}

function normalizeRoutes(value: unknown, scenarioTime: string): RouteRecommendation[] {
  const scenarioTimestamp = Date.parse(scenarioTime);
  if (!Number.isFinite(scenarioTimestamp)) return [];

  const seen = new Set<string>();
  return readItems(value).flatMap((candidate) => {
    const id = stringField(candidate, "id");
    const label = stringField(candidate, "label");
    const duration = numberField(candidate, "duration_min");
    const distance = numberField(candidate, "distance_km");
    const shelter = stringField(candidate, "shelter");
    const shelterId = stringField(candidate, "shelter_id");
    const shelterDetail = normalizedRouteShelterDetail(candidate, scenarioTime);
    const risk = stringField(candidate, "risk");
    const routeRisk: RouteRecommendation["risk"] | null = risk === "LOWER" || risk === "ELEVATED"
      ? risk
      : null;
    const modelVersion = stringField(candidate, "model_version");
    const evidenceVersion = stringField(candidate, "evidence_version");
    const validUntil = stringField(candidate, "valid_until");
    const validUntilTimestamp = validUntil ? Date.parse(validUntil) : Number.NaN;
    const rawReasons = candidate && typeof candidate === "object"
      ? (candidate as Record<string, unknown>).reasons
      : undefined;
    const reasons = Array.isArray(rawReasons)
      ? rawReasons.filter((reason): reason is string => typeof reason === "string")
      : [];

    if (
      !id
      || seen.has(id)
      || !label
      || duration === undefined
      || duration <= 0
      || distance === undefined
      || distance <= 0
      || !shelter
      || !routeRisk
      || !modelVersion
      || !evidenceVersion
      || !validUntil
      || !Number.isFinite(validUntilTimestamp)
      || validUntilTimestamp <= scenarioTimestamp
    ) {
      return [];
    }
    seen.add(id);
    return [{
      id,
      label,
      duration_min: duration,
      distance_km: distance,
      shelter,
      ...(shelterId ? { shelter_id: shelterId } : {}),
      ...(shelterDetail ? { shelter_detail: shelterDetail } : {}),
      risk: routeRisk,
      reasons,
      model_version: modelVersion,
      evidence_version: evidenceVersion,
      valid_until: validUntil,
    } satisfies RouteRecommendation];
  }).slice(0, 3);
}

function normalizeSources(value: unknown): SourceHealth[] {
  const seen = new Set<string>();
  return readItems(value).flatMap((candidate) => {
    const id = stringField(candidate, "id");
    const provider = stringField(candidate, "provider");
    const status = stringField(candidate, "status");
    const observedAt = stringField(candidate, "observed_at");
    const cadence = stringField(candidate, "cadence");
    const isSimulated = booleanField(candidate, "is_simulated");
    const rawQualityFlags = candidate && typeof candidate === "object"
      ? (candidate as Record<string, unknown>).quality_flags
      : undefined;
    const qualityFlags = Array.isArray(rawQualityFlags)
      ? rawQualityFlags.filter((flag): flag is string => typeof flag === "string")
      : [];
    const declaredMode = stringField(candidate, "source_mode");
    if (
      !id
      || seen.has(id)
      || !provider
      || (status !== "HEALTHY" && status !== "STALE" && status !== "UNKNOWN")
      || !observedAt
      || !Number.isFinite(Date.parse(observedAt))
      || !cadence
      || isSimulated === undefined
    ) {
      return [];
    }
    const sourceMode: NonNullable<SourceHealth["source_mode"]> = qualityFlags.includes("PACKAGED_BASELINE")
      ? "PACKAGED_BASELINE"
      : isSimulated || qualityFlags.includes("DEMO_FIXTURE")
        ? "DEMO_FIXTURE"
        : declaredMode === "LIVE" || qualityFlags.includes("LIVE_AUTHORIZED")
          ? "LIVE"
          : "REFERENCE_DATA";
    seen.add(id);
    return [{
      id,
      provider,
      status,
      observed_at: observedAt,
      cadence,
      is_simulated: isSimulated,
      quality_flags: qualityFlags,
      source_mode: sourceMode,
    }];
  });
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function minutesBetweenOrNull(later: string | undefined, earlier: string | undefined): number | null {
  if (!later || !earlier) return null;
  const laterTimestamp = Date.parse(later);
  const earlierTimestamp = Date.parse(earlier);
  if (!Number.isFinite(laterTimestamp) || !Number.isFinite(earlierTimestamp)) return null;
  return Math.max(0, Math.round((laterTimestamp - earlierTimestamp) / 60_000));
}

function minutesUntilOrNull(later: string | undefined, earlier: string | undefined): number | null {
  if (!later || !earlier) return null;
  const laterTimestamp = Date.parse(later);
  const earlierTimestamp = Date.parse(earlier);
  if (!Number.isFinite(laterTimestamp) || !Number.isFinite(earlierTimestamp)) return null;
  return Math.max(0, Math.round((laterTimestamp - earlierTimestamp) / 60_000));
}

function formatIncidentTimestamp(value: string | undefined): string {
  if (!value) return "Unavailable";
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.valueOf())) return "Unavailable";
  return timestamp.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Kolkata",
    timeZoneName: "short",
  });
}

function normalizeIncidentStatus(value: string | undefined): IncidentRecord["status"] {
  if (value === "ACTIVE" || value === "MONITORING" || value === "CLOSED") return value;
  return "UNKNOWN";
}

function normalizeIncidentSeverity(value: string | undefined): IncidentRecord["severity"] {
  if (value === "SEVERE" || value === "Severe") return "Severe";
  if (value === "HIGH" || value === "High") return "High";
  if (value === "MODERATE" || value === "Moderate") return "Moderate";
  return "Unknown";
}

function normalizeAuthoritativeIncidents(
  bootstrapIncident: unknown,
  incidentList: unknown[],
  incidentId: string,
  scenarioTime: string,
  modelVersion: string,
  impact: Record<string, unknown> | undefined,
): IncidentRecord[] {
  const bootstrapRecord = asRecord(bootstrapIncident);
  const byId = new Map<string, Record<string, unknown>>();
  for (const candidate of incidentList) {
    const record = asRecord(candidate);
    const id = stringField(record, "id");
    if (record && id) byId.set(id, record);
  }
  const bootstrapId = stringField(bootstrapRecord, "id");
  if (bootstrapRecord && bootstrapId) {
    byId.set(bootstrapId, { ...byId.get(bootstrapId), ...bootstrapRecord });
  }
  if (!byId.has(incidentId)) byId.set(incidentId, { id: incidentId });

  const impactSummary = recordField(impact, "summary");
  const impactPopulation = numberField(impact, "affected_population_estimate")
    ?? numberField(impactSummary, "affected_population");

  return [...byId.values()].map((record) => {
    const id = stringField(record, "id") as string;
    const isSelectedIncident = id === incidentId;
    return {
      id,
      name: stringField(record, "name")
        ?? stringField(record, "title")
        ?? `Incident ${id}`,
      status: normalizeIncidentStatus(
        stringField(record, "status") ?? stringField(record, "state"),
      ),
      severity: normalizeIncidentSeverity(stringField(record, "severity")),
      startedAt: formatIncidentTimestamp(stringField(record, "started_at")),
      lastUpdate: formatIncidentTimestamp(
        stringField(record, "updated_at")
          ?? stringField(record, "scenario_time")
          ?? (isSelectedIncident ? scenarioTime : undefined),
      ),
      wards: numberField(record, "ward_count") ?? numberField(record, "wards") ?? null,
      peopleExposed: isSelectedIncident
        ? numberField(record, "people_exposed") ?? impactPopulation ?? null
        : numberField(record, "people_exposed") ?? null,
      modelVersion: isSelectedIncident
        ? modelVersion
        : stringField(record, "model_version") ?? "Unavailable",
    };
  });
}

function normalizeAuthoritativeEvidence(
  reports: unknown[],
  signalId: string,
  clusterId: string | undefined,
): FloodSignalRecord["evidence"] {
  return reports.flatMap((candidate, index) => {
    const report = asRecord(candidate);
    if (!report) return [];
    const reportSignalId = stringField(report, "signal_id");
    const reportClusterId = stringField(report, "cluster_id");
    if (reportSignalId !== signalId && (!clusterId || reportClusterId !== clusterId)) return [];

    const waterDepth = stringField(report, "water_depth") ?? "UNKNOWN";
    const roadStatus = stringField(report, "road_status") ?? "UNKNOWN";
    const observedAt = stringField(report, "observed_at");
    const trusted = booleanField(report, "trusted") === true;
    const channel = stringField(report, "submission_channel");
    return [{
      id: stringField(report, "id") ?? `${signalId}-report-${index + 1}`,
      reporter: "Identity protected",
      source: trusted
        ? "Responder" as const
        : channel === "WEB"
          ? "Web" as const
          : "Mobile app" as const,
      depth: `${waterDepth.toLowerCase().replaceAll("_", " ")} estimate`,
      roadStatus: roadStatus.toLowerCase().replaceAll("_", " "),
      observedAt: formatIst(observedAt, "Unavailable"),
      distanceM: numberField(report, "distance_m") ?? null,
      counted: stringField(report, "disposition") === "ELIGIBLE",
      note: `Privacy-protected ${waterDepth.toLowerCase().replaceAll("_", " ")} depth report; road ${roadStatus.toLowerCase().replaceAll("_", " ")}.`,
    }];
  });
}

function normalizeAuthoritativeSignals(
  value: unknown,
  reportsValue: unknown,
  scenarioTime: string,
): FloodSignalRecord[] {
  const reports = readItems(reportsValue);
  return readItems(value).flatMap((candidate) => {
    const signal = asRecord(candidate);
    const id = stringField(signal, "id");
    if (!signal || !id) return [];
    const state = stringField(signal, "state") ?? "";
    const confidence = numberField(signal, "confidence");
    const clusterId = stringField(signal, "cluster_id");
    return [{
      id,
      apiId: id,
      apiVersion: numberField(signal, "version"),
      name: stringField(signal, "name")
        ?? stringField(signal, "area_name")
        ?? "FloodSignal",
      ward: stringField(signal, "ward") ?? "Ward unavailable",
      area: stringField(signal, "area_name") ?? "Area unavailable",
      updatedMinutesAgo: minutesBetweenOrNull(
        scenarioTime,
        stringField(signal, "last_observed_at"),
      ),
      confidence: confidence === undefined ? 0 : Math.round(confidence * 100),
      independentReports: numberField(signal, "independent_report_count") ?? 0,
      receivedReports: numberField(signal, "report_count") ?? 0,
      authenticatedReports: numberField(signal, "authenticated_report_count") ?? 0,
      conflictReports: numberField(signal, "conflict_count")
        ?? (booleanField(signal, "contradiction_present") ? 1 : 0),
      status: signalStatusFromState(state),
      decision: signalDecisionFromState(
        state,
        stringField(recordField(signal, "human_review"), "decision"),
      ),
      expiresInMinutes: minutesUntilOrNull(
        stringField(signal, "expires_at"),
        scenarioTime,
      ),
      peopleExposed: numberField(signal, "affected_population_estimate") ?? null,
      roadsAtRisk: numberField(signal, "roads_at_risk") ?? null,
      sheltersReachable: numberField(signal, "shelters_reachable") ?? null,
      evidence: normalizeAuthoritativeEvidence(reports, id, clusterId),
    }];
  });
}

function normalizeAuthoritativeActions(
  value: unknown,
  fallbackEvidenceVersion: string,
  fallbackModelVersion: string,
): OperationalAction[] {
  return readItems(value).flatMap((candidate) => {
    const approval = asRecord(candidate);
    const approvalId = stringField(approval, "id");
    const actionType = stringField(approval, "action_type");
    if (
      !approval
      || !approvalId
      || (
        actionType !== "AREA_CAUTION"
        && actionType !== "ROAD_CLOSURE"
        && actionType !== "EVACUATION_GUIDANCE"
      )
    ) return [];
    const payload = recordField(approval, "action_payload");
    const requestedBy = stringField(approval, "requested_by");
    const requestedRole = stringField(approval, "requested_role");
    return [{
      id: stringField(payload, "presentation_id") ?? approvalId,
      approvalId,
      approvalVersion: numberField(approval, "version"),
      title: stringField(payload, "title")
        ?? actionType.toLowerCase().replaceAll("_", " "),
      type: actionType,
      status: actionStatusFromApproval(stringField(approval, "status")),
      requestedBy: requestedBy
        ? `${requestedBy}${requestedRole ? ` · ${requestedRole.replaceAll("_", " ")}` : ""}`
        : "Unavailable",
      requestedById: requestedBy,
      requestedAt: formatIst(stringField(approval, "requested_at"), "Unavailable"),
      expiresAt: formatIst(stringField(approval, "expires_at"), "Unavailable"),
      audience: stringField(approval, "audience") ?? "Unavailable",
      evidenceVersion: stringField(approval, "evidence_version") ?? fallbackEvidenceVersion,
      modelVersion: stringField(approval, "model_version") ?? fallbackModelVersion,
      detail: stringField(payload, "body")
        ?? stringField(approval, "reason")
        ?? "No action detail supplied.",
      decidedById: stringField(approval, "decided_by"),
      decisionReason: stringField(approval, "decision_reason"),
      executionStatus: stringField(approval, "execution_status"),
    }];
  });
}

function normalizeAuthoritativeShelters(
  value: unknown,
  scenarioTime: string,
): ShelterRecord[] {
  return readItems(value).flatMap((candidate) => {
    const shelter = asRecord(candidate);
    const id = stringField(shelter, "id");
    const name = stringField(shelter, "name");
    if (!shelter || !id || !name) return [];
    const rawStatus = stringField(shelter, "activation_status")
      ?? stringField(shelter, "availability");
    const status: ShelterRecord["status"] = rawStatus === "OPEN"
      || rawStatus === "LIMITED"
      || rawStatus === "FULL"
      ? rawStatus
      : "UNKNOWN";
    const capacity = numberField(shelter, "capacity_total")
      ?? numberField(shelter, "capacity")
      ?? null;
    const remaining = numberField(shelter, "capacity_remaining");
    const occupancy = numberField(shelter, "occupancy")
      ?? (capacity !== null && remaining !== undefined
        ? Math.max(0, capacity - remaining)
        : null);
    return [{
      id,
      apiId: id,
      apiVersion: numberField(shelter, "version"),
      name,
      ward: stringField(shelter, "ward")
        ?? stringField(shelter, "area_name")
        ?? "Area unavailable",
      status,
      occupancy,
      capacity,
      access: shelterAccess(stringField(shelter, "access_status"), "Unknown"),
      updatedMinutesAgo: minutesBetweenOrNull(
        scenarioTime,
        stringField(shelter, "verified_at") ?? stringField(shelter, "observed_at"),
      ),
    }];
  });
}

function normalizeAuthoritativePriorities(value: unknown): ResiliencePriority[] {
  return readItems(value).flatMap((candidate, index) => {
    const priority = asRecord(candidate);
    const id = stringField(priority, "id");
    const location = stringField(priority, "location");
    const assetType = stringField(priority, "asset_type");
    if (
      !priority
      || !id
      || !location
      || (assetType !== "Drainage" && assetType !== "Road" && assetType !== "Shelter")
    ) return [];
    const years = priority.event_years;
    return [{
      rank: numberField(priority, "rank") ?? index + 1,
      id,
      location,
      ward: stringField(priority, "ward") ?? "Area unavailable",
      assetType,
      eventYears: Array.isArray(years)
        ? years.filter((year): year is number => typeof year === "number" && Number.isInteger(year))
        : [],
      hasOfficialEvidence: booleanField(priority, "has_official_evidence") === true,
      evidence: stringField(priority, "evidence") ?? "Evidence summary unavailable",
      impact: stringField(priority, "impact") ?? "Impact summary unavailable",
      confidence: numberField(priority, "confidence") ?? 0,
      recurrence: numberField(priority, "recurrence") ?? 0,
      accessDelay: numberField(priority, "access_delay") ?? 0,
      population: numberField(priority, "population") ?? 0,
      recommendation: stringField(priority, "recommendation")
        ?? "Assess this location before proposing an intervention.",
    }];
  });
}

function normalizeAuthoritativeBootstrap(
  raw: unknown,
  incidentId: string,
  incidentList: unknown[],
): OperationsSnapshot {
  const value = asRecord(raw);
  if (!value) {
    throw new ApiRequestError(
      "The authority service returned an invalid incident bootstrap.",
      502,
      "INVALID_OPERATIONAL_BOOTSTRAP",
    );
  }
  const incident = recordField(value, "incident");
  if (
    booleanField(value, "demo_mode") === true
    || stringField(value, "data_label") === "DEMO DATA"
    || booleanField(incident, "is_demo") === true
    || stringField(incident, "data_label") === "DEMO DATA"
  ) {
    throw new ApiRequestError(
      "The authority endpoint returned a deterministic demo incident. Live operations remain closed.",
      503,
      "DEMO_LIVE_BOUNDARY_VIOLATION",
    );
  }
  const simulation = recordField(value, "simulation")
    ?? recordField(value, "active_simulation");
  const impact = recordField(value, "latest_impact")
    ?? recordField(value, "impacts");
  const scenarioTime = stringField(value, "scenario_clock")
    ?? stringField(value.scenario_clock, "current_time")
    ?? stringField(value.scenario_clock, "scenario_time")
    ?? stringField(incident, "scenario_time")
    ?? stringField(value, "server_time")
    ?? "";
  const modelVersion = stringField(simulation, "model_version")
    ?? stringField(simulation, "version")
    ?? stringField(impact, "model_version")
    ?? "Unavailable";
  const normalizedSignals = normalizeAuthoritativeSignals(
    value.signals,
    value.reports,
    scenarioTime,
  );
  const evidenceVersion = stringField(simulation, "evidence_version")
    ?? stringField(impact, "evidence_version")
    ?? normalizedSignals.map((signal) => {
      const rawSignal = readItems(value.signals).find(
        (candidate) => stringField(candidate, "id") === signal.apiId,
      );
      return stringField(rawSignal, "evidence_version");
    }).find((candidate): candidate is string => Boolean(candidate))
    ?? "Unavailable";

  return {
    incidentId,
    scenarioTime,
    step: numberField(value, "step") ?? 0,
    modelVersion,
    evidenceVersion,
    signals: normalizedSignals,
    incidents: normalizeAuthoritativeIncidents(
      incident,
      incidentList,
      incidentId,
      scenarioTime,
      modelVersion,
      impact,
    ),
    sources: normalizeSources(value.sources),
    shelters: normalizeAuthoritativeShelters(value.shelters, scenarioTime),
    routes: normalizeRoutes(value.routes, scenarioTime),
    actions: normalizeAuthoritativeActions(
      value.approvals,
      evidenceVersion,
      modelVersion,
    ),
    priorities: normalizeAuthoritativePriorities(value.resilience),
    audit: [],
  };
}

function normalizeDemoBootstrap(raw: unknown, incidentId: string): OperationsSnapshot {
  if (!raw || typeof raw !== "object") return demoSnapshot;
  const value = raw as Record<string, unknown>;
  const simulation = value.simulation && typeof value.simulation === "object"
    ? value.simulation as Record<string, unknown>
    : {};
  const scenarioTime = typeof value.scenario_clock === "string"
    ? value.scenario_clock
    : stringField(value.scenario_clock, "current_time") ?? stringField(value.scenario_clock, "scenario_time");
  const effectiveScenarioTime = scenarioTime ?? demoSnapshot.scenarioTime;

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
  const humanReview = recordField(primarySignal, "human_review");
  const humanDecision = stringField(humanReview, "decision");
  const apiStatus = signalStatusFromState(signalState ?? "");
  const apiDecision = signalDecisionFromState(signalState ?? "", humanDecision);
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
    const capacity = numberField(apiShelter, "capacity_total") ?? numberField(apiShelter, "capacity") ?? shelter.capacity ?? 0;
    const remaining = numberField(apiShelter, "capacity_remaining");
    const occupancy = numberField(apiShelter, "occupancy") ?? (remaining === undefined ? shelter.occupancy ?? 0 : Math.max(0, capacity - remaining));
    return {
      ...shelter,
      apiId: stringField(apiShelter, "id"),
      apiVersion: numberField(apiShelter, "version"),
      status: shelterStatus(stringField(apiShelter, "activation_status") ?? stringField(apiShelter, "availability"), shelter.status),
      occupancy,
      capacity,
      access: shelterAccess(stringField(apiShelter, "access_status"), shelter.access),
      updatedMinutesAgo: minutesBetween(scenarioTime, stringField(apiShelter, "verified_at") ?? stringField(apiShelter, "observed_at"), shelter.updatedMinutesAgo ?? 0),
    } satisfies ShelterRecord;
  });
  const routes = normalizeRoutes(value.routes, effectiveScenarioTime);
  const sources = normalizeSources(value.sources);

  // The deterministic bundle remains the presentation-safe baseline. Current
  // authoritative signal identifiers, versions, counts, and evidence replace
  // fixture values when the API has processed live demo reports.
  return {
    ...demoSnapshot,
    incidentId,
    scenarioTime: effectiveScenarioTime,
    modelVersion: stringField(simulation, "version") ?? stringField(simulation, "model_version") ?? demoSnapshot.modelVersion,
    signals,
    actions,
    shelters,
    routes,
    sources,
  };
}

export async function fetchOperationsSnapshot(
  identity?: StaffApiIdentity,
  options: { allowDemoFallback?: boolean } = {},
): Promise<{ snapshot: OperationsSnapshot; connected: boolean }> {
  try {
    const incidentsResponse = await request<unknown>("/incidents", undefined, BOOTSTRAP_TIMEOUT_MS, identity);
    const incidents = readItems(incidentsResponse);
    const first = incidents[0];
    const incidentId = stringField(first, "id")
      ?? (options.allowDemoFallback === false ? undefined : demoSnapshot.incidentId);
    if (!incidentId) {
      throw new ApiRequestError(
        "The authority service returned no operational incident.",
        503,
        "NO_OPERATIONAL_INCIDENT",
      );
    }
    const bootstrap = await request<unknown>(`/incidents/${encodeURIComponent(incidentId)}/bootstrap`, undefined, BOOTSTRAP_TIMEOUT_MS, identity);
    return {
      snapshot: options.allowDemoFallback === false
        ? normalizeAuthoritativeBootstrap(bootstrap, incidentId, incidents)
        : normalizeDemoBootstrap(bootstrap, incidentId),
      connected: true,
    };
  } catch (error) {
    if (options.allowDemoFallback === false) throw error;
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
  const apiDecision = decision === "VERIFIED"
    ? "VERIFY"
    : decision === "REJECTED"
      ? "REJECT"
      : "FIELD_CHECK";
  const apiSignalId = signalId.startsWith("signal-") ? signalId : `signal-${signalId.toLowerCase()}`;
  return request<{
    id: string;
    state: string;
    version: number;
    human_decision?: string | null;
    human_review?: {
      decision?: string | null;
    } | null;
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
    status: "PENDING" | "APPROVED" | "MODIFIED" | "REJECTED" | "EXPIRED" | "CANCELLED";
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
  if (
    !shelter.apiId
    || !shelter.apiVersion
    || shelter.capacity === null
    || status === "UNKNOWN"
  ) {
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
