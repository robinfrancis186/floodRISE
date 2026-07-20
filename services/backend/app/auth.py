"""Cognito/OIDC authentication boundary with an isolated offline demo shim.

``X-Demo-*`` headers exist only for deterministic judging in the ``demo`` and
``test`` profiles.  Every other profile authenticates a signed bearer token;
staging and production settings fail closed unless issuer, audience, and JWKS
configuration are present.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import time
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Annotated, Any

import httpx
import jwt
from fastapi import Depends, Header, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from jwt import InvalidTokenError, PyJWK

from .config import Settings
from .errors import AppError, AuthenticationError, PermissionDeniedError

ROLE_PRECEDENCE = (
    "incident_commander",
    "verifier",
    "responder",
    "engineer",
    "shelter_manager",
    "auditor",
    "identity_administrator",
    "reporter",
)
ROLES = frozenset(ROLE_PRECEDENCE)

bearer_scheme = HTTPBearer(
    auto_error=False,
    scheme_name="OIDC bearer token",
    description="Cognito/OIDC access token. Demo/test profiles may instead use X-Demo headers.",
)


@dataclass(frozen=True, slots=True)
class Principal:
    user_id: str
    role: str
    authenticated: bool
    roles: frozenset[str] = field(default_factory=frozenset)
    auth_source: str = "internal"
    issuer: str | None = None
    auth_time: datetime | None = None
    acr: str | None = None
    amr: tuple[str, ...] = ()
    mfa_authenticated: bool = False
    phishing_resistant: bool = False
    step_up_authenticated: bool = False
    token_id_digest: str | None = None
    audit_pseudonym_key: bytes = field(
        default=b"floodrise-demo-audit-pseudonym-v1",
        repr=False,
        compare=False,
    )

    @property
    def granted_roles(self) -> frozenset[str]:
        return self.roles or frozenset({self.role})

    def authentication_evidence(self) -> dict[str, Any]:
        """Return non-secret evidence suitable for an approval audit record."""

        return {
            "source": self.auth_source,
            "issuer": self.issuer,
            "auth_time": self.auth_time.isoformat().replace("+00:00", "Z")
            if self.auth_time
            else None,
            "acr": self.acr,
            "amr": list(self.amr),
            "mfa_authenticated": self.mfa_authenticated,
            "phishing_resistant": self.phishing_resistant,
            "step_up_authenticated": self.step_up_authenticated,
            "token_id_digest": self.token_id_digest,
            "simulated": self.auth_source == "demo_header",
        }


def _normalize_role(value: str) -> str:
    return value.strip().lower().replace("-", "_").replace(" ", "_")


def _claim_values(value: object) -> list[str]:
    if isinstance(value, str):
        return [part for part in (item.strip() for item in value.replace(",", " ").split()) if part]
    if isinstance(value, (list, tuple, set)):
        return [str(item).strip() for item in value if str(item).strip()]
    return []


def _claim_is_true(value: object) -> bool:
    return value is True or (
        isinstance(value, str) and value.strip().lower() in {"1", "true", "yes"}
    )


def _epoch_datetime(value: object) -> datetime | None:
    try:
        return datetime.fromtimestamp(float(value), tz=UTC)
    except (TypeError, ValueError, OSError):
        return None


class OIDCVerifier:
    """Validate bearer JWTs with a bounded, rotation-aware JWKS cache."""

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self._jwks: dict[str, Any] | None = None
        self._jwks_expires_at = 0.0
        self._lock = asyncio.Lock()
        if settings.oidc_jwks_json:
            try:
                loaded = json.loads(settings.oidc_jwks_json.get_secret_value())
            except json.JSONDecodeError as exc:
                raise ValueError("oidc_jwks_json must be a valid JWKS document") from exc
            self._jwks = self._validate_jwks_document(loaded)
            self._jwks_expires_at = float("inf")

    @staticmethod
    def _validate_jwks_document(value: object) -> dict[str, Any]:
        if not isinstance(value, dict) or not isinstance(value.get("keys"), list):
            raise ValueError("JWKS document must contain a keys array")
        keys = [key for key in value["keys"] if isinstance(key, dict) and key.get("kid")]
        if not keys:
            raise ValueError("JWKS document does not contain any keyed public keys")
        return {"keys": keys}

    async def _load_jwks(self, *, force_refresh: bool = False) -> dict[str, Any]:
        now = time.monotonic()
        if self._jwks is not None and not force_refresh and now < self._jwks_expires_at:
            return self._jwks
        if self.settings.oidc_jwks_json:
            if self._jwks is None:  # pragma: no cover - guarded by constructor validation
                raise RuntimeError("Static JWKS configuration was not initialized")
            return self._jwks

        jwks_url = self.settings.resolved_oidc_jwks_url
        if not jwks_url:
            raise AppError(
                status_code=503,
                title="Identity provider unavailable",
                detail="OIDC JWKS is not configured.",
                code="IDENTITY_PROVIDER_UNAVAILABLE",
            )
        async with self._lock:
            now = time.monotonic()
            if self._jwks is not None and not force_refresh and now < self._jwks_expires_at:
                return self._jwks
            try:
                async with httpx.AsyncClient(
                    timeout=self.settings.oidc_http_timeout_seconds,
                    follow_redirects=False,
                ) as client:
                    response = await client.get(
                        jwks_url,
                        headers={"Accept": "application/json"},
                    )
                    response.raise_for_status()
                    document = self._validate_jwks_document(response.json())
            except (httpx.HTTPError, json.JSONDecodeError, ValueError) as exc:
                raise AppError(
                    status_code=503,
                    title="Identity provider unavailable",
                    detail="The configured OIDC signing keys could not be refreshed.",
                    code="IDENTITY_PROVIDER_UNAVAILABLE",
                ) from exc
            self._jwks = document
            self._jwks_expires_at = now + self.settings.oidc_jwks_cache_seconds
            return document

    async def _signing_key(self, token: str) -> tuple[Any, str]:
        try:
            header = jwt.get_unverified_header(token)
        except InvalidTokenError as exc:
            raise AuthenticationError("The bearer token header is invalid") from exc
        algorithm = str(header.get("alg", ""))
        key_id = str(header.get("kid", ""))
        if algorithm not in self.settings.oidc_algorithms or not key_id:
            raise AuthenticationError("The bearer token uses an unsupported signing key")

        jwks = await self._load_jwks()
        matching = next((key for key in jwks["keys"] if key.get("kid") == key_id), None)
        if matching is None and not self.settings.oidc_jwks_json:
            jwks = await self._load_jwks(force_refresh=True)
            matching = next((key for key in jwks["keys"] if key.get("kid") == key_id), None)
        if matching is None or matching.get("alg", algorithm) != algorithm:
            raise AuthenticationError("The bearer token signing key is not trusted")
        try:
            return PyJWK.from_dict(matching, algorithm=algorithm).key, algorithm
        except (InvalidTokenError, ValueError) as exc:
            raise AuthenticationError("The configured bearer signing key is invalid") from exc

    def _validate_audience(self, claims: dict[str, Any]) -> None:
        expected = self.settings.oidc_audience
        token_use = claims.get("token_use")
        if token_use == "access":
            presented = _claim_values(claims.get("client_id"))
        else:
            presented = _claim_values(claims.get("aud"))
        if expected not in presented:
            raise AuthenticationError("The bearer token audience is not accepted")

    def _roles(self, claims: dict[str, Any]) -> frozenset[str]:
        supplied: set[str] = set()
        for claim_name in self.settings.oidc_role_claims:
            supplied.update(
                _normalize_role(value) for value in _claim_values(claims.get(claim_name))
            )
        roles = frozenset(supplied & ROLES)
        if not roles:
            raise PermissionDeniedError(
                "The authenticated identity has no supported floodRISE role"
            )
        if "identity_administrator" in roles and len(roles) > 1:
            raise PermissionDeniedError(
                "Identity-administrator accounts cannot also hold operational roles"
            )
        return roles

    async def verify(self, token: str) -> Principal:
        if not self.settings.oidc_issuer:
            raise AppError(
                status_code=503,
                title="Identity provider unavailable",
                detail="OIDC issuer configuration is missing.",
                code="IDENTITY_PROVIDER_UNAVAILABLE",
            )
        key, algorithm = await self._signing_key(token)
        try:
            claims = jwt.decode(
                token,
                key=key,
                algorithms=[algorithm],
                issuer=self.settings.oidc_issuer,
                options={"require": ["exp", "iat", "iss", "sub"], "verify_aud": False},
                leeway=30,
            )
        except InvalidTokenError as exc:
            raise AuthenticationError("The bearer token is invalid or expired") from exc

        self._validate_audience(claims)
        roles = self._roles(claims)
        primary_role = next(role for role in ROLE_PRECEDENCE if role in roles)
        amr = tuple(value.lower() for value in _claim_values(claims.get("amr")))
        acr = str(claims["acr"]) if claims.get("acr") is not None else None
        auth_time = _epoch_datetime(claims.get("auth_time"))
        now = datetime.now(UTC)
        recent_auth = bool(
            auth_time
            and -60
            <= (now - auth_time).total_seconds()
            <= self.settings.oidc_step_up_max_age_seconds
        )
        mfa = bool(set(amr) & set(self.settings.oidc_mfa_amr_values)) or _claim_is_true(
            claims.get(self.settings.oidc_mfa_claim)
        )
        phishing_resistant = bool(
            set(amr) & set(self.settings.oidc_phishing_resistant_amr_values)
        ) or _claim_is_true(claims.get(self.settings.oidc_phishing_resistant_claim))
        step_up_asserted = acr in self.settings.oidc_step_up_acr_values or _claim_is_true(
            claims.get(self.settings.oidc_step_up_claim)
        )
        token_id = claims.get("jti") or claims.get("origin_jti")
        return Principal(
            user_id=str(claims["sub"]),
            role=primary_role,
            roles=roles,
            authenticated=True,
            auth_source="oidc_bearer",
            issuer=str(claims["iss"]),
            auth_time=auth_time,
            acr=acr,
            amr=amr,
            mfa_authenticated=mfa,
            phishing_resistant=phishing_resistant,
            step_up_authenticated=bool(step_up_asserted and recent_auth),
            token_id_digest=hashlib.sha256(str(token_id).encode()).hexdigest()[:16]
            if token_id
            else None,
            audit_pseudonym_key=self.settings.session_secret.get_secret_value().encode(),
        )


async def demo_principal(
    x_demo_user: Annotated[str, Header(alias="X-Demo-User")] = "demo-reporter",
    x_demo_role: Annotated[str, Header(alias="X-Demo-Role")] = "reporter",
    audit_pseudonym_key: bytes = b"floodrise-demo-audit-pseudonym-v1",
) -> Principal:
    """Build a visibly simulated principal for demo/test compatibility."""

    role = _normalize_role(x_demo_role)
    if role not in ROLES:
        raise PermissionDeniedError("The supplied demo role is not recognized")
    return Principal(
        user_id=x_demo_user.strip() or "demo-user",
        role=role,
        roles=frozenset({role}),
        authenticated=True,
        auth_source="demo_header",
        auth_time=datetime.now(UTC),
        acr="demo-step-up",
        amr=("demo",),
        mfa_authenticated=True,
        phishing_resistant=True,
        step_up_authenticated=True,
        audit_pseudonym_key=audit_pseudonym_key,
    )


async def authenticated_principal(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer_scheme)],
    x_demo_user: Annotated[str | None, Header(alias="X-Demo-User")] = None,
    x_demo_role: Annotated[str | None, Header(alias="X-Demo-Role")] = None,
) -> Principal:
    settings: Settings = request.app.state.settings
    supplied_demo_headers = x_demo_user is not None or x_demo_role is not None
    if settings.allow_demo_headers:
        if credentials is not None:
            verifier: OIDCVerifier = request.app.state.oidc_verifier
            return await verifier.verify(credentials.credentials)
        return await demo_principal(
            x_demo_user=x_demo_user or "demo-reporter",
            x_demo_role=x_demo_role or "reporter",
            audit_pseudonym_key=settings.session_secret.get_secret_value().encode(),
        )
    if supplied_demo_headers:
        raise AuthenticationError("Demo identity headers are disabled in this environment")
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise AuthenticationError()
    verifier = request.app.state.oidc_verifier
    return await verifier.verify(credentials.credentials)


def ensure_role(principal: Principal, *allowed: str) -> None:
    normalized = {_normalize_role(role) for role in allowed}
    if principal.granted_roles.isdisjoint(normalized):
        raise PermissionDeniedError(
            f"Role '{principal.role}' cannot perform this action; required role: "
            + ", ".join(sorted(normalized))
        )


def audit_actor_id(principal: Principal, incident_id: str) -> str:
    """Return an accountable staff ID or an incident-scoped citizen pseudonym."""

    if principal.role != "reporter":
        return principal.user_id
    digest = hmac.new(
        principal.audit_pseudonym_key,
        f"{incident_id}:{principal.user_id}".encode(),
        hashlib.sha256,
    ).hexdigest()[:24]
    return f"reporter-{digest}"


def ensure_high_impact_auth(principal: Principal) -> None:
    """Require recent, phishing-resistant step-up MFA for operational approval."""

    missing: list[str] = []
    if not principal.mfa_authenticated:
        missing.append("MFA")
    if not principal.phishing_resistant:
        missing.append("phishing-resistant authentication")
    if not principal.step_up_authenticated:
        missing.append("a recent step-up assertion")
    if missing:
        raise PermissionDeniedError(
            "High-impact approval requires " + ", ".join(missing) + ". Re-authenticate and retry."
        )


__all__ = [
    "OIDCVerifier",
    "Principal",
    "ROLES",
    "authenticated_principal",
    "audit_actor_id",
    "bearer_scheme",
    "demo_principal",
    "ensure_high_impact_auth",
    "ensure_role",
]
