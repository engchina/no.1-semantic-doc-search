from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from pydantic import ValidationError

from app.rag.clients import EmbeddingClient
from app.rag.oracle_schema import SCHEMA_VERSION, schema_sql, schema_table_names
from app.rag.pipeline_models import (
    EmbeddingRecipe,
    EmbeddingRecipeInput,
    EmbeddingRecipeUpsert,
    PipelineJobRequest,
    PipelineStepSelector,
)
from app.rag.pipeline_planner import plan_steps, planned_dependencies


def recipe(
    code: str,
    *inputs: tuple[str, str | None],
    scope: str = "PAGE",
    enabled: bool = True,
) -> EmbeddingRecipe:
    return EmbeddingRecipe(
        recipe_id=code,
        code=code,
        name=code,
        description="test",
        enabled=enabled,
        search_weight=1,
        target_scope=scope,
        inputs=[
            EmbeddingRecipeInput(
                source_type=source,
                source_ref=source_ref,
                required=True,
            )
            for source, source_ref in inputs
        ],
        current_revision_id=f"{code}_v1",
        revision_no=1,
        config_hash="a" * 64,
    )


def test_ocr_only_expands_prerequisite_and_marks_only_related_downstream() -> None:
    recipes = [
        recipe("page_image", ("PAGE_IMAGE", None)),
        recipe("page_image_ocr", ("PAGE_IMAGE", None), ("OCR_TEXT", None)),
        recipe("chunk_text", ("CHUNK_TEXT", None), scope="CHUNK"),
    ]
    request = PipelineJobRequest(
        object_names=["a.pdf"],
        mode="CUSTOM",
        steps=[PipelineStepSelector(kind="OCR")],
        force=True,
        publish_mode="DRAFT",
    )

    planned, prerequisites, downstream = plan_steps(
        request,
        recipes=recipes,
        profile_slots=[1],
        mineru_enabled=True,
        ocr_enabled=True,
    )

    assert [step.component_key for step in planned] == ["render", "ocr"]
    assert prerequisites == {"render"}
    assert "normalize" in downstream
    assert "vlm:1" in downstream
    assert "embedding:page_image_ocr" in downstream
    assert "embedding:chunk_text" in downstream
    assert "embedding:page_image" not in downstream


def test_vlm_only_does_not_run_ocr_or_embeddings_without_downstream() -> None:
    recipes = [recipe("vlm_text_slot_1", ("VLM_TEXT", "1"))]
    request = PipelineJobRequest(
        object_names=["a.pdf"],
        mode="CUSTOM",
        steps=[PipelineStepSelector(kind="VLM", key="1")],
        force=True,
        publish_mode="DRAFT",
    )

    planned, prerequisites, downstream = plan_steps(
        request,
        recipes=recipes,
        profile_slots=[1],
        mineru_enabled=True,
        ocr_enabled=True,
    )

    components = [step.component_key for step in planned]
    assert components == ["render", "native_parse", "normalize", "vlm:1"]
    assert "ocr" not in components
    assert "mineru_parse" not in components
    assert prerequisites == {"render", "native_parse", "normalize"}
    assert downstream == {"embedding:vlm_text_slot_1"}


def test_full_job_persists_dependency_order_and_publish_waits_for_all() -> None:
    recipes = [
        recipe("chunk_text", ("CHUNK_TEXT", None), scope="CHUNK"),
        recipe("page_image", ("PAGE_IMAGE", None)),
    ]
    request = PipelineJobRequest(object_names=["a.pdf"], mode="FULL")
    planned, _, _ = plan_steps(
        request,
        recipes=recipes,
        profile_slots=[1],
        mineru_enabled=True,
        ocr_enabled=True,
    )

    dependencies = planned_dependencies(planned, recipes=recipes)

    assert dependencies["normalize"] == {"native_parse", "mineru_parse", "ocr"}
    assert dependencies["vlm:1"] == {"render", "normalize"}
    assert dependencies["embedding:page_image"] == {"render"}
    assert dependencies["publish"] == {
        step.component_key for step in planned if step.component_key != "publish"
    }


def test_full_job_does_not_reintroduce_disabled_optional_stages() -> None:
    recipes = [
        recipe("chunk_text", ("CHUNK_TEXT", None), scope="CHUNK"),
        recipe("page_image", ("PAGE_IMAGE", None)),
    ]
    request = PipelineJobRequest(
        object_names=["a.pdf"],
        mode="FULL",
        include_downstream=True,
    )

    planned, prerequisites, downstream = plan_steps(
        request,
        recipes=recipes,
        profile_slots=[1],
        mineru_enabled=False,
        ocr_enabled=False,
    )

    components = [step.component_key for step in planned]
    assert "ocr" not in components
    assert "mineru_parse" not in components
    assert request.include_downstream is False
    assert prerequisites == set()
    assert downstream == set()
    assert planned_dependencies(planned, recipes=recipes)["normalize"] == {
        "native_parse"
    }


def test_recipe_rejects_multiple_images_and_noncanonical_vlm_slot() -> None:
    base = {
        "code": "mixed_recipe",
        "name": "Mixed",
        "target_scope": "PAGE",
        "inputs": [
            {"source_type": "PAGE_IMAGE", "required": True},
            {"source_type": "PAGE_IMAGE", "required": True},
        ],
    }
    with pytest.raises(ValidationError, match="画像は1件まで"):
        EmbeddingRecipeUpsert.model_validate(base)

    base["inputs"] = [
        {"source_type": "VLM_TEXT", "source_ref": "01", "required": True}
    ]
    with pytest.raises(ValidationError, match="1〜99"):
        EmbeddingRecipeUpsert.model_validate(base)


class _Model:
    def __init__(self, **kwargs):
        self.__dict__.update(kwargs)


def test_mixed_embedding_uses_ordered_contents_search_document_and_1536() -> None:
    models = SimpleNamespace(
        EmbedTextContent=_Model,
        EmbedImageContent=_Model,
        ImageUrl=_Model,
        EmbedTextDetails=_Model,
        OnDemandServingMode=_Model,
    )
    response = SimpleNamespace(
        data=SimpleNamespace(embeddings=[[0.25] * 1536])
    )
    genai = MagicMock()

    with (
        patch("app.rag.clients.image_vectorizer.genai_client", genai),
        patch(
            "app.rag.clients.image_vectorizer._retry_embedding_api_call",
            return_value=response,
        ) as request,
        patch("app.rag.clients.importlib.import_module", return_value=models),
    ):
        value = EmbeddingClient()._request(
            ordered_contents=[
                ("IMAGE", b"image", "image/png"),
                ("TEXT", "page text", "text/plain"),
                ("TEXT", "vlm text", "text/plain"),
            ],
            input_type="SEARCH_DOCUMENT",
        )

    details = request.call_args.args[1]
    assert len(value) == 1536
    assert details.input_type == "SEARCH_DOCUMENT"
    assert details.output_dimensions == 1536
    assert [content.type for content in details.embed_contents] == [
        "IMAGE",
        "TEXT",
        "TEXT",
    ]
    assert [content.text for content in details.embed_contents[1:]] == [
        "page text",
        "vlm text",
    ]


def test_embedding_rejects_more_than_one_image_and_wrong_dimension() -> None:
    models = SimpleNamespace(
        EmbedTextContent=_Model,
        EmbedImageContent=_Model,
        ImageUrl=_Model,
        EmbedTextDetails=_Model,
        OnDemandServingMode=_Model,
    )
    genai = MagicMock()
    with (
        patch("app.rag.clients.image_vectorizer.genai_client", genai),
        patch("app.rag.clients.importlib.import_module", return_value=models),
    ):
        with pytest.raises(ValueError, match="画像は1件まで"):
            EmbeddingClient()._request(
                ordered_contents=[
                    ("IMAGE", b"one", "image/png"),
                    ("IMAGE", b"two", "image/png"),
                ],
                input_type="SEARCH_DOCUMENT",
            )

    with pytest.raises(ValueError, match="次元数が不正"):
        EmbeddingClient._validate_vector([0.1] * 1024)


def test_embed_v4_reads_float_embeddings_by_type() -> None:
    models = SimpleNamespace(
        EmbedTextContent=_Model,
        EmbedImageContent=_Model,
        ImageUrl=_Model,
        EmbedTextDetails=_Model,
        OnDemandServingMode=_Model,
    )
    response = SimpleNamespace(
        data=SimpleNamespace(
            embeddings=None,
            embeddings_by_type={"float": [[0.25] * 1536]},
        )
    )
    genai = MagicMock()

    with (
        patch("app.rag.clients.image_vectorizer.genai_client", genai),
        patch(
            "app.rag.clients.image_vectorizer._retry_embedding_api_call",
            return_value=response,
        ),
        patch("app.rag.clients.importlib.import_module", return_value=models),
    ):
        value = EmbeddingClient()._request(
            ordered_contents=[("IMAGE", b"image", "image/png")],
            input_type="SEARCH_DOCUMENT",
        )

    assert len(value) == 1536


def test_embedding_rejects_inputs_that_are_empty_after_filtering() -> None:
    models = SimpleNamespace(
        EmbedTextContent=_Model,
        EmbedImageContent=_Model,
        ImageUrl=_Model,
        EmbedTextDetails=_Model,
        OnDemandServingMode=_Model,
    )
    genai = MagicMock()

    with (
        patch("app.rag.clients.image_vectorizer.genai_client", genai),
        patch(
            "app.rag.clients.image_vectorizer._retry_embedding_api_call"
        ) as request,
        patch("app.rag.clients.importlib.import_module", return_value=models),
    ):
        with pytest.raises(ValueError, match="空白以外"):
            EmbeddingClient()._request(
                ordered_contents=[("TEXT", "   ", "text/plain")],
                input_type="SEARCH_DOCUMENT",
            )

    request.assert_not_called()


def test_v4_schema_contains_new_model_and_excludes_legacy_tables() -> None:
    names = set(schema_table_names())
    required = {
        "SDS_DOCUMENTS",
        "SDS_DOCUMENT_REVISIONS",
        "SDS_PIPELINE_JOBS",
        "SDS_PIPELINE_JOB_STEPS",
        "SDS_PIPELINE_STEP_DEPENDENCIES",
        "SDS_JOB_EVENTS",
        "SDS_STAGE_RUNS",
        "SDS_ARTIFACTS",
        "SDS_ARTIFACT_LINEAGE",
        "SDS_EMBEDDING_RECIPES",
        "SDS_EMBEDDING_RECIPE_REVISIONS",
        "SDS_EMBEDDING_RECIPE_INPUTS",
        "SDS_EMBEDDINGS",
        "SDS_EMBEDDING_INPUTS",
        "SDS_INDEX_RELEASES",
        "SDS_INDEX_RELEASE_COMPONENTS",
    }
    assert SCHEMA_VERSION == "20260714_004"
    assert required <= names
    assert {
        "SDS_FILES",
        "SDS_IMAGE_EMBEDDINGS",
        "SDS_DOCUMENT_INDEX_RUNS",
        "SDS_EVIDENCE",
        "SDS_VLM_PROFILE_RUNS",
        "SDS_VLM_FACETS",
    }.isdisjoint(names)
    ddl = schema_sql()
    assert "VECTOR(1536, FLOAT32)" in ddl
    assert "DISTANCE COSINE" in ddl
    assert "LEASE_GENERATION NUMBER DEFAULT 0 NOT NULL" in ddl
    assert "OUTPUT_HASH CHAR(64)" in ddl
