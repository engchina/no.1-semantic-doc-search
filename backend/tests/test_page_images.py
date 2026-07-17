from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from pydantic import ValidationError

from app.rag.page_image_cleanup import build_cleanup_plan
from app.rag.pipeline_api import (
    document_page_image_content,
    document_page_images,
    document_page_texts,
)
from app.rag.pipeline_models import (
    EmbeddingRecipe,
    EmbeddingRecipeInput,
    PipelineJobRequest,
)
from app.rag.pipeline_repository import OraclePipelineRepository
from app.rag.pipeline_planner import plan_steps
from app.services.parallel_processor import parallel_processor


def _recipe(code: str, source_type: str, source_ref: str | None = None) -> EmbeddingRecipe:
    return EmbeddingRecipe(
        recipe_id=code,
        code=code,
        name=code,
        enabled=True,
        search_weight=1,
        target_scope="PAGE",
        inputs=[
            EmbeddingRecipeInput(
                source_type=source_type,
                source_ref=source_ref,
            )
        ],
        current_revision_id=f"{code}:1",
        revision_no=1,
        config_hash="a" * 64,
    )


def test_pipeline_request_rejects_internal_page_image_object() -> None:
    with pytest.raises(ValidationError, match="内部のページ画像"):
        PipelineJobRequest(
            object_names=["catalog/_pipeline/revision/run/page_000001.png"],
            mode="CUSTOM",
            steps=[{"kind": "RENDER"}],
        )


def test_render_only_does_not_schedule_downstream_and_reports_stale_scope() -> None:
    recipes = [
        _recipe("page_image", "PAGE_IMAGE"),
        _recipe("vlm_text_slot_1", "VLM_TEXT", "1"),
        _recipe("native_text", "NATIVE_TEXT"),
    ]
    request = PipelineJobRequest(
        object_names=["catalog.pdf"],
        mode="CUSTOM",
        steps=[{"kind": "RENDER"}],
        force=True,
        include_downstream=False,
        publish_mode="DRAFT",
    )
    planned, prerequisites, downstream = plan_steps(
        request,
        recipes=recipes,
        profile_slots=[1],
        mineru_enabled=False,
        ocr_enabled=True,
    )
    assert [item.component_key for item in planned] == ["render"]
    assert prerequisites == set()
    assert {"normalize", "ocr", "vlm:1"} <= downstream
    assert "embedding:page_image" in downstream
    assert "embedding:vlm_text_slot_1" in downstream
    assert "embedding:native_text" not in downstream


def test_cleanup_plan_only_deletes_legacy_and_unreferenced_pipeline_objects() -> None:
    objects = [
        {"name": "catalog.pdf", "size": 100},
        {"name": "catalog/page_001.png", "size": 10},
        {"name": "catalog/_pipeline/r1/run1/page_000001.png", "size": 20},
        {"name": "catalog/_pipeline/r1/orphan/page_000001.png", "size": 30},
        {"name": "uploads/page_001.png", "size": 40},
    ]
    referenced = {"catalog/_pipeline/r1/run1/page_000001.png"}
    plan = build_cleanup_plan(objects, referenced)
    assert plan["original_document_count"] == 2
    assert plan["delete_object_names"] == [
        "catalog/_pipeline/r1/orphan/page_000001.png",
        "catalog/page_001.png",
    ]
    assert plan["estimated_reclaimed_bytes"] == 40
    assert plan["protected_referenced_object_names"] == [
        "catalog/_pipeline/r1/run1/page_000001.png"
    ]


def test_object_list_source_filter_excludes_internal_and_legacy_children() -> None:
    from app.main import _filter_source_objects

    objects = [
        {"name": "catalog.pdf"},
        {"name": "catalog/page_001.png"},
        {"name": "catalog/_pipeline/r1/run1/page_000001.png"},
        {"name": "uploads/page_001.png"},
        {"name": "folder/"},
    ]
    assert [item["name"] for item in _filter_source_objects(objects)] == [
        "catalog.pdf",
        "uploads/page_001.png",
    ]


def test_page_image_list_uses_release_selector() -> None:
    value = {
        "document_id": "doc-1",
        "object_name": "catalog.pdf",
        "revision_id": "rev-1",
        "release_id": "draft-1",
        "release_status": "DRAFT",
        "stage_status": "STALE",
        "total": 1,
        "items": [
            {
                "artifact_id": "artifact-1",
                "page_number": 1,
                "media_type": "image/png",
                "size": 12,
                "content_sha256": "a" * 64,
                "stage_status": "STALE",
            }
        ],
        "pagination": {
            "current_page": 1,
            "page_size": 50,
            "total": 1,
            "total_pages": 1,
            "has_next": False,
            "has_prev": False,
        },
    }
    with (
        patch("app.rag.pipeline_api._require_schema"),
        patch(
            "app.rag.pipeline_api.pipeline_repository.list_page_images",
            return_value=value,
        ) as list_images,
    ):
        response = document_page_images("doc-1", release="draft", page=1, page_size=50)
    assert response.release_id == "draft-1"
    assert response.items[0].artifact_id == "artifact-1"
    list_images.assert_called_once_with(
        "doc-1", selector="draft", page=1, page_size=50
    )


def test_page_texts_use_release_selector_and_expose_vlm_payload() -> None:
    value = {
        "document_id": "doc-1",
        "selector": "draft",
        "release_id": "draft-1",
        "release_status": "DRAFT",
        "page_number": 3,
        "items": [
            {
                "component_key": "vlm:1",
                "artifact_kind": "VLM_TEXT",
                "page_number": 3,
                "raw_text": "説明テキスト",
                "payload_json": {"summary": "概要"},
                "stage_status": "SUCCEEDED",
            }
        ],
    }
    with (
        patch("app.rag.pipeline_api._require_schema"),
        patch(
            "app.rag.pipeline_api.pipeline_repository.list_page_texts",
            return_value=value,
        ) as list_texts,
    ):
        response = document_page_texts("doc-1", page_number=3, release="draft")
    assert response.release_id == "draft-1"
    assert response.items[0].component_key == "vlm:1"
    assert response.items[0].payload_json == {"summary": "概要"}
    list_texts.assert_called_once_with("doc-1", selector="draft", page_number=3)


def test_processing_status_hides_inactive_stale_stage() -> None:
    repository = OraclePipelineRepository()
    connection_context = MagicMock()
    connection = connection_context.__enter__.return_value
    cursor = connection.cursor.return_value.__enter__.return_value
    cursor.fetchone.return_value = (
        "doc-1",
        "catalog.pdf",
        "INDEXED",
        "revision-1",
        "serving-1",
        None,
    )

    def execute(sql: str, _params: dict[str, object] | None = None) -> None:
        if "SELECT code FROM sds_embedding_recipes" in sql:
            cursor.fetchall.return_value = []
        elif "SELECT slot_no FROM sds_vlm_profiles" in sql:
            cursor.fetchall.return_value = [(1,)]
        elif "FROM sds_index_release_components c" in sql:
            cursor.fetchall.return_value = [
                ("render", 0, None, "SUCCEEDED"),
                ("vlm:2", 1, "render changed", "SUCCEEDED"),
            ]

    cursor.execute.side_effect = execute
    page_images = {
        "selector": "latest",
        "selected": {"release_id": "serving-1", "count": 2},
        "draft": None,
        "serving": {"release_id": "serving-1", "count": 2},
    }

    with (
        patch.object(repository, "connection", return_value=connection_context),
        patch.object(repository, "page_image_versions", return_value=page_images),
    ):
        result = repository.processing_status("doc-1", "latest")

    stage_call = next(
        call
        for call in cursor.execute.call_args_list
        if "FROM sds_index_release_components c" in call.args[0]
    )
    stage_sql, stage_params = stage_call.args
    assert "SELECT c.component_key" in stage_sql
    assert stage_params == {"release": "serving-1"}
    assert result["publication_status"] == "PUBLISHED"
    assert result["stages"] == {"render": "SUCCEEDED"}
    assert result["stale_reasons"] == {}
    assert result["page_images"] == page_images


def test_statuses_by_object_batches_release_and_page_image_queries() -> None:
    repository = OraclePipelineRepository()
    connection_context = MagicMock()
    connection = connection_context.__enter__.return_value
    cursor = connection.cursor.return_value.__enter__.return_value

    def execute(sql: str, _params: dict[str, object] | None = None) -> None:
        if "FROM sds_documents" in sql:
            cursor.fetchall.return_value = [
                ("doc-1", "published.pdf", "INDEXED", "rev-1", "serving-1", None),
                (
                    "doc-2",
                    "draft.pdf",
                    "PROCESSING",
                    "rev-2",
                    "serving-2",
                    "draft-2",
                ),
            ]
        elif "FROM sds_index_release_components c" in sql:
            cursor.fetchall.return_value = [
                ("serving-1", "render", 0, None, "SUCCEEDED"),
                ("draft-2", "render", 1, "render changed", "SUCCEEDED"),
                ("draft-2", "vlm:2", 1, "render changed", "SUCCEEDED"),
            ]
        elif "SELECT code FROM sds_embedding_recipes" in sql:
            cursor.fetchall.return_value = []
        elif "SELECT slot_no FROM sds_vlm_profiles" in sql:
            cursor.fetchall.return_value = [(1,)]
        elif "FROM sds_index_releases r" in sql:
            cursor.fetchall.return_value = [
                ("serving-1", "PUBLISHED", "rev-1", 0, "SUCCEEDED", 2),
                ("serving-2", "PUBLISHED", "rev-2", 0, "SUCCEEDED", 1),
                ("draft-2", "DRAFT", "rev-2", 1, "SUCCEEDED", 3),
            ]
        else:  # pragma: no cover - makes unexpected SQL fail loudly
            raise AssertionError(sql)

    cursor.execute.side_effect = execute
    with patch.object(repository, "connection", return_value=connection_context):
        result = repository.statuses_by_object(["published.pdf", "draft.pdf"], "latest")

    assert cursor.execute.call_count == 5
    assert result["published.pdf"]["stages"] == {"render": "SUCCEEDED"}
    assert result["published.pdf"]["page_images"]["selected"]["count"] == 2
    assert result["draft.pdf"]["publication_status"] == "UPDATE_AVAILABLE"
    assert result["draft.pdf"]["stages"] == {"render": "STALE"}
    assert result["draft.pdf"]["stale_reasons"] == {"render": "render changed"}
    assert result["draft.pdf"]["page_images"]["selected"]["release_id"] == "draft-2"


def test_existing_draft_prunes_components_disabled_after_it_was_created() -> None:
    repository = OraclePipelineRepository()
    connection_context = MagicMock()
    connection = connection_context.__enter__.return_value
    cursor = connection.cursor.return_value.__enter__.return_value
    cursor.fetchone.side_effect = [
        ("draft-1",),
        ("revision-1", "DRAFT"),
    ]
    revision = SimpleNamespace(document_id="doc-1", revision_id="revision-1")
    active = {"render", "native_parse", "normalize", "vlm:1"}

    with (
        patch.object(repository, "connection", return_value=connection_context),
        patch.object(repository, "_current_required_components", return_value=active),
        patch.object(repository, "_prune_inactive_release_components") as prune,
        patch.object(repository, "_mark_outdated_component_configs") as mark_stale,
    ):
        release_id = repository.ensure_draft_release(revision, "job-1")

    assert release_id == "draft-1"
    prune.assert_called_once_with(cursor, "draft-1", active)
    mark_stale.assert_called_once_with(cursor, "draft-1")
    connection.commit.assert_called_once()


def test_new_draft_prunes_inactive_components_copied_from_serving_release() -> None:
    repository = OraclePipelineRepository()
    connection_context = MagicMock()
    connection = connection_context.__enter__.return_value
    cursor = connection.cursor.return_value.__enter__.return_value
    cursor.fetchone.return_value = (None,)
    revision = SimpleNamespace(document_id="doc-1", revision_id="revision-1")
    active = {"render", "native_parse", "normalize"}

    with (
        patch.object(repository, "connection", return_value=connection_context),
        patch.object(repository, "_current_required_components", return_value=active),
        patch.object(repository, "_prune_inactive_release_components") as prune,
        patch.object(repository, "_mark_outdated_component_configs"),
        patch(
            "app.rag.pipeline_repository.uuid4",
            return_value=SimpleNamespace(hex="draft-new"),
        ),
    ):
        release_id = repository.ensure_draft_release(revision, "job-1")

    assert release_id == "draft-new"
    clone_call = next(
        call
        for call in cursor.execute.call_args_list
        if "INSERT INTO sds_index_release_components" in call.args[0]
    )
    assert "d.serving_release_id" in clone_call.args[0]
    prune.assert_called_once_with(cursor, "draft-new", active)
    connection.commit.assert_called_once()


def test_component_pruning_uses_only_current_contract_as_delete_allowlist() -> None:
    cursor = MagicMock()
    active = {"render", "native_parse", "normalize", "vlm:1"}

    OraclePipelineRepository._prune_inactive_release_components(
        cursor, "draft-1", active
    )

    sql, params = cursor.execute.call_args.args
    assert "DELETE FROM sds_index_release_components" in sql
    assert "component_key NOT IN" in sql
    assert params["release"] == "draft-1"
    assert {
        value for key, value in params.items() if key.startswith("active_component_")
    } == active


def test_publish_prunes_inactive_components_before_switching_serving_release() -> None:
    repository = OraclePipelineRepository()
    initial_context = MagicMock()
    initial_cursor = initial_context.__enter__.return_value.cursor.return_value.__enter__.return_value
    initial_cursor.fetchone.return_value = ("READY", "serving-old")

    publish_context = MagicMock()
    publish_connection = publish_context.__enter__.return_value
    publish_cursor = publish_connection.cursor.return_value.__enter__.return_value
    publish_cursor.fetchone.side_effect = [
        ("serving-old", "revision-1"),
        ("doc-1", "revision-1", "READY"),
    ]
    publish_cursor.fetchall.return_value = [
        ("render", "run-render", 0),
        ("vlm:2", "run-disabled", 1),
    ]
    active = {"render", "native_parse", "normalize"}
    validation = {
        "valid": True,
        "required_components": sorted(active),
        "component_run_ids": {
            "render": "run-render",
            "vlm:2": "run-disabled",
        },
    }

    with (
        patch.object(
            repository,
            "connection",
            side_effect=[initial_context, publish_context],
        ),
        patch.object(repository, "validate_release", return_value=validation),
        patch.object(repository, "_prune_inactive_release_components") as prune,
    ):
        result = repository.publish_release("doc-1", "draft-1")

    prune.assert_called_once_with(publish_cursor, "draft-1", active)
    assert result == {
        "document_id": "doc-1",
        "release_id": "draft-1",
        "previous_release_id": "serving-old",
    }
    publish_connection.commit.assert_called_once()


@pytest.mark.asyncio
async def test_page_image_content_is_fetched_only_after_lineage_validation() -> None:
    artifact = {
        "artifact_id": "artifact-1",
        "object_name": "catalog/_pipeline/r1/run1/page_000001.png",
        "content_sha256": "b" * 64,
        "page_number": 1,
        "media_type": "image/png",
    }
    with (
        patch("app.rag.pipeline_api._require_schema"),
        patch(
            "app.rag.pipeline_api.pipeline_repository.get_page_image_artifact",
            return_value=artifact,
        ) as validate_artifact,
        patch(
            "app.rag.pipeline_api.oci_service.download_object",
            return_value=b"png",
        ) as download,
    ):
        response = await document_page_image_content(
            "doc-1", "release-1", "artifact-1"
        )
    validate_artifact.assert_called_once_with("doc-1", "release-1", "artifact-1")
    download.assert_called_once_with(artifact["object_name"])
    assert response.body == b"png"
    assert response.headers["etag"] == f'"{artifact["content_sha256"]}"'


@pytest.mark.asyncio
async def test_source_deletion_removes_v4_document_lineage_after_object_delete() -> None:
    storage = SimpleNamespace(
        get_namespace=MagicMock(return_value={"success": True, "namespace": "ns"}),
        delete_objects=MagicMock(return_value={"success": True}),
    )
    vectorizer = SimpleNamespace(
        get_file_id_by_object_name=MagicMock(return_value=None)
    )
    legacy_database = SimpleNamespace(delete_file_info_records=MagicMock())
    repository = SimpleNamespace(delete_document_by_object=MagicMock(return_value=1))
    with patch.dict("os.environ", {"OCI_BUCKET": "bucket"}):
        events = [
            event
            async for event in parallel_processor.process_deletion(
                object_names=["catalog.pdf"],
                oci_service=storage,
                image_vectorizer=vectorizer,
                database_service=legacy_database,
                job_id="page-image-delete-test",
                rag_repository=repository,
            )
        ]
    storage.delete_objects.assert_called_once()
    repository.delete_document_by_object.assert_called_once_with(
        bucket="bucket", object_name="catalog.pdf"
    )
    assert any(event["type"] == "file_complete" for event in events)
