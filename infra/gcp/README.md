# Google Cloud and Firebase deployment target

This directory is a separate, un-applied deployment target for floodRISE. It
does not replace the AWS scaffold in `infra/terraform`, and its presence is not
evidence that any Google Cloud control, restore objective, authority feed, or
notification destination is live.

The target uses one Google Cloud/Firebase project per environment. Within each
project, canonical service names keep the checked-in Firebase Hosting rewrite
stable:

- Firebase Hosting serves the assembled `/ops` and `/field` applications.
  `/api/**` rewrites to `floodrise-api` only in the separately activated,
  protected production runtime. The default demo remains static Hosting plus
  local packaged fixtures; Terraform creates no public remote demo API.
- `floodrise-api` is production-only and uses a dedicated service account,
  private Cloud SQL, its own database credential, narrowly scoped non-model
  bucket permissions, and Secret Manager. It receives no simulation-job target,
  tile URL, job-execution role, or model-bucket read grant while the live model
  is unavailable.
- `floodrise-tile` is an optional, internal-ingress, deterministic-demo-only
  Cloud Run service. It is omitted until a ready demo runtime has reviewed
  packaged-PGM objects in the model bucket and supplies the exact artifact
  acknowledgement. Production is disabled because the current tile API does
  not implement the required COG pipeline.
- `floodrise-simulation` is a deterministic-demo-only Cloud Run Job using the reviewed command
  `/opt/floodrise-venv/bin/python -m app.gcp_job`. Its identity can read only
  the independently revocable simulation database secret, connect to the
  database, and write model artifacts. It cannot read the API database
  credential or API pseudonymization secret. Production never creates this Job:
  the application intentionally returns `LIVE_MODEL_UNAVAILABLE` for live
  incidents until an approved live model adapter exists.
- PostgreSQL 16 uses private service networking, CMEK, SSD automatic growth,
  server-enforced encrypted transport, automated backups, and point-in-time
  recovery. Production guards require regional high availability, 35 retained
  backups, seven days of transaction logs, the Asia backup location, deletion
  protection, RPO at most five minutes, and RTO at most thirty minutes.
- Quarantine, sanitized photo, model, export, and audit buckets are private,
  enforce uniform access and public-access prevention, use CMEK, and have
  data-class lifecycle rules. The short-lived quarantine and sanitized-photo
  buckets disable versioning, soft delete, and minimum bucket retention so
  prompt application deletion remains possible; eight-day and 31-day age
  lifecycle rules are their maximum-retention fallback. Model, export, and
  audit buckets retain explicit versioning, seven-day soft-delete recovery, and
  their existing minimum-retention policies. Accepted evidence records and
  identity linkage remain in PostgreSQL for one year. Retention policies are
  not irreversibly locked by Terraform; locking them requires a separate legal
  and records-authority decision.
- Firebase, Identity Platform, App Check, Artifact Registry, Cloud Run, Cloud
  SQL, Storage, KMS, Secret Manager, and required networking APIs are enabled.
  Identity Platform is initialized without anonymous sign-in. Upstream staff
  OIDC configuration and phishing-resistant MFA policy remain authority-owned.

## Safety boundary

Demo and production must use different projects, credentials, hosting sites,
storage names, notification gateways, and remote-state prefixes. Every plan
requires `deployment_boundary_ack = "PROJECT_ID:ENVIRONMENT"`. Project IDs that
visibly contradict the selected environment are rejected.

All runtime images must be from this project's `asia-south1` Artifact Registry
and include a lowercase SHA-256 digest. Mutable tags are rejected before plan,
and the repository itself enforces immutable tags.

Demo is hard-guarded to `demo_log`, with external notifications and live source
adapters disabled. Staging is also fail-closed. FCM permission can only be added
in production when all three controls are explicit:

```hcl
notification_driver            = "fcm"
external_notifications_enabled = true
notification_activation_ack    = "I_HAVE_AUTHORITY_AND_APPROVAL"
```

That acknowledgement is necessary but not sufficient: the two-person approval
workflow, audience binding, opt-in records, delivery deduplication, and a
non-production destination rehearsal must still be reviewed before activation.
FCM permission is granted only to the dedicated notification service account.
The API, simulation, and tile identities cannot send FCM or impersonate that
identity. This scaffold intentionally creates no notification runtime; an
authority-reviewed dispatcher and transactional-outbox consumer must be added
and rehearsed before `external_notifications_enabled` can represent a working
delivery path.

`runtime_config_ready = false` creates no Cloud Run API, simulation Job, or tile
service in any environment. In demo, even a ready persistent database enables
only the private deterministic simulation Job. The tile service additionally
requires:

```hcl
demo_tile_artifacts_ack = "I_HAVE_REVIEWED_DEMO_TILE_ARTIFACTS"
tile_image              = "asia-south1-docker.pkg.dev/DEMO_PROJECT/floodrise-containers/floodrise-tile@sha256:..."
```

Set that acknowledgement only after the packaged-PGM manifest and every
referenced object have been uploaded and reviewed in the isolated demo model
bucket. It cannot enable staging or production. A future public remote demo API
would require a persistent database, protected OIDC and App Check, disabled
demo-role headers, explicit shared/single-instance state semantics, and a new
security review; this Terraform intentionally omits it.

The Hosting rewrite reaches Cloud Run without a Google caller identity.
The production `floodrise-api` is therefore publicly invokable, while FastAPI still enforces
App Check for production browser traffic, OIDC/role authorization for staff
actions, idempotency, approval separation, and audit persistence. This request
path is **not protected by Cloud Armor**. A future custom API domain behind an
external Application Load Balancer can add Cloud Armor, but that is a different
request path requiring DNS, certificates, CORS, and Hosting/client changes. This
scaffold intentionally does not create or claim an unattached policy.

The current Hosting path sends its short-lived staff bearer token through the
in-memory authorization transport and does not require an application cookie.
Firebase Hosting forwards only the `__session` cookie name; if a future BFF
replaces bearer transport with a cookie session, it must use `__session`, add
CSRF protection, and receive a separate security review.

## Secret and database activation

Terraform creates empty, regional, CMEK Secret Manager envelopes and never
stores secret payloads. The first approved production apply must use
`deployment_phase = "foundation"` and `runtime_config_ready = false`; it creates
the durable dependencies and intentionally omits every Cloud Run runtime. After
that foundation exists, an authorized operator must:

1. Create an independently revocable PostgreSQL API login for production and
   put its `postgresql+psycopg://.../floodrise?sslmode=require` URL in
   `api-database-url`. A separately activated deterministic demo model Job uses
   its own login and `simulation-database-url`; production grants no simulation
   identity or secret access. Every URL must use the exact private Cloud SQL
   address injected as `FLOODRISE_DATABASE_ALLOWED_HOST`; each runtime rejects a
   different parsed hostname. The server also enforces `ENCRYPTED_ONLY`, and the
   explicit client option prevents a future topology change from weakening
   transport.
2. Put a strong, independently generated application value in
   `session-secret`. Only the API service account can read this
   pseudonymization key. Never put any secret value in HCL, tfvars, CI
   variables, plan output, or Git history.
3. Connect using an approved database-owner bootstrap path and install the
   extensions required by the checked-in schema:

   ```sql
   CREATE EXTENSION IF NOT EXISTS postgis;
   CREATE EXTENSION IF NOT EXISTS pgrouting;
   CREATE EXTENSION IF NOT EXISTS pgcrypto;
   CREATE EXTENSION IF NOT EXISTS btree_gist;
   ```

4. Run Alembic, verify the normalized-source, routing, approval and hash-chained
   audit tables, seed only the matching environment, and perform a rollback
   rehearsal before enabling application traffic. Inspect the redacted grants,
   RLS policies, ownership, and default privileges for both logins. The current
   generic `entities` table mixes record kinds, so independent credentials
   provide separate rotation and revocation but do not by themselves prove
   kind-level SQL isolation; an approved RLS policy or dedicated publication
   boundary is required before claiming that stronger property.
5. Register the two Firebase web applications, configure App Check providers,
   and place their exact app IDs in `firebase_app_check_app_ids`. Production
   refuses to plan without App Check and at least one app ID.

The browser may use an authority's generic OIDC provider through Identity
Platform, but the API verifies the resulting Firebase ID token. Production
therefore binds `oidc_issuer` to
`https://securetoken.google.com/PROJECT_ID`, `oidc_audience` to the exact
project ID, and `oidc_jwks_url` to
`https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com`.

Only after those steps pass should a second reviewed plan set
`deployment_phase = "runtime"` and `runtime_config_ready = true`. This avoids a
broken first revision referencing the `latest` version of a newly created but
still-empty secret.

Cloud SQL supports these extensions, but Terraform cannot safely create them
without placing a database-owner credential in state. The extension and
migration steps therefore remain deliberate, audited activation work.

Production deliberately has no simulation Job or API job-execution role. The
live domain path remains fail-closed with `LIVE_MODEL_UNAVAILABLE`; adding
production COG generation, hydraulic validation, result publication, or job
dispatch is a separate reviewed implementation, not a Terraform switch.

All Cloud Run VPC attachments use `PRIVATE_RANGES_ONLY`. Cloud SQL and other
private ranges traverse the direct VPC path, while OIDC, App Check, approved
HTTPS feeds, and Google APIs retain Cloud Run managed public egress. Using
`ALL_TRAFFIC` without Cloud NAT would make those identity and provider paths
unreachable; adding restricted NAT instead would require a separate egress
policy and cost review.

## Validate without cloud changes

```bash
terraform -chdir=infra/gcp fmt -check -recursive
terraform -chdir=infra/gcp init -backend=false
terraform -chdir=infra/gcp validate
```

Provider initialization downloads plugins but creates no resources. Validation
does not prove that project policy allows public Cloud Run invocation, that
billing is enabled, that Firebase is on the required billing plan, or that
images and secret versions exist.

## Reviewed planning workflow

1. Create or select the dedicated environment project and confirm the active
   `gcloud` account, project number, organization policy, and `asia-south1`
   region. Do not reuse the demo project for production.
2. For production, build and scan only the API image and publish its immutable
   digest. Tile and simulation images are accepted only by the separately
   reviewed deterministic demo gates.
3. Copy the matching example tfvars and `backend.hcl.example` outside the
   repository. Use a separately protected state prefix for each environment.
4. Initialize and plan only:

   ```bash
   terraform -chdir=infra/gcp init -backend-config=/secure/path/backend.hcl
   terraform -chdir=infra/gcp plan \
     -var-file=/secure/path/production.tfvars \
     -out=/secure/path/floodrise-gcp.tfplan
   ```

5. Have a different authorized operator review the plan, IAM diff, bucket
   retention, public API boundary, identity setup, and cost estimate. This
   repository intentionally provides no automatic apply.
6. Apply the approved foundation plan, populate secret versions, install
   extensions, run migrations, and register Firebase apps/App Check. Then
   produce and separately review the runtime plan before the public production
   API is created. Production creates no model Job or tile service.
7. Build the Hosting artifact and rehearse the deterministic demo before any
   production activation.

The demo-only Cloud Run Job is intentionally not scheduled by Terraform. The
competition replay remains a local deterministic workflow for its five-second
acceptance target. After a ready private demo model runtime is separately
reviewed, authorized asynchronous execution is explicit:

```bash
gcloud run jobs execute floodrise-simulation \
  --project=DEMO_PROJECT_ID \
  --region=asia-south1 \
  --update-env-vars=FLOODRISE_JOB_EVENT_ID=evt-00000000-0000-4000-8000-000000000000,FLOODRISE_JOB_INCIDENT_ID=INCIDENT_ID,FLOODRISE_JOB_TRIGGER=AUTHORIZED_TRIGGER \
  --wait
```

`FLOODRISE_JOB_EVENT_ID` must be the persisted transactional-outbox event ID in
canonical `evt-UUID` form. The job rejects manual or scheduled executions that
lack that authoritative correlation key, and its bounded receipt includes the
same ID. Do not run this command against production; no production Job exists.

Production RPO/RTO values are guarded declarations, not measured evidence.
Quarterly restore drills, a documented cross-project recovery procedure,
security testing, performance testing, accessibility validation, and hydraulic
model certification remain required external evidence.
