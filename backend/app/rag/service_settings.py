from __future__ import annotations

import os
from pathlib import Path

from dotenv import dotenv_values, set_key

from app.rag.models import (
    GlobalVlmSettings,
    MinerUSettings,
    OcrEngineSettings,
    OcrSettings,
    RerankSettings,
    RetrievalWeights,
)

MASK = "[CONFIGURED]"
ROOT = Path(__file__).parents[3]
TARGET_ENV = ROOT / ".env"
CHALLENGE_ENV = ROOT.parent / "no.1-ai-engineering-challenge-2026" / ".env"


class RetrievalServiceSettingsStore:
    """Small .env-backed store for service endpoints; profile content lives in Oracle."""

    def _values(self) -> dict[str, str]:
        target = {key: str(value) for key, value in dotenv_values(TARGET_ENV).items() if value is not None}
        challenge = {
            key: str(value)
            for key, value in dotenv_values(CHALLENGE_ENV).items()
            if value is not None
        }
        allowed_imports = {
            "MINERU_API_HOST",
            "MINERU_API_TIMEOUT_SECONDS",
            "DOTS_MOCR_API_HOST",
            "DOTS_MOCR_MODEL",
            "DOTS_MOCR_API_KEY",
            "DOTS_MOCR_DPI",
            "DOTS_MOCR_PDF_WORKERS",
            "OCR_API_HOST",
            "OCR_MODEL",
            "OCR_API_KEY",
            "GLM_OCR_DPI",
            "UNLIMITED_OCR_API_HOST",
            "UNLIMITED_OCR_MODEL",
            "UNLIMITED_OCR_API_KEY",
            "UNLIMITED_OCR_DPI",
        }
        for key in allowed_imports:
            if key not in target and challenge.get(key):
                target[key] = challenge[key]
        return target

    @staticmethod
    def _bool(values: dict[str, str], key: str, default: bool) -> bool:
        raw = values.get(key)
        return default if raw is None else raw.strip().casefold() in {"1", "true", "yes", "on"}

    @staticmethod
    def _int(values: dict[str, str], key: str, default: int) -> int:
        try:
            return int(values.get(key, default))
        except (TypeError, ValueError):
            return default

    def get_mineru(self) -> MinerUSettings:
        values = self._values()
        return MinerUSettings(
            enabled=self._bool(values, "MINERU_ENABLED", True),
            base_url=values.get("MINERU_API_HOST", ""),
            timeout_seconds=self._int(values, "MINERU_API_TIMEOUT_SECONDS", 1800),
        )

    def get_ocr(self, *, mask_secrets: bool = True) -> OcrSettings:
        values = self._values()

        def engine(prefix: str, *, enabled: bool, dpi: int, workers: int) -> OcrEngineSettings:
            api_key = values.get(f"{prefix}_API_KEY", "")
            if mask_secrets and api_key:
                api_key = MASK
            return OcrEngineSettings(
                enabled=self._bool(values, f"{prefix}_ENABLED", enabled),
                base_url=values.get(f"{prefix}_API_HOST", ""),
                model=values.get(f"{prefix}_MODEL", ""),
                api_key=api_key,
                dpi=(
                    self._int(values, "GLM_OCR_DPI", dpi)
                    if prefix == "OCR"
                    else self._int(values, f"{prefix}_DPI", dpi)
                ),
                workers=self._int(values, f"{prefix}_PDF_WORKERS", workers),
            )

        return OcrSettings(
            enabled=self._bool(values, "OCR_ENABLED", True),
            dots=engine("DOTS_MOCR", enabled=True, dpi=200, workers=4),
            glm=engine("OCR", enabled=bool(values.get("OCR_API_HOST")), dpi=200, workers=1),
            unlimited=engine("UNLIMITED_OCR", enabled=True, dpi=300, workers=1),
        )

    def get_rerank(self) -> RerankSettings:
        values = self._values()
        return RerankSettings(
            enabled=self._bool(values, "OCI_RERANK_ENABLED", True),
            model=values.get("OCI_RERANK_MODEL", "cohere.rerank-v4.0-fast"),
            candidate_count=self._int(values, "RERANK_CANDIDATE_COUNT", 500),
            top_n=self._int(values, "RERANK_TOP_N", 30),
        )

    def get_vlm(self) -> GlobalVlmSettings:
        values = self._values()
        defaults = GlobalVlmSettings()
        return GlobalVlmSettings(
            query_enabled=self._bool(values, "VLM_QUERY_ENABLED", defaults.query_enabled),
            verify_enabled=self._bool(values, "VLM_VERIFY_ENABLED", defaults.verify_enabled),
            query_prompt=values.get("VLM_QUERY_PROMPT", defaults.query_prompt),
            verify_prompt=values.get("VLM_VERIFY_PROMPT", defaults.verify_prompt),
        )

    def get_weights(self) -> RetrievalWeights:
        values = self._values()

        def weight(key: str) -> float:
            try:
                return float(values.get(key, "1"))
            except ValueError:
                return 1.0

        return RetrievalWeights(
            oracle_text=weight("RETRIEVAL_WEIGHT_ORACLE_TEXT"),
            text_vector=weight("RETRIEVAL_WEIGHT_TEXT_VECTOR"),
            visual_vector=weight("RETRIEVAL_WEIGHT_VISUAL_VECTOR"),
            vlm_text=weight("RETRIEVAL_WEIGHT_VLM_TEXT"),
            vlm_vector=weight("RETRIEVAL_WEIGHT_VLM_VECTOR"),
        )

    def _save(self, values: dict[str, object]) -> None:
        TARGET_ENV.touch(exist_ok=True)
        for key, value in values.items():
            if value == MASK:
                continue
            set_key(TARGET_ENV, key, str(value).lower() if isinstance(value, bool) else str(value))
            os.environ[key] = str(value)

    def save_mineru(self, settings: MinerUSettings) -> MinerUSettings:
        self._save(
            {
                "MINERU_ENABLED": settings.enabled,
                "MINERU_API_HOST": settings.base_url.rstrip("/"),
                "MINERU_API_TIMEOUT_SECONDS": settings.timeout_seconds,
            }
        )
        return self.get_mineru()

    def save_ocr(self, settings: OcrSettings) -> OcrSettings:
        values: dict[str, object] = {"OCR_ENABLED": settings.enabled}
        for prefix, engine in (
            ("DOTS_MOCR", settings.dots),
            ("OCR", settings.glm),
            ("UNLIMITED_OCR", settings.unlimited),
        ):
            values.update(
                {
                    f"{prefix}_ENABLED": engine.enabled,
                    f"{prefix}_API_HOST": engine.base_url.rstrip("/"),
                    f"{prefix}_MODEL": engine.model,
                    f"{prefix}_API_KEY": engine.api_key,
                    f"{prefix}_DPI": engine.dpi,
                    f"{prefix}_PDF_WORKERS": engine.workers,
                }
            )
            if prefix == "OCR":
                values["GLM_OCR_DPI"] = engine.dpi
        self._save(values)
        return self.get_ocr()

    def save_rerank(self, settings: RerankSettings) -> RerankSettings:
        self._save(
            {
                "OCI_RERANK_ENABLED": settings.enabled,
                "OCI_RERANK_MODEL": settings.model,
                "RERANK_CANDIDATE_COUNT": settings.candidate_count,
                "RERANK_TOP_N": settings.top_n,
            }
        )
        return self.get_rerank()

    def save_vlm(self, settings: GlobalVlmSettings) -> GlobalVlmSettings:
        self._save(
            {
                "VLM_QUERY_ENABLED": settings.query_enabled,
                "VLM_VERIFY_ENABLED": settings.verify_enabled,
                "VLM_QUERY_PROMPT": settings.query_prompt,
                "VLM_VERIFY_PROMPT": settings.verify_prompt,
            }
        )
        return self.get_vlm()

    def save_weights(self, settings: RetrievalWeights) -> RetrievalWeights:
        self._save(
            {
                "RETRIEVAL_WEIGHT_ORACLE_TEXT": settings.oracle_text,
                "RETRIEVAL_WEIGHT_TEXT_VECTOR": settings.text_vector,
                "RETRIEVAL_WEIGHT_VISUAL_VECTOR": settings.visual_vector,
                "RETRIEVAL_WEIGHT_VLM_TEXT": settings.vlm_text,
                "RETRIEVAL_WEIGHT_VLM_VECTOR": settings.vlm_vector,
            }
        )
        return self.get_weights()


retrieval_service_settings = RetrievalServiceSettingsStore()
