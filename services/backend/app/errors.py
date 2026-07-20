"""RFC 9457 error types and FastAPI exception handlers."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from .schemas import ProblemDetails, ProblemFieldError

PROBLEM_MEDIA_TYPE = "application/problem+json"


class AppError(Exception):
    """A deliberate, client-safe API failure represented as RFC 9457."""

    def __init__(
        self,
        *,
        status_code: int,
        title: str,
        detail: str | None = None,
        code: str | None = None,
        type_uri: str = "about:blank",
        errors: list[ProblemFieldError] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> None:
        super().__init__(detail or title)
        self.status_code = status_code
        self.title = title
        self.detail = detail
        self.code = code
        self.type_uri = type_uri
        self.errors = errors or []
        self.headers = dict(headers or {})


class ConflictError(AppError):
    def __init__(self, detail: str, *, code: str = "VERSION_CONFLICT") -> None:
        super().__init__(status_code=409, title="Conflict", detail=detail, code=code)


class NotFoundError(AppError):
    def __init__(self, resource: str, resource_id: str) -> None:
        super().__init__(
            status_code=404,
            title="Resource not found",
            detail=f"{resource} '{resource_id}' was not found",
            code="NOT_FOUND",
        )


class PermissionDeniedError(AppError):
    def __init__(self, detail: str = "You do not have permission to perform this action") -> None:
        super().__init__(
            status_code=403,
            title="Permission denied",
            detail=detail,
            code="PERMISSION_DENIED",
        )


class AuthenticationError(AppError):
    def __init__(self, detail: str = "A valid bearer token is required") -> None:
        super().__init__(
            status_code=401,
            title="Authentication required",
            detail=detail,
            code="AUTHENTICATION_REQUIRED",
            headers={"WWW-Authenticate": "Bearer"},
        )


def _trace_id(request: Request) -> str | None:
    return getattr(request.state, "trace_id", None) or request.headers.get("x-request-id")


def _problem_response(
    request: Request,
    *,
    status: int,
    title: str,
    detail: str | None = None,
    type_uri: str = "about:blank",
    code: str | None = None,
    errors: list[ProblemFieldError] | None = None,
    headers: Mapping[str, str] | None = None,
) -> JSONResponse:
    problem = ProblemDetails(
        type=type_uri,
        title=title,
        status=status,
        detail=detail,
        instance=str(request.url.path),
        code=code,
        trace_id=_trace_id(request),
        errors=errors or [],
    )
    return JSONResponse(
        status_code=status,
        content=problem.model_dump(mode="json", exclude_none=True),
        media_type=PROBLEM_MEDIA_TYPE,
        headers=dict(headers or {}),
    )


async def app_error_handler(request: Request, exc: AppError) -> JSONResponse:
    return _problem_response(
        request,
        status=exc.status_code,
        title=exc.title,
        detail=exc.detail,
        type_uri=exc.type_uri,
        code=exc.code,
        errors=exc.errors,
        headers=exc.headers,
    )


async def validation_error_handler(request: Request, exc: RequestValidationError) -> JSONResponse:
    errors = [
        ProblemFieldError(
            pointer="/" + "/".join(str(part) for part in error["loc"]),
            message=error["msg"],
            code=error["type"],
        )
        for error in exc.errors()
    ]
    return _problem_response(
        request,
        status=422,
        title="Request validation failed",
        detail="One or more request fields are invalid.",
        code="VALIDATION_ERROR",
        errors=errors,
    )


async def http_error_handler(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    detail = exc.detail if isinstance(exc.detail, str) else "The request could not be completed."
    return _problem_response(
        request,
        status=exc.status_code,
        title=_http_title(exc.status_code),
        detail=detail,
        code=f"HTTP_{exc.status_code}",
        headers=exc.headers,
    )


async def unhandled_error_handler(request: Request, _exc: Exception) -> JSONResponse:
    return _problem_response(
        request,
        status=500,
        title="Internal server error",
        detail="The service could not complete the request.",
        code="INTERNAL_ERROR",
    )


def _http_title(status_code: int) -> str:
    titles: dict[int, str] = {
        400: "Bad request",
        401: "Authentication required",
        403: "Permission denied",
        404: "Resource not found",
        405: "Method not allowed",
        409: "Conflict",
        410: "Resource expired",
        413: "Payload too large",
        415: "Unsupported media type",
        422: "Unprocessable content",
        429: "Too many requests",
        503: "Service unavailable",
    }
    return titles.get(status_code, "Request failed")


def install_exception_handlers(app: FastAPI) -> None:
    """Install a consistent problem-details boundary around the application."""
    app.add_exception_handler(AppError, app_error_handler)  # type: ignore[arg-type]
    app.add_exception_handler(RequestValidationError, validation_error_handler)  # type: ignore[arg-type]
    app.add_exception_handler(StarletteHTTPException, http_error_handler)  # type: ignore[arg-type]
    app.add_exception_handler(Exception, unhandled_error_handler)


def problem_openapi_response(model: type[ProblemDetails] = ProblemDetails) -> dict[int | str, Any]:
    """Reusable OpenAPI response fragment for endpoint declarations."""
    return {
        "default": {
            "model": model,
            "content": {PROBLEM_MEDIA_TYPE: {}},
            "description": "RFC 9457 problem detail",
        }
    }


__all__ = [
    "PROBLEM_MEDIA_TYPE",
    "AppError",
    "AuthenticationError",
    "ConflictError",
    "NotFoundError",
    "PermissionDeniedError",
    "app_error_handler",
    "http_error_handler",
    "install_exception_handlers",
    "problem_openapi_response",
    "unhandled_error_handler",
    "validation_error_handler",
]
