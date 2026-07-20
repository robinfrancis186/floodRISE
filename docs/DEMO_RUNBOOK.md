# Kerala extreme-rainfall competition demo runbook

## Safety objective

This is a deterministic synthetic replay for Aluva–Eloor–Periyar and
Periyar basin. It must run without upstream providers, show
`DEMO DATA • NOT LIVE` throughout, reset in under two minutes, and never contact
a real notification destination.

Stop if any watermark is absent, an identity/destination looks real, the API is
not in demo mode, or `ops/scripts/demo-preflight.sh` fails.

## One-time preparation

Use Node 22, pnpm 11.7, Python 3.12, uv, Docker, and Docker Compose v2.

```bash
pnpm install
(cd services/backend && uv sync --frozen)
docker compose -f infra/compose.yaml pull
```

After this preparation, rehearse loss of upstream internet before claiming the
presentation path is offline-ready. Do not sign in to, configure, or test a live
provider for a rehearsal.

## Clean start

```bash
docker compose -f infra/compose.yaml up -d
(cd services/backend && uv run python -m app.seed)
pnpm dev
ops/scripts/demo-preflight.sh
```

Expected local surfaces:

- Operations console: <http://127.0.0.1:5173>
- Field PWA: <http://127.0.0.1:5174>
- API documentation/health: <http://127.0.0.1:8787/docs>
- MinIO console: <http://127.0.0.1:9001>

Check both applications at desktop and 360 × 800, confirm the scenario clock is
deterministic, and confirm the fixture manifest reports `is_simulated: true`,
`live_integrations_enabled: false`, and `fake://notification-sink`.

## Eight-minute judging flow and acceptance targets

The table is the intended operator script. “Within five seconds,” reset timing,
and the eight-minute finish are acceptance targets until measured and recorded
on the judging machine; the UI state alone is not timing evidence.

| Time | Operator action | Evidence visible to judges |
| --- | --- | --- |
| 0:00 | Open Live Map and name the scenario and safety boundary. | Persistent demo watermark, incident clock, source timestamps/confidence, modelled versus observed legend. |
| 0:45 | Open Source Health, then return to Aluva. | Provenance and freshness are explicit; no hidden “perfect data” claim. |
| 1:20 | Submit the first report in the field PWA. | Mobile-friendly form, accuracy/time validation, receipt, one uncorroborated candidate. |
| 2:00 | Submit reports two and three from distinct fixture identities. | Independent-family count rises while wording remains unofficial. |
| 2:40 | Submit the fourth qualifying report. | Within five seconds the signal becomes community-corroborated, the map invalidates/refetches, and route impact updates. |
| 3:30 | Show the duplicate/same-device report and contradictory observation. | Duplicate does not increase independence; conflict is visible and reviewable. |
| 4:15 | Open Evacuation and Shelters. | Up to three lower-risk alternatives or explicit no-route, reasons, freshness, shelter status, model/evidence versions, and expiry. |
| 5:10 | Request a high-impact action as one fixture staff user. | No dispatch occurs; request is version-bound and awaiting a different approver. |
| 5:50 | Approve as the second fixture staff user. | Step-up/two-person boundary, synthetic `DISPATCHED` alert record naming `fake://notification-sink`, and immutable audit/outbox sequence. No sink request is sent. |
| 6:40 | Open Audit Log and Resilience Audit. | Actor/time/reason/version chain and cautious “inspect/assess/consider” recommendations. |
| 7:30 | Recap limitations. | Rapid impact estimate, unofficial community evidence, lower-risk—not safe—route, and human authority. |

Do not rush an unfinished asynchronous change. State that it is pending and show
the job/version state; never imply the result already exists.

## Reset and repeatability

```bash
ops/scripts/demo-reset.sh
```

The reset script refuses any non-loopback API, requires both `demo_mode: true`
and the `DEMO DATA` label, resets the backend as the fixture identity
administrator, and verifies the canonical incident ID and scenario time
`2023-12-04T14:10:00Z` in the response.

A shell process cannot erase IndexedDB in a browser profile. The script therefore
prints the local Field PWA reset URL. Open that URL in **every browser/profile**
used during the rehearsal, select **Verify and clear this demo device**, and
require the “This browser profile is clean” confirmation. The app re-verifies
demo mode before it removes that profile's encrypted drafts, encryption key,
receipts, last-sync label, and forced-offline rehearsal flag. It refuses a live
or unreachable API. Reporter/device identifiers remain in place so duplicate and
independence tests do not silently acquire new identities.

Only after those per-profile confirmations should the operator record a complete
reset. Confirm zero unsent drafts in Offline Queue, the initial model/evidence
versions, and no stale approval from a prior run.

Run three complete clean resets. Record each duration and the following:

| Run | Fourth report → signal/route | Full model publish | Duplicate suppressed | Audit complete | External attempts |
| --- | --- | --- | --- | --- | --- |
| 1 |  |  |  |  | Must be 0 |
| 2 |  |  |  |  | Must be 0 |
| 3 |  |  |  |  | Must be 0 |

The repository's automated reset/browser tests do not replace this three-run
operator record. Do not mark the rehearsal complete until all cells have direct
evidence.

## Degraded-network rehearsal

1. Load the field PWA, then use browser tooling to set it offline.
2. Create one synthetic report. Confirm it is immutable in Offline Queue and no
   fresh route/approval claim is available.
3. Advance the local time beyond 24 hours for a separate draft and confirm expiry
   says it was **not submitted**.
4. Restore connectivity. Confirm one idempotent submission/receipt and no duplicate
   evidence family or alert.
5. Disable a source adapter fixture. Confirm stale/unknown source state remains
   visible while the rest of the deterministic flow continues.

## After the rehearsal

```bash
docker compose -f infra/compose.yaml logs demo-alert-sink
docker compose -f infra/compose.yaml down
```

The current backend does not call the mock sink, so its request log should be
empty; synthetic alert state is inspected through the API/audit log instead.
Prometheus includes an alert rule for
`floodrise_notification_external_attempt_total{environment="demo"}`, but the
backend does not currently emit that metric. A missing time series is not proof
of zero attempts—record configuration/preflight results and environment-level
network observation for release evidence.
Do not use `down -v` unless intentionally deleting the named local demo volumes.
