from __future__ import annotations

from collections.abc import Mapping
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import uuid4

import pytest

from app.database import Database
from app.notifications import (
    DatabaseDeliveryDeduplicator,
    DeliveryAttemptPhase,
    DeliveryClaimState,
    DeliveryReconciliation,
    DeliveryStatus,
    DemoLogNotificationGateway,
    DisabledNotificationGateway,
    FcmHttpV1NotificationGateway,
    InMemoryDeliveryDeduplicator,
    NotificationConfigurationError,
    NotificationEnvelope,
    NotificationGatewayConfig,
    OptInDeviceTarget,
    create_notification_gateway,
)


class StubResponse:
    def __init__(self, status_code: int, body: Any) -> None:
        self.status_code = status_code
        self._body = body

    def json(self) -> Any:
        return self._body


class RecordingHttpClient:
    def __init__(
        self,
        response: StubResponse | None = None,
        error: Exception | None = None,
    ) -> None:
        self.response = response or StubResponse(
            200,
            {"name": "projects/floodrise-prod/messages/0:message-id"},
        )
        self.error = error
        self.calls: list[dict[str, Any]] = []

    def post(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        json: Mapping[str, Any],
        timeout: float,
    ) -> StubResponse:
        self.calls.append(
            {
                "url": url,
                "headers": dict(headers),
                "json": json,
                "timeout": timeout,
            }
        )
        if self.error is not None:
            raise self.error
        return self.response


class MutableClock:
    def __init__(self, value: datetime) -> None:
        self.value = value

    def __call__(self) -> datetime:
        return self.value

    def advance(self, delta: timedelta) -> None:
        self.value += delta


class CrashAtSendBoundaryClient(RecordingHttpClient):
    def post(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        json: Mapping[str, Any],
        timeout: float,
    ) -> StubResponse:
        super().post(url, headers=headers, json=json, timeout=timeout)
        raise SystemExit("simulated process crash after entering the send boundary")


def event_id() -> str:
    return f"evt-{uuid4()}"


def envelope(*, outbox_event_id: str | None = None) -> NotificationEnvelope:
    return NotificationEnvelope(
        event_id=outbox_event_id or event_id(),
        alert_id="alert-approval-123",
        incident_id="inc-kerala-2023",
        title="Flood caution",
        body="Use the marked lower-risk route and follow responder instructions.",
        official=False,
        deep_link="/field/alerts/alert-approval-123",
        ttl_seconds=900,
    )


def target(
    *,
    opted_in: bool = True,
    device_token: str = "secret-device-token",
) -> OptInDeviceTarget:
    return OptInDeviceTarget(
        device_token=device_token,
        opted_in=opted_in,
        consent_reference="consent-receipt-private-123" if opted_in else "",
    )


def persistent_deduplicator(
    database_url: str = "sqlite://",
    *,
    clock: MutableClock | None = None,
    pre_send_lease: timedelta = timedelta(seconds=30),
) -> DatabaseDeliveryDeduplicator:
    database = Database(database_url)
    database.initialize()
    return DatabaseDeliveryDeduplicator(
        database,
        clock=clock,
        pre_send_lease=pre_send_lease,
    )


def fcm_config(**overrides: Any) -> NotificationGatewayConfig:
    values: dict[str, Any] = {
        "environment": "production",
        "mode": "fcm",
        "demo_mode": False,
        "external_delivery_enabled": True,
        "authority_activation_reference": "AUTHORITY/ORDER/2026-0001",
        "firebase_project_id": "floodrise-prod",
        "timeout_seconds": 2.5,
    }
    values.update(overrides)
    return NotificationGatewayConfig(**values)


@pytest.mark.parametrize("environment", ["demo", "development", "test", "staging"])
def test_fcm_is_hard_disabled_outside_production_without_network(
    environment: str,
) -> None:
    client = RecordingHttpClient()
    token_calls = 0

    def token_provider() -> str:
        nonlocal token_calls
        token_calls += 1
        return "secret-access-token"

    with pytest.raises(
        NotificationConfigurationError,
        match="forbidden outside non-demo production",
    ):
        create_notification_gateway(
            fcm_config(environment=environment, demo_mode=environment == "demo"),
            access_token_provider=token_provider,
            http_client=client,
        )

    assert client.calls == []
    assert token_calls == 0


@pytest.mark.parametrize(
    ("changes", "message"),
    [
        ({"external_delivery_enabled": False}, "explicit activation"),
        ({"authority_activation_reference": None}, "authority activation reference"),
        ({"authority_activation_reference": "short"}, "authority activation reference"),
        ({"firebase_project_id": None}, "Firebase project ID"),
        ({"timeout_seconds": 10.1}, "timeout"),
    ],
)
def test_fcm_requires_explicit_bounded_production_activation(
    changes: dict[str, Any],
    message: str,
) -> None:
    with pytest.raises(NotificationConfigurationError, match=message):
        create_notification_gateway(
            fcm_config(**changes),
            access_token_provider=lambda: "token",
            http_client=RecordingHttpClient(),
        )


def test_disabled_and_demo_gateways_never_call_injected_network() -> None:
    client = RecordingHttpClient()
    token_calls = 0

    def token_provider() -> str:
        nonlocal token_calls
        token_calls += 1
        return "secret-access-token"

    disabled = create_notification_gateway(
        NotificationGatewayConfig(environment="staging", mode="disabled", demo_mode=False),
        access_token_provider=token_provider,
        http_client=client,
    )
    demo = create_notification_gateway(
        NotificationGatewayConfig(environment="demo", mode="demo_log"),
        access_token_provider=token_provider,
        http_client=client,
    )

    assert disabled.deliver(envelope(), target()).status is DeliveryStatus.SUPPRESSED
    assert demo.deliver(envelope(), target()).status is DeliveryStatus.DEMO_RECORDED
    assert client.calls == []
    assert token_calls == 0


def test_demo_log_is_token_free_opt_in_only_and_idempotent() -> None:
    gateway = DemoLogNotificationGateway()
    message = envelope()

    suppressed = gateway.deliver(message, target(opted_in=False))
    first = gateway.deliver(message, target())
    duplicate = gateway.deliver(message, target())

    assert suppressed.status is DeliveryStatus.SUPPRESSED
    assert suppressed.failure_code == "TARGET_NOT_OPTED_IN"
    assert first.status is DeliveryStatus.DEMO_RECORDED
    assert duplicate.status is DeliveryStatus.DUPLICATE
    assert duplicate.failure_code == "DUPLICATE_DELIVERY"
    assert len(gateway.records) == 1
    serialized = repr(gateway.records) + repr(asdict(gateway.records[0]))
    assert "secret-device-token" not in serialized
    assert "consent-receipt-private-123" not in serialized


def test_fcm_requires_injected_persistent_deduplication_before_activation() -> None:
    client = RecordingHttpClient()
    for deduplicator in (None, InMemoryDeliveryDeduplicator()):
        with pytest.raises(
            NotificationConfigurationError,
            match="persistent atomic delivery deduplicator",
        ):
            create_notification_gateway(
                fcm_config(),
                access_token_provider=lambda: "secret-access-token",
                http_client=client,
                deduplicator=deduplicator,
            )

    with pytest.raises(
        NotificationConfigurationError,
        match="persistent atomic delivery deduplicator",
    ):
        FcmHttpV1NotificationGateway(
            fcm_config(),
            access_token_provider=lambda: "secret-access-token",
            http_client=client,
            deduplicator=InMemoryDeliveryDeduplicator(),
        )

    assert client.calls == []


def test_fcm_sends_one_opted_in_token_with_target_bound_safe_payload() -> None:
    client = RecordingHttpClient()
    token_calls = 0

    def token_provider() -> str:
        nonlocal token_calls
        token_calls += 1
        return "secret-access-token"

    message = envelope()
    gateway = create_notification_gateway(
        fcm_config(),
        access_token_provider=token_provider,
        http_client=client,
        deduplicator=persistent_deduplicator(),
    )

    result = gateway.deliver(message, target())

    assert result.status is DeliveryStatus.SENT
    assert result.event_id == message.event_id
    assert result.idempotency_key.startswith(f"{message.event_id}:target:")
    assert "secret-device-token" not in result.idempotency_key
    assert result.provider_reference == "projects/floodrise-prod/messages/0:message-id"
    assert token_calls == 1
    assert len(client.calls) == 1
    call = client.calls[0]
    assert call["url"] == ("https://fcm.googleapis.com/v1/projects/floodrise-prod/messages:send")
    assert call["timeout"] == 2.5
    assert call["headers"]["X-FloodRISE-Event-ID"] == message.event_id
    assert call["headers"]["X-FloodRISE-Idempotency-Key"] == result.idempotency_key
    assert call["headers"]["Authorization"] == "Bearer secret-access-token"

    fcm_message = call["json"]["message"]
    assert fcm_message["token"] == "secret-device-token"
    assert "topic" not in fcm_message
    assert "condition" not in fcm_message
    assert set(fcm_message) == {"token", "notification", "data", "webpush"}
    assert fcm_message["data"] == {
        "event_id": message.event_id,
        "idempotency_key": result.idempotency_key,
        "alert_id": "alert-approval-123",
        "incident_id": "inc-kerala-2023",
        "official": "false",
        "deep_link": "/field/alerts/alert-approval-123",
    }
    assert fcm_message["webpush"]["notification"] == {
        "tag": result.idempotency_key,
        "renotify": False,
    }
    payload_text = repr(call["json"])
    assert "consent-receipt-private-123" not in payload_text
    assert "user_id" not in payload_text
    assert "audience" not in payload_text


def test_fcm_suppresses_non_opted_in_target_before_credentials_or_network() -> None:
    client = RecordingHttpClient()
    token_calls = 0

    def token_provider() -> str:
        nonlocal token_calls
        token_calls += 1
        return "secret-access-token"

    gateway = create_notification_gateway(
        fcm_config(),
        access_token_provider=token_provider,
        http_client=client,
        deduplicator=persistent_deduplicator(),
    )

    result = gateway.deliver(envelope(), target(opted_in=False))

    assert result.status is DeliveryStatus.SUPPRESSED
    assert result.failure_code == "TARGET_NOT_OPTED_IN"
    assert result.attempted is False
    assert token_calls == 0
    assert client.calls == []


def test_fcm_duplicate_prevention_uses_exact_event_and_target() -> None:
    client = RecordingHttpClient()
    gateway = create_notification_gateway(
        fcm_config(),
        access_token_provider=lambda: "secret-access-token",
        http_client=client,
        deduplicator=persistent_deduplicator(),
    )
    message = envelope()

    first = gateway.deliver(message, target())
    duplicate = gateway.deliver(message, target())

    assert first.status is DeliveryStatus.SENT
    assert duplicate.status is DeliveryStatus.DUPLICATE
    assert duplicate.event_id == message.event_id
    assert duplicate.idempotency_key == first.idempotency_key
    assert duplicate.failure_code == "DUPLICATE_DELIVERY"
    assert len(client.calls) == 1


def test_persistent_deduplication_survives_gateway_and_database_replacement(
    tmp_path: Path,
) -> None:
    database_url = f"sqlite:///{tmp_path / 'notification-delivery.sqlite3'}"
    first_client = RecordingHttpClient()
    second_client = RecordingHttpClient()
    first_gateway = create_notification_gateway(
        fcm_config(),
        access_token_provider=lambda: "secret-access-token",
        http_client=first_client,
        deduplicator=persistent_deduplicator(database_url),
    )
    second_gateway = create_notification_gateway(
        fcm_config(),
        access_token_provider=lambda: "secret-access-token",
        http_client=second_client,
        deduplicator=persistent_deduplicator(database_url),
    )
    message = envelope()
    device = target()

    first = first_gateway.deliver(message, device)
    replay = second_gateway.deliver(message, device)

    assert first.status is DeliveryStatus.SENT
    assert replay.status is DeliveryStatus.DUPLICATE
    assert replay.idempotency_key == first.idempotency_key
    assert len(first_client.calls) == 1
    assert second_client.calls == []


def test_abandoned_pre_send_claim_is_reclaimed_after_bounded_lease_across_instances(
    tmp_path: Path,
) -> None:
    database_url = f"sqlite:///{tmp_path / 'pre-send-lease.sqlite3'}"
    clock = MutableClock(datetime(2026, 7, 30, 8, 0, tzinfo=UTC))
    first = persistent_deduplicator(
        database_url,
        clock=clock,
        pre_send_lease=timedelta(seconds=30),
    )
    second = persistent_deduplicator(
        database_url,
        clock=clock,
        pre_send_lease=timedelta(seconds=30),
    )
    message = envelope()
    device = target()
    delivery_key = message.delivery_idempotency_key(device)

    abandoned_attempt = first.claim(delivery_key)

    assert abandoned_attempt is not None
    assert second.claim(delivery_key) is None
    clock.advance(timedelta(seconds=29))
    assert second.claim(delivery_key) is None

    clock.advance(timedelta(seconds=1))
    recovered_attempt = second.claim(delivery_key)

    assert recovered_attempt is not None
    assert recovered_attempt != abandoned_attempt
    assert second.state(delivery_key) is DeliveryClaimState.IN_FLIGHT
    with pytest.raises(RuntimeError, match="current delivery attempt"):
        first.mark_send_boundary(delivery_key, abandoned_attempt)

    second.mark_send_boundary(delivery_key, recovered_attempt)

    assert second.state(delivery_key) is DeliveryClaimState.UNKNOWN_AFTER_SEND
    record = second.record(delivery_key)
    assert record is not None
    assert record["phase"] == DeliveryAttemptPhase.SEND_BOUNDARY
    assert record["attempt_started_at"] == "2026-07-30T08:00:30Z"
    assert record["send_boundary_at"] == "2026-07-30T08:00:30Z"
    assert record["pre_send_lease_expires_at"] is None


def test_crash_after_send_boundary_never_auto_retries_after_lease(
    tmp_path: Path,
) -> None:
    database_url = f"sqlite:///{tmp_path / 'send-boundary-crash.sqlite3'}"
    clock = MutableClock(datetime(2026, 7, 30, 8, 30, tzinfo=UTC))
    crash_client = CrashAtSendBoundaryClient()
    replay_client = RecordingHttpClient()
    first_deduplicator = persistent_deduplicator(database_url, clock=clock)
    first_gateway = create_notification_gateway(
        fcm_config(),
        access_token_provider=lambda: "secret-access-token",
        http_client=crash_client,
        deduplicator=first_deduplicator,
    )
    replay_deduplicator = persistent_deduplicator(database_url, clock=clock)
    replay_gateway = create_notification_gateway(
        fcm_config(),
        access_token_provider=lambda: "secret-access-token",
        http_client=replay_client,
        deduplicator=replay_deduplicator,
    )
    message = envelope()
    device = target()
    delivery_key = message.delivery_idempotency_key(device)

    with pytest.raises(SystemExit, match="simulated process crash"):
        first_gateway.deliver(message, device)

    assert first_deduplicator.state(delivery_key) is DeliveryClaimState.UNKNOWN_AFTER_SEND
    assert first_deduplicator.record(delivery_key)["phase"] == DeliveryAttemptPhase.SEND_BOUNDARY
    clock.advance(timedelta(days=7))

    replay = replay_gateway.deliver(message, device)

    assert replay.status is DeliveryStatus.DUPLICATE
    assert len(crash_client.calls) == 1
    assert replay_client.calls == []


@pytest.mark.parametrize(
    ("resolution", "expected_state", "claimable"),
    [
        (DeliveryReconciliation.RETRY, DeliveryClaimState.RETRYABLE, True),
        (DeliveryReconciliation.REJECTED, DeliveryClaimState.REJECTED, False),
        (DeliveryReconciliation.DELIVERED, DeliveryClaimState.DELIVERED, False),
    ],
)
def test_unknown_after_send_requires_explicit_authorized_reconciliation(
    resolution: DeliveryReconciliation,
    expected_state: DeliveryClaimState,
    claimable: bool,
    tmp_path: Path,
) -> None:
    database_url = f"sqlite:///{tmp_path / f'reconcile-{resolution.value}.sqlite3'}"
    clock = MutableClock(datetime(2026, 7, 30, 9, 0, tzinfo=UTC))
    first = persistent_deduplicator(database_url, clock=clock)
    second = persistent_deduplicator(database_url, clock=clock)
    message = envelope()
    device = target()
    delivery_key = message.delivery_idempotency_key(device)
    attempt_id = first.claim(delivery_key)
    assert attempt_id is not None
    first.mark_send_boundary(delivery_key, attempt_id)
    clock.advance(timedelta(hours=1))

    with pytest.raises(ValueError, match="authorization reference"):
        second.reconcile_authorized(
            delivery_key,
            resolution,
            authorization_reference="short",
        )
    assert second.state(delivery_key) is DeliveryClaimState.UNKNOWN_AFTER_SEND

    second.reconcile_authorized(
        delivery_key,
        resolution,
        authorization_reference="AUTHORITY/RECONCILIATION/2026-0001",
    )

    assert second.state(delivery_key) is expected_state
    record = second.record(delivery_key)
    assert record is not None
    assert record["phase"] == DeliveryAttemptPhase.RECONCILED
    assert record["reconciled_at"] == "2026-07-30T10:00:00Z"
    assert record["reconciliation_reference"] == "AUTHORITY/RECONCILIATION/2026-0001"
    with pytest.raises(RuntimeError, match="requires an unknown send"):
        second.reconcile_authorized(
            delivery_key,
            DeliveryReconciliation.DELIVERED,
            authorization_reference="AUTHORITY/RECONCILIATION/2026-0002",
        )
    recovered_attempt = second.claim(delivery_key)
    assert (recovered_attempt is not None) is claimable

    persisted = repr(second.record(delivery_key))
    assert "secret-device-token" not in persisted
    assert "consent-receipt-private-123" not in persisted
    assert delivery_key not in persisted


def test_target_bound_key_allows_cross_target_fanout_without_collisions() -> None:
    client = RecordingHttpClient()
    gateway = create_notification_gateway(
        fcm_config(),
        access_token_provider=lambda: "secret-access-token",
        http_client=client,
        deduplicator=persistent_deduplicator(),
    )
    message = envelope()

    first = gateway.deliver(message, target(device_token="secret-device-token-a"))
    second = gateway.deliver(message, target(device_token="secret-device-token-b"))

    assert first.status is DeliveryStatus.SENT
    assert second.status is DeliveryStatus.SENT
    assert first.idempotency_key != second.idempotency_key
    assert [call["json"]["message"]["token"] for call in client.calls] == [
        "secret-device-token-a",
        "secret-device-token-b",
    ]


@pytest.mark.parametrize(
    ("status_code", "expected_code", "retryable"),
    [
        (400, "FCM_REQUEST_REJECTED", False),
        (401, "FCM_AUTHORIZATION_FAILED", False),
        (404, "FCM_TARGET_NOT_FOUND", False),
        (425, "FCM_REQUEST_REJECTED", True),
        (429, "FCM_RATE_LIMITED", True),
    ],
)
def test_fcm_http_failures_retry_only_explicitly_retryable_responses(
    status_code: int,
    expected_code: str,
    retryable: bool,
) -> None:
    private_error = "secret-device-token user@example.test secret-access-token"
    client = RecordingHttpClient(StubResponse(status_code, {"error": {"message": private_error}}))
    gateway = create_notification_gateway(
        fcm_config(),
        access_token_provider=lambda: "secret-access-token",
        http_client=client,
        deduplicator=persistent_deduplicator(),
    )
    message = envelope()

    first = gateway.deliver(message, target())
    second = gateway.deliver(message, target())

    assert first.status is DeliveryStatus.FAILED
    assert first.failure_code == expected_code
    assert first.retryable is retryable
    assert second.status is (DeliveryStatus.FAILED if retryable else DeliveryStatus.DUPLICATE)
    assert len(client.calls) == (2 if retryable else 1)
    safe_result = repr(first) + repr(asdict(first))
    assert private_error not in safe_result
    assert "secret-device-token" not in safe_result
    assert "secret-access-token" not in safe_result


@pytest.mark.parametrize("status_code", [408, 500, 503])
def test_ambiguous_http_response_is_not_retried_by_a_second_dispatcher(
    status_code: int,
    tmp_path: Path,
) -> None:
    database_url = f"sqlite:///{tmp_path / f'unknown-http-{status_code}.sqlite3'}"
    first_client = RecordingHttpClient(
        StubResponse(status_code, {"error": {"message": "private-provider-error"}})
    )
    replay_client = RecordingHttpClient()
    first_deduplicator = persistent_deduplicator(database_url)
    first_gateway = create_notification_gateway(
        fcm_config(),
        access_token_provider=lambda: "secret-access-token",
        http_client=first_client,
        deduplicator=first_deduplicator,
    )
    replay_gateway = create_notification_gateway(
        fcm_config(),
        access_token_provider=lambda: "secret-access-token",
        http_client=replay_client,
        deduplicator=persistent_deduplicator(database_url),
    )
    message = envelope()
    device = target()

    unknown = first_gateway.deliver(message, device)
    replay = replay_gateway.deliver(message, device)

    assert unknown.status is DeliveryStatus.UNKNOWN_AFTER_SEND
    assert unknown.failure_code == "FCM_DELIVERY_OUTCOME_UNKNOWN"
    assert unknown.retryable is False
    assert (
        first_deduplicator.state(unknown.idempotency_key) is DeliveryClaimState.UNKNOWN_AFTER_SEND
    )
    assert replay.status is DeliveryStatus.DUPLICATE
    assert len(first_client.calls) == 1
    assert replay_client.calls == []
    assert "private-provider-error" not in repr(unknown)


def test_definite_pre_send_failure_releases_for_retry_across_instances(
    tmp_path: Path,
) -> None:
    database_url = f"sqlite:///{tmp_path / 'pre-send-retry.sqlite3'}"
    failed_client = RecordingHttpClient()
    retry_client = RecordingHttpClient()
    failed_deduplicator = persistent_deduplicator(database_url)
    failed_gateway = create_notification_gateway(
        fcm_config(),
        access_token_provider=lambda: (_ for _ in ()).throw(
            RuntimeError("private-service-account-secret")
        ),
        http_client=failed_client,
        deduplicator=failed_deduplicator,
    )
    retry_deduplicator = persistent_deduplicator(database_url)
    retry_gateway = create_notification_gateway(
        fcm_config(),
        access_token_provider=lambda: "secret-access-token",
        http_client=retry_client,
        deduplicator=retry_deduplicator,
    )
    message = envelope()
    device = target()

    failed = failed_gateway.deliver(message, device)

    assert failed.status is DeliveryStatus.FAILED
    assert failed.failure_code == "FCM_TOKEN_ACQUISITION_FAILED"
    assert failed.retryable is True
    assert failed.attempted is False
    assert failed_deduplicator.state(failed.idempotency_key) is DeliveryClaimState.RETRYABLE

    retried = retry_gateway.deliver(message, device)

    assert retried.status is DeliveryStatus.SENT
    assert retry_deduplicator.state(retried.idempotency_key) is DeliveryClaimState.DELIVERED
    assert failed_client.calls == []
    assert len(retry_client.calls) == 1
    rendered = repr(failed) + repr(retried)
    assert "private-service-account-secret" not in rendered


def test_ambiguous_post_send_failure_is_persisted_and_never_auto_retried(
    tmp_path: Path,
) -> None:
    database_url = f"sqlite:///{tmp_path / 'unknown-after-send.sqlite3'}"
    ambiguous_client = RecordingHttpClient(
        error=TimeoutError("secret-device-token user@example.test")
    )
    replay_client = RecordingHttpClient()
    first_deduplicator = persistent_deduplicator(database_url)
    first_gateway = create_notification_gateway(
        fcm_config(),
        access_token_provider=lambda: "secret-access-token",
        http_client=ambiguous_client,
        deduplicator=first_deduplicator,
    )
    second_deduplicator = persistent_deduplicator(database_url)
    second_gateway = create_notification_gateway(
        fcm_config(),
        access_token_provider=lambda: "secret-access-token",
        http_client=replay_client,
        deduplicator=second_deduplicator,
    )
    message = envelope()
    device = target()

    unknown = first_gateway.deliver(message, device)
    replay = second_gateway.deliver(message, device)

    assert unknown.status is DeliveryStatus.UNKNOWN_AFTER_SEND
    assert unknown.failure_code == "FCM_DELIVERY_OUTCOME_UNKNOWN"
    assert unknown.attempted is True
    assert unknown.retryable is False
    assert (
        first_deduplicator.state(unknown.idempotency_key) is DeliveryClaimState.UNKNOWN_AFTER_SEND
    )
    assert replay.status is DeliveryStatus.DUPLICATE
    assert replay.idempotency_key == unknown.idempotency_key
    assert len(ambiguous_client.calls) == 1
    assert replay_client.calls == []
    rendered = repr(unknown) + repr(replay)
    assert "secret-device-token" not in rendered
    assert "user@example.test" not in rendered


def test_untrusted_provider_reference_is_not_surfaced() -> None:
    client = RecordingHttpClient(
        StubResponse(
            200,
            {"name": "secret-device-token user@example.test\ncredential=private"},
        )
    )
    gateway = FcmHttpV1NotificationGateway(
        fcm_config(),
        access_token_provider=lambda: "secret-access-token",
        http_client=client,
        deduplicator=persistent_deduplicator(),
    )

    result = gateway.deliver(envelope(), target())

    assert result.status is DeliveryStatus.SENT
    assert result.provider_reference is None


def test_target_repr_and_results_never_surface_device_or_consent_secrets() -> None:
    device = target()
    disabled = DisabledNotificationGateway()
    result = disabled.deliver(envelope(), device)

    rendered = repr(device) + repr(result) + repr(asdict(result))
    assert "secret-device-token" not in rendered
    assert "consent-receipt-private-123" not in rendered


@pytest.mark.parametrize(
    "changes",
    [
        {"event_id": "alert-123"},
        {"deep_link": "https://attacker.example/collect"},
        {"deep_link": "//attacker.example/collect"},
        {"ttl_seconds": 10},
    ],
)
def test_envelope_rejects_non_authoritative_or_unsafe_content(
    changes: dict[str, Any],
) -> None:
    values: dict[str, Any] = {
        "event_id": event_id(),
        "alert_id": "alert-123",
        "incident_id": "inc-123",
        "title": "Flood caution",
        "body": "Follow local responder instructions.",
        "official": False,
        "deep_link": "/field/alerts/alert-123",
        "ttl_seconds": 900,
    }
    values.update(changes)

    with pytest.raises(ValueError):
        NotificationEnvelope(**values)
