"""
AIコパイロットサービス

OCI Generative AI OpenAI互換APIを使用したAIアシスタント機能を提供します。
チャット形式の対話、画像分析、コード実行などの機能をサポートします。

モデルはOCI Enterprise AI設定のOCI_ENTERPRISE_AI_MODELから取得します。
"""
import asyncio
import logging
import os
import random
from typing import Any, AsyncGenerator, Dict, List, Optional

from openai import APIConnectionError, APIStatusError, AsyncOpenAI
from app.services.oci_service import oci_service

logger = logging.getLogger(__name__)

GENAI_API_MAX_RETRIES = int(os.environ.get("GENAI_API_MAX_RETRIES", "5"))
GENAI_API_BASE_DELAY = float(os.environ.get("GENAI_API_BASE_DELAY", "2.0"))
GENAI_API_MAX_DELAY = float(os.environ.get("GENAI_API_MAX_DELAY", "180.0"))
GENAI_API_JITTER = float(os.environ.get("GENAI_API_JITTER", "0.15"))

class AICopilotService:
    """AI Copilot サービスクラス"""

    @staticmethod
    def _is_genai_rate_limit_error(error: Exception) -> bool:
        return isinstance(error, APIStatusError) and error.status_code == 429

    @staticmethod
    def _is_genai_retryable_error(error: Exception) -> bool:
        if isinstance(error, APIConnectionError):
            return True
        return isinstance(error, APIStatusError) and (
            error.status_code in (408, 409, 429) or error.status_code >= 500
        )

    @staticmethod
    def _calculate_genai_backoff_delay(attempt: int, is_rate_limit: bool) -> float:
        multiplier = 3.5 if is_rate_limit else 2.0
        delay = min(GENAI_API_BASE_DELAY * multiplier ** attempt, GENAI_API_MAX_DELAY)
        delay += random.uniform(-GENAI_API_JITTER, GENAI_API_JITTER) * delay
        return max(1.0, delay)
    
    async def chat_stream(
        self,
        message: str,
        context: Optional[Dict[str, Any]] = None,
        history: Optional[List[Dict[str, str]]] = None,
        images: Optional[List[Dict[str, Any]]] = None
    ) -> AsyncGenerator[str, None]:
        """
        AIとチャットしてストリーミングレスポンスを取得
            
        Args:
            message: ユーザーメッセージ
            context: コンテキスト情報(データセット情報など)
            history: 会話履歴
            images: 画像リスト(最大5枚)
                
        Yields:
            str: AIレスポンスのチャンク
        """
        try:
            system_prompt = self._build_system_prompt(context)

            # 画像数の検証とログ
            image_count = len(images) if images else 0
            if image_count > 5:
                logger.warning(f"画像数が上限を超えています: {image_count}枚 (最大5枚)")
                images = images[:5]
                image_count = 5
            
            if image_count > 0:
                logger.info(f"画像付きリクエスト: {image_count}枚の画像を処理中")
            else:
                logger.info("テキストのみのリクエスト")
            
            combined_prompt = self._build_combined_prompt(system_prompt, history, message)
            
            async for chunk in self._oci_generate_text_with_images_streaming(combined_prompt, images):
                yield chunk

        except Exception as e:
            logger.error(f"AI Copilot エラー: {str(e)}")
            error_message = f"エラーが発生しました: {str(e)}"
            yield error_message

    def _build_combined_prompt(
        self,
        system_prompt: str,
        history: Optional[List[Dict[str, str]]],
        message: str
    ) -> str:
        """システムプロンプト、会話履歴、ユーザーメッセージを結合"""
        lines: List[str] = [system_prompt.strip()]
        if history:
            lines.append("")
            lines.append("会話履歴:")
            for item in history:
                if not item:  # None or 空辞書をスキップ
                    continue
                role = item.get("role", "")
                content = item.get("content", "")
                if role and content:
                    lines.append(f"{role.upper()}: {content}")
        lines.append("")
        if message:
            lines.append(f"USER: {message}")
        return "\n".join(lines).strip()

    async def _oci_generate_text_with_images_streaming(self, prompt: str, images: List[Dict[str, Any]]) -> AsyncGenerator[str, None]:
        """OpenAI SDKでOCI Generative AI OpenAI互換APIを呼び出す。"""
        settings = oci_service.get_enterprise_ai_settings()
        if not all((settings.base_url, settings.api_key, settings.model)):
            raise ValueError("OCI Enterprise AI設定（Base URL、API Key、Model）が必要です")

        client_options = {"base_url": settings.base_url, "api_key": settings.api_key, "max_retries": 0}
        if settings.project:
            client_options["project"] = settings.project
        client = AsyncOpenAI(**client_options)

        content: List[Dict[str, Any]] = [{"type": "text", "text": prompt}]
        for image in (images or [])[:5]:
            data_url = (image or {}).get("data_url") or (image or {}).get("dataUrl")
            if data_url:
                content.append({"type": "image_url", "image_url": {"url": data_url}})

        for attempt in range(GENAI_API_MAX_RETRIES):
            yielded = False
            try:
                stream = await client.chat.completions.create(
                    model=settings.model,
                    messages=[{"role": "user", "content": content}],
                    temperature=0.0,
                    seed=42,
                    stream=True,
                )
                async for chunk in stream:
                    text = chunk.choices[0].delta.content if chunk.choices else None
                    if text:
                        yielded = True
                        yield text
                return
            except Exception as error:
                if (
                    yielded
                    or not self._is_genai_retryable_error(error)
                    or attempt == GENAI_API_MAX_RETRIES - 1
                ):
                    raise
                is_rate_limit = self._is_genai_rate_limit_error(error)
                delay = self._calculate_genai_backoff_delay(attempt, is_rate_limit)
                logger.warning(
                    "OCI Enterprise AI API %s（リトライ %s/%s）: %.1f秒後に再試行 - %s",
                    "レート制限" if is_rate_limit else "エラー",
                    attempt + 1,
                    GENAI_API_MAX_RETRIES,
                    delay,
                    str(error)[:100],
                )
                await asyncio.sleep(delay)

    def _build_system_prompt(self, context: Optional[Dict[str, Any]] = None) -> str:
        """
        システムプロンプトを構築
        
        Args:
            context: コンテキスト情報
            
        Returns:
            str: システムプロンプト
        """
        # 汎用的なAIアシスタントプロンプト（1-2文に簡素化）
        base_prompt = """あなたは親切で有能なAIアシスタントです。必ず日本語で丁寧に回答してください。"""
        
        return base_prompt


# グローバルインスタンス
_copilot_service = None


def get_copilot_service() -> AICopilotService:
    """AI Copilot サービスのシングルトンインスタンスを取得"""
    global _copilot_service
    if _copilot_service is None:
        _copilot_service = AICopilotService()
    return _copilot_service
