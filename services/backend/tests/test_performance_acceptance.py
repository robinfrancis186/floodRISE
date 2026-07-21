"""Deterministic local latency acceptance for the judging request path."""

from __future__ import annotations

import json
from statistics import quantiles
from time import perf_counter

from fastapi.testclient import TestClient

from app.config import Settings
from app.database import Database
from app.main import create_app

API = "/api/v1"
INCIDENT_ID = "inc-demo-kerala-flood-2023"


def _p95(samples: list[float]) -> float:
    return quantiles(samples, n=100, method="inclusive")[94]


def _timed_post(client: TestClient, path: str, **kwargs: object) -> tuple[float, int]:
    started_at = perf_counter()
    response = client.post(path, **kwargs)
    return perf_counter() - started_at, response.status_code


def test_local_judging_path_meets_the_published_latency_thresholds() -> None:
    database = Database("sqlite://")
    app = create_app(
        Settings(env="test", demo_mode=True, database_url="sqlite://"),
        database=database,
    )
    report_samples: list[float] = []
    route_samples: list[float] = []
    simulation_samples: list[float] = []

    with TestClient(app, raise_server_exceptions=False) as client:
        for index in range(20):
            elapsed, status_code = _timed_post(
                client,
                f"{API}/reports",
                json={
                    "client_report_id": f"performance-report-{index}",
                    "incident_id": INCIDENT_ID,
                    "reporter_id": f"performance-reporter-{index}",
                    "device_id": f"performance-device-{index}",
                    "observed_at": "2023-12-04T14:00:00Z",
                    "location": {
                        "latitude": 10.1065 + index * 0.00001,
                        "longitude": 76.3517 + index * 0.00001,
                        "accuracy_m": 20,
                    },
                    "water_depth": "KNEE",
                    "road_status": "IMPASSABLE",
                    "flood_status": "FLOODED",
                },
                headers={
                    "Idempotency-Key": f"performance-report-key-{index}",
                    "X-Demo-User": f"performance-reporter-{index}",
                    "X-Demo-Role": "reporter",
                },
            )
            assert status_code == 201
            report_samples.append(elapsed)
            if index == 3:
                fourth_report_elapsed = elapsed

        for _ in range(20):
            elapsed, status_code = _timed_post(
                client,
                f"{API}/routes/recommend",
                json={
                    "incident_id": INCIDENT_ID,
                    "origin_node": "aluva",
                    "max_alternatives": 3,
                },
            )
            assert status_code == 200
            route_samples.append(elapsed)

        for index in range(20):
            elapsed, status_code = _timed_post(
                client,
                f"{API}/simulations",
                json={
                    "incident_id": INCIDENT_ID,
                    "trigger": f"performance acceptance {index}",
                },
                headers={
                    "X-Demo-User": "performance-engineer",
                    "X-Demo-Role": "engineer",
                },
            )
            assert status_code == 201
            simulation_samples.append(elapsed)

        assert client.get("/health").json()["audit_chain_valid"] is True
        assert "floodrise_corroboration_seconds_count 1.0" in client.get("/metrics").text

    database.engine.dispose()

    report_p95 = _p95(report_samples)
    route_p95 = _p95(route_samples)
    simulation_p95 = _p95(simulation_samples)
    print(
        "performance_acceptance="
        + json.dumps(
            {
                "sample_count_each": 20,
                "report_p95_ms": round(report_p95 * 1_000, 2),
                "fourth_report_ms": round(fourth_report_elapsed * 1_000, 2),
                "route_p95_ms": round(route_p95 * 1_000, 2),
                "simulation_p95_ms": round(simulation_p95 * 1_000, 2),
            },
            sort_keys=True,
        )
    )
    assert report_p95 <= 2.0
    assert fourth_report_elapsed <= 5.0
    assert route_p95 <= 0.750
    assert simulation_p95 <= 60.0
