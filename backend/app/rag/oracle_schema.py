from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path
from typing import Any
from uuid import uuid4

from dotenv import load_dotenv

from app.rag.models import initial_profiles
from app.services.database_service import database_service


SCHEMA_VERSION = "20260714_004"
MIGRATION_CONFIRMATION = "MIGRATE_TO_20260714_004"
LEGACY_TABLES = (
    "SDS_SEARCH_FEEDBACK",
    "SDS_SEARCH_AUDIT",
    "SDS_INGESTION_SEGMENTS",
    "SDS_INGESTION_JOBS",
    "SDS_VLM_FACETS",
    "SDS_VLM_PROFILE_RUNS",
    "SDS_EVIDENCE",
    "SDS_DOCUMENT_INDEX_RUNS",
    "SDS_IMAGE_EMBEDDINGS",
    "SDS_FILES",
    "SDS_VLM_PROFILE_REVISIONS",
    "SDS_VLM_PROFILES",
    "SDS_DOCUMENT_ACL",
    "SDS_DOCUMENTS",
    "SDS_SCHEMA_VERSION",
)


def _sql_text(value: str) -> str:
    return value.replace("'", "''")


def _profile_seed_statements() -> list[str]:
    statements: list[str] = []
    for profile in initial_profiles():
        revision_id = f"profile_{profile.slot_no}_initial"
        digest = hashlib.sha256(
            json.dumps(
                {
                    "slot_no": profile.slot_no,
                    "name": profile.name,
                    "enabled": profile.enabled,
                    "extraction_prompt": profile.extraction_prompt,
                },
                ensure_ascii=False,
                sort_keys=True,
            ).encode()
        ).hexdigest()
        statements.extend(
            (
                "INSERT INTO SDS_VLM_PROFILES "
                "(SLOT_NO, NAME, ENABLED, APPLY_STATUS) "
                f"VALUES ({profile.slot_no}, '{_sql_text(profile.name)}', "
                f"{int(profile.enabled)}, 'NOT_APPLIED')",
                "INSERT INTO SDS_VLM_PROFILE_REVISIONS "
                "(REVISION_ID, SLOT_NO, REVISION_NO, CONFIG_HASH, EXTRACTION_PROMPT) "
                f"VALUES ('{revision_id}', {profile.slot_no}, 1, '{digest}', "
                f"'{_sql_text(profile.extraction_prompt)}')",
                "UPDATE SDS_VLM_PROFILES SET CURRENT_REVISION_ID="
                f"'{revision_id}' WHERE SLOT_NO={profile.slot_no}",
            )
        )
    return statements


def _recipe_seed_statements() -> list[str]:
    recipes = (
        {
            "id": "chunk_text",
            "name": "チャンクテキスト",
            "description": "標準化したチャンクテキストを検索用に埋め込みます。",
            "enabled": True,
            "scope": "CHUNK",
            "inputs": (("CHUNK_TEXT", None, True),),
        },
        {
            "id": "page_image",
            "name": "ページ画像",
            "description": "ページ画像だけを埋め込みます。",
            "enabled": True,
            "scope": "PAGE",
            "inputs": (("PAGE_IMAGE", None, True),),
        },
        {
            "id": "page_image_page_text",
            "name": "ページ画像＋標準テキスト",
            "description": "ページ画像と原生解析・OCRを統合したテキストを1つのベクトルにします。",
            "enabled": True,
            "scope": "PAGE",
            "inputs": (("PAGE_IMAGE", None, True), ("PAGE_TEXT", None, True)),
        },
        {
            "id": "vlm_text_slot_1",
            "name": "VLMテキスト（プロファイル1）",
            "description": "VLMプロファイル1の抽出テキストを埋め込みます。",
            "enabled": True,
            "scope": "PAGE",
            "inputs": (("VLM_TEXT", "1", True),),
        },
    )
    statements: list[str] = []
    for recipe in recipes:
        revision_id = f"{recipe['id']}_v1"
        config = {
            "model_id": "cohere.embed-v4.0",
            "output_dimensions": 1536,
            "target_scope": recipe["scope"],
            "inputs": recipe["inputs"],
        }
        digest = hashlib.sha256(
            json.dumps(config, ensure_ascii=False, sort_keys=True).encode()
        ).hexdigest()
        statements.extend(
            (
                "INSERT INTO SDS_EMBEDDING_RECIPES "
                "(RECIPE_ID, CODE, NAME, DESCRIPTION, ENABLED, SEARCH_WEIGHT) "
                f"VALUES ('{recipe['id']}', '{recipe['id']}', "
                f"'{_sql_text(str(recipe['name']))}', '{_sql_text(str(recipe['description']))}', "
                f"{int(bool(recipe['enabled']))}, 1)",
                "INSERT INTO SDS_EMBEDDING_RECIPE_REVISIONS "
                "(REVISION_ID, RECIPE_ID, REVISION_NO, CONFIG_HASH, MODEL_ID, "
                "OUTPUT_DIMENSIONS, TARGET_SCOPE, MISSING_INPUT_POLICY) "
                f"VALUES ('{revision_id}', '{recipe['id']}', 1, '{digest}', "
                f"'cohere.embed-v4.0', 1536, '{recipe['scope']}', 'SKIP_TARGET')",
            )
        )
        for ordinal, (source_type, source_ref, required) in enumerate(recipe["inputs"], 1):
            ref = "NULL" if source_ref is None else f"'{_sql_text(str(source_ref))}'"
            statements.append(
                "INSERT INTO SDS_EMBEDDING_RECIPE_INPUTS "
                "(REVISION_ID, INPUT_ORDINAL, SOURCE_TYPE, SOURCE_REF, REQUIRED) "
                f"VALUES ('{revision_id}', {ordinal}, '{source_type}', {ref}, {int(required)})"
            )
        statements.append(
            "UPDATE SDS_EMBEDDING_RECIPES SET CURRENT_REVISION_ID="
            f"'{revision_id}' WHERE RECIPE_ID='{recipe['id']}'"
        )
    return statements


def schema_statements() -> list[str]:
    statements = [
        """
        CREATE TABLE SDS_SCHEMA_VERSION (
            VERSION_ID VARCHAR2(32) PRIMARY KEY,
            DDL_SHA256 CHAR(64) NOT NULL,
            APPLIED_AT TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
            DETAILS_JSON CLOB CHECK (DETAILS_JSON IS JSON)
        )
        """,
        """
        CREATE TABLE SDS_VLM_PROFILES (
            SLOT_NO NUMBER(2) PRIMARY KEY CHECK (SLOT_NO BETWEEN 1 AND 99),
            NAME VARCHAR2(200) NOT NULL,
            ENABLED NUMBER(1) DEFAULT 0 NOT NULL CHECK (ENABLED IN (0, 1)),
            CURRENT_REVISION_ID VARCHAR2(64),
            APPLY_STATUS VARCHAR2(24) DEFAULT 'NOT_APPLIED' NOT NULL
                CHECK (APPLY_STATUS IN ('NOT_APPLIED', 'READY', 'PENDING', 'PROCESSING', 'FAILED')),
            LAST_APPLIED_AT TIMESTAMP,
            CREATED_AT TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
            UPDATED_AT TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
        )
        """,
        """
        CREATE TABLE SDS_VLM_PROFILE_REVISIONS (
            REVISION_ID VARCHAR2(64) PRIMARY KEY,
            SLOT_NO NUMBER(2) NOT NULL REFERENCES SDS_VLM_PROFILES(SLOT_NO),
            REVISION_NO NUMBER NOT NULL,
            CONFIG_HASH CHAR(64) NOT NULL,
            EXTRACTION_PROMPT CLOB NOT NULL,
            CREATED_AT TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
            APPLIED_AT TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
            UNIQUE (SLOT_NO, REVISION_NO)
        )
        """,
        """
        ALTER TABLE SDS_VLM_PROFILES ADD CONSTRAINT FK_SDS_VLM_PROFILE_REVISION
        FOREIGN KEY (CURRENT_REVISION_ID) REFERENCES SDS_VLM_PROFILE_REVISIONS(REVISION_ID)
        """,
        """
        CREATE TABLE SDS_DOCUMENTS (
            DOCUMENT_ID VARCHAR2(64) PRIMARY KEY,
            TENANT_ID_HASH CHAR(64),
            BUCKET VARCHAR2(128) NOT NULL,
            OBJECT_NAME VARCHAR2(1024) NOT NULL,
            FILE_NAME VARCHAR2(1024) NOT NULL,
            MEDIA_TYPE VARCHAR2(128),
            DOCUMENT_TYPE VARCHAR2(120),
            FILE_SIZE NUMBER,
            CONTENT_SHA256 CHAR(64),
            CURRENT_REVISION_ID VARCHAR2(64),
            SERVING_RELEASE_ID VARCHAR2(64),
            DRAFT_RELEASE_ID VARCHAR2(64),
            IS_CURRENT NUMBER(1) DEFAULT 1 NOT NULL CHECK (IS_CURRENT IN (0, 1)),
            STATUS VARCHAR2(40) DEFAULT 'UNPROCESSED' NOT NULL,
            UPLOADED_AT TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
            UPDATED_AT TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
            UNIQUE (BUCKET, OBJECT_NAME)
        )
        """,
        """
        CREATE TABLE SDS_DOCUMENT_REVISIONS (
            REVISION_ID VARCHAR2(64) PRIMARY KEY,
            DOCUMENT_ID VARCHAR2(64) NOT NULL REFERENCES SDS_DOCUMENTS(DOCUMENT_ID) ON DELETE CASCADE,
            CONTENT_SHA256 CHAR(64) NOT NULL,
            OBJECT_VERSION VARCHAR2(256),
            ETAG VARCHAR2(256),
            FILE_SIZE NUMBER,
            MEDIA_TYPE VARCHAR2(128),
            SOURCE_METADATA_JSON CLOB CHECK (SOURCE_METADATA_JSON IS JSON),
            CREATED_AT TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
            UNIQUE (DOCUMENT_ID, CONTENT_SHA256)
        )
        """,
        """
        ALTER TABLE SDS_DOCUMENTS ADD CONSTRAINT FK_SDS_DOCUMENT_CURRENT_REVISION
        FOREIGN KEY (CURRENT_REVISION_ID) REFERENCES SDS_DOCUMENT_REVISIONS(REVISION_ID)
        """,
        """
        CREATE TABLE SDS_PIPELINE_JOBS (
            JOB_ID VARCHAR2(64) PRIMARY KEY,
            IDEMPOTENCY_KEY VARCHAR2(200),
            JOB_MODE VARCHAR2(16) NOT NULL CHECK (JOB_MODE IN ('FULL', 'CUSTOM')),
            PUBLISH_MODE VARCHAR2(16) NOT NULL CHECK (PUBLISH_MODE IN ('DRAFT', 'AUTO')),
            REQUEST_JSON CLOB NOT NULL CHECK (REQUEST_JSON IS JSON),
            STATUS VARCHAR2(24) DEFAULT 'QUEUED' NOT NULL
                CHECK (STATUS IN ('QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL_FAILED', 'FAILED', 'CANCELLED')),
            CANCEL_REQUESTED NUMBER(1) DEFAULT 0 NOT NULL CHECK (CANCEL_REQUESTED IN (0, 1)),
            TOTAL_STEPS NUMBER DEFAULT 0 NOT NULL,
            COMPLETED_STEPS NUMBER DEFAULT 0 NOT NULL,
            FAILED_STEPS NUMBER DEFAULT 0 NOT NULL,
            LEASE_OWNER VARCHAR2(200),
            LEASE_GENERATION NUMBER DEFAULT 0 NOT NULL,
            LEASE_UNTIL TIMESTAMP,
            HEARTBEAT_AT TIMESTAMP,
            ERROR_SUMMARY VARCHAR2(2000),
            CREATED_AT TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
            STARTED_AT TIMESTAMP,
            COMPLETED_AT TIMESTAMP,
            UPDATED_AT TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
            UNIQUE (IDEMPOTENCY_KEY)
        )
        """,
        """
        CREATE TABLE SDS_STAGE_RUNS (
            STAGE_RUN_ID VARCHAR2(64) PRIMARY KEY,
            DOCUMENT_REVISION_ID VARCHAR2(64) NOT NULL
                REFERENCES SDS_DOCUMENT_REVISIONS(REVISION_ID) ON DELETE CASCADE,
            STAGE_KIND VARCHAR2(32) NOT NULL,
            COMPONENT_KEY VARCHAR2(200) NOT NULL,
            CONFIG_HASH CHAR(64) NOT NULL,
            INPUT_HASH CHAR(64) NOT NULL,
            CACHE_KEY CHAR(64) NOT NULL,
            OUTPUT_HASH CHAR(64),
            STATUS VARCHAR2(24) NOT NULL
                CHECK (STATUS IN ('RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
            OUTPUT_COUNT NUMBER DEFAULT 0 NOT NULL,
            COVERAGE NUMBER DEFAULT 0 NOT NULL,
            METADATA_JSON CLOB CHECK (METADATA_JSON IS JSON),
            ERROR_SUMMARY VARCHAR2(2000),
            STARTED_AT TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
            COMPLETED_AT TIMESTAMP
        )
        """,
        """
        CREATE TABLE SDS_PIPELINE_JOB_STEPS (
            STEP_ID VARCHAR2(64) PRIMARY KEY,
            JOB_ID VARCHAR2(64) NOT NULL REFERENCES SDS_PIPELINE_JOBS(JOB_ID) ON DELETE CASCADE,
            OBJECT_NAME VARCHAR2(1024) NOT NULL,
            DOCUMENT_ID VARCHAR2(64) REFERENCES SDS_DOCUMENTS(DOCUMENT_ID),
            DOCUMENT_REVISION_ID VARCHAR2(64) REFERENCES SDS_DOCUMENT_REVISIONS(REVISION_ID),
            RELEASE_ID VARCHAR2(64),
            STEP_ORDINAL NUMBER NOT NULL,
            STAGE_KIND VARCHAR2(32) NOT NULL,
            COMPONENT_KEY VARCHAR2(200) NOT NULL,
            STATUS VARCHAR2(24) DEFAULT 'QUEUED' NOT NULL
                CHECK (STATUS IN ('BLOCKED', 'QUEUED', 'RUNNING', 'REUSED', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
            FORCE_RUN NUMBER(1) DEFAULT 0 NOT NULL CHECK (FORCE_RUN IN (0, 1)),
            STAGE_RUN_ID VARCHAR2(64) REFERENCES SDS_STAGE_RUNS(STAGE_RUN_ID),
            PROGRESS_CURRENT NUMBER DEFAULT 0 NOT NULL,
            PROGRESS_TOTAL NUMBER DEFAULT 0 NOT NULL,
            ATTEMPT_COUNT NUMBER DEFAULT 0 NOT NULL,
            LEASE_GENERATION NUMBER,
            ERROR_SUMMARY VARCHAR2(2000),
            STARTED_AT TIMESTAMP,
            COMPLETED_AT TIMESTAMP,
            UPDATED_AT TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
            UNIQUE (JOB_ID, OBJECT_NAME, COMPONENT_KEY)
        )
        """,
        """
        CREATE TABLE SDS_PIPELINE_STEP_DEPENDENCIES (
            STEP_ID VARCHAR2(64) NOT NULL
                REFERENCES SDS_PIPELINE_JOB_STEPS(STEP_ID) ON DELETE CASCADE,
            DEPENDS_ON_STEP_ID VARCHAR2(64) NOT NULL
                REFERENCES SDS_PIPELINE_JOB_STEPS(STEP_ID) ON DELETE CASCADE,
            PRIMARY KEY (STEP_ID, DEPENDS_ON_STEP_ID),
            CHECK (STEP_ID <> DEPENDS_ON_STEP_ID)
        )
        """,
        """
        CREATE TABLE SDS_JOB_EVENTS (
            EVENT_ID NUMBER GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
            JOB_ID VARCHAR2(64) NOT NULL REFERENCES SDS_PIPELINE_JOBS(JOB_ID) ON DELETE CASCADE,
            SEQUENCE_NO NUMBER NOT NULL,
            EVENT_TYPE VARCHAR2(64) NOT NULL,
            PAYLOAD_JSON CLOB NOT NULL CHECK (PAYLOAD_JSON IS JSON),
            CREATED_AT TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
            UNIQUE (JOB_ID, SEQUENCE_NO)
        )
        """,
        """
        CREATE TABLE SDS_ARTIFACTS (
            ARTIFACT_ID VARCHAR2(64) PRIMARY KEY,
            STAGE_RUN_ID VARCHAR2(64) NOT NULL REFERENCES SDS_STAGE_RUNS(STAGE_RUN_ID) ON DELETE CASCADE,
            DOCUMENT_REVISION_ID VARCHAR2(64) NOT NULL
                REFERENCES SDS_DOCUMENT_REVISIONS(REVISION_ID) ON DELETE CASCADE,
            PARENT_ARTIFACT_ID VARCHAR2(64) REFERENCES SDS_ARTIFACTS(ARTIFACT_ID) ON DELETE CASCADE,
            PAGE_NUMBER NUMBER,
            ARTIFACT_KIND VARCHAR2(40) NOT NULL,
            SOURCE_LOCATOR VARCHAR2(512) NOT NULL,
            BBOX_JSON CLOB CHECK (BBOX_JSON IS JSON),
            RAW_TEXT CLOB,
            SEARCH_TEXT CLOB,
            OBJECT_NAME VARCHAR2(1024),
            PAYLOAD_JSON CLOB CHECK (PAYLOAD_JSON IS JSON),
            METADATA_JSON CLOB CHECK (METADATA_JSON IS JSON),
            CONTENT_SHA256 CHAR(64) NOT NULL,
            CREATED_AT TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
            UNIQUE (STAGE_RUN_ID, SOURCE_LOCATOR, ARTIFACT_KIND)
        )
        """,
        """
        CREATE TABLE SDS_ARTIFACT_LINEAGE (
            CHILD_ARTIFACT_ID VARCHAR2(64) NOT NULL REFERENCES SDS_ARTIFACTS(ARTIFACT_ID) ON DELETE CASCADE,
            PARENT_ARTIFACT_ID VARCHAR2(64) NOT NULL REFERENCES SDS_ARTIFACTS(ARTIFACT_ID) ON DELETE CASCADE,
            INPUT_ROLE VARCHAR2(64) NOT NULL,
            INPUT_ORDINAL NUMBER NOT NULL,
            PRIMARY KEY (CHILD_ARTIFACT_ID, PARENT_ARTIFACT_ID, INPUT_ROLE)
        )
        """,
        """
        CREATE TABLE SDS_EMBEDDING_RECIPES (
            RECIPE_ID VARCHAR2(64) PRIMARY KEY,
            CODE VARCHAR2(64) NOT NULL UNIQUE,
            NAME VARCHAR2(200) NOT NULL,
            DESCRIPTION VARCHAR2(1000),
            ENABLED NUMBER(1) DEFAULT 0 NOT NULL CHECK (ENABLED IN (0, 1)),
            SEARCH_WEIGHT NUMBER DEFAULT 1 NOT NULL CHECK (SEARCH_WEIGHT BETWEEN 0 AND 10),
            CURRENT_REVISION_ID VARCHAR2(64),
            CREATED_AT TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
            UPDATED_AT TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
        )
        """,
        """
        CREATE TABLE SDS_EMBEDDING_RECIPE_REVISIONS (
            REVISION_ID VARCHAR2(64) PRIMARY KEY,
            RECIPE_ID VARCHAR2(64) NOT NULL REFERENCES SDS_EMBEDDING_RECIPES(RECIPE_ID) ON DELETE CASCADE,
            REVISION_NO NUMBER NOT NULL,
            CONFIG_HASH CHAR(64) NOT NULL,
            MODEL_ID VARCHAR2(256) NOT NULL,
            OUTPUT_DIMENSIONS NUMBER NOT NULL CHECK (OUTPUT_DIMENSIONS=1536),
            TARGET_SCOPE VARCHAR2(16) NOT NULL CHECK (TARGET_SCOPE IN ('PAGE', 'CHUNK')),
            MISSING_INPUT_POLICY VARCHAR2(24) DEFAULT 'SKIP_TARGET' NOT NULL
                CHECK (MISSING_INPUT_POLICY IN ('SKIP_TARGET', 'FAIL_RUN')),
            CREATED_AT TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
            UNIQUE (RECIPE_ID, REVISION_NO)
        )
        """,
        """
        ALTER TABLE SDS_EMBEDDING_RECIPES ADD CONSTRAINT FK_SDS_RECIPE_REVISION
        FOREIGN KEY (CURRENT_REVISION_ID) REFERENCES SDS_EMBEDDING_RECIPE_REVISIONS(REVISION_ID)
        """,
        """
        CREATE TABLE SDS_EMBEDDING_RECIPE_INPUTS (
            REVISION_ID VARCHAR2(64) NOT NULL
                REFERENCES SDS_EMBEDDING_RECIPE_REVISIONS(REVISION_ID) ON DELETE CASCADE,
            INPUT_ORDINAL NUMBER NOT NULL,
            SOURCE_TYPE VARCHAR2(32) NOT NULL
                CHECK (SOURCE_TYPE IN ('PAGE_IMAGE', 'NATIVE_TEXT', 'MINERU_TEXT', 'OCR_TEXT',
                                       'PAGE_TEXT', 'CHUNK_TEXT', 'VLM_TEXT')),
            SOURCE_REF VARCHAR2(200),
            REQUIRED NUMBER(1) DEFAULT 1 NOT NULL CHECK (REQUIRED IN (0, 1)),
            PRIMARY KEY (REVISION_ID, INPUT_ORDINAL),
            UNIQUE (REVISION_ID, SOURCE_TYPE, SOURCE_REF)
        )
        """,
        """
        CREATE TABLE SDS_EMBEDDINGS (
            EMBEDDING_ID VARCHAR2(64) PRIMARY KEY,
            STAGE_RUN_ID VARCHAR2(64) NOT NULL REFERENCES SDS_STAGE_RUNS(STAGE_RUN_ID) ON DELETE CASCADE,
            DOCUMENT_REVISION_ID VARCHAR2(64) NOT NULL
                REFERENCES SDS_DOCUMENT_REVISIONS(REVISION_ID) ON DELETE CASCADE,
            RECIPE_REVISION_ID VARCHAR2(64) NOT NULL
                REFERENCES SDS_EMBEDDING_RECIPE_REVISIONS(REVISION_ID),
            TARGET_ARTIFACT_ID VARCHAR2(64) NOT NULL REFERENCES SDS_ARTIFACTS(ARTIFACT_ID) ON DELETE CASCADE,
            INPUT_HASH CHAR(64) NOT NULL,
            VECTOR_VALUE VECTOR(1536, FLOAT32) NOT NULL,
            CREATED_AT TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
            UNIQUE (STAGE_RUN_ID, TARGET_ARTIFACT_ID)
        )
        """,
        """
        CREATE TABLE SDS_EMBEDDING_INPUTS (
            EMBEDDING_ID VARCHAR2(64) NOT NULL REFERENCES SDS_EMBEDDINGS(EMBEDDING_ID) ON DELETE CASCADE,
            ARTIFACT_ID VARCHAR2(64) NOT NULL REFERENCES SDS_ARTIFACTS(ARTIFACT_ID) ON DELETE CASCADE,
            INPUT_ROLE VARCHAR2(32) NOT NULL,
            INPUT_ORDINAL NUMBER NOT NULL,
            PRIMARY KEY (EMBEDDING_ID, INPUT_ORDINAL),
            UNIQUE (EMBEDDING_ID, ARTIFACT_ID, INPUT_ROLE)
        )
        """,
        """
        CREATE TABLE SDS_INDEX_RELEASES (
            RELEASE_ID VARCHAR2(64) PRIMARY KEY,
            DOCUMENT_ID VARCHAR2(64) NOT NULL REFERENCES SDS_DOCUMENTS(DOCUMENT_ID) ON DELETE CASCADE,
            DOCUMENT_REVISION_ID VARCHAR2(64) NOT NULL REFERENCES SDS_DOCUMENT_REVISIONS(REVISION_ID),
            STATUS VARCHAR2(24) NOT NULL
                CHECK (STATUS IN ('DRAFT', 'READY', 'PUBLISHED', 'SUPERSEDED', 'FAILED')),
            CREATED_BY_JOB_ID VARCHAR2(64) REFERENCES SDS_PIPELINE_JOBS(JOB_ID),
            VALIDATION_JSON CLOB CHECK (VALIDATION_JSON IS JSON),
            ERROR_SUMMARY VARCHAR2(2000),
            CREATED_AT TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
            READY_AT TIMESTAMP,
            PUBLISHED_AT TIMESTAMP
        )
        """,
        """
        CREATE TABLE SDS_INDEX_RELEASE_COMPONENTS (
            RELEASE_ID VARCHAR2(64) NOT NULL REFERENCES SDS_INDEX_RELEASES(RELEASE_ID) ON DELETE CASCADE,
            COMPONENT_KEY VARCHAR2(200) NOT NULL,
            STAGE_KIND VARCHAR2(32) NOT NULL,
            STAGE_RUN_ID VARCHAR2(64) NOT NULL REFERENCES SDS_STAGE_RUNS(STAGE_RUN_ID),
            IS_STALE NUMBER(1) DEFAULT 0 NOT NULL CHECK (IS_STALE IN (0, 1)),
            STALE_REASON VARCHAR2(1000),
            PRIMARY KEY (RELEASE_ID, COMPONENT_KEY)
        )
        """,
        """
        ALTER TABLE SDS_DOCUMENTS ADD CONSTRAINT FK_SDS_DOCUMENT_SERVING_RELEASE
        FOREIGN KEY (SERVING_RELEASE_ID) REFERENCES SDS_INDEX_RELEASES(RELEASE_ID)
        """,
        """
        ALTER TABLE SDS_DOCUMENTS ADD CONSTRAINT FK_SDS_DOCUMENT_DRAFT_RELEASE
        FOREIGN KEY (DRAFT_RELEASE_ID) REFERENCES SDS_INDEX_RELEASES(RELEASE_ID)
        """,
        """
        ALTER TABLE SDS_PIPELINE_JOB_STEPS ADD CONSTRAINT FK_SDS_JOB_STEP_RELEASE
        FOREIGN KEY (RELEASE_ID) REFERENCES SDS_INDEX_RELEASES(RELEASE_ID)
        """,
        """
        CREATE TABLE SDS_DOCUMENT_ACL (
            DOCUMENT_ID VARCHAR2(64) NOT NULL REFERENCES SDS_DOCUMENTS(DOCUMENT_ID) ON DELETE CASCADE,
            PRINCIPAL_TYPE VARCHAR2(32) NOT NULL
                CHECK (PRINCIPAL_TYPE IN ('user', 'group', 'service', 'public_authenticated')),
            PRINCIPAL_HASH CHAR(64) NOT NULL,
            PERMISSION VARCHAR2(16) NOT NULL CHECK (PERMISSION IN ('read', 'write', 'admin')),
            PRIMARY KEY (DOCUMENT_ID, PRINCIPAL_TYPE, PRINCIPAL_HASH)
        )
        """,
        """
        CREATE TABLE SDS_SEARCH_AUDIT (
            TRACE_ID VARCHAR2(64) PRIMARY KEY,
            TENANT_ID_HASH CHAR(64),
            USER_ID_HASH CHAR(64),
            QUERY_HASH CHAR(64) NOT NULL,
            PROFILE_SLOTS_JSON CLOB CHECK (PROFILE_SLOTS_JSON IS JSON),
            RELEASE_IDS_JSON CLOB CHECK (RELEASE_IDS_JSON IS JSON),
            DIAGNOSTICS_JSON CLOB CHECK (DIAGNOSTICS_JSON IS JSON),
            RESULT_COUNT NUMBER DEFAULT 0 NOT NULL,
            ELAPSED_MS NUMBER,
            CREATED_AT TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
        )
        """,
        """
        CREATE TABLE SDS_SEARCH_FEEDBACK (
            FEEDBACK_ID VARCHAR2(64) PRIMARY KEY,
            TRACE_ID VARCHAR2(64) NOT NULL REFERENCES SDS_SEARCH_AUDIT(TRACE_ID) ON DELETE CASCADE,
            DOCUMENT_ID VARCHAR2(64) REFERENCES SDS_DOCUMENTS(DOCUMENT_ID) ON DELETE SET NULL,
            ARTIFACT_ID VARCHAR2(64) REFERENCES SDS_ARTIFACTS(ARTIFACT_ID) ON DELETE SET NULL,
            ACTION VARCHAR2(24) NOT NULL,
            USER_ID_HASH CHAR(64),
            CREATED_AT TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
        )
        """,
        *_profile_seed_statements(),
        *_recipe_seed_statements(),
        "CREATE INDEX SDS_DOCUMENT_STATUS_IDX ON SDS_DOCUMENTS (STATUS, UPDATED_AT)",
        "CREATE INDEX SDS_REVISION_DOCUMENT_IDX ON SDS_DOCUMENT_REVISIONS (DOCUMENT_ID, CREATED_AT)",
        "CREATE INDEX SDS_JOB_STATUS_IDX ON SDS_PIPELINE_JOBS (STATUS, LEASE_UNTIL, CREATED_AT)",
        "CREATE INDEX SDS_JOB_STEP_STATUS_IDX ON SDS_PIPELINE_JOB_STEPS (JOB_ID, STATUS, STEP_ORDINAL)",
        "CREATE INDEX SDS_JOB_STEP_DEP_IDX ON SDS_PIPELINE_STEP_DEPENDENCIES (DEPENDS_ON_STEP_ID)",
        "CREATE INDEX SDS_STAGE_CACHE_IDX ON SDS_STAGE_RUNS (CACHE_KEY, STATUS, COMPLETED_AT)",
        "CREATE INDEX SDS_ARTIFACT_SOURCE_IDX ON SDS_ARTIFACTS (DOCUMENT_REVISION_ID, ARTIFACT_KIND, PAGE_NUMBER)",
        "CREATE INDEX SDS_RELEASE_COMPONENT_IDX ON SDS_INDEX_RELEASE_COMPONENTS (STAGE_RUN_ID, RELEASE_ID, IS_STALE)",
        """
        CREATE UNIQUE INDEX SDS_ONE_PUBLISHED_RELEASE_IDX ON SDS_INDEX_RELEASES (
            CASE WHEN STATUS='PUBLISHED' THEN DOCUMENT_ID END
        )
        """,
        """
        DECLARE V_COUNT NUMBER;
        BEGIN
            SELECT COUNT(*) INTO V_COUNT FROM CTX_USER_PREFERENCES WHERE PRE_NAME='SDS_WORLD_LEXER';
            IF V_COUNT=0 THEN CTX_DDL.CREATE_PREFERENCE('SDS_WORLD_LEXER', 'WORLD_LEXER'); END IF;
        END;
        """,
        """
        DECLARE V_COUNT NUMBER;
        BEGIN
            SELECT COUNT(*) INTO V_COUNT FROM CTX_USER_STOPLISTS WHERE SPL_NAME='SDS_SEARCH_STOPLIST';
            IF V_COUNT=0 THEN CTX_DDL.CREATE_STOPLIST('SDS_SEARCH_STOPLIST', 'BASIC_STOPLIST'); END IF;
        END;
        """,
        """
        CREATE INDEX SDS_ARTIFACT_TEXT_IDX ON SDS_ARTIFACTS (SEARCH_TEXT)
        INDEXTYPE IS CTXSYS.CONTEXT
        PARAMETERS ('LEXER SDS_WORLD_LEXER STOPLIST SDS_SEARCH_STOPLIST SYNC (ON COMMIT)')
        """,
        """
        CREATE VECTOR INDEX SDS_EMBEDDING_HNSW_IDX ON SDS_EMBEDDINGS (VECTOR_VALUE)
        ORGANIZATION INMEMORY NEIGHBOR GRAPH DISTANCE COSINE WITH TARGET ACCURACY 95
        PARAMETERS (TYPE HNSW, NEIGHBORS 32, EFCONSTRUCTION 500)
        """,
    ]
    return [statement.strip() for statement in statements]


@lru_cache(maxsize=1)
def schema_digest() -> str:
    seed_prefixes = (
        "INSERT INTO SDS_VLM_",
        "UPDATE SDS_VLM_",
        "INSERT INTO SDS_EMBEDDING_RECIP",
        "UPDATE SDS_EMBEDDING_RECIP",
    )
    structural = [
        statement for statement in schema_statements()
        if not statement.startswith(seed_prefixes)
    ]
    return hashlib.sha256("\n\n".join(structural).encode()).hexdigest()


def schema_sql() -> str:
    rendered: list[str] = []
    for statement in schema_statements():
        if statement.lstrip().upper().startswith(("DECLARE", "BEGIN")):
            rendered.append(f"{statement.rstrip().rstrip(';')};\n/")
        else:
            rendered.append(f"{statement.rstrip().rstrip(';')};")
    rendered.append(
        "INSERT INTO SDS_SCHEMA_VERSION (VERSION_ID, DDL_SHA256, DETAILS_JSON) "
        f"VALUES ('{SCHEMA_VERSION}', '{schema_digest()}', "
        f"'{{\"migration\":\"{SCHEMA_VERSION}\"}}');"
    )
    return "\n\n".join(rendered) + "\n"


def schema_table_names() -> tuple[str, ...]:
    names: list[str] = []
    for statement in schema_statements():
        words = statement.upper().split()
        if len(words) >= 3 and words[:2] == ["CREATE", "TABLE"]:
            names.append(words[2])
    return tuple(names)


def system_table_names() -> tuple[str, ...]:
    return schema_table_names()


def table_name_migrations() -> dict[str, str]:
    return {}


def migrate_system_table_names() -> list[str]:
    return []


def _existing_tables(cursor: Any, names: tuple[str, ...]) -> set[str]:
    if not names:
        return set()
    binds = {f"table_{index}": name for index, name in enumerate(names)}
    placeholders = ", ".join(f":table_{index}" for index in range(len(names)))
    cursor.execute(
        f"SELECT TABLE_NAME FROM USER_TABLES WHERE TABLE_NAME IN ({placeholders})", binds
    )
    return {str(row[0]).upper() for row in cursor.fetchall()}


def system_table_status() -> dict[str, object]:
    if not database_service._ensure_pool_initialized():
        raise RuntimeError("database connection is not configured")
    expected = system_table_names()
    with database_service.pool_manager.acquire_connection() as connection:
        with connection.cursor() as cursor:
            existing = _existing_tables(cursor, expected)
            version_current = False
            if "SDS_SCHEMA_VERSION" in existing:
                cursor.execute(
                    "SELECT COUNT(*) FROM SDS_SCHEMA_VERSION "
                    "WHERE VERSION_ID=:version_id AND DDL_SHA256=:ddl_sha256",
                    {"version_id": SCHEMA_VERSION, "ddl_sha256": schema_digest()},
                )
                version_current = bool(cursor.fetchone()[0])
    missing = [name for name in expected if name not in existing]
    state = (
        "ready" if not missing and version_current
        else "missing" if not existing
        else "outdated" if not missing
        else "partial"
    )
    return {
        "ready": state == "ready",
        "status": state,
        "schema_version": SCHEMA_VERSION,
        "version_current": version_current,
        "existing_count": len(existing),
        "total_count": len(expected),
        "existing_tables": sorted(existing),
        "missing_tables": missing,
    }


def apply_schema() -> None:
    if not database_service._ensure_pool_initialized():
        raise RuntimeError("database connection is not configured")
    with database_service.pool_manager.acquire_connection() as connection:
        with connection.cursor() as cursor:
            for statement in schema_statements():
                cursor.execute(statement)
            cursor.execute(
                "INSERT INTO SDS_SCHEMA_VERSION "
                "(VERSION_ID, DDL_SHA256, DETAILS_JSON) VALUES (:version, :digest, :details)",
                {
                    "version": SCHEMA_VERSION,
                    "digest": schema_digest(),
                    "details": json.dumps({"migration": SCHEMA_VERSION}, ensure_ascii=False),
                },
            )
        connection.commit()


def _profile_backup() -> list[dict[str, object]]:
    if not database_service._ensure_pool_initialized():
        raise RuntimeError("database connection is not configured")
    with database_service.pool_manager.acquire_connection() as connection:
        with connection.cursor() as cursor:
            existing = _existing_tables(
                cursor, ("SDS_VLM_PROFILES", "SDS_VLM_PROFILE_REVISIONS")
            )
            if existing and len(existing) != 2:
                raise RuntimeError("VLMプロファイル表が不完全なため移行を中止しました")
            if not existing:
                return []
            cursor.execute(
                """
                SELECT p.slot_no, p.name, p.enabled, r.extraction_prompt
                FROM sds_vlm_profiles p
                JOIN sds_vlm_profile_revisions r
                  ON r.revision_id=p.current_revision_id
                ORDER BY p.slot_no
                """
            )
            rows = []
            for slot, name, enabled, prompt in cursor.fetchall():
                if hasattr(prompt, "read"):
                    prompt = prompt.read()
                rows.append(
                    {
                        "slot_no": int(slot),
                        "name": str(name),
                        "enabled": bool(enabled),
                        "extraction_prompt": str(prompt or ""),
                    }
                )
            return rows


def _list_source_objects() -> list[str]:
    from app.services.oci_service import oci_service

    bucket = os.environ.get("OCI_BUCKET")
    namespace_result = oci_service.get_namespace()
    if not bucket or not namespace_result.get("success"):
        raise RuntimeError("Object Storageのbucketまたはnamespaceを取得できません")
    namespace = str(namespace_result["namespace"])
    object_names: list[str] = []
    page_pattern = re.compile(r"/page_\d{3,6}(?:_[a-f0-9]{32})?\.png$")
    page_token = None
    while True:
        response = oci_service.list_objects(
            bucket_name=bucket,
            namespace=namespace,
            page_size=1000,
            page_token=page_token,
        )
        if not response.get("success"):
            raise RuntimeError(str(response.get("message") or "Object一覧の取得に失敗しました"))
        for item in response.get("objects") or []:
            name = str(item.get("name") or "")
            if (
                name
                and not name.endswith("/")
                and "/_pipeline/" not in name
                and not page_pattern.search(name)
            ):
                object_names.append(name)
        page_token = response.get("next_start_with")
        if not page_token:
            break
    return list(dict.fromkeys(object_names))


def _restore_profiles(profiles: list[dict[str, object]]) -> None:
    if not profiles:
        return
    with database_service.pool_manager.acquire_connection() as connection:
        with connection.cursor() as cursor:
            for profile in profiles:
                slot = int(profile["slot_no"])
                revision_id = uuid4().hex
                prompt = str(profile["extraction_prompt"])
                digest = hashlib.sha256(
                    json.dumps(profile, ensure_ascii=False, sort_keys=True).encode()
                ).hexdigest()
                cursor.execute(
                    "SELECT COUNT(*) FROM SDS_VLM_PROFILES WHERE SLOT_NO=:slot",
                    {"slot": slot},
                )
                if not cursor.fetchone()[0]:
                    cursor.execute(
                        "INSERT INTO SDS_VLM_PROFILES "
                        "(SLOT_NO, NAME, ENABLED, APPLY_STATUS) "
                        "VALUES (:slot, :name, :enabled, 'PENDING')",
                        {
                            "slot": slot,
                            "name": str(profile["name"]),
                            "enabled": int(bool(profile["enabled"])),
                        },
                    )
                cursor.execute(
                    "SELECT NVL(MAX(REVISION_NO), 0)+1 FROM SDS_VLM_PROFILE_REVISIONS "
                    "WHERE SLOT_NO=:slot",
                    {"slot": slot},
                )
                revision_no = int(cursor.fetchone()[0])
                cursor.execute(
                    """
                    INSERT INTO SDS_VLM_PROFILE_REVISIONS
                        (REVISION_ID, SLOT_NO, REVISION_NO, CONFIG_HASH, EXTRACTION_PROMPT)
                    VALUES (:revision, :slot, :revision_no, :digest, :prompt)
                    """,
                    {
                        "revision": revision_id,
                        "slot": slot,
                        "revision_no": revision_no,
                        "digest": digest,
                        "prompt": prompt,
                    },
                )
                cursor.execute(
                    """
                    UPDATE SDS_VLM_PROFILES
                    SET NAME=:name, ENABLED=:enabled, CURRENT_REVISION_ID=:revision,
                        APPLY_STATUS=CASE WHEN :enabled=1 THEN 'PENDING' ELSE 'READY' END,
                        UPDATED_AT=SYSTIMESTAMP
                    WHERE SLOT_NO=:slot
                    """,
                    {
                        "name": str(profile["name"]),
                        "enabled": int(bool(profile["enabled"])),
                        "revision": revision_id,
                        "slot": slot,
                    },
                )
        connection.commit()


def ensure_profile_embedding_recipes() -> list[str]:
    """Ensure every enabled VLM Profile has its required text recipe."""
    from app.rag.pipeline_models import (
        EmbeddingRecipeInput,
        EmbeddingRecipeUpsert,
    )
    from app.rag.pipeline_repository import pipeline_repository
    from app.rag.profile_repository import profile_repository

    existing = {item.code for item in pipeline_repository.list_recipes()}
    created: list[str] = []
    for profile in profile_repository.enabled_profiles():
        code = f"vlm_text_slot_{profile.slot_no}"
        if code in existing:
            continue
        pipeline_repository.upsert_recipe(
            EmbeddingRecipeUpsert(
                code=code,
                name=f"VLMテキスト（プロファイル{profile.slot_no}）",
                description=(
                    f"VLMプロファイル{profile.slot_no}の抽出テキストを埋め込みます。"
                ),
                enabled=True,
                search_weight=1,
                target_scope="PAGE",
                inputs=[
                    EmbeddingRecipeInput(
                        source_type="VLM_TEXT",
                        source_ref=str(profile.slot_no),
                        required=True,
                    )
                ],
            )
        )
        existing.add(code)
        created.append(code)
    return created


def migration_plan() -> dict[str, object]:
    if not database_service._ensure_pool_initialized():
        raise RuntimeError("database connection is not configured")
    names = tuple(dict.fromkeys((*system_table_names(), *LEGACY_TABLES)))
    counts: dict[str, int] = {}
    with database_service.pool_manager.acquire_connection() as connection:
        with connection.cursor() as cursor:
            existing = _existing_tables(cursor, names)
            for table_name in sorted(existing):
                cursor.execute(f"SELECT COUNT(*) FROM {table_name}")
                counts[table_name] = int(cursor.fetchone()[0])
    return {
        "target_version": SCHEMA_VERSION,
        "destructive": True,
        "confirmation": MIGRATION_CONFIRMATION,
        "tables_to_drop": sorted(counts),
        "row_counts": counts,
        "object_storage_preserved": True,
        "old_vectors_backfilled": False,
    }


def provision_system_tables(*, recreate: bool = False) -> dict[str, object]:
    before = None
    try:
        before = system_table_status()
    except RuntimeError:
        raise
    if before["ready"] and not recreate:
        return {**before, "recreated": False, "created_tables": []}
    if before["status"] != "missing" and not recreate:
        raise ValueError("SDS schema is partial or outdated; migration is required")
    if recreate:
        names = tuple(dict.fromkeys((*system_table_names(), *LEGACY_TABLES)))
        with database_service.pool_manager.acquire_connection() as connection:
            with connection.cursor() as cursor:
                existing = _existing_tables(cursor, names)
                remaining = set(existing)
                while remaining:
                    progress = False
                    for table_name in list(remaining):
                        try:
                            cursor.execute(f"DROP TABLE {table_name} CASCADE CONSTRAINTS PURGE")
                        except Exception:
                            continue
                        remaining.remove(table_name)
                        progress = True
                    if not progress:
                        raise RuntimeError(
                            "旧システムテーブルを削除できません: " + ", ".join(sorted(remaining))
                        )
            connection.commit()
    apply_schema()
    after = system_table_status()
    if not after["ready"]:
        raise RuntimeError("システムテーブルの初期化が完了しませんでした")
    return {
        **after,
        "recreated": recreate,
        "created_tables": list(system_table_names()),
    }


def migrate_to_v4(
    *,
    confirmation: str,
    backup_dir: Path,
    resume_profile_backup: Path | None = None,
) -> dict[str, object]:
    if confirmation != MIGRATION_CONFIRMATION:
        raise ValueError("破壊的マイグレーションの確認語が一致しません")
    plan = migration_plan()
    if resume_profile_backup is not None:
        profiles_value = json.loads(resume_profile_backup.read_text(encoding="utf-8"))
        if not isinstance(profiles_value, list) or any(
            not isinstance(item, dict)
            or not {"slot_no", "name", "enabled", "extraction_prompt"}.issubset(item)
            for item in profiles_value
        ):
            raise ValueError("再開用VLMプロファイルバックアップが不正です")
        profiles = profiles_value
    else:
        profiles = _profile_backup()
    object_names = _list_source_objects()
    backup_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup_path = backup_dir / f"sds-vlm-profiles-{timestamp}.json"
    profile_payload = json.dumps(profiles, ensure_ascii=False, indent=2)
    backup_path.write_text(profile_payload, encoding="utf-8")
    object_manifest_path = backup_dir / f"sds-object-manifest-{timestamp}.json"
    object_manifest = {
        "schema_version": SCHEMA_VERSION,
        "object_count": len(object_names),
        "objects_sha256": hashlib.sha256(
            json.dumps(object_names, ensure_ascii=False).encode()
        ).hexdigest(),
        "object_names": object_names,
    }
    object_manifest_payload = json.dumps(
        object_manifest, ensure_ascii=False, indent=2
    )
    object_manifest_path.write_text(object_manifest_payload, encoding="utf-8")
    if backup_path.read_text(encoding="utf-8") != profile_payload:
        raise RuntimeError("VLMプロファイルのバックアップ検証に失敗しました")
    if object_manifest_path.read_text(encoding="utf-8") != object_manifest_payload:
        raise RuntimeError("Object Storage一覧のバックアップ検証に失敗しました")
    result = provision_system_tables(recreate=True)
    _restore_profiles(profiles)
    ensure_profile_embedding_recipes()
    if profiles:
        expected_slots = {int(item["slot_no"]) for item in profiles}
        with database_service.pool_manager.acquire_connection() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT slot_no FROM sds_vlm_profiles "
                    "WHERE current_revision_id IS NOT NULL"
                )
                restored_slots = {int(row[0]) for row in cursor.fetchall()}
        if not expected_slots.issubset(restored_slots):
            raise RuntimeError("VLMプロファイルの復元検証に失敗しました")
    queued_job_id: str | None = None
    queued_job_ids: list[str] = []
    registration_warning: str | None = None
    object_count = len(object_names)
    try:
        from app.rag.pipeline_models import PipelineJobRequest
        from app.rag.pipeline_planner import plan_steps, planned_dependencies
        from app.rag.pipeline_repository import pipeline_repository, stable_hash
        from app.rag.profile_repository import profile_repository
        from app.rag.service_settings import retrieval_service_settings
        if object_names:
            # PipelineJobRequest intentionally caps a request at 500 objects;
            # enqueue migration work in deterministic batches so a large
            # Object Storage bucket is never left partially unindexed.
            mineru = retrieval_service_settings.get_mineru()
            recipes = pipeline_repository.list_recipes()
            profile_slots = [
                item.slot_no for item in profile_repository.enabled_profiles()
            ]
            for batch_no in range(0, len(object_names), 500):
                batch = object_names[batch_no : batch_no + 500]
                request = PipelineJobRequest(object_names=batch, mode="FULL")
                planned, _, _ = plan_steps(
                    request,
                    recipes=recipes,
                    profile_slots=profile_slots,
                    mineru_enabled=mineru.enabled and bool(mineru.base_url),
                    ocr_enabled=retrieval_service_settings.get_ocr().enabled,
                )
                dependencies = planned_dependencies(planned, recipes=recipes)
                batch_no_1 = batch_no // 500
                job_id, _ = pipeline_repository.create_job(
                    request_json=request.model_dump_json(),
                    mode=request.mode,
                    publish_mode=request.publish_mode,
                    step_specs=[
                        {
                            "object_name": object_name,
                            "kind": step.kind,
                            "component_key": step.component_key,
                            "force": False,
                            "depends_on": sorted(
                                dependencies[step.component_key]
                            ),
                        }
                        for object_name in batch
                        for step in planned
                    ],
                    idempotency_key=(
                        f"schema-migration:{SCHEMA_VERSION}:{batch_no_1}:"
                        f"{stable_hash(batch)[:16]}"
                    ),
                )
                queued_job_ids.append(job_id)
            queued_job_id = queued_job_ids[0] if queued_job_ids else None
    except Exception as error:
        registration_warning = str(error)[:1000]
    return {
        **result,
        "migration_plan": plan,
        "profile_backup": str(backup_path),
        "profile_backup_source": (
            str(resume_profile_backup) if resume_profile_backup else None
        ),
        "object_manifest_backup": str(object_manifest_path),
        "reindex_required": True,
        "object_storage_preserved": True,
        "object_count": object_count,
        "queued_job_id": queued_job_id,
        "queued_job_ids": queued_job_ids,
        "registration_warning": registration_warning,
    }


def enqueue_full_rebuild() -> dict[str, object]:
    """Register every source object and enqueue durable FULL pipeline jobs."""
    from app.rag.pipeline_models import PipelineJobRequest
    from app.rag.pipeline_planner import plan_steps, planned_dependencies
    from app.rag.pipeline_repository import pipeline_repository, stable_hash
    from app.rag.profile_repository import profile_repository
    from app.rag.service_settings import retrieval_service_settings

    if not pipeline_repository.schema_ready():
        raise RuntimeError("SDS v4 schema is not ready")
    ensure_profile_embedding_recipes()
    object_names = _list_source_objects()
    mineru = retrieval_service_settings.get_mineru()
    recipes = pipeline_repository.list_recipes()
    profile_slots = [
        item.slot_no for item in profile_repository.enabled_profiles()
    ]
    job_ids: list[str] = []
    for batch_offset in range(0, len(object_names), 500):
        batch = object_names[batch_offset : batch_offset + 500]
        request = PipelineJobRequest(object_names=batch, mode="FULL")
        planned, _, _ = plan_steps(
            request,
            recipes=recipes,
            profile_slots=profile_slots,
            mineru_enabled=mineru.enabled and bool(mineru.base_url),
            ocr_enabled=retrieval_service_settings.get_ocr().enabled,
        )
        dependencies = planned_dependencies(planned, recipes=recipes)
        job_id, _ = pipeline_repository.create_job(
            request_json=request.model_dump_json(),
            mode=request.mode,
            publish_mode=request.publish_mode,
            step_specs=[
                {
                    "object_name": object_name,
                    "kind": step.kind,
                    "component_key": step.component_key,
                    "force": False,
                    "depends_on": sorted(dependencies[step.component_key]),
                }
                for object_name in batch
                for step in planned
            ],
            idempotency_key=(
                f"schema-rebuild:{SCHEMA_VERSION}:{stable_hash(batch)[:16]}"
            ),
        )
        job_ids.append(job_id)
    return {
        "schema_version": SCHEMA_VERSION,
        "object_count": len(object_names),
        "queued_job_id": job_ids[0] if job_ids else None,
        "queued_job_ids": job_ids,
    }


def main() -> None:
    load_dotenv(Path(__file__).resolve().parents[3] / ".env")
    parser = argparse.ArgumentParser(description="SDS v4スキーマを生成・移行します")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--plan", action="store_true")
    parser.add_argument("--migrate", action="store_true")
    parser.add_argument("--confirmation")
    parser.add_argument("--backup-dir", type=Path, default=Path("var/schema-backups"))
    parser.add_argument("--resume-profile-backup", type=Path)
    parser.add_argument("--enqueue-rebuild", action="store_true")
    args = parser.parse_args()
    if args.output:
        args.output.write_text(schema_sql(), encoding="utf-8")
    if args.plan:
        print(json.dumps(migration_plan(), ensure_ascii=False, indent=2))
    if args.enqueue_rebuild:
        print(json.dumps(enqueue_full_rebuild(), ensure_ascii=False, indent=2))
    elif args.migrate:
        print(
            json.dumps(
                migrate_to_v4(
                    confirmation=args.confirmation or "",
                    backup_dir=args.backup_dir,
                    resume_profile_backup=args.resume_profile_backup,
                ),
                ensure_ascii=False,
                indent=2,
                default=str,
            )
        )
    elif args.apply:
        apply_schema()
    elif not args.output and not args.plan:
        print(schema_sql())


if __name__ == "__main__":
    main()
