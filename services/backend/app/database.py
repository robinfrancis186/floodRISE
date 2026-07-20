"""Small durable repository primitives for the competition MVP.

The domain is intentionally stored as versioned JSON documents.  This keeps the
demo profile lightweight while the SQLAlchemy engine remains portable to the
PostgreSQL URL used by a deployed environment.  Audit and outbox rows are never
updated after insertion.
"""

from __future__ import annotations

import hashlib
import json
from collections.abc import Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock
from typing import Any
from uuid import uuid4

from sqlalchemy import (
    DateTime,
    Integer,
    String,
    Text,
    UniqueConstraint,
    create_engine,
    delete,
    select,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, Session, mapped_column, sessionmaker
from sqlalchemy.pool import NullPool, StaticPool


def utc_now() -> datetime:
    return datetime.now(UTC)


def _json_default(value: Any) -> str:
    if isinstance(value, datetime):
        return value.astimezone(UTC).isoformat().replace("+00:00", "Z")
    raise TypeError(f"Cannot serialize {type(value)!r}")


def canonical_json(value: Any) -> str:
    return json.dumps(
        value,
        default=_json_default,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    )


def parse_json(value: str) -> Any:
    return json.loads(value)


class Base(DeclarativeBase):
    pass


class EntityRow(Base):
    __tablename__ = "entities"

    key: Mapped[str] = mapped_column(String(320), primary_key=True)
    kind: Mapped[str] = mapped_column(String(80), index=True)
    entity_id: Mapped[str] = mapped_column(String(240), index=True)
    version: Mapped[int] = mapped_column(Integer, default=1)
    payload: Mapped[str] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))

    __table_args__ = (UniqueConstraint("kind", "entity_id", name="uq_entity_kind_id"),)


class StateRow(Base):
    __tablename__ = "app_state"

    key: Mapped[str] = mapped_column(String(120), primary_key=True)
    value: Mapped[str] = mapped_column(Text)


class IdempotencyRow(Base):
    __tablename__ = "idempotency"

    compound_key: Mapped[str] = mapped_column(String(520), primary_key=True)
    scope: Mapped[str] = mapped_column(String(120), index=True)
    idempotency_key: Mapped[str] = mapped_column(String(360))
    status_code: Mapped[int] = mapped_column(Integer)
    response_payload: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class AuditRow(Base):
    __tablename__ = "audit_events"

    sequence: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    event_id: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    event_type: Mapped[str] = mapped_column(String(160), index=True)
    aggregate_kind: Mapped[str] = mapped_column(String(80), index=True)
    aggregate_id: Mapped[str] = mapped_column(String(240), index=True)
    aggregate_version: Mapped[int] = mapped_column(Integer)
    actor_id: Mapped[str] = mapped_column(String(240))
    actor_role: Mapped[str] = mapped_column(String(80))
    payload: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    previous_hash: Mapped[str] = mapped_column(String(64))
    event_hash: Mapped[str] = mapped_column(String(64), unique=True)
    supersedes_event_id: Mapped[str | None] = mapped_column(String(80), nullable=True)

    __table_args__ = (
        UniqueConstraint(
            "aggregate_kind",
            "aggregate_id",
            "aggregate_version",
            "event_type",
            name="uq_audit_aggregate_version_event",
        ),
    )


class OutboxRow(Base):
    __tablename__ = "outbox_events"

    sequence: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    event_id: Mapped[str] = mapped_column(String(80), unique=True, index=True)
    event_type: Mapped[str] = mapped_column(String(160), index=True)
    incident_id: Mapped[str | None] = mapped_column(String(240), index=True, nullable=True)
    resource_id: Mapped[str] = mapped_column(String(240), index=True)
    resource_version: Mapped[int] = mapped_column(Integer)
    payload: Mapped[str] = mapped_column(Text)
    occurred_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


@dataclass(frozen=True, slots=True)
class EntityChange:
    kind: str
    entity_id: str
    payload: Mapping[str, Any]
    version: int


@dataclass(frozen=True, slots=True)
class EventInput:
    event_type: str
    aggregate_kind: str
    aggregate_id: str
    aggregate_version: int
    actor_id: str
    actor_role: str
    payload: Mapping[str, Any]
    incident_id: str | None = None
    supersedes_event_id: str | None = None


class Database:
    """SQLAlchemy-backed JSON repository with atomic audit/outbox writes."""

    def __init__(self, database_url: str) -> None:
        self.database_url = database_url
        engine_kwargs: dict[str, Any] = {"future": True}
        if database_url.startswith("sqlite"):
            engine_kwargs["connect_args"] = {"check_same_thread": False}
            if database_url in {"sqlite://", "sqlite:///:memory:"}:
                engine_kwargs["poolclass"] = StaticPool
            else:
                # A demo reset rewrites most rows in one transaction. Opening a
                # fresh file-backed SQLite connection per request avoids stale
                # pooled file descriptors on removable/external volumes while
                # keeping the PostgreSQL production pool unchanged.
                engine_kwargs["poolclass"] = NullPool
                path = database_url.removeprefix("sqlite:///")
                if path and path != ":memory:":
                    Path(path).expanduser().resolve().parent.mkdir(parents=True, exist_ok=True)
        self.engine = create_engine(database_url, **engine_kwargs)
        self.Session = sessionmaker(bind=self.engine, expire_on_commit=False, class_=Session)
        self._lock = RLock()

    def initialize(self) -> None:
        Base.metadata.create_all(self.engine)

    @contextmanager
    def session(self) -> Iterator[Session]:
        with self.Session() as session:
            yield session

    def is_empty(self) -> bool:
        with self._lock, self.session() as session:
            return session.scalar(select(EntityRow.key).limit(1)) is None

    @staticmethod
    def entity_key(kind: str, entity_id: str) -> str:
        return f"{kind}:{entity_id}"

    def get(self, kind: str, entity_id: str) -> dict[str, Any] | None:
        with self._lock, self.session() as session:
            row = session.get(EntityRow, self.entity_key(kind, entity_id))
            return parse_json(row.payload) if row else None

    def list(self, kind: str) -> list[dict[str, Any]]:
        with self._lock, self.session() as session:
            rows = session.scalars(
                select(EntityRow).where(EntityRow.kind == kind).order_by(EntityRow.entity_id)
            ).all()
            return [parse_json(row.payload) for row in rows]

    def get_state(self, key: str, default: Any = None) -> Any:
        with self._lock, self.session() as session:
            row = session.get(StateRow, key)
            return parse_json(row.value) if row else default

    @staticmethod
    def _idempotency_storage_key(scope: str, key: str) -> tuple[str, str]:
        digest = hashlib.sha256(key.encode()).hexdigest()
        return f"{scope}:{digest}", digest

    def idempotent_response(self, scope: str, key: str) -> tuple[int, dict[str, Any]] | None:
        compound_key, _ = self._idempotency_storage_key(scope, key)
        # In-memory SQLite uses one StaticPool connection. Serialize reads as
        # well as writes so concurrent request workers never share that DB-API
        # connection at the same instant. PostgreSQL retains normal engine-level
        # pooling; the small repository lock only protects atomic domain units.
        with self._lock, self.session() as session:
            row = session.get(IdempotencyRow, compound_key)
            if not row:
                return None
            return row.status_code, parse_json(row.response_payload)

    def commit(
        self,
        *,
        changes: Sequence[EntityChange] = (),
        events: Sequence[EventInput] = (),
        state: Mapping[str, Any] | None = None,
        idempotency: tuple[str, str, int, Mapping[str, Any]] | None = None,
    ) -> list[dict[str, Any]]:
        """Commit document changes, hash-chained audit, and outbox atomically."""

        emitted: list[dict[str, Any]] = []
        with self._lock, self.Session.begin() as session:
            if idempotency:
                scope, key, _, _ = idempotency
                compound_key, _ = self._idempotency_storage_key(scope, key)
                if session.get(IdempotencyRow, compound_key):
                    raise ValueError("duplicate idempotency key")

            for change in changes:
                key = self.entity_key(change.kind, change.entity_id)
                existing = session.get(EntityRow, key)
                now = utc_now()
                if existing:
                    existing.version = change.version
                    existing.payload = canonical_json(change.payload)
                    existing.updated_at = now
                else:
                    session.add(
                        EntityRow(
                            key=key,
                            kind=change.kind,
                            entity_id=change.entity_id,
                            version=change.version,
                            payload=canonical_json(change.payload),
                            updated_at=now,
                        )
                    )

            for key, value in (state or {}).items():
                row = session.get(StateRow, key)
                if row:
                    row.value = canonical_json(value)
                else:
                    session.add(StateRow(key=key, value=canonical_json(value)))

            latest = session.scalars(
                select(AuditRow).order_by(AuditRow.sequence.desc()).limit(1)
            ).first()
            previous_hash = latest.event_hash if latest else "0" * 64
            for event in events:
                created_at = utc_now()
                event_id = f"evt-{uuid4()}"
                material = {
                    "event_id": event_id,
                    "event_type": event.event_type,
                    "aggregate_kind": event.aggregate_kind,
                    "aggregate_id": event.aggregate_id,
                    "aggregate_version": event.aggregate_version,
                    "actor_id": event.actor_id,
                    "actor_role": event.actor_role,
                    "payload": event.payload,
                    "created_at": created_at,
                    "previous_hash": previous_hash,
                    "supersedes_event_id": event.supersedes_event_id,
                }
                event_hash = hashlib.sha256(canonical_json(material).encode("utf-8")).hexdigest()
                session.add(
                    AuditRow(
                        event_id=event_id,
                        event_type=event.event_type,
                        aggregate_kind=event.aggregate_kind,
                        aggregate_id=event.aggregate_id,
                        aggregate_version=event.aggregate_version,
                        actor_id=event.actor_id,
                        actor_role=event.actor_role,
                        payload=canonical_json(event.payload),
                        created_at=created_at,
                        previous_hash=previous_hash,
                        event_hash=event_hash,
                        supersedes_event_id=event.supersedes_event_id,
                    )
                )
                outbox_payload = {
                    "id": event_id,
                    "type": event.event_type,
                    "incident_id": event.incident_id,
                    "resource_id": event.aggregate_id,
                    "version": event.aggregate_version,
                    "occurred_at": created_at,
                }
                session.add(
                    OutboxRow(
                        event_id=event_id,
                        event_type=event.event_type,
                        incident_id=event.incident_id,
                        resource_id=event.aggregate_id,
                        resource_version=event.aggregate_version,
                        payload=canonical_json(outbox_payload),
                        occurred_at=created_at,
                    )
                )
                emitted.append({**outbox_payload, "occurred_at": _json_default(created_at)})
                previous_hash = event_hash

            if idempotency:
                scope, key, status_code, response = idempotency
                compound_key, key_digest = self._idempotency_storage_key(scope, key)
                session.add(
                    IdempotencyRow(
                        compound_key=compound_key,
                        scope=scope,
                        idempotency_key=key_digest,
                        status_code=status_code,
                        response_payload=canonical_json(response),
                        created_at=utc_now(),
                    )
                )
        return emitted

    def reset(
        self,
        *,
        changes: Sequence[EntityChange],
        state: Mapping[str, Any],
        actor_id: str = "demo-system",
        actor_role: str = "identity_administrator",
    ) -> None:
        with self._lock, self.Session.begin() as session:
            for model in (OutboxRow, AuditRow, IdempotencyRow, StateRow, EntityRow):
                session.execute(delete(model))
            for change in changes:
                session.add(
                    EntityRow(
                        key=self.entity_key(change.kind, change.entity_id),
                        kind=change.kind,
                        entity_id=change.entity_id,
                        version=change.version,
                        payload=canonical_json(change.payload),
                        updated_at=utc_now(),
                    )
                )
            for key, value in state.items():
                session.add(StateRow(key=key, value=canonical_json(value)))

            created_at = utc_now()
            event_id = f"evt-{uuid4()}"
            payload = {"reason": "deterministic demo reset", "is_simulated": True}
            material = {
                "event_id": event_id,
                "event_type": "demo.reset",
                "aggregate_kind": "scenario",
                "aggregate_id": str(state.get("scenario_id", "demo")),
                "aggregate_version": 1,
                "actor_id": actor_id,
                "actor_role": actor_role,
                "payload": payload,
                "created_at": created_at,
                "previous_hash": "0" * 64,
                "supersedes_event_id": None,
            }
            event_hash = hashlib.sha256(canonical_json(material).encode()).hexdigest()
            session.add(
                AuditRow(
                    event_id=event_id,
                    event_type="demo.reset",
                    aggregate_kind="scenario",
                    aggregate_id=str(state.get("scenario_id", "demo")),
                    aggregate_version=1,
                    actor_id=actor_id,
                    actor_role=actor_role,
                    payload=canonical_json(payload),
                    created_at=created_at,
                    previous_hash="0" * 64,
                    event_hash=event_hash,
                )
            )
            outbox_payload = {
                "id": event_id,
                "type": "demo.reset",
                "incident_id": state.get("incident_id"),
                "resource_id": state.get("scenario_id", "demo"),
                "version": 1,
                "occurred_at": created_at,
            }
            session.add(
                OutboxRow(
                    event_id=event_id,
                    event_type="demo.reset",
                    incident_id=state.get("incident_id"),
                    resource_id=str(state.get("scenario_id", "demo")),
                    resource_version=1,
                    payload=canonical_json(outbox_payload),
                    occurred_at=created_at,
                )
            )

    def audit_events(self, *, limit: int = 200) -> list[dict[str, Any]]:
        limit = max(1, min(limit, 1_000))
        with self._lock, self.session() as session:
            rows = session.scalars(
                select(AuditRow).order_by(AuditRow.sequence.desc()).limit(limit)
            ).all()
            return [
                {
                    "sequence": row.sequence,
                    "id": row.event_id,
                    "event_type": row.event_type,
                    "aggregate_kind": row.aggregate_kind,
                    "aggregate_id": row.aggregate_id,
                    "aggregate_version": row.aggregate_version,
                    "actor_id": row.actor_id,
                    "actor_role": row.actor_role,
                    "payload": parse_json(row.payload),
                    "created_at": row.created_at.replace(tzinfo=UTC)
                    if row.created_at.tzinfo is None
                    else row.created_at,
                    "previous_hash": row.previous_hash,
                    "event_hash": row.event_hash,
                    "supersedes_event_id": row.supersedes_event_id,
                }
                for row in rows
            ]

    def outbox_events(self, *, after_sequence: int = 0, limit: int = 200) -> list[dict[str, Any]]:
        limit = max(1, min(limit, 1_000))
        with self._lock, self.session() as session:
            rows = session.scalars(
                select(OutboxRow)
                .where(OutboxRow.sequence > after_sequence)
                .order_by(OutboxRow.sequence)
                .limit(limit)
            ).all()
            return [{"sequence": row.sequence, **parse_json(row.payload)} for row in rows]

    def verify_audit_chain(self) -> bool:
        with self._lock, self.session() as session:
            rows = session.scalars(select(AuditRow).order_by(AuditRow.sequence)).all()
            previous_hash = "0" * 64
            for row in rows:
                material = {
                    "event_id": row.event_id,
                    "event_type": row.event_type,
                    "aggregate_kind": row.aggregate_kind,
                    "aggregate_id": row.aggregate_id,
                    "aggregate_version": row.aggregate_version,
                    "actor_id": row.actor_id,
                    "actor_role": row.actor_role,
                    "payload": parse_json(row.payload),
                    "created_at": row.created_at.replace(tzinfo=UTC)
                    if row.created_at.tzinfo is None
                    else row.created_at,
                    "previous_hash": previous_hash,
                    "supersedes_event_id": row.supersedes_event_id,
                }
                expected = hashlib.sha256(canonical_json(material).encode()).hexdigest()
                if row.previous_hash != previous_hash or row.event_hash != expected:
                    return False
                previous_hash = row.event_hash
            return True
