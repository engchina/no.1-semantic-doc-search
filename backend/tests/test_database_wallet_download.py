from __future__ import annotations

import gzip
import io
import tempfile
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

from app.services.database_service import DatabaseService


def _wallet_zip() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("cwallet.sso", b"cwallet")
        archive.writestr("ewallet.pem", b"ewallet")
        archive.writestr("sqlnet.ora", "WALLET_LOCATION = test")
        archive.writestr(
            "tnsnames.ora",
            "testdb_high = (DESCRIPTION = test)\ntestdb_low = (DESCRIPTION = test)\n",
        )
    return buffer.getvalue()


class _GzipEncodedResponse:
    def __init__(self, wallet_zip: bytes) -> None:
        self.encoded_body = gzip.compress(wallet_zip)
        self.stream_calls: list[tuple[int, bool]] = []

    def stream(self, chunk_size: int, decode_content: bool = False):
        self.stream_calls.append((chunk_size, decode_content))
        body = gzip.decompress(self.encoded_body) if decode_content else self.encoded_body
        for offset in range(0, len(body), chunk_size):
            yield body[offset : offset + chunk_size]


def _track_temp_wallets(monkeypatch, temp_dir: Path) -> list[Path]:
    original_named_tempfile = tempfile.NamedTemporaryFile
    created_paths: list[Path] = []

    def tracked_named_tempfile(*args, **kwargs):
        kwargs["dir"] = temp_dir
        temp_file = original_named_tempfile(*args, **kwargs)
        created_paths.append(Path(temp_file.name))
        return temp_file

    monkeypatch.setattr(tempfile, "NamedTemporaryFile", tracked_named_tempfile)
    return created_paths


def test_download_wallet_decodes_gzip_response_and_extracts_zip(
    monkeypatch, tmp_path: Path
) -> None:
    service = object.__new__(DatabaseService)
    wallet_dir = tmp_path / "network" / "admin"
    raw_response = _GzipEncodedResponse(_wallet_zip())
    client = MagicMock()
    client.generate_autonomous_database_wallet.return_value = SimpleNamespace(
        data=SimpleNamespace(raw=raw_response)
    )
    created_paths = _track_temp_wallets(monkeypatch, tmp_path)

    with (
        patch(
            "app.services.oci_service.oci_service.get_oci_config",
            return_value={"region": "us-chicago-1"},
        ),
        patch("oci.database.DatabaseClient", return_value=client),
        patch.object(service, "_get_wallet_location", return_value=str(wallet_dir)),
        patch.dict("os.environ", {"OCI_REGION_DEPLOY": "ap-osaka-1"}),
    ):
        result = service._download_wallet_from_adb("test-adb-ocid", "test-password")

    assert result == {
        "success": True,
        "message": "Walletをダウンロードしました",
        "available_services": ["testdb_high", "testdb_low"],
    }
    assert raw_response.stream_calls == [(1024 * 1024, True)]
    assert (wallet_dir / "cwallet.sso").read_bytes() == b"cwallet"
    assert (wallet_dir / "ewallet.pem").read_bytes() == b"ewallet"
    assert (wallet_dir / "sqlnet.ora").is_file()
    assert (wallet_dir / "tnsnames.ora").is_file()
    assert len(created_paths) == 1
    assert not created_paths[0].exists()


def test_download_wallet_cleans_temp_file_when_stream_fails(
    monkeypatch, tmp_path: Path
) -> None:
    service = object.__new__(DatabaseService)
    raw_response = MagicMock()
    raw_response.stream.side_effect = RuntimeError("download failed")
    client = MagicMock()
    client.generate_autonomous_database_wallet.return_value = SimpleNamespace(
        data=SimpleNamespace(raw=raw_response)
    )
    created_paths = _track_temp_wallets(monkeypatch, tmp_path)

    with (
        patch(
            "app.services.oci_service.oci_service.get_oci_config",
            return_value={"region": "ap-osaka-1"},
        ),
        patch("oci.database.DatabaseClient", return_value=client),
        patch.dict("os.environ", {}, clear=False),
    ):
        result = service._download_wallet_from_adb("test-adb-ocid", "test-password")

    assert result == {
        "success": False,
        "message": "Walletのダウンロードに失敗しました: download failed",
        "available_services": [],
    }
    raw_response.stream.assert_called_once_with(1024 * 1024, decode_content=True)
    assert len(created_paths) == 1
    assert not created_paths[0].exists()
