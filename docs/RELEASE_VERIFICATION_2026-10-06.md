# Release verification — 6 October 2026

## Completed locally

- Web units: 61 passed (22 operations, 32 field, 5 map, 2 browser-session).
- Backend: 126 passed, including signed-JWKS roles, recent step-up, private
  photo quarantine, S3 adapter contracts, and rejection of empty/replay
  production databases. S3/scanner checks use local protocol stubs.
- Tile API: 7 passed. Import/release scripts: 8 passed.
- All 14 Playwright journeys passed, including desktop/mobile navigation,
  axe accessibility smoke checks, encrypted offline reporting, expired routes,
  evidence review, private photos, independent approval, and demo reset.
  Street-tile browser tests use deterministic mocked tiles, not bulk requests
  to the community tile server.
- TypeScript, Ruff lint/format, fixtures/checksums, generated OpenAPI drift,
  and `git diff --check` passed. Compose configuration validates.
- Release build packages operations at `/` and the PWA at `/field/`; assembly
  checks ensure map CSS survives tree shaking and the manifest uses `/field/`.
- A protected release without valid OIDC/API build configuration is rejected.

## Hosted verification

The combined Vercel release returned HTTP 200 for operations, `/signals`,
`/field/report`, the field JavaScript entry, service worker, and manifest.
Security headers and PWA manifest scope were checked. Real browser inspection
confirmed detailed OSM tiles and tablet controls. That inspection also caught
field-only stylesheet tree shaking and base-path report layout defects;
both were fixed in this release.

## Activation boundaries

Vercel has no configured API or identity provider; `/api/v1/health` is missing.
The release remains a clearly labeled demo. API-dependent decisions cannot be
saved there; reports remain encrypted for retry and current routes are withheld.
Local development runs the full deterministic API and both web products.

Real emergency activation requires a service host, OIDC client and enrolled
users, durable PostgreSQL, a private S3 bucket, a real ClamAV daemon, approved
live incident/source workflows, operational routing, and an authorized alert
provider. Current field workflows still target the Chennai replay incident.
No hosted identity round trip, bucket durability/restore, live scan, real alert
sending, physical-device/VoiceOver review, load test, or backup recovery was
claimed. Docker execution was unavailable locally; only Compose configuration
was validated. Build output still warns about large map/entry chunks.

See [deployment setup](DEPLOYMENT.md) and
[implementation status](IMPLEMENTATION_STATUS.md) before operational activation.
