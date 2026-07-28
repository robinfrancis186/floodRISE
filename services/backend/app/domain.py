"""FloodRISE application service and safety-critical domain rules."""

from __future__ import annotations

import hashlib
import hmac
import math
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from threading import RLock
from typing import Any

from .auth import Principal, audit_actor_id
from .database import ConcurrentWriteError, Database, EntityChange, EventInput, canonical_json
from .errors import AppError, ConflictError, NotFoundError, PermissionDeniedError
from .schemas import (
    ApprovalCreateInput,
    ApprovalDecisionInput,
    DemoAdvanceInput,
    ReportInput,
    SignalDecisionInput,
)
from .seed import reset_database

CORROBORATION_MESSAGE = (
    "Corroborated by 4 independent recent reports; not an official confirmation."
)
EXPIRY_MESSAGE = "No recent confirmation; this does not mean the area is safe."
LOWER_RISK_DISCLAIMER = (
    "Lower-risk route estimate; conditions may change. Follow responder guidance."
)


def parse_utc(value: str | datetime) -> datetime:
    if isinstance(value, datetime):
        parsed = value
    else:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def iso_utc(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def haversine_m(a: Mapping[str, float], b: Mapping[str, float]) -> float:
    radius_m = 6_371_008.8
    lat1 = math.radians(float(a["latitude"]))
    lat2 = math.radians(float(b["latitude"]))
    delta_lat = lat2 - lat1
    delta_lon = math.radians(float(b["longitude"]) - float(a["longitude"]))
    value = (
        math.sin(delta_lat / 2) ** 2
        + math.cos(lat1) * math.cos(lat2) * math.sin(delta_lon / 2) ** 2
    )
    return 2 * radius_m * math.asin(math.sqrt(value))


def _medoid(reports: list[dict[str, Any]]) -> dict[str, float]:
    if not reports:
        raise ValueError("a medoid requires at least one report")
    return min(
        (report["location"] for report in reports),
        key=lambda candidate: sum(haversine_m(candidate, other["location"]) for other in reports),
    )


def _diameter(reports: list[dict[str, Any]]) -> float:
    return max(
        (
            haversine_m(left["location"], right["location"])
            for index, left in enumerate(reports)
            for right in reports[index + 1 :]
        ),
        default=0.0,
    )


class _UnionFind:
    def __init__(self, values: Iterable[str]) -> None:
        self.parent = {value: value for value in values}

    def find(self, value: str) -> str:
        parent = self.parent[value]
        if parent != value:
            self.parent[value] = self.find(parent)
        return self.parent[value]

    def union(self, left: str, right: str) -> None:
        left_root, right_root = self.find(left), self.find(right)
        if left_root != right_root:
            self.parent[right_root] = left_root


def evidence_families(reports: list[dict[str, Any]]) -> list[list[dict[str, Any]]]:
    """Collapse reports sharing any strong identifier into one evidence family."""

    union = _UnionFind(str(report["id"]) for report in reports)
    identifiers: dict[tuple[str, str], str] = {}
    for report in reports:
        report_id = str(report["id"])
        scalar_identifiers = {
            # The authenticated account is server-derived. reporter_id remains
            # only as a compatibility fallback for historical fixtures.
            "account_id": report.get("account_id") or report.get("reporter_id"),
            "device_id": report.get("device_id"),
            "client_report_id": report.get("client_report_id"),
        }
        for identifier_field, value in scalar_identifiers.items():
            if not value:
                continue
            key = (identifier_field, str(value))
            previous = identifiers.get(key)
            if previous:
                union.union(previous, report_id)
            else:
                identifiers[key] = report_id
        media_hashes = report.get("media_independence_hashes")
        if not isinstance(media_hashes, list):
            media_hashes = [report["media_hash"]] if report.get("media_hash") else []
        for value in media_hashes:
            if not value:
                continue
            key = ("media_independence_hash", str(value))
            previous = identifiers.get(key)
            if previous:
                union.union(previous, report_id)
            else:
                identifiers[key] = report_id

    grouped: dict[str, list[dict[str, Any]]] = {}
    for report in reports:
        grouped.setdefault(union.find(str(report["id"])), []).append(report)
    return list(grouped.values())


def confidence_breakdown(
    independent_families: int,
    mean_quality: float,
    *,
    external_corroboration: float = 0.0,
    conflicts: int = 0,
    fraud_risk: float = 0.0,
) -> dict[str, float | str]:
    """Return the plan's explainable, clamped confidence score."""

    try:
        from .intelligence import explain_confidence

        result = explain_confidence(
            independent_families,
            mean_quality,
            external_corroboration,
            conflicts,
            fraud_risk,
        )
        if isinstance(result, dict) and "score" in result:
            return result
    except (ImportError, TypeError, ValueError):
        pass

    base = 0.15
    independence = 0.60 * min(independent_families / 4, 1)
    quality = 0.10 * mean_quality
    additional = 0.05 * min(max(independent_families - 4, 0) / 4, 1)
    external = 0.10 * external_corroboration
    conflict_penalty = 0.15 * min(conflicts / 4, 1)
    fraud_penalty = 0.25 * fraud_risk
    score = min(
        0.99,
        max(
            0.0,
            base
            + independence
            + quality
            + additional
            + external
            - conflict_penalty
            - fraud_penalty,
        ),
    )
    return {
        "score": round(score, 4),
        "base": base,
        "independence": round(independence, 4),
        "mean_quality": round(quality, 4),
        "additional_reports": round(additional, 4),
        "external_corroboration": round(external, 4),
        "conflict_penalty": round(conflict_penalty, 4),
        "fraud_penalty": round(fraud_penalty, 4),
        "formula": (
            "clamp(0,.99,.15+.60*min(n/4,1)+.10*mean_quality+"
            ".05*min((n-4)/4,1)+.10*external-.15*min(conflicts/4,1)-.25*fraud_risk)"
        ),
    }


@dataclass(slots=True)
class FloodRiseService:
    database: Database
    is_demo: bool
    route_max_snap_distance_m: float = 500.0
    alert_sink: str | None = None
    _mutation_lock: RLock = field(default_factory=RLock, repr=False)

    def __post_init__(self) -> None:
        if not self.is_demo and self.alert_sink and self.alert_sink.startswith("fake://"):
            raise ValueError("A non-demo service cannot use the deterministic fake alert sink")

    @property
    def scenario_clock(self) -> datetime:
        value = self.database.get_state("scenario_clock")
        if not value:
            return datetime.now(UTC)
        return parse_utc(value)

    @property
    def incident_id(self) -> str:
        value = self.database.get_state("incident_id")
        if not value:
            raise AppError(
                status_code=404,
                title="No active incident",
                detail="No active incident has been configured for this runtime.",
                code="NO_ACTIVE_INCIDENT",
            )
        return str(value)

    def reset_demo(self, principal: Principal | None = None) -> dict[str, Any]:
        if not self.is_demo:
            raise PermissionDeniedError("Demo reset is disabled outside demo mode")
        reset_database(self.database)
        return {
            "incident_id": self.incident_id,
            "scenario_time": iso_utc(self.scenario_clock),
            "reset_at": iso_utc(datetime.now(UTC)),
            "data_label": "DEMO DATA",
            "message": (
                "Deterministic Kerala extreme-rainfall replay reset; "
                "no live provider was contacted."
            ),
        }

    def incidents(self) -> list[dict[str, Any]]:
        return self.database.list("incident")

    def incident(self, incident_id: str) -> dict[str, Any]:
        incident = self.database.get("incident", incident_id)
        if not incident:
            raise NotFoundError("incident", incident_id)
        return incident

    @staticmethod
    def _for_incident(items: list[dict[str, Any]], incident_id: str) -> list[dict[str, Any]]:
        return [item for item in items if item.get("incident_id") == incident_id]

    def sources(self) -> list[dict[str, Any]]:
        result: list[dict[str, Any]] = []
        for source in self.database.list("source"):
            view = dict(source)
            valid_until = view.get("valid_until")
            if valid_until and self.scenario_clock > parse_utc(valid_until):
                view["status"] = "STALE"
                view["quality_flags"] = sorted({*view.get("quality_flags", []), "STALE"})
                view["message"] = (
                    f"Last-known {view['provider']} data; operational influence is reduced."
                )
            result.append(view)
        return result

    def reports(self, incident_id: str) -> list[dict[str, Any]]:
        return self._for_incident(self.database.list("report"), incident_id)

    def report(self, report_id: str) -> dict[str, Any]:
        report = self.database.get("report", report_id)
        if not report:
            raise NotFoundError("report", report_id)
        return report

    def signals(self, incident_id: str) -> list[dict[str, Any]]:
        return [
            self._freshness_view(item)
            for item in self._for_incident(self.database.list("signal"), incident_id)
        ]

    def signal(self, signal_id: str) -> dict[str, Any]:
        signal = self.database.get("signal", signal_id)
        if not signal:
            raise NotFoundError("signal", signal_id)
        return self._freshness_view(signal)

    def _freshness_view(self, signal: dict[str, Any]) -> dict[str, Any]:
        result = dict(signal)
        if result.get("state") in {"RESOLVED", "DISPUTED"}:
            return result
        last = parse_utc(result["last_observed_at"])
        age = self.scenario_clock - last
        if age > timedelta(minutes=120):
            result["state"] = "EXPIRED"
            result["display_message"] = EXPIRY_MESSAGE
            result["freshness"] = "EXPIRED"
        elif age > timedelta(minutes=60):
            result["state"] = "STALE"
            result["display_message"] = (
                "Community evidence is stale; conditions are uncertain and this is "
                "not an all-clear."
            )
            result["freshness"] = "STALE"
        elif age > timedelta(minutes=30):
            result["freshness"] = "AGING"
        else:
            result["freshness"] = "FRESH"
        return result

    def _choose_cluster(
        self,
        report: dict[str, Any],
        existing_reports: list[dict[str, Any]],
        existing_signals: list[dict[str, Any]],
    ) -> str:
        eligible_signals = sorted(
            existing_signals,
            key=lambda signal: haversine_m(
                report["location"],
                {
                    "latitude": signal["location"]["coordinates"][1],
                    "longitude": signal["location"]["coordinates"][0],
                },
            ),
        )
        for signal in eligible_signals:
            center = {
                "latitude": signal["location"]["coordinates"][1],
                "longitude": signal["location"]["coordinates"][0],
            }
            if haversine_m(report["location"], center) > 250:
                continue
            members = [
                item for item in existing_reports if item.get("cluster_id") == signal["cluster_id"]
            ]
            if _diameter([*members, report]) <= 500:
                return str(signal["cluster_id"])
        digest = hashlib.sha256(
            f"{report['incident_id']}:{report['location']['latitude']:.4f}:"
            f"{report['location']['longitude']:.4f}".encode()
        ).hexdigest()[:10]
        return f"cluster-{digest}"

    def _build_signal(
        self,
        *,
        cluster_id: str,
        reports: list[dict[str, Any]],
        existing: dict[str, Any] | None,
    ) -> dict[str, Any]:
        newest = max(parse_utc(report["observed_at"]) for report in reports)
        window = [
            report
            for report in reports
            if newest - parse_utc(report["observed_at"]) <= timedelta(minutes=30)
            and report.get("disposition") == "ELIGIBLE"
        ]
        positive = [report for report in window if report.get("flood_status") == "FLOODED"]
        contradictions = [
            report for report in window if report.get("flood_status") == "NOT_FLOODED"
        ]
        families = evidence_families(positive)
        trusted_families = sum(
            any(member.get("trusted") or member.get("authenticated") for member in family)
            for family in families
        )
        family_representatives = [
            max(family, key=lambda item: item["quality_score"]) for family in families
        ]
        mean_quality = (
            sum(float(item["quality_score"]) for item in family_representatives)
            / len(family_representatives)
            if family_representatives
            else 0.0
        )
        breakdown = confidence_breakdown(
            len(families),
            mean_quality,
            conflicts=len(contradictions),
            fraud_risk=0.0,
        )
        score = float(breakdown["score"])
        if len(contradictions) >= 2:
            state = "NEEDS_REVIEW"
        elif len(families) >= 4 and trusted_families >= 2 and score >= 0.75:
            state = "COMMUNITY_CORROBORATED"
        elif len(families) >= 2:
            state = "CORROBORATING"
        else:
            state = "CANDIDATE"

        location_reports = positive or window or reports
        medoid = _medoid(location_reports)
        radius = max(
            (haversine_m(medoid, item["location"]) for item in location_reports), default=0
        )
        version = int(existing.get("version", 0)) + 1 if existing else 1
        signal_id = str(existing["id"]) if existing else cluster_id.replace("cluster-", "signal-")
        last_observed = max(parse_utc(item["observed_at"]) for item in window or reports)
        first_observed = min(parse_utc(item["observed_at"]) for item in window or reports)
        if state == "COMMUNITY_CORROBORATED":
            display_message = CORROBORATION_MESSAGE
        elif state == "NEEDS_REVIEW":
            display_message = "Conflicting recent reports require authorized human review."
        elif state == "CORROBORATING":
            display_message = (
                f"{len(families)} independent recent reports; corroboration is still in progress."
            )
        else:
            display_message = "One recent report; not corroborated."
        return {
            "id": signal_id,
            "incident_id": reports[0]["incident_id"],
            "cluster_id": cluster_id,
            "state": state,
            "location": {
                "type": "Point",
                "coordinates": [medoid["longitude"], medoid["latitude"]],
            },
            "radius_m": round(radius, 2),
            "diameter_m": round(_diameter(location_reports), 2),
            "confidence": score,
            "confidence_breakdown": breakdown,
            "independent_report_count": len(families),
            "authenticated_report_count": trusted_families,
            "report_count": len(window),
            "first_observed_at": iso_utc(first_observed),
            "last_observed_at": iso_utc(last_observed),
            "stale_at": iso_utc(last_observed + timedelta(minutes=60)),
            "expires_at": iso_utc(last_observed + timedelta(minutes=120)),
            "display_message": display_message,
            "evidence_version": f"evidence-{signal_id}-v{version}",
            "contradiction_present": bool(contradictions),
            "route_recalculation_requested": state == "COMMUNITY_CORROBORATED",
            "human_review": (
                existing.get("human_review")
                if existing and not existing.get("presentation_seed")
                else None
            ),
            "is_simulated": self.is_demo,
            "version": version,
        }

    def _authoritative_install_id(self, principal: Principal) -> str:
        """Return only an IdP/server-derived install family identifier."""

        if principal.install_id_digest:
            return principal.install_id_digest
        if self.is_demo:
            return hmac.new(
                principal.audit_pseudonym_key,
                f"demo-install:{principal.user_id}".encode(),
                hashlib.sha256,
            ).hexdigest()
        raise PermissionDeniedError(
            "A signed install identity claim is required for live report submission"
        )

    def create_report(
        self,
        report_input: ReportInput,
        *,
        idempotency_key: str,
        principal: Principal,
    ) -> tuple[int, dict[str, Any]]:
        # The SQLite demo has one application process. This lock makes the
        # read-classify-write aggregate transition serializable; production
        # PostgreSQL deployments additionally use transaction/row locking.
        with self._mutation_lock:
            for attempt in range(3):
                try:
                    return self._create_report_locked(
                        report_input,
                        idempotency_key=idempotency_key,
                        principal=principal,
                    )
                except ConcurrentWriteError:
                    if attempt == 2:
                        raise
            raise AssertionError("unreachable report retry state")

    def _create_report_locked(
        self,
        report_input: ReportInput,
        *,
        idempotency_key: str,
        principal: Principal,
    ) -> tuple[int, dict[str, Any]]:
        if not idempotency_key or len(idempotency_key) > 360:
            raise AppError(
                status_code=400,
                title="Idempotency-Key required",
                detail="Provide a stable Idempotency-Key of at most 360 characters.",
                code="IDEMPOTENCY_KEY_REQUIRED",
            )
        request_body = report_input.model_dump(mode="json")
        request_body["device_id"] = self._authoritative_install_id(principal)
        principal_scope = hashlib.sha256(principal.user_id.encode()).hexdigest()[:24]
        idempotency_scope = f"report.create:{principal_scope}"
        replay = self.database.idempotent_response(idempotency_scope, idempotency_key)
        if replay:
            status, payload = replay
            replayed_report = payload.get("report", {})
            if self._report_request_fingerprint(
                replayed_report
            ) != self._report_request_fingerprint(request_body):
                raise ConflictError(
                    "This Idempotency-Key was already used for a different report payload",
                    code="IDEMPOTENCY_KEY_REUSED",
                )
            return status, {**payload, "replayed": True}

        body = dict(request_body)
        # Independence and trust are authority data. Never accept them from the
        # request body: bind the evidence to the authenticated principal and
        # derive trusted-responder status from server-enforced roles.
        body["account_id"] = principal.user_id
        body["authenticated"] = bool(principal.authenticated)
        body["trusted"] = principal.role in {
            "responder",
            "verifier",
            "engineer",
            "incident_commander",
        }
        incident = self.incident(str(body["incident_id"]))
        if bool(incident.get("is_simulated")) != self.is_demo:
            raise ConflictError(
                "Demo and live reports cannot share an incident", code="MODE_MISMATCH"
            )
        media_hash, attached_media, media_independence_hashes = self._validate_media_attachments(
            body, principal
        )
        body["media_hash"] = media_hash
        body["media_independence_hashes"] = media_independence_hashes

        existing_reports = self.reports(body["incident_id"])
        for prior in existing_reports:
            if prior.get("client_report_id") == body["client_report_id"]:
                # A competing worker can commit after our initial idempotency
                # read but before this client-ID check. Give the shared key its
                # authoritative semantics before classifying the client ID.
                concurrent_replay = self.database.idempotent_response(
                    idempotency_scope, idempotency_key
                )
                if concurrent_replay:
                    replay_status, replay_payload = concurrent_replay
                    winner = replay_payload.get("report", {})
                    if self._report_request_fingerprint(winner) != self._report_request_fingerprint(
                        request_body
                    ):
                        raise ConflictError(
                            "This Idempotency-Key was already used for a different report payload",
                            code="IDEMPOTENCY_KEY_REUSED",
                        )
                    return replay_status, {**replay_payload, "replayed": True}
                if prior.get("account_id") != body["account_id"]:
                    raise ConflictError(
                        "This client report identifier is already bound to another account",
                        code="CLIENT_REPORT_ID_COLLISION",
                    )
                if self._report_request_fingerprint(prior) != self._report_request_fingerprint(
                    body
                ):
                    raise ConflictError(
                        "This client report identifier was reused with a different payload",
                        code="CLIENT_REPORT_ID_REUSED",
                    )
                signal = self.database.get("signal", str(prior.get("signal_id", "")))
                payload = {
                    "report": prior,
                    "signal": self._freshness_view(signal) if signal else None,
                    "receipt": self._receipt(prior, duplicate=True),
                    "replayed": True,
                }
                return 200, payload

        now = self.scenario_clock
        observed = parse_utc(body["observed_at"])
        reasons: list[str] = []
        disposition = "ELIGIBLE"
        if float(body["location"]["accuracy_m"]) > 100:
            disposition = "INVALID"
            reasons.append("GPS accuracy is worse than 100 m; retained for human review only")
        elif observed > now + timedelta(minutes=5):
            disposition = "INVALID"
            reasons.append("Observation time is more than five minutes in the future")
        elif now - observed > timedelta(minutes=45):
            disposition = "LATE"
            reasons.append("Observation is historical and cannot trigger a live signal")

        strong_duplicate = next(
            (
                item
                for item in existing_reports
                if (
                    item.get("account_id") == body["account_id"]
                    or item.get("device_id") == body["device_id"]
                    or bool(
                        set(item.get("media_independence_hashes") or [])
                        & set(body["media_independence_hashes"])
                    )
                )
                and abs((observed - parse_utc(item["observed_at"])).total_seconds()) <= 30 * 60
            ),
            None,
        )
        if strong_duplicate and disposition == "ELIGIBLE":
            disposition = "DUPLICATE"
            reasons.append(
                "A recent report from this account and install already contributes one vote"
            )

        digest = hashlib.sha256(
            f"{body['incident_id']}:{body['client_report_id']}".encode()
        ).hexdigest()[:16]
        report_id = f"report-{digest}"
        quality = max(0.5, min(0.99, 1 - float(body["location"]["accuracy_m"]) / 200))
        report: dict[str, Any] = {
            "id": report_id,
            **body,
            "received_at": iso_utc(now),
            "disposition": disposition,
            "disposition_reasons": reasons,
            "eligible_for_live_signal": disposition == "ELIGIBLE",
            "quality_score": round(quality, 3),
            "trusted": bool(body["trusted"]),
            "authenticated": bool(body["authenticated"]),
            "public_location": {
                # A ~1 km grid comfortably exceeds the 200 m public minimum even
                # after longitude convergence at Kerala's latitude.
                "latitude": round(float(body["location"]["latitude"]), 2),
                "longitude": round(float(body["location"]["longitude"]), 2),
                "accuracy_m": max(200, float(body["location"]["accuracy_m"])),
            },
            "idempotency_key_digest": hashlib.sha256(idempotency_key.encode()).hexdigest(),
            "is_simulated": self.is_demo,
            "version": 1,
        }

        existing_signals = self.signals(body["incident_id"])
        cluster_id = self._choose_cluster(report, existing_reports, existing_signals)
        report["cluster_id"] = cluster_id
        existing_signal = next(
            (signal for signal in existing_signals if signal["cluster_id"] == cluster_id), None
        )
        signal_reports = [
            item for item in existing_reports if item.get("cluster_id") == cluster_id
        ] + [report]
        signal = self._build_signal(
            cluster_id=cluster_id,
            reports=signal_reports,
            existing=existing_signal,
        )
        report["signal_id"] = signal["id"]
        report["evidence_family_id"] = self._family_id(report)

        media_changes: list[EntityChange] = []
        media_events: list[EventInput] = []
        for media_record in attached_media:
            updated_media = dict(media_record)
            attached_reports = set(updated_media.get("attached_report_ids", []))
            attached_reports.add(report_id)
            updated_media["attached_report_ids"] = sorted(attached_reports)
            updated_media["version"] = int(updated_media.get("version", 1)) + 1
            media_changes.append(
                EntityChange(
                    "media_upload",
                    str(updated_media["upload_id"]),
                    updated_media,
                    updated_media["version"],
                    int(media_record.get("version", 1)),
                )
            )
            media_events.append(
                EventInput(
                    event_type="media.attached_to_report",
                    aggregate_kind="media_upload",
                    aggregate_id=str(updated_media["upload_id"]),
                    aggregate_version=updated_media["version"],
                    actor_id=audit_actor_id(principal, str(body["incident_id"])),
                    actor_role=principal.role,
                    payload={
                        "report_id": report_id,
                        "status": updated_media["status"],
                        "visibility": "PRIVATE",
                    },
                    incident_id=str(body["incident_id"]),
                )
            )

        changes = [
            EntityChange("report", report_id, report, 1),
            EntityChange(
                "signal",
                signal["id"],
                signal,
                signal["version"],
                int(existing_signal["version"]) if existing_signal else 0,
            ),
            *media_changes,
        ]
        event_type = {
            "DUPLICATE": "report.duplicate",
            "LATE": "report.late",
            "INVALID": "report.invalid",
        }.get(disposition, "report.received")
        events = [
            EventInput(
                event_type=event_type,
                aggregate_kind="report",
                aggregate_id=report_id,
                aggregate_version=1,
                actor_id=audit_actor_id(principal, str(body["incident_id"])),
                actor_role=principal.role,
                payload={
                    "disposition": disposition,
                    "cluster_id": cluster_id,
                    "quality_score": report["quality_score"],
                    "is_simulated": self.is_demo,
                },
                incident_id=body["incident_id"],
            ),
            EventInput(
                event_type="signal.updated" if existing_signal else "signal.created",
                aggregate_kind="signal",
                aggregate_id=signal["id"],
                aggregate_version=signal["version"],
                actor_id="floodsignal-engine",
                actor_role="system",
                payload={
                    "state": signal["state"],
                    "independent_report_count": signal["independent_report_count"],
                    "confidence": signal["confidence"],
                    "evidence_version": signal["evidence_version"],
                },
                incident_id=body["incident_id"],
            ),
            *media_events,
        ]

        transitioned = signal["state"] == "COMMUNITY_CORROBORATED" and (
            not existing_signal or existing_signal.get("state") != "COMMUNITY_CORROBORATED"
        )
        if transitioned:
            events.append(
                EventInput(
                    event_type="signal.community_corroborated",
                    aggregate_kind="signal",
                    aggregate_id=signal["id"],
                    aggregate_version=signal["version"],
                    actor_id="floodsignal-engine",
                    actor_role="system",
                    payload={
                        "display_message": CORROBORATION_MESSAGE,
                        "confidence": signal["confidence"],
                        "evidence_version": signal["evidence_version"],
                    },
                    incident_id=body["incident_id"],
                )
            )
            caution = self._community_caution(signal)
            changes.append(EntityChange("alert", caution["id"], caution, caution["version"]))
            events.append(
                EventInput(
                    event_type="alert.caution_created",
                    aggregate_kind="alert",
                    aggregate_id=caution["id"],
                    aggregate_version=caution["version"],
                    actor_id="floodsignal-engine",
                    actor_role="system",
                    payload={
                        "caution_only": True,
                        "official": False,
                        "gateway": self.alert_sink,
                        "dispatch_suppressed": self.alert_sink is None,
                    },
                    incident_id=body["incident_id"],
                )
            )
            route_changes, route_events = self._recalculate_routes_for_signal(signal)
            changes.extend(route_changes)
            events.extend(route_events)

        response = {
            "report": report,
            "signal": signal,
            "receipt": self._receipt(report, duplicate=disposition == "DUPLICATE"),
            "corroboration_transitioned": transitioned,
            "replayed": False,
        }
        try:
            self.database.commit(
                changes=changes,
                events=events,
                idempotency=(idempotency_scope, idempotency_key, 201, response),
            )
        except ValueError as exc:
            # Another worker may have committed the same offline retry while this
            # request was computing its cluster. Return the authoritative receipt.
            replay = self.database.idempotent_response(idempotency_scope, idempotency_key)
            if replay:
                replay_status, replay_payload = replay
                winner = replay_payload.get("report", {})
                if self._report_request_fingerprint(winner) != self._report_request_fingerprint(
                    request_body
                ):
                    raise ConflictError(
                        "This Idempotency-Key was already used for a different report payload",
                        code="IDEMPOTENCY_KEY_REUSED",
                    ) from exc
                return replay_status, {**replay_payload, "replayed": True}
            raise exc
        return 201, response

    def _validate_media_attachments(
        self,
        body: dict[str, Any],
        principal: Principal,
    ) -> tuple[str | None, list[dict[str, Any]], list[str]]:
        upload_ids = [str(value) for value in body.get("media_upload_ids", [])]
        supplied_hash = body.get("media_hash")
        if not upload_ids:
            if supplied_hash:
                raise ConflictError(
                    "A client-supplied media hash is not accepted without private media uploads",
                    code="MEDIA_HASH_NOT_SERVER_DERIVED",
                )
            return None, [], []
        if len(upload_ids) != len(set(upload_ids)):
            raise ConflictError(
                "A media upload may be attached only once per report",
                code="MEDIA_UPLOAD_DUPLICATED",
            )

        authorized_staff = {
            "responder",
            "verifier",
            "engineer",
            "incident_commander",
            "identity_administrator",
        }
        records: list[dict[str, Any]] = []
        independence_hashes: list[str] = []
        for upload_id in upload_ids:
            record = self.database.get("media_upload", upload_id)
            if not record:
                raise NotFoundError("media upload", upload_id)
            if record.get("incident_id") != body["incident_id"]:
                raise ConflictError(
                    "Media evidence must belong to the report incident",
                    code="MEDIA_INCIDENT_MISMATCH",
                )
            if record.get(
                "requested_by"
            ) != principal.user_id and principal.granted_roles.isdisjoint(authorized_staff):
                raise PermissionDeniedError(
                    "A reporter cannot attach another identity's private evidence media"
                )
            if record.get("status") not in {"READY_PRIVATE", "DUPLICATE_PRIVATE"}:
                raise ConflictError(
                    f"Media upload '{upload_id}' is not ready for evidence use",
                    code="MEDIA_NOT_READY",
                )
            independence_hash = record.get("independence_hash")
            if not independence_hash:
                raise ConflictError(
                    f"Media upload '{upload_id}' has no sanitized independence hash",
                    code="MEDIA_NOT_READY",
                )
            records.append(record)
            independence_hashes.append(str(independence_hash))

        derived_hash = hashlib.sha256("|".join(sorted(independence_hashes)).encode()).hexdigest()
        if supplied_hash and supplied_hash != derived_hash:
            raise ConflictError(
                "The supplied media hash does not match sanitized private evidence",
                code="MEDIA_HASH_NOT_SERVER_DERIVED",
            )
        return derived_hash, records, sorted(set(independence_hashes))

    @staticmethod
    def _report_request_fingerprint(body: Mapping[str, Any]) -> str:
        request_fields = {
            key: body.get(key)
            for key in (
                "client_report_id",
                "incident_id",
                "reporter_id",
                "device_id",
                "observed_at",
                "location",
                "water_depth",
                "road_status",
                "infrastructure_issues",
                "note",
                "flood_status",
                "media_upload_ids",
                "schema_version",
            )
        }
        return hashlib.sha256(canonical_json(request_fields).encode()).hexdigest()

    @staticmethod
    def _family_id(report: Mapping[str, Any]) -> str:
        digest = hashlib.sha256(
            (
                f"{report.get('account_id') or report.get('reporter_id')}:{report.get('device_id')}"
            ).encode()
        ).hexdigest()[:12]
        return f"family-{digest}"

    @staticmethod
    def _receipt(report: Mapping[str, Any], *, duplicate: bool) -> dict[str, Any]:
        disposition = str(report["disposition"])
        if disposition == "ELIGIBLE":
            message = "Report received and eligible for community corroboration."
        elif disposition == "DUPLICATE":
            message = "Report retained, but it does not add an independent corroboration vote."
        elif disposition == "LATE":
            message = "Historical report retained; it cannot trigger a live caution."
        else:
            message = "Report retained for authorized review."
        return {
            "report_id": report["id"],
            "client_report_id": report["client_report_id"],
            "disposition": disposition,
            "accepted_at": report["received_at"],
            "duplicate": duplicate,
            "live_signal_eligible": disposition == "ELIGIBLE",
            "cluster_id": report.get("cluster_id"),
            "sync_message": message,
        }

    def _community_caution(self, signal: Mapping[str, Any]) -> dict[str, Any]:
        now = self.scenario_clock
        dispatched = self.alert_sink is not None
        return {
            "id": f"caution-{signal['id']}-v{signal['version']}",
            "incident_id": signal["incident_id"],
            "signal_id": signal["id"],
            "approval_request_id": None,
            "status": "DISPATCHED" if dispatched else "SUPPRESSED",
            "title": "Community-corroborated flooding nearby",
            "body": CORROBORATION_MESSAGE,
            "audience": "Opted-in users inside the hazard footprint plus 1 km",
            "geometry": signal["location"],
            "caution_only": True,
            "official": False,
            "evidence_version": signal["evidence_version"],
            "model_version": self._active_model_version(),
            "created_at": iso_utc(now),
            "approved_at": None,
            "dispatched_at": iso_utc(now) if dispatched else None,
            "expires_at": iso_utc(now + timedelta(minutes=30)),
            "gateway": self.alert_sink,
            "is_demo": self.is_demo,
            "version": 1,
        }

    def _active_model_version(self) -> str:
        simulations = self.database.list("simulation")
        return (
            str(simulations[-1].get("model_version", "model-demo-20231204-001"))
            if simulations
            else ("model-demo-20231204-001" if self.is_demo else "model-unavailable")
        )

    def _recalculate_routes_for_signal(
        self, signal: Mapping[str, Any]
    ) -> tuple[list[EntityChange], list[EventInput]]:
        now = self.scenario_clock
        existing = self._for_incident(self.database.list("route"), str(signal["incident_id"]))
        route = (
            dict(existing[0])
            if existing
            else {
                "id": "route-lower-risk-001",
                "incident_id": signal["incident_id"],
                "label": "Lower-risk route to Aluva School Shelter",
                "duration_min": 18,
                "distance_km": 4.2,
                "shelter": "Aluva School Shelter",
                "shelter_id": "shelter-aluva-school",
                "risk": "LOWER",
                "reasons": [],
                "model_version": self._active_model_version(),
                "version": 0,
            }
        )
        route["version"] = int(route.get("version", 0)) + 1
        route["evidence_version"] = signal["evidence_version"]
        route["valid_until"] = iso_utc(now + timedelta(minutes=10))
        route["reasons"] = [
            "Avoids community-corroborated flooding; this is not an official road closure",
            "Avoids modelled p50 depth of at least 0.15 m and p90 depth of at least 0.30 m",
        ]
        route["wording"] = LOWER_RISK_DISCLAIMER
        route["is_simulated"] = self.is_demo
        return (
            [
                EntityChange(
                    "route",
                    route["id"],
                    route,
                    route["version"],
                    int(route["version"]) - 1,
                )
            ],
            [
                EventInput(
                    event_type="route.recalculated",
                    aggregate_kind="route",
                    aggregate_id=route["id"],
                    aggregate_version=route["version"],
                    actor_id="routing-engine",
                    actor_role="system",
                    payload={
                        "evidence_version": signal["evidence_version"],
                        "reason": "community corroboration",
                    },
                    incident_id=str(signal["incident_id"]),
                )
            ],
        )

    def decide_signal(
        self,
        signal_id: str,
        decision: SignalDecisionInput,
        principal: Principal,
    ) -> dict[str, Any]:
        current = self.database.get("signal", signal_id)
        if not current:
            raise NotFoundError("signal", signal_id)
        if int(current["version"]) != decision.expected_version:
            raise ConflictError(
                f"Signal version is {current['version']}; expected {decision.expected_version}"
            )
        updated = dict(current)
        value = str(decision.decision)
        if value in {"DISPUTE", "REJECT", "REJECTED"}:
            updated["state"] = "DISPUTED"
        elif value in {"VERIFY", "VERIFIED"}:
            updated["state"] = "COMMUNITY_CORROBORATED"
        elif value == "RESOLVE":
            updated["state"] = "RESOLVED"
        elif value in {"FIELD_CHECK", "MODIFY", "UNREVIEWED"}:
            updated["state"] = "NEEDS_REVIEW"
        updated["human_review"] = {
            "decision": value,
            "reason": decision.reason,
            "reviewed_by": principal.user_id,
            "reviewed_at": iso_utc(self.scenario_clock),
        }
        updated["version"] = int(updated["version"]) + 1
        self.database.commit(
            changes=[
                EntityChange(
                    "signal",
                    signal_id,
                    updated,
                    updated["version"],
                    int(current["version"]),
                )
            ],
            events=[
                EventInput(
                    event_type="signal.reviewed",
                    aggregate_kind="signal",
                    aggregate_id=signal_id,
                    aggregate_version=updated["version"],
                    actor_id=principal.user_id,
                    actor_role=principal.role,
                    payload={
                        "decision": value,
                        "reason": decision.reason,
                        "previous_state": current["state"],
                        "next_state": updated["state"],
                    },
                    incident_id=updated["incident_id"],
                )
            ],
        )
        return updated

    def simulations(self, incident_id: str) -> list[dict[str, Any]]:
        return self._for_incident(self.database.list("simulation"), incident_id)

    def impacts(self, incident_id: str) -> list[dict[str, Any]]:
        return self._for_incident(self.database.list("impact"), incident_id)

    def run_simulation(
        self, incident_id: str, *, trigger: str, principal: Principal
    ) -> dict[str, Any]:
        self.incident(incident_id)
        if not self.is_demo:
            raise AppError(
                status_code=503,
                title="Live model unavailable",
                detail=(
                    "The deterministic replay model is isolated from live incidents; "
                    "configure an approved live model adapter before publishing."
                ),
                code="LIVE_MODEL_UNAVAILABLE",
            )
        snapshot = {
            "incident_id": incident_id,
            "scenario_time": iso_utc(self.scenario_clock),
            "rainfall_mm_3h": 118,
            "gauge_stage_m": 2.14,
            "reports": self.reports(incident_id),
            "sources": self.sources(),
            "is_simulated": self.is_demo,
        }
        try:
            from .intelligence import run_rapid_impact_model

            model_result = run_rapid_impact_model(snapshot, seed=5305)
        except (ImportError, TypeError, ValueError):
            checksum = hashlib.sha256(canonical_json(snapshot).encode()).hexdigest()
            model_result = {
                "model_version": f"model-demo-{checksum[:12]}",
                "snapshot_checksum": checksum,
                "ensemble_members": 9,
                "horizons": {
                    "now": {"p10_depth_m": 0.08, "p50_depth_m": 0.22, "p90_depth_m": 0.39},
                    "+30m": {"p10_depth_m": 0.11, "p50_depth_m": 0.31, "p90_depth_m": 0.52},
                    "+1h": {"p10_depth_m": 0.15, "p50_depth_m": 0.38, "p90_depth_m": 0.64},
                    "+3h": {"p10_depth_m": 0.07, "p50_depth_m": 0.2, "p90_depth_m": 0.41},
                },
            }
        model_version = str(model_result["model_version"])
        existing = self.database.get("simulation", model_version)
        version = int(existing.get("version", 0)) + 1 if existing else 1
        simulation = {
            "id": model_version,
            "incident_id": incident_id,
            "model_version": model_version,
            "evidence_version": self._latest_evidence_version(incident_id),
            "status": "PUBLISHED",
            "kind": "rapid impact estimate",
            "trigger": trigger,
            "scenario_time": iso_utc(self.scenario_clock),
            "started_at": iso_utc(self.scenario_clock),
            "completed_at": iso_utc(self.scenario_clock),
            "published_at": iso_utc(self.scenario_clock),
            "ensemble_members": int(model_result.get("ensemble_members", 9)),
            "result": model_result,
            "is_simulated": self.is_demo,
            "version": version,
        }
        impact_id = f"impact-{model_version}"
        existing_impact = self.database.get("impact", impact_id)
        impact_version = int(existing_impact.get("version", 0)) + 1 if existing_impact else 1
        impact = {
            "id": impact_id,
            "incident_id": incident_id,
            "model_version": model_version,
            "evidence_version": simulation["evidence_version"],
            "affected_population_estimate": 18_420,
            "population_label": "2025 modelled estimate; not an official count",
            "affected_communities": 6,
            "roads_at_risk": 14,
            "shelters_reachable": sum(
                item.get("access_status") == "REACHABLE" for item in self.shelters(incident_id)
            ),
            "confidence": 0.78,
            "valid_until": iso_utc(self.scenario_clock + timedelta(minutes=10)),
            "label": "Rapid impact estimate",
            "is_simulated": self.is_demo,
            "version": impact_version,
        }
        self.database.commit(
            changes=[
                EntityChange(
                    "simulation",
                    model_version,
                    simulation,
                    version,
                    int(existing["version"]) if existing else 0,
                ),
                EntityChange(
                    "impact",
                    impact_id,
                    impact,
                    impact_version,
                    int(existing_impact["version"]) if existing_impact else 0,
                ),
            ],
            events=[
                EventInput(
                    event_type="simulation.published",
                    aggregate_kind="simulation",
                    aggregate_id=model_version,
                    aggregate_version=version,
                    actor_id=principal.user_id,
                    actor_role=principal.role,
                    payload={
                        "trigger": trigger,
                        "model_version": model_version,
                        "snapshot_checksum": model_result.get("snapshot_checksum"),
                    },
                    incident_id=incident_id,
                )
            ],
        )
        return simulation

    def _latest_evidence_version(self, incident_id: str) -> str:
        signals = self.signals(incident_id)
        if not signals:
            return "evidence-demo-001" if self.is_demo else "evidence-unavailable"
        return str(max(signals, key=lambda item: int(item["version"]))["evidence_version"])

    def routes(self, incident_id: str) -> list[dict[str, Any]]:
        from .routing import shelter_is_eligible

        shelter_records = {str(shelter["id"]): shelter for shelter in self.shelters(incident_id)}
        current_routes: list[dict[str, Any]] = []
        for route in self._for_incident(self.database.list("route"), incident_id):
            shelter_id = route.get("shelter_id")
            shelter = shelter_records.get(str(shelter_id)) if shelter_id is not None else None
            if shelter is None:
                current_routes.append(
                    {
                        **route,
                        "shelter_status": "UNKNOWN",
                        "shelter_access_status": "UNKNOWN",
                        "shelter_detail": {
                            "id": shelter_id,
                            "name": route.get("shelter"),
                            "status": "UNKNOWN",
                            "access_status": "UNKNOWN",
                            "warnings": ["SHELTER_STATUS_UNVERIFIED"],
                        },
                    }
                )
                continue
            eligible, exclusion_codes = shelter_is_eligible(shelter)
            if not eligible:
                continue
            capacity_total = shelter.get("capacity_total", shelter.get("capacity"))
            capacity_remaining = shelter.get("capacity_remaining")
            current_routes.append(
                {
                    **route,
                    "shelter_status": str(
                        shelter.get(
                            "activation_status",
                            shelter.get("availability", "UNKNOWN"),
                        )
                    ).upper(),
                    "shelter_access_status": str(shelter.get("access_status", "UNKNOWN")).upper(),
                    "shelter_capacity_remaining": capacity_remaining,
                    "shelter_verified_at": shelter.get("verified_at", shelter.get("observed_at")),
                    "shelter_detail": {
                        "id": shelter["id"],
                        "name": shelter.get("name", route.get("shelter")),
                        "status": str(
                            shelter.get(
                                "activation_status",
                                shelter.get("availability", "UNKNOWN"),
                            )
                        ).upper(),
                        "activation_status": shelter.get("activation_status"),
                        "access_status": str(shelter.get("access_status", "UNKNOWN")).upper(),
                        "capacity_total": capacity_total,
                        "capacity_remaining": capacity_remaining,
                        "occupancy": shelter.get("occupancy"),
                        "verified_at": shelter.get("verified_at", shelter.get("observed_at")),
                        "version": shelter.get("version"),
                        "warnings": list(exclusion_codes),
                    },
                }
            )
        return current_routes

    def recommend_routes(
        self,
        incident_id: str,
        *,
        origin_node: str | None,
        origin_location: Mapping[str, float] | None = None,
        max_alternatives: int,
        principal: Principal,
    ) -> dict[str, Any]:
        del principal
        incident = self.incident(incident_id)
        now = self.scenario_clock
        model_version = self._active_model_version()
        evidence_version = self._latest_evidence_version(incident_id)
        valid_until = iso_utc(now + timedelta(minutes=10))
        if not self.is_demo:
            raise AppError(
                status_code=503,
                title="Live routing unavailable",
                detail=(
                    "The deterministic Kerala graph is isolated from live incidents; "
                    "configure an approved versioned road graph before requesting routes."
                ),
                code="LIVE_ROUTING_UNAVAILABLE",
            )
        try:
            from .routing import (
                apply_operational_overrides,
                build_demo_kerala_graph,
                find_lower_risk_routes,
            )
        except ImportError as exc:
            raise AppError(
                status_code=503,
                title="Routing unavailable",
                detail="The lower-risk routing engine could not be loaded.",
                code="ROUTING_UNAVAILABLE",
            ) from exc

        graph = apply_operational_overrides(
            build_demo_kerala_graph(),
            roads=self._for_incident(self.database.list("road"), incident_id),
            shelters=self.shelters(incident_id),
        )
        nodes = graph.get("nodes")
        if not isinstance(nodes, Mapping) or not nodes:
            raise AppError(
                status_code=503,
                title="Routing unavailable",
                detail="The active road graph has no routable nodes.",
                code="ROUTING_UNAVAILABLE",
            )

        selected_origin: str | None = None
        if origin_node and origin_location:
            return self._no_route_response(
                incident_id,
                now=now,
                model_version=model_version,
                evidence_version=evidence_version,
                valid_until=valid_until,
                reason_code="AMBIGUOUS_ORIGIN",
                reason="Provide one route origin, not both a node and coordinates.",
            )
        if origin_node:
            selected_origin = str(origin_node)
            if selected_origin not in nodes:
                return self._no_route_response(
                    incident_id,
                    now=now,
                    model_version=model_version,
                    evidence_version=evidence_version,
                    valid_until=valid_until,
                    reason_code="UNKNOWN_ORIGIN_NODE",
                    reason="The requested origin is not part of the active routable graph.",
                )
        elif origin_location:
            if float(origin_location.get("accuracy_m", 10_001)) > 100:
                return self._no_route_response(
                    incident_id,
                    now=now,
                    model_version=model_version,
                    evidence_version=evidence_version,
                    valid_until=valid_until,
                    reason_code="ORIGIN_ACCURACY_TOO_LOW",
                    reason="Route guidance requires a location accuracy of 100 m or better.",
                )
            bounds = incident.get("bounds")
            longitude = float(origin_location["longitude"])
            latitude = float(origin_location["latitude"])
            if (
                not isinstance(bounds, list)
                or len(bounds) != 4
                or not (
                    float(bounds[0]) <= longitude <= float(bounds[2])
                    and float(bounds[1]) <= latitude <= float(bounds[3])
                )
            ):
                return self._no_route_response(
                    incident_id,
                    now=now,
                    model_version=model_version,
                    evidence_version=evidence_version,
                    valid_until=valid_until,
                    reason_code="ORIGIN_OUTSIDE_INCIDENT_AREA",
                    reason="The supplied origin is outside the active incident area.",
                )
            nearest = min(
                nodes.values(),
                key=lambda node: haversine_m(
                    origin_location,
                    {
                        "latitude": float(node["latitude"]),
                        "longitude": float(node["longitude"]),
                    },
                ),
            )
            snap_distance = haversine_m(
                origin_location,
                {
                    "latitude": float(nearest["latitude"]),
                    "longitude": float(nearest["longitude"]),
                },
            )
            if snap_distance > self.route_max_snap_distance_m:
                return self._no_route_response(
                    incident_id,
                    now=now,
                    model_version=model_version,
                    evidence_version=evidence_version,
                    valid_until=valid_until,
                    reason_code="ORIGIN_TOO_FAR_FROM_ROUTABLE_NETWORK",
                    reason=(
                        "The supplied origin is too far from the verified routable network "
                        "for lower-risk guidance."
                    ),
                )
            selected_origin = str(nearest["id"])
        else:
            return self._no_route_response(
                incident_id,
                now=now,
                model_version=model_version,
                evidence_version=evidence_version,
                valid_until=valid_until,
                reason_code="ORIGIN_REQUIRED",
                reason="A route origin is required.",
            )

        try:
            result = find_lower_risk_routes(
                graph,
                selected_origin,
                model_version=model_version,
                evidence_version=evidence_version,
                valid_until=valid_until,
                max_alternatives=max_alternatives,
            )
        except (KeyError, TypeError, ValueError) as exc:
            raise AppError(
                status_code=503,
                title="Routing unavailable",
                detail="The active road graph could not produce a trustworthy route result.",
                code="ROUTING_UNAVAILABLE",
            ) from exc
        alternatives = []
        for raw in result.get("alternatives", []):
            alternative = dict(raw)
            shelter = alternative.get("shelter", {})
            shelter_name = (
                shelter.get("name", "Reachable shelter")
                if isinstance(shelter, Mapping)
                else str(shelter)
            )
            route_id = str(alternative.get("id", alternative.get("route_id", "route")))
            alternative.update(
                {
                    "id": route_id,
                    "label": alternative.get("label", f"Lower-risk route to {shelter_name}"),
                    "duration_min": alternative.get(
                        "duration_min", alternative.get("estimated_minutes")
                    ),
                    "distance_km": alternative.get(
                        "distance_km", round(float(alternative.get("distance_m", 0)) / 1_000, 2)
                    ),
                    "shelter": shelter_name,
                    "shelter_id": (
                        str(shelter["id"])
                        if isinstance(shelter, Mapping) and shelter.get("id") is not None
                        else None
                    ),
                    "shelter_detail": shelter if isinstance(shelter, Mapping) else None,
                    "risk": alternative.get("risk", "LOWER"),
                    "model_version": model_version,
                    "evidence_version": evidence_version,
                    "valid_until": valid_until,
                    "excluded_edge_count": len(result.get("excluded_edges", [])),
                    "wording": LOWER_RISK_DISCLAIMER,
                }
            )
            alternatives.append(alternative)
        return {
            "incident_id": incident_id,
            "generated_at": iso_utc(now),
            "status": result.get("status", "ROUTES_AVAILABLE" if alternatives else "NO_ROUTE"),
            "alternatives": alternatives,
            "exclusions": [
                *result.get("excluded_edges", []),
                *result.get("excluded_shelters", []),
            ],
            "excluded_edges": result.get("excluded_edges", []),
            "excluded_shelters": result.get("excluded_shelters", []),
            "graph_version": result.get("graph_version"),
            "no_route_reason": (
                "No compliant lower-risk route is currently available. Await responder guidance."
                if not alternatives
                else None
            ),
            "staging_point": result.get("staging_point"),
            "model_version": model_version,
            "evidence_version": evidence_version,
            "valid_until": valid_until,
            "disclaimer": LOWER_RISK_DISCLAIMER,
            "is_simulated": self.is_demo,
        }

    def _no_route_response(
        self,
        incident_id: str,
        *,
        now: datetime,
        model_version: str,
        evidence_version: str,
        valid_until: str,
        reason_code: str,
        reason: str,
    ) -> dict[str, Any]:
        return {
            "incident_id": incident_id,
            "generated_at": iso_utc(now),
            "status": "NO_ROUTE",
            "alternatives": [],
            "exclusions": [{"reason_code": reason_code}],
            "no_route_reason": reason,
            "reason_code": reason_code,
            "staging_point": None,
            "model_version": model_version,
            "evidence_version": evidence_version,
            "valid_until": valid_until,
            "disclaimer": LOWER_RISK_DISCLAIMER,
            "is_simulated": self.is_demo,
        }

    def shelters(self, incident_id: str) -> list[dict[str, Any]]:
        return self._for_incident(self.database.list("shelter"), incident_id)

    def update_shelter(
        self,
        shelter_id: str,
        updates: Mapping[str, Any],
        principal: Principal,
    ) -> dict[str, Any]:
        current = self.database.get("shelter", shelter_id)
        if not current:
            raise NotFoundError("shelter", shelter_id)
        expected = int(updates.get("expected_version", current["version"]))
        if expected != int(current["version"]):
            raise ConflictError(f"Shelter version is {current['version']}; expected {expected}")
        closure_values = {"CLOSED", "BLOCKED", "UNREACHABLE", "IMPASSABLE"}
        requested_activation = str(updates.get("activation_status", "")).upper()
        requested_access = str(updates.get("access_status", "")).upper()
        if requested_activation in closure_values or requested_access in closure_values:
            raise PermissionDeniedError(
                "Shelter closure or blocked access requires a separate two-person approval request"
            )
        updated = {
            **current,
            **{key: value for key, value in updates.items() if key != "expected_version"},
        }
        updated["version"] = int(current["version"]) + 1
        updated["verified_by"] = principal.user_id
        updated["verified_at"] = iso_utc(self.scenario_clock)
        self.database.commit(
            changes=[
                EntityChange(
                    "shelter",
                    shelter_id,
                    updated,
                    updated["version"],
                    int(current["version"]),
                )
            ],
            events=[
                EventInput(
                    event_type="shelter.status_updated",
                    aggregate_kind="shelter",
                    aggregate_id=shelter_id,
                    aggregate_version=updated["version"],
                    actor_id=principal.user_id,
                    actor_role=principal.role,
                    payload={
                        "access_status": updated.get("access_status"),
                        "capacity_remaining": updated.get("capacity_remaining"),
                    },
                    incident_id=updated["incident_id"],
                )
            ],
        )
        return updated

    def resilience(self, incident_id: str | None = None) -> list[dict[str, Any]]:
        items = self.database.list("resilience")
        return self._for_incident(items, incident_id) if incident_id else items

    def approvals(self, incident_id: str) -> list[dict[str, Any]]:
        return self._for_incident(self.database.list("approval"), incident_id)

    def _resolve_approval_bindings(
        self,
        incident_id: str,
        evidence_version: str,
        model_version: str,
        action_type: str,
        action_payload: Mapping[str, Any],
    ) -> dict[str, Any]:
        evidence = next(
            (
                signal
                for signal in self.signals(incident_id)
                if signal.get("evidence_version") == evidence_version
            ),
            None,
        )
        if evidence is None:
            raise AppError(
                status_code=422,
                title="Invalid approval binding",
                detail="The cited evidence version does not exist for this incident.",
                code="INVALID_EVIDENCE_BINDING",
            )
        if evidence.get("state") in {"STALE", "EXPIRED"}:
            raise AppError(
                status_code=422,
                title="Invalid approval binding",
                detail="The cited evidence is stale or expired and cannot authorize this action.",
                code="STALE_EVIDENCE_BINDING",
            )
        simulation = next(
            (
                item
                for item in self.simulations(incident_id)
                if item.get("model_version") == model_version
            ),
            None,
        )
        if simulation is None or simulation.get("status") != "PUBLISHED":
            raise AppError(
                status_code=422,
                title="Invalid approval binding",
                detail="The cited published model version does not exist for this incident.",
                code="INVALID_MODEL_BINDING",
            )
        binding = {
            "evidence_record_id": str(evidence["id"]),
            "evidence_record_version": int(evidence["version"]),
            "evidence_version": evidence_version,
            "model_record_id": str(simulation["id"]),
            "model_record_version": int(simulation["version"]),
            "model_version": model_version,
            "incident_id": incident_id,
        }
        target_kind: str | None = None
        target_id_field: str | None = None
        if action_type == "ROAD_CLOSURE":
            target_kind = "road"
            target_id_field = "road_id"
        elif action_type == "SHELTER_CLOSURE":
            target_kind = "shelter"
            target_id_field = "shelter_id"
        if target_kind and target_id_field:
            target_id = action_payload.get(target_id_field)
            if not isinstance(target_id, str) or not target_id.strip():
                raise AppError(
                    status_code=422,
                    title="Invalid approval target",
                    detail=(
                        f"{action_type} actions must identify a versioned "
                        f"{target_id_field} for this incident."
                    ),
                    code="INVALID_ACTION_TARGET",
                )
            target = self.database.get(target_kind, target_id)
            if target is None or str(target.get("incident_id")) != incident_id:
                raise AppError(
                    status_code=422,
                    title="Invalid approval target",
                    detail=(f"The cited {target_kind} does not exist in the approval incident."),
                    code="INVALID_ACTION_TARGET",
                )
            binding["action_target"] = {
                "kind": target_kind,
                "id": target_id,
                "record_version": int(target.get("version", 1)),
                "incident_id": incident_id,
            }
        return binding

    def create_approval(self, request: ApprovalCreateInput, principal: Principal) -> dict[str, Any]:
        if principal.role == "identity_administrator":
            raise PermissionDeniedError(
                "Identity administrators cannot request operational actions"
            )
        body = request.model_dump(mode="json")
        self.incident(body["incident_id"])
        binding = self._resolve_approval_bindings(
            str(body["incident_id"]),
            str(body["evidence_version"]),
            str(body["model_version"]),
            str(body["action_type"]),
            body["action_payload"],
        )
        now = self.scenario_clock
        payload_digest = hashlib.sha256(canonical_json(body).encode()).hexdigest()
        approval_id = f"approval-{payload_digest[:14]}"
        if self.database.get("approval", approval_id):
            raise ConflictError(
                "An approval for this exact action is already pending", code="DUPLICATE_ACTION"
            )
        approval = {
            "id": approval_id,
            **body,
            "payload_digest": payload_digest,
            "status": "PENDING",
            "requested_by": principal.user_id,
            "requested_role": principal.role,
            "request_authentication": principal.authentication_evidence(),
            "binding": binding,
            "requested_at": iso_utc(now),
            "expires_at": iso_utc(now + timedelta(minutes=15)),
            "decided_by": None,
            "decided_at": None,
            "decision_reason": None,
            "execution_status": "NOT_STARTED",
            "is_simulated": self.is_demo,
            "version": 1,
        }
        self.database.commit(
            changes=[EntityChange("approval", approval_id, approval, 1)],
            events=[
                EventInput(
                    event_type="approval.requested",
                    aggregate_kind="approval",
                    aggregate_id=approval_id,
                    aggregate_version=1,
                    actor_id=principal.user_id,
                    actor_role=principal.role,
                    payload={
                        "action_type": body["action_type"],
                        "payload_digest": payload_digest,
                        "expires_at": approval["expires_at"],
                    },
                    incident_id=body["incident_id"],
                )
            ],
        )
        return approval

    def decide_approval(
        self,
        approval_id: str,
        decision: ApprovalDecisionInput,
        principal: Principal,
    ) -> tuple[dict[str, Any], dict[str, Any] | None]:
        with self._mutation_lock:
            return self._decide_approval_locked(approval_id, decision, principal)

    def _decide_approval_locked(
        self,
        approval_id: str,
        decision: ApprovalDecisionInput,
        principal: Principal,
    ) -> tuple[dict[str, Any], dict[str, Any] | None]:
        if principal.role == "identity_administrator":
            raise PermissionDeniedError(
                "Identity administrators cannot approve operational actions"
            )
        current = self.database.get("approval", approval_id)
        if not current:
            raise NotFoundError("approval", approval_id)
        if current["status"] != "PENDING":
            raise ConflictError(f"Approval is already {current['status']}", code="ALREADY_DECIDED")
        if int(current["version"]) != decision.expected_version:
            raise ConflictError(
                f"Approval version is {current['version']}; expected {decision.expected_version}"
            )
        if current["requested_by"] == principal.user_id:
            raise PermissionDeniedError("The requester and approver must be different people")
        now = self.scenario_clock
        if now >= parse_utc(current["expires_at"]):
            expired = {**current, "status": "EXPIRED", "version": int(current["version"]) + 1}
            self.database.commit(
                changes=[
                    EntityChange(
                        "approval",
                        approval_id,
                        expired,
                        expired["version"],
                        int(current["version"]),
                    )
                ],
                events=[
                    EventInput(
                        event_type="approval.expired",
                        aggregate_kind="approval",
                        aggregate_id=approval_id,
                        aggregate_version=expired["version"],
                        actor_id="approval-engine",
                        actor_role="system",
                        payload={"expired_at": current["expires_at"]},
                        incident_id=current["incident_id"],
                    )
                ],
            )
            raise AppError(
                status_code=410,
                title="Approval expired",
                detail="The bound action expired after 15 minutes and must be requested again.",
                code="APPROVAL_EXPIRED",
            )

        decision_value = str(decision.decision)
        approved = decision_value == "APPROVE"
        modified = decision_value == "MODIFY"
        if approved:
            try:
                current_binding = self._resolve_approval_bindings(
                    str(current["incident_id"]),
                    str(current["evidence_version"]),
                    str(current["model_version"]),
                    str(current["action_type"]),
                    current["action_payload"],
                )
            except AppError as exc:
                raise ConflictError(
                    "The approval evidence or model binding is no longer valid",
                    code="APPROVAL_BINDING_CHANGED",
                ) from exc
            if current_binding != current.get("binding"):
                raise ConflictError(
                    "The approval evidence or model record changed after the request",
                    code="APPROVAL_BINDING_CHANGED",
                )
        updated = {
            **current,
            "status": "APPROVED" if approved else "MODIFIED" if modified else "REJECTED",
            "decided_by": principal.user_id,
            "decided_role": principal.role,
            "decision_authentication": principal.authentication_evidence(),
            "decided_at": iso_utc(now),
            "decision_reason": decision.reason,
            "execution_status": "SUCCEEDED" if approved else "NOT_STARTED",
            "version": int(current["version"]) + 1,
        }
        changes = [
            EntityChange(
                "approval",
                approval_id,
                updated,
                updated["version"],
                int(current["version"]),
            )
        ]
        event_type = (
            "approval.approved"
            if approved
            else "approval.modification_requested"
            if modified
            else "approval.rejected"
        )
        events = [
            EventInput(
                event_type=event_type,
                aggregate_kind="approval",
                aggregate_id=approval_id,
                aggregate_version=updated["version"],
                actor_id=principal.user_id,
                actor_role=principal.role,
                payload={
                    "reason": decision.reason,
                    "payload_digest": current["payload_digest"],
                    "requester": current["requested_by"],
                    "approver": principal.user_id,
                },
                incident_id=current["incident_id"],
            )
        ]
        alert: dict[str, Any] | None = None
        if approved:
            action_changes, action_events = self._approved_action_effects(updated, principal)
            changes.extend(action_changes)
            events.extend(action_events)
            alert = self._official_alert(updated)
            changes.append(EntityChange("alert", alert["id"], alert, 1))
            dispatched = self.alert_sink is not None
            events.append(
                EventInput(
                    event_type="alert.dispatched" if dispatched else "alert.dispatch_suppressed",
                    aggregate_kind="alert",
                    aggregate_id=alert["id"],
                    aggregate_version=1,
                    actor_id="demo-alert-gateway" if self.is_demo else "alert-gateway",
                    actor_role="system",
                    payload={
                        "official": True,
                        "approval_request_id": approval_id,
                        "gateway": self.alert_sink,
                    },
                    incident_id=current["incident_id"],
                )
            )
        self.database.commit(changes=changes, events=events)
        return updated, alert

    def _approved_action_effects(
        self,
        approval: Mapping[str, Any],
        principal: Principal,
    ) -> tuple[list[EntityChange], list[EventInput]]:
        """Apply only target-specific effects bound into the approved payload."""

        payload = approval.get("action_payload", {})
        action_type = str(approval["action_type"])
        if action_type == "ROAD_CLOSURE" and payload.get("road_id"):
            road_id = str(payload["road_id"])
            road = self.database.get("road", road_id)
            if not road:
                raise NotFoundError("road", road_id)
            changed = {
                **road,
                "status": "CLOSED",
                "reason": payload.get("body", approval["reason"]),
                "authorized_by_approval": approval["id"],
                "version": int(road.get("version", 1)) + 1,
            }
            return [
                EntityChange(
                    "road",
                    road_id,
                    changed,
                    changed["version"],
                    int(road.get("version", 1)),
                )
            ], [
                EventInput(
                    event_type="road.officially_closed",
                    aggregate_kind="road",
                    aggregate_id=road_id,
                    aggregate_version=changed["version"],
                    actor_id=principal.user_id,
                    actor_role=principal.role,
                    payload={"approval_request_id": approval["id"]},
                    incident_id=str(approval["incident_id"]),
                )
            ]
        if action_type == "SHELTER_CLOSURE" and payload.get("shelter_id"):
            shelter_id = str(payload["shelter_id"])
            shelter = self.database.get("shelter", shelter_id)
            if not shelter:
                raise NotFoundError("shelter", shelter_id)
            changed = {
                **shelter,
                "activation_status": "CLOSED",
                "access_status": "CLOSED",
                "status_reason": payload.get("body", approval["reason"]),
                "authorized_by_approval": approval["id"],
                "version": int(shelter.get("version", 1)) + 1,
            }
            return [
                EntityChange(
                    "shelter",
                    shelter_id,
                    changed,
                    changed["version"],
                    int(shelter.get("version", 1)),
                )
            ], [
                EventInput(
                    event_type="shelter.officially_closed",
                    aggregate_kind="shelter",
                    aggregate_id=shelter_id,
                    aggregate_version=changed["version"],
                    actor_id=principal.user_id,
                    actor_role=principal.role,
                    payload={"approval_request_id": approval["id"]},
                    incident_id=str(approval["incident_id"]),
                )
            ]
        return [], []

    def _official_alert(self, approval: Mapping[str, Any]) -> dict[str, Any]:
        now = self.scenario_clock
        payload = approval.get("action_payload", {})
        dispatched = self.alert_sink is not None
        return {
            "id": f"alert-{approval['id']}",
            "incident_id": approval["incident_id"],
            "approval_request_id": approval["id"],
            "status": "DISPATCHED" if dispatched else "APPROVED",
            "title": payload.get("title", str(approval["action_type"]).replace("_", " ").title()),
            "body": payload.get("body", approval["reason"]),
            "audience": approval["audience"],
            "geometry": approval.get("geometry"),
            "caution_only": False,
            "official": True,
            "evidence_version": approval["evidence_version"],
            "model_version": approval["model_version"],
            "created_at": approval["requested_at"],
            "approved_at": approval["decided_at"],
            "dispatched_at": iso_utc(now) if dispatched else None,
            "expires_at": approval["expires_at"],
            "gateway": self.alert_sink,
            "is_demo": self.is_demo,
            "version": 1,
        }

    def alerts(self, incident_id: str) -> list[dict[str, Any]]:
        return self._for_incident(self.database.list("alert"), incident_id)

    def advance_demo(self, request: DemoAdvanceInput, principal: Principal) -> dict[str, Any]:
        if not self.is_demo:
            raise PermissionDeniedError("Demo replay controls are disabled outside demo mode")
        previous = self.scenario_clock
        current = previous + timedelta(minutes=request.minutes)
        incident_id = self.incident_id
        incident = self.incident(incident_id)
        incident_version = int(incident.get("version", 1)) + 1
        updated_incident = {
            **incident,
            "scenario_time": iso_utc(current),
            "updated_at": iso_utc(current),
            "version": incident_version,
        }
        scenario_version = int(self.database.get_state("scenario_version", 1)) + 1
        self.database.commit(
            changes=[
                EntityChange(
                    "incident",
                    incident_id,
                    updated_incident,
                    incident_version,
                    int(incident.get("version", 1)),
                )
            ],
            state={
                "scenario_clock": iso_utc(current),
                "scenario_version": scenario_version,
                "timeline_offset_seconds": int(
                    self.database.get_state("timeline_offset_seconds", 0)
                )
                + request.minutes * 60,
            },
            events=[
                EventInput(
                    event_type="demo.clock_advanced",
                    aggregate_kind="scenario",
                    aggregate_id=str(self.database.get_state("scenario_id", "demo")),
                    aggregate_version=scenario_version,
                    actor_id=principal.user_id,
                    actor_role=principal.role,
                    payload={"previous_time": iso_utc(previous), "scenario_time": iso_utc(current)},
                    incident_id=incident_id,
                )
            ],
        )
        injected: list[str] = []
        fixtures = {item["id"]: item for item in self.database.get_state("fixture_reports", [])}
        for fixture_id in request.inject_report_ids:
            fixture = fixtures.get(fixture_id)
            if not fixture:
                raise NotFoundError("fixture report", fixture_id)
            data = {
                "client_report_id": fixture["client_report_id"],
                "incident_id": incident_id,
                "reporter_id": fixture["reporter_id"],
                "device_id": fixture["device_id"],
                "observed_at": fixture["observed_at"],
                "location": fixture["location"],
                "water_depth": fixture["water_depth"],
                "road_status": fixture["road_status"],
                "flood_status": (
                    "NOT_FLOODED"
                    if fixture.get("claim") == "ROAD_OPEN_SHALLOW_WATER"
                    else "FLOODED"
                ),
            }
            self.create_report(
                ReportInput.model_validate(data),
                idempotency_key=f"demo-fixture:{fixture_id}",
                principal=Principal(
                    f"demo-fixture:{fixture['reporter_id']}",
                    "responder" if fixture.get("trusted", False) else "reporter",
                    True,
                ),
            )
            injected.append(fixture_id)
        simulation_id = None
        if request.run_simulation:
            simulation = self.run_simulation(
                incident_id,
                trigger="demo clock advanced",
                principal=Principal("demo-simulation-engine", "engineer", True),
            )
            simulation_id = simulation["id"]
        outbox = self.database.outbox_events(after_sequence=0, limit=1_000)
        return {
            "incident_id": incident_id,
            "previous_time": iso_utc(previous),
            "scenario_time": iso_utc(current),
            "injected_report_ids": injected,
            "triggered_simulation_id": simulation_id,
            "emitted_event_ids": [event["id"] for event in outbox[-20:]],
            "message": "DEMO DATA replay advanced without contacting live providers.",
        }

    def bootstrap(self, incident_id: str) -> dict[str, Any]:
        incident = self.incident(incident_id)
        simulations = self.simulations(incident_id)
        impacts = self.impacts(incident_id)
        layers = (
            [
                {
                    "id": "rapid-impact-p50",
                    "incident_id": incident_id,
                    "name": "Rapid impact estimate — p50",
                    "kind": "MODELLED_FLOOD",
                    "representation": "PACKAGED_PGM",
                    "artifact_id": "depth-p50-now",
                    "delivery_service": "RESTRICTED_RASTER_TILE_SERVICE",
                    "model_version": self._active_model_version(),
                    "is_simulated": True,
                },
                {
                    "id": "community-corroboration",
                    "incident_id": incident_id,
                    "name": "Community-corroborated reports — not official confirmation",
                    "kind": "COMMUNITY_REPORTS",
                    "representation": "GEOJSON",
                    "is_simulated": True,
                },
            ]
            if self.is_demo
            else []
        )
        route_recommendation = (
            self.recommend_routes(
                incident_id,
                origin_node="aluva",
                max_alternatives=3,
                principal=Principal("bootstrap-routing-engine", "system", True),
            )
            if self.is_demo
            else None
        )
        return {
            "server_time": iso_utc(datetime.now(UTC)),
            "scenario_clock": iso_utc(self.scenario_clock),
            "demo_mode": self.is_demo,
            "data_label": "DEMO DATA" if self.is_demo else "LIVE",
            "incident": incident,
            "sources": self.sources(),
            "layers": layers,
            "signals": self.signals(incident_id),
            "reports": self.reports(incident_id),
            "simulation": simulations[-1] if simulations else None,
            "active_simulation": simulations[-1] if simulations else None,
            "impacts": impacts[-1] if impacts else None,
            "latest_impact": impacts[-1] if impacts else None,
            "routes": (
                route_recommendation["alternatives"]
                if route_recommendation is not None
                else self.routes(incident_id)
            ),
            "route_recommendation": route_recommendation,
            "shelters": self.shelters(incident_id),
            "alerts": self.alerts(incident_id),
            "approvals": self.approvals(incident_id),
            "resilience": self.resilience(incident_id),
        }


__all__ = [
    "CORROBORATION_MESSAGE",
    "EXPIRY_MESSAGE",
    "FloodRiseService",
    "confidence_breakdown",
    "evidence_families",
    "haversine_m",
    "iso_utc",
    "parse_utc",
]
