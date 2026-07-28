import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

async function text(relativePath) {
  return readFile(resolve(repoRoot, relativePath), "utf8");
}

function includesEvery(source, values, label) {
  for (const value of values) {
    assert.ok(source.includes(value), `${label} is missing ${JSON.stringify(value)}`);
  }
}

test("all GitHub Actions are pinned to immutable full commit SHAs", async () => {
  const workflows = await Promise.all([
    text(".github/workflows/ci.yml"),
    text(".github/workflows/security.yml"),
  ]);
  const uses = workflows
    .flatMap((workflow) => workflow.split("\n"))
    .map((line) => line.match(/^\s*(?:-\s+)?uses:\s+([^#\s]+)(?:\s+#.*)?$/)?.[1])
    .filter(Boolean);

  assert.ok(uses.length > 0, "expected at least one GitHub Action reference");
  for (const action of uses) {
    assert.match(
      action,
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?@[0-9a-f]{40}$/,
      `${action} is not pinned to a full lowercase commit SHA`,
    );
  }
});

test("CodeQL SARIF findings are enforced without requiring private-repository GHAS", async () => {
  const workflow = await text(".github/workflows/security.yml");

  includesEvery(
    workflow,
    [
      "upload: never",
      "output: codeql-results/${{ matrix.language }}",
      "node scripts/check-sarif.mjs codeql-results/${{ matrix.language }} 7",
      "if: always()",
    ],
    "portable CodeQL enforcement",
  );
});

test("dependency overrides and lockfile use the reviewed fixed versions", async () => {
  const [workspace, lockfile] = await Promise.all([
    text("pnpm-workspace.yaml"),
    text("pnpm-lock.yaml"),
  ]);
  includesEvery(
    workspace,
    [
      "overrides:",
      "brace-expansion: 5.0.8",
      "fast-uri: 3.1.4",
      "js-yaml: 4.3.0",
    ],
    "pnpm workspace overrides",
  );
  includesEvery(
    lockfile,
    ["brace-expansion@5.0.8:", "fast-uri@3.1.4:", "js-yaml@4.3.0:"],
    "pnpm lockfile",
  );
  for (const vulnerable of ["brace-expansion@5.0.7:", "fast-uri@3.1.3:", "js-yaml@4.2.0:"]) {
    assert.equal(lockfile.includes(vulnerable), false, `lockfile still contains ${vulnerable}`);
  }
});

test("non-demo deployments and container provenance fail closed", async () => {
  const [root, variables, compute] = await Promise.all([
    text("infra/terraform/main.tf"),
    text("infra/terraform/variables.tf"),
    text("infra/terraform/modules/compute/main.tf"),
  ]);

  includesEvery(
    root,
    [
      'var.environment != "staging"',
      "!var.live_integrations_enabled",
      "!var.external_notifications_enabled",
      'var.notification_driver == "disabled"',
      "same_account_ecr_digest_pattern",
      "can(regex(local.same_account_ecr_digest_pattern, image))",
      "length(var.approved_adapter_egress_cidrs) > 0",
    ],
    "root deployment guard",
  );
  includesEvery(
    variables,
    ["can(cidrnetmask(cidr))", 'cidr != "0.0.0.0/0"'],
    "adapter egress validation",
  );
  assert.match(
    compute,
    /FLOODRISE_LIVE_INTEGRATIONS_ENABLED", value = tostring\(var\.live_integrations_enabled\)/,
  );
  assert.doesNotMatch(compute, /var\.environment != "demo"/);
});

test("runtime services have isolated IAM and network boundaries", async () => {
  const [root, compute, network, data] = await Promise.all([
    text("infra/terraform/main.tf"),
    text("infra/terraform/modules/compute/main.tf"),
    text("infra/terraform/modules/network/main.tf"),
    text("infra/terraform/modules/data/main.tf"),
  ]);

  includesEvery(
    compute,
    [
      'aws_iam_role.task["api"]',
      'aws_iam_role.task["worker"]',
      'aws_iam_role.task["tile-api"]',
      'name = "api-data-plane"',
      'name = "worker-data-plane"',
      'name = "tile-read-only"',
    ],
    "service-specific task roles",
  );
  includesEvery(
    root,
    [
      "api_security_group_id",
      "worker_security_group_id",
      "tile_security_group_id",
    ],
    "service-specific task security groups",
  );
  includesEvery(
    network,
    [
      'resource "aws_security_group" "api"',
      'resource "aws_security_group" "worker"',
      'resource "aws_security_group" "tile"',
      'resource "aws_vpc_security_group_egress_rule" "worker_to_approved_adapter"',
    ],
    "segmented network",
  );
  assert.equal(network.includes('cidr_ipv4         = "0.0.0.0/0"'), false);
  assert.equal(network.includes("app_to_redis"), false);
  assert.equal(data.includes("aws_elasticache"), false);
  assert.equal(compute.includes("FLOODRISE_REDIS_URL"), false);
  assert.equal(compute.includes("DATABASE_MASTER_SECRET"), false);
  assert.equal(compute.includes("database_master_secret_arn"), false);
});

test("the API reaches the restricted tile service through its private Cloud Map name", async () => {
  const [compute, tileImage] = await Promise.all([
    text("infra/terraform/modules/compute/main.tf"),
    text("services/tile-api/Dockerfile"),
  ]);

  includesEvery(
    compute,
    [
      'name = "${var.environment}.floodrise.internal"',
      'name = "tile-api"',
      '"http://tile-api.${var.environment}.floodrise.internal:8790"',
      '{ name = "FLOODRISE_RASTER_MANIFEST", value = "/app/artifacts/manifest.json" }',
      'urllib.request.urlopen(\\"http://127.0.0.1:8790/health\\", timeout=2)',
    ],
    "private tile-service discovery",
  );
  includesEvery(
    tileImage,
    [
      "COPY fixtures/kerala-demo/rasters ./artifacts",
      'CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8790"]',
    ],
    "tile image artifact contract",
  );
  assert.equal(
    compute.includes('"http://tile-api:8790"'),
    false,
    "the short tile hostname is not resolvable without ECS Service Connect",
  );
});

test("the public ALB forwards only requests with the generated CloudFront origin secret", async () => {
  const [root, compute, edge] = await Promise.all([
    text("infra/terraform/main.tf"),
    text("infra/terraform/modules/compute/main.tf"),
    text("infra/terraform/modules/edge/main.tf"),
  ]);

  includesEvery(
    root,
    ["random_password.origin_verify.result", "origin_verify_header_value"],
    "origin secret wiring",
  );
  includesEvery(
    compute,
    [
      'type = "fixed-response"',
      'status_code  = "403"',
      'resource "aws_lb_listener_rule" "cloudfront_origin"',
      'http_header_name = "X-FloodRISE-Origin-Verify"',
      "values           = [var.origin_verify_header_value]",
    ],
    "ALB origin enforcement",
  );
  includesEvery(
    edge,
    [
      'name  = "X-FloodRISE-Origin-Verify"',
      "value = var.origin_verify_header_value",
    ],
    "CloudFront origin header",
  );
});

test("the edge CSP permits only the reviewed public OpenStreetMap tile origin", async () => {
  const [edge, mapStyle] = await Promise.all([
    text("infra/terraform/modules/edge/main.tf"),
    text("packages/map/src/style.ts"),
  ]);
  const reviewedTileOrigin = "https://tile.openstreetmap.org";

  assert.ok(
    mapStyle.includes(`${reviewedTileOrigin}/{z}/{x}/{y}.png`),
    "map default must use the reviewed OpenStreetMap tile endpoint",
  );
  assert.match(
    edge,
    new RegExp(`img-src [^;]*${reviewedTileOrigin.replaceAll(".", "\\.")}[^;]*;`),
    "CloudFront img-src must allow the reviewed tile endpoint",
  );
  assert.match(
    edge,
    new RegExp(`connect-src [^;]*${reviewedTileOrigin.replaceAll(".", "\\.")}[^;]*;`),
    "CloudFront connect-src must allow MapLibre tile requests",
  );
  assert.equal(
    edge.includes("*.openstreetmap.org"),
    false,
    "CSP must not broaden access to unreviewed OpenStreetMap subdomains",
  );
});

test("WAF admits representative evidence above 8 KiB only through the bounded PUT route", async () => {
  const edge = await text("infra/terraform/modules/edge/main.tf");
  const representativePhotoBytes = 5 * 1024 * 1024;
  const apiLimitBytes = 10_000_000;

  assert.ok(representativePhotoBytes > 8 * 1024, "fixture must exercise the managed 8 KiB boundary");
  assert.ok(representativePhotoBytes <= apiLimitBytes, "fixture must remain inside the API limit");
  includesEvery(
    edge,
    [
      'name     = "PrivateEvidenceRateLimit"',
      'priority = 4',
      "limit              = 200",
      'name     = "AllowBoundedPrivateEvidenceContent"',
      'priority = 5',
      'regex_string = "^/api/v1/media/uploads/upload-[a-f0-9]{20}/content$"',
      'search_string         = "PUT"',
      'search_string         = "image/"',
      'name = "content-length"',
      'regex_string = "^([0-9]{1,7}|10000000)$"',
      'name        = "AWSManagedRulesCommonRuleSet"',
      'priority = 10',
    ],
    "bounded WAF media exception",
  );
  assert.equal(
    edge.includes('excluded_rule {\n          name = "SizeRestrictions_BODY"'),
    false,
    "the managed body-size rule must not be disabled globally",
  );
  assert.ok(
    edge.indexOf('name     = "PrivateEvidenceRateLimit"')
      < edge.indexOf('name     = "AllowBoundedPrivateEvidenceContent"'),
    "the media-specific rate limit must run before the terminal bounded exception",
  );
});

test("raw evidence lifecycle has bounded current, quarantine, and multipart retention", async () => {
  const data = await text("infra/terraform/modules/data/main.tf");

  includesEvery(
    data,
    [
      'id     = "expire-all-current-raw-evidence"',
      "days = 30",
      "noncurrent_days = 7",
      "days_after_initiation = 1",
      'id     = "expire-rejected-quarantine"',
      'prefix = "quarantine/"',
      "days = 7",
    ],
    "raw evidence lifecycle",
  );
});

test("staff Cognito authentication is passkey-only at the infrastructure boundary", async () => {
  const identity = await text("infra/terraform/modules/identity/main.tf");

  includesEvery(
    identity,
    [
      'mfa_configuration        = "OFF"',
      'user_pool_tier           = "ESSENTIALS"',
      'allowed_first_auth_factors = ["WEB_AUTHN"]',
      'user_verification = "required"',
      'explicit_auth_flows                  = ["ALLOW_USER_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]',
      'name     = "admin_only"',
      "managed_login_version = 2",
    ],
    "Cognito passkey policy",
  );
  assert.equal(identity.includes("software_token_mfa_configuration"), false);
  assert.equal(identity.includes("ALLOW_USER_SRP_AUTH"), false);
});
