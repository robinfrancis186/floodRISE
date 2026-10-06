"""Tests for the open-source ClamAV scanner and Keycloak role-claim support."""

from __future__ import annotations

import socket
import struct
import threading
from collections.abc import Iterator
from contextlib import contextmanager

import pytest

from app.auth import _claim_lookup
from app.config import Settings
from app.database import Database
from app.main import create_app
from app.media import ClamAVScanner


@contextmanager
def _fake_clamd(reply: bytes) -> Iterator[tuple[int, list[bytes]]]:
    """Speak just enough of clamd's INSTREAM protocol to exercise the client."""

    received: list[bytes] = []
    server = socket.create_server(("127.0.0.1", 0))
    port = server.getsockname()[1]

    def read_exact(connection: socket.socket, size: int) -> bytes:
        data = bytearray()
        while len(data) < size:
            chunk = connection.recv(size - len(data))
            if not chunk:
                raise ConnectionError("client closed early")
            data.extend(chunk)
        return bytes(data)

    def serve() -> None:
        connection, _ = server.accept()
        with connection:
            received.append(read_exact(connection, len(b"zINSTREAM\0")))
            body = bytearray()
            while True:
                (size,) = struct.unpack("!I", read_exact(connection, 4))
                if size == 0:
                    break
                body.extend(read_exact(connection, size))
            received.append(bytes(body))
            if reply:
                connection.sendall(reply)

    thread = threading.Thread(target=serve, daemon=True)
    thread.start()
    try:
        yield port, received
    finally:
        thread.join(timeout=5)
        server.close()


@pytest.mark.parametrize(
    ("reply", "expected"),
    [
        (b"stream: OK\0", "CLEAN"),
        (b"stream: Eicar-Signature FOUND\0", "MALICIOUS"),
        (b"INSTREAM size limit exceeded. ERROR\0", "UNAVAILABLE"),
        (b"", "UNAVAILABLE"),
    ],
)
def test_clamav_scanner_maps_clamd_replies(reply: bytes, expected: str) -> None:
    payload = b"evidence-bytes" * 10_000
    with _fake_clamd(reply) as (port, received):
        scanner = ClamAVScanner("127.0.0.1", port, timeout_seconds=5, chunk_bytes=4_096)
        assert scanner.scan(payload) == expected
    assert received == [b"zINSTREAM\0", payload]


def test_clamav_scanner_fails_closed_when_daemon_is_unreachable() -> None:
    with socket.create_server(("127.0.0.1", 0)) as placeholder:
        port = placeholder.getsockname()[1]
    assert ClamAVScanner("127.0.0.1", port, timeout_seconds=1).scan(b"x") == "UNAVAILABLE"


def test_non_demo_runtime_uses_clamav_only_when_configured() -> None:
    database = Database("sqlite://")
    application = create_app(
        Settings(
            env="development", demo_mode=False, database_url="sqlite://", clamav_host="clamav"
        ),
        database=database,
    )
    try:
        scanner = application.state.media_service.scanner
        assert isinstance(scanner, ClamAVScanner)
        assert (scanner.host, scanner.port) == ("clamav", 3310)
    finally:
        database.engine.dispose()


def test_role_claims_resolve_keycloak_nested_paths_and_prefer_exact_names() -> None:
    claims = {
        "realm_access": {"roles": ["verifier", "offline_access"]},
        "https://floodrise.example/roles": ["auditor"],
        "a.b": "exact",
        "a": {"b": "nested"},
    }
    assert _claim_lookup(claims, "realm_access.roles") == ["verifier", "offline_access"]
    assert _claim_lookup(claims, "https://floodrise.example/roles") == ["auditor"]
    assert _claim_lookup(claims, "a.b") == "exact"
    assert _claim_lookup(claims, "realm_access.missing") is None
    assert _claim_lookup(claims, "realm_access.roles.deeper") is None
