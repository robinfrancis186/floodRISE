"""Private, quarantine-first evidence media processing.

The deterministic profile keeps bytes in an in-process private blob adapter so
the judging path has no external dependency.  Only metadata is persisted in the
authoritative database.  Production replaces the blob and scanner protocols
with private object storage and an approved malware scanner; no public download
route exists in v1.
"""

from __future__ import annotations

import hashlib
import logging
import warnings
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from io import BytesIO
from threading import RLock
from typing import Any, Literal, Protocol
from uuid import uuid4

from PIL import Image, ImageOps, UnidentifiedImageError

from .auth import Principal, audit_actor_id
from .database import ConcurrentWriteError, Database, EntityChange, EventInput
from .errors import AppError, ConflictError, NotFoundError, PermissionDeniedError
from .schemas import MediaUploadRequest

MAX_MEDIA_BYTES = 10_000_000
MAX_IMAGE_PIXELS = 20_000_000
DEMO_MEDIA_MAX_OBJECTS = 200
DEMO_MEDIA_MAX_BYTES = 100_000_000
ALLOWED_MEDIA_TYPES = {
    "image/jpeg": "JPEG",
    "image/png": "PNG",
    "image/webp": "WEBP",
}
AUTHORIZED_MEDIA_ROLES = {
    "responder",
    "verifier",
    "engineer",
    "incident_commander",
    "identity_administrator",
}
QUARANTINE_CLEANUP_KIND = "media_quarantine_cleanup"
logger = logging.getLogger(__name__)


def _iso(value: datetime) -> str:
    return value.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _parse_utc(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return parsed.astimezone(UTC)


class MediaBlobStore(Protocol):
    """Private storage contract with immutable, operation-owned blob references.

    Every put must create a distinct immutable object and return an opaque
    reference for that exact write. Reads and deletes with a reference must
    address only that object, even when concurrent writers share an upload ID.
    """

    production_approved: bool

    def put_quarantine(
        self,
        upload_id: str,
        payload: bytes,
        *,
        delete_after: datetime,
    ) -> str: ...
    def read_quarantine(
        self,
        upload_id: str,
        *,
        blob_ref: str | None = None,
    ) -> bytes | None: ...
    def put_clean(
        self,
        upload_id: str,
        payload: bytes,
        *,
        delete_after: datetime,
    ) -> str: ...
    def read_clean(
        self,
        upload_id: str,
        *,
        blob_ref: str | None = None,
    ) -> bytes | None: ...
    def delete_quarantine(
        self,
        upload_id: str,
        *,
        blob_ref: str,
    ) -> None: ...
    def delete_clean(
        self,
        upload_id: str,
        *,
        blob_ref: str,
    ) -> None: ...
    def cleanup_expired(self, now: datetime) -> int: ...
    def clear(self) -> None: ...


class MediaStoreCapacityError(RuntimeError):
    """Raised before a demo byte store would exceed its aggregate quota."""


@dataclass(slots=True)
class MemoryMediaBlobStore:
    """Bounded private byte adapter for the fully offline deterministic profile."""

    max_objects: int = DEMO_MEDIA_MAX_OBJECTS
    max_bytes: int = DEMO_MEDIA_MAX_BYTES
    quarantine: dict[tuple[str, str], bytes] = field(default_factory=dict)
    clean: dict[tuple[str, str], bytes] = field(default_factory=dict)
    production_approved: bool = field(default=False, init=False)
    _quarantine_delete_after: dict[tuple[str, str], datetime] = field(
        default_factory=dict,
        repr=False,
    )
    _clean_delete_after: dict[tuple[str, str], datetime] = field(
        default_factory=dict,
        repr=False,
    )
    _latest_quarantine_ref: dict[str, str] = field(default_factory=dict, repr=False)
    _latest_clean_ref: dict[str, str] = field(default_factory=dict, repr=False)
    _lock: RLock = field(default_factory=RLock, repr=False)

    def __post_init__(self) -> None:
        if self.max_objects <= 0 or self.max_bytes <= 0:
            raise ValueError("demo media object and byte quotas must be positive")

    @property
    def object_count(self) -> int:
        with self._lock:
            return len(self.quarantine) + len(self.clean)

    @property
    def byte_count(self) -> int:
        with self._lock:
            return sum(map(len, self.quarantine.values())) + sum(map(len, self.clean.values()))

    def _put(
        self,
        bucket: dict[tuple[str, str], bytes],
        deadlines: dict[tuple[str, str], datetime],
        latest: dict[str, str],
        upload_id: str,
        payload: bytes,
        *,
        delete_after: datetime,
    ) -> str:
        stored = bytes(payload)
        blob_ref = f"blob-{uuid4()}"
        key = (upload_id, blob_ref)
        with self._lock:
            projected_objects = self.object_count + 1
            projected_bytes = self.byte_count + len(stored)
            if projected_objects > self.max_objects or projected_bytes > self.max_bytes:
                raise MediaStoreCapacityError(
                    "the deterministic media store has reached its aggregate capacity"
                )
            bucket[key] = stored
            deadlines[key] = delete_after.astimezone(UTC)
            latest[upload_id] = blob_ref
        return blob_ref

    @staticmethod
    def _previous_ref(
        bucket: dict[tuple[str, str], bytes],
        upload_id: str,
    ) -> str | None:
        return next(
            (
                candidate_ref
                for candidate_upload_id, candidate_ref in reversed(bucket)
                if candidate_upload_id == upload_id
            ),
            None,
        )

    def _read(
        self,
        bucket: dict[tuple[str, str], bytes],
        latest: dict[str, str],
        upload_id: str,
        *,
        blob_ref: str | None,
    ) -> bytes | None:
        with self._lock:
            selected_ref = blob_ref or latest.get(upload_id)
            if selected_ref is None:
                return None
            return bucket.get((upload_id, selected_ref))

    def _delete(
        self,
        bucket: dict[tuple[str, str], bytes],
        deadlines: dict[tuple[str, str], datetime],
        latest: dict[str, str],
        upload_id: str,
        *,
        blob_ref: str,
    ) -> None:
        with self._lock:
            key = (upload_id, blob_ref)
            bucket.pop(key, None)
            deadlines.pop(key, None)
            if latest.get(upload_id) == blob_ref:
                previous = self._previous_ref(bucket, upload_id)
                if previous is None:
                    latest.pop(upload_id, None)
                else:
                    latest[upload_id] = previous

    def put_quarantine(
        self,
        upload_id: str,
        payload: bytes,
        *,
        delete_after: datetime,
    ) -> str:
        return self._put(
            self.quarantine,
            self._quarantine_delete_after,
            self._latest_quarantine_ref,
            upload_id,
            payload,
            delete_after=delete_after,
        )

    def read_quarantine(
        self,
        upload_id: str,
        *,
        blob_ref: str | None = None,
    ) -> bytes | None:
        return self._read(
            self.quarantine,
            self._latest_quarantine_ref,
            upload_id,
            blob_ref=blob_ref,
        )

    def put_clean(
        self,
        upload_id: str,
        payload: bytes,
        *,
        delete_after: datetime,
    ) -> str:
        return self._put(
            self.clean,
            self._clean_delete_after,
            self._latest_clean_ref,
            upload_id,
            payload,
            delete_after=delete_after,
        )

    def read_clean(
        self,
        upload_id: str,
        *,
        blob_ref: str | None = None,
    ) -> bytes | None:
        return self._read(
            self.clean,
            self._latest_clean_ref,
            upload_id,
            blob_ref=blob_ref,
        )

    def delete_quarantine(
        self,
        upload_id: str,
        *,
        blob_ref: str,
    ) -> None:
        self._delete(
            self.quarantine,
            self._quarantine_delete_after,
            self._latest_quarantine_ref,
            upload_id,
            blob_ref=blob_ref,
        )

    def delete_clean(
        self,
        upload_id: str,
        *,
        blob_ref: str,
    ) -> None:
        self._delete(
            self.clean,
            self._clean_delete_after,
            self._latest_clean_ref,
            upload_id,
            blob_ref=blob_ref,
        )

    def cleanup_expired(self, now: datetime) -> int:
        current = now.astimezone(UTC)
        removed = 0
        with self._lock:
            for bucket, deadlines, latest in (
                (
                    self.quarantine,
                    self._quarantine_delete_after,
                    self._latest_quarantine_ref,
                ),
                (self.clean, self._clean_delete_after, self._latest_clean_ref),
            ):
                expired = [
                    key for key, delete_after in deadlines.items() if delete_after <= current
                ]
                affected_upload_ids: set[str] = set()
                for key in expired:
                    affected_upload_ids.add(key[0])
                    bucket.pop(key, None)
                    deadlines.pop(key, None)
                    removed += 1
                for upload_id in affected_upload_ids:
                    previous = self._previous_ref(bucket, upload_id)
                    if previous is None:
                        latest.pop(upload_id, None)
                    else:
                        latest[upload_id] = previous
        return removed

    def clear(self) -> None:
        with self._lock:
            self.quarantine.clear()
            self.clean.clear()
            self._quarantine_delete_after.clear()
            self._clean_delete_after.clear()
            self._latest_quarantine_ref.clear()
            self._latest_clean_ref.clear()


ScannerResult = Literal["DEMO_CLEAN", "CLEAN", "MALICIOUS", "UNAVAILABLE"]


class MediaScanner(Protocol):
    production_approved: bool

    def scan(self, payload: bytes) -> ScannerResult: ...


@dataclass(frozen=True, slots=True)
class DemoCleanScanner:
    """Explicitly simulated scanner used only by the offline demo."""

    production_approved: bool = field(default=False, init=False)

    def scan(self, payload: bytes) -> ScannerResult:
        del payload
        return "DEMO_CLEAN"


@dataclass(frozen=True, slots=True)
class UnavailableScanner:
    production_approved: bool = field(default=False, init=False)

    def scan(self, payload: bytes) -> ScannerResult:
        del payload
        return "UNAVAILABLE"


@dataclass(frozen=True, slots=True)
class RejectingScanner:
    production_approved: bool = field(default=False, init=False)

    def scan(self, payload: bytes) -> ScannerResult:
        del payload
        return "MALICIOUS"


def _image_error(code: str, detail: str) -> AppError:
    return AppError(
        status_code=422,
        title="Evidence image rejected",
        detail=detail,
        code=code,
    )


def _perceptual_hash(image: Image.Image) -> str:
    grayscale = image.convert("L").resize((9, 8), Image.Resampling.LANCZOS)
    pixels = list(grayscale.get_flattened_data())
    value = 0
    for row in range(8):
        offset = row * 9
        for column in range(8):
            value = (value << 1) | int(pixels[offset + column] > pixels[offset + column + 1])
    return f"{value:016x}"


def _hamming_distance(left: str, right: str) -> int:
    return (int(left, 16) ^ int(right, 16)).bit_count()


def _mean_rgb(image: Image.Image) -> list[int]:
    red, green, blue = image.convert("RGB").resize((1, 1), Image.Resampling.BOX).getpixel((0, 0))
    return [int(red), int(green), int(blue)]


def _color_distance(left: list[int], right: list[int]) -> float:
    return sum((first - second) ** 2 for first, second in zip(left, right, strict=True)) ** 0.5


def _decode_and_sanitize(payload: bytes, declared_type: str) -> dict[str, Any]:
    expected_format = ALLOWED_MEDIA_TYPES[declared_type]
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(payload)) as candidate:
                actual_format = str(candidate.format or "").upper()
                width, height = candidate.size
                if width <= 0 or height <= 0 or width * height > MAX_IMAGE_PIXELS:
                    raise _image_error(
                        "MEDIA_PIXEL_LIMIT_EXCEEDED",
                        "Evidence images may contain at most 20 megapixels.",
                    )
                if actual_format != expected_format:
                    raise _image_error(
                        "MEDIA_TYPE_SPOOFED",
                        (
                            f"Declared {expected_format} content decoded as "
                            f"{actual_format or 'unknown'}."
                        ),
                    )
                candidate.verify()

        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(payload)) as source:
                source.load()
                normalized = ImageOps.exif_transpose(source)
                if expected_format == "JPEG":
                    normalized = normalized.convert("RGB")
                elif expected_format == "PNG":
                    normalized = normalized.convert(
                        "RGBA" if "A" in normalized.getbands() else "RGB"
                    )
                else:
                    normalized = normalized.convert(
                        "RGBA" if "A" in normalized.getbands() else "RGB"
                    )

                output = BytesIO()
                if expected_format == "JPEG":
                    normalized.save(
                        output,
                        format="JPEG",
                        quality=85,
                        optimize=False,
                        progressive=False,
                        subsampling=2,
                    )
                elif expected_format == "PNG":
                    normalized.save(output, format="PNG", optimize=False, compress_level=9)
                else:
                    normalized.save(output, format="WEBP", lossless=True, method=6)
                clean = output.getvalue()
                return {
                    "payload": clean,
                    "width": normalized.width,
                    "height": normalized.height,
                    "perceptual_hash": _perceptual_hash(normalized),
                    "perceptual_color": _mean_rgb(normalized),
                    "normalized_content_type": declared_type,
                    "normalized_sha256": hashlib.sha256(clean).hexdigest(),
                    "normalized_size_bytes": len(clean),
                }
    except AppError:
        raise
    except (Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise _image_error(
            "MEDIA_PIXEL_LIMIT_EXCEEDED",
            "The evidence image exceeds the safe decoded-pixel limit.",
        ) from None
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError):
        raise _image_error(
            "MEDIA_DECODE_FAILED",
            "The uploaded bytes are not a valid supported image.",
        ) from None


@dataclass(slots=True)
class MediaService:
    database: Database
    blob_store: MediaBlobStore = field(default_factory=MemoryMediaBlobStore)
    scanner: MediaScanner = field(default_factory=DemoCleanScanner)
    clock: Callable[[], datetime] = field(default=lambda: datetime.now(UTC))
    runtime_is_demo: bool = True
    _lock: RLock = field(default_factory=RLock, repr=False)

    def _now(self) -> datetime:
        value = self.clock()
        if value.tzinfo is None:
            value = value.replace(tzinfo=UTC)
        return value.astimezone(UTC)

    def bind_runtime(self, *, is_demo: bool) -> None:
        """Bind adapter policy to the application profile that owns this service."""

        self.runtime_is_demo = is_demo

    def ensure_body_ingestion_ready(self) -> None:
        """Fail before an evidence body is read when production adapters are absent."""

        if self.runtime_is_demo:
            return
        if not (
            getattr(self.blob_store, "production_approved", False) is True
            and getattr(self.scanner, "production_approved", False) is True
        ):
            raise AppError(
                status_code=503,
                title="Private media pipeline unavailable",
                detail=(
                    "Evidence bytes are not accepted until approved external private "
                    "blob storage and malware-scanner adapters are configured."
                ),
                code="MEDIA_PIPELINE_UNAVAILABLE",
                headers={"Retry-After": "60"},
            )

    def _cleanup_expired(self) -> None:
        try:
            self.blob_store.cleanup_expired(self._now())
        except Exception:
            logger.warning(
                "Private media retention cleanup failed; the primary operation will continue.",
            )

    @staticmethod
    def _warn_quarantine_deletion_pending() -> None:
        logger.warning(
            (
                "Private quarantine deletion remains pending; the authoritative media "
                "result is unchanged and a later reconciliation will retry."
            ),
        )

    def _quarantine_cleanup_change(
        self,
        record: dict[str, Any],
        quarantine_blob_ref: str,
    ) -> EntityChange:
        upload_id = str(record["upload_id"])
        cleanup = {
            "id": upload_id,
            "upload_id": upload_id,
            "incident_id": str(record["incident_id"]),
            "blob_ref": quarantine_blob_ref,
            "state": "PENDING",
            "scheduled_at": _iso(self._now()),
            "completed_at": None,
            "version": 1,
        }
        return EntityChange(
            QUARANTINE_CLEANUP_KIND,
            upload_id,
            cleanup,
            1,
            0,
        )

    def _reconcile_quarantine_deletion(self, upload_id: str) -> bool:
        """Delete one terminal raw upload without invalidating its committed result.

        A READY/REJECTED transition creates this cleanup record in the same
        transaction as its idempotency receipt. The external delete happens only
        after that commit. Any transport/database outage therefore leaves a
        durable PENDING marker that completion replay or metadata polling can
        safely retry.
        """

        try:
            cleanup = self.database.get(QUARANTINE_CLEANUP_KIND, upload_id)
        except Exception:
            self._warn_quarantine_deletion_pending()
            return False
        if cleanup is None or cleanup.get("state") == "DELETED":
            return True
        blob_ref = cleanup.get("blob_ref")
        if cleanup.get("state") != "PENDING" or not isinstance(blob_ref, str) or not blob_ref:
            self._warn_quarantine_deletion_pending()
            return False

        try:
            self.blob_store.delete_quarantine(upload_id, blob_ref=blob_ref)
        except Exception:
            self._warn_quarantine_deletion_pending()
            return False

        now = self._now()
        updated = {
            **cleanup,
            "blob_ref": None,
            "state": "DELETED",
            "completed_at": _iso(now),
            "version": int(cleanup["version"]) + 1,
        }
        try:
            self.database.commit(
                changes=[
                    EntityChange(
                        QUARANTINE_CLEANUP_KIND,
                        upload_id,
                        updated,
                        updated["version"],
                        int(cleanup["version"]),
                    )
                ],
                events=[
                    EventInput(
                        event_type="media.quarantine_deleted",
                        aggregate_kind=QUARANTINE_CLEANUP_KIND,
                        aggregate_id=upload_id,
                        aggregate_version=updated["version"],
                        actor_id="media-pipeline",
                        actor_role="system",
                        payload={
                            "status": "DELETED",
                            "visibility": "PRIVATE",
                            "deletion_reconciled": True,
                        },
                        incident_id=str(cleanup["incident_id"]),
                    )
                ],
            )
        except ConcurrentWriteError:
            try:
                refreshed = self.database.get(QUARANTINE_CLEANUP_KIND, upload_id)
            except Exception:
                self._warn_quarantine_deletion_pending()
                return False
            if refreshed is not None and refreshed.get("state") == "DELETED":
                return True
            self._warn_quarantine_deletion_pending()
            return False
        except Exception:
            self._warn_quarantine_deletion_pending()
            return False
        return True

    def _record(self, upload_id: str) -> dict[str, Any]:
        record = self.database.get("media_upload", upload_id)
        if not record:
            raise NotFoundError("media upload", upload_id)
        return record

    @staticmethod
    def _required_blob_ref(record: dict[str, Any], field_name: str) -> str:
        blob_ref = record.get(field_name)
        if not isinstance(blob_ref, str) or not blob_ref:
            raise ConflictError(
                "Private evidence storage reference is unavailable",
                code="MEDIA_BLOB_REFERENCE_MISSING",
            )
        return blob_ref

    @staticmethod
    def _idempotency_scope(operation: str, *identifiers: str) -> str:
        digest = hashlib.sha256(":".join(identifiers).encode()).hexdigest()[:24]
        return f"{operation}:{digest}"

    @staticmethod
    def _validate_idempotency_key(idempotency_key: str) -> None:
        if not idempotency_key or len(idempotency_key) > 360:
            raise AppError(
                status_code=400,
                title="Idempotency-Key required",
                detail="Provide a stable Idempotency-Key of at most 360 characters.",
                code="IDEMPOTENCY_KEY_REQUIRED",
            )

    def reset_demo_store(self) -> None:
        """Clear private bytes when the deterministic backend is explicitly reset."""

        self.blob_store.clear()

    @staticmethod
    def _authorize(record: dict[str, Any], principal: Principal) -> None:
        if record.get("requested_by") == principal.user_id:
            return
        if not principal.granted_roles.isdisjoint(AUTHORIZED_MEDIA_ROLES):
            return
        raise PermissionDeniedError("This identity cannot access another reporter's evidence media")

    def create_upload(
        self,
        body: MediaUploadRequest,
        *,
        idempotency_key: str,
        principal: Principal,
    ) -> tuple[int, dict[str, Any]]:
        with self._lock:
            self._cleanup_expired()
            return self._create_upload_locked(
                body,
                idempotency_key=idempotency_key,
                principal=principal,
            )

    def _create_upload_locked(
        self,
        body: MediaUploadRequest,
        *,
        idempotency_key: str,
        principal: Principal,
    ) -> tuple[int, dict[str, Any]]:
        self._validate_idempotency_key(idempotency_key)
        idempotency_scope = self._idempotency_scope("media.create", principal.user_id)
        replay = self.database.idempotent_response(idempotency_scope, idempotency_key)
        if replay:
            _, payload = replay
            expected = {
                "incident_id": body.incident_id,
                "filename": body.filename,
                "declared_content_type": body.content_type,
                "declared_size_bytes": body.size_bytes,
                "declared_sha256": body.sha256.lower(),
            }
            if any(payload.get(key) != value for key, value in expected.items()):
                raise ConflictError(
                    "This Idempotency-Key was already used for a different media grant",
                    code="IDEMPOTENCY_KEY_REUSED",
                )
            return replay
        incident = self.database.get("incident", body.incident_id)
        if not incident:
            raise NotFoundError("incident", body.incident_id)

        now = self._now()
        is_simulated = bool(incident.get("is_simulated", self.runtime_is_demo))
        upload_digest = hashlib.sha256(
            f"{principal.user_id}:{idempotency_key}:{body.sha256.lower()}".encode()
        ).hexdigest()[:20]
        upload_id = f"upload-{upload_digest}"
        record = {
            "upload_id": upload_id,
            "incident_id": body.incident_id,
            "requested_by": principal.user_id,
            "requested_role": principal.role,
            "filename": body.filename,
            "declared_content_type": body.content_type,
            "declared_size_bytes": body.size_bytes,
            "declared_sha256": body.sha256.lower(),
            "actual_size_bytes": None,
            "actual_sha256": None,
            "normalized_content_type": None,
            "normalized_size_bytes": None,
            "normalized_sha256": None,
            "width": None,
            "height": None,
            "perceptual_hash": None,
            "independence_hash": None,
            "duplicate_of_upload_id": None,
            "perceptual_distance": None,
            "quarantine_blob_ref": None,
            "clean_blob_ref": None,
            "status": "AWAITING_UPLOAD",
            "scanner_status": "NOT_RUN",
            "failure_code": None,
            "visibility": "PRIVATE",
            "public_url": None,
            "download_url": None,
            "created_at": _iso(now),
            "updated_at": _iso(now),
            "expires_at": _iso(now + timedelta(minutes=15)),
            "quarantine_delete_after": _iso(now + timedelta(days=7)),
            "evidence_delete_after": _iso(now + timedelta(days=30)),
            "identity_link_delete_after": _iso(now + timedelta(days=365)),
            "retention_status": (
                "ACTIVE_DEMO_POLICY" if is_simulated else "ACTIVE_AUTHORITY_POLICY"
            ),
            "attached_report_ids": [],
            "is_simulated": is_simulated,
            "version": 1,
        }
        response = self.public_metadata(record)
        try:
            self.database.commit(
                changes=[EntityChange("media_upload", upload_id, record, 1)],
                events=[
                    EventInput(
                        event_type="media.upload_requested",
                        aggregate_kind="media_upload",
                        aggregate_id=upload_id,
                        aggregate_version=1,
                        actor_id=audit_actor_id(principal, body.incident_id),
                        actor_role=principal.role,
                        payload={
                            "incident_id": body.incident_id,
                            "status": "AWAITING_UPLOAD",
                            "visibility": "PRIVATE",
                        },
                        incident_id=body.incident_id,
                    )
                ],
                idempotency=(idempotency_scope, idempotency_key, 201, response),
            )
        except ValueError as exc:
            # A second worker may win the unique idempotency race. Replay only
            # when the winning grant is for this exact immutable request.
            replay = self.database.idempotent_response(idempotency_scope, idempotency_key)
            if replay:
                _, payload = replay
                expected = {
                    "incident_id": body.incident_id,
                    "filename": body.filename,
                    "declared_content_type": body.content_type,
                    "declared_size_bytes": body.size_bytes,
                    "declared_sha256": body.sha256.lower(),
                }
                if any(payload.get(key) != value for key, value in expected.items()):
                    raise ConflictError(
                        "This Idempotency-Key was already used for a different media grant",
                        code="IDEMPOTENCY_KEY_REUSED",
                    ) from exc
                return replay
            raise
        return 201, response

    def upload_content(
        self,
        upload_id: str,
        payload: bytes,
        *,
        content_type: str,
        content_length: int | None,
        checksum_header: str,
        idempotency_key: str,
        principal: Principal,
    ) -> tuple[int, dict[str, Any]]:
        self._validate_idempotency_key(idempotency_key)
        with self._lock:
            # The HTTP adapter runs this check before streaming. Keep the same
            # invariant at the storage boundary for internal callers.
            self.ensure_body_ingestion_ready()
            self._cleanup_expired()
            record = self._record(upload_id)
            self._authorize(record, principal)
            idempotency_scope = self._idempotency_scope(
                "media.content", principal.user_id, upload_id
            )
            replay = self.database.idempotent_response(idempotency_scope, idempotency_key)
            if replay:
                _, replayed = replay
                computed = hashlib.sha256(payload).hexdigest()
                if (
                    replayed.get("actual_size_bytes") != len(payload)
                    or replayed.get("actual_sha256") != computed
                    or str(replayed.get("declared_content_type"))
                    != content_type.split(";", 1)[0].strip().lower()
                ):
                    raise ConflictError(
                        "This Idempotency-Key was already used for different media content",
                        code="IDEMPOTENCY_KEY_REUSED",
                    )
                return replay
            if _parse_utc(record["expires_at"]) <= self._now():
                raise AppError(
                    status_code=410,
                    title="Media upload expired",
                    detail="Request a new private media upload grant.",
                    code="MEDIA_UPLOAD_EXPIRED",
                )
            if record["status"] != "AWAITING_UPLOAD":
                raise ConflictError(
                    "Media content has already been received",
                    code="MEDIA_ALREADY_UPLOADED",
                )
            declared_type = str(record["declared_content_type"])
            if content_type.split(";", 1)[0].strip().lower() != declared_type:
                raise AppError(
                    status_code=415,
                    title="Media type mismatch",
                    detail="The upload Content-Type must match the requested grant.",
                    code="MEDIA_TYPE_MISMATCH",
                )
            if len(payload) > MAX_MEDIA_BYTES:
                raise AppError(
                    status_code=413,
                    title="Evidence image too large",
                    detail="Evidence image uploads are limited to 10 MB.",
                    code="MEDIA_SIZE_LIMIT_EXCEEDED",
                )
            expected_size = int(record["declared_size_bytes"])
            if (
                content_length is None
                or content_length != expected_size
                or len(payload) != expected_size
            ):
                raise AppError(
                    status_code=422,
                    title="Media size mismatch",
                    detail="Content-Length and received bytes must match the declared size.",
                    code="MEDIA_SIZE_MISMATCH",
                )
            computed = hashlib.sha256(payload).hexdigest()
            declared_checksum = str(record["declared_sha256"])
            if checksum_header.lower() != declared_checksum or computed != declared_checksum:
                raise AppError(
                    status_code=422,
                    title="Media checksum mismatch",
                    detail=(
                        "The checksum header and uploaded bytes must match the private "
                        "upload grant."
                    ),
                    code="MEDIA_CHECKSUM_MISMATCH",
                )

            try:
                quarantine_blob_ref = self.blob_store.put_quarantine(
                    upload_id,
                    payload,
                    delete_after=_parse_utc(record["quarantine_delete_after"]),
                )
            except MediaStoreCapacityError as exc:
                raise AppError(
                    status_code=503,
                    title="Private media capacity unavailable",
                    detail=(
                        "The bounded demo evidence store is full; retry after retention cleanup."
                    ),
                    code="MEDIA_STORE_CAPACITY_EXCEEDED",
                    headers={"Retry-After": "60"},
                ) from exc
            updated = {
                **record,
                "actual_size_bytes": len(payload),
                "actual_sha256": computed,
                "quarantine_blob_ref": quarantine_blob_ref,
                "status": "QUARANTINED_PENDING_SCAN",
                "updated_at": _iso(self._now()),
                "version": int(record["version"]) + 1,
            }
            response = self.public_metadata(updated)
            try:
                self.database.commit(
                    changes=[EntityChange("media_upload", upload_id, updated, updated["version"])],
                    events=[
                        EventInput(
                            event_type="media.quarantined",
                            aggregate_kind="media_upload",
                            aggregate_id=upload_id,
                            aggregate_version=updated["version"],
                            actor_id=audit_actor_id(principal, str(updated["incident_id"])),
                            actor_role=principal.role,
                            payload={"status": updated["status"], "visibility": "PRIVATE"},
                            incident_id=updated["incident_id"],
                        )
                    ],
                    idempotency=(idempotency_scope, idempotency_key, 202, response),
                )
            except Exception:
                self.blob_store.delete_quarantine(
                    upload_id,
                    blob_ref=quarantine_blob_ref,
                )
                raise
            return 202, response

    def complete_upload(
        self,
        upload_id: str,
        *,
        idempotency_key: str,
        principal: Principal,
    ) -> tuple[int, dict[str, Any], dict[str, str]]:
        self._validate_idempotency_key(idempotency_key)
        with self._lock:
            self._cleanup_expired()
            record = self._record(upload_id)
            self._authorize(record, principal)
            idempotency_scope = self._idempotency_scope(
                "media.complete", principal.user_id, upload_id
            )
            replay = self.database.idempotent_response(idempotency_scope, idempotency_key)
            if replay:
                status_code, payload = replay
                if status_code != 202:
                    self._reconcile_quarantine_deletion(upload_id)
                if status_code >= 400:
                    raise _image_error(
                        str(payload.get("failure_code", "MEDIA_DECODE_FAILED")),
                        str(payload.get("detail", "The evidence image was rejected.")),
                    )
                headers = {"Retry-After": "30"} if status_code == 202 else {}
                return status_code, payload, headers
            if record["status"] in {"READY_PRIVATE", "DUPLICATE_PRIVATE"}:
                self._reconcile_quarantine_deletion(upload_id)
                return 200, self.public_metadata(record), {}
            if record["status"] == "REJECTED":
                self._reconcile_quarantine_deletion(upload_id)
                raise _image_error(
                    str(record.get("failure_code") or "MEDIA_DECODE_FAILED"),
                    str(record.get("failure_detail") or "The evidence image was rejected."),
                )
            if record["status"] not in {
                "QUARANTINED_PENDING_SCAN",
                "QUARANTINED_SCANNER_UNAVAILABLE",
            }:
                raise ConflictError(
                    "Media must be uploaded into quarantine before completion",
                    code="MEDIA_NOT_QUARANTINED",
                )
            quarantine_blob_ref = self._required_blob_ref(record, "quarantine_blob_ref")
            payload = self.blob_store.read_quarantine(
                upload_id,
                blob_ref=quarantine_blob_ref,
            )
            if payload is None:
                raise ConflictError(
                    "Private quarantine bytes are unavailable",
                    code="MEDIA_QUARANTINE_MISSING",
                )
            scan_result = self.scanner.scan(payload)
            if scan_result == "UNAVAILABLE":
                if record["status"] == "QUARANTINED_SCANNER_UNAVAILABLE":
                    # Polling an unchanged outage is read-only. Do not create a
                    # new version/audit/outbox row for every Retry-After cycle.
                    return 202, self.public_metadata(record), {"Retry-After": "30"}
                updated = {
                    **record,
                    "status": "QUARANTINED_SCANNER_UNAVAILABLE",
                    "scanner_status": "UNAVAILABLE",
                    "failure_code": "MEDIA_SCANNER_UNAVAILABLE",
                    "updated_at": _iso(self._now()),
                    "version": int(record["version"]) + 1,
                }
                response = self.public_metadata(updated)
                self.database.commit(
                    changes=[EntityChange("media_upload", upload_id, updated, updated["version"])],
                    events=[
                        EventInput(
                            event_type="media.scan_deferred",
                            aggregate_kind="media_upload",
                            aggregate_id=upload_id,
                            aggregate_version=updated["version"],
                            actor_id="media-pipeline",
                            actor_role="system",
                            payload={"scanner_status": "UNAVAILABLE", "quarantine_retained": True},
                            incident_id=updated["incident_id"],
                        )
                    ],
                    idempotency=(idempotency_scope, idempotency_key, 202, response),
                )
                return 202, response, {"Retry-After": "30"}
            if scan_result == "MALICIOUS":
                detail = "The evidence image was rejected by the private malware scanner."
                self._reject(
                    record,
                    principal,
                    "MEDIA_MALWARE_DETECTED",
                    "MALICIOUS",
                    detail=detail,
                    idempotency_scope=idempotency_scope,
                    idempotency_key=idempotency_key,
                )
                self._reconcile_quarantine_deletion(upload_id)
                raise _image_error(
                    "MEDIA_MALWARE_DETECTED",
                    detail,
                )

            try:
                processed = _decode_and_sanitize(payload, str(record["declared_content_type"]))
            except AppError as exc:
                self._reject(
                    record,
                    principal,
                    str(exc.code),
                    scan_result,
                    detail=exc.detail,
                    idempotency_scope=idempotency_scope,
                    idempotency_key=idempotency_key,
                )
                self._reconcile_quarantine_deletion(upload_id)
                raise

            duplicate: dict[str, Any] | None = None
            duplicate_distance: int | None = None
            for candidate in self.database.list("media_upload"):
                if candidate.get("upload_id") == upload_id:
                    continue
                if candidate.get("incident_id") != record.get("incident_id"):
                    continue
                candidate_hash = candidate.get("perceptual_hash")
                candidate_color = candidate.get("perceptual_color")
                if not candidate_hash or candidate.get("status") not in {
                    "READY_PRIVATE",
                    "DUPLICATE_PRIVATE",
                }:
                    continue
                distance = _hamming_distance(processed["perceptual_hash"], str(candidate_hash))
                color_is_close = (
                    isinstance(candidate_color, list)
                    and len(candidate_color) == 3
                    and _color_distance(processed["perceptual_color"], candidate_color) <= 36
                )
                if (
                    distance <= 4
                    and color_is_close
                    and (duplicate_distance is None or distance < duplicate_distance)
                ):
                    duplicate = candidate
                    duplicate_distance = distance

            clean_payload = processed.pop("payload")
            try:
                clean_blob_ref = self.blob_store.put_clean(
                    upload_id,
                    clean_payload,
                    delete_after=_parse_utc(record["evidence_delete_after"]),
                )
            except MediaStoreCapacityError as exc:
                raise AppError(
                    status_code=503,
                    title="Private media capacity unavailable",
                    detail=(
                        "The bounded demo evidence store is full; retry after retention cleanup."
                    ),
                    code="MEDIA_STORE_CAPACITY_EXCEEDED",
                    headers={"Retry-After": "60"},
                ) from exc
            status_value = "DUPLICATE_PRIVATE" if duplicate else "READY_PRIVATE"
            independence_hash = (
                str(duplicate.get("independence_hash") or duplicate["perceptual_hash"])
                if duplicate
                else hashlib.sha256(
                    (
                        f"{processed['perceptual_hash']}:"
                        + ",".join(str(value) for value in processed["perceptual_color"])
                    ).encode()
                ).hexdigest()
            )
            updated = {
                **record,
                **processed,
                "clean_blob_ref": clean_blob_ref,
                "independence_hash": independence_hash,
                "duplicate_of_upload_id": duplicate.get("upload_id") if duplicate else None,
                "perceptual_distance": duplicate_distance,
                "status": status_value,
                "scanner_status": scan_result,
                "failure_code": None,
                "updated_at": _iso(self._now()),
                "version": int(record["version"]) + 1,
            }
            response = self.public_metadata(updated)
            cleanup_change = self._quarantine_cleanup_change(updated, quarantine_blob_ref)
            try:
                self.database.commit(
                    changes=[
                        EntityChange("media_upload", upload_id, updated, updated["version"]),
                        cleanup_change,
                    ],
                    events=[
                        EventInput(
                            event_type="media.ready_private",
                            aggregate_kind="media_upload",
                            aggregate_id=upload_id,
                            aggregate_version=updated["version"],
                            actor_id="media-pipeline",
                            actor_role="system",
                            payload={
                                "status": status_value,
                                "scanner_status": scan_result,
                                "duplicate_detected": duplicate is not None,
                                "metadata_stripped": True,
                                "quarantine_deletion_state": "PENDING",
                                "visibility": "PRIVATE",
                            },
                            incident_id=updated["incident_id"],
                        )
                    ],
                    idempotency=(idempotency_scope, idempotency_key, 200, response),
                )
            except Exception:
                self.blob_store.delete_clean(
                    upload_id,
                    blob_ref=clean_blob_ref,
                )
                raise
            self._reconcile_quarantine_deletion(upload_id)
            return 200, response, {}

    def _reject(
        self,
        record: dict[str, Any],
        principal: Principal,
        failure_code: str,
        scanner_status: str,
        *,
        detail: str,
        idempotency_scope: str,
        idempotency_key: str,
    ) -> None:
        updated = {
            **record,
            "status": "REJECTED",
            "scanner_status": scanner_status,
            "failure_code": failure_code,
            "failure_detail": detail,
            "updated_at": _iso(self._now()),
            "version": int(record["version"]) + 1,
        }
        quarantine_blob_ref = self._required_blob_ref(record, "quarantine_blob_ref")
        self.database.commit(
            changes=[
                EntityChange(
                    "media_upload",
                    record["upload_id"],
                    updated,
                    updated["version"],
                ),
                self._quarantine_cleanup_change(updated, quarantine_blob_ref),
            ],
            events=[
                EventInput(
                    event_type="media.rejected",
                    aggregate_kind="media_upload",
                    aggregate_id=record["upload_id"],
                    aggregate_version=updated["version"],
                    actor_id="media-pipeline",
                    actor_role="system",
                    payload={
                        "failure_code": failure_code,
                        "quarantine_deletion_requested": True,
                        "quarantine_deletion_state": "PENDING",
                    },
                    incident_id=updated["incident_id"],
                )
            ],
            idempotency=(
                idempotency_scope,
                idempotency_key,
                422,
                {"failure_code": failure_code, "detail": detail},
            ),
        )

    def metadata(self, upload_id: str, principal: Principal) -> dict[str, Any]:
        with self._lock:
            self._cleanup_expired()
            record = self._record(upload_id)
            self._authorize(record, principal)
            if record["status"] in {"READY_PRIVATE", "DUPLICATE_PRIVATE", "REJECTED"}:
                self._reconcile_quarantine_deletion(upload_id)
            return self.public_metadata(record)

    @staticmethod
    def public_metadata(record: dict[str, Any]) -> dict[str, Any]:
        allowed = {
            "upload_id",
            "incident_id",
            "filename",
            "declared_content_type",
            "declared_size_bytes",
            "declared_sha256",
            "actual_size_bytes",
            "actual_sha256",
            "normalized_content_type",
            "normalized_size_bytes",
            "normalized_sha256",
            "width",
            "height",
            "status",
            "scanner_status",
            "failure_code",
            "visibility",
            "public_url",
            "download_url",
            "created_at",
            "updated_at",
            "expires_at",
            "quarantine_delete_after",
            "evidence_delete_after",
            "identity_link_delete_after",
            "retention_status",
            "is_simulated",
            "version",
        }
        return {key: value for key, value in record.items() if key in allowed}


__all__ = [
    "DEMO_MEDIA_MAX_BYTES",
    "DEMO_MEDIA_MAX_OBJECTS",
    "DemoCleanScanner",
    "MAX_MEDIA_BYTES",
    "MediaBlobStore",
    "MediaScanner",
    "MediaService",
    "MediaStoreCapacityError",
    "MemoryMediaBlobStore",
    "QUARANTINE_CLEANUP_KIND",
    "RejectingScanner",
    "UnavailableScanner",
]
