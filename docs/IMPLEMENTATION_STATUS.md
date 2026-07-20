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
| Products | Eight-route React operations console and installable field PWA with six operational workflows, shared design tokens/map primitives, responsive layouts, keyboard semantics, list/table map alternatives, and safety wording. |
| Field evidence | AES-GCM encrypted Dexie queue, 100-item/100-MB limit, 24-hour draft expiry, idempotent sync, explicit offline freshness restrictions, receipts, and per-profile demo reset. |
| Private photos | Quarantine-first grant/content/complete API, exact size/type/SHA-256 checks, decoded-type validation, 20-MP limit, deterministic re-encoding without EXIF/GPS, private metadata, perceptual deduplication, scanner-outage behavior, and report-ownership checks. Demo bytes are process-local and `DEMO_CLEAN` is simulated, not an antivirus result. |
| FloodSignal | Spatial/time eligibility, evidence-family collapse, four-family/two-trusted threshold, explainable confidence, contradiction and aging states, explicit unofficial wording, audit/outbox events, and one demo caution. |
| Impact and routing | Fixed-seed nine-member rapid-impact reference model, four horizons, bounded catchment assimilation, exposure estimates, threshold/closure-aware lower-risk graph routing, bridge handling, shelter eligibility, and explicit no-route results. |
| Authority | Server-enforced roles, version conflicts, seeded two-person approval requests, distinct requester/approver checks, expiry/model/evidence binding, synthetic alert/audit records, OIDC/JWKS bearer verification, and phishing-resistant recent step-up claim checks for high-impact decisions. No external dispatcher or web PKCE/session flow is implemented. |
| Durability | SQLAlchemy/Alembic versioned entity repository, idempotency records, atomic hash-chained audit plus transactional outbox, and replayable SSE invalidations. SQLite supplies the deterministic demo; SQLAlchemy can target PostgreSQL, but no PostGIS/pgRouting application schema or query path is implemented. |
| Raster replay | Two checksum-pinned, georeferenced packaged PGM depth grids, fail-closed manifest validation, deterministic PNG tiles, TileJSON provenance/version metadata, and immutable ETags. This is explicitly not COG/TiTiler or certified depth output. |
| Kerala map and road baseline | Detailed standard OpenStreetMap tiles for normal interactive demo viewing, plus 3,967 packaged Kerala major-road segments with source way IDs, snapshot metadata, ODbL licence metadata, visible attribution, fixture checksum validation, and bridge/tunnel tags. Workbox does not cache cross-origin OSM tiles and the packaged response layers remain functional without upstream access. Public tiles are best-effort and not an emergency-runtime dependency. The exact legacy Chennai demo seed auto-migrates to Kerala without rewriting unrelated non-demo records. |
| Delivery assets | OpenAPI snapshot and generated TypeScript client, deterministic fixtures, local Compose dependencies, AWS Mumbai Terraform scaffold, CI/security workflows, runbooks, Playwright/axe journeys, and screenshot evidence. |

## Implemented boundary, activation evidence still required

- Terraform describes CloudFront/WAF, ECS, RDS, Redis, S3, SQS, Cognito, KMS,
  Secrets Manager, backups, and recovery controls, but no AWS plan or apply was
  performed from this workspace. It is a target scaffold with unresolved
  runtime wiring, including the declared worker entry point and application
  secret/settings contract.
- OIDC bearer verification is implemented. The Terraform Cognito client enables
  authorization-code, but the web PKCE exchange, refresh/logout, secure HttpOnly
  session, real Cognito pool, WebAuthn enrollment, DNS/TLS, WAF, secret injection,
  and two-user production rehearsal remain activation work.
- A fresh local Compose database initializes
  PostGIS/pgRouting/pgcrypto/btree_gist. Alembic does
  not install those extensions, Terraform provisions ordinary RDS PostgreSQL,
  and the judging model/router are deterministic Python reference
  implementations—not PostGIS raster processing or pgRouting edge views.
- The media interfaces are ready for private object storage and an approved
  scanner. The competition demo deliberately uses private process memory and an
  explicit simulated `DEMO_CLEAN` result; successful sanitization removes the
  raw quarantine copy and retains a private in-memory derivative. Scanner-outage
  data remains quarantined until process exit. Non-demo behavior fails closed
  until an approved storage/scanner adapter is injected.
- Hosted CodeQL/Trivy/dependency workflows are configured. ZAP, k6, VoiceOver,
  immutable container-image scans, backup restore, RPO/RTO, and three-reset plus
  degraded-network rehearsals must produce environment-specific release evidence.

## Deliberately not claimed

- No IMD, CWC/NWDP, KSDMA, Kerala local-authority GIS, or satellite credential was used
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
network field journey passed for the Kerala baseline on 2026-07-21; the exact
timings, OpenStreetMap snapshot, and scope are recorded in
`docs/RELEASE_VERIFICATION_2026-07-21.md`. The sub-two-minute
full reset rehearsal, eight-minute presentation timing, full numerical fixture
tolerances, performance percentiles, VoiceOver review, ZAP/k6 gates, and
zero-destination environment observation must still be run and recorded on the
actual judging machine. Until then those environment-dependent thresholds in
the submission plan remain acceptance targets rather than production claims.
