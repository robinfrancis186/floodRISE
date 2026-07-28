from io import BytesIO
from pathlib import Path
from shutil import copytree

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.artifacts import (
    TRANSPARENT_TILE_PNG,
    ArtifactManifestError,
    default_manifest_path,
    load_artifact_store,
)
from app.main import app

client = TestClient(app)


def test_rejects_arbitrary_artifact() -> None:
    response = client.get("/api/v1/raster/https:%2F%2Fevil.invalid%2Fa/1/1/1.png")
    assert response.status_code in {404, 422}


def test_known_artifact_tile_and_metadata() -> None:
    metadata = client.get("/api/v1/raster/depth-p50-now/tilejson.json")
    assert metadata.status_code == 200
    body = metadata.json()
    assert body["is_simulated"] is True
    assert body["data_label"] == "DEMO DATA"
    assert body["classification"] == "RAPID_IMPACT_ESTIMATE"
    assert body["representation"] == "PACKAGED_PGM"
    assert body["model_version"] == "model-demo-20231204-001"
    assert body["tiles"][0].endswith(".png?v=raster-demo-20231204-p50-now-v1")
    assert body["sample_unit"] == "centimetres"
    assert body["scale_to_metres"] == 0.01
    assert body["artifact_sha256"] == (
        "318d675624ec47706124bd6596849012b214363d74bb3b9d19fafc6c9f4adc8c"
    )
    assert body["provenance"]["quality_flags"] == [
        "SYNTHETIC",
        "DETERMINISTIC",
        "NOT_HYDRAULICALLY_CERTIFIED",
    ]

    tile = client.get("/api/v1/raster/depth-p50-now/10/729/483.png")
    assert tile.status_code == 200
    assert tile.headers["content-type"] == "image/png"
    assert tile.headers["x-floodrise-representation"] == "PACKAGED_PGM"
    assert tile.headers["x-floodrise-artifact-sha256"] == body["artifact_sha256"]
    assert tile.headers["cache-control"] == "public, max-age=300, must-revalidate"
    image = Image.open(BytesIO(tile.content)).convert("RGBA")
    assert image.size == (256, 256)
    assert image.getchannel("A").getextrema()[1] > 0


def test_tile_rendering_is_deterministic_and_supports_conditional_get() -> None:
    first = client.get("/api/v1/raster/depth-p90-3h/10/729/483.png")
    second = client.get("/api/v1/raster/depth-p90-3h/10/729/483.png")
    assert first.status_code == second.status_code == 200
    assert first.content == second.content
    assert first.headers["etag"] == second.headers["etag"]

    unchanged = client.get(
        "/api/v1/raster/depth-p90-3h/10/729/483.png",
        headers={"If-None-Match": first.headers["etag"]},
    )
    assert unchanged.status_code == 304
    assert unchanged.content == b""


def test_tile_outside_fixture_bounds_is_transparent_and_invalid_coordinate_fails() -> None:
    outside = client.get("/api/v1/raster/depth-p50-now/10/722/449.png")
    assert outside.status_code == 200
    assert outside.content == TRANSPARENT_TILE_PNG
    image = Image.open(BytesIO(outside.content)).convert("RGBA")
    assert image.getchannel("A").getextrema()[1] == 0

    assert client.get("/api/v1/raster/depth-p50-now/7/1/1.png").status_code == 400
    assert client.get("/api/v1/raster/depth-p50-now/10/1024/1.png").status_code == 400


def test_outside_tile_uses_constant_time_transparent_path(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def unexpected_render(*_args: object, **_kwargs: object) -> bytes:
        raise AssertionError("out-of-coverage tile reached the raster renderer")

    monkeypatch.setattr("app.main.render_tile", unexpected_render)
    outside = client.get("/api/v1/raster/depth-p50-now/10/722/449.png")

    assert outside.status_code == 200
    assert outside.content == TRANSPARENT_TILE_PNG


def test_inside_tile_still_uses_raster_renderer(monkeypatch: pytest.MonkeyPatch) -> None:
    from app import main as tile_main

    original_render = tile_main.render_tile
    rendered: list[tuple[int, int, int]] = []

    def recording_render(artifact: object, z: int, x: int, y: int) -> bytes:
        rendered.append((z, x, y))
        return original_render(artifact, z, x, y)

    monkeypatch.setattr(tile_main, "render_tile", recording_render)
    inside = client.get("/api/v1/raster/depth-p50-now/10/729/483.png")

    assert inside.status_code == 200
    assert rendered == [(10, 729, 483)]
    assert Image.open(BytesIO(inside.content)).convert("RGBA").getchannel("A").getextrema()[1] > 0


def test_health_proves_loaded_manifest() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["artifact_count"] == 2
    assert body["representation"] == "PACKAGED_PGM"
    assert len(body["manifest_sha256"]) == 64


def test_store_fails_closed_when_packaged_raster_is_modified(tmp_path: Path) -> None:
    copied = tmp_path / "rasters"
    copytree(default_manifest_path().parent, copied)
    raster = copied / "depth-p50-now.pgm"
    raster.write_bytes(raster.read_bytes() + b"\n0\n")

    with pytest.raises(ArtifactManifestError, match="checksum mismatch"):
        load_artifact_store(copied / "manifest.json")


def test_packaged_demo_store_is_disabled_in_production(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("FLOODRISE_ENV", "production")
    with pytest.raises(ArtifactManifestError, match="disabled in production"):
        load_artifact_store(default_manifest_path())
