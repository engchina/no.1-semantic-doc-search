from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


StageKind = Literal[
    "RENDER",
    "NATIVE_PARSE",
    "MINERU_PARSE",
    "OCR",
    "NORMALIZE",
    "VLM",
    "EMBED",
    "PUBLISH",
]
RecipeInputSource = Literal[
    "PAGE_IMAGE",
    "NATIVE_TEXT",
    "MINERU_TEXT",
    "OCR_TEXT",
    "PAGE_TEXT",
    "CHUNK_TEXT",
    "VLM_TEXT",
]
TargetScope = Literal["PAGE", "CHUNK"]
PublishMode = Literal["DRAFT", "AUTO"]
PipelineMode = Literal["FULL", "CUSTOM"]
PageImageReleaseSelector = Literal["latest", "draft", "serving"]


class PipelineStepSelector(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: StageKind
    key: str | None = Field(default=None, max_length=200)

    @model_validator(mode="after")
    def validate_component_key(self) -> "PipelineStepSelector":
        if self.kind in {"VLM", "EMBED"} and not (self.key or "").strip():
            raise ValueError("VLMまたはEmbeddingには処理対象の指定が必要です")
        if self.kind not in {"VLM", "EMBED"} and self.key:
            raise ValueError("この処理段階には個別キーを指定できません")
        return self

    @property
    def component_key(self) -> str:
        if self.kind == "VLM":
            return f"vlm:{self.key}"
        if self.kind == "EMBED":
            return f"embedding:{self.key}"
        return self.kind.casefold()


class PipelineJobRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    object_names: list[str] = Field(min_length=1, max_length=500)
    mode: PipelineMode = "FULL"
    steps: list[PipelineStepSelector] = Field(default_factory=list, max_length=100)
    force: bool = False
    include_downstream: bool = False
    publish_mode: PublishMode = "AUTO"

    @field_validator("object_names")
    @classmethod
    def normalize_object_names(cls, values: list[str]) -> list[str]:
        normalized = list(dict.fromkeys(value.strip() for value in values if value.strip()))
        if not normalized:
            raise ValueError("処理対象のファイルを指定してください")
        if any(
            value.startswith("_pipeline/") or "/_pipeline/" in value
            for value in normalized
        ):
            raise ValueError("内部のページ画像は処理対象に指定できません")
        return normalized

    @model_validator(mode="after")
    def validate_mode(self) -> "PipelineJobRequest":
        if self.mode == "FULL":
            self.steps = []
            # FULL already expands every currently enabled stage explicitly in
            # the planner.  Re-expanding the generic downstream impact set can
            # reintroduce disabled optional stages such as OCR or MinerU.
            self.include_downstream = False
            self.publish_mode = "AUTO"
        elif not self.steps:
            raise ValueError("個別処理では少なくとも1つの処理段階を指定してください")
        return self


class PipelineJobPreview(BaseModel):
    object_count: int
    requested_steps: list[str]
    prerequisite_steps: list[str]
    downstream_steps: list[str]
    estimated_oci_calls: int
    estimated_pages: int
    publish_mode: PublishMode
    can_publish_automatically: bool
    warnings: list[str] = Field(default_factory=list)


class PipelineJobAccepted(BaseModel):
    success: bool = True
    job_id: str
    status: str
    status_url: str
    events_url: str
    reused: bool = False


class PipelineJobStepStatus(BaseModel):
    step_id: str
    object_name: str
    document_id: str | None = None
    revision_id: str | None = None
    release_id: str | None = None
    kind: StageKind
    component_key: str
    status: str
    progress_current: int = 0
    progress_total: int = 0
    attempt_count: int = 0
    error_summary: str | None = None


class PipelineJobStatus(BaseModel):
    job_id: str
    status: str
    mode: PipelineMode
    publish_mode: PublishMode
    cancel_requested: bool
    total_steps: int
    completed_steps: int
    failed_steps: int
    created_at: datetime | None = None
    updated_at: datetime | None = None
    steps: list[PipelineJobStepStatus] = Field(default_factory=list)


class EmbeddingRecipeInput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source_type: RecipeInputSource
    source_ref: str | None = Field(default=None, max_length=200)
    required: bool = True

    @model_validator(mode="after")
    def validate_source_reference(self) -> "EmbeddingRecipeInput":
        if self.source_type == "VLM_TEXT" and not (self.source_ref or "").strip():
            raise ValueError("VLM_TEXTにはVLMプロファイル番号が必要です")
        if self.source_type == "VLM_TEXT":
            # Profile slots are persisted as NUMBER(2) (1..99). Validate this
            # at the API boundary instead of failing later in the executor.
            raw_slot = str(self.source_ref).strip()
            try:
                slot_no = int(raw_slot)
            except (TypeError, ValueError) as error:
                raise ValueError("VLM_TEXTの参照先は1〜99のプロファイル番号です") from error
            if not 1 <= slot_no <= 99 or str(slot_no) != raw_slot:
                raise ValueError("VLM_TEXTの参照先は1〜99のプロファイル番号です")
        if self.source_type != "VLM_TEXT" and self.source_ref:
            raise ValueError("VLM_TEXT以外には参照先を指定できません")
        return self


class EmbeddingRecipeUpsert(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str = Field(pattern=r"^[a-z][a-z0-9_]{1,62}$")
    name: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=1000)
    enabled: bool = False
    search_weight: float = Field(default=1.0, ge=0, le=10)
    target_scope: TargetScope
    inputs: list[EmbeddingRecipeInput] = Field(min_length=1, max_length=10)

    @field_validator("name", "description")
    @classmethod
    def strip_text(cls, value: str) -> str:
        return value.strip()

    @model_validator(mode="after")
    def validate_inputs(self) -> "EmbeddingRecipeUpsert":
        image_count = sum(item.source_type == "PAGE_IMAGE" for item in self.inputs)
        if image_count > 1:
            raise ValueError("1つのレシピに指定できる画像は1件までです")
        if image_count and self.target_scope != "PAGE":
            raise ValueError("画像を含むレシピの対象単位はページにしてください")
        # A chunk target may combine chunk text with optional page/VLM text.
        # The previous implementation rejected every non-CHUNK_TEXT input here,
        # which made valid VLM_TEXT recipes impossible to represent (and was
        # inconsistent with the recipe input list documented by the API).  The
        # executor resolves all inputs on the same page; only PAGE_IMAGE has a
        # hard PAGE-target restriction above.
        identities = [(item.source_type, item.source_ref or "") for item in self.inputs]
        if len(set(identities)) != len(identities):
            raise ValueError("同じ入力を重複して指定できません")
        return self


class EmbeddingRecipe(EmbeddingRecipeUpsert):
    recipe_id: str
    current_revision_id: str
    revision_no: int
    config_hash: str
    model_id: str = "cohere.embed-v4.0"
    output_dimensions: int = 1536


class PageImageReleaseSummary(BaseModel):
    release_id: str
    release_status: str
    revision_id: str
    count: int = 0
    stage_status: str = "NOT_RUN"


class DocumentPageImageVersions(BaseModel):
    selector: PageImageReleaseSelector = "latest"
    selected: PageImageReleaseSummary | None = None
    draft: PageImageReleaseSummary | None = None
    serving: PageImageReleaseSummary | None = None


class PageImageArtifact(BaseModel):
    artifact_id: str
    page_number: int
    media_type: str = "image/png"
    size: int | None = None
    content_sha256: str
    created_at: datetime | None = None
    stage_status: str


class PageImagePagination(BaseModel):
    current_page: int
    page_size: int
    total: int
    total_pages: int
    has_next: bool
    has_prev: bool


class DocumentPageImagesResponse(BaseModel):
    document_id: str
    object_name: str
    revision_id: str
    release_id: str
    release_status: str
    stage_status: str
    total: int
    items: list[PageImageArtifact] = Field(default_factory=list)
    pagination: PageImagePagination


class PageTextArtifact(BaseModel):
    component_key: str
    artifact_kind: str
    page_number: int
    raw_text: str = ""
    payload_json: Any | None = None
    created_at: datetime | None = None
    stage_status: str


class DocumentPageTextsResponse(BaseModel):
    document_id: str
    selector: PageImageReleaseSelector = "latest"
    release_id: str
    release_status: str
    page_number: int
    items: list[PageTextArtifact] = Field(default_factory=list)


class DocumentProcessingStatus(BaseModel):
    document_id: str
    object_name: str
    document_status: str
    current_revision_id: str | None = None
    serving_release_id: str | None = None
    draft_release_id: str | None = None
    publication_status: Literal["PUBLISHED", "UPDATE_AVAILABLE", "UNPUBLISHED", "ERROR"]
    stages: dict[str, str] = Field(default_factory=dict)
    stale_reasons: dict[str, str] = Field(default_factory=dict)
    page_images: DocumentPageImageVersions = Field(
        default_factory=DocumentPageImageVersions
    )
