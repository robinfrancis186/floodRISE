import { deleteQueuedReport, decryptQueueRecord, fieldDb, purgeExpiredReports, saveReceipt, updateQueueState } from "./db";
import { ReportSubmissionError, shouldRetrySubmission, submitReport } from "./api";
import { isForcedOfflineMode } from "./network";

export type SyncResult = {
  synced: number;
  failed: number;
  needsAction: number;
  nextRetryAt: number | null;
};

let activeSync: Promise<SyncResult> | null = null;

export function syncQueuedReports() {
  if (activeSync) return activeSync;
  activeSync = runSync().finally(() => {
    activeSync = null;
  });
  return activeSync;
}

async function runSync() {
  if (!navigator.onLine || isForcedOfflineMode()) {
    return { synced: 0, failed: 0, needsAction: 0, nextRetryAt: null };
  }
  await purgeExpiredReports();
  const records = await fieldDb.queue.orderBy("createdAt").toArray();
  let synced = 0;
  let failed = 0;
  let needsAction = 0;
  let nextRetryAt: number | null = null;
  for (const record of records) {
    if (record.state === "NEEDS_ACTION") {
      needsAction += 1;
      continue;
    }
    if (record.nextAttemptAt && record.nextAttemptAt > Date.now()) {
      nextRetryAt = nextRetryAt === null
        ? record.nextAttemptAt
        : Math.min(nextRetryAt, record.nextAttemptAt);
      continue;
    }
    let draft: Awaited<ReturnType<typeof decryptQueueRecord>>;
    try {
      await updateQueueState(record.id, "SYNCING");
      draft = await decryptQueueRecord(record);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Encrypted draft could not be read";
      await updateQueueState(record.id, "NEEDS_ACTION", message);
      needsAction += 1;
      failed += 1;
      continue;
    }

    let receipt: Awaited<ReturnType<typeof submitReport>>;
    try {
      receipt = await submitReport(draft);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sync failed";
      if (error instanceof ReportSubmissionError && !error.retryable) {
        await updateQueueState(record.id, "NEEDS_ACTION", message);
        needsAction += 1;
      } else if (!shouldRetrySubmission(error)) {
        await updateQueueState(record.id, "NEEDS_ACTION", message);
        needsAction += 1;
      } else {
        const delay = error instanceof ReportSubmissionError
          ? Math.max(1_000, error.retryAfterMs)
          : 5_000;
        const retryAt = Date.now() + delay;
        await updateQueueState(record.id, "RETRY", message, retryAt);
        nextRetryAt = nextRetryAt === null ? retryAt : Math.min(nextRetryAt, retryAt);
      }
      failed += 1;
      continue;
    }

    try {
      await saveReceipt(receipt);
      await deleteQueuedReport(record.id);
      synced += 1;
    } catch (error) {
      // The authoritative API has already accepted this immutable client ID.
      // Keep the same queue record retryable so the next pass replays the same
      // idempotency key and repairs the local receipt without creating evidence.
      const detail = error instanceof Error ? ` ${error.message}` : "";
      const retryAt = Date.now() + 5_000;
      await updateQueueState(
        record.id,
        "RETRY",
        `Report accepted by the API; local receipt storage will retry.${detail}`,
        retryAt
      );
      nextRetryAt = nextRetryAt === null ? retryAt : Math.min(nextRetryAt, retryAt);
      failed += 1;
    }
  }
  if (synced) localStorage.setItem("floodrise.field.last-sync", new Date().toISOString());
  return { synced, failed, needsAction, nextRetryAt };
}
