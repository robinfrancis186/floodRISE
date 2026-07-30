# Original plan execution matrix

This matrix reconciles the requested floodRISE Professional Competition MVP
with the checked-in implementation. `Executed` means the deterministic Kerala
judging path is implemented and has an automated acceptance check. `Scaffolded`
means deployable code or infrastructure is present but requires an authorized
environment. `External activation` means completion cannot be truthfully
claimed from a source repository alone.

The executable companion is `scripts/plan-conformance.test.mjs`; it runs as
part of `pnpm test` and fails if a required implementation or safety boundary
is removed.

## Competition scenario

| Plan requirement | Status | Implementation and evidence |
| --- | --- | --- |
| Desktop operations console with eight workflows | Executed | `apps/ops-web`; direct-route Playwright sweep and operations journey. |
| Installable field PWA with six operational workflows | Executed | `apps/field-web`; scoped manifest/Workbox, Android/maskable/Apple icons, safe-area handling, and six-viewport Field journeys. |
| Professional shared visual system and accessible map alternatives | Executed | `packages/ui`, `packages/map`, `docs/DESIGN_SYSTEM.md`, keyboard semantics and axe tests. |
| Detailed Kerala OpenStreetMap view with offline emergency fallback | Executed | 3,967 versioned OSM road segments, 800-segment fallback, visible ODbL attribution and fixture validation. |
| Visible `DEMO DATA`, freshness and confidence wording | Executed | Shared banner, source health, map labels and browser assertions. |
| Never claim certified depths or guaranteed-safe routes | Executed | “Rapid impact estimate” and “lower-risk route” language is enforced in UI, API and tests. |

## Evidence, intelligence and authority

| Plan requirement | Status | Implementation and evidence |
| --- | --- | --- |
| Encrypted offline reports, 100 item/100 MB cap and 24-hour expiry | Executed | AES-GCM Dexie queue plus unit and browser offline tests. |
| Quarantine, checksum/type checks, scanning, re-encoding, EXIF removal and deduplication | Executed | `services/backend/app/media.py` and media failure/ownership tests. |
| Four-family, two-trusted FloodSignal corroboration | Executed | Domain rules, boundary tests and fourth-report Playwright acceptance under five seconds. |
| Explicit unofficial corroboration wording | Executed | API constant, Operations/Field UI and assertions. |
| Deterministic nine-member rapid-impact model and four horizons | Executed | `app/intelligence.py` with deterministic numerical tests. |
| Bounded same-catchment assimilation | Executed | 500 m decay, +/-0.5 m cap and acceptance tests. |
| Threshold-aware lower-risk routing, bridge handling and no-route staging | Executed | `app/routing.py` and deterministic routing tests. |
| Server-enforced roles and two-person approvals | Executed | OIDC/demo principals, staff phishing resistance, immutable evidence/model binding, cross-process compare-and-swap, expiry and distinct-reviewer browser journey. |
| Hash-chained audit, transactional outbox and replayable SSE | Executed | Serialized audit head, SQLAlchemy repository, audit export, authenticated incident-scoped replay, admission caps and client invalidation handling. |
| Resilience audit with cautious recommendations | Executed | API seed/domain plus Operations Resilience Audit view and route sweep. |

## Platform and delivery

| Plan requirement | Status | Implementation and evidence |
| --- | --- | --- |
| pnpm/uv monorepo, generated OpenAPI client and RFC 9457 errors | Executed | Eight workspaces, 35-path snapshot, generated TypeScript schema and contract drift gate. |
| Local PostGIS, Redis, MinIO and LocalStack profile | Scaffolded | Isolated `infra/compose.yaml`; requires Docker on the target machine. |
| PostgreSQL spatial extensions and normalized operational tables | Scaffolded | Alembic `0002_postgis_operational_schema`; production query migration still requires an authorized database rehearsal. |
| Celery worker over an allow-listed SQS queue | Scaffolded | `app.worker:celery_app`, eager offline demo tasks, predefined SQS queue transport and ECS command. |
| Reproducible backend container image | Scaffolded | Non-root, frozen-uv `services/backend/Dockerfile`; immutable registry build requires the deployment account. |
| AWS Mumbai CloudFront, WAF, ECS, RDS, S3, SQS, Cognito, KMS and Secrets Manager | Scaffolded | Terraform modules and hosted validation; Redis is intentionally omitted until an authenticated remote fanout need exists. No AWS apply is claimed. |
| Firebase Hosting for `/ops/` and `/field/` | Scaffolded | The CSP template, reviewed target map, deterministic per-app source/config receipts, complete artifact hashes, exact project confirmation, and clean-tree execution guard preserve demo/live isolation, both prefixes, and Field PWA scope. The direct `floodrise-api` rewrite is limited to short requests; no Firebase project selection or deploy is claimed. |
| Google Cloud Mumbai-equivalent regional runtime | Scaffolded | `infra/gcp` declares Cloud Run API/tile services, an asynchronous simulation job, private Cloud SQL/PostGIS, private Storage, KMS, Secret Manager, Artifact Registry, service identities and recovery controls in `asia-south1`. CI initializes and validates without credentials; no plan/apply is claimed. |
| Multi-AZ, PITR, cross-region backup, RPO 5 and RTO 30 controls | Scaffolded | Terraform production preconditions and backup resources; measured restoration remains external evidence. |
| Cognito/OIDC and phishing-resistant step-up | Scaffolded | Resource-server verification, claim enforcement and Cognito resources. Real web PKCE/session enrollment needs the authority’s identity environment. |
| Identity Platform OIDC, App Check and FCM | Scaffolded | Generic OIDC can feed the same server-side roles/step-up contract; optional App Check covers modifying API requests plus SSE; guarded, opt-in FCM accepts only production activation. Project registration, passkey enrollment, App Check enforcement and real delivery are external activation. |
| Private production object storage, approved malware scanner and COG service | External activation | Interfaces and locked tile boundary exist; provider, scanner and production COG adapter require credentials, licences and infrastructure. |
| Real IMD/CWC/KSDMA or local-authority feeds | External activation | Deterministic contract-faithful adapters are used; permission-gated feeds are never scraped. |
| Real official alerts or evacuation dispatch | External activation | Demo uses only `fake://notification-sink`; a reviewed authority gateway and separate approval rehearsal are required. |

## Acceptance and release

| Plan requirement | Status | Implementation and evidence |
| --- | --- | --- |
| Full functional/unit/contract release gate | Executed | `pnpm test`, lint, format, typecheck and production builds. |
| Local judging-path latency thresholds | Executed | Twenty-sample API acceptance gate enforces report p95 <=2 s, fourth-report transition <=5 s, route p95 <=750 ms and model publication p95 <=60 s. |
| Desktop/mobile cross-app journeys | Executed | 26 Playwright journeys cover all routes, reports, media, reset, corroboration, approval, WCAG scans, and six touch viewports from 320×568 through 768×1024 plus 844×390. |
| WCAG automated gate | Executed | axe serious/critical WCAG A/AA/2.2 AA scans. |
| Three reset rehearsals and degraded-network journey | Automated path executed; operator record pending | Three consecutive deterministic fourth-report replays and the degraded offline browser journey pass. The demo runbook still requires the three-run operator record on the actual judging environment. |
| Hosted CodeQL, Trivy, secret and dependency gates | Configured; release run pending | Immutable GitHub workflows are checked in. The exact pushed release commit must pass them before publication. |
| Credential-free Firebase/GCP conformance | Executed | Firebase artifact/rewrite checks, `scripts/gcp-conformance.test.mjs`, Terraform formatting, provider initialization without a backend, and validation run in CI without choosing a project or creating resources. |
| Hydraulic benchmark tolerances, VoiceOver device review, ZAP, k6, backup restore and AWS smoke | External activation | Require accepted reference data or the authorized judging/deployment environment; deterministic checks and repository configuration are not substituted for that evidence. |
