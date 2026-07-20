import { useCallback, useEffect, useState } from "react";
import { getQueueSummary, QUEUE_CHANGED_EVENT } from "../lib/db";

const emptySummary = { count: 0, bytes: 0, oldestCreatedAt: null as number | null };

export function useQueueSummary() {
  const [summary, setSummary] = useState(emptySummary);
  const refresh = useCallback(() => {
    void getQueueSummary().then(setSummary).catch(() => setSummary(emptySummary));
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener(QUEUE_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(QUEUE_CHANGED_EVENT, refresh);
  }, [refresh]);

  return { ...summary, refresh };
}
