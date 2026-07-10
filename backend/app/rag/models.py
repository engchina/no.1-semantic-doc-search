from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


DEFAULT_EXTRACTION_PROMPT = (
    "Extract the visual and textual information that will make this source easier to find."
)


class ProfileConfig(BaseModel):
    """One VLM extraction viewpoint. It never configures the shared retrieval pipeline."""

    model_config = ConfigDict(extra="forbid")

    slot_no: int = Field(ge=1, le=3)
    name: str = Field(min_length=1, max_length=200)
    enabled: bool = False
    extraction_prompt: str = Field(min_length=1, max_length=40_000)
    current_revision_id: str | None = None
    config_hash: str | None = None
    apply_status: Literal["NOT_APPLIED", "READY", "PENDING", "PROCESSING", "FAILED"] = (
        "NOT_APPLIED"
    )
    last_applied_at: datetime | None = None
    pending_document_count: int = Field(default=0, ge=0)

    @field_validator("name", "extraction_prompt")
    @classmethod
    def trim_required_text(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("value cannot be empty")
        return value


def initial_profiles() -> list[ProfileConfig]:
    return [
        ProfileConfig(
            slot_no=1,
            name="Profile 1",
            enabled=True,
            extraction_prompt=DEFAULT_EXTRACTION_PROMPT,
        ),
        ProfileConfig(
            slot_no=2,
            name="Profile 2",
            extraction_prompt=DEFAULT_EXTRACTION_PROMPT,
        ),
        ProfileConfig(
            slot_no=3,
            name="Profile 3",
            extraction_prompt=DEFAULT_EXTRACTION_PROMPT,
        ),
    ]


class VlmFact(BaseModel):
    model_config = ConfigDict(extra="forbid")

    text: str = Field(min_length=1, max_length=4000)
    source_locator: str = Field(min_length=1, max_length=512)
    confidence: float = Field(ge=0, le=1)


class VlmExtractionOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    summary: str = Field(default="", max_length=8000)
    keywords: list[str] = Field(default_factory=list, max_length=200)
    facts: list[VlmFact] = Field(default_factory=list, max_length=500)

    @field_validator("keywords")
    @classmethod
    def clean_keywords(cls, values: list[str]) -> list[str]:
        return list(dict.fromkeys(value.strip() for value in values if value.strip()))

    def search_text(self) -> str:
        return "\n".join(
            value
            for value in (
                self.summary.strip(),
                " ".join(self.keywords),
                "\n".join(item.text for item in self.facts),
            )
            if value
        )


class MinerUSettings(BaseModel):
    enabled: bool = True
    base_url: str = ""
    timeout_seconds: int = Field(default=1800, ge=10, le=7200)
    backend: Literal["pipeline"] = "pipeline"
    effort: Literal["medium"] = "medium"

    @field_validator("base_url")
    @classmethod
    def validate_base_url(cls, value: str) -> str:
        value = value.strip().rstrip("/")
        if value and urlparse(value).scheme not in {"http", "https"}:
            raise ValueError("base_url must use http or https")
        return value


class OcrEngineSettings(BaseModel):
    enabled: bool = False
    base_url: str = ""
    model: str = ""
    api_key: str = ""
    dpi: int = Field(default=200, ge=72, le=600)
    workers: int = Field(default=1, ge=1, le=32)

    @field_validator("base_url")
    @classmethod
    def validate_base_url(cls, value: str) -> str:
        value = value.strip().rstrip("/")
        if value and urlparse(value).scheme not in {"http", "https"}:
            raise ValueError("base_url must use http or https")
        return value


class OcrSettings(BaseModel):
    enabled: bool = True
    dots: OcrEngineSettings = Field(
        default_factory=lambda: OcrEngineSettings(enabled=True, dpi=200, workers=4)
    )
    glm: OcrEngineSettings = Field(
        default_factory=lambda: OcrEngineSettings(enabled=False, dpi=200, workers=1)
    )
    unlimited: OcrEngineSettings = Field(
        default_factory=lambda: OcrEngineSettings(enabled=True, dpi=300, workers=1)
    )


class RerankSettings(BaseModel):
    enabled: bool = True
    model: str = Field(default="cohere.rerank-v4.0-fast", min_length=1, max_length=256)
    candidate_count: int = Field(default=500, ge=1, le=500)
    top_n: int = Field(default=30, ge=1, le=100)

    @model_validator(mode="after")
    def validate_counts(self) -> "RerankSettings":
        if self.top_n > self.candidate_count:
            raise ValueError("top_n must be <= candidate_count")
        return self


class GlobalVlmSettings(BaseModel):
    query_enabled: bool = True
    verify_enabled: bool = True
    query_prompt: str = Field(
        default=(
            "Generate up to three concise search variants that preserve the user's meaning. "
            "Return JSON with query_variants and intent."
        ),
        min_length=1,
        max_length=40_000,
    )
    verify_prompt: str = Field(
        default=(
            "Verify whether the candidate image satisfies the user's request. "
            "Return JSON with verified, confidence, evidence, and failed_constraints."
        ),
        min_length=1,
        max_length=40_000,
    )


class RetrievalWeights(BaseModel):
    oracle_text: float = Field(default=1.0, ge=0, le=10)
    text_vector: float = Field(default=1.0, ge=0, le=10)
    visual_vector: float = Field(default=1.0, ge=0, le=10)
    vlm_text: float = Field(default=1.0, ge=0, le=10)
    vlm_vector: float = Field(default=1.0, ge=0, le=10)


class RetrievalSettingsResponse(BaseModel):
    schema_ready: bool
    profiles: list[ProfileConfig]
    mineru: MinerUSettings
    ocr: OcrSettings
    rerank: RerankSettings
    vlm: GlobalVlmSettings
    weights: RetrievalWeights
    vlm_model: str = ""


class FieldFilter(BaseModel):
    field_key: str = Field(pattern=r"^[A-Za-z][A-Za-z0-9_.-]{0,119}$")
    operator: Literal["eq", "contains", "gte", "lte", "between"]
    value: Any


class SearchV2Request(BaseModel):
    query: str = Field(min_length=1, max_length=4000)
    top_k: int = Field(default=20, ge=1, le=100)
    filename_filter: str | None = Field(default=None, max_length=1024)
    field_filters: list[FieldFilter] = Field(default_factory=list, max_length=50)
    document_types: list[str] = Field(default_factory=list, max_length=50)
    current_version_only: bool = True
    verify: bool = False
    debug: bool = False


class EvidenceResult(BaseModel):
    evidence_id: str
    document_id: str
    profile_slots: list[int]
    page_number: int | None = None
    unit_kind: str
    source_locator: str
    bbox: list[float] | None = None
    text_excerpt: str = ""
    caption: str = ""
    asset_url: str | None = None
    score: float
    rerank_score: float | None = None
    visual_rank: int | None = None
    text_rerank_rank: int | None = None
    retrieval_channels: list[str] = Field(default_factory=list)
    verification_status: Literal["not_requested", "verified", "unverified", "failed"] = (
        "not_requested"
    )
    profile_verifications: dict[str, Literal["verified", "unverified", "failed"]] = Field(
        default_factory=dict
    )
    match_reasons: list[str] = Field(default_factory=list)


class DocumentSearchResult(BaseModel):
    document_id: str
    file_name: str
    object_name: str
    bucket: str
    score: float
    profile_slots: list[int]
    evidence: list[EvidenceResult]


class SearchV2Response(BaseModel):
    success: bool = True
    trace_id: str
    query: str
    results: list[DocumentSearchResult]
    total_documents: int
    total_evidence: int
    processing_time: float
    diagnostics: dict[str, Any] = Field(default_factory=dict)
