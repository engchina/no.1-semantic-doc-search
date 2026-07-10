from __future__ import annotations

import hashlib
from contextlib import contextmanager
from typing import Any, Iterator
from uuid import uuid4

from app.rag.models import ProfileConfig, initial_profiles
from app.rag.oracle_schema import SCHEMA_VERSION, schema_digest
from app.rag.profile_validation import profile_hash
from app.services.database_service import database_service
from app.services.oci_service import oci_service


def _lob_text(value: object) -> str:
    if hasattr(value, "read"):
        value = value.read()
    if isinstance(value, bytes):
        return value.decode()
    return str(value or "")


class OracleProfileRepository:
    @contextmanager
    def _connection(self) -> Iterator[Any]:
        if not database_service._ensure_pool_initialized():
            raise RuntimeError("database connection is not configured")
        with database_service.pool_manager.acquire_connection() as connection:
            yield connection

    @staticmethod
    def _fetch_all(cursor: Any) -> list[dict[str, Any]]:
        columns = [item[0].lower() for item in cursor.description or []]
        return [dict(zip(columns, row)) for row in cursor.fetchall()]

    def schema_ready(self) -> bool:
        try:
            with self._connection() as connection, connection.cursor() as cursor:
                cursor.execute(
                    "SELECT COUNT(*) FROM SDS_SCHEMA_VERSION "
                    "WHERE VERSION_ID=:version_id AND DDL_SHA256=:ddl_sha256",
                    {"version_id": SCHEMA_VERSION, "ddl_sha256": schema_digest()},
                )
                return bool(cursor.fetchone()[0])
        except Exception:
            return False

    def list_profiles(self) -> list[ProfileConfig]:
        if not self.schema_ready():
            return initial_profiles()
        with self._connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT p.slot_no, p.name, p.enabled, p.current_revision_id,
                       p.apply_status, p.last_applied_at, r.config_hash,
                       r.extraction_prompt
                FROM sds_vlm_profiles p
                JOIN sds_vlm_profile_revisions r
                  ON r.revision_id=p.current_revision_id
                ORDER BY p.slot_no
                """
            )
            rows = self._fetch_all(cursor)
            for row in rows:
                row["pending_document_count"] = 0
                if not row["enabled"]:
                    continue
                cursor.execute(
                    """
                    SELECT COUNT(*) FROM sds_documents d
                    WHERE NOT EXISTS (
                        SELECT 1 FROM sds_vlm_profile_runs pr
                        WHERE pr.document_id=d.document_id AND pr.slot_no=:slot
                          AND pr.revision_id=:revision
                          AND pr.content_sha256=d.content_sha256
                          AND pr.config_hash=:runtime_hash
                          AND pr.is_serving=1 AND pr.build_status='INDEXED'
                    )
                    """,
                    {
                        "slot": row["slot_no"],
                        "revision": row["current_revision_id"],
                        "runtime_hash": self._runtime_hash(str(row["config_hash"])),
                    },
                )
                row["pending_document_count"] = int(cursor.fetchone()[0])
        return [
            ProfileConfig(
                slot_no=int(row["slot_no"]),
                name=str(row["name"]),
                enabled=bool(row["enabled"]),
                extraction_prompt=_lob_text(row["extraction_prompt"]),
                current_revision_id=str(row["current_revision_id"]),
                config_hash=str(row["config_hash"]),
                apply_status=str(row["apply_status"]),
                last_applied_at=row.get("last_applied_at"),
                pending_document_count=int(row.get("pending_document_count") or 0),
            )
            for row in rows
        ]

    def get_profile(self, slot_no: int) -> ProfileConfig:
        return next(item for item in self.list_profiles() if item.slot_no == slot_no)

    def enabled_profiles(self) -> list[ProfileConfig]:
        return [profile for profile in self.list_profiles() if profile.enabled]

    # Compatibility name used by existing call sites while the meaning is now VLM-only.
    enabled_published_profiles = enabled_profiles

    @staticmethod
    def _runtime_hash(config_hash: str) -> str:
        model = oci_service.get_enterprise_ai_settings().model or ""
        return hashlib.sha256(f"{config_hash}:{model}".encode()).hexdigest()

    def apply_profile(self, profile: ProfileConfig) -> ProfileConfig:
        digest = profile_hash(profile)
        with self._connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT p.current_revision_id, r.config_hash
                FROM sds_vlm_profiles p
                JOIN sds_vlm_profile_revisions r ON r.revision_id=p.current_revision_id
                WHERE p.slot_no=:slot FOR UPDATE
                """,
                {"slot": profile.slot_no},
            )
            row = cursor.fetchone()
            if row is None:
                raise LookupError("VLM profile was not found")
            revision_id = str(row[0])
            if str(row[1]) != digest:
                revision_id = uuid4().hex
                cursor.execute(
                    "SELECT NVL(MAX(REVISION_NO), 0)+1 FROM SDS_VLM_PROFILE_REVISIONS "
                    "WHERE SLOT_NO=:slot",
                    {"slot": profile.slot_no},
                )
                revision_no = int(cursor.fetchone()[0])
                cursor.execute(
                    """
                    INSERT INTO sds_vlm_profile_revisions
                        (revision_id, slot_no, revision_no, config_hash, extraction_prompt)
                    VALUES (:revision, :slot, :revision_no, :hash, :prompt)
                    """,
                    {
                        "revision": revision_id,
                        "slot": profile.slot_no,
                        "revision_no": revision_no,
                        "hash": digest,
                        "prompt": profile.extraction_prompt,
                    },
                )
            cursor.execute(
                """
                UPDATE sds_vlm_profiles
                SET name=:name, enabled=:enabled, current_revision_id=:revision,
                    apply_status=CASE WHEN :enabled=1 THEN 'PENDING' ELSE 'READY' END,
                    last_applied_at=SYSTIMESTAMP, updated_at=SYSTIMESTAMP
                WHERE slot_no=:slot
                """,
                {
                    "name": profile.name,
                    "enabled": int(profile.enabled),
                    "revision": revision_id,
                    "slot": profile.slot_no,
                },
            )
            if profile.enabled:
                cursor.execute(
                    """
                    SELECT COUNT(*) FROM sds_documents d
                    WHERE NOT EXISTS (
                        SELECT 1 FROM sds_vlm_profile_runs pr
                        WHERE pr.document_id=d.document_id AND pr.slot_no=:slot
                          AND pr.revision_id=:revision
                          AND pr.content_sha256=d.content_sha256
                          AND pr.config_hash=:runtime_hash
                          AND pr.is_serving=1 AND pr.build_status='INDEXED'
                    )
                    """,
                    {
                        "slot": profile.slot_no,
                        "revision": revision_id,
                        "runtime_hash": self._runtime_hash(digest),
                    },
                )
                if int(cursor.fetchone()[0]) == 0:
                    cursor.execute(
                        "UPDATE sds_vlm_profiles SET apply_status='READY' WHERE slot_no=:slot",
                        {"slot": profile.slot_no},
                    )
            connection.commit()
        return self.get_profile(profile.slot_no)

    def set_apply_status(self, slot_no: int, status: str) -> None:
        if status not in {"READY", "PENDING", "PROCESSING", "FAILED"}:
            raise ValueError("invalid profile apply status")
        with self._connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                "UPDATE sds_vlm_profiles SET apply_status=:status, updated_at=SYSTIMESTAMP "
                "WHERE slot_no=:slot",
                {"status": status, "slot": slot_no},
            )
            connection.commit()

    def refresh_apply_status(self, slot_no: int) -> None:
        profile = self.get_profile(slot_no)
        status = "READY" if not profile.enabled or profile.pending_document_count == 0 else "PENDING"
        self.set_apply_status(slot_no, status)

    def pending_object_names(self, slot_no: int) -> list[str]:
        profile = self.get_profile(slot_no)
        if not profile.enabled:
            return []
        with self._connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT d.object_name FROM sds_documents d
                WHERE NOT EXISTS (
                    SELECT 1 FROM sds_vlm_profile_runs pr
                    WHERE pr.document_id=d.document_id AND pr.slot_no=:slot
                      AND pr.revision_id=:revision
                      AND pr.content_sha256=d.content_sha256
                      AND pr.config_hash=:runtime_hash
                      AND pr.is_serving=1 AND pr.build_status='INDEXED'
                )
                ORDER BY d.object_name
                """,
                {
                    "slot": slot_no,
                    "revision": profile.current_revision_id,
                    "runtime_hash": self._runtime_hash(profile.config_hash or ""),
                },
            )
            return [str(row[0]) for row in cursor.fetchall()]

    def pending_page_count(self, slot_no: int) -> int:
        profile = self.get_profile(slot_no)
        if not profile.enabled:
            return 0
        with self._connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT COUNT(*)
                FROM sds_evidence e
                JOIN sds_document_index_runs ir ON ir.index_run_id=e.index_run_id
                JOIN sds_documents d ON d.document_id=e.document_id
                WHERE ir.is_serving=1 AND ir.status='SUCCEEDED' AND e.unit_kind='page'
                  AND NOT EXISTS (
                    SELECT 1 FROM sds_vlm_profile_runs pr
                    WHERE pr.document_id=d.document_id AND pr.slot_no=:slot
                      AND pr.revision_id=:revision
                      AND pr.content_sha256=d.content_sha256
                      AND pr.config_hash=:runtime_hash
                      AND pr.is_serving=1 AND pr.build_status='INDEXED'
                  )
                """,
                {
                    "slot": slot_no,
                    "revision": profile.current_revision_id,
                    "runtime_hash": self._runtime_hash(profile.config_hash or ""),
                },
            )
            return int(cursor.fetchone()[0])

    def apply_impact(self, profile: ProfileConfig) -> tuple[int, int]:
        if not profile.enabled:
            return 0, 0
        current = self.get_profile(profile.slot_no)
        if current.enabled and profile_hash(profile) == current.config_hash:
            return len(self.pending_object_names(profile.slot_no)), self.pending_page_count(profile.slot_no)
        with self._connection() as connection, connection.cursor() as cursor:
            cursor.execute("SELECT COUNT(*) FROM sds_documents")
            documents = int(cursor.fetchone()[0])
            cursor.execute(
                """
                SELECT COUNT(*) FROM sds_evidence e
                JOIN sds_document_index_runs ir ON ir.index_run_id=e.index_run_id
                WHERE ir.is_serving=1 AND ir.status='SUCCEEDED' AND e.unit_kind='page'
                """
            )
            return documents, int(cursor.fetchone()[0])

    def mark_service_reindex_required(self, capability: str) -> int:
        if capability not in {"mineru", "ocr", "vlm"}:
            raise ValueError("unsupported shared indexing capability")
        with self._connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                "UPDATE sds_documents SET status='REINDEX_REQUIRED', updated_at=SYSTIMESTAMP"
            )
            count = int(cursor.rowcount)
            if capability == "vlm":
                cursor.execute(
                    "UPDATE sds_vlm_profiles SET apply_status='PENDING', updated_at=SYSTIMESTAMP "
                    "WHERE enabled=1"
                )
            connection.commit()
        return count


profile_repository = OracleProfileRepository()
