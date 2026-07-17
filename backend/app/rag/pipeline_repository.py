from __future__ import annotations

import hashlib
import json
import mimetypes
from array import array
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import PurePosixPath
from typing import Any, Iterator, Sequence
from uuid import uuid4

from app.rag.oracle_schema import SCHEMA_VERSION, schema_digest
from app.rag.pipeline_models import EmbeddingRecipe, EmbeddingRecipeInput, EmbeddingRecipeUpsert
from app.rag.pipeline_repository_types import (
    embedding_input_fingerprint,
    stable_hash_value,
)
from app.rag.service_settings import retrieval_service_settings
from app.services.database_service import database_service


def _lob_text(value: object) -> str:
    if hasattr(value, "read"):
        value = value.read()
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return str(value or "")


def _json_value(value: object, default: Any) -> Any:
    if value is None:
        return default
    if isinstance(value, (dict, list)):
        return value
    text = _lob_text(value).strip()
    return json.loads(text) if text else default


def stable_hash(value: object) -> str:
    return stable_hash_value(value)


def release_validation_error_message(validation: dict[str, Any]) -> str:
    """Turn a failed validation snapshot into an actionable conflict message."""
    issues: list[str] = []
    missing = [str(item) for item in validation.get("missing_components", [])]
    stale_value = validation.get("stale_components", {})
    stale = (
        [str(item) for item in stale_value]
        if isinstance(stale_value, (dict, list, tuple, set))
        else []
    )
    invalid_runs = [
        str(item) for item in validation.get("invalid_stage_runs", [])
    ]
    cross_revision = [
        str(item) for item in validation.get("cross_revision_components", [])
    ]
    config_mismatches = [
        str(item) for item in validation.get("config_mismatch_components", [])
    ]
    invalid_embeddings = validation.get("invalid_embeddings", [])
    if missing:
        issues.append(f"未実行: {', '.join(missing)}")
    if stale:
        issues.append(f"更新が必要: {', '.join(stale)}")
    if invalid_runs:
        issues.append(f"失敗した段階: {', '.join(invalid_runs)}")
    if cross_revision:
        issues.append(f"文書Revision不一致: {', '.join(cross_revision)}")
    if config_mismatches:
        issues.append(f"設定不一致: {', '.join(config_mismatches)}")
    if invalid_embeddings:
        issues.append(f"Embedding入力不一致: {len(invalid_embeddings)}件")
    detail = "；".join(issues) or "検証条件を満たしていません"
    return f"Releaseの構成が不完全なため公開できません（{detail}）"


@dataclass(frozen=True)
class RevisionRecord:
    document_id: str
    revision_id: str
    content_sha256: str
    bucket: str
    object_name: str
    file_name: str
    media_type: str
    document_type: str
    content_changed: bool


@dataclass
class ArtifactRecord:
    artifact_id: str = field(default_factory=lambda: uuid4().hex)
    artifact_kind: str = ""
    source_locator: str = ""
    page_number: int | None = None
    parent_artifact_id: str | None = None
    bbox: list[float] | None = None
    raw_text: str = ""
    search_text: str = ""
    object_name: str | None = None
    payload: dict[str, Any] | list[Any] | None = None
    metadata: dict[str, Any] = field(default_factory=dict)
    content_sha256: str = ""
    lineage: list[tuple[str, str, int]] = field(default_factory=list)

    def finalize_hash(self) -> None:
        if not self.content_sha256:
            self.content_sha256 = stable_hash(
                {
                    "kind": self.artifact_kind,
                    "locator": self.source_locator,
                    "page": self.page_number,
                    "text": self.raw_text,
                    "object": self.object_name,
                    "payload": self.payload,
                }
            )


class LeaseLostError(RuntimeError):
    """Raised when a worker attempts to commit after losing its job lease."""


class OraclePipelineRepository:
    @contextmanager
    def connection(self) -> Iterator[Any]:
        if not database_service._ensure_pool_initialized():
            raise RuntimeError("データベース接続が設定されていません")
        with database_service.pool_manager.acquire_connection() as connection:
            yield connection

    @staticmethod
    def rows(cursor: Any) -> list[dict[str, Any]]:
        columns = [item[0].lower() for item in cursor.description or []]
        return [dict(zip(columns, row)) for row in cursor.fetchall()]

    def schema_ready(self) -> bool:
        try:
            with self.connection() as connection, connection.cursor() as cursor:
                cursor.execute(
                    "SELECT COUNT(*) FROM SDS_SCHEMA_VERSION "
                    "WHERE VERSION_ID=:version AND DDL_SHA256=:digest",
                    {"version": SCHEMA_VERSION, "digest": schema_digest()},
                )
                return bool(cursor.fetchone()[0])
        except Exception:
            return False

    def enabled_recipes(self) -> list[EmbeddingRecipe]:
        return [item for item in self.list_recipes() if item.enabled]

    def list_recipes(self) -> list[EmbeddingRecipe]:
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT r.recipe_id, r.code, r.name, r.description, r.enabled,
                       r.search_weight, r.current_revision_id, rr.revision_no,
                       rr.config_hash, rr.model_id, rr.output_dimensions, rr.target_scope
                FROM sds_embedding_recipes r
                JOIN sds_embedding_recipe_revisions rr
                  ON rr.revision_id=r.current_revision_id
                ORDER BY r.code
                """
            )
            recipes = self.rows(cursor)
            result: list[EmbeddingRecipe] = []
            for row in recipes:
                cursor.execute(
                    """
                    SELECT source_type, source_ref, required
                    FROM sds_embedding_recipe_inputs
                    WHERE revision_id=:revision ORDER BY input_ordinal
                    """,
                    {"revision": row["current_revision_id"]},
                )
                inputs = [
                    EmbeddingRecipeInput(
                        source_type=str(item[0]),
                        source_ref=str(item[1]) if item[1] is not None else None,
                        required=bool(item[2]),
                    )
                    for item in cursor.fetchall()
                ]
                result.append(
                    EmbeddingRecipe(
                        recipe_id=str(row["recipe_id"]),
                        code=str(row["code"]),
                        name=str(row["name"]),
                        description=str(row.get("description") or ""),
                        enabled=bool(row["enabled"]),
                        search_weight=float(row["search_weight"]),
                        target_scope=str(row["target_scope"]),
                        inputs=inputs,
                        current_revision_id=str(row["current_revision_id"]),
                        revision_no=int(row["revision_no"]),
                        config_hash=str(row["config_hash"]),
                        model_id=str(row["model_id"]),
                        output_dimensions=int(row["output_dimensions"]),
                    )
                )
            return result

    def get_recipe(self, code: str) -> EmbeddingRecipe:
        try:
            return next(item for item in self.list_recipes() if item.code == code)
        except StopIteration as error:
            raise LookupError("Embeddingレシピが見つかりません") from error

    def upsert_recipe(self, value: EmbeddingRecipeUpsert) -> EmbeddingRecipe:
        config = {
            "model_id": "cohere.embed-v4.0",
            "output_dimensions": 1536,
            "target_scope": value.target_scope,
            "inputs": [item.model_dump(mode="json") for item in value.inputs],
        }
        digest = stable_hash(config)
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                "SELECT recipe_id, current_revision_id FROM sds_embedding_recipes "
                "WHERE code=:code FOR UPDATE",
                {"code": value.code},
            )
            row = cursor.fetchone()
            recipe_id = str(row[0]) if row else uuid4().hex
            if not row:
                cursor.execute(
                    """
                    INSERT INTO sds_embedding_recipes
                        (recipe_id, code, name, description, enabled, search_weight)
                    VALUES (:id, :code, :name, :description, :enabled, :weight)
                    """,
                    {
                        "id": recipe_id,
                        "code": value.code,
                        "name": value.name,
                        "description": value.description,
                        "enabled": int(value.enabled),
                        "weight": value.search_weight,
                    },
                )
                current_revision_id = None
            else:
                current_revision_id = str(row[1]) if row[1] else None
                cursor.execute(
                    """
                    UPDATE sds_embedding_recipes
                    SET name=:name, description=:description, enabled=:enabled,
                        search_weight=:weight, updated_at=SYSTIMESTAMP
                    WHERE recipe_id=:id
                    """,
                    {
                        "id": recipe_id,
                        "name": value.name,
                        "description": value.description,
                        "enabled": int(value.enabled),
                        "weight": value.search_weight,
                    },
                )
            current_hash = None
            if current_revision_id:
                cursor.execute(
                    "SELECT config_hash FROM sds_embedding_recipe_revisions "
                    "WHERE revision_id=:revision",
                    {"revision": current_revision_id},
                )
                current_hash = str(cursor.fetchone()[0])
            if current_hash != digest:
                revision_id = uuid4().hex
                cursor.execute(
                    "SELECT NVL(MAX(revision_no), 0)+1 FROM sds_embedding_recipe_revisions "
                    "WHERE recipe_id=:id",
                    {"id": recipe_id},
                )
                revision_no = int(cursor.fetchone()[0])
                cursor.execute(
                    """
                    INSERT INTO sds_embedding_recipe_revisions
                        (revision_id, recipe_id, revision_no, config_hash, model_id,
                         output_dimensions, target_scope, missing_input_policy)
                    VALUES (:revision, :id, :revision_no, :hash, 'cohere.embed-v4.0',
                            1536, :scope, 'SKIP_TARGET')
                    """,
                    {
                        "revision": revision_id,
                        "id": recipe_id,
                        "revision_no": revision_no,
                        "hash": digest,
                        "scope": value.target_scope,
                    },
                )
                for ordinal, item in enumerate(value.inputs, 1):
                    cursor.execute(
                        """
                        INSERT INTO sds_embedding_recipe_inputs
                            (revision_id, input_ordinal, source_type, source_ref, required)
                        VALUES (:revision, :ordinal, :source, :ref, :required)
                        """,
                        {
                            "revision": revision_id,
                            "ordinal": ordinal,
                            "source": item.source_type,
                            "ref": item.source_ref,
                            "required": int(item.required),
                        },
                    )
                cursor.execute(
                    "UPDATE sds_embedding_recipes SET current_revision_id=:revision "
                    "WHERE recipe_id=:id",
                    {"revision": revision_id, "id": recipe_id},
                )
                cursor.execute(
                    """
                    UPDATE sds_index_release_components c
                    SET c.is_stale=1, c.stale_reason='Embeddingレシピ設定が更新されました'
                    WHERE c.component_key=:component AND EXISTS (
                        SELECT 1 FROM sds_index_releases r
                        WHERE r.release_id=c.release_id AND r.status='DRAFT'
                    )
                    """,
                    {"component": f"embedding:{value.code}"},
                )
            connection.commit()
        return self.get_recipe(value.code)

    def register_revision(
        self,
        *,
        bucket: str,
        object_name: str,
        content: bytes,
        media_type: str | None = None,
        object_version: str | None = None,
        etag: str | None = None,
        job_id: str | None = None,
        owner: str | None = None,
        generation: int | None = None,
    ) -> RevisionRecord:
        digest = hashlib.sha256(content).hexdigest()
        file_name = PurePosixPath(object_name).name
        media_type = media_type or mimetypes.guess_type(file_name)[0] or "application/octet-stream"
        document_type = PurePosixPath(file_name).suffix.casefold().lstrip(".")
        with self.connection() as connection, connection.cursor() as cursor:
            if job_id is not None:
                cursor.execute(
                    """
                    SELECT job_id FROM sds_pipeline_jobs
                    WHERE job_id=:job AND lease_owner=:owner
                      AND lease_generation=:generation AND status='RUNNING'
                    FOR UPDATE
                    """,
                    {"job": job_id, "owner": owner, "generation": generation},
                )
                if not cursor.fetchone():
                    connection.rollback()
                    raise LeaseLostError("処理Jobのリースが失効しました")
            cursor.execute(
                "SELECT document_id, current_revision_id, content_sha256 "
                "FROM sds_documents WHERE bucket=:bucket AND object_name=:object FOR UPDATE",
                {"bucket": bucket, "object": object_name},
            )
            row = cursor.fetchone()
            document_id = str(row[0]) if row else uuid4().hex
            content_changed = not row or str(row[2] or "") != digest
            if not row:
                cursor.execute(
                    """
                    INSERT INTO sds_documents
                        (document_id, bucket, object_name, file_name, media_type,
                         document_type, file_size, content_sha256, status)
                    VALUES (:document, :bucket, :object, :file_name_bind, :media, :type,
                            :file_size_bind, :hash, 'UNPROCESSED')
                    """,
                    {
                        "document": document_id,
                        "bucket": bucket,
                        "object": object_name,
                        "file_name_bind": file_name,
                        "media": media_type,
                        "type": document_type or None,
                        "file_size_bind": len(content),
                        "hash": digest,
                    },
                )
            cursor.execute(
                "SELECT revision_id FROM sds_document_revisions "
                "WHERE document_id=:document AND content_sha256=:hash",
                {"document": document_id, "hash": digest},
            )
            revision_row = cursor.fetchone()
            revision_id = str(revision_row[0]) if revision_row else uuid4().hex
            if not revision_row:
                cursor.execute(
                    """
                    INSERT INTO sds_document_revisions
                        (revision_id, document_id, content_sha256, object_version, etag,
                         file_size, media_type, source_metadata_json)
                    VALUES (:revision, :document, :hash, :version, :etag,
                            :file_size_bind, :media, :metadata)
                    """,
                    {
                        "revision": revision_id,
                        "document": document_id,
                        "hash": digest,
                        "version": object_version,
                        "etag": etag,
                        "file_size_bind": len(content),
                        "media": media_type,
                        "metadata": json.dumps({"bucket": bucket, "object_name": object_name}),
                    },
                )
            cursor.execute(
                """
                UPDATE sds_documents
                SET current_revision_id=:revision, file_name=:file_name_bind, media_type=:media,
                    document_type=:type, file_size=:file_size_bind, content_sha256=:hash,
                    draft_release_id=CASE WHEN current_revision_id=:revision
                                          THEN draft_release_id ELSE NULL END,
                    status=CASE WHEN serving_release_id IS NULL THEN 'UNPROCESSED'
                                WHEN current_revision_id=:revision THEN status
                                ELSE 'UPDATE_AVAILABLE' END,
                    updated_at=SYSTIMESTAMP
                WHERE document_id=:document
                """,
                {
                    "revision": revision_id,
                    "file_name_bind": file_name,
                    "media": media_type,
                    "type": document_type or None,
                    "file_size_bind": len(content),
                    "hash": digest,
                    "document": document_id,
                },
            )
            cursor.execute(
                """
                MERGE INTO sds_document_acl a
                USING (SELECT :document document_id FROM dual) s
                ON (a.document_id=s.document_id AND a.principal_type='public_authenticated'
                    AND a.principal_hash=:principal)
                WHEN NOT MATCHED THEN INSERT
                    (document_id, principal_type, principal_hash, permission)
                    VALUES (:document, 'public_authenticated', :principal, 'read')
                """,
                {"document": document_id, "principal": "0" * 64},
            )
            connection.commit()
        return RevisionRecord(
            document_id=document_id,
            revision_id=revision_id,
            content_sha256=digest,
            bucket=bucket,
            object_name=object_name,
            file_name=file_name,
            media_type=media_type,
            document_type=document_type,
            content_changed=content_changed,
        )

    @staticmethod
    def _current_required_components(cursor: Any) -> set[str]:
        """Return the components that belong to releases under current settings."""
        required = {"render", "native_parse", "normalize"}
        ocr_settings = retrieval_service_settings.get_ocr()
        if ocr_settings.enabled:
            required.add("ocr")
        mineru_settings = retrieval_service_settings.get_mineru()
        if mineru_settings.enabled and mineru_settings.base_url:
            required.add("mineru_parse")
        cursor.execute("SELECT code FROM sds_embedding_recipes WHERE enabled=1")
        required.update(f"embedding:{item[0]}" for item in cursor.fetchall())
        cursor.execute("SELECT slot_no FROM sds_vlm_profiles WHERE enabled=1")
        required.update(f"vlm:{item[0]}" for item in cursor.fetchall())
        return required

    @staticmethod
    def _prune_inactive_release_components(
        cursor: Any, release_id: str, active_components: set[str]
    ) -> None:
        """Detach outputs for stages that no longer belong to the release contract."""
        component_binds = {
            f"active_component_{index}": component
            for index, component in enumerate(sorted(active_components))
        }
        component_placeholders = ", ".join(f":{key}" for key in component_binds)
        cursor.execute(
            f"""
            DELETE FROM sds_index_release_components
            WHERE release_id=:release
              AND component_key NOT IN ({component_placeholders})
            """,
            {"release": release_id, **component_binds},
        )

    @staticmethod
    def _mark_outdated_component_configs(cursor: Any, release_id: str) -> None:
        from app.rag.pipeline_config import stage_config_hash

        cursor.execute(
            """
            SELECT c.component_key, c.stage_kind, sr.config_hash
            FROM sds_index_release_components c
            JOIN sds_stage_runs sr ON sr.stage_run_id=c.stage_run_id
            WHERE c.release_id=:release
            """,
            {"release": release_id},
        )
        for component, kind, actual_hash in cursor.fetchall():
            try:
                expected_hash = stage_config_hash(str(kind), str(component))
            except (LookupError, ValueError):
                expected_hash = ""
            if str(actual_hash) != expected_hash:
                cursor.execute(
                    """
                    UPDATE sds_index_release_components
                    SET is_stale=1, stale_reason='現在の段階設定と一致しません'
                    WHERE release_id=:release AND component_key=:component
                    """,
                    {"release": release_id, "component": str(component)},
                )

    def ensure_draft_release(
        self,
        revision: RevisionRecord,
        job_id: str,
        *,
        owner: str | None = None,
        generation: int | None = None,
    ) -> str:
        with self.connection() as connection, connection.cursor() as cursor:
            if owner is not None:
                cursor.execute(
                    """
                    SELECT job_id FROM sds_pipeline_jobs
                    WHERE job_id=:job AND lease_owner=:owner
                      AND lease_generation=:generation AND status='RUNNING'
                    FOR UPDATE
                    """,
                    {"job": job_id, "owner": owner, "generation": generation},
                )
                if not cursor.fetchone():
                    connection.rollback()
                    raise LeaseLostError("処理Jobのリースが失効しました")
            cursor.execute(
                "SELECT draft_release_id FROM sds_documents WHERE document_id=:document FOR UPDATE",
                {"document": revision.document_id},
            )
            draft_id = cursor.fetchone()[0]
            if draft_id:
                cursor.execute(
                    "SELECT document_revision_id, status FROM sds_index_releases WHERE release_id=:id",
                    {"id": draft_id},
                )
                current = cursor.fetchone()
                if (
                    current
                    and str(current[0]) == revision.revision_id
                    and str(current[1]) == "DRAFT"
                ):
                    active_components = self._current_required_components(cursor)
                    self._prune_inactive_release_components(
                        cursor, str(draft_id), active_components
                    )
                    self._mark_outdated_component_configs(cursor, str(draft_id))
                    connection.commit()
                    return str(draft_id)
            release_id = uuid4().hex
            cursor.execute(
                """
                INSERT INTO sds_index_releases
                    (release_id, document_id, document_revision_id, status, created_by_job_id)
                VALUES (:release, :document, :revision, 'DRAFT', :job)
                """,
                {
                    "release": release_id,
                    "document": revision.document_id,
                    "revision": revision.revision_id,
                    "job": job_id,
                },
            )
            cursor.execute(
                """
                INSERT INTO sds_index_release_components
                    (release_id, component_key, stage_kind, stage_run_id, is_stale, stale_reason)
                SELECT :draft, c.component_key, c.stage_kind, c.stage_run_id, 0, NULL
                FROM sds_documents d
                JOIN sds_index_releases r ON r.release_id=d.serving_release_id
                JOIN sds_index_release_components c ON c.release_id=r.release_id
                WHERE d.document_id=:document AND r.document_revision_id=:revision
                """,
                {
                    "draft": release_id,
                    "document": revision.document_id,
                    "revision": revision.revision_id,
                },
            )
            active_components = self._current_required_components(cursor)
            self._prune_inactive_release_components(
                cursor, release_id, active_components
            )
            # A profile/recipe can change while the serving release remains
            # immutable. When cloning that release into a new revision, mark
            # components whose executor metadata points at an older revision
            # as stale instead of silently publishing a mixed configuration.
            cursor.execute(
                """
                UPDATE sds_index_release_components c
                SET is_stale=1, stale_reason='VLMプロファイル設定が更新されています'
                WHERE c.release_id=:release AND c.component_key LIKE 'vlm:%'
                  AND EXISTS (
                      SELECT 1
                      FROM sds_stage_runs sr
                      JOIN sds_vlm_profiles p
                        ON p.slot_no=TO_NUMBER(SUBSTR(c.component_key, 5))
                      WHERE sr.stage_run_id=c.stage_run_id
                        AND JSON_VALUE(
                            sr.metadata_json, '$.profile_revision_id'
                            RETURNING VARCHAR2(64) NULL ON ERROR
                        )<>p.current_revision_id
                  )
                """,
                {"release": release_id},
            )
            self._mark_outdated_component_configs(cursor, release_id)
            cursor.execute(
                """
                UPDATE sds_index_release_components c
                SET is_stale=1, stale_reason='Embeddingレシピ設定が更新されています'
                WHERE c.release_id=:release AND c.component_key LIKE 'embedding:%'
                  AND EXISTS (
                      SELECT 1
                      FROM sds_stage_runs sr
                      JOIN sds_embedding_recipes r
                        ON r.code=SUBSTR(c.component_key, 11)
                      WHERE sr.stage_run_id=c.stage_run_id
                        AND JSON_VALUE(
                            sr.metadata_json, '$.recipe_revision_id'
                            RETURNING VARCHAR2(64) NULL ON ERROR
                        )<>r.current_revision_id
                  )
                """,
                {"release": release_id},
            )
            cursor.execute(
                "UPDATE sds_documents SET draft_release_id=:release, status='PROCESSING', "
                "updated_at=SYSTIMESTAMP WHERE document_id=:document",
                {"release": release_id, "document": revision.document_id},
            )
            connection.commit()
            return release_id

    def create_job(
        self,
        *,
        request_json: str,
        mode: str,
        publish_mode: str,
        step_specs: Sequence[dict[str, Any]],
        idempotency_key: str | None,
    ) -> tuple[str, bool]:
        request_fingerprint = stable_hash(_json_value(request_json, {}))
        with self.connection() as connection, connection.cursor() as cursor:
            try:
                if idempotency_key:
                    cursor.execute(
                        "SELECT job_id, request_json FROM sds_pipeline_jobs "
                        "WHERE idempotency_key=:idempotency_key",
                        {"idempotency_key": idempotency_key},
                    )
                    row = cursor.fetchone()
                    if row:
                        if stable_hash(_json_value(row[1], {})) != request_fingerprint:
                            raise ValueError(
                                "同じIdempotency-Keyが異なるリクエストに使用されています"
                            )
                        return str(row[0]), True
                job_id = uuid4().hex
                cursor.execute(
                    """
                    INSERT INTO sds_pipeline_jobs
                        (job_id, idempotency_key, job_mode, publish_mode, request_json, total_steps)
                    VALUES (:job_id, :idempotency_key, :job_mode, :publish_mode,
                            :request_json, :total_steps)
                    """,
                    {
                        "job_id": job_id,
                        "idempotency_key": idempotency_key,
                        "job_mode": mode,
                        "publish_mode": publish_mode,
                        "request_json": request_json,
                        "total_steps": len(step_specs),
                    },
                )
                step_ids = {
                    (str(spec["object_name"]), str(spec["component_key"])): uuid4().hex
                    for spec in step_specs
                }
                for ordinal, spec in enumerate(step_specs, 1):
                    identity = (str(spec["object_name"]), str(spec["component_key"]))
                    cursor.execute(
                        """
                        INSERT INTO sds_pipeline_job_steps
                            (step_id, job_id, object_name, step_ordinal, stage_kind,
                             component_key, status, force_run)
                        VALUES (:step_id, :job_id, :object_name, :step_ordinal,
                                :stage_kind, :component_key, 'QUEUED', :force_run)
                        """,
                        {
                            "step_id": step_ids[identity],
                            "job_id": job_id,
                            "object_name": identity[0],
                            "step_ordinal": ordinal,
                            "stage_kind": spec["kind"],
                            "component_key": identity[1],
                            "force_run": int(bool(spec.get("force"))),
                        },
                    )
                    for dependency in spec.get("depends_on", ()): 
                        dependency_id = step_ids.get((identity[0], str(dependency)))
                        if dependency_id is None:
                            raise ValueError(
                                f"処理段階 {identity[1]} の依存先がJobにありません: {dependency}"
                            )
                        cursor.execute(
                            """
                            INSERT INTO sds_pipeline_step_dependencies
                                (step_id, depends_on_step_id)
                            VALUES (:step, :dependency)
                            """,
                            {"step": step_ids[identity], "dependency": dependency_id},
                        )
                self._append_event_cursor(
                    cursor,
                    job_id,
                    "job_queued",
                    {"status": "QUEUED", "total_steps": len(step_specs)},
                )
                connection.commit()
                return job_id, False
            except Exception as error:
                connection.rollback()
                if not idempotency_key:
                    raise
                # Resolve concurrent inserts against the unique key. The same
                # request reuses the winner; a different payload is rejected.
                cursor.execute(
                    "SELECT job_id, request_json FROM sds_pipeline_jobs "
                    "WHERE idempotency_key=:idempotency_key",
                    {"idempotency_key": idempotency_key},
                )
                row = cursor.fetchone()
                if row:
                    if stable_hash(_json_value(row[1], {})) != request_fingerprint:
                        raise ValueError(
                            "同じIdempotency-Keyが異なるリクエストに使用されています"
                        ) from error
                    return str(row[0]), True
                raise

    @staticmethod
    def _append_event_cursor(cursor: Any, job_id: str, event_type: str, payload: dict[str, Any]) -> None:
        cursor.execute(
            "SELECT NVL(MAX(sequence_no), 0)+1 FROM sds_job_events WHERE job_id=:job",
            {"job": job_id},
        )
        sequence = int(cursor.fetchone()[0])
        cursor.execute(
            """
            INSERT INTO sds_job_events (job_id, sequence_no, event_type, payload_json)
            VALUES (:job, :sequence, :type, :payload)
            """,
            {
                "job": job_id,
                "sequence": sequence,
                "type": event_type,
                "payload": json.dumps(payload, ensure_ascii=False),
            },
        )

    def append_event(self, job_id: str, event_type: str, payload: dict[str, Any]) -> None:
        with self.connection() as connection, connection.cursor() as cursor:
            self._append_event_cursor(cursor, job_id, event_type, payload)
            connection.commit()

    def events(self, job_id: str, after_sequence: int = 0) -> list[dict[str, Any]]:
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT sequence_no, event_type, payload_json, created_at
                FROM sds_job_events
                WHERE job_id=:job AND sequence_no>:after
                ORDER BY sequence_no
                """,
                {"job": job_id, "after": max(0, after_sequence)},
            )
            return [
                {
                    "sequence": int(row[0]),
                    "type": str(row[1]),
                    "payload": _json_value(row[2], {}),
                    "created_at": row[3],
                }
                for row in cursor.fetchall()
            ]

    def get_job(self, job_id: str) -> dict[str, Any]:
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute("SELECT * FROM sds_pipeline_jobs WHERE job_id=:job", {"job": job_id})
            rows = self.rows(cursor)
            if not rows:
                raise LookupError("処理ジョブが見つかりません")
            job = rows[0]
            job["request_json"] = _json_value(job.get("request_json"), {})
            job["cancel_requested"] = bool(job.get("cancel_requested"))
            cursor.execute(
                "SELECT * FROM sds_pipeline_job_steps WHERE job_id=:job ORDER BY step_ordinal",
                {"job": job_id},
            )
            job["steps"] = self.rows(cursor)
            cursor.execute(
                """
                SELECT dependency.step_id, parent.component_key
                FROM sds_pipeline_step_dependencies dependency
                JOIN sds_pipeline_job_steps parent
                  ON parent.step_id=dependency.depends_on_step_id
                JOIN sds_pipeline_job_steps child ON child.step_id=dependency.step_id
                WHERE child.job_id=:job
                ORDER BY parent.step_ordinal
                """,
                {"job": job_id},
            )
            dependencies: dict[str, list[str]] = {}
            for step_id, component in cursor.fetchall():
                dependencies.setdefault(str(step_id), []).append(str(component))
            for step in job["steps"]:
                step["depends_on"] = dependencies.get(str(step["step_id"]), [])
            return job

    def claim_next_job(
        self, owner: str, lease_seconds: int = 90
    ) -> tuple[str, int] | None:
        # LEASE_UNTIL is a plain TIMESTAMP holding the DB wall clock.  Comparing
        # it against SYSTIMESTAMP (TIMESTAMP WITH TIME ZONE) would make Oracle
        # reinterpret it in SESSIONTIMEZONE, so a client in a different zone
        # sees every fresh lease as already expired and reclaims its own job on
        # each poll.  CAST keeps both sides on the naive DB clock.
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT job_id, lease_generation FROM sds_pipeline_jobs
                WHERE status IN ('QUEUED', 'RUNNING')
                  AND (lease_until IS NULL
                       OR lease_until<CAST(SYSTIMESTAMP AS TIMESTAMP))
                  AND ROWNUM=1
                FOR UPDATE SKIP LOCKED
                """
            )
            row = cursor.fetchone()
            if not row:
                connection.rollback()
                return None
            job_id = str(row[0])
            expected_generation = int(row[1] or 0)
            generation = expected_generation + 1
            cursor.execute(
                """
                UPDATE sds_pipeline_jobs
                SET status='RUNNING', lease_owner=:owner,
                    lease_generation=:generation,
                    lease_until=SYSTIMESTAMP+NUMTODSINTERVAL(:lease, 'SECOND'),
                    heartbeat_at=SYSTIMESTAMP,
                    started_at=COALESCE(started_at, SYSTIMESTAMP), updated_at=SYSTIMESTAMP
                WHERE job_id=:job AND lease_generation=:expected_generation
                  AND status IN ('QUEUED', 'RUNNING')
                  AND (lease_until IS NULL
                       OR lease_until<CAST(SYSTIMESTAMP AS TIMESTAMP))
                """,
                {
                    "owner": owner,
                    "generation": generation,
                    "expected_generation": expected_generation,
                    "lease": lease_seconds,
                    "job": job_id,
                },
            )
            # Multiple dispatchers may all evaluate the expired lease before
            # the first SELECT ... SKIP LOCKED transaction commits. Re-check
            # generation and expiry in the UPDATE so only one stale snapshot
            # can win the claim.
            if cursor.rowcount != 1:
                connection.rollback()
                return None
            # A worker can disappear while a step is running.  The job lease
            # is the recovery boundary, so make any in-flight step claimable
            # again only after this worker wins the compare-and-set above.
            cursor.execute(
                """
                UPDATE sds_pipeline_job_steps
                SET status='QUEUED', updated_at=SYSTIMESTAMP
                WHERE job_id=:job AND status='RUNNING'
                """,
                {"job": job_id},
            )
            self._append_event_cursor(
                cursor,
                job_id,
                "job_started",
                {"status": "RUNNING", "owner": owner, "generation": generation},
            )
            connection.commit()
            return job_id, generation

    def heartbeat(
        self,
        job_id: str,
        owner: str,
        generation: int,
        lease_seconds: int = 90,
    ) -> bool:
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE sds_pipeline_jobs
                SET lease_until=SYSTIMESTAMP+NUMTODSINTERVAL(:lease, 'SECOND'),
                    heartbeat_at=SYSTIMESTAMP, updated_at=SYSTIMESTAMP
                WHERE job_id=:job AND lease_owner=:owner
                  AND lease_generation=:generation AND status='RUNNING'
                """,
                {
                    "lease": lease_seconds,
                    "job": job_id,
                    "owner": owner,
                    "generation": generation,
                },
            )
            renewed = cursor.rowcount == 1
            connection.commit()
            return renewed

    def cancel_job(self, job_id: str) -> bool:
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE sds_pipeline_jobs
                SET cancel_requested=1,
                    status=CASE WHEN status='QUEUED' THEN 'CANCELLED' ELSE status END,
                    completed_at=CASE WHEN status='QUEUED' THEN SYSTIMESTAMP ELSE completed_at END,
                    updated_at=SYSTIMESTAMP
                WHERE job_id=:job AND status IN ('QUEUED', 'RUNNING')
                """,
                {"job": job_id},
            )
            changed = cursor.rowcount == 1
            if changed:
                cursor.execute(
                    """
                    UPDATE sds_pipeline_job_steps
                    SET status='CANCELLED', completed_at=SYSTIMESTAMP,
                        updated_at=SYSTIMESTAMP
                    WHERE job_id=:job AND status IN ('QUEUED', 'BLOCKED')
                    """,
                    {"job": job_id},
                )
                self._append_event_cursor(cursor, job_id, "cancel_requested", {})
                cursor.execute(
                    """
                    UPDATE sds_pipeline_jobs job
                    SET status='CANCELLED', lease_owner=NULL, lease_until=NULL,
                        completed_at=COALESCE(completed_at, SYSTIMESTAMP),
                        updated_at=SYSTIMESTAMP
                    WHERE job_id=:job AND cancel_requested=1
                      AND status IN ('RUNNING', 'CANCELLED')
                      AND NOT EXISTS (
                          SELECT 1 FROM sds_pipeline_job_steps step
                          WHERE step.job_id=job.job_id AND step.status='RUNNING'
                      )
                    """,
                    {"job": job_id},
                )
                if cursor.rowcount == 1:
                    self._append_event_cursor(
                        cursor, job_id, "job_completed", {"status": "CANCELLED"}
                    )
            connection.commit()
            return changed

    def retry_job(self, job_id: str) -> str:
        source = self.get_job(job_id)
        retry_components = {
            (str(step["object_name"]), str(step["component_key"]))
            for step in source["steps"]
            if str(step["status"]) in {"FAILED", "BLOCKED"}
        }
        if not retry_components:
            raise ValueError("再試行できる失敗処理がありません")
        request = dict(source["request_json"])
        request["force"] = True
        specs = [
            {
                "object_name": str(step["object_name"]),
                "kind": str(step["stage_kind"]),
                "component_key": str(step["component_key"]),
                "force": str(step["status"]) == "FAILED",
                "depends_on": [
                    dependency
                    for dependency in step.get("depends_on", [])
                    if (str(step["object_name"]), dependency) in retry_components
                ],
            }
            for step in source["steps"]
            if (str(step["object_name"]), str(step["component_key"])) in retry_components
        ]
        new_job_id, _ = self.create_job(
            request_json=json.dumps(request, ensure_ascii=False),
            mode="CUSTOM",
            publish_mode=str(source["publish_mode"]),
            step_specs=specs,
            idempotency_key=None,
        )
        return new_job_id

    def next_step(
        self,
        job_id: str,
        exclude_object_names: Sequence[str] | None = None,
    ) -> dict[str, Any] | None:
        excluded = list(
            dict.fromkeys(str(value) for value in (exclude_object_names or ()))
        )
        excluded_binds = {
            f"excluded_object_{index}": value
            for index, value in enumerate(excluded)
        }
        excluded_clause = ""
        if excluded_binds:
            placeholders = ", ".join(f":{key}" for key in excluded_binds)
            excluded_clause = f" AND child.object_name NOT IN ({placeholders})"
        with self.connection() as connection, connection.cursor() as cursor:
            while True:
                cursor.execute(
                    """
                UPDATE sds_pipeline_job_steps child
                SET status='BLOCKED',
                    error_summary='上流段階が失敗またはキャンセルされました',
                    completed_at=SYSTIMESTAMP, updated_at=SYSTIMESTAMP
                WHERE child.job_id=:job AND child.status='QUEUED'
                  AND EXISTS (
                      SELECT 1
                      FROM sds_pipeline_step_dependencies dependency
                      JOIN sds_pipeline_job_steps parent
                        ON parent.step_id=dependency.depends_on_step_id
                      WHERE dependency.step_id=child.step_id
                        AND parent.status IN ('FAILED', 'BLOCKED', 'CANCELLED')
                  )
                    """,
                    {"job": job_id},
                )
                if cursor.rowcount == 0:
                    break
            cursor.execute(
                f"""
                SELECT child.* FROM sds_pipeline_job_steps child
                WHERE child.job_id=:job AND child.status='QUEUED'
                  {excluded_clause}
                  AND NOT EXISTS (
                      SELECT 1
                      FROM sds_pipeline_step_dependencies dependency
                      JOIN sds_pipeline_job_steps parent
                        ON parent.step_id=dependency.depends_on_step_id
                      WHERE dependency.step_id=child.step_id
                        AND parent.status NOT IN ('SUCCEEDED', 'REUSED')
                  )
                ORDER BY child.step_ordinal FETCH FIRST 1 ROWS ONLY
                """,
                {"job": job_id, **excluded_binds},
            )
            rows = self.rows(cursor)
            connection.commit()
            return rows[0] if rows else None

    def start_step(
        self,
        step_id: str,
        *,
        owner: str,
        generation: int,
        document_id: str | None = None,
        revision_id: str | None = None,
        release_id: str | None = None,
        progress_total: int = 0,
    ) -> None:
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE sds_pipeline_job_steps
                SET status='RUNNING', document_id=:document,
                    document_revision_id=:revision, release_id=:release,
                    progress_total=:total, attempt_count=attempt_count+1,
                    lease_generation=:generation, error_summary=NULL,
                    started_at=SYSTIMESTAMP, updated_at=SYSTIMESTAMP
                WHERE step_id=:step AND status='QUEUED'
                  AND EXISTS (
                      SELECT 1 FROM sds_pipeline_jobs job
                      WHERE job.job_id=sds_pipeline_job_steps.job_id
                        AND job.lease_owner=:owner
                        AND job.lease_generation=:generation
                        AND job.status='RUNNING'
                  )
                """,
                {
                    "document": document_id,
                    "revision": revision_id,
                    "release": release_id,
                    "total": progress_total,
                    "owner": owner,
                    "generation": generation,
                    "step": step_id,
                },
            )
            if cursor.rowcount != 1:
                connection.rollback()
                raise LeaseLostError("処理Jobのリースが失効しました")
            connection.commit()

    def attach_step_context(
        self,
        step_id: str,
        *,
        owner: str,
        generation: int,
        document_id: str,
        revision_id: str,
        release_id: str,
    ) -> None:
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE sds_pipeline_job_steps
                SET document_id=:document, document_revision_id=:revision,
                    release_id=:release, updated_at=SYSTIMESTAMP
                WHERE step_id=:step AND status='RUNNING'
                  AND lease_generation=:generation
                  AND EXISTS (
                      SELECT 1 FROM sds_pipeline_jobs job
                      WHERE job.job_id=sds_pipeline_job_steps.job_id
                        AND job.lease_owner=:owner
                        AND job.lease_generation=:generation
                        AND job.status='RUNNING'
                  )
                """,
                {
                    "document": document_id,
                    "revision": revision_id,
                    "release": release_id,
                    "owner": owner,
                    "generation": generation,
                    "step": step_id,
                },
            )
            if cursor.rowcount != 1:
                connection.rollback()
                raise LeaseLostError("処理Jobのリースが失効しました")
            connection.commit()

    def complete_step(
        self,
        step_id: str,
        stage_run_id: str | None,
        *,
        owner: str,
        generation: int,
        reused: bool = False,
    ) -> None:
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                "SELECT job_id, component_key, object_name FROM sds_pipeline_job_steps "
                "WHERE step_id=:step FOR UPDATE",
                {"step": step_id},
            )
            job_id, component, object_name = cursor.fetchone()
            cursor.execute(
                """
                UPDATE sds_pipeline_job_steps
                SET status=:status, stage_run_id=:run,
                    progress_current=progress_total, completed_at=SYSTIMESTAMP,
                    updated_at=SYSTIMESTAMP
                WHERE step_id=:step AND status='RUNNING'
                  AND lease_generation=:generation
                  AND EXISTS (
                      SELECT 1 FROM sds_pipeline_jobs job
                      WHERE job.job_id=sds_pipeline_job_steps.job_id
                        AND job.lease_owner=:owner
                        AND job.lease_generation=:generation
                        AND job.status='RUNNING'
                  )
                """,
                {
                    "status": "REUSED" if reused else "SUCCEEDED",
                    "run": stage_run_id,
                    "owner": owner,
                    "generation": generation,
                    "step": step_id,
                },
            )
            if cursor.rowcount != 1:
                connection.rollback()
                raise LeaseLostError("処理Jobのリースが失効しました")
            cursor.execute(
                "UPDATE sds_pipeline_jobs SET completed_steps=completed_steps+1, "
                "updated_at=SYSTIMESTAMP WHERE job_id=:job",
                {"job": job_id},
            )
            self._append_event_cursor(
                cursor,
                str(job_id),
                "step_completed",
                {"object_name": object_name, "component_key": component, "reused": reused},
            )
            connection.commit()

    def fail_step(
        self, step_id: str, error: str, *, owner: str, generation: int
    ) -> None:
        message = error[:2000]
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                "SELECT job_id, component_key, object_name FROM sds_pipeline_job_steps "
                "WHERE step_id=:step FOR UPDATE",
                {"step": step_id},
            )
            job_id, component, object_name = cursor.fetchone()
            cursor.execute(
                """
                UPDATE sds_pipeline_job_steps
                SET status='FAILED', error_summary=:error, completed_at=SYSTIMESTAMP,
                    updated_at=SYSTIMESTAMP
                WHERE step_id=:step AND status='RUNNING'
                  AND lease_generation=:generation
                  AND EXISTS (
                      SELECT 1 FROM sds_pipeline_jobs job
                      WHERE job.job_id=sds_pipeline_job_steps.job_id
                        AND job.lease_owner=:owner
                        AND job.lease_generation=:generation
                        AND job.status='RUNNING'
                  )
                """,
                {
                    "error": message,
                    "step": step_id,
                    "owner": owner,
                    "generation": generation,
                },
            )
            if cursor.rowcount != 1:
                connection.rollback()
                raise LeaseLostError("処理Jobのリースが失効しました")
            cursor.execute(
                "UPDATE sds_pipeline_jobs SET failed_steps=failed_steps+1, "
                "updated_at=SYSTIMESTAMP WHERE job_id=:job",
                {"job": job_id},
            )
            self._append_event_cursor(
                cursor,
                str(job_id),
                "step_failed",
                {"object_name": object_name, "component_key": component, "error": message},
            )
            connection.commit()

    def requeue_step(
        self,
        step_id: str,
        error: str,
        *,
        owner: str,
        generation: int,
        attempt: int,
    ) -> None:
        """Return a transiently failed owned step to the durable queue."""
        message = error[:2000]
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                "SELECT job_id, component_key, object_name FROM sds_pipeline_job_steps "
                "WHERE step_id=:step FOR UPDATE",
                {"step": step_id},
            )
            row = cursor.fetchone()
            if not row:
                connection.rollback()
                raise LookupError("処理段階が見つかりません")
            job_id, component, object_name = row
            cursor.execute(
                """
                UPDATE sds_pipeline_job_steps
                SET status='QUEUED', stage_run_id=NULL, error_summary=:error,
                    completed_at=NULL, lease_generation=NULL, updated_at=SYSTIMESTAMP
                WHERE step_id=:step AND status='RUNNING'
                  AND lease_generation=:generation
                  AND EXISTS (
                      SELECT 1 FROM sds_pipeline_jobs job
                      WHERE job.job_id=sds_pipeline_job_steps.job_id
                        AND job.lease_owner=:owner
                        AND job.lease_generation=:generation
                        AND job.status='RUNNING'
                  )
                """,
                {
                    "error": message,
                    "step": step_id,
                    "owner": owner,
                    "generation": generation,
                },
            )
            if cursor.rowcount != 1:
                connection.rollback()
                raise LeaseLostError("処理Jobのリースが失効しました")
            self._append_event_cursor(
                cursor,
                str(job_id),
                "step_retrying",
                {
                    "object_name": object_name,
                    "component_key": component,
                    "attempt": attempt,
                    "error": message,
                },
            )
            connection.commit()

    def finish_job(self, job_id: str, owner: str, generation: int) -> str:
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                "SELECT cancel_requested FROM sds_pipeline_jobs "
                "WHERE job_id=:job AND lease_owner=:owner "
                "AND lease_generation=:generation AND status='RUNNING' FOR UPDATE",
                {"job": job_id, "owner": owner, "generation": generation},
            )
            row = cursor.fetchone()
            if not row:
                connection.rollback()
                raise LeaseLostError("処理Jobのリースが失効しました")
            cancel_requested = row[0]
            cursor.execute(
                """
                SELECT
                    SUM(CASE WHEN status IN ('SUCCEEDED', 'REUSED') THEN 1 ELSE 0 END),
                    SUM(CASE WHEN status IN ('FAILED', 'BLOCKED') THEN 1 ELSE 0 END),
                    COUNT(*)
                FROM sds_pipeline_job_steps WHERE job_id=:job
                """,
                {"job": job_id},
            )
            completed, failed, total = (int(value or 0) for value in cursor.fetchone())
            if cancel_requested:
                status = "CANCELLED"
                cursor.execute(
                    "UPDATE sds_pipeline_job_steps SET status='CANCELLED', completed_at=SYSTIMESTAMP "
                    "WHERE job_id=:job AND status IN ('QUEUED', 'BLOCKED')",
                    {"job": job_id},
                )
            elif failed == 0 and completed >= total:
                status = "SUCCEEDED"
            elif completed > 0:
                status = "PARTIAL_FAILED"
            else:
                status = "FAILED"
            cursor.execute(
                """
                UPDATE sds_pipeline_jobs
                SET status=:status, lease_owner=NULL, lease_until=NULL,
                    completed_steps=:completed, failed_steps=:failed,
                    completed_at=SYSTIMESTAMP, updated_at=SYSTIMESTAMP
                WHERE job_id=:job AND lease_owner=:owner
                  AND lease_generation=:generation
                """,
                {
                    "status": status,
                    "job": job_id,
                    "owner": owner,
                    "generation": generation,
                    "completed": completed,
                    "failed": failed,
                },
            )
            self._append_event_cursor(cursor, job_id, "job_completed", {"status": status})
            connection.commit()
            return status

    def cached_stage_run(self, cache_key: str) -> str | None:
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT stage_run_id FROM sds_stage_runs
                WHERE cache_key=:cache AND status='SUCCEEDED'
                  AND output_hash IS NOT NULL
                ORDER BY completed_at DESC FETCH FIRST 1 ROWS ONLY
                """,
                {"cache": cache_key},
            )
            row = cursor.fetchone()
            return str(row[0]) if row else None

    def start_stage_run(
        self,
        *,
        revision_id: str,
        kind: str,
        component_key: str,
        config_hash: str,
        input_hash: str,
        cache_key: str,
    ) -> str:
        run_id = uuid4().hex
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO sds_stage_runs
                    (stage_run_id, document_revision_id, stage_kind, component_key,
                     config_hash, input_hash, cache_key, status)
                VALUES (:run, :revision, :kind, :component, :config, :input, :cache, 'RUNNING')
                """,
                {
                    "run": run_id,
                    "revision": revision_id,
                    "kind": kind,
                    "component": component_key,
                    "config": config_hash,
                    "input": input_hash,
                    "cache": cache_key,
                },
            )
            connection.commit()
        return run_id

    def complete_stage_run(
        self,
        run_id: str,
        *,
        output_count: int,
        coverage: float,
        metadata: dict[str, Any] | None = None,
        output_hash: str,
    ) -> None:
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE sds_stage_runs
                SET status='SUCCEEDED', output_count=:count, coverage=:coverage,
                    metadata_json=:metadata, output_hash=:output_hash,
                    completed_at=SYSTIMESTAMP
                WHERE stage_run_id=:run
                """,
                {
                    "count": output_count,
                    "coverage": coverage,
                    "metadata": json.dumps(metadata or {}, ensure_ascii=False),
                    "output_hash": output_hash,
                    "run": run_id,
                },
            )
            connection.commit()

    def stage_output_hash(self, run_id: str, kind: str) -> str:
        """Fingerprint immutable stage outputs without hashing vector LOBs."""
        with self.connection() as connection, connection.cursor() as cursor:
            if kind == "EMBED":
                cursor.execute(
                    """
                    SELECT target_artifact_id, input_hash, recipe_revision_id
                    FROM sds_embeddings
                    WHERE stage_run_id=:run
                    ORDER BY target_artifact_id, embedding_id
                    """,
                    {"run": run_id},
                )
            else:
                cursor.execute(
                    """
                    SELECT artifact_kind, source_locator, content_sha256
                    FROM sds_artifacts
                    WHERE stage_run_id=:run
                    ORDER BY artifact_kind, source_locator, artifact_id
                    """,
                    {"run": run_id},
                )
            return stable_hash([list(row) for row in cursor.fetchall()])

    def fail_stage_run(self, run_id: str, error: str) -> None:
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                "UPDATE sds_stage_runs SET status='FAILED', error_summary=:error, "
                "completed_at=SYSTIMESTAMP WHERE stage_run_id=:run",
                {"error": error[:2000], "run": run_id},
            )
            connection.commit()

    def store_artifacts(
        self, run_id: str, revision_id: str, artifacts: Sequence[ArtifactRecord]
    ) -> list[ArtifactRecord]:
        with self.connection() as connection, connection.cursor() as cursor:
            for item in artifacts:
                item.finalize_hash()
                cursor.execute(
                    """
                    INSERT INTO sds_artifacts
                        (artifact_id, stage_run_id, document_revision_id,
                         parent_artifact_id, page_number, artifact_kind, source_locator,
                         bbox_json, raw_text, search_text, object_name, payload_json,
                         metadata_json, content_sha256)
                    VALUES (:id, :run, :revision, :parent, :page, :kind, :locator,
                            :bbox, :raw_text_bind, :search, :object, :payload, :metadata, :hash)
                    """,
                    {
                        "id": item.artifact_id,
                        "run": run_id,
                        "revision": revision_id,
                        "parent": item.parent_artifact_id,
                        "page": item.page_number,
                        "kind": item.artifact_kind,
                        "locator": item.source_locator,
                        "bbox": json.dumps(item.bbox) if item.bbox else None,
                        "raw_text_bind": item.raw_text or None,
                        "search": item.search_text or item.raw_text or None,
                        "object": item.object_name,
                        "payload": json.dumps(item.payload, ensure_ascii=False)
                        if item.payload is not None
                        else None,
                        "metadata": json.dumps(item.metadata, ensure_ascii=False),
                        "hash": item.content_sha256,
                    },
                )
                for parent_id, role, ordinal in item.lineage:
                    cursor.execute(
                        """
                        INSERT INTO sds_artifact_lineage
                            (child_artifact_id, parent_artifact_id, input_role, input_ordinal)
                        VALUES (:child, :parent, :role, :ordinal)
                        """,
                        {
                            "child": item.artifact_id,
                            "parent": parent_id,
                            "role": role,
                            "ordinal": ordinal,
                        },
                    )
            connection.commit()
        return list(artifacts)

    def artifacts_for_run(self, run_id: str, kind: str | None = None) -> list[dict[str, Any]]:
        where = "stage_run_id=:run"
        binds: dict[str, Any] = {"run": run_id}
        if kind:
            where += " AND artifact_kind=:kind"
            binds["kind"] = kind
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                f"""
                SELECT * FROM sds_artifacts WHERE {where}
                ORDER BY page_number, source_locator, artifact_id
                """,
                binds,
            )
            rows = self.rows(cursor)
            for row in rows:
                row["raw_text"] = _lob_text(row.get("raw_text"))
                row["search_text"] = _lob_text(row.get("search_text"))
                row["payload_json"] = _json_value(row.get("payload_json"), None)
                row["metadata_json"] = _json_value(row.get("metadata_json"), {})
            return rows

    def component_artifacts(
        self, release_id: str, component_key: str, kind: str | None = None
    ) -> list[dict[str, Any]]:
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                "SELECT stage_run_id FROM sds_index_release_components "
                "WHERE release_id=:release AND component_key=:component AND is_stale=0",
                {"release": release_id, "component": component_key},
            )
            row = cursor.fetchone()
        return self.artifacts_for_run(str(row[0]), kind) if row else []

    def component_hash(self, release_id: str, component_key: str) -> str:
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT sr.config_hash, sr.input_hash, sr.output_hash
                FROM sds_index_release_components c
                JOIN sds_stage_runs sr ON sr.stage_run_id=c.stage_run_id
                WHERE c.release_id=:release AND c.component_key=:component AND c.is_stale=0
                """,
                {"release": release_id, "component": component_key},
            )
            row = cursor.fetchone()
            # A run ID is intentionally excluded. Identical forced output can
            # reuse downstream caches, while changed output changes this hash.
            return stable_hash(list(row)) if row else ""

    def replace_component(
        self,
        release_id: str,
        component_key: str,
        kind: str,
        run_id: str,
        *,
        job_id: str | None = None,
        owner: str | None = None,
        generation: int | None = None,
    ) -> None:
        # Keep stale propagation data-aware.  In particular, a new render
        # must not invalidate a text-only recipe, and an OCR rerun must not
        # force a pure image embedding to be regenerated.  VLM output is an
        # intermediate input, so render/normalize changes also invalidate
        # recipes that consume any VLM_TEXT artifact.
        downstream = {
            "render": ("normalize", "ocr", "vlm:%"),
            "native_parse": ("normalize", "vlm:%"),
            "mineru_parse": ("normalize", "vlm:%"),
            "ocr": ("normalize", "vlm:%"),
            "normalize": ("vlm:%",),
        }
        recipe_sources: tuple[str, ...] = {
            "render": ("PAGE_IMAGE", "VLM_TEXT"),
            # Parse/OCR output feeds Normalize, which in turn feeds page,
            # chunk, VLM and their embedding recipes. Mark the dependency
            # closure now even when downstream execution was not requested.
            "native_parse": ("NATIVE_TEXT", "PAGE_TEXT", "CHUNK_TEXT", "VLM_TEXT"),
            "mineru_parse": ("MINERU_TEXT", "PAGE_TEXT", "CHUNK_TEXT", "VLM_TEXT"),
            "ocr": ("OCR_TEXT", "PAGE_TEXT", "CHUNK_TEXT", "VLM_TEXT"),
            "normalize": ("PAGE_TEXT", "CHUNK_TEXT", "VLM_TEXT"),
        }.get(component_key, ())
        source_ref: str | None = None
        if component_key.startswith("vlm:"):
            recipe_sources = ("VLM_TEXT",)
            source_ref = component_key.split(":", 1)[1]
        with self.connection() as connection, connection.cursor() as cursor:
            if job_id is not None:
                cursor.execute(
                    """
                    SELECT job_id FROM sds_pipeline_jobs
                    WHERE job_id=:job AND lease_owner=:owner
                      AND lease_generation=:generation AND status='RUNNING'
                    FOR UPDATE
                    """,
                    {"job": job_id, "owner": owner, "generation": generation},
                )
                if not cursor.fetchone():
                    connection.rollback()
                    raise LeaseLostError("処理Jobのリースが失効しました")
            cursor.execute(
                "SELECT status FROM sds_index_releases WHERE release_id=:release FOR UPDATE",
                {"release": release_id},
            )
            release_row = cursor.fetchone()
            if not release_row:
                raise LookupError("Releaseが見つかりません")
            if str(release_row[0]) != "DRAFT":
                raise ValueError("公開済みReleaseは変更できません")
            # Re-attaching an already selected stage run (the cache-hit path)
            # is idempotent and must not make its downstream artifacts stale.
            # Only a genuinely different run represents changed semantics.
            cursor.execute(
                """
                SELECT stage_run_id FROM sds_index_release_components
                WHERE release_id=:release AND component_key=:component
                FOR UPDATE
                """,
                {"release": release_id, "component": component_key},
            )
            existing_component = cursor.fetchone()
            semantic_change = not existing_component or str(existing_component[0]) != run_id
            cursor.execute(
                """
                MERGE INTO sds_index_release_components c
                USING (SELECT :release release_id, :component component_key FROM dual) s
                ON (c.release_id=s.release_id AND c.component_key=s.component_key)
                WHEN MATCHED THEN UPDATE SET c.stage_kind=:kind, c.stage_run_id=:run,
                                             c.is_stale=0, c.stale_reason=NULL
                WHEN NOT MATCHED THEN INSERT
                    (release_id, component_key, stage_kind, stage_run_id, is_stale)
                    VALUES (:release, :component, :kind, :run, 0)
                """,
                {
                    "release": release_id,
                    "component": component_key,
                    "kind": kind,
                    "run": run_id,
                },
            )
            if semantic_change:
                for pattern in downstream.get(component_key, ()):
                    operator = "LIKE" if "%" in pattern else "="
                    cursor.execute(
                        f"""
                        UPDATE sds_index_release_components
                        SET is_stale=1, stale_reason=:reason
                        WHERE release_id=:release AND component_key {operator} :pattern
                          AND component_key<>:component
                        """,
                        {
                            "reason": f"上流段階 {component_key} が更新されました",
                            "release": release_id,
                            "pattern": pattern,
                            "component": component_key,
                        },
                    )
            if semantic_change and recipe_sources:
                source_binds = {
                    f"source_{index}": source
                    for index, source in enumerate(recipe_sources)
                }
                source_placeholders = ", ".join(f":source_{index}" for index in range(len(recipe_sources)))
                ref_predicate = ""
                if source_ref is not None:
                    ref_predicate = " AND i.source_ref=:source_ref"
                    source_binds["source_ref"] = source_ref
                cursor.execute(
                    f"""
                    UPDATE sds_index_release_components c
                    SET is_stale=1, stale_reason=:reason
                    WHERE c.release_id=:release
                      AND c.component_key LIKE 'embedding:%'
                      AND c.component_key<>:component
                      AND EXISTS (
                          SELECT 1
                          FROM sds_embedding_recipes r
                          JOIN sds_embedding_recipe_inputs i
                            ON i.revision_id=r.current_revision_id
                          WHERE r.code=SUBSTR(c.component_key, 11)
                            AND i.source_type IN ({source_placeholders})
                            {ref_predicate}
                      )
                    """,
                    {
                        "reason": f"上流段階 {component_key} が更新されました",
                        "release": release_id,
                        "component": component_key,
                        **source_binds,
                    },
                )
            connection.commit()

    def store_embeddings(
        self,
        *,
        run_id: str,
        revision_id: str,
        recipe_revision_id: str,
        values: Sequence[tuple[str, str, Sequence[float], Sequence[tuple[str, str, int]]]],
    ) -> None:
        with self.connection() as connection, connection.cursor() as cursor:
            for target_artifact_id, input_hash, vector, inputs in values:
                if len(vector) != 1536:
                    raise ValueError(f"Embeddingの次元数が不正です: {len(vector)}")
                embedding_id = uuid4().hex
                cursor.execute(
                    """
                    INSERT INTO sds_embeddings
                        (embedding_id, stage_run_id, document_revision_id,
                         recipe_revision_id, target_artifact_id, input_hash, vector_value)
                    VALUES (:id, :run, :revision, :recipe, :target, :hash, :vector)
                    """,
                    {
                        "id": embedding_id,
                        "run": run_id,
                        "revision": revision_id,
                        "recipe": recipe_revision_id,
                        "target": target_artifact_id,
                        "hash": input_hash,
                        "vector": array("f", vector),
                    },
                )
                for artifact_id, role, ordinal in inputs:
                    cursor.execute(
                        """
                        INSERT INTO sds_embedding_inputs
                            (embedding_id, artifact_id, input_role, input_ordinal)
                        VALUES (:embedding, :artifact, :role, :ordinal)
                        """,
                        {
                            "embedding": embedding_id,
                            "artifact": artifact_id,
                            "role": role,
                            "ordinal": ordinal,
                        },
                    )
            connection.commit()

    def validate_release(
        self,
        release_id: str,
        *,
        require_current_config: bool = True,
        job_id: str | None = None,
        owner: str | None = None,
        generation: int | None = None,
    ) -> dict[str, Any]:
        with self.connection() as connection, connection.cursor() as cursor:
            if job_id is not None:
                cursor.execute(
                    """
                    SELECT job_id FROM sds_pipeline_jobs
                    WHERE job_id=:job AND lease_owner=:owner
                      AND lease_generation=:generation AND status='RUNNING'
                    FOR UPDATE
                    """,
                    {"job": job_id, "owner": owner, "generation": generation},
                )
                if not cursor.fetchone():
                    connection.rollback()
                    raise LeaseLostError("処理Jobのリースが失効しました")
            cursor.execute(
                """
                SELECT r.document_id, r.document_revision_id, d.current_revision_id, r.status
                FROM sds_index_releases r JOIN sds_documents d ON d.document_id=r.document_id
                WHERE r.release_id=:release FOR UPDATE
                """,
                {"release": release_id},
            )
            row = cursor.fetchone()
            if not row:
                raise LookupError("Releaseが見つかりません")
            if str(row[1]) != str(row[2]):
                raise ValueError("現在の文書Revisionと異なるReleaseは公開できません")
            cursor.execute(
                """
                SELECT c.component_key, c.is_stale, c.stale_reason,
                       sr.document_revision_id, c.stage_run_id, sr.status,
                       c.stage_kind, sr.config_hash, sr.output_hash
                FROM sds_index_release_components c
                JOIN sds_stage_runs sr ON sr.stage_run_id=c.stage_run_id
                WHERE c.release_id=:release
                """,
                {"release": release_id},
            )
            component_rows = cursor.fetchall()
            components = {
                str(item[0]): (bool(item[1]), str(item[2] or ""))
                for item in component_rows
            }
            # Enabled parsers are part of the serving contract.  A release built
            # without an enabled upstream stage would otherwise look complete and
            # could publish a stale OCR/MinerU combination.
            if require_current_config:
                required = self._current_required_components(cursor)
            else:
                required = set(components)
            missing = sorted(required - set(components))
            stale = {
                key: reason
                for key, (flag, reason) in components.items()
                if flag and key in required
            }
            invalid_stage_runs = sorted(
                str(item[0])
                for item in component_rows
                if str(item[0]) in required
                and (str(item[5]) != "SUCCEEDED" or not item[8])
            )
            cross_revision = sorted(
                str(item[0])
                for item in component_rows
                if str(item[0]) in required and str(item[3]) != str(row[1])
            )
            config_mismatches: list[str] = []
            if require_current_config:
                from app.rag.pipeline_config import stage_config_hash

                for item in component_rows:
                    component = str(item[0])
                    if component not in required:
                        continue
                    try:
                        expected_hash = stage_config_hash(str(item[6]), component)
                    except (LookupError, ValueError):
                        expected_hash = ""
                    if str(item[7]) != expected_hash:
                        config_mismatches.append(component)
            invalid_embeddings: list[str] = []
            for component in sorted(
                item for item in required if item.startswith("embedding:")
            ):
                cursor.execute(
                    """
                    SELECT e.embedding_id, e.input_hash, ri.source_type,
                           NVL(ri.source_ref, ''), a.content_sha256,
                           e.document_revision_id, a.document_revision_id,
                           e.recipe_revision_id
                    FROM sds_index_release_components c
                    JOIN sds_embeddings e ON e.stage_run_id=c.stage_run_id
                    JOIN sds_embedding_inputs ei ON ei.embedding_id=e.embedding_id
                    JOIN sds_embedding_recipe_inputs ri
                      ON ri.revision_id=e.recipe_revision_id
                         AND ri.input_ordinal=ei.input_ordinal
                    JOIN sds_artifacts a ON a.artifact_id=ei.artifact_id
                    WHERE c.release_id=:release AND c.component_key=:component
                    ORDER BY e.embedding_id, ei.input_ordinal
                    """,
                    {"release": release_id, "component": component},
                )
                grouped: dict[str, dict[str, Any]] = {}
                for embedding_row in cursor.fetchall():
                    item = grouped.setdefault(
                        str(embedding_row[0]),
                        {
                            "stored": str(embedding_row[1]),
                            "inputs": [],
                            "revisions": set(),
                            "recipe_revisions": set(),
                        },
                    )
                    item["inputs"].append(
                        embedding_input_fingerprint(
                            embedding_row[2],
                            embedding_row[3],
                            embedding_row[4],
                        )
                    )
                    item["revisions"].update(
                        (str(embedding_row[5]), str(embedding_row[6]))
                    )
                    item["recipe_revisions"].update(
                        (str(embedding_row[7]),)
                    )
                for embedding_id, item in grouped.items():
                    if (
                        item["stored"] != stable_hash(item["inputs"])
                        or item["revisions"] != {str(row[1])}
                        or len(item["recipe_revisions"]) != 1
                    ):
                        invalid_embeddings.append(embedding_id)
            validation = {
                "valid": (
                    not missing
                    and not stale
                    and not invalid_stage_runs
                    and not cross_revision
                    and not config_mismatches
                    and not invalid_embeddings
                ),
                "required_components": sorted(required),
                "missing_components": missing,
                "stale_components": stale,
                "invalid_stage_runs": invalid_stage_runs,
                "cross_revision_components": cross_revision,
                "config_mismatch_components": sorted(config_mismatches),
                "invalid_embeddings": invalid_embeddings,
                "document_revision_id": str(row[1]),
                # Used by publish_release to detect a component replacement
                # between validation and the pointer transaction.
                "component_run_ids": {
                    str(item[0]): str(item[4]) for item in component_rows
                },
            }
            next_status = str(row[3])
            if next_status in {"DRAFT", "READY"}:
                next_status = "READY" if validation["valid"] else "DRAFT"
            cursor.execute(
                "UPDATE sds_index_releases SET status=:status, validation_json=:validation, "
                "ready_at=CASE WHEN :status='READY' THEN SYSTIMESTAMP ELSE ready_at END "
                "WHERE release_id=:release",
                {
                    "status": next_status,
                    "validation": json.dumps(validation, ensure_ascii=False),
                    "release": release_id,
                },
            )
            connection.commit()
            return validation

    def publish_release(
        self,
        document_id: str,
        release_id: str,
        *,
        job_id: str | None = None,
        owner: str | None = None,
        generation: int | None = None,
    ) -> dict[str, Any]:
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT r.status, d.serving_release_id
                FROM sds_index_releases r
                JOIN sds_documents d ON d.document_id=r.document_id
                WHERE r.release_id=:release AND r.document_id=:document
                """,
                {"release": release_id, "document": document_id},
            )
            initial = cursor.fetchone()
            if not initial:
                raise LookupError("Releaseが見つかりません")
            initial_status = str(initial[0])
            if initial_status == "PUBLISHED" and str(initial[1]) == release_id:
                return {
                    "document_id": document_id,
                    "release_id": release_id,
                    "previous_release_id": release_id,
                }
        require_current_config = initial_status in {"DRAFT", "READY"}
        validation = self.validate_release(
            release_id,
            require_current_config=require_current_config,
            job_id=job_id,
            owner=owner,
            generation=generation,
        )
        if not validation["valid"]:
            raise ValueError(release_validation_error_message(validation))
        with self.connection() as connection, connection.cursor() as cursor:
            if job_id is not None:
                cursor.execute(
                    """
                    SELECT job_id FROM sds_pipeline_jobs
                    WHERE job_id=:job AND lease_owner=:owner
                      AND lease_generation=:generation AND status='RUNNING'
                    FOR UPDATE
                    """,
                    {"job": job_id, "owner": owner, "generation": generation},
                )
                if not cursor.fetchone():
                    connection.rollback()
                    raise LeaseLostError("処理Jobのリースが失効しました")
            cursor.execute(
                "SELECT serving_release_id, current_revision_id FROM sds_documents "
                "WHERE document_id=:document FOR UPDATE",
                {"document": document_id},
            )
            row = cursor.fetchone()
            if not row:
                raise LookupError("文書が見つかりません")
            previous = str(row[0]) if row[0] else None
            cursor.execute(
                "SELECT document_id, document_revision_id, status FROM sds_index_releases "
                "WHERE release_id=:release FOR UPDATE",
                {"release": release_id},
            )
            release = cursor.fetchone()
            if not release or str(release[0]) != document_id:
                raise ValueError("指定した文書のReleaseではありません")
            allowed_statuses = (
                {"READY"} if require_current_config else {"SUPERSEDED", "PUBLISHED"}
            )
            if str(release[1]) != str(row[1]) or str(release[2]) not in allowed_statuses:
                raise ValueError("公開可能なReleaseではありません")
            # ``validate_release`` runs before this transaction can acquire
            # the document/release locks.  Compare the locked component set
            # with the validated snapshot so a concurrent stage replacement
            # can never be published accidentally; callers can simply retry.
            cursor.execute(
                """
                SELECT component_key, stage_run_id, is_stale
                FROM sds_index_release_components
                WHERE release_id=:release
                FOR UPDATE
                """,
                {"release": release_id},
            )
            locked_components = cursor.fetchall()
            locked_run_ids = {
                str(item[0]): str(item[1]) for item in locked_components
            }
            if locked_run_ids != validation.get("component_run_ids", {}):
                raise ValueError("検証後にReleaseの構成が更新されました。再検証してください")
            required_components = set(validation["required_components"])
            if any(
                bool(item[2]) and str(item[0]) in required_components
                for item in locked_components
            ):
                raise ValueError("Releaseに更新が必要なコンポーネントがあります")
            if require_current_config:
                self._prune_inactive_release_components(
                    cursor, release_id, required_components
                )
            if previous and previous != release_id:
                cursor.execute(
                    "UPDATE sds_index_releases SET status='SUPERSEDED' WHERE release_id=:release",
                    {"release": previous},
                )
            cursor.execute(
                "UPDATE sds_index_releases SET status='PUBLISHED', published_at=SYSTIMESTAMP "
                "WHERE release_id=:release",
                {"release": release_id},
            )
            cursor.execute(
                """
                UPDATE sds_documents
                SET serving_release_id=:release, draft_release_id=NULL,
                    status='INDEXED', updated_at=SYSTIMESTAMP
                WHERE document_id=:document
                """,
                {"release": release_id, "document": document_id},
            )
            connection.commit()
            return {"document_id": document_id, "release_id": release_id, "previous_release_id": previous}

    @staticmethod
    def _page_image_summary_for_release(
        cursor: Any, release_id: str | None
    ) -> dict[str, Any] | None:
        if not release_id:
            return None
        cursor.execute(
            """
            SELECT r.release_id, r.status, r.document_revision_id,
                   c.is_stale, sr.status, COUNT(a.artifact_id)
            FROM sds_index_releases r
            LEFT JOIN sds_index_release_components c
              ON c.release_id=r.release_id AND c.component_key='render'
            LEFT JOIN sds_stage_runs sr ON sr.stage_run_id=c.stage_run_id
            LEFT JOIN sds_artifacts a
              ON a.stage_run_id=c.stage_run_id AND a.artifact_kind='PAGE_IMAGE'
            WHERE r.release_id=:release
            GROUP BY r.release_id, r.status, r.document_revision_id,
                     c.is_stale, sr.status
            """,
            {"release": release_id},
        )
        row = cursor.fetchone()
        if not row:
            return None
        stage_status = (
            "NOT_RUN" if row[4] is None else "STALE" if bool(row[3]) else str(row[4])
        )
        return {
            "release_id": str(row[0]),
            "release_status": str(row[1]),
            "revision_id": str(row[2]),
            "count": int(row[5] or 0),
            "stage_status": stage_status,
        }

    def page_image_versions(
        self, document_id: str, selector: str = "latest"
    ) -> dict[str, Any]:
        if selector not in {"latest", "draft", "serving"}:
            raise ValueError("ページ画像のRelease指定が不正です")
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT serving_release_id, draft_release_id
                FROM sds_documents WHERE document_id=:document
                """,
                {"document": document_id},
            )
            row = cursor.fetchone()
            if not row:
                raise LookupError("文書が見つかりません")
            serving = self._page_image_summary_for_release(cursor, row[0])
            draft = self._page_image_summary_for_release(cursor, row[1])
            if selector == "latest":
                selected = draft or serving
            elif selector == "draft":
                selected = draft
            else:
                selected = serving
            return {
                "selector": selector,
                "selected": selected,
                "draft": draft,
                "serving": serving,
            }

    def list_page_texts(
        self,
        document_id: str,
        *,
        selector: str = "latest",
        page_number: int,
    ) -> dict[str, Any]:
        """指定ページの前処理・解析／VLMテキスト成果物を版指定で返す。"""
        versions = self.page_image_versions(document_id, selector)
        selected = versions["selected"]
        if not selected:
            raise LookupError("指定した版の処理結果はありません")
        release_id = selected["release_id"]
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT c.component_key, a.artifact_kind, a.page_number,
                       a.raw_text, a.payload_json, a.created_at,
                       c.is_stale, sr.status
                FROM sds_index_release_components c
                JOIN sds_stage_runs sr ON sr.stage_run_id=c.stage_run_id
                JOIN sds_artifacts a ON a.stage_run_id=c.stage_run_id
                WHERE c.release_id=:release AND a.page_number=:page_number
                  AND a.artifact_kind IN
                      ('NATIVE_TEXT','MINERU_TEXT','OCR_TEXT','PAGE_TEXT','VLM_TEXT')
                ORDER BY c.component_key, a.artifact_id
                """,
                {"release": release_id, "page_number": page_number},
            )
            items = [
                {
                    "component_key": str(component_key),
                    "artifact_kind": str(kind),
                    "page_number": int(page_no),
                    "raw_text": _lob_text(raw_text) or "",
                    "payload_json": _json_value(payload, None),
                    "created_at": created_at,
                    "stage_status": "STALE" if bool(stale) else str(run_status),
                }
                for (
                    component_key,
                    kind,
                    page_no,
                    raw_text,
                    payload,
                    created_at,
                    stale,
                    run_status,
                ) in cursor.fetchall()
            ]
        return {
            "document_id": document_id,
            "selector": selector,
            "release_id": release_id,
            "release_status": selected["release_status"],
            "page_number": page_number,
            "items": items,
        }

    def list_page_images(
        self,
        document_id: str,
        *,
        selector: str = "latest",
        page: int = 1,
        page_size: int = 50,
    ) -> dict[str, Any]:
        versions = self.page_image_versions(document_id, selector)
        selected = versions["selected"]
        if not selected:
            raise LookupError("指定した版のページ画像はありません")
        release_id = selected["release_id"]
        offset = (page - 1) * page_size
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                "SELECT object_name FROM sds_documents WHERE document_id=:document",
                {"document": document_id},
            )
            document_row = cursor.fetchone()
            if not document_row:
                raise LookupError("文書が見つかりません")
            cursor.execute(
                """
                SELECT COUNT(*)
                FROM sds_index_release_components c
                JOIN sds_artifacts a ON a.stage_run_id=c.stage_run_id
                WHERE c.release_id=:release AND c.component_key='render'
                  AND a.artifact_kind='PAGE_IMAGE'
                """,
                {"release": release_id},
            )
            total = int(cursor.fetchone()[0] or 0)
            cursor.execute(
                """
                SELECT a.artifact_id, a.page_number, a.content_sha256,
                       a.created_at, a.metadata_json, c.is_stale, sr.status
                FROM sds_index_release_components c
                JOIN sds_stage_runs sr ON sr.stage_run_id=c.stage_run_id
                JOIN sds_artifacts a ON a.stage_run_id=c.stage_run_id
                WHERE c.release_id=:release AND c.component_key='render'
                  AND a.artifact_kind='PAGE_IMAGE'
                ORDER BY a.page_number, a.artifact_id
                OFFSET :offset ROWS FETCH NEXT :limit ROWS ONLY
                """,
                {"release": release_id, "offset": offset, "limit": page_size},
            )
            items = []
            for (
                artifact_id,
                page_number,
                digest,
                created_at,
                metadata,
                stale,
                run_status,
            ) in cursor.fetchall():
                metadata_value = _json_value(metadata, {})
                items.append(
                    {
                        "artifact_id": str(artifact_id),
                        "page_number": int(page_number),
                        "media_type": str(metadata_value.get("media_type") or "image/png"),
                        "size": (
                            int(metadata_value["size"])
                            if metadata_value.get("size") is not None
                            else None
                        ),
                        "content_sha256": str(digest),
                        "created_at": created_at,
                        "stage_status": "STALE" if bool(stale) else str(run_status),
                    }
                )
        total_pages = max(1, (total + page_size - 1) // page_size)
        return {
            "document_id": document_id,
            "object_name": str(document_row[0]),
            "revision_id": selected["revision_id"],
            "release_id": release_id,
            "release_status": selected["release_status"],
            "stage_status": selected["stage_status"],
            "total": total,
            "items": items,
            "pagination": {
                "current_page": page,
                "page_size": page_size,
                "total": total,
                "total_pages": total_pages,
                "has_next": page < total_pages,
                "has_prev": page > 1,
            },
        }

    def get_page_image_artifact(
        self, document_id: str, release_id: str, artifact_id: str
    ) -> dict[str, Any]:
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT a.artifact_id, a.object_name, a.content_sha256,
                       a.page_number, a.metadata_json
                FROM sds_index_releases r
                JOIN sds_index_release_components c
                  ON c.release_id=r.release_id AND c.component_key='render'
                JOIN sds_artifacts a ON a.stage_run_id=c.stage_run_id
                WHERE r.document_id=:document AND r.release_id=:release
                  AND a.artifact_id=:artifact AND a.artifact_kind='PAGE_IMAGE'
                  AND a.document_revision_id=r.document_revision_id
                """,
                {
                    "document": document_id,
                    "release": release_id,
                    "artifact": artifact_id,
                },
            )
            row = cursor.fetchone()
            if not row:
                raise LookupError("ページ画像が見つかりません")
            if not row[1]:
                raise LookupError("ページ画像の保存先がありません")
            metadata = _json_value(row[4], {})
            return {
                "artifact_id": str(row[0]),
                "object_name": str(row[1]),
                "content_sha256": str(row[2]),
                "page_number": int(row[3]),
                "media_type": str(metadata.get("media_type") or "image/png"),
            }

    def referenced_page_image_object_names(self) -> set[str]:
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT DISTINCT object_name FROM sds_artifacts
                WHERE artifact_kind='PAGE_IMAGE' AND object_name IS NOT NULL
                """
            )
            return {str(row[0]) for row in cursor.fetchall()}

    def processing_status(
        self, document_id: str, page_image_selector: str = "latest"
    ) -> dict[str, Any]:
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT document_id, object_name, status, current_revision_id,
                       serving_release_id, draft_release_id
                FROM sds_documents WHERE document_id=:document
                """,
                {"document": document_id},
            )
            row = cursor.fetchone()
            if not row:
                raise LookupError("文書が見つかりません")
            stages: dict[str, str] = {}
            stale_reasons: dict[str, str] = {}
            # Draft があればその処理状態を優先し、なければ現在の公開版を
            # 表示する。公開済み文書を「未実行」と誤表示しないため、Serving
            # Release のコンポーネントも同じ経路で集約する。
            stage_release_id = row[5] or row[4]
            if stage_release_id:
                active_components = self._current_required_components(cursor)
                cursor.execute(
                    """
                    SELECT c.component_key, c.is_stale, c.stale_reason, sr.status
                    FROM sds_index_release_components c
                    JOIN sds_stage_runs sr ON sr.stage_run_id=c.stage_run_id
                    WHERE c.release_id=:release
                    """,
                    {"release": stage_release_id},
                )
                for component, is_stale, reason, run_status in cursor.fetchall():
                    if str(component) not in active_components:
                        continue
                    stages[str(component)] = "STALE" if is_stale else str(run_status)
                    if is_stale:
                        stale_reasons[str(component)] = str(
                            reason or "上流入力が更新されました"
                        )
            publication = (
                "PUBLISHED" if row[4] and not row[5]
                else "UPDATE_AVAILABLE" if row[4] and row[5]
                else "ERROR" if str(row[2]) == "FAILED"
                else "UNPUBLISHED"
            )
            result = {
                "document_id": str(row[0]),
                "object_name": str(row[1]),
                "document_status": str(row[2]),
                "current_revision_id": str(row[3]) if row[3] else None,
                "serving_release_id": str(row[4]) if row[4] else None,
                "draft_release_id": str(row[5]) if row[5] else None,
                "publication_status": publication,
                "stages": stages,
                "stale_reasons": stale_reasons,
            }
        result["page_images"] = self.page_image_versions(
            document_id, page_image_selector
        )
        return result

    def statuses_by_object(
        self, object_names: Sequence[str], page_image_selector: str = "latest"
    ) -> dict[str, dict[str, Any]]:
        if page_image_selector not in {"latest", "draft", "serving"}:
            raise ValueError("ページ画像のRelease指定が不正です")
        if not object_names:
            return {}
        unique_names = list(dict.fromkeys(str(name) for name in object_names))
        object_binds = {
            f"object_{index}": name for index, name in enumerate(unique_names)
        }
        object_placeholders = ", ".join(f":{key}" for key in object_binds)

        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                f"""
                SELECT document_id, object_name, status, current_revision_id,
                       serving_release_id, draft_release_id
                FROM sds_documents
                WHERE object_name IN ({object_placeholders})
                """,
                object_binds,
            )
            document_rows = cursor.fetchall()
            release_ids = list(
                dict.fromkeys(
                    str(release_id)
                    for row in document_rows
                    for release_id in (row[4], row[5])
                    if release_id
                )
            )
            components: dict[str, list[tuple[Any, ...]]] = {}
            page_summaries: dict[str, dict[str, Any]] = {}
            active_components: set[str] = set()
            if release_ids:
                active_components = self._current_required_components(cursor)
                release_binds = {
                    f"release_{index}": release_id
                    for index, release_id in enumerate(release_ids)
                }
                release_placeholders = ", ".join(
                    f":{key}" for key in release_binds
                )
                cursor.execute(
                    f"""
                    SELECT c.release_id, c.component_key, c.is_stale,
                           c.stale_reason, sr.status
                    FROM sds_index_release_components c
                    JOIN sds_stage_runs sr ON sr.stage_run_id=c.stage_run_id
                    WHERE c.release_id IN ({release_placeholders})
                    """,
                    release_binds,
                )
                for component_row in cursor.fetchall():
                    components.setdefault(str(component_row[0]), []).append(
                        component_row[1:]
                    )
                cursor.execute(
                    f"""
                    SELECT r.release_id, r.status, r.document_revision_id,
                           c.is_stale, sr.status, COUNT(a.artifact_id)
                    FROM sds_index_releases r
                    LEFT JOIN sds_index_release_components c
                      ON c.release_id=r.release_id AND c.component_key='render'
                    LEFT JOIN sds_stage_runs sr ON sr.stage_run_id=c.stage_run_id
                    LEFT JOIN sds_artifacts a
                      ON a.stage_run_id=c.stage_run_id
                     AND a.artifact_kind='PAGE_IMAGE'
                    WHERE r.release_id IN ({release_placeholders})
                    GROUP BY r.release_id, r.status, r.document_revision_id,
                             c.is_stale, sr.status
                    """,
                    release_binds,
                )
                for summary_row in cursor.fetchall():
                    stage_status = (
                        "NOT_RUN"
                        if summary_row[4] is None
                        else "STALE"
                        if bool(summary_row[3])
                        else str(summary_row[4])
                    )
                    page_summaries[str(summary_row[0])] = {
                        "release_id": str(summary_row[0]),
                        "release_status": str(summary_row[1]),
                        "revision_id": str(summary_row[2]),
                        "count": int(summary_row[5] or 0),
                        "stage_status": stage_status,
                    }

        result: dict[str, dict[str, Any]] = {}
        for row in document_rows:
            serving_release_id = str(row[4]) if row[4] else None
            draft_release_id = str(row[5]) if row[5] else None
            stage_release_id = draft_release_id or serving_release_id
            stages: dict[str, str] = {}
            stale_reasons: dict[str, str] = {}
            for component, is_stale, reason, run_status in components.get(
                stage_release_id or "", []
            ):
                if str(component) not in active_components:
                    continue
                stages[str(component)] = "STALE" if is_stale else str(run_status)
                if is_stale:
                    stale_reasons[str(component)] = str(
                        reason or "上流入力が更新されました"
                    )
            serving = page_summaries.get(serving_release_id or "")
            draft = page_summaries.get(draft_release_id or "")
            selected = (
                draft or serving
                if page_image_selector == "latest"
                else draft
                if page_image_selector == "draft"
                else serving
            )
            publication = (
                "PUBLISHED"
                if serving_release_id and not draft_release_id
                else "UPDATE_AVAILABLE"
                if serving_release_id and draft_release_id
                else "ERROR"
                if str(row[2]) == "FAILED"
                else "UNPUBLISHED"
            )
            result[str(row[1])] = {
                "document_id": str(row[0]),
                "object_name": str(row[1]),
                "document_status": str(row[2]),
                "current_revision_id": str(row[3]) if row[3] else None,
                "serving_release_id": serving_release_id,
                "draft_release_id": draft_release_id,
                "publication_status": publication,
                "stages": stages,
                "stale_reasons": stale_reasons,
                "page_images": {
                    "selector": page_image_selector,
                    "selected": selected,
                    "draft": draft,
                    "serving": serving,
                },
            }
        return result


pipeline_repository = OraclePipelineRepository()
