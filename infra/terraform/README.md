# AWS Mumbai infrastructure

This directory is an un-applied **target-topology scaffold**, not a deployable
release bundle and not proof of any AWS control. It declares:

- CloudFront, private S3 web assets, WAF, and an ALB-backed API origin;
  production requires TLS on the CloudFront-to-ALB hop.
- ECS Fargate API/worker tasks plus a private service-discovered tile facade.
- RDS PostgreSQL, encrypted S3 data/audit buckets, encrypted SQS/DLQ, Redis,
  KMS, and an empty Secrets Manager envelope.
- a Cognito public app client with authorization-code enabled, staff groups,
  MFA, and WebAuthn configuration. PKCE is a client-side exchange behavior and
  is not implemented by the current web apps; no HttpOnly application-session
  layer is present.
- RDS continuous recovery points and optional cross-region backup copies.
- PrivateLink/gateway endpoints for ECR, logs, metrics, secrets, SQS, KMS, STS,
  and S3. Demo creates no NAT gateway and gives tasks no public HTTPS egress.

The application secret has no Terraform-managed value. Populate it using the
organization's approved secret workflow after `apply`; never put credentials in
HCL, tfvars, CI variables, or Git history.

## Activation gaps

The scaffold has not been planned or applied in an AWS account. Before it can
run floodRISE, an authorized delivery team must at minimum:

- supply reviewed container images, DNS names, certificates, remote state, and
  secret values, then reconcile the secret/environment shape with the FastAPI
  settings;
- implement and package the declared `app.worker` Celery entry point and the
  SQS worker transport (the judging API runs model/route work synchronously);
- implement the web PKCE flow and secure HttpOnly session/token handling;
- enable and verify `postgis`, `pgrouting`, `pgcrypto`, and `btree_gist` in RDS
  with an approved database-owner bootstrap. Terraform provisions PostgreSQL,
  while the checked-in Alembic migration creates only application tables;
- connect private S3 media, an approved malware scanner, COG/TiTiler, retention
  jobs, and any separately authorized notification provider; and
- perform account-level IAM/network/WAF review, database migration, smoke,
  restore, security, accessibility, and performance evidence.

## Validate without AWS changes

```bash
terraform -chdir=infra/terraform fmt -check -recursive
terraform -chdir=infra/terraform init -backend=false
terraform -chdir=infra/terraform validate
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

Production-variable preconditions require Multi-AZ, deletion protection,
35-day PITR, cross-region backup, origin TLS, RPO <= 5 minutes, and RTO <= 30
minutes. The RPO/RTO values are declarations, not measured behavior; successful
quarterly restore drills would provide the evidence.
