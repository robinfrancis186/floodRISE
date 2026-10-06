"""Tests for the packaged OpenStreetMap facility baseline."""

from __future__ import annotations

import json
import shutil
from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import osm
from app.config import Settings
from app.database import Database
from app.errors import AppError
from app.main import create_app
from app.seed import DEFAULT_FIXTURE_ROOT

API = "/api/v1"
VELACHERY = {"latitude": 12.9815, "longitude": 80.2207}


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


def test_nearest_hospitals_are_sorted_attributed_and_unverified() -> None:
    result = osm.find_facilities(kinds=frozenset({"HOSPITAL"}), **VELACHERY, limit=5)
    distances = [item["distance_m"] for item in result["items"]]
    assert len(distances) == 5
    assert distances == sorted(distances)
    assert distances[0] < 2_000
    assert result["has_more"] is True
    assert result["attribution"] == "© OpenStreetMap contributors"
    assert "ODbL" in result["licence"]
    assert "Not an activated shelter list" in result["notice"]
    for item in result["items"]:
        assert item["kind"] == "HOSPITAL"
        assert item["is_simulated"] is False
        assert item["verified_by_authority"] is False
        assert item["source_url"].startswith("https://www.openstreetmap.org/")


def test_radius_limits_results_and_requires_an_origin() -> None:
    near = osm.find_facilities(**VELACHERY, radius_m=500, limit=100)
    assert all(item["distance_m"] <= 500 for item in near["items"])
    assert near["total_matching"] == len(near["items"])
    with pytest.raises(AppError):
        osm.find_facilities(radius_m=500)
    with pytest.raises(AppError):
        osm.find_facilities(latitude=12.98)
    with pytest.raises(AppError):
        osm.find_facilities(kinds=frozenset({"CASINO"}))


def test_without_origin_results_have_no_distance() -> None:
    result = osm.find_facilities(kinds=frozenset({"FIRE_STATION"}))
    assert result["items"]
    assert all(item["distance_m"] is None for item in result["items"])


def test_altered_snapshot_fails_closed(tmp_path: Path) -> None:
    for name in ("manifest.json", osm.PLACES_FILE):
        shutil.copy(DEFAULT_FIXTURE_ROOT / name, tmp_path / name)
    collection = json.loads((tmp_path / osm.PLACES_FILE).read_text(encoding="utf-8"))
    collection["features"][0]["properties"]["name"] = "Tampered"
    (tmp_path / osm.PLACES_FILE).write_text(json.dumps(collection), encoding="utf-8")
    with pytest.raises(osm.FacilityBaselineError):
        osm.load_facility_baseline(tmp_path)
    with pytest.raises(AppError) as raised:
        osm.find_facilities(fixture_root=tmp_path)
    assert raised.value.status_code == 503


def test_facilities_endpoint(client: TestClient) -> None:
    response = client.get(
        f"{API}/osm/facilities",
        params={"kind": ["HOSPITAL", "POLICE"], **VELACHERY, "radius_m": 3000, "limit": 3},
    )
    assert response.status_code == 200
    body = response.json()
    assert len(body["items"]) == 3
    assert {item["kind"] for item in body["items"]} <= {"HOSPITAL", "POLICE"}
    assert body["attribution"] == "© OpenStreetMap contributors"
    assert client.get(f"{API}/osm/facilities", params={"kind": "CASINO"}).status_code == 422
    assert client.get(f"{API}/osm/facilities", params={"latitude": 12.98}).status_code == 422
    assert client.get(f"{API}/osm/facilities", params={"limit": 1000}).status_code == 422


KOCHI = {"latitude": 9.9312, "longitude": 76.2673}


def test_kerala_baseline_serves_statewide_facilities_with_derived_links() -> None:
    result = osm.find_facilities(
        kinds=frozenset({"HOSPITAL"}), **KOCHI, radius_m=5_000, limit=10, baseline="in-kl"
    )
    assert result["baseline"] == "in-kl"
    assert len(result["items"]) == 10
    assert result["total_matching"] > 10
    assert result["attribution"] == "© OpenStreetMap contributors"
    for item in result["items"]:
        assert item["distance_m"] <= 5_000
        assert item["source_url"].startswith("https://www.openstreetmap.org/")
        assert item["source_url"].rsplit("/", 1)[1] == item["id"].rsplit("-", 1)[1]
        assert 8.1 <= item["location"]["latitude"] <= 12.9
    everything = osm.find_facilities(baseline="in-kl", limit=1)
    assert everything["total_matching"] > 20_000
    assert any(
        "ml" in osm._view(feature, None)["names"]
        for feature in osm.load_facility_baseline(osm.BASELINE_ROOTS["in-kl"])["features"]
    )


def test_baselines_do_not_leak_into_each_other() -> None:
    chennai = osm.find_facilities(**KOCHI, radius_m=25_000)
    assert chennai["baseline"] == "in-tn-chennai"
    assert chennai["items"] == []
    with pytest.raises(AppError) as raised:
        osm.find_facilities(baseline="in-xx")
    assert raised.value.status_code == 404


def test_kerala_baseline_endpoint(client: TestClient) -> None:
    response = client.get(
        f"{API}/osm/facilities",
        params={"baseline": "in-kl", "kind": "FIRE_STATION", **KOCHI, "limit": 2},
    )
    assert response.status_code == 200
    assert [item["kind"] for item in response.json()["items"]] == ["FIRE_STATION"] * 2
    assert client.get(f"{API}/osm/facilities", params={"baseline": "nope"}).status_code == 404
    kerala = [
        region
        for region in client.get(f"{API}/india/regions").json()["items"]
        if region["state_code"] == "IN-KL"
    ]
    assert len(kerala) == 5
    assert {region["facility_baseline"] for region in kerala} == {"in-kl"}
    assert all(region["data_status"] == "REGISTERED_NO_DATA" for region in kerala)
