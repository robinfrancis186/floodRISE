# Implementation status

This document prevents the deterministic competition MVP from being mistaken
for an activated municipal production system. The repository contains an
offline-capable deterministic judging path; “complete” here means the code path
is present, not that every numerical, performance, rehearsal, accessibility, or
cloud acceptance criterion has been evidenced. Live-provider and cloud
activation remain subject to authority, credentials, licences, implementation,
and environment evidence.

## Implemented and locally verified

| Area | Current implementation |
| --- | --- |
| Products | Eight-route React operations console and installable field PWA with six operational workflows, selectable report map pins and manual coordinate editing, shared design tokens/map primitives, responsive layouts, keyboard semantics, list/table map alternatives, and safety wording. |
| Field evidence | AES-GCM encrypted Dexie queue, 100-item/100-MB limit, 24-hour draft expiry, idempotent sync, explicit offline freshness restrictions, receipts, per-account storage isolation for signed-in reporters, and per-profile demo reset. |
| Private photos | Quarantine-first grant/content/complete API, exact size/type/SHA-256 checks, decoded-type validation, 20-MP limit, deterministic re-encoding without EXIF/GPS, private metadata, perceptual deduplication, scanner-outage behavior, and report-ownership checks. Demo bytes are process-local and `DEMO_CLEAN` is simulated, not an antivirus result. |
| FloodSignal | Spatial/time eligibility, evidence-family collapse, four-family/two-trusted threshold, explainable confidence, contradiction and aging states, explicit unofficial wording, audit/outbox events, and one demo caution. |
| Impact and routing | Fixed-seed nine-member rapid-impact reference model, four horizons, bounded catchment assimilation, exposure estimates, threshold/closure-aware lower-risk graph routing, bridge handling, shelter eligibility, and explicit no-route results. |
| Authority | Server-enforced roles, version conflicts, seeded two-person approval requests, distinct requester/approver checks, expiry/model/evidence binding, synthetic alert/audit records, OIDC/JWKS bearer verification, and phishing-resistant recent step-up claim checks for high-impact decisions. Browser authorization-code/PKCE sign-in, memory-only access tokens, server-verified role selection, expiration handling, and sign-out are implemented; no external dispatcher is connected. |
| Durability | SQLAlchemy/Alembic versioned entity repository, idempotency records, atomic hash-chained audit plus transactional outbox, and replayable SSE invalidations. An S3-compatible evidence adapter supports encrypted private quarantine and sanitized objects; production settings require PostgreSQL, HTTPS origins, S3, and a scanner, and reject empty/replay databases. SQLite supplies the deterministic demo; SQLAlchemy can target PostgreSQL, but no PostGIS/pgRouting application schema or query path is implemented. |
| Raster replay | Two checksum-pinned, georeferenced packaged PGM depth grids, fail-closed manifest validation, deterministic PNG tiles, TileJSON provenance/version metadata, and immutable ETags. This is explicitly not COG/TiTiler or certified depth output. |
| Road baseline | 291 packaged Chennai OpenStreetMap road segments with source way IDs, snapshot metadata, ODbL licence metadata, visible attribution, fixture checksum validation, and bridge/tunnel tags. Runtime maps remain functional without upstream tile or API access; this is a baseline, not event-time road status. |
| India profile | Static registry of sixteen flood-prone urban regions, national and city helplines, IMD/CWC reference scales, CAP 1.2 alert export in IST, and English/Hindi/Tamil/Malayalam field-shell strings. Only Chennai has packaged flood scenario data; Kerala has geographic facilities; translations and helpline numbers are unreviewed. See `docs/INDIA.md`. |
| Open-source adapters | ClamAV `INSTREAM` scanner adapter (unit-tested against a protocol stub, not a live daemon), Keycloak `realm_access.roles` claim support, and Compose services for Valkey, Keycloak, and ClamAV. See `docs/OPEN_SOURCE_STACK.md`. |
| OSM facilities and basemap | 637 Chennai and 23,586 statewide Kerala checksum-verified OpenStreetMap facility locations served nearest-first, with clustered, searchable map layers, category filters, source records, nearest-to-map-centre lists, and a Chennai/Kerala geography switch in both apps; the field hospital list also works from the packaged Chennai snapshot without an API; detailed direct OpenStreetMap raster basemap with packaged offline fallback, configurable through `VITE_OSM_TILE_URL`. Facility entries are unverified community data; routing does not yet use the OSM road network. |
| Delivery assets | OpenAPI snapshot and generated TypeScript client, deterministic fixtures, local Compose dependencies, AWS Mumbai Terraform scaffold, CI/security workflows, runbooks, Playwright/axe journeys, and screenshot evidence. |

## Implemented boundary, activation evidence still required

- Terraform describes CloudFront/WAF, ECS, RDS, Redis, S3, SQS, Cognito, KMS,
  Secrets Manager, backups, and recovery controls, but no AWS plan or apply was
  performed from this workspace. It is a target scaffold with unresolved
  runtime wiring, including the declared worker entry point and application
  secret/settings contract.
- OIDC bearer verification and browser PKCE are implemented and tested locally.
  A real identity provider/client, WebAuthn enrollment and step-up claim mapping,
  DNS/TLS, secret injection, and a two-user hosted rehearsal remain activation
  work. Access tokens stay in memory; a page reload requires sign-in again.
- A fresh local Compose database initializes
  PostGIS/pgRouting/pgcrypto/btree_gist. Alembic does
  not install those extensions, Terraform provisions ordinary RDS PostgreSQL,
  and the judging model/router are deterministic Python reference
  implementations—not PostGIS raster processing or pgRouting edge views.
- The S3-compatible storage adapter is implemented and tested with a protocol
  stub. A private bucket with public access blocked, platform IAM credentials,
  durable PostgreSQL, and a live ClamAV daemon still require provisioning and a
  restart/restore rehearsal. Demo bytes remain process-local, and `DEMO_CLEAN`
  is simulated. Protected media fails closed on scanner outage.
- The combined Vercel release serves operations at `/` and the field PWA at
  `/field/`, with independent asset paths, service-worker scope, and response
  security headers. The public deployment has no configured backend or OIDC
  provider and remains a labeled demo. See `docs/DEPLOYMENT.md`.
- Hosted CodeQL/Trivy/dependency workflows are configured. ZAP, k6, VoiceOver,
  immutable container-image scans, backup restore, RPO/RTO, and three-reset plus
  degraded-network rehearsals must produce environment-specific release evidence.

## Deliberately not claimed

- No IMD, CWC/NWDP, GCC, Chennai Flood Monitor, or satellite credential was used
  and no permission-gated source was scraped. The repository contains a
  source/provenance policy and contract-faithful deterministic fixtures, not an
  activated live ingestion fleet.
- The demo does not publish real alerts, closures, evacuation instructions, or
  all-clear messages. Approval creates a synthetic alert entity and audit event
  with `status: DISPATCHED` and `gateway: fake://notification-sink`; no sink or
  provider is invoked.
- Report serialization hides identity/device/note/media fields from
  non-identity-administrator views and generalizes location, but identity and
  evidence coexist in the same persisted JSON record. A separate identity store
  and audited join boundary are not implemented.
- The packaged raster adapter is not a COG reader or TiTiler service. A private,
  allow-listed production COG adapter remains a deployment prerequisite.
- The demo request path runs synchronously; Celery/SQS distributed workers,
  continuous ten-minute scheduling, national-scale modeling, and certified 2D
  hydraulics are outside this implemented competition path.
- Retention deadlines are stored and documented, but authority-approved object
  deletion, legal hold, and backup-deletion jobs require the deployment records
  system.

## Judging acceptance status

Automated unit, API, browser, and axe journeys exercise the deterministic path,
including reset controls, reporting, corroboration, routing, approvals, audit,
offline behavior, and media failure handling. They are development evidence,
not a signed judging rehearsal record.

Three consecutive clean automated resets/corroboration runs and the degraded
network field journey passed locally on 2026-07-20; the exact timings and scope
are recorded in `docs/RELEASE_VERIFICATION_2026-07-20.md`. The sub-two-minute
full reset rehearsal, eight-minute presentation timing, full numerical fixture
tolerances, performance percentiles, VoiceOver review, ZAP/k6 gates, and
zero-destination environment observation must still be run and recorded on the
actual judging machine. Until then those environment-dependent thresholds in
the submission plan remain acceptance targets rather than production claims.
