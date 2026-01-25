"""
AI Copilot サービス - OCI OpenAI を使用したデータ分析支援
"""
import os
import asyncio
import base64
import re
import logging
from pathlib import Path
from typing import List, Dict, Any, Optional, AsyncGenerator, Tuple
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError
from dotenv import load_dotenv, find_dotenv
import oci
import oci.retry
import oci.util
from oci_openai import AsyncOciOpenAI, OciUserPrincipalAuth

logger = logging.getLogger(__name__)

# プロジェクトルートの.envファイルを読み込み
project_root = Path(__file__).parent.parent.parent.parent
env_path = project_root / ".env"
if env_path.exists():
    load_dotenv(env_path)
    logger.info(f"環境変数を読み込みました: {env_path}")
else:
    # フォールバック: find_dotenvで検索
    dotenv_path = find_dotenv()
    if dotenv_path:
        load_dotenv(dotenv_path)
        logger.info(f"環境変数を読み込みました: {dotenv_path}")
    else:
        logger.warning(".envファイルが見つかりません。環境変数はシステムから読み込みます。")


class AICopilotService:
    """AI Copilot サービスクラス"""
    
    def __init__(self):
        """AI Copilot サービスの初期化"""
        self.region = os.environ.get("OCI_REGION", "us-chicago-1")
        self.compartment_id = os.environ.get("OCI_COMPARTMENT_OCID", "")
        self.model_name = os.environ.get("AI_MODEL_NAME", "xai.grok-code-fast-1")
        self.vision_model_name = os.environ.get("VISION_MODEL_NAME", "google.gemini-2.5-flash")
        self.oci_config_profile = os.environ.get("OCI_CONFIG_PROFILE", "DEFAULT")
        self.oci_config_file = os.environ.get("OCI_CONFIG_FILE", "~/.oci/config")
        self.web_access_enabled = os.environ.get("COPILOT_WEB_ACCESS", "1").lower() not in ("0", "false", "no")
        
        if not self.compartment_id:
            logger.warning("OCI_COMPARTMENT_OCID が設定されていません")
    
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

            # 画像が含まれているかに関わらず、常にVISION_MODEL_NAMEを使用
            # 画像数の検証とログ
            image_count = len(images) if images else 0
            if image_count > 5:
                logger.warning(f"画像数が上限を超えています: {image_count}枚 (最大5枚)")
                images = images[:5]
                image_count = 5
            
            if image_count > 0:
                logger.info(f"画像付きリクエスト: {image_count}枚の画像を処理中")
            else:
                logger.info(f"テキストのみのリクエスト (VISION_MODEL使用)")
            
            combined_prompt = self._build_combined_prompt(system_prompt, history, message)
            
            # VISION_MODEL (Gemini) APIを非同期で呼び出してストリーミング出力
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
        """
        Gemini APIを呼び出してストリーミング出力
        
        OCI Generative AI Inference APIのネイティブなストリーミング機能を使用。
        """
        # API呼び出しを別スレッドで実行
        async for chunk in self._oci_generate_text_with_images_native_streaming(prompt, images):
            yield chunk

    async def _oci_generate_text_with_images_native_streaming(self, prompt: str, images: List[Dict[str, Any]]) -> AsyncGenerator[str, None]:
        """
        OCI Generative AIのネイティブストリーミングを使用
        Qiita記事：for event in response.events(): yield json.loads(event.data)["text"]
        リアルタイムストリーミングのためキューを使用
        """
        import json
        import queue
        import threading
        
        logger.info("=== Gemini Streaming開始 ===")
        
        # リアルタイムでチャンクを受け渡すためのキュー
        chunk_queue = queue.Queue()
        
        def stream_worker():
            """Qiita記事のシンプルなアプローチでストリーミング"""
            try:
                events_gen = self._oci_generate_text_with_images_streaming_sync(prompt, images)
                chunk_count = 0
                
                for event in events_gen:
                    if not event or not hasattr(event, 'data'):
                        continue
                    
                    try:
                        event_obj = json.loads(event.data)
                        
                        # Cohere形式: {"text": "..."}
                        if 'text' in event_obj:
                            if event_obj['text']:
                                chunk_count += 1
                                chunk_queue.put(('chunk', event_obj['text']))
                        # Gemini形式: {"message": {"content": [{"type": "TEXT", "text": "..."}]}}
                        elif 'message' in event_obj:
                            content_list = event_obj.get('message', {}).get('content', [])
                            for item in content_list:
                                if item.get('type') == 'TEXT' and item.get('text'):
                                    chunk_count += 1
                                    chunk_queue.put(('chunk', item['text']))
                        # finishReason, usageはスキップ
                    except (json.JSONDecodeError, KeyError, TypeError):
                        continue
                
                logger.info(f"Streaming完了: {chunk_count}チャンク")
                chunk_queue.put(('done', None))
            except Exception as e:
                logger.error(f"Streamingエラー: {e}", exc_info=True)
                chunk_queue.put(('error', str(e)))
        
        # 別スレッドでストリーミング開始
        thread = threading.Thread(target=stream_worker, daemon=True)
        thread.start()
        
        # キューからチャンクを取得して即座にyield
        while True:
            try:
                msg_type, data = await asyncio.to_thread(chunk_queue.get, timeout=0.05)
                
                if msg_type == 'chunk':
                    yield data
                elif msg_type == 'done':
                    break
                elif msg_type == 'error':
                    yield f"\n\nエラー: {data}"
                    break
            except queue.Empty:
                await asyncio.sleep(0.001)
                continue

    def _oci_generate_text_with_images_streaming_sync(self, prompt: str, images: List[Dict[str, Any]]):
        """
        OCI Generative AIのストリーミングAPIを呼び出す（同期版）
        """
        logger.info("_oci_generate_text_with_images_streaming_sync開始")
        
        # クライアント作成を最大3回リトライ
        max_init_retries = 3
        client = None
        
        for retry in range(1, max_init_retries + 1):
            try:
                config = None
                signer = None
                try:
                    config = oci.config.from_file(self.oci_config_file, self.oci_config_profile)
                    logger.info("OCI config読み込み成功")
                except Exception as e:
                    logger.warning(f"OCI config読み込み失敗: {e}")
                    config = None

                if config is None:
                    try:
                        signer = oci.auth.signers.get_resource_principals_signer()
                        logger.info("Resource Principal Signer取得成功")
                    except Exception as e:
                        logger.warning(f"Resource Principal Signer取得失敗: {e}")
                        signer = None
                    if signer is None:
                        try:
                            signer = oci.auth.signers.InstancePrincipalsSecurityTokenSigner()
                            logger.info("Instance Principal Signer取得成功")
                        except Exception as e:
                            logger.warning(f"Instance Principal Signer取得失敗: {e}")
                            signer = None

                endpoint = f"https://inference.generativeai.{self.region}.oci.oraclecloud.com"
                logger.info(f"エンドポイント: {endpoint}")
                
                if config is not None:
                    client = oci.generative_ai_inference.GenerativeAiInferenceClient(
                        config=config,
                        service_endpoint=endpoint,
                        retry_strategy=oci.retry.NoneRetryStrategy(),
                        timeout=(10, 240),
                    )
                    logger.info(f"Client作成成功 (config使用) - {retry}回目")
                else:
                    client = oci.generative_ai_inference.GenerativeAiInferenceClient(
                        config={},
                        signer=signer,
                        service_endpoint=endpoint,
                        retry_strategy=oci.retry.NoneRetryStrategy(),
                        timeout=(10, 240),
                    )
                    logger.info(f"Client作成成功 (signer使用) - {retry}回目")
                
                # クライアント作成成功
                break
                
            except Exception as e:
                logger.warning(f"OCI Generative AIクライアント作成失敗（{retry}/{max_init_retries}回目）: {e}")
                if retry < max_init_retries:
                    import time
                    time.sleep(1)  # 1秒待機してリトライ
                else:
                    logger.error(f"OCI Generative AIクライアント作成に失敗しました（{max_init_retries}回リトライ）")
                    raise Exception("OCI Generative AIクライアントの初期化に失敗しました") from e
        
        if client is None:
            raise Exception("OCI Generative AIクライアントの作成に失敗しました")

        contents: List[Any] = [oci.generative_ai_inference.models.TextContent(text=prompt)]
        valid_image_count = 0
        for idx, img in enumerate((images or [])[:5]):
            data_url = (img or {}).get("data_url") or (img or {}).get("dataUrl")
            if not data_url:
                logger.warning(f"画像 #{idx+1}: data_url が見つかりません")
                continue
            mime, b64_data = self._parse_data_url(data_url)
            if not b64_data:
                logger.warning(f"画像 #{idx+1}: base64データの解析に失敗")
                continue
            url_value = f"data:{mime or 'image/jpeg'};base64,{b64_data}"
            image_url = oci.generative_ai_inference.models.ImageUrl(url=url_value, detail="AUTO")
            contents.append(oci.generative_ai_inference.models.ImageContent(image_url=image_url))
            valid_image_count += 1
        
        logger.info(f"有効な画像: {valid_image_count}枚")

        # is_stream=Trueでストリーミングを有効化
        chat_request = oci.generative_ai_inference.models.GenericChatRequest(
            api_format=oci.generative_ai_inference.models.BaseChatRequest.API_FORMAT_GENERIC,
            messages=[oci.generative_ai_inference.models.Message(role="USER", content=contents)],
            max_tokens=8192,
            temperature=0.0,
            top_p=0.95,
            top_k=1,
            is_stream=True  # ストリーミングを有効化
        )
        logger.info("ChatRequest作成完了 (is_stream=True)")

        chat_detail = oci.generative_ai_inference.models.ChatDetails(
            compartment_id=self.compartment_id,
            serving_mode=oci.generative_ai_inference.models.OnDemandServingMode(model_id=self.vision_model_name),
            chat_request=chat_request,
        )
        logger.info(f"ChatDetail作成完了 (model={self.vision_model_name})")

        logger.info("client.chat()呼び出し開始")
        try:
            response = client.chat(chat_detail)
            logger.info(f"client.chat()レスポンス取得, type={type(response)}")
            logger.info(f"response.data type={type(response.data)}")
            
            # response.dataはSSEClientオブジェクト
            # events()メソッドでイベントを取得
            events_gen = response.data.events()
            logger.info(f"events()取得完了, type={type(events_gen)}")
            return events_gen
        except Exception as e:
            logger.error(f"client.chat()呼び出しエラー: {e}", exc_info=True)
            raise

    async def _oci_generate_text_with_images(self, prompt: str, images: List[Dict[str, Any]]) -> str:
        return await asyncio.to_thread(self._oci_generate_text_with_images_sync, prompt, images)

    def _oci_generate_text_with_images_sync(self, prompt: str, images: List[Dict[str, Any]]) -> str:
        # クライアント作成を最大3回リトライ
        max_init_retries = 3
        client = None
        
        for retry in range(1, max_init_retries + 1):
            try:
                config = None
                signer = None
                try:
                    config = oci.config.from_file(self.oci_config_file, self.oci_config_profile)
                except Exception:
                    config = None

                if config is None:
                    try:
                        signer = oci.auth.signers.get_resource_principals_signer()
                    except Exception:
                        signer = None
                    if signer is None:
                        try:
                            signer = oci.auth.signers.InstancePrincipalsSecurityTokenSigner()
                        except Exception:
                            signer = None

                endpoint = f"https://inference.generativeai.{self.region}.oci.oraclecloud.com"
                if config is not None:
                    client = oci.generative_ai_inference.GenerativeAiInferenceClient(
                        config=config,
                        service_endpoint=endpoint,
                        retry_strategy=oci.retry.NoneRetryStrategy(),
                        timeout=(10, 240),
                    )
                    logger.info(f"Client作成成功 (config使用) - {retry}回目")
                else:
                    client = oci.generative_ai_inference.GenerativeAiInferenceClient(
                        config={},
                        signer=signer,
                        service_endpoint=endpoint,
                        retry_strategy=oci.retry.NoneRetryStrategy(),
                        timeout=(10, 240),
                    )
                    logger.info(f"Client作成成功 (signer使用) - {retry}回目")
                
                # クライアント作成成功
                break
                
            except Exception as e:
                logger.warning(f"OCI Generative AIクライアント作成失敗（{retry}/{max_init_retries}回目）: {e}")
                if retry < max_init_retries:
                    import time
                    time.sleep(1)  # 1秒待機してリトライ
                else:
                    logger.error(f"OCI Generative AIクライアント作成に失敗しました（{max_init_retries}回リトライ）")
                    raise Exception("OCI Generative AIクライアントの初期化に失敗しました") from e
        
        if client is None:
            raise Exception("OCI Generative AIクライアントの作成に失敗しました")

        contents: List[Any] = [oci.generative_ai_inference.models.TextContent(text=prompt)]
        valid_image_count = 0
        for idx, img in enumerate((images or [])[:5]):
            data_url = (img or {}).get("data_url") or (img or {}).get("dataUrl")
            if not data_url:
                logger.warning(f"画像 #{idx+1}: data_url が見つかりません")
                continue
            mime, b64_data = self._parse_data_url(data_url)
            if not b64_data:
                logger.warning(f"画像 #{idx+1}: base64データの解析に失敗")
                continue
            url_value = f"data:{mime or 'image/jpeg'};base64,{b64_data}"
            image_url = oci.generative_ai_inference.models.ImageUrl(url=url_value, detail="AUTO")
            contents.append(oci.generative_ai_inference.models.ImageContent(image_url=image_url))
            valid_image_count += 1
        
        logger.info(f"有効な画像: {valid_image_count}枚")

        chat_request = oci.generative_ai_inference.models.GenericChatRequest(
            api_format=oci.generative_ai_inference.models.BaseChatRequest.API_FORMAT_GENERIC,
            messages=[oci.generative_ai_inference.models.Message(role="USER", content=contents)],
            max_tokens=8192,
            temperature=0.0,
            top_p=0.95,
            top_k=1,
        )

        chat_detail = oci.generative_ai_inference.models.ChatDetails(
            compartment_id=self.compartment_id,
            serving_mode=oci.generative_ai_inference.models.OnDemandServingMode(model_id=self.vision_model_name),
            chat_request=chat_request,
        )

        response = client.chat(chat_detail)
        data = oci.util.to_dict(getattr(response, "data", response))
        
        # レスポンス情報をログ出力
        finish_reason = None
        try:
            finish_reason = data.get("chat_response", {}).get("choices", [{}])[0].get("finish_reason")
            if finish_reason:
                logger.info(f"Gemini応答完了理由: {finish_reason}")
        except Exception:
            pass
        
        extracted_text = self._extract_oci_chat_text(data)
        logger.info(f"Gemini応答テキスト長: {len(extracted_text)}文字")
        
        return extracted_text

    def _parse_data_url(self, data_url: str) -> Tuple[Optional[str], Optional[str]]:
        """Data URL から MIME タイプと base64 データを抽出"""
        if not data_url:
            return None, None
        m = re.match(r"^data:(?P<mime>[^;]+);base64,(?P<data>.+)$", data_url.strip())
        if not m:
            logger.debug("Data URL の形式が不正です")
            return None, None
        mime = m.group("mime")
        b64_data = m.group("data").strip()
        # base64データの妥当性を検証
        try:
            base64.b64decode(b64_data, validate=True)
        except Exception as e:
            logger.warning(f"base64 デコードエラー: {str(e)}")
            return mime, None
        return mime, b64_data

    def _extract_oci_chat_text(self, data: Dict[str, Any]) -> str:
        try:
            content = (
                data.get("chat_response", {})
                .get("choices", [{}])[0]
                .get("message", {})
                .get("content", [])
            )
            for item in content:
                if (item or {}).get("type") == "TEXT" and (item or {}).get("text"):
                    return (item or {}).get("text", "").strip()
        except Exception:
            pass

        texts: List[str] = []
        stack = [data]
        while stack:
            cur = stack.pop()
            if isinstance(cur, dict):
                if cur.get("type") == "TEXT" and isinstance(cur.get("text"), str):
                    texts.append(cur["text"])
                for v in cur.values():
                    stack.append(v)
            elif isinstance(cur, list):
                for v in cur:
                    stack.append(v)
        return "".join(texts).strip()
    
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
