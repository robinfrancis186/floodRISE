"""Cloud Run Job adapter tests."""

from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Lock
from typing import Any

import pytest
from pydantic import ValidationError

from app.config import (
    Settings,
    SimulationJobSettings,
    get_simulation_job_settings,
)
from app.database import Database, EventInput
from app.errors import ConflictError
from app.gcp_job import SIMULATION_TRIGGER_EVENT_TYPE, main, run_job
from app.seed import seed_database

EVENT_ID = "evt-53050000-0000-4000-8000-000000000001"
INCIDENT_ID = "inc-demo-kerala-flood-2023"


def _demo_settings(database_url: str) -> Settings:
    return Settings(env="test", demo_mode=True, database_url=database_url)


def _create_simulation_trigger(
    database_url: str,
    *,
    event_type: str = SIMULATION_TRIGGER_EVENT_TYPE,
    incident_id: str = INCIDENT_ID,
    resource_id: str = INCIDENT_ID,
) -> str:
    database = Database(database_url)
    try:
        seed_database(database, is_demo=True)
        emitted = database.commit(
            events=[
                EventInput(
                    event_type=event_type,
                    aggregate_kind="incident",
                    aggregate_id=resource_id,
                    aggregate_version=1,
                    actor_id="simulation-scheduler",
                    actor_role="system",
                    payload={
                        "operation": "simulation",
                        "trigger": "authorized simulation trigger",
                    },
                    incident_id=incident_id,
                )
            ]
        )
        return str(emitted[0]["id"])
    finally:
        database.engine.dispose()


def _assert_single_publication(database_url: str, receipt: dict[str, Any]) -> None:
    database = Database(database_url)
    try:
        simulation = database.get("simulation", receipt["model_version"])
        impact = database.get("impact", f"impact-{receipt['model_version']}")
        assert simulation is not None
        assert impact is not None
        assert simulation["version"] == 1
        assert impact["version"] == 1
        assert (
            len(
                [
                    event
                    for event in database.audit_events(limit=1_000)
                    if event["event_type"] == "simulation.published"
                    and event["aggregate_id"] == receipt["model_version"]
                ]
            )
            == 1
        )
        assert (
            len(
                [
                    event
                    for event in database.outbox_events(limit=1_000)
                    if event["type"] == "simulation.published"
                    and event["resource_id"] == receipt["model_version"]
                ]
            )
            == 1
        )
    finally:
        database.engine.dispose()


@pytest.fixture(autouse=True)
def authoritative_event_id(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FLOODRISE_JOB_EVENT_ID", EVENT_ID)


def test_cloud_run_job_publishes_the_versioned_demo_model(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database_url = f"sqlite:///{tmp_path / 'job.sqlite3'}"
    event_id = _create_simulation_trigger(database_url)
    monkeypatch.setenv("FLOODRISE_JOB_EVENT_ID", event_id)
    monkeypatch.setenv("FLOODRISE_JOB_OPERATION", "simulation")
    monkeypatch.setenv("FLOODRISE_JOB_INCIDENT_ID", INCIDENT_ID)
    monkeypatch.setenv("FLOODRISE_JOB_TRIGGER", "ten-minute incident schedule")

    receipt = run_job(_demo_settings(database_url))

    assert receipt == {
        "event_id": event_id,
        "operation": "simulation",
        "incident_id": INCIDENT_ID,
        "resource_id": receipt["model_version"],
        "model_version": receipt["model_version"],
        "evidence_version": receipt["evidence_version"],
        "status": "PUBLISHED",
        "is_simulated": True,
    }
    assert receipt["model_version"].startswith("rapid-impact-v1-")
    assert receipt["evidence_version"].startswith("evidence-")


def test_cloud_run_job_rejects_event_id_missing_from_authoritative_outbox(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database_url = f"sqlite:///{tmp_path / 'job-missing-event.sqlite3'}"
    database = Database(database_url)
    seed_database(database, is_demo=True)
    database.engine.dispose()
    monkeypatch.setenv("FLOODRISE_JOB_OPERATION", "simulation")
    monkeypatch.setenv("FLOODRISE_JOB_INCIDENT_ID", INCIDENT_ID)
    monkeypatch.setenv("FLOODRISE_JOB_TRIGGER", "ten-minute incident schedule")

    with pytest.raises(RuntimeError, match="authoritative outbox"):
        run_job(_demo_settings(database_url))

    verifier = Database(database_url)
    try:
        assert verifier.idempotent_response("simulation.run", EVENT_ID) is None
    finally:
        verifier.engine.dispose()


@pytest.mark.parametrize(
    ("event_type", "event_incident_id", "resource_id", "message"),
    [
        ("signal.updated", INCIDENT_ID, INCIDENT_ID, "simulation.requested"),
        (
            SIMULATION_TRIGGER_EVENT_TYPE,
            "inc-demo-other-flood",
            INCIDENT_ID,
            "outbox incident",
        ),
        (
            SIMULATION_TRIGGER_EVENT_TYPE,
            INCIDENT_ID,
            "inc-demo-other-resource",
            "outbox resource",
        ),
    ],
)
def test_cloud_run_job_rejects_wrong_authoritative_outbox_binding(
    event_type: str,
    event_incident_id: str,
    resource_id: str,
    message: str,
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database_url = f"sqlite:///{tmp_path / 'job-wrong-event.sqlite3'}"
    event_id = _create_simulation_trigger(
        database_url,
        event_type=event_type,
        incident_id=event_incident_id,
        resource_id=resource_id,
    )
    monkeypatch.setenv("FLOODRISE_JOB_EVENT_ID", event_id)
    monkeypatch.setenv("FLOODRISE_JOB_OPERATION", "simulation")
    monkeypatch.setenv("FLOODRISE_JOB_INCIDENT_ID", INCIDENT_ID)
    monkeypatch.setenv("FLOODRISE_JOB_TRIGGER", "ten-minute incident schedule")

    with pytest.raises(RuntimeError, match=message):
        run_job(_demo_settings(database_url))

    database = Database(database_url)
    try:
        assert database.idempotent_response("simulation.run", event_id) is None
        assert not any(
            event["event_type"] == "simulation.published"
            for event in database.audit_events(limit=1_000)
        )
    finally:
        database.engine.dispose()


def test_cloud_run_job_retry_returns_original_receipt_without_republishing(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database_url = f"sqlite:///{tmp_path / 'job-retry.sqlite3'}"
    event_id = _create_simulation_trigger(database_url)
    monkeypatch.setenv("FLOODRISE_JOB_EVENT_ID", event_id)
    monkeypatch.setenv("FLOODRISE_JOB_OPERATION", "simulation")
    monkeypatch.setenv("FLOODRISE_JOB_INCIDENT_ID", INCIDENT_ID)
    monkeypatch.setenv("FLOODRISE_JOB_TRIGGER", "ten-minute incident schedule")

    first = run_job(_demo_settings(database_url))
    retry = run_job(_demo_settings(database_url))

    assert retry == first
    _assert_single_publication(database_url, first)


def test_concurrent_cloud_run_job_retries_publish_once(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database_url = f"sqlite:///{tmp_path / 'job-concurrent-retry.sqlite3'}"
    event_id = _create_simulation_trigger(database_url)
    monkeypatch.setenv("FLOODRISE_JOB_EVENT_ID", event_id)
    monkeypatch.setenv("FLOODRISE_JOB_OPERATION", "simulation")
    monkeypatch.setenv("FLOODRISE_JOB_INCIDENT_ID", INCIDENT_ID)
    monkeypatch.setenv("FLOODRISE_JOB_TRIGGER", "corroborated signal update")

    barrier = Barrier(2)
    counter_lock = Lock()
    empty_reads = 0
    original = Database.idempotent_response

    def synchronized_read(
        database: Database,
        scope: str,
        key: str,
    ) -> tuple[int, dict[str, Any]] | None:
        nonlocal empty_reads
        result = original(database, scope, key)
        should_wait = False
        if scope == "simulation.run" and key == event_id and result is None:
            with counter_lock:
                if empty_reads < 2:
                    empty_reads += 1
                    should_wait = True
        if should_wait:
            barrier.wait(timeout=5)
        return result

    monkeypatch.setattr(Database, "idempotent_response", synchronized_read)

    def execute_job(_index: int) -> dict[str, Any]:
        return run_job(_demo_settings(database_url))

    with ThreadPoolExecutor(max_workers=2) as executor:
        receipts = list(executor.map(execute_job, range(2)))

    assert receipts[0] == receipts[1]
    _assert_single_publication(database_url, receipts[0])


def test_cloud_run_job_event_id_cannot_be_reused_for_different_trigger(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    database_url = f"sqlite:///{tmp_path / 'job-event-reuse.sqlite3'}"
    event_id = _create_simulation_trigger(database_url)
    monkeypatch.setenv("FLOODRISE_JOB_EVENT_ID", event_id)
    monkeypatch.setenv("FLOODRISE_JOB_OPERATION", "simulation")
    monkeypatch.setenv("FLOODRISE_JOB_INCIDENT_ID", INCIDENT_ID)
    monkeypatch.setenv("FLOODRISE_JOB_TRIGGER", "ten-minute incident schedule")
    first = run_job(_demo_settings(database_url))

    monkeypatch.setenv("FLOODRISE_JOB_TRIGGER", "a different simulation trigger")
    with pytest.raises(ConflictError) as caught:
        run_job(_demo_settings(database_url))

    assert caught.value.code == "IDEMPOTENCY_KEY_REUSED"
    _assert_single_publication(database_url, first)


def test_cloud_run_job_rejects_unlisted_operations_before_opening_storage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FLOODRISE_JOB_OPERATION", "shell")
    monkeypatch.setenv("FLOODRISE_JOB_INCIDENT_ID", "inc-demo-kerala-flood-2023")

    with pytest.raises(RuntimeError, match="must be one of: simulation"):
        run_job(_demo_settings("sqlite://"))


@pytest.mark.parametrize(
    ("name", "value", "message"),
    [
        ("FLOODRISE_JOB_EVENT_ID", "", "FLOODRISE_JOB_EVENT_ID is required"),
        ("FLOODRISE_JOB_EVENT_ID", "evt-not-a-uuid", "must be an authoritative evt-UUID"),
        ("FLOODRISE_JOB_INCIDENT_ID", "", "FLOODRISE_JOB_INCIDENT_ID is required"),
        ("FLOODRISE_JOB_TRIGGER", "x", "between 3 and 200"),
    ],
)
def test_cloud_run_job_validates_execution_overrides(
    name: str,
    value: str,
    message: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FLOODRISE_JOB_OPERATION", "simulation")
    monkeypatch.setenv("FLOODRISE_JOB_INCIDENT_ID", "inc-demo-kerala-flood-2023")
    monkeypatch.setenv("FLOODRISE_JOB_TRIGGER", "scheduled run")
    monkeypatch.setenv(name, value)

    with pytest.raises(RuntimeError, match=message):
        run_job(_demo_settings("sqlite://"))


def test_cloud_run_job_loads_only_job_credentials_in_production(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FLOODRISE_ENV", "production")
    monkeypatch.setenv("FLOODRISE_DEMO_MODE", "false")
    monkeypatch.setenv(
        "FLOODRISE_DATABASE_URL",
        "postgresql+psycopg://simulation@example.invalid/floodrise?sslmode=require",
    )
    monkeypatch.setenv("FLOODRISE_DATABASE_ALLOWED_HOST", "example.invalid")
    for name in (
        "FLOODRISE_OIDC_ISSUER",
        "FLOODRISE_OIDC_JWKS_URL",
        "FLOODRISE_SESSION_SECRET",
    ):
        monkeypatch.delenv(name, raising=False)
    get_simulation_job_settings.cache_clear()

    settings = get_simulation_job_settings()

    assert isinstance(settings, SimulationJobSettings)
    assert settings.env == "production"
    assert settings.is_demo is False
    assert settings.database_url.startswith("postgresql+psycopg://simulation@")
    assert not hasattr(settings, "session_secret")
    assert not hasattr(settings, "oidc_issuer")
    get_simulation_job_settings.cache_clear()


@pytest.mark.parametrize(
    ("database_url", "allowed_host"),
    [
        ("sqlite:///simulation.db", "database.internal"),
        ("postgresql+psycopg://database.internal/floodrise", "database.internal"),
        (
            "postgresql+psycopg://database.internal/floodrise?sslmode=disable",
            "database.internal",
        ),
        (
            "postgresql+psycopg://database.internal/floodrise?sslmode=require",
            "different.internal",
        ),
    ],
)
def test_live_simulation_settings_require_encrypted_approved_database_target(
    database_url: str,
    allowed_host: str,
) -> None:
    with pytest.raises(ValidationError, match="simulation database"):
        SimulationJobSettings(
            env="production",
            demo_mode=False,
            database_url=database_url,
            database_allowed_host=allowed_host,
        )


@pytest.mark.parametrize(
    ("database_url", "allowed_host"),
    [
        ("sqlite:///simulation.db", "10.53.0.8"),
        ("postgresql+psycopg://10.53.0.8/floodrise", "10.53.0.8"),
        (
            "postgresql+psycopg://10.53.0.8/floodrise?sslmode=disable",
            "10.53.0.8",
        ),
        (
            "postgresql+psycopg://10.53.0.8/floodrise?sslmode=require",
            "10.53.0.9",
        ),
    ],
)
def test_remote_demo_simulation_settings_require_encrypted_approved_database_target(
    database_url: str,
    allowed_host: str,
) -> None:
    with pytest.raises(ValidationError, match="simulation database"):
        SimulationJobSettings(
            env="demo",
            demo_mode=True,
            database_url=database_url,
            database_allowed_host=allowed_host,
        )


def test_cloud_run_demo_environment_rejects_local_database_when_remote_host_is_injected(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("FLOODRISE_ENV", "demo")
    monkeypatch.setenv("FLOODRISE_DEMO_MODE", "true")
    monkeypatch.setenv("FLOODRISE_DATABASE_URL", "sqlite:///ephemeral-job.sqlite3")
    monkeypatch.setenv("FLOODRISE_DATABASE_ALLOWED_HOST", "10.53.0.8")
    get_simulation_job_settings.cache_clear()

    try:
        with pytest.raises(ValidationError, match="simulation database"):
            get_simulation_job_settings()
    finally:
        get_simulation_job_settings.cache_clear()


def test_remote_demo_simulation_settings_accept_the_exact_encrypted_database_target() -> None:
    settings = SimulationJobSettings(
        env="demo",
        demo_mode=True,
        database_url=("postgresql+psycopg://simulation@10.53.0.8/floodrise?sslmode=verify-full"),
        database_allowed_host="10.53.0.8",
    )

    assert settings.database_allowed_host == "10.53.0.8"
    assert settings.database_url.endswith("sslmode=verify-full")


def test_local_demo_simulation_settings_preserve_sqlite_without_a_remote_marker(
    tmp_path,
) -> None:
    database_url = f"sqlite:///{tmp_path / 'local-job.sqlite3'}"

    settings = SimulationJobSettings(
        env="demo",
        demo_mode=True,
        database_url=database_url,
    )

    assert settings.database_url == database_url
    assert settings.database_allowed_host is None


def test_cloud_run_job_stdout_is_a_bounded_receipt(
    tmp_path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    settings = _demo_settings(f"sqlite:///{tmp_path / 'stdout.sqlite3'}")
    event_id = _create_simulation_trigger(settings.database_url)
    monkeypatch.setenv("FLOODRISE_JOB_EVENT_ID", event_id)
    monkeypatch.setenv("FLOODRISE_JOB_INCIDENT_ID", INCIDENT_ID)
    monkeypatch.setattr("app.gcp_job.get_simulation_job_settings", lambda: settings)

    main()

    payload = json.loads(capsys.readouterr().out)
    assert set(payload) == {
        "evidence_version",
        "event_id",
        "incident_id",
        "is_simulated",
        "model_version",
        "operation",
        "resource_id",
        "status",
    }
    assert payload["event_id"] == event_id
    assert "database" not in payload
    assert "token" not in payload
