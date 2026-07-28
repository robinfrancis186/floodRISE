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
  location: z.object({
    latitude: z.number().min(-90).max(90),
    longitude: z.number().min(-180).max(180),
    // Preserve imprecise fixes for human review. The 100 m live-eligibility
    // policy is enforced by the domain and routing layers, not data capture.
    accuracy_m: z.number().min(0).max(10_000),
  }),
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
  quality_flags?: string[];
  source_mode?: "DEMO_FIXTURE" | "PACKAGED_BASELINE" | "LIVE" | "REFERENCE_DATA";
};

export type RouteRecommendation = {
  id: string;
  label: string;
  duration_min: number;
  distance_km: number;
  shelter: string;
  shelter_id?: string;
  shelter_detail?: {
    id: string;
    name: string;
    status?: "OPEN" | "LIMITED" | "FULL";
    access?: "Reachable" | "At risk" | "Unknown";
    capacity?: number;
    remaining_capacity?: number;
    observed_at?: string;
    updated_minutes_ago?: number;
    version?: number;
    warnings?: string[];
  } | null;
  risk: "LOWER" | "ELEVATED";
  reasons: string[];
  model_version: string;
  evidence_version: string;
  valid_until: string;
};
