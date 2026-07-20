# Incident response runbook

## Severity and authority

| Severity | Examples | Initial response |
| --- | --- | --- |
| SEV-0 safety/privacy | Demo external-notification attempt; wrong evacuation/closure/all-clear dispatch; live/demo crossover; exposed citizen identity or precise location; audit tampering | Stop the affected path immediately, page incident commander/security/privacy, preserve evidence, assess recipients and public-safety impact. |
| SEV-1 operational integrity | Corrupted model/input, approval bypass, duplicate dispatch, audit/outbox failure, compromised credential, no compliant route returned as usable | Disable affected capability, fail closed, declare incident, begin rollback or source quarantine. |
| SEV-2 degradation | API/SSE outage, model >60 s, route p95 >750 ms, source stale, queue backlog with safe fallback | Degrade explicitly, show stale/unknown state, restore service within objective. |
| SEV-3 limited issue | Cosmetic/accessibility defect without wrong decision data | Track and repair; escalate if it obscures a safety label or blocks a user role. |

The incident commander owns operational decisions. Security owns containment and
credentials; privacy owns personal-data impact; data/model owners validate source
and output; communications uses only approved factual wording. One person records
the timeline and audit references.

## First 15 minutes

1. Declare severity, incident ID, UTC start, commander, scribe, and affected
   incident/environment/version. Use an out-of-band channel if identity is suspect.
2. Stop or isolate the unsafe action. Preserve service for read-only evidence when
   safe; do not destroy containers, logs, queues, or objects to “clean up.”
3. Confirm demo versus live credentials/account/region before any command.
4. Capture last known good model/evidence/task version, request/approval IDs,
   relevant hashes, queue depth, source health, and exact user-visible wording.
5. Fail closed for dispatch/approval/audit faults. Show stale/unknown status for
   data faults; never manufacture an all-clear or route.
6. Decide rollback, source quarantine, credential revocation, or restore. Assign an
   owner and update time. Notify the deploying authority when impact is plausible.

## External notification attempt

1. Stop the sender/worker and set external notifications disabled at the highest
   available control plane. Disconnect the demo network if needed.
2. Preserve the attempted payload, idempotency key, destination classification,
   provider response, timestamps, process/task identity, configuration source,
   and audit/outbox events. Restrict evidence containing destinations.
3. Determine whether any real provider accepted delivery. Ask the authorized
   account owner to revoke credentials/cancel queued messages when possible.
4. Notify incident commander, security, privacy, and the responsible authority.
   Do not independently contact recipients unless the authority approves wording.
5. Trace how the demo obtained the endpoint/credential, rotate exposed credentials,
   close egress, and add a regression test. Rehearsal resumes only after preflight,
   sink/network logs, configuration review, and environment-level network
   observation prove zero external capability. The judging backend does not emit
   the configured external-attempt metric, so an absent series is not evidence.

## Audit integrity or outbox failure

Disable operational dispatch and approvals. Compare database transaction state,
hash-chain verification, outbox sequence, consumer acknowledgements, and delivery
idempotency records. Do not backfill by rewriting an event. Record a superseding
correction and reconcile from the authoritative transaction after peer review.

## Wrong, stale, or mixed data

Quarantine the source/version, stop dependent jobs, retain the raw checksum, mark
products withdrawn/stale, and identify routes/actions derived from them. Never
replace a live artifact with a demo fixture. Reprocess from the last accepted
immutable snapshot, publish a new version, and explicitly supersede the old one.

## Credential or identity compromise

Revoke sessions/tokens, disable the principal/integration, rotate through the
approved secret system, and inspect audit/access logs without copying sensitive
values. Review role/group changes and high-impact requests made during exposure.
Do not place a replacement credential in a ticket, chat, shell history, or Git.

## Service or regional outage

Keep cached screens clearly timestamped and disable fresh route claims/approvals
when authority cannot be verified. Recover from Multi-AZ automatically where
possible. For regional recovery, restore the latest verified cross-region recovery
point into an isolated environment, validate hash/audit consistency, rerun smoke
tests, then switch traffic through a separately approved change. Target RPO is
five minutes and RTO 30 minutes; record actual values.

## Recovery and closure

Before resuming, two authorized operators verify containment, safety labels,
authorization/approval rules, source versions, audit continuity, no duplicate
dispatch, and user-visible correction. Close only with scope, root cause,
timeline, impact, data/version list, recovery evidence, notification decisions,
follow-up owners/dates, and a tested prevention control.
