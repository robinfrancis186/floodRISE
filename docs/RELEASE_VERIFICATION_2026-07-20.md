# Release verification — 2026-07-20

This record captures the clean local competition-MVP gate completed on
2026-07-20. It is development evidence from an Apple silicon macOS 26.2
workstation using Node 24.2.0, pnpm 11.7.0, and uv 0.11.28. It is not evidence
of an AWS deployment or an authority-approved production flood system.

## Automated results

| Gate | Result |
| --- | --- |
| Lint and formatting | Passed for every TypeScript workspace and both Python services. |
| Type checking | Passed for the applications, generated API client, contracts, shared map, and shared UI. |
| Unit and service tests | 124 passed: field web 23, operations web 21, backend 73, and restricted tile API 7. |
| Contracts and fixtures | Six fixture files, two raster artifacts, and 291 packaged OpenStreetMap road segments validated; the 33-path OpenAPI snapshot and generated TypeScript client matched the FastAPI source. |
| Production builds | Both Vite applications built; the field PWA generated a 23-entry, 2,134.02 KiB precache. |
| Browser journeys | 10 Playwright tests passed, including WCAG 2.2 AA axe smoke checks, offline queue and route restrictions, private photo sanitization, FloodSignal review, two-person approval, and the direct-URL route sweep. |
| Named product surfaces | All eight operations routes and all six static field routes rendered at 1440x900 and 360x800 respectively; the dynamic receipt route was reached through photo submission. They retained the `DEMO DATA · NOT LIVE` boundary and emitted no page or console errors. |
| Deterministic replay | Three consecutive fourth-report corroboration runs passed in 247 ms, 185 ms, and 192 ms. Each result retained the explicitly unofficial message, requested route recalculation, and preserved a valid audit chain. |
| Static release files | GitHub workflow YAML, shell syntax, JSON dashboards, fixture hashes, and executable demo scripts passed available local checks. |
| JavaScript dependency audit | `pnpm audit --prod` reported no known vulnerabilities. |

The browser sweep found and closed one contract defect before release: the field
alerts view had treated authoritative snake_case alert records as the UI model.
The API adapter now validates and normalizes those records, and a regression
test covers the community-caution mapping.

## Observed warnings and environment limits

- Vite reports large uncompressed MapLibre/application chunks. Gzip sizes remain
  bounded, and the field route/map chunks stay precached for the required
  upstream-independent PWA behavior. This is an explicit offline-readiness
  trade-off rather than a failed build.
- FastAPI's test client emits the upstream Starlette `httpx` deprecation warning;
  no application test is skipped or failed.
- Docker, Terraform, Prometheus `promtool`, and ShellCheck were not installed on
  this workstation. The local Docker preflight therefore failed closed before
  starting infrastructure. GitHub CI is the independent environment for those
  portable infrastructure checks.
- VoiceOver, authenticated ZAP, k6 percentile tests, immutable container-image
  scans, AWS plan/apply, backup restore, and RPO/RTO drills require the target
  device or an authorized deployed environment and are not represented as
  passing here.
- The deterministic reference model is tested for ordering, bounds, fixed-seed
  stability, assimilation limits, routing thresholds, bridge handling, and
  exposure behavior. It is not a certified hydraulic model or validation against
  an authority-issued depth raster.

## Release boundary

The complete offline judging flow is implemented and verified: report, private
media handling, four-family corroboration, rapid impact update, lower-risk route
update, review, two-person approval, synthetic dispatch, resilience analysis,
source health, audit, reset, and mobile offline behavior. Live provider
credentials, production notification destinations, AWS activation, and legal or
authority operating approvals remain intentionally outside this evidence record.
