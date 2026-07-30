"""FastAPI application for the floodRISE competition MVP."""

from __future__ import annotations

import hashlib
import json
from asyncio import Lock, sleep, to_thread
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from time import perf_counter
from typing import Annotated, Any, Literal
from uuid import uuid4

from fastapi import APIRouter, Depends, FastAPI, Header, Query, Request, Response, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.exc import SQLAlchemyError

from .app_check import (
    APP_CHECK_HEADER,
    MUTATING_METHODS,
    FirebaseAppCheckVerifier,
    require_firebase_app_check,
)
from .auth import (
    OIDCVerifier,
    Principal,
    authenticated_principal,
    ensure_high_impact_auth,
    ensure_role,
)
from .config import Settings, get_settings
from .database import Database, canonical_json
from .domain import FloodRiseService, iso_utc
from .errors import (
    AppError,
    NotFoundError,
    app_error_handler,
    install_exception_handlers,
    problem_openapi_response,
)
from .media import MAX_MEDIA_BYTES, DemoCleanScanner, MediaService, UnavailableScanner
from .metrics import FloodRiseMetrics
from .schemas import (
    ApprovalCreateInput,
    ApprovalDecisionInput,
    ApprovalDecisionResponse,
    ApprovalRecord,
    DemoAdvanceInput,
    MediaUploadGrant,
    MediaUploadMetadata,
    MediaUploadRequest,
    ReportInput,
    RouteRequest,
    SignalDecisionInput,
)
from .seed import seed_database

PrincipalDependency = Annotated[Principal, Depends(authenticated_principal)]


class SimulationTriggerInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    incident_id: str
    trigger: str = Field(default="operator requested", min_length=3, max_length=200)


class ShelterUpdateInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_version: int = Field(ge=1)
    activation_status: Literal["OPEN", "LIMITED", "FULL", "UNKNOWN"] | None = None
    access_status: Literal["REACHABLE", "LIMITED", "AT_RISK", "UNKNOWN"] | None = None
    capacity_remaining: int | None = Field(default=None, ge=0)
    status_reason: str = Field(min_length=3, max_length=500)


def _page(items: list[dict[str, Any]]) -> dict[str, Any]:
    return {"items": items, "next_cursor": None, "has_more": False}


def _report_view(report: dict[str, Any], principal: Principal) -> dict[str, Any]:
    """Keep the identity/evidence join private except for identity administrators."""

    if principal.role == "identity_administrator":
        return report
    public = dict(report)
    for field in (
        "reporter_id",
        "account_id",
        "device_id",
        "client_report_id",
        "note",
        "media_hash",
        "media_upload_ids",
        "media_independence_hashes",
        "idempotency_key_digest",
    ):
        public.pop(field, None)
    public["location"] = public.pop("public_location", public.get("location"))
    public["identity_protected"] = True
    return public


def _signal_view(signal: dict[str, Any], principal: Principal) -> dict[str, Any]:
    if principal.role in {
        "responder",
        "verifier",
        "engineer",
        "incident_commander",
        "auditor",
        "identity_administrator",
    }:
        return signal
    public = dict(signal)
    location = dict(public.get("location", {}))
    coordinates = location.get("coordinates")
    if isinstance(coordinates, list) and len(coordinates) == 2:
        location["coordinates"] = [round(float(coordinates[0]), 2), round(float(coordinates[1]), 2)]
        public["location"] = location
        public["radius_m"] = max(200, float(public.get("radius_m", 0)))
        public["location_generalized"] = True
    return public


def _alert_view(alert: dict[str, Any], principal: Principal) -> dict[str, Any]:
    operational_roles = {
        "responder",
        "verifier",
        "engineer",
        "incident_commander",
        "auditor",
    }
    if not principal.granted_roles.isdisjoint(operational_roles):
        return alert
    projected = dict(alert)
    if projected.get("approval_request_id"):
        projected["id"] = (
            "alert-public-" + hashlib.sha256(str(projected.get("id", "")).encode()).hexdigest()[:16]
        )
    projected.pop("approval_request_id", None)
    projected.pop("gateway", None)
    return projected


def _bootstrap_view(payload: dict[str, Any], principal: Principal) -> dict[str, Any]:
    """Project the combined incident view through the same role boundaries as list APIs."""

    projected = dict(payload)
    projected["reports"] = [
        _report_view(report, principal) for report in payload.get("reports", [])
    ]
    projected["signals"] = [
        _signal_view(signal, principal) for signal in payload.get("signals", [])
    ]
    projected["alerts"] = [_alert_view(alert, principal) for alert in payload.get("alerts", [])]
    approval_roles = {
        "responder",
        "verifier",
        "engineer",
        "incident_commander",
        "auditor",
    }
    if principal.granted_roles.isdisjoint(approval_roles):
        projected["approvals"] = []
    return projected


def _database_url_for_sync(url: str) -> str:
    return url.replace("postgresql+asyncpg://", "postgresql+psycopg://").replace(
        "sqlite+aiosqlite://", "sqlite://"
    )


def create_app(
    settings: Settings | None = None,
    *,
    database: Database | None = None,
    media_service: MediaService | None = None,
) -> FastAPI:
    runtime = settings or get_settings()
    target_database = database or Database(_database_url_for_sync(runtime.database_url))
    target_service = FloodRiseService(
        target_database,
        is_demo=runtime.is_demo,
        route_max_snap_distance_m=runtime.route_max_snap_distance_m,
        alert_sink=runtime.demo_alert_sink if runtime.is_demo else None,
    )
    target_metrics = FloodRiseMetrics(is_demo=runtime.is_demo)
    target_media_service = media_service or MediaService(
        target_database,
        # A simulated clean result is permitted only inside the visibly
        # labelled deterministic demo. Any non-demo deployment without both
        # approved external adapters fails before an evidence body is read.
        scanner=DemoCleanScanner() if runtime.is_demo else UnavailableScanner(),
        clock=lambda: target_service.scenario_clock,
    )
    target_media_service.bind_runtime(is_demo=runtime.is_demo)

    @asynccontextmanager
    async def lifespan(application: FastAPI) -> AsyncIterator[None]:
        seed_database(target_database, is_demo=runtime.is_demo)
        application.state.database = target_database
        application.state.service = target_service
        application.state.media_service = target_media_service
        application.state.metrics = target_metrics
        yield

    application = FastAPI(
        title="floodRISE API",
        summary="Human-verified flood intelligence and decision support",
        description=(
            "Versioned Kerala flood-response API. The default profile is deterministic "
            "DEMO DATA and never contacts a production notification destination."
        ),
        version="0.1.0",
        openapi_url=f"{runtime.api_prefix}/openapi.json",
        docs_url="/docs",
        redoc_url="/redoc",
        lifespan=lifespan,
    )
    application.state.settings = runtime
    application.state.oidc_verifier = OIDCVerifier(runtime)
    application.state.firebase_app_check_verifier = FirebaseAppCheckVerifier(runtime)
    application.state.database = target_database
    application.state.service = target_service
    application.state.media_service = target_media_service
    application.state.metrics = target_metrics
    application.state.sse_connection_lock = Lock()
    application.state.sse_connection_count = 0
    application.state.sse_principal_connections = {}
    install_exception_handlers(application)

    @application.middleware("http")
    async def firebase_app_check_boundary(request: Request, call_next: Any) -> Response:
        try:
            await require_firebase_app_check(
                request,
                token=request.headers.get("X-Firebase-AppCheck"),
            )
        except AppError as exc:
            return await app_error_handler(request, exc)
        return await call_next(request)

    @application.middleware("http")
    async def request_context(request: Request, call_next: Any) -> Response:
        request.state.trace_id = request.headers.get("X-Request-ID", str(uuid4()))
        response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.trace_id
        if runtime.is_demo:
            response.headers["X-floodRISE-Data-Label"] = "DEMO DATA"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        return response

    # Starlette makes the most recently registered middleware outermost. CORS
    # must wrap the security boundary so allowed browser origins can read
    # fail-closed App Check responses and preflight never reaches a route.
    application.add_middleware(
        CORSMiddleware,
        allow_origins=runtime.allowed_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=[
            "Authorization",
            "Content-Type",
            "Idempotency-Key",
            "Last-Event-ID",
            "X-Checksum-SHA256",
            "X-Firebase-AppCheck",
            "X-Request-ID",
        ]
        + (["X-Demo-Role", "X-Demo-User"] if runtime.allow_demo_headers else []),
        expose_headers=["X-Request-ID", "X-floodRISE-Data-Label"],
    )

    router = APIRouter(prefix=runtime.api_prefix, responses=problem_openapi_response())

    def service(request: Request) -> FloodRiseService:
        return request.app.state.service

    def media(request: Request) -> MediaService:
        return request.app.state.media_service

    @application.get("/health", tags=["system"])
    @router.get("/health", tags=["system"])
    async def health() -> dict[str, Any]:
        return {
            "status": "ok",
            "service": "floodrise-backend",
            "version": application.version,
            "environment": runtime.environment,
            "demo_mode": runtime.is_demo,
            "data_label": "DEMO DATA" if runtime.is_demo else "LIVE",
            "time": iso_utc(datetime.now(UTC)),
        }

    @application.get("/ready", tags=["system"])
    @router.get("/ready", tags=["system"])
    async def readiness(request: Request) -> dict[str, Any]:
        database_value: Database = request.app.state.database
        try:
            database_ready = await to_thread(database_value.readiness_check)
        except SQLAlchemyError as exc:
            raise AppError(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                title="Service not ready",
                detail="The authoritative database is not available for bounded readiness checks.",
                code="SERVICE_NOT_READY",
                headers={"Retry-After": "5"},
            ) from exc
        if not database_ready:
            raise AppError(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                title="Service not ready",
                detail="The authoritative database schema is not initialized.",
                code="SERVICE_NOT_READY",
                headers={"Retry-After": "5"},
            )
        return {
            "status": "ready",
            "service": "floodrise-backend",
            "environment": runtime.environment,
            "database": "reachable",
            "audit_chain_head": "initialized",
            "time": iso_utc(datetime.now(UTC)),
        }

    @application.get("/metrics", include_in_schema=False)
    async def metrics(
        request: Request,
        principal: PrincipalDependency,
    ) -> Response:
        ensure_role(principal, "auditor", "engineer", "incident_commander")
        database_value: Database = request.app.state.database
        metrics_value: FloodRiseMetrics = request.app.state.metrics
        payload = metrics_value.render(database_value, service(request))
        return Response(
            content=payload,
            headers={"Content-Type": "text/plain; version=0.0.4; charset=utf-8"},
        )

    @router.get("/auth/me", tags=["authentication"])
    async def auth_context(principal: PrincipalDependency) -> dict[str, Any]:
        evidence = principal.authentication_evidence()
        return {
            "user_id": principal.user_id,
            "roles": sorted(principal.granted_roles),
            "authenticated": principal.authenticated,
            "authentication_evidence": evidence,
            "high_impact_approval_eligible": all(
                (
                    principal.mfa_authenticated,
                    principal.phishing_resistant,
                    principal.step_up_authenticated,
                )
            ),
            "high_impact_approval_requirements": {
                "mfa": True,
                "phishing_resistant": True,
                "recent_step_up": True,
                "maximum_auth_age_seconds": runtime.oidc_step_up_max_age_seconds,
            },
        }

    @router.get("/incidents", tags=["incidents"])
    async def list_incidents(request: Request) -> dict[str, Any]:
        return _page(service(request).incidents())

    @router.get("/incidents/bootstrap", tags=["incidents"])
    async def default_bootstrap(
        request: Request,
        principal: PrincipalDependency,
    ) -> dict[str, Any]:
        return _bootstrap_view(
            service(request).bootstrap(service(request).incident_id),
            principal,
        )

    @router.get("/incidents/{incident_id}", tags=["incidents"])
    async def get_incident(incident_id: str, request: Request) -> dict[str, Any]:
        return service(request).incident(incident_id)

    @router.get("/incidents/{incident_id}/bootstrap", tags=["incidents"])
    async def bootstrap(
        incident_id: str,
        request: Request,
        principal: PrincipalDependency,
    ) -> dict[str, Any]:
        return _bootstrap_view(service(request).bootstrap(incident_id), principal)

    @router.get("/sources/status", tags=["sources"])
    @router.get("/layers/source-health", tags=["sources"], include_in_schema=False)
    async def source_status(request: Request) -> dict[str, Any]:
        return {
            "items": service(request).sources(),
            "generated_at": iso_utc(datetime.now(UTC)),
            "next_cursor": None,
        }

    @router.post(
        "/media/uploads",
        status_code=status.HTTP_201_CREATED,
        response_model=MediaUploadGrant,
        tags=["reports"],
    )
    async def create_media_upload(
        body: MediaUploadRequest,
        request: Request,
        principal: PrincipalDependency,
        idempotency_key: Annotated[str, Header(alias="Idempotency-Key")],
    ) -> dict[str, Any]:
        _, metadata = media(request).create_upload(
            body,
            idempotency_key=idempotency_key,
            principal=principal,
        )
        upload_id = metadata["upload_id"]
        return {
            **metadata,
            "upload_url": f"{runtime.api_prefix}/media/uploads/{upload_id}/content",
            "completion_url": f"{runtime.api_prefix}/media/uploads/{upload_id}/complete",
            "required_headers": {
                "Content-Type": body.content_type,
                "X-Checksum-SHA256": body.sha256.lower(),
                "Idempotency-Key": f"{idempotency_key}:content",
            },
        }

    @router.put(
        "/media/uploads/{upload_id}/content",
        status_code=status.HTTP_202_ACCEPTED,
        response_model=MediaUploadMetadata,
        tags=["reports"],
    )
    async def upload_media_content(
        upload_id: str,
        request: Request,
        principal: PrincipalDependency,
        idempotency_key: Annotated[str, Header(alias="Idempotency-Key")],
        checksum: Annotated[str, Header(alias="X-Checksum-SHA256")],
        content_length: Annotated[int | None, Header(alias="Content-Length")] = None,
    ) -> Response:
        media_service = media(request)
        media_service.ensure_body_ingestion_ready()
        content_type = request.headers.get("content-type", "")
        payload = bytearray()
        async for chunk in request.stream():
            payload.extend(chunk)
            if len(payload) > MAX_MEDIA_BYTES:
                raise AppError(
                    status_code=413,
                    title="Evidence image too large",
                    detail="Evidence image uploads are limited to 10 MB.",
                    code="MEDIA_SIZE_LIMIT_EXCEEDED",
                )
        response_status, metadata = media_service.upload_content(
            upload_id,
            bytes(payload),
            content_type=content_type,
            content_length=content_length,
            checksum_header=checksum,
            idempotency_key=idempotency_key,
            principal=principal,
        )
        return JSONResponse(status_code=response_status, content=metadata)

    @router.post(
        "/media/uploads/{upload_id}/complete",
        response_model=MediaUploadMetadata,
        tags=["reports"],
    )
    async def complete_media_upload(
        upload_id: str,
        request: Request,
        principal: PrincipalDependency,
        idempotency_key: Annotated[str, Header(alias="Idempotency-Key")],
    ) -> Response:
        response_status, metadata, headers = media(request).complete_upload(
            upload_id,
            idempotency_key=idempotency_key,
            principal=principal,
        )
        return JSONResponse(status_code=response_status, content=metadata, headers=headers)

    @router.get(
        "/media/uploads/{upload_id}",
        response_model=MediaUploadMetadata,
        tags=["reports"],
    )
    async def get_media_upload(
        upload_id: str,
        request: Request,
        principal: PrincipalDependency,
    ) -> dict[str, Any]:
        return media(request).metadata(upload_id, principal)

    @router.post("/reports", tags=["reports"])
    async def submit_report(
        body: ReportInput,
        request: Request,
        principal: PrincipalDependency,
        idempotency_key: Annotated[str, Header(alias="Idempotency-Key")],
    ) -> Response:
        ensure_role(
            principal,
            "reporter",
            "responder",
            "verifier",
            "engineer",
            "incident_commander",
        )
        started_at = perf_counter()
        response_status, payload = service(request).create_report(
            body,
            idempotency_key=idempotency_key,
            principal=principal,
        )
        elapsed = perf_counter() - started_at
        request.app.state.metrics.report_submit.observe(elapsed)
        if payload.get("corroboration_transitioned") is True:
            request.app.state.metrics.corroboration.observe(elapsed)
        response_payload = dict(payload)
        report = response_payload.get("report")
        if isinstance(report, dict):
            response_payload["report"] = _report_view(report, principal)
        signal = response_payload.get("signal")
        if isinstance(signal, dict):
            response_payload["signal"] = _signal_view(signal, principal)
        return JSONResponse(status_code=response_status, content=response_payload)

    @router.get("/reports", tags=["reports"])
    async def list_reports(
        request: Request,
        principal: PrincipalDependency,
        incident_id: Annotated[str, Query()],
    ) -> dict[str, Any]:
        service(request).incident(incident_id)
        return _page(
            [_report_view(report, principal) for report in service(request).reports(incident_id)]
        )

    @router.get("/reports/{report_id}", tags=["reports"])
    async def get_report(
        report_id: str,
        request: Request,
        principal: PrincipalDependency,
    ) -> dict[str, Any]:
        return _report_view(service(request).report(report_id), principal)

    @router.get("/signals", tags=["floodsignal"])
    async def list_signals(
        request: Request,
        principal: PrincipalDependency,
        incident_id: Annotated[str, Query()],
    ) -> dict[str, Any]:
        service(request).incident(incident_id)
        return _page(
            [_signal_view(signal, principal) for signal in service(request).signals(incident_id)]
        )

    @router.get("/signals/{signal_id}", tags=["floodsignal"])
    async def get_signal(
        signal_id: str,
        request: Request,
        principal: PrincipalDependency,
    ) -> dict[str, Any]:
        return _signal_view(service(request).signal(signal_id), principal)

    @router.post("/signals/{signal_id}/decisions", tags=["floodsignal"])
    async def decide_signal(
        signal_id: str,
        body: SignalDecisionInput,
        request: Request,
        principal: PrincipalDependency,
    ) -> dict[str, Any]:
        ensure_role(principal, "responder", "verifier", "incident_commander")
        return service(request).decide_signal(signal_id, body, principal)

    @router.get("/simulations", tags=["simulation"])
    async def list_simulations(
        request: Request,
        incident_id: Annotated[str, Query()],
    ) -> dict[str, Any]:
        return _page(service(request).simulations(incident_id))

    @router.get("/simulations/{simulation_id}", tags=["simulation"])
    async def get_simulation(simulation_id: str, request: Request) -> dict[str, Any]:
        simulation = request.app.state.database.get("simulation", simulation_id)
        if not simulation:
            raise NotFoundError("simulation", simulation_id)
        return simulation

    @router.post("/simulations", status_code=status.HTTP_201_CREATED, tags=["simulation"])
    @router.post(
        "/simulations/trigger",
        status_code=status.HTTP_201_CREATED,
        tags=["simulation"],
        include_in_schema=False,
    )
    async def trigger_simulation(
        body: SimulationTriggerInput,
        request: Request,
        principal: PrincipalDependency,
    ) -> dict[str, Any]:
        ensure_role(principal, "engineer", "responder", "incident_commander")
        started_at = perf_counter()
        result = service(request).run_simulation(
            body.incident_id,
            trigger=body.trigger,
            principal=principal,
        )
        request.app.state.metrics.simulation.observe(perf_counter() - started_at)
        return result

    @router.get("/impacts", tags=["simulation"])
    async def list_impacts(
        request: Request,
        incident_id: Annotated[str, Query()],
    ) -> dict[str, Any]:
        return _page(service(request).impacts(incident_id))

    @router.get("/routes", tags=["evacuation"])
    async def list_routes(
        request: Request,
        incident_id: Annotated[str, Query()],
    ) -> dict[str, Any]:
        return _page(service(request).routes(incident_id))

    @router.post("/routes/recommend", tags=["evacuation"])
    async def recommend_route(
        body: RouteRequest,
        request: Request,
        principal: PrincipalDependency,
    ) -> dict[str, Any]:
        started_at = perf_counter()
        result = service(request).recommend_routes(
            body.incident_id,
            origin_node=body.origin_node,
            origin_location=(body.origin.model_dump() if body.origin else None),
            max_alternatives=body.max_alternatives,
            principal=principal,
        )
        request.app.state.metrics.route.observe(perf_counter() - started_at)
        return result

    @router.get("/shelters", tags=["shelters"])
    async def list_shelters(
        request: Request,
        incident_id: Annotated[str, Query()],
    ) -> dict[str, Any]:
        return _page(service(request).shelters(incident_id))

    @router.patch("/shelters/{shelter_id}", tags=["shelters"])
    async def update_shelter(
        shelter_id: str,
        body: ShelterUpdateInput,
        request: Request,
        principal: PrincipalDependency,
    ) -> dict[str, Any]:
        ensure_role(principal, "shelter_manager", "responder", "incident_commander")
        return service(request).update_shelter(
            shelter_id,
            body.model_dump(mode="json", exclude_none=True),
            principal,
        )

    @router.get("/resilience/audits", tags=["resilience"])
    @router.get("/resilience", tags=["resilience"], include_in_schema=False)
    async def list_resilience(
        request: Request,
        incident_id: Annotated[str | None, Query()] = None,
    ) -> dict[str, Any]:
        return _page(service(request).resilience(incident_id))

    @router.post(
        "/approvals",
        status_code=status.HTTP_201_CREATED,
        response_model=ApprovalRecord,
        tags=["approvals"],
    )
    async def create_approval(
        body: ApprovalCreateInput,
        request: Request,
        principal: PrincipalDependency,
    ) -> dict[str, Any]:
        ensure_role(principal, "responder", "engineer", "incident_commander")
        return service(request).create_approval(body, principal)

    @router.get("/approvals", tags=["approvals"])
    async def list_approvals(
        request: Request,
        principal: PrincipalDependency,
        incident_id: Annotated[str, Query()],
    ) -> dict[str, Any]:
        ensure_role(
            principal,
            "responder",
            "verifier",
            "engineer",
            "incident_commander",
            "auditor",
        )
        return _page(service(request).approvals(incident_id))

    @router.post(
        "/approvals/{approval_id}/decisions",
        response_model=ApprovalDecisionResponse,
        tags=["approvals"],
    )
    async def decide_approval(
        approval_id: str,
        body: ApprovalDecisionInput,
        request: Request,
        principal: PrincipalDependency,
    ) -> dict[str, Any]:
        ensure_role(principal, "responder", "verifier", "incident_commander")
        ensure_high_impact_auth(principal)
        approval, alert = service(request).decide_approval(approval_id, body, principal)
        return {"approval": approval, "alert": alert}

    @router.get("/alerts", tags=["alerts"])
    async def list_alerts(
        request: Request,
        principal: PrincipalDependency,
        incident_id: Annotated[str, Query()],
    ) -> dict[str, Any]:
        return _page(
            [_alert_view(alert, principal) for alert in service(request).alerts(incident_id)]
        )

    @router.get("/audit", tags=["audit"])
    async def list_audit(
        request: Request,
        principal: PrincipalDependency,
        limit: Annotated[int, Query(ge=1, le=1_000)] = 200,
    ) -> dict[str, Any]:
        ensure_role(principal, "auditor", "incident_commander", "identity_administrator")
        database_value: Database = request.app.state.database
        events = database_value.audit_events(limit=limit)
        return {
            "items": events,
            "next_cursor": None,
            "chain_valid": database_value.verify_audit_chain(),
        }

    @router.get("/audit/export", tags=["audit"])
    async def export_audit(
        request: Request,
        principal: PrincipalDependency,
    ) -> dict[str, Any]:
        ensure_role(principal, "auditor", "incident_commander")
        database_value: Database = request.app.state.database
        events = list(reversed(database_value.audit_events(limit=1_000)))
        serialized = canonical_json(events)
        return {
            "incident_id": service(request).incident_id,
            "generated_at": iso_utc(datetime.now(UTC)),
            "event_count": len(events),
            "first_sequence": events[0]["sequence"] if events else None,
            "last_sequence": events[-1]["sequence"] if events else None,
            "sha256": hashlib.sha256(serialized.encode()).hexdigest(),
            "chain_valid": database_value.verify_audit_chain(),
            "events": events,
        }

    @router.get("/events", tags=["events"])
    async def events(
        request: Request,
        principal: PrincipalDependency,
        incident_id: Annotated[str, Query(min_length=1, max_length=240)],
        once: Annotated[bool, Query()] = False,
        last_event_id: Annotated[str | None, Header(alias="Last-Event-ID")] = None,
    ) -> StreamingResponse:
        ensure_role(
            principal,
            "responder",
            "verifier",
            "engineer",
            "shelter_manager",
            "incident_commander",
            "auditor",
        )
        service(request).incident(incident_id)
        database_value: Database = request.app.state.database
        after_sequence = 0
        if last_event_id:
            try:
                after_sequence = int(last_event_id)
            except ValueError as exc:
                raise AppError(
                    status_code=400,
                    title="Invalid event cursor",
                    detail="Last-Event-ID must be a non-negative persisted event sequence.",
                    code="INVALID_EVENT_CURSOR",
                ) from exc
            if after_sequence < 0:
                raise AppError(
                    status_code=400,
                    title="Invalid event cursor",
                    detail="Last-Event-ID must be a non-negative persisted event sequence.",
                    code="INVALID_EVENT_CURSOR",
                )

        principal_key = principal.user_id
        connection_lock: Lock = request.app.state.sse_connection_lock
        async with connection_lock:
            total = int(request.app.state.sse_connection_count)
            per_principal = int(request.app.state.sse_principal_connections.get(principal_key, 0))
            if total >= runtime.sse_max_connections or (
                per_principal >= runtime.sse_max_connections_per_principal
            ):
                raise AppError(
                    status_code=429,
                    title="Event stream capacity reached",
                    detail="Close an existing event stream before opening another.",
                    code="SSE_CONNECTION_LIMIT",
                    headers={"Retry-After": "5"},
                )
            request.app.state.sse_connection_count = total + 1
            request.app.state.sse_principal_connections[principal_key] = per_principal + 1

        full_event_roles = {
            "responder",
            "verifier",
            "engineer",
            "incident_commander",
            "auditor",
        }

        def event_visible(row: dict[str, Any]) -> bool:
            if not principal.granted_roles.isdisjoint(full_event_roles):
                return True
            return str(row.get("type", "")).startswith(
                ("shelter.", "signal.", "route.", "simulation.", "alert.")
            )

        async def stream() -> AsyncIterator[str]:
            cursor = after_sequence
            heartbeat = 0
            try:
                # Flush response headers immediately so clients can distinguish
                # a healthy live channel from a still-pending connection.
                yield ": connected\n\n"
                while True:
                    rows = await to_thread(
                        database_value.outbox_events,
                        after_sequence=cursor,
                        limit=runtime.sse_replay_limit,
                        incident_id=incident_id,
                    )
                    for row in rows:
                        cursor = int(row["sequence"])
                        if not event_visible(row):
                            continue
                        data = {key: value for key, value in row.items() if key != "sequence"}
                        yield (
                            f"id: {cursor}\n"
                            f"event: {row['type']}\n"
                            f"data: {json.dumps(data, separators=(',', ':'))}\n\n"
                        )
                    if once or await request.is_disconnected():
                        break
                    heartbeat += 1
                    if heartbeat % 15 == 0:
                        yield f": heartbeat {iso_utc(datetime.now(UTC))}\n\n"
                    await sleep(runtime.sse_poll_interval_seconds)
            finally:
                async with connection_lock:
                    request.app.state.sse_connection_count = max(
                        0,
                        int(request.app.state.sse_connection_count) - 1,
                    )
                    remaining = max(
                        0,
                        int(request.app.state.sse_principal_connections.get(principal_key, 1)) - 1,
                    )
                    if remaining:
                        request.app.state.sse_principal_connections[principal_key] = remaining
                    else:
                        request.app.state.sse_principal_connections.pop(principal_key, None)

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache, no-transform",
                "X-Accel-Buffering": "no",
            },
        )

    @router.post("/demo/reset", tags=["demo"])
    async def demo_reset(request: Request, principal: PrincipalDependency) -> dict[str, Any]:
        if not runtime.is_demo:
            raise AppError(
                status_code=404,
                title="Resource not found",
                detail="Demo controls are disabled outside demo mode.",
                code="DEMO_DISABLED",
            )
        ensure_role(principal, "identity_administrator")
        result = service(request).reset_demo(principal)
        media(request).reset_demo_store()
        return result

    @router.post("/demo/advance", tags=["demo"])
    async def demo_advance(
        request: Request,
        principal: PrincipalDependency,
        body: DemoAdvanceInput | None = None,
    ) -> dict[str, Any]:
        if not runtime.is_demo:
            raise AppError(
                status_code=404,
                title="Resource not found",
                detail="Demo controls are disabled outside demo mode.",
                code="DEMO_DISABLED",
            )
        ensure_role(principal, "incident_commander", "engineer")
        return service(request).advance_demo(body or DemoAdvanceInput(), principal)

    @application.get("/", include_in_schema=False)
    async def root() -> dict[str, Any]:
        return {
            "name": "floodRISE API",
            "docs": "/docs",
            "health": "/health",
            "data_label": "DEMO DATA" if runtime.is_demo else "LIVE",
        }

    application.include_router(router)

    default_openapi = application.openapi

    def app_check_openapi() -> dict[str, Any]:
        if application.openapi_schema:
            return application.openapi_schema
        schema = default_openapi()
        for path, path_item in schema.get("paths", {}).items():
            if not isinstance(path_item, dict):
                continue
            for method, operation in path_item.items():
                if not isinstance(operation, dict):
                    continue
                upper_method = method.upper()
                protected = upper_method in MUTATING_METHODS or (
                    upper_method == "GET" and path.rstrip("/") == f"{runtime.api_prefix}/events"
                )
                if not protected:
                    continue
                parameters = operation.setdefault("parameters", [])
                if any(
                    parameter.get("in") == "header"
                    and str(parameter.get("name", "")).lower() == APP_CHECK_HEADER.lower()
                    for parameter in parameters
                ):
                    continue
                parameters.append(
                    {
                        "name": APP_CHECK_HEADER,
                        "in": "header",
                        "required": True,
                        "description": (
                            "Firebase App Check JWT required by the production browser "
                            "contract. The isolated local demo may run with enforcement "
                            "disabled. This verifies the calling app and does not grant "
                            "a user identity or role."
                        ),
                        "schema": {"type": "string"},
                    }
                )
        application.openapi_schema = schema
        return schema

    application.openapi = app_check_openapi  # type: ignore[method-assign]
    return application


app = create_app()


__all__ = ["app", "create_app"]
