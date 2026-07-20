import { z } from "zod";

export const reportFormSchema = z.object({
  waterDepth: z.enum(["ANKLE", "KNEE", "WAIST", "ABOVE_WAIST"]),
  roadStatus: z.enum(["OPEN", "DIFFICULT", "IMPASSABLE"]),
  infrastructureIssues: z.array(z.enum(["BLOCKED_DRAIN", "FALLEN_TREE", "BRIDGE_DAMAGE", "POWER_HAZARD"])),
  note: z.string().trim().max(250, "Keep the note to 250 characters or fewer.")
});

export type ReportFormValues = z.infer<typeof reportFormSchema>;

export const defaultReportValues: ReportFormValues = {
  waterDepth: "KNEE",
  roadStatus: "DIFFICULT",
  infrastructureIssues: ["BLOCKED_DRAIN"],
  note: ""
};
