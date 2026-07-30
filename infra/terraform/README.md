# AWS Mumbai infrastructure

This directory is an un-applied **target-topology scaffold**, not a deployable
release bundle and not proof of any AWS control. It declares:

- CloudFront, private S3 web assets, WAF, and an ALB-backed API origin;
  production requires TLS on the CloudFront-to-ALB hop. A generated
  origin-verification header is added by CloudFront, the ALB default action is
  a fixed 403, and only a matching header rule forwards to the API.
- ECS Fargate API/worker tasks plus a private service-discovered tile facade.
- RDS PostgreSQL, encrypted S3 data/audit buckets, encrypted SQS/DLQ, KMS, and
  an empty Secrets Manager envelope. API, worker, and tile services use distinct
  task roles and security groups; the tile role can only read processed
  artifacts.
- a Cognito public app client with authorization-code enabled, staff groups,
  passkey-only WebAuthn first-factor policy, required user verification, and
  admin-only recovery. PKCE is a client-side exchange behavior and is not
  implemented by the current web apps; no HttpOnly application-session layer
  is present.
- RDS continuous recovery points and optional cross-region backup copies.
- PrivateLink/gateway endpoints for ECR, logs, metrics, secrets, SQS, KMS, STS,
  Cognito, and S3. Demo and staging create no NAT gateway and give tasks no
  public HTTPS egress. Production source-adapter egress remains disabled by
  default and, when separately reviewed, is limited to explicit worker CIDRs.
- current raw objects expire after 30 days, rejected `quarantine/` objects after
  seven days, noncurrent versions after seven days, and abandoned multipart
  uploads after one day. Production object keys must follow these prefixes.

The application secret has no Terraform-managed value. Populate it with an
application-scoped database credential and other reviewed runtime configuration
using the organization's approved secret workflow after `apply`; never put
credentials in HCL, tfvars, CI variables, or Git history. The RDS-managed master
secret is a database-owner bootstrap credential and is not granted or injected
into any runtime task.

Redis is intentionally absent from the AWS target. The current application uses
persisted database invalidations and does not need a remote cache/fanout service;
adding one later requires an authenticated, service-scoped design and a separate
review.

## Activation gaps

The scaffold has not been planned or applied in an AWS account. Before it can
run floodRISE, an authorized delivery team must at minimum:

- supply reviewed, same-account ECR images referenced by full SHA-256 digest,
  DNS names, certificates, remote state, and secret values, then reconcile the
  secret/environment shape with the FastAPI settings;
- build and publish the checked-in backend image, exercise the declared
  `app.worker:celery_app` tasks against the provisioned SQS queue, and cut the
  production API over from the synchronous judging path only after rehearsal;
- implement the web PKCE flow and secure HttpOnly session/token handling, then
  provision and rehearse passkey enrollment/recovery with two authorized staff
  accounts before enabling runtime tasks;
- run Alembic with an approved database-owner bootstrap and verify the checked-in
  `postgis`, `pgrouting`, `pgcrypto`, `btree_gist`, normalized-source and route
  schema migration against RDS before enabling application traffic;
- connect private S3 media under the enforced `quarantine/` and `raw/` prefixes,
  an approved malware scanner, COG/TiTiler, deletion/legal-hold receipts, and any
  separately authorized notification provider; and
- perform account-level IAM/network/WAF review, database migration, smoke,
  restore, security, accessibility, and performance evidence.

## Validate without AWS changes

```bash
terraform -chdir=infra/terraform fmt -check -recursive
terraform -chdir=infra/terraform init -backend=false
terraform -chdir=infra/terraform validate
pnpm test:security-conformance
```

Provider initialization downloads plugins but does not create cloud resources.

## Planning workflow after the activation gaps are closed

1. Use separate AWS accounts/roles and separate state keys for demo and
   production. Confirm the caller identity and `ap-south-1` region.
2. Copy an example tfvars file outside the repository, replace image digests and
   DNS placeholders, and run the review in
   [the deployment runbook](../../docs/DEPLOYMENT_RUNBOOK.md).
3. Initialize an encrypted remote backend using a reviewed copy of
   `backend.hcl.example`.
4. Run `terraform plan -out=...`; have a second operator review the plan before
   any apply. This repository does not contain auto-apply workflows, and a
   successful plan would validate resource intent—not application readiness.

Production-variable preconditions require same-account immutable image digests,
Multi-AZ, deletion protection, 35-day PITR, cross-region backup, origin TLS,
RPO <= 5 minutes, and RTO <= 30 minutes. Staging is explicitly non-live. The
RPO/RTO values are declarations, not measured behavior; successful quarterly
restore drills would provide the evidence. External notification activation is
not available from this scaffold.
