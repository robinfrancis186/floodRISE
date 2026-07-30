"""End-to-end contract tests for the versioned floodRISE HTTP API."""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import SQLAlchemyError

from app.config import Settings
from app.database import Database, EventInput
from app.domain import CORROBORATION_MESSAGE, EXPIRY_MESSAGE
from app.main import create_app

INCIDENT_ID = "inc-demo-kerala-flood-2023"
API = "/api/v1"


@pytest.fixture
def client() -> Iterator[TestClient]:
    """Run every API test against an isolated, seeded, in-memory database."""

    database = Database("sqlite://")
    settings = Settings(env="test", demo_mode=True, database_url="sqlite://")
    application = create_app(settings, database=database)
    try:
        with TestClient(application, raise_server_exceptions=False) as test_client:
            yield test_client
    finally:
        database.engine.dispose()


def _role_headers(user_id: str, role: str) -> dict[str, str]:
    return {"X-Demo-User": user_id, "X-Demo-Role": role}


def _report_payload(
    number: int,
    *,
    observed_at: str = "2023-12-04T14:00:00Z",
    reporter_id: str | None = None,
    device_id: str | None = None,
) -> dict[str, Any]:
    return {
        "client_report_id": f"field-report-{number:02d}",
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


def _submit_report(
    client: TestClient,
    number: int,
    *,
    payload: dict[str, Any] | None = None,
    idempotency_key: str | None = None,
) -> Any:
    request_payload = payload or _report_payload(number)
    return client.post(
        f"{API}/reports",
        json=request_payload,
        headers={
            "Idempotency-Key": idempotency_key or f"report-key-{number}",
            **_role_headers(str(request_payload["reporter_id"]), "reporter"),
        },
    )


def _parse_sse(body: str) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for block in body.strip().split("\n\n"):
        if not block or block.startswith(":"):
            continue
        fields: dict[str, str] = {}
        for line in block.splitlines():
            key, _, value = line.partition(":")
            fields[key] = value.lstrip()
        events.append(
            {
                "id": fields["id"],
                "event": fields["event"],
                "data": json.loads(fields["data"]),
            }
        )
    return events


def _approval_payload() -> dict[str, Any]:
    return {
        "incident_id": INCIDENT_ID,
        "action_type": "OFFICIAL_WARNING",
        "action_payload": {
            "title": "Official flood warning",
            "body": "Move away from low-lying streets and follow responder instructions.",
        },
        "audience": "Residents inside the approved Aluva warning area",
        "geometry": {"type": "Point", "coordinates": [76.3517000, 10.1065000]},
        "evidence_version": "evidence-demo-001",
        "model_version": "model-demo-20231204-001",
        "reason": "Issue an official warning for the reviewed impact area.",
    }


def test_seeded_health_and_bootstrap_are_demo_labelled(client: TestClient) -> None:
    health = client.get("/health", headers={"X-Request-ID": "health-trace"})

    assert health.status_code == 200
    assert health.headers["X-Request-ID"] == "health-trace"
    assert health.headers["X-floodRISE-Data-Label"] == "DEMO DATA"
    assert health.json() | {"time": "ignored"} == {
        "status": "ok",
        "service": "floodrise-backend",
        "version": "0.1.0",
        "environment": "test",
        "demo_mode": True,
        "data_label": "DEMO DATA",
        "time": "ignored",
    }
    assert client.get(f"{API}/health").json()["status"] == "ok"

    bootstrap = client.get(
        f"{API}/incidents/{INCIDENT_ID}/bootstrap",
        headers=_role_headers("incident-lead", "incident_commander"),
    )
    assert bootstrap.status_code == 200
    body = bootstrap.json()
    assert body["data_label"] == "DEMO DATA"
    assert body["demo_mode"] is True
    assert body["scenario_clock"] == "2023-12-04T14:10:00Z"
    assert body["incident"]["id"] == INCIDENT_ID
    assert body["incident"]["is_simulated"] is True
    assert body["sources"]
    osm_source = next(
        source for source in body["sources"] if source["id"] == "osm-southern-zone-demo"
    )
    assert osm_source["is_simulated"] is False
    assert osm_source["attribution"] == "© OpenStreetMap contributors"
    assert "NOT_EVENT_TIME" in osm_source["quality_flags"]
    assert all(
        source["is_simulated"] is True
        for source in body["sources"]
        if source["id"] != "osm-southern-zone-demo"
    )
    assert body["active_simulation"]["kind"] == "rapid impact estimate"
    rapid_layer = next(layer for layer in body["layers"] if layer["id"] == "rapid-impact-p50")
    assert rapid_layer["representation"] == "PACKAGED_PGM"
    assert rapid_layer["artifact_id"] == "depth-p50-now"
    assert rapid_layer["delivery_service"] == "RESTRICTED_RASTER_TILE_SERVICE"
    assert rapid_layer.get("url") is None
    assert body["active_simulation"]["outputs"]["representation"] == "PACKAGED_PGM"
    assert "cog" not in json.dumps(body["active_simulation"]["outputs"]).lower()
    assert body["routes"][0]["wording"].startswith("Lower-risk route")
    assert body["shelters"]
    assert len(body["approvals"]) == 3
    assert all(approval["status"] == "PENDING" for approval in body["approvals"])
    assert all(approval["version"] == 1 for approval in body["approvals"])
    assert {approval["action_payload"]["presentation_id"] for approval in body["approvals"]} == {
        "ACT-190",
        "ACT-198",
        "ACT-204",
    }
    road_closure = next(
        approval
        for approval in body["approvals"]
        if approval["action_payload"]["presentation_id"] == "ACT-198"
    )
    assert road_closure["action_payload"]["road_id"] == "road-aluva-main"
    assert road_closure["binding"]["action_target"] == {
        "kind": "road",
        "id": "road-aluva-main",
        "record_version": 1,
        "incident_id": INCIDENT_ID,
    }


def test_public_health_is_database_independent(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    database: Database = client.app.state.database

    def unexpected_database_access(*_args: Any, **_kwargs: Any) -> bool:
        raise AssertionError("public liveness must not access the database")

    monkeypatch.setattr(database, "is_empty", unexpected_database_access)
    monkeypatch.setattr(database, "verify_audit_chain", unexpected_database_access)
    monkeypatch.setattr(database, "readiness_check", unexpected_database_access)

    for path in ("/health", f"{API}/health"):
        response = client.get(path)
        assert response.status_code == 200
        assert response.json()["status"] == "ok"


def test_readiness_uses_only_the_bounded_database_check(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    database: Database = client.app.state.database
    readiness_calls = 0

    def unexpected_full_verification(*_args: Any, **_kwargs: Any) -> bool:
        raise AssertionError("public readiness must not verify the full audit history")

    def bounded_readiness() -> bool:
        nonlocal readiness_calls
        readiness_calls += 1
        return True

    monkeypatch.setattr(database, "verify_audit_chain", unexpected_full_verification)
    monkeypatch.setattr(database, "readiness_check", bounded_readiness)

    for path in ("/ready", f"{API}/ready"):
        response = client.get(path)
        assert response.status_code == 200
        assert response.json() | {"time": "ignored"} == {
            "status": "ready",
            "service": "floodrise-backend",
            "environment": "test",
            "database": "reachable",
            "audit_chain_head": "initialized",
            "time": "ignored",
        }
    assert readiness_calls == 2


@pytest.mark.parametrize("failure_mode", ["missing_head", "database_error"])
def test_readiness_fails_closed_without_exposing_database_errors(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    failure_mode: str,
) -> None:
    database: Database = client.app.state.database

    if failure_mode == "missing_head":
        monkeypatch.setattr(database, "readiness_check", lambda: False)
    else:

        def unavailable_database() -> bool:
            raise SQLAlchemyError("postgresql://private-credential@database")

        monkeypatch.setattr(database, "readiness_check", unavailable_database)

    response = client.get("/ready")

    assert response.status_code == 503
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.headers["retry-after"] == "5"
    assert response.json()["code"] == "SERVICE_NOT_READY"
    assert "private-credential" not in response.text
    assert client.get("/health").status_code == 200


def test_bootstrap_omits_operational_approvals_for_non_operational_roles(
    client: TestClient,
) -> None:
    reporter = client.get(
        f"{API}/incidents/{INCIDENT_ID}/bootstrap",
        headers=_role_headers("field-reporter", "reporter"),
    )
    identity_admin = client.get(
        f"{API}/incidents/{INCIDENT_ID}/bootstrap",
        headers=_role_headers("identity-admin", "identity_administrator"),
    )
    verifier = client.get(
        f"{API}/incidents/{INCIDENT_ID}/bootstrap",
        headers=_role_headers("duty-verifier", "verifier"),
    )

    assert reporter.status_code == identity_admin.status_code == verifier.status_code == 200
    assert reporter.json()["approvals"] == []
    assert identity_admin.json()["approvals"] == []
    serialized_reporter = json.dumps(reporter.json())
    assert "demo-requester-area-caution" not in serialized_reporter
    assert "request_authentication" not in serialized_reporter
    assert len(verifier.json()["approvals"]) == 3


def test_demo_reset_requires_identity_administrator_and_returns_canonical_checkpoint(
    client: TestClient,
) -> None:
    denied = client.post(f"{API}/demo/reset", headers=_role_headers("field-user", "reporter"))
    assert denied.status_code == 403

    response = client.post(
        f"{API}/demo/reset",
        headers=_role_headers("runbook-reset", "identity_administrator"),
    )
    assert response.status_code == 200
    assert response.json() | {"reset_at": "ignored"} == {
        "incident_id": INCIDENT_ID,
        "scenario_time": "2023-12-04T14:10:00Z",
        "reset_at": "ignored",
        "data_label": "DEMO DATA",
        "message": (
            "Deterministic Kerala extreme-rainfall replay reset; no live provider was contacted."
        ),
    }


def test_validation_errors_use_rfc_9457_problem_details(client: TestClient) -> None:
    payload = _report_payload(1)
    payload["location"]["accuracy_m"] = 10_001
    payload["unexpected"] = "strict contracts reject extra fields"

    response = client.post(
        f"{API}/reports",
        json=payload,
        headers={"Idempotency-Key": "invalid-location", "X-Request-ID": "validation-trace"},
    )

    assert response.status_code == 422
    assert response.headers["content-type"].startswith("application/problem+json")
    problem = response.json()
    assert problem["type"] == "about:blank"
    assert problem["title"] == "Request validation failed"
    assert problem["status"] == 422
    assert problem["code"] == "VALIDATION_ERROR"
    assert problem["instance"] == f"{API}/reports"
    assert problem["trace_id"] == "validation-trace"
    pointers = {item["pointer"] for item in problem["errors"]}
    assert "/body/location/accuracy_m" in pointers
    assert "/body/unexpected" in pointers

    missing_header = client.post(f"{API}/reports", json=_report_payload(2))
    assert missing_header.status_code == 422
    assert missing_header.json()["errors"][0]["pointer"] == "/header/Idempotency-Key"


def test_report_submission_is_idempotent(client: TestClient) -> None:
    payload = _report_payload(1)

    first = _submit_report(client, 1, payload=payload, idempotency_key="stable-offline-key")
    replay = _submit_report(client, 1, payload=payload, idempotency_key="stable-offline-key")

    assert first.status_code == replay.status_code == 201
    assert first.json()["replayed"] is False
    assert replay.json()["replayed"] is True
    assert replay.json()["report"]["id"] == first.json()["report"]["id"]
    assert replay.json()["receipt"] == first.json()["receipt"]
    reports = client.get(f"{API}/reports", params={"incident_id": INCIDENT_ID}).json()
    assert len(reports["items"]) == 1


def test_reporter_identity_is_pseudonymized_in_reports_and_audit(client: TestClient) -> None:
    raw_identity = "private-citizen-subject"
    payload = _report_payload(41, reporter_id="client-local-alias")
    response = client.post(
        f"{API}/reports",
        json=payload,
        headers={
            "Idempotency-Key": "privacy-report-key",
            **_role_headers(raw_identity, "reporter"),
        },
    )

    assert response.status_code == 201, response.text
    protected_fields = {
        "reporter_id",
        "account_id",
        "device_id",
        "client_report_id",
        "note",
        "media_hash",
        "media_upload_ids",
        "media_independence_hashes",
        "idempotency_key_digest",
    }
    returned_report = response.json()["report"]
    assert protected_fields.isdisjoint(returned_report)
    assert returned_report["identity_protected"] is True
    assert returned_report["location"]["accuracy_m"] >= 200
    returned_signal = response.json()["signal"]
    assert returned_signal["location_generalized"] is True
    assert returned_signal["location"]["coordinates"] == [
        round(value, 2) for value in returned_signal["location"]["coordinates"]
    ]

    listed = client.get(
        f"{API}/reports",
        params={"incident_id": INCIDENT_ID},
        headers=_role_headers("field-responder", "responder"),
    )
    assert listed.status_code == 200
    assert protected_fields.isdisjoint(listed.json()["items"][0])

    audit = client.get(
        f"{API}/audit",
        headers=_role_headers("audit-reviewer", "auditor"),
    )
    assert audit.status_code == 200
    serialized = json.dumps(audit.json())
    assert raw_identity not in serialized
    report_event = next(
        event for event in audit.json()["items"] if event["event_type"] == "report.received"
    )
    assert report_event["actor_id"].startswith("reporter-")


def test_four_independent_reports_create_one_unofficial_caution(client: TestClient) -> None:
    responses = [_submit_report(client, number) for number in range(1, 5)]

    assert all(response.status_code == 201 for response in responses)
    assert [response.json()["signal"]["state"] for response in responses] == [
        "CANDIDATE",
        "CORROBORATING",
        "CORROBORATING",
        "COMMUNITY_CORROBORATED",
    ]
    signal = responses[-1].json()["signal"]
    assert signal["state"] == "COMMUNITY_CORROBORATED"
    assert signal["independent_report_count"] == 4
    assert signal["authenticated_report_count"] >= 2
    assert signal["display_message"] == CORROBORATION_MESSAGE
    assert signal["route_recalculation_requested"] is True

    alerts = client.get(f"{API}/alerts", params={"incident_id": INCIDENT_ID}).json()["items"]
    assert len(alerts) == 1
    assert alerts[0]["body"] == CORROBORATION_MESSAGE
    assert alerts[0]["caution_only"] is True
    assert alerts[0]["official"] is False
    assert "gateway" not in alerts[0]

    fifth = _submit_report(client, 5)
    assert fifth.status_code == 201
    assert fifth.json()["signal"]["independent_report_count"] == 5
    alerts_after_fifth = client.get(f"{API}/alerts", params={"incident_id": INCIDENT_ID}).json()[
        "items"
    ]
    assert len(alerts_after_fifth) == 1


def test_same_reporter_and_device_never_create_four_votes(client: TestClient) -> None:
    receipts = []
    for number in range(1, 5):
        payload = _report_payload(
            number,
            reporter_id="one-reporter",
            device_id="one-install",
        )
        response = _submit_report(client, number, payload=payload)
        assert response.status_code == 201
        receipts.append(response.json()["receipt"])

    signal = client.get(f"{API}/signals", params={"incident_id": INCIDENT_ID}).json()["items"][0]
    assert signal["state"] == "CANDIDATE"
    assert signal["independent_report_count"] == 1
    assert [receipt["disposition"] for receipt in receipts] == [
        "ELIGIBLE",
        "DUPLICATE",
        "DUPLICATE",
        "DUPLICATE",
    ]
    assert client.get(f"{API}/alerts", params={"incident_id": INCIDENT_ID}).json()["items"] == []


def test_one_authenticated_account_cannot_rotate_client_identifiers_into_four_votes(
    client: TestClient,
) -> None:
    responses = []
    for number in range(1, 5):
        payload = _report_payload(
            number,
            reporter_id=f"spoofed-reporter-{number}",
            device_id=f"rotated-device-{number}",
        )
        responses.append(
            client.post(
                f"{API}/reports",
                json=payload,
                headers={
                    "Idempotency-Key": f"rotating-account-{number}",
                    **_role_headers("one-authenticated-account", "reporter"),
                },
            )
        )

    assert all(response.status_code == 201 for response in responses)
    assert [response.json()["report"]["disposition"] for response in responses] == [
        "ELIGIBLE",
        "DUPLICATE",
        "DUPLICATE",
        "DUPLICATE",
    ]
    assert all(response.json()["report"]["trusted"] is False for response in responses)
    assert responses[-1].json()["signal"]["independent_report_count"] == 1
    assert responses[-1].json()["signal"]["state"] == "CANDIDATE"

    asserted_authority = _report_payload(9)
    asserted_authority["trusted"] = True
    rejected = client.post(
        f"{API}/reports",
        json=asserted_authority,
        headers={
            "Idempotency-Key": "client-asserted-authority",
            **_role_headers("ordinary-reporter", "reporter"),
        },
    )
    assert rejected.status_code == 422
    assert rejected.json()["code"] == "VALIDATION_ERROR"


def test_report_idempotency_and_client_ids_never_reveal_cross_account_evidence(
    client: TestClient,
) -> None:
    original = _report_payload(1)
    created = client.post(
        f"{API}/reports",
        json=original,
        headers={"Idempotency-Key": "shared-key", **_role_headers("account-a", "reporter")},
    )
    assert created.status_code == 201

    changed = {**_report_payload(2), "client_report_id": original["client_report_id"]}
    cross_account = client.post(
        f"{API}/reports",
        json=changed,
        headers={"Idempotency-Key": "different-key", **_role_headers("account-b", "reporter")},
    )
    changed_same_key = client.post(
        f"{API}/reports",
        json=_report_payload(3),
        headers={"Idempotency-Key": "shared-key", **_role_headers("account-a", "reporter")},
    )

    assert cross_account.status_code == 409
    assert cross_account.json()["code"] == "CLIENT_REPORT_ID_COLLISION"
    assert "account-a" not in cross_account.text
    assert changed_same_key.status_code == 409
    assert changed_same_key.json()["code"] == "IDEMPOTENCY_KEY_REUSED"


def test_late_report_is_retained_but_cannot_trigger_a_live_signal(client: TestClient) -> None:
    payload = _report_payload(1, observed_at="2023-12-04T13:00:00Z")

    response = _submit_report(client, 1, payload=payload)

    assert response.status_code == 201
    body = response.json()
    assert body["report"]["disposition"] == "LATE"
    assert body["report"]["eligible_for_live_signal"] is False
    assert body["receipt"]["live_signal_eligible"] is False
    assert body["receipt"]["sync_message"] == (
        "Historical report retained; it cannot trigger a live caution."
    )
    assert body["signal"]["state"] == "CANDIDATE"
    assert body["signal"]["independent_report_count"] == 0


def test_poor_accuracy_report_is_retained_but_not_live_eligible(
    client: TestClient,
) -> None:
    payload = _report_payload(71)
    payload["location"]["accuracy_m"] = 145

    response = _submit_report(client, 71, payload=payload)

    assert response.status_code == 201
    body = response.json()
    assert body["report"]["disposition"] == "INVALID"
    assert body["report"]["eligible_for_live_signal"] is False
    assert "worse than 100 m" in body["report"]["disposition_reasons"][0]
    assert body["signal"]["independent_report_count"] == 0


def test_demo_advance_expires_signal_without_implying_safety(client: TestClient) -> None:
    created = _submit_report(client, 1)
    signal_id = created.json()["signal"]["id"]

    advanced = client.post(
        f"{API}/demo/advance",
        json={"minutes": 121, "inject_report_ids": [], "run_simulation": False},
        headers=_role_headers("demo-engineer", "engineer"),
    )
    signal = client.get(f"{API}/signals/{signal_id}")

    assert advanced.status_code == 200
    assert advanced.json()["scenario_time"] == "2023-12-04T16:11:00Z"
    assert signal.status_code == 200
    assert signal.json()["state"] == "EXPIRED"
    assert signal.json()["freshness"] == "EXPIRED"
    assert signal.json()["display_message"] == EXPIRY_MESSAGE


def test_demo_advance_rejects_reporter_test_data_injection(client: TestClient) -> None:
    denied = client.post(
        f"{API}/demo/advance",
        json={"minutes": 10, "inject_report_ids": [], "run_simulation": False},
        headers=_role_headers("private-citizen-subject", "reporter"),
    )

    assert denied.status_code == 403
    audit = client.get(
        f"{API}/audit",
        headers=_role_headers("audit-reviewer", "auditor"),
    )
    assert "private-citizen-subject" not in json.dumps(audit.json())


def test_signal_decision_requires_the_current_expected_version(client: TestClient) -> None:
    signal = _submit_report(client, 1).json()["signal"]
    headers = _role_headers("field-verifier", "verifier")

    conflict = client.post(
        f"{API}/signals/{signal['id']}/decisions",
        json={"decision": "DISPUTE", "reason": "Field evidence conflicts", "expected_version": 99},
        headers=headers,
    )
    accepted = client.post(
        f"{API}/signals/{signal['id']}/decisions",
        json={
            "decision": "DISPUTE",
            "reason": "Field evidence conflicts",
            "expected_version": signal["version"],
        },
        headers=headers,
    )

    assert conflict.status_code == 409
    assert conflict.json()["code"] == "VERSION_CONFLICT"
    assert accepted.status_code == 200
    assert accepted.json()["state"] == "DISPUTED"
    assert accepted.json()["version"] == signal["version"] + 1
    assert accepted.json()["human_review"]["reviewed_by"] == "field-verifier"


def test_field_check_http_decision_returns_corroborated_signal_to_review(
    client: TestClient,
) -> None:
    headers = _role_headers("field-verifier", "verifier")
    signal = client.get(f"{API}/signals/signal-aluva-042", headers=headers).json()
    corroborated = client.post(
        f"{API}/signals/{signal['id']}/decisions",
        json={
            "decision": "VERIFY",
            "reason": "Independent review supports community corroboration.",
            "expected_version": signal["version"],
        },
        headers=headers,
    )
    assert corroborated.status_code == 200
    reviewed = client.post(
        f"{API}/signals/{signal['id']}/decisions",
        json={
            "decision": "FIELD_CHECK",
            "reason": "A responder field check is required before operational use.",
            "expected_version": corroborated.json()["version"],
        },
        headers=headers,
    )

    assert reviewed.status_code == 200
    assert reviewed.json()["state"] == "NEEDS_REVIEW"
    assert reviewed.json()["human_review"]["decision"] == "FIELD_CHECK"


def test_two_person_approval_denies_requester_and_dispatches_for_other_user(
    client: TestClient,
) -> None:
    requester = _role_headers("incident-lead", "incident_commander")
    approver = _role_headers("duty-verifier", "verifier")
    created = client.post(f"{API}/approvals", json=_approval_payload(), headers=requester)
    assert created.status_code == 201
    approval = created.json()

    decision = {
        "decision": "APPROVE",
        "reason": "Evidence and bound audience were reviewed.",
        "expected_version": approval["version"],
    }
    self_approval = client.post(
        f"{API}/approvals/{approval['id']}/decisions", json=decision, headers=requester
    )
    approved = client.post(
        f"{API}/approvals/{approval['id']}/decisions", json=decision, headers=approver
    )

    assert self_approval.status_code == 403
    assert self_approval.json()["detail"] == ("The requester and approver must be different people")
    assert approved.status_code == 200
    assert approved.json()["approval"]["status"] == "APPROVED"
    assert approved.json()["approval"]["decided_by"] == "duty-verifier"
    alert = approved.json()["alert"]
    assert alert["status"] == "DISPATCHED"
    assert alert["official"] is True
    assert alert["caution_only"] is False
    assert alert["approval_request_id"] == approval["id"]
    assert alert["gateway"] == "fake://notification-sink"
    reporter_bootstrap = client.get(
        f"{API}/incidents/{INCIDENT_ID}/bootstrap",
        headers=_role_headers("field-reporter", "reporter"),
    )
    assert approval["id"] not in json.dumps(reporter_bootstrap.json())
    public_alert = next(
        item for item in reporter_bootstrap.json()["alerts"] if item["official"] is True
    )
    assert "gateway" not in public_alert


def test_seeded_evacuation_approval_uses_bound_id_version_and_distinct_approver(
    client: TestClient,
) -> None:
    bootstrap = client.get(
        f"{API}/incidents/{INCIDENT_ID}/bootstrap",
        headers=_role_headers("incident-lead", "incident_commander"),
    ).json()
    approval = next(
        item
        for item in bootstrap["approvals"]
        if item["action_payload"]["presentation_id"] == "ACT-190"
    )
    decision = {
        "decision": "APPROVE",
        "reason": "The route, evidence, model and audience were independently reviewed.",
        "expected_version": approval["version"],
    }

    self_decision = client.post(
        f"{API}/approvals/{approval['id']}/decisions",
        json=decision,
        headers=_role_headers(approval["requested_by"], "incident_commander"),
    )
    stale_decision = client.post(
        f"{API}/approvals/{approval['id']}/decisions",
        json={**decision, "expected_version": 99},
        headers=_role_headers("ops-verifier", "verifier"),
    )
    accepted = client.post(
        f"{API}/approvals/{approval['id']}/decisions",
        json=decision,
        headers=_role_headers("ops-verifier", "verifier"),
    )

    assert self_decision.status_code == 403
    assert self_decision.json()["code"] == "PERMISSION_DENIED"
    assert stale_decision.status_code == 409
    assert stale_decision.json()["code"] == "VERSION_CONFLICT"
    assert accepted.status_code == 200
    assert accepted.json()["approval"]["version"] == approval["version"] + 1
    assert accepted.json()["approval"]["id"] == approval["id"]
    assert accepted.json()["approval"]["status"] == "APPROVED"
    assert accepted.json()["approval"]["decided_by"] == "ops-verifier"
    assert accepted.json()["alert"]["approval_request_id"] == approval["id"]


def test_approved_road_closure_persists_and_is_excluded_from_new_routes(
    client: TestClient,
) -> None:
    route_request = {
        "incident_id": INCIDENT_ID,
        "origin_node": "aluva",
        "max_alternatives": 3,
    }
    before = client.post(f"{API}/routes/recommend", json=route_request)
    assert before.status_code == 200
    assert any(
        "e-aluva-school-shelter" in route["edge_ids"] for route in before.json()["alternatives"]
    )

    payload = {
        **_approval_payload(),
        "action_type": "ROAD_CLOSURE",
        "action_payload": {
            "road_id": "road-nh-544",
            "title": "Close reviewed NH 544 segment",
            "body": "Close only the exact bound segment after independent review.",
        },
        "reason": "The road target, evidence and model are bound for review.",
    }
    created = client.post(
        f"{API}/approvals",
        json=payload,
        headers=_role_headers("road-requester", "incident_commander"),
    )
    assert created.status_code == 201
    approval = created.json()
    assert approval["binding"]["action_target"]["id"] == "road-nh-544"

    decision = client.post(
        f"{API}/approvals/{approval['id']}/decisions",
        json={
            "decision": "APPROVE",
            "reason": "Independent review confirms the exact road closure target.",
            "expected_version": approval["version"],
        },
        headers=_role_headers("road-approver", "verifier"),
    )
    assert decision.status_code == 200
    assert decision.json()["approval"]["status"] == "APPROVED"

    after = client.post(f"{API}/routes/recommend", json=route_request)
    assert after.status_code == 200
    body = after.json()
    assert all("e-aluva-school-shelter" not in route["edge_ids"] for route in body["alternatives"])
    exclusion = next(
        item for item in body["excluded_edges"] if item["edge_id"] == "e-aluva-school-shelter"
    )
    assert exclusion["reasons"] == ["AUTHORIZED_OR_CONFIRMED_CLOSURE"]
    audit = client.get(
        f"{API}/audit",
        headers=_role_headers("audit-reviewer", "auditor"),
    ).json()
    assert any(
        event["event_type"] == "road.officially_closed" and event["aggregate_id"] == "road-nh-544"
        for event in audit["items"]
    )


@pytest.mark.parametrize(
    ("update", "expected_reason"),
    [
        (
            {
                "activation_status": "FULL",
                "access_status": "REACHABLE",
                "capacity_remaining": 0,
                "status_reason": "The shelter reached its verified capacity.",
            },
            "SHELTER_FULL",
        ),
        (
            {
                "activation_status": "OPEN",
                "access_status": "AT_RISK",
                "capacity_remaining": 120,
                "status_reason": "The only verified access is currently at risk.",
            },
            "SHELTER_ACCESS_NOT_CONFIRMED_REACHABLE",
        ),
    ],
)
def test_shelter_status_change_withholds_stale_route_from_list_and_bootstrap(
    client: TestClient,
    update: dict[str, Any],
    expected_reason: str,
) -> None:
    staff_headers = _role_headers("incident-lead", "incident_commander")
    before = client.get(
        f"{API}/incidents/{INCIDENT_ID}/bootstrap",
        headers=staff_headers,
    ).json()
    shelter = next(item for item in before["shelters"] if item["id"] == "shelter-aluva-school")
    initial_route = next(item for item in before["routes"] if item["shelter_id"] == shelter["id"])
    assert initial_route["shelter_detail"]["status"] == "OPEN"
    assert initial_route["shelter_detail"]["access_status"] == "REACHABLE"
    assert initial_route["shelter_detail"]["capacity_remaining"] == 186

    changed = client.patch(
        f"{API}/shelters/{shelter['id']}",
        json={"expected_version": shelter["version"], **update},
        headers=_role_headers("shelter-manager", "shelter_manager"),
    )
    assert changed.status_code == 200

    stored_routes = client.get(
        f"{API}/routes",
        params={"incident_id": INCIDENT_ID},
        headers=staff_headers,
    ).json()
    after = client.get(
        f"{API}/incidents/{INCIDENT_ID}/bootstrap",
        headers=staff_headers,
    ).json()
    assert all(route.get("shelter_id") != shelter["id"] for route in stored_routes["items"])
    assert all(route.get("shelter_id") != shelter["id"] for route in after["routes"])
    exclusion = next(
        item
        for item in after["route_recommendation"]["excluded_shelters"]
        if item["shelter_id"] == shelter["id"]
    )
    assert expected_reason in exclusion["reasons"]


def test_limited_reachable_shelter_route_preserves_current_capacity_and_status(
    client: TestClient,
) -> None:
    staff_headers = _role_headers("incident-lead", "incident_commander")
    before = client.get(
        f"{API}/incidents/{INCIDENT_ID}/bootstrap",
        headers=staff_headers,
    ).json()
    shelter = next(item for item in before["shelters"] if item["id"] == "shelter-aluva-school")
    changed = client.patch(
        f"{API}/shelters/{shelter['id']}",
        json={
            "expected_version": shelter["version"],
            "activation_status": "LIMITED",
            "access_status": "REACHABLE",
            "capacity_remaining": 24,
            "status_reason": "Capacity is limited but verified access remains reachable.",
        },
        headers=_role_headers("shelter-manager", "shelter_manager"),
    )
    assert changed.status_code == 200

    after = client.get(
        f"{API}/incidents/{INCIDENT_ID}/bootstrap",
        headers=staff_headers,
    ).json()
    route = next(item for item in after["routes"] if item["shelter_id"] == shelter["id"])
    assert route["shelter_detail"]["status"] == "LIMITED"
    assert route["shelter_detail"]["access_status"] == "REACHABLE"
    assert route["shelter_detail"]["capacity_remaining"] == 24
    assert route["shelter_detail"]["version"] == shelter["version"] + 1


def test_identity_administrator_cannot_request_operational_action(client: TestClient) -> None:
    response = client.post(
        f"{API}/approvals",
        json=_approval_payload(),
        headers=_role_headers("identity-admin", "identity_administrator"),
    )

    assert response.status_code == 403
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["code"] == "PERMISSION_DENIED"


def test_audit_chain_and_finite_sse_replay_share_persisted_events(client: TestClient) -> None:
    stream_headers = _role_headers("audit-reviewer", "auditor")
    initial_stream = client.get(
        f"{API}/events",
        params={"once": "true", "incident_id": INCIDENT_ID},
        headers=stream_headers,
    )
    initial_events = _parse_sse(initial_stream.text)

    assert initial_stream.status_code == 200
    assert initial_stream.headers["content-type"].startswith("text/event-stream")
    assert [event["event"] for event in initial_events] == [
        "demo.reset",
        "approval.requested",
        "approval.requested",
        "approval.requested",
    ]
    assert initial_events[0]["data"]["type"] == "demo.reset"

    assert _submit_report(client, 1).status_code == 201
    replay = client.get(
        f"{API}/events",
        params={"once": "true", "incident_id": INCIDENT_ID},
        headers={**stream_headers, "Last-Event-ID": initial_events[-1]["id"]},
    )
    replay_events = _parse_sse(replay.text)
    assert [event["event"] for event in replay_events] == [
        "report.received",
        "signal.updated",
    ]
    assert all(event["data"]["incident_id"] == INCIDENT_ID for event in replay_events)

    auditor = _role_headers("audit-reviewer", "auditor")
    audit = client.get(f"{API}/audit", headers=auditor)
    exported = client.get(f"{API}/audit/export", headers=auditor)
    assert audit.status_code == exported.status_code == 200
    assert audit.json()["chain_valid"] is True
    assert exported.json()["chain_valid"] is True
    assert exported.json()["event_count"] == len(audit.json()["items"]) == 6
    assert len(exported.json()["sha256"]) == 64
    assert client.app.state.sse_connection_count == 0


def test_sse_requires_operational_auth_filters_incident_and_rejects_bad_cursor(
    client: TestClient,
) -> None:
    default_reporter = client.get(
        f"{API}/events",
        params={"once": "true", "incident_id": INCIDENT_ID},
    )
    auditor = _role_headers("audit-reviewer", "auditor")
    malformed = client.get(
        f"{API}/events",
        params={"once": "true", "incident_id": INCIDENT_ID},
        headers={**auditor, "Last-Event-ID": "not-a-persisted-sequence"},
    )
    database = client.app.state.database
    database.commit(
        events=[
            EventInput(
                event_type="approval.requested",
                aggregate_kind="approval",
                aggregate_id="approval-other-incident",
                aggregate_version=1,
                actor_id="other-incident-user",
                actor_role="incident_commander",
                payload={"private": True},
                incident_id="inc-other-authority-event",
            )
        ]
    )
    filtered = client.get(
        f"{API}/events",
        params={"once": "true", "incident_id": INCIDENT_ID},
        headers=auditor,
    )

    assert default_reporter.status_code == 403
    assert malformed.status_code == 400
    assert malformed.json()["code"] == "INVALID_EVENT_CURSOR"
    assert "approval-other-incident" not in filtered.text
    assert all(event["data"]["incident_id"] == INCIDENT_ID for event in _parse_sse(filtered.text))

    runtime = client.app.state.settings
    client.app.state.sse_connection_count = runtime.sse_max_connections
    at_capacity = client.get(
        f"{API}/events",
        params={"once": "true", "incident_id": INCIDENT_ID},
        headers=auditor,
    )
    client.app.state.sse_connection_count = 0
    client.app.state.sse_principal_connections.clear()
    assert at_capacity.status_code == 429
    assert at_capacity.json()["code"] == "SSE_CONNECTION_LIMIT"


def test_route_and_simulation_endpoints_publish_versioned_estimates(client: TestClient) -> None:
    route = client.post(
        f"{API}/routes/recommend",
        json={"incident_id": INCIDENT_ID, "origin_node": "aluva", "max_alternatives": 3},
    )

    assert route.status_code == 200
    route_body = route.json()
    assert route_body["status"] == "ROUTES_AVAILABLE"
    assert 1 <= len(route_body["alternatives"]) <= 3
    assert route_body["disclaimer"].startswith("Lower-risk route estimate")
    assert "safe" not in route_body["disclaimer"].lower()
    assert all(
        alternative["model_version"] == route_body["model_version"]
        for alternative in route_body["alternatives"]
    )
    assert {alternative["shelter_id"] for alternative in route_body["alternatives"]} == {
        "shelter-aluva-school"
    }
    assert all(
        alternative["shelter_detail"]["access_status"] == "REACHABLE"
        and alternative["shelter_detail"]["version"] is not None
        for alternative in route_body["alternatives"]
    )

    simulation = client.post(
        f"{API}/simulations",
        json={"incident_id": INCIDENT_ID, "trigger": "operator acceptance test"},
        headers=_role_headers("hydrology-engineer", "engineer"),
    )
    assert simulation.status_code == 201
    simulation_body = simulation.json()
    assert simulation_body["status"] == "PUBLISHED"
    assert simulation_body["kind"] == "rapid impact estimate"
    assert simulation_body["ensemble_members"] == 9
    assert simulation_body["is_simulated"] is True

    fetched = client.get(f"{API}/simulations/{simulation_body['id']}")
    impacts = client.get(f"{API}/impacts", params={"incident_id": INCIDENT_ID})
    assert fetched.status_code == impacts.status_code == 200
    assert fetched.json()["model_version"] == simulation_body["model_version"]
    assert any(
        item["model_version"] == simulation_body["model_version"]
        and item["label"] == "Rapid impact estimate"
        for item in impacts.json()["items"]
    )


@pytest.mark.parametrize(
    ("origin", "reason_code"),
    [
        ({"origin_node": "not-on-graph"}, "UNKNOWN_ORIGIN_NODE"),
        (
            {
                "origin": {
                    "latitude": 40.7128,
                    "longitude": -74.006,
                    "accuracy_m": 10,
                }
            },
            "ORIGIN_OUTSIDE_INCIDENT_AREA",
        ),
        (
            {
                "origin": {
                    "latitude": 9.93,
                    "longitude": 76.21,
                    "accuracy_m": 10,
                }
            },
            "ORIGIN_TOO_FAR_FROM_ROUTABLE_NETWORK",
        ),
        (
            {
                "origin": {
                    "latitude": 10.1065,
                    "longitude": 76.3516,
                    "accuracy_m": 101,
                }
            },
            "ORIGIN_ACCURACY_TOO_LOW",
        ),
    ],
)
def test_route_recommendation_fails_closed_for_untrusted_origins(
    client: TestClient,
    origin: dict[str, Any],
    reason_code: str,
) -> None:
    response = client.post(
        f"{API}/routes/recommend",
        json={"incident_id": INCIDENT_ID, **origin, "max_alternatives": 3},
    )

    assert response.status_code == 200
    assert response.json()["status"] == "NO_ROUTE"
    assert response.json()["alternatives"] == []
    assert response.json()["reason_code"] == reason_code
    assert response.json()["staging_point"] is None


def test_route_engine_failure_never_returns_a_seeded_route(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_engine(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        raise ValueError("corrupt graph fixture")

    monkeypatch.setattr("app.routing.find_lower_risk_routes", fail_engine)
    response = client.post(
        f"{API}/routes/recommend",
        json={
            "incident_id": INCIDENT_ID,
            "origin_node": "aluva",
            "max_alternatives": 3,
        },
    )

    assert response.status_code == 503
    assert response.json()["code"] == "ROUTING_UNAVAILABLE"
    assert "route-lower-risk-001" not in response.text
