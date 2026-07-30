"""Safe notification gateways for demo logging and opt-in FCM delivery.

Each delivery idempotency key binds one authoritative outbox event to one
specific device without persisting or exposing its FCM token. Production FCM
construction requires a durable ``DeliveryDeduplicator``; the in-memory
implementation is intentionally limited to the no-network demo gateway.

FCM delivery is deliberately narrow:

* one explicitly opted-in device per call;
* no topic, condition, multicast, or arbitrary caller-provided data;
* no external delivery outside production;
* an explicit authority activation reference is required in production; and
* credentials, device tokens, consent references, and provider error bodies
  never appear in results.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from hashlib import sha256
from threading import Lock
from typing import Any, Literal, Protocol
from uuid import uuid4

from sqlalchemy.exc import IntegrityError

from .database import ConcurrentWriteError, Database, EntityChange

RuntimeEnvironment = Literal["demo", "development", "test", "staging", "production"]
GatewayMode = Literal["disabled", "demo_log", "fcm"]

_EVENT_ID_PATTERN = re.compile(
    r"^evt-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_RESOURCE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_PROJECT_ID_PATTERN = re.compile(r"^[a-z][a-z0-9-]{4,62}$")
_AUTHORITY_REFERENCE_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:/-]{7,127}$")
_PROVIDER_REFERENCE_PATTERN = re.compile(
    r"^projects/[A-Za-z0-9_-]+/messages/[A-Za-z0-9:._%-]{1,256}$"
)


class NotificationConfigurationError(ValueError):
    """Raised when a gateway configuration could permit an unsafe delivery."""


class DeliveryStatus(StrEnum):
    """Safe, provider-independent delivery outcomes."""

    SUPPRESSED = "SUPPRESSED"
    DEMO_RECORDED = "DEMO_RECORDED"
    SENT = "SENT"
    DUPLICATE = "DUPLICATE"
    FAILED = "FAILED"
    UNKNOWN_AFTER_SEND = "UNKNOWN_AFTER_SEND"


class DeliveryClaimState(StrEnum):
    """Durable state for one event-and-target delivery attempt."""

    IN_FLIGHT = "IN_FLIGHT"
    RETRYABLE = "RETRYABLE"
    DELIVERED = "DELIVERED"
    REJECTED = "REJECTED"
    UNKNOWN_AFTER_SEND = "UNKNOWN_AFTER_SEND"


class DeliveryAttemptPhase(StrEnum):
    """Security-relevant boundary reached by one fenced delivery attempt."""

    PRE_SEND = "PRE_SEND"
    SEND_BOUNDARY = "SEND_BOUNDARY"
    RECONCILED = "RECONCILED"


class DeliveryReconciliation(StrEnum):
    """Explicit resolution of an attempt that crossed the send boundary."""

    RETRY = "RETRY"
    REJECTED = "REJECTED"
    DELIVERED = "DELIVERED"


@dataclass(frozen=True, slots=True)
class NotificationEnvelope:
    """Public alert content bound to one immutable outbox event."""

    event_id: str
    alert_id: str
    incident_id: str
    title: str
    body: str
    official: bool
    deep_link: str
    ttl_seconds: int = 900

    def __post_init__(self) -> None:
        if not _EVENT_ID_PATTERN.fullmatch(self.event_id):
            raise ValueError("event_id must be an authoritative evt-UUID outbox ID")
        for name, value in (
            ("alert_id", self.alert_id),
            ("incident_id", self.incident_id),
        ):
            if not _RESOURCE_ID_PATTERN.fullmatch(value):
                raise ValueError(f"{name} contains unsupported characters")
        if not self.title.strip() or len(self.title) > 120:
            raise ValueError("title must contain between 1 and 120 characters")
        if not self.body.strip() or len(self.body) > 1_000:
            raise ValueError("body must contain between 1 and 1000 characters")
        if not self.deep_link.startswith("/") or self.deep_link.startswith("//"):
            raise ValueError("deep_link must be an application-relative path")
        if any(character in self.deep_link for character in ("\r", "\n", "\0")):
            raise ValueError("deep_link contains unsupported characters")
        if not 30 <= self.ttl_seconds <= 3_600:
            raise ValueError("ttl_seconds must be between 30 and 3600")

    def delivery_idempotency_key(self, target: OptInDeviceTarget) -> str:
        """Return the privacy-safe key for this event and one specific device."""

        return _delivery_key(self, target)


@dataclass(frozen=True, slots=True)
class OptInDeviceTarget:
    """A single device with an auditable, current opt-in reference."""

    device_token: str = field(repr=False)
    opted_in: bool
    consent_reference: str = field(repr=False)

    def __post_init__(self) -> None:
        if not self.device_token.strip() or len(self.device_token) > 4_096:
            raise ValueError("device_token must contain between 1 and 4096 characters")
        if any(character.isspace() for character in self.device_token):
            raise ValueError("device_token must not contain whitespace")
        if self.opted_in and not self.consent_reference.strip():
            raise ValueError("an opted-in target requires a consent reference")
        if len(self.consent_reference) > 256:
            raise ValueError("consent_reference must not exceed 256 characters")


@dataclass(frozen=True, slots=True)
class DeliveryResult:
    """Redacted result safe to persist in a delivery-attempt record."""

    event_id: str
    idempotency_key: str
    status: DeliveryStatus
    provider: str
    attempted: bool
    retryable: bool = False
    provider_reference: str | None = None
    failure_code: str | None = None

    def __post_init__(self) -> None:
        prefix = f"{self.event_id}:target:"
        target_digest = self.idempotency_key.removeprefix(prefix)
        if (
            not self.idempotency_key.startswith(prefix)
            or len(target_digest) != 64
            or any(character not in "0123456789abcdef" for character in target_digest)
        ):
            raise ValueError(
                "idempotency_key must bind the event ID to a privacy-safe target digest"
            )


@dataclass(frozen=True, slots=True)
class DemoDeliveryRecord:
    """Token-free record exposed by the deterministic demo gateway."""

    event_id: str
    idempotency_key: str
    alert_id: str
    incident_id: str
    official: bool


class HttpResponse(Protocol):
    status_code: int

    def json(self) -> Any:
        """Return a decoded response body."""


class HttpClient(Protocol):
    def post(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        json: Mapping[str, Any],
        timeout: float,
    ) -> HttpResponse:
        """Send one bounded HTTP request."""


class DeliveryDeduplicator(Protocol):
    """Atomic duplicate-prevention contract backed by persistent storage in production."""

    persistent: bool

    def claim(self, delivery_key: str) -> str | None:
        """Claim a pre-send lease and return its fencing attempt ID."""

    def complete(self, delivery_key: str, attempt_id: str) -> None:
        """Complete a no-network delivery that never crossed the send boundary."""

    def reject(self, delivery_key: str, attempt_id: str) -> None:
        """Reject a definitely unsent delivery before the send boundary."""

    def release(self, delivery_key: str, attempt_id: str) -> None:
        """Release only a definitely unsent delivery for a later attempt."""

    def mark_send_boundary(self, delivery_key: str, attempt_id: str) -> None:
        """Persist UNKNOWN_AFTER_SEND before the provider call can begin."""

    def reconcile(
        self,
        delivery_key: str,
        attempt_id: str,
        resolution: DeliveryReconciliation,
        *,
        authorization_reference: str,
    ) -> None:
        """Explicitly resolve an attempt that crossed the send boundary."""

    def reconcile_authorized(
        self,
        delivery_key: str,
        resolution: DeliveryReconciliation,
        *,
        authorization_reference: str,
    ) -> None:
        """Resolve the current unknown attempt after caller authorization."""


class NotificationGateway(Protocol):
    name: str

    def deliver(
        self,
        envelope: NotificationEnvelope,
        target: OptInDeviceTarget,
    ) -> DeliveryResult:
        """Deliver or safely suppress one device notification."""


class InMemoryDeliveryDeduplicator:
    """Thread-safe demo/test deduplicator; not a production persistence substitute."""

    persistent = False

    def __init__(self) -> None:
        self._states: dict[
            str,
            tuple[str, DeliveryClaimState, DeliveryAttemptPhase],
        ] = {}
        self._lock = Lock()

    def claim(self, delivery_key: str) -> str | None:
        with self._lock:
            current = self._states.get(delivery_key)
            if current is not None and current[1] is not DeliveryClaimState.RETRYABLE:
                return None
            attempt_id = str(uuid4())
            self._states[delivery_key] = (
                attempt_id,
                DeliveryClaimState.IN_FLIGHT,
                DeliveryAttemptPhase.PRE_SEND,
            )
            return attempt_id

    def complete(self, delivery_key: str, attempt_id: str) -> None:
        with self._lock:
            self._transition_pre_send(
                delivery_key,
                attempt_id,
                DeliveryClaimState.DELIVERED,
            )

    def reject(self, delivery_key: str, attempt_id: str) -> None:
        with self._lock:
            self._transition_pre_send(
                delivery_key,
                attempt_id,
                DeliveryClaimState.REJECTED,
            )

    def release(self, delivery_key: str, attempt_id: str) -> None:
        with self._lock:
            self._transition_pre_send(
                delivery_key,
                attempt_id,
                DeliveryClaimState.RETRYABLE,
            )

    def mark_send_boundary(self, delivery_key: str, attempt_id: str) -> None:
        with self._lock:
            self._require_current(
                delivery_key,
                attempt_id,
                state=DeliveryClaimState.IN_FLIGHT,
                phase=DeliveryAttemptPhase.PRE_SEND,
            )
            self._states[delivery_key] = (
                attempt_id,
                DeliveryClaimState.UNKNOWN_AFTER_SEND,
                DeliveryAttemptPhase.SEND_BOUNDARY,
            )

    def reconcile(
        self,
        delivery_key: str,
        attempt_id: str,
        resolution: DeliveryReconciliation,
        *,
        authorization_reference: str,
    ) -> None:
        _validate_reconciliation_reference(authorization_reference)
        with self._lock:
            self._require_current(
                delivery_key,
                attempt_id,
                state=DeliveryClaimState.UNKNOWN_AFTER_SEND,
                phase=DeliveryAttemptPhase.SEND_BOUNDARY,
            )
            self._states[delivery_key] = (
                attempt_id,
                _reconciled_state(resolution),
                DeliveryAttemptPhase.RECONCILED,
            )

    def reconcile_authorized(
        self,
        delivery_key: str,
        resolution: DeliveryReconciliation,
        *,
        authorization_reference: str,
    ) -> None:
        _validate_reconciliation_reference(authorization_reference)
        with self._lock:
            current = self._states.get(delivery_key)
            if (
                current is None
                or current[1] is not DeliveryClaimState.UNKNOWN_AFTER_SEND
                or current[2] is not DeliveryAttemptPhase.SEND_BOUNDARY
            ):
                raise RuntimeError("authorized reconciliation requires an unknown send")
            self._states[delivery_key] = (
                current[0],
                _reconciled_state(resolution),
                DeliveryAttemptPhase.RECONCILED,
            )

    def _transition_pre_send(
        self,
        delivery_key: str,
        attempt_id: str,
        state: DeliveryClaimState,
    ) -> None:
        self._require_current(
            delivery_key,
            attempt_id,
            state=DeliveryClaimState.IN_FLIGHT,
            phase=DeliveryAttemptPhase.PRE_SEND,
        )
        self._states[delivery_key] = (
            attempt_id,
            state,
            DeliveryAttemptPhase.RECONCILED,
        )

    def _require_current(
        self,
        delivery_key: str,
        attempt_id: str,
        *,
        state: DeliveryClaimState,
        phase: DeliveryAttemptPhase,
    ) -> None:
        current = self._states.get(delivery_key)
        if current != (attempt_id, state, phase):
            raise RuntimeError("transition requires the current delivery attempt")


class DatabaseDeliveryDeduplicator:
    """Durable, cross-process delivery state stored in the authoritative database."""

    persistent = True
    _KIND = "notification_delivery"

    def __init__(
        self,
        database: Database,
        *,
        clock: Callable[[], datetime] | None = None,
        pre_send_lease: timedelta = timedelta(seconds=30),
    ) -> None:
        if not timedelta(seconds=1) <= pre_send_lease <= timedelta(minutes=5):
            raise ValueError("pre_send_lease must be between 1 second and 5 minutes")
        self._database = database
        self._clock = clock or (lambda: datetime.now(UTC))
        self._pre_send_lease = pre_send_lease

    @staticmethod
    def _entity_id(delivery_key: str) -> str:
        return sha256(delivery_key.encode("utf-8")).hexdigest()

    @staticmethod
    def _event_id(delivery_key: str) -> str:
        event_id, separator, _ = delivery_key.partition(":target:")
        if not separator or not _EVENT_ID_PATTERN.fullmatch(event_id):
            raise ValueError("delivery key must contain an authoritative event ID")
        return event_id

    def claim(self, delivery_key: str) -> str | None:
        entity_id = self._entity_id(delivery_key)
        current = self._database.get(self._KIND, entity_id)
        now = self._now()
        if current is None:
            version = 1
        elif current.get("state") == DeliveryClaimState.RETRYABLE or self._expired_pre_send_claim(
            current, now
        ):
            version = int(current["version"]) + 1
        else:
            return None

        attempt_id = str(uuid4())
        payload = self._payload(
            delivery_key,
            entity_id=entity_id,
            version=version,
            state=DeliveryClaimState.IN_FLIGHT,
            phase=DeliveryAttemptPhase.PRE_SEND,
            attempt_id=attempt_id,
            attempt_started_at=self._iso(now),
            pre_send_lease_expires_at=self._iso(now + self._pre_send_lease),
            send_boundary_at=None,
            reconciled_at=None,
            reconciliation_reference=None,
            updated_at=self._iso(now),
        )
        try:
            self._database.commit(
                changes=[
                    EntityChange(
                        kind=self._KIND,
                        entity_id=entity_id,
                        payload=payload,
                        version=version,
                        expected_version=version - 1,
                    )
                ]
            )
        except (ConcurrentWriteError, IntegrityError):
            return None
        return attempt_id

    def complete(self, delivery_key: str, attempt_id: str) -> None:
        self._transition_pre_send(
            delivery_key,
            attempt_id,
            DeliveryClaimState.DELIVERED,
        )

    def reject(self, delivery_key: str, attempt_id: str) -> None:
        self._transition_pre_send(
            delivery_key,
            attempt_id,
            DeliveryClaimState.REJECTED,
        )

    def release(self, delivery_key: str, attempt_id: str) -> None:
        self._transition_pre_send(
            delivery_key,
            attempt_id,
            DeliveryClaimState.RETRYABLE,
        )

    def mark_send_boundary(self, delivery_key: str, attempt_id: str) -> None:
        """Atomically fail closed before any provider call can begin."""

        current = self._current_attempt(
            delivery_key,
            attempt_id,
            state=DeliveryClaimState.IN_FLIGHT,
            phase=DeliveryAttemptPhase.PRE_SEND,
        )
        now = self._now()
        self._commit_transition(
            delivery_key,
            current,
            state=DeliveryClaimState.UNKNOWN_AFTER_SEND,
            phase=DeliveryAttemptPhase.SEND_BOUNDARY,
            pre_send_lease_expires_at=None,
            send_boundary_at=self._iso(now),
            reconciled_at=None,
            reconciliation_reference=None,
            updated_at=self._iso(now),
        )

    def reconcile(
        self,
        delivery_key: str,
        attempt_id: str,
        resolution: DeliveryReconciliation,
        *,
        authorization_reference: str,
    ) -> None:
        """Resolve an unknown send only through an explicit, auditable decision."""

        _validate_reconciliation_reference(authorization_reference)
        current = self._current_attempt(
            delivery_key,
            attempt_id,
            state=DeliveryClaimState.UNKNOWN_AFTER_SEND,
            phase=DeliveryAttemptPhase.SEND_BOUNDARY,
        )
        self._reconcile_current(
            delivery_key,
            current,
            resolution,
            authorization_reference=authorization_reference,
        )

    def reconcile_authorized(
        self,
        delivery_key: str,
        resolution: DeliveryReconciliation,
        *,
        authorization_reference: str,
    ) -> None:
        """Resolve the current unknown attempt after caller authorization.

        The caller owns role, incident, and approval checks. This boundary
        requires and persists its audit-safe authority reference.
        """

        _validate_reconciliation_reference(authorization_reference)
        entity_id = self._entity_id(delivery_key)
        current = self._database.get(self._KIND, entity_id)
        if (
            current is None
            or current.get("state") != DeliveryClaimState.UNKNOWN_AFTER_SEND
            or current.get("phase") != DeliveryAttemptPhase.SEND_BOUNDARY
            or not isinstance(current.get("attempt_id"), str)
        ):
            raise RuntimeError("authorized reconciliation requires an unknown send")
        self._reconcile_current(
            delivery_key,
            current,
            resolution,
            authorization_reference=authorization_reference,
        )

    def _reconcile_current(
        self,
        delivery_key: str,
        current: Mapping[str, Any],
        resolution: DeliveryReconciliation,
        *,
        authorization_reference: str,
    ) -> None:
        now = self._now()
        self._commit_transition(
            delivery_key,
            current,
            state=_reconciled_state(resolution),
            phase=DeliveryAttemptPhase.RECONCILED,
            pre_send_lease_expires_at=None,
            send_boundary_at=current.get("send_boundary_at"),
            reconciled_at=self._iso(now),
            reconciliation_reference=authorization_reference,
            updated_at=self._iso(now),
        )

    def state(self, delivery_key: str) -> DeliveryClaimState | None:
        current = self._database.get(self._KIND, self._entity_id(delivery_key))
        if current is None:
            return None
        return DeliveryClaimState(current["state"])

    def record(self, delivery_key: str) -> dict[str, Any] | None:
        """Return a redacted state snapshot without the fencing attempt ID."""

        current = self._database.get(self._KIND, self._entity_id(delivery_key))
        if current is None:
            return None
        return {key: value for key, value in current.items() if key != "attempt_id"}

    def _transition_pre_send(
        self,
        delivery_key: str,
        attempt_id: str,
        state: DeliveryClaimState,
    ) -> None:
        current = self._current_attempt(
            delivery_key,
            attempt_id,
            state=DeliveryClaimState.IN_FLIGHT,
            phase=DeliveryAttemptPhase.PRE_SEND,
        )
        now = self._now()
        self._commit_transition(
            delivery_key,
            current,
            state=state,
            phase=DeliveryAttemptPhase.RECONCILED,
            pre_send_lease_expires_at=None,
            send_boundary_at=None,
            reconciled_at=self._iso(now),
            reconciliation_reference=None,
            updated_at=self._iso(now),
        )

    def _current_attempt(
        self,
        delivery_key: str,
        attempt_id: str,
        *,
        state: DeliveryClaimState,
        phase: DeliveryAttemptPhase,
    ) -> dict[str, Any]:
        entity_id = self._entity_id(delivery_key)
        current = self._database.get(self._KIND, entity_id)
        if current is None:
            raise RuntimeError("delivery state transition requires an existing claim")
        if (
            current.get("attempt_id") != attempt_id
            or current.get("state") != state
            or current.get("phase") != phase
        ):
            raise RuntimeError("transition requires the current delivery attempt")
        return current

    def _commit_transition(
        self,
        delivery_key: str,
        current: Mapping[str, Any],
        *,
        state: DeliveryClaimState,
        phase: DeliveryAttemptPhase,
        pre_send_lease_expires_at: str | None,
        send_boundary_at: str | None,
        reconciled_at: str | None,
        reconciliation_reference: str | None,
        updated_at: str,
    ) -> None:
        entity_id = self._entity_id(delivery_key)
        version = int(current["version"]) + 1
        try:
            self._database.commit(
                changes=[
                    EntityChange(
                        kind=self._KIND,
                        entity_id=entity_id,
                        payload=self._payload(
                            delivery_key,
                            entity_id=entity_id,
                            version=version,
                            state=state,
                            phase=phase,
                            attempt_id=str(current["attempt_id"]),
                            attempt_started_at=str(current["attempt_started_at"]),
                            pre_send_lease_expires_at=pre_send_lease_expires_at,
                            send_boundary_at=send_boundary_at,
                            reconciled_at=reconciled_at,
                            reconciliation_reference=reconciliation_reference,
                            updated_at=updated_at,
                        ),
                        version=version,
                        expected_version=version - 1,
                    )
                ]
            )
        except ConcurrentWriteError as error:
            refreshed = self._database.get(self._KIND, entity_id)
            if (
                refreshed is None
                or refreshed.get("attempt_id") != current.get("attempt_id")
                or refreshed.get("state") != state
                or refreshed.get("phase") != phase
            ):
                raise RuntimeError("delivery state changed concurrently") from error

    def _expired_pre_send_claim(
        self,
        current: Mapping[str, Any],
        now: datetime,
    ) -> bool:
        if (
            current.get("state") != DeliveryClaimState.IN_FLIGHT
            or current.get("phase") != DeliveryAttemptPhase.PRE_SEND
        ):
            return False
        lease_expires_at = self._parse_timestamp(current.get("pre_send_lease_expires_at"))
        return lease_expires_at is not None and lease_expires_at <= now

    def _now(self) -> datetime:
        value = self._clock()
        if not isinstance(value, datetime) or value.tzinfo is None:
            raise ValueError("delivery clock must return a timezone-aware datetime")
        return value.astimezone(UTC)

    @staticmethod
    def _iso(value: datetime) -> str:
        return value.astimezone(UTC).isoformat().replace("+00:00", "Z")

    @staticmethod
    def _parse_timestamp(value: object) -> datetime | None:
        if not isinstance(value, str):
            return None
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        if parsed.tzinfo is None:
            return None
        return parsed.astimezone(UTC)

    def _payload(
        self,
        delivery_key: str,
        *,
        entity_id: str,
        version: int,
        state: DeliveryClaimState,
        phase: DeliveryAttemptPhase,
        attempt_id: str,
        attempt_started_at: str,
        pre_send_lease_expires_at: str | None,
        send_boundary_at: str | None,
        reconciled_at: str | None,
        reconciliation_reference: str | None,
        updated_at: str,
    ) -> dict[str, Any]:
        return {
            "id": entity_id,
            "event_id": self._event_id(delivery_key),
            "delivery_key_digest": entity_id,
            "state": state.value,
            "phase": phase.value,
            "attempt_id": attempt_id,
            "attempt_started_at": attempt_started_at,
            "pre_send_lease_expires_at": pre_send_lease_expires_at,
            "send_boundary_at": send_boundary_at,
            "reconciled_at": reconciled_at,
            "reconciliation_reference": reconciliation_reference,
            "updated_at": updated_at,
            "version": version,
        }


def _validate_reconciliation_reference(value: str) -> None:
    if not _AUTHORITY_REFERENCE_PATTERN.fullmatch(value):
        raise ValueError("a valid reconciliation authorization reference is required")


def _reconciled_state(resolution: DeliveryReconciliation) -> DeliveryClaimState:
    resolution = DeliveryReconciliation(resolution)
    if resolution is DeliveryReconciliation.RETRY:
        return DeliveryClaimState.RETRYABLE
    if resolution is DeliveryReconciliation.REJECTED:
        return DeliveryClaimState.REJECTED
    return DeliveryClaimState.DELIVERED


def _delivery_key(
    envelope: NotificationEnvelope,
    target: OptInDeviceTarget,
) -> str:
    """Bind an event to one device without exposing a reusable token-derived value."""

    target_digest = sha256(f"{envelope.event_id}\0{target.device_token}".encode()).hexdigest()
    return f"{envelope.event_id}:target:{target_digest}"


def _result(
    envelope: NotificationEnvelope,
    target: OptInDeviceTarget,
    *,
    status: DeliveryStatus,
    provider: str,
    attempted: bool,
    retryable: bool = False,
    provider_reference: str | None = None,
    failure_code: str | None = None,
) -> DeliveryResult:
    return DeliveryResult(
        event_id=envelope.event_id,
        idempotency_key=envelope.delivery_idempotency_key(target),
        status=status,
        provider=provider,
        attempted=attempted,
        retryable=retryable,
        provider_reference=provider_reference,
        failure_code=failure_code,
    )


class DisabledNotificationGateway:
    """Fail-closed gateway used when external delivery is not configured."""

    name = "disabled"

    def __init__(self, reason: str = "NOTIFICATION_DELIVERY_DISABLED") -> None:
        self._reason = reason

    def deliver(
        self,
        envelope: NotificationEnvelope,
        target: OptInDeviceTarget,
    ) -> DeliveryResult:
        return _result(
            envelope,
            target,
            status=DeliveryStatus.SUPPRESSED,
            provider=self.name,
            attempted=False,
            failure_code=self._reason,
        )


class DemoLogNotificationGateway:
    """Deterministic no-network gateway that retains token-free demo records."""

    name = "demo-log"

    def __init__(self, deduplicator: DeliveryDeduplicator | None = None) -> None:
        self._deduplicator = deduplicator or InMemoryDeliveryDeduplicator()
        self._records: list[DemoDeliveryRecord] = []

    @property
    def records(self) -> tuple[DemoDeliveryRecord, ...]:
        return tuple(self._records)

    def deliver(
        self,
        envelope: NotificationEnvelope,
        target: OptInDeviceTarget,
    ) -> DeliveryResult:
        delivery_key = envelope.delivery_idempotency_key(target)
        if not target.opted_in:
            return _result(
                envelope,
                target,
                status=DeliveryStatus.SUPPRESSED,
                provider=self.name,
                attempted=False,
                failure_code="TARGET_NOT_OPTED_IN",
            )
        attempt_id = self._deduplicator.claim(delivery_key)
        if attempt_id is None:
            return _result(
                envelope,
                target,
                status=DeliveryStatus.DUPLICATE,
                provider=self.name,
                attempted=False,
                failure_code="DUPLICATE_DELIVERY",
            )
        self._records.append(
            DemoDeliveryRecord(
                event_id=envelope.event_id,
                idempotency_key=delivery_key,
                alert_id=envelope.alert_id,
                incident_id=envelope.incident_id,
                official=envelope.official,
            )
        )
        self._deduplicator.complete(delivery_key, attempt_id)
        return _result(
            envelope,
            target,
            status=DeliveryStatus.DEMO_RECORDED,
            provider=self.name,
            attempted=False,
        )


@dataclass(frozen=True, slots=True)
class NotificationGatewayConfig:
    """Deployment configuration with hard external-delivery guards."""

    environment: RuntimeEnvironment
    mode: GatewayMode = "disabled"
    demo_mode: bool = True
    external_delivery_enabled: bool = False
    authority_activation_reference: str | None = field(default=None, repr=False)
    firebase_project_id: str | None = None
    timeout_seconds: float = 3.0

    def validate_fcm_activation(self) -> None:
        if self.environment != "production" or self.demo_mode:
            raise NotificationConfigurationError(
                "FCM external delivery is forbidden outside non-demo production"
            )
        if not self.external_delivery_enabled:
            raise NotificationConfigurationError(
                "FCM external delivery requires explicit activation"
            )
        activation = self.authority_activation_reference or ""
        if not _AUTHORITY_REFERENCE_PATTERN.fullmatch(activation):
            raise NotificationConfigurationError(
                "FCM external delivery requires an auditable authority activation reference"
            )
        project_id = self.firebase_project_id or ""
        if not _PROJECT_ID_PATTERN.fullmatch(project_id):
            raise NotificationConfigurationError("a valid Firebase project ID is required")
        if not 0.25 <= self.timeout_seconds <= 10:
            raise NotificationConfigurationError(
                "FCM HTTP timeout must be between 0.25 and 10 seconds"
            )


class FcmHttpV1NotificationGateway:
    """Single-device Firebase Cloud Messaging HTTP v1 gateway."""

    name = "fcm-http-v1"

    def __init__(
        self,
        config: NotificationGatewayConfig,
        *,
        access_token_provider: Callable[[], str],
        http_client: HttpClient,
        deduplicator: DeliveryDeduplicator,
    ) -> None:
        config.validate_fcm_activation()
        if not getattr(deduplicator, "persistent", False):
            raise NotificationConfigurationError(
                "FCM requires an injected persistent atomic delivery deduplicator"
            )
        self._config = config
        self._access_token_provider = access_token_provider
        self._http_client = http_client
        self._deduplicator = deduplicator
        self._endpoint = (
            f"https://fcm.googleapis.com/v1/projects/{config.firebase_project_id}/messages:send"
        )

    def deliver(
        self,
        envelope: NotificationEnvelope,
        target: OptInDeviceTarget,
    ) -> DeliveryResult:
        delivery_key = envelope.delivery_idempotency_key(target)
        if not target.opted_in:
            return _result(
                envelope,
                target,
                status=DeliveryStatus.SUPPRESSED,
                provider=self.name,
                attempted=False,
                failure_code="TARGET_NOT_OPTED_IN",
            )
        attempt_id = self._deduplicator.claim(delivery_key)
        if attempt_id is None:
            return _result(
                envelope,
                target,
                status=DeliveryStatus.DUPLICATE,
                provider=self.name,
                attempted=False,
                failure_code="DUPLICATE_DELIVERY",
            )

        try:
            access_token = self._access_token_provider()
            if not access_token.strip() or any(character.isspace() for character in access_token):
                raise ValueError("invalid access token")
        except Exception:
            self._deduplicator.release(delivery_key, attempt_id)
            return _result(
                envelope,
                target,
                status=DeliveryStatus.FAILED,
                provider=self.name,
                attempted=False,
                retryable=True,
                failure_code="FCM_TOKEN_ACQUISITION_FAILED",
            )

        headers = {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json; charset=UTF-8",
            "X-FloodRISE-Event-ID": envelope.event_id,
            "X-FloodRISE-Idempotency-Key": delivery_key,
        }
        payload: dict[str, Any] = {
            "message": {
                "token": target.device_token,
                "notification": {
                    "title": envelope.title,
                    "body": envelope.body,
                },
                "data": {
                    "event_id": envelope.event_id,
                    "idempotency_key": delivery_key,
                    "alert_id": envelope.alert_id,
                    "incident_id": envelope.incident_id,
                    "official": "true" if envelope.official else "false",
                    "deep_link": envelope.deep_link,
                },
                "webpush": {
                    "headers": {
                        "TTL": str(envelope.ttl_seconds),
                        "Urgency": "high",
                    },
                    # The event-and-target key limits duplicate presentation for
                    # this device without exposing its reusable FCM token.
                    "notification": {
                        "tag": delivery_key,
                        "renotify": False,
                    },
                },
            }
        }
        try:
            self._deduplicator.mark_send_boundary(delivery_key, attempt_id)
        except RuntimeError:
            # A different worker recovered an expired pre-send lease first.
            # The fencing attempt ID prevents this stale worker from sending.
            return _result(
                envelope,
                target,
                status=DeliveryStatus.DUPLICATE,
                provider=self.name,
                attempted=False,
                failure_code="DELIVERY_CLAIM_LOST",
            )
        try:
            response = self._http_client.post(
                self._endpoint,
                headers=headers,
                json=payload,
                timeout=self._config.timeout_seconds,
            )
        except Exception:
            # The state entered UNKNOWN_AFTER_SEND before the transport call.
            # Leave it untouched until an authorized reconciliation decision.
            return _result(
                envelope,
                target,
                status=DeliveryStatus.UNKNOWN_AFTER_SEND,
                provider=self.name,
                attempted=True,
                retryable=False,
                failure_code="FCM_DELIVERY_OUTCOME_UNKNOWN",
            )

        if 200 <= response.status_code < 300:
            provider_reference = _provider_reference(response)
            self._deduplicator.reconcile(
                delivery_key,
                attempt_id,
                DeliveryReconciliation.DELIVERED,
                authorization_reference=_provider_reconciliation_reference(response.status_code),
            )
            return _result(
                envelope,
                target,
                status=DeliveryStatus.SENT,
                provider=self.name,
                attempted=True,
                provider_reference=provider_reference,
            )

        if response.status_code == 408 or response.status_code >= 500:
            # A timeout or server failure can be emitted after provider-side
            # processing began. Without provider idempotency, only explicit
            # reconciliation can safely resolve this attempt.
            return _result(
                envelope,
                target,
                status=DeliveryStatus.UNKNOWN_AFTER_SEND,
                provider=self.name,
                attempted=True,
                retryable=False,
                failure_code="FCM_DELIVERY_OUTCOME_UNKNOWN",
            )

        retryable = response.status_code in {425, 429}
        self._deduplicator.reconcile(
            delivery_key,
            attempt_id,
            (DeliveryReconciliation.RETRY if retryable else DeliveryReconciliation.REJECTED),
            authorization_reference=_provider_reconciliation_reference(response.status_code),
        )
        return _result(
            envelope,
            target,
            status=DeliveryStatus.FAILED,
            provider=self.name,
            attempted=True,
            retryable=retryable,
            failure_code=_failure_code(response.status_code),
        )


def _provider_reference(response: HttpResponse) -> str | None:
    try:
        body = response.json()
    except Exception:
        return None
    if not isinstance(body, dict):
        return None
    name = body.get("name")
    if not isinstance(name, str) or not _PROVIDER_REFERENCE_PATTERN.fullmatch(name):
        return None
    return name


def _provider_reconciliation_reference(status_code: int) -> str:
    return f"PROVIDER/FCM/HTTP/{status_code}"


def _failure_code(status_code: int) -> str:
    if status_code == 429:
        return "FCM_RATE_LIMITED"
    if status_code in {401, 403}:
        return "FCM_AUTHORIZATION_FAILED"
    if status_code == 404:
        return "FCM_TARGET_NOT_FOUND"
    if 400 <= status_code < 500:
        return "FCM_REQUEST_REJECTED"
    if status_code >= 500:
        return "FCM_PROVIDER_UNAVAILABLE"
    return "FCM_UNEXPECTED_RESPONSE"


def create_notification_gateway(
    config: NotificationGatewayConfig,
    *,
    access_token_provider: Callable[[], str] | None = None,
    http_client: HttpClient | None = None,
    deduplicator: DeliveryDeduplicator | None = None,
) -> NotificationGateway:
    """Build a gateway without silently weakening environment protections."""

    if config.mode == "disabled":
        return DisabledNotificationGateway()
    if config.mode == "demo_log":
        return DemoLogNotificationGateway(deduplicator)
    if config.mode != "fcm":
        raise NotificationConfigurationError("unsupported notification gateway mode")

    config.validate_fcm_activation()
    if access_token_provider is None or http_client is None:
        raise NotificationConfigurationError(
            "FCM requires injected token acquisition and an HTTP client"
        )
    if deduplicator is None or not getattr(deduplicator, "persistent", False):
        raise NotificationConfigurationError(
            "FCM requires an injected persistent atomic delivery deduplicator"
        )
    return FcmHttpV1NotificationGateway(
        config,
        access_token_provider=access_token_provider,
        http_client=http_client,
        deduplicator=deduplicator,
    )


__all__ = [
    "DatabaseDeliveryDeduplicator",
    "DeliveryAttemptPhase",
    "DeliveryClaimState",
    "DeliveryDeduplicator",
    "DeliveryReconciliation",
    "DeliveryResult",
    "DeliveryStatus",
    "DemoDeliveryRecord",
    "DemoLogNotificationGateway",
    "DisabledNotificationGateway",
    "FcmHttpV1NotificationGateway",
    "GatewayMode",
    "HttpClient",
    "HttpResponse",
    "InMemoryDeliveryDeduplicator",
    "NotificationConfigurationError",
    "NotificationEnvelope",
    "NotificationGateway",
    "NotificationGatewayConfig",
    "OptInDeviceTarget",
    "RuntimeEnvironment",
    "create_notification_gateway",
]
