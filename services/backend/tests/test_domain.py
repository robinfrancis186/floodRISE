"""Domain and persistence tests for floodRISE's safety-critical invariants."""

from __future__ import annotations

from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Lock
from typing import Any

import pytest

from app.auth import Principal
from app.database import AuditRow, Database, EntityChange, EventInput
from app.domain import (
    CORROBORATION_MESSAGE,
    EXPIRY_MESSAGE,
    FloodRiseService,
    evidence_families,
)
from app.errors import AppError, ConflictError, PermissionDeniedError
from app.schemas import (
    ApprovalCreateInput,
    ApprovalDecisionInput,
    DemoAdvanceInput,
    ReportInput,
    RoadStatus,
    SignalDecisionInput,
)
from app.seed import seed_database

INCIDENT_ID = "inc-demo-kerala-flood-2023"


@pytest.fixture
def database() -> Iterator[Database]:
    value = Database("sqlite://")
    seed_database(value)
    try:
        yield value
    finally:
        value.engine.dispose()


@pytest.fixture
def service(database: Database) -> FloodRiseService:
    return FloodRiseService(database)


def _report_input(
    number: int,
    *,
    observed_at: str = "2023-12-04T14:00:00Z",
    reporter_id: str | None = None,
    device_id: str | None = None,
) -> ReportInput:
    return ReportInput.model_validate(
        {
            "client_report_id": f"domain-report-{number:02d}",
            "incident_id": INCIDENT_ID,
            "reporter_id": reporter_id or f"reporter-{number}",
            "device_id": device_id or f"device-{number}",
            "observed_at": observed_at,
            "location": {
                "latitude": 10.1065000 + number * 0.00004,
                "longitude": 76.3517000 + number * 0.00004,
                "accuracy_m": 20,
            },
            "water_depth": "KNEE",
            "road_status": "IMPASSABLE",
            "flood_status": "FLOODED",
        }
    )


def _submit(
    service: FloodRiseService,
    number: int,
    *,
    report: ReportInput | None = None,
    key: str | None = None,
    principal: Principal | None = None,
) -> tuple[int, dict[str, Any]]:
    return service.create_report(
        report or _report_input(number),
        idempotency_key=key or f"domain-key-{number}",
        principal=principal or Principal(f"user-{number}", "reporter", True),
    )


def _approval_input() -> ApprovalCreateInput:
    return ApprovalCreateInput.model_validate(
        {
            "incident_id": INCIDENT_ID,
            "action_type": "OFFICIAL_WARNING",
            "action_payload": {
                "title": "Official flood warning",
                "body": "Follow the reviewed official flood instructions.",
            },
            "audience": "Residents inside the approved warning geometry",
            "geometry": {"type": "Point", "coordinates": [76.3517000, 10.1065000]},
            "evidence_version": "evidence-demo-001",
            "model_version": "model-demo-20231204-001",
            "reason": "Issue a reviewed official warning.",
        }
    )


def test_database_seed_commit_outbox_and_hash_chain(database: Database) -> None:
    assert database.is_empty() is False
    incident = database.get("incident", INCIDENT_ID)
    assert incident is not None
    assert incident["id"] == INCIDENT_ID
    assert incident["is_simulated"] is True
    assert database.verify_audit_chain() is True
    assert [event["type"] for event in database.outbox_events()] == [
        "demo.reset",
        "approval.requested",
        "approval.requested",
        "approval.requested",
    ]
    assert len(database.list("approval")) == 3
    initial_signal = database.get("signal", "signal-aluva-042")
    assert initial_signal is not None
    assert initial_signal["state"] == "NEEDS_REVIEW"
    assert initial_signal["version"] == 1
    assert initial_signal["presentation_seed"] is True

    emitted = database.commit(
        changes=[EntityChange("probe", "probe-1", {"id": "probe-1", "version": 1}, 1)],
        events=[
            EventInput(
                event_type="probe.created",
                aggregate_kind="probe",
                aggregate_id="probe-1",
                aggregate_version=1,
                actor_id="test-system",
                actor_role="system",
                payload={"purpose": "verify atomic audit and outbox"},
                incident_id=INCIDENT_ID,
            )
        ],
    )

    assert database.get("probe", "probe-1") == {"id": "probe-1", "version": 1}
    assert len(emitted) == 1
    assert emitted[0]["type"] == "probe.created"
    events = list(reversed(database.audit_events()))
    assert [event["event_type"] for event in events] == [
        "demo.reset",
        "approval.requested",
        "approval.requested",
        "approval.requested",
        "probe.created",
    ]
    assert events[-1]["previous_hash"] == events[-2]["event_hash"]
    assert database.verify_audit_chain() is True


def test_idempotency_keys_are_hashed_at_rest(
    database: Database,
    service: FloodRiseService,
) -> None:
    raw_key = "private-offline-install-idempotency-key"
    status, _ = _submit(service, 61, key=raw_key)

    assert status == 201
    with database.engine.connect() as connection:
        row = connection.exec_driver_sql(
            "SELECT compound_key, idempotency_key FROM idempotency LIMIT 1"
        ).one()
    assert raw_key not in row.compound_key
    assert row.idempotency_key != raw_key
    assert len(row.idempotency_key) == 64


def test_competing_report_payloads_never_receive_the_wrong_idempotent_receipt(
    database: Database,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    services = [FloodRiseService(database), FloodRiseService(database)]
    reports = [
        _report_input(62),
        _report_input(62).model_copy(update={"road_status": RoadStatus.OPEN}),
    ]
    principal = Principal("same-authoritative-account", "reporter", True)
    barrier = Barrier(2)
    counter_lock = Lock()
    empty_reads = 0
    original = database.idempotent_response

    def synchronized_read(scope: str, key: str) -> tuple[int, dict[str, Any]] | None:
        nonlocal empty_reads
        result = original(scope, key)
        should_wait = False
        if result is None:
            with counter_lock:
                if empty_reads < 2:
                    empty_reads += 1
                    should_wait = True
        if should_wait:
            barrier.wait(timeout=2)
        return result

    monkeypatch.setattr(database, "idempotent_response", synchronized_read)

    def submit(index: int) -> str:
        try:
            services[index].create_report(
                reports[index],
                idempotency_key="concurrent-offline-key",
                principal=principal,
            )
            return "accepted"
        except ConflictError as exc:
            assert exc.code == "IDEMPOTENCY_KEY_REUSED"
            return "conflict"

    with ThreadPoolExecutor(max_workers=2) as executor:
        outcomes = list(executor.map(submit, range(2)))

    assert sorted(outcomes) == ["accepted", "conflict"]
    assert len(database.list("report")) == 1


def test_database_detects_a_tampered_audit_event(database: Database) -> None:
    event = database.audit_events(limit=1)[0]
    with database.Session.begin() as session:
        row = session.get(AuditRow, event["sequence"])
        assert row is not None
        row.payload = '{"reason":"rewritten history"}'

    assert database.verify_audit_chain() is False


def test_evidence_families_collapse_transitive_strong_identifiers() -> None:
    reports = [
        {"id": "a", "reporter_id": "person-a", "device_id": "device-a"},
        {"id": "b", "reporter_id": "person-a", "device_id": "device-b"},
        {"id": "c", "reporter_id": "person-c", "device_id": "device-b"},
        {"id": "d", "reporter_id": "person-d", "device_id": "device-d"},
    ]

    families = evidence_families(reports)

    assert {frozenset(item["id"] for item in family) for family in families} == {
        frozenset({"a", "b", "c"}),
        frozenset({"d"}),
    }


def test_evidence_families_collapse_when_any_private_media_hash_overlaps() -> None:
    reports = [
        {"id": "a", "account_id": "one", "media_independence_hashes": ["photo-a"]},
        {
            "id": "b",
            "account_id": "two",
            "media_independence_hashes": ["photo-a", "photo-b"],
        },
        {"id": "c", "account_id": "three", "media_independence_hashes": ["photo-c"]},
    ]

    families = evidence_families(reports)

    assert {frozenset(item["id"] for item in family) for family in families} == {
        frozenset({"a", "b"}),
        frozenset({"c"}),
    }


def test_report_idempotency_replays_without_new_evidence(service: FloodRiseService) -> None:
    report = _report_input(1)

    first_status, first = _submit(service, 1, report=report, key="stable-domain-key")
    replay_status, replay = _submit(service, 1, report=report, key="stable-domain-key")

    assert first_status == replay_status == 201
    assert first["replayed"] is False
    assert replay["replayed"] is True
    assert replay["report"]["id"] == first["report"]["id"]
    assert len(service.reports(INCIDENT_ID)) == 1


def test_corroboration_transition_is_independent_and_emits_one_caution(
    service: FloodRiseService, database: Database
) -> None:
    responses = [_submit(service, number)[1] for number in range(1, 6)]

    fourth = responses[3]["signal"]
    fifth = responses[4]["signal"]
    assert fourth["state"] == fifth["state"] == "COMMUNITY_CORROBORATED"
    assert fourth["independent_report_count"] == 4
    assert fifth["independent_report_count"] == 5
    assert fourth["display_message"] == CORROBORATION_MESSAGE
    assert fourth["confidence"] >= 0.75

    cautions = service.alerts(INCIDENT_ID)
    assert len(cautions) == 1
    assert cautions[0]["body"] == CORROBORATION_MESSAGE
    assert cautions[0]["official"] is False
    assert cautions[0]["caution_only"] is True
    event_types = [event["event_type"] for event in database.audit_events(limit=100)]
    assert event_types.count("signal.community_corroborated") == 1
    assert event_types.count("alert.caution_created") == 1
    assert event_types.count("route.recalculated") == 1


def test_first_report_replaces_the_presentation_checkpoint_with_real_evidence(
    service: FloodRiseService,
) -> None:
    states = [_submit(service, number)[1]["signal"] for number in range(1, 5)]

    assert [signal["state"] for signal in states] == [
        "CANDIDATE",
        "CORROBORATING",
        "CORROBORATING",
        "COMMUNITY_CORROBORATED",
    ]
    assert [signal["independent_report_count"] for signal in states] == [1, 2, 3, 4]
    assert states[0]["id"] == "signal-aluva-042"
    assert states[0]["version"] == 2
    assert "presentation_seed" not in states[0]


def test_same_reporter_and_install_contribute_only_one_vote(
    service: FloodRiseService,
) -> None:
    dispositions = []
    for number in range(1, 5):
        report = _report_input(
            number,
            reporter_id="shared-reporter",
            device_id="shared-device",
        )
        dispositions.append(_submit(service, number, report=report)[1]["report"]["disposition"])

    signal = service.signals(INCIDENT_ID)[0]
    assert dispositions == ["ELIGIBLE", "DUPLICATE", "DUPLICATE", "DUPLICATE"]
    assert signal["independent_report_count"] == 1
    assert signal["state"] == "CANDIDATE"
    assert service.alerts(INCIDENT_ID) == []


def test_late_report_and_expired_freshness_never_imply_all_clear(
    service: FloodRiseService,
) -> None:
    _, late = _submit(
        service,
        1,
        report=_report_input(1, observed_at="2023-12-04T13:00:00Z"),
    )
    _, fresh = _submit(service, 2)

    assert late["report"]["disposition"] == "LATE"
    assert late["report"]["eligible_for_live_signal"] is False
    assert late["receipt"]["sync_message"] == (
        "Historical report retained; it cannot trigger a live caution."
    )

    service.advance_demo(
        DemoAdvanceInput(minutes=121, inject_report_ids=[], run_simulation=False),
        Principal("demo-engineer", "engineer", True),
    )
    expired = service.signal(fresh["signal"]["id"])
    assert expired["state"] == "EXPIRED"
    assert expired["freshness"] == "EXPIRED"
    assert expired["display_message"] == EXPIRY_MESSAGE


def test_signal_review_enforces_optimistic_concurrency(service: FloodRiseService) -> None:
    signal = _submit(service, 1)[1]["signal"]
    reviewer = Principal("field-verifier", "verifier", True)

    with pytest.raises(
        ConflictError,
        match=f"Signal version is {signal['version']}; expected 99",
    ):
        service.decide_signal(
            signal["id"],
            SignalDecisionInput(
                decision="DISPUTE", reason="Conflicting field evidence", expected_version=99
            ),
            reviewer,
        )

    updated = service.decide_signal(
        signal["id"],
        SignalDecisionInput(
            decision="DISPUTE",
            reason="Conflicting field evidence",
            expected_version=signal["version"],
        ),
        reviewer,
    )
    assert updated["state"] == "DISPUTED"
    assert updated["version"] == signal["version"] + 1
    assert updated["human_review"]["reviewed_by"] == "field-verifier"


def test_two_person_approval_and_identity_admin_boundaries(
    service: FloodRiseService,
) -> None:
    request = _approval_input()
    requester = Principal("incident-lead", "incident_commander", True)
    approver = Principal("duty-verifier", "verifier", True)
    identity_admin = Principal("identity-admin", "identity_administrator", True)

    with pytest.raises(
        PermissionDeniedError, match="Identity administrators cannot request operational actions"
    ):
        service.create_approval(request, identity_admin)

    approval = service.create_approval(request, requester)
    decision = ApprovalDecisionInput(
        decision="APPROVE",
        reason="Evidence and audience were independently reviewed.",
        expected_version=approval["version"],
    )
    with pytest.raises(PermissionDeniedError, match="requester and approver must be different"):
        service.decide_approval(approval["id"], decision, requester)
    with pytest.raises(
        PermissionDeniedError, match="Identity administrators cannot approve operational actions"
    ):
        service.decide_approval(approval["id"], decision, identity_admin)

    approved, alert = service.decide_approval(approval["id"], decision, approver)
    assert approved["status"] == "APPROVED"
    assert approved["execution_status"] == "SUCCEEDED"
    assert approved["decided_by"] == "duty-verifier"
    assert alert is not None
    assert alert["status"] == "DISPATCHED"
    assert alert["official"] is True
    assert alert["gateway"] == "fake://notification-sink"
    assert len(service.alerts(INCIDENT_ID)) == 1


def test_expired_approval_cannot_be_dispatched(service: FloodRiseService) -> None:
    approval = service.create_approval(
        _approval_input(), Principal("incident-lead", "incident_commander", True)
    )
    service.advance_demo(
        DemoAdvanceInput(minutes=15, inject_report_ids=[], run_simulation=False),
        Principal("demo-engineer", "engineer", True),
    )

    with pytest.raises(AppError) as caught:
        service.decide_approval(
            approval["id"],
            ApprovalDecisionInput(
                decision="APPROVE", reason="Independent review completed", expected_version=1
            ),
            Principal("duty-verifier", "verifier", True),
        )

    assert caught.value.status_code == 410
    assert caught.value.code == "APPROVAL_EXPIRED"
    assert service.alerts(INCIDENT_ID) == []
    expired = service.database.get("approval", approval["id"])
    assert expired is not None
    assert expired["status"] == "EXPIRED"


def test_service_publishes_simulation_and_lower_risk_routes(
    service: FloodRiseService,
) -> None:
    simulation = service.run_simulation(
        INCIDENT_ID,
        trigger="domain acceptance test",
        principal=Principal("hydrology-engineer", "engineer", True),
    )
    routes = service.recommend_routes(
        INCIDENT_ID,
        origin_node="aluva",
        max_alternatives=3,
        principal=Principal("field-responder", "responder", True),
    )

    assert simulation["status"] == "PUBLISHED"
    assert simulation["kind"] == "rapid impact estimate"
    assert simulation["ensemble_members"] == 9
    assert routes["status"] == "ROUTES_AVAILABLE"
    assert 1 <= len(routes["alternatives"]) <= 3
    assert routes["disclaimer"].startswith("Lower-risk route estimate")
    assert "safe" not in routes["disclaimer"].lower()
    assert all(
        route["model_version"] == routes["model_version"] for route in routes["alternatives"]
    )
