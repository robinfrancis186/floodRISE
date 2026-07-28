# Quality and security gates

This matrix describes checks that are actually automated in this repository.
GitHub branch protection must require the listed workflows before they become
merge-blocking; repository files alone cannot enforce that setting.

## Local commands

| Command | Scope | Browser required |
| --- | --- | --- |
| `pnpm test` | Vitest, backend pytest (including 20-sample local latency acceptance and Alembic upgrade), tile pytest, plan-conformance checks, bounded OSM importer tests, fixture checksums/safety flags, FastAPI snapshot drift, generated OpenAPI client drift | No |
| `pnpm lint` | TypeScript package checks and Ruff for both Python services | No |
| `pnpm format:check` | Ruff formatting for both Python services | No |
| `pnpm typecheck` | Every TypeScript workspace package | No |
| `pnpm build` | Production builds for both React applications/shared packages plus exact `/ops/` and `/field/` CloudFront artifact checks | No |
| `pnpm test:e2e` | Deterministic API replay, all-route desktop/mobile sweep, operations journey, offline field journey, and axe smoke scans | Chromium |
| `pnpm test:a11y` | axe smoke scans for the operations console and 360 px field workflow | Chromium |
| `pnpm test:security-conformance` | Immutable Actions, dependency overrides, fail-closed environments, service isolation, origin enforcement, retention, and passkey-only infrastructure contracts | No |

`pnpm test:e2e` starts isolated services on ports 8787, 55173, and 55174 and
uses a disposable ignored SQLite database. It does not contact production alert
destinations or require upstream disaster-data providers.

The current dated local result and its environment limitations are recorded in
`docs/RELEASE_VERIFICATION_2026-07-28.md`.

## CI workflow

`.github/workflows/ci.yml` runs these independent gates:

- Web units, TypeScript checks, production builds, deterministic fixture
  validation, FastAPI-to-snapshot drift, and OpenAPI generated-client drift.
- Backend Ruff/format and pytest with coverage output.
- Restricted tile service Ruff/format and pytest.
- Playwright Chromium journeys plus axe serious/critical WCAG 2 A/AA, 2.1
  A/AA, and 2.2 AA smoke scans. Failure traces, video, screenshots, and the HTML
  report are retained for seven days.
- Compose, Terraform, Prometheus, JSON, shell, and demo-isolation validation.

## Security workflow

`.github/workflows/security.yml` provides CodeQL `security-extended` analysis
for TypeScript/JavaScript and Python, Gitleaks history scanning, Trivy filesystem
scanning that fails on fixed high/critical findings, retained SARIF evidence,
and pull-request dependency review. A portable SARIF check fails CodeQL results
with numeric security severity 7 or higher, or SARIF error level, without
requiring GitHub Advanced Security write access. Dependabot covers npm, both uv
projects, the tile Dockerfile, Terraform providers, and GitHub Actions.

## Checks that remain manual or environment-specific

Automated axe checks find only a subset of accessibility defects. Release review
still requires keyboard-only operation, visible focus, 200% zoom/reflow, reduced
motion, non-colour status comprehension, and VoiceOver checks on representative
operations and field workflows.

OWASP ZAP against the deployed WAF/OIDC surface, authenticated authorization
testing, k6 performance acceptance, container-image scanning by immutable image
digest, a deployed malware-scanner outage drill, production restore exercises,
and cloud configuration review are not represented as passing local gates. Unit
and HTTP integration tests do cover fail-closed scanner unavailability,
quarantine retention, and the deterministic request-path latency thresholds,
but the environment exercises require a deployed, authorized system and are
release evidence, not mocked CI claims.
