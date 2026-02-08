"""
Autonomous Database 管理サービス
"""
"""
Autonomous Database サービス

Oracle Autonomous Databaseの管理を行うサービスです。
データベースの起動・停止、情報取得、状態監視などの機能を提供します。

主な機能:
- Autonomous Databaseクライアントの初期化
- データベース情報の取得
- データベースの起動・停止操作
- データベース状態の監視
- OCI APIとの連携

設計原則:
- OCI設定の検証とエラーハンドリング
- 非同期処理による応答性の向上
- 状態遷移の適切な管理
"""

import logging
import os
from typing import Optional

import oci
from app.models.adb import ADBGetResponse, ADBOperationResponse
from app.services.oci_service import oci_service

logger = logging.getLogger(__name__)


class ADBService:
    """Autonomous Database 管理サービス"""
    
    def __init__(self):
        self._db_client = None
    
    def _get_db_client(self) -> Optional[oci.database.DatabaseClient]:
        """Database Clientを取得"""
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
            
            # コンパートメント内のADBリストを取得
            adbs = db_client.list_autonomous_databases(
                compartment_id=compartment_ocid
            ).data
            
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
            
            # 現在の状態を確認
            adb = db_client.get_autonomous_database(adb_ocid).data
            
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
            
            # 起動リクエスト送信
            db_client.start_autonomous_database(adb_ocid)
            
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
            
            # 現在の状態を確認
            adb = db_client.get_autonomous_database(adb_ocid).data
            
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
            
            # 停止リクエスト送信
            db_client.stop_autonomous_database(adb_ocid)
            
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
