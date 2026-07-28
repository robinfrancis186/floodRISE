import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const serviceWorkerPath = fileURLToPath(new URL("../dist/sw.js", import.meta.url));
const serviceWorker = await readFile(serviceWorkerPath, "utf8");

assert.match(
  serviceWorker,
  /field-public-alerts-v2/,
  "compiled service worker must use the public-alert-only cache",
);
assert.match(
  serviceWorker,
  /\/api\/v1\/alerts/,
  "compiled service worker must contain the exact public alert endpoint",
);
assert.match(
  serviceWorker,
  /sameOrigin/,
  "compiled service worker must enforce same-origin requests",
);
assert.match(
  serviceWorker,
  /GET/,
  "compiled service worker must enforce the GET method",
);
assert.doesNotMatch(
  serviceWorker,
  /field-api-last-known/,
  "compiled service worker must not reopen the legacy broad API cache",
);

for (const protectedPath of [
  "/api/v1/media",
  "/api/v1/reports",
  "/api/v1/routes",
  "/api/v1/health",
  "/api/v1/events",
  "/api/v1/approvals",
]) {
  assert.doesNotMatch(
    serviceWorker,
    new RegExp(protectedPath.replaceAll("/", "\\/")),
    `compiled service worker must not cache ${protectedPath}`,
  );
}

console.log("Service worker policy verified: same-origin GET /api/v1/alerts only.");
