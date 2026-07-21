"""Low-cardinality Prometheus metrics for floodRISE operational SLOs.

Each FastAPI app owns its registry so isolated tests and multiple application
instances in one process never share counters. Identity, report text, precise
locations, media references, and signed URLs are deliberately absent.
"""

from __future__ import annotations

from datetime import UTC, datetime

from prometheus_client import CollectorRegistry, Counter, Gauge, Histogram, generate_latest

from .database import Database
from .domain import FloodRiseService, parse_utc


class FloodRiseMetrics:
    """Application metrics and database-backed operational gauges."""

    def __init__(self, *, is_demo: bool = True) -> None:
        self.is_demo = is_demo
        self.registry = CollectorRegistry(auto_describe=True)
        latency_buckets = (0.05, 0.1, 0.25, 0.5, 0.75, 1, 2, 5, 15, 60)
        self.report_submit = Histogram(
            "floodrise_report_submit_seconds",
            "Flood report submission duration.",
            buckets=latency_buckets,
            registry=self.registry,
        )
        self.corroboration = Histogram(
            "floodrise_corroboration_seconds",
            "Report duration when a signal becomes community corroborated.",
            buckets=latency_buckets,
            registry=self.registry,
        )
        self.simulation = Histogram(
            "floodrise_simulation_seconds",
            "Rapid impact model publication duration.",
            buckets=latency_buckets,
            registry=self.registry,
        )
        self.route = Histogram(
            "floodrise_route_seconds",
            "Lower-risk route query duration.",
            buckets=latency_buckets,
            registry=self.registry,
        )
        self.outbox_oldest_age = Gauge(
            "floodrise_audit_outbox_oldest_age_seconds",
            "Age of the oldest persisted outbox event.",
            registry=self.registry,
        )
        self.outbox_depth = Gauge(
            "floodrise_audit_outbox_depth",
            "Number of retained persisted outbox events.",
            registry=self.registry,
        )
        self.source_age = Gauge(
            "floodrise_source_age_seconds",
            "Age of a source observation against the scenario clock.",
            ("source_id", "provider", "is_simulated"),
            registry=self.registry,
        )
        self.source_max_age = Gauge(
            "floodrise_source_max_age_seconds",
            "Maximum age allowed before a source is operationally stale.",
            ("source_id", "provider", "is_simulated"),
            registry=self.registry,
        )
        self.external_notification_attempt = Counter(
            "floodrise_notification_external_attempt",
            "Attempts to contact an external notification destination.",
            registry=self.registry,
        )

    def refresh_state(self, database: Database, service: FloodRiseService) -> None:
        """Refresh gauges from authoritative records immediately before scrape."""

        now = datetime.now(UTC)
        outbox = database.outbox_events(limit=1_000)
        self.outbox_depth.set(len(outbox))
        if outbox and not self.is_demo:
            occurred_at = outbox[0].get("occurred_at")
            age = max(0.0, (now - parse_utc(str(occurred_at))).total_seconds())
            self.outbox_oldest_age.set(age)
        else:
            self.outbox_oldest_age.set(0)

        self.source_age.clear()
        self.source_max_age.clear()
        scenario_now = service.scenario_clock
        for source in service.sources():
            labels = {
                "source_id": str(source["id"]),
                "provider": str(source["provider"]),
                "is_simulated": str(bool(source.get("is_simulated"))).lower(),
            }
            observed_at = parse_utc(str(source["observed_at"]))
            self.source_age.labels(**labels).set(
                max(0.0, (scenario_now - observed_at).total_seconds())
            )
            self.source_max_age.labels(**labels).set(
                max(0.0, float(source.get("maximum_age_seconds", 1_800)))
            )

    def render(self, database: Database, service: FloodRiseService) -> bytes:
        self.refresh_state(database, service)
        return generate_latest(self.registry)
