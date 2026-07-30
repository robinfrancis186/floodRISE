"""Fail-closed dispatcher for versioned floodRISE Cloud Run Job executions.

The dispatcher accepts only the immutable identifiers required to start one
simulation.  It deliberately has no Google SDK dependency: production injects
a workload-identity access-token provider, an HTTP client, and an atomic
deduplicator backed by the authoritative transactional outbox.

Provider response bodies and exception messages are never copied into receipts.
This keeps credentials and operational payloads out of logs while still giving
the outbox worker stable retry classifications.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from enum import StrEnum
from typing import Any, Literal, Protocol

RuntimeEnvironment = Literal["demo", "development", "test", "staging", "production"]
DispatchMode = Literal["disabled", "cloud_run", "demo_cloud_run"]

MUMBAI_REGION = "asia-south1"
SIMULATION_JOB_NAME = "floodrise-simulation"
SIMULATION_CONTAINER_NAME = "simulation"
SUPPORTED_OPERATIONS = frozenset({"simulation"})

_EVENT_ID_PATTERN = re.compile(
    r"^evt-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_INCIDENT_ID_PATTERN = re.compile(r"^inc-[A-Za-z0-9][A-Za-z0-9._:-]{0,123}$")
_TRIGGER_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9 ._:/(),#+-]{2,199}$")
_PROJECT_ID_PATTERN = re.compile(r"^[a-z][a-z0-9-]{4,28}[a-z0-9]$")
_PROVIDER_REFERENCE_SUFFIX = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$")
_VALID_ENVIRONMENTS = frozenset({"demo", "development", "test", "staging", "production"})
_VALID_MODES = frozenset({"disabled", "cloud_run", "demo_cloud_run"})
# Only explicit provider rejections that prove the Job was not accepted may
# release the authoritative event claim. Timeouts and server failures are
# ambiguous after a request crossed the network boundary.
_RETRYABLE_STATUS_CODES = frozenset({425, 429})


class CloudRunJobConfigurationError(ValueError):
    """Raised before a target could permit an unsafe cross-boundary request."""


class DispatchStatus(StrEnum):
    """Provider-independent outcomes safe to persist with an outbox event."""

    SUPPRESSED = "SUPPRESSED"
    QUEUED = "QUEUED"
    DUPLICATE = "DUPLICATE"
    ACCEPTANCE_UNKNOWN = "ACCEPTANCE_UNKNOWN"
    FAILED = "FAILED"


@dataclass(frozen=True, slots=True)
class SimulationDispatchCommand:
    """Validated values allowed into per-execution environment overrides."""

    outbox_event_id: str
    incident_id: str
    trigger: str = field(repr=False)
    operation: str = "simulation"

    def __post_init__(self) -> None:
        if not _EVENT_ID_PATTERN.fullmatch(self.outbox_event_id):
            raise ValueError("outbox_event_id must be an authoritative evt-UUID")
        if not _INCIDENT_ID_PATTERN.fullmatch(self.incident_id):
            raise ValueError("incident_id must be a bounded floodRISE incident identifier")
        if self.operation not in SUPPORTED_OPERATIONS:
            raise ValueError("operation must be an allow-listed simulation operation")
        if self.trigger != self.trigger.strip() or not _TRIGGER_PATTERN.fullmatch(self.trigger):
            raise ValueError(
                "trigger must contain 3-200 bounded plain-text characters without controls"
            )

    @property
    def idempotency_key(self) -> str:
        """The persisted outbox event ID is the exact, non-derived key."""

        return self.outbox_event_id


@dataclass(frozen=True, slots=True)
class CloudRunJobDispatchConfig:
    """Explicit Cloud Run target and environment boundary.

    ``allowed_project_ids`` must be supplied independently by deployment
    configuration.  This prevents a compromised runtime value from redirecting
    job execution into another otherwise-valid Google Cloud project.
    """

    environment: RuntimeEnvironment
    mode: DispatchMode = "disabled"
    project_id: str | None = None
    allowed_project_ids: frozenset[str] = frozenset()
    region: str = MUMBAI_REGION
    job_name: str = SIMULATION_JOB_NAME
    request_timeout_seconds: float = 3.0

    def __post_init__(self) -> None:
        if self.environment not in _VALID_ENVIRONMENTS:
            raise CloudRunJobConfigurationError("unsupported runtime environment")
        if self.mode not in _VALID_MODES:
            raise CloudRunJobConfigurationError("unsupported Cloud Run dispatch mode")
        if self.region != MUMBAI_REGION:
            raise CloudRunJobConfigurationError("Cloud Run jobs must remain in asia-south1")
        if self.job_name != SIMULATION_JOB_NAME:
            raise CloudRunJobConfigurationError(
                "job_name must be the allow-listed floodrise-simulation job"
            )
        if not 0.25 <= self.request_timeout_seconds <= 10:
            raise CloudRunJobConfigurationError(
                "request_timeout_seconds must be between 0.25 and 10"
            )

        project_id = self.project_id
        if project_id is not None and not _PROJECT_ID_PATTERN.fullmatch(project_id):
            raise CloudRunJobConfigurationError("project_id must be a valid Google Cloud project")
        if any(not _PROJECT_ID_PATTERN.fullmatch(value) for value in self.allowed_project_ids):
            raise CloudRunJobConfigurationError(
                "allowed_project_ids contains an invalid Google Cloud project"
            )

        if self.mode == "disabled":
            return
        if project_id is None:
            raise CloudRunJobConfigurationError(
                "an explicitly allow-listed project_id is required for Cloud Run dispatch"
            )
        if project_id not in self.allowed_project_ids:
            raise CloudRunJobConfigurationError(
                "project_id is not in the deployment project allow-list"
            )
        if self.mode == "cloud_run" and self.environment != "production":
            raise CloudRunJobConfigurationError(
                "cloud_run mode is restricted to the production environment"
            )
        if self.mode == "demo_cloud_run" and self.environment != "demo":
            raise CloudRunJobConfigurationError(
                "demo_cloud_run mode is restricted to the isolated demo environment"
            )

    @property
    def network_enabled(self) -> bool:
        return (self.environment, self.mode) in {
            ("production", "cloud_run"),
            ("demo", "demo_cloud_run"),
        }


@dataclass(frozen=True, slots=True)
class CloudRunExecutionReceipt:
    """Redacted, typed result for an attempted or suppressed job execution."""

    outbox_event_id: str
    idempotency_key: str
    incident_id: str
    operation: str
    job_name: str
    status: DispatchStatus
    attempted: bool
    retryable: bool = False
    provider_reference: str | None = None
    failure_code: str | None = None

    def __post_init__(self) -> None:
        if self.idempotency_key != self.outbox_event_id:
            raise ValueError("idempotency_key must exactly equal outbox_event_id")


class HTTPResponse(Protocol):
    status_code: int

    def json(self) -> Any:
        """Return the decoded provider response."""


class SyncHTTPClient(Protocol):
    def post(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        json: Mapping[str, Any],
        timeout: float,
    ) -> HTTPResponse:
        """Send one bounded synchronous HTTP request."""


class DispatchDeduplicator(Protocol):
    """Atomic claim contract implemented by persistent outbox delivery state."""

    def claim(self, outbox_event_id: str) -> bool:
        """Atomically claim an event or return false when already processed."""

    def complete(self, outbox_event_id: str) -> None:
        """Mark a claim terminal after acceptance, rejection, or an ambiguous send.

        An ambiguous network outcome must remain terminal until an operator or
        provider-reconciliation workflow proves that replay is safe. Persistent
        implementations make this event-level claim authoritative across API
        and worker instances.
        """

    def release(self, outbox_event_id: str) -> None:
        """Release a retryable failure so the outbox can try again."""


class CloudRunJobDispatcher:
    """Dispatch one immutable outbox operation to the allow-listed v2 Job."""

    def __init__(
        self,
        config: CloudRunJobDispatchConfig,
        *,
        access_token_provider: Callable[[], str],
        http_client: SyncHTTPClient,
        deduplicator: DispatchDeduplicator,
    ) -> None:
        self._config = config
        self._access_token_provider = access_token_provider
        self._http_client = http_client
        self._deduplicator = deduplicator
        self._endpoint = (
            "https://run.googleapis.com/v2/"
            f"projects/{config.project_id}/locations/{config.region}/"
            f"jobs/{config.job_name}:run"
            if config.network_enabled
            else None
        )

    def dispatch(self, command: SimulationDispatchCommand) -> CloudRunExecutionReceipt:
        """Queue a simulation or return a redacted, retry-classified result."""

        if not self._config.network_enabled:
            return self._receipt(
                command,
                status=DispatchStatus.SUPPRESSED,
                attempted=False,
                failure_code="CLOUD_RUN_DISPATCH_DISABLED",
            )

        try:
            claimed = self._deduplicator.claim(command.outbox_event_id)
        except Exception:
            return self._receipt(
                command,
                status=DispatchStatus.FAILED,
                attempted=False,
                retryable=True,
                failure_code="IDEMPOTENCY_STORE_UNAVAILABLE",
            )
        if not claimed:
            return self._receipt(
                command,
                status=DispatchStatus.DUPLICATE,
                attempted=False,
                failure_code="DUPLICATE_OUTBOX_EVENT",
            )

        try:
            access_token = self._access_token_provider()
            if (
                not access_token.strip()
                or any(character.isspace() for character in access_token)
                or len(access_token) > 8_192
            ):
                raise ValueError("invalid access token")
        except Exception:
            return self._retryable_failure(
                command,
                attempted=False,
                failure_code="CLOUD_RUN_TOKEN_ACQUISITION_FAILED",
            )

        payload: dict[str, Any] = {
            "overrides": {
                "containerOverrides": [
                    {
                        "name": SIMULATION_CONTAINER_NAME,
                        "env": [
                            {
                                "name": "FLOODRISE_JOB_EVENT_ID",
                                "value": command.outbox_event_id,
                            },
                            {
                                "name": "FLOODRISE_JOB_INCIDENT_ID",
                                "value": command.incident_id,
                            },
                            {
                                "name": "FLOODRISE_JOB_TRIGGER",
                                "value": command.trigger,
                            },
                            {
                                "name": "FLOODRISE_JOB_OPERATION",
                                "value": command.operation,
                            },
                        ],
                    }
                ],
                "taskCount": 1,
            }
        }
        headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json; charset=UTF-8",
            "X-FloodRISE-Event-ID": command.outbox_event_id,
            "X-FloodRISE-Idempotency-Key": command.outbox_event_id,
        }

        try:
            response = self._http_client.post(
                self._endpoint or "",
                headers=headers,
                json=payload,
                timeout=self._config.request_timeout_seconds,
            )
        except Exception:
            return self._acceptance_unknown(
                command,
                failure_code="CLOUD_RUN_TRANSPORT_ACCEPTANCE_UNKNOWN",
            )

        if 200 <= response.status_code < 300:
            provider_reference = self._provider_reference(response)
            if not self._finalize(command.outbox_event_id):
                return self._receipt(
                    command,
                    status=DispatchStatus.FAILED,
                    attempted=True,
                    failure_code="IDEMPOTENCY_FINALIZATION_FAILED",
                )
            return self._receipt(
                command,
                status=DispatchStatus.QUEUED,
                attempted=True,
                provider_reference=provider_reference,
            )

        if self._is_ambiguous_response(response.status_code):
            return self._acceptance_unknown(
                command,
                failure_code="CLOUD_RUN_PROVIDER_ACCEPTANCE_UNKNOWN",
            )
        if self._is_retryable(response.status_code):
            return self._retryable_failure(
                command,
                attempted=True,
                failure_code=self._failure_code(response.status_code),
            )
        if not self._finalize(command.outbox_event_id):
            return self._receipt(
                command,
                status=DispatchStatus.FAILED,
                attempted=True,
                failure_code="IDEMPOTENCY_FINALIZATION_FAILED",
            )
        return self._receipt(
            command,
            status=DispatchStatus.FAILED,
            attempted=True,
            retryable=False,
            failure_code=self._failure_code(response.status_code),
        )

    def _receipt(
        self,
        command: SimulationDispatchCommand,
        *,
        status: DispatchStatus,
        attempted: bool,
        retryable: bool = False,
        provider_reference: str | None = None,
        failure_code: str | None = None,
    ) -> CloudRunExecutionReceipt:
        return CloudRunExecutionReceipt(
            outbox_event_id=command.outbox_event_id,
            idempotency_key=command.outbox_event_id,
            incident_id=command.incident_id,
            operation=command.operation,
            job_name=self._config.job_name,
            status=status,
            attempted=attempted,
            retryable=retryable,
            provider_reference=provider_reference,
            failure_code=failure_code,
        )

    def _retryable_failure(
        self,
        command: SimulationDispatchCommand,
        *,
        attempted: bool,
        failure_code: str,
    ) -> CloudRunExecutionReceipt:
        try:
            self._deduplicator.release(command.outbox_event_id)
        except Exception:
            return self._receipt(
                command,
                status=DispatchStatus.FAILED,
                attempted=attempted,
                retryable=False,
                failure_code="IDEMPOTENCY_RELEASE_FAILED",
            )
        return self._receipt(
            command,
            status=DispatchStatus.FAILED,
            attempted=attempted,
            retryable=True,
            failure_code=failure_code,
        )

    def _acceptance_unknown(
        self,
        command: SimulationDispatchCommand,
        *,
        failure_code: str,
    ) -> CloudRunExecutionReceipt:
        """Retain the event claim when Cloud Run may have started the Job."""

        if not self._finalize(command.outbox_event_id):
            failure_code = "IDEMPOTENCY_AMBIGUOUS_FINALIZATION_FAILED"
        return self._receipt(
            command,
            status=DispatchStatus.ACCEPTANCE_UNKNOWN,
            attempted=True,
            retryable=False,
            failure_code=failure_code,
        )

    def _finalize(self, outbox_event_id: str) -> bool:
        try:
            self._deduplicator.complete(outbox_event_id)
        except Exception:
            return False
        return True

    def _provider_reference(self, response: HTTPResponse) -> str | None:
        try:
            body = response.json()
        except Exception:
            return None
        if not isinstance(body, dict):
            return None
        name = body.get("name")
        if not isinstance(name, str):
            return None
        prefix = f"projects/{self._config.project_id}/locations/{self._config.region}/operations/"
        if not name.startswith(prefix):
            return None
        suffix = name.removeprefix(prefix)
        return name if _PROVIDER_REFERENCE_SUFFIX.fullmatch(suffix) else None

    @staticmethod
    def _is_retryable(status_code: int) -> bool:
        return status_code in _RETRYABLE_STATUS_CODES

    @staticmethod
    def _is_ambiguous_response(status_code: int) -> bool:
        return status_code == 408 or status_code >= 500

    @staticmethod
    def _failure_code(status_code: int) -> str:
        if status_code == 429:
            return "CLOUD_RUN_RATE_LIMITED"
        if status_code in {401, 403}:
            return "CLOUD_RUN_AUTHORIZATION_FAILED"
        if status_code == 404:
            return "CLOUD_RUN_JOB_NOT_FOUND"
        if status_code in {408, 425}:
            return "CLOUD_RUN_TRANSIENT_REQUEST_FAILURE"
        if 400 <= status_code < 500:
            return "CLOUD_RUN_REQUEST_REJECTED"
        if status_code >= 500:
            return "CLOUD_RUN_PROVIDER_UNAVAILABLE"
        return "CLOUD_RUN_UNEXPECTED_RESPONSE"


__all__ = [
    "CloudRunExecutionReceipt",
    "CloudRunJobConfigurationError",
    "CloudRunJobDispatchConfig",
    "CloudRunJobDispatcher",
    "DispatchDeduplicator",
    "DispatchMode",
    "DispatchStatus",
    "HTTPResponse",
    "MUMBAI_REGION",
    "RuntimeEnvironment",
    "SIMULATION_CONTAINER_NAME",
    "SIMULATION_JOB_NAME",
    "SUPPORTED_OPERATIONS",
    "SimulationDispatchCommand",
    "SyncHTTPClient",
]
