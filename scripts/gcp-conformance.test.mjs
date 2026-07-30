import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

async function text(relativePath) {
  return readFile(resolve(repoRoot, relativePath), "utf8");
}

function includesEvery(source, values, label) {
  for (const value of values) {
    assert.ok(source.includes(value), `${label} is missing ${JSON.stringify(value)}`);
  }
}

test("Firebase Hosting preserves both products and isolates the API rewrite", async () => {
  const [
    configurationText,
    projectAliasesText,
    targetMapText,
    packageText,
    cloudAuthPackageText,
    deploymentGuard,
    buildMetadata,
  ] =
    await Promise.all([
      text("firebase.json"),
      text(".firebaserc.example"),
      text(".firebase-targets.example.json"),
      text("package.json"),
      text("packages/cloud-auth/package.json"),
      text("scripts/deploy-firebase-hosting.mjs"),
      text("scripts/firebase-build-metadata.mjs"),
    ]);
  const configuration = JSON.parse(configurationText);
  const projectAliases = JSON.parse(projectAliasesText);
  const targetMap = JSON.parse(targetMapText);
  const packageManifest = JSON.parse(packageText);
  const cloudAuthPackage = JSON.parse(cloudAuthPackageText);
  const hosting = configuration.hosting;
  assert.equal(
    cloudAuthPackage.dependencies.firebase,
    "12.16.0",
    "the CSP contract must stay pinned to the reviewed Firebase Web SDK",
  );

  assert.equal(hosting.public, "dist/firebase");
  assert.deepEqual(projectAliases.projects, {
    demo: "replace-with-floodrise-demo-project-id",
    live: "replace-with-floodrise-live-project-id",
  });
  assert.equal(targetMap.format, 1);
  assert.deepEqual(Object.keys(targetMap.targets), ["demo", "live"]);
  includesEvery(
    targetMapText,
    ["apiKey", "appCheckSiteKey", "authProviderId"],
    "Firebase reviewed target map",
  );
  assert.deepEqual(hosting.rewrites[0], {
    source: "/api/**",
    run: {
      serviceId: "floodrise-api",
      region: "asia-south1",
      pinTag: true,
    },
  });
  assert.deepEqual(
    hosting.rewrites.slice(1, 3),
    [
      { source: "/ops/**", destination: "/ops/index.html" },
      { source: "/field/**", destination: "/field/index.html" },
    ],
  );
  assert.ok(
    hosting.headers.some(
      (entry) =>
        entry.source === "/api/**"
        && entry.headers.some(
          (header) => header.key === "Cache-Control" && header.value === "private, no-store",
        ),
    ),
    "API responses must not be cached by Hosting",
  );
  assert.ok(
    hosting.headers.some(
      (entry) =>
        entry.source.includes("sw.js")
        && entry.headers.some(
          (header) =>
            header.key === "Service-Worker-Allowed" && header.value === "/field/",
        ),
    ),
    "Field service-worker scope must remain /field/",
  );
  includesEvery(
    JSON.stringify(packageManifest.scripts),
    [
      "firebase:assemble",
      "firebase:test",
      "firebase:emulate",
      "firebase:deploy:hosting",
      "firebase-tools@15.24.0",
    ],
    "Firebase package scripts",
  );
  includesEvery(
    deploymentGuard,
    [
      'const environments = ["demo", "live"]',
      '"--environment"',
      '"--project"',
      '"--confirm-target"',
      '"--execute"',
      '"--validate-only"',
      "firebase-tools@${FIREBASE_TOOLS_VERSION}",
      '"--only"',
      '"hosting"',
      "validateDeploymentArtifact",
      "revalidateDeploymentBoundary",
      "renderFirebaseConfig",
      ".firebase-targets.json",
    ],
    "Firebase deployment guard",
  );
  includesEvery(
    buildMetadata,
    [
      "floodrise-build-metadata.json",
      "VITE_DEPLOYMENT_ENVIRONMENT",
      "treeSha256",
      "VITE_FIREBASE_PROJECT_ID",
      "VITE_FIREBASE_APP_ID",
      "VITE_FIREBASE_AUTH_DOMAIN",
      "VITE_FIREBASE_API_KEY",
      "VITE_FIREBASE_APP_CHECK_SITE_KEY",
      "VITE_FIREBASE_AUTH_PROVIDER_ID",
      "publicConfigDigests",
    ],
    "Firebase build metadata",
  );
  const csp = hosting.headers
    .find(({ source }) => source === "**")
    .headers.find(({ key }) => key === "Content-Security-Policy").value;
  includesEvery(
    csp,
    [
      "https://content-firebaseappcheck.googleapis.com",
      "https://apis.google.com",
      "https://__FLOODRISE_AUTH_DOMAIN__",
      "frame-ancestors 'none'",
    ],
    "Firebase 12.16 CSP template",
  );
});

test("Google Cloud Terraform keeps demo and live isolated and fail closed", async () => {
  const paths = [
    "infra/gcp/versions.tf",
    "infra/gcp/providers.tf",
    "infra/gcp/variables.tf",
    "infra/gcp/locals.tf",
    "infra/gcp/services.tf",
    "infra/gcp/network.tf",
    "infra/gcp/kms.tf",
    "infra/gcp/storage.tf",
    "infra/gcp/database.tf",
    "infra/gcp/compute.tf",
    "infra/gcp/iam.tf",
    "infra/gcp/outputs.tf",
    "infra/gcp/backend.hcl.example",
    "infra/gcp/environments/demo.tfvars.example",
    "infra/gcp/environments/production.tfvars.example",
  ];
  const terraform = (await Promise.all(paths.map(text))).join("\n");

  includesEvery(
    terraform,
    [
      'api_service_name       = "floodrise-api"',
      'tile_service_name      = "floodrise-tile"',
      'simulation_job_name    = "floodrise-simulation"',
      '"asia-south1"',
      "google_cloud_run_v2_service",
      "google_cloud_run_v2_job",
      "google_sql_database_instance",
      "google_storage_bucket",
      "google_kms_crypto_key",
      "google_secret_manager_secret",
      "google_service_account",
      "google_service_networking_connection",
      "firebase_app_check_enabled",
      "runtime_config_ready",
      "demo_tile_artifacts_ack",
      "I_HAVE_REVIEWED_DEMO_TILE_ARTIFACTS",
      "api_service_enabled",
      "simulation_job_enabled",
      "tile_service_enabled",
      "PRIVATE_RANGES_ONLY",
      "deployment_boundary_ack",
      "@sha256:",
      "database_high_availability",
      "deletion_protection",
      "target_rpo_minutes",
      "target_rto_minutes",
    ],
    "Google Cloud Terraform",
  );
  includesEvery(
    terraform,
    [
      'var.notification_driver == "demo_log"',
      "!var.external_notifications_enabled",
      "!var.live_integrations_enabled",
      'var.environment == "production"',
      'var.notification_driver == "fcm"',
      'var.notification_activation_ack == "I_HAVE_AUTHORITY_AND_APPROVAL"',
    ],
    "notification activation guard",
  );
  assert.ok(
    !terraform.includes("BEGIN PRIVATE KEY"),
    "Terraform must not contain a service-account private key",
  );
  assert.ok(
    !terraform.includes('egress = "ALL_TRAFFIC"'),
    "direct VPC egress must not black-hole public identity/provider HTTPS without Cloud NAT",
  );
});

test("App Check is memory-only at the clients and fail-closed at the API", async () => {
  const [settings, verifier, main, fieldClient, operationsClient] = await Promise.all([
    text("services/backend/app/config.py"),
    text("services/backend/app/app_check.py"),
    text("services/backend/app/main.py"),
    text("apps/field-web/src/lib/cloud-security.ts"),
    text("apps/ops-web/src/lib/cloud-security.ts"),
  ]);
  const clients = `${fieldClient}\n${operationsClient}`;

  includesEvery(
    settings,
    [
      "firebase_app_check_enabled",
      "firebase_app_check_project_number",
      "firebase_app_check_app_ids",
      "https://firebaseappcheck.googleapis.com/v1/jwks",
      'default_factory=lambda: ["RS256"]',
      "le=21_600",
      "demo and test App Check verification requires a static JWKS",
    ],
    "App Check settings",
  );
  includesEvery(
    verifier,
    [
      'APP_CHECK_HEADER = "X-Firebase-AppCheck"',
      "MUTATING_METHODS",
      'request.method.upper() == "GET" and path == f"{prefix}/events"',
      '"typ"',
      '"aud"',
      '"iss"',
      "allowed_app_ids",
    ],
    "App Check verifier",
  );
  includesEvery(
    main,
    [
      "firebase_app_check_boundary",
      "app_check_openapi",
      "X-Firebase-AppCheck",
      "This verifies the calling app and does not grant",
      "a user identity or role.",
    ],
    "App Check API boundary",
  );
  includesEvery(
    clients,
    [
      "configureCloudSecurity",
      "cloudFetch",
      "X-Firebase-AppCheck",
      "allowedOrigins",
      'headers.delete(FIREBASE_APP_CHECK_HEADER)',
      'startsWith("x-demo-")',
      'headers.has("Idempotency-Key")',
      "forceRefresh",
    ],
    "in-memory client security boundary",
  );
  assert.ok(!clients.includes("localStorage"), "App Check or bearer tokens must not use localStorage");
  assert.ok(!clients.includes("sessionStorage"), "App Check or bearer tokens must not use sessionStorage");
});

test("FCM remains opt-in, idempotent, and impossible to activate in demo", async () => {
  const [notifications, settings] = await Promise.all([
    text("services/backend/app/notifications.py"),
    text("infra/gcp/locals.tf"),
  ]);

  includesEvery(
    notifications,
    [
      "FcmHttpV1NotificationGateway",
      "NotificationGatewayConfig",
      'self.environment != "production" or self.demo_mode',
      "external_delivery_enabled",
      "authority_activation_reference",
      "firebase_project_id",
      "if not target.opted_in",
      "DatabaseDeliveryDeduplicator",
      "self._deduplicator.claim(delivery_key)",
      "self._deduplicator.mark_send_boundary(delivery_key, attempt_id)",
      "DeliveryStatus.UNKNOWN_AFTER_SEND",
      "reconcile_authorized",
      "authorized reconciliation requires an unknown send",
      '"X-FloodRISE-Event-ID": envelope.event_id',
      '"X-FloodRISE-Idempotency-Key": delivery_key',
      '"idempotency_key": delivery_key',
      "FCM requires an injected persistent atomic delivery deduplicator",
      "FCM_DELIVERY_OUTCOME_UNKNOWN",
      "FCM external delivery is forbidden outside non-demo production",
    ],
    "FCM gateway",
  );
  includesEvery(
    settings,
    [
      'var.notification_driver == "demo_log"',
      "!var.external_notifications_enabled",
      'var.notification_driver == "fcm"',
      'var.environment == "production"',
    ],
    "Terraform FCM guard",
  );
});

test("Cloud Run jobs and private GCS adapters preserve bounded authoritative work", async () => {
  const [job, dispatcher, storage] = await Promise.all([
    text("services/backend/app/gcp_job.py"),
    text("services/backend/app/cloud_run_jobs.py"),
    text("services/backend/app/media_gcs.py"),
  ]);
  includesEvery(
    job,
    [
      'SUPPORTED_OPERATIONS = frozenset({"simulation"})',
      "FLOODRISE_JOB_EVENT_ID",
      "FLOODRISE_JOB_INCIDENT_ID",
      "FLOODRISE_JOB_TRIGGER",
      'auth_source="gcp_workload_identity"',
      "service.run_simulation",
      '"model_version"',
      '"evidence_version"',
      '"event_id"',
      '"is_simulated"',
    ],
    "Cloud Run Job entry point",
  );
  includesEvery(
    dispatcher,
    [
      'MUMBAI_REGION = "asia-south1"',
      'SIMULATION_JOB_NAME = "floodrise-simulation"',
      'SUPPORTED_OPERATIONS = frozenset({"simulation"})',
      '("production", "cloud_run")',
      '("demo", "demo_cloud_run")',
      "allowed_project_ids",
      "project_id is not in the deployment project allow-list",
      "command.outbox_event_id",
      '"X-FloodRISE-Idempotency-Key": command.outbox_event_id',
      "IDEMPOTENCY_STORE_UNAVAILABLE",
    ],
    "Cloud Run Jobs v2 dispatcher",
  );
  includesEvery(
    storage,
    [
      "GCSPrivateMediaBlobStore",
      "ifGenerationMatch",
      "quarantine and clean evidence must use separate buckets",
      '"cacheControl": "private, no-store, max-age=0"',
      '"floodrise-visibility": "PRIVATE"',
      "GCSBulkOperationRefused",
      "Bulk clearing of private evidence buckets is disabled",
      "max_retention",
      "cleanup_batch_size",
      "_GOOGLE_STORAGE_ENDPOINT",
    ],
    "private GCS media adapter",
  );
  assert.ok(!storage.includes("predefinedAcl"), "GCS adapter must not create object ACLs");
  assert.ok(!storage.includes("signed_url"), "GCS adapter must not create signed URLs");
});

test("GCP runtime credentials, transport, and job invocation stay workload-scoped", async () => {
  const [locals, iam, compute, database, configuration, dockerfile] = await Promise.all([
    text("infra/gcp/locals.tf"),
    text("infra/gcp/iam.tf"),
    text("infra/gcp/compute.tf"),
    text("infra/gcp/database.tf"),
    text("services/backend/app/config.py"),
    text("services/backend/Dockerfile"),
  ]);
  const apiService = compute.slice(
    compute.indexOf('resource "google_cloud_run_v2_service" "api"'),
    compute.indexOf('resource "google_cloud_run_v2_job" "simulation"'),
  );
  const simulationJob = compute.slice(
    compute.indexOf('resource "google_cloud_run_v2_job" "simulation"'),
    compute.indexOf("# Firebase Hosting invokes the API rewrite"),
  );
  const simulationSettings = configuration.slice(
    configuration.indexOf("class SimulationJobSettings"),
    configuration.indexOf("def get_settings()"),
  );

  includesEvery(
    locals,
    [
      '"api-database-url"',
      '"simulation-database-url"',
      '"session-secret"',
      "api_runtime_secrets",
      "simulation_runtime_secrets",
    ],
    "workload-specific secret sets",
  );
  includesEvery(
    iam,
    [
      'resource "google_cloud_run_v2_job_iam_member" "api_simulation_runner"',
      "google_cloud_run_v2_job.simulation[0].name",
      "local.api_simulation_dispatch_enabled",
      '"run.jobs.run"',
      '"run.jobs.runWithOverrides"',
    ],
    "job-scoped Cloud Run IAM",
  );
  assert.ok(
    !iam.includes('resource "google_project_iam_member" "api_simulation_runner"'),
    "the API must not receive project-wide Cloud Run job execution",
  );
  includesEvery(
    compute,
    [
      'var.environment == "production"',
      "api_service_enabled",
      "demo_model_runtime_ready",
      "simulation_job_enabled = local.demo_model_runtime_ready",
      "demo_tile_artifacts_ack",
      "local.api_simulation_dispatch_enabled ?",
      "local.api_tile_integration_enabled ?",
      'egress = "PRIVATE_RANGES_ONLY"',
    ],
    "fail-closed model-runtime and split-egress gates",
  );
  assert.ok(
    !compute.includes('egress = "ALL_TRAFFIC"'),
    "Cloud Run must retain managed public HTTPS egress unless a reviewed NAT path exists",
  );
  assert.ok(
    apiService.includes('runtime["api-database-url"]')
      && apiService.includes('runtime["session-secret"]'),
    "the API must receive its own database credential and session secret",
  );
  includesEvery(
    simulationJob,
    [
      'command = ["/opt/floodrise-venv/bin/python", "-m", "app.gcp_job"]',
      'runtime["simulation-database-url"]',
    ],
    "simulation job credential boundary",
  );
  assert.ok(
    !simulationJob.includes("FLOODRISE_SESSION_SECRET")
      && !simulationJob.includes('runtime["api-database-url"]'),
    "the simulation job must not receive API-only secret material",
  );
  assert.ok(
    simulationSettings.includes("database credential is independently")
      && simulationSettings.includes("provisioned and revocable")
      && !simulationSettings.includes("session_secret:")
      && !simulationSettings.includes("oidc_issuer:"),
    "simulation settings must not load API identity or pseudonymization secrets",
  );
  assert.ok(
    database.includes('ssl_mode                                      = "ENCRYPTED_ONLY"'),
    "Cloud SQL must explicitly reject unencrypted transport",
  );
  assert.ok(
    dockerfile.includes("UV_PROJECT_ENVIRONMENT=/opt/floodrise-venv"),
    "the fixed simulation command must target the image's managed Python environment",
  );
});

test("operator documentation preserves AWS and external activation boundaries", async () => {
  const [gcp, architecture, runbook, matrix] = await Promise.all([
    text("docs/GCP_FIREBASE_DEPLOYMENT.md"),
    text("docs/ARCHITECTURE.md"),
    text("docs/DEPLOYMENT_RUNBOOK.md"),
    text("docs/PLAN_EXECUTION_MATRIX.md"),
  ]);
  const documentation = `${gcp}\n${architecture}\n${runbook}\n${matrix}`;

  includesEvery(
    gcp,
    [
      "alternative to the AWS scaffold",
      "Do not reuse an unrelated existing Firebase project",
      "`dist/firebase/`",
      "`/ops/`",
      "`/field/`",
      "`__session`",
      "60-second",
      "Cloud Run Job",
      "remains synchronous",
      "not yet wired into a persisted API `202`",
      "CREATE EXTENSION IF NOT EXISTS postgis",
      "CREATE EXTENSION IF NOT EXISTS pgrouting",
      "phishing-resistant passkeys or security keys",
      "Firebase App Check",
      "FCM is opt-in",
      "fake://notification-sink",
      "external activation",
      "## Rollback",
      "## Recovery rehearsal",
    ],
    "Firebase/Google Cloud deployment guide",
  );
  includesEvery(
    architecture,
    [
      "AWS target production topology",
      "Firebase and Google Cloud target topology",
      "Cloud Armor is not on the checked-in",
      "Hosting rewrite path.",
      "not an implemented control",
      "The current",
      "demo `POST /simulations` remains synchronous",
      "have not been applied or deployed",
    ],
    "architecture boundary",
  );
  includesEvery(
    runbook,
    [
      "The AWS and Firebase/Google Cloud",
      "No Google Cloud plan/apply",
      "Firebase deploy is claimed",
      "fake://notification-sink",
      "adapters alone do not implement that integration",
    ],
    "deployment runbook boundary",
  );
  includesEvery(
    matrix,
    [
      "AWS Mumbai CloudFront",
      "Firebase Hosting for `/ops/` and `/field/`",
      "Google Cloud Mumbai-equivalent regional runtime",
      "no plan/apply is claimed",
    ],
    "plan execution matrix",
  );
  assert.ok(
    documentation.includes("Blaze billing")
      && documentation.includes("separate projects")
      && documentation.includes("domain"),
    "billing, project isolation, and domain activation must stay explicit",
  );
});

test("CI validates Google Cloud source without credentials or apply", async () => {
  const workflow = await text(".github/workflows/ci.yml");
  includesEvery(
    workflow,
    [
      "terraform -chdir=infra/gcp fmt -check -recursive",
      "terraform -chdir=infra/gcp init -backend=false -input=false",
      "terraform -chdir=infra/gcp validate",
      "node --test scripts/gcp-conformance.test.mjs",
    ],
    "CI Google Cloud validation",
  );
  assert.ok(!workflow.includes("terraform apply"), "CI must never apply Terraform");
  assert.ok(!workflow.includes("firebase deploy"), "CI must never deploy Firebase Hosting");
});
