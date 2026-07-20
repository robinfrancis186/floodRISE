import { afterEach, describe, expect, it, vi } from "vitest";
import {
  operationsEventCursorKey,
  subscribeToOperationsEvents,
  type OperationsInvalidation,
  type OperationsStreamStatus,
} from "./operations-events";

const INCIDENT_ID = "inc-demo-michaung-2023";

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
    resource_id: "signal-velachery",
    version: 5,
    occurred_at: "2023-12-04T14:10:02Z",
    ...overrides,
  };
  return `id: ${sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

describe("operations SSE subscription", () => {
  it("resumes with Last-Event-ID, accepts typed events, and persists the next cursor", async () => {
    window.localStorage.setItem(operationsEventCursorKey(INCIDENT_ID), "41");
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
      onEvent: (event) => received.push(event),
      onStatus: (status) => statuses.push(status),
      retryBaseMs: 10,
    });

    await vi.waitFor(() => expect(statuses.at(-1)).toBe("live"));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("Last-Event-ID")).toBe("41");

    streamController?.enqueue(new TextEncoder().encode(eventFrame(42)));
    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0]).toMatchObject({
      type: "signal.updated",
      incident_id: INCIDENT_ID,
      resource_id: "signal-velachery",
      version: 5,
    });
    expect(window.localStorage.getItem(operationsEventCursorKey(INCIDENT_ID))).toBe("42");

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
      onEvent: (event) => received.push(event),
      onStatus: () => undefined,
      retryBaseMs: 10_000,
    });

    await vi.waitFor(() => {
      expect(window.localStorage.getItem(operationsEventCursorKey(INCIDENT_ID))).toBe("8");
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
      onEvent: () => undefined,
      onStatus: (status) => statuses.push(status),
      retryBaseMs: 10_000,
    });

    await vi.waitFor(() => expect(statuses.at(-1)).toBe("reconnecting"));
    expect(statuses).toEqual(["connecting", "reconnecting"]);
    unsubscribe();
  });
});
