from __future__ import annotations

import hashlib
import json
import os
import re
from array import array
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Iterator
from uuid import uuid4

from app.rag.models import ProfileConfig, VlmExtractionOutput
from app.services.database_service import database_service

TOKEN_PATTERN = re.compile(r"[0-9A-Za-z_.-]+|[ぁ-んァ-ン一-龯々ー]+")
ASCII_TOKEN_PATTERN = re.compile(r"[0-9A-Za-z_.-]+")
KANJI_RUN_PATTERN = re.compile(r"[一-龯々]+")
KATAKANA_RUN_PATTERN = re.compile(r"[ァ-ンー]+")
HIRAGANA_RUN_PATTERN = re.compile(r"[ぁ-んー]+")
ORACLE_TEXT_DEFAULT_MAX_TERMS = 20


def _lob_text(value: object) -> str:
    return str(value.read()) if hasattr(value, "read") else str(value or "")


def _json_col(value: object, default: Any):
    """`IS JSON` 制約付きCLOMを安全にデコード。

    python-oracledbは `IS JSON` 列を dict/list に自動デコードして返すことがあり、
    その場合 str() すると単一引用符のPython reprになって json.loads が失敗する。
    dict/list はそのまま、LOB/str のみ json.loads する。
    """
    if value is None:
        return default
    if isinstance(value, (dict, list)):
        return value
    if hasattr(value, "read"):
        value = value.read()
    if isinstance(value, (bytes, bytearray)):
        value = value.decode("utf-8")
    text = str(value).strip()
    return json.loads(text) if text else default


def _vector(value: list[float] | None) -> array | None:
    return array("f", value) if value is not None else None


def oracle_text_max_terms() -> int:
    try:
        return max(1, int(os.environ.get("ORACLE_TEXT_MAX_TERMS", ORACLE_TEXT_DEFAULT_MAX_TERMS)))
    except ValueError:
        return ORACLE_TEXT_DEFAULT_MAX_TERMS


def oracle_text_terms(query: str, *, max_terms: int | None = None) -> list[str]:
    limit = max_terms or oracle_text_max_terms()
    terms: list[str] = []
    for match in TOKEN_PATTERN.finditer(query):
        raw = match.group(0).strip()
        candidates: list[str] = []
        if ASCII_TOKEN_PATTERN.fullmatch(raw):
            candidates = [raw.casefold()]
        else:
            for pattern in (KANJI_RUN_PATTERN, KATAKANA_RUN_PATTERN, HIRAGANA_RUN_PATTERN):
                for run in pattern.findall(raw.casefold()):
                    if len(run) >= 2:
                        candidates.append(run)
        for term in candidates:
            if len(term) >= 2 and term not in terms:
                terms.append(term)
        if len(terms) >= limit:
            break
    return terms[:limit]


def oracle_text_query(query: str) -> str | None:
    terms = oracle_text_terms(query)
    return " ACCUM ".join(f"{{{term}}}" for term in terms) if terms else None


@dataclass
class EvidenceRecord:
    evidence_id: str
    document_id: str
    page_number: int | None
    unit_kind: str
    source_locator: str
    raw_text: str = ""
    search_text: str = ""
    asset_object_name: str | None = None
    bbox: list[float] | None = None
    provenance: dict[str, Any] = field(default_factory=dict)
    text_embedding: list[float] | None = None
    visual_embedding: list[float] | None = None
    parent_evidence_id: str | None = None


@dataclass
class VlmFacetRecord:
    evidence_id: str
    output: VlmExtractionOutput
    text_embedding: list[float] | None = None


@dataclass(frozen=True)
class DocumentUpsertResult:
    document_id: str
    content_changed: bool
    content_sha256: str
    document_type: str | None = None


@dataclass
class RetrievalHit:
    evidence_id: str
    document_id: str
    slot_no: int
    revision_id: str
    page_number: int | None
    unit_kind: str
    source_locator: str
    bbox: list[float] | None
    raw_text: str
    caption: str
    asset_object_name: str | None
    file_name: str
    object_name: str
    bucket: str
    score: float
    channel: str
    fields: dict[str, Any] = field(default_factory=dict)
    relations: list[str] = field(default_factory=list)

    @property
    def canonical_key(self) -> str:
        bbox = json.dumps(self.bbox or [], separators=(",", ":"))
        return f"{self.document_id}:{self.page_number}:{self.source_locator}:{bbox}"


class OracleRagRepository:
    @contextmanager
    def connection(self) -> Iterator[Any]:
        if not database_service._ensure_pool_initialized():
            raise RuntimeError("database connection is not configured")
        with database_service.pool_manager.acquire_connection() as connection:
            yield connection

    @staticmethod
    def rows(cursor: Any) -> list[dict[str, Any]]:
        columns = [item[0].lower() for item in cursor.description or []]
        return [dict(zip(columns, row)) for row in cursor.fetchall()]

    @staticmethod
    def _text_query(query: str) -> str | None:
        return oracle_text_query(query)

    @staticmethod
    def _access_sql(user_hash: str | None) -> tuple[str, dict[str, Any]]:
        return (
            """
            EXISTS (
                SELECT 1 FROM sds_document_acl acl
                WHERE acl.document_id=d.document_id
                  AND (
                    (:user_hash IS NOT NULL AND acl.principal_type='public_authenticated')
                    OR (:user_hash IS NOT NULL AND acl.principal_type IN ('user', 'service')
                        AND acl.principal_hash=:user_hash)
                  )
            )
            """,
            {"user_hash": user_hash},
        )

    def _document_where(
        self,
        *,
        user_hash: str | None,
        current_version_only: bool,
        document_types: list[str],
        filename_filter: str | None,
    ) -> tuple[str, dict[str, Any]]:
        access, binds = self._access_sql(user_hash)
        clauses = ["d.serving_release_id IS NOT NULL", access]
        if current_version_only:
            clauses.append("d.is_current=1")
        if document_types:
            placeholders: list[str] = []
            for index, value in enumerate(document_types):
                key = f"document_type_{index}"
                placeholders.append(f":{key}")
                binds[key] = value.casefold()
            clauses.append(f"LOWER(d.document_type) IN ({', '.join(placeholders)})")
        if filename_filter and filename_filter.strip():
            binds["filename_filter"] = filename_filter.strip()
            clauses.append("LOWER(d.file_name) LIKE '%' || LOWER(:filename_filter) || '%'")
        return " AND ".join(clauses), binds

    @staticmethod
    def _hit(row: dict[str, Any], *, channel: str) -> RetrievalHit:
        return RetrievalHit(
            evidence_id=str(row["evidence_id"]),
            document_id=str(row["document_id"]),
            slot_no=int(row.get("slot_no") or 0),
            revision_id=str(row.get("revision_id") or ""),
            page_number=int(row["page_number"]) if row.get("page_number") is not None else None,
            unit_kind=str(row["unit_kind"]),
            source_locator=str(row["source_locator"]),
            bbox=_json_col(row.get("bbox_json"), None),
            raw_text=_lob_text(row.get("raw_text")),
            caption=_lob_text(row.get("caption")),
            asset_object_name=row.get("asset_object_name"),
            file_name=str(row["file_name"]),
            object_name=str(row["object_name"]),
            bucket=str(row["bucket"]),
            score=float(row.get("score") or 0),
            channel=channel,
        )

    @staticmethod
    def _base_select() -> str:
        return """
            a.artifact_id evidence_id, d.document_id, 0 slot_no,
            rel.document_revision_id revision_id,
            a.page_number, a.artifact_kind unit_kind, a.source_locator, a.bbox_json,
            NVL(a.raw_text, page_text.raw_text) raw_text, NULL caption,
            NVL(a.object_name, page_image.object_name) asset_object_name,
            d.file_name, d.object_name, d.bucket
        """

    @staticmethod
    def _facet_select() -> str:
        return """
            a.artifact_id evidence_id, d.document_id, :slot slot_no,
            rel.document_revision_id revision_id,
            a.page_number, a.artifact_kind unit_kind, a.source_locator, a.bbox_json,
            a.raw_text, a.raw_text caption, page_image.object_name asset_object_name,
            d.file_name, d.object_name, d.bucket
        """

    def keyword_search(self, *, query: str, top_k: int, user_hash: str | None,
                       current_version_only: bool, document_types: list[str],
                       filename_filter: str | None = None) -> list[RetrievalHit]:
        text_query = self._text_query(query)
        if not text_query:
            return []
        where, binds = self._document_where(
            user_hash=user_hash,
            current_version_only=current_version_only,
            document_types=document_types,
            filename_filter=filename_filter,
        )
        binds.update(text_query=text_query, top_k=top_k)
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                f"""
                SELECT * FROM (
                    SELECT {self._base_select()}, SCORE(1)/100 score
                    FROM sds_documents d
                    JOIN sds_index_releases rel
                      ON rel.release_id=d.serving_release_id AND rel.status='PUBLISHED'
                    JOIN sds_index_release_components rc
                      ON rc.release_id=rel.release_id AND rc.is_stale=0
                    JOIN sds_artifacts a ON a.stage_run_id=rc.stage_run_id
                    LEFT JOIN sds_index_release_components nc
                      ON nc.release_id=rel.release_id AND nc.component_key='normalize'
                         AND nc.is_stale=0
                    LEFT JOIN sds_artifacts page_text
                      ON page_text.stage_run_id=nc.stage_run_id
                         AND page_text.artifact_kind='PAGE_TEXT'
                         AND page_text.page_number=a.page_number
                    LEFT JOIN sds_index_release_components ic
                      ON ic.release_id=rel.release_id AND ic.component_key='render'
                         AND ic.is_stale=0
                    LEFT JOIN sds_artifacts page_image
                      ON page_image.stage_run_id=ic.stage_run_id
                         AND page_image.artifact_kind='PAGE_IMAGE'
                         AND page_image.page_number=a.page_number
                    WHERE {where}
                      AND a.search_text IS NOT NULL
                      AND CONTAINS(a.search_text, :text_query, 1)>0
                    ORDER BY SCORE(1) DESC, a.artifact_id
                ) WHERE ROWNUM<=:top_k
                """,
                binds,
            )
            return [self._hit(row, channel="keyword:page_text") for row in self.rows(cursor)]

    def vector_search(self, *, embedding: list[float], column: str, channel: str,
                      top_k: int, user_hash: str | None, current_version_only: bool,
                      document_types: list[str], filename_filter: str | None = None) -> list[RetrievalHit]:
        if column not in {"text_embedding", "visual_embedding"}:
            raise ValueError("invalid vector column")
        with self.connection() as connection, connection.cursor() as cursor:
            source_type = "PAGE_IMAGE" if column == "visual_embedding" else "CHUNK_TEXT"
            cursor.execute(
                """
                SELECT DISTINCT r.code
                FROM sds_embedding_recipes r
                JOIN sds_embedding_recipe_inputs i
                  ON i.revision_id=r.current_revision_id
                WHERE r.enabled=1 AND i.source_type=:source
                ORDER BY r.code
                """,
                {"source": source_type},
            )
            codes = [str(row[0]) for row in cursor.fetchall()]
        results: list[RetrievalHit] = []
        for code in codes:
            results.extend(
                self.recipe_vector_search(
                    recipe_code=code,
                    embedding=embedding,
                    channel=channel,
                    top_k=top_k,
                    user_hash=user_hash,
                    current_version_only=current_version_only,
                    document_types=document_types,
                    filename_filter=filename_filter,
                )
            )
        return sorted(results, key=lambda item: item.score, reverse=True)[:top_k]

    def recipe_vector_search(
        self,
        *,
        recipe_code: str,
        embedding: list[float],
        channel: str,
        top_k: int,
        user_hash: str | None,
        current_version_only: bool,
        document_types: list[str],
        filename_filter: str | None = None,
        min_score: float = 0.0,
    ) -> list[RetrievalHit]:
        top_k = max(1, min(top_k, 1000))
        score_filter = ""
        if min_score > 0:
            score_filter = "AND 1-VECTOR_DISTANCE(ev.vector_value, :embedding, COSINE) >= :min_score"
        where, binds = self._document_where(
            user_hash=user_hash,
            current_version_only=current_version_only,
            document_types=document_types,
            filename_filter=filename_filter,
        )
        binds.update(embedding=_vector(embedding), recipe_code=recipe_code)
        if score_filter:
            binds["min_score"] = float(min_score)
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                f"""
                SELECT {self._base_select()},
                       1-VECTOR_DISTANCE(ev.vector_value, :embedding, COSINE) score
                FROM sds_documents d
                JOIN sds_index_releases rel
                  ON rel.release_id=d.serving_release_id AND rel.status='PUBLISHED'
                JOIN sds_embedding_recipes recipe ON recipe.code=:recipe_code
                JOIN sds_index_release_components rc
                  ON rc.release_id=rel.release_id
                     AND rc.component_key='embedding:' || recipe.code
                     AND rc.is_stale=0
                JOIN sds_embeddings ev
                  ON ev.stage_run_id=rc.stage_run_id
                     AND ev.document_revision_id=rel.document_revision_id
                JOIN sds_artifacts a ON a.artifact_id=ev.target_artifact_id
                LEFT JOIN sds_index_release_components nc
                  ON nc.release_id=rel.release_id AND nc.component_key='normalize'
                     AND nc.is_stale=0
                LEFT JOIN sds_artifacts page_text
                  ON page_text.stage_run_id=nc.stage_run_id
                     AND page_text.artifact_kind='PAGE_TEXT'
                     AND page_text.page_number=a.page_number
                LEFT JOIN sds_index_release_components ic
                  ON ic.release_id=rel.release_id AND ic.component_key='render'
                     AND ic.is_stale=0
                LEFT JOIN sds_artifacts page_image
                  ON page_image.stage_run_id=ic.stage_run_id
                     AND page_image.artifact_kind='PAGE_IMAGE'
                     AND page_image.page_number=a.page_number
                WHERE {where}
                {score_filter}
                ORDER BY VECTOR_DISTANCE(ev.vector_value, :embedding, COSINE), ev.embedding_id
                FETCH APPROX FIRST {top_k} ROWS ONLY WITH TARGET ACCURACY 95
                """,
                binds,
            )
            return [self._hit(row, channel=channel) for row in self.rows(cursor)]

    def facet_keyword_search(self, *, profile: ProfileConfig, query: str, top_k: int,
                             user_hash: str | None, current_version_only: bool,
                             document_types: list[str], filename_filter: str | None = None) -> list[RetrievalHit]:
        text_query = self._text_query(query)
        if not text_query or not profile.current_revision_id:
            return []
        where, binds = self._document_where(
            user_hash=user_hash,
            current_version_only=current_version_only,
            document_types=document_types,
            filename_filter=filename_filter,
        )
        binds.update(
            text_query=text_query,
            slot=profile.slot_no,
            top_k=top_k,
        )
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                f"""
                SELECT * FROM (
                    SELECT {self._facet_select()}, SCORE(1)/100 score
                    FROM sds_documents d
                    JOIN sds_index_releases rel
                      ON rel.release_id=d.serving_release_id AND rel.status='PUBLISHED'
                    JOIN sds_index_release_components rc
                      ON rc.release_id=rel.release_id
                         AND rc.component_key='vlm:' || TO_CHAR(:slot)
                         AND rc.is_stale=0
                    JOIN sds_artifacts a
                      ON a.stage_run_id=rc.stage_run_id AND a.artifact_kind='VLM_TEXT'
                    LEFT JOIN sds_index_release_components ic
                      ON ic.release_id=rel.release_id AND ic.component_key='render'
                         AND ic.is_stale=0
                    LEFT JOIN sds_artifacts page_image
                      ON page_image.stage_run_id=ic.stage_run_id
                         AND page_image.artifact_kind='PAGE_IMAGE'
                         AND page_image.page_number=a.page_number
                    WHERE {where}
                      AND CONTAINS(a.search_text, :text_query, 1)>0
                    ORDER BY SCORE(1) DESC, a.artifact_id
                ) WHERE ROWNUM<=:top_k
                """,
                binds,
            )
            channel = f"keyword:vlm_text_slot_{profile.slot_no}"
            return [self._hit(row, channel=channel) for row in self.rows(cursor)]

    def facet_vector_search(self, *, profile: ProfileConfig, embedding: list[float], top_k: int,
                            user_hash: str | None, current_version_only: bool,
                            document_types: list[str], filename_filter: str | None = None) -> list[RetrievalHit]:
        code = f"vlm_text_slot_{profile.slot_no}"
        return self.recipe_vector_search(
            recipe_code=code,
            embedding=embedding,
            channel=f"vector:vlm_text_slot_{profile.slot_no}",
            top_k=top_k,
            user_hash=user_hash,
            current_version_only=current_version_only,
            document_types=document_types,
            filename_filter=filename_filter,
        )

    def enrich_hits(self, hits: list[RetrievalHit]) -> None:
        return

    def upsert_document(self, *, bucket: str, object_name: str, file_name: str,
                        media_type: str, content: bytes, document_type: str | None) -> DocumentUpsertResult:
        digest = hashlib.sha256(content).hexdigest()
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                "SELECT document_id, content_sha256, document_type FROM sds_documents "
                "WHERE bucket=:bucket AND object_name=:object_name",
                {"bucket": bucket, "object_name": object_name},
            )
            row = cursor.fetchone()
            document_id = str(row[0]) if row else uuid4().hex
            content_changed = not row or str(row[1]) != digest
            resolved_type = row[2] if row else document_type
            cursor.execute(
                """
                MERGE INTO sds_documents d
                USING (SELECT :document_id document_id FROM dual) s
                ON (d.document_id=s.document_id)
                WHEN MATCHED THEN UPDATE SET d.file_name=:file_name, d.media_type=:media_type,
                    d.file_size=:file_size, d.content_sha256=:sha, d.document_type=:document_type,
                    d.status='PROCESSING', d.updated_at=SYSTIMESTAMP
                WHEN NOT MATCHED THEN INSERT
                    (document_id, bucket, object_name, file_name, media_type, document_type,
                     file_size, content_sha256, status)
                    VALUES (:document_id, :bucket, :object_name, :file_name, :media_type,
                            :document_type, :file_size, :sha, 'PROCESSING')
                """,
                {
                    "document_id": document_id,
                    "bucket": bucket,
                    "object_name": object_name,
                    "file_name": file_name,
                    "media_type": media_type,
                    "document_type": resolved_type,
                    "file_size": len(content),
                    "sha": digest,
                },
            )
            cursor.execute(
                """
                MERGE INTO sds_document_acl a
                USING (SELECT :document_id document_id FROM dual) s
                ON (a.document_id=s.document_id AND a.principal_type='public_authenticated'
                    AND a.principal_hash=:principal)
                WHEN NOT MATCHED THEN INSERT
                    (document_id, principal_type, principal_hash, permission)
                    VALUES (:document_id, 'public_authenticated', :principal, 'read')
                """,
                {"document_id": document_id, "principal": "0" * 64},
            )
            connection.commit()
        return DocumentUpsertResult(document_id, content_changed, digest, resolved_type)

    def reusable_document_run(self, *, document_id: str, content_sha256: str,
                              config_hash: str) -> str | None:
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT index_run_id FROM sds_document_index_runs
                WHERE document_id=:document AND content_sha256=:content
                  AND config_hash=:config AND is_serving=1 AND status='SUCCEEDED'
                """,
                {"document": document_id, "content": content_sha256, "config": config_hash},
            )
            row = cursor.fetchone()
            return str(row[0]) if row else None

    def start_index_run(self, *, document_id: str, content_sha256: str, config_hash: str,
                        native_parser: str, embedding_model: str) -> str:
        run_id = uuid4().hex
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO sds_document_index_runs
                    (index_run_id, document_id, content_sha256, config_hash, status,
                     native_parser, embedding_model)
                VALUES (:run, :document, :content, :config, 'BUILDING', :parser, :embedding)
                """,
                {
                    "run": run_id,
                    "document": document_id,
                    "content": content_sha256,
                    "config": config_hash,
                    "parser": native_parser,
                    "embedding": embedding_model,
                },
            )
            connection.commit()
        return run_id

    def store_document_evidence(self, *, index_run_id: str, document_id: str,
                                evidence: list[EvidenceRecord], page_count: int,
                                page_coverage: float, mineru_version: str | None,
                                ocr_engines: list[str]) -> None:
        with self.connection() as connection, connection.cursor() as cursor:
            for item in evidence:
                cursor.execute(
                    """
                    INSERT INTO sds_evidence
                        (evidence_id, index_run_id, document_id, parent_evidence_id,
                         page_number, unit_kind, source_locator, bbox_json, raw_text,
                         search_text, asset_object_name, provenance_json,
                         text_embedding, visual_embedding)
                    VALUES (:evidence, :run, :document, :parent, :page, :kind, :locator,
                            :bbox, :raw_text, :search_text, :asset, :provenance,
                            :text_embedding, :visual_embedding)
                    """,
                    {
                        "evidence": item.evidence_id,
                        "run": index_run_id,
                        "document": document_id,
                        "parent": item.parent_evidence_id,
                        "page": item.page_number,
                        "kind": item.unit_kind,
                        "locator": item.source_locator,
                        "bbox": json.dumps(item.bbox) if item.bbox else None,
                        "raw_text": item.raw_text,
                        "search_text": item.search_text,
                        "asset": item.asset_object_name,
                        "provenance": json.dumps(item.provenance),
                        "text_embedding": _vector(item.text_embedding),
                        "visual_embedding": _vector(item.visual_embedding),
                    },
                )
            cursor.execute(
                "UPDATE sds_document_index_runs SET is_serving=0 "
                "WHERE document_id=:document AND is_serving=1",
                {"document": document_id},
            )
            cursor.execute(
                """
                UPDATE sds_document_index_runs
                SET status='SUCCEEDED', is_serving=1, page_count=:page_count,
                    page_coverage=:coverage, mineru_version=:mineru,
                    ocr_engines_json=:ocr, completed_at=SYSTIMESTAMP
                WHERE index_run_id=:run
                """,
                {
                    "page_count": page_count,
                    "coverage": page_coverage,
                    "mineru": mineru_version,
                    "ocr": json.dumps(ocr_engines),
                    "run": index_run_id,
                },
            )
            cursor.execute(
                "UPDATE sds_documents SET status='INDEXED', updated_at=SYSTIMESTAMP "
                "WHERE document_id=:document",
                {"document": document_id},
            )
            connection.commit()

    def serving_evidence(self, document_id: str) -> tuple[str, list[EvidenceRecord]]:
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT e.evidence_id, e.document_id, e.parent_evidence_id, e.page_number,
                       e.unit_kind, e.source_locator, e.bbox_json, e.raw_text,
                       e.search_text, e.asset_object_name, e.provenance_json,
                       e.index_run_id
                FROM sds_evidence e
                JOIN sds_document_index_runs ir ON ir.index_run_id=e.index_run_id
                WHERE e.document_id=:document AND ir.is_serving=1 AND ir.status='SUCCEEDED'
                ORDER BY e.page_number, e.evidence_id
                """,
                {"document": document_id},
            )
            rows = self.rows(cursor)
        if not rows:
            raise LookupError("serving document evidence was not found")
        records = []
        for row in rows:
            records.append(
                EvidenceRecord(
                    evidence_id=str(row["evidence_id"]),
                    document_id=str(row["document_id"]),
                    parent_evidence_id=row.get("parent_evidence_id"),
                    page_number=int(row["page_number"]) if row.get("page_number") is not None else None,
                    unit_kind=str(row["unit_kind"]),
                    source_locator=str(row["source_locator"]),
                    bbox=_json_col(row.get("bbox_json"), None),
                    raw_text=_lob_text(row.get("raw_text")),
                    search_text=_lob_text(row.get("search_text")),
                    asset_object_name=row.get("asset_object_name"),
                    provenance=_json_col(row.get("provenance_json"), {}),
                )
            )
        return str(rows[0]["index_run_id"]), records

    def reusable_profile_run(self, *, document_id: str, profile: ProfileConfig,
                             index_run_id: str, content_sha256: str,
                             config_hash: str) -> bool:
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT COUNT(*) FROM sds_vlm_profile_runs
                WHERE document_id=:document AND slot_no=:slot AND revision_id=:revision
                  AND index_run_id=:index_run AND content_sha256=:content
                  AND config_hash=:config
                  AND is_serving=1 AND build_status='INDEXED'
                """,
                {
                    "document": document_id,
                    "slot": profile.slot_no,
                    "revision": profile.current_revision_id,
                    "index_run": index_run_id,
                    "content": content_sha256,
                    "config": config_hash,
                },
            )
            return bool(cursor.fetchone()[0])

    def store_profile_facets(self, *, document_id: str, index_run_id: str,
                             content_sha256: str, profile: ProfileConfig,
                             facets: list[VlmFacetRecord], config_hash: str) -> str:
        profile_run_id = uuid4().hex
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO sds_vlm_profile_runs
                    (profile_run_id, document_id, slot_no, revision_id, index_run_id,
                     content_sha256, config_hash, build_status, is_serving)
                VALUES (:run, :document, :slot, :revision, :index_run, :content,
                        :config, 'BUILDING', 0)
                """,
                {
                    "run": profile_run_id,
                    "document": document_id,
                    "slot": profile.slot_no,
                    "revision": profile.current_revision_id,
                    "index_run": index_run_id,
                    "content": content_sha256,
                    "config": config_hash,
                },
            )
            for facet in facets:
                search_text = facet.output.search_text()
                confidence = (
                    sum(item.confidence for item in facet.output.facts) / len(facet.output.facts)
                    if facet.output.facts
                    else None
                )
                cursor.execute(
                    """
                    INSERT INTO sds_vlm_facets
                        (facet_id, profile_run_id, evidence_id, document_id, slot_no,
                         revision_id, output_json, summary, search_text, confidence,
                         text_embedding)
                    VALUES (:facet, :run, :evidence, :document, :slot, :revision,
                            :output, :summary, :search_text, :confidence, :embedding)
                    """,
                    {
                        "facet": uuid4().hex,
                        "run": profile_run_id,
                        "evidence": facet.evidence_id,
                        "document": document_id,
                        "slot": profile.slot_no,
                        "revision": profile.current_revision_id,
                        "output": facet.output.model_dump_json(),
                        "summary": facet.output.summary,
                        "search_text": search_text,
                        "confidence": confidence,
                        "embedding": _vector(facet.text_embedding),
                    },
                )
            cursor.execute(
                "UPDATE sds_vlm_profile_runs SET is_serving=0 "
                "WHERE document_id=:document AND slot_no=:slot AND is_serving=1",
                {"document": document_id, "slot": profile.slot_no},
            )
            cursor.execute(
                "UPDATE sds_vlm_profile_runs SET build_status='INDEXED', is_serving=1, "
                "indexed_at=SYSTIMESTAMP WHERE profile_run_id=:run",
                {"run": profile_run_id},
            )
            connection.commit()
        return profile_run_id

    def record_profile_failure(self, *, document_id: str, index_run_id: str,
                               content_sha256: str, profile: ProfileConfig, error: str,
                               config_hash: str) -> str:
        profile_run_id = uuid4().hex
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO sds_vlm_profile_runs
                    (profile_run_id, document_id, slot_no, revision_id, index_run_id,
                     content_sha256, config_hash, build_status, is_serving, error_summary)
                VALUES (:run, :document, :slot, :revision, :index_run, :content,
                        :config, 'FAILED', 0, :error)
                """,
                {
                    "run": profile_run_id,
                    "document": document_id,
                    "slot": profile.slot_no,
                    "revision": profile.current_revision_id,
                    "index_run": index_run_id,
                    "content": content_sha256,
                    "config": config_hash,
                    "error": error[:2000],
                },
            )
            connection.commit()
        return profile_run_id

    def fail_index_run(self, index_run_id: str, document_id: str, error: str) -> None:
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                "UPDATE sds_document_index_runs SET status='FAILED', error_summary=:error, "
                "completed_at=SYSTIMESTAMP WHERE index_run_id=:run",
                {"error": error[:2000], "run": index_run_id},
            )
            cursor.execute(
                """
                UPDATE sds_documents SET status=CASE WHEN EXISTS (
                    SELECT 1 FROM sds_document_index_runs ir
                    WHERE ir.document_id=:document AND ir.is_serving=1 AND ir.status='SUCCEEDED'
                ) THEN 'REINDEX_REQUIRED' ELSE 'FAILED' END, updated_at=SYSTIMESTAMP
                WHERE document_id=:document
                """,
                {"document": document_id},
            )
            connection.commit()

    def set_document_status(self, document_id: str, status: str) -> None:
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                "UPDATE sds_documents SET status=:status, updated_at=SYSTIMESTAMP "
                "WHERE document_id=:document",
                {"status": status, "document": document_id},
            )
            connection.commit()

    def document_object_names(self) -> list[str]:
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute("SELECT object_name FROM sds_documents ORDER BY object_name")
            return [str(row[0]) for row in cursor.fetchall()]

    def delete_document_by_object(self, *, bucket: str, object_name: str) -> int:
        with self.connection() as connection, connection.cursor() as cursor:
            # SDS_DOCUMENTS and SDS_INDEX_RELEASES intentionally have a
            # bidirectional pointer (serving/draft release on the document,
            # document_id on the release).  Null the pointers first so
            # Oracle can cascade-delete releases/revisions without an
            # ORA-02292 child-record violation.
            cursor.execute(
                """
                UPDATE sds_documents
                SET serving_release_id=NULL, draft_release_id=NULL,
                    updated_at=SYSTIMESTAMP
                WHERE bucket=:bucket AND object_name=:object_name
                """,
                {"bucket": bucket, "object_name": object_name},
            )
            cursor.execute(
                "DELETE FROM sds_documents WHERE bucket=:bucket AND object_name=:object_name",
                {"bucket": bucket, "object_name": object_name},
            )
            count = int(cursor.rowcount)
            connection.commit()
            return count

    def list_documents_for_settings(self, limit: int = 100) -> list[dict[str, Any]]:
        limit = max(1, min(limit, 500))
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                f"""
                SELECT document_id, object_name, file_name, document_type, status
                FROM sds_documents WHERE is_current=1
                ORDER BY updated_at DESC FETCH FIRST {limit} ROWS ONLY
                """
            )
            return self.rows(cursor)

    def update_document_type(self, document_id: str, document_type: str | None) -> None:
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                "UPDATE sds_documents SET document_type=:type, status='UPDATE_AVAILABLE', "
                "updated_at=SYSTIMESTAMP WHERE document_id=:document",
                {"type": document_type, "document": document_id},
            )
            if cursor.rowcount != 1:
                raise LookupError("document was not found")
            connection.commit()

    def unreferenced_serving_assets(self, document_id: str) -> list[str]:
        # ponytail: retain revisioned assets until a measured storage problem justifies GC.
        return []

    def record_search_audit(self, *, trace_id: str, query_hash: str, user_hash: str | None,
                            profile_slots: list[int], diagnostics: dict[str, Any],
                            result_count: int, elapsed_ms: int) -> None:
        try:
            with self.connection() as connection, connection.cursor() as cursor:
                cursor.execute(
                    """
                    INSERT INTO sds_search_audit
                        (trace_id, user_id_hash, query_hash, profile_slots_json,
                         diagnostics_json, result_count, elapsed_ms)
                    VALUES (:trace, :user_hash, :query_hash, :profiles,
                            :diagnostics, :result_count, :elapsed_ms)
                    """,
                    {
                        "trace": trace_id,
                        "user_hash": user_hash,
                        "query_hash": query_hash,
                        "profiles": json.dumps(profile_slots),
                        "diagnostics": json.dumps(diagnostics),
                        "result_count": result_count,
                        "elapsed_ms": elapsed_ms,
                    },
                )
                connection.commit()
        except Exception:
            return

    def create_ingestion_job(self, job_id: str, total_items: int) -> None:
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                "INSERT INTO sds_ingestion_jobs (job_id, status, total_items) "
                "VALUES (:job, 'RUNNING', :total)",
                {"job": job_id, "total": total_items},
            )
            connection.commit()

    def update_ingestion_job(self, job_id: str, *, completed: int, failed: int,
                             finished: bool) -> None:
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                UPDATE sds_ingestion_jobs
                SET status=:status, completed_items=:completed, failed_items=:failed,
                    updated_at=SYSTIMESTAMP WHERE job_id=:job
                """,
                {
                    "status": "SUCCEEDED" if finished and not failed else "FAILED" if finished else "RUNNING",
                    "completed": completed,
                    "failed": failed,
                    "job": job_id,
                },
            )
            connection.commit()

    def record_search_feedback(self, *, feedback_id: str, trace_id: str,
                               document_id: str | None, evidence_id: str | None,
                               action: str, user_hash: str | None) -> None:
        with self.connection() as connection, connection.cursor() as cursor:
            cursor.execute(
                """
                INSERT INTO sds_search_feedback
                    (feedback_id, trace_id, document_id, artifact_id, action, user_id_hash)
                VALUES (:feedback, :trace, :document, :artifact, :action, :user_hash)
                """,
                {
                    "feedback": feedback_id,
                    "trace": trace_id,
                    "document": document_id,
                    "artifact": evidence_id,
                    "action": action,
                    "user_hash": user_hash,
                },
            )
            connection.commit()


rag_repository = OracleRagRepository()
