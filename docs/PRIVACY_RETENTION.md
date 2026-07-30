# Privacy, media handling, and retention

## Principles

Collect only what is needed to assess a flood observation, protect life, prevent
abuse, or evidence an authorized decision. A production deployment must separate
reporter identity from flood evidence. The current MVP does **not** provide that
storage separation: exact identity/device and evidence fields coexist in a
versioned report record, while API response filtering hides them from
non-identity-administrator report views. Public/report views use a generalized
position; separately permissioned identity storage and audited joins remain an
activation requirement.

Never put report text, precise coordinates, contact details, device/install
tokens, access tokens, signed URLs, photo bytes, or identity linkage in analytics,
traces, dashboard labels, exception messages, or routine application logs.

## Implemented demo media pipeline

1. Upload to the private in-process quarantine adapter using an idempotency key
   and bounded content length; do not make the original public.
2. Verify magic bytes and declared type, checksum, and supported dimensions.
3. Return the explicit simulated result `DEMO_CLEAN`. This is not malware
   detection. The fail-closed scanner adapter used outside demo returns
   unavailable, leaves bytes quarantined in the active blob adapter, and blocks
   operational use.
4. Decode and re-encode supported images, strip EXIF/GPS, and calculate a
   perceptual hash for near-duplicate evidence families.
5. Put the sanitized derivative in private process memory and commit a durable
   `PENDING` raw-quarantine deletion marker with the terminal media result. The
   generation-bound deletion is then attempted immediately; terminal completion
   replay and metadata polling retry it idempotently without changing the
   committed result. Bytes disappear when the process restarts; upload metadata
   and the cleanup receipt remain in the database. V1 has no byte-download,
   public-photo, or signed-URL endpoint.
6. Record upload state changes and report attachment in the audit/outbox. A
   general evidence-view/export audit workflow is not implemented.

Production activation must replace the in-memory blob/scanner adapters with
private object storage and an approved scanner before accepting real photos.

## Default schedule

| Category | Default retention | Disposal / notes |
| --- | --- | --- |
| Rejected quarantine uploads | 7 days | The API stores `quarantine_delete_after` and performs a bounded best-effort expiry sweep. The un-applied GCP target uses an eight-day lifecycle fallback with no minimum bucket retention, object versioning, or soft-delete extension. A continuously scheduled deletion/legal-hold job is not yet activated. |
| Sanitized private citizen photo bytes | Up to 30 days | The API stores `evidence_delete_after`. The un-applied GCP target uses a 31-day lifecycle fallback with no minimum bucket retention, object versioning, or soft-delete extension. Sanitization/rejection atomically records durable raw-quarantine cleanup state and retries the generation-bound deletion after terminal commit. |
| Accepted evidence record and identity linkage | 1 year | The API stores `identity_link_delete_after` in the authoritative database. The MVP has no separate identity store or scheduled database erasure job. |
| Security and access logs | 1 year | Target policy; Terraform declares 365-day production CloudWatch retention, but no deployed log-retention evidence exists. |
| Official decisions and approval/audit events | 7 years | Target policy; Terraform declares object-lock retention for an audit bucket, but the API does not export its database audit chain to that bucket. |
| Unsent offline field evidence | 24 hours | Implemented locally: expire drafts and say they were not submitted. Queue limit: 100 items / 100 MB. |
| Demo data | Until scenario version is retired | Synthetic only; no real identity or destination is allowed. |

These are proposed defaults pending the deploying authority's legal basis and
records schedule. Retention timestamps are metadata, not proof of disposal.
Production still requires continuous cleanup scheduling, legal-hold enforcement,
failure alerting, backup handling, and restore tests. Raw-quarantine terminal
deletion already has an idempotent database cleanup receipt; other retention
classes do not yet have equivalent scheduled workers. A documented legal hold
should suspend deletion for the minimum affected objects and have an owner and
review date.

## Rights and operational requests

The following is a target operating policy, not an implemented portal or job:
privacy requests should be authenticated, ticketed, and searched across
identity, evidence, object, export, and backup indexes. The privacy lead should
decide whether a record can be deleted, de-identified, restricted, or must be
retained for a documented public-safety/legal purpose. Backup expiry should
follow its approved cycle, and restored data should reapply approved deletions
and restrictions.

Production exports must state purpose, requester, approving role, filters, row
count, classification, expiry, and checksum, and must exclude direct identity,
precise report points, free text, media URLs, and stable device tokens from
public output. That complete export/approval workflow is not implemented in the
judging path.
