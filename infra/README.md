# Local, AWS, and Google Cloud infrastructure

`compose.yaml` starts the local PostGIS/pgRouting, Redis, MinIO, LocalStack,
and isolated demo alert sink. All containers share an `internal: true` Docker
network, so demo processes cannot reach an external notification provider.

```bash
docker compose -f infra/compose.yaml up -d
docker compose -f infra/compose.yaml --profile tiles up -d
docker compose -f infra/compose.yaml --profile observability up -d
```

The credentials in the compose file are intentionally non-secret local demo
values and must never be reused outside a developer machine. AWS infrastructure
is declarative only; see `infra/terraform/README.md` before planning a deployment.
The local Redis container is retained only for deterministic compatibility
testing. The AWS target deliberately omits Redis because no authenticated remote
cache/fanout path is currently required.

The alternative Firebase/Google Cloud target lives in `infra/gcp`. It uses
Firebase Hosting, Cloud Run, Cloud Run Jobs, private Cloud SQL, private GCS
buckets, KMS, Secret Manager, and project-level identity controls. It requires
an existing, dedicated Google Cloud project and has its own fail-closed
Terraform guards. Do not reuse an unrelated Firebase project, and do not run
`terraform apply` until the deployment runbook's project, billing, image,
identity, retention, and notification checks are complete.
