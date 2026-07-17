from __future__ import annotations

import asyncio
import hashlib
import json
from contextlib import contextmanager
from io import BytesIO
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from PIL import Image
from pydantic import ValidationError

from app.rag import search_api, service_settings
from app.rag.index_pipeline import (
    PageExtraction,
    SharedIndexPipeline,
    _build_profile_facets,
    _mineru_blocks,
    _mineru_missing_pages,
    _run_ocr,
)
from app.rag.clients import OciRerankClient
from app.rag.pipeline_models import EmbeddingRecipe, EmbeddingRecipeInput
from app.rag.models import (
    LEGACY_VLM_VERIFY_PROMPT,
    OcrSettings,
    OcrEngineSettings,
    MinerUSettings,
    PROFILE_DOCUMENT_PAGE_PROMPT,
    PROFILE_SPEC_DATA_PROMPT,
    PROFILE_VISUAL_PROMPT,
    ProfileConfig,
    RerankSettings,
    GlobalVlmSettings,
    RetrievalWeights,
    SearchV2Response,
    VlmExtractionOutput,
    initial_profiles,
)
from app.rag.oracle_repository import (
    DocumentUpsertResult,
    EvidenceRecord,
    RetrievalHit,
    oracle_text_terms,
    rag_repository,
)
from app.rag.oracle_schema import schema_digest, schema_sql, schema_statements, system_table_names
from app.rag.profile_validation import profile_hash, validate_profile
from app.rag.profile_repository import OracleProfileRepository
from app.rag.search_pipeline import (
    QueryPlan,
    RankedHit,
    SearchPipeline,
    _candidate_text,
    _image_similarity_score,
    _image_sort_key,
    _query_plan,
    _rerank_text,
    _weighted_rrf,
)
from app.rag.settings_api import test_ocr as run_ocr_test


def test_profile_repository_materializes_lob_before_returning_connection() -> None:
    active = {"value": False}

    class GuardedLob:
        def read(self) -> str:
            assert active["value"], "LOB was read after its connection closed"
            return "extract document facts"

    repository = OracleProfileRepository()
    cursor = MagicMock()
    cursor.description = [
        ("SLOT_NO",),
        ("NAME",),
        ("ENABLED",),
        ("CURRENT_REVISION_ID",),
        ("APPLY_STATUS",),
        ("LAST_APPLIED_AT",),
        ("CONFIG_HASH",),
        ("EXTRACTION_PROMPT",),
    ]
    cursor.fetchall.return_value = [
        (1, "Profile 1", 1, "revision-1", "PENDING", None, "a" * 64, GuardedLob())
    ]
    cursor.fetchone.return_value = (0,)
    connection = MagicMock()
    connection.cursor.return_value.__enter__.return_value = cursor

    @contextmanager
    def open_connection():
        active["value"] = True
        try:
            yield connection
        finally:
            active["value"] = False

    with (
        patch.object(repository, "schema_ready", return_value=True),
        patch.object(repository, "_connection", side_effect=open_connection),
    ):
        profiles = repository.list_profiles()

    assert profiles[0].extraction_prompt == "extract document facts"
    assert not active["value"]


def retrieval_hit(
    *,
    slot: int = 0,
    channel: str = "keyword:page_text",
    score: float = 0.8,
    evidence_id: str = "e1",
    document_id: str = "d1",
    page_number: int = 1,
    file_name: str = "source.pdf",
    object_name: str = "source.pdf",
    asset_object_name: str = "asset/page.png",
) -> RetrievalHit:
    return RetrievalHit(
        evidence_id=evidence_id,
        document_id=document_id,
        slot_no=slot,
        revision_id="r1" if slot else "",
        page_number=page_number,
        unit_kind="page",
        source_locator=f"page:{page_number}",
        bbox=None,
        raw_text="source text",
        caption="profile summary" if slot else "",
        asset_object_name=asset_object_name,
        file_name=file_name,
        object_name=object_name,
        bucket="bucket",
        score=score,
        channel=channel,
    )


def embedding_recipe(
    code: str,
    *sources: tuple[str, str | None],
    weight: float = 1.0,
) -> EmbeddingRecipe:
    return EmbeddingRecipe(
        recipe_id=code,
        code=code,
        name=code,
        description="test recipe",
        enabled=True,
        search_weight=weight,
        target_scope="PAGE" if any(source == "PAGE_IMAGE" for source, _ in sources) else "CHUNK",
        inputs=[
            EmbeddingRecipeInput(source_type=source, source_ref=reference, required=True)
            for source, reference in sources
        ],
        current_revision_id=f"{code}_v1",
        revision_no=1,
        config_hash="a" * 64,
    )


def sse_events(text: str) -> list[dict[str, Any]]:
    return [
        json.loads(line.removeprefix("data: "))
        for line in text.splitlines()
        if line.startswith("data: ")
    ]


def sse_chunk_event(chunk: str | bytes) -> dict[str, Any]:
    text = chunk.decode() if isinstance(chunk, bytes) else chunk
    return sse_events(text)[0]


def search_event_response(query: str = "ceiling light"):
    request = Request({
        "type": "http",
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": "/search/v2/events",
        "raw_path": b"/search/v2/events",
        "query_string": b"",
        "headers": [],
        "client": ("testclient", 50000),
        "server": ("testserver", 80),
        "state": {"auth_username": "tester"},
    })
    return search_api._search_events(
        request,
        query=query,
        top_k=1,
        field_filters=[],
        document_types=[],
        current_version_only=True,
        filename_filter=None,
    )


def successful_search_result(query: str = "ceiling light") -> SimpleNamespace:
    return SimpleNamespace(model_dump=lambda mode="json": {
        "success": True,
        "trace_id": "trace",
        "query": query,
        "results": [],
        "total_documents": 0,
        "total_evidence": 0,
        "processing_time": 0.01,
        "diagnostics": {"degraded": []},
    })


def test_search_events_follow_agui_sequence(monkeypatch) -> None:
    async def fake_search(**kwargs: Any) -> SimpleNamespace:
        await kwargs["progress"]({
            "type": "STEP_STARTED",
            "stepName": "retrieval",
            "message": "候補取得",
        })
        await kwargs["progress"]({"type": "STEP_FINISHED", "stepName": "retrieval"})
        return SimpleNamespace(model_dump=lambda mode="json": {
            "success": True,
            "trace_id": "trace",
            "query": kwargs["query"],
            "results": [],
            "total_documents": 0,
            "total_evidence": 0,
            "processing_time": 0.01,
            "diagnostics": {"degraded": []},
        })

    monkeypatch.setattr(search_api.search_pipeline, "search", fake_search)
    app = FastAPI()
    app.include_router(search_api.router)

    response = TestClient(app).post("/search/v2/events", json={"query": "ceiling light"})

    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-cache, no-transform"
    assert response.headers["x-accel-buffering"] == "no"
    events = sse_events(response.text)
    types = [event["type"] for event in events]
    assert types[:2] == ["RUN_STARTED", "STATE_SNAPSHOT"]
    assert "STEP_STARTED" in types
    assert types[-2:] == ["STATE_DELTA", "RUN_FINISHED"]
    assert events[-1]["result"]["trace_id"] == "trace"


@pytest.mark.asyncio
async def test_search_event_stream_yields_steps_before_search_finishes(monkeypatch) -> None:
    release = asyncio.Event()
    finished = asyncio.Event()

    async def fake_search(**kwargs: Any) -> SimpleNamespace:
        await kwargs["progress"]({
            "type": "STEP_STARTED",
            "stepName": "initialization",
            "message": "検索を準備しています",
        })
        await release.wait()
        finished.set()
        return successful_search_result(kwargs["query"])

    monkeypatch.setattr(search_api.search_pipeline, "search", fake_search)
    iterator = search_event_response().body_iterator.__aiter__()
    try:
        first_chunks = [
            await asyncio.wait_for(anext(iterator), timeout=1)
            for _ in range(3)
        ]
        assert [sse_chunk_event(chunk)["type"] for chunk in first_chunks] == [
            "RUN_STARTED",
            "STATE_SNAPSHOT",
            "STEP_STARTED",
        ]
        assert not finished.is_set()
    finally:
        release.set()
        async for _ in iterator:
            pass
    assert finished.is_set()


@pytest.mark.asyncio
async def test_search_event_stream_heartbeats_and_stops_after_completion(monkeypatch) -> None:
    async def fake_search(**kwargs: Any) -> SimpleNamespace:
        await asyncio.sleep(0.04)
        return successful_search_result(kwargs["query"])

    monkeypatch.setattr(search_api, "SEARCH_EVENT_HEARTBEAT_SECONDS", 0.01)
    monkeypatch.setattr(search_api.search_pipeline, "search", fake_search)

    chunks = [chunk async for chunk in search_event_response().body_iterator]
    assert ": heartbeat\n\n" in chunks
    data_events = [
        sse_chunk_event(chunk)
        for chunk in chunks
        if not str(chunk).startswith(":")
    ]
    assert data_events[-1]["type"] == "RUN_FINISHED"
    assert not str(chunks[-1]).startswith(":")


@pytest.mark.asyncio
async def test_closing_search_event_stream_cancels_search_task(monkeypatch) -> None:
    started = asyncio.Event()
    cancelled = asyncio.Event()

    async def fake_search(**_: Any) -> SimpleNamespace:
        started.set()
        try:
            await asyncio.Future()
        finally:
            cancelled.set()

    monkeypatch.setattr(search_api.search_pipeline, "search", fake_search)
    iterator = search_event_response().body_iterator.__aiter__()
    await asyncio.wait_for(anext(iterator), timeout=1)
    await asyncio.wait_for(started.wait(), timeout=1)
    await iterator.aclose()

    assert cancelled.is_set()


def test_search_events_return_run_error(monkeypatch) -> None:
    async def fake_search(**_: Any) -> None:
        raise ValueError("bad search")

    monkeypatch.setattr(search_api.search_pipeline, "search", fake_search)
    app = FastAPI()
    app.include_router(search_api.router)

    response = TestClient(app).post("/search/v2/events", json={"query": "ceiling light"})

    assert response.status_code == 200
    events = sse_events(response.text)
    assert events[-1]["type"] == "RUN_ERROR"
    assert events[-1]["message"] == "bad search"


def test_search_events_forward_verify_flag(monkeypatch) -> None:
    captured: dict[str, Any] = {}

    async def fake_search(**kwargs: Any) -> SimpleNamespace:
        captured.update(kwargs)
        return SimpleNamespace(model_dump=lambda mode="json": {
            "success": True,
            "trace_id": "trace",
            "query": kwargs["query"],
            "results": [],
            "total_documents": 0,
            "total_evidence": 0,
            "processing_time": 0.01,
            "diagnostics": {},
        })

    monkeypatch.setattr(search_api.search_pipeline, "search", fake_search)
    app = FastAPI()
    app.include_router(search_api.router)

    response = TestClient(app).post(
        "/search/v2/events",
        json={"query": "ceiling light", "verify": True},
    )

    assert response.status_code == 200
    assert captured["verify"] is True


def test_search_pipeline_skips_vlm_verify_by_default_and_reports_query_plan() -> None:
    result, verify_candidates, events = run_search_pipeline_for_verify(verify=False)

    verify_candidates.assert_not_awaited()
    assert result.diagnostics["query_plan"] == {
        "variants": ["ceiling light", "downlight"],
        "query_expansion_source": "llm",
    }
    assert result.diagnostics["keyword_terms"] == ["ceiling", "light", "downlight"]
    assert result.diagnostics["keyword_plan"] == {
        "terms": ["ceiling", "light", "downlight"],
        "target": "Oracle Text",
        "max_terms": 20,
    }
    step_starts = [
        event["stepName"]
        for event in events
        if event.get("type") == "STEP_STARTED"
    ]
    assert step_starts[:7] == [
        "initialization",
        "query_variants",
        "keyword_plan",
        "embedding",
        "retrieval",
        "candidate_merge",
        "rerank",
    ]
    assert result.diagnostics["oracle_text_max_terms"] == 20
    assert result.diagnostics["candidate_merge"]["method"] == "weighted_rrf"
    assert result.diagnostics["candidate_merge"]["candidate_count"] == 1
    assert any(
        event.get("type") == "STATE_DELTA"
        and event.get("delta") == [{
            "op": "replace",
            "path": "/queryPlan",
            "value": result.diagnostics["query_plan"],
        }]
        for event in events
    )
    assert any(
        event.get("type") == "STATE_DELTA"
        and event.get("delta") == [{
            "op": "replace",
            "path": "/keywordPlan",
            "value": result.diagnostics["keyword_plan"],
        }]
        for event in events
    )


def test_search_pipeline_runs_vlm_verify_only_when_requested() -> None:
    _, verify_candidates, _ = run_search_pipeline_for_verify(verify=True)

    verify_candidates.assert_awaited_once()


def test_query_plan_uses_original_query_when_expansion_is_off() -> None:
    with (
        patch(
            "app.rag.search_pipeline.retrieval_service_settings.get_query_expansion",
            return_value=service_settings.QueryExpansionSettings(),
        ),
        patch("app.rag.search_pipeline.vlm_client.generate_json", new=AsyncMock()) as generate_json,
    ):
        plan = asyncio.run(_query_plan("請求書"))

    generate_json.assert_not_awaited()
    assert plan.query_expansion_source == "off"
    assert plan.variants == ["請求書"]


def test_query_plan_uses_rule_based_expansion_without_query_llm() -> None:
    with (
        patch(
            "app.rag.search_pipeline.retrieval_service_settings.get_query_expansion",
            return_value=service_settings.QueryExpansionSettings(enabled=True),
        ),
        patch("app.rag.search_pipeline.vlm_client.generate_json", new=AsyncMock()) as generate_json,
    ):
        plan = asyncio.run(_query_plan("請求書"))

    generate_json.assert_not_awaited()
    assert plan.query_expansion_source == "deterministic"
    assert plan.variants == ["請求書", "請求書 インボイス", "インボイス"]
    assert "invoice" not in " ".join(plan.variants)


def test_query_plan_uses_llm_variants() -> None:
    with (
        patch(
            "app.rag.search_pipeline.retrieval_service_settings.get_query_expansion",
            return_value=service_settings.QueryExpansionSettings(
                enabled=True, llm_enabled=True, llm_prompt="expand"
            ),
        ),
        patch(
            "app.rag.search_pipeline.vlm_client.generate_json",
            new=AsyncMock(return_value={"query_variants": ["downlight"]}),
        ) as generate_json,
    ):
        plan = asyncio.run(_query_plan("ceiling light"))

    generate_json.assert_awaited_once()
    assert generate_json.await_args.kwargs["prompt"].startswith("expand\n\n")
    assert plan.query_expansion_source == "llm"
    assert plan.variants == ["ceiling light", "downlight"]


def test_query_plan_falls_back_to_deterministic_when_llm_fails() -> None:
    with (
        patch(
            "app.rag.search_pipeline.retrieval_service_settings.get_query_expansion",
            return_value=service_settings.QueryExpansionSettings(
                enabled=True, llm_enabled=True, llm_prompt="expand"
            ),
        ),
        patch(
            "app.rag.search_pipeline.vlm_client.generate_json",
            new=AsyncMock(side_effect=RuntimeError("llm failed")),
        ),
    ):
        plan = asyncio.run(_query_plan("請求書"))

    assert plan.query_expansion_source == "deterministic"
    assert plan.variants == ["請求書", "請求書 インボイス", "インボイス"]


def test_query_expansion_settings_read_env_values() -> None:
    with patch.object(
        service_settings.RetrievalServiceSettingsStore,
        "_values",
        return_value={
            "RAG_QUERY_EXPANSION_ENABLED": "false",
            "RAG_QUERY_EXPANSION_LLM_ENABLED": "true",
            "RAG_QUERY_EXPANSION_MAX_VARIANTS": "99",
            "RAG_QUERY_EXPANSION_LLM_PROMPT": "expand",
            "RAG_QUERY_EXPANSION_SYNONYM_GROUPS": '[["浴室換気乾燥機","浴乾"],["200V"]]',
        },
    ):
        settings = service_settings.RetrievalServiceSettingsStore().get_query_expansion()

    assert settings.enabled is False
    assert settings.llm_enabled is True
    assert settings.max_variants == 8
    assert settings.llm_prompt == "expand"
    assert settings.synonym_groups == [["浴室換気乾燥機", "浴乾"]]


def run_search_pipeline_for_verify(
    *, verify: bool
) -> tuple[SearchV2Response, AsyncMock, list[dict[str, Any]]]:
    events: list[dict[str, Any]] = []

    async def progress(event: dict[str, Any]) -> None:
        events.append(event)

    with (
        patch(
            "app.rag.search_pipeline._query_plan",
            new=AsyncMock(return_value=QueryPlan(["ceiling light", "downlight"], "llm")),
        ),
        patch.dict("os.environ", {"ORACLE_TEXT_MAX_TERMS": "20"}),
        patch("app.rag.search_pipeline.embedding_client.query", new=AsyncMock(return_value=[[0.1]])),
        patch("app.rag.search_pipeline.profile_repository.enabled_profiles", return_value=[]),
        patch("app.rag.search_pipeline.pipeline_repository.enabled_recipes", return_value=[]),
        patch(
            "app.rag.search_pipeline.retrieval_service_settings.get_weights",
            return_value=RetrievalWeights(
                oracle_text=1,
                text_vector=0,
                visual_vector=0,
                vlm_text=0,
                vlm_vector=0,
            ),
        ),
        patch(
            "app.rag.search_pipeline.retrieval_service_settings.get_rerank",
            return_value=RerankSettings(enabled=False, candidate_count=1, top_n=1),
        ),
        patch("app.rag.search_pipeline.rag_repository.keyword_search", return_value=[retrieval_hit()]),
        patch("app.rag.search_pipeline.rag_repository.record_search_audit"),
        patch("app.rag.search_pipeline._verify_candidates", new=AsyncMock()) as verify_candidates,
    ):
        result = asyncio.run(SearchPipeline().search(
            query="ceiling light",
            top_k=1,
            field_filters=[],
            document_types=[],
            current_version_only=True,
            user_hash=None,
            verify=verify,
            progress=progress,
        ))
    return result, verify_candidates, events


def test_search_pipeline_runs_each_variant_as_own_route() -> None:
    events: list[dict[str, Any]] = []

    async def progress(event: dict[str, Any]) -> None:
        events.append(event)

    query_embeddings = AsyncMock(return_value=[[0.1], [0.2]])
    keyword_search = MagicMock(return_value=[])
    recipe_vector_search = MagicMock(return_value=[])
    variants = ["浴室換気乾燥機", "浴乾"]
    with (
        patch(
            "app.rag.search_pipeline._query_plan",
            new=AsyncMock(return_value=QueryPlan(variants, "llm")),
        ),
        patch("app.rag.search_pipeline.embedding_client.query", new=query_embeddings),
        patch("app.rag.search_pipeline.profile_repository.enabled_profiles", return_value=[]),
        patch(
            "app.rag.search_pipeline.pipeline_repository.enabled_recipes",
            return_value=[
                embedding_recipe("chunk_text", ("CHUNK_TEXT", None)),
                embedding_recipe("page_image", ("PAGE_IMAGE", None)),
            ],
        ),
        patch(
            "app.rag.search_pipeline.retrieval_service_settings.get_weights",
            return_value=RetrievalWeights(
                oracle_text=1,
                text_vector=1,
                visual_vector=1,
                vlm_text=0,
                vlm_vector=0,
            ),
        ),
        patch(
            "app.rag.search_pipeline.retrieval_service_settings.get_rerank",
            return_value=RerankSettings(enabled=False, candidate_count=10, top_n=5),
        ),
        patch("app.rag.search_pipeline.rag_repository.keyword_search", keyword_search),
        patch("app.rag.search_pipeline.rag_repository.recipe_vector_search", recipe_vector_search),
        patch("app.rag.search_pipeline.rag_repository.record_search_audit"),
    ):
        asyncio.run(SearchPipeline().search(
            query="浴室換気乾燥機",
            top_k=1,
            field_filters=[],
            document_types=[],
            current_version_only=True,
            user_hash=None,
            progress=progress,
        ))

    query_embeddings.assert_awaited_once_with(variants)
    assert sorted(call.kwargs["query"] for call in keyword_search.call_args_list) == sorted(variants)
    assert keyword_search.call_count == 2
    assert recipe_vector_search.call_count == 4
    retrieval = next(
        op["value"]
        for event in events
        for op in event.get("delta", [])
        if op.get("path") == "/retrievalSummary"
    )
    channels = retrieval["channels"]
    assert [item["weight"] for item in channels if item["channel"].startswith("keyword:page_text")] == [0.5, 0.5]
    assert [item["weight"] for item in channels if item["channel"].startswith("vector:chunk_text")] == [0.5, 0.5]
    assert [item["weight"] for item in channels if item["channel"].startswith("vector:page_image")] == [0.5, 0.5]


def test_vlm_route_weight_is_split_across_enabled_profiles() -> None:
    def run(profile_count: int) -> tuple[list[dict[str, Any]], int, int]:
        events: list[dict[str, Any]] = []

        async def progress(event: dict[str, Any]) -> None:
            events.append(event)

        profiles = [
            ProfileConfig(
                slot_no=slot,
                name=f"Profile {slot}",
                enabled=True,
                extraction_prompt="Extract facts",
                current_revision_id=f"r{slot}",
            )
            for slot in range(1, profile_count + 1)
        ]
        facet_keyword_search = MagicMock(return_value=[])
        recipe_vector_search = MagicMock(return_value=[])
        with (
            patch(
                "app.rag.search_pipeline._query_plan",
                new=AsyncMock(return_value=QueryPlan(["lighting"], "deterministic")),
            ),
            patch("app.rag.search_pipeline.embedding_client.query", new=AsyncMock(return_value=[[0.1]])),
            patch("app.rag.search_pipeline.profile_repository.enabled_profiles", return_value=profiles),
            patch(
                "app.rag.search_pipeline.pipeline_repository.enabled_recipes",
                return_value=[embedding_recipe("vlm_text_slot_1", ("VLM_TEXT", "1"))],
            ),
            patch(
                "app.rag.search_pipeline.retrieval_service_settings.get_weights",
                return_value=RetrievalWeights(
                    oracle_text=0,
                    text_vector=0,
                    visual_vector=0,
                    vlm_text=1,
                    vlm_vector=1,
                ),
            ),
            patch(
                "app.rag.search_pipeline.retrieval_service_settings.get_rerank",
                return_value=RerankSettings(enabled=False, candidate_count=10, top_n=5),
            ),
            patch("app.rag.search_pipeline.rag_repository.facet_keyword_search", facet_keyword_search),
            patch("app.rag.search_pipeline.rag_repository.recipe_vector_search", recipe_vector_search),
            patch("app.rag.search_pipeline.rag_repository.record_search_audit"),
        ):
            asyncio.run(SearchPipeline().search(
                query="lighting",
                top_k=1,
                field_filters=[],
                document_types=[],
                current_version_only=True,
                user_hash=None,
                progress=progress,
            ))

        retrieval = next(
            op["value"]
            for event in events
            for op in event.get("delta", [])
            if op.get("path") == "/retrievalSummary"
        )
        return retrieval["channels"], facet_keyword_search.call_count, recipe_vector_search.call_count

    channels, text_count, vector_count = run(2)
    assert text_count == 2
    assert vector_count == 1
    assert [item["weight"] for item in channels if item["channel"].startswith("keyword:vlm_text_slot")] == [0.5, 0.5]
    assert [item["weight"] for item in channels if item["channel"].startswith("vector:vlm_text_slot_1")] == [1]

    channels, text_count, vector_count = run(1)
    assert text_count == 1
    assert vector_count == 1
    assert [item["weight"] for item in channels if item["channel"].startswith("keyword:vlm_text_slot")] == [1]
    assert [item["weight"] for item in channels if item["channel"].startswith("vector:vlm_text_slot_1")] == [1]


def test_oracle_text_terms_default_and_env_limit(monkeypatch) -> None:
    query = " ".join(f"term{index}" for index in range(25))

    monkeypatch.delenv("ORACLE_TEXT_MAX_TERMS", raising=False)
    assert len(oracle_text_terms(query)) == 20

    monkeypatch.setenv("ORACLE_TEXT_MAX_TERMS", "3")
    assert oracle_text_terms(query) == ["term0", "term1", "term2"]


def test_profile_has_exactly_the_vlm_extraction_fields() -> None:
    profile = initial_profiles()[0]
    assert profile.slot_no == 1
    assert profile.enabled is True
    with pytest.raises(ValidationError):
        ProfileConfig(
            slot_no=1,
            name="Profile",
            enabled=True,
            extraction_prompt="Extract facts",
            scope_rules=[],
        )
    with pytest.raises(ValidationError):
        ProfileConfig(slot_no=4, name="Profile", extraction_prompt="Extract facts")


def test_default_profile_prompts_are_generic_japanese_by_slot() -> None:
    prompts = [profile.extraction_prompt for profile in initial_profiles()]
    assert prompts == [
        PROFILE_DOCUMENT_PAGE_PROMPT,
        PROFILE_SPEC_DATA_PROMPT,
        PROFILE_VISUAL_PROMPT,
    ]
    for prompt in prompts:
        assert "抽出" in prompt
        assert "\n- " in prompt
        assert not any(term in prompt for term in ("施工", "建築", "住宅", "顧客", "プラン"))


def test_global_vlm_prompts_keep_json_contract_keys() -> None:
    settings = GlobalVlmSettings()
    expansion = service_settings.QueryExpansionSettings()
    assert "\n- " in expansion.llm_prompt
    assert "\n- " in settings.verify_prompt
    assert "query_variants" in expansion.llm_prompt
    assert "intent" not in expansion.llm_prompt
    assert "確認不能ならverifiedをfalse" in settings.verify_prompt
    assert "推測や外部知識" in settings.verify_prompt
    for key in ("verified", "confidence", "evidence", "failed_constraints"):
        assert key in settings.verify_prompt


def test_legacy_vlm_verify_prompt_uses_improved_default() -> None:
    with patch.object(
        service_settings.RetrievalServiceSettingsStore,
        "_values",
        return_value={"VLM_VERIFY_PROMPT": LEGACY_VLM_VERIFY_PROMPT},
    ):
        settings = service_settings.RetrievalServiceSettingsStore().get_vlm()

    assert settings.verify_prompt == GlobalVlmSettings().verify_prompt
    assert settings.verify_prompt != LEGACY_VLM_VERIFY_PROMPT


def test_prompt_is_an_instruction_not_a_template() -> None:
    profile = initial_profiles()[0].model_copy(update={"extraction_prompt": "Use {{page_text}}"})
    assert validate_profile(profile) == ["extraction_prompt is an instruction, not a template"]


def test_profile_hash_changes_only_for_extraction_semantics() -> None:
    profile = initial_profiles()[0]
    assert profile_hash(profile) == profile_hash(
        profile.model_copy(update={"name": "Renamed", "enabled": False})
    )
    assert profile_hash(profile) != profile_hash(
        profile.model_copy(update={"extraction_prompt": "Extract different information"})
    )


def test_fixed_vlm_output_serializes_to_search_text() -> None:
    output = VlmExtractionOutput.model_validate(
        {
            "summary": "summary",
            "keywords": ["alpha", "alpha", "beta"],
            "facts": [{"text": "fact", "source_locator": "page:1", "confidence": 0.9}],
        }
    )
    assert output.keywords == ["alpha", "beta"]
    assert output.search_text() == "summary\nalpha beta\nfact"


def test_schema_uses_release_artifact_and_recipe_vector_model() -> None:
    ddl = schema_sql()
    assert "CREATE TABLE SDS_VLM_PROFILES" in ddl
    assert "CREATE TABLE SDS_STAGE_RUNS" in ddl
    assert "CREATE TABLE SDS_ARTIFACTS" in ddl
    assert "CREATE TABLE SDS_EMBEDDING_RECIPES" in ddl
    assert "CREATE TABLE SDS_EMBEDDINGS" in ddl
    assert "CREATE TABLE SDS_INDEX_RELEASES" in ddl
    assert "SDS_EMBEDDING_HNSW_IDX" in ddl
    assert "VECTOR(1536, FLOAT32)" in ddl
    assert "CREATE TABLE SDS_DOCUMENT_INDEX_RUNS" not in ddl
    assert "CREATE TABLE SDS_VLM_FACETS" not in ddl
    assert "SDS_PROFILE_SCOPE_RULES" not in ddl
    assert "SDS_FIELD_DEFINITIONS" not in ddl
    assert "SDS_PROFILE_DOCUMENT_RUNS" not in ddl
    assert all(name.startswith("SDS_") for name in system_table_names())


def test_schema_digest_ignores_initial_profile_seed_text() -> None:
    seed_prefixes = (
        "INSERT INTO SDS_VLM_",
        "UPDATE SDS_VLM_",
        "INSERT INTO SDS_EMBEDDING_RECIP",
        "UPDATE SDS_EMBEDDING_RECIP",
    )
    structural = [
        statement
        for statement in schema_statements()
        if not statement.startswith(seed_prefixes)
    ]
    assert schema_digest() == hashlib.sha256("\n\n".join(structural).encode()).hexdigest()
    assert len(structural) < len(schema_statements())


def test_ocr_defaults_remain_global() -> None:
    settings = OcrSettings()
    assert (settings.dots.dpi, settings.glm.dpi, settings.unlimited.dpi) == (200, 200, 300)


def test_ocr_global_and_glm_enabled_flags_are_separate(monkeypatch, tmp_path) -> None:
    for key in ("OCR_ENABLED", "DOTS_MOCR_ENABLED", "GLM_OCR_ENABLED", "UNLIMITED_OCR_ENABLED"):
        monkeypatch.setenv(key, "")
    monkeypatch.setattr(service_settings, "TARGET_ENV", tmp_path / ".env")
    monkeypatch.setattr(service_settings, "CHALLENGE_ENV", tmp_path / "challenge.env")
    engine = OcrEngineSettings(enabled=False, base_url="http://ocr.test", model="model")

    saved = service_settings.RetrievalServiceSettingsStore().save_ocr(
        OcrSettings(enabled=False, dots=engine, glm=engine.model_copy(update={"enabled": True}), unlimited=engine)
    )

    assert saved.enabled is False
    assert saved.dots.enabled is False
    assert saved.glm.enabled is True
    assert saved.unlimited.enabled is False
    text = (tmp_path / ".env").read_text()
    assert "OCR_ENABLED='false'" in text
    assert "GLM_OCR_ENABLED='true'" in text
    assert "DOTS_MOCR_ENABLED='false'" in text
    assert "UNLIMITED_OCR_ENABLED='false'" in text


def test_ocr_connection_test_sends_a_decodable_document_image() -> None:
    recognize = AsyncMock(return_value={"engine": "dots", "cells": [], "text": "test"})
    with patch("app.rag.settings_api.ocr_client.recognize", new=recognize):
        asyncio.run(run_ocr_test("dots"))

    with Image.open(BytesIO(recognize.await_args.kwargs["image"])) as image:
        image.load()
        assert image.size == (640, 128)


def test_only_pages_without_mineru_content_need_ocr() -> None:
    pages = [
        PageExtraction(page_number=number, native_text="native text" * 20)
        for number in range(1, 7)
    ]
    result = {
        "content_list": [
            {"page_idx": 0, "type": "text", "text": "x"},
            {"page_idx": 1, "type": "image"},
            {"page_idx": 2, "type": "equation", "equation": "x=1"},
            {"page_idx": 3, "type": "image", "image_caption": ["caption"]},
            {"page_idx": 4, "type": "image", "image_footnote": "footnote"},
        ]
    }
    for block in _mineru_blocks(result):
        pages[block.page_number - 1].mineru_blocks.append(block)

    assert [page.page_number for page in _mineru_missing_pages(pages)] == [2, 6]
    assert len(_mineru_missing_pages([PageExtraction(1), PageExtraction(2)])) == 2


def test_ocr_uses_the_first_complete_engine_and_keeps_dots_partial_as_last_resort() -> None:
    engine = OcrEngineSettings(enabled=True, base_url="http://ocr.test", model="model")
    settings = OcrSettings(enabled=True, dots=engine, glm=engine, unlimited=engine)

    dots = AsyncMock(return_value={
        "engine": "dots",
        "cells": [{"category": "Text", "text": "Dots text"}],
        "text": "Dots text",
    })
    first = PageExtraction(page_number=1, image=b"image")
    with (
        patch("app.rag.index_pipeline.retrieval_service_settings.get_ocr", return_value=settings),
        patch("app.rag.index_pipeline.ocr_client.recognize", new=dots),
    ):
        asyncio.run(_run_ocr(first, []))
    assert first.ocr_engine == "dots"
    assert [call.kwargs["engine"] for call in dots.await_args_list] == ["dots"]

    partial = {
        "engine": "dots",
        "cells": [
            {"category": "Picture"},
            {"category": "Caption", "text": "Partial caption"},
        ],
        "text": "Partial caption",
    }
    fallback = AsyncMock(side_effect=[partial, RuntimeError("glm down"), {
        "engine": "unlimited", "cells": [], "text": "",
    }])
    last = PageExtraction(page_number=2, image=b"image")
    degraded: list[str] = []
    with (
        patch("app.rag.index_pipeline.retrieval_service_settings.get_ocr", return_value=settings),
        patch("app.rag.index_pipeline.ocr_client.recognize", new=fallback),
    ):
        asyncio.run(_run_ocr(last, degraded))
    assert last.ocr_engine == "dots_partial"
    assert [call.kwargs["engine"] for call in fallback.await_args_list] == [
        "dots", "glm", "unlimited"
    ]
    assert degraded == ["ocr:dots_partial", "ocr:glm"]

    cold = AsyncMock(side_effect=[partial, RuntimeError("glm down"), {
        "engine": "unlimited", "cells": [], "text": "Unlimited text",
    }])
    recovered = PageExtraction(page_number=3, image=b"image")
    with (
        patch("app.rag.index_pipeline.retrieval_service_settings.get_ocr", return_value=settings),
        patch("app.rag.index_pipeline.ocr_client.recognize", new=cold),
    ):
        asyncio.run(_run_ocr(recovered, []))
    assert recovered.ocr_engine == "unlimited"


def test_profile_reuse_requires_the_current_shared_index_run() -> None:
    context = MagicMock()
    cursor = context.__enter__.return_value.cursor.return_value.__enter__.return_value
    cursor.fetchone.return_value = (1,)
    with patch.object(rag_repository, "connection", return_value=context):
        assert rag_repository.reusable_profile_run(
            document_id="document",
            profile=initial_profiles()[0].model_copy(update={"current_revision_id": "revision"}),
            index_run_id="current-index-run",
            content_sha256="content",
            config_hash="config",
        )

    sql, binds = cursor.execute.call_args.args
    assert "index_run_id=:index_run" in sql
    assert binds["index_run"] == "current-index-run"


def test_rrf_merges_shared_and_profile_hits_by_source_locator() -> None:
    shared = retrieval_hit()
    profile = retrieval_hit(slot=2, channel="vector:vlm_text_slot_2")
    ranked = _weighted_rrf([([shared], 1.0), ([profile], 1.0)])
    assert len(ranked) == 1
    assert ranked[0].profile_slots == {2}
    assert ranked[0].channels == {"keyword:page_text", "vector:vlm_text_slot_2"}


def test_rrf_preserves_channel_scores_and_image_similarity_prefers_pure_image() -> None:
    pure = retrieval_hit(channel="vector:page_image", score=0.81)
    combined = retrieval_hit(channel="vector:page_image_page_text", score=0.92)
    ranked = _weighted_rrf([([pure], 1.0), ([combined], 1.0)])

    assert ranked[0].channel_scores == {
        "vector:page_image": 0.81,
        "vector:page_image_page_text": 0.92,
    }
    assert _image_similarity_score(
        ranked[0],
        pure_image_channels={"vector:page_image"},
        image_channels={"vector:page_image", "vector:page_image_page_text"},
    ) == 0.81

    ranked[0].channel_scores.pop("vector:page_image")
    assert _image_similarity_score(
        ranked[0],
        pure_image_channels={"vector:page_image"},
        image_channels={"vector:page_image", "vector:page_image_page_text"},
    ) == 0.92


def test_image_sort_key_keeps_similarity_above_secondary_signals_and_missing_scores() -> None:
    channels = {"vector:page_image"}
    high = RankedHit(
        hit=retrieval_hit(document_id="high", score=0.988),
        rrf_score=0.01,
        rerank_score=0.1,
        channel_scores={"vector:page_image": 0.988},
        verification_status="unverified",
    )
    low = RankedHit(
        hit=retrieval_hit(document_id="low", score=0.579),
        rrf_score=1.0,
        rerank_score=0.99,
        channel_scores={"vector:page_image": 0.579},
        verification_status="verified",
    )
    missing = RankedHit(
        hit=retrieval_hit(document_id="missing"),
        rrf_score=2.0,
        rerank_score=1.0,
        verification_status="verified",
    )

    ranked = sorted(
        [missing, low, high],
        key=lambda item: _image_sort_key(
            item, pure_image_channels=channels, image_channels=channels
        ),
        reverse=True,
    )
    assert [item.hit.document_id for item in ranked] == ["high", "low", "missing"]


def test_pure_image_search_never_calls_text_rerank() -> None:
    candidate = RankedHit(hit=retrieval_hit(channel="vector:page_image"), rrf_score=1.0)
    with patch("app.rag.search_pipeline.rerank_client.rerank", new=AsyncMock()) as rerank:
        result = asyncio.run(_rerank_text("", [candidate], has_image=True))
    assert result == [candidate]
    rerank.assert_not_awaited()


def test_image_search_sorts_before_candidate_document_and_page_limits() -> None:
    recipes = [
        embedding_recipe("page_image", ("PAGE_IMAGE", None)),
        embedding_recipe(
            "page_image_page_text", ("PAGE_IMAGE", None), ("PAGE_TEXT", None)
        ),
    ]

    async def immediate_to_thread(
        function: Any, *args: object, **kwargs: object
    ) -> object:
        return function(*args, **kwargs)

    def run(candidate_count: int, top_k: int) -> SearchV2Response:
        def hit(
            *, document_id: str, page_number: int, score: float, channel: str
        ) -> RetrievalHit:
            return retrieval_hit(
                evidence_id=f"{document_id}-p{page_number}",
                document_id=document_id,
                page_number=page_number,
                file_name=f"{document_id}.pdf",
                object_name=f"{document_id}.pdf",
                asset_object_name=f"{document_id}_p{page_number}.png",
                channel=channel,
                score=score,
            )

        def vector_search(**kwargs: Any) -> list[RetrievalHit]:
            channel = kwargs["channel"]
            if kwargs["recipe_code"] == "page_image":
                return [
                    hit(document_id="high", page_number=1, score=0.988, channel=channel),
                    hit(document_id="high", page_number=2, score=0.7, channel=channel),
                    hit(document_id="low", page_number=1, score=0.579, channel=channel),
                ]
            return [hit(document_id="low", page_number=1, score=0.95, channel=channel)]

        with (
            patch(
                "app.rag.search_pipeline._query_plan",
                new=AsyncMock(return_value=QueryPlan([], "off")),
            ),
            patch(
                "app.rag.search_pipeline.embedding_client.image",
                new=AsyncMock(return_value=[0.1]),
            ),
            patch(
                "app.rag.search_pipeline.asyncio.to_thread",
                new=immediate_to_thread,
            ),
            patch("app.rag.search_pipeline.profile_repository.enabled_profiles", return_value=[]),
            patch(
                "app.rag.search_pipeline.pipeline_repository.enabled_recipes",
                return_value=recipes,
            ),
            patch(
                "app.rag.search_pipeline.retrieval_service_settings.get_weights",
                return_value=RetrievalWeights(
                    oracle_text=0,
                    text_vector=0,
                    visual_vector=1,
                    vlm_text=0,
                    vlm_vector=0,
                ),
            ),
            patch(
                "app.rag.search_pipeline.retrieval_service_settings.get_rerank",
                return_value=RerankSettings(
                    enabled=False, candidate_count=candidate_count, top_n=1
                ),
            ),
            patch(
                "app.rag.search_pipeline.rag_repository.recipe_vector_search",
                side_effect=vector_search,
            ),
            patch("app.rag.search_pipeline.rag_repository.record_search_audit"),
        ):
            return asyncio.run(
                SearchPipeline().search(
                    query="",
                    top_k=top_k,
                    field_filters=[],
                    document_types=[],
                    current_version_only=True,
                    user_hash=None,
                    image=b"image",
                )
            )

    limited = run(candidate_count=1, top_k=1)
    assert [item.document_id for item in limited.results] == ["high"]
    assert limited.results[0].image_similarity_score == 0.988

    complete = run(candidate_count=10, top_k=2)
    assert [item.document_id for item in complete.results] == ["high", "low"]
    assert [item.page_number for item in complete.results[0].evidence] == [1, 2]
    assert [item.image_similarity_score for item in complete.results[0].evidence] == [
        0.988,
        0.7,
    ]


def test_image_text_rerank_scores_all_candidates_without_pruning() -> None:
    candidates = [
        RankedHit(hit=retrieval_hit(document_id="high"), rrf_score=0.5),
        RankedHit(hit=retrieval_hit(document_id="low"), rrf_score=1.0),
    ]

    async def rerank(**kwargs: object) -> list[SimpleNamespace]:
        settings = kwargs["settings"]
        documents = kwargs["documents"]
        assert isinstance(settings, RerankSettings)
        assert isinstance(documents, list)
        assert settings.top_n == len(documents) == 2
        return [
            SimpleNamespace(index=1, score=0.99),
            SimpleNamespace(index=0, score=0.1),
        ]

    with (
        patch(
            "app.rag.search_pipeline.retrieval_service_settings.get_rerank",
            return_value=RerankSettings(enabled=True, candidate_count=2, top_n=1),
        ),
        patch("app.rag.search_pipeline.rerank_client.rerank", new=rerank),
    ):
        result = asyncio.run(_rerank_text("query", candidates, has_image=True))

    assert result == candidates
    assert [item.rerank_score for item in result] == [0.1, 0.99]


def test_rerank_candidate_is_text_json_only() -> None:
    candidate = RankedHit(hit=retrieval_hit(slot=1), rrf_score=1.0, profile_slots={1})
    payload = _candidate_text(candidate)
    assert "data:image" not in payload
    assert "image_url" not in payload
    assert "profile summary" in payload


def test_no_enabled_profile_still_reuses_shared_index_without_vlm() -> None:
    async def immediate_to_thread(function: Any, *args: object, **kwargs: object) -> object:
        return function(*args, **kwargs)

    page = EvidenceRecord(
        evidence_id="e1",
        document_id="d1",
        page_number=1,
        unit_kind="page",
        source_locator="page:1",
        raw_text="text",
        search_text="text",
    )
    mineru = MinerUSettings(enabled=False)
    ocr = OcrSettings(enabled=False)
    with (
        patch("app.rag.index_pipeline.asyncio.to_thread", new=immediate_to_thread),
        patch("app.rag.index_pipeline.oci_service.download_object", return_value=b"text"),
        patch("app.rag.index_pipeline.rag_repository.upsert_document", return_value=DocumentUpsertResult("d1", False, "hash", "txt")),
        patch("app.rag.index_pipeline.profile_repository.enabled_profiles", return_value=[]),
        patch("app.rag.index_pipeline.retrieval_service_settings.get_mineru", return_value=mineru),
        patch("app.rag.index_pipeline.retrieval_service_settings.get_ocr", return_value=ocr),
        patch("app.rag.index_pipeline.rag_repository.reusable_document_run", return_value="run1"),
        patch("app.rag.index_pipeline.rag_repository.serving_evidence", return_value=("run1", [page])),
        patch("app.rag.index_pipeline.rag_repository.set_document_status"),
        patch("app.rag.index_pipeline.vlm_client.generate_json", new=AsyncMock()) as vlm,
    ):
        outcome = asyncio.run(SharedIndexPipeline().index_object("source.txt"))
    assert outcome.matched_profiles == []
    assert outcome.page_count == 1
    vlm.assert_not_awaited()


def test_three_profiles_produce_three_independent_vlm_facets() -> None:
    evidence = [
        EvidenceRecord(
            evidence_id="e1",
            document_id="d1",
            page_number=1,
            unit_kind="page",
            source_locator="page:1",
            raw_text="text",
            search_text="text",
        )
    ]
    profiles = [profile.model_copy(update={"enabled": True}) for profile in initial_profiles()]
    response = {
        "summary": "summary",
        "keywords": ["keyword"],
        "facts": [{"text": "fact", "source_locator": "page:1", "confidence": 0.8}],
    }
    with (
        patch("app.rag.index_pipeline.vlm_client.generate_json", new=AsyncMock(return_value=response)) as vlm,
        patch("app.rag.index_pipeline.embedding_client.text", new=AsyncMock(return_value=[[0.1] * 1536])),
    ):
        async def run() -> list[list[object]]:
            return [
                await _build_profile_facets(
                    profile=profile,
                    object_name="source.pdf",
                    evidence=evidence,
                    page_images={1: b"image"},
                )
                for profile in profiles
            ]

        results = asyncio.run(run())
    assert [len(result) for result in results] == [1, 1, 1]
    assert vlm.await_count == 3


def test_profile_facets_report_progress_per_page() -> None:
    evidence = [
        EvidenceRecord(
            evidence_id=f"e{number}",
            document_id="d1",
            page_number=number,
            unit_kind="page",
            source_locator=f"page:{number}",
            raw_text="text",
            search_text="text",
        )
        for number in (1, 2, 3)
    ] + [
        EvidenceRecord(
            evidence_id="chunk",
            document_id="d1",
            page_number=None,
            unit_kind="chunk",
            source_locator="chunk:1",
            raw_text="text",
            search_text="text",
        )
    ]
    profile = initial_profiles()[0].model_copy(update={"enabled": True})
    response = {"summary": "summary", "keywords": [], "facts": []}
    calls: list[int] = []
    with (
        patch("app.rag.index_pipeline.vlm_client.generate_json", new=AsyncMock(return_value=response)),
        patch("app.rag.index_pipeline.embedding_client.text", new=AsyncMock(return_value=[[0.1] * 1536])),
    ):
        asyncio.run(
            _build_profile_facets(
                profile=profile,
                object_name="source.pdf",
                evidence=evidence,
                page_images={},
                on_page=lambda: calls.append(1),
            )
        )
    # ページ単位のevidenceのみカウント（chunkは対象外）
    assert len(calls) == 3


def test_rerank_defaults_to_oci_fast_model() -> None:
    settings = RerankSettings()
    assert settings.model == "cohere.rerank-v4.0-fast"
    assert (settings.candidate_count, settings.top_n) == (500, 30)
    assert set(settings.model_dump()) == {"enabled", "model", "candidate_count", "top_n"}


def test_rerank_batches_500_candidates_then_reranks_100_finalists() -> None:
    candidates = [RankedHit(hit=retrieval_hit(), rrf_score=1 / (index + 1)) for index in range(500)]
    batch_sizes: list[int] = []

    async def rerank(**kwargs: object) -> list[SimpleNamespace]:
        documents = kwargs["documents"]
        settings = kwargs["settings"]
        assert isinstance(documents, list)
        assert isinstance(settings, RerankSettings)
        batch_sizes.append(len(documents))
        return [
            SimpleNamespace(index=index, score=float(index))
            for index in range(min(len(documents), settings.top_n))
        ]

    with (
        patch("app.rag.search_pipeline.retrieval_service_settings.get_rerank", return_value=RerankSettings()),
        patch("app.rag.search_pipeline.rerank_client.rerank", new=rerank),
    ):
        result = asyncio.run(_rerank_text("query", candidates, has_image=False))

    assert batch_sizes == [100, 100, 100, 100, 100, 100]
    assert len(result) == 30
    assert all(item.rerank_score is not None for item in result)


def test_empty_rerank_response_falls_back_to_rrf() -> None:
    candidates = [RankedHit(hit=retrieval_hit(), rrf_score=1.0)]
    with (
        patch("app.rag.search_pipeline.retrieval_service_settings.get_rerank", return_value=RerankSettings()),
        patch("app.rag.search_pipeline.rerank_client.rerank", new=AsyncMock(return_value=[])),
    ):
        result = asyncio.run(_rerank_text("query", candidates, has_image=False))

    assert result == candidates
    assert result[0].rerank_score is None


def test_rerank_request_omits_optional_document_limits() -> None:
    captured: dict[str, object] = {}

    class Details:
        def __init__(self, **kwargs: object) -> None:
            captured.update(kwargs)

    models = SimpleNamespace(
        RerankTextDetails=Details,
        OnDemandServingMode=lambda **kwargs: kwargs,
    )
    response = SimpleNamespace(data=SimpleNamespace(document_ranks=[]))
    genai = SimpleNamespace(
        GenerativeAiInferenceClient=lambda _config: SimpleNamespace(
            rerank_text=lambda _details: response
        )
    )

    async def immediate(function: Any, *args: object, **kwargs: object) -> object:
        return function(*args, **kwargs)

    with (
        patch("app.rag.clients.oci_service.get_oci_config", return_value={"region": "us-chicago-1"}),
        patch("app.rag.clients.asyncio.to_thread", new=immediate),
        patch("app.rag.clients.importlib.import_module", side_effect=[genai, models]),
    ):
        result = asyncio.run(
            OciRerankClient().rerank(
                query="query",
                documents=["document"],
                settings=RerankSettings(),
            )
        )

    assert result == []
    assert set(captured) == {
        "input", "documents", "serving_mode", "compartment_id", "top_n", "is_echo"
    }
