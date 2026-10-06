# Open-source stack

The runtime and local infrastructure use open-source components, so a state or
municipal deployment does not depend on a proprietary cloud service. Licences
below are the upstream projects' own; confirm the licence of the exact version
you deploy.

## In the repository

| Layer | Component | Licence | Status |
| --- | --- | --- | --- |
| API | FastAPI, Pydantic, SQLAlchemy, Alembic | MIT | Used by `services/backend` |
| Web | React, Vite, TanStack Router/Query, Tailwind CSS | MIT | Used by both web apps |
| Offline storage | Dexie (IndexedDB) | Apache-2.0 | Field PWA encrypted queue |
| Maps | MapLibre GL JS | BSD-3-Clause | `packages/map`, no hosted tile dependency |
| Map data | OpenStreetMap | ODbL 1.0 | Packaged Chennai road baseline with attribution |
| Database | PostgreSQL + PostGIS + pgRouting | PostgreSQL / GPL-2.0-or-later | Compose service; the demo path uses SQLite |
| Cache and fan-out | Valkey | BSD-3-Clause | Compose service, replaces Redis; not yet used by the request path |
| Object storage | MinIO | AGPL-3.0 | Compose service; media adapter not yet wired |
| Identity | Keycloak | Apache-2.0 | Compose profile `identity` with an importable realm; backend reads `realm_access.roles` |
| Malware scanning | ClamAV | GPL-2.0 | Compose profile `scanner`; backend `ClamAVScanner` enabled by `FLOODRISE_CLAMAV_HOST` |
| Alert interchange | CAP 1.2 (OASIS open standard) | Open standard | `GET /api/v1/alerts/{id}/cap` |
| Observability | Prometheus, OpenTelemetry Collector | Apache-2.0 | Compose profile `observability` |
| Observability | Grafana, Loki | AGPL-3.0 | Compose profile `observability` |
| AWS emulation | LocalStack community | Apache-2.0 | Compose service for the optional AWS target |
| Test sink | MockServer | Apache-2.0 | Isolated demo alert sink |

Run the optional services with:

```bash
docker compose -f infra/compose.yaml --profile identity --profile scanner up -d
```

### Keycloak

`infra/keycloak/floodrise-realm.json` defines the `floodrise` realm, the eight
floodRISE realm roles, and a public PKCE client that adds the `floodrise-api`
audience. It contains no users or secrets. Point the backend at it with:

```bash
FLOODRISE_OIDC_ISSUER=http://localhost:8081/realms/floodrise
FLOODRISE_OIDC_JWKS_URL=http://localhost:8081/realms/floodrise/protocol/openid-connect/certs
```

Staging and production settings still require HTTPS for both URLs. The web apps
do not implement the login redirect yet, and the high-impact approval checks
(MFA, phishing-resistant factor, recent step-up) need matching Keycloak
authentication flows and claim mappers that the realm file does not configure.

### ClamAV

Set `FLOODRISE_CLAMAV_HOST` (and optionally `FLOODRISE_CLAMAV_PORT`) outside demo
mode to scan uploads through clamd's `INSTREAM` protocol. Only an explicit `OK`
is treated as clean; a timeout, connection failure, or unrecognized reply keeps
the upload quarantined. The adapter is covered by unit tests against a protocol
stub; it has not been run against a live clamd in this repository. The Compose
service joins a second network so `freshclam` can download signatures.

## Open alternatives for the AWS target

`infra/terraform` remains an un-applied AWS Mumbai scaffold. Each managed service
has an open-source equivalent; only the first four are present in Compose.

| AWS service | Open-source alternative | State here |
| --- | --- | --- |
| Cognito | Keycloak | Compose profile and realm |
| ElastiCache for Redis | Valkey | Compose service |
| S3 | MinIO | Compose service |
| RDS PostgreSQL | PostgreSQL + PostGIS + pgRouting | Compose service |
| SQS | Valkey streams or RabbitMQ | Not implemented |
| CloudFront + WAF | Caddy or nginx with Coraza | Not implemented |
| KMS + Secrets Manager | OpenBao | Not implemented |
| ECS Fargate | Kubernetes or Nomad | Not implemented |
| Terraform CLI | OpenTofu (MPL-2.0) | HCL not validated with OpenTofu |

A production raster path still needs a locked-down COG service such as TiTiler
(MIT); see [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md).
