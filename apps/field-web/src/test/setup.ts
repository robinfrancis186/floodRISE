import "@testing-library/jest-dom/vitest";
import "fake-indexeddb/auto";
import { webcrypto } from "node:crypto";

Object.defineProperty(globalThis, "crypto", {
  configurable: true,
  value: webcrypto
});

if (!globalThis.CustomEvent) {
  class CustomEventPolyfill<T> extends Event {
    detail: T;
    constructor(type: string, init?: CustomEventInit<T>) {
      super(type, init);
      this.detail = init?.detail as T;
    }
  }
  Object.defineProperty(globalThis, "CustomEvent", { value: CustomEventPolyfill });
}
