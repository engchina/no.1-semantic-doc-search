from __future__ import annotations

import asyncio
import json
from io import BytesIO
from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
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
from app.rag.models import (
    OcrSettings,
    OcrEngineSettings,
    MinerUSettings,
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
from app.rag.oracle_schema import schema_sql, system_table_names
from app.rag.profile_validation import profile_hash, validate_profile
from app.rag.search_pipeline import (
    QueryPlan,
    RankedHit,
    SearchPipeline,
    _candidate_text,
    _query_plan,
    _rerank_text,
    _weighted_rrf,
)
from app.rag.settings_api import test_ocr as run_ocr_test


def retrieval_hit(*, slot: int = 0, channel: str = "oracle_text") -> RetrievalHit:
    return RetrievalHit(
        evidence_id="e1",
        document_id="d1",
        slot_no=slot,
        revision_id="r1" if slot else "",
        page_number=1,
        unit_kind="page",
        source_locator="page:1",
        bbox=None,
        raw_text="source text",
        caption="profile summary" if slot else "",
        asset_object_name="asset/page.png",
        file_name="source.pdf",
        object_name="source.pdf",
        bucket="bucket",
        score=0.8,
        channel=channel,
    )


def sse_events(text: str) -> list[dict[str, Any]]:
    return [
        json.loads(line.removeprefix("data: "))
        for line in text.splitlines()
        if line.startswith("data: ")
    ]


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
    events = sse_events(response.text)
    types = [event["type"] for event in events]
    assert types[:2] == ["RUN_STARTED", "STATE_SNAPSHOT"]
    assert "STEP_STARTED" in types
    assert types[-2:] == ["STATE_DELTA", "RUN_FINISHED"]
    assert events[-1]["result"]["trace_id"] == "trace"


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
        "intent": "lighting",
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
        "query_plan",
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


def test_query_plan_uses_deterministic_expansion_by_default() -> None:
    with (
        patch(
            "app.rag.search_pipeline.retrieval_service_settings.get_query_expansion",
            return_value=service_settings.QueryExpansionSettings(),
        ),
        patch("app.rag.search_pipeline.vlm_client.generate_json", new=AsyncMock()) as generate_json,
    ):
        plan = asyncio.run(_query_plan("請求書"))

    generate_json.assert_not_awaited()
    assert plan.query_expansion_source == "deterministic"
    assert plan.variants == ["請求書", "請求書 インボイス invoice bill", "インボイス invoice bill"]


def test_query_plan_uses_llm_only_when_enabled() -> None:
    with (
        patch(
            "app.rag.search_pipeline.retrieval_service_settings.get_query_expansion",
            return_value=service_settings.QueryExpansionSettings(llm_enabled=True),
        ),
        patch(
            "app.rag.search_pipeline.retrieval_service_settings.get_vlm",
            return_value=GlobalVlmSettings(query_prompt="expand"),
        ),
        patch(
            "app.rag.search_pipeline.vlm_client.generate_json",
            new=AsyncMock(return_value={"query_variants": ["downlight"], "intent": "lighting"}),
        ) as generate_json,
    ):
        plan = asyncio.run(_query_plan("ceiling light"))

    generate_json.assert_awaited_once()
    assert plan.query_expansion_source == "llm"
    assert plan.intent == "lighting"
    assert plan.variants == ["ceiling light", "downlight"]


def test_query_plan_falls_back_to_deterministic_when_llm_fails() -> None:
    with (
        patch(
            "app.rag.search_pipeline.retrieval_service_settings.get_query_expansion",
            return_value=service_settings.QueryExpansionSettings(llm_enabled=True),
        ),
        patch(
            "app.rag.search_pipeline.retrieval_service_settings.get_vlm",
            return_value=GlobalVlmSettings(query_prompt="expand"),
        ),
        patch(
            "app.rag.search_pipeline.vlm_client.generate_json",
            new=AsyncMock(side_effect=RuntimeError("llm failed")),
        ),
    ):
        plan = asyncio.run(_query_plan("請求書"))

    assert plan.query_expansion_source == "deterministic"
    assert plan.variants == ["請求書", "請求書 インボイス invoice bill", "インボイス invoice bill"]


def test_query_expansion_settings_read_env_values() -> None:
    with patch.object(
        service_settings.RetrievalServiceSettingsStore,
        "_values",
        return_value={
            "RAG_QUERY_EXPANSION_ENABLED": "false",
            "RAG_QUERY_EXPANSION_LLM_ENABLED": "true",
            "RAG_QUERY_EXPANSION_MAX_VARIANTS": "99",
        },
    ):
        settings = service_settings.RetrievalServiceSettingsStore().get_query_expansion()

    assert settings.enabled is False
    assert settings.llm_enabled is True
    assert settings.max_variants == 8


def run_search_pipeline_for_verify(
    *, verify: bool
) -> tuple[SearchV2Response, AsyncMock, list[dict[str, Any]]]:
    events: list[dict[str, Any]] = []

    async def progress(event: dict[str, Any]) -> None:
        events.append(event)

    with (
        patch(
            "app.rag.search_pipeline._query_plan",
            new=AsyncMock(return_value=QueryPlan(["ceiling light", "downlight"], "lighting", "llm")),
        ),
        patch.dict("os.environ", {"ORACLE_TEXT_MAX_TERMS": "20"}),
        patch("app.rag.search_pipeline.embedding_client.text", new=AsyncMock(return_value=[[0.1]])),
        patch("app.rag.search_pipeline.profile_repository.enabled_profiles", return_value=[]),
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
        patch(
            "app.rag.search_pipeline.retrieval_service_settings.get_vlm",
            return_value=GlobalVlmSettings(verify_enabled=True),
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


def test_schema_separates_shared_evidence_and_vlm_facets() -> None:
    ddl = schema_sql()
    assert "CREATE TABLE SDS_VLM_PROFILES" in ddl
    assert "CREATE TABLE SDS_DOCUMENT_INDEX_RUNS" in ddl
    assert "CREATE TABLE SDS_VLM_FACETS" in ddl
    assert "SDS_VLM_FACET_TEXT_HNSW_IDX" in ddl
    assert "SDS_EVIDENCE_VISUAL_HNSW_IDX" in ddl
    assert "SDS_PROFILE_SCOPE_RULES" not in ddl
    assert "SDS_FIELD_DEFINITIONS" not in ddl
    assert "SDS_PROFILE_DOCUMENT_RUNS" not in ddl
    assert all(name.startswith("SDS_") for name in system_table_names())


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
    profile = retrieval_hit(slot=2, channel="vlm_profile_2_vector")
    ranked = _weighted_rrf([([shared], 1.0), ([profile], 1.0)])
    assert len(ranked) == 1
    assert ranked[0].profile_slots == {2}
    assert ranked[0].channels == {"oracle_text", "vlm_profile_2_vector"}


def test_pure_image_search_never_calls_text_rerank() -> None:
    candidate = RankedHit(hit=retrieval_hit(channel="visual_vector"), rrf_score=1.0)
    with patch("app.rag.search_pipeline.rerank_client.rerank", new=AsyncMock()) as rerank:
        result = asyncio.run(_rerank_text("", [candidate], has_image=True))
    assert result == [candidate]
    rerank.assert_not_awaited()


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
