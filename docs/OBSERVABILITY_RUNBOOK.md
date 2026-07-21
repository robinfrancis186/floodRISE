# Observability and SLO runbook

## Local stack

```bash
docker compose -f infra/compose.yaml --profile observability up -d
```

Grafana is on <http://127.0.0.1:3001> and Prometheus on
<http://127.0.0.1:9090>. The demo stack has no Alertmanager destination; alerts
remain visible locally and cannot page or message a production channel.

## Telemetry contract

The FastAPI service emits the core SLO metrics below from its private `/metrics`
endpoint. Prometheus/Grafana/OTel configuration and alert rules are provisioned
for the local stack. The notification-attempt counter is initialized to zero in
every process, while authoritative alert and approval events remain in the
database audit/outbox records.

Implemented telemetry must carry environment, service, release, incident ID,
demo/live mode, and model/evidence version where relevant. Never use identity,
precise coordinates, report text, contact details, tokens, signed URLs, or media
as labels or log fields. Request IDs may be logged; sensitive domain IDs remain
access-controlled.

Required production metrics include:

| Metric | Target / meaning |
| --- | --- |
| `floodrise_report_submit_seconds` | Submission p95 ≤2 s |
| `floodrise_corroboration_seconds` | Fourth eligible report through signal/reroute p95 ≤5 s |
| `floodrise_simulation_seconds` | Full ensemble/impact publication p95 ≤60 s |
| `floodrise_route_seconds` | Route query p95 ≤750 ms |
| `floodrise_audit_outbox_oldest_age_seconds` | Near zero; critical above 30 s |
| `floodrise_source_age_seconds` and `floodrise_source_max_age_seconds` | Source freshness contract |
| `floodrise_notification_external_attempt_total` | Must remain exactly zero in demo |
| `floodrise_audit_outbox_depth` | Persisted outbox depth |
| SSE connected/replay/lag, route no-result count, model failures, scanner availability | Production-adapter capacity and safe-degradation signals still requiring deployment instrumentation |

Structured logs use UTC, severity, service/release, request/job/event ID, actor role
(not identity), authorization decision, resource type/version, outcome, duration,
and sanitized error code. Approval and audit events remain authoritative database
records; logs are not the audit trail.

## Triage

### API or SSE unavailable

Check ALB/health, task desired/running counts, recent deployment, CPU/memory,
database/Redis reachability, and error codes. Redis/SSE loss must cause refetch or
reconnect with `Last-Event-ID`, not lost authority. Keep cached UI timestamps and
disable claims needing fresh verification.

### Corroboration or route latency high

Inspect report-ingest duration, independence/deduplication work, transaction lock
time, outbox age, queue oldest age, worker saturation, spatial query plan, and
route graph/model version. Never bypass eligibility, contradiction, closed-edge,
or audit rules to meet latency.

### Simulation exceeds 60 seconds

Check trigger coalescing, ensemble job fanout, input snapshot/object availability,
worker CPU/memory, failed/DLQ messages, and output publication: checksum-pinned
packaged rasters in the demo, or COGs only in a production deployment where that
adapter has been separately activated. Continue displaying the prior version
with its timestamp and stale state; do not relabel it current.

### Source freshness breached

Confirm provider status, acquisition versus observation time, parser/schema
errors, checksum/version, and licence/access changes. Mark stale/unknown, switch
only to a pre-approved fallback with visible provenance, and quarantine suspect
artifacts. Demo fixtures never substitute into live incidents.

### External notification attempt

Stop the demo immediately and follow
[INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md#external-notification-attempt). Preserve
the attempted payload/destination classification and do not retry.

### Audit/outbox backlog

Disable dispatch and high-impact approvals, preserve state, compare transaction
and consumer offsets, and follow
[INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md#audit-integrity-or-outbox-failure).

## Release and rehearsal evidence

For every competition rehearsal capture the reset duration, report and route
timings, model publish duration, audit-chain result, browser performance
(LCP/INP/CLS), and fixture/release versions. Use the application metrics plus
environment-level network observation; do not treat an unused queue/DLQ as a
production delivery proof. Three clean runs plus one degraded-network run are
required. A screenshot without
measurement method, time range, and release context is not acceptance evidence.
