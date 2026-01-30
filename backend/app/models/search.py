from pydantic import BaseModel
from typing import Optional, List, Dict, Any

class SearchQuery(BaseModel):
    """検索クエリ"""
    query: str
    top_k: Optional[int] = 10
    min_score: Optional[float] = 0.7  # デフォルトを0.7に設定

class ImageSearchResult(BaseModel):
    """画像検索結果(個別のページ画像)"""
    embed_id: int
    bucket: str
    object_name: str
    page_number: int
    vector_distance: float
    content_type: Optional[str] = None
    file_size: Optional[int] = None
    url: Optional[str] = None  # 絶対URL(外部システム統合用)

class FileSearchResult(BaseModel):
    """ファイル検索結果(ファイル単位)"""
    file_id: int
    bucket: str
    object_name: str
    original_filename: Optional[str] = None
    file_size: Optional[int] = None
    content_type: Optional[str] = None
    uploaded_at: Optional[str] = None
    min_distance: float  # このファイル内の最小距離
    matched_images: List[ImageSearchResult]  # マッチした画像のリスト
    url: Optional[str] = None  # 絶対URL(外部システム統合用)

class SearchResponse(BaseModel):
    """検索レスポンス"""
    success: bool
    query: str
    results: List[FileSearchResult]  # ファイル単位の結果
    total_files: int  # マッチしたファイル数
    total_images: int  # マッチした画像数
    processing_time: float  # 秒
