"""Firebase App Check boundary tests using local signing keys only."""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import Iterator
from typing import Any
from unittest.mock import patch

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi.testclient import TestClient
from jwt.algorithms import RSAAlgorithm
from pydantic import SecretStr, ValidationError

from app.app_check import (
    JWKS_REFRESH_COOLDOWN_SECONDS,
    MAX_UNKNOWN_KEY_CACHE_ENTRIES,
    FirebaseAppCheckVerifier,
)
from app.config import Settings
from app.database import Database
from app.errors import AppError
from app.main import create_app

API = "/api/v1"
PROJECT_NUMBER = "123456789012"
APP_CHECK_ISSUER = f"https://firebaseappcheck.googleapis.com/{PROJECT_NUMBER}"
APP_CHECK_AUDIENCE = f"projects/{PROJECT_NUMBER}"
APP_CHECK_KEY_ID = "local-app-check-key"
FIELD_APP_ID = "1:123456789012:web:local-field-app"
OIDC_ISSUER = "https://identity.example.test"
OIDC_AUDIENCE = "floodrise-staff"
OIDC_KEY_ID = "local-oidc-key"
INCIDENT_ID = "inc-demo-kerala-flood-2023"
CORS_ALLOWED_ORIGIN = "http://localhost:4174"
CORS_DISALLOWED_ORIGIN = "https://attacker.example"


@pytest.fixture(scope="module")
def app_check_signing_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65_537, key_size=2_048)


@pytest.fixture(scope="module")
def oidc_signing_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65_537, key_size=2_048)


def _jwks(key: rsa.RSAPrivateKey, key_id: str) -> str:
    jwk = RSAAlgorithm.to_jwk(key.public_key(), as_dict=True)
    jwk.update({"kid": key_id, "alg": "RS256", "use": "sig"})
    return json.dumps({"keys": [jwk]})


def _combined_jwks(*entries: tuple[rsa.RSAPrivateKey, str]) -> str:
    keys = [json.loads(_jwks(key, key_id))["keys"][0] for key, key_id in entries]
    return json.dumps({"keys": keys})


class _MutableClock:
    def __init__(self) -> None:
        self.value = 1_000.0

    def __call__(self) -> float:
        return self.value

    def advance_past_refresh_cooldown(self) -> None:
        self.value += JWKS_REFRESH_COOLDOWN_SECONDS + 0.001


class _RemoteJwksEndpoint:
    def __init__(self, documents: list[str | None]) -> None:
        self.documents = documents
        self.request_count = 0

    async def __call__(self, request: httpx.Request) -> httpx.Response:
        self.request_count += 1
        await asyncio.sleep(0)
        if not self.documents:
            raise AssertionError("Unexpected additional Firebase JWKS request")
        document = self.documents.pop(0)
        if document is None:
            raise httpx.ConnectError("simulated Firebase JWKS outage", request=request)
        return httpx.Response(
            200,
            content=document.encode(),
            headers={"Content-Type": "application/json"},
            request=request,
        )


def _patch_remote_jwks(endpoint: _RemoteJwksEndpoint) -> Any:
    real_async_client = httpx.AsyncClient

    def client_factory(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        kwargs["transport"] = httpx.MockTransport(endpoint)
        return real_async_client(*args, **kwargs)

    return patch("app.app_check.httpx.AsyncClient", side_effect=client_factory)


def _remote_verifier(clock: _MutableClock) -> FirebaseAppCheckVerifier:
    settings = Settings(
        env="development",
        demo_mode=False,
        database_url="sqlite://",
        firebase_app_check_enabled=True,
        firebase_app_check_project_number=PROJECT_NUMBER,
        firebase_app_check_app_ids=[FIELD_APP_ID],
    )
    return FirebaseAppCheckVerifier(settings, monotonic_clock=clock)


def _assert_app_check_errors(results: list[Any], expected_code: str) -> None:
    assert results
    for result in results:
        assert isinstance(result, AppError)
        assert result.code == expected_code


def _settings(
    app_check_signing_key: rsa.RSAPrivateKey,
    **overrides: Any,
) -> Settings:
    values: dict[str, Any] = {
        "env": "test",
        "demo_mode": True,
        "database_url": "sqlite://",
        "firebase_app_check_enabled": True,
        "firebase_app_check_project_number": PROJECT_NUMBER,
        "firebase_app_check_app_ids": [FIELD_APP_ID],
        "firebase_app_check_jwks_json": SecretStr(_jwks(app_check_signing_key, APP_CHECK_KEY_ID)),
    }
    values.update(overrides)
    return Settings(**values)


@pytest.fixture
def protected_client(
    app_check_signing_key: rsa.RSAPrivateKey,
) -> Iterator[TestClient]:
    database = Database("sqlite://")
    application = create_app(
        _settings(app_check_signing_key),
        database=database,
    )
    try:
        with TestClient(application, raise_server_exceptions=False) as client:
            yield client
    finally:
        database.engine.dispose()


def _app_check_token(
    signing_key: rsa.RSAPrivateKey,
    *,
    key_id: str = APP_CHECK_KEY_ID,
    app_id: str = FIELD_APP_ID,
    issuer: str = APP_CHECK_ISSUER,
    audience: str | list[str] = APP_CHECK_AUDIENCE,
    issued_at: int | None = None,
    expires_at: int | None = None,
    token_type: str = "JWT",
) -> str:
    now = int(time.time())
    return jwt.encode(
        {
            "iss": issuer,
            "aud": audience,
            "sub": app_id,
            "iat": issued_at if issued_at is not None else now,
            "exp": expires_at if expires_at is not None else now + 600,
        },
        signing_key,
        algorithm="RS256",
        headers={"kid": key_id, "typ": token_type},
    )


def _report_payload() -> dict[str, Any]:
    return {
        "client_report_id": "app-check-report-01",
        "incident_id": INCIDENT_ID,
        "reporter_id": "app-check-reporter",
        "device_id": "app-check-device",
        "observed_at": "2023-12-04T14:00:00Z",
        "location": {
            "latitude": 10.1065,
            "longitude": 76.3517,
            "accuracy_m": 20,
        },
        "water_depth": "KNEE",
        "road_status": "IMPASSABLE",
        "flood_status": "FLOODED",
    }


def _report_headers(token: str | None = None) -> dict[str, str]:
    headers = {
        "Idempotency-Key": "app-check-report-key",
        "X-Demo-User": "app-check-reporter",
        "X-Demo-Role": "reporter",
    }
    if token is not None:
        headers["X-Firebase-AppCheck"] = token
    return headers


def _assert_cors_origin(response: httpx.Response, expected_origin: str | None) -> None:
    assert response.headers.get("access-control-allow-origin") == expected_origin
    if expected_origin is not None:
        assert response.headers["access-control-allow-credentials"] == "true"


def test_demo_and_test_profiles_are_offline_and_bypass_is_explicit(
    app_check_signing_key: rsa.RSAPrivateKey,
) -> None:
    disabled = Settings(env="test", demo_mode=True, database_url="sqlite://")
    assert disabled.firebase_app_check_enabled is False

    with pytest.raises(ValidationError, match="static JWKS"):
        Settings(
            env="test",
            demo_mode=True,
            firebase_app_check_enabled=True,
            firebase_app_check_project_number=PROJECT_NUMBER,
        )

    configured = _settings(app_check_signing_key)
    assert configured.firebase_app_check_enabled is True
    assert configured.firebase_app_check_project_number == PROJECT_NUMBER


@pytest.mark.parametrize("project_number", [None, "", "project-id", "12 34"])
def test_enabled_app_check_requires_numeric_project_number(
    app_check_signing_key: rsa.RSAPrivateKey,
    project_number: str | None,
) -> None:
    with pytest.raises(ValidationError, match="numeric Google Cloud project number"):
        _settings(
            app_check_signing_key,
            firebase_app_check_project_number=project_number,
        )


@pytest.mark.parametrize("algorithms", [[], ["none"], ["HS256"], ["RS256", "HS256"]])
def test_app_check_accepts_only_firebase_rs256(
    algorithms: list[str],
) -> None:
    with pytest.raises(ValidationError, match="only RS256"):
        Settings(firebase_app_check_algorithms=algorithms)


def test_jwks_cache_ttl_is_bounded_to_six_hours() -> None:
    assert Settings(firebase_app_check_jwks_cache_seconds=21_600)
    with pytest.raises(ValidationError):
        Settings(firebase_app_check_jwks_cache_seconds=21_601)


def test_staging_app_check_requires_an_explicit_app_id_allow_list(
    app_check_signing_key: rsa.RSAPrivateKey,
) -> None:
    with pytest.raises(ValidationError, match="firebase_app_check_app_ids"):
        Settings(
            env="staging",
            demo_mode=False,
            database_url=("postgresql+psycopg://database.invalid/floodrise?sslmode=require"),
            database_allowed_host="database.invalid",
            oidc_issuer=OIDC_ISSUER,
            oidc_audience=OIDC_AUDIENCE,
            oidc_jwks_json=SecretStr(_jwks(app_check_signing_key, OIDC_KEY_ID)),
            session_secret=SecretStr("app-check-staging-validation-secret"),
            firebase_app_check_enabled=True,
            firebase_app_check_project_number=PROJECT_NUMBER,
            firebase_app_check_jwks_json=SecretStr(_jwks(app_check_signing_key, APP_CHECK_KEY_ID)),
        )


def test_disabled_profile_preserves_offline_flow_and_production_openapi_contract() -> None:
    database = Database("sqlite://")
    application = create_app(
        Settings(env="test", demo_mode=True, database_url="sqlite://"),
        database=database,
    )
    try:
        with TestClient(application, raise_server_exceptions=False) as client:
            response = client.post(
                f"{API}/reports",
                json=_report_payload(),
                headers=_report_headers(),
            )
            report_operation = client.get(f"{API}/openapi.json").json()["paths"][f"{API}/reports"][
                "post"
            ]
        assert response.status_code == 201
        parameters = {
            parameter["name"].lower(): parameter
            for parameter in report_operation.get("parameters", [])
        }
        app_check_parameter = parameters["x-firebase-appcheck"]
        assert app_check_parameter["required"] is True
        assert "isolated local demo" in app_check_parameter["description"]
    finally:
        database.engine.dispose()


def test_missing_app_check_is_rejected_before_report_or_media_ingestion(
    protected_client: TestClient,
) -> None:
    report = protected_client.post(
        f"{API}/reports",
        json=_report_payload(),
        headers=_report_headers(),
    )
    media = protected_client.post(
        f"{API}/media/uploads",
        json={},
        headers={
            "Idempotency-Key": "app-check-media-key",
            "X-Demo-User": "app-check-reporter",
            "X-Demo-Role": "reporter",
        },
    )

    assert report.status_code == media.status_code == 401
    assert report.headers["content-type"].startswith("application/problem+json")
    assert report.json()["code"] == "APP_CHECK_REQUIRED"
    assert media.json()["code"] == "APP_CHECK_REQUIRED"
    assert "www-authenticate" not in report.headers


@pytest.mark.parametrize(
    ("token", "expected_code"),
    [
        pytest.param(None, "APP_CHECK_REQUIRED", id="missing"),
        pytest.param("not-a-jwt", "APP_CHECK_INVALID", id="invalid"),
    ],
)
@pytest.mark.parametrize(
    ("origin", "expected_allow_origin"),
    [
        pytest.param(CORS_ALLOWED_ORIGIN, CORS_ALLOWED_ORIGIN, id="allowed-origin"),
        pytest.param(CORS_DISALLOWED_ORIGIN, None, id="disallowed-origin"),
    ],
)
def test_app_check_401_responses_apply_strict_cors_without_reaching_report_route(
    protected_client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    token: str | None,
    expected_code: str,
    origin: str,
    expected_allow_origin: str | None,
) -> None:
    route_calls = 0

    def fail_if_report_route_runs(*_args: Any, **_kwargs: Any) -> None:
        nonlocal route_calls
        route_calls += 1
        raise AssertionError("failed App Check requests must not reach the report route")

    monkeypatch.setattr(
        type(protected_client.app.state.service),
        "create_report",
        fail_if_report_route_runs,
    )
    headers = _report_headers(token)
    headers["Origin"] = origin

    response = protected_client.post(
        f"{API}/reports",
        json=_report_payload(),
        headers=headers,
    )

    assert response.status_code == 401
    assert response.json()["code"] == expected_code
    _assert_cors_origin(response, expected_allow_origin)
    assert route_calls == 0
    assert protected_client.app.state.database.list("report") == []


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("post", f"{API}/simulations"),
        ("post", f"{API}/routes/recommend"),
        ("post", f"{API}/approvals"),
        ("patch", f"{API}/shelters/shelter-demo-01"),
        ("delete", f"{API}/reports/not-present"),
        ("get", f"{API}/events?incident_id={INCIDENT_ID}"),
    ],
)
def test_all_api_mutations_and_event_stream_require_app_check(
    protected_client: TestClient,
    method: str,
    path: str,
) -> None:
    response = protected_client.request(
        method,
        path,
        json={},
        headers={
            "X-Demo-User": "app-check-responder",
            "X-Demo-Role": "responder",
        },
    )

    assert response.status_code == 401
    assert response.json()["code"] == "APP_CHECK_REQUIRED"


def test_valid_static_jwks_token_allows_report_without_network(
    protected_client: TestClient,
    app_check_signing_key: rsa.RSAPrivateKey,
) -> None:
    token = _app_check_token(app_check_signing_key)

    with patch(
        "app.app_check.httpx.AsyncClient",
        side_effect=AssertionError("static App Check verification must remain offline"),
    ):
        response = protected_client.post(
            f"{API}/reports",
            json=_report_payload(),
            headers=_report_headers(token),
        )

    assert response.status_code == 201
    assert response.json()["report"]["identity_protected"] is True


def test_audience_array_is_accepted(
    protected_client: TestClient,
    app_check_signing_key: rsa.RSAPrivateKey,
) -> None:
    token = _app_check_token(
        app_check_signing_key,
        audience=[APP_CHECK_AUDIENCE, "projects/non-authoritative-alias"],
    )

    response = protected_client.post(
        f"{API}/reports",
        json={**_report_payload(), "client_report_id": "app-check-report-audience-list"},
        headers={
            **_report_headers(token),
            "Idempotency-Key": "app-check-report-audience-list",
        },
    )

    assert response.status_code == 201


@pytest.mark.parametrize(
    ("token_factory", "expected_code"),
    [
        (
            lambda key, _other: _app_check_token(
                key,
                issuer="https://firebaseappcheck.googleapis.com/999999999999",
            ),
            "APP_CHECK_INVALID",
        ),
        (
            lambda key, _other: _app_check_token(
                key,
                audience="projects/999999999999",
            ),
            "APP_CHECK_INVALID",
        ),
        (
            lambda key, _other: _app_check_token(
                key,
                issued_at=int(time.time()) - 700,
                expires_at=int(time.time()) - 100,
            ),
            "APP_CHECK_INVALID",
        ),
        (
            lambda _key, other: _app_check_token(other),
            "APP_CHECK_INVALID",
        ),
        (
            lambda key, _other: _app_check_token(key, key_id="untrusted-key"),
            "APP_CHECK_INVALID",
        ),
        (
            lambda key, _other: _app_check_token(key, token_type="not-a-jwt"),
            "APP_CHECK_INVALID",
        ),
        (
            lambda key, _other: _app_check_token(
                key,
                app_id="1:123456789012:web:unregistered-app",
            ),
            "APP_CHECK_INVALID",
        ),
    ],
)
def test_invalid_signature_issuer_audience_expiry_key_and_type_are_rejected(
    protected_client: TestClient,
    app_check_signing_key: rsa.RSAPrivateKey,
    token_factory: Any,
    expected_code: str,
) -> None:
    other_key = rsa.generate_private_key(public_exponent=65_537, key_size=2_048)
    token = token_factory(app_check_signing_key, other_key)

    response = protected_client.post(
        f"{API}/reports",
        json=_report_payload(),
        headers=_report_headers(token),
    )

    assert response.status_code == 401
    assert response.json()["code"] == expected_code
    assert token not in response.text


def test_health_docs_openapi_reads_and_preflight_remain_reachable(
    protected_client: TestClient,
) -> None:
    health = protected_client.get("/health")
    api_health = protected_client.get(f"{API}/health")
    readiness = protected_client.get("/ready")
    api_readiness = protected_client.get(f"{API}/ready")
    docs = protected_client.get("/docs")
    openapi = protected_client.get(f"{API}/openapi.json")
    incidents = protected_client.get(f"{API}/incidents")
    assert health.status_code == api_health.status_code == 200
    assert readiness.status_code == api_readiness.status_code == 200
    assert readiness.json()["status"] == "ready"
    assert docs.status_code == openapi.status_code == incidents.status_code == 200


@pytest.mark.parametrize(
    ("origin", "expected_status", "expected_allow_origin"),
    [
        pytest.param(CORS_ALLOWED_ORIGIN, 200, CORS_ALLOWED_ORIGIN, id="allowed-origin"),
        pytest.param(CORS_DISALLOWED_ORIGIN, 400, None, id="disallowed-origin"),
    ],
)
def test_app_check_preflight_applies_strict_cors_without_entering_verifier(
    protected_client: TestClient,
    origin: str,
    expected_status: int,
    expected_allow_origin: str | None,
) -> None:
    with patch.object(
        protected_client.app.state.firebase_app_check_verifier,
        "verify",
        side_effect=AssertionError("CORS preflight must not enter App Check verification"),
    ):
        preflight = protected_client.options(
            f"{API}/reports",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "POST",
                "Access-Control-Request-Headers": "x-firebase-appcheck,idempotency-key",
            },
        )

    assert preflight.status_code == expected_status
    _assert_cors_origin(preflight, expected_allow_origin)
    assert "x-firebase-appcheck" in preflight.headers["access-control-allow-headers"].lower()


@pytest.mark.asyncio
async def test_cold_unknown_key_loads_remote_jwks_once_without_double_refresh(
    app_check_signing_key: rsa.RSAPrivateKey,
) -> None:
    clock = _MutableClock()
    verifier = _remote_verifier(clock)
    endpoint = _RemoteJwksEndpoint([_jwks(app_check_signing_key, APP_CHECK_KEY_ID)])
    unknown_token = _app_check_token(app_check_signing_key, key_id="cold-unknown-key")

    with _patch_remote_jwks(endpoint):
        results = await asyncio.gather(
            *(verifier.verify(unknown_token) for _ in range(8)),
            return_exceptions=True,
        )

    _assert_app_check_errors(results, "APP_CHECK_INVALID")
    assert endpoint.request_count == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("distinct_key_ids", [False, True], ids=["same-kid", "different-kids"])
async def test_concurrent_unknown_key_spray_coalesces_one_rotation_refresh(
    app_check_signing_key: rsa.RSAPrivateKey,
    distinct_key_ids: bool,
) -> None:
    clock = _MutableClock()
    verifier = _remote_verifier(clock)
    endpoint = _RemoteJwksEndpoint(
        [
            _jwks(app_check_signing_key, APP_CHECK_KEY_ID),
            _jwks(app_check_signing_key, APP_CHECK_KEY_ID),
        ]
    )
    trusted_token = _app_check_token(app_check_signing_key)
    key_ids = (
        [f"unknown-spray-{index}" for index in range(12)]
        if distinct_key_ids
        else ["unknown-spray"] * 12
    )
    tokens = [_app_check_token(app_check_signing_key, key_id=key_id) for key_id in key_ids]

    with _patch_remote_jwks(endpoint):
        trusted = await verifier.verify(trusted_token)
        clock.advance_past_refresh_cooldown()
        results = await asyncio.gather(
            *(verifier.verify(token) for token in tokens),
            return_exceptions=True,
        )
        repeated = await asyncio.gather(
            verifier.verify(tokens[0]),
            verifier.verify(_app_check_token(app_check_signing_key, key_id="another-unknown-key")),
            return_exceptions=True,
        )

    assert trusted.app_id == FIELD_APP_ID
    _assert_app_check_errors(results, "APP_CHECK_INVALID")
    _assert_app_check_errors(repeated, "APP_CHECK_INVALID")
    assert endpoint.request_count == 2


@pytest.mark.asyncio
async def test_rotated_key_is_accepted_after_one_coalesced_refresh(
    app_check_signing_key: rsa.RSAPrivateKey,
) -> None:
    rotated_key = rsa.generate_private_key(public_exponent=65_537, key_size=2_048)
    rotated_key_id = "rotated-app-check-key"
    clock = _MutableClock()
    verifier = _remote_verifier(clock)
    endpoint = _RemoteJwksEndpoint(
        [
            _jwks(app_check_signing_key, APP_CHECK_KEY_ID),
            _combined_jwks(
                (app_check_signing_key, APP_CHECK_KEY_ID),
                (rotated_key, rotated_key_id),
            ),
        ]
    )
    trusted_token = _app_check_token(app_check_signing_key)
    rotated_token = _app_check_token(rotated_key, key_id=rotated_key_id)

    with _patch_remote_jwks(endpoint):
        await verifier.verify(trusted_token)
        clock.advance_past_refresh_cooldown()
        results = await asyncio.gather(
            *(verifier.verify(rotated_token) for _ in range(8)),
            return_exceptions=True,
        )

    assert all(getattr(result, "app_id", None) == FIELD_APP_ID for result in results)
    assert endpoint.request_count == 2


@pytest.mark.asyncio
async def test_failed_rotation_refresh_is_cooled_down_and_recovers(
    app_check_signing_key: rsa.RSAPrivateKey,
) -> None:
    clock = _MutableClock()
    verifier = _remote_verifier(clock)
    trusted_document = _jwks(app_check_signing_key, APP_CHECK_KEY_ID)
    endpoint = _RemoteJwksEndpoint([trusted_document, None, trusted_document])
    trusted_token = _app_check_token(app_check_signing_key)
    unknown_tokens = [
        _app_check_token(app_check_signing_key, key_id=f"outage-key-{index}") for index in range(8)
    ]

    with _patch_remote_jwks(endpoint):
        await verifier.verify(trusted_token)
        clock.advance_past_refresh_cooldown()
        failed = await asyncio.gather(
            *(verifier.verify(token) for token in unknown_tokens),
            return_exceptions=True,
        )
        trusted_during_outage = await verifier.verify(trusted_token)
        within_cooldown = await asyncio.gather(
            verifier.verify(unknown_tokens[0]),
            return_exceptions=True,
        )
        clock.advance_past_refresh_cooldown()
        recovered = await asyncio.gather(
            verifier.verify(unknown_tokens[0]),
            return_exceptions=True,
        )

    _assert_app_check_errors(failed, "APP_CHECK_UNAVAILABLE")
    assert trusted_during_outage.app_id == FIELD_APP_ID
    _assert_app_check_errors(within_cooldown, "APP_CHECK_UNAVAILABLE")
    _assert_app_check_errors(recovered, "APP_CHECK_INVALID")
    assert endpoint.request_count == 3


@pytest.mark.asyncio
async def test_unknown_key_cache_is_bounded_and_hashes_attacker_key_ids(
    app_check_signing_key: rsa.RSAPrivateKey,
) -> None:
    clock = _MutableClock()
    verifier = _remote_verifier(clock)
    endpoint = _RemoteJwksEndpoint([_jwks(app_check_signing_key, APP_CHECK_KEY_ID)])
    key_ids = [
        f"attacker-controlled-key-{index}" for index in range(MAX_UNKNOWN_KEY_CACHE_ENTRIES + 32)
    ]
    tokens = [_app_check_token(app_check_signing_key, key_id=key_id) for key_id in key_ids]

    with _patch_remote_jwks(endpoint):
        results = await asyncio.gather(
            *(verifier.verify(token) for token in tokens),
            return_exceptions=True,
        )

    _assert_app_check_errors(results, "APP_CHECK_INVALID")
    assert endpoint.request_count == 1
    assert len(verifier._unknown_key_ids) == MAX_UNKNOWN_KEY_CACHE_ENTRIES
    assert all(
        isinstance(cache_key, bytes) and len(cache_key) == 32
        for cache_key in verifier._unknown_key_ids
    )
    assert not any(key_id in verifier._unknown_key_ids for key_id in key_ids)


@pytest.mark.parametrize(
    ("origin", "expected_allow_origin"),
    [
        pytest.param(CORS_ALLOWED_ORIGIN, CORS_ALLOWED_ORIGIN, id="allowed-origin"),
        pytest.param(CORS_DISALLOWED_ORIGIN, None, id="disallowed-origin"),
    ],
)
def test_remote_key_failure_is_fail_closed_with_strict_cors_without_reaching_route(
    app_check_signing_key: rsa.RSAPrivateKey,
    origin: str,
    expected_allow_origin: str | None,
) -> None:
    settings = Settings(
        env="development",
        demo_mode=False,
        database_url="sqlite://",
        firebase_app_check_enabled=True,
        firebase_app_check_project_number=PROJECT_NUMBER,
        firebase_app_check_app_ids=[FIELD_APP_ID],
    )
    database = Database("sqlite://")
    application = create_app(settings, database=database)
    token = _app_check_token(app_check_signing_key)
    route_reached = False

    @application.post(f"{API}/cors-verifier-probe")
    async def cors_verifier_probe() -> dict[str, bool]:
        nonlocal route_reached
        route_reached = True
        return {"reached": True}

    try:
        with (
            patch(
                "app.app_check.httpx.AsyncClient",
                side_effect=httpx.ConnectError("offline test"),
            ),
            TestClient(application, raise_server_exceptions=False) as client,
        ):
            response = client.post(
                f"{API}/cors-verifier-probe",
                headers={
                    "Origin": origin,
                    "X-Firebase-AppCheck": token,
                },
            )
    finally:
        database.engine.dispose()

    assert response.status_code == 503
    assert response.json()["code"] == "APP_CHECK_UNAVAILABLE"
    assert token not in response.text
    _assert_cors_origin(response, expected_allow_origin)
    assert route_reached is False


def test_malformed_trusted_key_is_reported_as_verification_unavailable(
    app_check_signing_key: rsa.RSAPrivateKey,
) -> None:
    settings = _settings(
        app_check_signing_key,
        firebase_app_check_jwks_json=SecretStr(
            json.dumps(
                {
                    "keys": [
                        {
                            "kid": APP_CHECK_KEY_ID,
                            "alg": "RS256",
                            "use": "sig",
                        }
                    ]
                }
            )
        ),
    )
    database = Database("sqlite://")
    application = create_app(settings, database=database)
    try:
        with TestClient(application, raise_server_exceptions=False) as client:
            response = client.post(
                f"{API}/demo/reset",
                headers={"X-Firebase-AppCheck": _app_check_token(app_check_signing_key)},
            )
    finally:
        database.engine.dispose()

    assert response.status_code == 503
    assert response.json()["code"] == "APP_CHECK_UNAVAILABLE"


def test_openapi_marks_all_mutations_and_events_as_app_check_protected(
    protected_client: TestClient,
) -> None:
    paths = protected_client.get(f"{API}/openapi.json").json()["paths"]

    protected_operations = [
        paths[f"{API}/reports"]["post"],
        paths[f"{API}/media/uploads"]["post"],
        paths[f"{API}/media/uploads/{{upload_id}}/content"]["put"],
        paths[f"{API}/media/uploads/{{upload_id}}/complete"]["post"],
        paths[f"{API}/simulations"]["post"],
        paths[f"{API}/routes/recommend"]["post"],
        paths[f"{API}/shelters/{{shelter_id}}"]["patch"],
        paths[f"{API}/approvals"]["post"],
        paths[f"{API}/events"]["get"],
    ]
    for operation in protected_operations:
        parameters = {
            parameter["name"].lower(): parameter for parameter in operation.get("parameters", [])
        }
        assert "x-firebase-appcheck" in parameters
        assert parameters["x-firebase-appcheck"]["required"] is True

    audit_parameters = {
        parameter["name"].lower()
        for parameter in paths[f"{API}/audit"]["get"].get("parameters", [])
    }
    assert "x-firebase-appcheck" not in audit_parameters


def test_staff_bearer_auth_remains_independent_of_app_check(
    app_check_signing_key: rsa.RSAPrivateKey,
    oidc_signing_key: rsa.RSAPrivateKey,
) -> None:
    oidc_jwks = _jwks(oidc_signing_key, OIDC_KEY_ID)
    settings = Settings(
        env="staging",
        demo_mode=False,
        database_url="postgresql+psycopg://database.invalid/floodrise?sslmode=require",
        database_allowed_host="database.invalid",
        oidc_issuer=OIDC_ISSUER,
        oidc_audience=OIDC_AUDIENCE,
        oidc_jwks_json=SecretStr(oidc_jwks),
        session_secret=SecretStr("app-check-staging-test-session-secret"),
        firebase_app_check_enabled=True,
        firebase_app_check_project_number=PROJECT_NUMBER,
        firebase_app_check_app_ids=[FIELD_APP_ID],
        firebase_app_check_jwks_json=SecretStr(_jwks(app_check_signing_key, APP_CHECK_KEY_ID)),
    )
    database = Database("sqlite://")
    application = create_app(settings, database=database)
    now = int(time.time())
    staff_token = jwt.encode(
        {
            "iss": OIDC_ISSUER,
            "sub": "app-check-auditor",
            "iat": now,
            "exp": now + 600,
            "auth_time": now,
            "aud": OIDC_AUDIENCE,
            "roles": ["auditor"],
            "amr": ["webauthn"],
        },
        oidc_signing_key,
        algorithm="RS256",
        headers={"kid": OIDC_KEY_ID},
    )
    try:
        with TestClient(application, raise_server_exceptions=False) as client:
            authorized = client.get(
                f"{API}/audit",
                headers={"Authorization": f"Bearer {staff_token}"},
            )
            invalid = client.get(
                f"{API}/audit",
                headers={"Authorization": "Bearer invalid"},
            )
            app_integrity_without_identity = client.post(
                f"{API}/demo/reset",
                headers={"X-Firebase-AppCheck": _app_check_token(app_check_signing_key)},
            )
    finally:
        database.engine.dispose()

    assert authorized.status_code == 200
    assert authorized.json()["chain_valid"] is True
    assert invalid.status_code == 401
    assert invalid.json()["code"] == "AUTHENTICATION_REQUIRED"
    assert app_integrity_without_identity.status_code == 401
    assert app_integrity_without_identity.json()["code"] == "AUTHENTICATION_REQUIRED"


def test_invalid_static_jwks_fails_at_application_construction(
    app_check_signing_key: rsa.RSAPrivateKey,
) -> None:
    settings = _settings(
        app_check_signing_key,
        firebase_app_check_jwks_json=SecretStr('{"keys": []}'),
    )

    with pytest.raises(ValueError, match="no keyed public keys"):
        create_app(settings, database=Database("sqlite://"))
