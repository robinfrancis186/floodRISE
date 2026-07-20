"""Deterministic lower-risk evacuation routing for the Chennai demo.

The production architecture can replace this reference graph with a versioned
pgRouting edge view while preserving the result envelope.  This implementation
is dependency-free, excludes operationally closed or depth-threshold edges, and
never describes a computed path as guaranteed safe.
"""

from __future__ import annotations

import hashlib
import heapq
import math
from collections.abc import Mapping, Sequence
from typing import Any, Final

DEFAULT_P50_DEPTH_THRESHOLD_M: Final = 0.15
DEFAULT_P90_DEPTH_THRESHOLD_M: Final = 0.30
MAX_ROUTE_ALTERNATIVES: Final = 3
ROUTING_ALGORITHM_VERSION: Final = "lower-risk-routing-v1"


def _finite(value: Any, *, name: str) -> float:
    if isinstance(value, bool):
        raise ValueError(f"{name} must be a finite number")
    try:
        result = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{name} must be a finite number") from exc
    if not math.isfinite(result):
        raise ValueError(f"{name} must be a finite number")
    return result


def _non_negative(value: Any, *, name: str) -> float:
    result = _finite(value, name=name)
    if result < 0:
        raise ValueError(f"{name} must be non-negative")
    return result


def _clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def _round(value: float, places: int = 6) -> float:
    rounded = round(value, places)
    return 0.0 if rounded == 0 else rounded


def _depths(edge: Mapping[str, Any]) -> tuple[float, float]:
    nested = edge.get("depth_m")
    if isinstance(nested, Mapping):
        p50_value = nested.get("p50", edge.get("p50_depth_m", 0.0))
        p90_value = nested.get("p90", edge.get("p90_depth_m", 0.0))
    else:
        p50_value = edge.get("p50_depth_m", 0.0)
        p90_value = edge.get("p90_depth_m", 0.0)
    return (
        _non_negative(p50_value, name="p50_depth_m"),
        _non_negative(p90_value, name="p90_depth_m"),
    )


def _bridge_uses_ground_raster(edge: Mapping[str, Any]) -> bool:
    """True when a wet terrain cell must not be projected onto the bridge deck."""

    return (
        bool(edge.get("is_bridge"))
        and str(edge.get("depth_source", "")).lower()
        in {"ground_raster", "terrain_cell", "modelled_ground"}
        and not bool(edge.get("bridge_flood_confirmed", False))
    )


def edge_is_usable(
    edge: Mapping[str, Any],
    p50_threshold_m: float = DEFAULT_P50_DEPTH_THRESHOLD_M,
    p90_threshold_m: float = DEFAULT_P90_DEPTH_THRESHOLD_M,
) -> tuple[bool, tuple[str, ...]]:
    """Return edge eligibility and deterministic exclusion reason codes.

    Thresholds are inclusive: p50 depth >= 0.15 m or p90 depth >= 0.30 m
    excludes the edge.  A ground-raster cell beneath a bridge is ignored unless
    bridge-deck flooding has separately been confirmed.
    """

    if not isinstance(edge, Mapping):
        raise ValueError("edge must be a mapping")
    p50_threshold = _finite(p50_threshold_m, name="p50_threshold_m")
    p90_threshold = _finite(p90_threshold_m, name="p90_threshold_m")
    if p50_threshold <= 0 or p90_threshold <= 0:
        raise ValueError("depth thresholds must be greater than zero")

    reasons: list[str] = []
    closure_status = str(edge.get("closure_status", "")).upper()
    if (
        bool(edge.get("closed", False))
        or bool(edge.get("authorized_closure", False))
        or closure_status in {"CLOSED", "BLOCKED"}
        or edge.get("is_open") is False
    ):
        reasons.append("AUTHORIZED_OR_CONFIRMED_CLOSURE")

    if bool(edge.get("bridge_flood_confirmed", False)):
        reasons.append("BRIDGE_FLOOD_CONFIRMED")

    p50, p90 = _depths(edge)
    if not _bridge_uses_ground_raster(edge):
        if p50 >= p50_threshold:
            reasons.append("P50_DEPTH_THRESHOLD")
        if p90 >= p90_threshold:
            reasons.append("P90_DEPTH_THRESHOLD")

    return not reasons, tuple(reasons)


def shelter_is_eligible(shelter: Mapping[str, Any]) -> tuple[bool, tuple[str, ...]]:
    """Check shelter operational status and capacity without inventing capacity."""

    if not isinstance(shelter, Mapping):
        raise ValueError("shelter must be a mapping")
    reasons: list[str] = []
    warnings: list[str] = []
    status = str(shelter.get("status", shelter.get("activation_status", "UNKNOWN"))).upper()
    if status not in {"OPEN", "AVAILABLE", "LIMITED"}:
        reasons.append("SHELTER_NOT_OPEN")
    if shelter.get("eligible") is False:
        reasons.append("SHELTER_MARKED_INELIGIBLE")
    if bool(shelter.get("authorized_closed", False)):
        reasons.append("AUTHORIZED_SHELTER_CLOSURE")
    if bool(shelter.get("flooded", False)):
        reasons.append("SHELTER_FLOODED")
    if shelter.get("access_open") is False:
        reasons.append("SHELTER_ACCESS_CLOSED")
    if str(shelter.get("access_status", "")).upper() in {
        "BLOCKED",
        "CLOSED",
        "UNREACHABLE",
    }:
        reasons.append("SHELTER_ACCESS_CLOSED")

    capacity_value = shelter.get("capacity_total", shelter.get("capacity"))
    occupancy_value = shelter.get("occupancy")
    remaining_value = shelter.get("capacity_remaining")
    if remaining_value is not None:
        remaining = _non_negative(remaining_value, name="shelter.capacity_remaining")
        if remaining <= 0:
            reasons.append("SHELTER_FULL")
    elif capacity_value is None:
        warnings.append("CAPACITY_UNKNOWN")
    else:
        capacity = _non_negative(capacity_value, name="shelter.capacity")
        if occupancy_value is None:
            warnings.append("OCCUPANCY_UNKNOWN")
        else:
            occupancy = _non_negative(occupancy_value, name="shelter.occupancy")
            if occupancy >= capacity:
                reasons.append("SHELTER_FULL")

    return not reasons, tuple(reasons + warnings)


def build_demo_chennai_graph() -> dict[str, Any]:
    """Return the pinned, deterministic Velachery-centred demo graph."""

    nodes = {
        "velachery": {
            "id": "velachery",
            "name": "Velachery",
            "longitude": 80.2206,
            "latitude": 12.9815,
        },
        "taramani": {
            "id": "taramani",
            "name": "Taramani",
            "longitude": 80.2432,
            "latitude": 12.9863,
        },
        "adyar": {
            "id": "adyar",
            "name": "Adyar",
            "longitude": 80.2570,
            "latitude": 13.0067,
        },
        "guindy": {
            "id": "guindy",
            "name": "Guindy",
            "longitude": 80.2209,
            "latitude": 13.0067,
        },
        "alandur": {
            "id": "alandur",
            "name": "Alandur",
            "longitude": 80.2069,
            "latitude": 13.0022,
        },
        "saidapet": {
            "id": "saidapet",
            "name": "Saidapet",
            "longitude": 80.2230,
            "latitude": 13.0213,
        },
        "kotturpuram": {
            "id": "kotturpuram",
            "name": "Kotturpuram",
            "longitude": 80.2416,
            "latitude": 13.0180,
        },
        "camp-taramani": {
            "id": "camp-taramani",
            "name": "Taramani Relief Camp",
            "longitude": 80.2481,
            "latitude": 12.9891,
        },
        "camp-adyar": {
            "id": "camp-adyar",
            "name": "Adyar Relief Centre",
            "longitude": 80.2608,
            "latitude": 13.0080,
        },
        "camp-guindy": {
            "id": "camp-guindy",
            "name": "Guindy Community Hall",
            "longitude": 80.2177,
            "latitude": 13.0094,
        },
        "camp-saidapet": {
            "id": "camp-saidapet",
            "name": "Saidapet Relief Centre",
            "longitude": 80.2252,
            "latitude": 13.0240,
        },
    }

    def edge(
        edge_id: str,
        source: str,
        target: str,
        distance_m: float,
        p50: float,
        p90: float,
        **extra: Any,
    ) -> dict[str, Any]:
        return {
            "id": edge_id,
            "source": source,
            "target": target,
            "distance_m": distance_m,
            "bidirectional": True,
            "p50_depth_m": p50,
            "p90_depth_m": p90,
            "stale": False,
            "uncertainty": 0.10,
            **extra,
        }

    edges = [
        edge(
            "e-velachery-guindy",
            "velachery",
            "guindy",
            3_400,
            0.18,
            0.27,
        ),
        edge("e-velachery-taramani", "velachery", "taramani", 3_500, 0.08, 0.13),
        edge("e-taramani-camp", "taramani", "camp-taramani", 800, 0.03, 0.07),
        edge("e-taramani-adyar", "taramani", "adyar", 4_200, 0.11, 0.20),
        edge("e-adyar-camp", "adyar", "camp-adyar", 600, 0.02, 0.04),
        edge("e-velachery-alandur", "velachery", "alandur", 4_800, 0.07, 0.14),
        edge("e-alandur-guindy", "alandur", "guindy", 2_500, 0.09, 0.18),
        edge("e-guindy-camp", "guindy", "camp-guindy", 500, 0.04, 0.05),
        edge(
            "e-guindy-saidapet",
            "guindy",
            "saidapet",
            3_000,
            0.08,
            0.16,
            authorized_closure=True,
            closure_status="CLOSED",
        ),
        edge("e-saidapet-camp", "saidapet", "camp-saidapet", 450, 0.03, 0.06),
        edge(
            "e-adyar-kotturpuram-bridge",
            "adyar",
            "kotturpuram",
            1_900,
            0.48,
            0.70,
            is_bridge=True,
            depth_source="ground_raster",
        ),
        edge("e-kotturpuram-saidapet", "kotturpuram", "saidapet", 1_700, 0.07, 0.12),
        edge("e-taramani-guindy", "taramani", "guindy", 3_600, 0.13, 0.28),
    ]

    shelters = [
        {
            "id": "shelter-taramani",
            "node": "camp-taramani",
            "name": "Taramani Relief Camp",
            "status": "OPEN",
            "capacity_total": 240,
            "occupancy": 104,
            "access_open": True,
        },
        {
            "id": "shelter-adyar",
            "node": "camp-adyar",
            "name": "Adyar Relief Centre",
            "status": "OPEN",
            "capacity_total": 180,
            "occupancy": 86,
            "access_open": True,
        },
        {
            "id": "shelter-guindy",
            "node": "camp-guindy",
            "name": "Guindy Community Hall",
            "status": "OPEN",
            "capacity_total": 320,
            "occupancy": 201,
            "access_open": True,
        },
        {
            "id": "shelter-saidapet",
            "node": "camp-saidapet",
            "name": "Saidapet Relief Centre",
            "status": "OPEN",
            "capacity_total": 150,
            "occupancy": 150,
            "access_open": True,
        },
    ]

    return {
        "graph_version": "chennai-michaung-demo-graph-v1",
        "data_label": "DEMO DATA",
        "default_origin": "velachery",
        "nodes": nodes,
        "edges": edges,
        "shelters": shelters,
        "staging_points": [
            {
                "id": "staging-velachery",
                "node": "velachery",
                "name": "Velachery pre-identified staging point",
                "status": "DEMO",
            }
        ],
    }


def _nodes_by_id(graph: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    raw_nodes = graph.get("nodes", {})
    if isinstance(raw_nodes, Mapping):
        nodes = {str(key): value for key, value in raw_nodes.items()}
    elif isinstance(raw_nodes, Sequence) and not isinstance(raw_nodes, (str, bytes)):
        nodes = {
            str(node.get("id")): node
            for node in raw_nodes
            if isinstance(node, Mapping) and node.get("id") is not None
        }
    else:
        raise ValueError("graph.nodes must be a mapping or sequence")
    for node_id, node in nodes.items():
        if not isinstance(node, Mapping):
            raise ValueError(f"node {node_id!r} must be a mapping")
    return nodes


def _edge_cost(
    edge: Mapping[str, Any], p50_threshold: float, p90_threshold: float
) -> tuple[float, float]:
    distance = _non_negative(edge.get("distance_m", 0.0), name="edge.distance_m")
    p50, p90 = _depths(edge)
    if _bridge_uses_ground_raster(edge):
        p50 = p90 = 0.0
    uncertainty = _clamp(_finite(edge.get("uncertainty", 0.0), name="edge.uncertainty"), 0.0, 1.0)
    multiplier = 1.0 + 0.35 * (p50 / p50_threshold) + 0.20 * (p90 / p90_threshold)
    multiplier += 0.50 * uncertainty
    if bool(edge.get("stale", False)):
        multiplier += 0.25
    return distance * multiplier, distance


def _build_adjacency(
    graph: Mapping[str, Any],
    nodes: Mapping[str, Mapping[str, Any]],
    p50_threshold: float,
    p90_threshold: float,
) -> tuple[
    dict[str, list[tuple[str, Mapping[str, Any], float, float]]],
    list[dict[str, Any]],
]:
    adjacency: dict[str, list[tuple[str, Mapping[str, Any], float, float]]] = {
        node_id: [] for node_id in nodes
    }
    exclusions: list[dict[str, Any]] = []
    raw_edges = graph.get("edges", ())
    if isinstance(raw_edges, (str, bytes)) or not isinstance(raw_edges, Sequence):
        raise ValueError("graph.edges must be a sequence")

    seen_ids: set[str] = set()
    for index, edge in enumerate(raw_edges):
        if not isinstance(edge, Mapping):
            raise ValueError(f"edge at index {index} must be a mapping")
        edge_id = str(edge.get("id", f"edge-{index}"))
        if edge_id in seen_ids:
            raise ValueError(f"duplicate edge id: {edge_id}")
        seen_ids.add(edge_id)
        source = str(edge.get("source", ""))
        target = str(edge.get("target", ""))
        if source not in nodes or target not in nodes:
            raise ValueError(f"edge {edge_id} references an unknown node")

        usable, reasons = edge_is_usable(edge, p50_threshold, p90_threshold)
        if not usable:
            exclusions.append({"edge_id": edge_id, "reasons": list(reasons)})
            continue
        cost, distance = _edge_cost(edge, p50_threshold, p90_threshold)
        adjacency[source].append((target, edge, cost, distance))
        if bool(edge.get("bidirectional", True)):
            adjacency[target].append((source, edge, cost, distance))

    for neighbours in adjacency.values():
        neighbours.sort(key=lambda item: (str(item[1].get("id", "")), item[0]))
    exclusions.sort(key=lambda item: item["edge_id"])
    return adjacency, exclusions


def _shortest_path(
    adjacency: Mapping[str, Sequence[tuple[str, Mapping[str, Any], float, float]]],
    origin: str,
    target: str,
) -> dict[str, Any] | None:
    # The lexical path tuple makes equal-cost outcomes deterministic.
    queue: list[tuple[float, float, tuple[str, ...], str, tuple[str, ...]]] = [
        (0.0, 0.0, (origin,), origin, ())
    ]
    best: dict[str, tuple[float, tuple[str, ...]]] = {origin: (0.0, (origin,))}
    while queue:
        cost, distance, node_path, node, edge_path = heapq.heappop(queue)
        current_best = best.get(node)
        if current_best is None or (cost, node_path) > current_best:
            continue
        if node == target:
            return {
                "cost": cost,
                "distance_m": distance,
                "node_ids": list(node_path),
                "edge_ids": list(edge_path),
            }
        for neighbour, edge, edge_cost, edge_distance in adjacency.get(node, ()):
            if neighbour in node_path:
                continue
            next_path = node_path + (neighbour,)
            next_cost = cost + edge_cost
            next_key = (next_cost, next_path)
            if neighbour not in best or next_key < best[neighbour]:
                best[neighbour] = next_key
                heapq.heappush(
                    queue,
                    (
                        next_cost,
                        distance + edge_distance,
                        next_path,
                        neighbour,
                        edge_path + (str(edge.get("id")),),
                    ),
                )
    return None


def _coordinates(
    node_ids: Sequence[str], nodes: Mapping[str, Mapping[str, Any]]
) -> list[list[float]]:
    result: list[list[float]] = []
    for node_id in node_ids:
        node = nodes[node_id]
        longitude = _finite(node.get("longitude"), name=f"node {node_id} longitude")
        latitude = _finite(node.get("latitude"), name=f"node {node_id} latitude")
        if not (-180 <= longitude <= 180 and -90 <= latitude <= 90):
            raise ValueError(f"node {node_id} has invalid RFC 7946 coordinates")
        result.append([longitude, latitude])
    return result


def _staging_point(
    graph: Mapping[str, Any], origin: str, nodes: Mapping[str, Mapping[str, Any]]
) -> dict[str, Any]:
    raw_points = graph.get("staging_points", ())
    if isinstance(raw_points, Sequence) and not isinstance(raw_points, (str, bytes)):
        for point in raw_points:
            if isinstance(point, Mapping) and str(point.get("node")) == origin:
                return {
                    "id": str(point.get("id", f"staging-{origin}")),
                    "node_id": origin,
                    "name": str(point.get("name", nodes[origin].get("name", origin))),
                    "status": str(point.get("status", "UNKNOWN")),
                    "instruction": (
                        "Remain only if conditions allow and contact authorized "
                        "emergency responders for current instructions."
                    ),
                }
    return {
        "id": f"current-location-{origin}",
        "node_id": origin,
        "name": str(nodes[origin].get("name", origin)),
        "status": "CURRENT_LOCATION",
        "instruction": (
            "No pre-identified reachable staging point is available; avoid entering "
            "floodwater and contact authorized emergency responders."
        ),
    }


def find_lower_risk_routes(
    graph: Mapping[str, Any],
    origin_node: str,
    *,
    model_version: str,
    evidence_version: str,
    valid_until: str,
    max_alternatives: int = MAX_ROUTE_ALTERNATIVES,
    p50_threshold_m: float = DEFAULT_P50_DEPTH_THRESHOLD_M,
    p90_threshold_m: float = DEFAULT_P90_DEPTH_THRESHOLD_M,
) -> dict[str, Any]:
    """Return up to three deterministic lower-risk routes to eligible shelters."""

    if not isinstance(graph, Mapping):
        raise ValueError("graph must be a mapping")
    if isinstance(max_alternatives, bool) or not isinstance(max_alternatives, int):
        raise ValueError("max_alternatives must be an integer")
    if max_alternatives <= 0:
        raise ValueError("max_alternatives must be greater than zero")
    limit = min(max_alternatives, MAX_ROUTE_ALTERNATIVES)
    p50_threshold = _finite(p50_threshold_m, name="p50_threshold_m")
    p90_threshold = _finite(p90_threshold_m, name="p90_threshold_m")
    if p50_threshold <= 0 or p90_threshold <= 0:
        raise ValueError("depth thresholds must be greater than zero")

    nodes = _nodes_by_id(graph)
    origin = str(origin_node)
    if origin not in nodes:
        raise ValueError(f"unknown origin_node: {origin}")
    adjacency, edge_exclusions = _build_adjacency(graph, nodes, p50_threshold, p90_threshold)

    raw_shelters = graph.get("shelters", ())
    if isinstance(raw_shelters, (str, bytes)) or not isinstance(raw_shelters, Sequence):
        raise ValueError("graph.shelters must be a sequence")

    candidates: list[dict[str, Any]] = []
    excluded_shelters: list[dict[str, Any]] = []
    for index, shelter in enumerate(raw_shelters):
        if not isinstance(shelter, Mapping):
            raise ValueError(f"shelter at index {index} must be a mapping")
        shelter_id = str(shelter.get("id", f"shelter-{index}"))
        shelter_node = str(shelter.get("node", ""))
        if shelter_node not in nodes:
            excluded_shelters.append(
                {"shelter_id": shelter_id, "reasons": ["UNKNOWN_SHELTER_NODE"]}
            )
            continue
        eligible, eligibility_codes = shelter_is_eligible(shelter)
        hard_reasons = [
            code
            for code in eligibility_codes
            if code not in {"CAPACITY_UNKNOWN", "OCCUPANCY_UNKNOWN"}
        ]
        warnings = [
            code for code in eligibility_codes if code in {"CAPACITY_UNKNOWN", "OCCUPANCY_UNKNOWN"}
        ]
        if not eligible:
            excluded_shelters.append({"shelter_id": shelter_id, "reasons": hard_reasons})
            continue

        path = _shortest_path(adjacency, origin, shelter_node)
        if path is None:
            excluded_shelters.append({"shelter_id": shelter_id, "reasons": ["NO_COMPLIANT_PATH"]})
            continue
        route_material = "|".join(
            [
                str(graph.get("graph_version", "unversioned")),
                str(model_version),
                str(evidence_version),
                origin,
                shelter_id,
                *path["edge_ids"],
            ]
        )
        route_id = "route-" + hashlib.sha256(route_material.encode("utf-8")).hexdigest()[:16]
        capacity = shelter.get("capacity_total", shelter.get("capacity"))
        occupancy = shelter.get("occupancy")
        remaining = None
        if capacity is not None and occupancy is not None:
            remaining = max(0, int(float(capacity) - float(occupancy)))
        candidates.append(
            {
                "route_id": route_id,
                "shelter": {
                    "id": shelter_id,
                    "name": str(shelter.get("name", shelter_id)),
                    "status": str(shelter.get("status", "UNKNOWN")).upper(),
                    "remaining_capacity": remaining,
                    "warnings": warnings,
                },
                "node_ids": path["node_ids"],
                "edge_ids": path["edge_ids"],
                "geometry": {
                    "type": "LineString",
                    "coordinates": _coordinates(path["node_ids"], nodes),
                },
                "distance_m": _round(path["distance_m"], 1),
                "estimated_minutes": max(1, int(math.ceil(path["distance_m"] / 70.0))),
                "risk_weighted_cost": _round(path["cost"], 3),
                "reasons": [
                    "Avoids authorized closures and configured depth thresholds",
                    "Penalizes uncertain or stale edges",
                ],
            }
        )

    candidates.sort(
        key=lambda route: (
            route["risk_weighted_cost"],
            route["distance_m"],
            route["shelter"]["id"],
        )
    )
    selected = candidates[:limit]
    for rank, route in enumerate(selected, start=1):
        route["rank"] = rank

    common = {
        "routing_version": ROUTING_ALGORITHM_VERSION,
        "graph_version": str(graph.get("graph_version", "unversioned")),
        "data_label": str(graph.get("data_label", "UNKNOWN DATA")),
        "origin_node": origin,
        "model_version": str(model_version),
        "evidence_version": str(evidence_version),
        "valid_until": str(valid_until),
        "thresholds_m": {
            "p50": _round(p50_threshold),
            "p90": _round(p90_threshold),
        },
        "excluded_edges": edge_exclusions,
        "excluded_shelters": sorted(excluded_shelters, key=lambda item: item["shelter_id"]),
        "disclaimer": (
            "Lower-risk route based on the cited model and evidence versions; "
            "conditions may change and this result does not certify route conditions."
        ),
    }

    if selected:
        return {
            **common,
            "status": "ROUTES_AVAILABLE",
            "message": "Lower-risk route alternatives are available.",
            "alternatives": selected,
            "staging_point": None,
        }
    return {
        **common,
        "status": "NO_ROUTE",
        "reason_code": "NO_COMPLIANT_ROUTE",
        "message": (
            "No compliant lower-risk route is currently available; this is not "
            "an all-clear or a direction to enter floodwater."
        ),
        "alternatives": [],
        "staging_point": _staging_point(graph, origin, nodes),
    }


route_to_shelters = find_lower_risk_routes


__all__ = [
    "DEFAULT_P50_DEPTH_THRESHOLD_M",
    "DEFAULT_P90_DEPTH_THRESHOLD_M",
    "MAX_ROUTE_ALTERNATIVES",
    "ROUTING_ALGORITHM_VERSION",
    "build_demo_chennai_graph",
    "edge_is_usable",
    "find_lower_risk_routes",
    "route_to_shelters",
    "shelter_is_eligible",
]
