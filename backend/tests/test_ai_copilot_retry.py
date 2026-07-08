import asyncio
from types import SimpleNamespace

import httpx
from openai import APIStatusError

from app.services import ai_copilot


def test_enterprise_ai_retries_before_streaming(monkeypatch):
    calls = 0

    class Completions:
        async def create(self, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                response = httpx.Response(429, request=httpx.Request("POST", "https://example.com"))
                raise APIStatusError("rate limit exceeded", response=response, body=None)

            async def chunks():
                yield SimpleNamespace(
                    choices=[SimpleNamespace(delta=SimpleNamespace(content="ok"))]
                )

            return chunks()

    class Client:
        def __init__(self, **kwargs):
            self.chat = SimpleNamespace(completions=Completions())

    monkeypatch.setattr(ai_copilot, "AsyncOpenAI", Client)
    monkeypatch.setattr(
        ai_copilot.oci_service,
        "get_enterprise_ai_settings",
        lambda: SimpleNamespace(base_url="https://example.com", api_key="key", project=None, model="model"),
    )

    async def no_sleep(_delay):
        return None

    monkeypatch.setattr(ai_copilot.asyncio, "sleep", no_sleep)

    async def collect():
        service = ai_copilot.AICopilotService()
        return [chunk async for chunk in service._oci_generate_text_with_images_streaming("hi", [])]

    assert asyncio.run(collect()) == ["ok"]
    assert calls == 2


def test_only_transient_status_errors_are_retryable():
    service = ai_copilot.AICopilotService()

    def error(status):
        response = httpx.Response(status, request=httpx.Request("POST", "https://example.com"))
        return APIStatusError("error", response=response, body=None)

    assert all(service._is_genai_retryable_error(error(status)) for status in (408, 409, 429, 500))
    assert not any(service._is_genai_retryable_error(error(status)) for status in (400, 401, 403, 404, 422))
    assert not service._is_genai_retryable_error(RuntimeError("application error"))
