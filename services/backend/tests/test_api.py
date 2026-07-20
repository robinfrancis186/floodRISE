"""End-to-end contract tests for the versioned floodRISE HTTP API."""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.database import Database
from app.domain import CORROBORATION_MESSAGE, EXPIRY_MESSAGE
from app.main import create_app

INCIDENT_ID = "inc-demo-michaung-2023"
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
            "latitude": 12.98150 + number * 0.00004,
            "longitude": 80.22070 + number * 0.00004,
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
        "audience": "Residents inside the approved Velachery warning area",
        "geometry": {"type": "Point", "coordinates": [80.2207, 12.9815]},
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
        "database": "reachable",
        "audit_chain_valid": True,
        "demo_mode": True,
        "data_label": "DEMO DATA",
        "time": "ignored",
    }
    assert client.get(f"{API}/health").json()["status"] == "ok"

    bootstrap = client.get(f"{API}/incidents/{INCIDENT_ID}/bootstrap")
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
        "message": "Deterministic Michaung replay reset; no live provider was contacted.",
    }


def test_validation_errors_use_rfc_9457_problem_details(client: TestClient) -> None:
    payload = _report_payload(1)
    payload["location"]["accuracy_m"] = 101
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
    assert alerts[0]["gateway"] == "fake://notification-sink"

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


def test_seeded_evacuation_approval_uses_bound_id_version_and_distinct_approver(
    client: TestClient,
) -> None:
    bootstrap = client.get(f"{API}/incidents/{INCIDENT_ID}/bootstrap").json()
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
    initial_stream = client.get(f"{API}/events", params={"once": "true"})
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
        params={"once": "true"},
        headers={"Last-Event-ID": initial_events[-1]["id"]},
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


def test_route_and_simulation_endpoints_publish_versioned_estimates(client: TestClient) -> None:
    route = client.post(
        f"{API}/routes/recommend",
        json={"incident_id": INCIDENT_ID, "origin_node": "velachery", "max_alternatives": 3},
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
