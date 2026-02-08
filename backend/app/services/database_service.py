"""
データベース管理サービス

Oracle Database接続とクエリ実行を管理するサービスです。
接続プール経由でDB操作を実行し、Thin modeに対応しています。

主な機能:
- データベース接続設定の管理
- 接続プールの初期化と管理
- SQLクエリの実行
- Autonomous Database Walletの管理
- テーブル情報の取得と管理
"""
import asyncio
import json
import logging
import os
import re
import shutil
import zipfile
from concurrent.futures import ThreadPoolExecutor  # 必要に応じて使用
from datetime import datetime
from functools import partial
from pathlib import Path
from typing import Any, Dict, List, Optional

from app.services.connection_pool_manager import ConnectionPoolManager

logger = logging.getLogger(__name__)

def setup_tns_admin() -> Optional[str]:
    """
    Setup TNS_ADMIN environment variable if not already set
    
    TNS_ADMINはinit_script.shでも設定されますが、
    Python側でも明示的に設定することで再起動後の一貫性を保証します。
    
    Returns:
        Optional[str]: TNS_ADMIN path, or None if ORACLE_CLIENT_LIB_DIR is not set
    """
    if not os.environ.get('TNS_ADMIN'):
        # TNS_ADMINは常に ORACLE_CLIENT_LIB_DIR/network/admin を使用
        lib_dir = os.environ.get('ORACLE_CLIENT_LIB_DIR')
        if not lib_dir:
            # ORACLE_CLIENT_LIB_DIRが設定されていない場合は.envから読み込みを試みる
            logger.warning("ORACLE_CLIENT_LIB_DIR環境変数が設定されていません。.envファイルから読み込みを試みます...")
            try:
                from dotenv import load_dotenv
                load_dotenv()
                lib_dir = os.environ.get('ORACLE_CLIENT_LIB_DIR')
                if lib_dir:
                    logger.info(f".envからORACLE_CLIENT_LIB_DIRを読み込みました: {lib_dir}")
            except ImportError:
                logger.error("python-dotenvモジュールが利用できません")
            
            if not lib_dir:
                logger.error("ORACLE_CLIENT_LIB_DIRが設定されていません")
                return None
        
        wallet_location = os.path.join(lib_dir, "network", "admin")
        os.environ['TNS_ADMIN'] = wallet_location
        logger.info(f"Set TNS_ADMIN to: {wallet_location}")
    
    return os.environ.get('TNS_ADMIN')

# 設定ファイルパス
STORAGE_PATH = Path(os.getenv("STORAGE_PATH", "./storage"))
# DB接続は.envのORACLE_26AI_CONNECTION_STRINGを使用

# oracledbモジュールのインポート（オプション）
try:
    import oracledb
    import platform
    ORACLEDB_AVAILABLE = True
    
    # Thin modeを使用（Oracle Clientは不要）
except ImportError:
    logger.warning("oracledb モジュールが利用できません。pip install oracledb を実行してください。")
    ORACLEDB_AVAILABLE = False


# Thin modeでは init_oracle_client() は不要（削除済み）


def _execute_db_operation(func_name: str, **kwargs) -> Dict[str, Any]:
    """
    データベース操作を実行（接続テスト用）
    
    参照プロジェクト（No.1-SQL-Assist）の実装に基づくシンプルな接続方式
    
    Args:
        func_name: 操作名 ('test_connection')
        **kwargs: 接続パラメータ (username, password, dsn)
        
    Returns:
        Dict with operation result
    """
    import time
    
    logger.info("========== データベース操作開始 ==========")
    logger.info(f"操作: {func_name}")
    
    # Step 1: oracledbモジュール確認
    logger.info("[Step 1] oracledbモジュール確認")
    if not ORACLEDB_AVAILABLE:
        logger.error("  ✘ oracledbモジュールが利用できません")
        return {'success': False, 'message': 'oracledbモジュールがインストールされていません'}
    logger.info(f"  ✔ oracledb version: {oracledb.__version__} (Thin mode)")
    
    # Step 2: Wallet場所設定（Thin mode）
    logger.info("[Step 2] Wallet場所設定（Thin mode）")
    tns_admin = setup_tns_admin()
    logger.info(f"  TNS_ADMIN: {tns_admin}")
    
    if not tns_admin or not os.path.exists(tns_admin):
        logger.error(f"  ✘ TNS_ADMINディレクトリが存在しません: {tns_admin}")
        return {'success': False, 'message': f'Walletディレクトリが見つかりません: {tns_admin}'}
    
    # Walletファイル確認
    wallet_files = os.listdir(tns_admin)
    logger.info(f"  Walletファイル: {wallet_files}")
    
    # 必須ウォレットファイルのチェック（4つ）
    required_files = ['cwallet.sso', 'ewallet.pem', 'sqlnet.ora', 'tnsnames.ora']
    missing = [f for f in required_files if f not in wallet_files]
    if missing:
        logger.error(f"  ✘ 必要なWalletファイルが不足: {missing}")
        logger.error("  必須: cwallet.sso (自動ログイン), ewallet.pem (PEM形式証明書), sqlnet.ora (ネットワーク設定), tnsnames.ora (接続文字列)")
        return {'success': False, 'message': f'必要なWalletファイルが不足: {missing}'}
    logger.info("  ✔ すべての必須Walletファイルが確認されました")
    logger.info("    - cwallet.sso (自動ログイン)")
    logger.info("    - ewallet.pem (PEM形式証明書)")
    logger.info("    - sqlnet.ora (ネットワーク設定)")
    logger.info("    - tnsnames.ora (接続文字列)")
    
    # 利用可能なサービス確認
    tnsnames_path = os.path.join(tns_admin, 'tnsnames.ora')
    available_services = []
    if os.path.exists(tnsnames_path):
        with open(tnsnames_path, 'r') as f:
            content = f.read()
        available_services = re.findall(r'^([\w-]+)\s*=', content, re.MULTILINE)
        logger.info(f"  利用可能なサービス: {available_services}")
    
    if func_name == 'test_connection':
        # Step 4: 接続パラメータ確認
        logger.info("[Step 4] 接続パラメータ確認")
        username = kwargs.get('username')
        password = kwargs.get('password')
        dsn = kwargs.get('dsn')
        
        logger.info(f"  username: {username}")
        logger.info(f"  password: {'***' if password else 'None'}")
        logger.info(f"  dsn: {dsn}")
        
        if not username:
            logger.error("  ✘ usernameが設定されていません")
            return {'success': False, 'message': 'ユーザー名が必要です'}
        if not password:
            logger.error("  ✘ passwordが設定されていません")
            return {'success': False, 'message': 'パスワードが必要です'}
        if not dsn:
            logger.error("  ✘ dsnが設定されていません")
            return {'success': False, 'message': 'DSNが必要です'}
        
        # DSNがtnsnames.oraに存在するか確認
        if available_services and dsn not in available_services:
            logger.warning(f"  ⚠ DSN '{dsn}' がtnsnames.oraに見つかりません")
            logger.warning(f"  利用可能なサービス: {available_services}")
        
        logger.info("  ✔ 接続パラメータOK")
        
        # Step 5: データベース接続（リトライ付き）
        logger.info("[Step 5] データベース接続")
        
        max_retries = 3
        retry_delay = 2
        last_error = None
        
        for attempt in range(1, max_retries + 1):
            connection = None
            try:
                from datetime import datetime
                logger.info(f"  接続試行 {attempt}/{max_retries}...")
                logger.info(f"  接続開始時刻: {datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')}")
                start_time = time.time()
                
                # Thin mode接続(Wallet使用)
                # 注: Walletのパスワードは ORACLE_26AI_CONNECTION_STRING のパスワードを使用
                logger.info("  >>> oracledb.connect()呼び出し中... (Thin mode, タイムアウト: 10秒)")
                connection = oracledb.connect(
                    user=username,
                    password=password,
                    dsn=dsn,
                    config_dir=tns_admin,  # Wallet場所
                    wallet_location=tns_admin,  # Wallet場所
                    wallet_password=password,  # Walletのパスワード
                    tcp_connect_timeout=10  # 10秒でタイムアウト(推奨値)
                )
                
                elapsed = time.time() - start_time
                logger.info(f"  <<< oracledb.connect()完了 ({elapsed:.2f}秒)")
                
                # Step 6: 接続テスト
                logger.info("[Step 6] 接続テスト")
                with connection.cursor() as cursor:
                    cursor.execute("SELECT 1 FROM DUAL")
                    result = cursor.fetchone()
                    logger.info(f"  ✔ テストクエリ成功: {result}")
                
                # 接続をクローズ
                connection.close()
                
                logger.info("========== 接続テスト完了: 成功 ==========")
                return {
                    'success': True,
                    'message': 'データベース接続に成功しました',
                    'details': {'status': 'connected', 'attempts': attempt}
                }
                
            except Exception as e:
                last_error = e
                error_str = str(e)
                logger.error(f"  ✘ 接続失敗 (試行{attempt}): {error_str}")
                
                # エラー原因を解析
                if "DPY-6005" in error_str or "DPY-6000" in error_str:
                    logger.error("  原因: データベースが停止している可能性")
                elif "ORA-01017" in error_str:
                    logger.error("  原因: ユーザー名/パスワードが不正")
                elif "ORA-12154" in error_str:
                    logger.error("  原因: DSNが見つからない")
                elif "ORA-12541" in error_str:
                    logger.error("  原因: リスナーが応答しない")
                elif "Broken pipe" in error_str:
                    logger.error("  原因: ネットワーク接続切断")
                
                # 接続をクローズ
                if connection:
                    try:
                        connection.close()
                    except:
                        pass
                
                # リトライ
                if attempt < max_retries:
                    logger.info(f"  {retry_delay}秒後にリトライ...")
                    time.sleep(retry_delay)
        
        # 全リトライ失敗
        logger.error(f"========== 接続テスト完了: 失敗 ==========")
        error_msg = str(last_error) if last_error else '不明なエラー'
        
        # ユーザー向けのエラーメッセージを生成
        if "DPY-6005" in error_msg or "DPY-6000" in error_msg:
            user_msg = '接続エラー: データベースが停止している可能性があります。ADBの起動状態を確認してください。'
        elif "ORA-01017" in error_msg:
            user_msg = '接続エラー: ユーザー名またはパスワードが正しくありません。'
        elif "ORA-12154" in error_msg:
            user_msg = '接続エラー: DSNが見つかりません。Walletとtnsnames.oraを確認してください。'
        elif "ORA-12541" in error_msg:
            user_msg = '接続エラー: データベースサーバーに接続できません。ネットワーク設定を確認してください。'
        elif "Broken pipe" in error_msg:
            user_msg = '接続エラー: ネットワーク接続が切断されました。'
        else:
            user_msg = f'接続エラー: {error_msg}'
        
        return {'success': False, 'message': user_msg}
    
class DatabaseService:
    """データベース管理サービス（単例モード）
    
    接続プール方式:
    - ConnectionPoolManagerを使用した接続プール管理
    - 遅延初期化: 初回のDB操作時に接続プールを作成
    - リトライ機能: 接続プール作成失敗時、最大3回リトライ
    - Thin mode対応: Oracle Clientライブラリ不要
    - TNS_ADMIN環境変数を使用
    """
    _instance = None
    _initialized = False
    
    # リトライ設定
    MAX_RETRIES = 3
    RETRY_DELAY = 2  # 秒
    
    def __new__(cls):
        """単例モードの実装"""
        if cls._instance is None:
            cls._instance = super(DatabaseService, cls).__new__(cls)
        return cls._instance
    
    def __init__(self):
        """初期化（一度だけ実行）"""
        if not self.__class__._initialized:
            self.pool_manager = ConnectionPoolManager()
            self.settings = self._load_settings()
            self.__class__._initialized = True
            logger.info("========== DatabaseService初期化 ==========")
            logger.info("データベースサービスを単例モードで初期化しました（接続プール方式）")
            logger.info(f"MAX_RETRIES={self.MAX_RETRIES}, RETRY_DELAY={self.RETRY_DELAY}秒")
    
    def _ensure_pool_initialized(self) -> bool:
        """接続プールが初期化されていることを保証（遅延初期化）
        
        Returns:
            bool: 初期化成功の場合True
        """
        pool = self.pool_manager.get_pool()
        if pool is not None:
            return True
        
        # 接続情報を取得
        username = self.settings.get("username")
        password = self.settings.get("password")
        dsn = self.settings.get("dsn")
        
        # 設定が不完全な場合、.envから取得
        if not username or not password or not dsn:
            logger.info("設定が不完全、.envから取得を試みます...")
            env_info = self.get_env_connection_info()
            if env_info.get("success"):
                username = username or env_info.get("username")
                password = password or env_info.get("password")
                dsn = dsn or env_info.get("dsn")
        
        if not username or not password or not dsn:
            logger.error("接続情報が不完全です")
            return False
        
        # 接続プールを初期化
        logger.info("接続プールを遅延初期化します...")
        return self.pool_manager.initialize_pool(username, password, dsn)
    
    def is_connected(self) -> bool:
        """データベース接続状態をチェック
        
        Returns:
            bool: 接続が有効な場合True
        """
        try:
            if not self._ensure_pool_initialized():
                logger.debug("接続状態チェック: プール未初期化")
                return False
            
            # 簡単なクエリでテスト
            with self.pool_manager.acquire_connection() as connection:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT 1 FROM DUAL")
                    cursor.fetchone()
            
            logger.debug("接続状態チェック: 接続有効")
            return True
        except Exception as e:
            logger.warning(f"接続状態チェック: 接続無効 - {e}")
            return False
    
    # 注: 接続プール管理に移行したため、_reconnect_with_retry()は廃止
    # 接続プールが自動的に接続を管理します
    
    def _create_connection_internal(self) -> Optional[Any]:
        """データベース接続を内部的に作成（リトライなし）
        
        Returns:
            データベース接続、または失敗時はNone
        """
        logger.info("========== 接続作成開始 ==========")
        
        # Step 1: oracledbモジュール確認
        logger.info("[Step 1] oracledbモジュール確認")
        if not ORACLEDB_AVAILABLE:
            logger.error("  ✘ oracledbモジュールが利用できません")
            return None
        logger.info(f"  ✔ oracledbモジュール利用可能 (version: {oracledb.__version__})")
        
        # Step 2: 接続情報取得
        logger.info("[Step 2] 接続情報取得")
        username = self.settings.get("username")
        password = self.settings.get("password")
        dsn = self.settings.get("dsn")
        
        logger.info(f"  設定ファイルから: username={username}, dsn={dsn}, password_exists={bool(password)}")
        
        # 設定が不完全な場合、.envから取得
        if not username or not password or not dsn:
            logger.info("  設定が不完全、.envから取得を試みます...")
            env_info = self.get_env_connection_info()
            if env_info.get("success"):
                username = username or env_info.get("username")
                password = password or env_info.get("password")
                dsn = dsn or env_info.get("dsn")
                logger.info(f"  .envから取得: username={username}, dsn={dsn}, password_exists={bool(password)}")
            else:
                logger.warning(f"  .envからの取得失敗: {env_info.get('message', 'unknown')}")
        
        if not username:
            logger.error("  ✘ usernameが設定されていません")
            return None
        if not password:
            logger.error("  ✘ passwordが設定されていません")
            return None
        if not dsn:
            logger.error("  ✘ dsnが設定されていません")
            return None
        logger.info(f"  ✔ 接続情報OK: username={username}, dsn={dsn}")
        
        # Step 3: Wallet場所確認（Thin mode）
        logger.info("[Step 3] Wallet場所確認（Thin mode）")
        wallet_location = self._get_wallet_location()
        logger.info(f"  ORACLE_CLIENT_LIB_DIR: {os.getenv('ORACLE_CLIENT_LIB_DIR')}")
        logger.info(f"  Wallet場所: {wallet_location}")
        
        if not wallet_location:
            logger.error("  ✘ Wallet場所が取得できません")
            return None
        
        if not os.path.exists(wallet_location):
            logger.error(f"  ✘ Walletディレクトリが存在しません: {wallet_location}")
            return None
        
        # Walletファイルの確認
        wallet_files = os.listdir(wallet_location)
        logger.info(f"  Walletファイル: {wallet_files}")
        
        # 必須ウォレットファイルのチェック（4つ）
        required_files = ['cwallet.sso', 'ewallet.pem', 'sqlnet.ora', 'tnsnames.ora']
        missing_files = [f for f in required_files if f not in wallet_files]
        if missing_files:
            logger.error(f"  ✘ 必要なWalletファイルが不足: {missing_files}")
            logger.error("  必須: cwallet.sso (自動ログイン), ewallet.pem (PEM形式証明書), sqlnet.ora (ネットワーク設定), tnsnames.ora (接続文字列)")
            return None
        logger.info("  ✔ すべての必須Walletファイルが確認されました")
        
        # TNS_ADMIN設定
        os.environ['TNS_ADMIN'] = wallet_location
        logger.info(f"  ✔ TNS_ADMIN設定完了: {wallet_location}")
        
        # tnsnames.oraのサービス確認
        tnsnames_path = os.path.join(wallet_location, 'tnsnames.ora')
        if os.path.exists(tnsnames_path):
            with open(tnsnames_path, 'r') as f:
                content = f.read()
            services = re.findall(r'^([\w-]+)\s*=', content, re.MULTILINE)
            logger.info(f"  利用可能なサービス: {services}")
            if dsn not in services:
                logger.warning(f"  ⚠ 指定されたDSN '{dsn}' がtnsnames.oraに見つかりません")
        
        # Step 4: データベース接続（Thin mode）
        logger.info("[Step 4] データベース接続（Thin mode）")
        logger.info(f"  接続パラメータ: user={username}, dsn={dsn}")
        
        try:
            import time
            from datetime import datetime
            
            # 接続前の詳細情報
            logger.info(f"  接続開始時刻: {datetime.now().strftime('%Y-%m-%d %H:%M:%S.%f')}")
            logger.info(f"  環境変数 TNS_ADMIN: {os.environ.get('TNS_ADMIN')}")
            logger.info(f"  環境変数 ORACLE_CLIENT_LIB_DIR: {os.environ.get('ORACLE_CLIENT_LIB_DIR')}")
            
            start_time = time.time()
            logger.info("  >>> oracledb.connect()を呼び出し中... (Thin mode, tcp_connect_timeout: 10秒)")
            
            # Thin mode接続(Wallet使用)
            # 注: Walletのパスワードは ORACLE_26AI_CONNECTION_STRING のパスワードを使用
            connection = oracledb.connect(
                user=username,
                password=password,
                dsn=dsn,
                config_dir=wallet_location,  # Wallet場所
                wallet_location=wallet_location,  # Wallet場所
                wallet_password=password,  # Walletのパスワード
                tcp_connect_timeout=10  # TCP接続タイムアウト: 10秒
            )
            
            elapsed = time.time() - start_time
            logger.info(f"  <<< oracledb.connect()完了 ({elapsed:.2f}秒)")
            logger.info(f"  ✔ 接続成功")
            
            # Step 5: 接続テスト
            logger.info("[Step 5] 接続テスト")
            with connection.cursor() as cursor:
                cursor.execute("SELECT 1 FROM DUAL")
                result = cursor.fetchone()
                logger.info(f"  ✔ テストクエリ成功: {result}")
            
            logger.info("========== 接続作成完了 ==========")
            return connection
            
        except Exception as e:
            logger.error(f"  ✘ 接続失敗: {e}")
            logger.error(f"  エラータイプ: {type(e).__name__}")
            
            # エラー詳細を解析
            error_str = str(e)
            if "DPY-6005" in error_str or "DPY-6000" in error_str:
                logger.error("  原因: データベースが停止している可能性があります")
            elif "ORA-01017" in error_str:
                logger.error("  原因: ユーザー名またはパスワードが正しくありません")
            elif "ORA-12154" in error_str:
                logger.error("  原因: DSNが見つかりません。Walletとtnsnames.oraを確認してください")
            elif "Broken pipe" in error_str or "errno 32" in error_str.lower():
                logger.error("  原因: ネットワーク接続が切断されました")
            elif "timeout" in error_str.lower() or "timed out" in error_str.lower():
                logger.error("  原因: データベースが起動していないか、ネットワーク接続が不可です")
            
            return None
    
    def _create_connection(self, settings: Optional[Dict[str, Any]] = None, max_retries: int = 3) -> Optional[Any]:
        """データベース接続を作成（リトライ機能付き）
        
        Args:
            settings: 接続設定（Noneの場合はself.settingsを使用）
            max_retries: 最大リトライ回数
            
        Returns:
            データベース接続、または失敗時はNone
        """
        logger.info(f"_create_connection呼び出し (max_retries={max_retries})")
        
        # settingsが指定されている場合は一時的に使用
        original_settings = None
        if settings is not None:
            original_settings = self.settings
            self.settings = settings
        
        try:
            import time
            for attempt in range(1, max_retries + 1):
                logger.info(f"接続試行 {attempt}/{max_retries}")
                
                connection = self._create_connection_internal()
                if connection:
                    return connection
                
                if attempt < max_retries:
                    logger.info(f"{self.RETRY_DELAY}秒後にリトライ...")
                    time.sleep(self.RETRY_DELAY)
            
            logger.error(f"接続失敗: {max_retries}回試行後")
            return None
            
        finally:
            # settingsを元に戻す
            if original_settings is not None:
                self.settings = original_settings
    
    # 注: 接続プール管理では、接続はpool_manager.acquire_connection()の
    # コンテキストマネージャーで自動的にプールに返却されます。
    # 手動でclose()を呼ぶことはありません。
    def _release_connection(self, connection):
        """接続をクローズ（非推奨：プール外の接続のみ）
        
        警告: この関数は接続プール外で作成された接続専用です。
        プール経由の接続には使用しないでください。
        """
        if connection:
            try:
                connection.close()
                logger.debug("プール外接続をクローズしました")
            except Exception as e:
                logger.error(f"プール外接続クローズエラー: {e}")
    
    async def _release_connection_async(self, connection):
        """非同期接続をクローズ (Thin mode対応)"""
        if connection:
            try:
                # Thin modeでは非同期close()を使用
                await connection.close()
                logger.info("非同期DB接続をクローズしました")
            except Exception as e:
                logger.error(f"非同期接続クローズエラー: {e}")
    
    async def _create_connection_async(self) -> Optional[Any]:
        """非同期DB接続を作成 (Thin mode対応)
        
        Thin modeではoracledb.connect_async()が使用でき、
        真の非同期接続を実現します。
        
        Returns:
            Connectionオブジェクト、または失敗時はNone
        """
        logger.info("========== 非同期接続作成開始 (Thin mode) ===========")
        
        # Step 1: oracledbモジュール確認
        if not ORACLEDB_AVAILABLE:
            logger.error("非同期接続: oracledbモジュールが利用できません")
            return None
        
        # Step 2: 接続情報取得
        username = self.settings.get("username")
        password = self.settings.get("password")
        dsn = self.settings.get("dsn")
        
        # 設定が不完全な場合、.envから取得
        if not username or not password or not dsn:
            env_info = self.get_env_connection_info()
            if env_info.get("success"):
                username = username or env_info.get("username")
                password = password or env_info.get("password")
                dsn = dsn or env_info.get("dsn")
        
        if not username or not password or not dsn:
            logger.error("非同期接続: 接続情報が不完全です")
            return None
        
        # Step 3: Wallet場所設定
        wallet_location = self._get_wallet_location()
        logger.info(f"  wallet_location={wallet_location}")
        if not wallet_location or not os.path.exists(wallet_location):
            logger.error(f"非同期接続: Walletディレクトリが存在しません: {wallet_location}")
            return None
        
        # Step 4: 非同期接続作成 (Thin mode)
        try:
            import time
            start_time = time.time()
            logger.info(f"  >>> oracledb.connect_async()を実行中... (user={username}, dsn={dsn})")
            
            # Thin modeの真の非同期接続
            # 注: Walletのパスワードは ORACLE_26AI_CONNECTION_STRING のパスワードを使用
            connection = await oracledb.connect_async(
                user=username,
                password=password,
                dsn=dsn,
                config_dir=wallet_location,  # Wallet場所
                wallet_location=wallet_location,  # Wallet場所
                wallet_password=password,  # Walletのパスワード
                tcp_connect_timeout=10
            )
            
            elapsed = time.time() - start_time
            logger.info(f"  <<< oracledb.connect_async()完了 ({elapsed:.2f}秒)")
            logger.info("========== 非同期接続作成完了 (Thin mode) ===========")
            return connection
            
        except Exception as e:
            logger.error(f"非同期接続エラー: {e}")
            return None
    
    async def execute_query_async(self, sql: str, params: dict = None) -> Optional[List[Dict[str, Any]]]:
        """非同期でSQLクエリを実行 (Thin mode対応)
        
        注意: 現在の実装では、接続プール非対応の一時的な接続を使用します。
        将来的には非同期接続プールへの移行を検討してください。
        
        Args:
            sql: SQLクエリ
            params: バインドパラメータ
            
        Returns:
            クエリ結果のリスト、または失敗時はNone
        """
        connection = None
        try:
            # タイムアウト付きで接続作成（一時的な接続）
            connection = await asyncio.wait_for(
                self._create_connection_async(),
                timeout=10.0  # 10秒タイムアウト
            )
            
            if not connection:
                logger.error("非同期クエリ実行: 接続取得失敗")
                return None
            
            # Thin modeでは非同期カーソルを使用
            async with connection.cursor() as cursor:
                if params:
                    await cursor.execute(sql, params)
                else:
                    await cursor.execute(sql)
                
                # 結果取得
                columns = [col[0] for col in cursor.description] if cursor.description else []
                rows = await cursor.fetchall()
                
                results = []
                for row in rows:
                    results.append(dict(zip(columns, row)))
                
                return results
                
        except asyncio.TimeoutError:
            logger.error("非同期クエリ実行: 接続タイムアウト")
            return None
        except Exception as e:
            logger.error(f"非同期クエリ実行エラー: {e}")
            return None
        finally:
            # 一時的な接続なのでclose()が正しい
            if connection:
                await self._release_connection_async(connection)
    
    def _load_settings(self) -> Dict[str, Any]:
        """DB設定を.envのORACLE_26AI_CONNECTION_STRINGから読み込む
        
        形式: username/password@dsn
        """
        settings = {
            "username": None,
            "password": None,
            "dsn": None,
            "wallet_uploaded": False,
            "available_services": []
        }
        
        conn_string = os.getenv('ORACLE_26AI_CONNECTION_STRING')
        if conn_string:
            try:
                # 形式: username/password@dsn
                if '@' in conn_string and '/' in conn_string:
                    user_pass, dsn = conn_string.rsplit('@', 1)
                    if '/' in user_pass:
                        username, password = user_pass.split('/', 1)
                        settings['username'] = username
                        settings['password'] = password
                        settings['dsn'] = dsn
                        logger.info(f"DB設定を.envから読み込み: {username}@{dsn}")
            except Exception as e:
                logger.error(f"ORACLE_26AI_CONNECTION_STRINGの解析エラー: {e}")
        
        # Wallet状態を確認
        wallet_location = self._get_wallet_location()
        if wallet_location and os.path.exists(wallet_location):
            settings['wallet_uploaded'] = True
            settings['available_services'] = self._extract_dsn_from_tnsnames(wallet_location)
        
        return settings
    
    def _save_settings(self, settings: Dict[str, Any]):
        """.envファイルのORACLE_26AI_CONNECTION_STRINGを更新"""
        try:
            username = settings.get('username')
            password = settings.get('password')
            dsn = settings.get('dsn')
            
            if username and password and dsn:
                self._update_env_file_dsn(username, password, dsn)
                logger.info(f"DB設定を.envに保存: {username}@{dsn}")
            else:
                logger.warning("ユーザー名、パスワード、DSNが不完全なため保存しませんでした")
        except Exception as e:
            logger.error(f"DB設定保存エラー: {e}")
            raise
    
    def get_settings(self) -> Dict[str, Any]:
        """現在の設定を取得"""
        # パスワードをマスク
        settings = self.settings.copy()
        if settings.get("password"):
            settings["password"] = "[CONFIGURED]"
        return settings
    
    def save_settings(self, settings: Dict[str, Any]) -> bool:
        """設定を保存（.envに書き込み）"""
        try:
            # パスワードが[CONFIGURED]の場合は既存のものを保持
            if settings.get("password") == "[CONFIGURED]":
                settings["password"] = self.settings.get("password")
            
            # メモリ上の設定を更新
            self.settings.update(settings)
            
            # .envファイルに保存
            self._save_settings(self.settings)
            
            # 接続プールをクリア（設定変更時）
            self.pool_manager.close_pool()
            logger.info("設定変更により接続プールをクリアしました")
            
            return True
        except Exception as e:
            logger.error(f"設定保存エラー: {e}")
            return False
    
    def _get_wallet_location(self, create_if_missing: bool = False) -> Optional[str]:
        """Wallet場所を取得
        
        Args:
            create_if_missing: ディレクトリが存在しない場合、パスだけを返すか（True）、Noneを返すか（False）
        
        Returns:
            Walletのパス、またはNone
        """
        # TNS_ADMINは常に ORACLE_CLIENT_LIB_DIR/network/admin を使用
        lib_dir = os.getenv('ORACLE_CLIENT_LIB_DIR')
        if not lib_dir:
            # ORACLE_CLIENT_LIB_DIRが設定されていない場合は.envから読み込みを試みる
            logger.warning("ORACLE_CLIENT_LIB_DIR環境変数が設定されていません。.envファイルから読み込みを試みます...")
            try:
                from dotenv import load_dotenv
                load_dotenv()
                lib_dir = os.getenv('ORACLE_CLIENT_LIB_DIR')
                if lib_dir:
                    logger.info(f".envからORACLE_CLIENT_LIB_DIRを読み込みました: {lib_dir}")
            except ImportError:
                logger.error("python-dotenvモジュールが利用できません")
            
            if not lib_dir:
                logger.error("ORACLE_CLIENT_LIB_DIRが設定されていません")
                return None
        
        wallet_location = os.path.join(lib_dir, "network", "admin")
        
        # create_if_missing=Trueの場合は、存在しなくてもパスを返す
        if create_if_missing or os.path.exists(wallet_location):
            return wallet_location
        
        return None
    
    def upload_wallet(self, wallet_file_path: str) -> Dict[str, Any]:
        """�Walletファイルをアップロードして解凍"""
        try:
            # 優先順位に従ってウォレット場所を決定
            wallet_location = None
            
            # TNS_ADMINは常に ORACLE_CLIENT_LIB_DIR/network/admin を使用
            lib_dir = os.getenv('ORACLE_CLIENT_LIB_DIR')
            if not lib_dir:
                # ORACLE_CLIENT_LIB_DIRが設定されていない場合は.envから読み込みを試みる
                logger.warning("ORACLE_CLIENT_LIB_DIR環境変数が設定されていません。.envファイルから読み込みを試みます...")
                try:
                    from dotenv import load_dotenv
                    load_dotenv()
                    lib_dir = os.getenv('ORACLE_CLIENT_LIB_DIR')
                    if lib_dir:
                        logger.info(f".envからORACLE_CLIENT_LIB_DIRを読み込みました: {lib_dir}")
                except ImportError:
                    logger.error("python-dotenvモジュールが利用できません")
                
                if not lib_dir:
                    logger.error("ORACLE_CLIENT_LIB_DIRが設定されていません")
                    return {
                        "success": False,
                        "message": "ORACLE_CLIENT_LIB_DIR環境変数が設定されていません",
                        "available_services": []
                    }
            
            wallet_location = os.path.join(lib_dir, "network", "admin")
            
            logger.info(f"Walletアップロード先: {wallet_location}")
            
            # ディレクトリが存在する場合はバックアップ
            if os.path.exists(wallet_location):
                backup_location = wallet_location + "_backup_" + datetime.now().strftime("%Y%m%d_%H%M%S")
                shutil.move(wallet_location, backup_location)
                logger.info(f"既存Walletをバックアップ: {backup_location}")
            
            # ディレクトリ作成
            os.makedirs(wallet_location, exist_ok=True)
            
            # ZIPファイルを解凍
            with zipfile.ZipFile(wallet_file_path, 'r') as zip_ref:
                zip_ref.extractall(wallet_location)
            
            logger.info(f"Walletを解凍しました: {wallet_location}")
            
            # 不要なファイルを削除
            unnecessary_files = ['README', 'keystore.jks', 'truststore.jks', 'ojdbc.properties', 'ewallet.p12']
            for file in unnecessary_files:
                file_path = os.path.join(wallet_location, file)
                if os.path.exists(file_path):
                    try:
                        os.remove(file_path)
                        logger.info(f"不要なファイルを削除: {file}")
                    except Exception as e:
                        logger.warning(f"ファイル削除失敗: {file} - {e}")
            
            # 必須ウォレットファイルの存在確認（4つ）
            required_files = ['cwallet.sso', 'ewallet.pem', 'sqlnet.ora', 'tnsnames.ora']
            missing_files = []
            for file in required_files:
                if not os.path.exists(os.path.join(wallet_location, file)):
                    missing_files.append(file)
            
            if missing_files:
                return {
                    "success": False,
                    "message": f"必要なファイルが見つかりません: {', '.join(missing_files)}\n必須: cwallet.sso (自動ログイン), ewallet.pem (PEM形式証明書), sqlnet.ora (ネットワーク設定), tnsnames.ora (接続文字列)",
                    "available_services": []
                }
            
            logger.info("✓ すべての必須ウォレットファイルが確認されました")
            logger.info("  - cwallet.sso (自動ログイン)")
            logger.info("  - ewallet.pem (パスワード認証)")
            logger.info("  - sqlnet.ora (ネットワーク設定)")
            logger.info("  - tnsnames.ora (接続文字列)")
            
            # tnsnames.oraからDSNを抽出
            available_services = self._extract_dsn_from_tnsnames(wallet_location)
            
            # メモリ上の設定を更新（.envには保存しない、Wallet情報のみ）
            self.settings["wallet_uploaded"] = True
            self.settings["available_services"] = available_services
            
            return {
                "success": True,
                "message": f"Walletをアップロードしました",
                "wallet_location": wallet_location,
                "available_services": available_services
            }
            
        except Exception as e:
            logger.error(f"Walletアップロードエラー: {e}")
            return {
                "success": False,
                "message": f"Walletアップロードエラー: {str(e)}",
                "available_services": []
            }
    
    def _extract_dsn_from_tnsnames(self, wallet_location: str) -> List[str]:
        """�t nsnames.oraからDSNリストを抽出"""
        try:
            tnsnames_file = os.path.join(wallet_location, 'tnsnames.ora')
            if not os.path.exists(tnsnames_file):
                return []
            
            dsn_list = []
            with open(tnsnames_file, 'r', encoding='utf-8') as f:
                content = f.read()
                # DSN名を抽出（行頭の名前 = の形式）
                pattern = r'^([A-Za-z0-9_-]+)\s*='
                matches = re.findall(pattern, content, re.MULTILINE)
                dsn_list = list(set(matches))  # 重複除去
                dsn_list.sort()
            
            return dsn_list
        except Exception as e:
            logger.error(f"DSN抽出エラー: {e}")
            return []
    
    def test_connection(self, settings: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """接続テストを実行（同期版）"""
        try:
            if not ORACLEDB_AVAILABLE:
                return {
                    "success": False,
                    "message": "oracledbモジュールが利用できません。pip install oracledb を実行してください。"
                }
            
            # settingsがnoneの場合のみself.settingsを使用
            if settings is None:
                settings = self.settings
            
            username = settings.get("username")
            password = settings.get("password")
            dsn = settings.get("dsn")
            
            # 設定が不完全な場合、.envから取得を試みる
            if not username or not password or not dsn:
                logger.info(".envから接続情報を取得します...")
                env_info = self.get_env_connection_info()
                if env_info.get("success"):
                    username = username or env_info.get("username")
                    password = password or env_info.get("password")
                    dsn = dsn or env_info.get("dsn")
            
            # 同じプロセス内で直接実行
            result = _execute_db_operation(
                'test_connection',
                username=username,
                password=password,
                dsn=dsn
            )
            return result
        
        except Exception as e:
            logger.error(f"接続テストエラー: {e}")
            return {
                "success": False,
                "message": f"接続エラー: {str(e)}"
            }
    
    async def test_connection_async(self, settings: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        """接続テストを実行（非同期版 - Thin mode）
        
        Thin modeでは oracledb.connect_async() を使用し、
        真の非同期接続を実現します。
        タイムアウトは15秒以上を推奨。
        """
        CONNECTION_TIMEOUT = 15  # 接続タイムアウト: 15秒（推奨値）
        
        try:
            # settingsがnoneの場合のみself.settingsを使用
            if settings is None:
                settings = self.settings
            
            username = settings.get("username")
            password = settings.get("password")
            dsn = settings.get("dsn")
            
            # 設定が不完全な場合、.envから取得を試みる
            if not username or not password or not dsn:
                logger.info(".envから接続情報を取得します...")
                env_info = self.get_env_connection_info()
                if env_info.get("success"):
                    username = username or env_info.get("username")
                    password = password or env_info.get("password")
                    dsn = dsn or env_info.get("dsn")
            
            if not username or not password or not dsn:
                return {
                    "success": False,
                    "message": "接続情報が不完全です。ユーザー名、パスワード、DSNを設定してください。"
                }
            
            # Wallet場所設定
            wallet_location = self._get_wallet_location()
            if not wallet_location or not os.path.exists(wallet_location):
                return {
                    "success": False,
                    "message": f"Walletディレクトリが存在しません: {wallet_location}"
                }
            
            logger.info(f"接続テスト開始 (Thin mode, タイムアウト: {CONNECTION_TIMEOUT}秒)")
            logger.info(f"  user={username}, dsn={dsn}, password_len={len(password) if password else 0}")
            logger.info(f"  wallet_location={wallet_location}")
            
            try:
                import time
                start_time = time.time()
                
                # Thin modeの非同期接続をタイムアウト付きで実行
                # 注: Walletのパスワードは ORACLE_26AI_CONNECTION_STRING のパスワードを使用
                connection = await asyncio.wait_for(
                    oracledb.connect_async(
                        user=username,
                        password=password,
                        dsn=dsn,
                        config_dir=wallet_location,
                        wallet_location=wallet_location,
                        wallet_password=password,  # Walletのパスワード
                        tcp_connect_timeout=10
                    ),
                    timeout=CONNECTION_TIMEOUT
                )
                
                elapsed = time.time() - start_time
                logger.info(f"接続成功 ({elapsed:.2f}秒)")
                
                # テストクエリ実行
                async with connection.cursor() as cursor:
                    await cursor.execute("SELECT 1 FROM DUAL")
                    result = await cursor.fetchone()
                    logger.info(f"テストクエリ成功: {result}")
                
                await connection.close()
                
                return {
                    "success": True,
                    "message": "データベース接続に成功しました",
                    "details": {"status": "connected", "elapsed": f"{elapsed:.2f}s"}
                }
                
            except asyncio.TimeoutError:
                logger.error(f"接続テストがタイムアウトしました ({CONNECTION_TIMEOUT}秒)")
                return {
                    "success": False,
                    "message": f"接続テストがタイムアウトしました。データベースが起動していない可能性があります。"
                }
            except Exception as e:
                error_str = str(e)
                logger.error(f"接続エラー: {error_str}")
                
                # エラー原因を解析
                if "DPY-6005" in error_str or "DPY-6000" in error_str:
                    user_msg = "接続エラー: データベースが停止している可能性があります。ADBの起動状態を確認してください。"
                elif "ORA-01017" in error_str:
                    user_msg = "接続エラー: ユーザー名またはパスワードが正しくありません。"
                elif "ORA-12154" in error_str:
                    user_msg = "接続エラー: DSNが見つかりません。Walletとtnsnames.oraを確認してください。"
                elif "ORA-12541" in error_str:
                    user_msg = "接続エラー: データベースサーバーに接続できません。"
                elif "Broken pipe" in error_str:
                    user_msg = "接続エラー: ネットワーク接続が切断されました。"
                elif "DPY-4011" in error_str:
                    user_msg = f"接続エラー: WalletまたはTNS設定に問題があります。DSN '{dsn}' を確認してください。"
                else:
                    user_msg = f"接続エラー: {error_str}"
                
                return {
                    "success": False,
                    "message": user_msg
                }
                
        except Exception as e:
            logger.error(f"接続テストエラー（async）: {e}")
            return {
                "success": False,
                "message": f"接続エラー: {str(e)}"
            }
    
    def get_database_info(self) -> Optional[Dict[str, Any]]:
        """データベース情報を取得（接続プール経由）"""
        try:
            if not ORACLEDB_AVAILABLE:
                return None
            
            if not self._ensure_pool_initialized():
                return None
            
            with self.pool_manager.acquire_connection() as connection:
                cursor = connection.cursor()
                
                # データベースバージョン取得
                cursor.execute("SELECT * FROM v$version WHERE banner LIKE 'Oracle%'")
                version_row = cursor.fetchone()
                version = version_row[0] if version_row else None
                
                # インスタンス名取得
                cursor.execute("SELECT instance_name FROM v$instance")
                instance_row = cursor.fetchone()
                instance_name = instance_row[0] if instance_row else None
                
                # データベース名取得
                cursor.execute("SELECT name FROM v$database")
                db_row = cursor.fetchone()
                database_name = db_row[0] if db_row else None
                
                # 現在のユーザー取得
                cursor.execute("SELECT user FROM dual")
                user_row = cursor.fetchone()
                current_user = user_row[0] if user_row else None
                
                cursor.close()
                
                return {
                    "version": version,
                    "instance_name": instance_name,
                    "database_name": database_name,
                    "current_user": current_user
                }
        
        except Exception as e:
            logger.error(f"データベース情報取得エラー: {e}")
            return None
    
    def refresh_table_statistics(self) -> Dict[str, Any]:
        """全テーブルの統計情報を更新（接続プール経由）"""
        try:
            if not ORACLEDB_AVAILABLE:
                return {"success": False, "message": "Oracle DBが利用できません", "updated_count": 0}
            
            if not self._ensure_pool_initialized():
                return {"success": False, "message": "データベース接続に失敗しました", "updated_count": 0}
            
            with self.pool_manager.acquire_connection() as connection:
                cursor = connection.cursor()
                
                # '$'を含まないテーブル一覧を取得
                cursor.execute("""
                    SELECT table_name 
                    FROM user_tables 
                    WHERE table_name NOT LIKE '%$%'
                """)
                tables = cursor.fetchall()
                
                updated_count = 0
                errors = []
                
                # 各テーブルの統計情報を更新
                for (table_name,) in tables:
                    try:
                        # DBMS_STATS.GATHER_TABLE_STATSを使用して統計情報を収集
                        cursor.execute("""
                            BEGIN
                                DBMS_STATS.GATHER_TABLE_STATS(
                                    ownname => USER,
                                    tabname => :table_name,
                                    estimate_percent => DBMS_STATS.AUTO_SAMPLE_SIZE,
                                    method_opt => 'FOR ALL COLUMNS SIZE AUTO',
                                    degree => DBMS_STATS.AUTO_DEGREE,
                                    cascade => FALSE
                                );
                            END;
                        """, {'table_name': table_name})
                        updated_count += 1
                    except Exception as e:
                        logger.warning(f"テーブル {table_name} の統計情報更新に失敗: {e}")
                        errors.append(f"{table_name}: {str(e)}")
                
                connection.commit()
                cursor.close()
                
                message = f"{updated_count}件のテーブルの統計情報を更新しました"
                if errors:
                    message += f" ({len(errors)}件のエラー)"
                
                return {
                    "success": True,
                    "updated_count": updated_count,
                    "total_tables": len(tables),
                    "message": message,
                    "errors": errors
                }
        
        except Exception as e:
            logger.error(f"統計情報更新エラー: {e}")
            return {
                "success": False,
                "message": f"統計情報の更新に失敗しました: {str(e)}",
                "updated_count": 0
            }
    
    def get_tables(self, page: int = 1, page_size: int = 20) -> Dict[str, Any]:
        """テーブル一覧を取得（ページング対応、接続プール経由）"""
        try:
            if not ORACLEDB_AVAILABLE:
                return {"tables": [], "total": 0}
            
            if not self._ensure_pool_initialized():
                return {"tables": [], "total": 0}
            
            with self.pool_manager.acquire_connection() as connection:
                cursor = connection.cursor()
                
                # 総件数を取得（'$'を含むテーブルを除外）
                count_query = "SELECT COUNT(*) FROM user_tables WHERE table_name NOT LIKE '%$%'"
                cursor.execute(count_query)
                total = cursor.fetchone()[0]
                
                # ページング用の範囲計算
                start_row = (page - 1) * page_size + 1
                end_row = page * page_size
                
                # 最適化：先にページングを完了し、その後JOINを実行
                # '$'を含むテーブルを除外
                query = """
                    SELECT 
                        p.table_name,
                        p.num_rows,
                        o.created,
                        p.last_analyzed,
                        c.comments
                    FROM (
                        SELECT table_name, num_rows, last_analyzed, rn
                        FROM (
                            SELECT 
                                table_name, 
                                num_rows, 
                                last_analyzed,
                                ROW_NUMBER() OVER (ORDER BY table_name) rn
                            FROM user_tables
                            WHERE table_name NOT LIKE '%$%'
                        )
                        WHERE rn BETWEEN :start_row AND :end_row
                    ) p
                    LEFT JOIN user_objects o ON p.table_name = o.object_name AND o.object_type = 'TABLE'
                    LEFT JOIN user_tab_comments c ON p.table_name = c.table_name
                    ORDER BY p.rn
                """
                
                cursor.execute(query, {"start_row": start_row, "end_row": end_row})
                rows = cursor.fetchall()
                
                tables = []
                for row in rows:
                    table_info = {
                        "table_name": row[0],
                        "num_rows": row[1],
                        "created": row[2].isoformat() if row[2] else None,
                        "last_analyzed": row[3].isoformat() if row[3] else None,
                        "comments": row[4]
                    }
                    tables.append(table_info)
                
                cursor.close()
                
                return {"tables": tables, "total": total}
        
        except Exception as e:
            logger.error(f"テーブル一覧取得エラー: {e}")
            return {"tables": [], "total": 0}
    
    def get_table_data(self, table_name: str, page: int = 1, page_size: int = 20) -> Dict[str, Any]:
        """テーブルデータを取得（ページング対応、接続プール経由）"""
        try:
            if not ORACLEDB_AVAILABLE:
                return {"success": False, "rows": [], "columns": [], "total": 0, "message": "Oracle DBが利用できません"}
            
            # テーブル名のバリデーション（SQLインジェクション防止）
            if not table_name.isidentifier() and not table_name.replace('_', '').replace('$', '').isalnum():
                return {"success": False, "rows": [], "columns": [], "total": 0, "message": "無効なテーブル名です"}
            
            if not self._ensure_pool_initialized():
                return {"success": False, "rows": [], "columns": [], "total": 0, "message": "データベース接続に失敗しました"}
            
            with self.pool_manager.acquire_connection() as connection:
                cursor = connection.cursor()
                
                # 総件数を取得
                count_query = f'SELECT COUNT(*) FROM "{table_name}"'
                cursor.execute(count_query)
                total = cursor.fetchone()[0]
                
                # ページング用の範囲計算
                start_row = (page - 1) * page_size + 1
                end_row = page * page_size
                
                # データ取得（ページング対応）
                query = f'''
                    SELECT * FROM (
                        SELECT t.*, ROW_NUMBER() OVER (ORDER BY ROWID) as rn
                        FROM "{table_name}" t
                    )
                    WHERE rn BETWEEN :start_row AND :end_row
                '''
                
                cursor.execute(query, {"start_row": start_row, "end_row": end_row})
                
                # カラム名を取得
                columns = [desc[0] for desc in cursor.description if desc[0] != 'RN']
                
                # データを取得
                rows = []
                for row in cursor.fetchall():
                    # 最後のRN列を除外
                    row_data = []
                    for i, value in enumerate(row[:-1]):  # RN列を除く
                        # データ型に応じて変換
                        if value is None:
                            row_data.append(None)
                        elif isinstance(value, (int, float)):
                            row_data.append(value)
                        elif isinstance(value, datetime):
                            row_data.append(value.isoformat())
                        elif isinstance(value, bytes):
                            # BLOBデータは最初の100文字のみASCIIで表示
                            try:
                                ascii_repr = value[:100].decode('ascii', errors='ignore')
                                if len(value) > 100:
                                    row_data.append(f"{ascii_repr}...")
                                else:
                                    row_data.append(ascii_repr if ascii_repr else f"<BLOB: {len(value)} bytes>")
                            except:
                                row_data.append(f"<BLOB: {len(value)} bytes>")
                        elif hasattr(value, 'read'):
                            # LOBオブジェクト（CLOB, BLOB等）
                            try:
                                lob_data = value.read()
                                if isinstance(lob_data, bytes):
                                    row_data.append(f"<LOB: {len(lob_data)} bytes>")
                                else:
                                    # CLOBの場合、最初の100文字のみ表示
                                    lob_str = str(lob_data)
                                    if len(lob_str) > 100:
                                        row_data.append(lob_str[:100] + "...")
                                    else:
                                        row_data.append(lob_str)
                            except Exception as lob_err:
                                row_data.append(f"<LOB: 読み取りエラー>")
                                logger.warning(f"LOB読み取りエラー: {lob_err}")
                        else:
                            # その他の型は文字列に変換
                            try:
                                str_value = str(value)
                                # 長すぎる文字列は切り詰め
                                if len(str_value) > 1000:
                                    row_data.append(str_value[:1000] + "...")
                                else:
                                    row_data.append(str_value)
                            except Exception as str_err:
                                row_data.append(f"<変換エラー: {type(value).__name__}>")
                                logger.warning(f"文字列変換エラー: {str_err}")
                    rows.append(row_data)
                
                cursor.close()
                
                return {
                    "success": True,
                    "rows": rows,
                    "columns": columns,
                    "total": total,
                    "message": "データ取得成功"
                }
        
        except Exception as e:
            logger.error(f"テーブルデータ取得エラー: {e}")
            return {"success": False, "rows": [], "columns": [], "total": 0, "message": str(e)}
    
    def delete_tables(self, table_names: list) -> Dict[str, Any]:
        """テーブルを一括削除（接続プール経由）"""
        deleted_count = 0
        errors = []
        
        try:
            if not ORACLEDB_AVAILABLE:
                return {"success": False, "deleted_count": 0, "message": "Oracle DBが利用できません", "errors": []}
            
            if not table_names:
                return {"success": False, "deleted_count": 0, "message": "削除するテーブルが指定されていません", "errors": []}
            
            # 接続プールの初期化を確認
            if not self._ensure_pool_initialized():
                return {"success": False, "deleted_count": 0, "message": "データベース接続に失敗しました", "errors": []}
            
            with self.pool_manager.acquire_connection() as connection:
                cursor = connection.cursor()
                
                for table_name in table_names:
                    try:
                        # テーブル名のバリデーション（SQLインジェクション防止）
                        if not table_name.isidentifier() and not table_name.replace('_', '').replace('$', '').isalnum():
                            errors.append(f"無効なテーブル名: {table_name}")
                            continue
                        
                        # DROP TABLE文を実行
                        cursor.execute(f'DROP TABLE "{table_name}" CASCADE CONSTRAINTS PURGE')
                        deleted_count += 1
                        logger.info(f"テーブル削除成功: {table_name}")
                        
                    except Exception as e:
                        error_msg = f"{table_name}: {str(e)}"
                        errors.append(error_msg)
                        logger.error(f"テーブル削除エラー: {error_msg}")
                
                # コミット
                connection.commit()
                cursor.close()
            
            return {
                "success": deleted_count > 0,
                "deleted_count": deleted_count,
                "message": f"{deleted_count}件のテーブルを削除しました" if deleted_count > 0 else "削除に失敗しました",
                "errors": errors
            }
        
        except Exception as e:
            logger.error(f"テーブル一括削除エラー: {e}")
            return {"success": False, "deleted_count": 0, "message": str(e), "errors": errors}
    
    def delete_file_info_records(self, file_ids: list) -> Dict[str, Any]:
        """FILE_INFOテーブルのレコードを一括削除（接続プール経由、関連するIMG_EMBEDDINGSも自動削除）"""
        deleted_count = 0
        errors = []
        
        try:
            logger.info(f"delete_file_info_records開始: file_ids={file_ids}")
            
            if not ORACLEDB_AVAILABLE:
                logger.error("Oracle DBが利用できません")
                return {"success": False, "deleted_count": 0, "message": "Oracle DBが利用できません", "errors": []}
            
            if not file_ids:
                logger.warning("削除するレコードが指定されていません")
                return {"success": False, "deleted_count": 0, "message": "削除するレコードが指定されていません", "errors": []}
            
            # 接続プールの初期化を確認
            if not self._ensure_pool_initialized():
                logger.error("データベース接続に失敗しました")
                return {"success": False, "deleted_count": 0, "message": "データベース接続に失敗しました", "errors": []}
            
            logger.info(f"DB接続プールから接続取得中...")
            with self.pool_manager.acquire_connection() as connection:
                logger.info(f"DB接続成功")
                cursor = connection.cursor()
                
                for file_id in file_ids:
                    try:
                        logger.info(f"FILE_ID処理中: {file_id} (type={type(file_id).__name__})")
                        
                        # FILE_IDのバリデーション
                        file_id_int = int(file_id)
                        
                        # 削除前にレコードの存在を確認
                        cursor.execute('SELECT FILE_ID, BUCKET, OBJECT_NAME FROM FILE_INFO WHERE FILE_ID = :file_id', {'file_id': file_id_int})
                        existing_record = cursor.fetchone()
                        if existing_record:
                            logger.info(f"削除対象レコード発見: FILE_ID={existing_record[0]}")
                        else:
                            logger.warning(f"削除対象レコードが見つかりません: FILE_ID={file_id_int}")
                        
                        # DELETE文を実行（CASCADE制約によりIMG_EMBEDDINGSも自動削除）
                        cursor.execute('DELETE FROM FILE_INFO WHERE FILE_ID = :file_id', {'file_id': file_id_int})
                        
                        row_count = cursor.rowcount
                        if row_count > 0:
                            deleted_count += 1
                            logger.info(f"FILE_INFOレコード削除成功: FILE_ID={file_id_int}")
                        else:
                            errors.append(f"FILE_ID={file_id_int}: レコードが見つかりません")
                            logger.warning(f"FILE_INFOレコードが見つかりません: FILE_ID={file_id_int}")
                        
                    except ValueError as ve:
                        error_msg = f"無効なFILE_ID: {file_id}"
                        errors.append(error_msg)
                        logger.error(f"FILE_ID変換エラー: {error_msg}, exception={ve}")
                    except Exception as e:
                        error_msg = f"FILE_ID={file_id}: {str(e)}"
                        errors.append(error_msg)
                        logger.error(f"FILE_INFOレコード削除エラー: {error_msg}", exc_info=True)
                
                # コミット
                logger.info(f"COMMIT実行中... deleted_count={deleted_count}")
                connection.commit()
                logger.info(f"COMMIT成功")
                cursor.close()
            
            result = {
                "success": deleted_count > 0,
                "deleted_count": deleted_count,
                "message": f"{deleted_count}件のレコードを削除しました" if deleted_count > 0 else "削除に失敗しました",
                "errors": errors
            }
            logger.info(f"delete_file_info_records結果: {result}")
            return result
        
        except Exception as e:
            logger.error(f"FILE_INFOレコード一括削除エラー: {e}", exc_info=True)
            return {"success": False, "deleted_count": 0, "message": str(e), "errors": errors}
    
    def delete_table_data(self, table_name: str, primary_keys: list) -> Dict[str, Any]:
        """
        任意のテーブルから主キーを指定してレコードを削除（接続プール経由、汎用的）
        
        Args:
            table_name: テーブル名
            primary_keys: 削除するレコードの主キー値リスト
        
        Returns:
            Dict: {"success": bool, "deleted_count": int, "message": str, "errors": List[str]}
        """
        deleted_count = 0
        errors = []
        
        try:
            if not ORACLEDB_AVAILABLE:
                return {"success": False, "deleted_count": 0, "message": "Oracle DBが利用できません", "errors": []}
            
            if not primary_keys:
                return {"success": False, "deleted_count": 0, "message": "削除するレコードが指定されていません", "errors": []}
            
            # テーブル名のバリデーション（SQLインジェクション防止）
            if not table_name.replace('_', '').isalnum():
                return {"success": False, "deleted_count": 0, "message": f"無効なテーブル名: {table_name}", "errors": []}
            
            # 接続プールの初期化を確認
            if not self._ensure_pool_initialized():
                return {"success": False, "deleted_count": 0, "message": "データベース接続に失敗しました", "errors": []}
            
            with self.pool_manager.acquire_connection() as connection:
                cursor = connection.cursor()
                
                # テーブルの主キー列を取得
                cursor.execute("""
                    SELECT cols.column_name
                    FROM all_constraints cons
                    JOIN all_cons_columns cols ON cons.constraint_name = cols.constraint_name
                    WHERE cons.constraint_type = 'P'
                    AND cons.table_name = :table_name
                    AND cons.owner = USER
                    ORDER BY cols.position
                """, {'table_name': table_name.upper()})
                
                pk_columns = [row[0] for row in cursor.fetchall()]
                
                if not pk_columns:
                    cursor.close()
                    return {"success": False, "deleted_count": 0, "message": f"テーブル {table_name} に主キーが見つかりません", "errors": []}
                
                logger.info(f"テーブル {table_name} の主キー列: {pk_columns}")
                
                # 各レコードを削除
                for pk_value in primary_keys:
                    try:
                        # 主キーが1列の場合のみDELETE実行（複合主キーはサポートしない）
                        if len(pk_columns) == 1:
                            pk_column = pk_columns[0]
                            delete_sql = f'DELETE FROM "{table_name}" WHERE "{pk_column}" = :pk_value'
                            cursor.execute(delete_sql, {'pk_value': pk_value})
                            
                            row_count = cursor.rowcount
                            if row_count > 0:
                                deleted_count += row_count
                                logger.info(f"レコード削除成功: {table_name}.{pk_column}={pk_value}, deleted={row_count}")
                            else:
                                errors.append(f"{pk_column}={pk_value}: レコードが見つかりません")
                                logger.warning(f"レコードが見つかりません: {table_name}.{pk_column}={pk_value}")
                        else:
                            errors.append(f"{pk_value}: 複合主キーはサポートされていません")
                            logger.warning(f"複合主キーはサポートされていません: {table_name}, pk_columns={pk_columns}")
                            
                    except Exception as e:
                        error_msg = f"{pk_value}: {str(e)}"
                        errors.append(error_msg)
                        logger.error(f"レコード削除エラー: {error_msg}", exc_info=True)
                
                # コミット
                connection.commit()
                cursor.close()
            
            result = {
                "success": deleted_count > 0,
                "deleted_count": deleted_count,
                "message": f"{deleted_count}件のレコードを削除しました" if deleted_count > 0 else "削除に失敗しました",
                "errors": errors
            }
            logger.info(f"delete_table_data結果: {result}")
            return result
        
        except Exception as e:
            logger.error(f"テーブルデータ削除エラー: {e}", exc_info=True)
            return {"success": False, "deleted_count": 0, "message": str(e), "errors": errors}
    
    def get_env_connection_info(self) -> Dict[str, Any]:
        """環境変数からDB接続情報を取得、Wallet未設定時はADB_OCIDから自動ダウンロード"""
        try:
            # ORACLE_26AI_CONNECTION_STRINGから解析
            conn_str = os.getenv('ORACLE_26AI_CONNECTION_STRING', '')
            
            if not conn_str:
                return {
                    "success": False,
                    "message": "ORACLE_26AI_CONNECTION_STRING環境変数が設定されていません",
                    "username": None,
                    "dsn": None,
                    "wallet_exists": False,
                    "available_services": []
                }
            
            # 接続文字列を解析: username/password@dsn
            pattern = r'^([^/]+)/([^@]+)@(.+)$'
            match = re.match(pattern, conn_str)
            
            if not match:
                return {
                    "success": False,
                    "message": "接続文字列の形式が正しくありません。形式: username/password@dsn",
                    "username": None,
                    "dsn": None,
                    "wallet_exists": False,
                    "available_services": []
                }
            
            username = match.group(1)
            password = match.group(2)
            dsn = match.group(3)
            
            # Walletの存在確認
            wallet_location = self._get_wallet_location()
            wallet_exists = False
            available_services = []
            
            if wallet_location and os.path.exists(wallet_location):
                # 必要なファイルの確認
                required_files = ['cwallet.sso', 'tnsnames.ora', 'sqlnet.ora']
                all_exist = all(os.path.exists(os.path.join(wallet_location, f)) for f in required_files)
                
                if all_exist:
                    wallet_exists = True
                    # tnsnames.oraからDSNを抽出
                    available_services = self._extract_dsn_from_tnsnames(wallet_location)
            
            # Walletが未設定の場合、ADB_OCIDからダウンロードを試みる
            download_error = None
            if not wallet_exists:
                adb_ocid = os.getenv('ADB_OCID')
                if adb_ocid:
                    logger.info(f"Wallet未設定のため、ADB_OCIDからダウンロードを試みます: {adb_ocid}")
                    download_result = self._download_wallet_from_adb(adb_ocid, password)
                    
                    if download_result.get('success'):
                        wallet_exists = True
                        available_services = download_result.get('available_services', [])
                        # Walletロケーションを再取得
                        wallet_location = self._get_wallet_location()
                        logger.info(f"Walletダウンロード成功、利用可能なサービス: {len(available_services)}件")
                    else:
                        download_error = download_result.get('message')
                        logger.warning(f"ADB_OCIDからのWalletダウンロードに失敗: {download_error}")
                else:
                    download_error = "ADB_OCID環境変数が設定されていません"
            
            return {
                "success": True,
                "message": "環境変数から接続情報を取得しました",
                "username": username,
                "password": password,  # フロントエンドでは表示しない
                "dsn": dsn,
                "wallet_exists": wallet_exists,
                "wallet_location": wallet_location if wallet_exists else None,
                "available_services": available_services,
                "download_error": download_error  # ダウンロードエラー情報を追加
            }
            
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
    
    def _download_wallet_from_adb(self, adb_ocid: str, password: str) -> Dict[str, Any]:
        """
        ADB_OCIDからWalletをダウンロードして展開
        
        Args:
            adb_ocid: Autonomous Database OCID
            password: Walletのパスワード
        
        Returns:
            Dict: {"success": bool, "message": str, "available_services": List[str]}
        """
        try:
            import oci
            from app.services.oci_service import oci_service
            import tempfile
            
            # OCI設定を取得
            config = oci_service.get_oci_config()
            if not config:
                return {
                    "success": False,
                    "message": "OCI設定が見つかりません",
                    "available_services": []
                }
            
            # Database ClientはOCI_REGION_DEPLOYを使用（ADBと同じリージョン）
            deploy_region = os.environ.get("OCI_REGION_DEPLOY")
            if deploy_region:
                # 設定をコピーしてregionを上書き
                db_config = config.copy()
                db_config["region"] = deploy_region
                logger.info(f"Database ClientをOCI_REGION_DEPLOYで作成: {deploy_region}")
            else:
                # OCI_REGION_DEPLOYがない場合はデフォルトregionを使用
                logger.warning("OCI_REGION_DEPLOYが設定されていません。OCI_REGIONを使用します")
                db_config = config
            
            # Database Clientを作成
            db_client = oci.database.DatabaseClient(db_config)
            
            logger.info(f"ADB Walletをダウンロード中: {adb_ocid} (リージョン: {db_config['region']})")
            
            # Walletをダウンロード
            wallet_details = oci.database.models.GenerateAutonomousDatabaseWalletDetails(
                password=password
            )
            
            wallet_response = db_client.generate_autonomous_database_wallet(
                autonomous_database_id=adb_ocid,
                generate_autonomous_database_wallet_details=wallet_details
            )
            
            # Walletを一時ファイルに保存
            temp_wallet_file = tempfile.NamedTemporaryFile(delete=False, suffix='.zip')
            with open(temp_wallet_file.name, 'wb') as f:
                for chunk in wallet_response.data.raw.stream(1024 * 1024, decode_content=False):
                    f.write(chunk)
            
            logger.info(f"Walletダウンロード完了: {temp_wallet_file.name}")
            
            # Walletを展開（ディレクトリが存在しなくてもパスを取得）
            wallet_location = self._get_wallet_location(create_if_missing=True)
            if not wallet_location:
                return {
                    "success": False,
                    "message": "Wallet保存先が設定されていません（ORACLE_CLIENT_LIB_DIR環境変数が未設定）",
                    "available_services": []
                }
            
            # ディレクトリが存在する場合はバックアップ
            if os.path.exists(wallet_location):
                backup_location = wallet_location + "_backup_" + datetime.now().strftime("%Y%m%d_%H%M%S")
                shutil.move(wallet_location, backup_location)
                logger.info(f"既存Walletをバックアップ: {backup_location}")
            
            # ディレクトリ作成
            os.makedirs(wallet_location, exist_ok=True)
            
            # ZIPファイルを展開
            with zipfile.ZipFile(temp_wallet_file.name, 'r') as zip_ref:
                zip_ref.extractall(wallet_location)
            
            logger.info(f"Walletを展開しました: {wallet_location}")
            
            # 不要なファイルを削除
            unnecessary_files = ['README', 'keystore.jks', 'truststore.jks', 'ojdbc.properties', 'ewallet.p12']
            for file in unnecessary_files:
                file_path = os.path.join(wallet_location, file)
                if os.path.exists(file_path):
                    try:
                        os.remove(file_path)
                        logger.info(f"不要なファイルを削除: {file}")
                    except Exception as e:
                        logger.warning(f"ファイル削除失敗: {file} - {e}")
            
            # 一時ファイルを削除
            os.unlink(temp_wallet_file.name)
            
            # 必要なファイルの存在確認
            required_files = ['cwallet.sso', 'ewallet.pem', 'tnsnames.ora', 'sqlnet.ora']
            missing_files = []
            for file in required_files:
                if not os.path.exists(os.path.join(wallet_location, file)):
                    missing_files.append(file)
            
            if missing_files:
                return {
                    "success": False,
                    "message": f"必要なファイルが見つかりません: {', '.join(missing_files)}",
                    "available_services": []
                }
            
            # tnsnames.oraからDSNを抽出
            available_services = self._extract_dsn_from_tnsnames(wallet_location)
            
            return {
                "success": True,
                "message": "Walletをダウンロードしました",
                "available_services": available_services
            }
            
        except Exception as e:
            logger.error(f"Walletダウンロードエラー: {e}")
            return {
                "success": False,
                "message": f"Walletダウンロードエラー: {str(e)}",
                "available_services": []
            }
    
    def _update_env_file_dsn(self, username: str, password: str, dsn: str) -> bool:
        """
        .envファイルのORACLE_26AI_CONNECTION_STRINGを更新
        
        Args:
            username: ユーザー名
            password: パスワード
            dsn: DSN
        
        Returns:
            bool: 成功したかどうか
        """
        try:
            # .envファイルパス
            env_file_path = Path('.env')
            
            if not env_file_path.exists():
                logger.warning(".envファイルが見つかりません")
                return False
            
            # 現在の.envファイルを読み込む
            with open(env_file_path, 'r', encoding='utf-8') as f:
                lines = f.readlines()
            
            # 新しい接続文字列
            new_conn_str = f"{username}/{password}@{dsn}"
            
            # ORACLE_26AI_CONNECTION_STRINGを更新
            updated = False
            new_lines = []
            for line in lines:
                if line.startswith('ORACLE_26AI_CONNECTION_STRING='):
                    new_lines.append(f"ORACLE_26AI_CONNECTION_STRING={new_conn_str}\n")
                    updated = True
                    logger.info(f"ORACLE_26AI_CONNECTION_STRINGを更新: {username}/*****@{dsn}")
                else:
                    new_lines.append(line)
            
            # ファイルを書き込む
            if updated:
                with open(env_file_path, 'w', encoding='utf-8') as f:
                    f.writelines(new_lines)
                
                # 環境変数を更新
                os.environ['ORACLE_26AI_CONNECTION_STRING'] = new_conn_str
                
                logger.info(".envファイルを更新しました")
                return True
            else:
                logger.warning("ORACLE_26AI_CONNECTION_STRINGが.envファイルに見つかりません")
                return False
                
        except Exception as e:
            logger.error(f".envファイル更新エラー: {e}")
            return False
    
    def is_connected(self) -> bool:
        """接続状態を確認（接続プール経由、既存メソッドの再利用）"""
        # クラス内に既に接続プール経由のチェックメソッドがあるため、再利用
        # (line 329-350の is_connected メソッドと重複)
        if not ORACLEDB_AVAILABLE:
            return False
        
        try:
            if not self._ensure_pool_initialized():
                logger.debug("接続状態チェック: プール未初期化")
                return False
            
            # 簡単なクエリでテスト
            with self.pool_manager.acquire_connection() as connection:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT 1 FROM DUAL")
                    cursor.fetchone()
            
            logger.debug("接続状態チェック: 接続有効")
            return True
        except Exception as e:
            logger.warning(f"接続状態チェック: 接続無効 - {e}")
            return False
    
    def get_storage_info(self) -> Optional[Dict[str, Any]]:
        """データベースストレージ情報を取得（接続プール経由）"""
        try:
            if not ORACLEDB_AVAILABLE:
                return None
            
            # 接続プールの初期化を確認
            if not self._ensure_pool_initialized():
                return None
            
            with self.pool_manager.acquire_connection() as connection:
                cursor = connection.cursor()
                
                # テーブルスペース情報を取得
                query = """
                    SELECT 
                        tablespace_name,
                        ROUND(NVL(SUM(bytes), 0) / 1024 / 1024, 2) AS total_size_mb,
                        status
                    FROM dba_data_files
                    GROUP BY tablespace_name, status
                    ORDER BY tablespace_name
                """
                
                cursor.execute(query)
                rows = cursor.fetchall()
                
                tablespaces = []
                total_size_mb = 0.0
                used_size_mb = 0.0
                
                for row in rows:
                    tablespace_name = row[0]
                    size_mb = float(row[1]) if row[1] else 0.0
                    status = row[2]
                    
                    # 使用済みサイズを取得
                    used_query = """
                        SELECT 
                            ROUND(NVL(SUM(bytes), 0) / 1024 / 1024, 2) AS used_size_mb
                        FROM dba_segments
                        WHERE tablespace_name = :tablespace_name
                    """
                    cursor.execute(used_query, {'tablespace_name': tablespace_name})
                    used_row = cursor.fetchone()
                    used_mb = float(used_row[0]) if used_row and used_row[0] else 0.0
                    
                    free_mb = size_mb - used_mb
                    used_percent = (used_mb / size_mb * 100) if size_mb > 0 else 0.0
                    
                    tablespaces.append({
                        'tablespace_name': tablespace_name,
                        'total_size_mb': size_mb,
                        'used_size_mb': used_mb,
                        'free_size_mb': free_mb,
                        'used_percent': used_percent,
                        'status': status
                    })
                    
                    total_size_mb += size_mb
                    used_size_mb += used_mb
                
                cursor.close()
            
            free_size_mb = total_size_mb - used_size_mb
            used_percent = (used_size_mb / total_size_mb * 100) if total_size_mb > 0 else 0.0
            
            return {
                'tablespaces': tablespaces,
                'total_size_mb': total_size_mb,
                'used_size_mb': used_size_mb,
                'free_size_mb': free_size_mb,
                'used_percent': used_percent
            }
        
        except Exception as e:
            logger.error(f"ストレージ情報取得エラー: {e}")
            return None


    def shutdown(self):
        """データベースサービスのシャットダウン処理"""
        logger.info("DatabaseServiceをシャットダウン中...")
        
        try:
            # 接続プールのクローズ
            if hasattr(self, 'pool_manager') and self.pool_manager:
                logger.info("データベース接続プールをクローズ中...")
                self.pool_manager.close_pool(timeout=30, force=True)  # 30秒タイムアウト、強制モード
                logger.info("データベース接続プールをクローズしました")
        except Exception as e:
            logger.error(f"データベースサービスシャットダウンエラー: {e}")
        
        logger.info("DatabaseServiceシャットダウン完了")


# グローバルインスタンス
database_service = DatabaseService()
