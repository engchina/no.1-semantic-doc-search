import asyncio

from app.utils.sse import heartbeats_until_done


def test_heartbeats_are_emitted_while_task_is_running():
    async def slow_task():
        await asyncio.sleep(0.03)
        return True

    async def collect():
        task = asyncio.create_task(slow_task())
        events = []
        async for event in heartbeats_until_done(
            task,
            lambda: {"type": "heartbeat"},
            interval=0.01,
        ):
            events.append(event)
        return events, await task

    events, result = asyncio.run(collect())

    assert result is True
    assert events
    assert all(event["type"] == "heartbeat" for event in events)
