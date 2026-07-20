# Kerala OpenStreetMap release verification — 2026-07-21

This record captures the clean local release gate for the Kerala map migration.
It is development evidence from macOS, not evidence of an AWS deployment or an
authority-approved production flood system.

## Delivered map baseline

- The judging incident now covers Aluva, Eloor, Kalamassery, Kadungalloor, and
  the Periyar floodplain in Kerala under `demo-kerala-flood-v1`.
- Normal connected viewing uses the standard interactive OpenStreetMap raster
  tiles with visible contributor and ODbL attribution.
- The bounded importer captured 3,967 major-road segments from the reviewed
  Kerala AOI at `2026-07-20T18:40:36Z`. The full snapshot SHA-256 is
  `a6f0271c54f8b842f607c0ecbeddb4c0f5e3263c22ba3597fc9e1851c13331d0`.
- An 800-segment, 512 KiB deterministic road fallback is bundled with the map.
  Its SHA-256 is
  `bd3302d7e94121786ad4fc66fdb21f122dedb23f7c6c839c9ee0db4b9c809f90`.
- Workbox does not precache or runtime-cache cross-origin OpenStreetMap tiles.
  Offline use retains the packaged road fallback, flood estimates, signals,
  shelters, routes, and accessible synchronized lists.

## Automated results

| Gate | Result |
| --- | --- |
| Lint, format, and types | Passed for every TypeScript workspace and both Python services. |
| Unit and service tests | 132 passed: field web 23, operations web 21, backend 75, restricted tile API 7, and bounded OpenStreetMap importer 6. |
| Contracts and fixtures | Seven fixture files, two raster artifacts, 3,967 full OpenStreetMap road segments, and 800 bundled fallback segments validated. The 33-path OpenAPI snapshot and generated TypeScript client matched FastAPI. |
| Production builds | Both Vite applications built. The field PWA generated a 23-entry, 2,185.09 KiB precache containing its route and packaged fallback chunks. |
| Browser journeys | 10 Playwright tests passed in 37.7 seconds, including WCAG AA axe smoke checks, all eight Operations routes, all six static field routes at 360x800, offline queue restrictions, private photo sanitization, four-report corroboration, FloodSignal review, and two-person approval. |
| Repeatability | Three consecutive clean reset/corroboration runs passed in 248 ms, 189 ms, and 222 ms; every fourth report produced the explicitly unofficial corroboration, requested recalculation, and retained a valid audit chain. |
| Dependency audit | `pnpm audit --prod` reported no known vulnerabilities. |

## Rendered-product review

The Operations console was inspected at 1570x1000 and the field PWA at 360x800
in real Chromium sessions. The detailed Kerala basemap, flood overlays, road
status, lower-risk route, FloodSignal marker, shelters, labels, attribution,
responsive controls, and non-map alternatives rendered without page or console
errors. The browser review also verified that provider tile activity does not
block route readiness or the test lifecycle.

Startup migration tests also verify that the exact legacy Chennai deterministic
seed is replaced automatically on upgrade while unrelated, non-demo records are
left untouched.

Current reference captures:

- `artifacts/screenshots/ops-live.png`
- `artifacts/screenshots/ops-floodsignal.png`
- `artifacts/screenshots/ops-resilience.png`
- `artifacts/screenshots/field-conditions.png`
- `artifacts/screenshots/field-report.png`
- `artifacts/screenshots/field-offline-route.png`

## Limits retained deliberately

- Public OpenStreetMap tiles are a best-effort enhancement for ordinary
  interactive demo viewing. They are not prefetched, bulk-downloaded, or treated
  as an emergency-runtime dependency. Production requires an approved,
  self-hosted or contract-backed OSM-derived tile service that follows the
  [OpenStreetMap tile usage policy](https://operations.osmfoundation.org/policies/tiles/).
- Trivy was unavailable on this workstation. The repository's hosted security
  workflow remains the independent Trivy, CodeQL, dependency, and secret gate.
- Live-provider activation, AWS apply, VoiceOver device review, ZAP/k6 runs,
  backup restoration, RPO/RTO drills, and hydraulic certification remain outside
  this local evidence record.
