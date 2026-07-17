from __future__ import annotations

from unittest.mock import patch

from app.services.adb_service import ADBService


def test_adb_client_uses_region_from_adb_ocid(monkeypatch) -> None:
    monkeypatch.delenv("ADB_REGION", raising=False)
    monkeypatch.delenv("ADB_OCID", raising=False)
    generic_config = {"region": "us-chicago-1", "tenancy": "test"}
    adb_ocid = "ocid1.autonomousdatabase.oc1.ap-osaka-1.example"

    with (
        patch(
            "app.services.adb_service.oci_service.get_oci_config",
            return_value=generic_config,
        ),
        patch("app.services.adb_service.oci.database.DatabaseClient") as client,
    ):
        result = ADBService()._get_db_client(adb_ocid)

    assert result is client.return_value
    assert client.call_args.args[0]["region"] == "ap-osaka-1"
    assert generic_config["region"] == "us-chicago-1"


def test_explicit_adb_region_overrides_ocid_region(monkeypatch) -> None:
    monkeypatch.setenv("ADB_REGION", "ap-tokyo-1")

    with (
        patch(
            "app.services.adb_service.oci_service.get_oci_config",
            return_value={"region": "us-chicago-1"},
        ),
        patch("app.services.adb_service.oci.database.DatabaseClient") as client,
    ):
        ADBService()._get_db_client(
            "ocid1.autonomousdatabase.oc1.ap-osaka-1.example"
        )

    assert client.call_args.args[0]["region"] == "ap-tokyo-1"
