"""Deterministic Kerala demo seed, independent of the process working directory."""

from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from .database import Database, EntityChange, EventInput, canonical_json

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_FIXTURE_ROOT = REPOSITORY_ROOT / "fixtures" / "kerala-demo"
LEGACY_DEMO_SCENARIOS = {
    ("demo-michaung-chennai-v1", "inc-demo-michaung-2023"),
}


def _read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback


def _iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _pending_approval(
    *,
    incident_id: str,
    clock: datetime,
    presentation_id: str,
    action_type: str,
    title: str,
    body: str,
    audience: str,
    evidence_version: str,
    model_version: str,
    requested_by: str,
) -> dict[str, Any]:
    """Build a contract-faithful, versioned approval for the judging replay."""

    request = {
        "incident_id": incident_id,
        "action_type": action_type,
        "action_payload": {
            "presentation_id": presentation_id,
            "title": title,
            "body": body,
        },
        "audience": audience,
        "geometry": {"type": "Point", "coordinates": [76.3517000, 10.1065000]},
        "evidence_version": evidence_version,
        "model_version": model_version,
        "reason": body,
    }
    payload_digest = hashlib.sha256(canonical_json(request).encode()).hexdigest()
    return {
        "id": f"approval-{payload_digest[:14]}",
        **request,
        "payload_digest": payload_digest,
        "status": "PENDING",
        "requested_by": requested_by,
        "requested_role": "incident_commander",
        "requested_at": _iso(clock),
        "expires_at": _iso(clock + timedelta(minutes=15)),
        "decided_by": None,
        "decided_at": None,
        "decision_reason": None,
        "execution_status": "NOT_STARTED",
        "is_simulated": True,
        "version": 1,
    }


def build_seed_bundle(
    fixture_root: Path | None = None,
) -> tuple[list[EntityChange], dict[str, Any]]:
    fixture_root = (fixture_root or DEFAULT_FIXTURE_ROOT).resolve()
    manifest = _read_json(
        fixture_root / "manifest.json",
        {
            "scenario_id": "demo-kerala-flood-v1",
            "incident_id": "inc-demo-kerala-flood-2023",
            "title": "Kerala extreme-rainfall deterministic replay",
            "area": "Aluva–Eloor–Kalamassery and the Periyar floodplain",
            "clock_start": "2023-12-04T14:10:00Z",
            "timezone": "Asia/Kolkata",
            "is_simulated": True,
            "alert_gateway": "fake://notification-sink",
            "live_integrations_enabled": False,
            "model_version": "model-demo-20231204-001",
            "evidence_version": "evidence-demo-001",
        },
    )
    incident_id = manifest["incident_id"]
    clock = datetime.fromisoformat(manifest["clock_start"].replace("Z", "+00:00"))

    incident = {
        "id": incident_id,
        "scenario_id": manifest["scenario_id"],
        "title": manifest["title"],
        "name": manifest["title"],
        "area": manifest["area"],
        "area_name": manifest["area"],
        "state": "ACTIVE",
        "status": "ACTIVE",
        "disaster_type": "FLOOD",
        "severity": "SEVERE",
        "started_at": _iso(clock),
        "updated_at": _iso(clock),
        "scenario_time": _iso(clock),
        "timezone": manifest.get("timezone", "Asia/Kolkata"),
        "is_simulated": True,
        "is_demo": True,
        "demo_label": "DEMO DATA",
        "data_label": "DEMO DATA",
        "public_alerts_enabled": False,
        "alert_gateway": "fake://notification-sink",
        "version": 1,
        "bounds": [76.2, 9.92, 76.48, 10.24],
    }

    source_specs = [
        (
            "imd-rainfall-demo",
            "India Meteorological Department",
            "HEALTHY",
            "10 minutes",
            "118 mm / 3 h deterministic fixture",
            "https://api.imd.gov.in/public/api_reference.html",
            "Government source; fixture-shaped response",
        ),
        (
            "cwc-gauge-demo",
            "Central Water Commission",
            "HEALTHY",
            "60 minutes",
            "Reservoir and river stage replay",
            "https://ffs.india-water.gov.in/",
            "Approved-access adapter represented by deterministic fixture",
        ),
        (
            "copernicus-gfm-demo",
            "Copernicus Global Flood Monitoring",
            "STALE",
            "Satellite-pass dependent",
            "Last observed flood extent retained; absence is not dry",
            "https://global-flood.emergency.copernicus.eu/",
            "Copernicus attribution required",
        ),
        (
            "copernicus-dem-glo30",
            "Copernicus DEM GLO-30",
            "HEALTHY",
            "Version release",
            "30 m surface model; not certified street-level depth",
            "https://dataspace.copernicus.eu/",
            "Copernicus DEM licence and attribution apply",
        ),
        (
            "osm-southern-zone-demo",
            "OpenStreetMap Overpass snapshot",
            "HEALTHY",
            "Daily",
            (
                "Packaged 2026-07-20 Kerala OSM baseline with 3,967 major-road "
                "segments; not event-time road status"
            ),
            "https://www.openstreetmap.org/",
            "ODbL attribution and share-alike obligations apply",
        ),
    ]
    sources: list[dict[str, Any]] = []
    for source_id, provider, status, cadence, summary, source_url, licence in source_specs:
        is_osm_baseline = source_id == "osm-southern-zone-demo"
        sources.append(
            {
                "id": source_id,
                "provider": provider,
                "source_url": source_url,
                "provider_record_id": source_id,
                "status": status,
                "observed_at": _iso(
                    clock - (timedelta(hours=9) if status == "STALE" else timedelta())
                ),
                "acquired_at": _iso(clock),
                "issued_at": _iso(clock),
                "ingested_at": _iso(clock),
                "last_ingested_at": _iso(clock),
                "valid_from": _iso(clock - timedelta(minutes=10)),
                "valid_until": _iso(clock + timedelta(minutes=30)),
                "coverage_geometry": {"type": "Point", "coordinates": [76.3517000, 10.1065000]},
                "confidence": 0.72 if status == "STALE" else 0.9,
                "quality_flags": (
                    ["PACKAGED_BASELINE", "NOT_EVENT_TIME"]
                    if is_osm_baseline
                    else ["DEMO_FIXTURE"] + (["STALE"] if status == "STALE" else [])
                ),
                "licence": licence,
                "attribution": ("© OpenStreetMap contributors" if is_osm_baseline else provider),
                "checksum": (
                    "a6f0271c54f8b842f607c0ecbeddb4c0f5e3263c22ba3597fc9e1851c13331d0"
                    if is_osm_baseline
                    else f"fixture-{source_id}-v1"
                ),
                "version": "osm-2026-07-20T18:40:36Z" if is_osm_baseline else "demo-v1",
                "raw_payload_reference": (
                    "fixtures/kerala-demo/osm-baseline.geojson"
                    if is_osm_baseline
                    else f"fixtures/kerala-demo/{source_id}.json"
                ),
                "cadence": cadence,
                "summary": summary,
                "message": summary,
                "is_simulated": not is_osm_baseline,
            }
        )

    shelter_collection = _read_json(fixture_root / "shelters.geojson", {"features": []})
    shelters: list[dict[str, Any]] = []
    for feature in shelter_collection.get("features", []):
        props = feature.get("properties", {})
        shelters.append(
            {
                "id": str(feature.get("id")),
                "incident_id": incident_id,
                "name": props.get("name", "Unnamed shelter"),
                "location": feature.get("geometry"),
                "activation_status": props.get("activation_status", "UNKNOWN"),
                "availability": props.get("activation_status", "UNKNOWN"),
                "capacity_total": props.get("capacity_total"),
                "capacity_remaining": props.get("capacity_remaining"),
                "capacity": props.get("capacity_total"),
                "occupancy": (
                    props.get("capacity_total", 0) - props.get("capacity_remaining", 0)
                    if props.get("capacity_total") is not None
                    and props.get("capacity_remaining") is not None
                    else None
                ),
                "access_status": props.get("access_status", "UNKNOWN"),
                "verified_at": props.get("verified_at"),
                "observed_at": props.get("verified_at"),
                "verified_by": "demo-shelter-manager",
                "source": "Deterministic Kerala demo fixture",
                "is_simulated": True,
                "version": 1,
            }
        )
    if not shelters:
        shelters.append(
            {
                "id": "shelter-aluva-school",
                "incident_id": incident_id,
                "name": "Aluva School Shelter",
                "location": {"type": "Point", "coordinates": [76.3492000, 10.1036000]},
                "activation_status": "OPEN",
                "availability": "OPEN",
                "capacity_total": 420,
                "capacity_remaining": 186,
                "capacity": 420,
                "occupancy": 234,
                "access_status": "REACHABLE",
                "verified_at": _iso(clock),
                "observed_at": _iso(clock),
                "verified_by": "demo-shelter-manager",
                "source": "Deterministic Kerala demo fixture",
                "is_simulated": True,
                "version": 1,
            }
        )

    road_collection = _read_json(fixture_root / "roads.geojson", {"features": []})
    roads: list[dict[str, Any]] = []
    for feature in road_collection.get("features", []):
        roads.append(
            {
                "id": str(feature.get("id")),
                "incident_id": incident_id,
                "geometry": feature.get("geometry"),
                **feature.get("properties", {}),
                "version": 1,
            }
        )

    simulation = {
        "id": manifest.get("model_version", "model-demo-20231204-001"),
        "incident_id": incident_id,
        "model_version": manifest.get("model_version", "model-demo-20231204-001"),
        "evidence_version": manifest.get("evidence_version", "evidence-demo-001"),
        "status": "PUBLISHED",
        "kind": "rapid impact estimate",
        "started_at": _iso(clock - timedelta(seconds=25)),
        "queued_at": _iso(clock - timedelta(seconds=30)),
        "completed_at": _iso(clock),
        "published_at": _iso(clock),
        "ensemble_members": 9,
        "horizons": ["now", "+30m", "+1h", "+3h"],
        "outputs": {
            "depth": ["p10", "p50", "p90"],
            "scenario_agreement": True,
            "artifact_manifest": "fixture://kerala-demo/rasters/manifest.json",
            "published_artifacts": ["depth-p50-now", "depth-p90-3h"],
            "representation": "PACKAGED_PGM",
        },
        "is_simulated": True,
        "version": 1,
    }
    impact = {
        "id": "impact-demo-20231204-001",
        "incident_id": incident_id,
        "model_version": simulation["model_version"],
        "evidence_version": simulation["evidence_version"],
        "affected_population_estimate": 18_420,
        "population_label": "2025 modelled estimate; not an official count",
        "affected_communities": 6,
        "roads_at_risk": 14,
        "shelters_reachable": sum(s["access_status"] == "REACHABLE" for s in shelters),
        "confidence": 0.78,
        "valid_until": _iso(clock + timedelta(minutes=10)),
        "is_simulated": True,
        "version": 1,
    }
    # An authoritative, versioned aggregate backs the console's initial
    # ALV-042 review. It is explicitly a presentation checkpoint rather than
    # four stored citizen reports. The first submitted report rebuilds this
    # aggregate from actual evidence and removes ``presentation_seed``.
    initial_signal = {
        "id": "signal-aluva-042",
        "incident_id": incident_id,
        "cluster_id": "cluster-aluva-042",
        "state": "NEEDS_REVIEW",
        "location": {"type": "Point", "coordinates": [76.3517000, 10.1065000]},
        "radius_m": 148.0,
        "diameter_m": 296.0,
        "confidence": 0.92,
        "confidence_breakdown": {
            "score": 0.92,
            "explanation": "Deterministic aggregated evidence review checkpoint",
        },
        "independent_report_count": 4,
        "authenticated_report_count": 2,
        "report_count": 7,
        "first_observed_at": _iso(clock - timedelta(minutes=8)),
        "last_observed_at": _iso(clock - timedelta(minutes=1)),
        "stale_at": _iso(clock + timedelta(minutes=59)),
        "expires_at": _iso(clock + timedelta(minutes=119)),
        "display_message": (
            "Deterministic evidence checkpoint requires authorized review; "
            "not an official confirmation."
        ),
        "evidence_version": manifest.get("evidence_version", "evidence-demo-001"),
        "contradiction_present": True,
        "route_recalculation_requested": False,
        "human_review": None,
        "presentation_seed": True,
        "is_simulated": True,
        "version": 1,
    }
    route = {
        "id": "route-lower-risk-001",
        "incident_id": incident_id,
        "label": "Lower-risk route to Aluva School Shelter",
        "duration_min": 18,
        "distance_km": 4.2,
        "shelter": "Aluva School Shelter",
        "shelter_id": "shelter-aluva-school",
        "risk": "LOWER",
        "reasons": [
            "Avoids modelled deep water on Aluva–Paravur Road",
            "Shelter access was verified in the demo fixture",
        ],
        "model_version": simulation["model_version"],
        "evidence_version": simulation["evidence_version"],
        "valid_until": _iso(clock + timedelta(minutes=10)),
        "wording": (
            "Lower-risk route; conditions can change. Follow official responder instructions."
        ),
        "is_simulated": True,
        "version": 1,
    }
    resilience = {
        "id": "audit-aluva-demo-v1",
        "incident_id": incident_id,
        "title": "Aluva resilience audit",
        "generated_at": _iso(clock),
        "modelled_scenario": True,
        "metrics": {
            "recurring_flood_pockets": 5,
            "road_closure_hours": 31,
            "shelter_access_gaps": 2,
            "modelled_population_exposure": 18_420,
            "evidence_coverage": 0.71,
        },
        "recommendations": [
            "Inspect recurring drain blockage locations before the next monsoon.",
            "Assess culvert capacity along the lower Aluva catchment.",
            "Evaluate an additional reachable shelter north of the modelled isolation pocket.",
            "Consider responder-grade water-level sensors at recurring evidence gaps.",
        ],
        "disclaimer": "Modelled scenario, not an engineering design.",
        "is_simulated": True,
        "version": 1,
    }

    evidence_version = simulation["evidence_version"]
    model_version = simulation["model_version"]
    approvals = [
        _pending_approval(
            incident_id=incident_id,
            clock=clock,
            presentation_id="ACT-204",
            action_type="AREA_CAUTION",
            title="Issue area caution and reroute teams",
            body=(
                "Use NH 544 for response teams. Community-corroborated flooding "
                "is not an official confirmation."
            ),
            audience="Aluva hazard footprint + 1 km",
            evidence_version=evidence_version,
            model_version=model_version,
            requested_by="demo-requester-area-caution",
        ),
        _pending_approval(
            incident_id=incident_id,
            clock=clock,
            presentation_id="ACT-198",
            action_type="ROAD_CLOSURE",
            title="Close Aluva–Paravur Road underpass",
            body="Close the modelled high-risk underpass after independent review.",
            audience="Road operations and navigation partners",
            evidence_version=evidence_version,
            model_version=model_version,
            requested_by="demo-requester-road-closure",
        ),
        _pending_approval(
            incident_id=incident_id,
            clock=clock,
            presentation_id="ACT-190",
            action_type="EVACUATION_GUIDANCE",
            title="Evacuation guidance for Ward 121",
            body=(
                "Proceed to designated shelters using lower-risk routes. Do not enter floodwater."
            ),
            audience="Ward 121 opted-in residents",
            evidence_version=evidence_version,
            model_version=model_version,
            requested_by="demo-requester-evacuation-guidance",
        ),
    ]

    timeline = _read_json(fixture_root / "timeline.json", [])
    fixture_reports = _read_json(fixture_root / "reports.json", [])
    changes = [
        EntityChange("incident", incident["id"], incident, incident["version"]),
        EntityChange("simulation", simulation["id"], simulation, simulation["version"]),
        EntityChange("impact", impact["id"], impact, impact["version"]),
        EntityChange("signal", initial_signal["id"], initial_signal, initial_signal["version"]),
        EntityChange("route", route["id"], route, route["version"]),
        EntityChange("resilience", resilience["id"], resilience, resilience["version"]),
    ]
    changes.extend(EntityChange("source", item["id"], item, 1) for item in sources)
    changes.extend(EntityChange("shelter", item["id"], item, item["version"]) for item in shelters)
    changes.extend(EntityChange("road", item["id"], item, item["version"]) for item in roads)
    changes.extend(
        EntityChange("approval", item["id"], item, item["version"]) for item in approvals
    )
    state = {
        "scenario_id": manifest["scenario_id"],
        "incident_id": incident_id,
        "scenario_clock": _iso(clock),
        "scenario_started_at": _iso(clock),
        "scenario_version": 1,
        "timeline_offset_seconds": 0,
        "timeline": timeline,
        "fixture_reports": fixture_reports,
        "demo_mode": True,
        "demo_label": "DEMO DATA",
        "fake_alert_gateway": manifest.get("alert_gateway", "fake://notification-sink"),
        "live_integrations_enabled": False,
    }
    return changes, state


def reset_database(database: Database) -> None:
    changes, state = build_seed_bundle()
    database.reset(changes=changes, state=state)
    approvals = [change.payload for change in changes if change.kind == "approval"]
    database.commit(
        events=[
            EventInput(
                event_type="approval.requested",
                aggregate_kind="approval",
                aggregate_id=approval["id"],
                aggregate_version=approval["version"],
                actor_id=approval["requested_by"],
                actor_role=approval["requested_role"],
                payload={
                    "action_type": approval["action_type"],
                    "payload_digest": approval["payload_digest"],
                    "expires_at": approval["expires_at"],
                    "seeded_demo_record": True,
                },
                incident_id=approval["incident_id"],
            )
            for approval in approvals
        ]
    )


def seed_database(database: Database) -> None:
    database.initialize()
    persisted_demo = (
        database.get_state("scenario_id"),
        database.get_state("incident_id"),
    )
    if database.is_empty() or persisted_demo in LEGACY_DEMO_SCENARIOS:
        reset_database(database)


if __name__ == "__main__":
    from .config import get_settings

    settings = get_settings()
    target = Database(settings.database_url)
    target.initialize()
    reset_database(target)
    print(f"Seeded deterministic {settings.environment} database at {settings.database_url}")
