"""Contract and safety tests for the dependency-free private GCS adapter."""

from __future__ import annotations

import base64
import hashlib
import json
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import unquote

import pytest

from app.media import MAX_MEDIA_BYTES
from app.media_gcs import (
    GCSBulkOperationRefused,
    GCSMediaStoreConfigurationError,
    GCSMediaStoreConflict,
    GCSMediaStoreIntegrityError,
    GCSMediaStoreUnavailable,
    GCSPrivateMediaBlobStore,
)

NOW = datetime(2026, 7, 29, 8, 0, tzinfo=UTC)
QUARANTINE_BUCKET = "floodrise-private-quarantine"
CLEAN_BUCKET = "floodrise-private-clean"
TOKEN = "unit-test-access-token"


@dataclass(slots=True)
class FakeResponse:
    status_code: int
    document: Any = None
    content: bytes = b""
    headers: Mapping[str, str] = field(default_factory=dict)

    def json(self) -> Any:
        if isinstance(self.document, Exception):
            raise self.document
        return self.document


@dataclass(frozen=True, slots=True)
class RequestRecord:
    method: str
    url: str
    headers: Mapping[str, str]
    params: Mapping[str, str]
    content: bytes | None
    timeout: float | None


def _multipart_parts(record: RequestRecord) -> tuple[dict[str, Any], bytes]:
    content_type = record.headers["Content-Type"]
    boundary = content_type.split("boundary=", 1)[1].strip('"').encode()
    assert record.content is not None
    parts = record.content.split(b"--" + boundary)
    metadata_part = parts[1].split(b"\r\n\r\n", 1)[1].removesuffix(b"\r\n")
    payload_part = parts[2].split(b"\r\n\r\n", 1)[1].removesuffix(b"\r\n")
    return json.loads(metadata_part), payload_part


@dataclass(slots=True)
class MemoryGCSHTTP:
    """Small stateful GCS JSON API double with immutable generations."""

    records: list[RequestRecord] = field(default_factory=list)
    objects: dict[tuple[str, str], tuple[dict[str, Any], bytes]] = field(default_factory=dict)
    next_generation: int = 10
    fail_after_first_store: bool = False
    transport_secret: str = "transport-secret-should-not-leak"
    _failed_after_store: bool = False

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str] | None = None,
        params: Mapping[str, str] | None = None,
        content: bytes | None = None,
        timeout: float | None = None,
    ) -> FakeResponse:
        record = RequestRecord(
            method,
            url,
            dict(headers or {}),
            dict(params or {}),
            content,
            timeout,
        )
        self.records.append(record)
        if method == "POST":
            metadata, payload = _multipart_parts(record)
            bucket = self._bucket(url)
            name = str(metadata["name"])
            key = (bucket, name)
            if key in self.objects:
                return FakeResponse(412, {})
            remote = {
                **metadata,
                "bucket": bucket,
                "generation": str(self.next_generation),
                "size": str(len(payload)),
            }
            self.next_generation += 1
            self.objects[key] = (remote, payload)
            if self.fail_after_first_store and not self._failed_after_store:
                self._failed_after_store = True
                raise TimeoutError(self.transport_secret)
            return FakeResponse(200, remote)

        bucket = self._bucket(url)
        if url.endswith("/o"):
            prefix = str(record.params.get("prefix", ""))
            matches = [
                metadata
                for (candidate_bucket, name), (metadata, _) in sorted(self.objects.items())
                if candidate_bucket == bucket and name.startswith(prefix)
            ]
            offset = int(record.params.get("pageToken", "0"))
            limit = int(record.params.get("maxResults", "100"))
            response: dict[str, Any] = {"items": matches[offset : offset + limit]}
            next_offset = offset + limit
            if len(matches) > next_offset:
                response["nextPageToken"] = str(next_offset)
            return FakeResponse(200, response)

        name = self._object_name(url)
        key = (bucket, name)
        stored = self.objects.get(key)
        if stored is None:
            return FakeResponse(404, {})
        metadata, payload = stored
        requested_generation = record.params.get("generation")
        generation_match = record.params.get("ifGenerationMatch")
        if (
            requested_generation is not None and requested_generation != metadata["generation"]
        ) or (generation_match is not None and generation_match != metadata["generation"]):
            return FakeResponse(412, {})
        if method == "DELETE":
            del self.objects[key]
            return FakeResponse(204, {})
        if record.params.get("alt") == "media":
            return FakeResponse(206, content=payload)
        return FakeResponse(200, metadata)

    @staticmethod
    def _bucket(url: str) -> str:
        return unquote(url.split("/b/", 1)[1].split("/o", 1)[0])

    @staticmethod
    def _object_name(url: str) -> str:
        return unquote(url.split("/o/", 1)[1])


def _store(
    http: Any | None = None,
    *,
    token_provider: Callable[[], str] | None = None,
    **overrides: Any,
) -> GCSPrivateMediaBlobStore:
    return GCSPrivateMediaBlobStore(
        quarantine_bucket=QUARANTINE_BUCKET,
        clean_bucket=CLEAN_BUCKET,
        http=http or MemoryGCSHTTP(),
        token_provider=token_provider or (lambda: TOKEN),
        clock=lambda: NOW,
        sleeper=lambda _: None,
        **overrides,
    )


def _ref_document(blob_ref: str) -> dict[str, Any]:
    encoded = blob_ref.split(".", 1)[1]
    return json.loads(base64.urlsafe_b64decode(encoded + "=" * (-len(encoded) % 4)))


def _remote_for_ref(
    http: MemoryGCSHTTP,
    blob_ref: str,
) -> tuple[dict[str, Any], bytes]:
    document = _ref_document(blob_ref)
    return http.objects[(document["b"], document["n"])]


def test_quarantine_write_is_private_immutable_and_retention_tagged() -> None:
    http = MemoryGCSHTTP()
    store = _store(http)
    payload = b"private-evidence"
    deadline = NOW + timedelta(days=7)

    blob_ref = store.put_quarantine(
        "upload-one",
        payload,
        delete_after=deadline,
        operation_id="report-content-1",
    )

    request = http.records[0]
    metadata, uploaded = _multipart_parts(request)
    assert request.method == "POST"
    assert request.url.endswith(f"/b/{QUARANTINE_BUCKET}/o")
    assert request.params["uploadType"] == "multipart"
    assert request.params["ifGenerationMatch"] == "0"
    assert request.headers["Authorization"] == f"Bearer {TOKEN}"
    assert request.headers["Content-Length"] == str(len(request.content or b""))
    assert uploaded == payload
    assert metadata["cacheControl"] == "private, no-store, max-age=0"
    assert metadata["contentDisposition"] == "attachment"
    assert metadata["customTime"] == "2026-08-05T08:00:00Z"
    assert metadata["metadata"]["floodrise-delete-after"] == metadata["customTime"]
    assert metadata["metadata"]["floodrise-sha256"] == hashlib.sha256(payload).hexdigest()
    assert metadata["metadata"]["floodrise-tier"] == "quarantine"
    assert metadata["metadata"]["floodrise-visibility"] == "PRIVATE"
    assert metadata["metadata"]["floodrise-immutable"] == "true"
    serialized_request = json.dumps(
        {"url": request.url, "params": request.params, "metadata": metadata}
    ).lower()
    assert "predefinedacl" not in serialized_request
    assert '"acl"' not in serialized_request
    assert "x-goog-signature" not in serialized_request
    assert not blob_ref.startswith(("http://", "https://", "gs://"))
    assert TOKEN not in blob_ref


def test_clean_and_quarantine_writes_use_separate_buckets() -> None:
    http = MemoryGCSHTTP()
    store = _store(http)

    quarantine_ref = store.put_quarantine(
        "upload-one",
        b"raw",
        delete_after=NOW + timedelta(days=7),
    )
    clean_ref = store.put_clean(
        "upload-one",
        b"sanitized",
        delete_after=NOW + timedelta(days=30),
    )

    assert _ref_document(quarantine_ref)["b"] == QUARANTINE_BUCKET
    assert _ref_document(quarantine_ref)["t"] == "quarantine"
    assert _ref_document(clean_ref)["b"] == CLEAN_BUCKET
    assert _ref_document(clean_ref)["t"] == "clean"
    assert f"/b/{QUARANTINE_BUCKET}/" in http.records[0].url
    assert f"/b/{CLEAN_BUCKET}/" in http.records[1].url


def test_default_puts_are_distinct_but_stable_operation_id_is_idempotent() -> None:
    http = MemoryGCSHTTP()
    store = _store(http)
    deadline = NOW + timedelta(days=7)

    first = store.put_quarantine("upload-one", b"same", delete_after=deadline)
    second = store.put_quarantine("upload-one", b"same", delete_after=deadline)
    stable_first = store.put_quarantine(
        "upload-two",
        b"same",
        delete_after=deadline,
        operation_id="stable-content-operation",
    )
    stable_replay = store.put_quarantine(
        "upload-two",
        b"same",
        delete_after=deadline,
        operation_id="stable-content-operation",
    )

    assert first != second
    assert stable_first == stable_replay
    stable_posts = [
        record
        for record in http.records
        if record.method == "POST"
        and _multipart_parts(record)[0]["metadata"]["floodrise-operation-id-sha256"]
        == hashlib.sha256(b"stable-content-operation").hexdigest()
    ]
    assert len(stable_posts) == 2
    assert (
        _multipart_parts(stable_posts[0])[0]["name"] == _multipart_parts(stable_posts[1])[0]["name"]
    )
    assert any(record.method == "GET" for record in http.records)


def test_lost_success_response_recovers_same_immutable_object() -> None:
    http = MemoryGCSHTTP(fail_after_first_store=True)
    store = _store(http)

    blob_ref = store.put_quarantine(
        "upload-one",
        b"private",
        delete_after=NOW + timedelta(days=7),
        operation_id="stable-on-transport-retry",
    )

    posts = [record for record in http.records if record.method == "POST"]
    assert len(posts) == 2
    assert _multipart_parts(posts[0])[0]["name"] == _multipart_parts(posts[1])[0]["name"]
    assert _remote_for_ref(http, blob_ref)[1] == b"private"
    assert any(record.method == "GET" for record in http.records)


def test_idempotent_operation_rejects_different_payload() -> None:
    http = MemoryGCSHTTP()
    store = _store(http)
    kwargs = {
        "delete_after": NOW + timedelta(days=7),
        "operation_id": "stable-content-operation",
    }
    store.put_quarantine("upload-one", b"first", **kwargs)

    with pytest.raises(GCSMediaStoreConflict, match="did not match"):
        store.put_quarantine("upload-one", b"second", **kwargs)

    assert len(http.objects) == 1


def test_generation_pinned_read_checks_metadata_range_size_and_sha256() -> None:
    http = MemoryGCSHTTP()
    store = _store(http)
    payload = b"private-evidence-bytes"
    blob_ref = store.put_clean(
        "upload-one",
        payload,
        delete_after=NOW + timedelta(days=30),
    )

    assert store.read_clean("upload-one", blob_ref=blob_ref) == payload

    metadata_request, media_request = http.records[-2:]
    generation = _ref_document(blob_ref)["g"]
    assert metadata_request.params["generation"] == generation
    assert metadata_request.params["ifGenerationMatch"] == generation
    assert media_request.params["generation"] == generation
    assert media_request.params["ifGenerationMatch"] == generation
    assert media_request.headers["Range"] == f"bytes=0-{len(payload) - 1}"


def test_read_fails_closed_before_download_when_remote_size_is_too_large() -> None:
    http = MemoryGCSHTTP()
    store = _store(http)
    blob_ref = store.put_clean(
        "upload-one",
        b"small",
        delete_after=NOW + timedelta(days=30),
    )
    metadata, payload = _remote_for_ref(http, blob_ref)
    metadata["size"] = str(MAX_MEDIA_BYTES + 1)
    requests_before = len(http.records)

    with pytest.raises(GCSMediaStoreIntegrityError, match="bounds"):
        store.read_clean("upload-one", blob_ref=blob_ref)

    assert len(http.records) == requests_before + 1
    assert http.records[-1].params.get("alt") is None
    assert payload == b"small"


def test_read_fails_closed_when_remote_bytes_do_not_match_sha256() -> None:
    http = MemoryGCSHTTP()
    store = _store(http)
    blob_ref = store.put_quarantine(
        "upload-one",
        b"expected",
        delete_after=NOW + timedelta(days=7),
    )
    document = _ref_document(blob_ref)
    metadata, _ = _remote_for_ref(http, blob_ref)
    http.objects[(document["b"], document["n"])] = (metadata, b"tampered")

    with pytest.raises(GCSMediaStoreIntegrityError, match="SHA-256"):
        store.read_quarantine("upload-one", blob_ref=blob_ref)


def test_read_rejects_cross_tier_or_cross_upload_reference_without_http() -> None:
    http = MemoryGCSHTTP()
    store = _store(http)
    blob_ref = store.put_quarantine(
        "upload-one",
        b"expected",
        delete_after=NOW + timedelta(days=7),
    )
    requests_before = len(http.records)

    with pytest.raises(GCSMediaStoreConflict, match="not bound"):
        store.read_clean("upload-one", blob_ref=blob_ref)
    with pytest.raises(GCSMediaStoreConflict, match="not bound"):
        store.read_quarantine("upload-two", blob_ref=blob_ref)

    assert len(http.records) == requests_before


def test_read_without_reference_is_bounded_and_requires_unambiguous_object() -> None:
    http = MemoryGCSHTTP()
    store = _store(http)
    store.put_quarantine(
        "upload-one",
        b"first",
        delete_after=NOW + timedelta(days=7),
    )

    assert store.read_quarantine("upload-one") == b"first"
    listing = next(
        record
        for record in reversed(http.records)
        if record.method == "GET" and record.url.endswith("/o")
    )
    assert listing.params["maxResults"] == "2"

    store.put_quarantine(
        "upload-one",
        b"second",
        delete_after=NOW + timedelta(days=7),
    )
    with pytest.raises(GCSMediaStoreConflict, match="blob reference is required"):
        store.read_quarantine("upload-one")


def test_generation_match_delete_is_exact_and_retry_safe() -> None:
    http = MemoryGCSHTTP()
    store = _store(http)
    blob_ref = store.put_clean(
        "upload-one",
        b"sanitized",
        delete_after=NOW + timedelta(days=30),
    )
    generation = _ref_document(blob_ref)["g"]

    store.delete_clean("upload-one", blob_ref=blob_ref)
    store.delete_clean("upload-one", blob_ref=blob_ref)

    deletes = [record for record in http.records if record.method == "DELETE"]
    assert len(deletes) == 2
    assert all(record.params["generation"] == generation for record in deletes)
    assert all(record.params["ifGenerationMatch"] == generation for record in deletes)
    assert store.read_clean("upload-one", blob_ref=blob_ref) is None


def test_cleanup_paginates_boundedly_and_generation_pins_every_delete() -> None:
    http = MemoryGCSHTTP()
    store = _store(http, cleanup_batch_size=1)
    deadline = NOW + timedelta(hours=1)
    store.put_quarantine("upload-one", b"one", delete_after=deadline)
    store.put_quarantine("upload-two", b"two", delete_after=deadline)
    store.put_clean("upload-three", b"three", delete_after=deadline)

    removed = store.cleanup_expired(NOW + timedelta(hours=2))

    assert removed == 3
    listings = [
        record for record in http.records if record.method == "GET" and record.url.endswith("/o")
    ]
    assert len(listings) == 3
    assert all(record.params["maxResults"] == "1" for record in listings)
    assert any(record.params.get("pageToken") == "1" for record in listings)
    deletes = [record for record in http.records if record.method == "DELETE"]
    assert len(deletes) == 3
    assert all("ifGenerationMatch" in record.params for record in deletes)
    assert http.objects == {}


def test_cleanup_reports_when_the_bounded_page_budget_cannot_cover_the_backlog() -> None:
    http = MemoryGCSHTTP()
    store = _store(http, cleanup_batch_size=1, cleanup_max_pages=1)
    deadline = NOW + timedelta(hours=1)
    store.put_quarantine("upload-one", b"one", delete_after=deadline)
    store.put_quarantine("upload-two", b"two", delete_after=deadline)

    with pytest.raises(GCSMediaStoreUnavailable, match="bounded page limit"):
        store.cleanup_expired(NOW + timedelta(hours=2))

    assert [record for record in http.records if record.method == "DELETE"] == []
    assert len(http.objects) == 2


def test_clear_refuses_bulk_bucket_deletion() -> None:
    http = MemoryGCSHTTP()
    store = _store(http)

    with pytest.raises(GCSBulkOperationRefused, match="disabled"):
        store.clear()

    assert http.records == []


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"clean_bucket": QUARANTINE_BUCKET}, "separate buckets"),
        ({"quarantine_bucket": "Invalid Bucket"}, "valid lowercase"),
        ({"base_url": "http://storage.invalid"}, "HTTPS"),
        ({"request_timeout_seconds": 0}, "between 0 and 60"),
        ({"max_object_bytes": MAX_MEDIA_BYTES + 1}, "max_object_bytes"),
        ({"retry_attempts": 6}, "retry_attempts"),
        ({"cleanup_batch_size": 101}, "cleanup_batch_size"),
        ({"cleanup_max_pages": 0}, "cleanup_max_pages"),
    ],
)
def test_configuration_fails_closed(overrides: dict[str, Any], message: str) -> None:
    kwargs = {
        "quarantine_bucket": QUARANTINE_BUCKET,
        "clean_bucket": CLEAN_BUCKET,
        "http": MemoryGCSHTTP(),
        "token_provider": lambda: TOKEN,
        **overrides,
    }
    with pytest.raises(GCSMediaStoreConfigurationError, match=message):
        GCSPrivateMediaBlobStore(**kwargs)


def test_custom_endpoint_cannot_pass_production_adapter_gate() -> None:
    production = _store()
    emulator = _store(base_url="https://storage-emulator.invalid")

    assert production.production_approved is True
    assert emulator.production_approved is False


@pytest.mark.parametrize(
    "delete_after",
    [
        NOW.replace(tzinfo=None) + timedelta(days=1),
        NOW,
        NOW + timedelta(days=371),
    ],
)
def test_write_rejects_invalid_retention_deadline(delete_after: datetime) -> None:
    store = _store()

    with pytest.raises(ValueError, match="delete_after"):
        store.put_quarantine("upload-one", b"private", delete_after=delete_after)


def test_transport_and_credential_errors_do_not_expose_secrets() -> None:
    credential_secret = "credential-secret-should-not-leak"

    def broken_credentials() -> str:
        raise RuntimeError(credential_secret)

    credential_store = _store(token_provider=broken_credentials, retry_attempts=1)
    with pytest.raises(GCSMediaStoreUnavailable) as credential_error:
        credential_store.put_quarantine(
            "upload-one",
            b"private",
            delete_after=NOW + timedelta(days=7),
        )
    assert credential_secret not in str(credential_error.value)
    assert credential_error.value.__cause__ is None

    class BrokenTransport:
        def request(self, *_: Any, **__: Any) -> FakeResponse:
            raise RuntimeError(f"{TOKEN}:transport-secret")

    transport_store = _store(BrokenTransport(), retry_attempts=1)
    with pytest.raises(GCSMediaStoreUnavailable) as transport_error:
        transport_store.put_quarantine(
            "upload-one",
            b"private",
            delete_after=NOW + timedelta(days=7),
        )
    assert TOKEN not in str(transport_error.value)
    assert "transport-secret" not in str(transport_error.value)
    assert transport_error.value.__cause__ is None
    assert TOKEN not in repr(transport_store)


def test_http_error_response_body_is_never_reflected() -> None:
    secret = "gcs-response-secret"

    class ForbiddenTransport:
        def request(self, *_: Any, **__: Any) -> FakeResponse:
            return FakeResponse(403, {"error": {"message": secret}}, content=secret.encode())

    store = _store(ForbiddenTransport(), retry_attempts=1)
    with pytest.raises(GCSMediaStoreUnavailable) as error:
        store.put_clean(
            "upload-one",
            b"private",
            delete_after=NOW + timedelta(days=30),
        )

    assert secret not in str(error.value)
    assert "403" not in str(error.value)


def test_tampered_blob_reference_is_rejected_before_http() -> None:
    http = MemoryGCSHTTP()
    store = _store(http)
    blob_ref = store.put_clean(
        "upload-one",
        b"private",
        delete_after=NOW + timedelta(days=30),
    )
    requests_before = len(http.records)
    tampered = f"{blob_ref[:-1]}{'A' if blob_ref[-1] != 'A' else 'B'}"

    with pytest.raises(GCSMediaStoreConflict, match="invalid"):
        store.read_clean("upload-one", blob_ref=tampered)

    assert len(http.records) == requests_before


def test_remote_retention_metadata_mismatch_fails_integrity_check() -> None:
    http = MemoryGCSHTTP()
    store = _store(http)
    blob_ref = store.put_clean(
        "upload-one",
        b"private",
        delete_after=NOW + timedelta(days=30),
    )
    metadata, _ = _remote_for_ref(http, blob_ref)
    metadata["metadata"]["floodrise-delete-after"] = "2026-09-01T00:00:00Z"

    with pytest.raises(GCSMediaStoreIntegrityError, match="retention metadata"):
        store.read_clean("upload-one", blob_ref=blob_ref)


def test_empty_and_oversized_payloads_fail_before_credentials_or_http() -> None:
    credential_calls = 0
    http = MemoryGCSHTTP()

    def credentials() -> str:
        nonlocal credential_calls
        credential_calls += 1
        return TOKEN

    store = _store(http, token_provider=credentials)
    for payload in (b"", b"x" * (MAX_MEDIA_BYTES + 1)):
        with pytest.raises(ValueError, match="payload"):
            store.put_quarantine(
                "upload-one",
                payload,
                delete_after=NOW + timedelta(days=7),
            )

    assert credential_calls == 0
    assert http.records == []
