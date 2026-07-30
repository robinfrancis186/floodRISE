import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEMO_FIELD_RUNTIME,
  type LiveFieldRuntime
} from "./field-runtime";
import { recoverAuthoritativeReceipt } from "./receipt-recovery";

const liveRuntime: LiveFieldRuntime = {
  mode: "live",
  incidentId: "incident-live-ernakulam-1",
  referenceTime: "2026-07-30T10:00:00.000Z",
  incidentName: "Ernakulam flood response",
  areaName: "Ernakulam district",
  incidentStatus: "ACTIVE"
};

function reportResponse(overrides: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({
    id: "report-live-1",
    incident_id: liveRuntime.incidentId,
    received_at: "2026-07-30T10:01:00.000Z",
    disposition: "ELIGIBLE",
    is_simulated: false,
    note: "must not be retained by receipt recovery",
    ...overrides
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("authoritative receipt recovery", () => {
  it("rebuilds only the minimal receipt for the active live incident", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reportResponse());
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      recoverAuthoritativeReceipt("report-live-1", liveRuntime)
    ).resolves.toEqual({
      id: "report-live-1",
      clientReportId: "report-live-1",
      reference: "report-live-1",
      receivedAt: "2026-07-30T10:01:00.000Z",
      placeLabel: "Ernakulam district",
      status: "RECEIVED",
      source: "API",
      message: "Report received and eligible for community corroboration."
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/reports/report-live-1",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("rejects simulated or cross-incident reports at the live boundary", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(reportResponse({ is_simulated: true }))
      .mockResolvedValueOnce(reportResponse({ incident_id: "incident-other" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(recoverAuthoritativeReceipt("report-live-1", liveRuntime)).resolves.toBeNull();
    await expect(recoverAuthoritativeReceipt("report-live-1", liveRuntime)).resolves.toBeNull();
  });

  it("does not make a request without verified incident context", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      recoverAuthoritativeReceipt("report-live-1", {
        ...liveRuntime,
        incidentId: null,
        referenceTime: null
      })
    ).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps deterministic recovery explicitly bound to the demo runtime", async () => {
    const fetchMock = vi.fn().mockResolvedValue(reportResponse({
      id: "report-demo-1",
      incident_id: DEMO_FIELD_RUNTIME.incidentId,
      received_at: DEMO_FIELD_RUNTIME.referenceTime,
      is_simulated: true
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      recoverAuthoritativeReceipt("report-demo-1", DEMO_FIELD_RUNTIME)
    ).resolves.toMatchObject({
      id: "report-demo-1",
      placeLabel: "Aluva, Kerala",
      source: "API"
    });
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers as HeadersInit);
    expect(headers.get("X-Demo-Role")).toBe("reporter");
  });
});
