from __future__ import annotations

import asyncio
import hashlib
import json
import re
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field

from app.rag.clients import embedding_client, rerank_client, vlm_client
from app.rag.models import (
    DocumentSearchResult,
    EvidenceResult,
    FieldFilter,
    SearchV2Response,
)
from app.rag.oracle_repository import (
    RetrievalHit,
    oracle_text_max_terms,
    oracle_text_terms,
    rag_repository,
)
from app.rag.profile_repository import profile_repository
from app.rag.service_settings import retrieval_service_settings
from app.services.oci_service import oci_service

RERANK_BATCH_SIZE = 100
RERANK_FINALIST_COUNT = 100
WHITESPACE_PATTERN = re.compile(r"\s+")
SYNONYM_GROUPS: tuple[tuple[str, ...], ...] = (
    ("請求書", "インボイス", "invoice", "bill"),
    ("伝票", "document", "voucher"),
    ("経費", "費用", "expense", "cost"),
    ("申請", "申込", "request", "application"),
    ("承認", "承認者", "approve", "approval"),
    ("保管", "保存", "格納", "storage", "archive"),
    ("原本", "原紙", "original"),
    ("規程", "規則", "ポリシー", "policy"),
    ("手順", "手順書", "マニュアル", "manual", "procedure"),
    ("検索", "探索", "search", "retrieval"),
    ("表", "表形式", "テーブル", "table"),
    ("図", "図版", "画像", "figure", "image"),
    ("支払", "支払い", "payment"),
    ("期限", "期日", "due date", "deadline"),
)


@dataclass
class QueryPlan:
    variants: list[str]
    intent: str = "general"
    query_expansion_source: str = "off"


class _QueryOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query_variants: list[str] = Field(default_factory=list, max_length=8)
    intent: str = Field(default="general", max_length=80)


class _VerifyOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    verified: bool
    confidence: float = Field(ge=0, le=1)
    evidence: list[str] = Field(default_factory=list)
    failed_constraints: list[str] = Field(default_factory=list)


@dataclass
class RankedHit:
    hit: RetrievalHit
    rrf_score: float
    profile_slots: set[int] = field(default_factory=set)
    channels: set[str] = field(default_factory=set)
    rerank_score: float | None = None
    channel_ranks: dict[str, int] = field(default_factory=dict)
    text_rerank_rank: int | None = None
    verification_status: str = "not_requested"


def _normalize_query(query: str) -> str:
    return WHITESPACE_PATTERN.sub(" ", query).strip()


def _dedupe_strings(values: list[str]) -> list[str]:
    seen: set[str] = set()
    unique: list[str] = []
    for value in values:
        normalized = _normalize_query(value)
        key = normalized.casefold()
        if normalized and key not in seen:
            seen.add(key)
            unique.append(normalized)
    return unique


def _matching_expansions(query: str) -> list[str]:
    lowered = query.casefold()
    expansions: list[str] = []
    for group in SYNONYM_GROUPS:
        if not any(term.casefold() in lowered for term in group):
            continue
        for term in group:
            if term.casefold() not in lowered and term not in expansions:
                expansions.append(term)
    return expansions


def _deterministic_query_variants(query: str, *, enabled: bool, max_variants: int) -> list[str]:
    normalized = _normalize_query(query)
    if not normalized:
        return []
    if not enabled or max_variants <= 1:
        return [normalized]
    expansions = _matching_expansions(normalized)
    if not expansions:
        return [normalized]
    return _dedupe_strings([
        normalized,
        f"{normalized} {' '.join(expansions)}",
        " ".join(expansions),
    ])[:max_variants]


async def _query_plan(query: str) -> QueryPlan:
    expansion = retrieval_service_settings.get_query_expansion()
    fallback_variants = _deterministic_query_variants(
        query,
        enabled=expansion.enabled,
        max_variants=expansion.max_variants,
    )
    source = "deterministic" if query.strip() and expansion.enabled else "off"
    fallback = QueryPlan(variants=fallback_variants, query_expansion_source=source)
    if not fallback_variants or not expansion.llm_enabled:
        return fallback
    vlm_settings = retrieval_service_settings.get_vlm()
    prompt = f"{vlm_settings.query_prompt}\n\nUser query:\n{query}"
    try:
        output = _QueryOutput.model_validate(await vlm_client.generate_json(prompt=prompt))
    except Exception:
        return fallback
    variants = _dedupe_strings([query, *output.query_variants])[:expansion.max_variants]
    return QueryPlan(
        variants=variants or fallback_variants,
        intent=output.intent,
        query_expansion_source="llm" if variants else source,
    )


def _weighted_rrf(
    ranked_lists: list[tuple[list[RetrievalHit], float]], constant: int = 60
) -> list[RankedHit]:
    fused: dict[str, RankedHit] = {}
    for ranked, weight in ranked_lists:
        if weight <= 0:
            continue
        for rank, hit in enumerate(ranked, start=1):
            key = hit.canonical_key
            item = fused.setdefault(key, RankedHit(hit=hit, rrf_score=0.0))
            item.rrf_score += weight / (constant + rank)
            if hit.slot_no:
                item.profile_slots.add(hit.slot_no)
            item.channels.add(hit.channel)
            item.channel_ranks[hit.channel] = min(rank, item.channel_ranks.get(hit.channel, rank))
            if len(hit.raw_text) > len(item.hit.raw_text):
                item.hit.raw_text = hit.raw_text
            if hit.caption and not item.hit.caption:
                item.hit.caption = hit.caption
    return sorted(fused.values(), key=lambda item: item.rrf_score, reverse=True)


def _cross_profile_rrf(
    profile_lists: list[tuple[list[RankedHit], float]], constant: int = 60
) -> list[RankedHit]:
    """Compatibility helper; runtime fusion now happens once across all global routes."""
    fused: dict[str, RankedHit] = {}
    for ranked, weight in profile_lists:
        for rank, item in enumerate(ranked, start=1):
            current = fused.setdefault(item.hit.canonical_key, item)
            if current is not item:
                current.rrf_score += weight / (constant + rank)
                current.profile_slots.update(item.profile_slots)
                current.channels.update(item.channels)
    return sorted(fused.values(), key=lambda item: item.rrf_score, reverse=True)


def _candidate_text(item: RankedHit) -> str:
    return json.dumps(
        {
            "file_name": item.hit.file_name,
            "page_number": item.hit.page_number,
            "source_locator": item.hit.source_locator,
            "text": item.hit.raw_text[:6000],
            "vlm_summary": item.hit.caption[:2000],
            "vlm_profile_slots": sorted(item.profile_slots),
            "retrieval_channels": sorted(item.channels),
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )


async def _rerank_text(
    query: str, candidates: list[RankedHit], *, has_image: bool
) -> list[RankedHit]:
    if not query.strip() or not candidates:
        return candidates
    settings = retrieval_service_settings.get_rerank()
    if not settings.enabled:
        return candidates
    selected = candidates[: settings.candidate_count]

    async def rank(items: list[RankedHit]) -> list[tuple[RankedHit, float]]:
        ranks = await rerank_client.rerank(
            query=query,
            documents=[_candidate_text(item) for item in items],
            settings=settings,
        )
        return [(items[result.index], result.score) for result in ranks]

    try:
        batch_scores = []
        for start in range(0, len(selected), RERANK_BATCH_SIZE):
            batch_scores.extend(await rank(selected[start:start + RERANK_BATCH_SIZE]))
        if not batch_scores:
            return candidates
        finalists = [
            item
            for item, _ in sorted(batch_scores, key=lambda result: result[1], reverse=True)[
                : RERANK_FINALIST_COUNT
            ]
        ]
        final_scores = await rank(finalists) if len(selected) > RERANK_BATCH_SIZE else batch_scores
        if not final_scores:
            return candidates
    except Exception:
        return candidates

    reranked = sorted(final_scores, key=lambda result: result[1], reverse=True)[: settings.top_n]
    for rank, (item, score) in enumerate(reranked, start=1):
        item.rerank_score = score
        item.text_rerank_rank = rank
    ranked_items = [item for item, _ in reranked]
    if has_image:
        original = {item.hit.canonical_key: rank for rank, item in enumerate(selected, 1)}
        text_rank = {item.hit.canonical_key: rank for rank, item in enumerate(ranked_items, 1)}
        ranked_items.sort(
            key=lambda item: (
                1 / (60 + min(
                    (
                        rank
                        for channel, rank in item.channel_ranks.items()
                        if channel == "visual_vector"
                    ),
                    default=original[item.hit.canonical_key],
                ))
                + 1 / (60 + text_rank[item.hit.canonical_key])
            ),
            reverse=True,
        )
    return ranked_items


async def _verify_candidates(
    query: str,
    candidates: list[RankedHit],
    query_image: bytes | None,
    query_image_media_type: str,
    progress: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
) -> None:
    settings = retrieval_service_settings.get_vlm()
    if not settings.verify_enabled:
        return
    verifiable = [item for item in candidates[:20] if item.hit.asset_object_name]
    total = len(verifiable)
    for index, item in enumerate(verifiable, 1):
        if progress:
            await progress({
                "type": "STATE_DELTA",
                "delta": [
                    {"op": "replace", "path": "/status", "value": "verify"},
                    {
                        "op": "replace",
                        "path": "/message",
                        "value": f"VLM確認 {index}/{total}（時間がかかります）",
                    },
                ],
            })
        try:
            image = await asyncio.to_thread(
                oci_service.download_object, item.hit.asset_object_name
            )
            if not image:
                raise RuntimeError("candidate image is unavailable")
            prompt = (
                f"{settings.verify_prompt}\n\n"
                f"User query: {query}\n"
                f"Candidate context: {_candidate_text(item)}"
            )
            images = [(image, "image/png")]
            if query_image is not None:
                prompt += "\nImage 1 is the query reference. Image 2 is the candidate."
                images = [(query_image, query_image_media_type), (image, "image/png")]
            result = _VerifyOutput.model_validate(
                await vlm_client.generate_json(prompt=prompt, images=images)
            )
            item.verification_status = "verified" if result.verified else "unverified"
        except Exception:
            item.verification_status = "failed"


class SearchPipeline:
    async def search(
        self,
        *,
        query: str,
        top_k: int,
        field_filters: list[FieldFilter],
        document_types: list[str],
        current_version_only: bool,
        user_hash: str | None,
        filename_filter: str | None = None,
        image: bytes | None = None,
        image_media_type: str = "image/png",
        verify: bool = False,
        debug: bool = False,
        progress: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
    ) -> SearchV2Response:
        async def step(name: str, message: str):
            if not progress:
                return
            await progress({"type": "STEP_STARTED", "stepName": name, "message": message})
            await progress({
                "type": "STATE_DELTA",
                "delta": [
                    {"op": "replace", "path": "/status", "value": name},
                    {"op": "replace", "path": "/message", "value": message},
                ],
            })

        async def finish_step(name: str):
            if progress:
                await progress({"type": "STEP_FINISHED", "stepName": name})

        if field_filters:
            raise ValueError("field_filters are not configured; use text or filename filters")
        started = time.perf_counter()
        trace_id = uuid4().hex
        await step("query_plan", "検索意図を整理しています")
        profiles = profile_repository.enabled_profiles()
        plan = await _query_plan(query)
        await finish_step("query_plan")

        await step("query_variants", "検索バリエーションを生成しています")
        query_text = " ".join(plan.variants)
        query_plan = {
            "variants": plan.variants,
            "intent": plan.intent,
            "query_expansion_source": plan.query_expansion_source,
        }
        if progress:
            await progress({
                "type": "STATE_DELTA",
                "delta": [{"op": "replace", "path": "/queryPlan", "value": query_plan}],
            })
        await finish_step("query_variants")

        await step("keyword_plan", "検索キーワードを生成しています")
        keyword_terms = oracle_text_terms(query_text)
        keyword_plan = {
            "terms": keyword_terms,
            "target": "Oracle Text",
            "max_terms": oracle_text_max_terms(),
        }
        if progress:
            await progress({
                "type": "STATE_DELTA",
                "delta": [{"op": "replace", "path": "/keywordPlan", "value": keyword_plan}],
            })
        await finish_step("keyword_plan")

        degraded: list[str] = []
        await step("embedding", "検索ベクトルを作成しています")
        query_embedding: list[float] | None = None
        if query.strip():
            try:
                query_embedding = (await embedding_client.text([query]))[0]
            except Exception:
                degraded.append("text_embedding")
        image_embedding: list[float] | None = None
        if image is not None:
            try:
                image_embedding = await embedding_client.image(image, image_media_type)
            except Exception:
                degraded.append("visual_embedding")
        await finish_step("embedding")

        await step("retrieval", "複数チャンネルから候補を取得しています")
        weights = retrieval_service_settings.get_weights()
        rerank_settings = retrieval_service_settings.get_rerank()
        branch_k = max(rerank_settings.candidate_count, min(500, top_k * 5))
        tasks: list[tuple[str, float, Any]] = []

        if query_text and weights.oracle_text > 0:
            tasks.append(
                (
                    "oracle_text",
                    weights.oracle_text,
                    asyncio.to_thread(
                        rag_repository.keyword_search,
                        query=query_text,
                        top_k=branch_k,
                        user_hash=user_hash,
                        current_version_only=current_version_only,
                        document_types=document_types,
                        filename_filter=filename_filter,
                    ),
                )
            )
        if query_embedding is not None and weights.text_vector > 0:
            tasks.append(
                (
                    "text_vector",
                    weights.text_vector,
                    asyncio.to_thread(
                        rag_repository.vector_search,
                        embedding=query_embedding,
                        column="text_embedding",
                        channel="text_vector",
                        top_k=branch_k,
                        user_hash=user_hash,
                        current_version_only=current_version_only,
                        document_types=document_types,
                        filename_filter=filename_filter,
                    ),
                )
            )
        visual_query = image_embedding or query_embedding
        if visual_query is not None and weights.visual_vector > 0:
            tasks.append(
                (
                    "visual_vector",
                    weights.visual_vector,
                    asyncio.to_thread(
                        rag_repository.vector_search,
                        embedding=visual_query,
                        column="visual_embedding",
                        channel="visual_vector",
                        top_k=branch_k,
                        user_hash=user_hash,
                        current_version_only=current_version_only,
                        document_types=document_types,
                        filename_filter=filename_filter,
                    ),
                )
            )
        for profile in profiles:
            if query_text and weights.vlm_text > 0:
                tasks.append(
                    (
                        f"vlm_profile_{profile.slot_no}_text",
                        weights.vlm_text,
                        asyncio.to_thread(
                            rag_repository.facet_keyword_search,
                            profile=profile,
                            query=query_text,
                            top_k=branch_k,
                            user_hash=user_hash,
                            current_version_only=current_version_only,
                            document_types=document_types,
                            filename_filter=filename_filter,
                        ),
                    )
                )
            if query_embedding is not None and weights.vlm_vector > 0:
                tasks.append(
                    (
                        f"vlm_profile_{profile.slot_no}_vector",
                        weights.vlm_vector,
                        asyncio.to_thread(
                            rag_repository.facet_vector_search,
                            profile=profile,
                            embedding=query_embedding,
                            top_k=branch_k,
                            user_hash=user_hash,
                            current_version_only=current_version_only,
                            document_types=document_types,
                            filename_filter=filename_filter,
                        ),
                    )
                )
        raw_results = await asyncio.gather(
            *(task for _, _, task in tasks), return_exceptions=True
        )
        ranked_lists: list[tuple[list[RetrievalHit], float]] = []
        channel_summaries: list[dict[str, object]] = []
        for (channel, weight, _), result in zip(tasks, raw_results):
            if isinstance(result, list):
                ranked_lists.append((result, weight))
                channel_summaries.append({
                    "channel": channel,
                    "status": "ok",
                    "count": len(result),
                    "weight": weight,
                })
            else:
                degraded.append(channel)
                channel_summaries.append({
                    "channel": channel,
                    "status": "failed",
                    "count": 0,
                    "weight": weight,
                })
        retrieval_summary = {
            "channels": channel_summaries,
            "document_types": document_types,
            "current_version_only": current_version_only,
            "filename_filter": filename_filter,
        }
        if progress:
            await progress({
                "type": "STATE_DELTA",
                "delta": [{"op": "replace", "path": "/retrievalSummary", "value": retrieval_summary}],
            })
        await finish_step("retrieval")

        await step("candidate_merge", "候補を統合しています")
        candidates = _weighted_rrf(ranked_lists)[: rerank_settings.candidate_count]
        candidate_merge = {
            "method": "weighted_rrf",
            "source_lists": len(ranked_lists),
            "candidate_count": len(candidates),
            "limit": rerank_settings.candidate_count,
        }
        if progress:
            await progress({
                "type": "STATE_DELTA",
                "delta": [{"op": "replace", "path": "/candidateMerge", "value": candidate_merge}],
            })
        await finish_step("candidate_merge")

        await step("rerank", "候補を再ランキングしています")
        pre_rerank_document_ids = list(dict.fromkeys(item.hit.document_id for item in candidates))[
            : rerank_settings.candidate_count
        ]
        pre_rerank_count = len(candidates)
        candidates = await _rerank_text(query, candidates, has_image=image is not None)
        if (
            query.strip()
            and candidates
            and rerank_settings.enabled
            and not any(item.rerank_score is not None for item in candidates)
        ):
            degraded.append("rerank")
        rerank_summary = {
            "enabled": rerank_settings.enabled,
            "skipped": bool(image is not None and not query.strip()),
            "candidate_count": pre_rerank_count,
            "top_n": rerank_settings.top_n,
            "degraded": "rerank" in degraded,
        }
        if progress:
            await progress({
                "type": "STATE_DELTA",
                "delta": [{"op": "replace", "path": "/rerankSummary", "value": rerank_summary}],
            })
        await finish_step("rerank")

        vlm_settings = retrieval_service_settings.get_vlm()
        vlm_verify_active = verify and vlm_settings.verify_enabled
        if vlm_verify_active:
            await step("verify", "VLMで候補を確認しています（時間がかかります）")
            await _verify_candidates(query, candidates, image, image_media_type, progress)
            await finish_step("verify")

        await step("format_results", "検索結果を整形しています")
        candidates.sort(
            key=lambda item: (
                item.verification_status == "verified",
                item.rerank_score if item.rerank_score is not None else item.rrf_score,
            ),
            reverse=True,
        )
        documents: dict[str, list[RankedHit]] = defaultdict(list)
        for item in candidates:
            if len(documents[item.hit.document_id]) < 3:
                documents[item.hit.document_id].append(item)
        ranked_documents = sorted(
            documents.values(),
            key=lambda values: values[0].rerank_score
            if values[0].rerank_score is not None
            else values[0].rrf_score,
            reverse=True,
        )[:top_k]
        results: list[DocumentSearchResult] = []
        for values in ranked_documents:
            first = values[0]
            evidence = [
                EvidenceResult(
                    evidence_id=item.hit.evidence_id,
                    document_id=item.hit.document_id,
                    profile_slots=sorted(item.profile_slots),
                    page_number=item.hit.page_number,
                    unit_kind=item.hit.unit_kind,
                    source_locator=item.hit.source_locator,
                    bbox=item.hit.bbox,
                    text_excerpt=item.hit.raw_text[:500],
                    caption=item.hit.caption[:500],
                    asset_url=item.hit.asset_object_name,
                    score=item.rrf_score,
                    rerank_score=item.rerank_score,
                    visual_rank=item.channel_ranks.get("visual_vector"),
                    text_rerank_rank=item.text_rerank_rank,
                    retrieval_channels=sorted(item.channels),
                    verification_status=item.verification_status,  # type: ignore[arg-type]
                    match_reasons=sorted(item.channels),
                )
                for item in values
            ]
            results.append(
                DocumentSearchResult(
                    document_id=first.hit.document_id,
                    file_name=first.hit.file_name,
                    object_name=first.hit.object_name,
                    bucket=first.hit.bucket,
                    score=first.rerank_score if first.rerank_score is not None else first.rrf_score,
                    profile_slots=sorted(set().union(*(item.profile_slots for item in values))),
                    evidence=evidence,
                )
            )
        format_summary = {
            "total_documents": len(results),
            "total_evidence": sum(len(result.evidence) for result in results),
        }
        if progress:
            await progress({
                "type": "STATE_DELTA",
                "delta": [{"op": "replace", "path": "/formatSummary", "value": format_summary}],
            })
        elapsed = time.perf_counter() - started
        diagnostics: dict[str, Any] = {
            "enabled_vlm_profiles": [profile.slot_no for profile in profiles],
            "retrieval_channels": [channel for channel, _, _ in tasks],
            "pure_image_rerank_skipped": bool(image is not None and not query.strip()),
            "degraded": sorted(set(degraded)),
            "query_plan": query_plan,
            "keyword_terms": keyword_terms,
            "keyword_plan": keyword_plan,
            "oracle_text_max_terms": keyword_plan["max_terms"],
            "retrieval_summary": retrieval_summary,
            "candidate_merge": candidate_merge,
            "rerank_summary": rerank_summary,
            "format_summary": format_summary,
            "vlm_verify_requested": verify,
            "vlm_verify_enabled": vlm_settings.verify_enabled,
        }
        if debug:
            diagnostics.update(
                candidate_count=len(candidates),
                pre_rerank_document_ids=pre_rerank_document_ids,
            )
        await asyncio.to_thread(
            rag_repository.record_search_audit,
            trace_id=trace_id,
            query_hash=hashlib.sha256(query.encode()).hexdigest(),
            user_hash=user_hash,
            profile_slots=[profile.slot_no for profile in profiles],
            diagnostics=diagnostics,
            result_count=len(results),
            elapsed_ms=round(elapsed * 1000),
        )
        await finish_step("format_results")
        return SearchV2Response(
            trace_id=trace_id,
            query=query,
            results=results,
            total_documents=len(results),
            total_evidence=sum(len(result.evidence) for result in results),
            processing_time=elapsed,
            diagnostics=diagnostics,
        )


def principal_hash(value: str | None) -> str | None:
    return hashlib.sha256(value.encode()).hexdigest() if value else None


search_pipeline = SearchPipeline()
