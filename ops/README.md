# Operations assets

- `prometheus/` defines local scrape targets and safety/SLO rules.
- `grafana/` provisions a minimal operator dashboard.
- `otel-collector.yaml` receives OTLP logs, metrics, and traces.
- `scripts/demo-preflight.sh` blocks a rehearsal when demo isolation is absent.
- `scripts/demo-reset.sh` refuses to mutate any non-loopback API, verifies the
  canonical backend checkpoint, and prints the per-browser Field PWA reset step.

The demo stack has no Alertmanager delivery target. Production alert delivery is
configured outside these repository files only after an authorized deployment
review; the deterministic replay always remains log/mock-sink only.
