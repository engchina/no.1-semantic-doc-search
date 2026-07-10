from __future__ import annotations

import asyncio
import base64
from io import BytesIO
from uuid import uuid4

from fastapi import APIRouter, BackgroundTasks, HTTPException, Response
from PIL import Image, ImageDraw, ImageFont
from pydantic import BaseModel, Field

from app.rag.clients import mineru_client, ocr_client, rerank_client, vlm_client
from app.rag.index_pipeline import INDEX_OUTPUT_CONTRACT, index_pipeline
from app.rag.models import (
    GlobalVlmSettings,
    MinerUSettings,
    OcrSettings,
    ProfileConfig,
    RerankSettings,
    RetrievalSettingsResponse,
    RetrievalWeights,
    VlmExtractionOutput,
)
from app.rag.oracle_repository import rag_repository
from app.rag.profile_repository import profile_repository
from app.rag.profile_validation import validate_profile
from app.rag.service_settings import retrieval_service_settings
from app.services.oci_service import oci_service

router = APIRouter(prefix="/settings/retrieval", tags=["retrieval-settings"])


class PromptTestRequest(BaseModel):
    extraction_prompt: str | None = Field(default=None, max_length=40_000)
    image_base64: str | None = None
    page_text: str = Field(default="", max_length=20_000)


class DocumentTypeUpdate(BaseModel):
    document_type: str | None = None


def _require_schema() -> None:
    if not profile_repository.schema_ready():
        raise HTTPException(
            status_code=503,
            detail="SDS schema is not provisioned. Generate and explicitly apply the schema first.",
        )


# 注意: このルーターの同期DBコールを含むエンドポイントは async def ではなく def にする。
# FastAPIが自動的にスレッドプールで実行するため、DB停止時でもイベントループを凍結させない。
@router.get("", response_model=RetrievalSettingsResponse)
def get_retrieval_settings() -> RetrievalSettingsResponse:
    enterprise = oci_service.get_enterprise_ai_settings()
    return RetrievalSettingsResponse(
        schema_ready=profile_repository.schema_ready(),
        profiles=profile_repository.list_profiles(),
        mineru=retrieval_service_settings.get_mineru(),
        ocr=retrieval_service_settings.get_ocr(),
        rerank=retrieval_service_settings.get_rerank(),
        vlm=retrieval_service_settings.get_vlm(),
        weights=retrieval_service_settings.get_weights(),
        vlm_model=enterprise.model or "",
    )


@router.get("/profiles/{slot_no}", response_model=ProfileConfig)
def get_profile(slot_no: int) -> ProfileConfig:
    if slot_no not in {1, 2, 3}:
        raise HTTPException(status_code=404, detail="profile slot must be 1, 2, or 3")
    return profile_repository.get_profile(slot_no)


def _validate_profile(slot_no: int, profile: ProfileConfig) -> None:
    if slot_no != profile.slot_no or slot_no not in {1, 2, 3}:
        raise HTTPException(status_code=400, detail="profile slot mismatch")
    errors = validate_profile(profile)
    if errors:
        raise HTTPException(status_code=422, detail=errors)


@router.put("/profiles/{slot_no}", response_model=ProfileConfig)
def save_profile(slot_no: int, profile: ProfileConfig, response: Response) -> ProfileConfig:
    """Deprecated save adapter. New clients use apply so save and rebuild cannot drift."""
    _require_schema()
    _validate_profile(slot_no, profile)
    response.headers["Deprecation"] = "true"
    return profile_repository.apply_profile(profile)


async def _run_profile_apply(job_id: str, slot_no: int, object_names: list[str]) -> None:
    completed = 0
    failed = 0
    for object_name in object_names:
        try:
            await index_pipeline.index_object(object_name, profile_slots={slot_no})
            completed += 1
        except Exception:
            failed += 1
        rag_repository.update_ingestion_job(
            job_id, completed=completed, failed=failed, finished=False
        )
    if failed:
        profile_repository.set_apply_status(slot_no, "FAILED")
    else:
        profile_repository.refresh_apply_status(slot_no)
    rag_repository.update_ingestion_job(
        job_id, completed=completed, failed=failed, finished=True
    )


@router.post("/profiles/{slot_no}/apply")
def apply_profile(
    slot_no: int, profile: ProfileConfig, background_tasks: BackgroundTasks
) -> dict[str, object]:
    _require_schema()
    _validate_profile(slot_no, profile)
    saved = profile_repository.apply_profile(profile)
    object_names = profile_repository.pending_object_names(slot_no)
    page_count = profile_repository.pending_page_count(slot_no)
    job_id: str | None = None
    if object_names:
        job_id = uuid4().hex
        rag_repository.create_ingestion_job(job_id, len(object_names))
        background_tasks.add_task(_run_profile_apply, job_id, slot_no, object_names)
    return {
        "success": True,
        "profile": saved.model_dump(mode="json"),
        "job_id": job_id,
        "queued_documents": len(object_names),
        "estimated_vlm_calls": page_count,
    }


@router.post("/profiles/{slot_no}/preview")
def preview_profile_apply(slot_no: int, profile: ProfileConfig) -> dict[str, int]:
    _require_schema()
    _validate_profile(slot_no, profile)
    documents, calls = profile_repository.apply_impact(profile)
    return {"affected_documents": documents, "estimated_vlm_calls": calls}


@router.get("/profiles/{slot_no}/status", response_model=ProfileConfig)
def profile_status(slot_no: int) -> ProfileConfig:
    return get_profile(slot_no)


@router.post("/profiles/{slot_no}/test")
async def test_profile(slot_no: int, request: PromptTestRequest) -> dict[str, object]:
    profile = await asyncio.to_thread(profile_repository.get_profile, slot_no)
    prompt_text = (request.extraction_prompt or profile.extraction_prompt).strip()
    if not prompt_text:
        raise HTTPException(status_code=422, detail="extraction_prompt is required")
    try:
        image = base64.b64decode(request.image_base64, validate=True) if request.image_base64 else None
    except ValueError as error:
        raise HTTPException(status_code=422, detail="image_base64 is invalid") from error
    prompt = (
        f"Administrator extraction instruction:\n{prompt_text}\n\n"
        f"Page text:\n{request.page_text}\n\nSource locator: page:1\n\n"
        f"{INDEX_OUTPUT_CONTRACT}"
    )
    try:
        output = VlmExtractionOutput.model_validate(
            await vlm_client.generate_json(prompt=prompt, image=image)
        )
    except Exception as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    return {"success": True, "result": output.model_dump(mode="json"), "search_text": output.search_text()}


@router.post("/profiles/{slot_no}/validate")
async def validate_profile_endpoint(slot_no: int, profile: ProfileConfig) -> dict[str, object]:
    errors = [] if slot_no == profile.slot_no else ["profile slot mismatch"]
    errors.extend(validate_profile(profile))
    return {"valid": not errors, "errors": errors}


# One-release adapters for the former revision-oriented API.
@router.post("/profiles/{slot_no}/publish", response_model=ProfileConfig)
def publish_profile(slot_no: int, response: Response) -> ProfileConfig:
    response.headers["Deprecation"] = "true"
    return profile_repository.get_profile(slot_no)


@router.get("/profiles/{slot_no}/impact")
def profile_impact(slot_no: int, response: Response) -> dict[str, object]:
    response.headers["Deprecation"] = "true"
    names = profile_repository.pending_object_names(slot_no)
    return {
        "affected_documents": len(names),
        "estimated_vlm_calls": profile_repository.pending_page_count(slot_no),
        "object_names": names,
    }


@router.post("/profiles/{slot_no}/reindex")
def reindex_profile(slot_no: int, background_tasks: BackgroundTasks, response: Response) -> dict[str, object]:
    response.headers["Deprecation"] = "true"
    profile = profile_repository.get_profile(slot_no)
    return apply_profile(slot_no, profile, background_tasks)


@router.post("/profiles/{slot_no}/test-prompts")
async def test_profile_legacy(slot_no: int, request: PromptTestRequest, response: Response) -> dict[str, object]:
    response.headers["Deprecation"] = "true"
    return await test_profile(slot_no, request)


@router.get("/mineru", response_model=MinerUSettings)
async def get_mineru_settings() -> MinerUSettings:
    return retrieval_service_settings.get_mineru()


@router.put("/mineru", response_model=MinerUSettings)
def save_mineru_settings(settings: MinerUSettings) -> MinerUSettings:
    previous = retrieval_service_settings.get_mineru()
    saved = retrieval_service_settings.save_mineru(settings)
    if saved != previous and profile_repository.schema_ready():
        profile_repository.mark_service_reindex_required("mineru")
    return saved


@router.post("/mineru/test")
async def test_mineru() -> dict[str, object]:
    try:
        result = await mineru_client.health(retrieval_service_settings.get_mineru())
    except Exception as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    return {"success": True, "details": result}


@router.get("/ocr", response_model=OcrSettings)
async def get_ocr_settings() -> OcrSettings:
    return retrieval_service_settings.get_ocr()


@router.put("/ocr", response_model=OcrSettings)
def save_ocr_settings(settings: OcrSettings) -> OcrSettings:
    previous = retrieval_service_settings.get_ocr()
    saved = retrieval_service_settings.save_ocr(settings)
    if saved != previous and profile_repository.schema_ready():
        profile_repository.mark_service_reindex_required("ocr")
    return saved


@router.post("/ocr/test/{engine}")
async def test_ocr(engine: str) -> dict[str, object]:
    settings = retrieval_service_settings.get_ocr(mask_secrets=False)
    mapping = {"dots": settings.dots, "glm": settings.glm, "unlimited": settings.unlimited}
    if engine not in mapping:
        raise HTTPException(status_code=404, detail="unknown OCR engine")
    test_image = Image.new("RGB", (640, 128), "white")
    ImageDraw.Draw(test_image).text(
        (24, 44), "OCR connection test 123", fill="black", font=ImageFont.load_default(32)
    )
    test_png = BytesIO()
    test_image.save(test_png, format="PNG")
    try:
        result = await ocr_client.recognize(
            engine=engine, settings=mapping[engine], image=test_png.getvalue()
        )
    except Exception as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    return {"success": True, "engine": engine, "text_length": len(result["text"])}


@router.get("/rerank", response_model=RerankSettings)
async def get_rerank_settings() -> RerankSettings:
    return retrieval_service_settings.get_rerank()


@router.put("/rerank", response_model=RerankSettings)
async def save_rerank_settings(settings: RerankSettings) -> RerankSettings:
    return retrieval_service_settings.save_rerank(settings)


@router.post("/rerank/test")
async def test_rerank() -> dict[str, object]:
    try:
        result = await rerank_client.rerank(
            query="generic retrieval test",
            documents=["generic retrieval test", "unrelated content"],
            settings=retrieval_service_settings.get_rerank(),
        )
    except Exception as error:
        raise HTTPException(status_code=502, detail=str(error)) from error
    return {"success": True, "result_count": len(result)}


@router.get("/vlm", response_model=GlobalVlmSettings)
async def get_vlm_settings() -> GlobalVlmSettings:
    return retrieval_service_settings.get_vlm()


@router.put("/vlm", response_model=GlobalVlmSettings)
async def save_vlm_settings(settings: GlobalVlmSettings) -> GlobalVlmSettings:
    return retrieval_service_settings.save_vlm(settings)


@router.get("/weights", response_model=RetrievalWeights)
async def get_weights() -> RetrievalWeights:
    return retrieval_service_settings.get_weights()


@router.put("/weights", response_model=RetrievalWeights)
async def save_weights(settings: RetrievalWeights) -> RetrievalWeights:
    return retrieval_service_settings.save_weights(settings)


@router.get("/documents")
def list_documents(limit: int = 100) -> dict[str, object]:
    _require_schema()
    return {"documents": rag_repository.list_documents_for_settings(limit)}


@router.put("/documents/{document_id}/type")
def update_document_type(document_id: str, payload: DocumentTypeUpdate) -> dict[str, object]:
    _require_schema()
    try:
        rag_repository.update_document_type(document_id, payload.document_type)
    except LookupError as error:
        raise HTTPException(status_code=404, detail=str(error)) from error
    return {"success": True}
