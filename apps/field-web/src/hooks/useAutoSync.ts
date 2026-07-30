import { useEffect, useState } from "react";
import { QUEUE_ENQUEUED_EVENT } from "../lib/db";
import { syncQueuedReports } from "../lib/sync";
import { useNetworkStatus } from "./useNetworkStatus";

export function useAutoSync() {
  const network = useNetworkStatus();
  const [isSyncing, setIsSyncing] = useState(false);
  const [lastResult, setLastResult] = useState<{
    synced: number;
    failed: number;
    needsAction: number;
    nextRetryAt: number | null;
  } | null>(null);

  useEffect(() => {
    if (!network.isOnline) return;
    let cancelled = false;
    let retryTimer: number | undefined;
    const schedule = (delayMs: number) => {
      if (retryTimer) window.clearTimeout(retryTimer);
      retryTimer = window.setTimeout(() => void run(), Math.max(0, delayMs));
    };
    const run = async () => {
      setIsSyncing(true);
      try {
        const result = await syncQueuedReports();
        if (cancelled) return;
        setLastResult(result);
        if (result.nextRetryAt) {
          schedule(Math.max(1_000, result.nextRetryAt - Date.now()));
        }
      } catch {
        if (cancelled) return;
        setLastResult({
          synced: 0,
          failed: 1,
          needsAction: 0,
          nextRetryAt: null
        });
      } finally {
        if (!cancelled) setIsSyncing(false);
      }
    };
    const onEnqueued = () => schedule(0);
    window.addEventListener(QUEUE_ENQUEUED_EVENT, onEnqueued);
    void run();
    return () => {
      cancelled = true;
      window.removeEventListener(QUEUE_ENQUEUED_EVENT, onEnqueued);
      if (retryTimer) window.clearTimeout(retryTimer);
    };
  }, [network.isOnline]);

  return { ...network, isSyncing, lastResult };
}
