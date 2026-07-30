"""Alembic revision-chain and lightweight migration acceptance tests."""

from __future__ import annotations

import sqlite3

from alembic import command
from alembic.config import Config
from alembic.script import ScriptDirectory

from app.config import get_settings


def test_alembic_upgrade_reaches_the_spatial_schema_head(tmp_path, monkeypatch) -> None:
    database_path = tmp_path / "migration-acceptance.sqlite3"
    database_url = f"sqlite:///{database_path}"
    monkeypatch.setenv("FLOODRISE_DATABASE_URL", database_url)
    monkeypatch.setenv("FLOODRISE_ENV", "test")
    monkeypatch.setenv("FLOODRISE_DEMO_MODE", "true")
    get_settings.cache_clear()

    config = Config("alembic.ini")
    script = ScriptDirectory.from_config(config)
    assert script.get_current_head() == "0003_concurrency_guards"

    command.upgrade(config, "head")
    with sqlite3.connect(database_path) as connection:
        version = connection.execute("SELECT version_num FROM alembic_version").fetchone()
        tables = {
            row[0]
            for row in connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            ).fetchall()
        }

    assert version == ("0003_concurrency_guards",)
    assert {
        "entities",
        "audit_events",
        "audit_chain_head",
        "outbox_events",
        "idempotency",
    } <= tables
    get_settings.cache_clear()
