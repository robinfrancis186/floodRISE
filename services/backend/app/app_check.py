"""Firebase App Check verification for browser-originated API requests.

App Check is an application-integrity signal, not a replacement for the
existing reporter/staff identity boundary.  The verifier deliberately keeps
the two concerns separate: mutations and the event stream require App Check,
while endpoint-specific identity and role rules remain authoritative.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Annotated, Any

import httpx
import jwt
from fastapi import Header, Request
from jwt import InvalidTokenError, PyJWK, PyJWTError

from .config import Settings
from .errors import AppError

APP_CHECK_HEADER = "X-Firebase-AppCheck"
MAX_TOKEN_BYTES = 16_384
MAX_JWKS_BYTES = 256 * 1024
MAX_JWKS_KEYS = 32
JWKS_REFRESH_COOLDOWN_SECONDS = 5.0
MAX_UNKNOWN_KEY_CACHE_ENTRIES = 256
MUTATING_METHODS = frozenset({"POST", "PUT", "PATCH", "DELETE"})


@dataclass(frozen=True, slots=True)
class FirebaseAppCheckClaims:
    """Sanitized verification evidence safe to retain for this request."""

    app_id: str
    project_number: str
    issued_at: datetime
    expires_at: datetime
    token_digest: str


class FirebaseAppCheckVerifier:
    """Validate signed App Check JWTs with a bounded, rotation-aware JWKS cache."""

    def __init__(
        self,
        settings: Settings,
        *,
        monotonic_clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.settings = settings
        self._clock = monotonic_clock
        self._jwks: dict[str, Any] | None = None
        self._jwks_expires_at = 0.0
        self._jwks_generation = 0
        self._refresh_blocked_until = 0.0
        self._refresh_failed_until = 0.0
        self._unknown_key_ids: dict[bytes, tuple[int, float]] = {}
        self._lock = asyncio.Lock()
        if settings.firebase_app_check_jwks_json:
            try:
                loaded = json.loads(settings.firebase_app_check_jwks_json.get_secret_value())
            except json.JSONDecodeError as exc:
                raise ValueError(
                    "firebase_app_check_jwks_json must be a valid JWKS document"
                ) from exc
            self._jwks = self._validate_jwks_document(loaded)
            self._jwks_expires_at = float("inf")
            self._jwks_generation = 1

    @staticmethod
    def _validate_jwks_document(value: object) -> dict[str, Any]:
        if not isinstance(value, dict) or not isinstance(value.get("keys"), list):
            raise ValueError("Firebase App Check JWKS must contain a keys array")
        keys = [
            key for key in value["keys"][:MAX_JWKS_KEYS] if isinstance(key, dict) and key.get("kid")
        ]
        if not keys:
            raise ValueError("Firebase App Check JWKS has no keyed public keys")
        return {"keys": keys}

    @staticmethod
    def _unavailable_error() -> AppError:
        return AppError(
            status_code=503,
            title="App verification unavailable",
            detail="Application verification is temporarily unavailable. Retry shortly.",
            code="APP_CHECK_UNAVAILABLE",
            headers={"Retry-After": "5"},
        )

    @staticmethod
    def _invalid_error(*, missing: bool = False) -> AppError:
        return AppError(
            status_code=401,
            title="App verification required",
            detail=(
                "A Firebase App Check token is required for this request."
                if missing
                else "The Firebase App Check token is invalid or expired."
            ),
            code="APP_CHECK_REQUIRED" if missing else "APP_CHECK_INVALID",
        )

    @staticmethod
    def _matching_key(jwks: dict[str, Any], key_id: str) -> dict[str, Any] | None:
        return next(
            (key for key in jwks["keys"] if key.get("kid") == key_id),
            None,
        )

    @staticmethod
    def _unknown_key_digest(key_id: str) -> bytes:
        return hashlib.sha256(key_id.encode()).digest()

    def _is_known_unknown_key(self, key_id: str, generation: int) -> bool:
        digest = self._unknown_key_digest(key_id)
        cached = self._unknown_key_ids.get(digest)
        if cached is None:
            return False
        cached_generation, expires_at = cached
        if cached_generation != generation or self._clock() >= expires_at:
            self._unknown_key_ids.pop(digest, None)
            return False
        return True

    def _remember_unknown_key(self, key_id: str, generation: int) -> None:
        now = self._clock()
        if self._refresh_blocked_until <= now:
            return
        digest = self._unknown_key_digest(key_id)
        self._unknown_key_ids.pop(digest, None)
        if len(self._unknown_key_ids) >= MAX_UNKNOWN_KEY_CACHE_ENTRIES:
            self._unknown_key_ids.pop(next(iter(self._unknown_key_ids)))
        self._unknown_key_ids[digest] = (generation, self._refresh_blocked_until)

    async def _fetch_remote_jwks(self, jwks_url: str) -> dict[str, Any]:
        succeeded = False
        try:
            async with httpx.AsyncClient(
                timeout=self.settings.firebase_app_check_http_timeout_seconds,
                follow_redirects=False,
            ) as client:
                response = await client.get(
                    jwks_url,
                    headers={"Accept": "application/json"},
                )
                response.raise_for_status()
                if len(response.content) > MAX_JWKS_BYTES:
                    raise ValueError("Firebase App Check JWKS response is too large")
                document = self._validate_jwks_document(json.loads(response.content))
            completed_at = self._clock()
            self._jwks = document
            self._jwks_expires_at = (
                completed_at + self.settings.firebase_app_check_jwks_cache_seconds
            )
            self._jwks_generation += 1
            self._unknown_key_ids.clear()
            succeeded = True
            return document
        except (httpx.HTTPError, json.JSONDecodeError, UnicodeDecodeError, ValueError) as exc:
            raise self._unavailable_error() from exc
        finally:
            retry_at = self._clock() + JWKS_REFRESH_COOLDOWN_SECONDS
            self._refresh_blocked_until = retry_at
            self._refresh_failed_until = 0.0 if succeeded else retry_at

    async def _load_jwks(
        self,
        *,
        force_refresh: bool = False,
        expected_generation: int | None = None,
    ) -> dict[str, Any]:
        now = self._clock()
        if self._jwks is not None and not force_refresh and now < self._jwks_expires_at:
            return self._jwks
        if self.settings.firebase_app_check_jwks_json:
            if self._jwks is None:  # pragma: no cover - constructor validates this
                raise RuntimeError("Static Firebase App Check JWKS was not initialized")
            return self._jwks

        jwks_url = self.settings.firebase_app_check_jwks_url
        if not jwks_url:
            raise self._unavailable_error()
        async with self._lock:
            now = self._clock()
            if self._jwks is not None and not force_refresh and now < self._jwks_expires_at:
                return self._jwks
            if (
                force_refresh
                and self._jwks is not None
                and expected_generation is not None
                and self._jwks_generation != expected_generation
            ):
                return self._jwks
            if now < self._refresh_blocked_until:
                if now < self._refresh_failed_until or not force_refresh or self._jwks is None:
                    raise self._unavailable_error()
                return self._jwks
            return await self._fetch_remote_jwks(jwks_url)

    async def _signing_key(self, token: str) -> tuple[Any, str]:
        try:
            header = jwt.get_unverified_header(token)
        except InvalidTokenError as exc:
            raise self._invalid_error() from exc
        algorithm = str(header.get("alg", ""))
        key_id = str(header.get("kid", ""))
        if (
            algorithm not in self.settings.firebase_app_check_algorithms
            or not key_id
            or header.get("typ") != "JWT"
        ):
            raise self._invalid_error()

        jwks = await self._load_jwks()
        generation = self._jwks_generation
        matching = self._matching_key(jwks, key_id)
        if (
            matching is None
            and not self.settings.firebase_app_check_jwks_json
            and not self._is_known_unknown_key(key_id, generation)
        ):
            jwks = await self._load_jwks(
                force_refresh=True,
                expected_generation=generation,
            )
            generation = self._jwks_generation
            matching = self._matching_key(jwks, key_id)
            if matching is None:
                self._remember_unknown_key(key_id, generation)
        if matching is None or matching.get("alg", algorithm) != algorithm:
            raise self._invalid_error()
        try:
            return PyJWK.from_dict(matching, algorithm=algorithm).key, algorithm
        except (PyJWTError, ValueError) as exc:
            raise self._unavailable_error() from exc

    async def verify(self, token: str) -> FirebaseAppCheckClaims:
        token = token.strip()
        if not token:
            raise self._invalid_error(missing=True)
        if len(token.encode()) > MAX_TOKEN_BYTES:
            raise self._invalid_error()

        project_number = self.settings.firebase_app_check_project_number
        if not project_number:
            raise self._unavailable_error()
        key, algorithm = await self._signing_key(token)
        try:
            claims = jwt.decode(
                token,
                key=key,
                algorithms=[algorithm],
                audience=f"projects/{project_number}",
                issuer=f"https://firebaseappcheck.googleapis.com/{project_number}",
                options={"require": ["aud", "exp", "iat", "iss", "sub"]},
                leeway=30,
            )
        except InvalidTokenError as exc:
            raise self._invalid_error() from exc

        audience_claim = claims.get("aud")
        if isinstance(audience_claim, str):
            audiences = {audience_claim}
        elif isinstance(audience_claim, list) and all(
            isinstance(value, str) for value in audience_claim
        ):
            audiences = set(audience_claim)
        else:
            raise self._invalid_error()
        if f"projects/{project_number}" not in audiences:
            raise self._invalid_error()

        try:
            issued_at = datetime.fromtimestamp(float(claims["iat"]), tz=UTC)
            expires_at = datetime.fromtimestamp(float(claims["exp"]), tz=UTC)
        except (TypeError, ValueError, OSError) as exc:
            raise self._invalid_error() from exc
        if expires_at <= issued_at:
            raise self._invalid_error()
        app_id = str(claims["sub"]).strip()
        if not app_id:
            raise self._invalid_error()
        allowed_app_ids = set(self.settings.firebase_app_check_app_ids)
        if allowed_app_ids and app_id not in allowed_app_ids:
            raise self._invalid_error()
        return FirebaseAppCheckClaims(
            app_id=app_id,
            project_number=project_number,
            issued_at=issued_at,
            expires_at=expires_at,
            token_digest=hashlib.sha256(token.encode()).hexdigest()[:16],
        )


async def require_firebase_app_check(
    request: Request,
    token: Annotated[
        str | None,
        Header(
            alias=APP_CHECK_HEADER,
            description="Firebase App Check JWT for protected browser requests.",
        ),
    ] = None,
) -> FirebaseAppCheckClaims | None:
    """Verify App Check when this request crosses the configured boundary."""

    settings: Settings = request.app.state.settings
    if not request_requires_firebase_app_check(request, settings):
        return None
    header_values = request.headers.getlist(APP_CHECK_HEADER)
    if not header_values or token is None or not token.strip():
        raise FirebaseAppCheckVerifier._invalid_error(missing=True)
    if len(header_values) != 1:
        raise FirebaseAppCheckVerifier._invalid_error()
    verifier: FirebaseAppCheckVerifier = request.app.state.firebase_app_check_verifier
    claims = await verifier.verify(token)
    request.state.firebase_app_check = claims
    return claims


def request_requires_firebase_app_check(
    request: Request,
    settings: Settings | None = None,
) -> bool:
    """Return whether this API request requires an application-integrity token."""

    runtime = settings or request.app.state.settings
    if not runtime.firebase_app_check_enabled:
        return False
    prefix = runtime.api_prefix.rstrip("/")
    path = request.url.path.rstrip("/")
    if path != prefix and not path.startswith(f"{prefix}/"):
        return False
    if request.method.upper() in MUTATING_METHODS:
        return True
    return request.method.upper() == "GET" and path == f"{prefix}/events"


__all__ = [
    "APP_CHECK_HEADER",
    "MUTATING_METHODS",
    "FirebaseAppCheckClaims",
    "FirebaseAppCheckVerifier",
    "request_requires_firebase_app_check",
    "require_firebase_app_check",
]
