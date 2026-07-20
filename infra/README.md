# Local and AWS infrastructure

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
