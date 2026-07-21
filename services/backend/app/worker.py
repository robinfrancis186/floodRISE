"""Celery entry point for versioned simulation and route jobs.

The deterministic demo keeps these jobs eager and in-process so it remains
fully usable without AWS. Staging and production use the exact SQS queue URL
injected into the ECS task and rely on the task role for credentials.
"""

from __future__ import annotations

from typing import Any

from celery import Celery

from .auth import Principal
from .config import Settings, get_settings
from .database import Database
from .domain import FloodRiseService
from .main import _database_url_for_sync
from .seed import seed_database


def _system_principal(role: str) -> Principal:
    return Principal(
        user_id="floodrise-worker",
        role=role,
        authenticated=True,
        roles=frozenset({role}),
        auth_source="worker_task_role",
    )


def create_celery_app(runtime: Settings | None = None) -> Celery:
    settings = runtime or get_settings()
    queue_name = settings.jobs_queue_name
    broker_url = "memory://"
    transport_options: dict[str, Any] = {}

    if not settings.is_demo:
        if not settings.jobs_queue_url:
            raise RuntimeError("FLOODRISE_JOBS_QUEUE_URL is required outside demo mode")
        if not settings.jobs_queue_url.startswith("https://"):
            raise RuntimeError("FLOODRISE_JOBS_QUEUE_URL must be an HTTPS SQS queue URL")
        broker_url = "sqs://"
        transport_options = {
            "predefined_queues": {queue_name: {"url": settings.jobs_queue_url}},
            "visibility_timeout": settings.worker_visibility_timeout_seconds,
            "polling_interval": 1,
        }

    application = Celery("floodrise", broker=broker_url)
    application.conf.update(
        broker_transport_options=transport_options,
        task_default_queue=queue_name,
        task_serializer="json",
        accept_content=["json"],
        result_backend=None,
        task_ignore_result=True,
        task_acks_late=True,
        task_reject_on_worker_lost=True,
        worker_prefetch_multiplier=1,
        task_always_eager=settings.is_demo,
        task_eager_propagates=True,
        timezone="UTC",
        enable_utc=True,
    )
    return application


celery_app = create_celery_app()


def _service() -> tuple[Database, FloodRiseService]:
    runtime = get_settings()
    database = Database(_database_url_for_sync(runtime.database_url))
    database.initialize()
    seed_database(database)
    return database, FloodRiseService(database)


@celery_app.task(name="floodrise.simulation.run")
def run_simulation_job(incident_id: str, trigger: str) -> dict[str, Any]:
    database, service = _service()
    try:
        return service.run_simulation(
            incident_id,
            trigger=trigger,
            principal=_system_principal("engineer"),
        )
    finally:
        database.engine.dispose()


@celery_app.task(name="floodrise.routes.recalculate")
def recalculate_routes_job(
    incident_id: str,
    origin_node: str | None = None,
    max_alternatives: int = 3,
) -> dict[str, Any]:
    database, service = _service()
    try:
        return service.recommend_routes(
            incident_id,
            origin_node=origin_node,
            max_alternatives=max(1, min(max_alternatives, 3)),
            principal=_system_principal("responder"),
        )
    finally:
        database.engine.dispose()


__all__ = [
    "celery_app",
    "create_celery_app",
    "recalculate_routes_job",
    "run_simulation_job",
]
