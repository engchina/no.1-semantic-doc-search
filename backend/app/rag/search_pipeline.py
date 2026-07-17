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
from app.rag.pipeline_repository import pipeline_repository
from app.rag.profile_repository import profile_repository
from app.rag.service_settings import retrieval_service_settings
from app.services.oci_service import oci_service

RERANK_BATCH_SIZE = 100
RERANK_FINALIST_COUNT = 100
WHITESPACE_PATTERN = re.compile(r"\s+")
UPLOAD_PREFIX_PATTERN = re.compile(r"^\d{8}_\d{6}_[0-9a-f]{8}_")
FILENAME_AFFINITY_THRESHOLD = 0.4
FILENAME_AFFINITY_WEIGHT = 0.15


def _filename_affinity(query: str, file_name: str) -> float:
    """クエリが文書名をどれだけ含むか（ファイル名stemの3-gram被覆率）。

    「2026年4月版の戸建アイテムカタログで…」のように文書名を明示した質問で、
    類似コンテンツを持つ別カタログよりも名指しされた文書を優先するための信号。
    """
    stem = UPLOAD_PREFIX_PATTERN.sub("", file_name).rsplit(".", 1)[0].casefold()
    grams = [stem[i : i + 3] for i in range(len(stem) - 2)]
    if not grams:
        return 0.0
    lowered = query.casefold()
    return sum(1 for gram in grams if gram in lowered) / len(grams)


def _boosted_document_score(query: str, values: list[RankedHit]) -> float:
    first = values[0]
    base = first.rerank_score if first.rerank_score is not None else first.rrf_score
    affinity = _filename_affinity(query, first.hit.file_name)
    if affinity < FILENAME_AFFINITY_THRESHOLD:
        return base
    return base * (1 + FILENAME_AFFINITY_WEIGHT * affinity)


@dataclass
class QueryPlan:
    variants: list[str]
    query_expansion_source: str = "off"


class _QueryOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    query_variants: list[str] = Field(default_factory=list, max_length=8)


class _VerifyOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    verified: bool
    confidence: float = Field(ge=0, le=1)
    evidence: list[str] = Field(default_factory=list)
    failed_constraints: list[str] = Field(default_factory=list)


class _JudgeOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    best: int = Field(ge=1)


@dataclass
class RankedHit:
    hit: RetrievalHit
    rrf_score: float
    profile_slots: set[int] = field(default_factory=set)
    channels: set[str] = field(default_factory=set)
    rerank_score: float | None = None
    channel_ranks: dict[str, int] = field(default_factory=dict)
    channel_scores: dict[str, float] = field(default_factory=dict)
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


def _matching_expansions(query: str, synonym_groups: list[list[str]]) -> list[str]:
    lowered = query.casefold()
    expansions: list[str] = []
    for group in synonym_groups:
        if not any(term.casefold() in lowered for term in group):
            continue
        for term in group:
            if term.casefold() not in lowered and term not in expansions:
                expansions.append(term)
    return expansions


def _deterministic_query_variants(
    query: str, *, enabled: bool, max_variants: int, synonym_groups: list[list[str]]
) -> list[str]:
    normalized = _normalize_query(query)
    if not normalized:
        return []
    if not enabled or max_variants <= 1:
        return [normalized]
    expansions = _matching_expansions(normalized, synonym_groups)
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
        synonym_groups=expansion.synonym_groups,
    )
    source = "deterministic" if query.strip() and expansion.enabled else "off"
    fallback = QueryPlan(variants=fallback_variants, query_expansion_source=source)
    if not fallback_variants:
        return fallback
    use_llm_variants = expansion.enabled and expansion.llm_enabled
    if not use_llm_variants:
        return fallback
    prompt = f"{expansion.llm_prompt}\n\nユーザーの問い合わせ:\n{query}"
    try:
        output = _QueryOutput.model_validate(await vlm_client.generate_json(prompt=prompt))
    except Exception:
        return fallback
    variants = _dedupe_strings([query, *output.query_variants])[:expansion.max_variants]
    return QueryPlan(
        variants=variants or fallback_variants,
        query_expansion_source="llm" if variants else source,
    )


SANE_CHAR_PATTERN = re.compile(r"[0-9A-Za-zぁ-んァ-ヶ一-龯々ー\s]")


def _text_quality(text: str) -> tuple[bool, int]:
    """(正常テキストか, 長さ)。文字化けPAGE_TEXT(異言語グリフ列)を長さだけで
    正しいVLMテキストに勝たせないための統合時比較キー。"""
    if not text:
        return (False, 0)
    sane = len(SANE_CHAR_PATTERN.findall(text))
    return (sane / len(text) >= 0.5, len(text))


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
            item.channel_scores[hit.channel] = max(
                hit.score, item.channel_scores.get(hit.channel, hit.score)
            )
            if _text_quality(hit.raw_text) > _text_quality(item.hit.raw_text):
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
                for channel, score in item.channel_scores.items():
                    current.channel_scores[channel] = max(
                        score, current.channel_scores.get(channel, score)
                    )
    return sorted(fused.values(), key=lambda item: item.rrf_score, reverse=True)


def _image_similarity_score(
    item: RankedHit,
    *,
    pure_image_channels: set[str],
    image_channels: set[str],
) -> float | None:
    preferred_scores = [
        score
        for channel, score in item.channel_scores.items()
        if channel in pure_image_channels
    ]
    if preferred_scores:
        return max(preferred_scores)
    fallback_scores = [
        score
        for channel, score in item.channel_scores.items()
        if channel in image_channels
    ]
    return max(fallback_scores, default=None)


def _image_sort_key(
    item: RankedHit,
    *,
    pure_image_channels: set[str],
    image_channels: set[str],
) -> tuple[bool, float, bool, bool, float, float]:
    similarity = _image_similarity_score(
        item,
        pure_image_channels=pure_image_channels,
        image_channels=image_channels,
    )
    rerank_score = item.rerank_score
    return (
        similarity is not None,
        similarity if similarity is not None else float("-inf"),
        item.verification_status == "verified",
        rerank_score is not None,
        rerank_score if rerank_score is not None else float("-inf"),
        item.rrf_score,
    )


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
        effective_settings = (
            settings.model_copy(update={"top_n": len(items)}) if has_image else settings
        )
        ranks = await rerank_client.rerank(
            query=query,
            documents=[_candidate_text(item) for item in items],
            settings=effective_settings,
        )
        return [(items[result.index], result.score) for result in ranks]

    try:
        batch_scores = []
        for start in range(0, len(selected), RERANK_BATCH_SIZE):
            batch_scores.extend(await rank(selected[start:start + RERANK_BATCH_SIZE]))
        if not batch_scores:
            return candidates
        if has_image:
            for rank_index, (item, score) in enumerate(
                sorted(batch_scores, key=lambda result: result[1], reverse=True), start=1
            ):
                item.rerank_score = score
                item.text_rerank_rank = rank_index
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
    return ranked_items


JUDGE_CANDIDATE_COUNT = 30


def _judge_candidate_text(item: RankedHit) -> str:
    return json.dumps(
        {
            "file_name": UPLOAD_PREFIX_PATTERN.sub("", item.hit.file_name),
            "page_number": item.hit.page_number,
            "text": item.hit.raw_text[:1500],
            "vlm_summary": item.hit.caption[:1200],
        },
        ensure_ascii=False,
        separators=(",", ":"),
    )


async def _llm_judge_best(query: str, candidates: list[RankedHit]) -> int | None:
    """リランク上位からクエリの全条件に最も合致する1件をLLMに選ばせる。

    cross-encoderリランクは同一文書内の隣接ページや同種カタログ間の
    僅差の判定を誤りやすいため、最終的なtop-1のみLLMで決める。
    失敗時はNoneを返しリランク順をそのまま使う。
    """
    top = candidates[:JUDGE_CANDIDATE_COUNT]
    if len(top) < 2:
        return None
    listing = "\n".join(
        f"[{index}] {_judge_candidate_text(item)}" for index, item in enumerate(top, 1)
    )
    prompt = (
        "あなたは文書検索の最終判定者です。問い合わせの全ての条件"
        "（文書名・版・年月、ページに書かれている内容・数値・固有名詞）に"
        "最も合致する候補を1つ選び、{\"best\": 候補番号} のJSONだけを返してください。"
        "外観・内観などのイメージを探す問い合わせでは vlm_summary の視覚的特徴"
        "（構図・写っている物・色・時間帯）を条件と照合してください。"
        "表紙・目次ページと内容ページの両方が合致する場合は、問い合わせの内容が"
        "実際に記載・図示されたページを選んでください。"
        "候補は検索スコア順に並んでいます。決め手がなく複数候補が同等の場合は"
        "番号の小さい候補を選んでください。\n\n"
        f"問い合わせ: {query}\n\n候補:\n{listing}"
    )
    try:
        output = _JudgeOutput.model_validate(await vlm_client.generate_json(prompt=prompt))
    except Exception:
        return None
    index = output.best - 1
    return index if 0 <= index < len(top) else None


async def _verify_candidates(
    query: str,
    candidates: list[RankedHit],
    query_image: bytes | None,
    query_image_media_type: str,
    progress: Callable[[dict[str, Any]], Awaitable[None]] | None = None,
) -> None:
    settings = retrieval_service_settings.get_vlm()
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
                f"ユーザーの問い合わせ: {query}\n"
                f"候補コンテキスト: {_candidate_text(item)}"
            )
            images = [(image, "image/png")]
            if query_image is not None:
                prompt += "\n画像1は問い合わせの参照画像です。画像2は候補画像です。"
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
        min_score: float = 0.0,
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
        await step("initialization", "検索を準備しています")
        profiles = await asyncio.to_thread(profile_repository.enabled_profiles)
        await finish_step("initialization")
        await step("query_variants", "検索バリエーションを生成しています")
        plan = await _query_plan(query)
        query_variants = plan.variants or _dedupe_strings([query])
        query_text = " ".join(query_variants)
        query_plan = {
            "variants": query_variants,
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
        variant_embeddings: list[tuple[str, list[float]]] = []
        if query_variants:
            try:
                embeddings = await embedding_client.query(query_variants)
                variant_embeddings = list(zip(query_variants, embeddings))
            except Exception:
                degraded.append("text_embedding")
        image_embedding: list[float] | None = None
        if image is not None:
            try:
                # Query vectors must use the query input mode.  Indexed image
                # (and image+text) recipes use SEARCH_DOCUMENT, while this
                # branch represents the user's visual query.
                image_embedding = await embedding_client.image(
                    image, image_media_type, input_type="SEARCH_QUERY"
                )
            except Exception:
                degraded.append("visual_embedding")
        await finish_step("embedding")

        await step("retrieval", "複数チャンネルから候補を取得しています")
        weights = retrieval_service_settings.get_weights()
        rerank_settings = retrieval_service_settings.get_rerank()
        branch_k = max(rerank_settings.candidate_count, min(500, top_k * 5))
        tasks: list[tuple[str, float, Any]] = []
        image_channels: set[str] = set()
        pure_image_channels: set[str] = set()

        def route_name(name: str, index: int, total: int) -> str:
            return name if total == 1 else f"{name}_{index}"

        if query_variants and weights.oracle_text > 0:
            weight = weights.oracle_text / len(query_variants)
            for index, variant in enumerate(query_variants, start=1):
                tasks.append(
                    (
                        route_name("keyword:page_text", index, len(query_variants)),
                        weight,
                        asyncio.to_thread(
                            rag_repository.keyword_search,
                            query=variant,
                            top_k=branch_k,
                            user_hash=user_hash,
                            current_version_only=current_version_only,
                            document_types=document_types,
                            filename_filter=filename_filter,
                        ),
                    )
                )
        recipe_vectors = (
            [("image", image_embedding)]
            if image_embedding is not None
            else variant_embeddings
        )
        if recipe_vectors:
            recipes = await asyncio.to_thread(pipeline_repository.enabled_recipes)
            for recipe in recipes:
                source_types = {item.source_type for item in recipe.inputs}
                if "PAGE_IMAGE" in source_types:
                    channel_weight = weights.visual_vector
                elif "VLM_TEXT" in source_types:
                    channel_weight = weights.vlm_vector
                else:
                    channel_weight = weights.text_vector
                if channel_weight <= 0 or recipe.search_weight <= 0:
                    continue
                weight = (
                    channel_weight
                    * recipe.search_weight
                    / len(recipe_vectors)
                )
                for index, (_, embedding) in enumerate(recipe_vectors, start=1):
                    channel = f"vector:{recipe.code}"
                    if "PAGE_IMAGE" in source_types:
                        image_channels.add(channel)
                        if source_types == {"PAGE_IMAGE"}:
                            pure_image_channels.add(channel)
                    tasks.append(
                        (
                            route_name(channel, index, len(recipe_vectors)),
                            weight,
                            asyncio.to_thread(
                                rag_repository.recipe_vector_search,
                                recipe_code=recipe.code,
                                embedding=embedding,
                                channel=channel,
                                top_k=branch_k,
                                user_hash=user_hash,
                            current_version_only=current_version_only,
                            document_types=document_types,
                            filename_filter=filename_filter,
                            min_score=min_score,
                        ),
                    )
                )
        vlm_profile_count = max(1, len(profiles))
        for profile in profiles:
            if query_variants and weights.vlm_text > 0:
                weight = weights.vlm_text / (vlm_profile_count * len(query_variants))
                for index, variant in enumerate(query_variants, start=1):
                    tasks.append(
                        (
                            route_name(f"keyword:vlm_text_slot_{profile.slot_no}", index, len(query_variants)),
                            weight,
                            asyncio.to_thread(
                                rag_repository.facet_keyword_search,
                                profile=profile,
                                query=variant,
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
        candidates = _weighted_rrf(ranked_lists)
        if image is not None:
            candidates.sort(
                key=lambda item: _image_sort_key(
                    item,
                    pure_image_channels=pure_image_channels,
                    image_channels=image_channels,
                ),
                reverse=True,
            )
        candidates = candidates[: rerank_settings.candidate_count]
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

        judge_summary: dict[str, Any] = {"applied": False, "candidate_count": 0}
        if query.strip() and len(candidates) >= 2:
            await step("llm_judge", "LLMが最終候補を判定しています")
            judge_index = await _llm_judge_best(query, candidates)
            judge_summary["candidate_count"] = min(len(candidates), JUDGE_CANDIDATE_COUNT)
            if judge_index is not None:
                chosen = candidates[judge_index]
                top_item = candidates[0]
                top_score = (
                    top_item.rerank_score
                    if top_item.rerank_score is not None
                    else top_item.rrf_score
                )
                # テキスト検索ではjudge pickを最上位へ置く。画像検索では画像類似度が
                # 主排序のため、この値は同一類似度内のタイブレークにだけ使われる。
                chosen.rerank_score = top_score + 0.5
                judge_summary.update(
                    applied=True,
                    picked_file=chosen.hit.file_name,
                    picked_page=chosen.hit.page_number,
                )
            await finish_step("llm_judge")

        if verify:
            await step("verify", "VLMで候補を確認しています（時間がかかります）")
            await _verify_candidates(query, candidates, image, image_media_type, progress)
            await finish_step("verify")

        await step("format_results", "検索結果を整形しています")
        if image is not None:
            candidates.sort(
                key=lambda item: _image_sort_key(
                    item,
                    pure_image_channels=pure_image_channels,
                    image_channels=image_channels,
                ),
                reverse=True,
            )
        else:
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
        if image is not None:
            ranked_documents = sorted(
                documents.values(),
                key=lambda values: _image_sort_key(
                    values[0],
                    pure_image_channels=pure_image_channels,
                    image_channels=image_channels,
                ),
                reverse=True,
            )[:top_k]
        else:
            ranked_documents = sorted(
                documents.values(),
                key=lambda values: _boosted_document_score(query, values),
                reverse=True,
            )[:top_k]
        results: list[DocumentSearchResult] = []
        for values in ranked_documents:
            first = values[0]
            image_similarity_scores = [
                _image_similarity_score(
                    item,
                    pure_image_channels=pure_image_channels,
                    image_channels=image_channels,
                )
                if image is not None
                else None
                for item in values
            ]
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
                    image_similarity_score=image_similarity_score,
                    visual_rank=min(
                        (
                            rank
                            for channel, rank in item.channel_ranks.items()
                            if channel.startswith("vector:page_image")
                        ),
                        default=None,
                    ),
                    text_rerank_rank=item.text_rerank_rank,
                    retrieval_channels=sorted(item.channels),
                    verification_status=item.verification_status,  # type: ignore[arg-type]
                    match_reasons=sorted(item.channels),
                )
                for item, image_similarity_score in zip(values, image_similarity_scores)
            ]
            results.append(
                DocumentSearchResult(
                    document_id=first.hit.document_id,
                    file_name=first.hit.file_name,
                    object_name=first.hit.object_name,
                    bucket=first.hit.bucket,
                    score=first.rerank_score if first.rerank_score is not None else first.rrf_score,
                    rerank_score=first.rerank_score,
                    image_similarity_score=max(
                        (score for score in image_similarity_scores if score is not None),
                        default=None,
                    ),
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
            "judge_summary": judge_summary,
            "format_summary": format_summary,
            "vlm_verify_requested": verify,
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
