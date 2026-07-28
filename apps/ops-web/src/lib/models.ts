import type { RouteRecommendation, SourceHealth } from "@floodrise/contracts";

export type ViewId =
  | "live"
  | "signals"
  | "incidents"
  | "evacuation"
  | "shelters"
  | "resilience"
  | "sources"
  | "audit";

export type StaffRole =
  | "Incident commander"
  | "Verifier"
  | "Field responder"
  | "Resilience engineer"
  | "Shelter manager"
  | "Auditor"
  | "Identity administrator";

export type StaffApiIdentity = {
  role: "incident_commander" | "verifier" | "responder" | "engineer" | "shelter_manager" | "auditor" | "identity_administrator";
  userId: string;
};

export type SignalDecision = "UNREVIEWED" | "VERIFIED" | "FIELD_CHECK" | "REJECTED";

export type EvidenceReport = {
  id: string;
  reporter: string;
  source: "Mobile app" | "Web" | "Responder";
  depth: string;
  roadStatus: string;
  observedAt: string;
  distanceM: number;
  counted: boolean;
  note: string;
};

export type FloodSignalRecord = {
  id: string;
  apiId?: string;
  apiVersion?: number;
  name: string;
  ward: string;
  area: string;
  updatedMinutesAgo: number;
  confidence: number;
  independentReports: number;
  receivedReports: number;
  authenticatedReports: number;
  conflictReports: number;
  status: "NEEDS_REVIEW" | "COMMUNITY_CORROBORATED" | "DISPUTED";
  decision: SignalDecision;
  expiresInMinutes: number;
  peopleExposed: number;
  roadsAtRisk: number;
  sheltersReachable: number;
  evidence: EvidenceReport[];
};

export type IncidentRecord = {
  id: string;
  name: string;
  status: "ACTIVE" | "MONITORING" | "CLOSED";
  severity: "Severe" | "High" | "Moderate";
  startedAt: string;
  lastUpdate: string;
  wards: number;
  peopleExposed: number;
  modelVersion: string;
};

export type ShelterRecord = {
  id: string;
  apiId?: string;
  apiVersion?: number;
  name: string;
  ward: string;
  status: "OPEN" | "LIMITED" | "FULL";
  occupancy: number;
  capacity: number;
  access: "Reachable" | "At risk" | "Unknown";
  updatedMinutesAgo: number;
};

export type OperationalAction = {
  id: string;
  approvalId?: string;
  approvalVersion?: number;
  title: string;
  type: "AREA_CAUTION" | "ROAD_CLOSURE" | "EVACUATION_GUIDANCE";
  status: "RECOMMENDED" | "PENDING_APPROVAL" | "APPROVED" | "MODIFIED" | "REJECTED" | "EXPIRED";
  requestedBy: string;
  requestedById?: string;
  requestedAt: string;
  expiresAt: string;
  audience: string;
  evidenceVersion: string;
  modelVersion: string;
  detail: string;
  decidedById?: string;
  decisionReason?: string;
  executionStatus?: string;
};

export type ResiliencePriority = {
  rank: number;
  id: string;
  location: string;
  ward: string;
  assetType: "Drainage" | "Road" | "Shelter";
  eventYears: number[];
  hasOfficialEvidence: boolean;
  evidence: string;
  impact: string;
  confidence: number;
  recurrence: number;
  accessDelay: number;
  population: number;
  recommendation: string;
};

export type AuditRecord = {
  id: string;
  occurredAt: string;
  actor: string;
  role: string;
  event: string;
  resource: string;
  outcome: "RECORDED" | "APPROVED" | "REJECTED";
  hash: string;
};

export type OperationsSnapshot = {
  incidentId: string;
  scenarioTime: string;
  step: number;
  modelVersion: string;
  evidenceVersion: string;
  signals: FloodSignalRecord[];
  incidents: IncidentRecord[];
  sources: SourceHealth[];
  shelters: ShelterRecord[];
  routes: RouteRecommendation[];
  actions: OperationalAction[];
  priorities: ResiliencePriority[];
  audit: AuditRecord[];
};
