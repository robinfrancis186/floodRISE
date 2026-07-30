# Firebase/GCP hardening release verification — 2026-07-30

This record covers the completed local release gate for the floodRISE Kerala
competition MVP and its guarded Firebase Hosting/Google Cloud deployment
option. It is evidence for the checked-in deterministic product and deployment
scaffold. It is not evidence that cloud resources, authority feeds, production
notifications, or certified hydraulic guidance are live.

## Release outcome

- The desktop Operations console and installable Field PWA retain every planned
  competition workflow.
- The connected map uses OpenStreetMap with visible ODbL attribution. The
  deterministic emergency layers remain available without an upstream map
  provider.
- The reviewed Kerala baseline contains 3,967 unique road segments, including
  564 bridge-tagged and five tunnel-tagged segments. The packaged fallback
  contains 800 major-road segments.
- Four independent eligible reports still produce the explicitly unofficial
  wording: “Community-corroborated — not an official confirmation.”
- Official closures, evacuation instructions, warnings, and all-clear actions
  remain subject to server-enforced role, version, expiry, and two-person
  approval rules.
- Model output remains a “rapid impact estimate,” and route output remains a
  “lower-risk route,” never a certified depth or guaranteed-safe route.
- Demo and live browser sessions now use separate normalization and startup
  boundaries. A live session cannot substitute Kerala fixtures, replay maps,
  demo incidents, deterministic alerts, or demo routes after an API failure.

## Automated verification

| Gate | Result |
| --- | --- |
| Unified test gate | `pnpm test` passed: 150 web tests, 311 backend tests, nine restricted tile-service tests, and 41 executable plan/security/data conformance tests. |
| Backend coverage | 8,604 statements measured at 94% total coverage. |
| Lint, format, and types | All seven TypeScript workspaces passed type/lint checks; backend Ruff and tile-service Ruff lint/format checks passed. |
| API contract | The 35-path FastAPI OpenAPI snapshot and generated TypeScript client match with no source drift. Production App Check requirements remain in the stable contract even when isolated local-demo enforcement is disabled. |
| Production builds | Operations and Field production builds passed. Field service-worker policy validated 28 precache entries, no authenticated API runtime cache, API navigation exclusion, and legacy API-cache purging. |
| Firebase artifacts | Both apps assembled into 38 path/size/SHA-256-bound artifacts. Web artifact checks passed 30/30; Firebase metadata, CSP, deploy-target, and tamper guards passed 24/24. Credential-free `--validate-only` returned `deployed:false` and made no provider call. |
| Browser journeys | 26/26 real Chromium Playwright journeys passed in 2.6 minutes. Coverage includes all routes, FloodSignal review, two-person approval, private media, offline queue and route restrictions, safe areas, tables, exports, and WCAG smoke checks. |
| Mobile compatibility | Six Field and six Operations viewport checks passed at 320×568, 360×800, 390×844, 430×932, 768×1024, and 844×390. Touch targets, containment, short-landscape navigation, and mobile table alternatives were exercised. |
| Accessibility | Automated axe WCAG A/AA/2.2 AA smoke scans passed for Operations, Field, and the mobile Source Health/Audit tables. Keyboard, focus, non-color status, and list/table map alternatives remain covered. |
| Replay repeatability | The reset-plus-fourth-report acceptance passed three consecutive clean runs. Each run produced one unofficial corroboration without duplicate operational effects. |
| Local latency | Twenty samples per path produced report p95 7.43 ms, fourth-report transition 5.32 ms, route p95 2.72 ms, and nine-member simulation publication p95 6.52 ms. These are local deterministic timings, not deployed k6 results. |
| GCP Terraform | Terraform 1.12.2 format, isolated credential-free initialization, validation, and all 10 mocked plan tests passed. |
| AWS Terraform | The existing `infra/terraform` AWS stack passed format, isolated initialization, and validation. It has no Terraform test files. No plan or apply was performed. |
| Dependencies and secrets | The production pnpm audit found no known vulnerabilities. Security conformance passed 11/11. Gitleaks 8.30.1 scanned about 22.81 MB and found no leaks; custom key, token, JWT, service-account, and signed-URL scans were also clean. |

The backend and tile tests each emit the upstream Starlette TestClient
deprecation warning about the future `httpx2` migration. It does not affect the
test results.

## Security remediation

The sealed Codex Security working-tree review covered 47/47 changed surfaces and
validated 14 candidates. It reported three findings: one high, one medium, and
one low. All three are fixed:

1. Anonymous liveness no longer performs database or audit-history work.
   Readiness performs one bounded audit-head primary-key lookup.
2. App Check unknown-key traffic uses a generation-coalesced refresh,
   success/failure cooldown, and bounded hashed negative cache instead of one
   upstream JWKS fetch per attacker-chosen key ID.
3. The simulation job uses its own workload identity and database secret, not
   the API session/HMAC or database secret.

Post-seal adversarial review also closed adjacent release blockers:

- OIDC unknown-key traffic now has the same coalescing, cooldown, and bounded
  negative-cache protections while retaining valid key-rotation recovery.
- App Check errors pass through strict CORS handling without reaching a route;
  the production header contract is deterministic in OpenAPI.
- `/metrics` authenticates and authorizes an auditor, engineer, or incident
  commander before database rendering.
- Staging/production and any remotely marked simulation job require PostgreSQL,
  encrypted transport, and an exact approved Cloud SQL host. Local demo SQLite
  remains available only without the remote marker.
- Cloud Run simulation retries bind an existing `simulation.requested` outbox
  event to the exact incident/resource and return the first atomic result for a
  duplicate request.
- FCM delivery uses a persistent pre-send lease and fencing attempt, crosses an
  atomic `UNKNOWN_AFTER_SEND` boundary before provider I/O, never
  automatically retries an ambiguous send, and requires explicit authorized
  reconciliation.
- Ephemeral GCS quarantine/evidence objects have no minimum-retention,
  versioning, noncurrent-version, or soft-delete extension. Eight-day and
  31-day lifecycle fallbacks remain. Terminal media processing records a
  durable cleanup marker and hash-chained deletion receipt, and retries an
  exact generation-pinned quarantine deletion without changing the already
  committed idempotent response.
- Field Workbox never caches authenticated API requests. Old API caches are
  purged before every startup branch and again when the worker activates.
- Field cloud startup is time-bounded and credential-preflighted. Live requests
  fail locally when App Check or bearer tokens are unavailable.
- Field live mode validates `/incidents/bootstrap`, uses only its
  non-simulated incident ID/reference time, and rejects simulated incidents,
  alerts, and routes. Cold offline live mode is draft-review-only until
  re-verification.
- Cross-tab AES-key election and queue admission are transactional. The
  100-item/100-MB limits cannot be raced, one damaged ciphertext cannot hide
  healthy drafts, and reporters can remove only the unreadable local record.
- Accepted report IDs and sanitized receipts remain recoverable if IndexedDB
  receipt persistence fails after the API commits the report.
- Operations live mode obtains its principal from `/auth/me`, disables role
  switching, strictly normalizes the authoritative bootstrap, rejects
  demo-labelled responses, and provides safe empty/unavailable states across
  all eight routes.
- Firebase Hosting CSP is generated from the exact reviewed auth domain and
  required Firebase 12.16 endpoints. Per-app build receipts bind mode, project,
  app ID, API origin, SDK version, API key, App Check site key, OIDC provider,
  source state, and artifact hashes. Deployment revalidates the same values
  immediately before a provider process could start.
- Unready GCP configurations create no API, tile, simulation, runtime service
  account, or related IAM. Tile and simulation services are ready-demo-only;
  production model runtimes remain absent until reviewed live adapters exist.

## Rendered-product review

The six tracked captures were inspected directly against the four approved
visual concepts:

- `artifacts/screenshots/ops-live.png`
- `artifacts/screenshots/ops-floodsignal.png`
- `artifacts/screenshots/ops-resilience.png`
- `artifacts/screenshots/field-conditions.png`
- `artifacts/screenshots/field-report.png`
- `artifacts/screenshots/field-offline-route.png`

The implemented products preserve the intended restrained near-white/cool-gray
surfaces, navy hierarchy, flood blue, coral/amber/green status language,
tabular operational values, consistent icons, visible focus, map/list
alternatives, and explicit demo/freshness/confidence wording. The desktop
console is deliberately information-dense rather than card-heavy. The mobile
form and route states remain task-focused and readable without decorative
dashboard treatment.

The in-app Browser JavaScript control tool was not available after two
discovery attempts. The required repository Playwright fallback performed the
rendered Chromium, touch, console, download, screenshot, and axe validation.

## Deliberate external activation boundaries

- No Firebase Hosting deploy, GCP apply, AWS apply, resource creation, live
  project selection, or production provider call occurred.
- A real Firebase `--execute` requires committed clean source, an exact
  authority-reviewed target map, real public Firebase/App Check/OIDC values,
  and a fresh matching artifact build.
- The GCP production API remains gated until the authority supplies an edge
  admission/rate-limit control, Cloud SQL/OIDC/App Check configuration,
  production object-store/scanner integration, and operational approval.
- Production tile and simulation runtimes are intentionally omitted until
  reviewed COG/hydraulic and live-model adapters exist.
- No IMD, CWC/NWDP, KSDMA, local-authority, or satellite credential was used,
  and no permission-gated source was scraped.
- No production notification destination, official closure, evacuation
  instruction, warning, or all-clear was contacted. The FCM component is
  implementation-tested but not service-layer activated.
- Docker, Trivy, shellcheck, promtool, k6, and OWASP ZAP are unavailable on this
  machine. Hosted CI remains the Docker/CodeQL/Trivy gate. Authenticated ZAP and
  deployed k6 evidence require the authorized target.
- Physical iOS installation and VoiceOver validation remain device/operator
  work; automated Chromium/axe results do not substitute for them.
- Cloud backup restore, RPO/RTO measurement, PostGIS multi-worker rehearsal,
  and notification reconciliation authorization require the deployed authority
  environment.
- The rapid model remains a deterministic competition reference, not certified
  hydraulic analysis. Expired evidence never means an area is safe.
