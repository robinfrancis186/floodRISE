const HISTORICAL_FIELD_API_CACHES = Object.freeze([
  "field-api-last-known",
  "field-public-alerts-v2",
]);

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all(
      HISTORICAL_FIELD_API_CACHES.map((cacheName) => self.caches.delete(cacheName)),
    ),
  );
});
