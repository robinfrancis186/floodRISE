import { Alert, AlertDescription, AlertTitle, Badge, Button } from "@floodrise/ui";
import { CheckCircle2, CloudOff, CloudUpload, LockKeyhole, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNetworkStatus } from "../hooks/useNetworkStatus";
import { useQueueSummary } from "../hooks/useQueueSummary";
import {
  deleteQueuedReport,
  listQueuedReports,
  QUEUE_CHANGED_EVENT,
  QUEUE_LIMIT_BYTES,
  QUEUE_LIMIT_ITEMS,
  type QueuedReportListItem
} from "../lib/db";
import { formatBytes, formatDateTime, formatRelativeTime } from "../lib/format";
import { syncQueuedReports } from "../lib/sync";

export function OfflineQueuePage() {
  const { isOnline } = useNetworkStatus();
  const summary = useQueueSummary();
  const [items, setItems] = useState<QueuedReportListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [queueError, setQueueError] = useState(false);

  const refresh = useCallback(() => {
    setLoading(true);
    setQueueError(false);
    void listQueuedReports()
      .then(setItems)
      .catch(() => {
        setItems([]);
        setQueueError(true);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener(QUEUE_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(QUEUE_CHANGED_EVENT, refresh);
  }, [refresh]);

  async function sync() {
    setSyncing(true);
    setNotice(null);
    try {
      const result = await syncQueuedReports();
      if (result.synced) setNotice(`${result.synced} ${result.synced === 1 ? "report" : "reports"} submitted.`);
      else if (result.needsAction) setNotice("Some reports need action before they can be submitted. Remove the affected draft and submit it again with supported evidence.");
      else if (result.failed) setNotice("Reports remain encrypted on this device and will retry later.");
    } catch {
      setNotice("The encrypted queue could not be submitted. No draft was removed; close and reopen the app before trying again.");
    } finally {
      setSyncing(false);
      refresh();
    }
  }

  async function remove(id: string) {
    if (!window.confirm("Remove this unsent report and its evidence from this device?")) return;
    try {
      await deleteQueuedReport(id);
      setNotice("Unsent report removed from this device.");
    } catch {
      setNotice("The report could not be removed. Close and reopen the app before trying again.");
    } finally {
      refresh();
    }
  }

  return (
    <div className="page page-content standard-page queue-page">
      <div className="page-title-row">
        <div>
          <h1>Offline queue</h1>
          <p>Encrypted reports wait on this device and submit automatically after reconnecting.</p>
        </div>
        {isOnline ? <CloudUpload aria-hidden className="page-title-icon" /> : <CloudOff aria-hidden className="page-title-icon" />}
      </div>

      <div className="queue-summary" aria-label="Offline storage summary">
        <div><strong>{summary.count}</strong><span>waiting</span></div>
        <div><strong>{formatBytes(summary.bytes)}</strong><span>of 100 MB</span></div>
        <div><strong>{QUEUE_LIMIT_ITEMS - summary.count}</strong><span>slots left</span></div>
      </div>

      <Alert variant="info" className="queue-privacy-notice">
        <LockKeyhole aria-hidden className="alert-leading-icon" />
        <div>
          <AlertTitle>Encrypted on this device</AlertTitle>
          <AlertDescription>
            Unsent evidence expires after 24 hours. The queue is limited to {QUEUE_LIMIT_ITEMS} items / {formatBytes(QUEUE_LIMIT_BYTES)}.
          </AlertDescription>
        </div>
      </Alert>

      {notice ? <Alert variant="info"><AlertDescription>{notice}</AlertDescription></Alert> : null}

      <Button type="button" size="lg" className="queue-sync-button" onClick={() => void sync()} disabled={!isOnline || !summary.count || syncing}>
        <RefreshCw aria-hidden className={syncing ? "spin" : undefined} />
        {syncing ? "Submitting queued reports…" : isOnline ? "Sync now" : "Reconnect to sync"}
      </Button>

      <section aria-labelledby="waiting-heading">
        <div className="section-heading-row">
          <h2 id="waiting-heading">Waiting to submit</h2>
          <span>{summary.oldestCreatedAt ? `Oldest ${formatRelativeTime(summary.oldestCreatedAt)}` : "Queue ready"}</span>
        </div>

        {loading ? <p className="loading-row" role="status">Opening encrypted queue…</p> : null}
        {!loading && queueError ? (
          <Alert variant="warning" role="alert">
            <AlertTitle>Encrypted queue could not be opened</AlertTitle>
            <AlertDescription>
              No draft was removed. Close and reopen the app, then contact the incident desk if this continues.
            </AlertDescription>
          </Alert>
        ) : null}
        {!loading && !queueError && !items.length ? (
          <div className="queue-empty-state">
            <CheckCircle2 aria-hidden />
            <h3>No reports waiting</h3>
            <p>New offline reports will appear here until they are submitted or expire.</p>
          </div>
        ) : null}

        <ul className="queue-list">
          {items.map(({ record, draft }) => (
            <li key={record.id}>
              <div className="queue-item-head">
                <div>
                  <strong>{draft?.place_label ?? "Encrypted draft unavailable"}</strong>
                  <span>
                    {draft
                      ? `Observed ${formatDateTime(draft.observed_at)}`
                      : "Report details could not be decrypted on this device"}
                  </span>
                </div>
                <Badge variant={!draft || record.state === "RETRY" || record.state === "NEEDS_ACTION" ? "warning" : "secondary"}>
                  {!draft
                    ? "Needs removal"
                    : record.state === "SYNCING"
                    ? "Submitting"
                    : record.state === "RETRY"
                      ? "Will retry"
                      : record.state === "NEEDS_ACTION"
                        ? "Needs action"
                        : "Queued"}
                </Badge>
              </div>
              {draft ? (
                <div className="queue-item-tags">
                  <span>{draft.water_depth.replace("_", " ").toLowerCase()} depth</span>
                  <span>{draft.road_status.toLowerCase()} road</span>
                  {draft.photo ? <span>photo attached</span> : null}
                </div>
              ) : (
                <p className="queue-error">
                  Remove this unreadable draft and create a new report. No encrypted evidence is displayed.
                </p>
              )}
              {draft && record.lastError ? <p className="queue-error">{record.lastError}</p> : null}
              <footer>
                <span>{formatBytes(record.sizeBytes)} · {formatRelativeTime(record.expiresAt)}</span>
                <Button type="button" variant="ghost" size="sm" onClick={() => void remove(record.id)}>
                  <Trash2 aria-hidden />Remove
                </Button>
              </footer>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
