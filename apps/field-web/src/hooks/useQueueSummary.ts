import { useCallback, useEffect, useRef, useState } from "react";
import { getQueueSummary, QUEUE_CHANGED_EVENT } from "../lib/db";

const emptySummary = { count: 0, bytes: 0, oldestCreatedAt: null as number | null };

export function useQueueSummary() {
  const [summary, setSummary] = useState(emptySummary);
  const mountedRef = useRef(false);
  const generationRef = useRef(0);

  const refresh = useCallback(() => {
    const generation = ++generationRef.current;
    void getQueueSummary().then(
      (nextSummary) => {
        if (mountedRef.current && generation === generationRef.current) {
          setSummary(nextSummary);
        }
      },
      () => {
        if (mountedRef.current && generation === generationRef.current) {
          setSummary(emptySummary);
        }
      }
    );
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    window.addEventListener(QUEUE_CHANGED_EVENT, refresh);
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      window.removeEventListener(QUEUE_CHANGED_EVENT, refresh);
    };
  }, [refresh]);

  return { ...summary, refresh };
}
