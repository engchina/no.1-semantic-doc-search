from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Literal
from uuid import uuid4

from fastapi import APIRouter, File, Form, HTTPException, Request, Response, UploadFile
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.rag.models import FieldFilter, SearchV2Request, SearchV2Response
from app.rag.search_pipeline import principal_hash, search_pipeline

router = APIRouter(tags=["retrieval"])
logger = logging.getLogger(__name__)


class DifyRetrievalSetting(BaseModel):
    top_k: int = Field(default=10, ge=1, le=100)
    score_threshold: float | None = None


class DifyRetrievalRequest(BaseModel):
    knowledge_id: str | None = None
    query: str = Field(min_length=1, max_length=4000)
    retrieval_setting: DifyRetrievalSetting = Field(default_factory=DifyRetrievalSetting)


class SearchFeedbackRequest(BaseModel):
    trace_id: str = Field(min_length=1, max_length=64)
    document_id: str | None = Field(default=None, max_length=64)
    evidence_id: str | None = Field(default=None, max_length=128)
    action: Literal["relevant", "irrelevant", "opened", "downloaded"]


def _sse(event: dict[str, object]) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False, default=str)}\n\n"


def _agui_event(
    event_type: str,
    *,
    run_id: str,
    thread_id: str,
    **payload: object,
) -> dict[str, object]:
    return {
        "type": event_type,
        "runId": run_id,
        "threadId": thread_id,
        "timestamp": time.time(),
        **payload,
    }


def _parse_filters(field_filters: str, document_types: str) -> tuple[list[FieldFilter], list[str]]:
    raw_filters = json.loads(field_filters)
    raw_document_types = json.loads(document_types)
    if not isinstance(raw_filters, list) or len(raw_filters) > 50:
        raise ValueError("field_filters must be an array with at most 50 items")
    if not isinstance(raw_document_types, list) or len(raw_document_types) > 50:
        raise ValueError("document_types must be an array with at most 50 items")
    return [FieldFilter.model_validate(item) for item in raw_filters], [
        str(item) for item in raw_document_types
    ]


def _search_events(
    request: Request,
    *,
    query: str,
    top_k: int,
    field_filters: list[FieldFilter],
    document_types: list[str],
    current_version_only: bool,
    filename_filter: str | None,
    image: bytes | None = None,
    image_media_type: str = "image/png",
    verify: bool = False,
    debug: bool = False,
) -> StreamingResponse:
    run_id = uuid4().hex
    thread_id = f"search:{principal_hash(getattr(request.state, 'auth_username', None)) or 'anonymous'}"

    async def generate():
        queue: asyncio.Queue[dict[str, object] | None] = asyncio.Queue()

        async def emit(event: dict[str, object]) -> None:
            await queue.put(_agui_event(
                str(event.pop("type")),
                run_id=run_id,
                thread_id=thread_id,
                **event,
            ))

        async def run_search() -> None:
            started = time.perf_counter()
            try:
                await emit({"type": "RUN_STARTED"})
                await emit({
                    "type": "STATE_SNAPSHOT",
                    "snapshot": {
                        "status": "started",
                        "message": "検索を開始しました",
                        "steps": [],
                        "result": None,
                    },
                })
                result = await search_pipeline.search(
                    query=query,
                    top_k=top_k,
                    field_filters=field_filters,
                    document_types=document_types,
                    current_version_only=current_version_only,
                    user_hash=principal_hash(getattr(request.state, "auth_username", None)),
                    filename_filter=filename_filter,
                    image=image,
                    image_media_type=image_media_type,
                    verify=verify,
                    debug=debug,
                    progress=emit,
                )
                result_json = result.model_dump(mode="json")
                await emit({
                    "type": "STATE_DELTA",
                    "delta": [
                        {"op": "replace", "path": "/status", "value": "finished"},
                        {"op": "replace", "path": "/message", "value": "検索が完了しました"},
                        {"op": "replace", "path": "/result", "value": result_json},
                    ],
                })
                await emit({
                    "type": "RUN_FINISHED",
                    "result": result_json,
                    "elapsedMs": round((time.perf_counter() - started) * 1000),
                })
            except Exception as error:
                logger.exception("AG-UI search stream failed")
                await emit({
                    "type": "RUN_ERROR",
                    "message": str(error),
                    "elapsedMs": round((time.perf_counter() - started) * 1000),
                })
            finally:
                await queue.put(None)

        task = asyncio.create_task(run_search())
        try:
            while True:
                event = await queue.get()
                if event is None:
                    break
                yield _sse(event)
        finally:
            if not task.done():
                task.cancel()

    return StreamingResponse(generate(), media_type="text/event-stream")


@router.get("/search/v2/filters")
async def search_v2_filters() -> dict[str, object]:
    from app.rag.profile_repository import profile_repository

    # schema_ready()は同期DBコール（DB停止時は接続待ちで長時間ブロックする）。
    # イベントループを凍結させないよう必ずワーカースレッドで実行する。
    return {
        "profile_retrieval_active": False,
        "v2_retrieval_active": await asyncio.to_thread(profile_repository.schema_ready),
        "fields": [],
    }


@router.post("/retrieval")
@router.post("/dify/retrieval")
async def dify_retrieval(
    payload: DifyRetrievalRequest, request: Request, response: Response
) -> dict[str, object]:
    """Dify external-knowledge compatibility adapter backed by retrieval-only v2."""
    result = await search_pipeline.search(
        query=payload.query,
        top_k=payload.retrieval_setting.top_k,
        field_filters=[],
        document_types=[],
        current_version_only=True,
        user_hash=principal_hash(getattr(request.state, "auth_username", None)),
    )
    response.headers["X-Score-Threshold-Deprecated"] = "true"
    records: list[dict[str, object]] = []
    for document in result.results:
        excerpts = [
            item.text_excerpt or item.caption
            for item in document.evidence
            if item.text_excerpt or item.caption
        ]
        records.append(
            {
                "content": "\n\n".join(excerpts),
                "score": document.score,
                "title": document.file_name,
                "metadata": {
                    "document_id": document.document_id,
                    "object_name": document.object_name,
                    "profile_slots": document.profile_slots,
                    "trace_id": result.trace_id,
                },
            }
        )
    return {"records": records}


@router.post("/search/v2/feedback")
async def search_v2_feedback(payload: SearchFeedbackRequest, request: Request) -> dict[str, object]:
    from app.rag.oracle_repository import rag_repository

    try:
        rag_repository.record_search_feedback(
            feedback_id=uuid4().hex,
            trace_id=payload.trace_id,
            document_id=payload.document_id,
            evidence_id=payload.evidence_id,
            action=payload.action,
            user_hash=principal_hash(getattr(request.state, "auth_username", None)),
        )
    except Exception as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    return {"success": True}


@router.post("/search/v2", response_model=SearchV2Response)
async def search_v2(payload: SearchV2Request, request: Request) -> SearchV2Response:
    try:
        return await search_pipeline.search(
            query=payload.query,
            top_k=payload.top_k,
            field_filters=payload.field_filters,
            document_types=payload.document_types,
            current_version_only=payload.current_version_only,
            user_hash=principal_hash(getattr(request.state, "auth_username", None)),
            filename_filter=payload.filename_filter,
            verify=payload.verify,
            debug=payload.debug,
        )
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.post("/search/v2/events")
async def search_v2_events(payload: SearchV2Request, request: Request) -> StreamingResponse:
    return _search_events(
        request,
        query=payload.query,
        top_k=payload.top_k,
        field_filters=payload.field_filters,
        document_types=payload.document_types,
        current_version_only=payload.current_version_only,
        filename_filter=payload.filename_filter,
        verify=payload.verify,
        debug=payload.debug,
    )


@router.post("/search/v2/image", response_model=SearchV2Response)
async def search_v2_image(
    request: Request,
    image: UploadFile = File(...),
    query: str = Form(default="", max_length=4000),
    top_k: int = Form(default=20, ge=1, le=100),
    filename_filter: str | None = Form(default=None, max_length=1024),
    field_filters: str = Form(default="[]"),
    document_types: str = Form(default="[]"),
    current_version_only: bool = Form(default=True),
    verify: bool = Form(default=False),
    debug: bool = Form(default=False),
) -> SearchV2Response:
    allowed = {"image/png", "image/jpeg", "image/webp"}
    if image.content_type not in allowed:
        raise HTTPException(status_code=400, detail="PNG, JPEG, or WebP image is required")
    content = await image.read()
    if not content or len(content) > 10 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="image must be between 1 byte and 10 MiB")
    try:
        filters, types = _parse_filters(field_filters, document_types)
    except (ValueError, TypeError) as error:
        raise HTTPException(status_code=422, detail="invalid filter JSON") from error
    try:
        return await search_pipeline.search(
            query=query,
            top_k=top_k,
            field_filters=filters,
            document_types=types,
            current_version_only=current_version_only,
            user_hash=principal_hash(getattr(request.state, "auth_username", None)),
            filename_filter=filename_filter,
            image=content,
            image_media_type=image.content_type,
            verify=verify,
            debug=debug,
        )
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error


@router.post("/search/v2/image/events")
async def search_v2_image_events(
    request: Request,
    image: UploadFile = File(...),
    query: str = Form(default="", max_length=4000),
    top_k: int = Form(default=20, ge=1, le=100),
    filename_filter: str | None = Form(default=None, max_length=1024),
    field_filters: str = Form(default="[]"),
    document_types: str = Form(default="[]"),
    current_version_only: bool = Form(default=True),
    verify: bool = Form(default=False),
    debug: bool = Form(default=False),
) -> StreamingResponse:
    allowed = {"image/png", "image/jpeg", "image/webp"}
    if image.content_type not in allowed:
        raise HTTPException(status_code=400, detail="PNG, JPEG, or WebP image is required")
    content = await image.read()
    if not content or len(content) > 10 * 1024 * 1024:
        raise HTTPException(status_code=400, detail="image must be between 1 byte and 10 MiB")
    try:
        filters, types = _parse_filters(field_filters, document_types)
    except (ValueError, TypeError) as error:
        raise HTTPException(status_code=422, detail="invalid filter JSON") from error
    return _search_events(
        request,
        query=query,
        top_k=top_k,
        field_filters=filters,
        document_types=types,
        current_version_only=current_version_only,
        filename_filter=filename_filter,
        image=content,
        image_media_type=image.content_type,
        verify=verify,
        debug=debug,
    )
