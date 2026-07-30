# floodRISE

floodRISE is a human-verified flood intelligence and emergency decision-support MVP for Kerala. It combines deterministic flood-impact replay, community corroboration, lower-risk evacuation routing, human approval, and resilience auditing.

The pnpm/uv monorepo contains two React products, shared packages, and two
FastAPI services:

- `apps/ops-web`: command-center operations console.
- `apps/field-web`: installable, offline-first reporting PWA.
- `services/backend`: versioned API, FloodSignal rules, demo simulation, routing, approvals, SSE, and audit.
- `services/tile-api`: allow-listed raster tile facade backed by checksummed,
  versioned demo depth grids; arbitrary source URLs are rejected.
- `packages/ui` and `packages/map`: shared accessible UI primitives and Kerala MapLibre layers with a detailed interactive OpenStreetMap basemap plus a packaged offline road fallback.
- `packages/contracts` and `packages/api-client`: Zod contracts plus a generated OpenAPI client.
- `fixtures/kerala-demo`: checksummed deterministic Kerala extreme-rainfall replay data.
- `infra`, `ops`, and `docs`: local Compose, un-applied AWS and
  Firebase/Google Cloud Mumbai target topologies, observability configuration,
  CI gates, and runbooks.

## Local start

```bash
pnpm install
cd services/backend && uv sync && cd ../..
pnpm dev
```

- Operations console: <http://localhost:5173>
- Field PWA: <http://localhost:5174>
- API and OpenAPI: <http://127.0.0.1:8787/docs>

The default profile is a deterministic, clearly watermarked `DEMO DATA` replay and never contacts a real notification destination. See `docs/DEMO_RUNBOOK.md` for the judging flow and `docs/SAFETY.md` for operational boundaries.
The exact boundary between locally verified MVP behavior and deployment-time
integration work is recorded in `docs/IMPLEMENTATION_STATUS.md`.
The latest Kerala/OpenStreetMap and Firebase/GCP hardening evidence is recorded
in `docs/RELEASE_VERIFICATION_2026-07-30.md`.
The original brief is reconciled requirement by requirement in
`docs/PLAN_EXECUTION_MATRIX.md`; its executable checks run inside `pnpm test`.

## Firebase and Google Cloud target

Firebase Hosting can publish both prefixed web applications from one immutable
assembly while Cloud Run serves `/api/**`:

```bash
pnpm build
pnpm firebase:test
pnpm firebase:emulate
```

`firebase.json` targets the fixed `floodrise-api` Cloud Run service in Mumbai.
`infra/gcp` defines the separate-project Google Cloud topology; it does not
create or select a project on a developer's behalf. A dedicated floodRISE demo
project, a different live project, Blaze billing, immutable container digests,
registered Firebase web app IDs, authority OIDC configuration, and secrets are
required before deployment. Vite emits per-app target/source metadata, assembly
binds domain-separated receipts for the exact API key, App Check site key, and
OIDC provider ID, hashes every publish file, and the credential-free deployment
guard refuses stale, dirty, cross-project, wrong-app, or wrong-auth-domain
execution. See
`docs/GCP_FIREBASE_DEPLOYMENT.md`.

## Verify

The default test command covers web units, both Python services, deterministic
fixtures, and generated-client drift. It deliberately does not download or
launch a browser:

```bash
pnpm test
pnpm lint
pnpm format:check
pnpm typecheck
pnpm build
```

Install Chromium once and run the separate browser gate for cross-app journeys
and axe WCAG AA smoke scans. Playwright starts isolated API and web servers, so
the development API does not need to be running:

```bash
pnpm exec playwright install chromium
pnpm test:e2e
```

Backend tests use the lightweight deterministic profile. The judging API uses
SQLite by default; local Compose supplies PostgreSQL and Alembic bootstraps
PostGIS/pgRouting operational tables for authorized deployment rehearsals. The
deterministic model and router intentionally remain offline Python references.
Terraform plus the non-root backend image, Celery/SQS worker entry point, and
Cloud Run Job adapter form un-applied deployment scaffolds; they are not AWS or
Google Cloud activation evidence.
Browser artifacts are written under `artifacts/`.
The full CI and security gate matrix, including explicitly manual checks, is in
`docs/QUALITY_GATES.md`.
