"""Cloud Run Jobs v2 dispatch boundary tests."""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any
from uuid import uuid4

import pytest

from app.cloud_run_jobs import (
    CloudRunJobConfigurationError,
    CloudRunJobDispatchConfig,
    CloudRunJobDispatcher,
    DispatchStatus,
    SimulationDispatchCommand,
)


class StubResponse:
    def __init__(self, status_code: int, body: Any) -> None:
        self.status_code = status_code
        self._body = body
        self.json_calls = 0

    def json(self) -> Any:
        self.json_calls += 1
        return self._body


class RecordingHTTPClient:
    def __init__(
        self,
        response: StubResponse | None = None,
        error: Exception | None = None,
    ) -> None:
        self.response = response or StubResponse(
            200,
            {"name": ("projects/floodrise-prod/locations/asia-south1/operations/operation-123")},
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


class AtomicDeduplicator:
    def __init__(self) -> None:
        self.claimed: set[str] = set()
        self.completed: set[str] = set()
        self.released: list[str] = []

    def claim(self, outbox_event_id: str) -> bool:
        if outbox_event_id in self.claimed or outbox_event_id in self.completed:
            return False
        self.claimed.add(outbox_event_id)
        return True

    def complete(self, outbox_event_id: str) -> None:
        self.claimed.discard(outbox_event_id)
        self.completed.add(outbox_event_id)

    def release(self, outbox_event_id: str) -> None:
        self.claimed.discard(outbox_event_id)
        self.released.append(outbox_event_id)


def event_id() -> str:
    return f"evt-{uuid4()}"


def command(*, outbox_event_id: str | None = None) -> SimulationDispatchCommand:
    return SimulationDispatchCommand(
        outbox_event_id=outbox_event_id or event_id(),
        incident_id="inc-kerala-flood-2023",
        trigger="community corroboration version 4",
        operation="simulation",
    )


def production_config(**overrides: Any) -> CloudRunJobDispatchConfig:
    values: dict[str, Any] = {
        "environment": "production",
        "mode": "cloud_run",
        "project_id": "floodrise-prod",
        "allowed_project_ids": frozenset({"floodrise-prod"}),
        "region": "asia-south1",
        "job_name": "floodrise-simulation",
        "request_timeout_seconds": 2.5,
    }
    values.update(overrides)
    return CloudRunJobDispatchConfig(**values)


def dispatcher(
    *,
    config: CloudRunJobDispatchConfig | None = None,
    client: RecordingHTTPClient | None = None,
    deduplicator: AtomicDeduplicator | None = None,
    token_provider: Any = None,
) -> tuple[CloudRunJobDispatcher, RecordingHTTPClient, AtomicDeduplicator, list[int]]:
    resolved_client = client or RecordingHTTPClient()
    resolved_deduplicator = deduplicator or AtomicDeduplicator()
    token_calls: list[int] = []

    def default_token_provider() -> str:
        token_calls.append(1)
        return "secret-workload-identity-token"

    result = CloudRunJobDispatcher(
        config or production_config(),
        access_token_provider=token_provider or default_token_provider,
        http_client=resolved_client,
        deduplicator=resolved_deduplicator,
    )
    return result, resolved_client, resolved_deduplicator, token_calls


def test_dispatch_posts_v2_run_with_exact_headers_and_execution_overrides() -> None:
    service, client, deduplicator, token_calls = dispatcher()
    operation = command()

    receipt = service.dispatch(operation)

    assert receipt.status is DispatchStatus.QUEUED
    assert receipt.outbox_event_id == operation.outbox_event_id
    assert receipt.idempotency_key == operation.outbox_event_id
    assert receipt.provider_reference == (
        "projects/floodrise-prod/locations/asia-south1/operations/operation-123"
    )
    assert receipt.retryable is False
    assert receipt.attempted is True
    assert token_calls == [1]
    assert deduplicator.completed == {operation.outbox_event_id}
    assert client.calls == [
        {
            "url": (
                "https://run.googleapis.com/v2/projects/floodrise-prod/"
                "locations/asia-south1/jobs/floodrise-simulation:run"
            ),
            "headers": {
                "Authorization": "Bearer secret-workload-identity-token",
                "Content-Type": "application/json; charset=UTF-8",
                "X-FloodRISE-Event-ID": operation.outbox_event_id,
                "X-FloodRISE-Idempotency-Key": operation.outbox_event_id,
            },
            "json": {
                "overrides": {
                    "containerOverrides": [
                        {
                            "name": "simulation",
                            "env": [
                                {
                                    "name": "FLOODRISE_JOB_EVENT_ID",
                                    "value": operation.outbox_event_id,
                                },
                                {
                                    "name": "FLOODRISE_JOB_INCIDENT_ID",
                                    "value": "inc-kerala-flood-2023",
                                },
                                {
                                    "name": "FLOODRISE_JOB_TRIGGER",
                                    "value": "community corroboration version 4",
                                },
                                {
                                    "name": "FLOODRISE_JOB_OPERATION",
                                    "value": "simulation",
                                },
                            ],
                        }
                    ],
                    "taskCount": 1,
                }
            },
            "timeout": 2.5,
        }
    ]
    assert "secret-workload-identity-token" not in repr(receipt)
    assert "community corroboration" not in repr(receipt)


def test_duplicate_outbox_event_is_suppressed_before_token_or_network() -> None:
    service, client, _, token_calls = dispatcher()
    operation = command()

    first = service.dispatch(operation)
    duplicate = service.dispatch(operation)

    assert first.status is DispatchStatus.QUEUED
    assert duplicate.status is DispatchStatus.DUPLICATE
    assert duplicate.failure_code == "DUPLICATE_OUTBOX_EVENT"
    assert duplicate.attempted is False
    assert len(client.calls) == 1
    assert token_calls == [1]


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        (
            {
                "project_id": "another-valid-project",
                "allowed_project_ids": frozenset({"floodrise-prod"}),
            },
            "project allow-list",
        ),
        ({"region": "us-central1"}, "asia-south1"),
        ({"job_name": "floodrise-admin"}, "allow-listed floodrise-simulation"),
        ({"project_id": "INVALID"}, "valid Google Cloud project"),
        ({"request_timeout_seconds": 10.1}, "between 0.25 and 10"),
    ],
)
def test_unsafe_target_configuration_is_rejected_without_network(
    overrides: dict[str, Any],
    message: str,
) -> None:
    client = RecordingHTTPClient()
    token_calls = 0

    def token_provider() -> str:
        nonlocal token_calls
        token_calls += 1
        return "secret-token"

    with pytest.raises(CloudRunJobConfigurationError, match=message):
        CloudRunJobDispatcher(
            production_config(**overrides),
            access_token_provider=token_provider,
            http_client=client,
            deduplicator=AtomicDeduplicator(),
        )

    assert token_calls == 0
    assert client.calls == []


@pytest.mark.parametrize("environment", ["demo", "staging"])
def test_disabled_demo_and_staging_are_no_network_boundaries(environment: str) -> None:
    config = CloudRunJobDispatchConfig(environment=environment, mode="disabled")
    service, client, deduplicator, token_calls = dispatcher(config=config)
    operation = command()

    receipt = service.dispatch(operation)

    assert receipt.status is DispatchStatus.SUPPRESSED
    assert receipt.failure_code == "CLOUD_RUN_DISPATCH_DISABLED"
    assert receipt.attempted is False
    assert token_calls == []
    assert client.calls == []
    assert deduplicator.claimed == set()


@pytest.mark.parametrize(
    ("environment", "mode", "message"),
    [
        ("demo", "cloud_run", "restricted to the production"),
        ("staging", "cloud_run", "restricted to the production"),
        ("staging", "demo_cloud_run", "restricted to the isolated demo"),
        ("production", "demo_cloud_run", "restricted to the isolated demo"),
    ],
)
def test_non_explicit_environment_modes_fail_closed(
    environment: str,
    mode: str,
    message: str,
) -> None:
    with pytest.raises(CloudRunJobConfigurationError, match=message):
        production_config(environment=environment, mode=mode)


def test_explicit_demo_cloud_run_mode_uses_only_allow_listed_demo_project() -> None:
    config = production_config(
        environment="demo",
        mode="demo_cloud_run",
        project_id="floodrise-demo",
        allowed_project_ids=frozenset({"floodrise-demo"}),
    )
    response = StubResponse(
        200,
        {"name": ("projects/floodrise-demo/locations/asia-south1/operations/demo-operation-1")},
    )
    service, client, _, _ = dispatcher(
        config=config,
        client=RecordingHTTPClient(response=response),
    )

    receipt = service.dispatch(command())

    assert receipt.status is DispatchStatus.QUEUED
    assert "projects/floodrise-demo/" in client.calls[0]["url"]


@pytest.mark.parametrize(
    ("status_code", "failure_code", "status", "retryable"),
    [
        (400, "CLOUD_RUN_REQUEST_REJECTED", DispatchStatus.FAILED, False),
        (403, "CLOUD_RUN_AUTHORIZATION_FAILED", DispatchStatus.FAILED, False),
        (404, "CLOUD_RUN_JOB_NOT_FOUND", DispatchStatus.FAILED, False),
        (
            408,
            "CLOUD_RUN_PROVIDER_ACCEPTANCE_UNKNOWN",
            DispatchStatus.ACCEPTANCE_UNKNOWN,
            False,
        ),
        (425, "CLOUD_RUN_TRANSIENT_REQUEST_FAILURE", DispatchStatus.FAILED, True),
        (429, "CLOUD_RUN_RATE_LIMITED", DispatchStatus.FAILED, True),
        (
            503,
            "CLOUD_RUN_PROVIDER_ACCEPTANCE_UNKNOWN",
            DispatchStatus.ACCEPTANCE_UNKNOWN,
            False,
        ),
    ],
)
def test_provider_failures_are_classified_without_reading_error_body(
    status_code: int,
    failure_code: str,
    status: DispatchStatus,
    retryable: bool,
) -> None:
    response = StubResponse(status_code, {"error": {"message": "secret provider details"}})
    service, _, deduplicator, _ = dispatcher(client=RecordingHTTPClient(response=response))
    operation = command()

    receipt = service.dispatch(operation)

    assert receipt.status is status
    assert receipt.failure_code == failure_code
    assert receipt.retryable is retryable
    assert response.json_calls == 0
    assert "secret provider details" not in repr(receipt)
    if retryable:
        assert deduplicator.released == [operation.outbox_event_id]
    else:
        assert deduplicator.completed == {operation.outbox_event_id}


def test_token_and_transport_errors_are_redacted_with_safe_retry_semantics() -> None:
    operation = command()

    def broken_token_provider() -> str:
        raise RuntimeError("secret-token-from-metadata")

    token_service, token_client, _, _ = dispatcher(token_provider=broken_token_provider)
    token_receipt = token_service.dispatch(operation)

    transport_service, _, _, _ = dispatcher(
        client=RecordingHTTPClient(
            error=RuntimeError("Bearer secret-token and sensitive provider body")
        )
    )
    transport_receipt = transport_service.dispatch(command())

    assert token_client.calls == []
    assert token_receipt.failure_code == "CLOUD_RUN_TOKEN_ACQUISITION_FAILED"
    assert token_receipt.retryable is True
    assert token_receipt.attempted is False
    assert transport_receipt.failure_code == "CLOUD_RUN_TRANSPORT_ACCEPTANCE_UNKNOWN"
    assert transport_receipt.status is DispatchStatus.ACCEPTANCE_UNKNOWN
    assert transport_receipt.retryable is False
    assert transport_receipt.attempted is True
    combined = repr((token_receipt, transport_receipt))
    assert "secret-token-from-metadata" not in combined
    assert "sensitive provider body" not in combined
    assert "Bearer secret-token" not in combined


def test_ambiguous_transport_is_not_replayed_by_another_dispatcher_instance() -> None:
    operation = command()
    authoritative_store = AtomicDeduplicator()
    first, first_client, _, _ = dispatcher(
        client=RecordingHTTPClient(error=TimeoutError("response lost after request send")),
        deduplicator=authoritative_store,
    )
    second, second_client, _, second_token_calls = dispatcher(
        deduplicator=authoritative_store,
    )

    ambiguous = first.dispatch(operation)
    replay = second.dispatch(operation)

    assert ambiguous.status is DispatchStatus.ACCEPTANCE_UNKNOWN
    assert ambiguous.failure_code == "CLOUD_RUN_TRANSPORT_ACCEPTANCE_UNKNOWN"
    assert ambiguous.retryable is False
    assert authoritative_store.completed == {operation.outbox_event_id}
    assert authoritative_store.released == []
    assert replay.status is DispatchStatus.DUPLICATE
    assert replay.attempted is False
    assert len(first_client.calls) == 1
    assert second_client.calls == []
    assert second_token_calls == []


def test_definite_pre_dispatch_failure_releases_claim_for_retry() -> None:
    operation = command()
    authoritative_store = AtomicDeduplicator()

    def broken_token_provider() -> str:
        raise RuntimeError("metadata temporarily unavailable")

    first, first_client, _, _ = dispatcher(
        deduplicator=authoritative_store,
        token_provider=broken_token_provider,
    )
    second, second_client, _, _ = dispatcher(deduplicator=authoritative_store)

    failed = first.dispatch(operation)
    retried = second.dispatch(operation)

    assert failed.failure_code == "CLOUD_RUN_TOKEN_ACQUISITION_FAILED"
    assert failed.retryable is True
    assert failed.attempted is False
    assert authoritative_store.released == [operation.outbox_event_id]
    assert retried.status is DispatchStatus.QUEUED
    assert first_client.calls == []
    assert len(second_client.calls) == 1


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"outbox_event_id": "evt-not-a-uuid"}, "authoritative evt-UUID"),
        ({"incident_id": "other-incident"}, "floodRISE incident"),
        ({"trigger": "x"}, "3-200"),
        ({"trigger": " secret trigger"}, "3-200"),
        ({"trigger": "trigger\nwith log injection"}, "3-200"),
        ({"operation": "shell"}, "allow-listed simulation"),
    ],
)
def test_execution_override_values_are_strictly_validated(
    overrides: dict[str, str],
    message: str,
) -> None:
    values = {
        "outbox_event_id": event_id(),
        "incident_id": "inc-kerala-flood-2023",
        "trigger": "scheduled simulation",
        "operation": "simulation",
    }
    values.update(overrides)

    with pytest.raises(ValueError, match=message):
        SimulationDispatchCommand(**values)
