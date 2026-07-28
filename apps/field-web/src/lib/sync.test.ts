import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OfflineReportDraft, ReportReceipt } from "./db";
import {
  clearFieldDatabaseForTests,
  decryptQueueRecord,
  enqueueReport,
  fieldDb
} from "./db";

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return { ...actual, submitReport: vi.fn() };
});

import { submitReport } from "./api";
import { syncQueuedReports } from "./sync";

const draft: OfflineReportDraft = {
  client_report_id: "sync-report-immutable-0001",
  incident_id: "inc-demo-kerala-flood-2023",
  reporter_id: "field-reporter",
  device_id: "field-device",
  observed_at: "2023-12-04T14:08:00.000Z",
  location: { latitude: 10.1041000, longitude: 76.3519000, accuracy_m: 12 },
  water_depth: "KNEE",
  road_status: "DIFFICULT",
  infrastructure_issues: ["BLOCKED_DRAIN"],
  place_label: "Aluva–Paravur Road"
};

const receipt: ReportReceipt = {
  id: "report-authoritative-0001",
  clientReportId: draft.client_report_id,
  reference: "report-authoritative-0001",
  receivedAt: "2023-12-04T14:10:00.000Z",
  placeLabel: draft.place_label,
  status: "RECEIVED",
  source: "API",
  message: "Report received."
};

describe("offline queue synchronization", () => {
  beforeEach(async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
    sessionStorage.clear();
    localStorage.clear();
    vi.mocked(submitReport).mockReset();
    await clearFieldDatabaseForTests();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fieldDb.close();
  });

  it("replays the same accepted report when local receipt storage fails", async () => {
    await enqueueReport(draft);
    vi.mocked(submitReport).mockResolvedValue(receipt);
    const putSpy = vi.spyOn(fieldDb.receipts, "put").mockRejectedValueOnce(
      new DOMException("Storage temporarily unavailable", "QuotaExceededError")
    );

    const first = await syncQueuedReports();

    expect(first).toMatchObject({ synced: 0, failed: 1, needsAction: 0 });
    expect(first.nextRetryAt).not.toBeNull();
    const retained = await fieldDb.queue.get(draft.client_report_id);
    expect(retained).toMatchObject({
      state: "RETRY",
      lastError: expect.stringMatching(/accepted by the API.*receipt storage will retry/i)
    });

    putSpy.mockRestore();
    await fieldDb.queue.update(draft.client_report_id, { nextAttemptAt: Date.now() - 1 });
    const due = await fieldDb.queue.get(draft.client_report_id);
    expect(due).toBeDefined();
    await expect(decryptQueueRecord(due!)).resolves.toEqual(draft);
    const second = await syncQueuedReports();

    expect(submitReport).toHaveBeenCalledTimes(2);
    expect(second).toMatchObject({ synced: 1, failed: 0, needsAction: 0 });
    expect(await fieldDb.queue.get(draft.client_report_id)).toBeUndefined();
    expect(await fieldDb.receipts.get(receipt.id)).toEqual(receipt);
    expect(vi.mocked(submitReport).mock.calls[0]?.[0].client_report_id).toBe(
      draft.client_report_id
    );
    expect(vi.mocked(submitReport).mock.calls[1]?.[0].client_report_id).toBe(
      draft.client_report_id
    );
  });

  it("replays an imprecise offline fix unchanged for authoritative human review", async () => {
    const reviewDraft: OfflineReportDraft = {
      ...draft,
      client_report_id: "sync-report-location-review-0002",
      location: { ...draft.location, accuracy_m: 850 }
    };
    const reviewReceipt: ReportReceipt = {
      ...receipt,
      id: "report-authoritative-review-0002",
      clientReportId: reviewDraft.client_report_id,
      reference: "report-authoritative-review-0002",
      status: "UNDER_REVIEW",
      message: "Location accuracy exceeds 100 m; retained for human review."
    };
    await enqueueReport(reviewDraft);
    vi.mocked(submitReport).mockResolvedValue(reviewReceipt);

    await expect(syncQueuedReports()).resolves.toMatchObject({
      synced: 1,
      failed: 0,
      needsAction: 0
    });

    expect(submitReport).toHaveBeenCalledWith(
      expect.objectContaining({
        client_report_id: reviewDraft.client_report_id,
        location: expect.objectContaining({ accuracy_m: 850 })
      })
    );
    expect(await fieldDb.queue.get(reviewDraft.client_report_id)).toBeUndefined();
    expect(await fieldDb.receipts.get(reviewReceipt.id)).toEqual(reviewReceipt);
  });
});
