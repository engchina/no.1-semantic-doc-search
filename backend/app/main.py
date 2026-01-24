"""
セマンティック文書検索システム - メインAPIアプリケーション
"""
import logging
import sys
import os
import uuid
import time
import json
import secrets
import io
import subprocess
import tempfile
import zipfile
import shutil
import re
from pathlib import Path
from typing import List, Optional, Dict, Any
from datetime import datetime, timedelta
from fastapi import FastAPI, HTTPException, UploadFile, File, Form, Request, Query, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse, FileResponse
from pydantic import BaseModel
from dotenv import load_dotenv
from pdf2image import convert_from_path
from PIL import Image as PILImage

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
from app.services.document_processor import document_processor
from app.services.database_service import database_service
from app.services.adb_service import adb_service
from app.services.ai_copilot import get_copilot_service
from app.services.image_vectorizer import image_vectorizer
from app.utils.auth_util import do_auth, get_username_from_connection_string

# FastAPIアプリケーション初期化
app = FastAPI(
    title="セマンティック文書検索システムAPI",
    version="0.1.0",
    description="OCI Object Storageベースのセマンティック文書検索システム"
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

# セッション管理（メモリ内）
# Token -> {username: str, expires_at: datetime}
SESSIONS: Dict[str, Dict[str, Any]] = {}
SESSION_TIMEOUT_SECONDS = 86400  # 24時間

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

@app.get("/api/health")
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
    """認証チェックミドルウェア"""
    # 除外パス
    if request.url.path in ["/api/login", "/api/logout", "/api/config", "/", "/api/health"] or \
       request.url.path.startswith("/public/") or \
       request.method == "OPTIONS":
        return await call_next(request)
        
    # デバッグモードは認証スキップ
    if debug_mode:
        return await call_next(request)
        
    # トークンチェック
    auth_header = request.headers.get("Authorization")
    if not auth_header or not auth_header.startswith("Bearer "):
        # クエリパラメータもチェック
        token = request.query_params.get("token")
        if not token:
            return JSONResponse(status_code=401, content={"detail": "認証が必要です"})
    else:
        token = auth_header.split(" ")[1]
        
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

@app.get("/api/config")
def get_config():
    """フロントエンドに設定情報を公開"""
    return {
        "debug": debug_mode,
        "require_login": not debug_mode
    }

@app.post("/api/login")
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

@app.post("/api/logout")
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

@app.get("/api/oci/settings", response_model=OCISettingsResponse)
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

@app.post("/api/oci/settings", response_model=OCISettingsResponse)
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

@app.post("/api/oci/test", response_model=OCIConnectionTestResponse)
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

@app.get("/api/oci/namespace")
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

@app.post("/api/oci/object-storage/save")
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

@app.post("/api/oci/object-storage/test")
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

@app.get("/api/oci/objects")
async def list_oci_objects(
    prefix: str = Query(default="", description="プレフィックス（フォルダパス）"),
    page: int = Query(default=1, ge=1, description="ページ番号"),
    page_size: int = Query(default=50, ge=1, le=100, description="ページサイズ")
):
    """OCI Object Storage内のオブジェクト一覧を取得"""
    try:
        # 環境変数からバケット名を取得
        bucket_name = os.getenv("OCI_BUCKET")
        
        if not bucket_name:
            raise HTTPException(status_code=400, detail="バケット名が設定されていません")
        
        # Namespaceを取得（.env優先、空ならAPI）
        namespace_result = oci_service.get_namespace()
        if not namespace_result.get("success"):
            raise HTTPException(status_code=500, detail=f"Namespace取得エラー: {namespace_result.get('message')}")
        
        namespace = namespace_result.get("namespace")
        
        # 全オブジェクトを取得（ページネーション用）
        # 注: 本番環境では、大量のオブジェクトがある場合はキャッシュ機構を導入するべき
        all_objects = []
        page_token = None
        
        # 最大取得件数（無限ループ防止）
        max_fetch = 10000
        fetch_count = 0
        
        while fetch_count < max_fetch:
            result = oci_service.list_objects(
                bucket_name=bucket_name,
                namespace=namespace,
                prefix=prefix,
                page_size=1000,  # APIの1回あたりの取得数
                page_token=page_token
            )
            
            if not result.get("success"):
                raise HTTPException(status_code=500, detail=result.get("message", "オブジェクト一覧取得エラー"))
            
            objects = result.get("objects", [])
            all_objects.extend(objects)
            fetch_count += len(objects)
            
            # 次のページがあるかチェック
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
        
        # ファイルとページ画像の数を集計
        def is_generated_page_image(object_name: str, all_objects: list) -> bool:
            """ページ画像化で生成されたファイルかどうかを判定"""
            import re
            # page_001.pngのパターンにマッチするかチェック
            if not re.search(r'/page_\d{3}\.png$', object_name):
                return False
            
            # 親ファイル名を抽出
            last_slash_index = object_name.rfind('/')
            if last_slash_index == -1:
                return False
            
            parent_folder_path = object_name[:last_slash_index]
            
            # 親フォルダと同名のファイルが存在するかチェック
            for obj in all_objects:
                # フォルダを除外
                if obj["name"].endswith('/'):
                    continue
                
                # 拡張子を除いたファイル名を比較
                obj_name_without_ext = re.sub(r'\.[^.]+$', '', obj["name"])
                if obj_name_without_ext == parent_folder_path:
                    return True
            
            return False
        
        # 集計
        file_count = 0
        page_image_count = 0
        for obj in all_objects:
            # フォルダは除外
            if obj["name"].endswith('/'):
                continue
            
            # ページ画像かどうかを判定
            if is_generated_page_image(obj["name"], all_objects):
                page_image_count += 1
            else:
                file_count += 1
        
        return {
            "success": True,
            "objects": paginated_objects,
            "pagination": {
                "current_page": page,
                "total_pages": total_pages,
                "page_size": page_size,
                "total": total,
                "start_row": start_idx + 1 if total > 0 else 0,
                "end_row": min(end_idx, total),
                "has_next": page < total_pages,
                "has_prev": page > 1
            },
            "statistics": {
                "file_count": file_count,
                "page_image_count": page_image_count,
                "total_count": file_count + page_image_count
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

@app.get("/api/oci/objects/{object_name:path}/metadata")
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

@app.post("/api/oci/objects/delete")
async def delete_oci_objects(request: ObjectDeleteRequest):
    """OCI Object Storage内のオブジェクトを削除"""
    try:
        # 環境変数からバケット名を取得
        bucket_name = os.getenv("OCI_BUCKET")
        
        if not bucket_name:
            raise HTTPException(status_code=400, detail="バケット名が設定されていません")
        
        # Namespaceを取得（.env優先、空ならAPI）
        namespace_result = oci_service.get_namespace()
        if not namespace_result.get("success"):
            raise HTTPException(status_code=500, detail=f"Namespace取得エラー: {namespace_result.get('message')}")
        
        namespace = namespace_result.get("namespace")
        
        if not request.object_names or len(request.object_names) == 0:
            raise HTTPException(status_code=400, detail="削除するオブジェクトが指定されていません")
        
        # オブジェクトを削除
        result = oci_service.delete_objects(
            bucket_name=bucket_name,
            namespace=namespace,
            object_names=request.object_names
        )
        
        return result
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"OCI Object Storage削除エラー: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ========================================
# 文書管理
# ========================================

@app.post("/api/documents/upload", response_model=DocumentUploadResponse)
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
        max_size = int(os.getenv("MAX_FILE_SIZE", 100000000))  # 100MB
        allowed_extensions_str = os.getenv("ALLOWED_EXTENSIONS", "pdf,pptx,ppt,docx,txt,md,png,jpg,jpeg")
        allowed_extensions = [ext.strip() for ext in allowed_extensions_str.split(",")]
        
        # ファイル拡張子チェック
        file_ext = Path(file.filename).suffix.lower().lstrip('.')
        
        if file_ext not in allowed_extensions:
            raise HTTPException(status_code=400, detail=f"サポートされていないファイル形式: {file_ext}")
        
        # 許可されたMIMEタイプ
        allowed_mime_types = {
            'pdf': 'application/pdf',
            'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'ppt': 'application/vnd.ms-powerpoint',
            'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'txt': 'text/plain',
            'md': 'text/markdown',
            'png': 'image/png',
            'jpg': 'image/jpeg',
            'jpeg': 'image/jpeg'
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
        
        import re
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
@app.post("/api/documents/upload/multiple")
async def upload_multiple_documents(files: List[UploadFile] = File(...)):
    """
    複数の文書をObject Storageにアップロード（最大10ファイル）
    - ファイル検証（サイズ、拡張子、MIMEタイプ）
    - Object Storageに保存
    - ファイル名衝突回避（UUID）
    """
    try:
        # ファイル数チェック
        max_files = 10
        if len(files) > max_files:
            raise HTTPException(status_code=400, detail=f"アップロード可能なファイル数は最大{max_files}個です")
        
        if len(files) == 0:
            raise HTTPException(status_code=400, detail="アップロードするファイルを選択してください")
        
        # 環境変数から設定を取得
        max_size = int(os.getenv("MAX_FILE_SIZE", 100000000))  # 100MB
        allowed_extensions_str = os.getenv("ALLOWED_EXTENSIONS", "pdf,pptx,ppt,docx,txt,md,png,jpg,jpeg")
        allowed_extensions = [ext.strip() for ext in allowed_extensions_str.split(",")]
        
        # 許可されたMIMEタイプ（品質確保）
        allowed_mime_types = {
            'pdf': 'application/pdf',
            'pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
            'ppt': 'application/vnd.ms-powerpoint',
            'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'txt': 'text/plain',
            'md': 'text/markdown',
            'png': 'image/png',
            'jpg': 'image/jpeg',
            'jpeg': 'image/jpeg'
        }
        
        results = []
        success_count = 0
        failed_count = 0
        
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
            
            try:
                # ファイル名検証
                if not file.filename or file.filename.strip() == "":
                    file_result["message"] = "無効なファイル名です"
                    failed_count += 1
                    results.append(file_result)
                    continue
                
                # ファイル拡張子チェック
                file_ext = Path(file.filename).suffix.lower().lstrip('.')
                
                if file_ext not in allowed_extensions:
                    file_result["message"] = f"サポートされていないファイル形式: {file_ext}"
                    failed_count += 1
                    results.append(file_result)
                    continue
                
                # ファイルサイズをストリーミングでチェック
                file.file.seek(0, 2)
                file_size = file.file.tell()
                file.file.seek(0)
                
                if file_size > max_size:
                    file_result["message"] = f"ファイルサイズが大きすぎます（最大{max_size}バイト）"
                    failed_count += 1
                    results.append(file_result)
                    continue
                
                if file_size == 0:
                    file_result["message"] = "空のファイルです"
                    failed_count += 1
                    results.append(file_result)
                    continue
                
                # MIMEタイプ検証（品質確保）
                content_type = file.content_type
                expected_mime = allowed_mime_types.get(file_ext)
                
                if expected_mime and content_type:
                    # メインMIMEタイプが一致するかチェック
                    if not content_type.startswith(expected_mime.split('/')[0]):
                        logger.warning(f"MIMEタイプの不一致: 拡張子={file_ext}, Content-Type={content_type}")
                
                # 文書IDを生成（UUIDで衝突回避）
                document_id = str(uuid.uuid4())
                timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
                
                # ファイル名をサニタイズ（パストラバーサル対策）
                import re
                safe_basename = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', file.filename)
                safe_basename = safe_basename.replace('..', '_')
                if not safe_basename or safe_basename.strip() == '':
                    safe_basename = 'unnamed_file'
                
                safe_filename = f"{timestamp}_{document_id[:8]}_{safe_basename}"
                oci_object_name = safe_filename
                
                # OCI Object Storageにアップロード（ストリーミング）
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
                    file_result["message"] = "Object Storageアップロード失敗"
                    failed_count += 1
                    results.append(file_result)
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
                
            except Exception as e:
                logger.error(f"ファイル処理エラー [{idx}/{len(files)}] {file.filename}: {e}")
                file_result["message"] = f"処理エラー: {str(e)}"
                failed_count += 1
                results.append(file_result)
        
        # 全体の結果を返す
        overall_success = failed_count == 0
        summary_message = f"アップロード完了: 成功 {success_count}件、失敗 {failed_count}件"
        
        return {
            "success": overall_success,
            "message": summary_message,
            "total_files": len(files),
            "success_count": success_count,
            "failed_count": failed_count,
            "results": results
        }
        
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"複数ファイルアップロードエラー: {e}")
        raise HTTPException(status_code=500, detail=str(e))

@app.get("/api/documents", response_model=DocumentListResponse)
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

@app.delete("/api/documents/{document_id}", response_model=DocumentDeleteResponse)
async def delete_document(document_id: str):
    """文書を削除"""
    try:
        documents = load_documents_metadata()
        
        # 対象文書を検索
        target_doc = None
        for doc in documents:
            if doc["document_id"] == document_id:
                target_doc = doc
                break
        
        if not target_doc:
            raise HTTPException(status_code=404, detail="文書が見つかりません")
        
        # ローカルファイルを削除
        local_path = Path(target_doc.get("local_path", ""))
        if local_path.exists():
            local_path.unlink()
        
        # メタデータから削除
        documents = [doc for doc in documents if doc["document_id"] != document_id]
        save_documents_metadata(documents)
        
        logger.info(f"文書を削除: {document_id}")
        
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

@app.post("/api/search", response_model=SearchResponse)
async def search_documents(query: SearchQuery):
    """セマンティック検索を実行（Oracle Database 23aiのベクトル検索を使用）"""
    try:
        start_time = time.time()
        
        # TODO: Oracle Database 23aiのベクトル検索機能を実装
        # 現在はCohere Embed v4.0を使用した画像ベクトル検索のみ対応
        results = []
        
        processing_time = time.time() - start_time
        
        logger.info(f"検索完了: クエリ='{query.query}', 結果数={len(results)}, 処理時間={processing_time:.3f}s")
        
        return SearchResponse(
            success=True,
            query=query.query,
            results=results,
            total_results=len(results),
            processing_time=processing_time
        )
        
    except Exception as e:
        logger.error(f"検索エラー: {e}")
        raise HTTPException(status_code=500, detail=str(e))

# ========================================
# アプリケーション起動
# ========================================

# ========================================
# DB管理
# ========================================

@app.get("/api/db/settings", response_model=DatabaseSettingsResponse)
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

@app.post("/api/db/settings")
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

@app.post("/api/db/test", response_model=DatabaseConnectionTestResponse)
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

@app.get("/api/db/info", response_model=DatabaseInfoResponse)
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

@app.get("/api/db/tables", response_model=DatabaseTablesResponse)
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

@app.get("/api/settings/database", response_model=DatabaseSettingsResponse)
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

@app.get("/api/settings/database/env")
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

@app.post("/api/settings/database", response_model=DatabaseSettingsResponse)
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

@app.post("/api/settings/database/test", response_model=DatabaseConnectionTestResponse)
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

@app.get("/api/database/info", response_model=DatabaseInfoResponse)
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

@app.get("/api/database/tables", response_model=DatabaseTablesResponse)
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

@app.post("/api/database/tables/batch-delete")
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

@app.get("/api/database/tables/{table_name}/data", response_model=None)
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

@app.get("/api/database/storage", response_model=DatabaseStorageResponse)
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

@app.post("/api/settings/database/wallet", response_model=WalletUploadResponse)
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

@app.get("/api/database/target")
def get_target_autonomous_database():
    """ターゲットAutonomous Database情報を取得"""
    adb_name = os.environ.get("ADB_NAME")
    if not adb_name:
        raise HTTPException(status_code=400, detail="ADB_NAME が設定されていません")

    db_client = create_database_client()
    compartment_id = os.environ.get("OCI_COMPARTMENT_OCID") or oci_service.get_settings().tenancy_ocid
    adb = find_target_autonomous_database(db_client, compartment_id=compartment_id, adb_name=adb_name)
    if not adb:
        raise HTTPException(status_code=404, detail=f"Autonomous Database が見つかりません: {adb_name}")

    # find_target_autonomous_databaseで既に取得済みの情報を使用（不要な追加API呼び出しを避ける）
    return {
        "target_compartment_id": compartment_id,
        "target_adb_name": adb_name,
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

@app.post("/api/database/target/start")
def start_target_autonomous_database():
    """ターゲットAutonomous Databaseを起動"""
    adb_name = os.environ.get("ADB_NAME")
    if not adb_name:
        raise HTTPException(status_code=400, detail="ADB_NAME が設定されていません")

    db_client = create_database_client()
    compartment_id = os.environ.get("OCI_COMPARTMENT_OCID") or oci_service.get_settings().tenancy_ocid
    adb = find_target_autonomous_database(db_client, compartment_id=compartment_id, adb_name=adb_name)
    if not adb:
        raise HTTPException(status_code=404, detail=f"Autonomous Database が見つかりません: {adb_name}")

    # 既に取得済みの情報を使用（不要な追加API呼び出しを避ける）
    if adb.lifecycle_state in {"AVAILABLE", "STARTING"}:
        return {"status": "noop", "message": f"Already {adb.lifecycle_state}", "id": adb.id}

    resp = db_client.start_autonomous_database(adb.id)
    work_request_id = getattr(resp, "headers", {}).get("opc-work-request-id") if resp else None
    return {"status": "accepted", "message": "起動リクエストを送信しました", "id": adb.id, "work_request_id": work_request_id}

@app.post("/api/database/target/stop")
def stop_target_autonomous_database():
    """ターゲットAutonomous Databaseを停止"""
    adb_name = os.environ.get("ADB_NAME")
    if not adb_name:
        raise HTTPException(status_code=400, detail="ADB_NAME が設定されていません")

    db_client = create_database_client()
    compartment_id = os.environ.get("OCI_COMPARTMENT_OCID") or oci_service.get_settings().tenancy_ocid
    adb = find_target_autonomous_database(db_client, compartment_id=compartment_id, adb_name=adb_name)
    if not adb:
        raise HTTPException(status_code=404, detail=f"Autonomous Database が見つかりません: {adb_name}")

    # 既に取得済みの情報を使用（不要な追加API呼び出しを避ける）
    if adb.lifecycle_state in {"STOPPED", "STOPPING"}:
        return {"status": "noop", "message": f"Already {adb.lifecycle_state}", "id": adb.id}

    resp = db_client.stop_autonomous_database(adb.id)
    work_request_id = getattr(resp, "headers", {}).get("opc-work-request-id") if resp else None
    return {"status": "accepted", "message": "停止リクエストを送信しました", "id": adb.id, "work_request_id": work_request_id}

@app.post("/api/adb/get", response_model=ADBGetResponse)
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

@app.post("/api/adb/start", response_model=ADBOperationResponse)
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

@app.post("/api/adb/stop", response_model=ADBOperationResponse)
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

@app.post("/api/copilot/chat")
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

@app.post("/api/oci/objects/download")
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
                        # ZIPに追加
                        zipf.writestr(obj_name, file_content)
                        logger.info(f"ZIPに追加: {obj_name}")
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

@app.post("/api/oci/objects/vectorize")
async def vectorize_documents(request: VectorizeRequest):
    """
    選択されたファイルを画像ベクトル化してDBに保存
    - ファイルが未画像化の場合は自動的に画像化
    - 既存のembeddingがある場合は削除してから再作成
    - Server-Sent Events (SSE)でリアルタイム進捗状況を送信
    """
    object_names = request.object_names
    
    if not object_names:
        raise HTTPException(status_code=400, detail="ベクトル化するファイルが指定されていません")
    
    logger.info(f"画像ベクトル化開始: {len(object_names)}件")
    
    async def generate_progress():
        """進捗状況をSSE形式でストリーミング"""
        results = []
        success_count = 0
        failed_count = 0
        
        # 開始通知
        yield f"data: {json.dumps({'type': 'start', 'total_files': len(object_names)}, ensure_ascii=False)}\n\n"
        
        for file_idx, obj_name in enumerate(object_names, start=1):
            result = {
                "object_name": obj_name,
                "success": False,
                "message": "",
                "embedding_count": 0,
                "folder_name": ""
            }
            
            temp_dir = None
            file_content = None  # ループ内で初期化
            
            # ファイル処理開始通知
            yield f"data: {json.dumps({'type': 'file_start', 'file_index': file_idx, 'total_files': len(object_names), 'file_name': obj_name}, ensure_ascii=False)}\n\n"
            
            try:
                # ファイル名と拡張子を取得
                file_path = Path(obj_name)
                file_name = file_path.stem
                file_ext = file_path.suffix.lower().lstrip('.')
                
                # 同名フォルダ名
                parent_str = str(file_path.parent)
                if parent_str and parent_str != '.':
                    folder_name = f"{parent_str}/{file_name}"
                else:
                    folder_name = file_name
                
                result["folder_name"] = folder_name
                
                # Object Storageの設定を取得
                namespace_result = oci_service.get_namespace()
                if not namespace_result.get("success"):
                    result["message"] = "Namespace取得エラー"
                    failed_count += 1
                    results.append(result)
                    yield f"data: {json.dumps({'type': 'file_error', 'file_index': file_idx, 'total_files': len(object_names), 'file_name': obj_name, 'error': result['message']}, ensure_ascii=False)}\n\n"
                    continue
                
                namespace = namespace_result.get("namespace")
                bucket_name = os.getenv("OCI_BUCKET")
                
                if not bucket_name:
                    result["message"] = "OCI_BUCKET環境変数が設定されていません"
                    failed_count += 1
                    results.append(result)
                    yield f"data: {json.dumps({'type': 'file_error', 'file_index': file_idx, 'total_files': len(object_names), 'file_name': obj_name, 'error': result['message']}, ensure_ascii=False)}\n\n"
                    continue
                
                # FILE_INFOにファイル情報を保存または取得
                yield f"data: {json.dumps({'type': 'save_file_info', 'file_index': file_idx, 'file_name': obj_name}, ensure_ascii=False)}\n\n"
                
                file_id = image_vectorizer.get_file_id_by_object_name(bucket_name, obj_name)
                
                if file_id:
                    # 既存のembeddingを削除
                    logger.info(f"既存のembedding削除: FILE_ID={file_id}")
                    yield f"data: {json.dumps({'type': 'delete_existing', 'file_index': file_idx, 'file_name': obj_name, 'file_id': file_id}, ensure_ascii=False)}\n\n"
                    image_vectorizer.delete_file_embeddings(file_id)
                else:
                    # 新規ファイル情報を保存
                    # ファイルサイズとcontent_typeを取得するためにダウンロード
                    file_content = oci_service.download_object(obj_name)
                    if not file_content:
                        result["message"] = "ファイルが見つかりません"
                        failed_count += 1
                        results.append(result)
                        yield f"data: {json.dumps({'type': 'file_error', 'file_index': file_idx, 'file_name': obj_name, 'error': result['message']}, ensure_ascii=False)}\n\n"
                        continue
                    
                    file_size = len(file_content)
                    content_type = f"application/{file_ext}"
                    
                    file_id = image_vectorizer.save_file_info(
                        bucket=bucket_name,
                        object_name=obj_name,
                        original_filename=file_path.name,
                        file_size=file_size,
                        content_type=content_type
                    )
                    
                    if not file_id:
                        result["message"] = "ファイル情報保存エラー"
                        failed_count += 1
                        results.append(result)
                        yield f"data: {json.dumps({'type': 'file_error', 'file_index': file_idx, 'file_name': obj_name, 'error': result['message']}, ensure_ascii=False)}\n\n"
                        continue
                
                logger.info(f"FILE_ID: {file_id}")
                
                # ページ画像化されているかチェック
                page_images_result = oci_service.list_objects(
                    bucket_name=bucket_name,
                    namespace=namespace,
                    prefix=f"{folder_name}/",
                    page_size=1000
                )
                
                page_images = []
                if page_images_result.get("success"):
                    objects = page_images_result.get("objects", [])
                    for obj in objects:
                        obj_name_str = obj.get("name", "")
                        if not obj_name_str.endswith('/') and re.search(r'/page_\d{3}\.png$', obj_name_str):
                            page_images.append(obj_name_str)
                
                page_images.sort()
                
                # ページ画像がない場合は自動生成
                if not page_images:
                    yield f"data: {json.dumps({'type': 'auto_convert_start', 'file_index': file_idx, 'file_name': obj_name}, ensure_ascii=False)}\n\n"
                    
                    # Object Storageからファイルをダウンロード（新規ファイルの場合は既にダウンロード済み）
                    if not file_content:
                        file_content = oci_service.download_object(obj_name)
                    
                    if not file_content:
                        result["message"] = "ファイルが見つかりません"
                        failed_count += 1
                        results.append(result)
                        yield f"data: {json.dumps({'type': 'file_error', 'file_index': file_idx, 'file_name': obj_name, 'error': result['message']}, ensure_ascii=False)}\n\n"
                        continue
                    
                    # 一時ファイルに保存
                    temp_dir = tempfile.mkdtemp()
                    temp_file = Path(temp_dir) / f"temp.{file_ext}"
                    temp_file.write_bytes(file_content)
                    
                    images = []
                    auto_convert_success = False
                    
                    try:
                        if file_ext == 'pdf':
                            images = convert_from_path(str(temp_file), dpi=200, fmt='PNG')
                        elif file_ext in ['ppt', 'pptx']:
                            subprocess.run(
                                ['soffice', '--headless', '--convert-to', 'pdf', '--outdir', str(temp_dir), str(temp_file)],
                                check=True,
                                timeout=300
                            )
                            pdf_path = Path(temp_dir) / "temp.pdf"
                            if pdf_path.exists():
                                images = convert_from_path(str(pdf_path), dpi=200, fmt='PNG')
                            else:
                                raise Exception("PDF変換に失敗しました")
                        elif file_ext in ['png', 'jpg', 'jpeg']:
                            img = PILImage.open(temp_file)
                            img_copy = img.copy()
                            img.close()
                            images = [img_copy]
                        else:
                            result["message"] = f"サポートされていないファイル形式: {file_ext}"
                            failed_count += 1
                            results.append(result)
                            yield f"data: {json.dumps({'type': 'file_error', 'file_index': file_idx, 'file_name': obj_name, 'error': result['message']}, ensure_ascii=False)}\n\n"
                            # continueの代わりにauto_convert_successをFalseのままにする
                        
                        if images:  # 画像が生成された場合のみアップロード
                            # 各ページをアップロード
                            for i, img in enumerate(images, start=1):
                                img_bytes = io.BytesIO()
                                img.save(img_bytes, format='PNG')
                                img_bytes.seek(0)
                                
                                image_object_name = f"{folder_name}/page_{i:03d}.png"
                                upload_success = oci_service.upload_file(
                                    file_content=img_bytes,
                                    object_name=image_object_name,
                                    content_type="image/png",
                                    original_filename=f"page_{i:03d}.png",
                                    file_size=len(img_bytes.getvalue())
                                )
                                
                                if upload_success:
                                    page_images.append(image_object_name)
                            
                            yield f"data: {json.dumps({'type': 'auto_convert_complete', 'file_index': file_idx, 'file_name': obj_name, 'image_count': len(page_images)}, ensure_ascii=False)}\n\n"
                            auto_convert_success = True
                        
                    except Exception as conv_error:
                        result["message"] = f"画像変換エラー: {str(conv_error)}"
                        failed_count += 1
                        logger.error(f"画像変換エラー ({obj_name}): {conv_error}")
                        yield f"data: {json.dumps({'type': 'file_error', 'file_index': file_idx, 'file_name': obj_name, 'error': result['message']}, ensure_ascii=False)}\n\n"
                    finally:
                        # 一時ディレクトリを削除
                        if temp_dir and Path(temp_dir).exists():
                            try:
                                shutil.rmtree(temp_dir)
                                temp_dir = None
                            except Exception as cleanup_error:
                                logger.warning(f"一時ディレクトリ削除エラー: {cleanup_error}")
                    
                    # 自動変換に失敗した場合はこのファイルをスキップ
                    if not auto_convert_success:
                        results.append(result)
                        continue
                
                # 各ページ画像をベクトル化
                total_pages = len(page_images)
                
                if total_pages == 0:
                    result["message"] = "ページ画像が見つかりません。画像化に失敗した可能性があります"
                    failed_count += 1
                    results.append(result)
                    yield f"data: {json.dumps({'type': 'file_error', 'file_index': file_idx, 'total_files': len(object_names), 'file_name': obj_name, 'error': result['message']}, ensure_ascii=False)}\n\n"
                    continue
                
                yield f"data: {json.dumps({'type': 'vectorize_start', 'file_index': file_idx, 'file_name': obj_name, 'total_pages': total_pages}, ensure_ascii=False)}\n\n"
                
                for page_idx, page_image_name in enumerate(page_images, start=1):
                    try:
                        yield f"data: {json.dumps({'type': 'page_progress', 'file_index': file_idx, 'file_name': obj_name, 'page_index': page_idx, 'total_pages': total_pages}, ensure_ascii=False)}\n\n"
                        
                        # 画像をダウンロード
                        image_content = oci_service.download_object(page_image_name)
                        if not image_content:
                            logger.warning(f"画像が見つかりません: {page_image_name}")
                            continue
                        
                        image_bytes = io.BytesIO(image_content)
                        
                        # Embeddingを生成
                        embedding = image_vectorizer.generate_embedding(image_bytes, "image/png")
                        if embedding is None:
                            logger.warning(f"Embedding生成失敗: {page_image_name}")
                            continue
                        
                        # DBに保存
                        embedding_id = image_vectorizer.save_image_embedding(
                            file_id=file_id,
                            bucket=bucket_name,
                            object_name=page_image_name,
                            page_number=page_idx,
                            content_type="image/png",
                            file_size=len(image_content),
                            embedding=embedding
                        )
                        
                        if embedding_id:
                            result["embedding_count"] += 1
                        
                    except Exception as page_error:
                        logger.error(f"ページベクトル化エラー ({page_image_name}): {page_error}")
                        continue
                
                result["success"] = True
                result["message"] = f"{result['embedding_count']}ページをベクトル化しました"
                success_count += 1
                logger.info(f"ベクトル化完了: {obj_name} ({result['embedding_count']}ページ)")
                
                yield f"data: {json.dumps({'type': 'file_complete', 'file_index': file_idx, 'total_files': len(object_names), 'file_name': obj_name, 'embedding_count': result['embedding_count']}, ensure_ascii=False)}\n\n"
                
            except Exception as e:
                result["message"] = f"処理エラー: {str(e)}"
                failed_count += 1
                logger.error(f"ベクトル化エラー ({obj_name}): {e}")
                yield f"data: {json.dumps({'type': 'file_error', 'file_index': file_idx, 'total_files': len(object_names), 'file_name': obj_name, 'error': result['message']}, ensure_ascii=False)}\n\n"
            finally:
                if temp_dir and Path(temp_dir).exists():
                    try:
                        shutil.rmtree(temp_dir)
                    except:
                        pass
            
            results.append(result)
        
        # 完了通知
        overall_success = failed_count == 0
        summary_message = f"ベクトル化完了: 成功 {success_count}件、失敗 {failed_count}件"
        
        final_result = {
            "type": "complete",
            "success": overall_success,
            "message": summary_message,
            "total_files": len(object_names),
            "success_count": success_count,
            "failed_count": failed_count,
            "results": results
        }
        
        yield f"data: {json.dumps(final_result, ensure_ascii=False)}\n\n"
    
    return StreamingResponse(
        generate_progress(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no"
        }
    )

@app.post("/api/oci/objects/convert-to-images")
async def convert_documents_to_images(request: DocumentConvertRequest):
    """
    選択されたファイルをページ毎にPNG画像化して同名フォルダに保存
    Server-Sent Events (SSE)でリアルタイム進捗状況を送信
    """
    object_names = request.object_names
    
    if not object_names:
        raise HTTPException(status_code=400, detail="変換するファイルが指定されていません")
    
    logger.info(f"ページ画像化開始: {len(object_names)}件")
    
    async def generate_progress():
        """進捗状況をSSE形式でストリーミング"""
        results = []
        success_count = 0
        failed_count = 0
        
        # 開始通知
        yield f"data: {json.dumps({'type': 'start', 'total_files': len(object_names)}, ensure_ascii=False)}\n\n"
        
        for file_idx, obj_name in enumerate(object_names, start=1):
            result = {
                "object_name": obj_name,
                "success": False,
                "message": "",
                "image_count": 0,
                "folder_name": ""
            }
            
            # 一時ディレクトリの初期化（スコープ問題回避）
            temp_dir = None
            
            # ファイル処理開始通知
            yield f"data: {json.dumps({'type': 'file_start', 'file_index': file_idx, 'total_files': len(object_names), 'file_name': obj_name}, ensure_ascii=False)}\n\n"
            
            try:
                # ファイル名と拡張子を取得
                file_path = Path(obj_name)
                file_name = file_path.stem
                file_ext = file_path.suffix.lower().lstrip('.')
                
                # 同名フォルダ名（親フォルダがあれば考慮）
                parent_str = str(file_path.parent)
                if parent_str and parent_str != '.':
                    folder_name = f"{parent_str}/{file_name}"
                else:
                    folder_name = file_name
                
                result["folder_name"] = folder_name
                
                # 既存の同名フォルダ内の画像ファイルを削除
                yield f"data: {json.dumps({'type': 'cleanup_start', 'file_index': file_idx, 'total_files': len(object_names), 'file_name': obj_name, 'folder_name': folder_name}, ensure_ascii=False)}\n\n"
                
                # Namespaceを取得
                namespace_result = oci_service.get_namespace()
                if namespace_result.get("success"):
                    namespace = namespace_result.get("namespace")
                    bucket_name = os.getenv("OCI_BUCKET")
                    
                    if bucket_name and namespace:
                        # 同名フォルダ内のpage_*.pngファイルを検索して削除
                        existing_images_result = oci_service.list_objects(
                            bucket_name=bucket_name,
                            namespace=namespace,
                            prefix=f"{folder_name}/",
                            page_size=1000
                        )
                        
                        if existing_images_result.get("success"):
                            existing_objects = existing_images_result.get("objects", [])
                            images_to_delete = []
                            
                            # page_001.png, page_002.png などのパターンにマッチするファイルを抽出
                            # reモジュールはグローバルでインポート済み
                            for obj in existing_objects:
                                obj_name_str = obj.get("name", "")
                                # フォルダ（末尾が/）を除外し、page_XXX.pngパターンのみを対象
                                if not obj_name_str.endswith('/') and re.search(r'/page_\d{3}\.png$', obj_name_str):
                                    images_to_delete.append(obj_name_str)
                            
                            # 削除対象がある場合は削除
                            if images_to_delete:
                                logger.info(f"既存の画像ファイル {len(images_to_delete)}件を削除: {folder_name}")
                                yield f"data: {json.dumps({'type': 'cleanup_progress', 'file_index': file_idx, 'total_files': len(object_names), 'file_name': obj_name, 'cleanup_count': len(images_to_delete)}, ensure_ascii=False)}\n\n"
                                
                                delete_result = oci_service.delete_objects(
                                    bucket_name=bucket_name,
                                    namespace=namespace,
                                    object_names=images_to_delete
                                )
                                
                                if delete_result.get("success"):
                                    logger.info(f"既存画像の削除完了: {len(images_to_delete)}件")
                                    yield f"data: {json.dumps({'type': 'cleanup_complete', 'file_index': file_idx, 'total_files': len(object_names), 'file_name': obj_name, 'deleted_count': len(images_to_delete)}, ensure_ascii=False)}\n\n"
                                else:
                                    logger.warning(f"既存画像の削除に一部失敗: {delete_result.get('message')}")
                            else:
                                logger.info(f"削除対象の既存画像なし: {folder_name}")
                
                # Object Storageからファイルをダウンロード
                file_content = oci_service.download_object(obj_name)
                if not file_content:
                    result["message"] = "ファイルが見つかりません"
                    failed_count += 1
                    results.append(result)
                    yield f"data: {json.dumps({'type': 'file_error', 'file_index': file_idx, 'total_files': len(object_names), 'file_name': obj_name, 'error': result['message']}, ensure_ascii=False)}\n\n"
                    continue
                
                # 一時ファイルに保存
                temp_dir = tempfile.mkdtemp()
                temp_file = Path(temp_dir) / f"temp.{file_ext}"
                temp_file.write_bytes(file_content)
                
                images = []
                
                try:
                    # ファイルタイプごとに処理
                    if file_ext == 'pdf':
                        # PDFをページ毎にPNG変換
                        images = convert_from_path(str(temp_file), dpi=200, fmt='PNG')
                    elif file_ext in ['ppt', 'pptx']:
                        # PPT/PPTXをまずPDFに変換してからPNG化
                        subprocess.run(
                            ['soffice', '--headless', '--convert-to', 'pdf', '--outdir', str(temp_dir), str(temp_file)],
                            check=True,
                            timeout=300
                        )
                        # 変換されたPDFを画像化
                        pdf_path = Path(temp_dir) / "temp.pdf"
                        if pdf_path.exists():
                            images = convert_from_path(str(pdf_path), dpi=200, fmt='PNG')
                        else:
                            raise Exception("PDF変換に失敗しました")
                    elif file_ext in ['png', 'jpg', 'jpeg']:
                        # 画像ファイルはメモリに読み込んで1ページとして保存
                        img = PILImage.open(temp_file)
                        img_copy = img.copy()
                        img.close()
                        images = [img_copy]
                    else:
                        result["message"] = f"サポートされていないファイル形式: {file_ext}"
                        failed_count += 1
                        results.append(result)
                        yield f"data: {json.dumps({'type': 'file_error', 'file_index': file_idx, 'total_files': len(object_names), 'file_name': obj_name, 'error': result['message']}, ensure_ascii=False)}\n\n"
                        continue
                    
                    total_pages = len(images)
                    # ページ総数通知
                    yield f"data: {json.dumps({'type': 'pages_count', 'file_index': file_idx, 'total_files': len(object_names), 'file_name': obj_name, 'total_pages': total_pages}, ensure_ascii=False)}\n\n"
                    
                    # 各ページをPNG画像としてObject Storageにアップロード
                    for i, img in enumerate(images, start=1):
                        # ページ処理開始通知
                        yield f"data: {json.dumps({'type': 'page_progress', 'file_index': file_idx, 'total_files': len(object_names), 'file_name': obj_name, 'page_index': i, 'total_pages': total_pages}, ensure_ascii=False)}\n\n"
                        
                        # PNGバイナリに変換
                        img_bytes = io.BytesIO()
                        img.save(img_bytes, format='PNG')
                        img_bytes.seek(0)
                        
                        # Object Storageにアップロード
                        image_object_name = f"{folder_name}/page_{i:03d}.png"
                        upload_success = oci_service.upload_file(
                            file_content=img_bytes,
                            object_name=image_object_name,
                            content_type="image/png",
                            original_filename=f"page_{i:03d}.png",
                            file_size=len(img_bytes.getvalue())
                        )
                        
                        if upload_success:
                            result["image_count"] += 1
                        else:
                            logger.warning(f"画像アップロード失敗: {image_object_name}")
                    
                    result["success"] = True
                    result["message"] = f"{result['image_count']}ページを画像化しました"
                    success_count += 1
                    logger.info(f"ページ画像化完了: {obj_name} ({result['image_count']}ページ)")
                    
                    # ファイル処理完了通知
                    yield f"data: {json.dumps({'type': 'file_complete', 'file_index': file_idx, 'total_files': len(object_names), 'file_name': obj_name, 'image_count': result['image_count']}, ensure_ascii=False)}\n\n"
                    
                except subprocess.TimeoutExpired:
                    result["message"] = "PDF変換がタイムアウトしました"
                    failed_count += 1
                    yield f"data: {json.dumps({'type': 'file_error', 'file_index': file_idx, 'total_files': len(object_names), 'file_name': obj_name, 'error': result['message']}, ensure_ascii=False)}\n\n"
                except Exception as conv_error:
                    result["message"] = f"変換エラー: {str(conv_error)}"
                    failed_count += 1
                    logger.error(f"ページ画像化エラー ({obj_name}): {conv_error}")
                    yield f"data: {json.dumps({'type': 'file_error', 'file_index': file_idx, 'total_files': len(object_names), 'file_name': obj_name, 'error': result['message']}, ensure_ascii=False)}\n\n"
                finally:
                    # 一時ファイル削除
                    try:
                        if temp_dir and Path(temp_dir).exists():
                            shutil.rmtree(temp_dir)
                    except:
                        pass
                
            except Exception as e:
                result["message"] = f"処理エラー: {str(e)}"
                failed_count += 1
                logger.error(f"ページ画像化エラー ({obj_name}): {e}")
                yield f"data: {json.dumps({'type': 'file_error', 'file_index': file_idx, 'total_files': len(object_names), 'file_name': obj_name, 'error': result['message']}, ensure_ascii=False)}\n\n"
            
            results.append(result)
        
        # 全体の結果を返す
        overall_success = failed_count == 0
        summary_message = f"ページ画像化完了: 成功 {success_count}件、失敗 {failed_count}件"
        
        final_result = {
            "type": "complete",
            "success": overall_success,
            "message": summary_message,
            "total_files": len(object_names),
            "success_count": success_count,
            "failed_count": failed_count,
            "results": results
        }
        
        yield f"data: {json.dumps(final_result, ensure_ascii=False)}\n\n"
    
    return StreamingResponse(
        generate_progress(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no"
        }
    )

# ========================================
# アプリケーション起動
# ========================================

if __name__ == "__main__":
    import uvicorn
    
    port = int(os.getenv("API_PORT", "8081"))
    host = os.getenv("API_HOST", "0.0.0.0")
    
    logger.info(f"サーバーを起動中: {host}:{port}")
    uvicorn.run(app, host=host, port=port)
