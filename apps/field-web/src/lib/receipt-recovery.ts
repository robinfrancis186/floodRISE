import { z } from "zod";
import type { ReportReceipt } from "./db";
import type { FieldRuntime } from "./field-runtime";
import { cloudFetch } from "./cloud-security";

const API_BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/u, "")
  ?? "/api/v1";

const RecoverableReport = z.object({
  id: z.string().min(1),
  incident_id: z.string().min(1),
  received_at: z.string().datetime(),
  disposition: z.enum(["ELIGIBLE", "DUPLICATE", "LATE", "INVALID"]),
  is_simulated: z.boolean()
});

function dispositionMessage(disposition: z.infer<typeof RecoverableReport>["disposition"]) {
  if (disposition === "ELIGIBLE") {
    return "Report received and eligible for community corroboration.";
  }
  if (disposition === "DUPLICATE") {
    return "Report retained, but it does not add an independent corroboration vote.";
  }
  if (disposition === "LATE") {
    return "Historical report retained; it cannot trigger a live caution.";
  }
  return "Report retained for authorized review.";
}

/**
 * Rebuild a minimal receipt from the authenticated authoritative report when
 * the browser could not persist its local acknowledgement. No report body,
 * identity field, note, media reference, or precise coordinate is requested or
 * retained by this recovery path.
 */
export async function recoverAuthoritativeReceipt(
  reportId: string,
  runtime: FieldRuntime
): Promise<ReportReceipt | null> {
  if (!runtime.incidentId || reportId.length > 256) return null;
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await cloudFetch(
      `${API_BASE}/reports/${encodeURIComponent(reportId)}`,
      {
        headers: runtime.mode === "demo"
          ? { "X-Demo-Role": "reporter", "X-Demo-User": "field-pwa" }
          : undefined,
        signal: controller.signal
      }
    );
    if (!response.ok) return null;
    const parsed = RecoverableReport.safeParse(await response.json());
    if (
      !parsed.success
      || parsed.data.id !== reportId
      || parsed.data.incident_id !== runtime.incidentId
      || parsed.data.is_simulated !== (runtime.mode === "demo")
    ) {
      return null;
    }
    return {
      id: parsed.data.id,
      clientReportId: parsed.data.id,
      reference: parsed.data.id,
      receivedAt: parsed.data.received_at,
      placeLabel: runtime.areaName ?? "Submitted incident area",
      status: parsed.data.disposition === "INVALID" ? "UNDER_REVIEW" : "RECEIVED",
      source: "API",
      message: dispositionMessage(parsed.data.disposition)
    };
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}
