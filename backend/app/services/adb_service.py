"""
Autonomous Database 管理サービス
"""
import logging
import os
import random
import time
from typing import Optional, Any

import oci
from app.models.adb import ADBGetResponse, ADBInfo, ADBOperationResponse
from app.services.oci_service import oci_service

logger = logging.getLogger(__name__)


class ADBService:
    """Autonomous Database 管理サービス"""
    
    def __init__(self):
        """初期化"""
        self._db_client = None

    # レート制限対応のリトライ設定
    ADB_API_MAX_RETRIES = 3
    ADB_API_BASE_DELAY = 1.0
    ADB_API_MAX_DELAY = 60.0
    ADB_API_JITTER = 0.1

    def _is_rate_limit_error(self, error: Exception) -> bool:
        """エラーがレート制限関連かどうかを判定"""
        error_str = str(error).lower()
        return (
            '429' in error_str or 
            'too many requests' in error_str or 
            'rate limit exceeded' in error_str or
            'quota exceeded' in error_str or
            'request limit' in error_str
        )
    
    def _calculate_backoff_delay(self, attempt: int, is_rate_limit: bool = False) -> float:
        """指数バックオフ遅延時間を計算"""
        base_multiplier = 3.0 if is_rate_limit else 2.0
        delay = self.ADB_API_BASE_DELAY * (base_multiplier ** attempt)
        delay = min(delay, self.ADB_API_MAX_DELAY)
        jitter = random.uniform(-self.ADB_API_JITTER, self.ADB_API_JITTER) * delay
        return max(0.1, delay + jitter)
    
    def _retry_api_call(self, func, *args, **kwargs) -> Any:
        """OCI API呼び出しにリトライメカニズムを適用"""
        last_exception = None
        
        for attempt in range(self.ADB_API_MAX_RETRIES):
            try:
                result = func(*args, **kwargs)
                if attempt > 0:
                    logger.info(f"ADB API呼び出し成功（リトライ {attempt}回目後）")
                return result
                
            except Exception as e:
                last_exception = e
                is_rate_limit = self._is_rate_limit_error(e)
                
                if attempt == self.ADB_API_MAX_RETRIES - 1:
                    logger.error(f"ADB API呼び出し最終リトライ失敗（{self.ADB_API_MAX_RETRIES}回）: {e}")
                    raise
                
                delay = self._calculate_backoff_delay(attempt, is_rate_limit)
                error_type = "レート制限" if is_rate_limit else "エラー"
                logger.warning(
                    f"ADB API {error_type}（リトライ {attempt + 1}/{self.ADB_API_MAX_RETRIES}）: "
                    f"{delay:.1f}秒後に再試行 - {str(e)[:100]}"
                )
                time.sleep(delay)
        
        if last_exception:
            raise last_exception

    
    def _get_db_client(self) -> Optional[oci.database.DatabaseClient]:
        """
        Database Clientを取得します。
        
        OCI設定からDatabaseClientを作成して返します。
        
        Returns:
            Optional[oci.database.DatabaseClient]: Database Clientインスタンス、失敗時はNone
        """
        try:
            config = oci_service.get_oci_config()
            if not config:
                logger.error("OCI設定が見つかりません")
                return None
            
            # Database Clientを作成
            return oci.database.DatabaseClient(config)
        except Exception as e:
            logger.error(f"Database Client作成エラー: {e}")
            return None
    
    def get_adb_info(self, adb_name: str, compartment_ocid: str) -> ADBGetResponse:
        """
        Autonomous Database情報を取得
        
        Args:
            adb_name: データベース名（環境変数から取得する場合は空文字列）
            compartment_ocid: コンパートメントOCID（環境変数から取得する場合は空文字列）
        
        Returns:
            ADBGetResponse: 取得結果
        """
        try:
            # 環境変数から設定を取得
            if not adb_name:
                adb_name = os.getenv('ADB_NAME')
            if not compartment_ocid:
                compartment_ocid = os.getenv('OCI_COMPARTMENT_OCID')
            
            if not adb_name or not compartment_ocid:
                return ADBGetResponse(
                    status="error",
                    message="ADB_NAME または OCI_COMPARTMENT_OCID が設定されていません。"
                )
            
            db_client = self._get_db_client()
            if not db_client:
                return ADBGetResponse(
                    status="error",
                    message="OCI接続を確認できません。OCI設定を確認してください。"
                )
            
            # コンパートメント内のADBリストを取得（リトライ対応）
            adbs_response = self._retry_api_call(
                db_client.list_autonomous_databases,
                compartment_id=compartment_ocid
            )
            adbs = adbs_response.data
            
            # 指定された名前のADBを検索
            target_adb = None
            for adb in adbs:
                if adb.display_name == adb_name or adb.db_name == adb_name:
                    target_adb = adb
                    break
            
            if not target_adb:
                return ADBGetResponse(
                    status="error",
                    message=f"データベース '{adb_name}' が見つかりませんでした。"
                )
            
            return ADBGetResponse(
                status="accepted",
                message="Database information retrieved",
                id=target_adb.id,
                display_name=target_adb.display_name,
                lifecycle_state=target_adb.lifecycle_state
            )
            
        except Exception as e:
            logger.error(f"ADB情報取得エラー: {e}")
            return ADBGetResponse(
                status="error",
                message=f"エラー: {str(e)}"
            )
    
    def start_adb(self, adb_ocid: str) -> ADBOperationResponse:
        """
        Autonomous Databaseを起動
        
        Args:
            adb_ocid: Autonomous Database OCID
        
        Returns:
            ADBOperationResponse: 操作結果
        """
        try:
            db_client = self._get_db_client()
            if not db_client:
                return ADBOperationResponse(
                    status="error",
                    message="OCI接続を確認できません。OCI設定を確認してください。"
                )
            
            # 現在の状態を確認（リトライ対応）
            adb = self._retry_api_call(db_client.get_autonomous_database, adb_ocid).data
            
            if adb.lifecycle_state == "AVAILABLE":
                return ADBOperationResponse(
                    status="error",
                    message="データベースは既に起動しています。"
                )
            
            if adb.lifecycle_state not in ["STOPPED", "AVAILABLE"]:
                return ADBOperationResponse(
                    status="error",
                    message=f"データベースの現在の状態 ({adb.lifecycle_state}) では起動できません。"
                )
            
            # 起動リクエスト送信（リトライ対応）
            self._retry_api_call(db_client.start_autonomous_database, adb_ocid)
            
            return ADBOperationResponse(
                status="accepted",
                message=f"データベース '{adb.display_name}' の起動を開始しました。"
            )
            
        except Exception as e:
            logger.error(f"ADB起動エラー: {e}")
            return ADBOperationResponse(
                status="error",
                message=f"起動エラー: {str(e)}"
            )
    
    def stop_adb(self, adb_ocid: str) -> ADBOperationResponse:
        """
        Autonomous Databaseを停止
        
        Args:
            adb_ocid: Autonomous Database OCID
        
        Returns:
            ADBOperationResponse: 操作結果
        """
        try:
            db_client = self._get_db_client()
            if not db_client:
                return ADBOperationResponse(
                    status="error",
                    message="OCI接続を確認できません。OCI設定を確認してください。"
                )
            
            # 現在の状態を確認（リトライ対応）
            adb = self._retry_api_call(db_client.get_autonomous_database, adb_ocid).data
            
            if adb.lifecycle_state == "STOPPED":
                return ADBOperationResponse(
                    status="error",
                    message="データベースは既に停止しています。"
                )
            
            if adb.lifecycle_state not in ["STOPPED", "AVAILABLE"]:
                return ADBOperationResponse(
                    status="error",
                    message=f"データベースの現在の状態 ({adb.lifecycle_state}) では停止できません。"
                )
            
            # 停止リクエスト送信（リトライ対応）
            self._retry_api_call(db_client.stop_autonomous_database, adb_ocid)
            
            return ADBOperationResponse(
                status="accepted",
                message=f"データベース '{adb.display_name}' の停止を開始しました。"
            )
            
        except Exception as e:
            logger.error(f"ADB停止エラー: {e}")
            return ADBOperationResponse(
                status="error",
                message=f"停止エラー: {str(e)}"
            )


# シングルトンインスタンス
adb_service = ADBService()
