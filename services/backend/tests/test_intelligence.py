"""Deterministic acceptance tests for rapid impact intelligence and routing."""

from __future__ import annotations

import json

import pytest

from app.intelligence import (
    ENSEMBLE_SIZE,
    HORIZONS,
    bounded_report_assimilation,
    explain_confidence,
    run_rapid_impact_model,
)
from app.routing import (
    build_demo_chennai_graph,
    edge_is_usable,
    find_lower_risk_routes,
    shelter_is_eligible,
)

SCENARIO = {
    "scenario_time": "2023-12-04T14:00:00Z",
    "rainfall_mm": 118.0,
    "river_stage_m": 2.65,
    "bankfull_stage_m": 2.35,
    "base_depth_m": 0.06,
    "terrain_susceptibility": 0.72,
    "drainage_efficiency": 0.38,
    "catchment_area_km2": 400.0,
    "exposure_population": 780_000,
    "is_simulated": True,
}


def test_confidence_is_explainable_and_matches_published_formula() -> None:
    result = explain_confidence(
        independent_families=4,
        mean_quality=0.5,
        external_corroboration=0.0,
        conflicts=0,
        fraud_risk=0.0,
    )

    assert result["score"] == pytest.approx(0.80)
    assert result["threshold_met"] is True
    assert result["terms"] == {
        "base": 0.15,
        "independent_support": 0.6,
        "mean_quality": 0.05,
        "additional_support": 0.0,
        "external_corroboration": 0.0,
        "conflict_penalty": 0.0,
        "fraud_penalty": 0.0,
    }
    assert "does not make" in result["authority_notice"]


def test_confidence_caps_inputs_and_final_score() -> None:
    result = explain_confidence(
        independent_families=12,
        mean_quality=2.0,
        external_corroboration=3.0,
        fraud_risk=-1.0,
    )

    assert result["inputs"]["mean_quality"] == 1.0
    assert result["inputs"]["external_corroboration"] == 1.0
    assert result["inputs"]["fraud_risk"] == 0.0
    assert result["score"] == 0.99


def test_confidence_uses_the_published_negative_additional_support_term() -> None:
    result = explain_confidence(0, 0.0)

    assert result["terms"]["additional_support"] == -0.05
    assert result["score"] == 0.10


def test_conflicts_and_fraud_reduce_confidence() -> None:
    clean = explain_confidence(4, 0.8)
    disputed = explain_confidence(4, 0.8, conflicts=2, fraud_risk=0.8)

    assert disputed["score"] < clean["score"]
    assert disputed["terms"]["conflict_penalty"] == pytest.approx(-0.075)
    assert disputed["terms"]["fraud_penalty"] == pytest.approx(-0.2)


def test_report_assimilation_is_bounded_and_decays_to_zero() -> None:
    nearby = bounded_report_assimilation(
        base_depth_m=0.10,
        reported_depth_m=1.40,
        distance_m=250,
        same_catchment=True,
    )
    boundary = bounded_report_assimilation(
        base_depth_m=0.10,
        reported_depth_m=1.40,
        distance_m=500,
        same_catchment=True,
    )

    assert nearby["capped_delta_m"] == 0.5
    assert nearby["decay_weight"] == 0.5
    assert nearby["applied_adjustment_m"] == 0.25
    assert nearby["assimilated_depth_m"] == 0.35
    assert boundary["applied_adjustment_m"] == 0.0
    assert boundary["reason"] == "OUTSIDE_INFLUENCE_DISTANCE"


def test_report_assimilation_never_crosses_catchments_or_negative_depth() -> None:
    other_catchment = bounded_report_assimilation(0.2, 1.2, 0, False)
    lower_report = bounded_report_assimilation(0.2, 0.0, 0, True)

    assert other_catchment["applied_adjustment_m"] == 0.0
    assert other_catchment["reason"] == "OUTSIDE_CATCHMENT"
    assert lower_report["assimilated_depth_m"] == 0.0
    assert lower_report["applied_adjustment_m"] == -0.2


def test_nine_member_model_is_byte_stable_and_json_serializable() -> None:
    first = run_rapid_impact_model(SCENARIO)
    second = run_rapid_impact_model(dict(reversed(list(SCENARIO.items()))))

    assert first == second
    assert len(first["members"]) == ENSEMBLE_SIZE == 9
    assert [item["horizon"] for item in first["horizons"]] == [key for key, _ in HORIZONS]
    assert all(item["model_version"] == first["model_version"] for item in first["horizons"])
    assert first["data_label"] == "DEMO DATA"
    assert first["classification"] == "RAPID_IMPACT_ESTIMATE"
    assert json.loads(json.dumps(first))["model_version"] == first["model_version"]


def test_model_quantiles_are_ordered_and_versions_change_with_inputs() -> None:
    baseline = run_rapid_impact_model(SCENARIO)
    wetter = run_rapid_impact_model({**SCENARIO, "rainfall_mm": 160.0})

    assert baseline["model_version"] != wetter["model_version"]
    assert baseline["snapshot_checksum"] != wetter["snapshot_checksum"]
    for summary in baseline["horizons"]:
        depth = summary["depth_m"]
        assert 0 <= depth["p10"] <= depth["p50"] <= depth["p90"]
        assert 0 <= summary["scenario_agreement"] <= 1
    assert wetter["horizons"][-1]["depth_m"]["p50"] > baseline["horizons"][-1]["depth_m"]["p50"]


def test_model_accepts_backend_snapshot_aliases() -> None:
    result = run_rapid_impact_model(
        {
            "scenario_time": "2023-12-04T14:00:00Z",
            "rainfall_mm_3h": 90,
            "gauge_stage_m": 2.1,
        }
    )

    assert result["ensemble_members"] == 9
    assert result["input_summary"]["rainfall_by_horizon_mm"]["+3h"] == 90
    assert result["input_summary"]["river_stage_m"] == 2.1


def test_model_caps_combined_report_assimilation_at_half_a_metre() -> None:
    result = run_rapid_impact_model(
        {
            **SCENARIO,
            "report_assimilation_m": 2.0,
            "report_observations": [
                {
                    "reported_depth_m": 2.0,
                    "distance_m": 0,
                    "same_catchment": True,
                    "quality": 1.0,
                }
            ],
        }
    )

    assert result["assimilation"]["applied_adjustment_m"] == 0.5
    assert result["assimilation"]["maximum_absolute_adjustment_m"] == 0.5


def test_model_rejects_ambiguous_catchment_flags() -> None:
    with pytest.raises(ValueError, match="same_catchment must be a boolean"):
        run_rapid_impact_model(
            {
                **SCENARIO,
                "report_observations": [
                    {
                        "reported_depth_m": 0.4,
                        "distance_m": 20,
                        "same_catchment": "false",
                    }
                ],
            }
        )


def test_demo_routes_exclude_threshold_edges_and_full_shelters() -> None:
    graph = build_demo_chennai_graph()
    assert graph["default_origin"] == "velachery"
    result = find_lower_risk_routes(
        graph,
        "velachery",
        model_version="model-demo-1",
        evidence_version="evidence-demo-4",
        valid_until="2023-12-04T14:10:00Z",
    )

    assert result["status"] == "ROUTES_AVAILABLE"
    assert len(result["alternatives"]) == 3
    assert [route["rank"] for route in result["alternatives"]] == [1, 2, 3]
    assert result["staging_point"] is None
    exclusions = {entry["edge_id"]: entry["reasons"] for entry in result["excluded_edges"]}
    assert "P50_DEPTH_THRESHOLD" in exclusions["e-velachery-guindy"]
    assert "AUTHORIZED_OR_CONFIRMED_CLOSURE" in exclusions["e-guindy-saidapet"]
    shelter_exclusions = {
        entry["shelter_id"]: entry["reasons"] for entry in result["excluded_shelters"]
    }
    assert shelter_exclusions["shelter-saidapet"] == ["SHELTER_FULL"]

    edges = {edge["id"]: edge for edge in graph["edges"]}
    for route in result["alternatives"]:
        assert route["geometry"]["type"] == "LineString"
        assert route["geometry"]["coordinates"][0] == [80.2206, 12.9815]
        assert all(edge_is_usable(edges[edge_id])[0] for edge_id in route["edge_ids"])
        assert "safe" not in result["message"].lower()


def test_route_results_are_deterministic_and_capped_at_three() -> None:
    graph = build_demo_chennai_graph()
    arguments = {
        "model_version": "model-demo-1",
        "evidence_version": "evidence-demo-4",
        "valid_until": "2023-12-04T14:10:00Z",
        "max_alternatives": 99,
    }

    first = find_lower_risk_routes(graph, "velachery", **arguments)
    second = find_lower_risk_routes(graph, "velachery", **arguments)

    assert first == second
    assert len(first["alternatives"]) <= 3
    assert json.loads(json.dumps(first))["status"] == "ROUTES_AVAILABLE"


def test_bridge_is_not_closed_from_ground_cell_depth_alone() -> None:
    bridge = {
        "id": "bridge",
        "source": "a",
        "target": "b",
        "distance_m": 100,
        "p50_depth_m": 0.8,
        "p90_depth_m": 1.2,
        "is_bridge": True,
        "depth_source": "ground_raster",
    }

    assert edge_is_usable(bridge) == (True, ())
    bridge["bridge_flood_confirmed"] = True
    usable, reasons = edge_is_usable(bridge)
    assert usable is False
    assert "BRIDGE_FLOOD_CONFIRMED" in reasons


@pytest.mark.parametrize(
    ("p50", "p90", "expected_reason"),
    [
        (0.15, 0.29, "P50_DEPTH_THRESHOLD"),
        (0.14, 0.30, "P90_DEPTH_THRESHOLD"),
    ],
)
def test_depth_thresholds_are_inclusive(p50: float, p90: float, expected_reason: str) -> None:
    usable, reasons = edge_is_usable(
        {
            "id": "edge",
            "source": "a",
            "target": "b",
            "distance_m": 100,
            "p50_depth_m": p50,
            "p90_depth_m": p90,
        }
    )

    assert usable is False
    assert expected_reason in reasons


def test_unknown_capacity_is_visible_but_does_not_invent_a_closure() -> None:
    eligible, reasons = shelter_is_eligible({"status": "OPEN"})

    assert eligible is True
    assert reasons == ("CAPACITY_UNKNOWN",)


def test_limited_shelter_with_remaining_capacity_is_eligible() -> None:
    eligible, reasons = shelter_is_eligible(
        {
            "activation_status": "LIMITED",
            "capacity_total": 10,
            "capacity_remaining": 2,
            "access_status": "REACHABLE",
        }
    )

    assert eligible is True
    assert reasons == ()


def test_disconnected_graph_returns_explicit_no_route_and_staging_point() -> None:
    graph = {
        "graph_version": "disconnected-v1",
        "data_label": "DEMO DATA",
        "nodes": {
            "origin": {
                "id": "origin",
                "name": "Origin",
                "longitude": 80.2,
                "latitude": 13.0,
            },
            "shelter-node": {
                "id": "shelter-node",
                "name": "Shelter",
                "longitude": 80.21,
                "latitude": 13.01,
            },
        },
        "edges": [],
        "shelters": [
            {
                "id": "shelter",
                "node": "shelter-node",
                "name": "Shelter",
                "status": "OPEN",
                "capacity_total": 10,
                "occupancy": 1,
            }
        ],
        "staging_points": [{"id": "staging", "node": "origin", "name": "Current staging point"}],
    }

    result = find_lower_risk_routes(
        graph,
        "origin",
        model_version="model-1",
        evidence_version="evidence-1",
        valid_until="2023-12-04T14:10:00Z",
    )

    assert result["status"] == "NO_ROUTE"
    assert result["reason_code"] == "NO_COMPLIANT_ROUTE"
    assert result["alternatives"] == []
    assert result["staging_point"]["node_id"] == "origin"
    assert result["excluded_shelters"] == [
        {"shelter_id": "shelter", "reasons": ["NO_COMPLIANT_PATH"]}
    ]
    assert "not an all-clear" in result["message"]


def test_unknown_origin_fails_before_issuing_route_guidance() -> None:
    with pytest.raises(ValueError, match="unknown origin_node"):
        find_lower_risk_routes(
            build_demo_chennai_graph(),
            "not-on-graph",
            model_version="model-1",
            evidence_version="evidence-1",
            valid_until="2023-12-04T14:10:00Z",
        )
