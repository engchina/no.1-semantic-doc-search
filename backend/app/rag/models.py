from __future__ import annotations

from datetime import datetime
from typing import Any, Literal
from urllib.parse import urlparse

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


PROFILE_DOCUMENT_PAGE_PROMPT = (
    "文書・資料・ページを後から特定しやすくするため、次の情報を抽出してください。\n"
    "- 資料種別\n"
    "- 主題\n"
    "- 項目名、章、セクション\n"
    "- 数値、条件、比較対象\n"
    "- ページ特定に有効なキーワード\n"
    "- 検索に使える短い要約、キーワード、根拠付き事実\n"
    "- 元の内容にない推測は加えない"
)
PROFILE_SPEC_DATA_PROMPT = (
    "仕様・条件・データ確認に使える情報として、次の情報を抽出してください。\n"
    "- 対象項目\n"
    "- 機能、性能\n"
    "- 数値、単位、制限\n"
    "- 対応範囲\n"
    "- 比較条件\n"
    "- 判断に必要な根拠情報\n"
    "- 検索に使える短い要約、キーワード、根拠付き事実\n"
    "- 元の内容にない推測は加えない"
)
PROFILE_VISUAL_PROMPT = (
    "画像やビジュアル資料を探しやすくするため、次の情報を抽出してください。\n"
    "- 主対象\n"
    "- 色、形、素材\n"
    "- 数量、配置、位置関係\n"
    "- 背景や周辺要素\n"
    "- 見え方、角度、構図\n"
    "- 検索に有効なキーワード\n"
    "- 検索に使える短い要約、キーワード、根拠付き事実\n"
    "- 元の内容にない推測は加えない"
)
DEFAULT_EXTRACTION_PROMPT = PROFILE_VISUAL_PROMPT

DEFAULT_QUERY_SYNONYM_GROUPS: tuple[tuple[str, ...], ...] = (
    ("請求書", "インボイス"),
    ("伝票", "文書"),
    ("経費", "費用"),
    ("申請", "申込"),
    ("承認", "承認者"),
    ("保管", "保存", "格納"),
    ("原本", "原紙"),
    ("規程", "規則", "ポリシー"),
    ("手順", "手順書", "マニュアル"),
    ("検索", "探索"),
    ("表", "表形式", "テーブル"),
    ("図", "図版", "画像"),
    ("支払", "支払い"),
    ("期限", "期日"),
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
            extraction_prompt=PROFILE_DOCUMENT_PAGE_PROMPT,
        ),
        ProfileConfig(
            slot_no=2,
            name="Profile 2",
            extraction_prompt=PROFILE_SPEC_DATA_PROMPT,
        ),
        ProfileConfig(
            slot_no=3,
            name="Profile 3",
            extraction_prompt=PROFILE_VISUAL_PROMPT,
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


LEGACY_VLM_VERIFY_PROMPT = (
    "候補画像がユーザー条件に合っているか確認してください。\n"
    "- 主対象を確認する\n"
    "- 重要な視覚特徴を確認する\n"
    "- 数量、配置、位置関係を確認する\n"
    "- 背景や周辺要素を確認する\n"
    "- ユーザーが重視している条件を確認する\n"
    "- 一致ならverifiedをtrueにする\n"
    "- 一部一致または不一致ならverifiedをfalseにする\n"
    "- 必ずJSONで返す\n"
    "- 使用するキーはverified、confidence、evidence、failed_constraintsのみ"
)

DEFAULT_VLM_VERIFY_PROMPT = (
    "候補画像がユーザーの検索条件を満たすか、画像と候補コンテキストで確認できる事実だけに基づいて厳格に判定してください。\n"
    "- 問い合わせから必須条件と参考条件を区別する\n"
    "- 主対象、形状、色、材質、数量、配置、位置関係を確認する\n"
    "- 参照画像がある場合は主対象と重要な視覚特徴を比較し、背景や撮影条件の差は重視しない\n"
    "- 推測や外部知識で不足情報を補わない\n"
    "- 必須条件が1つでも不一致、または確認不能ならverifiedをfalseにする\n"
    "- すべての必須条件を確認できた場合だけverifiedをtrueにする\n"
    "- confidenceは判定の確信度を0から1で返す\n"
    "- evidenceには判定根拠となる確認済み事実を簡潔に列挙する\n"
    "- failed_constraintsには不一致または確認不能な必須条件を列挙する\n"
    "- 必ずJSONで返す\n"
    "- 使用するキーはverified、confidence、evidence、failed_constraintsのみ"
)


class GlobalVlmSettings(BaseModel):
    verify_prompt: str = Field(
        default=DEFAULT_VLM_VERIFY_PROMPT,
        min_length=1,
        max_length=40_000,
    )


class QueryExpansionSettings(BaseModel):
    enabled: bool = False
    llm_enabled: bool = False
    max_variants: int = Field(default=3, ge=1, le=8)
    llm_prompt: str = Field(
        default=(
            "ユーザーの問い合わせから検索バリエーションを作成してください。\n"
            "- 元の目的を保つ\n"
            "- 重要条件を保持する\n"
            "- 表記ゆれや同義語を考慮する\n"
            "- 短い検索バリエーションを作成する\n"
            "- 必ずJSONで返す\n"
            "- 使用するキーはquery_variantsのみ"
        ),
        min_length=1,
        max_length=40_000,
    )
    synonym_groups: list[list[str]] = Field(
        default_factory=lambda: [list(group) for group in DEFAULT_QUERY_SYNONYM_GROUPS],
        max_length=200,
    )

    @field_validator("synonym_groups")
    @classmethod
    def normalize_synonyms(cls, groups: list[list[str]]) -> list[list[str]]:
        normalized_groups: list[list[str]] = []
        seen_groups: set[tuple[str, ...]] = set()
        for group in groups:
            normalized: list[str] = []
            seen_terms: set[str] = set()
            for term in group:
                value = " ".join(str(term).split())
                key = value.casefold()
                if value and key not in seen_terms:
                    normalized.append(value)
                    seen_terms.add(key)
            if len(normalized) < 2:
                continue
            group_key = tuple(term.casefold() for term in normalized)
            if group_key not in seen_groups:
                normalized_groups.append(normalized)
                seen_groups.add(group_key)
        return normalized_groups


class RetrievalWeights(BaseModel):
    oracle_text: float = Field(default=1.0, ge=0, le=10)
    text_vector: float = Field(default=1.0, ge=0, le=10)
    visual_vector: float = Field(default=1.0, ge=0, le=10)
    vlm_text: float = Field(default=1.0, ge=0, le=10)
    vlm_vector: float = Field(default=1.0, ge=0, le=10)


RetrievalMode = Literal[
    "oracle_text",
    "text_vector",
    "vlm_text",
    "vlm_vector",
    "visual_vector",
]
RETRIEVAL_MODES: tuple[RetrievalMode, ...] = (
    "oracle_text",
    "text_vector",
    "vlm_text",
    "vlm_vector",
    "visual_vector",
)


class RetrievalModeOption(BaseModel):
    value: RetrievalMode
    label: str
    description: str
    available: bool = True
    unavailable_reason: str | None = None


class RetrievalSettingsResponse(BaseModel):
    schema_ready: bool
    profiles: list[ProfileConfig]
    mineru: MinerUSettings
    ocr: OcrSettings
    rerank: RerankSettings
    vlm: GlobalVlmSettings
    query_expansion: QueryExpansionSettings
    weights: RetrievalWeights
    vlm_model: str = ""


class FieldFilter(BaseModel):
    field_key: str = Field(pattern=r"^[A-Za-z][A-Za-z0-9_.-]{0,119}$")
    operator: Literal["eq", "contains", "gte", "lte", "between"]
    value: Any


class SearchV2Request(BaseModel):
    query: str = Field(min_length=1, max_length=4000)
    top_k: int = Field(default=20, ge=1, le=100)
    min_score: float = Field(default=0.0, ge=0.0, le=1.0)
    filename_filter: str | None = Field(default=None, max_length=1024)
    field_filters: list[FieldFilter] = Field(default_factory=list, max_length=50)
    document_types: list[str] = Field(default_factory=list, max_length=50)
    current_version_only: bool = True
    retrieval_modes: list[RetrievalMode] | None = Field(
        default=None,
        min_length=1,
        max_length=len(RETRIEVAL_MODES),
    )
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
    image_similarity_score: float | None = None
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
    rerank_score: float | None = None
    image_similarity_score: float | None = None
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
