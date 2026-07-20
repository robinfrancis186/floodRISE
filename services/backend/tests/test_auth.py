"""Production authentication boundary tests using an entirely local JWKS."""

from __future__ import annotations

import json
import time
from collections.abc import Iterator
from typing import Any
from unittest.mock import patch

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from jwt.algorithms import RSAAlgorithm
from pydantic import SecretStr, ValidationError

from app.auth import Principal, audit_actor_id
from app.config import Settings
from app.database import Database
from app.main import create_app

API = "/api/v1"
INCIDENT_ID = "inc-demo-kerala-flood-2023"
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
    settings = Settings(
        env="staging",
        demo_mode=False,
        database_url="sqlite://",
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
        headers={"kid": KEY_ID},
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


def test_static_jwks_validates_signature_audience_and_role_without_network(
    production_client: TestClient,
    signing_key: rsa.RSAPrivateKey,
) -> None:
    valid = _token(signing_key, roles=["auditor"])
    wrong_audience = _token(signing_key, audience="different-client")
    unsupported_role = _token(signing_key, roles=["unmapped-superuser"])

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


def test_high_impact_decision_requires_recent_phishing_resistant_step_up(
    production_client: TestClient,
    signing_key: rsa.RSAPrivateKey,
) -> None:
    requester_token = _token(
        signing_key,
        subject="requester",
        roles=["incident-commander"],
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
    requester_token = _token(signing_key, subject="requester-2", roles=["responder"])
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
