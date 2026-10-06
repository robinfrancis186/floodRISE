# floodRISE

floodRISE is a human-verified flood intelligence and emergency decision-support MVP for Indian cities, demonstrated with a Chennai scenario. It combines deterministic flood-impact replay, community corroboration, lower-risk evacuation routing, human approval, and resilience auditing.

The pnpm/uv monorepo contains two React products, shared packages, and two
FastAPI services:

- `apps/ops-web`: command-center operations console.
- `apps/field-web`: installable, offline-first reporting PWA.
- `services/backend`: versioned API, FloodSignal rules, demo simulation, routing, approvals, SSE, and audit.
- `services/tile-api`: allow-listed raster tile facade backed by checksummed,
  versioned demo depth grids; arbitrary source URLs are rejected.
- `packages/ui` and `packages/map`: shared accessible UI primitives and offline Chennai MapLibre layers.
- `packages/contracts` and `packages/api-client`: Zod contracts plus a generated OpenAPI client.
- `fixtures/chennai-demo`: checksummed deterministic Cyclone Michaung replay data.
- `infra`, `ops`, and `docs`: local Compose, an un-applied AWS Mumbai target-topology
  scaffold, observability configuration, CI gates, and runbooks.

## Local start

```bash
pnpm install
cd services/backend && uv sync && cd ../..
pnpm dev
```

- Operations console: <http://localhost:5173>
- Field PWA: <http://localhost:5174>
- API and OpenAPI: <http://127.0.0.1:8787/docs>

For the containerized API instead of `pnpm dev:api`, start the demo PostGIS,
Valkey, and API services, then run the two web apps in separate terminals:

```bash
docker compose -f infra/compose.yaml --profile api up -d --build backend
pnpm dev:ops
pnpm dev:field
```

India-specific reference data, CAP 1.2 alert export, and field-app languages are
described in `docs/INDIA.md`; the open-source components and optional Keycloak and
ClamAV services are in `docs/OPEN_SOURCE_STACK.md`.

The default profile is a deterministic, clearly watermarked `DEMO DATA` replay and never contacts a real notification destination. See `docs/DEMO_RUNBOOK.md` for the judging flow and `docs/SAFETY.md` for operational boundaries.
The exact boundary between locally verified MVP behavior and deployment-time
integration work is recorded in `docs/IMPLEMENTATION_STATUS.md`.

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
SQLite by default; local Compose supplies an optional PostgreSQL image with
PostGIS/pgRouting extensions for integration work, but the deterministic model
and router do not use those extensions. Terraform describes an RDS PostgreSQL
target and does not install PostGIS/pgRouting or deploy a working application by
itself. Browser artifacts are written under `artifacts/`.
The full CI and security gate matrix, including explicitly manual checks, is in
`docs/QUALITY_GATES.md`.


## Published release

- [Operations console](https://floodrise.vercel.app/)
- [Field reporting PWA](https://floodrise.vercel.app/field/)

`pnpm build:release` assembles both products in `dist/`; `vercel --prod`
uses the checked-in deployment configuration. The public release is a demo
until the API, identity provider, durable storage, and approved operational
sources are connected. [Deployment setup](docs/DEPLOYMENT.md) explains those
requirements; [latest verification](docs/RELEASE_VERIFICATION_2026-10-06.md)
records the checked behavior and remaining boundaries.
