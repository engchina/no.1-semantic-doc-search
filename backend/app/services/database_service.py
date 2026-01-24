"""  
データベース管理サービス
Oracle Database接続とクエリ実行を管理
"""
import logging
import json
import os
import zipfile
import shutil
import asyncio
from pathlib import Path
from typing import Optional, Dict, Any, List
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor  # 必要に応じて使用
from functools import partial

logger = logging.getLogger(__name__)

def setup_tns_admin() -> str:
    """
    Setup TNS_ADMIN environment variable if not already set
    
    Returns:
        str: TNS_ADMIN path
    """
    if not os.environ.get('TNS_ADMIN'):
        lib_dir = os.environ.get('ORACLE_CLIENT_LIB_DIR')
        if not lib_dir:
            # Try to find valid instant client path
            candidates = [
                '/u01/aipoc/instantclient_23_8',
                '/u01/aipoc/instantclient_23_9',
                '/u01/aipoc/instantclient_23_26'
            ]
            for path in candidates:
                if os.path.exists(path):
                    lib_dir = path
                    break
            
            # Fallback to default if not found
            if not lib_dir:
                lib_dir = '/u01/aipoc/instantclient_23_26'

        wallet_location = os.path.join(lib_dir, "network", "admin")
        os.environ['TNS_ADMIN'] = wallet_location
        logger.info(f"Set TNS_ADMIN to: {wallet_location}")
    
    return os.environ.get('TNS_ADMIN')

# 設定ファイルパス
STORAGE_PATH = Path(os.getenv("STORAGE_PATH", "./storage"))
DB_SETTINGS_FILE = STORAGE_PATH / "metadata" / "db_settings.json"

# oracledbモジュールのインポート（オプション）
try:
    import oracledb
    import platform
    ORACLEDB_AVAILABLE = True
    
    # Linux の場合、Oracle Client ライブラリを初期化
    _oracle_client_initialized = False
except ImportError:
    logger.warning("oracledb モジュールが利用できません。pip install oracledb を実行してください。")
    ORACLEDB_AVAILABLE = False
    _oracle_client_initialized = False


def init_oracle_client():
    """
    Initialize Oracle Client library (Linux only, one-time initialization)
    """
    global _oracle_client_initialized
    
    if _oracle_client_initialized:
        return True
    
    if not ORACLEDB_AVAILABLE:
        return False
    
    try:
        if platform.system() == 'Linux':
            lib_dir = os.environ.get('ORACLE_CLIENT_LIB_DIR')
            if lib_dir and os.path.exists(lib_dir):
                logger.info(f"Initializing Oracle Client with lib_dir: {lib_dir}")
                oracledb.init_oracle_client(lib_dir=lib_dir)
                _oracle_client_initialized = True
                logger.info("Oracle Client initialized successfully")
            else:
                logger.warning(f"ORACLE_CLIENT_LIB_DIR not set or does not exist: {lib_dir}")
        else:
            _oracle_client_initialized = True  # Non-Linux doesn't need init
        return True
    except Exception as e:
        logger.error(f"Failed to initialize Oracle Client: {e}")
        return False


def _execute_db_operation(func_name: str, **kwargs) -> Dict[str, Any]:
    """
    Execute database operation in thread pool
    
    Args:
        func_name: Name of the operation ('test_connection')
        **kwargs: Arguments for the operation (username, password, dsn)
        
    Returns:
        Dict with operation result
    """
    import re
    
    def log_info(msg):
        """ログ出力（logger と print 両方）"""
        logger.info(msg)
        print(msg, flush=True)
    
    def log_error(msg):
        """エラーログ出力（logger と print 両方）"""
        logger.error(msg)
        print(f"ERROR: {msg}", flush=True)
    
    if not ORACLEDB_AVAILABLE:
        return {
            'success': False,
            'message': 'oracledbモジュールがインストールされていません'
        }

    try:
        log_info(f"========== 接続テスト開始 ==========")
        log_info(f"Executing {func_name}")
        log_info(f"kwargs username: {kwargs.get('username')}")
        log_info(f"kwargs password exists: {bool(kwargs.get('password'))}")
        log_info(f"kwargs dsn: {kwargs.get('dsn')}")
        
        # Oracle Client 初期化（Linuxのみ、一度だけ）
        if not init_oracle_client():
            return {
                'success': False,
                'message': 'Oracle Clientの初期化に失敗しました'
            }
        
        # Setup environment
        tns_admin = setup_tns_admin()
        log_info(f"TNS_ADMIN set to: {tns_admin}")
        
        # Wallet ディレクトリの確認
        if tns_admin:
            log_info(f"TNS_ADMIN exists: {os.path.exists(tns_admin)}")
            if os.path.exists(tns_admin):
                files = os.listdir(tns_admin)
                log_info(f"Wallet files: {files}")
                # tnsnames.ora の内容確認
                tnsnames_path = os.path.join(tns_admin, 'tnsnames.ora')
                if os.path.exists(tnsnames_path):
                    with open(tnsnames_path, 'r') as f:
                        content = f.read()
                    # サービス名を抽出
                    services = re.findall(r'^(\w+)\s*=', content, re.MULTILINE)
                    log_info(f"Available services in tnsnames.ora: {services}")
                else:
                    log_error(f"tnsnames.ora not found at: {tnsnames_path}")
            else:
                log_error(f"TNS_ADMIN directory does not exist: {tns_admin}")
        else:
            log_error("TNS_ADMIN is None!")
        
        if func_name == 'test_connection':
            # Get connection parameters
            username = kwargs.get('username')
            password = kwargs.get('password')
            dsn = kwargs.get('dsn')
            
            if not username or not password or not dsn:
                log_error(f"Missing credentials - username: {bool(username)}, password: {bool(password)}, dsn: {bool(dsn)}")
                return {
                    'success': False,
                    'message': 'ユーザー名、パスワード、DSNが必要です'
                }
            
            log_info(f"Connecting to: username={username}, dsn={dsn}")
            log_info(f"Using config_dir: {tns_admin}")
            log_info(f"oracledb version: {oracledb.__version__}")
            
            # Connect to database with config_dir for Wallet support
            connection = oracledb.connect(
                user=username,
                password=password,
                dsn=dsn,
                config_dir=tns_admin
            )
            
            log_info(f"Connection established")
            
            # Execute test query
            cursor = connection.cursor()
            cursor.execute("SELECT 'OK' FROM DUAL")
            result = cursor.fetchone()
            cursor.close()
            connection.close()
            
            log_info(f"Test query executed successfully")
            
            if result and result[0] == 'OK':
                return {
                    'success': True,
                    'message': 'データベース接続に成功しました',
                    'details': {'status': 'connected'}
                }
            else:
                return {
                    'success': False,
                    'message': '接続テストが失敗しました'
                }
        
        return {
            'success': False,
            'message': f'不明な操作: {func_name}'
        }
        
    except Exception as e:
        error_msg = str(e)
        log_error(f"Database operation error: {error_msg}")
        import traceback
        log_error(f"Traceback: {traceback.format_exc()}")
        return {
            'success': False,
            'message': f'接続エラー: {error_msg}'
        }


class DatabaseService:
    """データベース管理サービス（単例モード）"""
    _instance = None
    _pool = None
    _pool_lock = None
    _initialized = False
    
    def __new__(cls):
        """単例モードの実装"""
        if cls._instance is None:
            cls._instance = super(DatabaseService, cls).__new__(cls)
        return cls._instance
    
    def __init__(self):
        """初期化（一度だけ実行）"""
        if not self.__class__._initialized:
            import threading
            self.connection = None
            self.settings = self._load_settings()
            self.__class__._pool_lock = threading.Lock()
            self.__class__._initialized = True
            logger.info("DatabaseService単例モードで初期化しました")
    
    def _load_settings(self) -> Dict[str, Any]:
        """DB設定をファイルから読み込む"""
        if DB_SETTINGS_FILE.exists():
            try:
                with open(DB_SETTINGS_FILE, 'r', encoding='utf-8') as f:
                    return json.load(f)
            except Exception as e:
                logger.error(f"DB設定読み込みエラー: {e}")
        
        return {
            "username": None,
            "password": None,
            "dsn": None,
            "wallet_uploaded": False,
            "available_services": []
        }
    
    def _save_settings(self, settings: Dict[str, Any]):
        """DB設定をファイルに保存"""
        try:
            DB_SETTINGS_FILE.parent.mkdir(parents=True, exist_ok=True)
            with open(DB_SETTINGS_FILE, 'w', encoding='utf-8') as f:
                json.dump(settings, f, ensure_ascii=False, indent=2)
            logger.info("DB設定を保存しました")
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
        """設定を保存"""
        try:
            # パスワードが[CONFIGURED]の場合は既存のものを保持
            if settings.get("password") == "[CONFIGURED]":
                settings["password"] = self.settings.get("password")
            
            self.settings = settings
            self._save_settings(settings)
            
            # 既存の接続とプールをクローズ（設定変更時）
            if self.connection:
                try:
                    self.connection.close()
                except:
                    pass
                self.connection = None
            
            # プールを無効化（次回再作成）
            with self.__class__._pool_lock:
                if self.__class__._pool:
                    try:
                        self.__class__._pool.close()
                        logger.info("設定変更により接続プールをクローズしました")
                    except Exception as e:
                        logger.warning(f"プールクローズエラー: {e}")
                    self.__class__._pool = None
            
            return True
        except Exception as e:
            logger.error(f"設定保存エラー: {e}")
            return False
    
    def _get_wallet_location(self) -> Optional[str]:
        """�Wallet場所を取得"""
        lib_dir = os.getenv('ORACLE_CLIENT_LIB_DIR')
        if lib_dir:
            wallet_location = os.path.join(lib_dir, "network", "admin")
            if os.path.exists(wallet_location):
                return wallet_location
        return None
    
    def upload_wallet(self, wallet_file_path: str) -> Dict[str, Any]:
        """�Walletファイルをアップロードして解凍"""
        try:
            lib_dir = os.getenv('ORACLE_CLIENT_LIB_DIR')
            if not lib_dir:
                return {
                    "success": False,
                    "message": "ORACLE_CLIENT_LIB_DIR環境変数が設定されていません",
                    "available_services": []
                }
            
            wallet_location = os.path.join(lib_dir, "network", "admin")
            
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
            
            # 必要なファイルの存在確認
            required_files = ['cwallet.sso', 'tnsnames.ora', 'sqlnet.ora']
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
            
            # 設定を更新
            self.settings["wallet_uploaded"] = True
            self.settings["available_services"] = available_services
            self._save_settings(self.settings)
            
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
                import re
                pattern = r'^([A-Za-z0-9_-]+)\s*='
                matches = re.findall(pattern, content, re.MULTILINE)
                dsn_list = list(set(matches))  # 重複除去
                dsn_list.sort()
            
            return dsn_list
        except Exception as e:
            logger.error(f"DSN抽出エラー: {e}")
            return []
    
    def _ensure_pool(self, max_retries: int = 3) -> bool:
        """接続プールを確保（作成または検証）、リトライ機能付き"""
        if not ORACLEDB_AVAILABLE:
            logger.error("oracledbモジュールが利用できません")
            return False
        
        with self.__class__._pool_lock:
            # 既存プールが有効かチェック
            if self.__class__._pool is not None:
                try:
                    # プールから接続を取得して検証
                    test_conn = self.__class__._pool.acquire()
                    cursor = test_conn.cursor()
                    cursor.execute("SELECT 1 FROM DUAL")
                    cursor.close()
                    self.__class__._pool.release(test_conn)
                    logger.info("既存の接続プールが有効です")
                    return True
                except Exception as e:
                    logger.warning(f"既存プールが無効です: {e}")
                    # プールをクローズして再作成
                    try:
                        self.__class__._pool.close()
                    except:
                        pass
                    self.__class__._pool = None
            
            # プールを作成（リトライ付き）
            for attempt in range(1, max_retries + 1):
                try:
                    logger.info(f"接続プール作成試行 {attempt}/{max_retries}")
                    
                    # 接続情報を取得
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
                            logger.info(f".envからの情報: username={username}, dsn={dsn}, password_exists={bool(password)}")
                    
                    if not username or not password or not dsn:
                        raise ValueError("ユーザー名、パスワード、DSNが必要です")
                    
                    # Oracle Client初期化（Linuxのみ）
                    if not init_oracle_client():
                        raise Exception("Oracle Clientの初期化に失敗しました")
                    
                    # TNS_ADMIN設定
                    wallet_location = self._get_wallet_location()
                    if not wallet_location or not os.path.exists(wallet_location):
                        raise ValueError(f"Walletが見つかりません: {wallet_location}")
                    
                    os.environ['TNS_ADMIN'] = wallet_location
                    logger.info(f"Wallet場所: {wallet_location}")
                    
                    # 接続プールを作成
                    self.__class__._pool = oracledb.create_pool(
                        user=username,
                        password=password,
                        dsn=dsn,
                        config_dir=wallet_location,
                        min=5,
                        max=20,
                        increment=2,
                        timeout=30,
                        getmode=oracledb.POOL_GETMODE_WAIT
                    )
                    
                    logger.info(f"接続プール作成成功 (試行{attempt}回目): min=5, max=20")
                    return True
                    
                except Exception as e:
                    logger.error(f"接続プール作成失敗 (試行{attempt}/{max_retries}): {e}")
                    if attempt == max_retries:
                        logger.error("接続プール作成の最大リトライ回数に達しました")
                        return False
                    # リトライ前に少し待機
                    import time
                    time.sleep(1)
            
            return False
    
    def _get_connection_from_pool(self) -> Optional[Any]:
        """プールから接続を取得"""
        if not self._ensure_pool():
            return None
        
        try:
            connection = self.__class__._pool.acquire()
            return connection
        except Exception as e:
            logger.error(f"プールから接続取得失敗: {e}")
            return None
    
    def _release_connection(self, connection):
        """接続をプールに返却"""
        if connection and self.__class__._pool:
            try:
                self.__class__._pool.release(connection)
            except Exception as e:
                logger.error(f"接続の返却失敗: {e}")
    
    def _create_connection(self, settings: Optional[Dict[str, Any]] = None):
        """プールから接続を取得（後方互換性のため維持）"""
        return self._get_connection_from_pool()
    
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
        """接続テストを実行（非同期版）- 同期版を呼び出し"""
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
            
            # 同じプロセス内で直接実行
            result = _execute_db_operation(
                'test_connection',
                username=username,
                password=password,
                dsn=dsn
            )
            return result
        except Exception as e:
            logger.error(f"接続テストエラー（async）: {e}")
            return {
                "success": False,
                "message": f"接続エラー: {str(e)}"
            }
    
    def get_database_info(self) -> Optional[Dict[str, Any]]:
        """データベース情報を取得"""
        connection = None
        try:
            if not ORACLEDB_AVAILABLE:
                return None
            
            connection = self._create_connection()
            if not connection:
                return None
            
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
            self._release_connection(connection)
            
            return {
                "version": version,
                "instance_name": instance_name,
                "database_name": database_name,
                "current_user": current_user
            }
        
        except Exception as e:
            logger.error(f"データベース情報取得エラー: {e}")
            if connection:
                self._release_connection(connection)
            return None
    
    def get_tables(self, page: int = 1, page_size: int = 20) -> Dict[str, Any]:
        """テーブル一覧を取得（ページング対応）"""
        connection = None
        try:
            if not ORACLEDB_AVAILABLE:
                return {"tables": [], "total": 0}
            
            connection = self._create_connection()
            if not connection:
                return {"tables": [], "total": 0}
            
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
            self._release_connection(connection)
            
            return {"tables": tables, "total": total}
        
        except Exception as e:
            logger.error(f"テーブル一覧取得エラー: {e}")
            if connection:
                self._release_connection(connection)
            return {"tables": [], "total": 0}
    
    def get_table_data(self, table_name: str, page: int = 1, page_size: int = 20) -> Dict[str, Any]:
        """テーブルデータを取得（ページング対応）"""
        connection = None
        try:
            if not ORACLEDB_AVAILABLE:
                return {"success": False, "rows": [], "columns": [], "total": 0, "message": "Oracle DBが利用できません"}
            
            # テーブル名のバリデーション（SQLインジェクション防止）
            if not table_name.isidentifier() and not table_name.replace('_', '').replace('$', '').isalnum():
                return {"success": False, "rows": [], "columns": [], "total": 0, "message": "無効なテーブル名です"}
            
            connection = self._create_connection()
            if not connection:
                return {"success": False, "rows": [], "columns": [], "total": 0, "message": "データベース接続に失敗しました"}
            
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
            self._release_connection(connection)
            
            return {
                "success": True,
                "rows": rows,
                "columns": columns,
                "total": total,
                "message": "データ取得成功"
            }
        
        except Exception as e:
            logger.error(f"テーブルデータ取得エラー: {e}")
            if connection:
                self._release_connection(connection)
            return {"success": False, "rows": [], "columns": [], "total": 0, "message": str(e)}
    
    def delete_tables(self, table_names: list) -> Dict[str, Any]:
        """テーブルを一括削除"""
        deleted_count = 0
        errors = []
        connection = None
        
        try:
            if not ORACLEDB_AVAILABLE:
                return {"success": False, "deleted_count": 0, "message": "Oracle DBが利用できません", "errors": []}
            
            if not table_names:
                return {"success": False, "deleted_count": 0, "message": "削除するテーブルが指定されていません", "errors": []}
            
            connection = self._create_connection()
            if not connection:
                return {"success": False, "deleted_count": 0, "message": "データベース接続に失敗しました", "errors": []}
            
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
            self._release_connection(connection)
            
            return {
                "success": deleted_count > 0,
                "deleted_count": deleted_count,
                "message": f"{deleted_count}件のテーブルを削除しました" if deleted_count > 0 else "削除に失敗しました",
                "errors": errors
            }
        
        except Exception as e:
            logger.error(f"テーブル一括削除エラー: {e}")
            if connection:
                self._release_connection(connection)
            return {"success": False, "deleted_count": 0, "message": str(e), "errors": errors}
    
    def get_env_connection_info(self) -> Dict[str, Any]:
        """環境変数からDB接続情報を取得"""
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
            import re
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
            
            return {
                "success": True,
                "message": "環境変数から接続情報を取得しました",
                "username": username,
                "password": password,  # フロントエンドでは表示しない
                "dsn": dsn,
                "wallet_exists": wallet_exists,
                "wallet_location": wallet_location if wallet_exists else None,
                "available_services": available_services
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
    
    def is_connected(self) -> bool:
        """接続状態を確認"""
        if not ORACLEDB_AVAILABLE:
            return False
        
        connection = None
        try:
            connection = self._create_connection()
            if not connection:
                return False
            
            cursor = connection.cursor()
            cursor.execute("SELECT 1 FROM DUAL")
            cursor.fetchone()
            cursor.close()
            self._release_connection(connection)
            return True
        except:
            if connection:
                self._release_connection(connection)
            return False
    
    def get_storage_info(self) -> Optional[Dict[str, Any]]:
        """データベースストレージ情報を取得"""
        connection = None
        try:
            if not ORACLEDB_AVAILABLE:
                return None
            
            connection = self._create_connection()
            if not connection:
                return None
            
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
            self._release_connection(connection)
            
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
            if connection:
                self._release_connection(connection)
            return None


# グローバルインスタンス
database_service = DatabaseService()
