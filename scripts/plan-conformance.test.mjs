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

test("the two planned products expose every competition workflow", async () => {
  const [operations, field] = await Promise.all([
    text("apps/ops-web/src/App.tsx"),
    text("apps/field-web/src/router.tsx"),
  ]);

  includesEvery(
    operations,
    ["/signals", "/incidents", "/evacuation", "/shelters", "/resilience", "/sources", "/audit"],
    "operations route contract",
  );
  includesEvery(
    field,
    ["/report", "/queue", "/alerts", "/lower-risk-route", "/receipt/$receiptId", "/demo-reset"],
    "field route contract",
  );
});

test("Kerala OpenStreetMap data and offline fallbacks remain versioned and visibly attributed", async () => {
  const [manifestText, mapSource, mapData, fixtureReadme] = await Promise.all([
    text("fixtures/kerala-demo/manifest.json"),
    text("packages/map/src/style.ts"),
    text("packages/map/src/data/kerala.ts"),
    text("fixtures/kerala-demo/README.md"),
  ]);
  const manifest = JSON.parse(manifestText);

  assert.equal(manifest.scenario_id, "demo-kerala-flood-v1");
  assert.equal(manifest.is_simulated, true);
  assert.equal(manifest.live_integrations_enabled, false);
  includesEvery(
    manifest.files.map((entry) => entry.path).join("\n"),
    ["osm-baseline.geojson", "osm-map-fallback.geojson", "rasters/manifest.json"],
    "Kerala fixture manifest",
  );
  includesEvery(mapSource, ["openstreetmap.org", "OpenStreetMap contributors"], "map source");
  includesEvery(mapData, ["osm-map-fallback.geojson", "not a certified flood depth"], "packaged map data");
  includesEvery(fixtureReadme, ["ODbL", "DEMO DATA", "offline"], "fixture provenance");
});

test("all planned roles are server enforced", async () => {
  const auth = await text("services/backend/app/auth.py");
  includesEvery(
    auth,
    [
      "reporter",
      "responder",
      "verifier",
      "engineer",
      "shelter_manager",
      "incident_commander",
      "auditor",
      "identity_administrator",
    ],
    "server role allow-list",
  );
  includesEvery(auth, ["phishing_resistant", "step_up_authenticated", "oidc_step_up_max_age_seconds"], "approval authentication boundary");
});

test("FloodSignal implements the published eligibility and corroboration rules", async () => {
  const [domain, schemas] = await Promise.all([
    text("services/backend/app/domain.py"),
    text("services/backend/app/schemas.py"),
  ]);
  includesEvery(
    domain,
    [
      "timedelta(minutes=45)",
      "timedelta(minutes=30)",
      "> 250",
      "<= 500",
      "len(families) >= 4",
      "trusted_families >= 2",
      "score >= 0.75",
      'state = "COMMUNITY_CORROBORATED"',
      '"route_recalculation_requested": state == "COMMUNITY_CORROBORATED"',
      "Corroborated by 4 independent recent reports; not an official confirmation.",
    ],
    "FloodSignal domain",
  );
  includesEvery(
    schemas,
    ["CANDIDATE", "CORROBORATING", "COMMUNITY_CORROBORATED", "NEEDS_REVIEW", "DISPUTED", "STALE", "EXPIRED", "RESOLVED"],
    "FloodSignal states",
  );
});

test("rapid impact modelling and routing retain their safety invariants", async () => {
  const [intelligence, routing] = await Promise.all([
    text("services/backend/app/intelligence.py"),
    text("services/backend/app/routing.py"),
  ]);
  includesEvery(
    intelligence,
    ["ENSEMBLE_SIZE: Final = 9", '("now", 0)', '("+30m", 30)', '("+1h", 60)', '("+3h", 180)', "maximum_absolute_adjustment_m", "RAPID_IMPACT_ESTIMATE"],
    "rapid impact model",
  );
  includesEvery(
    routing,
    ["p50_depth_m", "p90_depth_m", "P50_DEPTH_THRESHOLD", "P90_DEPTH_THRESHOLD", "BRIDGE_FLOOD_CONFIRMED", "NO_COMPLIANT_ROUTE", "max_alternatives"],
    "routing engine",
  );
});

test("offline field evidence remains encrypted, bounded, expiring and idempotent", async () => {
  const [database, sync, api, routePage] = await Promise.all([
    text("apps/field-web/src/lib/db.ts"),
    text("apps/field-web/src/lib/sync.ts"),
    text("apps/field-web/src/lib/api.ts"),
    text("apps/field-web/src/pages/LowerRiskRoutePage.tsx"),
  ]);
  includesEvery(
    database,
    ["QUEUE_LIMIT_ITEMS = 100", "100 * 1024 * 1024", "24 * 60 * 60 * 1000", "AES-GCM", "ciphertext"],
    "offline queue",
  );
  includesEvery(sync, ["purgeExpiredReports", "submitReport", "shouldRetrySubmission"], "offline synchronization");
  includesEvery(api, ["Idempotency-Key", "client_report_id"], "idempotent field API");
  includesEvery(routePage, ["Fresh route guidance unavailable offline", "must not be treated as safe", "Lower-risk route"], "offline route safety state");
});

test("private media processing is quarantine first and privacy preserving", async () => {
  const media = await text("services/backend/app/media.py");
  includesEvery(
    media,
    [
      "put_quarantine",
      "MEDIA_SCANNER_UNAVAILABLE",
      "ImageOps.exif_transpose",
      "normalized_sha256",
      "perceptual_hash",
      "DUPLICATE_PRIVATE",
      '"visibility": "PRIVATE"',
      '"public_url": None',
    ],
    "media pipeline",
  );
});

test("the public API retains the complete versioned contract", async () => {
  const specification = JSON.parse(await text("packages/api-client/openapi.json"));
  const paths = Object.keys(specification.paths);
  const requiredPaths = [
    "/api/v1/incidents/{incident_id}/bootstrap",
    "/api/v1/sources/status",
    "/api/v1/reports",
    "/api/v1/media/uploads",
    "/api/v1/signals",
    "/api/v1/signals/{signal_id}/decisions",
    "/api/v1/simulations",
    "/api/v1/impacts",
    "/api/v1/routes/recommend",
    "/api/v1/shelters/{shelter_id}",
    "/api/v1/approvals/{approval_id}/decisions",
    "/api/v1/resilience/audits",
    "/api/v1/audit/export",
    "/api/v1/events",
  ];

  assert.equal(paths.length, 33);
  for (const path of requiredPaths) assert.ok(paths.includes(path), `OpenAPI is missing ${path}`);
  assert.ok(specification.components.schemas.ProblemDetails, "RFC 9457 ProblemDetails schema is missing");
});

test("audit, optimistic concurrency and persisted SSE replay remain authoritative", async () => {
  const [database, main] = await Promise.all([
    text("services/backend/app/database.py"),
    text("services/backend/app/main.py"),
  ]);
  includesEvery(database, ["previous_hash", "event_hash", "outbox_events", "supersedes_event_id", "verify_audit_chain"], "audit repository");
  includesEvery(main, ["Last-Event-ID", "expected_version", "text/event-stream", "Idempotency-Key"], "HTTP concurrency and SSE contract");
});

test("AWS and local infrastructure retain every planned service and safety guard", async () => {
  const [root, compute, data, identity, edge, compose, migration, worker, dockerfile] = await Promise.all([
    text("infra/terraform/main.tf"),
    text("infra/terraform/modules/compute/main.tf"),
    text("infra/terraform/modules/data/main.tf"),
    text("infra/terraform/modules/identity/main.tf"),
    text("infra/terraform/modules/edge/main.tf"),
    text("infra/compose.yaml"),
    text("services/backend/migrations/versions/0002_postgis_operational_schema.py"),
    text("services/backend/app/worker.py"),
    text("services/backend/Dockerfile"),
  ]);
  includesEvery(root, ["ap-south-1", "multi_az", "cross_region_backup_enabled", "target_rpo_minutes", "target_rto_minutes"], "Terraform root guard");
  includesEvery(compute, ["aws_ecs_task_definition", "app.worker:celery_app", "FLOODRISE_JOBS_QUEUE_URL", "assign_public_ip = false"], "ECS compute");
  includesEvery(data, ["aws_db_instance", "aws_s3_bucket", "aws_sqs_queue", "aws_kms_key", "aws_secretsmanager_secret", "aws_backup_plan"], "AWS data services");
  includesEvery(identity, ["aws_cognito_user_pool", 'allowed_oauth_flows                  = ["code"]', "WEB_AUTHN", "web_authn_configuration"], "Cognito identity");
  includesEvery(edge, ["aws_cloudfront_distribution", "aws_wafv2_web_acl", "aws_cloudfront_origin_access_control"], "edge services");
  includesEvery(compose, ["postgis", "redis", "minio", "localstack", "internal: true", "fake://notification-sink"], "local Compose");
  includesEvery(migration, ["postgis", "pgrouting", "pgcrypto", "btree_gist", "normalized_source_records", "route_edges"], "PostGIS migration");
  includesEvery(worker, ["sqs://", "predefined_queues", "floodrise.simulation.run", "floodrise.routes.recalculate"], "Celery worker");
  includesEvery(dockerfile, ["USER floodrise", "uv sync --frozen --no-dev", "uvicorn", "8787"], "backend container");
});

test("acceptance journeys cover the judging-critical plan", async () => {
  const tests = await Promise.all([
    text("tests/e2e/api-replay.spec.ts"),
    text("tests/e2e/field.spec.ts"),
    text("tests/e2e/navigation.spec.ts"),
    text("tests/e2e/operations.spec.ts"),
    text("tests/e2e/accessibility.spec.ts"),
    text("services/backend/tests/test_performance_acceptance.py"),
  ]);
  const suite = tests.join("\n");
  includesEvery(
    suite,
    [
      "four independent reports",
      "toBeLessThan(5_000)",
      "stores an offline report",
      "photo evidence reaches a private sanitized state",
      "all operations routes",
      "all field workflows",
      "completes an evidence review",
      "distinct authorized reviewer",
      "WCAG AA smoke scan",
      "report_p95 <= 2.0",
      "fourth_report_elapsed <= 5.0",
      "route_p95 <= 0.750",
      "simulation_p95 <= 60.0",
    ],
    "Playwright acceptance suite",
  );
});

test("external activation boundaries cannot be silently presented as completed", async () => {
  const status = await text("docs/IMPLEMENTATION_STATUS.md");
  includesEvery(
    status,
    [
      "Live-provider and cloud",
      "activation remain subject to authority",
      "fake://notification-sink",
      "no sink or",
      "certified depth output",
      "AWS plan or apply",
      "VoiceOver",
      "ZAP",
      "k6",
    ],
    "honest activation boundary",
  );
});
