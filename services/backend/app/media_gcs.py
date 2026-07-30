"""Private Google Cloud Storage adapter for flood evidence.

This module intentionally depends only on small injected protocols.  A caller
may pass an ``httpx.Client`` and a Google access-token provider in production,
while tests can use an in-memory transport without importing a Google SDK.

Objects are immutable: each write uses ``ifGenerationMatch=0`` and every read
or delete is pinned to the generation returned by GCS.  Object references are
opaque application values rather than URLs, and this adapter never creates an
ACL, signed URL, or public download path.
"""

from __future__ import annotations

import base64
import hashlib
import json
import re
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any, Literal, Protocol
from urllib.parse import quote
from uuid import uuid4

from .media import MAX_MEDIA_BYTES

_GOOGLE_STORAGE_ENDPOINT = "https://storage.googleapis.com"
_RETRIABLE_STATUS_CODES = frozenset({408, 429, 500, 502, 503, 504})
_BUCKET_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$")
_HEX_SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}$")
_OPERATION_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_REFERENCE_PREFIX = "gcs1."
_OBJECT_ROOT = "floodrise/v1"

MediaTier = Literal["quarantine", "clean"]


class HTTPResponse(Protocol):
    """Minimal response shape required from an injected HTTP client."""

    status_code: int
    headers: Mapping[str, str]
    content: bytes

    def json(self) -> Any: ...


class SyncHTTPTransport(Protocol):
    """Minimal synchronous transport shape implemented by ``httpx.Client``."""

    def request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str] | None = None,
        params: Mapping[str, str] | None = None,
        content: bytes | None = None,
        timeout: float | None = None,
    ) -> HTTPResponse: ...


class GCSMediaStoreError(RuntimeError):
    """Base class for sanitized storage-boundary failures."""


class GCSMediaStoreUnavailable(GCSMediaStoreError):
    """The token provider, transport, or GCS service was unavailable."""


class GCSMediaStoreConflict(GCSMediaStoreError):
    """An immutable object or generation precondition did not match."""


class GCSMediaStoreIntegrityError(GCSMediaStoreError):
    """Remote metadata or bytes did not match their immutable receipt."""


class GCSMediaStoreConfigurationError(ValueError):
    """Unsafe or incomplete adapter configuration."""


class GCSBulkOperationRefused(GCSMediaStoreError):
    """Broad evidence deletion was intentionally blocked."""


@dataclass(frozen=True, slots=True)
class _ObjectLocator:
    tier: MediaTier
    bucket: str
    object_name: str
    generation: str
    size: int
    sha256: str


@dataclass(slots=True)
class GCSPrivateMediaBlobStore:
    """Generation-pinned, private GCS implementation of ``MediaBlobStore``.

    ``operation_id`` on the put methods is optional so the methods remain
    compatible with the existing ``MediaBlobStore`` protocol.  Supplying the
    same stable operation ID makes a retry in another process resolve the exact
    same immutable object.  Without it, every call creates a distinct object,
    matching the protocol's per-write ownership rule.

    Bucket lifecycle configuration should delete objects at or after
    ``customTime``.  ``cleanup_expired`` is a bounded safety sweep, not a
    replacement for that lifecycle policy.
    """

    quarantine_bucket: str
    clean_bucket: str
    http: SyncHTTPTransport = field(repr=False)
    token_provider: Callable[[], str] = field(repr=False)
    base_url: str = _GOOGLE_STORAGE_ENDPOINT
    request_timeout_seconds: float = 10.0
    max_object_bytes: int = MAX_MEDIA_BYTES
    max_retention: timedelta = timedelta(days=370)
    retry_attempts: int = 3
    cleanup_batch_size: int = 32
    cleanup_max_pages: int = 4
    clock: Callable[[], datetime] = field(
        default=lambda: datetime.now(UTC),
        repr=False,
    )
    sleeper: Callable[[float], None] = field(default=time.sleep, repr=False)
    production_approved: bool = field(init=False)

    def __post_init__(self) -> None:
        self.base_url = self.base_url.rstrip("/")
        for label, bucket in (
            ("quarantine_bucket", self.quarantine_bucket),
            ("clean_bucket", self.clean_bucket),
        ):
            if not _BUCKET_PATTERN.fullmatch(bucket):
                raise GCSMediaStoreConfigurationError(
                    f"{label} must be a valid lowercase GCS bucket name"
                )
        if self.quarantine_bucket == self.clean_bucket:
            raise GCSMediaStoreConfigurationError(
                "quarantine and clean evidence must use separate buckets"
            )
        if not self.base_url.startswith("https://"):
            raise GCSMediaStoreConfigurationError("GCS transport must use HTTPS")
        if self.request_timeout_seconds <= 0 or self.request_timeout_seconds > 60:
            raise GCSMediaStoreConfigurationError(
                "request_timeout_seconds must be between 0 and 60"
            )
        if self.max_object_bytes <= 0 or self.max_object_bytes > MAX_MEDIA_BYTES:
            raise GCSMediaStoreConfigurationError(
                f"max_object_bytes must be between 1 and {MAX_MEDIA_BYTES}"
            )
        if self.max_retention <= timedelta(0) or self.max_retention > timedelta(days=370):
            raise GCSMediaStoreConfigurationError(
                "max_retention must be positive and no more than 370 days"
            )
        if not 1 <= self.retry_attempts <= 5:
            raise GCSMediaStoreConfigurationError("retry_attempts must be between 1 and 5")
        if not 1 <= self.cleanup_batch_size <= 100:
            raise GCSMediaStoreConfigurationError("cleanup_batch_size must be between 1 and 100")
        if not 1 <= self.cleanup_max_pages <= 20:
            raise GCSMediaStoreConfigurationError("cleanup_max_pages must be between 1 and 20")
        # Custom endpoints are useful for emulators but must never satisfy the
        # application's live-adapter gate.
        self.production_approved = self.base_url == _GOOGLE_STORAGE_ENDPOINT

    def put_quarantine(
        self,
        upload_id: str,
        payload: bytes,
        *,
        delete_after: datetime,
        operation_id: str | None = None,
    ) -> str:
        return self._put(
            "quarantine",
            upload_id,
            payload,
            delete_after=delete_after,
            operation_id=operation_id,
        )

    def read_quarantine(
        self,
        upload_id: str,
        *,
        blob_ref: str | None = None,
    ) -> bytes | None:
        return self._read("quarantine", upload_id, blob_ref=blob_ref)

    def put_clean(
        self,
        upload_id: str,
        payload: bytes,
        *,
        delete_after: datetime,
        operation_id: str | None = None,
    ) -> str:
        return self._put(
            "clean",
            upload_id,
            payload,
            delete_after=delete_after,
            operation_id=operation_id,
        )

    def read_clean(
        self,
        upload_id: str,
        *,
        blob_ref: str | None = None,
    ) -> bytes | None:
        return self._read("clean", upload_id, blob_ref=blob_ref)

    def delete_quarantine(
        self,
        upload_id: str,
        *,
        blob_ref: str,
    ) -> None:
        self._delete("quarantine", upload_id, blob_ref)

    def delete_clean(
        self,
        upload_id: str,
        *,
        blob_ref: str,
    ) -> None:
        self._delete("clean", upload_id, blob_ref)

    def cleanup_expired(self, now: datetime) -> int:
        """Scan a bounded number of pages and delete every expired object found."""

        current = self._aware_utc(now, field_name="now")
        removed = 0
        for tier in ("quarantine", "clean"):
            bucket = self._bucket(tier)
            page_token: str | None = None
            seen_page_tokens: set[str] = set()
            expired: list[_ObjectLocator] = []
            for _ in range(self.cleanup_max_pages):
                params = {
                    "prefix": f"{_OBJECT_ROOT}/{tier}/",
                    "projection": "full",
                    "maxResults": str(self.cleanup_batch_size),
                    "fields": (
                        "items(bucket,name,generation,size,customTime,metadata),nextPageToken"
                    ),
                }
                if page_token is not None:
                    params["pageToken"] = page_token
                response = self._request(
                    "GET",
                    self._collection_url(bucket),
                    params=params,
                )
                if response.status_code != 200:
                    self._raise_status("retention sweep", response.status_code)
                document = self._json_object(response, operation="retention sweep")
                supplied_items = document.get("items", [])
                if not isinstance(supplied_items, list):
                    raise GCSMediaStoreIntegrityError(
                        "GCS returned invalid retention-list metadata"
                    )
                if len(supplied_items) > self.cleanup_batch_size:
                    raise GCSMediaStoreIntegrityError(
                        "GCS exceeded the bounded retention-list response"
                    )

                for item in supplied_items:
                    if not isinstance(item, Mapping):
                        raise GCSMediaStoreIntegrityError(
                            "GCS returned invalid retention object metadata"
                        )
                    deadline = self._retention_deadline(item)
                    if deadline <= current:
                        expired.append(self._locator_from_listing(tier, item))

                next_page_token = document.get("nextPageToken")
                if next_page_token is None or next_page_token == "":
                    page_token = None
                    break
                if (
                    not isinstance(next_page_token, str)
                    or next_page_token != next_page_token.strip()
                    or len(next_page_token) > 2_048
                    or next_page_token in seen_page_tokens
                ):
                    raise GCSMediaStoreIntegrityError(
                        "GCS returned an invalid retention page token"
                    )
                seen_page_tokens.add(next_page_token)
                page_token = next_page_token
            else:
                if page_token is not None:
                    raise GCSMediaStoreUnavailable(
                        "Private GCS retention sweep exceeded its bounded page limit"
                    )

            for locator in expired:
                self._delete_locator(locator)
                removed += 1
        return removed

    def clear(self) -> None:
        """Refuse unscoped bucket deletion.

        The application calls ``clear`` only for its in-memory demo reset.  A
        production evidence store must be cleared through an independently
        authorized retention/export procedure, never through the web process.
        """

        raise GCSBulkOperationRefused("Bulk clearing of private evidence buckets is disabled")

    def _put(
        self,
        tier: MediaTier,
        upload_id: str,
        payload: bytes,
        *,
        delete_after: datetime,
        operation_id: str | None,
    ) -> str:
        self._validate_upload_id(upload_id)
        stored = bytes(payload)
        if not stored or len(stored) > self.max_object_bytes:
            raise ValueError(
                f"private media payload must contain 1 to {self.max_object_bytes} bytes"
            )
        deadline = self._validate_deadline(delete_after)
        supplied_operation_id = operation_id or uuid4().hex
        if not _OPERATION_ID_PATTERN.fullmatch(supplied_operation_id):
            raise ValueError("operation_id must contain 1 to 128 URL-safe identifier characters")

        bucket = self._bucket(tier)
        upload_hash = self._upload_hash(upload_id)
        operation_hash = hashlib.sha256(supplied_operation_id.encode()).hexdigest()
        object_name = f"{_OBJECT_ROOT}/{tier}/{upload_hash}/{operation_hash}"
        payload_sha256 = hashlib.sha256(stored).hexdigest()
        deadline_text = self._iso(deadline)
        metadata = {
            "name": object_name,
            "contentType": "application/octet-stream",
            "cacheControl": "private, no-store, max-age=0",
            "contentDisposition": "attachment",
            "customTime": deadline_text,
            "metadata": {
                "floodrise-sha256": payload_sha256,
                "floodrise-delete-after": deadline_text,
                "floodrise-upload-id-sha256": upload_hash,
                "floodrise-operation-id-sha256": operation_hash,
                "floodrise-tier": tier,
                "floodrise-visibility": "PRIVATE",
                "floodrise-immutable": "true",
            },
        }
        body, content_type = self._multipart_body(metadata, stored)
        response = self._request(
            "POST",
            self._upload_url(bucket),
            headers={
                "Content-Type": content_type,
                "Content-Length": str(len(body)),
                "Accept": "application/json",
            },
            params={
                "uploadType": "multipart",
                "ifGenerationMatch": "0",
                "fields": (
                    "bucket,name,generation,size,customTime,metadata,cacheControl,contentType"
                ),
            },
            content=body,
        )
        if response.status_code in {200, 201}:
            remote = self._json_object(response, operation="immutable media write")
        elif response.status_code == 412:
            # A retry may have reached GCS after the first successful response
            # was lost. Resolve only the same immutable name, then verify every
            # payload-binding field before treating the write as successful.
            remote = self._get_metadata_by_name(bucket, object_name)
            if remote is None:
                raise GCSMediaStoreConflict("The immutable GCS write precondition failed")
        else:
            self._raise_status("immutable media write", response.status_code)

        locator = self._validated_locator(
            tier,
            upload_id,
            remote,
            expected_name=object_name,
            expected_sha256=payload_sha256,
            expected_size=len(stored),
            expected_operation_hash=operation_hash,
            expected_deadline=deadline,
        )
        return self._encode_ref(locator)

    def _read(
        self,
        tier: MediaTier,
        upload_id: str,
        *,
        blob_ref: str | None,
    ) -> bytes | None:
        self._validate_upload_id(upload_id)
        locator = (
            self._decode_and_bind_ref(blob_ref, tier, upload_id)
            if blob_ref is not None
            else self._resolve_single(tier, upload_id)
        )
        if locator is None:
            return None

        metadata = self._get_metadata(locator)
        if metadata is None:
            return None
        self._validate_locator_metadata(locator, upload_id, metadata)

        response = self._request(
            "GET",
            self._object_url(locator.bucket, locator.object_name),
            headers={
                "Accept": "application/octet-stream",
                "Range": f"bytes=0-{locator.size - 1}",
            },
            params={
                "alt": "media",
                "generation": locator.generation,
                "ifGenerationMatch": locator.generation,
            },
        )
        if response.status_code == 404:
            return None
        if response.status_code == 412:
            raise GCSMediaStoreConflict(
                "The private media generation changed during its bounded read"
            )
        if response.status_code not in {200, 206}:
            self._raise_status("private media read", response.status_code)
        content = response.content
        if not isinstance(content, bytes):
            raise GCSMediaStoreIntegrityError("GCS returned a non-bytes media response")
        if len(content) != locator.size or len(content) > self.max_object_bytes:
            raise GCSMediaStoreIntegrityError(
                "Private media bytes did not match the bounded object size"
            )
        if hashlib.sha256(content).hexdigest() != locator.sha256:
            raise GCSMediaStoreIntegrityError(
                "Private media bytes failed their SHA-256 integrity check"
            )
        return content

    def _delete(self, tier: MediaTier, upload_id: str, blob_ref: str) -> None:
        self._validate_upload_id(upload_id)
        locator = self._decode_and_bind_ref(blob_ref, tier, upload_id)
        self._delete_locator(locator)

    def _delete_locator(self, locator: _ObjectLocator) -> None:
        response = self._request(
            "DELETE",
            self._object_url(locator.bucket, locator.object_name),
            params={
                "generation": locator.generation,
                "ifGenerationMatch": locator.generation,
            },
        )
        # A retry after a successful delete safely observes 404.
        if response.status_code in {200, 204, 404}:
            return
        if response.status_code == 412:
            raise GCSMediaStoreConflict(
                "The private media generation did not match during deletion"
            )
        self._raise_status("generation-pinned media deletion", response.status_code)

    def _resolve_single(
        self,
        tier: MediaTier,
        upload_id: str,
    ) -> _ObjectLocator | None:
        bucket = self._bucket(tier)
        prefix = f"{_OBJECT_ROOT}/{tier}/{self._upload_hash(upload_id)}/"
        response = self._request(
            "GET",
            self._collection_url(bucket),
            params={
                "prefix": prefix,
                "projection": "full",
                "maxResults": "2",
                "fields": ("items(bucket,name,generation,size,customTime,metadata),nextPageToken"),
            },
        )
        if response.status_code != 200:
            self._raise_status("private media reference lookup", response.status_code)
        document = self._json_object(response, operation="private media reference lookup")
        items = document.get("items", [])
        if not isinstance(items, list):
            raise GCSMediaStoreIntegrityError(
                "GCS returned invalid private media reference metadata"
            )
        if not items:
            return None
        if len(items) != 1 or document.get("nextPageToken"):
            raise GCSMediaStoreConflict(
                "A blob reference is required when an upload has multiple immutable objects"
            )
        item = items[0]
        if not isinstance(item, Mapping):
            raise GCSMediaStoreIntegrityError("GCS returned invalid private media object metadata")
        locator = self._locator_from_listing(tier, item)
        self._validate_locator_metadata(locator, upload_id, item)
        return locator

    def _get_metadata(self, locator: _ObjectLocator) -> Mapping[str, Any] | None:
        response = self._request(
            "GET",
            self._object_url(locator.bucket, locator.object_name),
            params={
                "generation": locator.generation,
                "ifGenerationMatch": locator.generation,
                "fields": "bucket,name,generation,size,customTime,metadata",
            },
        )
        if response.status_code == 404:
            return None
        if response.status_code == 412:
            raise GCSMediaStoreConflict(
                "The private media generation did not match its immutable reference"
            )
        if response.status_code != 200:
            self._raise_status("private media metadata read", response.status_code)
        return self._json_object(response, operation="private media metadata read")

    def _get_metadata_by_name(
        self,
        bucket: str,
        object_name: str,
    ) -> Mapping[str, Any] | None:
        response = self._request(
            "GET",
            self._object_url(bucket, object_name),
            params={
                "fields": (
                    "bucket,name,generation,size,customTime,metadata,cacheControl,contentType"
                )
            },
        )
        if response.status_code == 404:
            return None
        if response.status_code != 200:
            self._raise_status("immutable media recovery", response.status_code)
        return self._json_object(response, operation="immutable media recovery")

    def _validated_locator(
        self,
        tier: MediaTier,
        upload_id: str,
        remote: Mapping[str, Any],
        *,
        expected_name: str,
        expected_sha256: str,
        expected_size: int,
        expected_operation_hash: str,
        expected_deadline: datetime,
    ) -> _ObjectLocator:
        locator = self._locator_from_listing(tier, remote)
        expected_bucket = self._bucket(tier)
        metadata = self._custom_metadata(remote)
        expected_upload_hash = self._upload_hash(upload_id)
        checks = (
            locator.bucket == expected_bucket,
            locator.object_name == expected_name,
            locator.sha256 == expected_sha256,
            locator.size == expected_size,
            metadata.get("floodrise-upload-id-sha256") == expected_upload_hash,
            metadata.get("floodrise-operation-id-sha256") == expected_operation_hash,
            metadata.get("floodrise-tier") == tier,
            metadata.get("floodrise-visibility") == "PRIVATE",
            metadata.get("floodrise-immutable") == "true",
            self._retention_deadline(remote) == expected_deadline,
        )
        if not all(checks):
            raise GCSMediaStoreConflict(
                "Existing immutable GCS media did not match the requested write"
            )
        return locator

    def _validate_locator_metadata(
        self,
        locator: _ObjectLocator,
        upload_id: str,
        remote: Mapping[str, Any],
    ) -> None:
        remote_locator = self._locator_from_listing(locator.tier, remote)
        metadata = self._custom_metadata(remote)
        checks = (
            remote_locator == locator,
            metadata.get("floodrise-upload-id-sha256") == self._upload_hash(upload_id),
            metadata.get("floodrise-tier") == locator.tier,
            metadata.get("floodrise-visibility") == "PRIVATE",
            metadata.get("floodrise-immutable") == "true",
        )
        if not all(checks):
            raise GCSMediaStoreIntegrityError(
                "Private media metadata did not match its immutable reference"
            )
        self._retention_deadline(remote)

    def _locator_from_listing(
        self,
        tier: MediaTier,
        remote: Mapping[str, Any],
    ) -> _ObjectLocator:
        try:
            bucket = str(remote["bucket"])
            object_name = str(remote["name"])
            generation = str(remote["generation"])
            size = int(remote["size"])
            sha256 = str(self._custom_metadata(remote)["floodrise-sha256"])
        except (KeyError, TypeError, ValueError):
            raise GCSMediaStoreIntegrityError(
                "GCS object metadata was incomplete or invalid"
            ) from None
        if (
            bucket != self._bucket(tier)
            or not generation.isdecimal()
            or int(generation) <= 0
            or not 1 <= size <= self.max_object_bytes
            or not _HEX_SHA256_PATTERN.fullmatch(sha256)
        ):
            raise GCSMediaStoreIntegrityError(
                "GCS object metadata violated the private media bounds"
            )
        return _ObjectLocator(
            tier=tier,
            bucket=bucket,
            object_name=object_name,
            generation=generation,
            size=size,
            sha256=sha256,
        )

    def _retention_deadline(self, remote: Mapping[str, Any]) -> datetime:
        metadata = self._custom_metadata(remote)
        metadata_deadline = self._parse_datetime(metadata.get("floodrise-delete-after"))
        custom_time = self._parse_datetime(remote.get("customTime"))
        if metadata_deadline is None or custom_time is None or metadata_deadline != custom_time:
            raise GCSMediaStoreIntegrityError(
                "GCS object retention metadata was missing or inconsistent"
            )
        return metadata_deadline

    @staticmethod
    def _custom_metadata(remote: Mapping[str, Any]) -> Mapping[str, Any]:
        metadata = remote.get("metadata")
        if not isinstance(metadata, Mapping):
            raise GCSMediaStoreIntegrityError("GCS object custom metadata was missing or invalid")
        return metadata

    def _decode_and_bind_ref(
        self,
        blob_ref: str,
        tier: MediaTier,
        upload_id: str,
    ) -> _ObjectLocator:
        locator = self._decode_ref(blob_ref)
        expected_prefix = f"{_OBJECT_ROOT}/{tier}/{self._upload_hash(upload_id)}/"
        if (
            locator.tier != tier
            or locator.bucket != self._bucket(tier)
            or not locator.object_name.startswith(expected_prefix)
            or "/" in locator.object_name.removeprefix(expected_prefix)
        ):
            raise GCSMediaStoreConflict(
                "The private media reference is not bound to this upload and tier"
            )
        return locator

    @staticmethod
    def _encode_ref(locator: _ObjectLocator) -> str:
        raw = json.dumps(
            {
                "b": locator.bucket,
                "g": locator.generation,
                "n": locator.object_name,
                "s": locator.sha256,
                "t": locator.tier,
                "z": locator.size,
            },
            separators=(",", ":"),
            sort_keys=True,
        ).encode()
        encoded = base64.urlsafe_b64encode(raw).decode().rstrip("=")
        return f"{_REFERENCE_PREFIX}{encoded}"

    def _decode_ref(self, blob_ref: str) -> _ObjectLocator:
        if not isinstance(blob_ref, str) or not blob_ref.startswith(_REFERENCE_PREFIX):
            raise GCSMediaStoreConflict("The private media reference is invalid")
        encoded = blob_ref.removeprefix(_REFERENCE_PREFIX)
        if not encoded or len(encoded) > 2048:
            raise GCSMediaStoreConflict("The private media reference is invalid")
        try:
            padding = "=" * (-len(encoded) % 4)
            document = json.loads(base64.urlsafe_b64decode(encoded + padding))
            tier = document["t"]
            locator = _ObjectLocator(
                tier=tier,
                bucket=str(document["b"]),
                object_name=str(document["n"]),
                generation=str(document["g"]),
                size=int(document["z"]),
                sha256=str(document["s"]),
            )
        except (KeyError, TypeError, ValueError, json.JSONDecodeError):
            raise GCSMediaStoreConflict("The private media reference is invalid") from None
        if (
            tier not in {"quarantine", "clean"}
            or not locator.generation.isdecimal()
            or int(locator.generation) <= 0
            or not 1 <= locator.size <= self.max_object_bytes
            or not _HEX_SHA256_PATTERN.fullmatch(locator.sha256)
        ):
            raise GCSMediaStoreConflict("The private media reference is invalid")
        return locator

    def _request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str] | None = None,
        params: Mapping[str, str] | None = None,
        content: bytes | None = None,
    ) -> HTTPResponse:
        last_status: int | None = None
        for attempt in range(self.retry_attempts):
            token = self._access_token()
            request_headers = {
                **dict(headers or {}),
                "Authorization": f"Bearer {token}",
                "User-Agent": "floodRISE-media-gcs/1",
            }
            try:
                response = self.http.request(
                    method,
                    url,
                    headers=request_headers,
                    params=dict(params or {}),
                    content=content,
                    timeout=self.request_timeout_seconds,
                )
            except Exception:
                if attempt + 1 == self.retry_attempts:
                    raise GCSMediaStoreUnavailable(
                        "Private GCS media transport is unavailable"
                    ) from None
                self.sleeper(min(0.1 * (2**attempt), 1.0))
                continue
            last_status = response.status_code
            if (
                response.status_code not in _RETRIABLE_STATUS_CODES
                or attempt + 1 == self.retry_attempts
            ):
                return response
            self.sleeper(min(0.1 * (2**attempt), 1.0))
        raise GCSMediaStoreUnavailable(
            f"Private GCS media transport failed with status {last_status or 'unknown'}"
        )

    def _access_token(self) -> str:
        try:
            token = self.token_provider()
        except Exception:
            raise GCSMediaStoreUnavailable("Private GCS credentials are unavailable") from None
        if (
            not isinstance(token, str)
            or not token
            or token != token.strip()
            or any(character.isspace() for character in token)
            or len(token) > 8192
        ):
            raise GCSMediaStoreUnavailable("Private GCS credentials are unavailable")
        return token

    @staticmethod
    def _json_object(response: HTTPResponse, *, operation: str) -> Mapping[str, Any]:
        try:
            document = response.json()
        except Exception:
            raise GCSMediaStoreIntegrityError(
                f"GCS returned invalid JSON during {operation}"
            ) from None
        if not isinstance(document, Mapping):
            raise GCSMediaStoreIntegrityError(f"GCS returned invalid JSON during {operation}")
        return document

    @staticmethod
    def _multipart_body(metadata: Mapping[str, Any], payload: bytes) -> tuple[bytes, str]:
        metadata_bytes = json.dumps(
            metadata,
            separators=(",", ":"),
            sort_keys=True,
        ).encode()
        while True:
            boundary = f"floodrise-{uuid4().hex}"
            boundary_bytes = boundary.encode()
            if boundary_bytes not in payload and boundary_bytes not in metadata_bytes:
                break
        body = b"".join(
            (
                b"--",
                boundary_bytes,
                b"\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n",
                metadata_bytes,
                b"\r\n--",
                boundary_bytes,
                b"\r\nContent-Type: application/octet-stream\r\n\r\n",
                payload,
                b"\r\n--",
                boundary_bytes,
                b"--\r\n",
            )
        )
        return body, f'multipart/related; boundary="{boundary}"'

    def _validate_deadline(self, value: datetime) -> datetime:
        deadline = self._aware_utc(value, field_name="delete_after")
        now = self._aware_utc(self.clock(), field_name="clock")
        if deadline <= now or deadline - now > self.max_retention:
            raise ValueError(
                "delete_after must be in the future and within the configured retention bound"
            )
        return deadline

    @staticmethod
    def _aware_utc(value: datetime, *, field_name: str) -> datetime:
        if not isinstance(value, datetime) or value.tzinfo is None:
            raise ValueError(f"{field_name} must be a timezone-aware datetime")
        return value.astimezone(UTC)

    @staticmethod
    def _parse_datetime(value: object) -> datetime | None:
        if not isinstance(value, str):
            return None
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
        if parsed.tzinfo is None:
            return None
        return parsed.astimezone(UTC)

    @staticmethod
    def _iso(value: datetime) -> str:
        return value.astimezone(UTC).isoformat().replace("+00:00", "Z")

    @staticmethod
    def _validate_upload_id(upload_id: str) -> None:
        if (
            not isinstance(upload_id, str)
            or not upload_id
            or len(upload_id.encode()) > 512
            or any(ord(character) < 32 for character in upload_id)
        ):
            raise ValueError("upload_id must be a non-empty bounded identifier")

    @staticmethod
    def _upload_hash(upload_id: str) -> str:
        return hashlib.sha256(upload_id.encode()).hexdigest()

    def _bucket(self, tier: MediaTier) -> str:
        return self.quarantine_bucket if tier == "quarantine" else self.clean_bucket

    def _upload_url(self, bucket: str) -> str:
        return f"{self.base_url}/upload/storage/v1/b/{quote(bucket, safe='')}/o"

    def _collection_url(self, bucket: str) -> str:
        return f"{self.base_url}/storage/v1/b/{quote(bucket, safe='')}/o"

    def _object_url(self, bucket: str, object_name: str) -> str:
        return (
            f"{self.base_url}/storage/v1/b/{quote(bucket, safe='')}/o/{quote(object_name, safe='')}"
        )

    @staticmethod
    def _raise_status(operation: str, status_code: int) -> None:
        if status_code in {401, 403}:
            raise GCSMediaStoreUnavailable(f"Private GCS authorization failed during {operation}")
        if status_code == 412:
            raise GCSMediaStoreConflict(f"The immutable GCS precondition failed during {operation}")
        raise GCSMediaStoreUnavailable(
            f"Private GCS operation failed during {operation} with status {status_code}"
        )


__all__ = [
    "GCSBulkOperationRefused",
    "GCSMediaStoreConfigurationError",
    "GCSMediaStoreConflict",
    "GCSMediaStoreError",
    "GCSMediaStoreIntegrityError",
    "GCSMediaStoreUnavailable",
    "GCSPrivateMediaBlobStore",
    "HTTPResponse",
    "SyncHTTPTransport",
]
