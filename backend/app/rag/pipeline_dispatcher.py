from __future__ import annotations

import asyncio
import logging
import os
import socket
from contextlib import suppress
from uuid import uuid4

from app.rag.pipeline_engine import pipeline_engine, pipeline_max_concurrent_files
from app.rag.pipeline_repository import pipeline_repository

logger = logging.getLogger(__name__)


class PipelineDispatcher:
    def __init__(self, max_concurrent_jobs: int | None = None) -> None:
        self.owner = f"{socket.gethostname()}:{os.getpid()}:{uuid4().hex[:8]}"
        self._task: asyncio.Task[None] | None = None
        self._wake = asyncio.Event()
        self._stopping = False
        global_limit = pipeline_max_concurrent_files()
        configured = max(
            1,
            max_concurrent_jobs
            if max_concurrent_jobs is not None
            else int(
                os.environ.get("PIPELINE_MAX_CONCURRENT_JOBS", str(global_limit))
            ),
        )
        self._max_concurrent_jobs = min(global_limit, configured)

    async def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stopping = False
        self._task = asyncio.create_task(self._run(), name="pipeline-dispatcher")

    def wake(self) -> None:
        self._wake.set()

    async def stop(self) -> None:
        self._stopping = True
        self._wake.set()
        task = self._task
        self._task = None
        if task:
            # A FULL job can run for hours.  Application shutdown must not wait
            # for every remaining stage; cancel only this worker coroutine and
            # let the persisted Oracle lease expire so another worker can
            # recover the job without duplicating completed steps.
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task

    async def _run(self) -> None:
        active_jobs: dict[asyncio.Task[str], str] = {}
        try:
            while not self._stopping:
                try:
                    for task, job_id in list(active_jobs.items()):
                        if not task.done():
                            continue
                        active_jobs.pop(task, None)
                        try:
                            task.result()
                        except Exception:
                            # The durable lease remains the recovery boundary;
                            # one failed job task must not stop other jobs.
                            logger.warning(
                                "パイプラインJobの実行に失敗しました: %s",
                                job_id,
                                exc_info=True,
                            )

                    # Schema provisioning can happen after API startup.  Poll
                    # quietly until the versioned tables exist; the migration
                    # endpoint calls ``wake`` once it has queued the rebuild job.
                    if not await asyncio.to_thread(pipeline_repository.schema_ready):
                        await self._wait_for_activity(active_jobs)
                        continue

                    while len(active_jobs) < self._max_concurrent_jobs:
                        claim = await asyncio.to_thread(
                            pipeline_repository.claim_next_job, self.owner
                        )
                        if not claim:
                            break
                        job_id, generation = claim
                        task = asyncio.create_task(
                            pipeline_engine.process_job(
                                job_id, self.owner, generation
                            ),
                            name=f"pipeline-job:{job_id}",
                        )
                        active_jobs[task] = job_id

                    await self._wait_for_activity(active_jobs)
                except Exception:
                    # A database may be temporarily unavailable while the app
                    # is starting or during wallet rotation.  Keep the
                    # dispatcher and any other active jobs alive.
                    logger.warning(
                        "パイプラインJobの取得または実行に失敗しました",
                        exc_info=True,
                    )
                    await self._wait_for_activity(active_jobs)
        finally:
            for task in active_jobs:
                task.cancel()
            if active_jobs:
                await asyncio.gather(*active_jobs, return_exceptions=True)

    async def _wait_for_activity(
        self, active_jobs: dict[asyncio.Task[str], str]
    ) -> None:
        self._wake.clear()
        if not active_jobs:
            try:
                await asyncio.wait_for(self._wake.wait(), timeout=2)
            except asyncio.TimeoutError:
                pass
            return

        wake_task = asyncio.create_task(
            self._wake.wait(), name="pipeline-dispatcher-wake"
        )
        try:
            await asyncio.wait(
                [*active_jobs, wake_task],
                timeout=2,
                return_when=asyncio.FIRST_COMPLETED,
            )
        finally:
            if not wake_task.done():
                wake_task.cancel()
            with suppress(asyncio.CancelledError):
                await wake_task


pipeline_dispatcher = PipelineDispatcher()
