# Firebase and Google Cloud deployment option

This document describes the checked-in Firebase/Google Cloud deployment
**scaffold**. It is an alternative to the AWS scaffold; it does not replace the
deterministic offline judging path or prove that a municipal production system
has been deployed. No Firebase project, Google Cloud project, domain, billing
account, authority feed, real notification destination, or production identity
tenant is created by this repository.

The deployment target is intentionally split into two isolated projects:

- a new, dedicated **demo** project for simulated Kerala data and the fake
  notification sink; and
- a separately owned **live** project with different credentials, buckets,
  databases, identity tenants, domains, alert gateways, and Terraform state.

Do not reuse an unrelated existing Firebase project. Project creation, Blaze
billing, domain ownership, credentials, remote Terraform state, and every
`terraform apply` or `firebase deploy` are external activation steps.

## Target topology and decisions

| Concern | Firebase/Google Cloud target |
| --- | --- |
| Static clients | Firebase Hosting serves the assembled `/ops/` and `/field/` Vite artifacts. Field retains the `/field/` manifest and service-worker scope, precaches only the static application shell/assets, keeps every `/api/**` response out of CacheStorage, and deletes historical API caches during worker activation before app authentication. |
| Short API requests | Protected production Cloud Run service in `asia-south1`; `runtime_config_ready=false` and all demo plans omit the remote API. Static demo Hosting therefore uses only local packaged fixtures and must treat `/api/**` as unavailable. |
| API edge | The implemented scaffold uses a Firebase Hosting rewrite directly to Cloud Run plus App Check. Cloud Armor is **not** on that path. A dedicated `api.<authority-domain>` with a serverless NEG and Cloud Armor is an optional future topology requiring separate implementation and review. |
| Long work | Terraform may declare a private deterministic-demo `floodrise-simulation` Job only after persistent runtime readiness. Production omits it because live incidents deliberately return `LIVE_MODEL_UNAVAILABLE`; persisted `202`/outbox wiring and an approved live model remain external work. |
| Spatial database | Private-IP Cloud SQL for PostgreSQL with server-enforced encrypted transport, separate API/simulation credentials, PostGIS, pgRouting, `pgcrypto`, and `btree_gist` bootstrapped by an approved database owner before Alembic. |
| Private artifacts | CMEK-protected Cloud Storage buckets separate quarantine, short-lived sanitized/private photos, raster/model products, and audit/export material. Quarantine and clean-photo buckets deliberately have no minimum retention, versioning, or soft-delete extension so generation-bound disposal can be prompt; eight-day and 31-day lifecycle rules are fallbacks for the API's seven-day and 30-day deadlines. Accepted evidence/identity records remain in PostgreSQL for one year. |
| Identity | Firebase Authentication with Identity Platform/generic OIDC. The API verifies the resulting Firebase ID token against the selected project's securetoken issuer, audience, and official Google JWKS. Staff approvals require an authority IdP that enforces phishing-resistant passkeys or security keys and recent step-up evidence. |
| Client attestation | Firebase App Check tokens are attached in memory to protected requests and verified by FastAPI. App Check complements authentication, authorization, and rate limiting; it does not replace them or imply a WAF/Cloud Armor path. |
| Notifications | FCM is opt-in and live-disabled by default. The deterministic demo remains bound to the fake sink and must never register or contact a production destination. |
| Tiles | An optional restricted demo-only tile service reads reviewed packaged-PGM artifacts after exact acknowledgement. Production is omitted because the current tile API does not implement COG products. |

The checked-in `firebase.json` is a deployment template for both web products in
`dist/firebase/`, preserving `/ops/` and `/field/` rather than placing either
application at the Hosting root. Rewrite order matters: API traffic is matched
before the two SPA fallbacks, and the final landing fallback must not swallow an
API 404. The template contains one auth-domain CSP placeholder. The release
guard replaces it with the exact reviewed target domain in an ignored generated
config; it rejects wildcard or unrelated iframe origins before Firebase CLI can
run.

Firebase Hosting removes cookies other than `__session` before forwarding a
dynamic rewrite. Therefore:

- the checked-in Firebase path uses injected, in-memory bearer and App Check
  providers; it does not use Firebase Hosting cookies;
- the present FastAPI bearer-token resource-server contract does not silently
  become a cookie session;
- any future BFF session sent through a Hosting rewrite must use a secure,
  HttpOnly, `SameSite`-reviewed `__session` cookie and add explicit CSRF
  defenses; and
- a future dedicated API domain could avoid that Hosting constraint, but the
  checked-in scaffold does not implement or claim that domain, load balancer,
  serverless NEG, or Cloud Armor protection.

Never put bearer tokens, App Check tokens, refresh tokens, service-account JSON,
signed URLs, or report coordinates into Hosting configuration, build artifacts,
analytics, logs, or Terraform variables.

## What is checked in

- `firebase.json`, `.firebaserc.example`, `.firebase-targets.example.json`,
  `scripts/firebase-build-metadata.mjs`,
  `scripts/assemble-firebase-hosting.mjs`, and the fail-closed
  `scripts/deploy-firebase-hosting.mjs` wrapper provide the deterministic
  Hosting artifact/rewrite contract without binding an actual checked-in
  project. Every Vite build emits public, deterministic deployment metadata for
  its environment, project, app ID, auth domain, API base, source commit,
  worktree state, and source-tree digest. It also emits domain-separated
  SHA-256 receipts for that app's exact Web API key, App Check site key, and
  OIDC provider ID; the raw values stay in the ignored reviewed target map.
  Assembly binds both app receipts and every publish-file hash into one
  manifest. The wrapper never falls back to
  Firebase CLI active-project state: it requires an explicit `demo` or `live`
  environment, a matching alias or exact project ID, the reviewed local target
  map, and an exact `PROJECT_ID:ENVIRONMENT` confirmation. It rejects stale,
  cross-environment, wrong-app, wrong-domain, or modified artifacts. Execution
  additionally requires a clean committed source tree.
- `infra/gcp/` declares the un-applied regional network, KMS keys, private
  buckets, Cloud SQL instance, Artifact Registry, protected production API, and
  explicitly gated demo-only model services, plus conditional identities/IAM,
  secret envelopes, backup controls, and activation guards.
- The clients initialize the Firebase Web SDK before rendering any API or SSE
  consumer. Firebase Auth uses `inMemoryPersistence`; bearer and refresh
  credentials are not written to durable browser storage. App Check and
  Identity Platform token providers feed the shared `cloudFetch` boundary,
  demo identity headers are removed when bearer identity is active, and
  requests are same-origin by default. A complete non-demo configuration with
  no signed-in user renders the OIDC sign-in gate; incomplete configuration
  renders a blocked startup state and creates no API or event-stream request.
  Before either client becomes live-ready, redirect restoration and the initial
  App Check and ID tokens must complete within a bounded startup deadline.
  Missing or invalid credentials fail closed before `fetch`.
- An installed Field PWA that relaunches without connectivity first deletes
  every historical API cache and synchronously validates that its live build
  configuration is complete. It may then open a network-locked offline shell
  for local report creation and encrypted queue review. Queue sync, new alerts,
  and lower-risk route requests remain disabled after connectivity returns
  until the user explicitly retries and completes in-memory identity and
  device verification. Invalid deployment mode, incomplete configuration, or a
  failed cache purge renders the blocked startup state instead.
- FastAPI optionally verifies `X-Firebase-AppCheck` on every modifying
  `/api/v1` request and the `/api/v1/events` stream. Health, readiness,
  docs/OpenAPI, preflight, and other read-only GET requests are exempt. Demo and
  test profiles default to disabled and require static JWKS when the verifier is
  deliberately exercised offline.
- The allow-listed Cloud Run Job command publishes a bounded model receipt from
  authoritative event-ID, incident, and trigger environment overrides. The job
  rejects executions without a canonical persisted `evt-UUID` and echoes that
  non-sensitive correlation key in its bounded receipt. A separate v2 dispatch
  adapter binds the exact outbox event as its idempotency key and permits
  network use only for an allow-listed production project or an explicitly
  isolated demo project.
  Google IAM is bound to the exact Job resource. Because the current request
  uses execution overrides, it requires `run.jobs.runWithOverrides`; IAM cannot
  constrain that permission to specific override fields. A future persisted
  command-claim path should remove overrides and retain only `run.jobs.run`.
  The private GCS media adapter uses separate quarantine/clean buckets,
  generation preconditions, integrity receipts, bounded multi-page retention
  cleanup, and no public URL or ACL. A terminal sanitized/rejected result
  atomically persists a raw-quarantine cleanup marker before an immediate
  generation-bound delete; completion replay and metadata polling reconcile a
  pending marker without invalidating the terminal result. General retention
  sweep failure is reported without failing an unrelated media operation, and
  bucket lifecycle remains the maximum-retention fallback. Continuous
  scheduling, persistent atomic dispatch deduplication,
  runtime adapter injection, workload identity, and scanner integration remain
  deployment activation.
- The FCM driver is configuration-gated. Demo remains `demo_log` /
  `fake://notification-sink`; live activation requires explicit configuration,
  credentials, opt-in records, and an authority review. Browser FCM SDK/token
  provisioning, consent/subscription UX, and background-message bootstrap are
  not claimed by the server adapter.

These components are source and validation evidence only. The checked-in web
apps now include Identity Platform OIDC redirect bootstrap, in-memory ID-token
refresh, App Check provider injection, and fail-closed startup gates. Project
registration, authority OIDC tenant configuration, logout/session-expiry UX,
staff enrollment, approved App Check enforcement, and an end-to-end deployed
rehearsal remain activation work before production use.

## Browser build configuration

Firebase web configuration is public project metadata, not a service-account
credential. It must still identify the dedicated floodRISE demo or live project;
do not reuse an unrelated Firebase project or copy production values into demo
artifacts. Supply these values at Vite build time:

| Variable | Required non-demo use |
| --- | --- |
| `VITE_DEPLOYMENT_ENVIRONMENT` | Set exactly to `demo` or `live`; a cloud-configured build without this binding fails. |
| `VITE_DEMO_MODE` | Set exactly to `false`. `true` keeps the deterministic demo independent of Firebase. |
| `VITE_API_BASE_URL` | Field API root, normally `/api/v1` behind Hosting. |
| `VITE_API_ROOT` | Operations API root, normally `/api/v1` behind Hosting. |
| `VITE_FIREBASE_API_KEY` | Public Firebase Web API key for the selected project. |
| `VITE_FIREBASE_AUTH_DOMAIN` | Authorized Firebase Authentication domain. |
| `VITE_FIREBASE_PROJECT_ID` | Exact isolated Firebase/Google Cloud project ID. |
| `VITE_FIREBASE_APP_ID` | Registered Firebase web app ID for the product being built. |
| `VITE_FIREBASE_APP_CHECK_SITE_KEY` | Reviewed reCAPTCHA Enterprise site key used by App Check. |
| `VITE_FIREBASE_AUTH_PROVIDER_ID` | Identity Platform generic OIDC provider ID; it must begin with `oidc.`. |

`VITE_FIREBASE_MESSAGING_SENDER_ID` and
`VITE_FIREBASE_AUTH_SCOPES` are optional; scopes default to `email,profile`.
Field and Operations must be built with their exact registered
`VITE_FIREBASE_APP_ID`; run their package builds separately when those IDs
differ. Every `demo` or `live` deployable build must also supply the exact API
key, App Check site key, and OIDC provider ID recorded for that individual web
app in `.firebase-targets.json`; the release receipt stores only
domain-separated digests and fails when any one value changes. The app ID and
API key may be present in static JavaScript; bearer
tokens, refresh credentials, App Check tokens, debug tokens, report evidence,
and signed URLs must not be build inputs. An ordinary build without cloud
variables emits `environment: local` metadata and is deliberately
non-deployable.

The browser SDK is pinned to Firebase `12.16.0`. The rendered Hosting CSP allows
its exact App Check exchange origin
`https://content-firebaseappcheck.googleapis.com`, the exact
`https://apis.google.com` Auth loader/frame origin, reCAPTCHA Enterprise
origins, and the one reviewed target auth-domain origin. It does not wildcard
Firebase auth domains, and `frame-ancestors 'none'` plus
`X-Frame-Options: DENY` remain mandatory. Browser FCM is not implemented, so
FCM and Firebase Installations origins are intentionally absent; future browser
messaging activation requires a separate CSP and consent-flow review.

## Validate without credentials or cloud changes

The following commands download provider/tooling packages but create no Google
Cloud or Firebase resources:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm firebase:test
node --test scripts/gcp-conformance.test.mjs

terraform -chdir=infra/gcp fmt -check -recursive
terraform -chdir=infra/gcp init -backend=false -input=false
terraform -chdir=infra/gcp validate
```

`pnpm firebase:emulate` is an optional local rendered check on
`http://127.0.0.1:5500`; it uses a deliberately non-deployable local project
alias and must not be pointed at a real project.

Do not run `firebase use`, `firebase deploy`, `gcloud run deploy`,
`terraform plan` against a shared state, or `terraform apply` as part of this
credential-free validation.

## External activation checklist

1. Create a new dedicated demo project and a separate live project under the
   authority's organization. Attach Blaze billing, record project numbers, and
   enable only the reviewed APIs. Confirm no unrelated application shares
   either project.
2. Create separate remote-state buckets and identities. Copy the relevant
   example tfvars outside Git, replace each enabled runtime image placeholder
   with a full Artifact Registry `@sha256:` digest, and keep
   `runtime_config_ready=false`. Production accepts only the API image.
3. Build, scan, sign, and publish the production API image. Build tile and
   simulation images only for the separately reviewed deterministic demo gates.
   Review SBOMs, provenance, IAM, VPC routes, split managed/private egress,
   bucket retention, database protection, App Check, notification guards, and
   demo/live labels.
4. Initialize the reviewed remote backend. Run `terraform plan -out=...`; have a
   second operator review the saved plan. The repository intentionally has no
   automatic apply workflow.
5. Apply the control plane with runtimes disabled. Populate
   `api-database-url` and `session-secret` for production; populate
   `simulation-database-url` only for a separately activated deterministic demo
   Job. Database URLs must use separate PostgreSQL logins, the exact Cloud SQL
   private address injected as `FLOODRISE_DATABASE_ALLOWED_HOST`, and
   `sslmode=require`, `verify-ca`, or `verify-full`. Each enabled runtime fails
   startup when the parsed URL hostname differs. Production creates no
   simulation identity or secret grant. Do not use service-account key JSON
   when workload identity or attached service identities are available.
6. Connect to Cloud SQL as an approved database owner and run the extension
   bootstrap below. Create separate API and simulation runtime roles, run
   Alembic as a separate release task, verify the schema, and remove owner
   access from runtime services. Review redacted grants, RLS, ownership, and
   default privileges: separate passwords are independently revocable, but the
   generic `entities` table needs approved RLS or a dedicated publication
   boundary before kind-level SQL isolation can be claimed.
7. Configure Identity Platform OIDC, exact redirect origins, staff group/role
   mapping, passkey/security-key enrollment, recovery, and recent step-up. The
   API must verify the resulting Firebase ID token with issuer
   `https://securetoken.google.com/PROJECT_ID`, audience equal to the exact
   project ID, and JWKS URL
   `https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com`.
   Test two different authorized staff accounts; requester and approver must
   differ.
8. Configure App Check for the exact Hosting origins and allow-list the exact
   Firebase web app IDs through `FLOODRISE_FIREBASE_APP_CHECK_APP_IDS`. Confirm
   missing, malformed, expired, wrong-project/audience, wrong-issuer, and
   unlisted-app tokens fail closed on protected requests. The checked-in verifier
   does not claim single-use token replay prevention. App Check enforcement must
   not be enabled until the deployed clients can obtain valid tokens.
9. Keep FCM external delivery disabled in the demo project. In live, implement
   explicit consent/token registration and background handling around the
   existing Field Workbox registration, then test a non-production destination
   before any authority-approved audience. Official closures, evacuations,
   warnings, and all-clear messages still require the existing two-person
   approval contract.
10. Start only the environment's enabled runtimes after health, database,
    object, audit/outbox, OIDC, App Check, split-egress, and duplicate-delivery
    checks pass. Production has no tile or simulation runtime. Demo has no
    remote API; its tile service additionally requires reviewed packaged-PGM
    objects plus
    `demo_tile_artifacts_ack = "I_HAVE_REVIEWED_DEMO_TILE_ARTIFACTS"`. Copy
    `.firebaserc.example` to the ignored local
    `.firebaserc` and `.firebase-targets.example.json` to the ignored local
    `.firebase-targets.json`. Replace every placeholder with the separately
    reviewed project IDs and auth domains, plus each Field/Operations web app's
    app ID, Web API key, App Check site key, and OIDC provider ID. Export
    `VITE_DEPLOYMENT_ENVIRONMENT`, the matching `VITE_DEMO_MODE`, project, auth
    domain, and exact per-app Firebase inputs; build Operations and Field
    separately, then run `pnpm firebase:assemble`. The two app metadata receipts
    must identify the same source tree and target, and each per-app public
    configuration digest must match the ignored reviewed target map.
    Validate the target and every artifact hash without contacting Firebase:
    `pnpm firebase:deploy:hosting -- --environment <demo|live> --project <matching-alias-or-project-id> --confirm-target <verified-project-id>:<demo|live> --validate-only`.
    Validation renders the exact-domain CSP config locally but invokes no
    provider. After committing and rebuilding from a clean tree, a designated
    operator may repeat that exact command with `--execute` instead of
    `--validate-only`; this is an external activation action and is never run by
    CI. Verify `/ops/`, `/field/`, direct SPA routes, install scope, security
    headers, and API error behavior.

Example database-owner bootstrap:

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS pgrouting;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;
```

Verify exact installed versions with `pg_extension`; do not assume extension
availability from Terraform validation alone.

## Asynchronous simulation contract

The current deterministic demo `POST /simulations` remains synchronous. The
checked-in Cloud Run v2 dispatcher and job entry point are isolated, tested
adapters; Terraform exposes the Job only in a ready private demo runtime and
never grants the public production API execution permission. They are not yet wired into a persisted API `202`/transactional-outbox dispatch flow. Production
also has no approved live model, so that integration and its deployed rehearsal
remain external activation work.

The report/command API should acknowledge accepted long-running work with a
persisted identifier and version (normally HTTP `202`) and enqueue or execute
an approved environment-specific worker. Clients follow the authoritative
resource through SSE invalidations and refetch; Redis or FCM is never the source
of truth. A future job must be idempotent for the bound incident, evidence
version, model version, and request identifier.

The 60-second full-ensemble and impact acceptance target is an end-to-end
operational objective, not permission to hold a Firebase Hosting request open.
No simulation or impact request may depend on a Hosting connection remaining
open for that interval. Timeouts, retries, or duplicate job delivery must not
create duplicate model versions, alerts, or approvals.

## Deployment verification

Before traffic:

- confirm demo/live project ID, project number, database, storage prefix,
  Firebase site, OIDC tenant, App Check audience, and notification driver;
- prove all container references are immutable digests and runtimes use attached
  least-privilege identities;
- verify Cloud SQL private connectivity, `ENCRYPTED_ONLY` server policy,
  `sslmode=require` on both distinct runtime URLs, extension/schema versions,
  PITR, deletion protection, and independent credential revocation;
- verify quarantine objects cannot be read publicly and the tile service cannot
  fetch arbitrary URLs;
- verify missing App Check is denied only where configured, and authentication,
  server-side roles, step-up, and two-person approval still fail closed;
- run the full unit/contract/browser/security gates and deployed ZAP/k6 and
  physical VoiceOver checks; and
- execute one synthetic job, one no-route case, one notification non-delivery,
  SSE replay, audit-chain verification, and duplicate-dispatch prevention.

## Rollback

1. Stop traffic shift and disable new live dispatch. Do not issue an automatic
   all-clear.
2. Roll Firebase Hosting back to the previous recorded Hosting version.
3. Route the API/tile service to the previous immutable Cloud Run revision and
   stop new simulation job executions. Reconcile any in-flight job by its
   persisted idempotency/version key.
4. Do not blindly reverse a database migration. Prefer a forward-compatible
   repair; otherwise restore into isolation and verify audit/outbox continuity
   before controlled cutover.
5. Mark withdrawn model, impact, evidence, and route versions as superseded;
   preserve the append-only audit chain.
6. Re-run health, authorization, App Check, OIDC step-up, artifact access, SSE
   replay, no-duplicate-dispatch, and critical mobile/desktop journeys.

## Recovery rehearsal

Quarterly, restore the newest Cloud SQL PITR point and required bucket versions
into an isolated recovery project/VPC. Verify extension versions, schema, row and
object counts, raster/model manifests, audit hashes, outbox reconciliation,
private-object policies, and application smoke tests. Measure actual recovery
point and recovery time; Terraform variables declaring RPO at most five minutes
and RTO at most thirty minutes are objectives, not evidence.

The AWS-specific process remains in
[DEPLOYMENT_RUNBOOK.md](DEPLOYMENT_RUNBOOK.md). Neither scaffold is production
complete until the external activation and environment evidence above exist.
