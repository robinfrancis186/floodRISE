import { describe, expect, it, vi } from "vitest";
import {
  deleteLegacyFieldApiCache,
  LEGACY_FIELD_ALERT_CACHE,
  LEGACY_FIELD_API_CACHE,
} from "./service-worker-cache";

describe("field service-worker cache migration", () => {
  it("deletes every historical API response cache", async () => {
    const deleteCache = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    await expect(deleteLegacyFieldApiCache({ delete: deleteCache })).resolves.toBe(true);

    expect(deleteCache).toHaveBeenCalledTimes(2);
    expect(deleteCache).toHaveBeenNthCalledWith(1, LEGACY_FIELD_API_CACHE);
    expect(deleteCache).toHaveBeenNthCalledWith(2, LEGACY_FIELD_ALERT_CACHE);
  });

  it("returns false once neither historical API cache exists", async () => {
    const deleteCache = vi.fn().mockResolvedValue(false);

    await expect(deleteLegacyFieldApiCache({ delete: deleteCache })).resolves.toBe(false);
  });

  it("is a no-op where Cache Storage is unavailable", async () => {
    await expect(deleteLegacyFieldApiCache(undefined)).resolves.toBe(false);
  });
});
