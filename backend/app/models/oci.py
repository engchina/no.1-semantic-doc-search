from typing import Any, Dict, Optional

from pydantic import BaseModel

class OCISettings(BaseModel):
    """OCI設定モデル"""
    # 認証情報
    user_ocid: Optional[str] = None
    tenancy_ocid: Optional[str] = None
    fingerprint: Optional[str] = None
    key_content: Optional[str] = None
    region: Optional[str] = None
    
    # Object Storage設定
    bucket_name: Optional[str] = None
    namespace: Optional[str] = None
    
class OCISettingsResponse(BaseModel):
    """OCI設定レスポンス"""
    settings: OCISettings
    is_configured: bool
    status: str
    message: Optional[str] = None
    has_credentials: bool = False

class OCIConnectionTestRequest(BaseModel):
    """OCI接続テストリクエスト"""
    settings: Optional[OCISettings] = None

class OCIConnectionTestResponse(BaseModel):
    """OCI接続テストレスポンス"""
    success: bool
    message: str
    details: Optional[Dict[str, Any]] = None

class EnterpriseAISettings(BaseModel):
    """OCI Generative AI OpenAI互換エンドポイント設定"""
    base_url: str
    project: Optional[str] = None
    api_key: str
    model: str
