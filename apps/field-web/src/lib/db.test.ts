import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearDemoFieldData,
  clearFieldDatabaseForTests,
  decryptQueueRecord,
  enqueueReport,
  fieldDb,
  getQueueSummary,
  listQueuedReports,
  purgeExpiredReports,
  QUEUE_EXPIRY_MS,
  saveReceipt,
  type OfflineReportDraft
} from "./db";

const now = Date.now();

function draft(id = "f42e61fb-3699-4c69-8107-4066ef8a73d1"): OfflineReportDraft {
  return {
    client_report_id: id,
    incident_id: "inc-demo-michaung-2023",
    reporter_id: "reporter-a",
    device_id: "device-a",
    observed_at: "2023-12-04T08:39:00.000Z",
    location: { latitude: 12.9791, longitude: 80.2209, accuracy_m: 12 },
    water_depth: "KNEE",
    road_status: "DIFFICULT",
    infrastructure_issues: ["BLOCKED_DRAIN"],
    note: "Water rising near bus stop.",
    place_label: "Velachery Main Road"
  };
}

describe("encrypted offline queue", () => {
  beforeEach(async () => {
    await clearFieldDatabaseForTests();
  });

  afterEach(async () => {
    await fieldDb.close();
  });

  it("stores only ciphertext while preserving the immutable report payload", async () => {
    const report = draft();
    const record = await enqueueReport(report, now);

    expect(record.ciphertext.length).toBeGreaterThan(0);
    expect(JSON.stringify(record)).not.toContain("Water rising near bus stop");
    await expect(decryptQueueRecord(record)).resolves.toEqual(report);
    await expect(getQueueSummary()).resolves.toMatchObject({ count: 1 });
  });

  it("deduplicates the client id through the IndexedDB primary key", async () => {
    await enqueueReport(draft(), now);
    await expect(enqueueReport(draft(), now + 1)).rejects.toThrow();
    expect((await listQueuedReports()).length).toBe(1);
  });

  it("deletes unsent encrypted evidence after 24 hours", async () => {
    await enqueueReport(draft(), now);
    expect(await purgeExpiredReports(now + QUEUE_EXPIRY_MS)).toBe(1);
    await expect(getQueueSummary()).resolves.toMatchObject({ count: 0, bytes: 0 });
  });

  it("clears this demo origin's drafts, receipts, and encryption key", async () => {
    await enqueueReport(draft(), now);
    await saveReceipt({
      id: "receipt-demo-reset",
      clientReportId: "submitted-demo-report",
      reference: "FR-RESET",
      receivedAt: "2023-12-04T14:10:00Z",
      placeLabel: "Velachery Main Road",
      status: "RECEIVED",
      source: "DEMO",
      message: "Synthetic receipt"
    });

    await expect(clearDemoFieldData()).resolves.toEqual({ queuedDrafts: 1, receipts: 1 });
    await expect(getQueueSummary()).resolves.toMatchObject({ count: 0, bytes: 0 });
    await expect(fieldDb.receipts.count()).resolves.toBe(0);
    await expect(fieldDb.keys.count()).resolves.toBe(0);
  });
});
