from __future__ import annotations

import asyncio
import json
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Header, HTTPException, Query
from fastapi.responses import Response, StreamingResponse

from app.rag.pipeline_dispatcher import pipeline_dispatcher
from app.rag.pipeline_models import (
    DocumentProcessingStatus,
    DocumentPageImagesResponse,
    DocumentPageTextsResponse,
    EmbeddingRecipe,
    PipelineJobAccepted,
    PipelineJobPreview,
    PipelineJobRequest,
    PipelineJobStatus,
    PipelineJobStepStatus,
)
from app.rag.pipeline_planner import plan_steps, planned_dependencies
from app.rag.pipeline_repository import pipeline_repository
from app.rag.profile_repository import profile_repository
from app.rag.service_settings import retrieval_service_settings
from app.services.oci_service import oci_service

router = APIRouter(tags=["pipeline"])


def _require_schema() -> None:
    if not pipeline_repository.schema_ready():
        raise HTTPException(
            status_code=503,
            detail="文書処理スキーマが未構築です。20260714_004を適用してください。",
        )


def _plan(request: PipelineJobRequest):
    profiles = profile_repository.enabled_profiles()
    recipes = pipeline_repository.list_recipes()
    mineru = retrieval_service_settings.get_mineru()
    ocr = retrieval_service_settings.get_ocr()
    return plan_steps(
        request,
        recipes=recipes,
        profile_slots=[item.slot_no for item in profiles],
        mineru_enabled=mineru.enabled and bool(mineru.base_url),
        ocr_enabled=ocr.enabled,
    )


@router.post("/pipeline/jobs/preview", response_model=PipelineJobPreview)
def preview_job(request: PipelineJobRequest) -> PipelineJobPreview:
    _require_schema()
    planned, prerequisites, downstream = _plan(request)
    calls_per_document = sum(
        item.kind in {"OCR", "VLM", "EMBED"} for item in planned
    )
    return PipelineJobPreview(
        object_count=len(request.object_names),
        requested_steps=[
            item.component_key for item in planned if item.reason == "requested"
        ],
        prerequisite_steps=sorted(prerequisites),
        downstream_steps=sorted(downstream),
        estimated_oci_calls=len(request.object_names) * calls_per_document,
        estimated_pages=len(request.object_names),
        publish_mode=request.publish_mode,
        can_publish_automatically=any(item.kind == "PUBLISH" for item in planned),
        warnings=[
            "ページ数はObject Storage取得前の概算です。実際の呼出回数はページ数に応じて増加します。"
        ],
    )


@router.post("/pipeline/jobs", status_code=202, response_model=PipelineJobAccepted)
def create_job(
    request: PipelineJobRequest,
    idempotency_key: Annotated[str | None, Header(alias="Idempotency-Key")] = None,
) -> PipelineJobAccepted:
    _require_schema()
    planned, _, _ = _plan(request)
    recipes = pipeline_repository.list_recipes()
    dependencies = planned_dependencies(planned, recipes=recipes)
    specs = [
        {
            "object_name": object_name,
            "kind": step.kind,
            "component_key": step.component_key,
            # ``force`` applies to the user-selected stage only.  Automatic
            # prerequisites (for example render required by an OCR rerun)
            # should still reuse their immutable cache entries; otherwise an
            # OCR-only request needlessly re-renders every page.
            "force": request.force
            and (request.mode == "FULL" or step.reason == "requested"),
            "depends_on": sorted(dependencies[step.component_key]),
        }
        for object_name in request.object_names
        for step in planned
    ]
    try:
        job_id, reused = pipeline_repository.create_job(
            request_json=request.model_dump_json(),
            mode=request.mode,
            publish_mode=request.publish_mode,
            step_specs=specs,
            idempotency_key=idempotency_key,
        )
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    pipeline_dispatcher.wake()
    return PipelineJobAccepted(
        job_id=job_id,
        status=str(pipeline_repository.get_job(job_id)["status"]),
        status_url=f"/pipeline/jobs/{job_id}",
        events_url=f"/pipeline/jobs/{job_id}/events",
        reused=reused,
    )


def _job_response(job: dict[str, Any]) -> PipelineJobStatus:
    steps = [
        PipelineJobStepStatus(
            step_id=str(item["step_id"]),
            object_name=str(item["object_name"]),
            document_id=str(item["document_id"]) if item.get("document_id") else None,
            revision_id=(
                str(item["document_revision_id"])
                if item.get("document_revision_id")
                else None
            ),
            release_id=str(item["release_id"]) if item.get("release_id") else None,
            kind=str(item["stage_kind"]),
            component_key=str(item["component_key"]),
            status=str(item["status"]),
            progress_current=int(item.get("progress_current") or 0),
            progress_total=int(item.get("progress_total") or 0),
            attempt_count=int(item.get("attempt_count") or 0),
            error_summary=(
                str(item["error_summary"]) if item.get("error_summary") else None
            ),
        )
        for item in job["steps"]
    ]
    return PipelineJobStatus(
        job_id=str(job["job_id"]),
        status=str(job["status"]),
        mode=str(job["job_mode"]),
        publish_mode=str(job["publish_mode"]),
        cancel_requested=bool(job["cancel_requested"]),
        total_steps=int(job["total_steps"]),
        completed_steps=int(job["completed_steps"]),
        failed_steps=int(job["failed_steps"]),
        created_at=job.get("created_at"),
        updated_at=job.get("updated_at"),
        steps=steps,
    )


@router.get("/pipeline/jobs/{job_id}", response_model=PipelineJobStatus)
def get_job(job_id: str) -> PipelineJobStatus:
    _require_schema()
    try:
        return _job_response(pipeline_repository.get_job(job_id))
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.get("/pipeline/jobs/{job_id}/events")
async def job_events(
    job_id: str,
    after_sequence: int = Query(default=0, ge=0),
) -> StreamingResponse:
    _require_schema()
    try:
        await asyncio.to_thread(pipeline_repository.get_job, job_id)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error

    async def stream():
        sequence = after_sequence
        idle = 0
        while True:
            events = await asyncio.to_thread(
                pipeline_repository.events, job_id, sequence
            )
            for event in events:
                sequence = int(event["sequence"])
                payload = {
                    "sequence": sequence,
                    "type": event["type"],
                    **event["payload"],
                }
                yield (
                    f"id: {sequence}\n"
                    f"event: {event['type']}\n"
                    f"data: {json.dumps(payload, ensure_ascii=False, default=str)}\n\n"
                )
            job = await asyncio.to_thread(pipeline_repository.get_job, job_id)
            if str(job["status"]) in {
                "SUCCEEDED",
                "PARTIAL_FAILED",
                "FAILED",
                "CANCELLED",
            } and not events:
                break
            idle += 1
            if idle % 15 == 0 and not events:
                yield ": heartbeat\n\n"
            await asyncio.sleep(1)

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/pipeline/jobs/{job_id}/cancel")
def cancel_job(job_id: str) -> dict[str, object]:
    _require_schema()
    if not pipeline_repository.cancel_job(job_id):
        raise HTTPException(
            status_code=409,
            detail="ジョブが見つからないか、すでに完了しています。",
        )
    pipeline_dispatcher.wake()
    return {"success": True, "job_id": job_id, "message": "キャンセルを受け付けました。"}


@router.post("/pipeline/jobs/{job_id}/retry", status_code=202)
def retry_job(job_id: str) -> dict[str, object]:
    _require_schema()
    try:
        new_job_id = pipeline_repository.retry_job(job_id)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    pipeline_dispatcher.wake()
    return {"success": True, "job_id": new_job_id}


@router.get(
    "/documents/{document_id}/processing",
    response_model=DocumentProcessingStatus,
)
def document_processing(document_id: str) -> DocumentProcessingStatus:
    _require_schema()
    try:
        return DocumentProcessingStatus.model_validate(
            pipeline_repository.processing_status(document_id)
        )
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.get(
    "/documents/{document_id}/page-images",
    response_model=DocumentPageImagesResponse,
)
def document_page_images(
    document_id: str,
    release: Literal["latest", "draft", "serving"] = Query(default="latest"),
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=100),
) -> DocumentPageImagesResponse:
    """Artifact lineageを検証したページ画像一覧を返す。"""
    _require_schema()
    try:
        return DocumentPageImagesResponse.model_validate(
            pipeline_repository.list_page_images(
                document_id,
                selector=release,
                page=page,
                page_size=page_size,
            )
        )
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.get(
    "/documents/{document_id}/page-texts",
    response_model=DocumentPageTextsResponse,
)
def document_page_texts(
    document_id: str,
    page_number: int = Query(ge=1),
    release: Literal["latest", "draft", "serving"] = Query(default="latest"),
) -> DocumentPageTextsResponse:
    """前処理・解析／VLMが生成したページ単位テキストを返す。"""
    _require_schema()
    try:
        return DocumentPageTextsResponse.model_validate(
            pipeline_repository.list_page_texts(
                document_id,
                selector=release,
                page_number=page_number,
            )
        )
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error


@router.get(
    "/documents/{document_id}/releases/{release_id}/page-images/"
    "{artifact_id}/content"
)
async def document_page_image_content(
    document_id: str,
    release_id: str,
    artifact_id: str,
    if_none_match: Annotated[str | None, Header(alias="If-None-Match")] = None,
) -> Response:
    """Object Storageパスを公開せず、Release従属性を検証して返す。"""
    _require_schema()
    try:
        artifact = await asyncio.to_thread(
            pipeline_repository.get_page_image_artifact,
            document_id,
            release_id,
            artifact_id,
        )
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    etag = f'"{artifact["content_sha256"]}"'
    if if_none_match == etag:
        return Response(
            status_code=304,
            headers={"ETag": etag, "Cache-Control": "private, max-age=3600"},
        )
    content = await asyncio.to_thread(
        oci_service.download_object, artifact["object_name"]
    )
    if content is None:
        raise HTTPException(
            status_code=404, detail="ページ画像の実体が見つかりません"
        )
    return Response(
        content=content,
        media_type=artifact["media_type"],
        headers={
            "ETag": etag,
            "Cache-Control": "private, max-age=3600",
            "Content-Disposition": (
                f'inline; filename="page_{artifact["page_number"]:06d}.png"'
            ),
        },
    )


@router.post("/documents/{document_id}/releases/{release_id}/publish")
def publish_release(document_id: str, release_id: str) -> dict[str, Any]:
    _require_schema()
    try:
        return {
            "success": True,
            **pipeline_repository.publish_release(document_id, release_id),
        }
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error


@router.get(
    "/settings/retrieval/embedding-recipes",
    response_model=list[EmbeddingRecipe],
)
def list_recipes() -> list[EmbeddingRecipe]:
    _require_schema()
    return pipeline_repository.list_recipes()


