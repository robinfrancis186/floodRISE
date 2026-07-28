import { describe, expect, it, vi } from "vitest";
import {
  deleteLegacyFieldApiCache,
  LEGACY_FIELD_API_CACHE,
} from "./service-worker-cache";

describe("field service-worker cache migration", () => {
  it("deletes only the legacy broad API cache", async () => {
    const deleteCache = vi.fn().mockResolvedValue(true);

    await expect(deleteLegacyFieldApiCache({ delete: deleteCache })).resolves.toBe(true);

    expect(deleteCache).toHaveBeenCalledOnce();
    expect(deleteCache).toHaveBeenCalledWith(LEGACY_FIELD_API_CACHE);
  });

  it("is a no-op where Cache Storage is unavailable", async () => {
    await expect(deleteLegacyFieldApiCache(undefined)).resolves.toBe(false);
  });
});
