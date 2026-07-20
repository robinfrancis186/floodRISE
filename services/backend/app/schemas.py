"""Pydantic v2 contracts for the versioned floodRISE HTTP and SSE APIs."""

from __future__ import annotations

from datetime import UTC, datetime
from enum import StrEnum
from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BaseModel, ConfigDict, Field, model_validator


def utc_now() -> datetime:
    """Return an aware UTC timestamp; injectable clocks should be used in domain logic."""
    return datetime.now(UTC)


def _require_utc(value: datetime) -> datetime:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError("datetime must include a UTC offset")
    return value.astimezone(UTC)


UtcDateTime = Annotated[datetime, AfterValidator(_require_utc)]
Confidence = Annotated[float, Field(ge=0, le=0.99)]
Longitude = Annotated[float, Field(ge=-180, le=180)]
Latitude = Annotated[float, Field(ge=-90, le=90)]


class APIModel(BaseModel):
    """Strict base class shared by public request and response contracts."""

    model_config = ConfigDict(
        extra="forbid",
        populate_by_name=True,
        str_strip_whitespace=True,
        use_enum_values=False,
    )


class UserRole(StrEnum):
    REPORTER = "REPORTER"
    RESPONDER = "RESPONDER"
    VERIFIER = "VERIFIER"
    ENGINEER = "ENGINEER"
    SHELTER_MANAGER = "SHELTER_MANAGER"
    INCIDENT_COMMANDER = "INCIDENT_COMMANDER"
    AUDITOR = "AUDITOR"
    IDENTITY_ADMINISTRATOR = "IDENTITY_ADMINISTRATOR"


class IncidentStatus(StrEnum):
    DRAFT = "DRAFT"
    ACTIVE = "ACTIVE"
    STANDBY = "STANDBY"
    CLOSED = "CLOSED"


class SourceStatus(StrEnum):
    HEALTHY = "HEALTHY"
    STALE = "STALE"
    DEGRADED = "DEGRADED"
    UNAVAILABLE = "UNAVAILABLE"
    UNKNOWN = "UNKNOWN"


class ReportDisposition(StrEnum):
    RECEIVED = "RECEIVED"
    ELIGIBLE = "ELIGIBLE"
    DUPLICATE = "DUPLICATE"
    LATE = "LATE"
    INVALID = "INVALID"
    HISTORICAL = "HISTORICAL"
    NEEDS_REVIEW = "NEEDS_REVIEW"
    REJECTED = "REJECTED"


class MediaUploadStatus(StrEnum):
    AWAITING_UPLOAD = "AWAITING_UPLOAD"
    QUARANTINED_PENDING_SCAN = "QUARANTINED_PENDING_SCAN"
    QUARANTINED_SCANNER_UNAVAILABLE = "QUARANTINED_SCANNER_UNAVAILABLE"
    READY_PRIVATE = "READY_PRIVATE"
    DUPLICATE_PRIVATE = "DUPLICATE_PRIVATE"
    REJECTED = "REJECTED"
    EXPIRED = "EXPIRED"


class MediaScannerStatus(StrEnum):
    NOT_RUN = "NOT_RUN"
    DEMO_CLEAN = "DEMO_CLEAN"
    CLEAN = "CLEAN"
    MALICIOUS = "MALICIOUS"
    UNAVAILABLE = "UNAVAILABLE"


class WaterDepth(StrEnum):
    ANKLE = "ANKLE"
    KNEE = "KNEE"
    WAIST = "WAIST"
    ABOVE_WAIST = "ABOVE_WAIST"


class RoadStatus(StrEnum):
    OPEN = "OPEN"
    DIFFICULT = "DIFFICULT"
    IMPASSABLE = "IMPASSABLE"
    UNKNOWN = "UNKNOWN"


class SignalState(StrEnum):
    CANDIDATE = "CANDIDATE"
    CORROBORATING = "CORROBORATING"
    COMMUNITY_CORROBORATED = "COMMUNITY_CORROBORATED"
    NEEDS_REVIEW = "NEEDS_REVIEW"
    DISPUTED = "DISPUTED"
    STALE = "STALE"
    EXPIRED = "EXPIRED"
    RESOLVED = "RESOLVED"


class SimulationStatus(StrEnum):
    QUEUED = "QUEUED"
    RUNNING = "RUNNING"
    PUBLISHED = "PUBLISHED"
    FAILED = "FAILED"
    SUPERSEDED = "SUPERSEDED"


class RiskLevel(StrEnum):
    LOWER = "LOWER"
    ELEVATED = "ELEVATED"


class ShelterAvailability(StrEnum):
    OPEN = "OPEN"
    LIMITED = "LIMITED"
    FULL = "FULL"
    CLOSED = "CLOSED"
    UNKNOWN = "UNKNOWN"


class ApprovalStatus(StrEnum):
    PENDING = "PENDING"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    EXPIRED = "EXPIRED"
    CANCELLED = "CANCELLED"


class ApprovalDecisionType(StrEnum):
    APPROVE = "APPROVE"
    MODIFY = "MODIFY"
    REJECT = "REJECT"


class ActionType(StrEnum):
    AREA_CAUTION = "AREA_CAUTION"
    ROAD_CLOSURE = "ROAD_CLOSURE"
    SHELTER_CLOSURE = "SHELTER_CLOSURE"
    EVACUATION_GUIDANCE = "EVACUATION_GUIDANCE"
    EVACUATION_INSTRUCTION = "EVACUATION_INSTRUCTION"
    OFFICIAL_WARNING = "OFFICIAL_WARNING"
    ALL_CLEAR = "ALL_CLEAR"


class AlertStatus(StrEnum):
    DRAFT = "DRAFT"
    AWAITING_APPROVAL = "AWAITING_APPROVAL"
    APPROVED = "APPROVED"
    DISPATCHING = "DISPATCHING"
    DISPATCHED = "DISPATCHED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


class DeliveryStatus(StrEnum):
    PENDING = "PENDING"
    ACCEPTED = "ACCEPTED"
    DELIVERED = "DELIVERED"
    FAILED = "FAILED"
    SUPPRESSED = "SUPPRESSED"


class DatasetKind(StrEnum):
    WEATHER = "WEATHER"
    RAINFALL = "RAINFALL"
    RIVER_GAUGE = "RIVER_GAUGE"
    SATELLITE_FLOOD = "SATELLITE_FLOOD"
    TERRAIN = "TERRAIN"
    DRAINAGE = "DRAINAGE"
    ROADS = "ROADS"
    SHELTERS = "SHELTERS"
    POPULATION = "POPULATION"
    CRITICAL_INFRASTRUCTURE = "CRITICAL_INFRASTRUCTURE"
    COMMUNITY_REPORTS = "COMMUNITY_REPORTS"
    MODELLED_FLOOD = "MODELLED_FLOOD"


class AuditActorType(StrEnum):
    USER = "USER"
    SYSTEM = "SYSTEM"
    ADAPTER = "ADAPTER"
    WORKER = "WORKER"


class ReportLocation(APIModel):
    latitude: Latitude
    longitude: Longitude
    accuracy_m: float = Field(ge=0, le=100)


class PublicReportLocation(APIModel):
    """Privacy-generalized location; intentionally less precise than report evidence."""

    latitude: Latitude
    longitude: Longitude
    accuracy_m: float = Field(ge=200)


class PointGeometry(APIModel):
    type: Literal["Point"] = "Point"
    coordinates: tuple[Longitude, Latitude]


class LineStringGeometry(APIModel):
    type: Literal["LineString"] = "LineString"
    coordinates: list[tuple[Longitude, Latitude]] = Field(min_length=2)


class PolygonGeometry(APIModel):
    type: Literal["Polygon"] = "Polygon"
    coordinates: list[list[tuple[Longitude, Latitude]]] = Field(min_length=1)

    @model_validator(mode="after")
    def rings_are_closed(self) -> PolygonGeometry:
        if any(len(ring) < 4 or ring[0] != ring[-1] for ring in self.coordinates):
            raise ValueError(
                "GeoJSON polygon rings must be closed and contain at least four positions"
            )
        return self


GeoGeometry = PointGeometry | LineStringGeometry | PolygonGeometry


class PageInfo(APIModel):
    next_cursor: str | None = None
    has_more: bool = False


class ProblemFieldError(APIModel):
    pointer: str
    message: str
    code: str | None = None


class ProblemDetails(BaseModel):
    """RFC 9457 problem detail with optional floodRISE extension members."""

    model_config = ConfigDict(extra="allow", populate_by_name=True)

    type: str = "about:blank"
    title: str
    status: int = Field(ge=400, le=599)
    detail: str | None = None
    instance: str | None = None
    code: str | None = None
    trace_id: str | None = None
    errors: list[ProblemFieldError] = Field(default_factory=list)


class OperationalIncident(APIModel):
    id: str
    name: str
    status: IncidentStatus
    disaster_type: Literal["FLOOD"] = "FLOOD"
    area_name: str
    area: PolygonGeometry | None = None
    started_at: UtcDateTime
    expected_end_at: UtcDateTime | None = None
    scenario_time: UtcDateTime
    timezone: str = "Asia/Kolkata"
    is_demo: bool = True
    data_label: str = "DEMO DATA"
    version: int = Field(default=1, ge=1)


class LayerDescriptor(APIModel):
    id: str
    incident_id: str
    name: str
    kind: DatasetKind
    representation: Literal["GEOJSON", "MVT", "PMTILES", "COG", "PACKAGED_PGM"]
    artifact_id: str | None = None
    delivery_service: Literal["RESTRICTED_RASTER_TILE_SERVICE"] | None = None
    url: str | None = None
    observed_at: UtcDateTime | None = None
    valid_until: UtcDateTime | None = None
    confidence: Confidence | None = None
    model_version: str | None = None
    evidence_version: str | None = None
    is_simulated: bool = False
    visible_by_default: bool = False


class SourceHealth(APIModel):
    id: str
    provider: str
    status: SourceStatus
    observed_at: UtcDateTime
    cadence: str
    is_simulated: bool
    last_ingested_at: UtcDateTime | None = None
    valid_until: UtcDateTime | None = None
    confidence: Confidence | None = None
    message: str | None = None


class DatasetVersion(APIModel):
    id: str
    incident_id: str | None = None
    kind: DatasetKind
    provider: str
    source_id: str
    source_url: str | None = None
    observed_at: UtcDateTime | None = None
    acquired_at: UtcDateTime | None = None
    issued_at: UtcDateTime | None = None
    ingested_at: UtcDateTime
    valid_from: UtcDateTime | None = None
    valid_until: UtcDateTime | None = None
    coverage: PolygonGeometry | None = None
    confidence: Confidence
    quality_flags: list[str] = Field(default_factory=list)
    licence: str
    attribution: str
    checksum: str
    version: str
    raw_reference: str | None = None
    is_simulated: bool = False


class FloodReportCreate(APIModel):
    client_report_id: str = Field(min_length=8, max_length=128)
    incident_id: str
    reporter_id: str
    device_id: str
    observed_at: UtcDateTime
    location: ReportLocation
    water_depth: WaterDepth
    road_status: RoadStatus
    infrastructure_issues: list[str] = Field(default_factory=list, max_length=20)
    note: str | None = Field(default=None, max_length=250)
    flood_status: Literal["FLOODED", "NOT_FLOODED"] = "FLOODED"
    media_upload_ids: list[str] = Field(default_factory=list, max_length=5)
    schema_version: int = Field(default=1, ge=1)


class FloodReport(FloodReportCreate):
    id: str
    received_at: UtcDateTime
    disposition: ReportDisposition
    disposition_reasons: list[str] = Field(default_factory=list)
    eligible_for_live_signal: bool = False
    evidence_family_id: str | None = None
    quality_score: Annotated[float, Field(ge=0, le=1)] = 0
    trusted: bool = False
    authenticated: bool = False
    media_hash: str | None = Field(default=None, min_length=16, max_length=128)
    public_location: PublicReportLocation | None = None
    cluster_id: str | None = None
    signal_id: str | None = None
    idempotency_key_digest: str | None = None
    is_simulated: bool = False
    version: int = Field(default=1, ge=1)


class ReportReceipt(APIModel):
    report_id: str
    client_report_id: str
    disposition: ReportDisposition
    accepted_at: UtcDateTime
    duplicate: bool = False
    live_signal_eligible: bool = False
    cluster_id: str | None = None
    sync_message: str


class MediaUploadRequest(APIModel):
    incident_id: str
    filename: str = Field(min_length=1, max_length=128)
    content_type: Literal["image/jpeg", "image/png", "image/webp"]
    size_bytes: int = Field(gt=0, le=10_000_000)
    sha256: str = Field(pattern=r"^[a-fA-F0-9]{64}$")


class MediaUploadMetadata(APIModel):
    upload_id: str
    incident_id: str
    filename: str
    declared_content_type: Literal["image/jpeg", "image/png", "image/webp"]
    declared_size_bytes: int = Field(gt=0, le=10_000_000)
    declared_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    actual_size_bytes: int | None = Field(default=None, gt=0, le=10_000_000)
    actual_sha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    normalized_content_type: Literal["image/jpeg", "image/png", "image/webp"] | None = None
    normalized_size_bytes: int | None = Field(default=None, gt=0, le=10_000_000)
    normalized_sha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    width: int | None = Field(default=None, gt=0)
    height: int | None = Field(default=None, gt=0)
    status: MediaUploadStatus
    scanner_status: MediaScannerStatus
    failure_code: str | None = None
    visibility: Literal["PRIVATE"] = "PRIVATE"
    public_url: None = None
    download_url: None = None
    created_at: UtcDateTime
    updated_at: UtcDateTime
    expires_at: UtcDateTime
    quarantine_delete_after: UtcDateTime
    evidence_delete_after: UtcDateTime
    identity_link_delete_after: UtcDateTime
    retention_status: str
    is_simulated: bool = False
    version: int = Field(ge=1)


class MediaUploadGrant(MediaUploadMetadata):
    upload_url: str
    completion_url: str
    required_headers: dict[str, str] = Field(default_factory=dict)


class EvidenceSummary(APIModel):
    report_id: str
    observed_at: UtcDateTime
    water_depth: WaterDepth
    road_status: RoadStatus
    trusted: bool
    authenticated: bool
    quality_score: Annotated[float, Field(ge=0, le=1)]


class EvidenceCluster(APIModel):
    id: str
    incident_id: str
    medoid: PointGeometry
    radius_m: float = Field(ge=0, le=250)
    diameter_m: float = Field(ge=0, le=500)
    window_started_at: UtcDateTime
    window_ended_at: UtcDateTime
    report_count: int = Field(ge=0)
    independent_family_count: int = Field(ge=0)
    authenticated_family_count: int = Field(ge=0)
    conflict_count: int = Field(ge=0)
    fraud_risk: Annotated[float, Field(ge=0, le=1)] = 0
    mean_quality: Annotated[float, Field(ge=0, le=1)] = 0
    evidence: list[EvidenceSummary] = Field(default_factory=list)
    version: int = Field(default=1, ge=1)


class ConfidenceBreakdown(APIModel):
    """Versioned score explanation supporting compact and full engine output."""

    model_config = ConfigDict(extra="allow", populate_by_name=True)

    score: Confidence
    total: Confidence | None = None
    raw_score: float | None = None
    formula_version: str | None = None
    formula: str | None = None
    base: float | None = None
    independence: float | None = None
    independent_support: float | None = None
    mean_quality: float | None = None
    additional_reports: float | None = None
    additional_support: float | None = None
    external_corroboration: float | None = None
    conflict_penalty: float | None = None
    fraud_penalty: float | None = None
    inputs: dict[str, float | int] = Field(default_factory=dict)
    terms: dict[str, float] = Field(default_factory=dict)


class FloodSignal(APIModel):
    id: str
    incident_id: str
    cluster_id: str
    state: SignalState
    location: PointGeometry
    area: PolygonGeometry | None = None
    radius_m: float | None = Field(default=None, ge=0, le=250)
    diameter_m: float | None = Field(default=None, ge=0, le=500)
    confidence: Confidence
    confidence_breakdown: ConfidenceBreakdown
    independent_report_count: int = Field(ge=0)
    authenticated_report_count: int = Field(ge=0)
    report_count: int = Field(default=0, ge=0)
    first_observed_at: UtcDateTime
    last_observed_at: UtcDateTime
    stale_at: UtcDateTime
    expires_at: UtcDateTime
    display_message: str
    evidence_version: str
    contradiction_present: bool = False
    route_recalculation_requested: bool = False
    human_review: dict[str, Any] | None = None
    freshness: Literal["FRESH", "AGING", "STALE", "EXPIRED"] | None = None
    is_simulated: bool = False
    version: int = Field(default=1, ge=1)


class FloodSignalDecision(APIModel):
    decision: Literal[
        "UNREVIEWED",
        "VERIFIED",
        "FIELD_CHECK",
        "REJECTED",
        "VERIFY",
        "MODIFY",
        "DISPUTE",
        "RESOLVE",
        "REJECT",
    ]
    expected_version: int = Field(ge=1)
    reason: str = Field(min_length=3, max_length=500)
    replacement_state: SignalState | None = None
    replacement_location: PointGeometry | None = None


class FloodSignalPage(APIModel):
    items: list[FloodSignal]
    page: PageInfo


class SimulationRun(APIModel):
    id: str
    incident_id: str
    model_version: str
    status: SimulationStatus
    trigger: str
    scenario_time: UtcDateTime
    queued_at: UtcDateTime
    started_at: UtcDateTime | None = None
    completed_at: UtcDateTime | None = None
    ensemble_members: int = Field(default=9, ge=1)
    internal_timestep_minutes: int = Field(default=5, ge=1)
    horizons_minutes: list[int] = Field(default_factory=lambda: [0, 30, 60, 180])
    quantiles: list[Literal["p10", "p50", "p90"]] = Field(
        default_factory=lambda: ["p10", "p50", "p90"]
    )
    input_dataset_versions: list[str] = Field(default_factory=list)
    evidence_version: str
    output_manifest_url: str | None = None
    error: str | None = None
    is_simulated: bool = True


class ImpactSummary(APIModel):
    affected_population: int = Field(ge=0)
    affected_communities: int = Field(ge=0)
    risky_road_segments: int = Field(ge=0)
    unreachable_shelters: int = Field(ge=0)
    critical_assets_at_risk: int = Field(ge=0)
    estimated_flooded_area_km2: float = Field(ge=0)


class ImpactVersion(APIModel):
    id: str
    incident_id: str
    model_version: str
    evidence_version: str
    generated_at: UtcDateTime
    valid_until: UtcDateTime
    horizon_minutes: int = Field(ge=0)
    quantile: Literal["p10", "p50", "p90"]
    scenario_agreement: Annotated[float, Field(ge=0, le=1)]
    summary: ImpactSummary
    depth_layer: LayerDescriptor
    limitations: list[str] = Field(default_factory=list)
    label: str = "Rapid impact estimate"


class ShelterStatus(APIModel):
    id: str
    incident_id: str
    name: str
    location: PointGeometry
    availability: ShelterAvailability
    capacity: int | None = Field(default=None, ge=0)
    occupancy: int | None = Field(default=None, ge=0)
    access_status: RoadStatus = RoadStatus.UNKNOWN
    accessible: bool | None = None
    facilities: list[str] = Field(default_factory=list)
    contact_public: str | None = None
    status_reason: str | None = None
    observed_at: UtcDateTime
    valid_until: UtcDateTime | None = None
    source: str
    version: int = Field(default=1, ge=1)

    @model_validator(mode="after")
    def occupancy_does_not_exceed_known_capacity(self) -> ShelterStatus:
        if (
            self.capacity is not None
            and self.occupancy is not None
            and self.occupancy > self.capacity
        ):
            raise ValueError("occupancy cannot exceed capacity")
        return self


class ShelterStatusUpdate(APIModel):
    availability: ShelterAvailability
    occupancy: int | None = Field(default=None, ge=0)
    access_status: RoadStatus
    status_reason: str = Field(min_length=3, max_length=500)
    observed_at: UtcDateTime
    expected_version: int = Field(ge=1)


class RouteRequest(APIModel):
    incident_id: str
    origin: ReportLocation | None = None
    origin_node: str | None = None
    destination_shelter_id: str | None = None
    max_alternatives: int = Field(default=3, ge=1, le=3)
    accessibility_needs: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def origin_is_available(self) -> RouteRequest:
        if self.origin is None and not self.origin_node:
            raise ValueError("origin or origin_node is required")
        return self


class RouteAlternative(APIModel):
    id: str
    label: str
    duration_min: float = Field(gt=0)
    distance_km: float = Field(gt=0)
    shelter: str
    shelter_id: str | None = None
    risk: RiskLevel
    reasons: list[str] = Field(default_factory=list)
    geometry: LineStringGeometry | None = None
    model_version: str
    evidence_version: str
    valid_until: UtcDateTime
    excluded_edge_count: int = Field(default=0, ge=0)


class RouteRecommendation(RouteAlternative):
    """Compatibility shape exported by ``@floodrise/contracts``."""


class RouteRecommendationResponse(APIModel):
    incident_id: str
    generated_at: UtcDateTime
    alternatives: list[RouteRecommendation] = Field(default_factory=list, max_length=3)
    no_route_reason: str | None = None
    staging_point: PointGeometry | None = None
    model_version: str
    evidence_version: str
    valid_until: UtcDateTime
    disclaimer: str = "Lower-risk route estimate; conditions may change. Follow responder guidance."

    @model_validator(mode="after")
    def route_or_reason_is_present(self) -> RouteRecommendationResponse:
        if not self.alternatives and not self.no_route_reason:
            raise ValueError("a route response needs at least one alternative or a no-route reason")
        return self


class ResilienceFinding(APIModel):
    id: str
    category: Literal[
        "DRAINAGE",
        "ROAD_BOTTLENECK",
        "SHELTER_ACCESS",
        "LOW_LYING_AREA",
        "SENSOR_COVERAGE",
        "CRITICAL_INFRASTRUCTURE",
    ]
    title: str
    area: PointGeometry | PolygonGeometry
    severity: Literal["LOW", "MEDIUM", "HIGH", "CRITICAL"]
    recurrence_count: int = Field(ge=0)
    closure_hours: float = Field(ge=0)
    exposed_population: int = Field(ge=0)
    evidence_coverage: Annotated[float, Field(ge=0, le=1)]
    evidence_version: str


class ResilienceRecommendation(APIModel):
    id: str
    finding_id: str
    verb: Literal["INSPECT", "ASSESS", "EVALUATE", "CONSIDER"]
    recommendation: str
    expected_benefit: str
    priority: Literal["LOW", "MEDIUM", "HIGH"]
    what_if_summary: str | None = None
    disclaimer: str = "Modelled planning scenario; not an engineering design."


class ResilienceAudit(APIModel):
    id: str
    incident_id: str | None = None
    area_name: str
    generated_at: UtcDateTime
    period_started_at: UtcDateTime
    period_ended_at: UtcDateTime
    dataset_versions: list[str]
    findings: list[ResilienceFinding]
    recommendations: list[ResilienceRecommendation]
    version: int = Field(default=1, ge=1)
    is_simulated: bool = True


class ActionRecommendation(APIModel):
    id: str
    incident_id: str
    action_type: ActionType
    title: str
    rationale: str
    audience: str
    geometry: GeoGeometry | None = None
    evidence_version: str
    model_version: str
    generated_at: UtcDateTime
    expires_at: UtcDateTime
    confidence: Confidence
    requires_two_person_approval: bool = True


class ApprovalRequestCreate(APIModel):
    incident_id: str
    action_type: ActionType
    action_payload: dict[str, Any]
    audience: str
    geometry: GeoGeometry | None = None
    evidence_version: str
    model_version: str
    reason: str = Field(min_length=3, max_length=1_000)


class ApprovalRequest(ApprovalRequestCreate):
    id: str
    status: ApprovalStatus
    requested_by: str
    requested_at: UtcDateTime
    expires_at: UtcDateTime
    decided_by: str | None = None
    decided_at: UtcDateTime | None = None
    decision_reason: str | None = None
    version: int = Field(default=1, ge=1)


class ApprovalDecision(APIModel):
    decision: ApprovalDecisionType
    reason: str = Field(min_length=3, max_length=1_000)
    expected_version: int = Field(ge=1)


class Alert(APIModel):
    id: str
    incident_id: str
    approval_request_id: str | None = None
    status: AlertStatus
    title: str
    body: str
    audience: str
    geometry: GeoGeometry | None = None
    caution_only: bool = False
    official: bool = False
    evidence_version: str
    model_version: str | None = None
    created_at: UtcDateTime
    approved_at: UtcDateTime | None = None
    dispatched_at: UtcDateTime | None = None
    expires_at: UtcDateTime
    is_demo: bool = True
    version: int = Field(default=1, ge=1)


class DeliveryAttempt(APIModel):
    id: str
    alert_id: str
    channel: Literal["PUSH", "SMS", "EMAIL", "WEBHOOK", "DEMO_SINK"]
    provider: str
    status: DeliveryStatus
    attempted_at: UtcDateTime
    acknowledged_at: UtcDateTime | None = None
    provider_reference: str | None = None
    failure_code: str | None = None
    failure_detail: str | None = None
    attempt_number: int = Field(ge=1)


class AuditEvent(APIModel):
    id: str
    sequence: int = Field(ge=1)
    incident_id: str | None = None
    occurred_at: UtcDateTime
    actor_type: AuditActorType
    actor_id: str
    action: str
    resource_type: str
    resource_id: str
    resource_version: int | str | None = None
    summary: str
    metadata: dict[str, Any] = Field(default_factory=dict)
    previous_hash: str | None = None
    event_hash: str
    supersedes_event_id: str | None = None


class AuditEventPage(APIModel):
    items: list[AuditEvent]
    page: PageInfo


class AuditExport(APIModel):
    incident_id: str
    generated_at: UtcDateTime
    first_sequence: int = Field(ge=1)
    last_sequence: int = Field(ge=1)
    event_count: int = Field(ge=0)
    sha256: str
    download_url: str
    expires_at: UtcDateTime


class EventInvalidation(APIModel):
    event_id: str
    event_type: str
    incident_id: str | None = None
    resource_type: str
    resource_id: str
    version: int | str
    occurred_at: UtcDateTime


class IncidentBootstrapResponse(APIModel):
    server_time: UtcDateTime
    incident: OperationalIncident
    sources: list[SourceHealth]
    layers: list[LayerDescriptor]
    signals: list[FloodSignal]
    shelters: list[ShelterStatus]
    active_simulation: SimulationRun | None = None
    latest_impact: ImpactVersion | None = None
    demo_mode: bool
    data_label: str


class DemoAdvanceRequest(APIModel):
    minutes: int = Field(default=10, ge=1, le=180)
    inject_report_ids: list[str] = Field(default_factory=list)
    run_simulation: bool = True


class DemoAdvanceResponse(APIModel):
    incident_id: str
    previous_time: UtcDateTime
    scenario_time: UtcDateTime
    injected_report_ids: list[str]
    triggered_simulation_id: str | None = None
    emitted_event_ids: list[str] = Field(default_factory=list)
    message: str


class DemoResetResponse(APIModel):
    incident_id: str
    scenario_time: UtcDateTime
    reset_at: UtcDateTime
    data_label: str = "DEMO DATA"
    message: str


# Short aliases make route modules readable while retaining descriptive OpenAPI names.
ReportCreate = FloodReportCreate
ReportResponse = FloodReport
SignalDecisionRequest = FloodSignalDecision
RouteResponse = RouteRecommendationResponse
ApprovalCreate = ApprovalRequestCreate
ReportInput = FloodReportCreate
ReportRecord = FloodReport
SignalRecord = FloodSignal
SignalDecisionInput = FloodSignalDecision
ApprovalCreateInput = ApprovalRequestCreate
ApprovalDecisionInput = ApprovalDecision
DemoAdvanceInput = DemoAdvanceRequest


__all__ = [
    "APIModel",
    "ActionRecommendation",
    "ActionType",
    "Alert",
    "AlertStatus",
    "ApprovalCreate",
    "ApprovalCreateInput",
    "ApprovalDecision",
    "ApprovalDecisionInput",
    "ApprovalDecisionType",
    "ApprovalRequest",
    "ApprovalRequestCreate",
    "ApprovalStatus",
    "AuditActorType",
    "AuditEvent",
    "AuditEventPage",
    "AuditExport",
    "Confidence",
    "ConfidenceBreakdown",
    "DatasetKind",
    "DatasetVersion",
    "DeliveryAttempt",
    "DeliveryStatus",
    "DemoAdvanceRequest",
    "DemoAdvanceInput",
    "DemoAdvanceResponse",
    "DemoResetResponse",
    "EventInvalidation",
    "EvidenceCluster",
    "EvidenceSummary",
    "FloodReport",
    "FloodReportCreate",
    "FloodSignal",
    "FloodSignalDecision",
    "FloodSignalPage",
    "GeoGeometry",
    "ImpactSummary",
    "ImpactVersion",
    "IncidentBootstrapResponse",
    "IncidentStatus",
    "Latitude",
    "LayerDescriptor",
    "LineStringGeometry",
    "Longitude",
    "MediaUploadGrant",
    "MediaUploadRequest",
    "OperationalIncident",
    "PageInfo",
    "PointGeometry",
    "PolygonGeometry",
    "ProblemDetails",
    "ProblemFieldError",
    "PublicReportLocation",
    "ReportCreate",
    "ReportInput",
    "ReportDisposition",
    "ReportLocation",
    "ReportReceipt",
    "ReportResponse",
    "ReportRecord",
    "ResilienceAudit",
    "ResilienceFinding",
    "ResilienceRecommendation",
    "RiskLevel",
    "RoadStatus",
    "RouteAlternative",
    "RouteRecommendation",
    "RouteRecommendationResponse",
    "RouteRequest",
    "RouteResponse",
    "ShelterAvailability",
    "ShelterStatus",
    "ShelterStatusUpdate",
    "SignalDecisionRequest",
    "SignalDecisionInput",
    "SignalRecord",
    "SignalState",
    "SimulationRun",
    "SimulationStatus",
    "SourceHealth",
    "SourceStatus",
    "UtcDateTime",
    "UserRole",
    "WaterDepth",
    "utc_now",
]
