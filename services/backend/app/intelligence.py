"""Deterministic flood intelligence primitives used by the competition demo.

The functions in this module deliberately avoid databases and geospatial runtime
dependencies.  They provide a small, auditable reference implementation for the
Kerala extreme-rainfall replay and are safe to call from request handlers, workers, and tests.

This is a *rapid impact estimate*, not a certified hydraulic model.  Inputs and
outputs are JSON-compatible mappings so model runs can be versioned and placed in
the immutable audit/outbox flow by the surrounding application.
"""

from __future__ import annotations

import hashlib
import json
import math
import random
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime, timedelta
from typing import Any, Final

MODEL_ALGORITHM_VERSION: Final = "rapid-impact-v1"
CONFIDENCE_FORMULA_VERSION: Final = "floodsignal-confidence-v1"
DEFAULT_MODEL_SEED: Final = 5305
ENSEMBLE_SIZE: Final = 9
HORIZONS: Final = (
    ("now", 0),
    ("+30m", 30),
    ("+1h", 60),
    ("+3h", 180),
)

_CONFIDENCE_FORMULA = (
    "clamp(0, 0.99, 0.15 + 0.60*min(n/4,1) + 0.10*mean_quality "
    "+ 0.05*min((n-4)/4,1) + 0.10*external_corroboration "
    "- 0.15*min(conflicts/4,1) - 0.25*fraud_risk)"
)


def _clamp(value: float, lower: float, upper: float) -> float:
    return max(lower, min(upper, value))


def _finite_number(value: Any, *, name: str) -> float:
    """Return a finite float and raise a useful error for unsafe input."""

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
    result = _finite_number(value, name=name)
    if result < 0:
        raise ValueError(f"{name} must be non-negative")
    return result


def _unit_interval(value: Any, *, name: str) -> float:
    """Normalize a score input defensively while keeping the output bounded."""

    return _clamp(_finite_number(value, name=name), 0.0, 1.0)


def _round(value: float, places: int = 6) -> float:
    # Avoid serializing negative zero, which creates noisy model manifests.
    rounded = round(value, places)
    return 0.0 if rounded == 0 else rounded


def _canonical_json(value: Mapping[str, Any]) -> str:
    """Create a repeatable representation for checksums and model versions."""

    return json.dumps(
        value,
        sort_keys=True,
        separators=(",", ":"),
        ensure_ascii=True,
        default=lambda item: item.isoformat() if hasattr(item, "isoformat") else str(item),
    )


def _scenario_clock(value: Any) -> datetime:
    text = str(value or "2023-12-04T09:00:00Z")
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError("scenario_time must be an ISO-8601 timestamp") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _utc_text(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _quantile(values: Sequence[float], probability: float) -> float:
    """Linearly interpolated quantile with no third-party dependency."""

    if not values:
        raise ValueError("at least one ensemble value is required")
    ordered = sorted(values)
    position = (len(ordered) - 1) * probability
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    fraction = position - lower
    return ordered[lower] * (1.0 - fraction) + ordered[upper] * fraction


def explain_confidence(
    independent_families: int,
    mean_quality: float,
    external_corroboration: float = 0.0,
    conflicts: int = 0,
    fraud_risk: float = 0.0,
) -> dict[str, Any]:
    """Calculate and explain the versioned FloodSignal confidence score.

    Scores alone do not grant operational authority.  The surrounding domain
    service must additionally enforce the four-family, trusted-reporter,
    contradiction, and fraud gates before transitioning a FloodSignal.
    Out-of-range quality/risk inputs are defensively clamped and their normalized
    values are returned for auditability.
    """

    if isinstance(independent_families, bool):
        raise ValueError("independent_families must be a non-negative integer")
    if isinstance(conflicts, bool):
        raise ValueError("conflicts must be a non-negative integer")
    try:
        family_count = int(independent_families)
        conflict_count = int(conflicts)
    except (TypeError, ValueError) as exc:
        raise ValueError("family and conflict counts must be integers") from exc
    if family_count != independent_families or family_count < 0:
        raise ValueError("independent_families must be a non-negative integer")
    if conflict_count != conflicts or conflict_count < 0:
        raise ValueError("conflicts must be a non-negative integer")

    quality = _unit_interval(mean_quality, name="mean_quality")
    external = _unit_interval(external_corroboration, name="external_corroboration")
    fraud = _unit_interval(fraud_risk, name="fraud_risk")

    terms = {
        "base": 0.15,
        "independent_support": 0.60 * min(family_count / 4.0, 1.0),
        "mean_quality": 0.10 * quality,
        "additional_support": 0.05 * min((family_count - 4) / 4.0, 1.0),
        "external_corroboration": 0.10 * external,
        "conflict_penalty": -0.15 * min(conflict_count / 4.0, 1.0),
        "fraud_penalty": -0.25 * fraud,
    }
    raw_score = sum(terms.values())
    score = _clamp(raw_score, 0.0, 0.99)

    return {
        "formula_version": CONFIDENCE_FORMULA_VERSION,
        "formula": _CONFIDENCE_FORMULA,
        "score": _round(score),
        "raw_score": _round(raw_score),
        "community_corroboration_threshold": 0.75,
        "threshold_met": score >= 0.75,
        "inputs": {
            "independent_families": family_count,
            "mean_quality": _round(quality),
            "external_corroboration": _round(external),
            "conflicts": conflict_count,
            "fraud_risk": _round(fraud),
        },
        "terms": {name: _round(value) for name, value in terms.items()},
        "authority_notice": (
            "Confidence does not make a report an official confirmation or "
            "authorize a closure, evacuation instruction, or all-clear."
        ),
    }


def bounded_report_assimilation(
    base_depth_m: float,
    reported_depth_m: float,
    distance_m: float,
    same_catchment: bool,
    max_adjustment_m: float = 0.5,
    decay_distance_m: float = 500.0,
) -> dict[str, Any]:
    """Apply a bounded, linearly decaying local depth correction.

    Evidence from another catchment or at/after the 500 m influence boundary is
    retained in the explanation but contributes no model correction.  A report
    can never move the estimate below zero and never adjusts it by more than
    ``max_adjustment_m`` at its observation point.
    """

    base = _non_negative(base_depth_m, name="base_depth_m")
    reported = _non_negative(reported_depth_m, name="reported_depth_m")
    distance = _non_negative(distance_m, name="distance_m")
    maximum = _non_negative(max_adjustment_m, name="max_adjustment_m")
    decay_distance = _finite_number(decay_distance_m, name="decay_distance_m")
    if decay_distance <= 0:
        raise ValueError("decay_distance_m must be greater than zero")
    if not isinstance(same_catchment, bool):
        raise ValueError("same_catchment must be a boolean")

    raw_delta = reported - base
    capped_delta = _clamp(raw_delta, -maximum, maximum)
    if not same_catchment:
        weight = 0.0
        reason = "OUTSIDE_CATCHMENT"
    elif distance >= decay_distance:
        weight = 0.0
        reason = "OUTSIDE_INFLUENCE_DISTANCE"
    else:
        weight = 1.0 - distance / decay_distance
        reason = "APPLIED"

    adjustment = capped_delta * weight
    assimilated = max(0.0, base + adjustment)
    # The non-negative floor can reduce a negative adjustment; report what the
    # model actually applied rather than the pre-floor request.
    applied = assimilated - base

    return {
        "base_depth_m": _round(base),
        "reported_depth_m": _round(reported),
        "distance_m": _round(distance),
        "same_catchment": same_catchment,
        "raw_delta_m": _round(raw_delta),
        "capped_delta_m": _round(capped_delta),
        "decay_weight": _round(weight),
        "applied_adjustment_m": _round(applied),
        "assimilated_depth_m": _round(assimilated),
        "max_adjustment_m": _round(maximum),
        "decay_distance_m": _round(decay_distance),
        "reason": reason,
    }


def _report_adjustment(
    snapshot: Mapping[str, Any], base_depth_m: float
) -> tuple[float, list[dict[str, Any]]]:
    """Combine local evidence without allowing aggregate corrections over 0.5 m."""

    direct = _finite_number(
        snapshot.get("report_assimilation_m", 0.0), name="report_assimilation_m"
    )
    observations = snapshot.get("report_observations", ())
    if observations is None:
        observations = ()
    if isinstance(observations, (str, bytes)) or not isinstance(observations, Sequence):
        raise ValueError("report_observations must be a sequence of mappings")

    explanations: list[dict[str, Any]] = []
    weighted_adjustments: list[tuple[float, float]] = []
    for index, observation in enumerate(observations):
        if not isinstance(observation, Mapping):
            raise ValueError(f"report_observations[{index}] must be a mapping")
        result = bounded_report_assimilation(
            base_depth_m=base_depth_m,
            reported_depth_m=observation.get("reported_depth_m", base_depth_m),
            distance_m=observation.get("distance_m", 0.0),
            same_catchment=observation.get("same_catchment", False),
        )
        quality = _unit_interval(observation.get("quality", 1.0), name="quality")
        result["quality"] = _round(quality)
        result["observation_index"] = index
        explanations.append(result)
        if result["reason"] == "APPLIED" and quality > 0:
            weighted_adjustments.append((result["applied_adjustment_m"], quality))

    evidence_adjustment = 0.0
    if weighted_adjustments:
        numerator = sum(value * weight for value, weight in weighted_adjustments)
        denominator = sum(weight for _, weight in weighted_adjustments)
        evidence_adjustment = numerator / denominator

    combined = _clamp(direct + evidence_adjustment, -0.5, 0.5)
    return combined, explanations


def run_rapid_impact_model(
    snapshot: Mapping[str, Any], *, seed: int = DEFAULT_MODEL_SEED
) -> dict[str, Any]:
    """Run the deterministic nine-member Kerala rapid-impact estimate.

    Expected snapshot fields are intentionally modest: ``scenario_time``,
    ``rainfall_mm``, ``river_stage_m``, ``bankfull_stage_m``, ``base_depth_m``,
    ``terrain_susceptibility``, ``drainage_efficiency``, ``catchment_area_km2``,
    ``exposure_population``, and optionally ``rainfall_by_horizon_mm`` plus local
    report assimilation inputs.  Missing values use documented Kerala extreme-rainfall demo
    defaults; callers should persist the complete snapshot returned in their own
    simulation manifest.
    """

    if not isinstance(snapshot, Mapping):
        raise ValueError("snapshot must be a mapping")
    if isinstance(seed, bool) or not isinstance(seed, int):
        raise ValueError("seed must be an integer")

    canonical = _canonical_json(snapshot)
    snapshot_checksum = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    version_material = f"{MODEL_ALGORITHM_VERSION}|{seed}|{snapshot_checksum}|{ENSEMBLE_SIZE}"
    version_digest = hashlib.sha256(version_material.encode("utf-8")).hexdigest()
    model_version = f"{MODEL_ALGORITHM_VERSION}-{version_digest[:16]}"
    scenario_time = _scenario_clock(snapshot.get("scenario_time"))

    rainfall = _non_negative(
        snapshot.get("rainfall_mm", snapshot.get("rainfall_mm_3h", 118.0)),
        name="rainfall_mm",
    )
    river_stage = _non_negative(
        snapshot.get("river_stage_m", snapshot.get("gauge_stage_m", 2.65)),
        name="river_stage_m",
    )
    bankfull_stage = _non_negative(snapshot.get("bankfull_stage_m", 2.35), name="bankfull_stage_m")
    base_depth = _non_negative(snapshot.get("base_depth_m", 0.06), name="base_depth_m")
    terrain = _unit_interval(
        snapshot.get("terrain_susceptibility", 0.72),
        name="terrain_susceptibility",
    )
    drainage = _unit_interval(snapshot.get("drainage_efficiency", 0.38), name="drainage_efficiency")
    catchment_area = _non_negative(
        snapshot.get("catchment_area_km2", 400.0), name="catchment_area_km2"
    )
    population = _non_negative(
        snapshot.get("exposure_population", 780_000), name="exposure_population"
    )
    assimilation_adjustment, assimilation_evidence = _report_adjustment(snapshot, base_depth)

    supplied_rainfall = snapshot.get("rainfall_by_horizon_mm")
    if supplied_rainfall is not None and not isinstance(supplied_rainfall, Mapping):
        raise ValueError("rainfall_by_horizon_mm must be a mapping")
    rainfall_fraction = {"now": 0.20, "+30m": 0.45, "+1h": 0.70, "+3h": 1.0}
    rainfall_by_horizon: dict[str, float] = {}
    for horizon, _ in HORIZONS:
        if supplied_rainfall is not None and horizon in supplied_rainfall:
            rainfall_by_horizon[horizon] = _non_negative(
                supplied_rainfall[horizon],
                name=f"rainfall_by_horizon_mm[{horizon}]",
            )
        else:
            rainfall_by_horizon[horizon] = rainfall * rainfall_fraction[horizon]

    # Seed each immutable input snapshot independently.  Reordering dictionary
    # keys therefore never changes the ensemble, but a material input change does.
    stable_seed = seed ^ int(snapshot_checksum[:16], 16)
    rng = random.Random(stable_seed)
    member_parameters: list[dict[str, float | int]] = []
    for index in range(ENSEMBLE_SIZE):
        member_parameters.append(
            {
                "member": index + 1,
                "rainfall_factor": _round(0.85 + 0.30 * rng.random()),
                "stage_offset_m": _round(-0.08 + 0.16 * rng.random()),
                "runoff_factor": _round(0.90 + 0.20 * rng.random()),
                "drainage_factor": _round(0.90 + 0.20 * rng.random()),
            }
        )

    depths_by_horizon: dict[str, list[float]] = {horizon: [] for horizon, _ in HORIZONS}
    member_outputs: list[dict[str, Any]] = []
    temporal_assimilation = {"now": 1.0, "+30m": 0.85, "+1h": 0.65, "+3h": 0.30}

    for parameters in member_parameters:
        member_depths: dict[str, float] = {}
        for horizon, minutes in HORIZONS:
            perturbed_rainfall = rainfall_by_horizon[horizon] * parameters["rainfall_factor"]
            runoff_response = (
                perturbed_rainfall * 0.0035 * (0.65 + 0.70 * terrain) * parameters["runoff_factor"]
            )
            drainage_relief = _clamp(drainage * parameters["drainage_factor"], 0.0, 1.0)
            runoff_response *= 1.25 - 0.75 * drainage_relief
            member_stage = river_stage + parameters["stage_offset_m"]
            stage_response = max(0.0, member_stage - bankfull_stage) * 0.60
            recession = (minutes / 180.0) * 0.04 * drainage_relief
            local_correction = assimilation_adjustment * temporal_assimilation[horizon]
            depth = max(
                0.0,
                base_depth + runoff_response + stage_response + local_correction - recession,
            )
            member_depths[horizon] = _round(depth)
            depths_by_horizon[horizon].append(depth)
        member_outputs.append({**parameters, "depth_by_horizon_m": member_depths})

    horizon_summaries: list[dict[str, Any]] = []
    for horizon, minutes in HORIZONS:
        depths = depths_by_horizon[horizon]
        p10 = _quantile(depths, 0.10)
        p50 = _quantile(depths, 0.50)
        p90 = _quantile(depths, 0.90)
        median_flooded = p50 >= 0.15
        classification_votes = sum((depth >= 0.15) == median_flooded for depth in depths)
        agreement = classification_votes / ENSEMBLE_SIZE

        area_fraction = _clamp((p50 / 0.85) * (0.55 + 0.45 * terrain), 0.0, 1.0)
        exposure_fraction = _clamp((p50 / 0.70) * (0.50 + 0.50 * terrain), 0.0, 1.0)
        horizon_summaries.append(
            {
                "horizon": horizon,
                "offset_minutes": minutes,
                "valid_at": _utc_text(scenario_time + timedelta(minutes=minutes)),
                "model_version": model_version,
                "output_version": f"{model_version}:{horizon}",
                "depth_m": {
                    "p10": _round(p10),
                    "p50": _round(p50),
                    "p90": _round(p90),
                },
                "scenario_agreement": _round(agreement),
                "rapid_impact_estimate": {
                    "inundated_area_km2_p50": _round(catchment_area * area_fraction, 3),
                    "population_exposed_p50": int(round(population * exposure_fraction)),
                },
                "flood_threshold_m": 0.15,
            }
        )

    is_simulated = bool(snapshot.get("is_simulated", True))
    return {
        "model_version": model_version,
        "algorithm_version": MODEL_ALGORITHM_VERSION,
        "snapshot_checksum": snapshot_checksum,
        "seed": seed,
        "member_count": ENSEMBLE_SIZE,
        "ensemble_members": ENSEMBLE_SIZE,
        "scenario_time": _utc_text(scenario_time),
        "generated_at": _utc_text(scenario_time),
        "is_simulated": is_simulated,
        "data_label": "DEMO DATA" if is_simulated else "LIVE INPUTS",
        "classification": "RAPID_IMPACT_ESTIMATE",
        "horizons": horizon_summaries,
        "members": member_outputs,
        "assimilation": {
            "applied_adjustment_m": _round(assimilation_adjustment),
            "maximum_absolute_adjustment_m": 0.5,
            "influence_distance_m": 500.0,
            "evidence": assimilation_evidence,
        },
        "input_summary": {
            "rainfall_by_horizon_mm": {
                key: _round(value) for key, value in rainfall_by_horizon.items()
            },
            "river_stage_m": _round(river_stage),
            "bankfull_stage_m": _round(bankfull_stage),
            "base_depth_m": _round(base_depth),
            "terrain_susceptibility": _round(terrain),
            "drainage_efficiency": _round(drainage),
            "catchment_area_km2": _round(catchment_area),
            "exposure_population": int(round(population)),
        },
        "layer_semantics": {
            "modelled": "Nine-member rapid impact estimate",
            "observed": "Source observations remain separate",
            "assimilated": "Local report correction is bounded to +/-0.5 m",
        },
        "disclaimer": (
            "Rapid impact estimate for decision support; not a certified flood "
            "depth prediction or an authorization for operational action."
        ),
    }


# Short alias for workers and adapters that use a simulation-oriented name.
simulate_rapid_impact = run_rapid_impact_model


__all__ = [
    "CONFIDENCE_FORMULA_VERSION",
    "DEFAULT_MODEL_SEED",
    "ENSEMBLE_SIZE",
    "HORIZONS",
    "MODEL_ALGORITHM_VERSION",
    "bounded_report_assimilation",
    "explain_confidence",
    "run_rapid_impact_model",
    "simulate_rapid_impact",
]
