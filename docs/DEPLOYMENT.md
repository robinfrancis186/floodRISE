# Deploy floodRISE

## Vercel web release

Run `pnpm install --frozen-lockfile`, `pnpm build:release`, then
`vercel --prod --yes`. Operations runs at `/`; the field PWA runs at `/field/`.
`vercel.json` supplies route fallbacks and security headers. The field service
worker only owns `/field/`, prompts before updating, and disables API runtime
caching in a protected build. Demo builds preserve clearly labeled fallback
views, queue reports when the API is unavailable, and withhold unverified routes.

## Protected browser configuration

Configure these public build values in Vercel, then rebuild:

```dotenv
VITE_DEMO_MODE=false
VITE_API_ROOT=https://YOUR_API/api/v1
VITE_OIDC_AUTHORITY=https://YOUR_IDENTITY_PROVIDER/realms/floodrise
VITE_OIDC_CLIENT_ID=YOUR_PUBLIC_CLIENT_ID
VITE_OIDC_SCOPE=openid profile
```

Use an OIDC public client with authorization code and PKCE. Allow redirect and
post-logout URLs `https://floodrise.vercel.app/` and
`https://floodrise.vercel.app/field/`; allow this origin for token endpoint CORS.
Client secrets belong on the server, never in `VITE_*`. Protected builds reject
missing/unsafe API and identity configuration. Browser tokens stay in memory,
permissions come from `/auth/me`, and expiration removes the protected UI.
Reporter queues use separate IndexedDB databases for each verified subject.

## Backend activation

Vercel currently hosts static web products, not the FastAPI/ClamAV/database
services. Deploy `services/backend/Dockerfile` to a persistent service host.
`infra/compose.yaml --profile api` runs the local demo API and dependencies;
it is not a production cloud deployment.

The production API requires these server settings:

```dotenv
FLOODRISE_ENV=production
FLOODRISE_DEMO_MODE=false
FLOODRISE_DATABASE_URL=postgresql+psycopg://YOUR_DATABASE
FLOODRISE_ALLOWED_ORIGINS=https://floodrise.vercel.app
FLOODRISE_OIDC_ISSUER=https://YOUR_IDENTITY_PROVIDER/realms/floodrise
FLOODRISE_OIDC_AUDIENCE=YOUR_PUBLIC_CLIENT_ID
FLOODRISE_SESSION_SECRET=LOAD_FROM_SECRET_STORE
FLOODRISE_MEDIA_STORE=s3
FLOODRISE_OBJECT_STORE_ENDPOINT=https://s3.ap-south-1.amazonaws.com
FLOODRISE_OBJECT_STORE_BUCKET=YOUR_PRIVATE_BUCKET
FLOODRISE_CLAMAV_HOST=YOUR_INTERNAL_SCANNER
```

`FLOODRISE_DATABASE_URL` may use any of `postgres://`, `postgresql://`,
`postgresql+asyncpg://`, or `postgresql+psycopg://`; all are run on the bundled
psycopg 3 driver. The image's Python version must match
`services/backend/.python-version`.

Block bucket public access and grant the backend identity only required object
read/write/delete permissions for `media/`. The SDK uses platform IAM or standard
AWS credentials from server secrets; every stored object requests AES256
server-side encryption. No evidence download endpoint is public. Verify access
policy, scanner behavior, and evidence survival across process restart on the
actual services; local protocol tests do not prove hosted persistence.

Production startup refuses empty or replay databases. Live incident import,
source ingestion, operational routing, and notification dispatch still require
implementation and approved data; browser field workflows currently target the
Chennai demo incident. Do not enable production against the replay database.
Map OSM tiles show geographic detail, not validated flood or road conditions.
Kerala facility data is a geographic baseline; it does not activate Kerala
incidents, reporting, routing, or relief camps. The field PWA caches a downloaded
facility snapshot after its first successful load, separately from street tiles.
The public OSM tile service has usage limits; use a compliant hosted/self-hosted
OSM renderer for sustained operational traffic. See `packages/map/README.md`.

Before activation, rehearse two independent approval users, phishing-resistant
recent step-up, offline report resubmission, scanner outage, database/object
restore, and alert delivery to an authorized test destination. Configuration
alone does not make this deterministic MVP an emergency authority system.
