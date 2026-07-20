import type { RouteRecommendation } from "@floodrise/contracts";

export const DEMO_INCIDENT_ID = "inc-demo-michaung-2023";
// Single deterministic checkpoint shared by the backend reset, operations
// console, and field fallback data (19:40 IST).
export const DEMO_SCENARIO_TIME = "2023-12-04T14:10:00.000Z";

export type FieldAlert = {
  id: string;
  kind: "OFFICIAL" | "COMMUNITY_CAUTION" | "SYSTEM";
  title: string;
  description: string;
  area: string;
  issuedAt: string;
  validUntil: string;
  severity: "INFO" | "CAUTION" | "DANGER";
  isSimulated: boolean;
};

export const demoAlerts: FieldAlert[] = [
  {
    id: "alert-velachery-corroborated",
    kind: "COMMUNITY_CAUTION",
    title: "Recent flooding reports near Velachery Main Road",
    description:
      "Corroborated by 4 independent recent reports; not an official confirmation. Avoid entering floodwater and check your route before travelling.",
    area: "Velachery · within 1 km",
    issuedAt: "2023-12-04T14:08:00.000Z",
    validUntil: "2023-12-04T14:38:00.000Z",
    severity: "CAUTION",
    isSimulated: true
  },
  {
    id: "alert-adyar-warning",
    kind: "OFFICIAL",
    title: "Heavy rainfall caution",
    description:
      "Stay away from low-lying roads and follow instructions from authorized emergency officials.",
    area: "Adyar basin",
    issuedAt: "2023-12-04T13:50:00.000Z",
    validUntil: "2023-12-04T15:10:00.000Z",
    severity: "DANGER",
    isSimulated: true
  },
  {
    id: "alert-source-freshness",
    kind: "SYSTEM",
    title: "Rapid impact estimate updated",
    description:
      "Rainfall and community evidence were incorporated into model v2023.12.04-1410. Predictions are estimates, not certified flood depths.",
    area: "Chennai demo area",
    issuedAt: "2023-12-04T14:10:00.000Z",
    validUntil: "2023-12-04T14:20:00.000Z",
    severity: "INFO",
    isSimulated: true
  }
];

export const demoRoutes: RouteRecommendation[] = [
  {
    id: "route-school-shelter-west",
    label: "Via 100 Feet Road",
    duration_min: 18,
    distance_km: 3.4,
    shelter: "Velachery School Shelter",
    risk: "LOWER",
    reasons: [
      "Avoids the corroborated flooding cluster",
      "No authorized closures on this route",
      "Shelter access reported open"
    ],
    model_version: "model-v2023.12.04-1410",
    evidence_version: "evidence-v2023.12.04-1408",
    valid_until: "2023-12-04T14:20:00.000Z"
  },
  {
    id: "route-community-hall",
    label: "Via Taramani Link Road",
    duration_min: 24,
    distance_km: 4.1,
    shelter: "Taramani Community Hall",
    risk: "ELEVATED",
    reasons: [
      "Longer route with older road observations",
      "Avoids estimated depth above 0.15 m"
    ],
    model_version: "model-v2023.12.04-1410",
    evidence_version: "evidence-v2023.12.04-1408",
    valid_until: "2023-12-04T14:20:00.000Z"
  }
];

export const fieldConditions = [
  {
    id: "condition-velachery",
    status: "COMMUNITY",
    title: "Velachery Main Road",
    detail: "4 independent recent reports · not official confirmation",
    age: "8 min ago"
  },
  {
    id: "condition-taramani",
    status: "PREDICTED",
    title: "Taramani low-lying roads",
    detail: "Elevated risk in the +3h rapid impact estimate",
    age: "Model updated 10 min ago"
  },
  {
    id: "condition-shelter",
    status: "OPEN",
    title: "Velachery School Shelter",
    detail: "Reported open · capacity not confirmed",
    age: "Checked 22 min ago"
  }
] as const;
