from __future__ import annotations

import argparse
import hashlib
import re
from functools import lru_cache
from pathlib import Path

from app.rag.models import initial_profiles
from app.rag.profile_validation import profile_hash
from app.services.database_service import database_service

SCHEMA_VERSION = "20260709_003"
CORE_TABLES = ("SDS_FILES", "SDS_IMAGE_EMBEDDINGS")
PREVIOUS_CORE_TABLES = {"FILE_INFO": "SDS_FILES", "IMG_EMBEDDINGS": "SDS_IMAGE_EMBEDDINGS"}
LEGACY_PROFILE_TABLES = (
    "SDS_PROFILE_PROMPTS",
    "SDS_EVIDENCE_RELATIONS",
    "SDS_EVIDENCE_FIELDS",
    "SDS_PROFILE_SCOPE_RULES",
    "SDS_SYNONYM_ENTRIES",
    "SDS_RELATION_DEFINITIONS",
    "SDS_FIELD_DEFINITIONS",
    "SDS_PROFILE_DOCUMENT_RUNS",
    "SDS_EXTRACTION_RUNS",
    "SDS_PROFILE_REVISIONS",
    "SDS_SEARCH_PROFILES",
)


def _sql_text(value: str) -> str:
    return value.replace("'", "''")


def _initial_profile_statements() -> list[str]:
    statements: list[str] = []
    for profile in initial_profiles():
        revision_id = f"vlm-profile-{profile.slot_no}-v1"
        digest = profile_hash(profile)
        statements.extend(
            [
                (
                    "INSERT INTO SDS_VLM_PROFILES "
                    "(SLOT_NO, NAME, ENABLED, APPLY_STATUS) VALUES "
                    f"({profile.slot_no}, '{_sql_text(profile.name)}', "
                    f"{int(profile.enabled)}, 'READY')"
                ),
                (
                    "INSERT INTO SDS_VLM_PROFILE_REVISIONS "
                    "(REVISION_ID, SLOT_NO, REVISION_NO, CONFIG_HASH, EXTRACTION_PROMPT, APPLIED_AT) VALUES "
                    f"('{revision_id}', {profile.slot_no}, 1, '{digest}', "
                    f"'{_sql_text(profile.extraction_prompt)}', SYSTIMESTAMP)"
                ),
                (
                    "UPDATE SDS_VLM_PROFILES SET CURRENT_REVISION_ID="
                    f"'{revision_id}', LAST_APPLIED_AT=SYSTIMESTAMP WHERE SLOT_NO={profile.slot_no}"
                ),
            ]
        )
    return statements


def schema_statements() -> list[str]:
    statements = [
        """
        CREATE TABLE SDS_SCHEMA_VERSION (
            VERSION_ID VARCHAR2(32) PRIMARY KEY,
            DDL_SHA256 CHAR(64) NOT NULL,
            APPLIED_AT TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
        )
        """,
        """
        CREATE TABLE SDS_VLM_PROFILES (
            SLOT_NO NUMBER(1) PRIMARY KEY CHECK (SLOT_NO BETWEEN 1 AND 3),
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
            SLOT_NO NUMBER(1) NOT NULL REFERENCES SDS_VLM_PROFILES(SLOT_NO),
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
            CONTENT_SHA256 CHAR(64) NOT NULL,
            VERSION_LABEL VARCHAR2(120),
            IS_CURRENT NUMBER(1) DEFAULT 1 NOT NULL CHECK (IS_CURRENT IN (0, 1)),
            SUPERSEDES_DOCUMENT_ID VARCHAR2(64) REFERENCES SDS_DOCUMENTS(DOCUMENT_ID),
            STATUS VARCHAR2(40) NOT NULL,
            UPLOADED_AT TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
            UPDATED_AT TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
            UNIQUE (BUCKET, OBJECT_NAME)
        )
        """,
        """
        CREATE TABLE SDS_DOCUMENT_INDEX_RUNS (
            INDEX_RUN_ID VARCHAR2(64) PRIMARY KEY,
            DOCUMENT_ID VARCHAR2(64) NOT NULL REFERENCES SDS_DOCUMENTS(DOCUMENT_ID) ON DELETE CASCADE,
            CONTENT_SHA256 CHAR(64) NOT NULL,
            CONFIG_HASH CHAR(64) NOT NULL,
            STATUS VARCHAR2(24) NOT NULL,
            IS_SERVING NUMBER(1) DEFAULT 0 NOT NULL CHECK (IS_SERVING IN (0, 1)),
            NATIVE_PARSER VARCHAR2(120),
            MINERU_VERSION VARCHAR2(120),
            OCR_ENGINES_JSON CLOB CHECK (OCR_ENGINES_JSON IS JSON),
            EMBEDDING_MODEL VARCHAR2(256),
            PAGE_COUNT NUMBER DEFAULT 0 NOT NULL,
            PAGE_COVERAGE NUMBER DEFAULT 0 NOT NULL,
            ERROR_SUMMARY VARCHAR2(2000),
            STARTED_AT TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
            COMPLETED_AT TIMESTAMP
        )
        """,
        """
        CREATE UNIQUE INDEX SDS_ONE_DOCUMENT_RUN_IDX ON SDS_DOCUMENT_INDEX_RUNS (
            CASE WHEN IS_SERVING=1 THEN DOCUMENT_ID END
        )
        """,
        """
        CREATE TABLE SDS_EVIDENCE (
            EVIDENCE_ID VARCHAR2(128) PRIMARY KEY,
            INDEX_RUN_ID VARCHAR2(64) NOT NULL REFERENCES SDS_DOCUMENT_INDEX_RUNS(INDEX_RUN_ID) ON DELETE CASCADE,
            DOCUMENT_ID VARCHAR2(64) NOT NULL REFERENCES SDS_DOCUMENTS(DOCUMENT_ID) ON DELETE CASCADE,
            PARENT_EVIDENCE_ID VARCHAR2(128) REFERENCES SDS_EVIDENCE(EVIDENCE_ID),
            PAGE_NUMBER NUMBER,
            UNIT_KIND VARCHAR2(40) NOT NULL,
            SOURCE_LOCATOR VARCHAR2(512) NOT NULL,
            BBOX_JSON CLOB CHECK (BBOX_JSON IS JSON),
            RAW_TEXT CLOB,
            SEARCH_TEXT CLOB NOT NULL,
            ASSET_OBJECT_NAME VARCHAR2(1024),
            PROVENANCE_JSON CLOB CHECK (PROVENANCE_JSON IS JSON),
            TEXT_EMBEDDING VECTOR(1536, FLOAT32),
            VISUAL_EMBEDDING VECTOR(1536, FLOAT32),
            CREATED_AT TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
            UNIQUE (INDEX_RUN_ID, SOURCE_LOCATOR, UNIT_KIND)
        )
        """,
        """
        CREATE TABLE SDS_VLM_PROFILE_RUNS (
            PROFILE_RUN_ID VARCHAR2(64) PRIMARY KEY,
            DOCUMENT_ID VARCHAR2(64) NOT NULL REFERENCES SDS_DOCUMENTS(DOCUMENT_ID) ON DELETE CASCADE,
            SLOT_NO NUMBER(1) NOT NULL REFERENCES SDS_VLM_PROFILES(SLOT_NO),
            REVISION_ID VARCHAR2(64) NOT NULL REFERENCES SDS_VLM_PROFILE_REVISIONS(REVISION_ID),
            INDEX_RUN_ID VARCHAR2(64) NOT NULL REFERENCES SDS_DOCUMENT_INDEX_RUNS(INDEX_RUN_ID),
            CONTENT_SHA256 CHAR(64) NOT NULL,
            CONFIG_HASH CHAR(64) NOT NULL,
            BUILD_STATUS VARCHAR2(24) NOT NULL,
            IS_SERVING NUMBER(1) DEFAULT 0 NOT NULL CHECK (IS_SERVING IN (0, 1)),
            INDEXED_AT TIMESTAMP,
            ERROR_SUMMARY VARCHAR2(2000)
        )
        """,
        """
        CREATE UNIQUE INDEX SDS_ONE_VLM_SERVING_RUN_IDX ON SDS_VLM_PROFILE_RUNS (
            CASE WHEN IS_SERVING=1 THEN DOCUMENT_ID END,
            CASE WHEN IS_SERVING=1 THEN SLOT_NO END
        )
        """,
        """
        CREATE TABLE SDS_VLM_FACETS (
            FACET_ID VARCHAR2(128) PRIMARY KEY,
            PROFILE_RUN_ID VARCHAR2(64) NOT NULL REFERENCES SDS_VLM_PROFILE_RUNS(PROFILE_RUN_ID) ON DELETE CASCADE,
            EVIDENCE_ID VARCHAR2(128) NOT NULL REFERENCES SDS_EVIDENCE(EVIDENCE_ID) ON DELETE CASCADE,
            DOCUMENT_ID VARCHAR2(64) NOT NULL REFERENCES SDS_DOCUMENTS(DOCUMENT_ID) ON DELETE CASCADE,
            SLOT_NO NUMBER(1) NOT NULL REFERENCES SDS_VLM_PROFILES(SLOT_NO),
            REVISION_ID VARCHAR2(64) NOT NULL REFERENCES SDS_VLM_PROFILE_REVISIONS(REVISION_ID),
            OUTPUT_JSON CLOB NOT NULL CHECK (OUTPUT_JSON IS JSON),
            SUMMARY CLOB,
            SEARCH_TEXT CLOB NOT NULL,
            CONFIDENCE NUMBER,
            TEXT_EMBEDDING VECTOR(1536, FLOAT32),
            CREATED_AT TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
            UNIQUE (PROFILE_RUN_ID, EVIDENCE_ID)
        )
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
        CREATE TABLE SDS_INGESTION_JOBS (
            JOB_ID VARCHAR2(64) PRIMARY KEY,
            STATUS VARCHAR2(24) NOT NULL,
            TOTAL_ITEMS NUMBER DEFAULT 0 NOT NULL,
            COMPLETED_ITEMS NUMBER DEFAULT 0 NOT NULL,
            FAILED_ITEMS NUMBER DEFAULT 0 NOT NULL,
            CREATED_AT TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
            UPDATED_AT TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
        )
        """,
        """
        CREATE TABLE SDS_INGESTION_SEGMENTS (
            SEGMENT_ID VARCHAR2(128) PRIMARY KEY,
            JOB_ID VARCHAR2(64) NOT NULL REFERENCES SDS_INGESTION_JOBS(JOB_ID) ON DELETE CASCADE,
            DOCUMENT_ID VARCHAR2(64),
            SLOT_NO NUMBER(1),
            PAGE_START NUMBER,
            PAGE_END NUMBER,
            STATUS VARCHAR2(24) NOT NULL,
            ERROR_SUMMARY VARCHAR2(2000),
            UPDATED_AT TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
        )
        """,
        """
        CREATE TABLE SDS_SEARCH_AUDIT (
            TRACE_ID VARCHAR2(64) PRIMARY KEY,
            TENANT_ID_HASH CHAR(64),
            USER_ID_HASH CHAR(64),
            QUERY_HASH CHAR(64) NOT NULL,
            PROFILE_SLOTS_JSON CLOB CHECK (PROFILE_SLOTS_JSON IS JSON),
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
            DOCUMENT_ID VARCHAR2(64),
            EVIDENCE_ID VARCHAR2(128),
            ACTION VARCHAR2(24) NOT NULL,
            USER_ID_HASH CHAR(64),
            CREATED_AT TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
        )
        """,
        *_initial_profile_statements(),
        "CREATE INDEX SDS_DOCUMENT_RUN_LOOKUP_IDX ON SDS_DOCUMENT_INDEX_RUNS (DOCUMENT_ID, IS_SERVING, STATUS)",
        "CREATE INDEX SDS_EVIDENCE_SOURCE_IDX ON SDS_EVIDENCE (DOCUMENT_ID, SOURCE_LOCATOR, PAGE_NUMBER)",
        "CREATE INDEX SDS_VLM_RUN_LOOKUP_IDX ON SDS_VLM_PROFILE_RUNS (SLOT_NO, IS_SERVING, DOCUMENT_ID)",
        "CREATE INDEX SDS_VLM_RUN_REUSE_IDX ON SDS_VLM_PROFILE_RUNS (DOCUMENT_ID, SLOT_NO, REVISION_ID, CONTENT_SHA256, IS_SERVING)",
        "CREATE INDEX SDS_VLM_FACET_SOURCE_IDX ON SDS_VLM_FACETS (DOCUMENT_ID, SLOT_NO, EVIDENCE_ID)",
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
        CREATE INDEX SDS_EVIDENCE_TEXT_IDX ON SDS_EVIDENCE (SEARCH_TEXT)
        INDEXTYPE IS CTXSYS.CONTEXT
        PARAMETERS ('LEXER SDS_WORLD_LEXER STOPLIST SDS_SEARCH_STOPLIST SYNC (ON COMMIT)')
        """,
        """
        CREATE INDEX SDS_VLM_FACET_TEXT_IDX ON SDS_VLM_FACETS (SEARCH_TEXT)
        INDEXTYPE IS CTXSYS.CONTEXT
        PARAMETERS ('LEXER SDS_WORLD_LEXER STOPLIST SDS_SEARCH_STOPLIST SYNC (ON COMMIT)')
        """,
        """
        CREATE VECTOR INDEX SDS_EVIDENCE_TEXT_HNSW_IDX ON SDS_EVIDENCE (TEXT_EMBEDDING)
        ORGANIZATION INMEMORY NEIGHBOR GRAPH DISTANCE COSINE WITH TARGET ACCURACY 95
        PARAMETERS (TYPE HNSW, NEIGHBORS 32, EFCONSTRUCTION 500)
        """,
        """
        CREATE VECTOR INDEX SDS_EVIDENCE_VISUAL_HNSW_IDX ON SDS_EVIDENCE (VISUAL_EMBEDDING)
        ORGANIZATION INMEMORY NEIGHBOR GRAPH DISTANCE COSINE WITH TARGET ACCURACY 95
        PARAMETERS (TYPE HNSW, NEIGHBORS 32, EFCONSTRUCTION 500)
        """,
        """
        CREATE VECTOR INDEX SDS_VLM_FACET_TEXT_HNSW_IDX ON SDS_VLM_FACETS (TEXT_EMBEDDING)
        ORGANIZATION INMEMORY NEIGHBOR GRAPH DISTANCE COSINE WITH TARGET ACCURACY 95
        PARAMETERS (TYPE HNSW, NEIGHBORS 32, EFCONSTRUCTION 500)
        """,
    ]
    return [statement.strip() for statement in statements]


@lru_cache(maxsize=1)
def schema_digest() -> str:
    seed_prefixes = (
        "INSERT INTO SDS_VLM_PROFILES ",
        "INSERT INTO SDS_VLM_PROFILE_REVISIONS ",
        "UPDATE SDS_VLM_PROFILES SET CURRENT_REVISION_ID=",
    )
    structural = [
        statement
        for statement in schema_statements()
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
        "INSERT INTO SDS_SCHEMA_VERSION (VERSION_ID, DDL_SHA256) "
        f"VALUES ('{SCHEMA_VERSION}', '{schema_digest()}');"
    )
    rendered.append("COMMIT;")
    return "\n\n".join(rendered) + "\n"


@lru_cache(maxsize=1)
def schema_table_names() -> tuple[str, ...]:
    return tuple(
        match.group(1)
        for statement in schema_statements()
        if (match := re.match(r"CREATE TABLE\s+([A-Z0-9_]+)", statement, re.IGNORECASE))
    )


def system_table_names() -> tuple[str, ...]:
    return (*CORE_TABLES, *schema_table_names())


def table_name_migrations() -> dict[str, str]:
    return {
        **PREVIOUS_CORE_TABLES,
        **{name.replace("SDS_", "RAG_", 1): name for name in schema_table_names()},
    }


def migrate_system_table_names() -> list[str]:
    if not database_service._ensure_pool_initialized():
        raise RuntimeError("database connection is not configured")
    renames = table_name_migrations()
    names = tuple((*renames, *renames.values()))
    binds = {f"table_{index}": name for index, name in enumerate(names)}
    placeholders = ", ".join(f":table_{index}" for index in range(len(names)))
    with database_service.pool_manager.acquire_connection() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                f"SELECT TABLE_NAME FROM USER_TABLES WHERE TABLE_NAME IN ({placeholders})", binds
            )
            existing = {str(row[0]).upper() for row in cursor.fetchall()}
            conflicts = [
                f"{old}/{new}" for old, new in renames.items() if old in existing and new in existing
            ]
            if conflicts:
                raise ValueError("old and new table names coexist: " + ", ".join(conflicts))
            migrated: list[str] = []
            for old, new in renames.items():
                if old in existing:
                    cursor.execute(f"ALTER TABLE {old} RENAME TO {new}")
                    migrated.append(f"{old}->{new}")
        connection.commit()
    return migrated


def system_table_status() -> dict[str, object]:
    if not database_service._ensure_pool_initialized():
        raise RuntimeError("database connection is not configured")
    expected = system_table_names()
    binds = {f"table_{index}": name for index, name in enumerate(expected)}
    placeholders = ", ".join(f":table_{index}" for index in range(len(expected)))
    with database_service.pool_manager.acquire_connection() as connection:
        with connection.cursor() as cursor:
            cursor.execute(
                f"SELECT TABLE_NAME FROM USER_TABLES WHERE TABLE_NAME IN ({placeholders})", binds
            )
            existing = {str(row[0]).upper() for row in cursor.fetchall()}
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
        "ready"
        if not missing and version_current
        else "missing"
        if not existing
        else "outdated"
        if not missing
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
                "INSERT INTO SDS_SCHEMA_VERSION (VERSION_ID, DDL_SHA256) VALUES (:v, :h)",
                {"v": SCHEMA_VERSION, "h": schema_digest()},
            )
        connection.commit()


def provision_system_tables(*, recreate: bool = False) -> dict[str, object]:
    renamed = migrate_system_table_names()
    before = system_table_status()
    existing = set(before["existing_tables"])
    if recreate:
        with database_service.pool_manager.acquire_connection() as connection:
            with connection.cursor() as cursor:
                for table_name in (*reversed(system_table_names()), *LEGACY_PROFILE_TABLES):
                    cursor.execute(
                        "SELECT COUNT(*) FROM USER_TABLES WHERE TABLE_NAME=:table_name",
                        {"table_name": table_name},
                    )
                    if cursor.fetchone()[0]:
                        cursor.execute(f"DROP TABLE {table_name} CASCADE CONSTRAINTS PURGE")
            connection.commit()
        before = system_table_status()
        existing = set()
    schema_existing = existing.intersection(schema_table_names())
    if schema_existing and not before["ready"]:
        raise ValueError("SDS schema is partial or outdated; recreate is required")
    from app.services.image_vectorizer import image_vectorizer

    with database_service.pool_manager.acquire_connection() as connection:
        image_vectorizer._ensure_tables_exist(connection)
    if not schema_existing:
        apply_schema()
    after = system_table_status()
    if not after["ready"]:
        raise RuntimeError("system table initialization did not complete")
    after.update(
        recreated=recreate,
        renamed_tables=renamed,
        created_tables=sorted(set(after["existing_tables"]) - set(before["existing_tables"])),
    )
    return after


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate or explicitly apply the SDS schema")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--recreate", action="store_true")
    parser.add_argument("--confirmation")
    args = parser.parse_args()
    if args.recreate and args.confirmation != "RECREATE":
        parser.error("--recreate requires --confirmation RECREATE")
    sql = schema_sql()
    if args.output:
        args.output.write_text(sql, encoding="utf-8")
    elif not args.apply and not args.recreate:
        print(sql)
    if args.recreate:
        provision_system_tables(recreate=True)
    elif args.apply:
        apply_schema()


if __name__ == "__main__":
    main()
