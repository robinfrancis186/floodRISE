import type { StaffApiIdentity } from "./models";
import {
  CloudCredentialUnavailableError,
  cloudFetch,
} from "./cloud-security";

export type OperationsInvalidation = {
  id: string;
  type: string;
  incident_id: string | null;
  resource_id: string;
  version: number;
  occurred_at: string;
};

export type OperationsStreamStatus =
  | "connecting"
  | "live"
  | "reconnecting"
  | "unavailable";

type SubscribeOptions = {
  apiRoot: string;
  incidentId: string;
  identity: StaffApiIdentity;
  onEvent: (event: OperationsInvalidation) => void;
  onStatus: (status: OperationsStreamStatus) => void;
  retryBaseMs?: number;
};

const CURSOR_PREFIX = "floodrise.ops.events.cursor";
const MAX_RETRY_MS = 15_000;

function cursorKey(incidentId: string, subject: string) {
  return `${CURSOR_PREFIX}.${encodeURIComponent(incidentId)}.${encodeURIComponent(subject)}`;
}

function readCursor(incidentId: string, subject: string): string | null {
  try {
    return window.localStorage.getItem(cursorKey(incidentId, subject));
  } catch {
    return null;
  }
}

function writeCursor(incidentId: string, subject: string, cursor: string) {
  try {
    window.localStorage.setItem(cursorKey(incidentId, subject), cursor);
  } catch {
    // A blocked storage API only removes cross-reload resume. The live stream
    // remains ordered and reconnects with its in-memory cursor.
  }
}

function parseInvalidation(data: string): OperationsInvalidation | null {
  try {
    const value = JSON.parse(data) as Record<string, unknown>;
    if (
      typeof value.id !== "string"
      || typeof value.type !== "string"
      || !(typeof value.incident_id === "string" || value.incident_id === null)
      || typeof value.resource_id !== "string"
      || typeof value.version !== "number"
      || !Number.isFinite(value.version)
      || typeof value.occurred_at !== "string"
    ) {
      return null;
    }
    return value as OperationsInvalidation;
  } catch {
    return null;
  }
}

async function consumeEventStream(
  response: Response,
  incidentId: string,
  onEvent: (event: OperationsInvalidation) => void,
  updateCursor: (cursor: string) => void,
) {
  if (!response.body) throw new Error("The SSE response has no readable body.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  let eventId = "";
  let dataLines: string[] = [];

  const dispatch = () => {
    if (!dataLines.length) {
      eventId = "";
      return;
    }
    const event = parseInvalidation(dataLines.join("\n"));
    if (eventId) updateCursor(eventId);
    if (event && (event.incident_id === null || event.incident_id === incidentId)) {
      onEvent(event);
    }
    eventId = "";
    dataLines = [];
  };

  while (true) {
    const { done, value } = await reader.read();
    buffered += decoder.decode(value, { stream: !done });
    const lines = buffered.split("\n");
    buffered = done ? "" : (lines.pop() ?? "");

    for (const rawLine of lines) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line === "") {
        dispatch();
        continue;
      }
      if (line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator === -1 ? line : line.slice(0, separator);
      let fieldValue = separator === -1 ? "" : line.slice(separator + 1);
      if (fieldValue.startsWith(" ")) fieldValue = fieldValue.slice(1);
      if (field === "id" && !fieldValue.includes("\0")) eventId = fieldValue;
      if (field === "data") dataLines.push(fieldValue);
    }

    if (done) {
      if (buffered) {
        const line = buffered.endsWith("\r") ? buffered.slice(0, -1) : buffered;
        if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
        else if (line.startsWith("id:")) eventId = line.slice(3).replace(/^ /, "");
      }
      dispatch();
      return;
    }
  }
}

/**
 * Subscribe to the persisted outbox over SSE.
 *
 * A fetch stream is used instead of EventSource because browsers do not let an
 * application set Last-Event-ID when restoring a subscription after reload.
 * The server still emits standard text/event-stream frames, while this client
 * resumes explicitly and uses the same in-memory bearer/App Check bootstrap as
 * ordinary API requests. Demo identity headers remain only in demo mode.
 */
export function subscribeToOperationsEvents({
  apiRoot,
  incidentId,
  identity,
  onEvent,
  onStatus,
  retryBaseMs = 1_000,
}: SubscribeOptions): () => void {
  let stopped = false;
  let activeController: AbortController | null = null;
  let retryTimer: number | null = null;
  let retryCount = 0;
  let cursor = readCursor(incidentId, identity.userId);

  if (typeof window.fetch !== "function" || typeof window.ReadableStream === "undefined") {
    onStatus("unavailable");
    return () => undefined;
  }

  const connect = async () => {
    if (stopped) return;
    onStatus(retryCount === 0 ? "connecting" : "reconnecting");
    activeController = new AbortController();
    const headers = new Headers({ Accept: "text/event-stream" });
    headers.set("X-Demo-Role", identity.role);
    headers.set("X-Demo-User", identity.userId);
    if (cursor) headers.set("Last-Event-ID", cursor);

    try {
      const response = await cloudFetch(
        `${apiRoot.replace(/\/$/, "")}/events?incident_id=${encodeURIComponent(incidentId)}`,
        {
          method: "GET",
          credentials: "include",
          cache: "no-store",
          headers,
          signal: activeController.signal,
        },
      );
      if (response.status === 401 || response.status === 403) {
        onStatus("unavailable");
        return;
      }
      if (!response.ok) throw new Error(`SSE request failed with status ${response.status}.`);
      if (!response.headers.get("Content-Type")?.toLowerCase().includes("text/event-stream")) {
        throw new Error("The events endpoint did not return an SSE stream.");
      }

      retryCount = 0;
      onStatus("live");
      await consumeEventStream(response, incidentId, onEvent, (nextCursor) => {
        cursor = nextCursor;
        writeCursor(incidentId, identity.userId, nextCursor);
      });
      if (!stopped) throw new Error("The events stream ended.");
    } catch (error) {
      if (stopped || (error instanceof DOMException && error.name === "AbortError")) return;
      if (error instanceof CloudCredentialUnavailableError) {
        onStatus("unavailable");
        return;
      }
      retryCount += 1;
      onStatus("reconnecting");
      const delay = Math.min(MAX_RETRY_MS, retryBaseMs * 2 ** Math.min(retryCount - 1, 4));
      retryTimer = window.setTimeout(() => void connect(), delay);
    }
  };

  void connect();

  return () => {
    stopped = true;
    if (retryTimer !== null) window.clearTimeout(retryTimer);
    activeController?.abort();
  };
}

export function operationsEventCursorKey(incidentId: string, subject: string) {
  return cursorKey(incidentId, subject);
}
