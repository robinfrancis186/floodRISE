"""Production authentication boundary tests using an entirely local JWKS."""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any
from unittest.mock import patch

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from jwt.algorithms import RSAAlgorithm
from pydantic import SecretStr, ValidationError

from app.auth import (
    OIDC_JWKS_REFRESH_COOLDOWN_SECONDS,
    OIDCVerifier,
    Principal,
    audit_actor_id,
)
from app.config import Settings
from app.database import Database, EntityChange
from app.errors import AppError, AuthenticationError
from app.main import create_app

API = "/api/v1"
INCIDENT_ID = "inc-authority-auth-test"
ISSUER = "https://cognito-idp.ap-south-1.amazonaws.com/ap-south-1_example"
AUDIENCE = "staff-web-client"
KEY_ID = "local-test-key"


@pytest.fixture(scope="module")
def signing_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65_537, key_size=2_048)


@pytest.fixture(scope="module")
def jwks_json(signing_key: rsa.RSAPrivateKey) -> str:
    jwk = RSAAlgorithm.to_jwk(signing_key.public_key(), as_dict=True)
    jwk.update({"kid": KEY_ID, "alg": "RS256", "use": "sig"})
    return json.dumps({"keys": [jwk]})


@pytest.fixture
def production_client(jwks_json: str) -> Iterator[TestClient]:
    database = Database("sqlite://")
    database.initialize()
    now = datetime.now(UTC)
    now_iso = now.isoformat().replace("+00:00", "Z")
    database.commit(
        changes=[
            EntityChange(
                "incident",
                INCIDENT_ID,
                {
                    "id": INCIDENT_ID,
                    "name": "Authority test incident",
                    "is_demo": False,
                    "is_simulated": False,
                    "bounds": [76.2, 9.92, 76.48, 10.24],
                    "version": 1,
                },
                1,
            ),
            EntityChange(
                "signal",
                "signal-auth-test",
                {
                    "id": "signal-auth-test",
                    "incident_id": INCIDENT_ID,
                    "cluster_id": "cluster-auth-test",
                    "state": "COMMUNITY_CORROBORATED",
                    "location": {
                        "type": "Point",
                        "coordinates": [76.3517, 10.1065],
                    },
                    "radius_m": 100,
                    "last_observed_at": now_iso,
                    "evidence_version": "evidence-auth-test-001",
                    "version": 1,
                },
                1,
            ),
            EntityChange(
                "simulation",
                "model-auth-test-001",
                {
                    "id": "model-auth-test-001",
                    "incident_id": INCIDENT_ID,
                    "model_version": "model-auth-test-001",
                    "status": "PUBLISHED",
                    "version": 1,
                },
                1,
            ),
        ],
        state={
            "incident_id": INCIDENT_ID,
            "scenario_clock": now_iso,
            "demo_mode": False,
        },
    )
    settings = Settings(
        env="staging",
        demo_mode=False,
        database_url="postgresql+psycopg://test.invalid/floodrise?sslmode=require",
        database_allowed_host="test.invalid",
        oidc_issuer=ISSUER,
        oidc_audience=AUDIENCE,
        oidc_jwks_json=SecretStr(jwks_json),
        session_secret=SecretStr("unit-test-session-secret-not-for-deployment"),
    )
    application = create_app(settings, database=database)
    try:
        with TestClient(application, raise_server_exceptions=False) as client:
            yield client
    finally:
        database.engine.dispose()


def _token(
    signing_key: rsa.RSAPrivateKey,
    *,
    key_id: str = KEY_ID,
    subject: str = "staff-user-1",
    roles: list[str] | None = None,
    audience: str = AUDIENCE,
    amr: list[str] | None = None,
    acr: str | None = None,
    auth_age_seconds: int = 0,
    overrides: dict[str, Any] | None = None,
) -> str:
    now = int(time.time())
    claims: dict[str, Any] = {
        "iss": ISSUER,
        "sub": subject,
        "iat": now,
        "exp": now + 600,
        "auth_time": now - auth_age_seconds,
        "token_use": "access",
        "client_id": audience,
        "cognito:groups": roles or ["auditor"],
        "amr": amr or ["pwd"],
        "jti": f"token-{subject}",
    }
    if acr:
        claims["acr"] = acr
    claims.update(overrides or {})
    return jwt.encode(
        claims,
        signing_key,
        algorithm="RS256",
        headers={"kid": key_id},
    )


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _approval_payload() -> dict[str, Any]:
    return {
        "incident_id": INCIDENT_ID,
        "action_type": "ALL_CLEAR",
        "action_payload": {
            "title": "End a test warning",
            "body": "This remains a fake-gateway test action.",
        },
        "audience": "Local static-JWKS test audience",
        "geometry": {"type": "Point", "coordinates": [76.3517000, 10.1065000]},
        "evidence_version": "evidence-auth-test-001",
        "model_version": "model-auth-test-001",
        "reason": "Exercise the production authorization boundary.",
    }


def test_staging_settings_fail_closed_without_oidc_or_non_demo_secret() -> None:
    with pytest.raises(ValidationError):
        Settings(env="staging", demo_mode=False)

    with pytest.raises(ValidationError):
        Settings(
            env="production",
            demo_mode=True,
            oidc_issuer=ISSUER,
            oidc_jwks_json=SecretStr('{"keys": []}'),
        )


@pytest.mark.parametrize(
    "database_url",
    [
        "sqlite:///floodrise.db",
        "mysql://database.invalid/floodrise?sslmode=require",
        "postgresql+psycopg://database.invalid/floodrise",
        "postgresql+psycopg://database.invalid/floodrise?sslmode=disable",
        "postgresql+psycopg://database.invalid/floodrise?sslmode=prefer",
    ],
)
def test_live_settings_reject_non_postgresql_or_non_encrypted_database_urls(
    database_url: str,
) -> None:
    with pytest.raises(ValidationError, match="database_url"):
        Settings(
            env="staging",
            demo_mode=False,
            database_url=database_url,
            database_allowed_host="database.invalid",
            oidc_issuer=ISSUER,
            oidc_jwks_json=SecretStr('{"keys": []}'),
            session_secret=SecretStr("staging-database-transport-test-secret"),
        )


@pytest.mark.parametrize("sslmode", ["require", "verify-ca", "verify-full"])
def test_live_settings_accept_encrypted_postgresql_database_urls(sslmode: str) -> None:
    settings = Settings(
        env="production",
        demo_mode=False,
        database_url=(f"postgresql+psycopg://database.invalid/floodrise?sslmode={sslmode}"),
        database_allowed_host="database.invalid",
        oidc_issuer=ISSUER,
        oidc_jwks_json=SecretStr('{"keys": []}'),
        session_secret=SecretStr("production-database-transport-test-secret"),
    )

    assert settings.database_url.endswith(f"sslmode={sslmode}")


def test_live_settings_bind_database_url_to_the_approved_host() -> None:
    common = {
        "env": "production",
        "demo_mode": False,
        "database_url": ("postgresql+psycopg://database.internal/floodrise?sslmode=verify-full"),
        "oidc_issuer": ISSUER,
        "oidc_jwks_json": SecretStr('{"keys": []}'),
        "session_secret": SecretStr("production-database-host-test-secret"),
    }

    with pytest.raises(ValidationError, match="database_allowed_host"):
        Settings(**common)
    with pytest.raises(ValidationError, match="approved database host"):
        Settings(**common, database_allowed_host="other.internal")

    settings = Settings(**common, database_allowed_host="database.internal")
    assert settings.database_allowed_host == "database.internal"


def test_reporter_audit_pseudonym_is_keyed_and_incident_scoped() -> None:
    principal = Principal(
        "predictable-phone-subject",
        "reporter",
        True,
        audit_pseudonym_key=b"test-managed-pseudonym-key",
    )

    first = audit_actor_id(principal, "incident-a")
    assert first == audit_actor_id(principal, "incident-a")
    assert first != audit_actor_id(principal, "incident-b")
    assert "predictable-phone-subject" not in first
    assert len(first.removeprefix("reporter-")) == 24


def test_demo_headers_are_rejected_and_bearer_is_required_in_staging(
    production_client: TestClient,
) -> None:
    demo_header = production_client.get(
        f"{API}/audit",
        headers={"X-Demo-User": "intruder", "X-Demo-Role": "auditor"},
    )
    missing = production_client.get(f"{API}/audit")

    assert demo_header.status_code == 401
    assert demo_header.json()["code"] == "AUTHENTICATION_REQUIRED"
    assert missing.status_code == 401
    assert missing.headers["www-authenticate"] == "Bearer"


def test_non_demo_application_exposes_only_authority_owned_state(
    production_client: TestClient,
) -> None:
    health = production_client.get("/health")
    incidents = production_client.get(f"{API}/incidents")

    assert health.status_code == incidents.status_code == 200
    assert health.json()["demo_mode"] is False
    assert health.json()["data_label"] == "LIVE"
    assert [item["id"] for item in incidents.json()["items"]] == [INCIDENT_ID]
    assert all(item.get("is_simulated") is False for item in incidents.json()["items"])


def test_static_jwks_validates_signature_audience_and_role_without_network(
    production_client: TestClient,
    signing_key: rsa.RSAPrivateKey,
) -> None:
    valid = _token(signing_key, roles=["auditor"], amr=["webauthn"])
    wrong_audience = _token(signing_key, audience="different-client", amr=["webauthn"])
    unsupported_role = _token(signing_key, roles=["unmapped-superuser"], amr=["webauthn"])

    with patch("app.auth.httpx.AsyncClient", side_effect=AssertionError("network not allowed")):
        response = production_client.get(f"{API}/audit", headers=_bearer(valid))
        context = production_client.get(f"{API}/auth/me", headers=_bearer(valid))
        audience_response = production_client.get(f"{API}/audit", headers=_bearer(wrong_audience))
        role_response = production_client.get(f"{API}/audit", headers=_bearer(unsupported_role))

    assert response.status_code == 200
    assert context.status_code == 200
    assert context.json()["roles"] == ["auditor"]
    assert context.json()["high_impact_approval_eligible"] is False
    assert audience_response.status_code == 401
    assert role_response.status_code == 403


def test_password_and_totp_are_insufficient_for_any_staff_access(
    production_client: TestClient,
    signing_key: rsa.RSAPrivateKey,
) -> None:
    password_and_totp = _token(
        signing_key,
        subject="phishable-auditor",
        roles=["auditor"],
        amr=["pwd", "totp"],
    )

    denied = production_client.get(
        f"{API}/audit",
        headers=_bearer(password_and_totp),
    )

    assert denied.status_code == 403
    assert denied.json()["code"] == "PERMISSION_DENIED"
    assert "phishing-resistant" in denied.json()["detail"]


def test_report_install_family_comes_from_the_signed_identity_claim(
    production_client: TestClient,
    signing_key: rsa.RSAPrivateKey,
) -> None:
    observed_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")

    def report_payload(number: int) -> dict[str, Any]:
        return {
            "client_report_id": f"live-install-report-{number}",
            "incident_id": INCIDENT_ID,
            "reporter_id": f"untrusted-alias-{number}",
            "device_id": f"forged-device-{number}",
            "observed_at": observed_at,
            "location": {
                "latitude": 10.1065 + number * 0.00001,
                "longitude": 76.3517 + number * 0.00001,
                "accuracy_m": 20,
            },
            "water_depth": "KNEE",
            "road_status": "IMPASSABLE",
            "flood_status": "FLOODED",
        }

    responses = []
    for number, account in enumerate(("reporter-a", "reporter-b"), start=1):
        token = _token(
            signing_key,
            subject=account,
            roles=["reporter"],
            overrides={"custom:install_id": "idp-managed-shared-install"},
        )
        responses.append(
            production_client.post(
                f"{API}/reports",
                json=report_payload(number),
                headers={
                    **_bearer(token),
                    "Idempotency-Key": f"live-install-key-{number}",
                },
            )
        )

    assert [response.status_code for response in responses] == [201, 201]
    stored = production_client.app.state.database.list("report")
    assert len({report["device_id"] for report in stored}) == 1
    assert all(not report["device_id"].startswith("forged-device") for report in stored)
    by_client_id = {report["client_report_id"]: report for report in stored}
    assert by_client_id["live-install-report-1"]["disposition"] == "ELIGIBLE"
    assert by_client_id["live-install-report-2"]["disposition"] == "DUPLICATE"

    missing_claim = _token(
        signing_key,
        subject="reporter-without-install",
        roles=["reporter"],
    )
    denied = production_client.post(
        f"{API}/reports",
        json=report_payload(3),
        headers={
            **_bearer(missing_claim),
            "Idempotency-Key": "missing-live-install-claim",
        },
    )
    assert denied.status_code == 403
    assert "signed install identity" in denied.json()["detail"]


def test_high_impact_decision_requires_recent_phishing_resistant_step_up(
    production_client: TestClient,
    signing_key: rsa.RSAPrivateKey,
) -> None:
    requester_token = _token(
        signing_key,
        subject="requester",
        roles=["incident-commander"],
        amr=["webauthn"],
    )
    created = production_client.post(
        f"{API}/approvals",
        json=_approval_payload(),
        headers=_bearer(requester_token),
    )
    assert created.status_code == 201
    approval = created.json()
    assert approval["request_authentication"]["source"] == "oidc_bearer"

    decision = {
        "decision": "APPROVE",
        "reason": "Independent operational review completed.",
        "expected_version": approval["version"],
    }
    password_only = _token(signing_key, subject="approver-basic", roles=["verifier"])
    denied = production_client.post(
        f"{API}/approvals/{approval['id']}/decisions",
        json=decision,
        headers=_bearer(password_only),
    )
    assert denied.status_code == 403
    assert "phishing-resistant" in denied.json()["detail"]

    stepped_up = _token(
        signing_key,
        subject="approver-step-up",
        roles=["verifier"],
        amr=["pwd", "webauthn"],
        acr="urn:floodrise:loa:step-up",
    )
    approved = production_client.post(
        f"{API}/approvals/{approval['id']}/decisions",
        json=decision,
        headers=_bearer(stepped_up),
    )

    assert approved.status_code == 200
    evidence = approved.json()["approval"]["decision_authentication"]
    assert evidence["mfa_authenticated"] is True
    assert evidence["phishing_resistant"] is True
    assert evidence["step_up_authenticated"] is True
    assert evidence["token_id_digest"] != "token-approver-step-up"


def test_stale_step_up_is_not_accepted(
    production_client: TestClient,
    signing_key: rsa.RSAPrivateKey,
) -> None:
    requester_token = _token(
        signing_key,
        subject="requester-2",
        roles=["responder"],
        amr=["webauthn"],
    )
    payload = _approval_payload()
    payload["reason"] = "A second unique action for stale step-up testing."
    created = production_client.post(
        f"{API}/approvals",
        json=payload,
        headers=_bearer(requester_token),
    )
    assert created.status_code == 201
    approval = created.json()

    stale_step_up = _token(
        signing_key,
        subject="stale-approver",
        roles=["verifier"],
        amr=["webauthn"],
        acr="aal2",
        auth_age_seconds=600,
    )
    denied = production_client.post(
        f"{API}/approvals/{approval['id']}/decisions",
        json={
            "decision": "APPROVE",
            "reason": "This assertion is intentionally stale.",
            "expected_version": approval["version"],
        },
        headers=_bearer(stale_step_up),
    )

    assert denied.status_code == 403
    assert "recent step-up" in denied.json()["detail"]


class _MutableOidcClock:
    def __init__(self) -> None:
        self.value = 1_000.0

    def __call__(self) -> float:
        return self.value

    def advance_past_refresh_cooldown(self) -> None:
        self.value += OIDC_JWKS_REFRESH_COOLDOWN_SECONDS + 0.001


class _RemoteOidcJwksEndpoint:
    def __init__(self, documents: list[str | None]) -> None:
        self.documents = documents
        self.request_count = 0

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        self.request_count += 1
        await asyncio.sleep(0)
        if not self.documents:
            raise AssertionError("Unexpected additional OIDC JWKS request")
        document = self.documents.pop(0)
        if document is None:
            raise httpx.ConnectError("simulated OIDC JWKS outage", request=request)
        return httpx.Response(
            200,
            content=document.encode(),
            headers={"Content-Type": "application/json"},
            request=request,
        )


def _patch_remote_oidc_jwks(endpoint: _RemoteOidcJwksEndpoint) -> Any:
    real_async_client = httpx.AsyncClient

    def client_factory(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = httpx.MockTransport(endpoint)
        return real_async_client(*args, **kwargs)

    return patch("app.auth.httpx.AsyncClient", side_effect=client_factory)


def _remote_oidc_verifier(clock: _MutableOidcClock) -> OIDCVerifier:
    return OIDCVerifier(
        Settings(
            env="development",
            demo_mode=False,
            database_url="sqlite://",
            oidc_issuer=ISSUER,
            oidc_audience=AUDIENCE,
        ),
        monotonic_clock=clock,
    )


def _assert_authentication_errors(results: list[Any]) -> None:
    assert results
    assert all(isinstance(result, AuthenticationError) for result in results)


@pytest.mark.asyncio
async def test_sequential_unknown_oidc_keys_share_one_rotation_refresh(
    signing_key: rsa.RSAPrivateKey,
    jwks_json: str,
) -> None:
    clock = _MutableOidcClock()
    verifier = _remote_oidc_verifier(clock)
    endpoint = _RemoteOidcJwksEndpoint([jwks_json, jwks_json])
    trusted = _token(signing_key, amr=["webauthn"])
    unknown_tokens = [
        _token(signing_key, key_id=f"sequential-unknown-{index}", amr=["webauthn"])
        for index in range(8)
    ]

    with _patch_remote_oidc_jwks(endpoint):
        principal = await verifier.verify(trusted)
        clock.advance_past_refresh_cooldown()
        results: list[Any] = []
        for token in unknown_tokens:
            try:
                await verifier.verify(token)
            except AppError as error:
                results.append(error)

    assert principal.user_id == "staff-user-1"
    _assert_authentication_errors(results)
    assert endpoint.request_count == 2


@pytest.mark.asyncio
async def test_concurrent_unknown_oidc_key_spray_coalesces_one_rotation_refresh(
    signing_key: rsa.RSAPrivateKey,
    jwks_json: str,
) -> None:
    clock = _MutableOidcClock()
    verifier = _remote_oidc_verifier(clock)
    endpoint = _RemoteOidcJwksEndpoint([jwks_json, jwks_json])
    trusted = _token(signing_key, amr=["webauthn"])
    unknown_tokens = [
        _token(signing_key, key_id=f"concurrent-unknown-{index}", amr=["webauthn"])
        for index in range(16)
    ]

    with _patch_remote_oidc_jwks(endpoint):
        await verifier.verify(trusted)
        clock.advance_past_refresh_cooldown()
        results = await asyncio.gather(
            *(verifier.verify(token) for token in unknown_tokens),
            return_exceptions=True,
        )

    _assert_authentication_errors(results)
    assert endpoint.request_count == 2


@pytest.mark.asyncio
async def test_rotated_oidc_key_is_accepted_after_one_coalesced_refresh(
    signing_key: rsa.RSAPrivateKey,
    jwks_json: str,
) -> None:
    rotated_key = rsa.generate_private_key(public_exponent=65_537, key_size=2_048)
    rotated_key_id = "rotated-oidc-key"
    rotated_jwk = RSAAlgorithm.to_jwk(rotated_key.public_key(), as_dict=True)
    rotated_jwk.update({"kid": rotated_key_id, "alg": "RS256", "use": "sig"})
    rotated_document = json.dumps({"keys": [*json.loads(jwks_json)["keys"], rotated_jwk]})
    clock = _MutableOidcClock()
    verifier = _remote_oidc_verifier(clock)
    endpoint = _RemoteOidcJwksEndpoint([jwks_json, rotated_document])
    trusted = _token(signing_key, amr=["webauthn"])
    rotated = _token(
        rotated_key,
        key_id=rotated_key_id,
        subject="rotated-key-user",
        amr=["webauthn"],
    )

    with _patch_remote_oidc_jwks(endpoint):
        await verifier.verify(trusted)
        clock.advance_past_refresh_cooldown()
        results = await asyncio.gather(
            *(verifier.verify(rotated) for _ in range(8)),
            return_exceptions=True,
        )

    assert all(getattr(result, "user_id", None) == "rotated-key-user" for result in results)
    assert endpoint.request_count == 2


@pytest.mark.asyncio
async def test_failed_oidc_rotation_refresh_is_cooled_down_and_recovers(
    signing_key: rsa.RSAPrivateKey,
    jwks_json: str,
) -> None:
    clock = _MutableOidcClock()
    verifier = _remote_oidc_verifier(clock)
    endpoint = _RemoteOidcJwksEndpoint([jwks_json, None, jwks_json])
    trusted = _token(signing_key, amr=["webauthn"])
    unknown_tokens = [
        _token(signing_key, key_id=f"outage-unknown-{index}", amr=["webauthn"])
        for index in range(8)
    ]

    with _patch_remote_oidc_jwks(endpoint):
        await verifier.verify(trusted)
        clock.advance_past_refresh_cooldown()
        failed = await asyncio.gather(
            *(verifier.verify(token) for token in unknown_tokens),
            return_exceptions=True,
        )
        trusted_during_outage = await verifier.verify(trusted)
        within_cooldown = await asyncio.gather(
            verifier.verify(unknown_tokens[0]),
            return_exceptions=True,
        )
        clock.advance_past_refresh_cooldown()
        recovered = await asyncio.gather(
            verifier.verify(unknown_tokens[0]),
            return_exceptions=True,
        )

    assert all(
        isinstance(result, AppError) and result.code == "IDENTITY_PROVIDER_UNAVAILABLE"
        for result in failed
    )
    assert trusted_during_outage.user_id == "staff-user-1"
    assert (
        isinstance(within_cooldown[0], AppError)
        and within_cooldown[0].code == "IDENTITY_PROVIDER_UNAVAILABLE"
    )
    _assert_authentication_errors(recovered)
    assert endpoint.request_count == 3
