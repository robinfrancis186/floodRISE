# Kerala competition MVP release verification — 2026-07-29

This record captures the clean local release gate for the hardened floodRISE
Kerala competition MVP. It is development evidence from macOS, not evidence of
an AWS deployment, an activated municipal system, or authority-approved live
flood guidance.

## Delivered judging baseline

- The deterministic incident covers Aluva, Eloor, Kalamassery, Kadungalloor,
  and the Periyar floodplain under `demo-kerala-flood-v1`.
- Connected viewing uses standard OpenStreetMap tiles with visible contributor
  and ODbL attribution. Emergency response layers do not depend on an upstream
  tile connection.
- The reviewed Kerala baseline contains 3,967 major-road segments and an
  800-segment, 512 KiB packaged fallback.
- The full snapshot SHA-256 is
  `a6f0271c54f8b842f607c0ecbeddb4c0f5e3263c22ba3597fc9e1851c13331d0`.
- The fallback SHA-256 is
  `bd3302d7e94121786ad4fc66fdb21f122dedb23f7c6c839c9ee0db4b9c809f90`.

## Automated results

| Gate | Result |
| --- | --- |
| Lint, format, and types | Passed for every TypeScript workspace and both Python services. |
| Unit and service tests | 209 passed: Field 38, Operations 45, backend 117, and restricted tile API 9. |
| Executable conformance | 33 passed, including the OpenStreetMap importer, original-plan invariants, portable CodeQL SARIF threshold, immutable CI actions, dependency overrides, non-demo fail-closed policy, service isolation/discovery, CloudFront origin control, bounded media WAF policy, retention, and staff passkeys. |
| Production-path artifacts | Six checks passed against the built `/ops/` and `/field/` trees and the actual CloudFront rewrite function. They prove canonical redirects, nested routes, prefix-rooted assets, install icons, a Field service worker that cannot claim Operations, and complete shared map CSS in both optimized applications. Total automated unit/service/conformance/artifact checks: 248. |
| Contracts and fixtures | Seven fixture files, two raster artifacts, 3,967 full OpenStreetMap road segments, and 800 fallback segments validated. The 33-path OpenAPI snapshot and generated TypeScript client match FastAPI. |
| Local performance acceptance | Twenty samples each produced report p95 7.50 ms, route p95 3.13 ms, and nine-member model-publication p95 5.50 ms. Fourth-report corroboration and route recalculation completed in 5.24 ms. These are deterministic local timings, not deployed k6 evidence. |
| Production builds | Both Vite applications built under their CloudFront prefixes. The Field PWA generated a 27-entry, 2,276.77 KiB precache with Android, maskable, and Apple install icons; its compiled service worker permits runtime caching only for same-origin `GET /api/v1/alerts`. |
| Browser journeys | 26 real-Chromium Playwright journeys passed in 2.3 minutes. They cover axe WCAG AA smoke checks, every Operations and Field route, 320×568 through 768×1024 plus 844×390 touch layouts, safe-area handling, offline restrictions, private photo sanitization, FloodSignal review, two-person approval, and working filters/exports/navigation boundaries. |
| Repeatability | The deterministic reset/fourth-report browser replay passed three consecutive runs in 4.0 seconds. Every fourth report produced the explicitly unofficial signal and retained the route/audit invariants. This automated proof does not replace the three-run operator record required by the demo runbook. |
| Infrastructure conformance | Docker, Terraform, and Trivy were unavailable in this local environment. The repository conformance tests for service isolation, immutable images, WAF, Cognito, CloudFront, and Terraform-required resources passed; exact-commit Compose/Terraform/Trivy evidence remains a hosted gate. No plan or apply was performed. |
| Dependencies and secrets | Frozen pnpm/uv installation passed; production and full `pnpm audit --audit-level high` found no known vulnerabilities; both uv locks resolved; Gitleaks scanned 11.06 MB across 19 commits and found no leaks. |

## Security closure

A standard Codex Security review sealed the immutable pre-hardening snapshot
with complete 244/244-file coverage. Discovery normalized 32 candidates;
central validation closed every row, and attack-path policy retained 18
reportable findings: two high, six medium, and ten low. Three development-only
dependency rows were not applicable and eleven rows did not cross the final
reportability threshold.

The release patch closes every reportable boundary and also repairs adjacent
safety defects found during validation:

- shelter closure-equivalent states require the approved two-person action;
- media intake is bounded and non-demo uploads refuse bytes without approved
  external storage and scanning adapters;
- concurrent media retries use immutable per-write blob references, so a losing
  process cannot delete the winning quarantine or sanitized object;
- approval decisions bind existing evidence/model versions and use
  cross-process compare-and-swap;
- road and shelter actions bind an incident-scoped target and version; approved
  closures/capacity/access changes are persisted and immediately exclude
  affected route edges or destinations;
- `MODIFIED` approvals remain non-dispatched, while FloodSignal field checks
  authoritatively transition to `NEEDS_REVIEW`;
- audit-chain appends are serialized and guarded by a uniqueness migration;
- reporter bootstrap, alerts, and SSE are role/incident projected;
- SSE admission, replay cursors, and connection counts are bounded;
- report install identity is server-authoritative and poor GPS remains visible
  but cannot influence live corroboration or routing;
- routes fail closed for ambiguous, unknown, inaccurate, out-of-area, or
  unsnappable origins, stale route versions, and unverified or unusable
  shelters;
- private media metadata is never admitted to the shared Field service-worker
  cache; expired alerts are not rendered as current; and an online API fallback
  is visibly labeled deterministic `DEMO DATA`;
- production assets are rooted at `/ops/` and `/field/`; the PWA scope is
  limited to `/field/`, while packaged route geometry is hidden from Field and
  Evacuation views that do not have matching authoritative GeoJSON;
- AWS workloads have service-specific roles and security groups, no runtime
  master database credential or unused Redis path, constrained egress,
  digest-only images, private tile discovery/manifest wiring, a
  CloudFront-to-ALB origin boundary, an OSM-compatible CSP, and a tightly scoped
  rate-limited media-body WAF exception;
- CI actions are pinned to immutable commits, CodeQL SARIF has a portable
  high/error release threshold, and staff authentication fails closed unless
  phishing-resistant evidence is present.

Focused regressions prove the repaired behavior, including two independent
database processes racing `APPROVE` versus `REJECT`, media services racing
content/scan completion, approval-to-closure-to-reroute, shelter status changes,
route and GPS boundary cases, connected source/route freshness, private-cache
policy, staff authentication, non-demo media refusal before body reads, and
out-of-coverage tile requests that never invoke the renderer.

## Rendered-product review

The Operations console was inspected at 1,570×1,000 and both products were
exercised at 320×568, 360×800, 390×844, 430×932, 768×1024, and 844×390 in
real touch-enabled Chromium contexts. The interface retains the approved map-first visual
system: dense operational hierarchy, restrained navy/blue/coral status
language, tabular values, explicit focus states, non-color cues, synchronized
list alternatives, and visible `DEMO DATA · NOT LIVE` wording. The Kerala map,
flood overlays, road risk, lower-risk route, FloodSignal evidence, shelters,
OpenStreetMap attribution, source provenance, and responsive controls rendered
without page or console errors. Every audited mobile control retained a
44×44 px touch target; phone safe areas, short landscape navigation, table
alternatives, and map gesture boundaries were also exercised. Primary controls either perform a tested local
or authoritative action or are visibly disabled with the missing authority
boundary; no inert primary button remains.

Reference captures:

- `artifacts/screenshots/ops-live.png`
- `artifacts/screenshots/ops-floodsignal.png`
- `artifacts/screenshots/ops-resilience.png`
- `artifacts/screenshots/field-conditions.png`
- `artifacts/screenshots/field-report.png`
- `artifacts/screenshots/field-offline-route.png`

## Deliberate external boundaries

- No IMD, CWC/NWDP, KSDMA, local-authority, or satellite credential was used,
  and no permission-gated source was scraped.
- No production notification destination, live closure, evacuation
  instruction, or all-clear was contacted or dispatched.
- Docker, Terraform, Trivy, ZAP, k6, physical iOS installation, and VoiceOver
  device testing were unavailable in this local environment. Hosted CI remains
  the independent Compose/Terraform/CodeQL/Trivy gate; authenticated ZAP,
  deployed-load k6, and assistive-technology device review require the
  authorized target environment.
- AWS plan/apply, Cognito enrollment, PostGIS multi-worker rehearsal, production
  scanner/object-store injection, backup restoration, RPO/RTO measurement, and
  direct-ALB/CloudFront probes remain activation evidence.
- The rapid impact model is a deterministic competition reference, not
  certified two-dimensional hydraulics. Routes remain lower-risk estimates,
  never guaranteed-safe routes.
