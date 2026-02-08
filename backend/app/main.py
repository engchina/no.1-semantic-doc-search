"""
セマンティック文書検索システム - メインAPIアプリケーション
"""
import io
import json
import logging
import os
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import time
import uuid
import zipfile
from contextlib import asynccontextmanager
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Request, Query, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pdf2image import convert_from_path
from PIL import Image as PILImage
from pydantic import BaseModel

# ログ設定
LOG_FORMAT = "%(asctime)s | %(levelname)-8s | %(name)s:%(lineno)d | %(message)s"
LOG_DATE_FORMAT = "%Y-%m-%d %H:%M:%S"

logging.basicConfig(
    level=logging.INFO,
    format=LOG_FORMAT,
    datefmt=LOG_DATE_FORMAT,
    handlers=[logging.StreamHandler(sys.stdout)]
)

logger = logging.getLogger(__name__)

# 環境変数の読み込み
project_root = Path(__file__).parent.parent
env_path = project_root / ".env"
if env_path.exists():
    load_dotenv(env_path)

# モデルのインポート
from app.models.oci import OCISettings, OCISettingsResponse, OCIConnectionTestRequest, OCIConnectionTestResponse
from app.models.document import DocumentUploadResponse, DocumentInfo, DocumentListResponse, DocumentDeleteRequest, DocumentDeleteResponse
from app.models.search import SearchQuery, SearchResponse
from app.models.database import (
    DatabaseSettings,
    DatabaseSettingsResponse,
    DatabaseConnectionTestRequest,
    DatabaseConnectionTestResponse,
    DatabaseInfo,
    DatabaseInfoResponse,
    TableInfo,
    DatabaseTablesResponse,
    WalletUploadResponse,
    DatabaseStorageResponse
)
from app.models.adb import (
    ADBGetRequest,
    ADBGetResponse,
    ADBOperationRequest,
    ADBOperationResponse
)

# サービスのインポート
from app.services.oci_service import oci_service
# @deprecated: document_processor は非推奨（テキストベース検索は未実装・実装予定なし）
# from app.services.document_processor import document_processor
from app.services.database_service import database_service
from app.services.adb_service import adb_service
from app.services.ai_copilot import get_copilot_service
from app.services.image_vectorizer import image_vectorizer
from app.services.parallel_processor import parallel_processor, JobManager
from app.utils.auth_util import do_auth, get_username_from_connection_string

# ========================================
# アプリケーションライフサイクル
# ========================================

@asynccontextmanager
async def lifespan(app: FastAPI):
    """アプリケーションのライフサイクル管理"""
    # startup処理（必要に応じて追加）
    yield
    # shutdown処理
    logger.info("アプリケーションシャットダウン開始...")
    
    # データベースサービスのシャットダウン
    try:
        from app.services.database_service import database_service
        database_service.shutdown()
    except Exception as e:
        logger.error(f"データベースサービスシャットダウンエラー: {e}")
    
    await parallel_processor.shutdown()
    logger.info("アプリケーションシャットダウン完了")

# FastAPIアプリケーション初期化
app = FastAPI(
    title="セマンティック文書検索システムAPI",
    version="0.1.0",
    description="OCI Object Storageベースのセマンティック文書検索システム",
    lifespan=lifespan
)

# CORS設定
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# デバッグモード設定
debug_mode = os.getenv("DEBUG", "False").lower() == "true"

# UI機能トグル設定
show_ai_assistant = os.getenv("SHOW_AI_ASSISTANT", "true").lower() == "true"
show_search_tab = os.getenv("SHOW_SEARCH_TAB", "true").lower() == "true"

# セッション管理（メモリ内）
# Token -> {username: str, expires_at: datetime}
SESSIONS: Dict[str, Dict[str, Any]] = {}
SESSION_TIMEOUT_SECONDS = 86400  # 24時間

# 外部API用のAPIキー管理
# APIキーは環境変数 EXTERNAL_API_KEYS から取得（カンマ区切り）
EXTERNAL_API_KEYS = set(os.getenv("EXTERNAL_API_KEYS", "").split(",")) if os.getenv("EXTERNAL_API_KEYS") else set()

# 一時トークン管理（検索結果URL用、短寿命）
# temp_token -> {expires_at: datetime, source: str}
TEMP_TOKENS: Dict[str, Dict[str, Any]] = {}
TEMP_TOKEN_TIMEOUT_SECONDS = int(os.getenv("TEMP_TOKEN_TIMEOUT_SECONDS", "300"))  # デフォルト5分

def generate_temp_token(source: str = "search") -> str:
    """
    短寿命の一時トークンを生成
    
    Args:
        source: トークンの発行元（ログ用）
    
    Returns:
        生成された一時トークン
    """
    temp_token = secrets.token_urlsafe(32)  # URL安全な44文字のトークン
    expires_at = datetime.now() + timedelta(seconds=TEMP_TOKEN_TIMEOUT_SECONDS)
    TEMP_TOKENS[temp_token] = {
        "expires_at": expires_at,
        "source": source
    }
    
    # 期限切れトークンのクリーンアップ（メモリ節約）
    current_time = datetime.now()
    expired_tokens = [t for t, data in TEMP_TOKENS.items() if data["expires_at"] < current_time]
    for t in expired_tokens:
        del TEMP_TOKENS[t]
    
    return temp_token

def validate_temp_token(temp_token: str) -> bool:
    """
    一時トークンを検証
    
    Args:
        temp_token: 検証するトークン
    
    Returns:
        有効な場合True
    """
    if temp_token not in TEMP_TOKENS:
        return False
    
    token_data = TEMP_TOKENS[temp_token]
    if token_data["expires_at"] < datetime.now():
        del TEMP_TOKENS[temp_token]
        return False
    
    return True

class LoginRequest(BaseModel):
    username: str
    password: str

# ストレージパス設定
STORAGE_PATH = Path(os.getenv("STORAGE_PATH", "./storage"))
UPLOAD_PATH = STORAGE_PATH / "uploads"
METADATA_PATH = STORAGE_PATH / "metadata"

# ディレクトリ作成
STORAGE_PATH.mkdir(parents=True, exist_ok=True)
UPLOAD_PATH.mkdir(parents=True, exist_ok=True)
METADATA_PATH.mkdir(parents=True, exist_ok=True)

# メタデータストレージ（本番環境ではDBを使用）
DOCUMENTS_METADATA_FILE = METADATA_PATH / "documents.json"

def load_documents_metadata() -> List[dict]:
    """文書メタデータを読み込む"""
    if DOCUMENTS_METADATA_FILE.exists():
        with open(DOCUMENTS_METADATA_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    return []

def save_documents_metadata(documents: List[dict]):
    """文書メタデータを保存"""
    with open(DOCUMENTS_METADATA_FILE, 'w', encoding='utf-8') as f:
        json.dump(documents, f, ensure_ascii=False, indent=2)

# ========================================
# ヘルスチェック
# ========================================

@app.get("/")
async def root():
    """ルートエンドポイント"""
    return {
        "name": "Semantic Document Search API",
        "version": "0.1.0",
        "status": "running"
    }

@app.get("/health")
async def health_check():
    """ヘルスチェック"""
    return {
        "status": "healthy",
        "timestamp": datetime.now().isoformat()
    }

# ========================================
# 認証ミドルウェア
# ========================================

@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    """認証チェックミドルウェア（セッショントークン、APIキー、一時トークンに対応）"""
    # 除外パス（nginxプロキシ経由を想定: /api/* -> /*）
    path = request.url.path
    excluded_paths = [
        "/",
        "/health",
        "/login",
        "/logout",
        "/config"
    ]
    
    if path in excluded_paths or \
       path.startswith("/public/") or \
       request.method == "OPTIONS":
        return await call_next(request)
        
    # デバッグモードは認証スキップ
    if debug_mode:
        return await call_next(request)
    
    # 認証情報を取得
    auth_header = request.headers.get("Authorization")
    token = None
    
    if auth_header:
        if auth_header.startswith("Bearer "):
            token = auth_header.split(" ")[1]
        elif auth_header.startswith("ApiKey "):
            # 外部API用のAPIキー認証
            api_key = auth_header.split(" ")[1]
            if api_key in EXTERNAL_API_KEYS:
                logger.info(f"外部APIキー認証成功: path={path}")
                return await call_next(request)
            else:
                logger.warning(f"無効なAPIキー: path={path}")
                return JSONResponse(status_code=401, content={"detail": "無効なAPIキーです"})
    
    # クエリパラメータからトークンを取得
    if not token:
        token = request.query_params.get("token")
    
    # APIキーをクエリパラメータからも取得（互換性のため残すが非推奨）
    api_key_query = request.query_params.get("api_key")
    if api_key_query and api_key_query in EXTERNAL_API_KEYS:
        logger.info(f"外部APIキー認証成功（クエリパラメータ）: path={path}")
        return await call_next(request)
    
    # 一時トークン検証（検索結果URL用、短寿命）
    temp_token = request.query_params.get("t")
    if temp_token and validate_temp_token(temp_token):
        logger.debug(f"一時トークン認証成功: path={path}")
        return await call_next(request)
    
    if not token:
        return JSONResponse(status_code=401, content={"detail": "認証が必要です"})
    
    # セッショントークンの検証
    if token not in SESSIONS:
        return JSONResponse(status_code=401, content={"detail": "無効または期限切れのトークンです"})
    
    # 有効期限チェック
    session_data = SESSIONS.get(token)
    if not session_data:
        return JSONResponse(status_code=401, content={"detail": "無効または期限切れのトークンです"})
        
    if session_data.get("expires_at") and session_data["expires_at"] < datetime.now():
        del SESSIONS[token]
        return JSONResponse(status_code=401, content={"detail": "セッションが期限切れです"})
    
    return await call_next(request)

# ========================================
# 認証エンドポイント
# ========================================

@app.get("/config")
def get_config():
    """フロントエンドに設定情報を公開"""
    return {
        "debug": debug_mode,
        "require_login": not debug_mode,
        "show_ai_assistant": show_ai_assistant,
        "show_search_tab": show_search_tab
    }

@app.post("/login")
def login(request: LoginRequest):
    """ログイン認証"""
    if debug_mode:
        # デバッグモード時は常に成功
        username = get_username_from_connection_string() or "debug-user"
        return {
            "status": "success", 
            "message": "デバッグモード: ログインをスキップしました", 
            "token": "debug-token", 
            "username": username
        }
    
    if do_auth(request.username, request.password):
        # トークン生成と保存
        token = secrets.token_hex(32)
        expires_at = datetime.now() + timedelta(seconds=SESSION_TIMEOUT_SECONDS)
        SESSIONS[token] = {
            "username": request.username,
            "expires_at": expires_at
        }
        
        # 期限切れトークンのクリーンアップ
        current_time = datetime.now()
        expired_tokens = [t for t, data in SESSIONS.items() if isinstance(data, dict) and data.get("expires_at") and data["expires_at"] < current_time]
        for t in expired_tokens:
            del SESSIONS[t]
            
        return {
            "status": "success", 
            "message": "ログインに成功しました", 
            "token": token, 
            "username": request.username
        }
    else:
        raise HTTPException(status_code=401, detail="ユーザー名またはパスワードが正しくありません")

@app.post("/logout")
def logout(request: Request):
    """ログアウト処理"""
    if debug_mode:
        return {"status": "success", "message": "デバッグモード: ログアウトをスキップしました"}

    auth_header = request.headers.get("Authorization")
    if auth_header and auth_header.startswith("Bearer "):
        token = auth_header.split(" ")[1]
        if token in SESSIONS:
            del SESSIONS[token]
            return {"status": "success", "message": "ログアウトしました"}
            
    return {"status": "success", "message": "既にログアウトしているか、無効なトークンです"}

# ========================================
# OCI設定管理
# ========================================

@app.get("/oci/settings", response_model=OCISettingsResponse)
async def get_oci_settings():
    """OCI設定を取得"""
    try:
        settings = oci_service.get_settings()
        
        # キー情報をマスク
        has_credentials = bool(settings.user_ocid and settings.tenancy_ocid and settings.fingerprint and settings.key_content)
        
        if settings.key_content:
            settings.key_content = '[CONFIGURED]'
        
        return OCISettingsResponse(
            settings=settings,
            is_configured=has_credentials,
            status="configured" if has_credentials else "not_configured",
            has_credentials=has_credentials
        )
    except Exception as e:
        logger.error(f"OCI設定取得エラー: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/oci/settings", response_model=OCISettingsResponse)
async def save_oci_settings(settings: OCISettings):
    """OCI設定を保存"""
    try:
        success = oci_service.save_settings(settings)
        
        if not success:
            raise HTTPException(status_code=500, detail="設定の保存に失敗しました")
        
        # 保存後の設定を取得
        saved_settings = oci_service.get_settings()
        
        # Private Keyの内容は返さない（セキュリティ上の理由）
        safe_settings = saved_settings.copy()
        if safe_settings.key_content:
            safe_settings.key_content = "[CONFIGURED]"
        
        return OCISettingsResponse(
            settings=safe_settings,
            is_configured=True,
            has_credentials=True,
            status="saved",
            message="設定を保存しました"
        )
            
    except Exception as e:
        logger.error(f"OCI設定保存エラー: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/oci/test", response_model=OCIConnectionTestResponse)
async def test_oci_connection(request: OCIConnectionTestRequest):
    """OCI接続テスト"""
    try:
        result = oci_service.test_connection(request.settings)
        
        return OCIConnectionTestResponse(
            success=result["success"],
            message=result["message"],
            details=result.get("details")
        )
    except Exception as e:
        logger.error(f"OCI接続テストエラー: {e}")
        return OCIConnectionTestResponse(
            success=False,
            message=f"接続テストエラー: {str(e)}"
        )

@app.get("/oci/namespace")
async def get_oci_namespace():
    """OCI Object StorageのNamespaceを取得"""
    try:
        result = oci_service.get_namespace()
        
        if result.get("success"):
            return {
                "success": True,
                "namespace": result.get("namespace"),
                "source": result.get("source", "unknown")
            }
        else:
            raise HTTPException(status_code=500, detail=result.get("message", "Namespace取得エラー"))
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Namespace取得エラー: {e}")
        raise HTTPException(status_code=500, detail=str(e))

class ObjectStorageSettingsRequest(BaseModel):
    bucket_name: str
    namespace: str

@app.post("/oci/object-storage/save")
async def save_object_storage_settings(request: ObjectStorageSettingsRequest):
    """Object Storage設定を保存"""
    try:
        result = oci_service.save_object_storage_settings(
            bucket_name=request.bucket_name,
            namespace=request.namespace
        )
        return result
    except Exception as e:
        logger.error(f"Object Storage設定保存エラー: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/oci/object-storage/test")
async def test_object_storage_connection(request: ObjectStorageSettingsRequest):
    """Object Storage接続テスト"""
    try:
        # Namespaceを検証
        namespace_result = oci_service.get_namespace()
        if not namespace_result.get("success"):
            return {
                "success": False,
                "message": f"Namespace取得エラー: {namespace_result.get('message')}"
            }
        
        # Bucketへのアクセスをテスト
        client = oci_service.get_object_storage_client()
        if not client:
            return {
                "success": False,
                "message": "Object Storage Clientの取得に失敗しました"
            }
        
        # Bucketの存在確認
        try:
            bucket_response = client.get_bucket(
                namespace_name=request.namespace,
                bucket_name=request.bucket_name
            )
            
            return {
                "success": True,
                "message": f"接続成功: Bucket '{request.bucket_name}' にアクセスできました",
                "details": {
                    "bucket_name": bucket_response.data.name,
                    "namespace": request.namespace,
                    "created_by": bucket_response.data.created_by if hasattr(bucket_response.data, 'created_by') else None
                }
            }
        except Exception as bucket_e:
            logger.error(f"Bucketアクセスエラー: {bucket_e}")
            return {
                "success": False,
                "message": f"Bucket '{request.bucket_name}' へのアクセスに失敗: {str(bucket_e)}"
            }
        
    except Exception as e:
        logger.error(f"Object Storage接続テストエラー: {e}")
        return {
            "success": False,
            "message": f"接続テストエラー: {str(e)}"
        }

@app.get("/oci/objects")
async def list_oci_objects(
    prefix: str = Query(default="", description="プレフィックス（フォルダパス）"),
    page: int = Query(default=1, ge=1, description="ページ番号"),
    page_size: int = Query(default=50, ge=1, le=100, description="ページサイズ"),
    filter_page_images: str = Query(default="all", description="ページ画像化フィルター: all, done, not_done"),
    filter_embeddings: str = Query(default="all", description="ベクトル化フィルター: all, done, not_done"),
    display_type: str = Query(default="files_only", description="表示タイプ: files_only, files_and_images")
):
    """OCI Object Storage内のオブジェクト一覧を取得（最適化版）"""
    try:
        # 環境変数からバケット名を取得
        bucket_name = os.getenv("OCI_BUCKET")
        
        if not bucket_name:
            raise HTTPException(status_code=400, detail="バケット名が設定されていません")
        
        # Namespaceを取得
        namespace_result = oci_service.get_namespace()
        if not namespace_result.get("success"):
            raise HTTPException(status_code=500, detail=f"Namespace取得エラー: {namespace_result.get('message')}")
        
        namespace = namespace_result.get("namespace")
        
        # 最適化: ストリーミング処理でメモリ使用量を削減
        all_objects = []
        page_token = None
        max_fetch_count = int(os.getenv("MAX_OBJECTS_FETCH", "10000"))
        fetch_count = 0
        
        # 親ファイル名マップ（高速検索用）
        parent_files_map = {}  # {parent_folder_path: True}
        
        while fetch_count < max_fetch_count:
            result = oci_service.list_objects(
                bucket_name=bucket_name,
                namespace=namespace,
                prefix=prefix,
                page_size=1000,
                page_token=page_token
            )
            
            if not result.get("success"):
                raise HTTPException(status_code=500, detail=result.get("message", "オブジェクト一覧取得エラー"))
            
            objects = result.get("objects", [])
            
            # 最適化: バッチ処理で親ファイルマップを構築
            for obj in objects:
                obj_name = obj["name"]
                if not obj_name.endswith('/'):
                    obj_name_without_ext = re.sub(r'\.[^.]+$', '', obj_name)
                    # 拡張子なしファイル名から元のファイル名へのマッピングを保存
                    parent_files_map[obj_name_without_ext] = obj_name
            
            all_objects.extend(objects)
            fetch_count += len(objects)
            
            page_token = result.get("next_start_with")
            if not page_token:
                break
        
        # ページネーション情報を計算
        total = len(all_objects)
        start_idx = (page - 1) * page_size
        end_idx = start_idx + page_size
        
        # 現在のページのオブジェクトを取得
        paginated_objects = all_objects[start_idx:end_idx]
        
        total_pages = (total + page_size - 1) // page_size if total > 0 else 1
        
        # 最適化: 正規表現パターンを事前コンパイル（3桁または6桁に対応）
        page_image_pattern = re.compile(r'/page_(\d{3}|\d{6})\.png$')
        
        # 最適化: O(1)高速検索用のマップを構築
        page_images_map = {}  # {file_base_name: True}
        
        for obj in all_objects:
            obj_name = obj["name"]
            if page_image_pattern.search(obj_name):
                last_slash_index = obj_name.rfind('/')
                if last_slash_index != -1:
                    parent_folder = obj_name[:last_slash_index]
                    page_images_map[parent_folder] = True
        
        def is_generated_page_image(object_name: str) -> bool:
            """ページ画像化で生成されたファイルかどうかを判定（最適化版 O(1)）"""
            if not page_image_pattern.search(object_name):
                return False
            
            last_slash_index = object_name.rfind('/')
            if last_slash_index == -1:
                return False
            
            parent_folder_path = object_name[:last_slash_index]
            return parent_folder_path in parent_files_map
        
        def has_page_images_for_file(object_name: str) -> bool:
            """ファイルに対応するページ画像が存在するか判定（最適化版 O(1)）"""
            if object_name.endswith('/'):
                return False
            
            file_base_name = re.sub(r'\.[^.]+$', '', object_name)
            return file_base_name in page_images_map
        
        def get_parent_file_from_page_image(page_image_name: str) -> Optional[str]:
            """ページ画像から親ファイル名（拡張子付き）を取得
            例: 'file/page_001.png' -> 'file.pdf'
            """
            if not page_image_pattern.search(page_image_name):
                return None
            
            last_slash_index = page_image_name.rfind('/')
            if last_slash_index == -1:
                return None
            
            folder_name = page_image_name[:last_slash_index]
            # parent_files_mapから元のファイル名（拡張子付き）を取得
            return parent_files_map.get(folder_name)
        
        # 最適化: 1パスで集計とファイル名収集
        file_count = 0
        page_image_count = 0
        file_object_names = []
        
        for obj in all_objects:
            obj_name = obj["name"]
            if obj_name.endswith('/'):
                continue
            
            if is_generated_page_image(obj_name):
                page_image_count += 1
            else:
                file_count += 1
                file_object_names.append(obj_name)
        
        # ベクトル化状態を一括取得（ファイルタイプのみ）
        vectorization_status = {}
        if file_object_names:
            try:
                vectorization_status = image_vectorizer.get_vectorization_status(bucket_name, file_object_names)
            except Exception as e:
                logger.warning(f"ベクトル化状態取得エラー: {e}")
        
        # 最適化: 状態付与を効率化
        for obj in all_objects:
            obj_name = obj["name"]
            is_folder = obj_name.endswith('/')
            is_page_image = not is_folder and is_generated_page_image(obj_name)
            
            if is_folder or is_page_image:
                # フォルダとページ画像は状態を表示しない
                obj["has_page_images"] = None
                obj["has_embeddings"] = None
            else:
                obj["has_page_images"] = has_page_images_for_file(obj_name)
                obj["has_embeddings"] = vectorization_status.get(obj_name, False)
        
        # 最適化: リスト内包表記でフィルタリング
        file_objects = [
            obj for obj in all_objects
            if not obj["name"].endswith('/') and not is_generated_page_image(obj["name"])
        ]
        
        # フィルタリング条件に従ってファイルを絞り込む
        filtered_files = file_objects
        
        # ページ画像化フィルター（ファイルのみ対象）
        if filter_page_images == "done":
            filtered_files = [
                obj for obj in filtered_files
                if obj["has_page_images"] is True
            ]
        elif filter_page_images == "not_done":
            filtered_files = [
                obj for obj in filtered_files
                if obj["has_page_images"] is False
            ]
        
        # ベクトル化フィルター（ファイルのみ対象）
        if filter_embeddings == "done":
            filtered_files = [
                obj for obj in filtered_files
                if obj["has_embeddings"] is True
            ]
        elif filter_embeddings == "not_done":
            filtered_files = [
                obj for obj in filtered_files
                if obj["has_embeddings"] is False
            ]
        
        # フィルター条件に一致したファイルの名前セットを作成
        filtered_file_names = {obj["name"] for obj in filtered_files}
        
        # 該当ファイルとその子ページ画像を含める
        filtered_objects = []
        for obj in all_objects:
            obj_name = obj["name"]
            
            # フォルダは常に除外（フィルター対象外）
            if obj_name.endswith('/'):
                continue
            
            # 表示タイプによるページ画像のフィルタリング
            if display_type == "files_only" and is_generated_page_image(obj_name):
                # ファイルのみ表示の場合、ページ画像を除外
                continue
            
            # 最適化: ページ画像の親ファイルチェック
            if is_generated_page_image(obj_name):
                last_slash_index = obj_name.rfind('/')
                if last_slash_index != -1:
                    parent_folder_path = obj_name[:last_slash_index]
                    # 親フォルダ名がフィルター済みファイル名に含まれるかチェック
                    if any(re.sub(r'\.[^.]+$', '', name) == parent_folder_path for name in filtered_file_names):
                        filtered_objects.append(obj)
            else:
                # ファイルの場合、フィルター条件に一致しているかチェック
                if obj_name in filtered_file_names:
                    filtered_objects.append(obj)
        
        # ソートロジック: ファイル先 → ページ画像後、ページ画像は数値順
        # 期待順序: ファイルA → ファイルAのページ画像(001,002,...,010,011,...) → ファイルB → ...
        def get_sort_key(obj):
            """ソートキーを生成"""
            obj_name = obj["name"]
            if is_generated_page_image(obj_name):
                # ページ画像の場合: (親ファイル名, 1, ページ番号)
                last_slash_index = obj_name.rfind('/')
                parent_folder = obj_name[:last_slash_index] if last_slash_index != -1 else ""
                # ページ番号を抽出
                match = page_image_pattern.search(obj_name)
                page_num = int(match.group(1)) if match else 0
                return (parent_folder, 1, page_num)
            else:
                # ファイルの場合: (ファイル名（拡張子なし）, 0, 0)
                file_base_name = re.sub(r'\.[^.]+$', '', obj_name)
                return (file_base_name, 0, 0)
        
        # ソートキーを事前計算してキャッシュ（パフォーマンス最適化）
        sort_key_cache = {id(obj): get_sort_key(obj) for obj in filtered_objects}
        
        # 2段階ソート（Pythonの安定ソートを利用）
        # 1. まずタイプ（ファイル先）とページ番号（昇順）でソート
        filtered_objects.sort(key=lambda obj: (
            sort_key_cache[id(obj)][1],  # タイプ (0=ファイル, 1=ページ画像)
            sort_key_cache[id(obj)][2]   # ページ番号（昇順）
        ))
        # 2. 次に基準名で降順ソート（安定ソートなので、同じ基準名内の順序は維持される）
        filtered_objects.sort(key=lambda obj: sort_key_cache[id(obj)][0], reverse=True)
        
        # フィルタリング後のページネーション情報を計算
        filtered_total = len(filtered_objects)
        start_idx = (page - 1) * page_size
        end_idx = start_idx + page_size
        
        # 現在のページのオブジェクトを取得
        paginated_objects = filtered_objects[start_idx:end_idx]
        
        total_pages = (filtered_total + page_size - 1) // page_size if filtered_total > 0 else 1
        
        # 最適化: 統計情報を効率的に計算
        filtered_page_image_count = sum(1 for obj in filtered_objects if is_generated_page_image(obj["name"]))
        filtered_file_count = len(filtered_objects) - filtered_page_image_count
        
        return {
            "success": True,
            "objects": paginated_objects,
            "pagination": {
                "current_page": page,
                "total_pages": total_pages,
                "page_size": page_size,
                "total": filtered_total,
                "total_unfiltered": total,
                "start_row": start_idx + 1 if filtered_total > 0 else 0,
                "end_row": min(end_idx, filtered_total),
                "has_next": page < total_pages,
                "has_prev": page > 1
            },
            "statistics": {
                "file_count": filtered_file_count,
                "page_image_count": filtered_page_image_count,
                "total_count": filtered_file_count + filtered_page_image_count,
                "unfiltered_file_count": file_count,
                "unfiltered_page_image_count": page_image_count,
                "unfiltered_total_count": file_count + page_image_count
            },
            "filters": {
                "filter_page_images": filter_page_images,
                "filter_embeddings": filter_embeddings,
                "display_type": display_type
            },
            "bucket_name": bucket_name,
            "namespace": namespace,
            "prefix": prefix
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"OCI Object Storage一覧取得エラー: {e}")
        raise HTTPException(status_code=500, detail=str(e))

class ObjectDeleteRequest(BaseModel):
    object_names: List[str]

@app.get("/oci/objects/{object_name:path}/metadata")
async def get_object_metadata(object_name: str):
    """オブジェクトのメタデータ（原始ファイル名など）を取得"""
    try:
        # URLデコード（日本語ファイル名対応）
        from urllib.parse import unquote
        decoded_object_name = unquote(object_name)
        
        # 環境変数からバケット名を取得
        bucket_name = os.getenv("OCI_BUCKET")
        
        if not bucket_name:
            raise HTTPException(status_code=400, detail="バケット名が設定されていません")
        
        # Namespaceを取得
        namespace_result = oci_service.get_namespace()
        if not namespace_result.get("success"):
            raise HTTPException(status_code=500, detail=f"Namespace取得エラー: {namespace_result.get('message')}")
        
        namespace = namespace_result.get("namespace")
        
        # メタデータを取得
        result = oci_service.get_object_metadata(
            bucket_name=bucket_name,
            namespace=namespace,
            object_name=decoded_object_name  # デコードされた名前を使用
        )
        
        if not result.get("success"):
            raise HTTPException(status_code=500, detail=result.get("message", "メタデータ取得エラー"))
        
        return {
            "success": True,
            "object_name": decoded_object_name,
            "original_filename": result.get("original_filename"),
            "metadata": result.get("metadata"),
            "content_type": result.get("content_type"),
            "content_length": result.get("content_length"),
            "last_modified": result.get("last_modified")
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"メタデータ取得エラー: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/oci/objects/delete")
async def delete_oci_objects(request: ObjectDeleteRequest):
    """
    OCI Object Storage内のオブジェクトを削除（SSEストリーミング対応）
    
    削除順序:
    1. object_nameからFILE_IDを取得
    2. FILE_INFOテーブルのレコード削除（IMG_EMBEDDINGSはCASCADE自動削除）
    3. 生成された画像ファイル削除
    4. 生成された画像フォルダ削除
    5. ファイル本体削除
    """
    if not request.object_names or len(request.object_names) == 0:
        raise HTTPException(status_code=400, detail="削除するオブジェクトが指定されていません")
    
    job_id = str(uuid.uuid4())
    logger.info(f"削除処理開始（並列）: {len(request.object_names)}件, job_id={job_id}")
    
    async def generate_progress():
        """進捗状況をSSE形式でストリーミング"""
        event_count = 0
        try:
            logger.info(f"削除SSEストリーム開始: job_id={job_id}")
            async for event in parallel_processor.process_deletion(
                object_names=request.object_names,
                oci_service=oci_service,
                image_vectorizer=image_vectorizer,
                database_service=database_service,
                job_id=job_id
            ):
                event_count += 1
                # 心拍以外のイベントのみログ出力
                if event.get('type') != 'heartbeat':
                    logger.debug(f"SSEイベント送信 [{event_count}]: {event.get('type')}")
                
                # SSE形式で送信
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            
            logger.info(f"削除SSEストリーム完了: job_id={job_id}, total_events={event_count}")
        
        except Exception as e:
            logger.error(f"削除SSEストリームエラー: {e}", exc_info=True)
            error_event = {
                'type': 'error',
                'message': f'削除処理エラー: {str(e)}'
            }
            yield f"data: {json.dumps(error_event, ensure_ascii=False)}\n\n"
    
    return StreamingResponse(
        generate_progress(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )

# ========================================
# 文書管理
# ========================================

@app.post("/documents/upload", response_model=DocumentUploadResponse)
async def upload_document(file: UploadFile = File(...)):
    """
    文書をObject Storageにアップロード
    - ローカルには保存しない
    - OCI Object Storageにそのまま保存
    - テキスト抽出やベクトル化は行わない
    """
    try:
        # ファイル名検証
        if not file.filename or file.filename.strip() == "":
            raise HTTPException(status_code=400, detail="無効なファイル名です")
        
        # 環境変数から設定を取得
        max_size = int(os.getenv("MAX_FILE_SIZE", 200000000))  # 200MB
        allowed_extensions_str = os.getenv("ALLOWED_EXTENSIONS", "pdf,xlsx,xls,docx,doc,pptx,ppt,png,jpg,jpeg,txt,md")
        allowed_extensions = [ext.strip() for ext in allowed_extensions_str.split(",")]
        
        # ファイル拡張子チェック
        file_ext = Path(file.filename).suffix.lower().lstrip('.')
        
        if file_ext not in allowed_extensions:
            raise HTTPException(status_code=400, detail=f"サポートされていないファイル形式: {file_ext}")
        
        # 許可されたMIMEタイプ
        allowed_mime_types = {
            'pdf': 'application/pdf',
            'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
            'xls': 'application/vnd.ms-excel',
            'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'doc': 'application/msword',
            'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'ppt': 'application/vnd.ms-powerpoint',
            'png': 'image/png',
            'jpg': 'image/jpeg',
            'jpeg': 'image/jpeg',
            'txt': 'text/plain',
            'md': 'text/markdown'
        }
        
        # MIMEタイプ検証
        content_type = file.content_type
        expected_mime = allowed_mime_types.get(file_ext)
        if expected_mime and content_type:
            if not content_type.startswith(expected_mime.split('/')[0]):
                logger.warning(f"MIMEタイプの不一致: 拡張子={file_ext}, Content-Type={content_type}")
        
        # ファイルサイズチェック
        file.file.seek(0, 2)  # ファイル末尾に移動
        file_size = file.file.tell()
        file.file.seek(0)  # 先頭に戻す
        
        if file_size > max_size:
            raise HTTPException(status_code=400, detail=f"ファイルサイズが大きすぎます（最大{max_size}バイト）")
        
        if file_size == 0:
            raise HTTPException(status_code=400, detail="空のファイルです")
        
        # 文書IDと安全なファイル名を生成
        document_id = str(uuid.uuid4())
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        
        safe_basename = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', file.filename)
        safe_basename = safe_basename.replace('..', '_')
        if not safe_basename or safe_basename.strip() == '':
            safe_basename = 'unnamed_file'
        
        safe_filename = f"{timestamp}_{document_id[:8]}_{safe_basename}"
        oci_object_name = safe_filename
        
        # アップロード前にストリーム位置をリセット
        file.file.seek(0)
        
        # Object Storageにアップロード
        logger.info(f"Object Storageにアップロード中: {file.filename} ({file_size} バイト)")
        upload_success = oci_service.upload_file(
            file_content=file.file,
            object_name=oci_object_name,
            content_type=content_type or f"application/{file_ext}",
            original_filename=file.filename,
            file_size=file_size
        )
        
        if not upload_success:
            logger.error("Object Storageアップロードに失敗しました")
            raise HTTPException(status_code=500, detail="Object Storageアップロードに失敗しました")
        
        logger.info(f"Object Storageアップロード完了: {file.filename} -> {oci_object_name}")
        
        # メタデータを保存
        documents = load_documents_metadata()
        document_metadata = {
            "document_id": document_id,
            "filename": file.filename,
            "file_size": file_size,
            "content_type": content_type or f"application/{file_ext}",
            "uploaded_at": datetime.now().isoformat(),
            "oci_path": oci_object_name,
            "status": "uploaded"
        }
        documents.append(document_metadata)
        save_documents_metadata(documents)
        
        return DocumentUploadResponse(
            success=True,
            message="文書のアップロードが完了しました",
            document_id=document_id,
            filename=file.filename,
            file_size=file_size,
            content_type=document_metadata["content_type"],
            uploaded_at=document_metadata["uploaded_at"],
            oci_path=document_metadata["oci_path"]
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"文書アップロードエラー: {e}")
        raise HTTPException(status_code=500, detail=str(e))
@app.post("/documents/upload/multiple")
async def upload_multiple_documents(files: List[UploadFile] = File(...)):
    """
    複数の文書をObject Storageにアップロード(最大10ファイル) - SSEストリーミング対応
    - ファイル検証(サイズ、拡張子、MIMEタイプ)
    - Object Storageに保存
    - ファイル名衝突回避(UUID)
    - リアルタイム進捗通知
    """
    
    async def generate_upload_events():
        try:
            # ファイル数チェック
            max_files = 10
            if len(files) > max_files:
                error_data = {"type": "error", "message": f"アップロード可能なファイル数は最大{max_files}個です"}
                yield f"data: {json.dumps(error_data, ensure_ascii=False)}\n\n"
                return
            
            if len(files) == 0:
                error_data = {"type": "error", "message": "アップロードするファイルを選択してください"}
                yield f"data: {json.dumps(error_data, ensure_ascii=False)}\n\n"
                return
            
            # 環境変数から設定を取得
            max_size = int(os.getenv("MAX_FILE_SIZE", 200000000))  # 200MB
            allowed_extensions_str = os.getenv("ALLOWED_EXTENSIONS", "pdf,xlsx,xls,docx,doc,pptx,ppt,png,jpg,jpeg,txt,md")
            allowed_extensions = [ext.strip() for ext in allowed_extensions_str.split(",")]
            
            # 許可されたMIMEタイプ(品質確保)
            allowed_mime_types = {
                'pdf': 'application/pdf',
                'xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                'xls': 'application/vnd.ms-excel',
                'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                'doc': 'application/msword',
                'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                'ppt': 'application/vnd.ms-powerpoint',
                'png': 'image/png',
                'jpg': 'image/jpeg',
                'jpeg': 'image/jpeg',
                'txt': 'text/plain',
                'md': 'text/markdown'
            }
            
            results = []
            success_count = 0
            failed_count = 0
            
            # 開始イベント送信
            start_event = {"type": "start", "total_files": len(files)}
            yield f"data: {json.dumps(start_event, ensure_ascii=False)}\n\n"
            
            # 各ファイルを処理
            for idx, file in enumerate(files, 1):
                file_result = {
                    "filename": file.filename,
                    "index": idx,
                    "success": False,
                    "message": "",
                    "document_id": None,
                    "oci_path": None
                }
                
                # ファイル処理開始イベント
                file_start_event = {
                    "type": "file_start",
                    "file_index": idx,
                    "total_files": len(files),
                    "file_name": file.filename or ""
                }
                yield f"data: {json.dumps(file_start_event, ensure_ascii=False)}\n\n"
                
                try:
                    # ファイル名検証
                    if not file.filename or file.filename.strip() == "":
                        error_msg = "無効なファイル名です"
                        file_result["message"] = error_msg
                        failed_count += 1
                        results.append(file_result)
                        error_event = {
                            "type": "file_error",
                            "file_index": idx,
                            "total_files": len(files),
                            "file_name": file.filename or "",
                            "error": error_msg
                        }
                        yield f"data: {json.dumps(error_event, ensure_ascii=False)}\n\n"
                        continue
                    
                    # ファイル拡張子チェック
                    file_ext = Path(file.filename).suffix.lower().lstrip('.')
                    
                    if file_ext not in allowed_extensions:
                        error_msg = f"サポートされていないファイル形式: {file_ext}"
                        file_result["message"] = error_msg
                        failed_count += 1
                        results.append(file_result)
                        error_event = {
                            "type": "file_error",
                            "file_index": idx,
                            "total_files": len(files),
                            "file_name": file.filename,
                            "error": error_msg
                        }
                        yield f"data: {json.dumps(error_event, ensure_ascii=False)}\n\n"
                        continue
                    
                    # ファイルサイズをストリーミングでチェック
                    file.file.seek(0, 2)
                    file_size = file.file.tell()
                    file.file.seek(0)
                    
                    if file_size > max_size:
                        error_msg = f"ファイルサイズが大きすぎます(最大{max_size}バイト)"
                        file_result["message"] = error_msg
                        failed_count += 1
                        results.append(file_result)
                        error_event = {
                            "type": "file_error",
                            "file_index": idx,
                            "total_files": len(files),
                            "file_name": file.filename,
                            "error": error_msg
                        }
                        yield f"data: {json.dumps(error_event, ensure_ascii=False)}\n\n"
                        continue
                    
                    if file_size == 0:
                        error_msg = "空のファイルです"
                        file_result["message"] = error_msg
                        failed_count += 1
                        results.append(file_result)
                        error_event = {
                            "type": "file_error",
                            "file_index": idx,
                            "total_files": len(files),
                            "file_name": file.filename,
                            "error": error_msg
                        }
                        yield f"data: {json.dumps(error_event, ensure_ascii=False)}\n\n"
                        continue
                    
                    # MIMEタイプ検証(品質確保)
                    content_type = file.content_type
                    expected_mime = allowed_mime_types.get(file_ext)
                    
                    if expected_mime and content_type:
                        if not content_type.startswith(expected_mime.split('/')[0]):
                            logger.warning(f"MIMEタイプの不一致: 拡張子={file_ext}, Content-Type={content_type}")
                    
                    # アップロード進行中イベント
                    uploading_event = {
                        "type": "file_uploading",
                        "file_index": idx,
                        "total_files": len(files),
                        "file_name": file.filename,
                        "file_size": file_size
                    }
                    yield f"data: {json.dumps(uploading_event, ensure_ascii=False)}\n\n"
                    
                    # 文書IDを生成(UUIDで衝突回避)
                    document_id = str(uuid.uuid4())
                    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                    
                    # ファイル名をサニタイズ(パストラバーサル対策)
                    safe_basename = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', file.filename)
                    safe_basename = safe_basename.replace('..', '_')
                    if not safe_basename or safe_basename.strip() == '':
                        safe_basename = 'unnamed_file'
                    
                    safe_filename = f"{timestamp}_{document_id[:8]}_{safe_basename}"
                    oci_object_name = safe_filename
                    
                    # OCI Object Storageにアップロード(ストリーミング)
                    logger.info(f"Object Storageにアップロード中 [{idx}/{len(files)}]: {file.filename}")
                    
                    # ファイルを先頭にリセット
                    file.file.seek(0)
                    
                    # OCIに直接アップロード
                    upload_success = oci_service.upload_file(
                        file_content=file.file,
                        object_name=oci_object_name,
                        content_type=content_type or f"application/{file_ext}",
                        original_filename=file.filename,
                        file_size=file_size
                    )
                    
                    if not upload_success:
                        error_msg = "Object Storageアップロード失敗"
                        file_result["message"] = error_msg
                        failed_count += 1
                        results.append(file_result)
                        error_event = {
                            "type": "file_error",
                            "file_index": idx,
                            "total_files": len(files),
                            "file_name": file.filename,
                            "error": error_msg
                        }
                        yield f"data: {json.dumps(error_event, ensure_ascii=False)}\n\n"
                        continue
                    
                    logger.info(f"Object Storageアップロード完了 [{idx}/{len(files)}]: {file.filename} ({file_size} バイト)")
                    
                    # メタデータを保存
                    documents = load_documents_metadata()
                    document_metadata = {
                        "document_id": document_id,
                        "filename": file.filename,
                        "file_size": file_size,
                        "content_type": content_type or f"application/{file_ext}",
                        "uploaded_at": datetime.now().isoformat(),
                        "oci_path": oci_object_name,
                        "status": "uploaded"
                    }
                    documents.append(document_metadata)
                    save_documents_metadata(documents)
                    
                    logger.info(f"文書アップロード完了 [{idx}/{len(files)}]: {file.filename} (ID: {document_id})")
                    
                    file_result["success"] = True
                    file_result["message"] = "アップロード成功"
                    file_result["document_id"] = document_id
                    file_result["file_size"] = file_size
                    file_result["oci_path"] = oci_object_name
                    success_count += 1
                    results.append(file_result)
                    
                    # ファイル完了イベント
                    complete_event = {
                        "type": "file_complete",
                        "file_index": idx,
                        "total_files": len(files),
                        "file_name": file.filename,
                        "status": "完了"
                    }
                    yield f"data: {json.dumps(complete_event, ensure_ascii=False)}\n\n"
                    
                except Exception as e:
                    logger.error(f"ファイル処理エラー [{idx}/{len(files)}] {file.filename}: {e}")
                    error_msg = f"処理エラー: {str(e)}"
                    file_result["message"] = error_msg
                    failed_count += 1
                    results.append(file_result)
                    error_event = {
                        "type": "file_error",
                        "file_index": idx,
                        "total_files": len(files),
                        "file_name": file.filename or "",
                        "error": error_msg
                    }
                    yield f"data: {json.dumps(error_event, ensure_ascii=False)}\n\n"
            
            # 全体の結果を返す
            overall_success = failed_count == 0
            summary_message = f"アップロード完了: 成功 {success_count}件、失敗 {failed_count}件"
            
            # 完了イベント送信
            complete_event = {
                "type": "complete",
                "success": overall_success,
                "message": summary_message,
                "total_files": len(files),
                "success_count": success_count,
                "failed_count": failed_count
            }
            yield f"data: {json.dumps(complete_event, ensure_ascii=False)}\n\n"
            
        except Exception as e:
            logger.error(f"アップロード処理エラー: {e}")
            error_msg = f"アップロード処理エラー: {str(e)}"
            error_event = {"type": "error", "message": error_msg}
            yield f"data: {json.dumps(error_event, ensure_ascii=False)}\n\n"
    
    return StreamingResponse(
        generate_upload_events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )

@app.get("/documents", response_model=DocumentListResponse)
async def list_documents():
    """文書リストを取得"""
    try:
        documents = load_documents_metadata()
        
        document_infos = [
            DocumentInfo(
                document_id=doc["document_id"],
                filename=doc["filename"],
                file_size=doc["file_size"],
                content_type=doc["content_type"],
                uploaded_at=doc["uploaded_at"],
                oci_path=doc["oci_path"],
                page_count=doc.get("page_count"),
                status=doc["status"]
            )
            for doc in documents
        ]
        
        return DocumentListResponse(
            success=True,
            documents=document_infos,
            total=len(document_infos)
        )
        
    except Exception as e:
        logger.error(f"文書リスト取得エラー: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/documents/{document_id}", response_model=DocumentDeleteResponse)
async def delete_document(document_id: str):
    """文書を削除
    
    削除順序:
    1. object_nameからFILE_IDを取得
    2. FILE_INFOテーブルのレコード削除（IMG_EMBEDDINGSはCASCADEで自動削除）
    3. 生成された画像ファイルを削除
    4. 生成されたフォルダを削除
    5. 該当ファイルを削除
    """
    try:
        # document_idからメタデータを検索
        documents = load_documents_metadata()
        
        # 対象文書を検索
        target_doc = None
        for doc in documents:
            if doc["document_id"] == document_id:
                target_doc = doc
                break
        
        if not target_doc:
            raise HTTPException(status_code=404, detail="文書が見つかりません")
        
        # Object Storageから削除する必要があるファイルの情報を取得
        object_name = target_doc.get("object_name") or target_doc.get("oci_path")  # OCI Object Storageのオブジェクト名
        
        if not object_name:
            logger.error(f"オブジェクト名が見つかりません: document_id={document_id}")
            raise HTTPException(status_code=500, detail="オブジェクト名が見つかりません")
        
        # ステップ1: object_nameからFILE_IDを取得
        bucket_name = os.getenv("OCI_BUCKET")
        file_id = None
        
        logger.info(f"[DEBUG] object_name取得: {object_name}")
        logger.info(f"[DEBUG] bucket_name: {bucket_name}")
        
        if bucket_name:
            try:
                logger.info(f"[DEBUG] get_file_id_by_object_name呼び出し: bucket={bucket_name}, object_name={object_name}")
                file_id = image_vectorizer.get_file_id_by_object_name(bucket_name, object_name)
                if file_id:
                    logger.info(f"[DEBUG] FILE_ID取得成功: FILE_ID={file_id}, object_name={object_name}")
                else:
                    logger.warning(f"[DEBUG] FILE_IDが見つかりません（ベクトル化されていない可能性）: object_name={object_name}")
            except Exception as e:
                logger.error(f"[DEBUG] FILE_ID取得エラー: {e}", exc_info=True)
        else:
            logger.warning(f"[DEBUG] OCI_BUCKET環境変数が設定されていません")
        
        # ステップ2: FILE_INFOテーブルのレコード削除（IMG_EMBEDDINGSはCASCADE制約で自動削除）
        if file_id:
            try:
                logger.info(f"[DEBUG] FILE_INFOレコード削除開始: FILE_ID={file_id}")
                
                # FILE_INFOレコードを削除（IMG_EMBEDDINGSはCASCADE制約で自動削除）
                delete_result = database_service.delete_file_info_records([str(file_id)])
                
                logger.info(f"[DEBUG] delete_file_info_records結果: {delete_result}")
                
                if not delete_result.get("success"):
                    logger.warning(f"[DEBUG] FILE_INFOレコード削除失敗: {delete_result.get('message')}")
                else:
                    logger.info(f"[DEBUG] FILE_INFOレコード削除成功: {delete_result.get('deleted_count')}件")
            except Exception as e:
                # データベース削除に失敗しても続行（ファイルは削除する）
                logger.error(f"[DEBUG] FILE_INFOレコード削除エラー: {e}", exc_info=True)
        else:
            logger.info(f"[DEBUG] FILE_IDが存在しないため、データベース削除をスキップ")
        
        # ステップ3-5: Object Storageからファイルと画像を削除
        # oci_service.delete_objects()は既に以下の順序で削除を実行:
        # - 画像ファイル削除
        # - 画像フォルダ削除
        # - ファイル本体削除
        if object_name:
            try:
                # Namespaceを取得
                namespace_result = oci_service.get_namespace()
                if not namespace_result.get("success"):
                    logger.error("Namespace取得エラー")
                    raise HTTPException(status_code=500, detail="Namespace取得エラー")
                
                namespace = namespace_result.get("namespace")
                bucket_name = os.getenv("OCI_BUCKET")
                
                if not bucket_name:
                    logger.error("OCI_BUCKET環境変数が設定されていません")
                    raise HTTPException(status_code=500, detail="OCI_BUCKET環境変数が設定されていません")
                
                logger.info(f"Object Storage削除開始: {object_name}")
                
                # 削除を実行（画像→フォルダ→ファイルの順序で削除）
                delete_result = oci_service.delete_objects(
                    bucket_name=bucket_name,
                    namespace=namespace,
                    object_names=[object_name]
                )
                
                if delete_result.get("success"):
                    logger.info(f"Object Storage削除成功: {object_name}")
                else:
                    logger.warning(f"Object Storage削除に一部失敗: {delete_result.get('message')}")
            except Exception as e:
                logger.error(f"Object Storage削除エラー: {e}")
                # 続行してメタデータを削除
        
        # ローカルファイルを削除（存在する場合）
        local_path = Path(target_doc.get("local_path", ""))
        if local_path.exists():
            local_path.unlink()
            logger.info(f"ローカルファイル削除: {local_path}")
        
        # メタデータから削除
        documents = [doc for doc in documents if doc["document_id"] != document_id]
        save_documents_metadata(documents)
        
        logger.info(f"文書削除完了: {document_id}")
        
        return DocumentDeleteResponse(
            success=True,
            message="文書を削除しました"
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"文書削除エラー: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ========================================
# セマンティック検索
# ========================================

@app.post("/search", response_model=SearchResponse)
async def search_documents(query: SearchQuery, request: Request):
    """
    セマンティック検索を実行(Oracle Database 26aiのベクトル検索を使用)
    
    レスポンスにはファイルと画像の絶対URLを含む(外部システム統合対応)
    URLには認証情報(APIキーまたはセッショントークン)が付与される
    """
    try:
        start_time = time.time()
        
        logger.info(f"検索開始: query='{query.query}', top_k={query.top_k}, min_score={query.min_score}, filename_filter='{query.filename_filter}'")
        
        # 1. テキストクエリからembeddingベクトルを生成
        query_embedding = image_vectorizer.generate_text_embedding(query.query)
        if query_embedding is None:
            logger.error("クエリのembedding生成に失敗")
            return SearchResponse(
                success=False,
                query=query.query,
                results=[],
                total_files=0,
                total_images=0,
                processing_time=time.time() - start_time
            )
        
        logger.info(f"Query embedding生成完了: shape={query_embedding.shape}")
        
        # 2. ベクトル検索を実行(2テーブルJOIN)
        search_results = await image_vectorizer.search_similar_images_async(
            query_embedding=query_embedding,
            limit=query.top_k,
            threshold=query.min_score,
            filename_filter=query.filename_filter
        )
        
        if not search_results:
            logger.info("検索結果がありません")
            return SearchResponse(
                success=True,
                query=query.query,
                results=[],
                total_files=0,
                total_images=0,
                processing_time=time.time() - start_time
            )
        
        logger.info(f"ベクトル検索完了: {len(search_results)}件の画像がマッチ")
        
        # 3. 結果をファイル単位で集約
        from collections import defaultdict
        from app.models.search import FileSearchResult, ImageSearchResult
        from urllib.parse import quote
        
        # ベースURLをリクエストから取得(絶対URL生成用)
        # X-Forwarded-* ヘッダーを優先(nginxプロキシ対応)
        scheme = request.headers.get('X-Forwarded-Proto', request.url.scheme)
        host = request.headers.get('X-Forwarded-Host', request.headers.get('Host', request.url.netloc))
        
        # ベースURLを構築(外部APIはバックエンドに直接アクセスするため/ai/apiプレフィックス不要)
        base_url = f"{scheme}://{host}"
        
        # 一時トークンを生成（短寿命、安全）
        # 元の認証情報(APIキーやセッショントークン)はURLに露出させない
        temp_token = generate_temp_token(source="search")
        auth_query_param = f"?t={temp_token}"
        
        logger.debug(f"一時トークン生成: 有効期限={TEMP_TOKEN_TIMEOUT_SECONDS}秒")
        
        # 絶対URL生成用のヘルパー関数(認証情報付き)
        def build_absolute_url(bucket: str, object_name: str) -> str:
            """ファイル/画像の絶対URLを生成(認証情報付き)"""
            # safe='/' でスラッシュはエンコードしない(パス構造を維持)
            encoded_name = quote(object_name, safe='/')
            return f"{base_url}/object/{bucket}/{encoded_name}{auth_query_param}"
        
        files_dict = defaultdict(lambda: {
            'file_id': None,
            'bucket': None,
            'object_name': None,
            'original_filename': None,
            'file_size': None,
            'content_type': None,
            'uploaded_at': None,
            'min_distance': float('inf'),
            'images': []
        })
        
        # 画像をファイルIDでグループ化
        for result in search_results:
            file_id = result['file_id']
            
            if files_dict[file_id]['file_id'] is None:
                files_dict[file_id]['file_id'] = result['file_id']
                files_dict[file_id]['bucket'] = result['file_bucket']
                files_dict[file_id]['object_name'] = result['file_object_name']
                files_dict[file_id]['original_filename'] = result.get('original_filename')
                files_dict[file_id]['file_size'] = result.get('file_size')
                files_dict[file_id]['content_type'] = result.get('file_content_type')
                files_dict[file_id]['uploaded_at'] = result.get('uploaded_at')
            
            # 最小距離を更新
            distance = result['vector_distance']
            if distance < files_dict[file_id]['min_distance']:
                files_dict[file_id]['min_distance'] = distance
            
            # 画像情報を追加
            image_result = ImageSearchResult(
                embed_id=result['embed_id'],
                bucket=result['bucket'],
                object_name=result['object_name'],
                page_number=result['page_number'],
                vector_distance=distance,
                content_type=result.get('content_type'),
                file_size=result.get('img_file_size'),
                url=build_absolute_url(result['bucket'], result['object_name'])
            )
            files_dict[file_id]['images'].append(image_result)
        
        # 4. ファイルを最小距離でソート
        sorted_files = sorted(files_dict.values(), key=lambda x: x['min_distance'])
        
        # 5. ファイル単位で結果を構築
        results = []
        total_images = len(search_results)
        
        for file_data in sorted_files:
            # 画像を距離でソート
            sorted_images = sorted(file_data['images'], key=lambda x: x.vector_distance)
            
            file_result = FileSearchResult(
                file_id=file_data['file_id'],
                bucket=file_data['bucket'],
                object_name=file_data['object_name'],
                original_filename=file_data['original_filename'],
                file_size=file_data['file_size'],
                content_type=file_data['content_type'],
                uploaded_at=file_data['uploaded_at'],
                min_distance=file_data['min_distance'],
                matched_images=sorted_images,
                url=build_absolute_url(file_data['bucket'], file_data['object_name'])
            )
            results.append(file_result)
        
        processing_time = time.time() - start_time
        
        logger.info(f"検索完了: ファイル数={len(results)}, 画像数={total_images}, 処理時間={processing_time:.3f}s")
        
        return SearchResponse(
            success=True,
            query=query.query,
            results=results,
            total_files=len(results),
            total_images=total_images,
            processing_time=processing_time
        )
        
    except Exception as e:
        logger.error(f"検索エラー: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/search/image", response_model=SearchResponse)
async def search_documents_by_image(
    image: UploadFile = File(...),
    top_k: int = Form(10),
    min_score: float = Form(0.7),
    filename_filter: str = Form(None),
    request: Request = None
):
    """
    画像によるセマンティック検索を実行
    
    Args:
        image: 検索する画像ファイル (PNG, JPG, JPEG)
        top_k: 取得する最大件数
        min_score: 最小スコア (0.0-1.0)
        filename_filter: ファイル名部分一致フィルタ（任意）
        request: HTTPリクエスト
    
    Returns:
        SearchResponse: 検索結果（ファイル単位で集約）
    """
    try:
        start_time = time.time()
        
        # ファイル拡張子とMIMEタイプの検証
        file_ext = image.filename.split('.')[-1].lower() if image.filename else ''
        if file_ext not in ['png', 'jpg', 'jpeg']:
            raise HTTPException(status_code=400, detail=f"サポートされていないファイル形式: {file_ext}")
        
        allowed_mime_types = ['image/png', 'image/jpeg', 'image/jpg']
        if image.content_type not in allowed_mime_types:
            raise HTTPException(status_code=400, detail=f"サポートされていないMIMEタイプ: {image.content_type}")
        
        # ファイルサイズチェック (最大10MB)
        max_size = 10 * 1024 * 1024
        image.file.seek(0, 2)
        file_size = image.file.tell()
        image.file.seek(0)
        
        if file_size > max_size:
            raise HTTPException(status_code=400, detail=f"ファイルサイズが大きすぎます（最大{max_size}バイト）")
        
        if file_size == 0:
            raise HTTPException(status_code=400, detail="空のファイルです")
        
        logger.info(f"画像検索開始: filename={image.filename}, size={file_size}, top_k={top_k}, min_score={min_score}, filename_filter='{filename_filter}'")
        
        # 1. 画像からembeddingベクトルを生成
        image_data = io.BytesIO(await image.read())
        query_embedding = image_vectorizer.generate_embedding(image_data, image.content_type)
        
        if query_embedding is None:
            logger.error("画像のembedding生成に失敗")
            return SearchResponse(
                success=False,
                query=f"画像検索: {image.filename}",
                results=[],
                total_files=0,
                total_images=0,
                processing_time=time.time() - start_time
            )
        
        logger.info(f"画像embedding生成完了: shape={query_embedding.shape}")
        
        # 2. ベクトル検索を実行
        search_results = await image_vectorizer.search_similar_images_async(
            query_embedding=query_embedding,
            limit=top_k,
            threshold=min_score,
            filename_filter=filename_filter
        )
        
        if not search_results:
            logger.info("検索結果がありません")
            return SearchResponse(
                success=True,
                query=f"画像検索: {image.filename}",
                results=[],
                total_files=0,
                total_images=0,
                processing_time=time.time() - start_time
            )
        
        logger.info(f"ベクトル検索完了: {len(search_results)}件の画像がマッチ")
        
        # 3. 結果をファイル単位で集約
        from collections import defaultdict
        from app.models.search import FileSearchResult, ImageSearchResult
        from urllib.parse import quote
        
        # ベースURLをリクエストから取得
        scheme = request.headers.get('X-Forwarded-Proto', request.url.scheme)
        host = request.headers.get('X-Forwarded-Host', request.headers.get('Host', request.url.netloc))
        base_url = f"{scheme}://{host}"
        
        # 一時トークンを生成
        temp_token = generate_temp_token(source="image_search")
        auth_query_param = f"?t={temp_token}"
        
        def build_absolute_url(bucket: str, object_name: str) -> str:
            encoded_name = quote(object_name, safe='/')
            return f"{base_url}/object/{bucket}/{encoded_name}{auth_query_param}"
        
        files_dict = defaultdict(lambda: {
            'file_id': None,
            'bucket': None,
            'object_name': None,
            'original_filename': None,
            'file_size': None,
            'content_type': None,
            'uploaded_at': None,
            'min_distance': float('inf'),
            'images': []
        })
        
        # 画像をファイルIDでグループ化
        for result in search_results:
            file_id = result['file_id']
            
            if files_dict[file_id]['file_id'] is None:
                files_dict[file_id]['file_id'] = result['file_id']
                files_dict[file_id]['bucket'] = result['file_bucket']
                files_dict[file_id]['object_name'] = result['file_object_name']
                files_dict[file_id]['original_filename'] = result.get('original_filename')
                files_dict[file_id]['file_size'] = result.get('file_size')
                files_dict[file_id]['content_type'] = result.get('file_content_type')
                files_dict[file_id]['uploaded_at'] = result.get('uploaded_at')
            
            # 最小距離を更新
            distance = result['vector_distance']
            if distance < files_dict[file_id]['min_distance']:
                files_dict[file_id]['min_distance'] = distance
            
            # 画像情報を追加
            image_result = ImageSearchResult(
                embed_id=result['embed_id'],
                bucket=result['bucket'],
                object_name=result['object_name'],
                page_number=result['page_number'],
                vector_distance=distance,
                content_type=result.get('content_type'),
                file_size=result.get('img_file_size'),
                url=build_absolute_url(result['bucket'], result['object_name'])
            )
            files_dict[file_id]['images'].append(image_result)
        
        # 4. ファイルを最小距離でソート
        sorted_files = sorted(files_dict.values(), key=lambda x: x['min_distance'])
        
        # 5. ファイル単位で結果を構築
        results = []
        total_images = len(search_results)
        
        for file_data in sorted_files:
            # 画像を距離でソート
            sorted_images = sorted(file_data['images'], key=lambda x: x.vector_distance)
            
            file_result = FileSearchResult(
                file_id=file_data['file_id'],
                bucket=file_data['bucket'],
                object_name=file_data['object_name'],
                original_filename=file_data['original_filename'],
                file_size=file_data['file_size'],
                content_type=file_data['content_type'],
                uploaded_at=file_data['uploaded_at'],
                min_distance=file_data['min_distance'],
                matched_images=sorted_images,
                url=build_absolute_url(file_data['bucket'], file_data['object_name'])
            )
            results.append(file_result)
        
        processing_time = time.time() - start_time
        
        logger.info(f"画像検索完了: ファイル数={len(results)}, 画像数={total_images}, 処理時間={processing_time:.3f}s")
        
        return SearchResponse(
            success=True,
            query=f"画像検索: {image.filename}",
            results=results,
            total_files=len(results),
            total_images=total_images,
            processing_time=processing_time
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"画像検索エラー: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/object/{bucket}/{object_name:path}")
async def get_object_proxy(bucket: str, object_name: str):
    """
    OCI Object Storageプロキシエンドポイント
    
    URL形式: /object/{bucket}/{object_name}
    対応ファイル: PDF, PPT, PPTX, PNG, JPG, JPEG等
    日本語ファイル名やスペースをURLエンコードでサポート
    
    Args:
        bucket: バケット名
        object_name: オブジェクト名(URLエンコード済み)
        
    Returns:
        ファイル/画像データ
    """
    try:
        from urllib.parse import unquote, quote
        
        # URLデコード(日本語ファイル名対応)
        decoded_object_name = unquote(object_name)
        
        logger.info(f"ファイル取得開始: bucket={bucket}, object={decoded_object_name}")
        
        # Namespaceを取得
        namespace_result = oci_service.get_namespace()
        if not namespace_result.get("success"):
            raise HTTPException(status_code=500, detail=f"Namespace取得エラー: {namespace_result.get('message')}")
        
        namespace = namespace_result.get("namespace")
        
        # OCI Object Storageからファイルを取得
        client = oci_service.get_object_storage_client()
        if not client:
            raise HTTPException(status_code=500, detail="Object Storage Clientの取得に失敗しました")
        
        get_obj_response = client.get_object(
            namespace_name=namespace,
            bucket_name=bucket,
            object_name=decoded_object_name
        )
        
        # Content-Typeを取得
        content_type = get_obj_response.headers.get('Content-Type', 'application/octet-stream')
        
        # ファイル名を取得（プレフィクスを除外）
        original_filename = decoded_object_name.split("/")[-1]
        # プレフィクス（20260124_235353_d5509515_）を除去
        prefix_pattern = r'^\d{8}_\d{6}_[a-f0-9]{8}_'
        original_filename = re.sub(prefix_pattern, '', original_filename)
        
        # Content-Dispositionヘッダーを生成(RFC 5987準拠、日本語対応)
        try:
            original_filename.encode('ascii')
            content_disposition = f'inline; filename="{original_filename}"'
        except UnicodeEncodeError:
            filename_encoded = quote(original_filename)
            content_disposition = f"inline; filename*=UTF-8''{filename_encoded}"
        
        logger.info(f"ファイル取得成功: object={decoded_object_name}, content_type={content_type}")
        
        # ファイルデータを返す
        return StreamingResponse(
            io.BytesIO(get_obj_response.data.content),
            media_type=content_type,
            headers={
                'Cache-Control': 'max-age=3600',  # 1時間キャッシュ
                'Content-Disposition': content_disposition
            }
        )
        
    except Exception as e:
        logger.error(f"ファイル取得エラー: {e}", exc_info=True)
        if "404" in str(e) or "NotFound" in str(e):
            raise HTTPException(status_code=404, detail="ファイルが見つかりません")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/oci/image/{bucket}/{object_name:path}")
async def get_oci_image(bucket: str, object_name: str):
    """
    後方互換性のため/object/へリダイレクト
    
    新しいURL形式: /object/{bucket}/{object_name}
    """
    from urllib.parse import quote
    from fastapi.responses import RedirectResponse
    
    # 新しいエンドポイントにリダイレクト(307 Temporary Redirect)
    encoded_name = quote(object_name, safe='/')
    return RedirectResponse(
        url=f"/object/{bucket}/{encoded_name}",
        status_code=307
    )

@app.get("/img/{bucket}/{object_name:path}")
async def get_img_redirect(bucket: str, object_name: str):
    """
    後方互換性のため/object/へリダイレクト
    
    新しいURL形式: /object/{bucket}/{object_name}
    """
    from urllib.parse import quote
    from fastapi.responses import RedirectResponse
    
    # 新しいエンドポイントにリダイレクト(307 Temporary Redirect)
    encoded_name = quote(object_name, safe='/')
    return RedirectResponse(
        url=f"/object/{bucket}/{encoded_name}",
        status_code=307
    )

# ========================================
# アプリケーション起動
# ========================================

# ========================================
# DB管理
# ========================================

@app.get("/settings/database", response_model=DatabaseSettingsResponse)
async def get_db_settings():
    """DB設定を取得（接続確認なし - パフォーマンス最適化）"""
    try:
        settings_dict = database_service.get_settings()
        settings = DatabaseSettings(**settings_dict)
        
        # 注意: is_connected()はDB接続を試みるため、設定取得時には呼び出さない
        # 接続確認が必要な場合は明示的に/api/db/testを使用する
        
        return DatabaseSettingsResponse(
            settings=settings,
            is_connected=False,
            status="not_checked"
        )
    except Exception as e:
        logger.error(f"DB設定取得エラー: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/settings/database")
async def save_db_settings(settings: DatabaseSettings):
    """DB設定を保存"""
    try:
        settings_dict = settings.model_dump()
        success = database_service.save_settings(settings_dict)
        
        if success:
            return {"success": True, "message": "DB設定を保存しました"}
        else:
            raise HTTPException(status_code=500, detail="設定の保存に失敗しました")
            
    except Exception as e:
        logger.error(f"DB設定保存エラー: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/settings/database/test", response_model=DatabaseConnectionTestResponse)
async def test_db_connection(request: DatabaseConnectionTestRequest):
    """DB接続テスト"""
    try:
        settings_dict = None
        if request.settings:
            settings_dict = request.settings.model_dump()
        
        # 非同期版を使用
        result = await database_service.test_connection_async(settings_dict)
        
        return DatabaseConnectionTestResponse(
            success=result["success"],
            message=result["message"],
            details=result.get("details")
        )
    except Exception as e:
        logger.error(f"DB接続テストエラー: {e}")
        return DatabaseConnectionTestResponse(
            success=False,
            message=f"接続テストエラー: {str(e)}"
        )

@app.get("/database/info", response_model=DatabaseInfoResponse)
async def get_db_info():
    """データベース情報を取得"""
    try:
        info_dict = database_service.get_database_info()
        
        if info_dict:
            info = DatabaseInfo(**info_dict)
            return DatabaseInfoResponse(success=True, info=info)
        else:
            return DatabaseInfoResponse(success=False, info=None)
            
    except Exception as e:
        logger.error(f"データベース情報取得エラー: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/db/tables", response_model=DatabaseTablesResponse)
async def get_db_tables():
    """テーブル一覧を取得"""
    try:
        tables_list = database_service.get_tables()
        
        tables = [TableInfo(**table) for table in tables_list]
        
        return DatabaseTablesResponse(
            success=True,
            tables=tables,
            total=len(tables)
        )
            
    except Exception as e:
        logger.error(f"テーブル一覧取得エラー: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ========================================
# データベース接続設定
# ========================================

@app.get("/settings/database", response_model=DatabaseSettingsResponse)
async def get_database_settings():
    """データベース接続設定を取得（接続確認なし - パフォーマンス最適化）"""
    try:
        settings = database_service.get_settings()
        
        # 注意: is_connected()はDB接続を試みるため、設定取得時には呼び出さない
        # 接続確認が必要な場合は明示的に/api/settings/database/testを使用する
        
        return DatabaseSettingsResponse(
            settings=DatabaseSettings(**settings),
            is_connected=False,
            status="not_checked"
        )
    except Exception as e:
        logger.error(f"データベース設定取得エラー: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/settings/database/env")
async def get_database_env_info(include_password: bool = False):
    """環境変数からDB接続情報を取得"""
    try:
        result = database_service.get_env_connection_info()
        
        # パスワードをマスク（include_password=Trueの場合はマスクしない）
        if result.get("password") and not include_password:
            result["password"] = "[CONFIGURED]"
        
        return result
    except Exception as e:
        logger.error(f"環境変数情報取得エラー: {e}")
        return {
            "success": False,
            "message": f"エラー: {str(e)}",
            "username": None,
            "dsn": None,
            "wallet_exists": False,
            "available_services": []
        }

@app.post("/settings/database", response_model=DatabaseSettingsResponse)
async def save_database_settings(settings: DatabaseSettings):
    """データベース接続設定を保存（接続確認なし - パフォーマンス最適化）"""
    try:
        # 設定をdict形式に変換
        settings_dict = settings.model_dump()
        
        success = database_service.save_settings(settings_dict)
        
        if not success:
            raise HTTPException(status_code=500, detail="設定の保存に失敗しました")
        
        # 注意: is_connected()はDB接続を試みるため、設定保存時には呼び出さない
        # 接続確認が必要な場合は明示的に/api/settings/database/testを使用する
        
        return DatabaseSettingsResponse(
            settings=settings,
            is_connected=False,
            status="saved"
        )
    except Exception as e:
        logger.error(f"データベース設定保存エラー: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/settings/database/test", response_model=DatabaseConnectionTestResponse)
async def test_database_connection(request: DatabaseConnectionTestRequest):
    """データベース接続テスト"""
    try:
        # テスト用の設定を使用（指定されていれば）
        test_settings = None
        if request.settings:
            test_settings = request.settings.model_dump()
            # 接続に必要なフィールドのみを抽出
            test_settings = {
                "username": test_settings.get("username"),
                "password": test_settings.get("password"),
                "dsn": test_settings.get("dsn")
            }
            logger.info(f"テスト設定: username={test_settings.get('username')}, dsn={test_settings.get('dsn')}")
        
        # 非同期版を使用
        result = await database_service.test_connection_async(test_settings)
        
        return DatabaseConnectionTestResponse(
            success=result["success"],
            message=result["message"],
            details=result.get("details")
        )
    except Exception as e:
        logger.error(f"データベース接続テストエラー: {e}")
        return DatabaseConnectionTestResponse(
            success=False,
            message=f"接続テストエラー: {str(e)}"
        )

@app.get("/database/info", response_model=DatabaseInfoResponse)
async def get_database_info():
    """データベース情報を取得"""
    try:
        info = database_service.get_database_info()
        
        if info:
            return DatabaseInfoResponse(
                success=True,
                info=DatabaseInfo(**info)
            )
        else:
            return DatabaseInfoResponse(
                success=False,
                info=None
            )
    except Exception as e:
        logger.error(f"データベース情報取得エラー: {e}")
        return DatabaseInfoResponse(
            success=False,
            info=None
        )

@app.get("/database/tables", response_model=DatabaseTablesResponse)
async def get_database_tables(
    page: int = Query(1, ge=1, description="ページ番号"),
    page_size: int = Query(20, ge=1, le=100, description="1ページあたりの件数")
):
    """データベースのテーブル一覧を取得（ページング対応）"""
    import math
    try:
        result = database_service.get_tables(page=page, page_size=page_size)
        tables = result.get("tables", [])
        total = result.get("total", 0)
        
        # ページング計算
        total_pages = max(1, math.ceil(total / page_size)) if total > 0 else 1
        start_row = (page - 1) * page_size + 1 if total > 0 else 0
        end_row = min(page * page_size, total) if total > 0 else 0
        
        return DatabaseTablesResponse(
            success=True,
            tables=[TableInfo(**t) for t in tables],
            total=total,
            current_page=page,
            total_pages=total_pages,
            page_size=page_size,
            start_row=start_row,
            end_row=end_row
        )
    except Exception as e:
        logger.error(f"テーブル一覧取得エラー: {e}")
        return DatabaseTablesResponse(
            success=False,
            tables=[],
            total=0
        )

@app.post("/database/tables/refresh-statistics")
async def refresh_table_statistics():
    """テーブルの統計情報を更新"""
    try:
        result = database_service.refresh_table_statistics()
        return result
    except Exception as e:
        logger.error(f"統計情報更新エラー: {e}")
        return {
            "success": False,
            "message": f"エラー: {str(e)}",
            "updated_count": 0
        }

@app.post("/database/tables/batch-delete")
async def delete_database_tables(request: dict):
    """データベースのテーブルを一括削除"""
    from app.models.database import TableBatchDeleteResponse
    try:
        table_names = request.get("table_names", [])
        
        if not table_names:
            return TableBatchDeleteResponse(
                success=False,
                deleted_count=0,
                message="削除するテーブルが指定されていません"
            )
        
        result = database_service.delete_tables(table_names)
        
        return TableBatchDeleteResponse(
            success=result.get("success", False),
            deleted_count=result.get("deleted_count", 0),
            message=result.get("message", ""),
            errors=result.get("errors", [])
        )
    except Exception as e:
        logger.error(f"テーブル一括削除エラー: {e}")
        return TableBatchDeleteResponse(
            success=False,
            deleted_count=0,
            message=str(e)
        )

@app.get("/database/tables/{table_name}/data", response_model=None)
async def get_table_data(
    table_name: str,
    page: int = Query(1, ge=1, description="ページ番号"),
    page_size: int = Query(20, ge=1, le=100, description="1ページあたりの件数")
):
    """テーブルデータを取得（ページング対応）"""
    from app.models.database import TableDataResponse
    import math
    try:
        result = database_service.get_table_data(table_name=table_name, page=page, page_size=page_size)
        
        if not result.get("success", False):
            return TableDataResponse(
                success=False,
                rows=[],
                columns=[],
                total=0,
                message=result.get("message", "データ取得に失敗しました")
            )
        
        total = result.get("total", 0)
        rows = result.get("rows", [])
        columns = result.get("columns", [])
        
        # ページング計算
        total_pages = max(1, math.ceil(total / page_size)) if total > 0 else 1
        start_row = (page - 1) * page_size + 1 if total > 0 else 0
        end_row = min(page * page_size, total) if total > 0 else 0
        
        return TableDataResponse(
            success=True,
            rows=rows,
            columns=columns,
            total=total,
            message=result.get("message", ""),
            current_page=page,
            total_pages=total_pages,
            page_size=page_size,
            start_row=start_row,
            end_row=end_row
        )
    except Exception as e:
        logger.error(f"テーブルデータ取得エラー: {e}")
        return TableDataResponse(
            success=False,
            rows=[],
            columns=[],
            total=0,
            message=str(e)
        )

class FileInfoDeleteRequest(BaseModel):
    """ファイル情報削除リクエスト"""
    file_ids: List[str]

@app.post("/database/file-info/batch-delete")
async def delete_file_info_records(request: FileInfoDeleteRequest):
    """FILE_INFOテーブルのレコードを一括削除"""
    from app.models.database import TableBatchDeleteResponse
    try:
        file_ids = request.file_ids
        
        if not file_ids:
            return TableBatchDeleteResponse(
                success=False,
                deleted_count=0,
                message="削除するレコードが指定されていません"
            )
        
        result = database_service.delete_file_info_records(file_ids)
        
        return TableBatchDeleteResponse(
            success=result.get("success", False),
            deleted_count=result.get("deleted_count", 0),
            message=result.get("message", ""),
            errors=result.get("errors", [])
        )
    except Exception as e:
        logger.error(f"FILE_INFOレコード削除エラー: {e}")
        return TableBatchDeleteResponse(
            success=False,
            deleted_count=0,
            message=str(e)
        )

@app.post("/database/tables/{table_name}/delete")
async def delete_table_data(table_name: str, request: dict):
    """
    任意のテーブルのレコードを主キー指定で一括削除（汎用API）
    
    Args:
        table_name: テーブル名
        request: {"primary_keys": [主キー値のリスト]}
    
    Returns:
        TableDataDeleteResponse
    """
    from app.models.database import TableDataDeleteResponse
    try:
        primary_keys = request.get("primary_keys", [])
        
        if not primary_keys:
            return TableDataDeleteResponse(
                success=False,
                deleted_count=0,
                message="削除するレコードが指定されていません"
            )
        
        result = database_service.delete_table_data(table_name, primary_keys)
        
        return TableDataDeleteResponse(
            success=result.get("success", False),
            deleted_count=result.get("deleted_count", 0),
            message=result.get("message", ""),
            errors=result.get("errors", [])
        )
    except Exception as e:
        logger.error(f"テーブルデータ削除エラー: table={table_name}, error={e}")
        return TableDataDeleteResponse(
            success=False,
            deleted_count=0,
            message=str(e)
        )

@app.get("/database/storage", response_model=DatabaseStorageResponse)
async def get_database_storage():
    """データベースストレージ情報を取得"""
    try:
        storage_info = database_service.get_storage_info()
        
        if storage_info:
            from app.models.database import DatabaseStorageInfo, TablespaceInfo
            
            # テーブルスペース情報を変換
            tablespaces = [TablespaceInfo(**ts) for ts in storage_info['tablespaces']]
            
            storage_data = DatabaseStorageInfo(
                tablespaces=tablespaces,
                total_size_mb=storage_info['total_size_mb'],
                used_size_mb=storage_info['used_size_mb'],
                free_size_mb=storage_info['free_size_mb'],
                used_percent=storage_info['used_percent']
            )
            
            return DatabaseStorageResponse(
                success=True,
                storage_info=storage_data
            )
        else:
            return DatabaseStorageResponse(
                success=False,
                storage_info=None,
                message="ストレージ情報の取得に失敗しました"
            )
    except Exception as e:
        logger.error(f"ストレージ情報取得エラー: {e}")
        return DatabaseStorageResponse(
            success=False,
            storage_info=None,
            message=f"エラー: {str(e)}"
        )

@app.post("/settings/database/wallet", response_model=WalletUploadResponse)
async def upload_wallet(file: UploadFile = File(...)):
    """Walletファイルをアップロード"""
    try:
        # ファイル拡張子チェック
        if not file.filename.lower().endswith('.zip'):
            raise HTTPException(status_code=400, detail="ZIPファイルのみ対応しています")
        
        # 一時ファイルに保存
        temp_file = UPLOAD_PATH / f"wallet_temp_{time.time()}.zip"
        content = await file.read()
        with open(temp_file, 'wb') as f:
            f.write(content)
        
        # Walletアップロード処理
        result = database_service.upload_wallet(str(temp_file))
        
        # 一時ファイル削除
        try:
            temp_file.unlink()
        except:
            pass
        
        if not result["success"]:
            raise HTTPException(status_code=400, detail=result["message"])
        
        return WalletUploadResponse(
            success=result["success"],
            message=result["message"],
            wallet_location=result.get("wallet_location"),
            available_services=result.get("available_services", [])
        )
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Walletアップロードエラー: {e}")
        raise HTTPException(status_code=500, detail=f"Walletアップロードエラー: {str(e)}")

# ========================================
# Autonomous Database管理
# ========================================

import oci

def create_database_client():
    """Database Client を作成"""
    settings = oci_service.get_settings()
    missing = []
    for key, value in {
        "user_ocid": settings.user_ocid,
        "tenancy_ocid": settings.tenancy_ocid,
        "fingerprint": settings.fingerprint,
        "key_content": settings.key_content,
    }.items():
        if not value or (isinstance(value, str) and not value.strip()):
            missing.append(key)
    if missing:
        raise HTTPException(status_code=400, detail=f"OCI認証情報が不完全です: {', '.join(missing)}")

    # Use OCI_REGION_DEPLOY if set (for cross-region ADB access), otherwise OCI_REGION, then settings default
    region = os.environ.get("OCI_REGION_DEPLOY") or os.environ.get("OCI_REGION") or settings.region
    if not region:
        raise HTTPException(status_code=400, detail="OCI_REGION / OCI_REGION_DEPLOY が設定されていません")

    logger.info(f"Creating DatabaseClient for region: {region}")

    signer = oci.signer.Signer(
        tenancy=settings.tenancy_ocid,
        user=settings.user_ocid,
        fingerprint=settings.fingerprint,
        private_key_file_location=None,
        private_key_content=settings.key_content,
    )
    config = {
        "user": settings.user_ocid,
        "fingerprint": settings.fingerprint,
        "tenancy": settings.tenancy_ocid,
        "region": region,
        "key_content": settings.key_content,
    }
    return oci.database.DatabaseClient(config, signer=signer)

def find_target_autonomous_database(db_client, compartment_id: str, adb_name: str):
    """ターゲットAutonomous Databaseを検索"""
    name_upper = adb_name.strip().upper()
    logger.info(f"Searching ADB '{adb_name}' in compartment {compartment_id}")
    
    # OCI Database API does not support subtree search, so we only search the specified compartment.
    try:
        # Use pagination to get ALL ADBs in the compartment
        adbs = oci.pagination.list_call_get_all_results(
            db_client.list_autonomous_databases,
            compartment_id=compartment_id
        ).data
    except Exception as e:
        logger.error(f"Failed to list ADBs: {e}")
        return None

    # Log found DBs for debugging
    found_names = [f"{adb.display_name} ({adb.db_name})" for adb in adbs]
    logger.info(f"Found {len(adbs)} ADBs in compartment: {', '.join(found_names[:10])}...")

    candidates = []
    for adb in adbs:
        db_name = (adb.db_name or "").strip()
        display_name = (adb.display_name or "").strip()
        if db_name.upper() == name_upper or display_name.upper() == name_upper:
            candidates.append(adb)
            
    if not candidates:
        logger.warning(f"No ADB found matching '{adb_name}' in compartment {compartment_id}")
        return None
        
    for adb in candidates:
        if (adb.db_name or "").strip().upper() == name_upper:
            return adb
    for adb in candidates:
        if (adb.display_name or "").strip().upper() == name_upper:
            return adb
    return candidates[0]

@app.get("/database/target/ocid")
def get_target_autonomous_database_ocid():
    """ターゲットAutonomous DatabaseのOCIDのみを取得（軽量版）"""
    adb_ocid = os.environ.get("ADB_OCID")
    if not adb_ocid:
        raise HTTPException(status_code=400, detail="ADB_OCID が設定されていません")
    
    return {
        "success": True,
        "ocid": adb_ocid
    }

@app.get("/database/connection-info")
def get_database_connection_info():
    """.envファイルからデータベース接続情報を取得（軽量版）"""
    conn_string = os.environ.get("ORACLE_26AI_CONNECTION_STRING")
    
    if not conn_string:
        return {
            "success": False,
            "message": "ORACLE_26AI_CONNECTION_STRING が設定されていません"
        }
    
    try:
        # 接続文字列を解析: username/password@dsn
        if '/' in conn_string and '@' in conn_string:
            # username/password@dsn 形式
            user_pass, dsn = conn_string.split('@', 1)
            if '/' in user_pass:
                username, password = user_pass.split('/', 1)
            else:
                username = user_pass
                password = ""
        else:
            return {
                "success": False,
                "message": "無効な接続文字列形式です"
            }
        
        return {
            "success": True,
            "username": username,
            "password": password,
            "dsn": dsn
        }
    except Exception as e:
        logger.error(f"接続情報解析エラー: {e}")
        return {
            "success": False,
            "message": f"解析エラー: {str(e)}"
        }

@app.get("/database/target")
def get_target_autonomous_database():
    """ターゲットAutonomous Database情報を取得"""
    adb_ocid = os.environ.get("ADB_OCID")
    if not adb_ocid:
        raise HTTPException(status_code=400, detail="ADB_OCID が設定されていません")

    db_client = create_database_client()
    
    try:
        # OCIDから直接ADB情報を取得
        adb = db_client.get_autonomous_database(adb_ocid).data
    except Exception as e:
        logger.error(f"ADB情報取得エラー: {e}")
        raise HTTPException(status_code=404, detail=f"Autonomous Database が見つかりません: {adb_ocid}")

    # 取得した情報を返す
    return {
        "id": adb.id,
        "display_name": adb.display_name,
        "db_name": adb.db_name,
        "lifecycle_state": adb.lifecycle_state,
        "cpu_core_count": adb.cpu_core_count,
        "data_storage_size_in_tbs": adb.data_storage_size_in_tbs,
        "db_workload": getattr(adb, "db_workload", None),
        "db_version": getattr(adb, "db_version", None),
        "is_free_tier": getattr(adb, "is_free_tier", None),
        "time_created": getattr(adb, "time_created", None),
    }

@app.post("/database/target/start")
def start_target_autonomous_database():
    """ターゲットAutonomous Databaseを起動"""
    adb_ocid = os.environ.get("ADB_OCID")
    if not adb_ocid:
        raise HTTPException(status_code=400, detail="ADB_OCID が設定されていません")

    db_client = create_database_client()
    
    try:
        # OCIDから直接ADB情報を取得
        adb = db_client.get_autonomous_database(adb_ocid).data
    except Exception as e:
        logger.error(f"ADB情報取得エラー: {e}")
        raise HTTPException(status_code=404, detail=f"Autonomous Database が見つかりません: {adb_ocid}")

    # 現在の状態を確認
    if adb.lifecycle_state in {"AVAILABLE", "STARTING"}:
        return {"status": "noop", "message": f"Already {adb.lifecycle_state}", "id": adb.id}

    resp = db_client.start_autonomous_database(adb.id)
    work_request_id = getattr(resp, "headers", {}).get("opc-work-request-id") if resp else None
    return {"status": "accepted", "message": "起動リクエストを送信しました", "id": adb.id, "work_request_id": work_request_id}

@app.post("/database/target/stop")
def stop_target_autonomous_database():
    """ターゲットAutonomous Databaseを停止"""
    adb_ocid = os.environ.get("ADB_OCID")
    if not adb_ocid:
        raise HTTPException(status_code=400, detail="ADB_OCID が設定されていません")

    db_client = create_database_client()
    
    try:
        # OCIDから直接ADB情報を取得
        adb = db_client.get_autonomous_database(adb_ocid).data
    except Exception as e:
        logger.error(f"ADB情報取得エラー: {e}")
        raise HTTPException(status_code=404, detail=f"Autonomous Database が見つかりません: {adb_ocid}")

    # 現在の状態を確認
    if adb.lifecycle_state in {"STOPPED", "STOPPING"}:
        return {"status": "noop", "message": f"Already {adb.lifecycle_state}", "id": adb.id}

    resp = db_client.stop_autonomous_database(adb.id)
    work_request_id = getattr(resp, "headers", {}).get("opc-work-request-id") if resp else None
    return {"status": "accepted", "message": "停止リクエストを送信しました", "id": adb.id, "work_request_id": work_request_id}

@app.post("/adb/get", response_model=ADBGetResponse)
async def get_adb_info(request: ADBGetRequest):
    """Autonomous Database情報を取得（旧エンドポイント、互換性のため残す）"""
    try:
        return adb_service.get_adb_info(request.adb_name, request.oci_compartment_ocid)
    except Exception as e:
        logger.error(f"ADB情報取得エラー: {e}")
        return ADBGetResponse(
            status="error",
            message=f"エラー: {str(e)}"
        )

@app.post("/adb/start", response_model=ADBOperationResponse)
async def start_adb(request: ADBOperationRequest):
    """Autonomous Databaseを起動（旧エンドポイント、互換性のため残す）"""
    try:
        return adb_service.start_adb(request.adb_ocid)
    except Exception as e:
        logger.error(f"ADB起動エラー: {e}")
        return ADBOperationResponse(
            status="error",
            message=f"起動エラー: {str(e)}"
        )

@app.post("/adb/stop", response_model=ADBOperationResponse)
async def stop_adb(request: ADBOperationRequest):
    """Autonomous Databaseを停止（旧エンドポイント、互換性のため残す）"""
    try:
        return adb_service.stop_adb(request.adb_ocid)
    except Exception as e:
        logger.error(f"ADB停止エラー: {e}")
        return ADBOperationResponse(
            status="error",
            message=f"停止エラー: {str(e)}"
        )

# ========================================
# AI Assistant エンドポイント
# ========================================

class ChatMessage(BaseModel):
    """チャットメッセージ"""
    message: str
    context: Optional[dict] = None
    history: Optional[List[dict]] = None
    images: Optional[List[dict]] = None

@app.post("/copilot/chat")
async def copilot_chat_http(request: ChatMessage):
    """AI Assistant チャット（HTTP ストリーミング）"""
    copilot = get_copilot_service()
    
    async def generate():
        async for chunk in copilot.chat_stream(
            request.message,
            request.context,
            request.history,
            request.images
        ):
            # SSE形式でストリーミング
            yield f"data: {json.dumps({'content': chunk})}\n\n"
        yield "data: {\"done\": true}\n\n"
    
    return StreamingResponse(
        generate(),
        media_type="text/event-stream"
    )

# ========================================
# Object Storage 文書操作エンドポイント
# ========================================

class DocumentDownloadRequest(BaseModel):
    """文書ダウンロードリクエスト"""
    object_names: List[str]

class DocumentConvertRequest(BaseModel):
    """文書ページ画像化リクエスト"""
    object_names: List[str]

@app.post("/oci/objects/download")
async def download_selected_objects(request: DocumentDownloadRequest, background_tasks: BackgroundTasks):
    """
    選択されたファイルをZIPアーカイブとしてダウンロード
    """
    try:
        object_names = request.object_names
        
        if not object_names:
            raise HTTPException(status_code=400, detail="ダウンロードするファイルが指定されていません")
        
        logger.info(f"ZIPダウンロード開始: {len(object_names)}件")
        
        # 一時ディレクトリ作成
        temp_dir = tempfile.mkdtemp()
        zip_path = Path(temp_dir) / "documents.zip"
        
        # ZIPファイル作成
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
            for obj_name in object_names:
                try:
                    # Object Storageからファイルを取得
                    file_content = oci_service.download_object(obj_name)
                    if file_content:
                        # プレフィクス（20260124_235353_d5509515_）を除去
                        prefix_pattern = r'^\d{8}_\d{6}_[a-f0-9]{8}_'
                        clean_filename = re.sub(prefix_pattern, '', obj_name)
                        # ZIPに追加
                        zipf.writestr(clean_filename, file_content)
                        logger.info(f"ZIPに追加: {clean_filename} (元: {obj_name})")
                    else:
                        logger.warning(f"ファイルが見つかりません: {obj_name}")
                except Exception as e:
                    logger.error(f"ファイル取得エラー ({obj_name}): {e}")
                    continue
        
        logger.info(f"ZIPファイル作成完了: {zip_path}")
        
        # ダウンロード後に一時ファイルを削除する関数
        def cleanup_temp_dir(dir_path: str):
            try:
                if dir_path and Path(dir_path).exists():
                    shutil.rmtree(dir_path)
                    logger.info(f"一時ディレクトリを削除: {dir_path}")
            except Exception as e:
                logger.warning(f"一時ファイル削除エラー: {e}")
        
        # バックグラウンドタスクで削除
        background_tasks.add_task(cleanup_temp_dir, temp_dir)
        
        # ZIPファイルを返す
        return FileResponse(
            path=str(zip_path),
            filename="documents.zip",
            media_type="application/zip"
        )
            
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"ZIPダウンロードエラー: {e}")
        raise HTTPException(status_code=500, detail=f"ダウンロードエラー: {str(e)}")

class VectorizeRequest(BaseModel):
    """画像ベクトル化リクエスト"""
    object_names: List[str]

@app.post("/oci/objects/vectorize")
async def vectorize_documents(request: VectorizeRequest):
    """
    選択されたファイルを画像ベクトル化してDBに保存（並列処理版）
    - ファイルが未画像化の場合は自動的にページ画像化を実行してからベクトル化
    - 既存の画像イメージやembeddingがある場合は削除してから再作成
    - Server-Sent Events (SSE)でリアルタイム進捗状況を送信
    """
    object_names = request.object_names
    
    if not object_names:
        raise HTTPException(status_code=400, detail="ベクトル化するファイルが指定されていません")
    
    job_id = str(uuid.uuid4())
    logger.info(f"画像ベクトル化開始（並列）: {len(object_names)}件, job_id={job_id}")
    
    async def generate_progress():
        """進捗状況をSSE形式でストリーミング"""
        event_count = 0
        try:
            logger.info(f"ベクトル化SSEストリーム開始: job_id={job_id}")
            async for event in parallel_processor.process_vectorization(
                object_names=object_names,
                oci_service=oci_service,
                image_vectorizer=image_vectorizer,
                job_id=job_id
            ):
                event_count += 1
                # 心拍以外のイベントのみログ出力
                if event.get('type') != 'heartbeat':
                    logger.debug(f"SSEイベント送信 #{event_count}: type={event.get('type')}, job_id={job_id}")
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            logger.info(f"ベクトル化SSEストリーム完了: job_id={job_id}, total_events={event_count}")
        except Exception as e:
            logger.error(f"ベクトル化エラー: {e}", exc_info=True)
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)}, ensure_ascii=False)}\n\n"
    
    return StreamingResponse(
        generate_progress(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "X-Job-ID": job_id
        }
    )

@app.post("/oci/objects/convert-to-images")
async def convert_documents_to_images(request: DocumentConvertRequest):
    """
    選択されたファイルをページ毎にPNG画像化して同名フォルダに保存（並列処理版）
    Server-Sent Events (SSE)でリアルタイム進捗状況を送信
    """
    object_names = request.object_names
    
    if not object_names:
        raise HTTPException(status_code=400, detail="変換するファイルが指定されていません")
    
    job_id = str(uuid.uuid4())
    logger.info(f"ページ画像化開始（並列）: {len(object_names)}件, job_id={job_id}")
    
    async def generate_progress():
        """進捗状況をSSE形式でストリーミング"""
        event_count = 0
        try:
            logger.info(f"ページ画像化SSEストリーム開始: job_id={job_id}")
            async for event in parallel_processor.process_image_conversion(
                object_names=object_names,
                oci_service=oci_service,
                job_id=job_id
            ):
                event_count += 1
                # 心拍以外のイベントのみログ出力
                if event.get('type') != 'heartbeat':
                    logger.debug(f"SSEイベント送信 #{event_count}: type={event.get('type')}, job_id={job_id}")
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
            logger.info(f"ページ画像化SSEストリーム完了: job_id={job_id}, total_events={event_count}")
        except Exception as e:
            logger.error(f"ページ画像化エラー: {e}", exc_info=True)
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)}, ensure_ascii=False)}\n\n"
    
    return StreamingResponse(
        generate_progress(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "X-Job-ID": job_id
        }
    )

@app.post("/jobs/{job_id}/cancel")
async def cancel_job(job_id: str):
    """
    実行中のジョブをキャンセル
    """
    success = parallel_processor.cancel_job(job_id)
    if success:
        logger.info(f"ジョブキャンセル成功: job_id={job_id}")
        return {"success": True, "message": "ジョブをキャンセルしました"}
    else:
        logger.warning(f"ジョブキャンセル失敗（見つからないか既に完了）: job_id={job_id}")
        raise HTTPException(status_code=404, detail="ジョブが見つからないか、既に完了しています")

@app.get("/jobs/{job_id}/status")
async def get_job_status(job_id: str):
    """
    ジョブの状態を取得
    """
    job = JobManager.get_job(job_id)
    if job:
        return {
            "success": True,
            "job_id": job.job_id,
            "status": job.status,
            "total_items": job.total_items,
            "completed_items": job.completed_items,
            "failed_items": job.failed_items,
            "cancel_requested": job.cancel_requested,
            "file_states": job.file_states
        }
    else:
        raise HTTPException(status_code=404, detail="ジョブが見つかりません")

# ========================================
# アプリケーション起動
# ========================================

if __name__ == "__main__":
    import uvicorn
    
    port = int(os.getenv("API_PORT", "8081"))
    host = os.getenv("API_HOST", "0.0.0.0")
    
    logger.info(f"サーバーを起動中: {host}:{port}")
    uvicorn.run(app, host=host, port=port)
