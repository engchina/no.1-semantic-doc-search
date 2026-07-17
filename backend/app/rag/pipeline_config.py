from __future__ import annotations

from typing import Any

from app.rag.pipeline_repository_types import stable_hash_value
from app.rag.profile_repository import profile_repository
from app.rag.service_settings import retrieval_service_settings
from app.services.oci_service import oci_service


def normalize_source_components() -> list[str]:
    """Return the currently enabled inputs consumed by Normalize."""
    components = ["native_parse"]
    mineru = retrieval_service_settings.get_mineru()
    if mineru.enabled and bool(mineru.base_url):
        components.append("mineru_parse")
    if retrieval_service_settings.get_ocr().enabled:
        components.append("ocr")
    return components


def stage_config_payload(kind: str, component: str) -> dict[str, Any]:
    if kind == "RENDER":
        ocr = retrieval_service_settings.get_ocr(mask_secrets=True)
        enabled = [
            item.dpi
            for item in (ocr.dots, ocr.glm, ocr.unlimited)
            if item.enabled
        ]
        return {"executor": "render-v4", "dpi": max([200, *enabled])}
    if kind == "NATIVE_PARSE":
        return {"executor": "native-parser-v4"}
    if kind == "MINERU_PARSE":
        return {
            "executor": "mineru-v4",
            **retrieval_service_settings.get_mineru().model_dump(mode="json"),
        }
    if kind == "OCR":
        settings = retrieval_service_settings.get_ocr(mask_secrets=True)
        return {"executor": "ocr-v4", **settings.model_dump(mode="json")}
    if kind == "NORMALIZE":
        return {
            "executor": "normalize-v4",
            "chunk_size": 1800,
            "overlap": 200,
            "source_components": normalize_source_components(),
        }
    if kind == "VLM":
        slot = int(component.split(":", 1)[1])
        profile = profile_repository.get_profile(slot)
        return {
            "executor": "vlm-v4",
            "revision": profile.current_revision_id,
            "config_hash": profile.config_hash,
            "model": oci_service.get_enterprise_ai_settings().model,
        }
    if kind == "EMBED":
        # Imported lazily to keep repository/config modules acyclic at import time.
        from app.rag.pipeline_repository import pipeline_repository

        recipe = pipeline_repository.get_recipe(component.split(":", 1)[1])
        return {
            "executor": "embed-v4",
            "revision": recipe.current_revision_id,
            "config_hash": recipe.config_hash,
            "model": recipe.model_id,
            "dimensions": recipe.output_dimensions,
        }
    return {"executor": kind.casefold()}


def stage_config_hash(kind: str, component: str) -> str:
    return stable_hash_value(stage_config_payload(kind, component))

