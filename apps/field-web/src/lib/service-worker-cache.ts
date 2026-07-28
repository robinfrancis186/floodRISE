export const LEGACY_FIELD_API_CACHE = "field-api-last-known";

/**
 * Remove the pre-hardening API cache once the updated application loads.
 *
 * The previous service worker cached broad authenticated API responses. The
 * replacement worker only caches the public alert feed, but deleting the
 * legacy cache is still required so a shared device cannot expose an older
 * reporter-scoped response while offline.
 */
export async function deleteLegacyFieldApiCache(
  storage: Pick<CacheStorage, "delete"> | undefined = globalThis.caches,
) {
  if (!storage) return false;
  return storage.delete(LEGACY_FIELD_API_CACHE);
}
