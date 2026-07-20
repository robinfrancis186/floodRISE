#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_file="${repo_dir}/infra/compose.yaml"

fail() {
  printf 'PRECHECK FAILED: %s\n' "$1" >&2
  exit 1
}

command -v docker >/dev/null 2>&1 || fail "Docker is not installed"
docker compose version >/dev/null 2>&1 || fail "Docker Compose v2 is not available"
docker compose -f "${compose_file}" config --quiet || fail "compose configuration is invalid"

rendered="$(docker compose -f "${compose_file}" config)"
printf '%s\n' "${rendered}" | grep -q 'FLOODRISE_DEMO_MODE: "true"' || fail "demo mode is not forced"
printf '%s\n' "${rendered}" | grep -q 'FLOODRISE_LIVE_INTEGRATIONS_ENABLED: "false"' || fail "live integrations are not disabled"
printf '%s\n' "${rendered}" | grep -q 'FLOODRISE_DEMO_ALERT_SINK: fake://notification-sink' || fail "the fake alert sink is not forced"
printf '%s\n' "${rendered}" | grep -q 'FLOODRISE_EXTERNAL_NOTIFICATIONS_ENABLED: "false"' || fail "external notifications are not disabled"
printf '%s\n' "${rendered}" | grep -q 'internal: true' || fail "the isolated demo network is missing"

if printf '%s\n' "${rendered}" | grep -Eiq '(twilio|sns\.|firebaseio|fcm\.googleapis|api\.whatsapp|sendgrid)'; then
  fail "a production-capable notification provider appears in demo configuration"
fi

if curl -fsS --max-time 2 http://127.0.0.1:8787/health >/dev/null 2>&1; then
  mode="$(curl -fsS --max-time 2 http://127.0.0.1:8787/health)"
  printf '%s' "${mode}" | grep -Eiq 'demo|simulated' || fail "running API health response does not identify demo mode"
else
  printf 'NOTE: API is not running; static safety checks passed.\n'
fi

printf 'PASS: demo configuration is isolated and notification egress is disabled.\n'
