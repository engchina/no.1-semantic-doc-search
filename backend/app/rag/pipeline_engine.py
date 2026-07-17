from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import mimetypes
import os
from contextlib import suppress
from collections import defaultdict
from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Any

import httpx
from openai import APIConnectionError, APIStatusError

from app.rag.clients import embedding_client, mineru_client, vlm_client
from app.rag.index_pipeline import (
    INDEX_OUTPUT_CONTRACT,
    PageExtraction,
    SourceBlock,
    _chunks,
    _clean_text,
    _convert_file_to_images_worker,
    _mineru_blocks,
    _native_pages,
    _run_ocr,
)
from app.rag.models import ProfileConfig, VlmExtractionOutput
from app.rag.pipeline_models import EmbeddingRecipe
from app.rag.pipeline_config import normalize_source_components, stage_config_hash
from app.rag.pipeline_repository import (
    ArtifactRecord,
    LeaseLostError,
    OraclePipelineRepository,
    RevisionRecord,
    pipeline_repository,
    stable_hash,
)
from app.rag.pipeline_repository_types import embedding_input_fingerprint
from app.rag.profile_repository import profile_repository
from app.rag.service_settings import retrieval_service_settings
from app.services.oci_service import oci_service

logger = logging.getLogger(__name__)

DEFAULT_PIPELINE_MAX_CONCURRENT_FILES = 3


def pipeline_max_concurrent_files() -> int:
    """全Jobを合算したファイル処理の同時実行上限を返す。"""
    return max(
        1,
        int(
            os.environ.get(
                "PIPELINE_MAX_CONCURRENT_FILES",
                str(DEFAULT_PIPELINE_MAX_CONCURRENT_FILES),
            )
        ),
    )


@dataclass
class ObjectContext:
    content: bytes
    revision: RevisionRecord
    release_id: str


class PipelineEngine:
    def __init__(self, repository: OraclePipelineRepository = pipeline_repository) -> None:
        self.repository = repository
        self._max_concurrent_files = pipeline_max_concurrent_files()
        self._file_slots = asyncio.Semaphore(self._max_concurrent_files)
        self._vlm_slots: asyncio.Semaphore | None = None

    @staticmethod
    def _is_transient_step_error(error: Exception) -> bool:
        if isinstance(error, (APIConnectionError, httpx.TransportError, TimeoutError)):
            return True
        if isinstance(error, APIStatusError):
            return error.status_code in {408, 409, 429} or error.status_code >= 500
        status = getattr(error, "status", None)
        return isinstance(status, int) and (status in {408, 409, 429} or status >= 500)

    @staticmethod
    def _transient_max_attempts() -> int:
        return max(
            1,
            int(os.environ.get("PIPELINE_TRANSIENT_STEP_MAX_ATTEMPTS", "2")),
        )

    @staticmethod
    def _transient_retry_delay(attempt: int) -> float:
        base = max(
            0.0,
            float(os.environ.get("PIPELINE_TRANSIENT_RETRY_DELAY_SECONDS", "5")),
        )
        return min(base * (2 ** max(0, attempt - 1)), 60.0)

    def _bounded_concurrency(self, name: str) -> int:
        return min(
            self._max_concurrent_files,
            max(
                1,
                int(os.environ.get(name, str(self._max_concurrent_files))),
            ),
        )

    def _max_concurrent_files_per_job(self) -> int:
        return self._bounded_concurrency("PIPELINE_MAX_CONCURRENT_FILES_PER_JOB")

    def _max_concurrent_vlm_steps(self) -> int:
        return self._bounded_concurrency("PIPELINE_MAX_CONCURRENT_VLM_STEPS")

    def _vlm_semaphore(self) -> asyncio.Semaphore:
        if self._vlm_slots is None:
            self._vlm_slots = asyncio.Semaphore(self._max_concurrent_vlm_steps())
        return self._vlm_slots

    def _input_hash(
        self,
        *,
        revision: RevisionRecord,
        release_id: str,
        kind: str,
        component: str,
    ) -> str:
        dependencies: list[str]
        if kind in {"RENDER", "NATIVE_PARSE", "MINERU_PARSE"}:
            dependencies = []
        elif kind == "OCR":
            dependencies = ["render"]
        elif kind == "NORMALIZE":
            dependencies = normalize_source_components()
        elif kind == "VLM":
            dependencies = ["render", "normalize"]
        elif kind == "EMBED":
            recipe = self.repository.get_recipe(component.split(":", 1)[1])
            dependencies = self._recipe_components(recipe)
        else:
            dependencies = []
        return stable_hash(
            {
                "revision": revision.revision_id,
                "content": revision.content_sha256,
                "inputs": [
                    (key, self.repository.component_hash(release_id, key))
                    for key in dependencies
                    if self.repository.component_hash(release_id, key)
                ],
            }
        )

    @staticmethod
    def _recipe_components(recipe: EmbeddingRecipe) -> list[str]:
        components: list[str] = []
        for value in recipe.inputs:
            component = {
                "PAGE_IMAGE": "render",
                "NATIVE_TEXT": "native_parse",
                "MINERU_TEXT": "mineru_parse",
                "OCR_TEXT": "ocr",
                "PAGE_TEXT": "normalize",
                "CHUNK_TEXT": "normalize",
                "VLM_TEXT": f"vlm:{value.source_ref}",
            }[value.source_type]
            if component not in components:
                components.append(component)
        return components

    async def _context(
        self,
        job_id: str,
        owner: str,
        generation: int,
        object_name: str,
        cache: dict[str, ObjectContext],
    ) -> ObjectContext:
        if object_name in cache:
            return cache[object_name]
        content = await asyncio.to_thread(oci_service.download_object, object_name)
        if not content:
            raise FileNotFoundError(f"Object Storageから取得できません: {object_name}")
        revision = await asyncio.to_thread(
            self.repository.register_revision,
            bucket=os.environ.get("OCI_BUCKET") or "",
            object_name=object_name,
            content=content,
            media_type=mimetypes.guess_type(object_name)[0],
            job_id=job_id,
            owner=owner,
            generation=generation,
        )
        release_id = await asyncio.to_thread(
            self.repository.ensure_draft_release,
            revision,
            job_id,
            owner=owner,
            generation=generation,
        )
        cache[object_name] = ObjectContext(content, revision, release_id)
        return cache[object_name]

    async def process_job(self, job_id: str, owner: str, generation: int) -> str:
        contexts: dict[str, ObjectContext] = {}
        lease_lost = asyncio.Event()
        active_steps: dict[asyncio.Task[None], str] = {}
        max_files = self._max_concurrent_files_per_job()
        # Rendering/OCR/VLM can each take several minutes.  A heartbeat only
        # after a step completes lets another worker reclaim the same job while
        # it is still running.  Keep a small background task extending the
        # lease for the entire processing loop; the worker remains the sole
        # owner and the task is always cancelled in ``finally``.
        lease_task = asyncio.create_task(
            self._lease_heartbeat(job_id, owner, generation, lease_lost),
            name=f"pipeline-lease:{job_id}",
        )
        try:
            while True:
                if lease_lost.is_set():
                    raise LeaseLostError("処理Jobのリースが失効しました")
                job = await asyncio.to_thread(self.repository.get_job, job_id)
                cancel_requested = bool(job["cancel_requested"])
                while not cancel_requested and len(active_steps) < max_files:
                    step = await asyncio.to_thread(
                        self.repository.next_step,
                        job_id,
                        tuple(active_steps.values()),
                    )
                    if not step:
                        break
                    step_id = str(step["step_id"])
                    object_name = str(step["object_name"])
                    # 全Job共有のスロットを確保してからRUNNINGへ遷移させる。
                    # 待機中の段階をQUEUEDのまま保つことで、画面上の状態と
                    # 実際にリソースを消費している処理を一致させる。
                    await self._file_slots.acquire()
                    slot_handed_off = False
                    try:
                        if lease_lost.is_set():
                            raise LeaseLostError("処理Jobのリースが失効しました")
                        latest_job = await asyncio.to_thread(
                            self.repository.get_job, job_id
                        )
                        cancel_requested = bool(latest_job["cancel_requested"])
                        if cancel_requested:
                            terminal = await self._terminal_status_after_lease_loss(
                                job_id, owner, generation
                            )
                            if terminal is not None:
                                return terminal
                            break

                        # Claim synchronously before creating the task.  This
                        # prevents this job owner from selecting the same QUEUED
                        # row twice while still allowing other files to advance.
                        await asyncio.to_thread(
                            self.repository.start_step,
                            step_id,
                            owner=owner,
                            generation=generation,
                        )
                    except LeaseLostError:
                        terminal = await self._terminal_status_after_lease_loss(
                            job_id, owner, generation
                        )
                        if terminal is not None:
                            return terminal
                        raise
                    else:
                        task = asyncio.create_task(
                            self._process_started_step_in_slot(
                                step=step,
                                contexts=contexts,
                                job_id=job_id,
                                owner=owner,
                                generation=generation,
                                lease_lost=lease_lost,
                            ),
                            name=f"pipeline-step:{job_id}:{step_id}",
                        )
                        slot_handed_off = True
                    finally:
                        if not slot_handed_off:
                            self._file_slots.release()
                    if cancel_requested:
                        break
                    active_steps[task] = object_name

                if active_steps:
                    done, _ = await asyncio.wait(
                        active_steps,
                        return_when=asyncio.FIRST_COMPLETED,
                    )
                    for task in done:
                        active_steps.pop(task, None)
                        try:
                            await task
                        except LeaseLostError:
                            terminal = await self._terminal_status_after_lease_loss(
                                job_id, owner, generation
                            )
                            if terminal is not None:
                                return terminal
                            raise
                        # Extend immediately after each step as well, so a
                        # short heartbeat outage does not leave a nearly-expired
                        # lease while other files continue running.
                        renewed = await asyncio.to_thread(
                            self.repository.heartbeat, job_id, owner, generation
                        )
                        if not renewed:
                            terminal = await self._terminal_status_after_lease_loss(
                                job_id, owner, generation
                            )
                            if terminal is not None:
                                return terminal
                            raise LeaseLostError("処理Jobのリースが失効しました")
                    continue

                if cancel_requested:
                    break
                # No ready step and no active file means all dependency chains
                # are terminal (succeeded, failed, blocked, or cancelled).
                break
            return await asyncio.to_thread(
                self.repository.finish_job, job_id, owner, generation
            )
        finally:
            for task in active_steps:
                task.cancel()
            if active_steps:
                await asyncio.gather(*active_steps, return_exceptions=True)
            lease_task.cancel()
            with suppress(asyncio.CancelledError):
                await lease_task

    async def _process_started_step_in_slot(
        self,
        *,
        step: dict[str, Any],
        contexts: dict[str, ObjectContext],
        job_id: str,
        owner: str,
        generation: int,
        lease_lost: asyncio.Event,
    ) -> None:
        """開始済み段階を実行し、終了経路にかかわらず共有スロットを返す。"""
        try:
            await self._process_started_step(
                step=step,
                contexts=contexts,
                job_id=job_id,
                owner=owner,
                generation=generation,
                lease_lost=lease_lost,
            )
        finally:
            self._file_slots.release()

    async def _terminal_status_after_lease_loss(
        self, job_id: str, owner: str, generation: int
    ) -> str | None:
        current_job = await asyncio.to_thread(self.repository.get_job, job_id)
        if not current_job["cancel_requested"]:
            return None
        status = str(current_job["status"])
        if status == "CANCELLED":
            return status
        if (
            status == "RUNNING"
            and str(current_job.get("lease_owner") or "") == owner
            and int(current_job.get("lease_generation") or 0) == generation
        ):
            return await asyncio.to_thread(
                self.repository.finish_job,
                job_id,
                owner,
                generation,
            )
        return None

    async def _process_started_step(
        self,
        *,
        step: dict[str, Any],
        contexts: dict[str, ObjectContext],
        job_id: str,
        owner: str,
        generation: int,
        lease_lost: asyncio.Event,
    ) -> None:
        step_id = str(step["step_id"])
        try:
            # Downloading the source and registering its immutable revision are
            # part of the already-claimed attempt, so setup failures persist as
            # FAILED instead of being mistaken for a lost lease.
            context = await self._context(
                job_id,
                owner,
                generation,
                str(step["object_name"]),
                contexts,
            )
            await asyncio.to_thread(
                self.repository.attach_step_context,
                step_id,
                owner=owner,
                generation=generation,
                document_id=context.revision.document_id,
                revision_id=context.revision.revision_id,
                release_id=context.release_id,
            )
            run_id, reused = await self._execute(
                step=step,
                context=context,
                job_id=job_id,
                owner=owner,
                generation=generation,
                lease_lost=lease_lost,
            )
            await asyncio.to_thread(
                self.repository.complete_step,
                step_id,
                run_id,
                owner=owner,
                generation=generation,
                reused=reused,
            )
        except LeaseLostError:
            raise
        except Exception as error:
            attempt = int(step.get("attempt_count") or 0) + 1
            if (
                self._is_transient_step_error(error)
                and attempt < self._transient_max_attempts()
            ):
                logger.warning(
                    "パイプライン段階で一時エラーが発生したため再試行します: "
                    "job=%s step=%s attempt=%s error=%s",
                    job_id,
                    step_id,
                    attempt,
                    str(error)[:200],
                )
                await asyncio.to_thread(
                    self.repository.requeue_step,
                    step_id,
                    str(error),
                    owner=owner,
                    generation=generation,
                    attempt=attempt,
                )
                delay = self._transient_retry_delay(attempt)
                if delay:
                    await asyncio.sleep(delay)
            else:
                logger.exception(
                    "パイプライン段階の実行に失敗しました: job=%s step=%s",
                    job_id,
                    step_id,
                )
                await asyncio.to_thread(
                    self.repository.fail_step,
                    step_id,
                    str(error),
                    owner=owner,
                    generation=generation,
                )

    async def _lease_heartbeat(
        self,
        job_id: str,
        owner: str,
        generation: int,
        lease_lost: asyncio.Event,
        *,
        interval_seconds: float = 30.0,
    ) -> None:
        """Renew a claimed job lease until the processing loop exits."""
        while True:
            await asyncio.sleep(interval_seconds)
            try:
                renewed = await asyncio.to_thread(
                    self.repository.heartbeat, job_id, owner, generation
                )
                if not renewed:
                    lease_lost.set()
                    return
            except Exception:
                logger.warning("パイプラインJobのheartbeatに失敗しました: %s", job_id, exc_info=True)
                lease_lost.set()
                return

    async def _execute(
        self,
        *,
        step: dict[str, Any],
        context: ObjectContext,
        job_id: str,
        owner: str,
        generation: int,
        lease_lost: asyncio.Event,
    ) -> tuple[str | None, bool]:
        kind = str(step["stage_kind"])
        component = str(step["component_key"])
        if kind == "PUBLISH":
            await asyncio.to_thread(
                self.repository.publish_release,
                context.revision.document_id,
                context.release_id,
                job_id=job_id,
                owner=owner,
                generation=generation,
            )
            # Publishing is the point at which a profile's artifacts become
            # searchable.  Recompute pending counts so APPLY_STATUS cannot
            # remain stuck at PROCESSING/PENDING after a successful job.
            for profile in profile_repository.enabled_profiles():
                await asyncio.to_thread(
                    profile_repository.refresh_apply_status, profile.slot_no
                )
            return None, False
        config_hash = stage_config_hash(kind, component)
        input_hash = self._input_hash(
            revision=context.revision,
            release_id=context.release_id,
            kind=kind,
            component=component,
        )
        cache_key = stable_hash(
            {
                "revision": context.revision.revision_id,
                "kind": kind,
                "component": component,
                "config": config_hash,
                "input": input_hash,
            }
        )
        if not bool(step.get("force_run")):
            cached = await asyncio.to_thread(self.repository.cached_stage_run, cache_key)
            if cached:
                await asyncio.to_thread(
                    self.repository.replace_component,
                    context.release_id,
                    component,
                    kind,
                    cached,
                    job_id=job_id,
                    owner=owner,
                    generation=generation,
                )
                return cached, True
        run_id = await asyncio.to_thread(
            self.repository.start_stage_run,
            revision_id=context.revision.revision_id,
            kind=kind,
            component_key=component,
            config_hash=config_hash,
            input_hash=input_hash,
            cache_key=cache_key,
        )
        profile_slot: int | None = None
        if kind == "VLM":
            profile_slot = int(component.split(":", 1)[1])
            # Keep the settings screen in sync with persistent jobs even when
            # the browser that started the job disconnects.
            await asyncio.to_thread(
                profile_repository.set_apply_status, profile_slot, "PROCESSING"
            )
        try:
            if kind == "VLM":
                async with self._vlm_semaphore():
                    count, coverage, metadata = await self._run_executor(
                        kind=kind,
                        component=component,
                        run_id=run_id,
                        context=context,
                    )
            else:
                count, coverage, metadata = await self._run_executor(
                    kind=kind,
                    component=component,
                    run_id=run_id,
                    context=context,
                )
            if lease_lost.is_set() or not await asyncio.to_thread(
                self.repository.heartbeat, job_id, owner, generation
            ):
                raise LeaseLostError("処理Jobのリースが失効しました")
            output_hash = await asyncio.to_thread(
                self.repository.stage_output_hash,
                run_id,
                kind,
            )
            await asyncio.to_thread(
                self.repository.complete_stage_run,
                run_id,
                output_count=count,
                coverage=coverage,
                metadata=metadata,
                output_hash=output_hash,
            )
            await asyncio.to_thread(
                self.repository.replace_component,
                context.release_id,
                component,
                kind,
                run_id,
                job_id=job_id,
                owner=owner,
                generation=generation,
            )
            if profile_slot is not None:
                # A draft result is intentionally not serving yet; refresh
                # computes PENDING until an atomic publish makes it visible.
                await asyncio.to_thread(
                    profile_repository.refresh_apply_status, profile_slot
                )
            return run_id, False
        except LeaseLostError:
            raise
        except Exception as error:
            await asyncio.to_thread(self.repository.fail_stage_run, run_id, str(error))
            if profile_slot is not None:
                await asyncio.to_thread(
                    profile_repository.set_apply_status, profile_slot, "FAILED"
                )
            raise

    async def _run_executor(
        self,
        *,
        kind: str,
        component: str,
        run_id: str,
        context: ObjectContext,
    ) -> tuple[int, float, dict[str, Any]]:
        if kind == "RENDER":
            return await self._render(run_id, context)
        if kind == "NATIVE_PARSE":
            return await self._native(run_id, context)
        if kind == "MINERU_PARSE":
            return await self._mineru(run_id, context)
        if kind == "OCR":
            return await self._ocr(run_id, context)
        if kind == "NORMALIZE":
            return await self._normalize(run_id, context)
        if kind == "VLM":
            return await self._vlm(run_id, context, int(component.split(":", 1)[1]))
        if kind == "EMBED":
            return await self._embed(run_id, context, component.split(":", 1)[1])
        raise ValueError(f"未対応の処理段階です: {kind}")

    async def _render(
        self, run_id: str, context: ObjectContext
    ) -> tuple[int, float, dict[str, Any]]:
        settings = retrieval_service_settings.get_ocr(mask_secrets=True)
        dpi = max(
            [200, *(item.dpi for item in (settings.dots, settings.glm, settings.unlimited) if item.enabled)]
        )
        extension = context.revision.document_type
        success, rendered, error = await asyncio.to_thread(
            _convert_file_to_images_worker,
            context.content,
            extension,
            context.revision.object_name,
            dpi,
            None,
            None,
        )
        if not success:
            raise RuntimeError(f"ページ画像の生成に失敗しました: {error}")
        folder = str(PurePosixPath(context.revision.object_name).with_suffix(""))
        artifacts: list[ArtifactRecord] = []
        for page_number, image in rendered:
            object_name = (
                f"{folder}/_pipeline/{context.revision.revision_id}/"
                f"{run_id}/page_{page_number:06d}.png"
            )
            uploaded = await asyncio.to_thread(
                oci_service.upload_file,
                image,
                object_name,
                "image/png",
                f"page_{page_number:06d}.png",
                len(image),
            )
            if not uploaded:
                raise RuntimeError(f"ページ画像を保存できませんでした: {page_number}")
            artifacts.append(
                ArtifactRecord(
                    artifact_kind="PAGE_IMAGE",
                    source_locator=f"page:{page_number}",
                    page_number=page_number,
                    object_name=object_name,
                    metadata={
                        "media_type": "image/png",
                        "dpi": dpi,
                        "size": len(image),
                    },
                    content_sha256=hashlib.sha256(image).hexdigest(),
                )
            )
        await asyncio.to_thread(
            self.repository.store_artifacts,
            run_id,
            context.revision.revision_id,
            artifacts,
        )
        return len(artifacts), 1.0 if artifacts else 0.0, {"dpi": dpi}

    async def _native(
        self, run_id: str, context: ObjectContext
    ) -> tuple[int, float, dict[str, Any]]:
        pages = await asyncio.to_thread(
            _native_pages,
            context.content,
            context.revision.document_type,
        )
        artifacts = [
            ArtifactRecord(
                artifact_kind="NATIVE_TEXT",
                source_locator=f"page:{page}",
                page_number=page,
                raw_text=text,
                search_text=_clean_text(f"{context.revision.file_name}\n{text}"),
                metadata={"parser": "native"},
            )
            for page, text in sorted(pages.items())
        ]
        await asyncio.to_thread(
            self.repository.store_artifacts,
            run_id,
            context.revision.revision_id,
            artifacts,
        )
        covered = sum(bool(item.raw_text) for item in artifacts)
        return len(artifacts), covered / max(1, len(artifacts)), {"parser": "native"}

    async def _mineru(
        self, run_id: str, context: ObjectContext
    ) -> tuple[int, float, dict[str, Any]]:
        settings = retrieval_service_settings.get_mineru()
        if not settings.enabled or not settings.base_url:
            raise RuntimeError("MinerUが有効化されていません")
        result = await mineru_client.parse_file(
            file_name=context.revision.file_name,
            content=context.content,
            media_type=context.revision.media_type,
            settings=settings,
        )
        grouped: dict[int, list[SourceBlock]] = defaultdict(list)
        for block in _mineru_blocks(result):
            grouped[block.page_number].append(block)
        artifacts = [
            ArtifactRecord(
                artifact_kind="MINERU_TEXT",
                source_locator=f"page:{page}",
                page_number=page,
                raw_text=_clean_text("\n\n".join(item.text for item in blocks)),
                search_text=_clean_text(
                    f"{context.revision.file_name}\n"
                    + "\n\n".join(item.text for item in blocks)
                ),
                payload={
                    "blocks": [
                        {"kind": item.kind, "text": item.text, "bbox": item.bbox}
                        for item in blocks
                    ]
                },
                metadata={"version": result.get("version") or result.get("engine_version")},
            )
            for page, blocks in sorted(grouped.items())
        ]
        await asyncio.to_thread(
            self.repository.store_artifacts,
            run_id,
            context.revision.revision_id,
            artifacts,
        )
        return len(artifacts), 1.0 if artifacts else 0.0, {
            "version": result.get("version") or result.get("engine_version")
        }

    async def _ocr(
        self, run_id: str, context: ObjectContext
    ) -> tuple[int, float, dict[str, Any]]:
        settings = retrieval_service_settings.get_ocr(mask_secrets=False)
        if not settings.enabled:
            raise RuntimeError("OCRが有効化されていません")
        images = self.repository.component_artifacts(
            context.release_id, "render", "PAGE_IMAGE"
        )
        degraded: list[str] = []
        pages: list[PageExtraction] = []
        for artifact in images:
            image = await asyncio.to_thread(
                oci_service.download_object, str(artifact["object_name"])
            )
            if image:
                pages.append(
                    PageExtraction(
                        page_number=int(artifact["page_number"]),
                        image=image,
                        image_dpi=int(artifact["metadata_json"].get("dpi") or 200),
                    )
                )
        await asyncio.gather(*(_run_ocr(page, degraded) for page in pages))
        by_page_image = {int(item["page_number"]): item for item in images}
        artifacts: list[ArtifactRecord] = []
        for page in pages:
            text = _clean_text("\n\n".join(block.text for block in page.ocr_blocks))
            if not text:
                continue
            image_artifact = by_page_image[page.page_number]
            artifacts.append(
                ArtifactRecord(
                    artifact_kind="OCR_TEXT",
                    source_locator=f"page:{page.page_number}",
                    page_number=page.page_number,
                    raw_text=text,
                    search_text=_clean_text(f"{context.revision.file_name}\n{text}"),
                    payload={
                        "blocks": [
                            {"kind": item.kind, "text": item.text, "bbox": item.bbox}
                            for item in page.ocr_blocks
                        ]
                    },
                    metadata={"engine": page.ocr_engine},
                    lineage=[(str(image_artifact["artifact_id"]), "PAGE_IMAGE", 1)],
                )
            )
        await asyncio.to_thread(
            self.repository.store_artifacts,
            run_id,
            context.revision.revision_id,
            artifacts,
        )
        return len(artifacts), len(artifacts) / max(1, len(pages)), {
            "degraded_services": sorted(set(degraded))
        }

    async def _normalize(
        self, run_id: str, context: ObjectContext
    ) -> tuple[int, float, dict[str, Any]]:
        artifact_kind = {
            "native_parse": "NATIVE_TEXT",
            "mineru_parse": "MINERU_TEXT",
            "ocr": "OCR_TEXT",
        }
        source_specs = tuple(
            (component, artifact_kind[component])
            for component in normalize_source_components()
        )
        by_page: dict[int, list[dict[str, Any]]] = defaultdict(list)
        for component, kind in source_specs:
            for artifact in self.repository.component_artifacts(
                context.release_id, component, kind
            ):
                if artifact.get("page_number") is not None:
                    by_page[int(artifact["page_number"])].append(artifact)
        for artifact in self.repository.component_artifacts(
            context.release_id, "render", "PAGE_IMAGE"
        ):
            by_page.setdefault(int(artifact["page_number"]), [])
        artifacts: list[ArtifactRecord] = []
        covered = 0
        for page_number, inputs in sorted(by_page.items()):
            text = _clean_text(
                "\n\n".join(
                    str(item["raw_text"])
                    for item in inputs
                    if str(item.get("raw_text") or "").strip()
                )
            )
            if text:
                covered += 1
            page = ArtifactRecord(
                artifact_kind="PAGE_TEXT",
                source_locator=f"page:{page_number}",
                page_number=page_number,
                raw_text=text,
                search_text=_clean_text(f"{context.revision.file_name}\n{text}"),
                metadata={"sources": sorted({str(item["artifact_kind"]) for item in inputs})},
                lineage=[
                    (str(item["artifact_id"]), str(item["artifact_kind"]), ordinal)
                    for ordinal, item in enumerate(inputs, 1)
                ],
            )
            page.finalize_hash()
            artifacts.append(page)
            for index, chunk_text in enumerate(_chunks(text), 1):
                artifacts.append(
                    ArtifactRecord(
                        artifact_kind="CHUNK_TEXT",
                        source_locator=f"page:{page_number}/chunk:{index}",
                        page_number=page_number,
                        parent_artifact_id=page.artifact_id,
                        raw_text=chunk_text,
                        search_text=_clean_text(
                            f"{context.revision.file_name}\n{chunk_text}"
                        ),
                        metadata={"chunk_index": index},
                        lineage=[(page.artifact_id, "PAGE_TEXT", 1)],
                    )
                )
        await asyncio.to_thread(
            self.repository.store_artifacts,
            run_id,
            context.revision.revision_id,
            artifacts,
        )
        page_count = len(by_page)
        return len(artifacts), covered / max(1, page_count), {"page_count": page_count}

    async def _vlm(
        self, run_id: str, context: ObjectContext, slot_no: int
    ) -> tuple[int, float, dict[str, Any]]:
        profile: ProfileConfig = profile_repository.get_profile(slot_no)
        pages = self.repository.component_artifacts(
            context.release_id, "normalize", "PAGE_TEXT"
        )
        images = {
            int(item["page_number"]): item
            for item in self.repository.component_artifacts(
                context.release_id, "render", "PAGE_IMAGE"
            )
        }
        # 288ページ級のカタログを直列処理すると1回の試行が1時間を超えるため、
        # 既存のAPI並列度設定の範囲でページを並列処理する。
        semaphore = asyncio.Semaphore(
            max(1, int(os.environ.get("API_CONCURRENT_LIMIT", "3")))
        )

        async def extract_page(page: dict[str, Any]) -> ArtifactRecord:
            page_number = int(page["page_number"])
            image_artifact = images.get(page_number)
            async with semaphore:
                image = (
                    await asyncio.to_thread(
                        oci_service.download_object, str(image_artifact["object_name"])
                    )
                    if image_artifact
                    else None
                )
                prompt = (
                    f"管理者の抽出指示:\n{profile.extraction_prompt}\n\n"
                    f"文書コンテキスト: "
                    f"{json.dumps({'object_name': context.revision.object_name, 'page_number': page_number}, ensure_ascii=False)}\n"
                    f"ページテキスト:\n{str(page['raw_text'])[:12000]}\n\n"
                    f"出典位置: page:{page_number}\n\n{INDEX_OUTPUT_CONTRACT}"
                )
                output = VlmExtractionOutput.model_validate(
                    await vlm_client.generate_json(prompt=prompt, image=image)
                )
            search_text = output.search_text()
            lineage = [(str(page["artifact_id"]), "PAGE_TEXT", 1)]
            if image_artifact:
                lineage.append((str(image_artifact["artifact_id"]), "PAGE_IMAGE", 2))
            return ArtifactRecord(
                artifact_kind="VLM_TEXT",
                source_locator=f"page:{page_number}",
                page_number=page_number,
                raw_text=search_text,
                search_text=_clean_text(
                    f"{context.revision.file_name}\n{search_text}"
                ),
                payload=output.model_dump(mode="json"),
                metadata={
                    "profile_slot": slot_no,
                    "profile_revision_id": profile.current_revision_id,
                },
                lineage=lineage,
            )

        artifacts: list[ArtifactRecord] = list(
            await asyncio.gather(*(extract_page(page) for page in pages))
        )
        await asyncio.to_thread(
            self.repository.store_artifacts,
            run_id,
            context.revision.revision_id,
            artifacts,
        )
        return len(artifacts), len(artifacts) / max(1, len(pages)), {
            "profile_slot": slot_no,
            "profile_revision_id": profile.current_revision_id,
        }

    async def _embed(
        self, run_id: str, context: ObjectContext, recipe_code: str
    ) -> tuple[int, float, dict[str, Any]]:
        recipe = self.repository.get_recipe(recipe_code)
        sources: dict[tuple[str, str | None], dict[int, list[dict[str, Any]]]] = {}
        source_component = {
            "PAGE_IMAGE": ("render", "PAGE_IMAGE"),
            "NATIVE_TEXT": ("native_parse", "NATIVE_TEXT"),
            "MINERU_TEXT": ("mineru_parse", "MINERU_TEXT"),
            "OCR_TEXT": ("ocr", "OCR_TEXT"),
            "PAGE_TEXT": ("normalize", "PAGE_TEXT"),
            "CHUNK_TEXT": ("normalize", "CHUNK_TEXT"),
        }
        for item in recipe.inputs:
            identity = (item.source_type, item.source_ref)
            if item.source_type == "VLM_TEXT":
                component, kind = f"vlm:{item.source_ref}", "VLM_TEXT"
            else:
                component, kind = source_component[item.source_type]
            grouped: dict[int, list[dict[str, Any]]] = defaultdict(list)
            for artifact in self.repository.component_artifacts(
                context.release_id, component, kind
            ):
                if artifact.get("page_number") is not None:
                    grouped[int(artifact["page_number"])].append(artifact)
            sources[identity] = grouped
        targets: list[tuple[int, dict[str, Any]]] = []
        if recipe.target_scope == "CHUNK":
            for artifact in self.repository.component_artifacts(
                context.release_id, "normalize", "CHUNK_TEXT"
            ):
                targets.append((int(artifact["page_number"]), artifact))
        else:
            # PAGE recipes are evaluated against the document's canonical page
            # set, not the union of whichever optional inputs happened to
            # exist.  Otherwise a missing OCR/VLM artifact silently disappears
            # from the denominator and reports 100% coverage.
            canonical = self.repository.component_artifacts(
                context.release_id, "render", "PAGE_IMAGE"
            )
            if not canonical:
                canonical = self.repository.component_artifacts(
                    context.release_id, "normalize", "PAGE_TEXT"
                )
            canonical_by_page = {
                int(item["page_number"]): item
                for item in canonical
                if item.get("page_number") is not None
            }
            for page in sorted(canonical_by_page):
                candidate = next(
                    (
                        artifacts[0]
                        for item in recipe.inputs
                        if (artifacts := sources[(item.source_type, item.source_ref)].get(page))
                    ),
                    canonical_by_page[page],
                )
                targets.append((page, candidate))
        # VLMと同様、大部数の文書を直列処理しないよう既存のAPI並列度設定の
        # 範囲でページを並列処理する。戻り値Noneはskip扱い。
        semaphore = asyncio.Semaphore(
            max(1, int(os.environ.get("API_CONCURRENT_LIMIT", "3")))
        )

        async def embed_target(
            page_number: int, target: dict[str, Any]
        ) -> tuple[str, str, list[float], list[tuple[str, str, int]]] | None:
            ordered: list[tuple[str, str | bytes, str]] = []
            lineage: list[tuple[str, str, int]] = []
            input_fingerprints: list[tuple[str, str, str]] = []
            async with semaphore:
                for ordinal, item in enumerate(recipe.inputs, 1):
                    candidates = sources[(item.source_type, item.source_ref)].get(
                        page_number, []
                    )
                    if recipe.target_scope == "CHUNK":
                        candidates = (
                            [target]
                            if item.source_type == "CHUNK_TEXT"
                            else candidates
                        )
                    artifact = candidates[0] if candidates else None
                    if not artifact:
                        if item.required:
                            return None
                        continue
                    if item.source_type == "PAGE_IMAGE":
                        image = await asyncio.to_thread(
                            oci_service.download_object, str(artifact["object_name"])
                        )
                        if not image:
                            return None
                        media_type = str(
                            artifact["metadata_json"].get("media_type") or "image/png"
                        )
                        ordered.append(("IMAGE", image, media_type))
                    else:
                        text = str(artifact.get("raw_text") or "").strip()
                        if not text:
                            if item.required:
                                return None
                            continue
                        ordered.append(("TEXT", text[:12000], "text/plain"))
                    lineage.append(
                        (str(artifact["artifact_id"]), item.source_type, ordinal)
                    )
                    input_fingerprints.append(
                        embedding_input_fingerprint(
                            item.source_type,
                            item.source_ref,
                            artifact["content_sha256"],
                        )
                    )
                # All-optional recipes can leave ``ordered`` empty on pages where
                # no input artifact exists; the OCI embed API rejects an empty
                # batch, so treat those pages as skipped rather than failed.
                if not ordered:
                    return None
                vector = await embedding_client.contents(
                    ordered_contents=ordered,
                    input_type="SEARCH_DOCUMENT",
                )
            return (
                str(target["artifact_id"]),
                stable_hash(input_fingerprints),
                vector,
                lineage,
            )

        results = await asyncio.gather(
            *(embed_target(page_number, target) for page_number, target in targets)
        )
        stored = [item for item in results if item is not None]
        skipped = len(results) - len(stored)
        await asyncio.to_thread(
            self.repository.store_embeddings,
            run_id=run_id,
            revision_id=context.revision.revision_id,
            recipe_revision_id=recipe.current_revision_id,
            values=stored,
        )
        total = len(targets)
        return len(stored), len(stored) / max(1, total), {
            "recipe_code": recipe.code,
            "recipe_revision_id": recipe.current_revision_id,
            "targets": total,
            "skipped": skipped,
        }


pipeline_engine = PipelineEngine()
