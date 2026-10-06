from io import BytesIO
from unittest.mock import Mock

import pytest
from botocore.exceptions import ClientError

from app.object_storage import S3MediaBlobStore


def test_private_bytes_survive_adapter_recreation_and_storage_errors_fail_closed():
    objects = {}
    client = Mock()
    client.put_object.side_effect = lambda **args: objects.__setitem__(args["Key"], args["Body"])
    client.get_object.side_effect = lambda **args: {"Body": BytesIO(objects[args["Key"]])}
    client.delete_object.side_effect = lambda **args: objects.pop(args["Key"], None)
    first = S3MediaBlobStore(
        "private-evidence", "https://s3.example.in", "ap-south-1", client=client
    )
    first.put_quarantine("upload-1", b"raw-photo")
    second = S3MediaBlobStore(
        "private-evidence", "https://s3.example.in", "ap-south-1", client=client
    )
    assert second.read_quarantine("upload-1") == b"raw-photo"
    second.put_clean("upload-1", b"sanitized-photo")
    second.delete_quarantine("upload-1")
    assert first.read_clean("upload-1") == b"sanitized-photo"
    assert "media/quarantine/upload-1" not in objects
    assert client.put_object.call_args.kwargs["ServerSideEncryption"] == "AES256"
    assert "ACL" not in client.put_object.call_args.kwargs
    with pytest.raises(RuntimeError, match="Bulk evidence deletion"):
        second.clear()
    client.get_object.side_effect = ClientError({"Error": {"Code": "NoSuchKey"}}, "GetObject")
    assert second.read_quarantine("missing") is None
    client.get_object.side_effect = ClientError({"Error": {"Code": "AccessDenied"}}, "GetObject")
    with pytest.raises(ClientError):
        second.read_clean("upload-1")
