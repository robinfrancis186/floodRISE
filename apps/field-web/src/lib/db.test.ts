import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearDemoFieldData,
  clearFieldDatabaseForTests,
  deleteQueuedReport,
  decryptQueueRecord,
  enqueueReport,
  fieldDb,
  getReceipt,
  getQueueSummary,
  listQueuedReports,
  purgeExpiredReports,
  QUEUE_EXPIRY_MS,
  QUEUE_LIMIT_BYTES,
  rememberReceiptForSession,
  saveReceipt,
  type OfflineReportDraft
} from "./db";

const now = Date.now();

function draft(id = "f42e61fb-3699-4c69-8107-4066ef8a73d1"): OfflineReportDraft {
  return {
    client_report_id: id,
    incident_id: "inc-demo-kerala-flood-2023",
    reporter_id: "reporter-a",
    device_id: "device-a",
    observed_at: "2023-12-04T08:39:00.000Z",
    location: { latitude: 10.1041000, longitude: 76.3519000, accuracy_m: 12 },
    water_depth: "KNEE",
    road_status: "DIFFICULT",
    infrastructure_issues: ["BLOCKED_DRAIN"],
    note: "Water rising near bus stop.",
    place_label: "Aluva–Paravur Road"
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

  it("elects one encryption key and atomically caps concurrent admission at 100 reports", async () => {
    const attempts = Array.from({ length: 101 }, (_value, index) =>
      enqueueReport(
        draft(`f42e61fb-3699-4c69-8107-${String(index).padStart(12, "0")}`),
        now + index
      )
    );

    const results = await Promise.allSettled(attempts);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(100);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await fieldDb.keys.count()).toBe(1);
    expect(await fieldDb.queue.count()).toBe(100);

    const records = await fieldDb.queue.toArray();
    await expect(Promise.all(records.map(decryptQueueRecord))).resolves.toHaveLength(100);
  });

  it("checks the byte limit inside the same queue admission transaction", async () => {
    await fieldDb.queue.add({
      id: "existing-near-limit",
      createdAt: now,
      expiresAt: now + QUEUE_EXPIRY_MS,
      sizeBytes: QUEUE_LIMIT_BYTES - 1,
      state: "QUEUED",
      attempts: 0,
      iv: "AA==",
      ciphertext: "AA=="
    });

    await expect(enqueueReport(draft(), now)).rejects.toThrow(
      "Offline evidence storage reached 100 MB"
    );
    expect(await fieldDb.queue.count()).toBe(1);
  });

  it("isolates an unreadable record without hiding removable or healthy drafts", async () => {
    const healthy = await enqueueReport(draft("healthy-report-client-0001"), now);
    const damaged = await enqueueReport(draft("damaged-report-client-0001"), now + 1);
    await fieldDb.queue.update(damaged.id, { ciphertext: "not-valid-base64!" });

    const queued = await listQueuedReports();
    expect(queued).toHaveLength(2);
    expect(queued.find(({ record }) => record.id === damaged.id)).toMatchObject({
      draft: null,
      decryptionFailed: true
    });
    expect(queued.find(({ record }) => record.id === healthy.id)).toMatchObject({
      draft: expect.objectContaining({ client_report_id: healthy.id }),
      decryptionFailed: false
    });

    await deleteQueuedReport(damaged.id);
    await expect(listQueuedReports()).resolves.toHaveLength(1);
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
      placeLabel: "Aluva–Paravur Road",
      status: "RECEIVED",
      source: "DEMO",
      message: "Synthetic receipt"
    });

    await expect(clearDemoFieldData()).resolves.toEqual({ queuedDrafts: 1, receipts: 1 });
    await expect(getQueueSummary()).resolves.toMatchObject({ count: 0, bytes: 0 });
    await expect(fieldDb.receipts.count()).resolves.toBe(0);
    await expect(fieldDb.keys.count()).resolves.toBe(0);
  });

  it("keeps an accepted acknowledgement available in memory when durable receipt storage fails", async () => {
    const receipt = {
      id: "accepted-report-session-receipt",
      clientReportId: "accepted-client-report",
      reference: "FR-ACCEPTED",
      receivedAt: "2023-12-04T14:10:00Z",
      placeLabel: "Aluva–Paravur Road",
      status: "RECEIVED" as const,
      source: "API" as const,
      message: "Report received."
    };

    rememberReceiptForSession(receipt);
    await expect(getReceipt(receipt.id)).resolves.toEqual(receipt);
    await expect(fieldDb.receipts.get(receipt.id)).resolves.toBeUndefined();
  });
});
