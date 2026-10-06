"""Packaged OpenStreetMap facility baseline (ODbL), served fully offline.

The snapshot is community-mapped data: it says where a hospital, school, or
police station has been mapped, not whether it is open, reachable, staffed, or
an activated shelter. Responses always carry that notice and the OSM
attribution required by the Open Database License.
"""

from __future__ import annotations

import hashlib
import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from .domain import haversine_m
from .errors import AppError
from .seed import DEFAULT_FIXTURE_ROOT, REPOSITORY_ROOT

PLACES_FILE = "osm-places.geojson"
FACILITY_KINDS = frozenset(
    {"HOSPITAL", "FIRE_STATION", "POLICE", "SCHOOL", "COLLEGE", "COMMUNITY_CENTRE"}
)
MAX_RADIUS_M = 25_000
DEFAULT_BASELINE = "in-tn-chennai"
# Baseline id -> fixture directory. Chennai is the pilot-area snapshot inside
# the demo bundle; Kerala is a statewide snapshot with no scenario data.
BASELINE_ROOTS: dict[str, Path] = {
    DEFAULT_BASELINE: DEFAULT_FIXTURE_ROOT,
    "in-kl": REPOSITORY_ROOT / "fixtures" / "regions" / "in-kl",
}
_NAME_LANGUAGES = ("en", "ta", "hi", "ml")


class FacilityBaselineError(RuntimeError):
    """The packaged snapshot is missing, altered, or not attributable."""


@lru_cache(maxsize=4)
def load_facility_baseline(fixture_root: Path = DEFAULT_FIXTURE_ROOT) -> dict[str, Any]:
    """Load the snapshot only if it matches the checksum pinned in the manifest."""

    try:
        manifest = json.loads((fixture_root / "manifest.json").read_text(encoding="utf-8"))
        payload = (fixture_root / PLACES_FILE).read_bytes()
    except (OSError, json.JSONDecodeError) as exc:
        raise FacilityBaselineError("The OpenStreetMap facility baseline is unavailable") from exc
    pinned = {entry["path"]: entry["sha256"] for entry in manifest.get("files", [])}
    if pinned.get(PLACES_FILE) != hashlib.sha256(payload).hexdigest():
        raise FacilityBaselineError("The OpenStreetMap facility baseline failed its checksum")
    collection = json.loads(payload)
    if "OpenStreetMap" not in str(collection.get("attribution")) or "ODbL" not in str(
        collection.get("licence")
    ):
        raise FacilityBaselineError("The OpenStreetMap facility baseline lacks attribution")
    return collection


def _view(feature: dict[str, Any], distance_m: float | None) -> dict[str, Any]:
    properties = feature["properties"]
    longitude, latitude = feature["geometry"]["coordinates"]
    return {
        "id": feature["id"],
        "kind": properties["kind"],
        "name": properties["name"],
        "names": {
            language: properties[f"name_{language}"]
            for language in _NAME_LANGUAGES
            if properties.get(f"name_{language}")
        },
        "location": {"latitude": latitude, "longitude": longitude},
        "distance_m": None if distance_m is None else round(distance_m),
        # Compact statewide snapshots omit the URL because it follows from the id.
        "source_url": properties.get("source_url")
        or f"https://www.openstreetmap.org/{properties['osm_type']}/{properties['osm_id']}",
        "is_simulated": False,
        "verified_by_authority": False,
    }


def find_facilities(
    *,
    kinds: frozenset[str] | None = None,
    latitude: float | None = None,
    longitude: float | None = None,
    radius_m: float | None = None,
    limit: int = 20,
    baseline: str = DEFAULT_BASELINE,
    fixture_root: Path | None = None,
) -> dict[str, Any]:
    """Filter the baseline by kind and, when an origin is given, by distance."""

    if (latitude is None) != (longitude is None):
        raise AppError(
            status_code=422,
            title="Incomplete origin",
            detail="latitude and longitude must be supplied together.",
            code="INCOMPLETE_ORIGIN",
        )
    if radius_m is not None and latitude is None:
        raise AppError(
            status_code=422,
            title="Incomplete origin",
            detail="radius_m requires latitude and longitude.",
            code="INCOMPLETE_ORIGIN",
        )
    unknown = (kinds or frozenset()) - FACILITY_KINDS
    if unknown:
        raise AppError(
            status_code=422,
            title="Unknown facility kind",
            detail=f"Supported kinds: {', '.join(sorted(FACILITY_KINDS))}.",
            code="UNKNOWN_FACILITY_KIND",
        )
    if fixture_root is None and baseline not in BASELINE_ROOTS:
        raise AppError(
            status_code=404,
            title="Unknown facility baseline",
            detail=f"Available baselines: {', '.join(sorted(BASELINE_ROOTS))}.",
            code="UNKNOWN_FACILITY_BASELINE",
        )
    try:
        collection = load_facility_baseline(fixture_root or BASELINE_ROOTS[baseline])
    except FacilityBaselineError as exc:
        raise AppError(
            status_code=503,
            title="Facility baseline unavailable",
            detail=str(exc),
            code="FACILITY_BASELINE_UNAVAILABLE",
        ) from exc

    origin = None if latitude is None else {"latitude": latitude, "longitude": longitude}
    matches: list[tuple[float | None, dict[str, Any]]] = []
    for feature in collection["features"]:
        if kinds and feature["properties"]["kind"] not in kinds:
            continue
        distance = None
        if origin is not None:
            feature_longitude, feature_latitude = feature["geometry"]["coordinates"]
            distance = haversine_m(
                origin, {"latitude": feature_latitude, "longitude": feature_longitude}
            )
            if radius_m is not None and distance > radius_m:
                continue
        matches.append((distance, feature))
    if origin is not None:
        matches.sort(key=lambda item: (item[0], item[1]["id"]))

    return {
        "items": [_view(feature, distance) for distance, feature in matches[:limit]],
        "total_matching": len(matches),
        "next_cursor": None,
        "has_more": len(matches) > limit,
        "baseline": baseline,
        "attribution": collection["attribution"],
        "licence": collection["licence"],
        "source_snapshot_at": collection.get("source_snapshot_at"),
        "notice": collection.get("notice"),
    }


__all__ = [
    "BASELINE_ROOTS",
    "DEFAULT_BASELINE",
    "FACILITY_KINDS",
    "FacilityBaselineError",
    "find_facilities",
    "load_facility_baseline",
]
