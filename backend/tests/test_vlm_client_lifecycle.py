from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.rag.clients import VlmClient


def _settings() -> SimpleNamespace:
    return SimpleNamespace(
        base_url="https://enterprise-ai.example/openai/v1",
        api_key="secret",
        model="vlm-model",
        project=None,
    )


def _client(*, error: Exception | None = None) -> MagicMock:
    client = MagicMock()
    if error is None:
        response = SimpleNamespace(
            choices=[SimpleNamespace(message=SimpleNamespace(content='{"ok": true}'))]
        )
        client.chat.completions.create = AsyncMock(return_value=response)
    else:
        client.chat.completions.create = AsyncMock(side_effect=error)
    client.close = AsyncMock()
    return client


@pytest.mark.asyncio
async def test_vlm_client_configures_retry_timeout_and_closes(monkeypatch) -> None:
    monkeypatch.setenv("ENTERPRISE_AI_VLM_MAX_RETRIES", "2")
    monkeypatch.setenv("ENTERPRISE_AI_VLM_CONNECT_TIMEOUT_SECONDS", "30")
    monkeypatch.setenv("ENTERPRISE_AI_VLM_REQUEST_TIMEOUT_SECONDS", "600")
    client = _client()

    with (
        patch(
            "app.rag.clients.oci_service.get_enterprise_ai_settings",
            return_value=_settings(),
        ),
        patch("app.rag.clients.AsyncOpenAI", return_value=client) as factory,
    ):
        result = await VlmClient().generate_json(prompt="extract")

    options = factory.call_args.kwargs
    assert result == {"ok": True}
    assert options["max_retries"] == 2
    assert options["timeout"].connect == 30
    assert options["timeout"].read == 600
    client.close.assert_awaited_once()


@pytest.mark.asyncio
async def test_vlm_client_closes_connection_pool_after_error() -> None:
    client = _client(error=RuntimeError("connection failed"))

    with (
        patch(
            "app.rag.clients.oci_service.get_enterprise_ai_settings",
            return_value=_settings(),
        ),
        patch("app.rag.clients.AsyncOpenAI", return_value=client),
        pytest.raises(RuntimeError, match="connection failed"),
    ):
        await VlmClient().generate_json(prompt="extract")

    client.close.assert_awaited_once()
