"""Serialize the audit chain head and prevent hash-chain forks.

Revision ID: 0003_concurrency_guards
Revises: 0002_postgis_operational_schema
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003_concurrency_guards"
down_revision: str | None = "0002_postgis_operational_schema"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

GENESIS_HASH = "0" * 64


def upgrade() -> None:
    op.create_table(
        "audit_chain_head",
        sa.Column("id", sa.Integer(), nullable=False),
        sa.Column("event_hash", sa.String(length=64), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.CheckConstraint("id = 1", name="ck_audit_chain_singleton"),
        sa.CheckConstraint("version >= 0", name="ck_audit_chain_version"),
    )
    bind = op.get_bind()
    latest = bind.execute(
        sa.text("SELECT event_hash, sequence FROM audit_events ORDER BY sequence DESC LIMIT 1")
    ).first()
    event_count = int(bind.execute(sa.text("SELECT COUNT(*) FROM audit_events")).scalar_one())
    bind.execute(
        sa.text(
            "INSERT INTO audit_chain_head (id, event_hash, version) "
            "VALUES (1, :event_hash, :version)"
        ),
        {
            "event_hash": str(latest.event_hash) if latest else GENESIS_HASH,
            "version": event_count,
        },
    )
    op.create_index(
        "uq_audit_previous_hash",
        "audit_events",
        ["previous_hash"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index("uq_audit_previous_hash", table_name="audit_events")
    op.drop_table("audit_chain_head")
