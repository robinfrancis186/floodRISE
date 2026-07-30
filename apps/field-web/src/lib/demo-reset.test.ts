import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearFieldDatabaseForTests, enqueueReport, getQueueSummary, type OfflineReportDraft } from "./db";
import { clearThisDemoDevice } from "./demo-reset";

const report: OfflineReportDraft = {
  client_report_id: "demo-reset-report",
  incident_id: "inc-demo-kerala-flood-2023",
  reporter_id: "reporter-reset",
  device_id: "device-reset",
  observed_at: "2023-12-04T14:08:00Z",
  location: { latitude: 10.1041000, longitude: 76.3519000, accuracy_m: 12 },
  water_depth: "KNEE",
  road_status: "DIFFICULT",
  infrastructure_issues: [],
  place_label: "Aluva–Paravur Road"
};

describe("demo device reset safety boundary", () => {
  beforeEach(async () => {
    await clearFieldDatabaseForTests();
    localStorage.clear();
    sessionStorage.clear();
    await enqueueReport(report);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses to delete local evidence unless the API proves demo mode", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      demo_mode: false,
      data_label: "LIVE",
      environment: "production"
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await expect(clearThisDemoDevice()).rejects.toThrow(/not an isolated demo runtime/i);
    await expect(getQueueSummary()).resolves.toMatchObject({ count: 1 });
  });

  it("clears demo evidence and rehearsal flags but retains the device identity", async () => {
    localStorage.setItem("floodrise.field.last-sync", "2023-12-04T14:10:00Z");
    localStorage.setItem("floodrise.field.device-id", "device-reset");
    sessionStorage.setItem("floodrise.field.force-offline", "1");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      demo_mode: true,
      data_label: "DEMO DATA",
      environment: "demo"
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    await expect(clearThisDemoDevice()).resolves.toMatchObject({ queuedDrafts: 1, environment: "demo" });
    await expect(getQueueSummary()).resolves.toMatchObject({ count: 0 });
    expect(localStorage.getItem("floodrise.field.last-sync")).toBeNull();
    expect(sessionStorage.getItem("floodrise.field.force-offline")).toBeNull();
    expect(localStorage.getItem("floodrise.field.device-id")).toBe("device-reset");
  });
});
