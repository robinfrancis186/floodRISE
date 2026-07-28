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
    seed_database(value, is_demo=True)
    try:
        yield value
    finally:
        value.engine.dispose()


@pytest.fixture
def service(database: Database) -> FloodRiseService:
    return FloodRiseService(
        database,
        is_demo=True,
        alert_sink="fake://notification-sink",
    )


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
    services = [
        FloodRiseService(
            database,
            is_demo=True,
            alert_sink="fake://notification-sink",
        ),
        FloodRiseService(
            database,
            is_demo=True,
            alert_sink="fake://notification-sink",
        ),
    ]
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


def test_two_processes_cannot_commit_conflicting_approval_decisions(tmp_path) -> None:
    database_url = f"sqlite:///{tmp_path / 'approval-race.sqlite3'}"
    first_database = Database(database_url)
    seed_database(first_database, is_demo=True)
    second_database = Database(database_url)
    second_database.initialize()
    first_service = FloodRiseService(
        first_database,
        is_demo=True,
        alert_sink="fake://notification-sink",
    )
    second_service = FloodRiseService(
        second_database,
        is_demo=True,
        alert_sink="fake://notification-sink",
    )
    approval = first_service.create_approval(
        _approval_input().model_copy(update={"reason": "Race exactly one authoritative decision."}),
        Principal("race-requester", "incident_commander", True),
    )

    barrier = Barrier(2)
    original_gets = [first_database.get, second_database.get]

    def synchronized_get(original: Any) -> Any:
        def read(kind: str, entity_id: str) -> dict[str, Any] | None:
            value = original(kind, entity_id)
            if kind == "approval" and entity_id == approval["id"]:
                barrier.wait(timeout=5)
            return value

        return read

    first_database.get = synchronized_get(original_gets[0])  # type: ignore[method-assign]
    second_database.get = synchronized_get(original_gets[1])  # type: ignore[method-assign]

    def decide(index: int) -> str:
        service = (first_service, second_service)[index]
        decision = ("APPROVE", "REJECT")[index]
        try:
            service.decide_approval(
                approval["id"],
                ApprovalDecisionInput(
                    decision=decision,
                    reason=f"Independent {decision.lower()} race decision.",
                    expected_version=1,
                ),
                Principal(f"race-reviewer-{index}", "verifier", True),
            )
            return decision
        except ConflictError as exc:
            assert exc.code == "VERSION_CONFLICT"
            return "CONFLICT"

    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            outcomes = list(executor.map(decide, range(2)))
    finally:
        first_database.get = original_gets[0]  # type: ignore[method-assign]
        second_database.get = original_gets[1]  # type: ignore[method-assign]

    assert outcomes.count("CONFLICT") == 1
    winner = next(outcome for outcome in outcomes if outcome != "CONFLICT")
    persisted = first_database.get("approval", approval["id"])
    assert persisted is not None
    assert persisted["status"] == ("APPROVED" if winner == "APPROVE" else "REJECTED")
    alerts = [
        alert
        for alert in first_service.alerts(INCIDENT_ID)
        if alert.get("approval_request_id") == approval["id"]
    ]
    assert bool(alerts) is (winner == "APPROVE")
    decision_events = [
        event
        for event in first_database.audit_events(limit=100)
        if event["aggregate_id"] == approval["id"]
        and event["event_type"] in {"approval.approved", "approval.rejected"}
    ]
    assert len(decision_events) == 1
    all_events = first_database.audit_events(limit=1_000)
    assert len({event["previous_hash"] for event in all_events}) == len(all_events)
    assert first_database.verify_audit_chain() is True
    assert second_database.verify_audit_chain() is True
    first_database.engine.dispose()
    second_database.engine.dispose()


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
        dispositions.append(
            _submit(
                service,
                number,
                report=report,
                principal=Principal("shared-account", "reporter", True),
            )[1]["report"]["disposition"]
        )

    signal = service.signals(INCIDENT_ID)[0]
    assert dispositions == ["ELIGIBLE", "DUPLICATE", "DUPLICATE", "DUPLICATE"]
    assert signal["independent_report_count"] == 1
    assert signal["state"] == "CANDIDATE"
    assert service.alerts(INCIDENT_ID) == []


def test_signed_install_identity_overrides_rotated_client_device_ids(
    service: FloodRiseService,
) -> None:
    shared_install = "server-signed-install-family"
    first = _submit(
        service,
        81,
        report=_report_input(81, device_id="forged-device-a"),
        principal=Principal(
            "account-a",
            "reporter",
            True,
            install_id_digest=shared_install,
        ),
    )[1]
    second = _submit(
        service,
        82,
        report=_report_input(82, device_id="forged-device-b"),
        principal=Principal(
            "account-b",
            "reporter",
            True,
            install_id_digest=shared_install,
        ),
    )[1]

    assert first["report"]["device_id"] == shared_install
    assert second["report"]["device_id"] == shared_install
    assert [first["report"]["disposition"], second["report"]["disposition"]] == [
        "ELIGIBLE",
        "DUPLICATE",
    ]
    assert second["signal"]["independent_report_count"] == 1


def test_live_report_requires_a_signed_install_identity(database: Database) -> None:
    live_service = FloodRiseService(database, is_demo=False, alert_sink=None)

    with pytest.raises(PermissionDeniedError, match="signed install identity"):
        live_service.create_report(
            _report_input(91),
            idempotency_key="missing-live-install",
            principal=Principal(
                "live-reporter",
                "reporter",
                True,
                auth_source="oidc_bearer",
            ),
        )


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


def test_approval_requires_existing_bound_versions_and_detects_binding_drift(
    service: FloodRiseService,
) -> None:
    baseline_count = len(service.approvals(INCIDENT_ID))
    invalid = _approval_input().model_copy(update={"evidence_version": "evidence-does-not-exist"})
    with pytest.raises(AppError) as caught:
        service.create_approval(
            invalid,
            Principal("invalid-binding-requester", "incident_commander", True),
        )
    assert caught.value.status_code == 422
    assert caught.value.code == "INVALID_EVIDENCE_BINDING"
    assert len(service.approvals(INCIDENT_ID)) == baseline_count
    invalid_model = _approval_input().model_copy(update={"model_version": "model-does-not-exist"})
    with pytest.raises(AppError) as missing_model:
        service.create_approval(
            invalid_model,
            Principal("invalid-model-requester", "incident_commander", True),
        )
    assert missing_model.value.status_code == 422
    assert missing_model.value.code == "INVALID_MODEL_BINDING"
    assert len(service.approvals(INCIDENT_ID)) == baseline_count

    approval = service.create_approval(
        _approval_input().model_copy(update={"reason": "Binding drift must invalidate approval."}),
        Principal("binding-requester", "incident_commander", True),
    )
    signal = service.signal("signal-aluva-042")
    service.decide_signal(
        signal["id"],
        SignalDecisionInput(
            decision="DISPUTE",
            reason="New field evidence changed the reviewed record.",
            expected_version=signal["version"],
        ),
        Principal("binding-reviewer", "verifier", True),
    )

    with pytest.raises(ConflictError) as drift:
        service.decide_approval(
            approval["id"],
            ApprovalDecisionInput(
                decision="APPROVE",
                reason="Attempt to approve a stale binding.",
                expected_version=1,
            ),
            Principal("binding-approver", "verifier", True),
        )
    assert drift.value.code == "APPROVAL_BINDING_CHANGED"
    assert service.database.get("alert", f"alert-{approval['id']}") is None

    rejected, alert = service.decide_approval(
        approval["id"],
        ApprovalDecisionInput(
            decision="REJECT",
            reason="Reject the request after its binding changed.",
            expected_version=1,
        ),
        Principal("binding-approver", "verifier", True),
    )
    assert rejected["status"] == "REJECTED"
    assert alert is None


@pytest.mark.parametrize("decision_value", ["FIELD_CHECK", "MODIFY"])
def test_field_check_decisions_authoritatively_return_signal_to_review(
    service: FloodRiseService,
    decision_value: str,
) -> None:
    signal = service.signal("signal-aluva-042")
    corroborated = service.decide_signal(
        signal["id"],
        SignalDecisionInput(
            decision="VERIFY",
            reason="Independent evidence review supports community corroboration.",
            expected_version=signal["version"],
        ),
        Principal("initial-reviewer", "verifier", True),
    )

    returned = service.decide_signal(
        signal["id"],
        SignalDecisionInput(
            decision=decision_value,
            reason="A field check is required before further operational use.",
            expected_version=corroborated["version"],
        ),
        Principal("field-check-reviewer", "verifier", True),
    )

    assert returned["state"] == "NEEDS_REVIEW"
    assert returned["human_review"]["decision"] == decision_value
    assert service.signal(signal["id"])["state"] == "NEEDS_REVIEW"
    reviewed_event = service.database.audit_events(limit=1)[0]
    assert reviewed_event["payload"]["previous_state"] == "COMMUNITY_CORROBORATED"
    assert reviewed_event["payload"]["next_state"] == "NEEDS_REVIEW"


def test_modify_approval_is_a_terminal_return_for_changes_without_dispatch(
    service: FloodRiseService,
) -> None:
    approval = service.create_approval(
        _approval_input().model_copy(
            update={"reason": "Return-for-changes semantics need an independent decision."}
        ),
        Principal("modification-requester", "incident_commander", True),
    )

    modified, alert = service.decide_approval(
        approval["id"],
        ApprovalDecisionInput(
            decision="MODIFY",
            reason="Narrow the audience and submit a newly bound request.",
            expected_version=approval["version"],
        ),
        Principal("modification-reviewer", "verifier", True),
    )

    assert modified["status"] == "MODIFIED"
    assert modified["execution_status"] == "NOT_STARTED"
    assert alert is None
    assert service.database.get("alert", f"alert-{approval['id']}") is None
    assert service.database.audit_events(limit=1)[0]["event_type"] == (
        "approval.modification_requested"
    )
    with pytest.raises(ConflictError) as terminal:
        service.decide_approval(
            approval["id"],
            ApprovalDecisionInput(
                decision="APPROVE",
                reason="The unchanged action must not be approved after return.",
                expected_version=modified["version"],
            ),
            Principal("second-reviewer", "verifier", True),
        )
    assert terminal.value.code == "ALREADY_DECIDED"


def test_road_closure_requires_a_bound_target_and_changes_route_output(
    service: FloodRiseService,
) -> None:
    unbound_request = ApprovalCreateInput.model_validate(
        {
            **_approval_input().model_dump(mode="json"),
            "action_type": "ROAD_CLOSURE",
            "action_payload": {
                "title": "Close NH 544 segment",
                "body": "Close the reviewed segment after independent approval.",
            },
            "reason": "The target must be exact and versioned.",
        }
    )
    with pytest.raises(AppError) as unbound:
        service.create_approval(
            unbound_request,
            Principal("unbound-road-requester", "incident_commander", True),
        )
    assert unbound.value.code == "INVALID_ACTION_TARGET"

    before = service.recommend_routes(
        INCIDENT_ID,
        origin_node="aluva",
        max_alternatives=3,
        principal=Principal("route-reviewer", "responder", True),
    )
    assert any("e-aluva-school-shelter" in route["edge_ids"] for route in before["alternatives"])

    request = ApprovalCreateInput.model_validate(
        {
            **_approval_input().model_dump(mode="json"),
            "action_type": "ROAD_CLOSURE",
            "action_payload": {
                "road_id": "road-nh-544",
                "title": "Close NH 544 segment",
                "body": "Close the reviewed segment after independent approval.",
            },
            "reason": "Independent evidence identifies an impassable segment.",
        }
    )
    approval = service.create_approval(
        request,
        Principal("road-closure-requester", "incident_commander", True),
    )
    assert approval["binding"]["action_target"] == {
        "kind": "road",
        "id": "road-nh-544",
        "record_version": 1,
        "incident_id": INCIDENT_ID,
    }
    decided, _ = service.decide_approval(
        approval["id"],
        ApprovalDecisionInput(
            decision="APPROVE",
            reason="The exact road, evidence and model versions were independently reviewed.",
            expected_version=approval["version"],
        ),
        Principal("road-closure-approver", "verifier", True),
    )

    road = service.database.get("road", "road-nh-544")
    after = service.recommend_routes(
        INCIDENT_ID,
        origin_node="aluva",
        max_alternatives=3,
        principal=Principal("route-reviewer", "responder", True),
    )
    assert decided["status"] == "APPROVED"
    assert road is not None
    assert road["status"] == "CLOSED"
    assert road["authorized_by_approval"] == approval["id"]
    assert before["graph_version"] != after["graph_version"]
    assert all("e-aluva-school-shelter" not in route["edge_ids"] for route in after["alternatives"])
    exclusion = next(
        item for item in after["excluded_edges"] if item["edge_id"] == "e-aluva-school-shelter"
    )
    assert exclusion["reasons"] == ["AUTHORIZED_OR_CONFIRMED_CLOSURE"]


def test_shelter_closure_has_one_approved_transition_path(
    service: FloodRiseService,
) -> None:
    shelter = service.shelters(INCIDENT_ID)[0]
    before_routes = service.recommend_routes(
        INCIDENT_ID,
        origin_node="aluva",
        max_alternatives=3,
        principal=Principal("route-reviewer", "responder", True),
    )
    assert any(route["shelter_id"] == shelter["id"] for route in before_routes["alternatives"])
    audit_count = len(service.database.audit_events(limit=1_000))
    with pytest.raises(PermissionDeniedError, match="two-person approval"):
        service.update_shelter(
            shelter["id"],
            {
                "expected_version": shelter["version"],
                "access_status": "IMPASSABLE",
                "status_reason": "Direct closure attempt",
            },
            Principal("shelter-manager", "shelter_manager", True),
        )
    assert service.database.get("shelter", shelter["id"]) == shelter
    assert len(service.database.audit_events(limit=1_000)) == audit_count

    request = ApprovalCreateInput.model_validate(
        {
            **_approval_input().model_dump(mode="json"),
            "action_type": "SHELTER_CLOSURE",
            "action_payload": {
                "shelter_id": shelter["id"],
                "title": "Close inaccessible shelter",
                "body": "Close shelter access after independent verification.",
            },
            "reason": "Verified floodwater blocks the only shelter access.",
        }
    )
    approval = service.create_approval(
        request,
        Principal("shelter-closure-requester", "incident_commander", True),
    )
    decided, _ = service.decide_approval(
        approval["id"],
        ApprovalDecisionInput(
            decision="APPROVE",
            reason="Independent shelter access review completed.",
            expected_version=1,
        ),
        Principal("shelter-closure-approver", "verifier", True),
    )

    closed = service.database.get("shelter", shelter["id"])
    assert decided["status"] == "APPROVED"
    assert closed is not None
    assert closed["activation_status"] == closed["access_status"] == "CLOSED"
    assert closed["authorized_by_approval"] == approval["id"]
    after_routes = service.recommend_routes(
        INCIDENT_ID,
        origin_node="aluva",
        max_alternatives=3,
        principal=Principal("route-reviewer", "responder", True),
    )
    assert all(route["shelter_id"] != shelter["id"] for route in after_routes["alternatives"])
    shelter_exclusion = next(
        item for item in after_routes["excluded_shelters"] if item["shelter_id"] == shelter["id"]
    )
    assert "AUTHORIZED_SHELTER_CLOSURE" in shelter_exclusion["reasons"]
    closure_events = [
        event
        for event in service.database.audit_events(limit=1_000)
        if event["event_type"] == "shelter.officially_closed"
        and event["aggregate_id"] == shelter["id"]
    ]
    assert len(closure_events) == 1


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
    assert {route["shelter_id"] for route in routes["alternatives"]} == {"shelter-aluva-school"}
    assert all(
        route["shelter_detail"]["access_status"] == "REACHABLE"
        and route["shelter_detail"]["version"] is not None
        for route in routes["alternatives"]
    )
