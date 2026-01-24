"""
データベース管理関連のデータモデル
"""
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field


class DatabaseSettings(BaseModel):
    """データベース接続設定"""
    username: Optional[str] = None
    password: Optional[str] = None
    dsn: Optional[str] = None  # 表示用DSN
    wallet_uploaded: bool = False  # Walletアップロード済みか
    available_services: List[str] = []  # tnsnames.oraから抽出したDSNリスト


class DatabaseSettingsResponse(BaseModel):
    """データベース設定取得レスポンス"""
    settings: DatabaseSettings
    is_connected: bool = False
    status: str = "not_connected"


class DatabaseConnectionTestRequest(BaseModel):
    """データベース接続テストリクエスト"""
    settings: Optional[DatabaseSettings] = None


class DatabaseConnectionTestResponse(BaseModel):
    """データベース接続テストレスポンス"""
    success: bool
    message: str
    details: Optional[Dict[str, Any]] = None


class DatabaseInfo(BaseModel):
    """データベース情報"""
    version: Optional[str] = None
    instance_name: Optional[str] = None
    database_name: Optional[str] = None
    current_user: Optional[str] = None


class DatabaseInfoResponse(BaseModel):
    """データベース情報取得レスポンス"""
    success: bool
    info: Optional[DatabaseInfo] = None


class TableInfo(BaseModel):
    """テーブル情報"""
    table_name: str
    num_rows: Optional[int] = None
    created: Optional[str] = None
    last_analyzed: Optional[str] = None
    comments: Optional[str] = None


class DatabaseTablesResponse(BaseModel):
    """テーブル一覧取得レスポンス"""
    success: bool
    tables: List[TableInfo] = []
    total: int = 0
    # ページネーション情報
    current_page: int = 1      # 現在のページ番号
    total_pages: int = 1       # 総ページ数
    page_size: int = 20        # ページサイズ
    start_row: int = 0         # 開始行番号
    end_row: int = 0           # 終了行番号


class WalletUploadResponse(BaseModel):
    """�Walletアップロードレスポンス"""
    success: bool
    message: str
    wallet_location: Optional[str] = None
    available_services: List[str] = []


class TablespaceInfo(BaseModel):
    """テーブルスペース情報"""
    tablespace_name: str
    total_size_mb: float = 0.0
    used_size_mb: float = 0.0
    free_size_mb: float = 0.0
    used_percent: float = 0.0
    status: Optional[str] = None


class DatabaseStorageInfo(BaseModel):
    """データベースストレージ情報"""
    tablespaces: List[TablespaceInfo] = []
    total_size_mb: float = 0.0
    used_size_mb: float = 0.0
    free_size_mb: float = 0.0
    used_percent: float = 0.0


class DatabaseStorageResponse(BaseModel):
    """データベースストレージ情報取得レスポンス"""
    success: bool
    storage_info: Optional[DatabaseStorageInfo] = None
    message: Optional[str] = None


class TableBatchDeleteRequest(BaseModel):
    """テーブル一括削除リクエスト"""
    table_names: List[str]


class TableBatchDeleteResponse(BaseModel):
    """テーブル一括削除レスポンス"""
    success: bool
    deleted_count: int = 0
    message: Optional[str] = None
    errors: List[str] = []


class TableDataResponse(BaseModel):
    """テーブルデータ取得レスポンス"""
    success: bool
    rows: List[List[Any]] = []
    columns: List[str] = []
    total: int = 0
    message: Optional[str] = None
    # ページネーション情報
    current_page: int = 1
    total_pages: int = 1
    page_size: int = 20
    start_row: int = 0
    end_row: int = 0
