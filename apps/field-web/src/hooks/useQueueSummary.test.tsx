import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { getQueueSummaryMock, stateDispatchSpy } = vi.hoisted(() => ({
  getQueueSummaryMock: vi.fn(),
  stateDispatchSpy: vi.fn()
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useState: <State,>(initialState: State | (() => State)) => {
      const [state, dispatch] = actual.useState(initialState);
      const observedDispatch: typeof dispatch = (action) => {
        stateDispatchSpy(action);
        dispatch(action);
      };
      return [state, observedDispatch] as const;
    }
  };
});

vi.mock("../lib/db", () => ({
  getQueueSummary: getQueueSummaryMock,
  QUEUE_CHANGED_EVENT: "floodrise:queue-changed"
}));

import { useQueueSummary } from "./useQueueSummary";

type QueueSummary = {
  count: number;
  bytes: number;
  oldestCreatedAt: number | null;
};

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  getQueueSummaryMock.mockReset();
  stateDispatchSpy.mockReset();
});

describe("useQueueSummary", () => {
  it("keeps the newest refresh when an older request finishes last", async () => {
    const older = deferred<QueueSummary>();
    const newer = deferred<QueueSummary>();
    getQueueSummaryMock
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);

    const { result } = renderHook(() => useQueueSummary());
    expect(getQueueSummaryMock).toHaveBeenCalledTimes(1);

    act(() => {
      window.dispatchEvent(new CustomEvent("floodrise:queue-changed"));
    });
    expect(getQueueSummaryMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      newer.resolve({ count: 2, bytes: 512, oldestCreatedAt: 200 });
      await newer.promise;
    });
    expect(result.current).toMatchObject({
      count: 2,
      bytes: 512,
      oldestCreatedAt: 200
    });

    await act(async () => {
      older.resolve({ count: 1, bytes: 128, oldestCreatedAt: 100 });
      await older.promise;
    });
    expect(result.current).toMatchObject({
      count: 2,
      bytes: 512,
      oldestCreatedAt: 200
    });
  });

  it("does not dispatch state or leak a rejection after unmount", async () => {
    const pending = deferred<QueueSummary>();
    const unhandledRejection = vi.fn();
    getQueueSummaryMock.mockReturnValueOnce(pending.promise);
    window.addEventListener("unhandledrejection", unhandledRejection);

    const { unmount } = renderHook(() => useQueueSummary());
    expect(getQueueSummaryMock).toHaveBeenCalledTimes(1);

    unmount();
    stateDispatchSpy.mockClear();

    await act(async () => {
      pending.reject(new Error("IndexedDB closed during teardown"));
      await pending.promise.catch(() => undefined);
      await Promise.resolve();
    });

    expect(stateDispatchSpy).not.toHaveBeenCalled();
    expect(unhandledRejection).not.toHaveBeenCalled();
    window.removeEventListener("unhandledrejection", unhandledRejection);
  });
});
