from __future__ import annotations

from unittest.mock import MagicMock, patch

from app.services.oci_service import OCIService


def test_object_storage_client_uses_configurable_transfer_timeout() -> None:
    service = OCIService()
    service._oci_config = {
        "user": "user",
        "tenancy": "tenancy",
        "fingerprint": "fingerprint",
        "key_content": "key",
        "region": "us-chicago-1",
    }
    client = MagicMock()

    with (
        patch.dict(
            "os.environ",
            {
                "OCI_REGION_DEPLOY": "ap-osaka-1",
                "OBJECT_STORAGE_CONNECT_TIMEOUT_SECONDS": "12",
                "OBJECT_STORAGE_TRANSFER_TIMEOUT_SECONDS": "420",
            },
        ),
        patch(
            "app.services.oci_service.oci.object_storage.ObjectStorageClient",
            return_value=client,
        ) as constructor,
    ):
        assert service.get_object_storage_client() is client

    constructor.assert_called_once_with(
        {
            "user": "user",
            "tenancy": "tenancy",
            "fingerprint": "fingerprint",
            "key_content": "key",
            "region": "ap-osaka-1",
        },
        timeout=(12.0, 420.0),
    )


def test_large_upload_uses_multipart_stream() -> None:
    service = OCIService()
    client = MagicMock()
    service._object_storage_client = client
    manager = MagicMock()
    payload = b"large-page-image"

    with (
        patch.dict(
            "os.environ",
            {
                "OCI_BUCKET": "documents",
                "OBJECT_STORAGE_MULTIPART_THRESHOLD_BYTES": "10",
                "OBJECT_STORAGE_MULTIPART_PART_SIZE_BYTES": str(10 * 1024 * 1024),
                "OBJECT_STORAGE_MULTIPART_WORKERS": "2",
            },
        ),
        patch.object(
            service,
            "get_namespace",
            return_value={"success": True, "namespace": "namespace"},
        ),
        patch.object(
            service,
            "_retry_api_call",
            side_effect=lambda function, *args, **kwargs: function(*args, **kwargs),
        ),
        patch(
            "app.services.oci_service.oci.object_storage.UploadManager",
            return_value=manager,
        ) as constructor,
    ):
        assert service.upload_file(
            payload,
            "catalog/_pipeline/page.png",
            "image/png",
            "page.png",
            len(payload),
        )

    constructor.assert_called_once_with(
        client,
        allow_parallel_uploads=True,
        parallel_process_count=2,
    )
    args = manager.upload_stream.call_args.args
    kwargs = manager.upload_stream.call_args.kwargs
    assert args[:3] == (
        "namespace",
        "documents",
        "catalog/_pipeline/page.png",
    )
    assert args[3].read() == payload
    assert kwargs["content_type"] == "image/png"
    assert kwargs["part_size"] == 10 * 1024 * 1024
    assert kwargs["metadata"]["file-size"] == str(len(payload))
    client.put_object.assert_not_called()
