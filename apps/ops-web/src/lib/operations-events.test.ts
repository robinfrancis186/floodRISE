import { afterEach, describe, expect, it, vi } from "vitest";
import {
  operationsEventCursorKey,
  subscribeToOperationsEvents,
  type OperationsInvalidation,
  type OperationsStreamStatus,
} from "./operations-events";

const INCIDENT_ID = "inc-demo-kerala-flood-2023";
const IDENTITY = {
  role: "incident_commander",
  userId: "ops-incident-commander",
} as const;

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function eventFrame(sequence: number, overrides: Partial<OperationsInvalidation> = {}) {
  const event: OperationsInvalidation = {
    id: `evt-${sequence}`,
    type: "signal.updated",
    incident_id: INCIDENT_ID,
    resource_id: "signal-aluva",
    version: 5,
    occurred_at: "2023-12-04T14:10:02Z",
    ...overrides,
  };
  return `id: ${sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

describe("operations SSE subscription", () => {
  it("resumes with Last-Event-ID, accepts typed events, and persists the next cursor", async () => {
    window.localStorage.setItem(operationsEventCursorKey(INCIDENT_ID, IDENTITY.userId), "41");
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        streamController = controller;
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream; charset=utf-8" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const statuses: OperationsStreamStatus[] = [];
    const received: OperationsInvalidation[] = [];

    const unsubscribe = subscribeToOperationsEvents({
      apiRoot: "/api/v1",
      incidentId: INCIDENT_ID,
      identity: IDENTITY,
      onEvent: (event) => received.push(event),
      onStatus: (status) => statuses.push(status),
      retryBaseMs: 10,
    });

    await vi.waitFor(() => expect(statuses.at(-1)).toBe("live"));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(url).toBe(`/api/v1/events?incident_id=${encodeURIComponent(INCIDENT_ID)}`);
    expect(headers.get("Last-Event-ID")).toBe("41");
    expect(headers.get("X-Demo-Role")).toBe(IDENTITY.role);
    expect(headers.get("X-Demo-User")).toBe(IDENTITY.userId);

    streamController?.enqueue(new TextEncoder().encode(eventFrame(42)));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({
      type: "signal.updated",
      incident_id: INCIDENT_ID,
      resource_id: "signal-aluva",
      version: 5,
    });
    expect(window.localStorage.getItem(operationsEventCursorKey(INCIDENT_ID, IDENTITY.userId))).toBe("42");

    unsubscribe();
    streamController?.close();
  });

  it("advances the global cursor but ignores invalidations for another incident", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(eventFrame(8, { incident_id: "inc-other" })));
      },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    })));
    const received: OperationsInvalidation[] = [];

    const unsubscribe = subscribeToOperationsEvents({
      apiRoot: "/api/v1",
      incidentId: INCIDENT_ID,
      identity: IDENTITY,
      onEvent: (event) => received.push(event),
      onStatus: () => undefined,
      retryBaseMs: 10_000,
    });

    await vi.waitFor(() => {
      expect(window.localStorage.getItem(operationsEventCursorKey(INCIDENT_ID, IDENTITY.userId))).toBe("8");
    });
    expect(received).toHaveLength(0);
    unsubscribe();
  });

  it("reports reconnecting when the persisted stream fails", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("network offline"));
    vi.stubGlobal("fetch", fetchMock);
    const statuses: OperationsStreamStatus[] = [];

    const unsubscribe = subscribeToOperationsEvents({
      apiRoot: "/api/v1",
      incidentId: INCIDENT_ID,
      identity: IDENTITY,
      onEvent: () => undefined,
      onStatus: (status) => statuses.push(status),
      retryBaseMs: 10_000,
    });

    await vi.waitFor(() => expect(statuses.at(-1)).toBe("reconnecting"));
    expect(statuses).toEqual(["connecting", "reconnecting"]);
    unsubscribe();
  });

  it.each([401, 403])("stops reconnecting after an authorization failure (%s)", async (status) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status }));
    vi.stubGlobal("fetch", fetchMock);
    const statuses: OperationsStreamStatus[] = [];

    const unsubscribe = subscribeToOperationsEvents({
      apiRoot: "/api/v1",
      incidentId: INCIDENT_ID,
      identity: IDENTITY,
      onEvent: () => undefined,
      onStatus: (nextStatus) => statuses.push(nextStatus),
      retryBaseMs: 10,
    });

    await vi.waitFor(() => expect(statuses.at(-1)).toBe("unavailable"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(["connecting", "unavailable"]);
    unsubscribe();
    vi.useRealTimers();
  });

  it("partitions persisted cursors by incident and authenticated subject", () => {
    expect(operationsEventCursorKey(INCIDENT_ID, "ops-verifier")).not.toBe(
      operationsEventCursorKey(INCIDENT_ID, IDENTITY.userId),
    );
    expect(operationsEventCursorKey("inc-other", IDENTITY.userId)).not.toBe(
      operationsEventCursorKey(INCIDENT_ID, IDENTITY.userId),
    );
  });
});
