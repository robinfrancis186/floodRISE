from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import re
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Any

from PIL import Image

SCHEMA_VERSION = "floodrise-packaged-raster/v1"
RENDERER_VERSION = "packaged-pgm-nearest-v1"
ARTIFACT_ID = re.compile(r"^[a-z0-9][a-z0-9-]{0,79}$")
TILE_SIZE = 256
MIN_ZOOM = 8
MAX_ZOOM = 16


class ArtifactManifestError(RuntimeError):
    """Raised when a raster manifest or its immutable content fails validation."""


@dataclass(frozen=True)
class RasterArtifact:
    id: str
    version: str
    title: str
    content_sha256: str
    model_version: str
    bounds: tuple[float, float, float, float]
    width: int
    height: int
    samples: tuple[int, ...]
    quantile: str
    horizon: str
    valid_at: str
    valid_until: str
    confidence: float
    statistics: dict[str, float | int]

    def sample(self, longitude: float, latitude: float) -> int:
        west, south, east, north = self.bounds
        if not (west <= longitude < east and south < latitude <= north):
            return 0
        column = min(self.width - 1, int((longitude - west) / (east - west) * self.width))
        row = min(self.height - 1, int((north - latitude) / (north - south) * self.height))
        return self.samples[row * self.width + column]


@dataclass(frozen=True)
class ArtifactStore:
    schema_version: str
    scenario_id: str
    incident_id: str
    model_version: str
    generated_at: str
    data_label: str
    representation: str
    provenance: dict[str, Any]
    rendering: dict[str, Any]
    artifacts: dict[str, RasterArtifact]
    manifest_sha256: str

    def get(self, artifact_id: str) -> RasterArtifact | None:
        return self.artifacts.get(artifact_id)


def default_manifest_path() -> Path:
    configured = os.environ.get("FLOODRISE_RASTER_MANIFEST")
    if configured:
        return Path(configured).expanduser().resolve()
    return (
        Path(__file__).resolve().parents[3]
        / "fixtures"
        / "chennai-demo"
        / "rasters"
        / "manifest.json"
    )


def _required_string(value: Any, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ArtifactManifestError(f"{field} must be a non-empty string")
    return value


def _safe_artifact_path(root: Path, relative_path: Any) -> Path:
    relative = Path(_required_string(relative_path, "artifact.path"))
    if relative.is_absolute():
        raise ArtifactManifestError("artifact.path must be relative to the manifest")
    candidate = (root / relative).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as exc:
        raise ArtifactManifestError("artifact.path escapes the manifest directory") from exc
    return candidate


def _parse_ascii_pgm(payload: bytes, expected_width: int, expected_height: int) -> tuple[int, ...]:
    try:
        text = payload.decode("ascii")
    except UnicodeDecodeError as exc:
        raise ArtifactManifestError("packaged raster must be an ASCII PGM (P2)") from exc

    tokens: list[str] = []
    for line in text.splitlines():
        tokens.extend(line.partition("#")[0].split())
    if len(tokens) < 4 or tokens[0] != "P2":
        raise ArtifactManifestError("packaged raster must use the PGM P2 encoding")
    try:
        width, height, maximum = (int(token) for token in tokens[1:4])
        samples = tuple(int(token) for token in tokens[4:])
    except ValueError as exc:
        raise ArtifactManifestError("packaged raster contains a non-integer sample") from exc
    if (width, height) != (expected_width, expected_height):
        raise ArtifactManifestError("packaged raster dimensions do not match its manifest")
    if maximum <= 0 or maximum > 65_535:
        raise ArtifactManifestError("packaged raster maximum is invalid")
    if len(samples) != width * height:
        raise ArtifactManifestError("packaged raster sample count does not match its dimensions")
    if any(sample < 0 or sample > maximum for sample in samples):
        raise ArtifactManifestError("packaged raster sample is outside the declared range")
    return samples


def load_artifact_store(manifest_path: Path | None = None) -> ArtifactStore:
    path = (manifest_path or default_manifest_path()).resolve()
    try:
        manifest_payload = path.read_bytes()
        document = json.loads(manifest_payload)
    except (OSError, json.JSONDecodeError) as exc:
        raise ArtifactManifestError(f"cannot load raster manifest at {path}") from exc
    if not isinstance(document, dict):
        raise ArtifactManifestError("raster manifest root must be an object")
    runtime_environment = os.environ.get("FLOODRISE_ENV", "demo").strip().lower()
    if runtime_environment in {"live", "prod", "production"}:
        raise ArtifactManifestError(
            "packaged demo rasters are disabled in production; configure the reviewed COG adapter"
        )
    if document.get("schema_version") != SCHEMA_VERSION:
        raise ArtifactManifestError(f"raster manifest schema must be {SCHEMA_VERSION}")
    if document.get("is_simulated") is not True or document.get("data_label") != "DEMO DATA":
        raise ArtifactManifestError("demo raster manifest must retain DEMO DATA simulation labels")
    if document.get("representation") != "PACKAGED_PGM":
        raise ArtifactManifestError("this lightweight service only accepts packaged PGM rasters")

    model_version = _required_string(document.get("model_version"), "model_version")
    entries = document.get("artifacts")
    if not isinstance(entries, list) or not entries:
        raise ArtifactManifestError("raster manifest must contain at least one artifact")

    artifacts: dict[str, RasterArtifact] = {}
    for entry in entries:
        if not isinstance(entry, dict):
            raise ArtifactManifestError("artifact entries must be objects")
        artifact_id = _required_string(entry.get("id"), "artifact.id")
        if not ARTIFACT_ID.fullmatch(artifact_id) or artifact_id in artifacts:
            raise ArtifactManifestError(f"invalid or duplicate artifact id: {artifact_id}")
        artifact_path = _safe_artifact_path(path.parent, entry.get("path"))
        try:
            payload = artifact_path.read_bytes()
        except OSError as exc:
            raise ArtifactManifestError(f"cannot load packaged raster: {artifact_id}") from exc
        digest = hashlib.sha256(payload).hexdigest()
        expected_digest = _required_string(entry.get("content_sha256"), "content_sha256")
        if not hmac.compare_digest(digest, expected_digest):
            raise ArtifactManifestError(f"checksum mismatch for packaged raster: {artifact_id}")

        try:
            width = int(entry["width"])
            height = int(entry["height"])
            bounds_values = tuple(float(value) for value in entry["bounds"])
            confidence = float(entry["confidence"])
        except (KeyError, TypeError, ValueError) as exc:
            raise ArtifactManifestError(f"invalid geospatial metadata for: {artifact_id}") from exc
        if width <= 0 or height <= 0 or len(bounds_values) != 4:
            raise ArtifactManifestError(f"invalid raster dimensions or bounds for: {artifact_id}")
        west, south, east, north = bounds_values
        if not (-180 <= west < east <= 180 and -85.051129 <= south < north <= 85.051129):
            raise ArtifactManifestError(f"invalid RFC 7946 bounds for: {artifact_id}")
        if entry.get("crs") != "EPSG:4326" or entry.get("row_order") != "north_to_south":
            raise ArtifactManifestError(f"unsupported CRS or row order for: {artifact_id}")
        if not 0 <= confidence <= 1:
            raise ArtifactManifestError(f"confidence is outside 0..1 for: {artifact_id}")
        samples = _parse_ascii_pgm(payload, width, height)

        statistics = entry.get("statistics")
        if not isinstance(statistics, dict):
            raise ArtifactManifestError(f"statistics are missing for: {artifact_id}")
        artifacts[artifact_id] = RasterArtifact(
            id=artifact_id,
            version=_required_string(entry.get("version"), "artifact.version"),
            title=_required_string(entry.get("title"), "artifact.title"),
            content_sha256=digest,
            model_version=model_version,
            bounds=(west, south, east, north),
            width=width,
            height=height,
            samples=samples,
            quantile=_required_string(entry.get("quantile"), "artifact.quantile"),
            horizon=_required_string(entry.get("horizon"), "artifact.horizon"),
            valid_at=_required_string(entry.get("valid_at"), "artifact.valid_at"),
            valid_until=_required_string(entry.get("valid_until"), "artifact.valid_until"),
            confidence=confidence,
            statistics=statistics,
        )

    provenance = document.get("provenance")
    rendering = document.get("rendering")
    if not isinstance(provenance, dict) or not isinstance(rendering, dict):
        raise ArtifactManifestError("raster manifest provenance and rendering must be objects")
    return ArtifactStore(
        schema_version=SCHEMA_VERSION,
        scenario_id=_required_string(document.get("scenario_id"), "scenario_id"),
        incident_id=_required_string(document.get("incident_id"), "incident_id"),
        model_version=model_version,
        generated_at=_required_string(document.get("generated_at"), "generated_at"),
        data_label="DEMO DATA",
        representation="PACKAGED_PGM",
        provenance=provenance,
        rendering=rendering,
        artifacts=artifacts,
        manifest_sha256=hashlib.sha256(manifest_payload).hexdigest(),
    )


def _tile_longitudes(x: int, z: int) -> list[float]:
    scale = 1 << z
    return [((x + (pixel + 0.5) / TILE_SIZE) / scale) * 360.0 - 180.0 for pixel in range(TILE_SIZE)]


def _tile_latitudes(y: int, z: int) -> list[float]:
    scale = 1 << z
    return [
        math.degrees(
            math.atan(math.sinh(math.pi * (1 - 2 * (y + (pixel + 0.5) / TILE_SIZE) / scale)))
        )
        for pixel in range(TILE_SIZE)
    ]


def _depth_colour(depth_centimetres: int) -> tuple[int, int, int, int]:
    if depth_centimetres <= 0:
        return (0, 0, 0, 0)
    if depth_centimetres < 15:
        return (113, 190, 255, 92)
    if depth_centimetres < 30:
        return (55, 148, 235, 130)
    if depth_centimetres < 60:
        return (22, 111, 205, 164)
    return (8, 62, 126, 198)


def render_tile(artifact: RasterArtifact, z: int, x: int, y: int) -> bytes:
    longitudes = _tile_longitudes(x, z)
    latitudes = _tile_latitudes(y, z)
    pixels = [
        _depth_colour(artifact.sample(longitude, latitude))
        for latitude in latitudes
        for longitude in longitudes
    ]
    image = Image.new("RGBA", (TILE_SIZE, TILE_SIZE), (0, 0, 0, 0))
    image.putdata(pixels)
    output = BytesIO()
    image.save(output, format="PNG", optimize=True)
    return output.getvalue()


def tile_etag(artifact: RasterArtifact, z: int, x: int, y: int) -> str:
    identity = f"{artifact.content_sha256}:{z}:{x}:{y}:{RENDERER_VERSION}".encode()
    return f'"{hashlib.sha256(identity).hexdigest()}"'


__all__ = [
    "ArtifactManifestError",
    "ArtifactStore",
    "MAX_ZOOM",
    "MIN_ZOOM",
    "RENDERER_VERSION",
    "RasterArtifact",
    "load_artifact_store",
    "render_tile",
    "tile_etag",
]
