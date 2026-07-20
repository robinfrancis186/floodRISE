import { describe, expect, it } from "vitest";
import { defaultReportValues, reportFormSchema } from "./report-schema";

describe("field report form contract", () => {
  it("accepts the default accessible reporting choices", () => {
    expect(reportFormSchema.parse(defaultReportValues)).toEqual(defaultReportValues);
  });

  it("enforces the public note limit", () => {
    const result = reportFormSchema.safeParse({ ...defaultReportValues, note: "a".repeat(251) });
    expect(result.success).toBe(false);
  });

  it("allows multiple infrastructure issues", () => {
    const result = reportFormSchema.parse({
      ...defaultReportValues,
      infrastructureIssues: ["BLOCKED_DRAIN", "POWER_HAZARD"]
    });
    expect(result.infrastructureIssues).toHaveLength(2);
  });
});
