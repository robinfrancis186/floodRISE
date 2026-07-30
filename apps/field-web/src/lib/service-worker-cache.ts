export const LEGACY_FIELD_API_CACHE = "field-api-last-known";
export const LEGACY_FIELD_ALERT_CACHE = "field-public-alerts-v2";
export const LEGACY_FIELD_API_CACHES = [
  LEGACY_FIELD_API_CACHE,
  LEGACY_FIELD_ALERT_CACHE,
] as const;

/**
 * Remove every historical API cache once the updated application loads.
 *
 * Earlier service workers cached broad API responses and later the alert feed.
 * Both can carry authenticated data, so the current worker keeps all `/api/**`
 * traffic network-only and removes both known caches from existing installs.
 */
export async function deleteLegacyFieldApiCache(
  storage: Pick<CacheStorage, "delete"> | undefined = globalThis.caches,
) {
  if (!storage) return false;
  const deleted = await Promise.all(
    LEGACY_FIELD_API_CACHES.map((cacheName) => storage.delete(cacheName)),
  );
  return deleted.some(Boolean);
}
