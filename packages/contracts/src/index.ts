import { z } from "zod";

export const SignalState = z.enum([
  "CANDIDATE",
  "CORROBORATING",
  "COMMUNITY_CORROBORATED",
  "NEEDS_REVIEW",
  "DISPUTED",
  "STALE",
  "EXPIRED",
  "RESOLVED",
]);

export const ReportInput = z.object({
  client_report_id: z.string().min(8),
  incident_id: z.string(),
  reporter_id: z.string(),
  device_id: z.string(),
  observed_at: z.string().datetime(),
  location: z.object({ latitude: z.number(), longitude: z.number(), accuracy_m: z.number().max(100) }),
  water_depth: z.enum(["ANKLE", "KNEE", "WAIST", "ABOVE_WAIST"]),
  road_status: z.enum(["OPEN", "DIFFICULT", "IMPASSABLE"]),
  infrastructure_issues: z.array(z.string()).default([]),
  note: z.string().max(250).optional(),
  media_upload_ids: z.array(z.string()).max(5).optional(),
});

export type ReportInput = z.infer<typeof ReportInput>;
export type SignalState = z.infer<typeof SignalState>;

export type SourceHealth = {
  id: string;
  provider: string;
  status: "HEALTHY" | "STALE" | "UNKNOWN";
  observed_at: string;
  cadence: string;
  is_simulated: boolean;
};

export type RouteRecommendation = {
  id: string;
  label: string;
  duration_min: number;
  distance_km: number;
  shelter: string;
  risk: "LOWER" | "ELEVATED";
  reasons: string[];
  model_version: string;
  evidence_version: string;
  valid_until: string;
};
