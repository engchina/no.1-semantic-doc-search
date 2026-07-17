from __future__ import annotations

import asyncio
import signal

from app.rag.pipeline_dispatcher import PipelineDispatcher


async def main() -> None:
    dispatcher = PipelineDispatcher()
    loop = asyncio.get_running_loop()
    stopping = asyncio.Event()
    for signal_name in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(signal_name, stopping.set)
    await dispatcher.start()
    await stopping.wait()
    await dispatcher.stop()


if __name__ == "__main__":
    asyncio.run(main())
