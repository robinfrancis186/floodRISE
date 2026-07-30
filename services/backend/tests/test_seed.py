"""Seed migration checks for deterministic demo installations."""

import pytest

from app.database import Database, EntityChange
from app.seed import seed_database


def test_seed_database_replaces_only_the_legacy_chennai_demo() -> None:
    database = Database("sqlite://")
    database.initialize()
    legacy_incident = {
        "id": "inc-demo-michaung-2023",
        "scenario_id": "demo-michaung-chennai-v1",
        "title": "Cyclone Michaung — Chennai deterministic replay",
        "is_demo": True,
        "version": 1,
    }
    database.reset(
        changes=[EntityChange("incident", legacy_incident["id"], legacy_incident, 1)],
        state={
            "scenario_id": "demo-michaung-chennai-v1",
            "incident_id": "inc-demo-michaung-2023",
        },
    )

    seed_database(database, is_demo=True)

    assert database.get("incident", "inc-demo-michaung-2023") is None
    kerala = database.get("incident", "inc-demo-kerala-flood-2023")
    assert kerala is not None
    assert kerala["scenario_id"] == "demo-kerala-flood-v1"
    assert database.get_state("scenario_id") == "demo-kerala-flood-v1"


def test_seed_database_preserves_non_demo_existing_records() -> None:
    database = Database("sqlite://")
    database.initialize()
    incident = {
        "id": "inc-authority-owned",
        "scenario_id": "authority-event-v1",
        "title": "Authority-owned incident",
        "is_demo": False,
        "version": 1,
    }
    database.reset(
        changes=[EntityChange("incident", incident["id"], incident, 1)],
        state={"scenario_id": "authority-event-v1", "incident_id": incident["id"]},
    )

    seed_database(database, is_demo=False)

    assert database.get("incident", incident["id"]) == incident
    assert database.get("incident", "inc-demo-kerala-flood-2023") is None


def test_demo_runtime_refuses_authority_incident_without_mode_state() -> None:
    database = Database("sqlite://")
    database.initialize()
    incident = {
        "id": "inc-authority-owned-unmarked-storage",
        "scenario_id": "authority-event-v1",
        "title": "Authority-owned incident",
        "is_demo": False,
        "is_simulated": False,
        "version": 1,
    }
    database.reset(
        changes=[EntityChange("incident", incident["id"], incident, 1)],
        state={"scenario_id": "authority-event-v1", "incident_id": incident["id"]},
    )

    assert database.get_state("demo_mode") is None

    with pytest.raises(RuntimeError, match="cannot open authority-owned live storage"):
        seed_database(database, is_demo=True)

    assert database.get("incident", incident["id"]) == incident
    assert database.get("incident", "inc-demo-kerala-flood-2023") is None


def test_empty_non_demo_database_remains_empty() -> None:
    database = Database("sqlite://")

    seed_database(database, is_demo=False)

    assert database.is_empty() is True
    assert database.get_state("incident_id") is None
    assert database.list("approval") == []


def test_non_demo_runtime_refuses_persisted_demo_storage() -> None:
    database = Database("sqlite://")
    seed_database(database, is_demo=True)

    with pytest.raises(RuntimeError, match="cannot open storage containing demo"):
        seed_database(database, is_demo=False)
