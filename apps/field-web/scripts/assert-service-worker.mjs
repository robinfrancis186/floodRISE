import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const serviceWorkerPath = fileURLToPath(new URL("../dist/sw.js", import.meta.url));
const purgeScriptPath = fileURLToPath(
  new URL("../dist/service-worker-purge.js", import.meta.url),
);
const serviceWorker = await readFile(serviceWorkerPath, "utf8");
const purgeScript = await readFile(purgeScriptPath, "utf8");
const readableServiceWorker = serviceWorker.replaceAll("\\/", "/");

assert.match(
  readableServiceWorker,
  /precacheAndRoute/,
  "compiled service worker must retain the static application precache",
);
assert.match(
  readableServiceWorker,
  /NavigationRoute/,
  "compiled service worker must retain the offline application-shell fallback",
);
assert.ok(
  readableServiceWorker.includes("denylist:[/^/api(?:/|$)/]"),
  "compiled navigation fallback must explicitly deny every /api path",
);
assert.match(
  readableServiceWorker,
  /\/field\/service-worker-purge\.js/,
  "compiled service worker must import the unconditional API-cache purge",
);
assert.doesNotMatch(
  readableServiceWorker,
  /field-(?:api-last-known|public-alerts-v2)/,
  "compiled service worker must not reference any historical API cache",
);
assert.doesNotMatch(
  readableServiceWorker,
  /NetworkFirst|CacheFirst|StaleWhileRevalidate/,
  "compiled service worker must not include a runtime caching strategy",
);
assert.doesNotMatch(
  readableServiceWorker,
  /\/api\/v1\//,
  "compiled service worker must not register a versioned API route",
);

assert.match(
  purgeScript,
  /addEventListener\("activate"/,
  "compiled purge must run during service-worker activation",
);
assert.match(
  purgeScript,
  /event\.waitUntil\(/,
  "compiled purge must extend activation until deletion completes",
);
assert.match(
  purgeScript,
  /self\.caches\.delete\(cacheName\)/,
  "compiled purge must delete each historical cache from CacheStorage",
);
for (const historicalCache of ["field-api-last-known", "field-public-alerts-v2"]) {
  assert.match(
    purgeScript,
    new RegExp(historicalCache),
    `compiled purge must delete ${historicalCache}`,
  );
}

console.log(
  "Service worker policy verified: static assets only; API is network-only and historical API caches purge on activation.",
);
