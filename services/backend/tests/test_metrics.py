"""Operational metric contract tests."""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.config import Settings
from app.database import Database
from app.main import create_app

API = "/api/v1"
INCIDENT_ID = "inc-demo-kerala-flood-2023"


def test_metrics_are_emitted_without_identity_or_location_labels() -> None:
    database = Database("sqlite://")
    app = create_app(
        Settings(env="test", demo_mode=True, database_url="sqlite://"),
        database=database,
    )
    with TestClient(app, raise_server_exceptions=False) as client:
        report = client.post(
            f"{API}/reports",
            json={
                "client_report_id": "metrics-report-1",
                "incident_id": INCIDENT_ID,
                "reporter_id": "private-reporter",
                "device_id": "private-device",
                "observed_at": "2023-12-04T14:00:00Z",
                "location": {
                    "latitude": 10.1065,
                    "longitude": 76.3517,
                    "accuracy_m": 20,
                },
                "water_depth": "KNEE",
                "road_status": "IMPASSABLE",
                "flood_status": "FLOODED",
            },
            headers={
                "Idempotency-Key": "metrics-report-key-1",
                "X-Demo-User": "private-reporter",
                "X-Demo-Role": "reporter",
            },
        )
        assert report.status_code == 201

        simulation = client.post(
            f"{API}/simulations",
            json={"incident_id": INCIDENT_ID, "trigger": "metrics acceptance"},
            headers={"X-Demo-User": "engineer-1", "X-Demo-Role": "engineer"},
        )
        route = client.post(
            f"{API}/routes/recommend",
            json={"incident_id": INCIDENT_ID, "origin_node": "aluva", "max_alternatives": 3},
        )
        assert simulation.status_code == 201
        assert route.status_code == 200

        scrape = client.get("/metrics")
        assert scrape.status_code == 200
        body = scrape.text
        assert "floodrise_report_submit_seconds_count 1.0" in body
        assert "floodrise_simulation_seconds_count 1.0" in body
        assert "floodrise_route_seconds_count 1.0" in body
        assert "floodrise_notification_external_attempt_total 0.0" in body
        assert "floodrise_source_age_seconds" in body
        assert "private-reporter" not in body
        assert "private-device" not in body
        assert "76.3517" not in body

    database.engine.dispose()
