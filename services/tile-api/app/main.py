from __future__ import annotations

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, Response

from app.artifacts import (
    MAX_ZOOM,
    MIN_ZOOM,
    RENDERER_VERSION,
    load_artifact_store,
    render_tile,
    tile_etag,
)

app = FastAPI(title="floodRISE Tile API", version="0.2.0")

STORE = load_artifact_store()


@app.exception_handler(HTTPException)
async def problem_details(request: Request, exc: HTTPException) -> JSONResponse:
    return JSONResponse(
        status_code=exc.status_code,
        media_type="application/problem+json",
        content={
            "type": "https://floodrise.local/problems/artifact-not-found",
            "title": "Raster artifact is not available",
            "status": exc.status_code,
            "detail": str(exc.detail),
            "instance": str(request.url.path),
        },
    )


@app.get("/health")
async def health() -> dict[str, str | int | bool]:
    return {
        "status": "ok",
        "service": "tile-api",
        "artifact_count": len(STORE.artifacts),
        "manifest_sha256": STORE.manifest_sha256,
        "representation": STORE.representation,
        "is_simulated": True,
    }


@app.get("/api/v1/raster/{artifact_id}/tilejson.json")
async def tilejson(artifact_id: str, request: Request) -> dict:
    artifact = STORE.get(artifact_id)
    if artifact is None:
        raise HTTPException(404, "Unknown or unapproved artifact id")
    base = str(request.base_url).rstrip("/")
    return {
        "tilejson": "3.0.0",
        "name": artifact.title,
        "tiles": [f"{base}/api/v1/raster/{artifact_id}/{{z}}/{{x}}/{{y}}.png?v={artifact.version}"],
        "bounds": list(artifact.bounds),
        "minzoom": MIN_ZOOM,
        "maxzoom": MAX_ZOOM,
        "artifact_id": artifact.id,
        "artifact_version": artifact.version,
        "artifact_sha256": artifact.content_sha256,
        "manifest_sha256": STORE.manifest_sha256,
        "model_version": artifact.model_version,
        "representation": STORE.representation,
        "renderer_version": RENDERER_VERSION,
        "quantile": artifact.quantile,
        "horizon": artifact.horizon,
        "valid_at": artifact.valid_at,
        "valid_until": artifact.valid_until,
        "confidence": artifact.confidence,
        "statistics": artifact.statistics,
        "sample_unit": STORE.rendering["sample_unit"],
        "scale_to_metres": STORE.rendering["scale_to_metres"],
        "units": "metres",
        "classification": "RAPID_IMPACT_ESTIMATE",
        "data_label": STORE.data_label,
        "is_simulated": True,
        "provenance": STORE.provenance,
    }


@app.get("/api/v1/raster/{artifact_id}/{z}/{x}/{y}.png")
async def tile(artifact_id: str, z: int, x: int, y: int, request: Request) -> Response:
    artifact = STORE.get(artifact_id)
    if artifact is None:
        raise HTTPException(404, "Unknown or unapproved artifact id")
    coordinate_limit = 1 << z if MIN_ZOOM <= z <= MAX_ZOOM else 0
    if not (MIN_ZOOM <= z <= MAX_ZOOM and 0 <= x < coordinate_limit and 0 <= y < coordinate_limit):
        raise HTTPException(400, "Invalid tile coordinate")

    etag = tile_etag(artifact, z, x, y)
    headers = {
        "Cache-Control": "public, max-age=300, must-revalidate",
        "ETag": etag,
        "X-floodRISE-Demo": "true",
        "X-floodRISE-Artifact-SHA256": artifact.content_sha256,
        "X-floodRISE-Model-Version": artifact.model_version,
        "X-floodRISE-Representation": STORE.representation,
        "X-Content-Type-Options": "nosniff",
    }
    if request.headers.get("if-none-match") == etag:
        return Response(status_code=304, headers=headers)
    return Response(
        render_tile(artifact, z, x, y),
        media_type="image/png",
        headers=headers,
    )
