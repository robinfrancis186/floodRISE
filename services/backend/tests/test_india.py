"""Contract tests for India reference data and CAP 1.2 alert export."""

from __future__ import annotations

from collections.abc import Iterator
from xml.etree import ElementTree

import pytest
from fastapi.testclient import TestClient

from app import india
from app.config import Settings
from app.database import Database
from app.errors import AppError
from app.main import create_app

API = "/api/v1"
INCIDENT_ID = "inc-demo-michaung-2023"
CAP = f"{{{india.CAP_NAMESPACE}}}"


@pytest.fixture
def client() -> Iterator[TestClient]:
    database = Database("sqlite://")
    settings = Settings(env="test", demo_mode=True, database_url="sqlite://")
    application = create_app(settings, database=database)
    try:
        with TestClient(application, raise_server_exceptions=False) as test_client:
            yield test_client
    finally:
        database.engine.dispose()


@pytest.mark.parametrize(
    ("amount", "category"),
    [
        (0, "NO_RAIN"),
        (0.1, "VERY_LIGHT"),
        (2.4, "VERY_LIGHT"),
        (2.5, "LIGHT"),
        (15.5, "LIGHT"),
        (15.6, "MODERATE"),
        (64.4, "MODERATE"),
        (64.5, "HEAVY"),
        (115.5, "HEAVY"),
        (115.6, "VERY_HEAVY"),
        (204.4, "VERY_HEAVY"),
        (204.5, "EXTREMELY_HEAVY"),
        (500, "EXTREMELY_HEAVY"),
    ],
)
def test_rainfall_uses_imd_category_boundaries(amount: float, category: str) -> None:
    assert india.classify_rainfall(amount)["category"] == category


@pytest.mark.parametrize("amount", [-0.1, float("nan"), float("inf")])
def test_rainfall_rejects_non_physical_amounts(amount: float) -> None:
    with pytest.raises(AppError):
        india.classify_rainfall(amount)


def test_rainfall_scale_ranges_are_contiguous() -> None:
    rows = india.warning_scales()["imd_rainfall_24h_mm"]
    assert rows[0]["min_mm"] == 0
    assert rows[-1]["max_mm"] is None
    for lower, upper in zip(rows, rows[1:], strict=False):
        assert round(upper["min_mm"] - lower["max_mm"], 1) in {0.0, 0.1}


@pytest.mark.parametrize(
    ("level", "category"),
    [(4.9, "NORMAL"), (5.0, "ABOVE_NORMAL"), (6.0, "SEVERE"), (7.5, "EXTREME")],
)
def test_river_level_uses_cwc_flood_situation(level: float, category: str) -> None:
    result = india.classify_river_level(level, warning_m=5.0, danger_m=6.0, hfl_m=7.5)
    assert result["category"] == category


def test_river_level_rejects_inverted_thresholds() -> None:
    with pytest.raises(AppError):
        india.classify_river_level(5.0, warning_m=6.0, danger_m=5.0, hfl_m=7.0)


def test_regions_are_inside_india_and_only_chennai_claims_data() -> None:
    regions = india.list_regions()
    assert len({region["id"] for region in regions}) == len(regions)
    for region in regions:
        west, south, east, north = region["bounds"]
        longitude, latitude = region["center"]
        assert west < east and south < north
        assert west <= longitude <= east and south <= latitude <= north
        assert india.point_in_india(latitude, longitude)
        assert region["timezone"] == "Asia/Kolkata"
        assert "en" in region["languages"]
    with_data = [r["id"] for r in regions if r["data_status"] != "REGISTERED_NO_DATA"]
    assert with_data == ["in-tn-chennai"]


def test_region_lookup_by_point() -> None:
    assert india.region_for_point(12.9815, 80.2207)["id"] == "in-tn-chennai"
    assert india.region_for_point(19.07, 72.87)["id"] == "in-mh-mumbai"
    assert india.region_for_point(51.5, -0.12) is None
    assert not india.point_in_india(51.5, -0.12)


def test_emergency_contacts_lead_with_112_and_add_city_lines() -> None:
    national = india.emergency_contacts()
    assert national[0]["number"] == "112"
    assert all(contact["requires_local_verification"] for contact in national)
    chennai = india.emergency_contacts("in-tn-chennai")
    assert {contact["number"] for contact in chennai} - {c["number"] for c in national} == {"1913"}
    assert chennai[0]["number"] == "112"


def test_india_endpoints(client: TestClient) -> None:
    regions = client.get(f"{API}/india/regions").json()["items"]
    assert any(region["id"] == "in-tn-chennai" for region in regions)
    assert client.get(f"{API}/india/regions/in-ka-bengaluru").json()["state_code"] == "IN-KA"
    assert client.get(f"{API}/india/regions/nowhere").status_code == 404
    assert client.get(f"{API}/india/emergency-contacts?region_id=nowhere").status_code == 404
    contacts = client.get(f"{API}/india/emergency-contacts?region_id=in-mh-mumbai").json()
    assert "1916" in {contact["number"] for contact in contacts["items"]}
    assert len(client.get(f"{API}/india/warning-scales").json()["imd_colour_codes"]) == 4
    classified = client.get(f"{API}/india/rainfall/classify?mm_24h=120").json()
    assert classified["category"] == "VERY_HEAVY"
    assert client.get(f"{API}/india/rainfall/classify?mm_24h=-1").status_code == 422


def _demo_alert(**overrides: object) -> dict[str, object]:
    return {
        "id": "alert-1",
        "title": "Flooding <nearby> & rising",
        "body": "Corroborated by 4 reports; not official.",
        "official": False,
        "is_demo": True,
        "created_at": "2023-12-04T14:10:00Z",
        "dispatched_at": "2023-12-04T14:10:00Z",
        "expires_at": "2023-12-04T14:40:00Z",
        "geometry": {"latitude": 12.9815, "longitude": 80.2207},
        "evidence_version": "evidence-demo-001",
        "model_version": "model-demo-20231204-001",
        **overrides,
    }


def _cap(alert: dict[str, object]) -> ElementTree.Element:
    document = india.alert_to_cap(
        alert, sender="demo@floodrise.invalid", sender_name="demo", area_description="Velachery"
    )
    assert document.startswith(b"<?xml")
    return ElementTree.fromstring(document)


def test_cap_demo_alert_is_an_exercise_in_ist() -> None:
    root = _cap(_demo_alert())
    assert root.tag == f"{CAP}alert"
    assert root.findtext(f"{CAP}status") == "Exercise"
    # CAP forbids "Z"; 14:10 UTC is 19:40 IST.
    assert root.findtext(f"{CAP}sent") == "2023-12-04T19:40:00+05:30"
    info = root.find(f"{CAP}info")
    assert info is not None
    assert info.findtext(f"{CAP}headline") == "Flooding <nearby> & rising"
    assert info.findtext(f"{CAP}certainty") == "Possible"
    assert info.findtext(f"{CAP}expires") == "2023-12-04T20:10:00+05:30"
    assert info.findtext(f"{CAP}area/{CAP}circle") == "12.98150,80.22070 1"
    parameters = {
        node.findtext(f"{CAP}valueName"): node.findtext(f"{CAP}value")
        for node in info.findall(f"{CAP}parameter")
    }
    assert parameters["floodrise:official"] == "false"
    assert parameters["floodrise:is_simulated"] == "true"


def test_cap_official_live_alert_and_unknown_geometry() -> None:
    root = _cap(_demo_alert(official=True, is_demo=False, geometry={"type": "Polygon"}))
    assert root.findtext(f"{CAP}status") == "Actual"
    assert root.find(f"{CAP}note") is None
    info = root.find(f"{CAP}info")
    assert info is not None
    assert info.findtext(f"{CAP}severity") == "Severe"
    assert info.find(f"{CAP}area/{CAP}circle") is None
    assert info.findtext(f"{CAP}area/{CAP}areaDesc") == "Velachery"


def test_cap_endpoint_exports_a_seeded_or_created_alert(client: TestClient) -> None:
    assert client.get(f"{API}/alerts/missing/cap").status_code == 404
    for number in range(1, 5):
        response = client.post(
            f"{API}/reports",
            headers={
                "X-Demo-User": f"reporter-{number}",
                "X-Demo-Role": "reporter",
                "Idempotency-Key": f"cap-report-{number}",
            },
            json={
                "client_report_id": f"cap-report-{number:02d}",
                "incident_id": INCIDENT_ID,
                "reporter_id": f"reporter-{number}",
                "device_id": f"device-{number}",
                "observed_at": "2023-12-04T14:00:00Z",
                "location": {
                    "latitude": 12.98150 + number * 0.00004,
                    "longitude": 80.22070 + number * 0.00004,
                    "accuracy_m": 20,
                },
                "water_depth": "KNEE",
                "road_status": "IMPASSABLE",
                "flood_status": "FLOODED",
            },
        )
        assert response.status_code < 300, response.text
    alerts = client.get(f"{API}/alerts", params={"incident_id": INCIDENT_ID}).json()["items"]
    assert alerts, "four independent reports should have produced a community caution"
    response = client.get(f"{API}/alerts/{alerts[0]['id']}/cap")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("application/cap+xml")
    root = ElementTree.fromstring(response.content)
    assert root.findtext(f"{CAP}identifier") == alerts[0]["id"]
    assert root.findtext(f"{CAP}status") == "Exercise"
