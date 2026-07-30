# floodRISE backend

FastAPI modular monolith for the deterministic Kerala flood-response MVP. The
default profile uses SQLite, packaged fixtures, a fixed scenario clock, and a
synthetic notification state. Approval records may say `DISPATCHED` and name
`fake://notification-sink`, but the backend does not call that sink or any real
notification destination.

## Run locally

```bash
uv sync
uv run alembic upgrade head
uv run uvicorn app.main:app --reload --port 8787
```

OpenAPI is available at `http://127.0.0.1:8787/docs`. Reset the replay with:

```bash
curl -fsS -X POST \
  -H 'Idempotency-Key: manual-demo-reset-001' \
  -H 'X-Demo-User: demo-runbook-reset' \
  -H 'X-Demo-Role: identity_administrator' \
  http://127.0.0.1:8787/api/v1/demo/reset
```

Prefer `ops/scripts/demo-reset.sh`: it verifies loopback scope and demo health,
then directs the operator to clear each Field PWA browser profile explicitly.

Demo/test staff authorization uses `X-Demo-User` and `X-Demo-Role`. Supported
roles are reporter, responder, verifier, engineer, shelter manager, incident
commander, auditor, and identity administrator. The API rejects these headers
in development, staging, and production.

Staging and production fail at startup unless demo mode is disabled and a
non-default hardening secret, HTTPS OIDC issuer, audience, and JWKS source are
configured. Requests then require a signed bearer token. The verifier pins the
allowed algorithms, validates signature/issuer/expiry/audience, supports
Cognito access-token `client_id`, refreshes unknown signing keys once, and maps
only allow-listed roles from `cognito:groups`, `roles`, or `custom:roles`.
Static JWKS JSON is supported for isolated tests; production should use the
issuer's HTTPS JWKS endpoint.

When Firebase App Check is enabled, a separate verifier also requires a valid
`X-Firebase-AppCheck` token for every API mutation and the SSE handshake. It
pins Firebase's RS256/JWT contract, project number, audience, expiry, and
allow-listed web app IDs. App Check is only an application-integrity signal: it
never grants a user identity, role, or approval authority, and OIDC remains
mandatory.

This is currently a bearer-token resource-server boundary. The web clients do
not implement authorization-code/PKCE, token exchange/refresh, logout, or a
secure HttpOnly session, and the API does not mint a session cookie. The
`FLOODRISE_SESSION_SECRET` startup check prevents a demo default from reaching a
deployed profile; it is not evidence that server-side sessions exist.

```bash
FLOODRISE_ENV=production
FLOODRISE_DEMO_MODE=false
FLOODRISE_DATABASE_URL=postgresql+psycopg://.../floodrise?sslmode=require
FLOODRISE_DATABASE_ALLOWED_HOST=PRIVATE_DATABASE_HOST
FLOODRISE_OIDC_ISSUER=https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_POOL_ID
FLOODRISE_OIDC_AUDIENCE=COGNITO_APP_CLIENT_ID
FLOODRISE_OIDC_JWKS_URL=https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_POOL_ID/.well-known/jwks.json
FLOODRISE_SESSION_SECRET=LOAD_FROM_SECRETS_MANAGER
```

Approval decisions additionally require MFA, a phishing-resistant method
(`webauthn`/FIDO/hardware-key by default), an accepted step-up `acr` or explicit
step-up claim, and an `auth_time` no more than five minutes old. The non-secret
authentication evidence is bound into the approval audit record. Cognito token
customization must emit the configured `amr`/`acr` or custom evidence claims;
absence fails closed. Identity-administrator tokens cannot also carry an
operational role.

Staging and production fail startup unless `FLOODRISE_DATABASE_URL` uses
PostgreSQL, sets `sslmode=require`, `verify-ca`, or `verify-full`, and its parsed
hostname exactly matches `FLOODRISE_DATABASE_ALLOWED_HOST`. Mutations store
versioned documents and atomically append hash-chained audit and durable outbox
records.

## Safety contract

- Four eligible independent evidence families, including two trusted or
  authenticated families, can create only a `COMMUNITY_CORROBORATED` signal.
- The public wording remains: “Corroborated by 4 independent recent reports;
  not an official confirmation.”
- Road or shelter closures, evacuation instructions, official warnings, and
  all-clear messages require a requester and a different authorized approver.
- A production approval decision also requires recent phishing-resistant
  step-up MFA; ordinary login or TOTP alone does not satisfy that boundary.
- Route responses say “lower-risk,” carry evidence/model versions and an
  expiry, and never claim that a route is safe.
- Demo photo bytes enter quarantine first. After the explicit simulated
  `DEMO_CLEAN` result, a sanitized derivative is kept in private process memory
  and the raw quarantine copy is removed; scanner-unavailable bytes remain
  quarantined. Report responses are redacted/generalized for non-identity-admin
  roles, but identity and evidence are not stored in separate databases in this
  MVP.

## Private evidence media

The field PWA requests an idempotent private upload grant, sends bytes into
quarantine with an exact type, size, and SHA-256 binding, then waits for a
terminal sanitized state before attaching the upload ID to a report. The demo
processor validates the decoded JPEG/PNG/WebP type, enforces byte and pixel
limits, strips EXIF/GPS by deterministic re-encoding, and perceptually groups
near-duplicates. It exposes metadata only; v1 has no public or byte-download
endpoint.

`DEMO_CLEAN` is an explicit simulated result, not malware detection, and is used
only while the API is visibly in demo mode. Clean and quarantined bytes are
process-local and disappear on restart; only upload metadata is persisted. A
non-demo runtime without an injected approved scanner defaults to `UNAVAILABLE`,
retains quarantine in the configured blob adapter, and blocks evidence
attachment. The in-memory adapter must be replaced by private object storage,
an approved scanner, and deployed retention/deletion jobs before non-demo media
is enabled.

`app.media_gcs.GCSPrivateMediaBlobStore` implements the private GCS side of that
boundary with immutable generation-bound objects, separate quarantine/clean
buckets, checksums, bounded multi-page retention sweeps, and no public URLs.
The terminal sanitized/rejected database transition also creates a durable
private raw-quarantine cleanup record. Deletion is generation-bound, attempted
after commit, and retried idempotently by completion replay or metadata polling;
a cleanup outage cannot turn an already committed terminal result into an
ambiguous failure. General expiry sweeps remain best-effort on user requests,
with bucket lifecycle as a maximum-retention fallback. The adapter remains
intentionally unselected until a production credential adapter and an
independently approved malware scanner are configured.

`/metrics` requires an authenticated `auditor`, `engineer`, or
`incident_commander` before database-backed gauges are refreshed.

`app.gcp_job` is the container command used by the Google Cloud simulation job.
`app.cloud_run_jobs` and `app.notifications` provide fail-closed, injected
Cloud Run Jobs and FCM HTTP v1 adapters. They do not bypass the transactional
outbox: live integration must use persistent deduplication and delivery-attempt
records, and an alert may be marked delivered only after provider acceptance.
The default demo continues to use only its token-free fake notification sink.

## Verify

```bash
uv run ruff check app tests migrations
uv run pytest
```
