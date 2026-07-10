import asyncio


async def heartbeats_until_done(task: asyncio.Task, event_factory, interval: float = 2.0):
    while not task.done():
        try:
            await asyncio.wait_for(asyncio.shield(task), timeout=interval)
        except asyncio.TimeoutError:
            if not task.done():
                yield event_factory()
