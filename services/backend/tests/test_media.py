"""Quarantine, privacy, and attachment tests for citizen evidence images."""

from __future__ import annotations

import hashlib
from collections.abc import Iterator
from datetime import UTC, datetime
from io import BytesIO
from typing import Any

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.config import Settings
from app.database import Database
from app.main import create_app
from app.media import MediaService, MemoryMediaBlobStore, UnavailableScanner

API = "/api/v1"
INCIDENT_ID = "inc-demo-kerala-flood-2023"
FIXED_TIME = datetime(2023, 12, 4, 14, 10, tzinfo=UTC)


@pytest.fixture
def client() -> Iterator[TestClient]:
    database = Database("sqlite://")
    application = create_app(
        Settings(env="test", demo_mode=True, database_url="sqlite://"),
        database=database,
    )
    try:
        with TestClient(application, raise_server_exceptions=False) as test_client:
            yield test_client
    finally:
        database.engine.dispose()


def _image_bytes(
    image_format: str = "JPEG",
    *,
    color: tuple[int, int, int] = (20, 120, 210),
    include_exif: bool = False,
    pattern: bool = False,
) -> bytes:
    image = Image.new("RGB", (32, 24), color)
    if pattern:
        for x in range(image.width):
            for y in range(image.height):
                image.putpixel((x, y), ((x * 7) % 256, (y * 11) % 256, ((x + y) * 5) % 256))
    output = BytesIO()
    if image_format == "JPEG" and include_exif:
        exif = image.getexif()
        exif[0x010E] = "private field note"
        exif[0x013B] = "citizen identity"
        image.save(output, format="JPEG", quality=92, exif=exif)
    else:
        image.save(output, format=image_format)
    return output.getvalue()


def _headers(user: str = "demo-reporter", role: str = "reporter") -> dict[str, str]:
    return {"X-Demo-User": user, "X-Demo-Role": role}


def _grant(
    client: TestClient,
    payload: bytes,
    *,
    content_type: str = "image/jpeg",
    key: str = "media-grant-1",
    user: str = "demo-reporter",
) -> dict[str, Any]:
    checksum = hashlib.sha256(payload).hexdigest()
    response = client.post(
        f"{API}/media/uploads",
        headers={"Idempotency-Key": key, **_headers(user)},
        json={
            "incident_id": INCIDENT_ID,
            "filename": f"evidence-{key}.jpg",
            "content_type": content_type,
            "size_bytes": len(payload),
            "sha256": checksum,
        },
    )
    assert response.status_code == 201, response.text
    grant = response.json()
    assert grant["visibility"] == "PRIVATE"
    assert grant["public_url"] is None
    assert grant["download_url"] is None
    return grant


def _upload(
    client: TestClient,
    grant: dict[str, Any],
    payload: bytes,
    *,
    key: str,
    user: str = "demo-reporter",
    checksum: str | None = None,
) -> Any:
    return client.put(
        grant["upload_url"],
        content=payload,
        headers={
            "Content-Type": grant["declared_content_type"],
            "Content-Length": str(len(payload)),
            "X-Checksum-SHA256": checksum or hashlib.sha256(payload).hexdigest(),
            "Idempotency-Key": key,
            **_headers(user),
        },
    )


def _complete(
    client: TestClient,
    grant: dict[str, Any],
    *,
    key: str,
    user: str = "demo-reporter",
) -> Any:
    return client.post(
        grant["completion_url"],
        headers={"Idempotency-Key": key, **_headers(user)},
    )


def _ready_image(
    client: TestClient,
    payload: bytes,
    *,
    prefix: str,
    user: str = "demo-reporter",
    content_type: str = "image/jpeg",
) -> dict[str, Any]:
    grant = _grant(
        client,
        payload,
        content_type=content_type,
        key=f"{prefix}-grant",
        user=user,
    )
    uploaded = _upload(client, grant, payload, key=f"{prefix}-content", user=user)
    assert uploaded.status_code == 202, uploaded.text
    completed = _complete(client, grant, key=f"{prefix}-complete", user=user)
    assert completed.status_code == 200, completed.text
    return completed.json()


def _report_payload(number: int, upload_ids: list[str]) -> dict[str, Any]:
    return {
        "client_report_id": f"media-report-{number:02d}",
        "incident_id": INCIDENT_ID,
        "reporter_id": f"reporter-{number}",
        "device_id": f"device-{number}",
        "observed_at": "2023-12-04T14:08:00Z",
        "location": {"latitude": 10.1065000, "longitude": 76.3517000, "accuracy_m": 20},
        "water_depth": "KNEE",
        "road_status": "IMPASSABLE",
        "media_upload_ids": upload_ids,
    }


def test_valid_jpeg_is_reencoded_without_exif_and_stays_private(client: TestClient) -> None:
    payload = _image_bytes(include_exif=True)
    ready = _ready_image(client, payload, prefix="valid-exif")

    assert ready["status"] == "READY_PRIVATE"
    assert ready["scanner_status"] == "DEMO_CLEAN"
    assert ready["normalized_content_type"] == "image/jpeg"
    assert ready["normalized_sha256"] != hashlib.sha256(payload).hexdigest()
    assert "perceptual_hash" not in ready
    assert client.app.state.database.get("media_upload", ready["upload_id"])["perceptual_hash"]
    assert ready["public_url"] is None and ready["download_url"] is None

    store = client.app.state.media_service.blob_store
    sanitized = store.read_clean(ready["upload_id"])
    assert sanitized is not None
    with Image.open(BytesIO(sanitized)) as image:
        assert image.format == "JPEG"
        assert not image.getexif()


def test_declared_jpeg_with_png_bytes_is_rejected_as_spoofed(client: TestClient) -> None:
    payload = _image_bytes("PNG")
    grant = _grant(client, payload, key="spoof-grant", content_type="image/jpeg")
    assert _upload(client, grant, payload, key="spoof-content").status_code == 202

    completed = _complete(client, grant, key="spoof-complete")
    assert completed.status_code == 422
    assert completed.json()["code"] == "MEDIA_TYPE_SPOOFED"

    status_response = client.get(f"{API}/media/uploads/{grant['upload_id']}", headers=_headers())
    assert status_response.json()["status"] == "REJECTED"
    assert status_response.json()["failure_code"] == "MEDIA_TYPE_SPOOFED"
    assert client.app.state.media_service.blob_store.read_clean(grant["upload_id"]) is None


def test_checksum_mismatch_never_enters_quarantine(client: TestClient) -> None:
    payload = _image_bytes()
    grant = _grant(client, payload, key="checksum-grant")
    response = _upload(
        client,
        grant,
        payload,
        key="checksum-content",
        checksum="0" * 64,
    )

    assert response.status_code == 422
    assert response.json()["code"] == "MEDIA_CHECKSUM_MISMATCH"
    assert client.app.state.media_service.blob_store.read_quarantine(grant["upload_id"]) is None


def test_malformed_image_is_rejected_after_quarantine(client: TestClient) -> None:
    payload = b"not-a-jpeg-but-checksum-valid"
    grant = _grant(client, payload, key="malformed-grant")
    assert _upload(client, grant, payload, key="malformed-content").status_code == 202

    completed = _complete(client, grant, key="malformed-complete")
    assert completed.status_code == 422
    assert completed.json()["code"] == "MEDIA_DECODE_FAILED"
    status_response = client.get(f"{API}/media/uploads/{grant['upload_id']}", headers=_headers())
    assert status_response.json()["status"] == "REJECTED"

    replay = _complete(client, grant, key="malformed-complete")
    assert replay.status_code == 422
    assert replay.json()["code"] == "MEDIA_DECODE_FAILED"


def test_near_identical_media_reuses_the_independence_family(client: TestClient) -> None:
    payload = _image_bytes()
    first = _ready_image(client, payload, prefix="duplicate-first", user="citizen-1")
    second = _ready_image(client, payload, prefix="duplicate-second", user="citizen-2")

    assert first["status"] == "READY_PRIVATE"
    assert second["status"] == "DUPLICATE_PRIVATE"
    assert "duplicate_of_upload_id" not in second
    assert "perceptual_hash" not in second
    assert "perceptual_distance" not in second
    internal = client.app.state.database.get("media_upload", second["upload_id"])
    assert internal["duplicate_of_upload_id"] == first["upload_id"]
    assert internal["perceptual_distance"] == 0

    first_report = client.post(
        f"{API}/reports",
        headers={"Idempotency-Key": "media-report-key-1", **_headers("citizen-1")},
        json=_report_payload(1, [first["upload_id"]]),
    )
    second_report = client.post(
        f"{API}/reports",
        headers={"Idempotency-Key": "media-report-key-2", **_headers("citizen-2")},
        json=_report_payload(2, [second["upload_id"]]),
    )
    assert first_report.status_code == 201, first_report.text
    assert second_report.status_code == 201, second_report.text
    assert "media_hash" not in first_report.json()["report"]
    assert "media_hash" not in second_report.json()["report"]
    assert second_report.json()["signal"]["independent_report_count"] == 1

    audit = client.get(
        f"{API}/audit",
        headers=_headers("media-auditor", "auditor"),
    )
    serialized_audit = str(audit.json())
    assert audit.status_code == 200
    assert "citizen-1" not in serialized_audit
    assert "citizen-2" not in serialized_audit
    assert first["upload_id"] not in str(
        [
            event["payload"]
            for event in audit.json()["items"]
            if event["event_type"] == "media.ready_private"
        ]
    )


def test_any_shared_private_photo_collapses_multi_photo_reports(client: TestClient) -> None:
    photo_a = _image_bytes()
    photo_b = _image_bytes(pattern=True)
    first_a = _ready_image(client, photo_a, prefix="set-first-a", user="set-citizen-1")
    duplicate_a = _ready_image(
        client,
        photo_a,
        prefix="set-second-a",
        user="set-citizen-2",
    )
    second_b = _ready_image(
        client,
        photo_b,
        prefix="set-second-b",
        user="set-citizen-2",
    )

    first_report = client.post(
        f"{API}/reports",
        headers={"Idempotency-Key": "set-report-1", **_headers("set-citizen-1")},
        json=_report_payload(11, [first_a["upload_id"]]),
    )
    second_report = client.post(
        f"{API}/reports",
        headers={"Idempotency-Key": "set-report-2", **_headers("set-citizen-2")},
        json=_report_payload(12, [duplicate_a["upload_id"], second_b["upload_id"]]),
    )

    assert first_report.status_code == second_report.status_code == 201
    assert "media_hash" not in first_report.json()["report"]
    assert "media_hash" not in second_report.json()["report"]
    assert second_report.json()["report"]["disposition"] == "DUPLICATE"
    assert second_report.json()["signal"]["independent_report_count"] == 1


def test_unrelated_flat_images_do_not_share_an_evidence_family(client: TestClient) -> None:
    first = _ready_image(
        client,
        _image_bytes(color=(20, 120, 210)),
        prefix="flat-blue",
        user="flat-citizen-1",
    )
    second = _ready_image(
        client,
        _image_bytes(color=(210, 70, 20)),
        prefix="flat-coral",
        user="flat-citizen-2",
    )

    assert first["status"] == second["status"] == "READY_PRIVATE"
    first_record = client.app.state.database.get("media_upload", first["upload_id"])
    second_record = client.app.state.database.get("media_upload", second["upload_id"])
    assert first_record["perceptual_hash"] == second_record["perceptual_hash"]
    assert first_record["independence_hash"] != second_record["independence_hash"]

    first_report = client.post(
        f"{API}/reports",
        headers={"Idempotency-Key": "flat-report-key-1", **_headers("flat-citizen-1")},
        json=_report_payload(21, [first["upload_id"]]),
    )
    second_report = client.post(
        f"{API}/reports",
        headers={"Idempotency-Key": "flat-report-key-2", **_headers("flat-citizen-2")},
        json=_report_payload(22, [second["upload_id"]]),
    )

    assert first_report.status_code == second_report.status_code == 201
    assert second_report.json()["signal"]["independent_report_count"] == 2


def test_media_idempotency_is_principal_scoped_and_payload_bound(client: TestClient) -> None:
    first_payload = _image_bytes()
    first = _grant(client, first_payload, key="shared-media-key", user="alice")
    second_payload = _image_bytes(pattern=True)
    second = _grant(client, second_payload, key="shared-media-key", user="mallory")

    assert first["upload_id"] != second["upload_id"]
    changed_same_principal = client.post(
        f"{API}/media/uploads",
        headers={"Idempotency-Key": "shared-media-key", **_headers("alice")},
        json={
            "incident_id": INCIDENT_ID,
            "filename": "changed.jpg",
            "content_type": "image/jpeg",
            "size_bytes": len(second_payload),
            "sha256": hashlib.sha256(second_payload).hexdigest(),
        },
    )
    assert changed_same_principal.status_code == 409
    assert changed_same_principal.json()["code"] == "IDEMPOTENCY_KEY_REUSED"


def test_demo_reset_clears_private_media_bytes(client: TestClient) -> None:
    ready = _ready_image(client, _image_bytes(), prefix="reset-private", user="reset-owner")
    store = client.app.state.media_service.blob_store
    assert store.read_clean(ready["upload_id"]) is not None

    reset = client.post(
        f"{API}/demo/reset",
        headers=_headers("reset-admin", "identity_administrator"),
    )

    assert reset.status_code == 200
    assert store.read_clean(ready["upload_id"]) is None
    assert store.read_quarantine(ready["upload_id"]) is None


def test_blob_state_rolls_back_when_quarantine_commit_fails(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = _image_bytes()
    grant = _grant(client, payload, key="content-rollback-grant")
    database = client.app.state.database

    def fail_commit(*args: Any, **kwargs: Any) -> None:
        del args, kwargs
        raise RuntimeError("injected commit failure")

    monkeypatch.setattr(database, "commit", fail_commit)
    response = _upload(client, grant, payload, key="content-rollback")

    assert response.status_code == 500
    assert client.app.state.media_service.blob_store.read_quarantine(grant["upload_id"]) is None


def test_clean_blob_rolls_back_but_quarantine_remains_when_ready_commit_fails(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = _image_bytes()
    grant = _grant(client, payload, key="complete-rollback-grant")
    assert _upload(client, grant, payload, key="complete-rollback-content").status_code == 202
    database = client.app.state.database

    def fail_commit(*args: Any, **kwargs: Any) -> None:
        del args, kwargs
        raise RuntimeError("injected commit failure")

    monkeypatch.setattr(database, "commit", fail_commit)
    response = _complete(client, grant, key="complete-rollback")
    store = client.app.state.media_service.blob_store

    assert response.status_code == 500
    assert store.read_clean(grant["upload_id"]) is None
    assert store.read_quarantine(grant["upload_id"]) == payload


def test_scanner_outage_retains_quarantine_and_blocks_evidence_use() -> None:
    database = Database("sqlite://")
    store = MemoryMediaBlobStore()
    media = MediaService(
        database,
        blob_store=store,
        scanner=UnavailableScanner(),
        clock=lambda: FIXED_TIME,
    )
    application = create_app(
        Settings(env="test", demo_mode=True, database_url="sqlite://"),
        database=database,
        media_service=media,
    )
    try:
        with TestClient(application, raise_server_exceptions=False) as outage_client:
            payload = _image_bytes()
            grant = _grant(outage_client, payload, key="outage-grant")
            assert _upload(outage_client, grant, payload, key="outage-content").status_code == 202
            completed = _complete(outage_client, grant, key="outage-complete")
            assert completed.status_code == 202
            assert completed.headers["Retry-After"] == "30"
            assert completed.json()["status"] == "QUARANTINED_SCANNER_UNAVAILABLE"
            assert completed.json()["scanner_status"] == "UNAVAILABLE"
            assert completed.json()["normalized_sha256"] is None
            assert store.read_quarantine(grant["upload_id"]) is not None
            assert store.read_clean(grant["upload_id"]) is None
            version_after_first_outage = completed.json()["version"]
            audit_count = len(database.audit_events(limit=200))

            repeated = _complete(outage_client, grant, key="outage-complete-poll-2")
            assert repeated.status_code == 202
            assert repeated.json()["version"] == version_after_first_outage
            assert len(database.audit_events(limit=200)) == audit_count

            report = outage_client.post(
                f"{API}/reports",
                headers={"Idempotency-Key": "outage-report", **_headers()},
                json=_report_payload(3, [grant["upload_id"]]),
            )
            assert report.status_code == 409
            assert report.json()["code"] == "MEDIA_NOT_READY"
    finally:
        database.engine.dispose()


def test_report_rejects_other_citizens_private_media(client: TestClient) -> None:
    ready = _ready_image(client, _image_bytes(), prefix="owner", user="citizen-owner")

    response = client.post(
        f"{API}/reports",
        headers={"Idempotency-Key": "other-owner-report", **_headers("different-citizen")},
        json=_report_payload(4, [ready["upload_id"]]),
    )

    assert response.status_code == 403
    assert response.json()["code"] == "PERMISSION_DENIED"


def test_non_demo_runtime_defaults_to_a_fail_closed_scanner() -> None:
    database = Database("sqlite://")
    application = create_app(
        Settings(env="development", demo_mode=False, database_url="sqlite://"),
        database=database,
    )
    try:
        assert isinstance(application.state.media_service.scanner, UnavailableScanner)
    finally:
        database.engine.dispose()
