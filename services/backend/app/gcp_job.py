"""Cloud Run Job entry point for deterministic, versioned model publication.

The API keeps short competition-demo requests synchronous, while this command
provides the same authoritative domain operation to a scheduled or explicitly
executed Cloud Run Job. Cloud Run supplies project identity and per-execution
environment overrides; no credential or incident payload is accepted on the
command line.
"""

from __future__ import annotations

import json
import os
import re
from typing import Any

from .auth import Principal
from .config import Settings, SimulationJobSettings, get_simulation_job_settings
from .database import Database
from .domain import FloodRiseService
from .seed import seed_database

SUPPORTED_OPERATIONS = frozenset({"simulation"})
# The asynchronous dispatcher must originate from this exact persisted outbox
# event. A published-result event is intentionally not accepted as a trigger.
SIMULATION_TRIGGER_EVENT_TYPE = "simulation.requested"
_EVENT_ID_PATTERN = re.compile(
    r"^evt-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)


def _database_url_for_sync(url: str) -> str:
    return url.replace("postgresql+asyncpg://", "postgresql+psycopg://").replace(
        "sqlite+aiosqlite://", "sqlite://"
    )


def _required_environment(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"{name} is required for a Cloud Run Job execution")
    return value


def _required_event_id() -> str:
    event_id = _required_environment("FLOODRISE_JOB_EVENT_ID")
    if not _EVENT_ID_PATTERN.fullmatch(event_id):
        raise RuntimeError("FLOODRISE_JOB_EVENT_ID must be an authoritative evt-UUID")
    return event_id


def _system_principal() -> Principal:
    return Principal(
        user_id="floodrise-cloud-run-job",
        role="engineer",
        authenticated=True,
        roles=frozenset({"engineer"}),
        auth_source="gcp_workload_identity",
    )


def _require_authoritative_trigger(
    database: Database,
    *,
    event_id: str,
    incident_id: str,
) -> None:
    event = database.outbox_event(event_id)
    if event is None:
        raise RuntimeError("FLOODRISE_JOB_EVENT_ID is not present in the authoritative outbox")
    if event["type"] != SIMULATION_TRIGGER_EVENT_TYPE:
        raise RuntimeError(
            "FLOODRISE_JOB_EVENT_ID must reference a simulation.requested outbox event"
        )
    if event["incident_id"] != incident_id:
        raise RuntimeError(
            "FLOODRISE_JOB_EVENT_ID outbox incident does not match FLOODRISE_JOB_INCIDENT_ID"
        )
    if event["resource_id"] != incident_id:
        raise RuntimeError(
            "FLOODRISE_JOB_EVENT_ID outbox resource does not match FLOODRISE_JOB_INCIDENT_ID"
        )


def run_job(runtime: Settings | SimulationJobSettings | None = None) -> dict[str, Any]:
    """Execute one allow-listed operation and return a non-sensitive receipt."""

    settings = runtime or get_simulation_job_settings()
    event_id = _required_event_id()
    operation = os.environ.get("FLOODRISE_JOB_OPERATION", "simulation").strip().lower()
    if operation not in SUPPORTED_OPERATIONS:
        raise RuntimeError(
            "FLOODRISE_JOB_OPERATION must be one of: " + ", ".join(sorted(SUPPORTED_OPERATIONS))
        )

    incident_id = _required_environment("FLOODRISE_JOB_INCIDENT_ID")
    trigger = os.environ.get("FLOODRISE_JOB_TRIGGER", "scheduled Cloud Run Job").strip()
    if not 3 <= len(trigger) <= 200:
        raise RuntimeError("FLOODRISE_JOB_TRIGGER must contain between 3 and 200 characters")

    database = Database(_database_url_for_sync(settings.database_url))
    try:
        if settings.is_demo:
            seed_database(database, is_demo=True)
        _require_authoritative_trigger(
            database,
            event_id=event_id,
            incident_id=incident_id,
        )
        service = FloodRiseService(
            database,
            is_demo=settings.is_demo,
            route_max_snap_distance_m=settings.route_max_snap_distance_m,
            alert_sink=settings.demo_alert_sink if settings.is_demo else None,
        )
        result = service.run_simulation(
            incident_id,
            trigger=trigger,
            principal=_system_principal(),
            idempotency_key=event_id,
        )
        return {
            "event_id": event_id,
            "operation": operation,
            "incident_id": incident_id,
            "resource_id": result["id"],
            "model_version": result["model_version"],
            "evidence_version": result["evidence_version"],
            "status": result["status"],
            "is_simulated": result["is_simulated"],
        }
    finally:
        database.engine.dispose()


def main() -> None:
    print(json.dumps(run_job(), sort_keys=True, separators=(",", ":")))


if __name__ == "__main__":  # pragma: no cover - exercised through the container command
    main()


__all__ = ["SIMULATION_TRIGGER_EVENT_TYPE", "SUPPORTED_OPERATIONS", "main", "run_job"]
