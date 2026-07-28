# Deployment and recovery runbook

## Preconditions

- All CI and security gates pass from an immutable commit.
- Container images are scanned and referenced by a full SHA-256 digest in ECR
  in the target AWS account; Terraform rejects tags, other registries, and
  cross-account references.
- Production has a reviewed ACM certificate for the CloudFront-to-ALB origin;
  CloudFront carries the generated origin-verification value and the ALB default
  action remains a fixed 403. Demo and staging have no NAT gateway or public
  task egress.
- The target AWS account, role, region `ap-south-1`, environment, state key, and
  DNS names are read back by two operators. Demo and production never share them.
- Data licences/permissions, privacy schedule, incident contacts, on-call owner,
  restore evidence, and security threat review are approved.
- External notifications remain disabled. Enabling a real provider is a separate
  authority-reviewed code change and is never performed for the competition
  demo. The checked-in Terraform cannot enable a real notification destination.

## Local deployment

Use [DEMO_RUNBOOK.md](DEMO_RUNBOOK.md). Compose exposes dependencies only on
loopback and places containers on an internal network. Local credentials embedded
in Compose are deliberately non-secret demo values and must never be reused.

## AWS target scaffold

The checked-in Terraform has not been planned or applied and is not presently a
runnable release bundle. It describes the target topology, while container
images, secret/settings wiring, authority-owned SQS/Celery transport rehearsal,
web PKCE/session handling, RDS extension bootstrap, production
object/scanner/COG adapters, and notification integration remain activation
work. Close the gaps listed in
`infra/terraform/README.md` before using the following as a deployment process.

```bash
terraform -chdir=infra/terraform fmt -check -recursive
terraform -chdir=infra/terraform init -backend=false
terraform -chdir=infra/terraform validate
pnpm test:security-conformance
```

For an authorized deployment, copy the relevant example tfvars outside Git and
replace image digests and DNS placeholders. Initialize a dedicated encrypted
remote backend, then create and peer-review a saved plan. Review every
service-specific IAM action and security-group rule, network route,
deletion/force-destroy flag, WAF/origin-header behavior, bucket policy,
retention value, task environment, and notification setting. There is
deliberately no CI auto-apply workflow.

The first infrastructure plan uses `runtime_config_ready=false`. This creates the
secret envelope while keeping API, worker, and tile desired counts at zero.
Create a least-privilege application database role with the RDS master bootstrap
credential, populate only that application credential and reviewed settings in
the application secret, verify its metadata, then remove bootstrap access from
the runtime process. Set `runtime_config_ready=true`, create a second plan, and
obtain a second review before starting services. No runtime task receives the
RDS master secret.

## Database and application release

1. Take/verify a recovery point and record the current task, schema, model, and
   fixture versions. Confirm sufficient migration headroom and no active incident
   command awaiting approval.
2. Have an approved database owner enable and verify `postgis`, `pgrouting`,
   `pgcrypto`, and `btree_gist` in RDS, then remove elevated access from the
   runtime role. The bootstrap for a fresh local Compose database creates these
   extensions, but Terraform and the checked-in Alembic migration do not. Run
   Alembic as a separate release task only after the extension bootstrap; it
   currently creates the generic application repository tables.
3. Complete passkey enrollment and recovery rehearsal for two separate staff
   accounts. Start one new API task, run private health/readiness, OpenAPI, OIDC,
   database, SQS, object, tile-artifact allowlist, origin-bypass denial, and
   audit/outbox smoke checks.
4. Rehearse the checked-in `app.worker` entry point against the authority-owned
   SQS queue, including visibility timeout, retry, dead-letter, idempotency, and
   outbox recovery behavior. After that transport rehearsal passes, deploy
   workers, then API tasks with 100% minimum healthy capacity. Confirm SSE replay
   and one synthetic non-delivery action before shifting CloudFront traffic.
5. Run `pnpm build`; its artifact conformance test serves the generated files
   under the same `/ops/` and `/field/` layout used by CloudFront and rejects
   root-scoped assets, manifests, service workers, or SPA fallbacks. Upload the
   contents of `apps/ops-web/dist/` below the S3 `ops/` key and the contents of
   `apps/field-web/dist/` below the S3 `field/` key—never either build at the
   bucket root. Update the release manifest/pointer, then invalidate only the
   changed entry points (including `/ops/index.html`, `/field/index.html`,
   `/field/manifest.webmanifest`, and `/field/sw.js` when changed).
   Confirm the edge returns `308` from `/ops` to `/ops/` and from `/field` to
   `/field/`; the trailing slash is required for Field's install and
   service-worker scope boundary.
6. Exercise reporter, responder, approver-as-different-user, auditor, stale source,
   no-route, and denied arbitrary tile URL. Verify security headers and WAF logs.

The target production configuration requires origin TLS, Multi-AZ RDS,
deletion protection, 35-day PITR, and cross-region recovery points, with RPO
≤5 minutes and RTO ≤30 minutes as objectives. Terraform preconditions do not
prove those outcomes or replace a quarterly restore exercise.

## Rollback

Stop rollout if safety wording, authorization, audit/outbox, source/version,
privacy, or error-rate checks fail. Scale the previous immutable ECS task
definition back up and move the release pointer to the previous static manifest.
Do not reverse an unsafe database migration blindly; prefer a forward-compatible
repair or restore into isolation. Record withdrawn model/evidence versions and
superseding versions so clients cannot use cached invalid output.

Rollback success requires health/readiness, correct demo/live label, prior schema
compatibility, authorization, audit-chain verification, zero duplicate dispatch,
and a full critical user journey. Keep the incident open until data products and
queued jobs are reconciled.

## Source-adapter egress

Live integrations are false by default. If a later authority-reviewed release
enables them, only worker tasks receive HTTPS rules and each destination must be
listed as a scoped IPv4 CIDR in `approved_adapter_egress_cidrs`; `0.0.0.0/0` is
rejected. Confirm the provider's stable address ownership, TLS,
licence, and incident-data handling before planning. Staging remains
non-live regardless of credentials.

## Recovery exercise

Quarterly, restore the newest primary and cross-region recovery points into an
isolated VPC/account. Verify recovery-point age, PostGIS extensions, row/object
counts, manifest checksums, audit chain, no orphaned outbox events, and application
smoke tests. Measure actual RPO/RTO and track any miss as an incident follow-up.
