from __future__ import annotations

import pytest

from app.rag import pipeline_api
from app.rag.pipeline_models import (
    EmbeddingRecipe,
    EmbeddingRecipeInput,
    PipelineJobRequest,
)
from app.rag.pipeline_planner import plan_steps


def _recipe(
    code: str,
    *inputs: tuple[str, str | None],
    enabled: bool = True,
    scope: str = "PAGE",
) -> EmbeddingRecipe:
    return EmbeddingRecipe(
        recipe_id=code,
        code=code,
        name=code,
        enabled=enabled,
        search_weight=1,
        target_scope=scope,
        inputs=[
            EmbeddingRecipeInput(source_type=source, source_ref=ref)
            for source, ref in inputs
        ],
        current_revision_id=f"{code}:v1",
        revision_no=1,
        config_hash="a" * 64,
    )


def test_ocr_request_expands_render_but_keeps_downstream_optional() -> None:
    request = PipelineJobRequest(
        object_names=["catalog.pdf"],
        mode="CUSTOM",
        steps=[{"kind": "OCR"}],
        force=True,
    )
    planned, prerequisites, downstream = plan_steps(
        request,
        recipes=[],
        profile_slots=[],
        mineru_enabled=False,
        ocr_enabled=True,
    )
    assert [step.component_key for step in planned] == ["render", "ocr"]
    assert prerequisites == {"render"}
    assert "normalize" in downstream
    # ``force`` is consumed by the API only for requested stages.  The planner
    # keeps the reason explicit so prerequisites can reuse their cache.
    assert [step.reason for step in planned] == ["prerequisite", "requested"]


def test_preprocess_includes_ocr_only_when_enabled() -> None:
    request = PipelineJobRequest(
        object_names=["catalog.pdf"],
        mode="CUSTOM",
        steps=[{"kind": "NATIVE_PARSE"}, {"kind": "OCR"}, {"kind": "NORMALIZE"}],
    )
    planned, prerequisites, _ = plan_steps(
        request,
        recipes=[],
        profile_slots=[],
        mineru_enabled=False,
        ocr_enabled=True,
    )
    assert [step.component_key for step in planned] == [
        "render",
        "native_parse",
        "ocr",
        "normalize",
    ]
    assert prerequisites == {"render"}

    planned, prerequisites, _ = plan_steps(
        request,
        recipes=[],
        profile_slots=[],
        mineru_enabled=False,
        ocr_enabled=False,
    )
    assert [step.component_key for step in planned] == ["native_parse", "normalize"]
    assert prerequisites == set()


def test_disabled_vlm_profile_excludes_vlm_and_dependent_recipes() -> None:
    recipes = [
        _recipe("chunk_text", ("CHUNK_TEXT", None)),
        _recipe("vlm_text_slot_1", ("VLM_TEXT", "1")),
    ]
    request = PipelineJobRequest(
        object_names=["catalog.pdf"],
        mode="CUSTOM",
        steps=[
            {"kind": "EMBED", "key": "chunk_text"},
            {"kind": "EMBED", "key": "vlm_text_slot_1"},
            {"kind": "VLM", "key": "1"},
        ],
        force=True,
    )
    planned, _, _ = plan_steps(
        request,
        recipes=recipes,
        profile_slots=[],
        mineru_enabled=False,
        ocr_enabled=False,
    )
    components = [step.component_key for step in planned]
    assert "vlm:1" not in components
    assert "embedding:vlm_text_slot_1" not in components
    assert "embedding:chunk_text" in components

    full = PipelineJobRequest(object_names=["catalog.pdf"], mode="FULL")
    planned, _, _ = plan_steps(
        full,
        recipes=recipes,
        profile_slots=[],
        mineru_enabled=False,
        ocr_enabled=False,
    )
    components = [step.component_key for step in planned]
    assert not any(component.startswith("vlm") for component in components)
    assert "embedding:vlm_text_slot_1" not in components


def test_forced_full_job_includes_all_enabled_profiles_and_forces_every_stage(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    request = PipelineJobRequest(
        object_names=["catalog.pdf"],
        mode="FULL",
        force=True,
    )
    planned, prerequisites, downstream = plan_steps(
        request,
        recipes=[],
        profile_slots=[1, 2, 3],
        mineru_enabled=False,
        ocr_enabled=False,
    )
    components = {step.component_key for step in planned}
    assert {"vlm:1", "vlm:2", "vlm:3"} <= components

    captured: dict[str, object] = {}

    def capture_job(**kwargs: object) -> tuple[str, bool]:
        captured.update(kwargs)
        return "full-job", False

    monkeypatch.setattr(pipeline_api, "_require_schema", lambda: None)
    monkeypatch.setattr(
        pipeline_api,
        "_plan",
        lambda _request: (planned, prerequisites, downstream),
    )
    monkeypatch.setattr(pipeline_api.pipeline_repository, "list_recipes", lambda: [])
    monkeypatch.setattr(pipeline_api.pipeline_repository, "create_job", capture_job)
    monkeypatch.setattr(
        pipeline_api.pipeline_repository,
        "get_job",
        lambda _job_id: {"status": "QUEUED"},
    )
    monkeypatch.setattr(pipeline_api.pipeline_dispatcher, "wake", lambda: None)

    response = pipeline_api.create_job(request, idempotency_key="forced-full")

    specs = captured["step_specs"]
    assert isinstance(specs, list)
    assert {str(spec["component_key"]) for spec in specs} == components
    assert all(bool(spec["force"]) for spec in specs)
    assert response.job_id == "full-job"


def test_vlm_text_chunk_recipe_is_valid_and_image_requires_page() -> None:
    recipe = _recipe("vlm_chunk", ("VLM_TEXT", "1"), scope="CHUNK")
    assert recipe.target_scope == "CHUNK"
    with pytest.raises(ValueError):
        _recipe("image_chunk", ("PAGE_IMAGE", None), scope="CHUNK")


def test_page_recipe_has_at_most_one_image() -> None:
    with pytest.raises(ValueError):
        _recipe(
            "two_images",
            ("PAGE_IMAGE", None),
            ("PAGE_IMAGE", "other"),
        )
