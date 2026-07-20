# Safety policy and operational guardrails

## Required language

- Every replay screen, export, screenshot, and alert says `DEMO DATA • NOT LIVE`.
- A model output is a **rapid impact estimate**, never a certified flood depth.
- Navigation is a **lower-risk route estimate**, never a safe route.
- A community signal says: “Corroborated by 4 independent recent reports; not
  an official confirmation.”
- Expiry says that recent confirmation is absent and never implies an all-clear.

These phrases are safety controls and must not be shortened in a visual polish
pass, localization, or presentation script.

## Automation boundary

Community corroboration may update internal maps, enqueue model/route work, and
produce an opt-in caution. It must not automatically issue a road closure,
shelter closure, evacuation instruction, official warning, or all-clear.

For a real operational dispatcher, those actions require:

1. an authenticated requester with the relevant role;
2. a different authenticated approver with recent, phishing-resistant step-up
   MFA (ordinary password or TOTP alone is insufficient);
3. exact action, audience, geometry, evidence/model versions, reason, and expiry;
4. a current approval no more than 15 minutes old; and
5. an audit/outbox write before any delivery attempt.

If audit persistence or the outbox fails, operational delivery must fail closed.
The judging backend exercises the authorization and atomic record boundary, then
creates a synthetic `DISPATCHED` alert/audit record only. It has no real
dispatcher and does not call the Compose mock sink.

## Demo notification isolation

The deterministic replay must never contact a production notification endpoint.
All of the following are mandatory:

- `FLOODRISE_DEMO_MODE=true`
- `FLOODRISE_EXTERNAL_NOTIFICATIONS_ENABLED=false`
- `FLOODRISE_NOTIFICATION_DRIVER=demo_log`
- the fixture manifest uses `fake://notification-sink`
- containers use the internal Compose network and the mock sink has no host port;
- AWS demo creates no NAT gateway/public task egress and uses private AWS endpoints;
- Prometheus has no Alertmanager delivery target

The last two AWS/network items describe the un-applied Terraform target. The
local backend also does not emit the configured external-attempt Prometheus
metric, so a missing series must never be treated as evidence of zero egress.

Run `ops/scripts/demo-preflight.sh` before every rehearsal. Stop immediately if
the check fails, a destination resembles a real phone/email/account, a screen is
missing the watermark, or the API cannot prove demo/simulated mode.

## Data and model limits

- Modelled, observed, and assimilated layers remain visually and structurally
  distinct. Do not use a community report as an official observation.
- Local report assimilation stays within its catchment, decays over 500 m, and
  is capped at plus or minus 0.5 m.
- A bridge or tunnel is not declared flooded from the ground cell beneath it.
- Stale/unknown source state remains visible. Never silently substitute demo
  data into a live incident or mark unknown capacity as available.
- Conflicting evidence suppresses automatic caution and requires human review.
- A no-route result is valid. Do not force a route through an excluded edge.

## Stop conditions

Pause the demo or live exercise and preserve evidence when any of these occur:

- possible external notification delivery from a demo process;
- demo/live identifier, credential, storage, or data crossover;
- an approval by the requester, an expired approval, or an unbound command;
- loss of audit integrity, duplicate dispatch, or missing idempotency control;
- identity or precise citizen location exposed to an unauthorized role;
- a recommendation without source freshness, confidence, version, or expiry;
- an operator believes the interface is presenting certified/safe guidance.

Follow [INCIDENT_RESPONSE.md](INCIDENT_RESPONSE.md). Only an incident commander
may resume after the safety control is restored and the decision is audited.
