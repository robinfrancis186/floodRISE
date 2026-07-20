#!/usr/bin/env bash
set -euo pipefail

api_base="${FLOODRISE_DEMO_API_BASE:-http://127.0.0.1:8787}"
field_origin="${FLOODRISE_FIELD_ORIGIN:-http://127.0.0.1:5174}"
reset_key="demo-runbook-reset-$(date -u +%Y%m%dT%H%M%SZ)-${RANDOM}"

case "${api_base}" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *)
    printf 'Refusing to reset a non-local API: %s\n' "${api_base}" >&2
    exit 1
    ;;
esac

case "${field_origin}" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *)
    printf 'Refusing to direct a demo reset to a non-local Field PWA: %s\n' "${field_origin}" >&2
    exit 1
    ;;
esac
field_origin="${field_origin%/}"

health="$(curl -fsS --max-time 3 "${api_base}/health")"
printf '%s' "${health}" | grep -Eq '"demo_mode"[[:space:]]*:[[:space:]]*true' || {
  printf 'Refusing reset: API did not prove demo mode.\n' >&2
  exit 1
}
printf '%s' "${health}" | grep -Eq '"data_label"[[:space:]]*:[[:space:]]*"DEMO DATA"' || {
  printf 'Refusing reset: API did not return the DEMO DATA label.\n' >&2
  exit 1
}

response="$(curl -fsS -X POST \
  -H "Idempotency-Key: ${reset_key}" \
  -H 'X-Demo-Role: identity_administrator' \
  -H 'X-Demo-User: demo-runbook-reset' \
  "${api_base}/api/v1/demo/reset")"

printf '%s' "${response}" | grep -Fq '"incident_id":"inc-demo-michaung-2023"' || {
  printf 'Reset response did not contain the canonical demo incident.\n' >&2
  exit 1
}
printf '%s' "${response}" | grep -Fq '"scenario_time":"2023-12-04T14:10:00Z"' || {
  printf 'Reset response did not return the canonical scenario time.\n' >&2
  exit 1
}

printf '%s\n' "${response}"
printf '\nBackend deterministic state reset completed.\n'
printf 'Browser storage is profile-scoped and has not been erased by this script.\n'
printf 'In every Field PWA browser/profile used for judging, open:\n  %s/demo-reset\n' "${field_origin}"
printf 'Choose "Verify and clear this demo device" and require the clean-profile confirmation.\n'
