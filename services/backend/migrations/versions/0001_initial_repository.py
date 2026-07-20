"""Create versioned entity, audit, idempotency, and transactional outbox tables.

Revision ID: 0001_initial
Revises: None
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0001_initial"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "entities",
        sa.Column("key", sa.String(length=320), nullable=False),
        sa.Column("kind", sa.String(length=80), nullable=False),
        sa.Column("entity_id", sa.String(length=240), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("payload", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("key"),
        sa.UniqueConstraint("kind", "entity_id", name="uq_entity_kind_id"),
    )
    op.create_index("ix_entities_kind", "entities", ["kind"])
    op.create_index("ix_entities_entity_id", "entities", ["entity_id"])
    op.create_table(
        "app_state",
        sa.Column("key", sa.String(length=120), nullable=False),
        sa.Column("value", sa.Text(), nullable=False),
        sa.PrimaryKeyConstraint("key"),
    )
    op.create_table(
        "idempotency",
        sa.Column("compound_key", sa.String(length=520), nullable=False),
        sa.Column("scope", sa.String(length=120), nullable=False),
        sa.Column("idempotency_key", sa.String(length=360), nullable=False),
        sa.Column("status_code", sa.Integer(), nullable=False),
        sa.Column("response_payload", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("compound_key"),
    )
    op.create_index("ix_idempotency_scope", "idempotency", ["scope"])
    op.create_table(
        "audit_events",
        sa.Column("sequence", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("event_id", sa.String(length=80), nullable=False),
        sa.Column("event_type", sa.String(length=160), nullable=False),
        sa.Column("aggregate_kind", sa.String(length=80), nullable=False),
        sa.Column("aggregate_id", sa.String(length=240), nullable=False),
        sa.Column("aggregate_version", sa.Integer(), nullable=False),
        sa.Column("actor_id", sa.String(length=240), nullable=False),
        sa.Column("actor_role", sa.String(length=80), nullable=False),
        sa.Column("payload", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("previous_hash", sa.String(length=64), nullable=False),
        sa.Column("event_hash", sa.String(length=64), nullable=False),
        sa.Column("supersedes_event_id", sa.String(length=80), nullable=True),
        sa.PrimaryKeyConstraint("sequence"),
        sa.UniqueConstraint(
            "aggregate_kind",
            "aggregate_id",
            "aggregate_version",
            "event_type",
            name="uq_audit_aggregate_version_event",
        ),
        sa.UniqueConstraint("event_hash"),
    )
    op.create_index("ix_audit_events_event_id", "audit_events", ["event_id"], unique=True)
    op.create_index("ix_audit_events_event_type", "audit_events", ["event_type"])
    op.create_index("ix_audit_events_aggregate_kind", "audit_events", ["aggregate_kind"])
    op.create_index("ix_audit_events_aggregate_id", "audit_events", ["aggregate_id"])
    op.create_table(
        "outbox_events",
        sa.Column("sequence", sa.Integer(), autoincrement=True, nullable=False),
        sa.Column("event_id", sa.String(length=80), nullable=False),
        sa.Column("event_type", sa.String(length=160), nullable=False),
        sa.Column("incident_id", sa.String(length=240), nullable=True),
        sa.Column("resource_id", sa.String(length=240), nullable=False),
        sa.Column("resource_version", sa.Integer(), nullable=False),
        sa.Column("payload", sa.Text(), nullable=False),
        sa.Column("occurred_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("sequence"),
    )
    op.create_index("ix_outbox_events_event_id", "outbox_events", ["event_id"], unique=True)
    op.create_index("ix_outbox_events_event_type", "outbox_events", ["event_type"])
    op.create_index("ix_outbox_events_incident_id", "outbox_events", ["incident_id"])
    op.create_index("ix_outbox_events_resource_id", "outbox_events", ["resource_id"])


def downgrade() -> None:
    op.drop_table("outbox_events")
    op.drop_table("audit_events")
    op.drop_table("idempotency")
    op.drop_table("app_state")
    op.drop_table("entities")
