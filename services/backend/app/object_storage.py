"""Private durable evidence bytes using S3 or a compatible object store."""

from typing import Any

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError


class S3MediaBlobStore:
    def __init__(self, bucket: str, endpoint: str, region: str, *, client: Any = None):
        self.bucket = bucket
        self.client = client or boto3.client(
            "s3",
            endpoint_url=endpoint,
            region_name=region,
            config=Config(connect_timeout=3, read_timeout=10, retries={"max_attempts": 2}),
        )

    def _put(self, stage: str, upload_id: str, payload: bytes) -> None:
        self.client.put_object(
            Bucket=self.bucket,
            Key=f"media/{stage}/{upload_id}",
            Body=payload,
            ContentType="application/octet-stream",
            ServerSideEncryption="AES256",
        )

    def _read(self, stage: str, upload_id: str) -> bytes | None:
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=f"media/{stage}/{upload_id}")
        except ClientError as error:
            if error.response["Error"]["Code"] in {"NoSuchKey", "404"}:
                return None
            raise
        with response["Body"] as body:
            return body.read()

    def _delete(self, stage: str, upload_id: str) -> None:
        self.client.delete_object(Bucket=self.bucket, Key=f"media/{stage}/{upload_id}")

    def put_quarantine(self, upload_id: str, payload: bytes) -> None:
        self._put("quarantine", upload_id, payload)

    def read_quarantine(self, upload_id: str) -> bytes | None:
        return self._read("quarantine", upload_id)

    def put_clean(self, upload_id: str, payload: bytes) -> None:
        self._put("clean", upload_id, payload)

    def read_clean(self, upload_id: str) -> bytes | None:
        return self._read("clean", upload_id)

    def delete_quarantine(self, upload_id: str) -> None:
        self._delete("quarantine", upload_id)

    def delete_clean(self, upload_id: str) -> None:
        self._delete("clean", upload_id)

    def clear(self) -> None:
        raise RuntimeError("Bulk evidence deletion is disabled for durable storage.")
