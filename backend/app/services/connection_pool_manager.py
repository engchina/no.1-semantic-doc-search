"""
データベース接続プール管理サービス

Thin mode対応の接続プールを管理し、遅延初期化とリトライ機能を提供します。
接続プールは初回のDB操作時に作成され、シングルトンパターンで管理されます。
"""
import logging
import os
import time
from typing import Optional, Dict, Any
from contextlib import contextmanager

logger = logging.getLogger(__name__)

# oracledbモジュールのインポート
try:
    import oracledb
    ORACLEDB_AVAILABLE = True
except ImportError:
    logger.warning("oracledbモジュールが利用できません。pip install oracledb を実行してください。")
    ORACLEDB_AVAILABLE = False


class ConnectionPoolManager:
    """データベース接続プール管理クラス（シングルトン）
    
    特徴:
    - 遅延初期化: 初回のDB操作時に接続プールを作成
    - シングルトンパターン: アプリケーション全体で1つのインスタンスのみ
    - リトライ機能: 接続プール作成失敗時、最大3回リトライ
    - Thin mode対応: Oracle Clientライブラリ不要
    - 自動リソース管理: コンテキストマネージャーで接続の確実なクローズ
    """
    
    _instance: Optional['ConnectionPoolManager'] = None
    _initialized: bool = False
    
    # プール設定
    POOL_MIN = 2  # 最小接続数
    POOL_MAX = 10  # 最大接続数
    POOL_INCREMENT = 1  # 接続増加数
    
    # リトライ設定
    MAX_RETRIES = 3  # 最大リトライ回数
    RETRY_DELAY = 2  # リトライ間隔（秒）
    
    # タイムアウト設定
    GET_CONNECTION_TIMEOUT = 10  # 接続取得タイムアウト（秒）
    TCP_CONNECT_TIMEOUT = 10  # TCP接続タイムアウト（秒）
    
    def __new__(cls):
        """シングルトンパターンの実装"""
        if cls._instance is None:
            cls._instance = super(ConnectionPoolManager, cls).__new__(cls)
        return cls._instance
    
    def __init__(self):
        """初期化（一度だけ実行）"""
        if not self.__class__._initialized:
            self._pool = None
            self._pool_settings: Dict[str, Any] = {}
            self.__class__._initialized = True
            logger.info("========== ConnectionPoolManager初期化 ==========")
            logger.info("接続プールマネージャーをシングルトンモードで初期化しました")
            logger.info(f"プール設定: MIN={self.POOL_MIN}, MAX={self.POOL_MAX}, INCREMENT={self.POOL_INCREMENT}")
            logger.info(f"リトライ設定: MAX_RETRIES={self.MAX_RETRIES}, RETRY_DELAY={self.RETRY_DELAY}秒")
    
    def _get_wallet_location(self) -> Optional[str]:
        """Wallet場所を取得
        
        Returns:
            Walletのパス、またはNone
        """
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
        
        if os.path.exists(wallet_location):
            return wallet_location
        
        return None
    
    def _create_pool_internal(self, username: str, password: str, dsn: str) -> Optional[Any]:
        """接続プールを内部的に作成（リトライなし）
        
        Args:
            username: データベースユーザー名
            password: データベースパスワード
            dsn: データソース名
            
        Returns:
            接続プール、または失敗時はNone
        """
        logger.info("========== 接続プール作成開始 ==========")
        
        # oracledbモジュール確認
        if not ORACLEDB_AVAILABLE:
            logger.error("✘ oracledbモジュールが利用できません")
            return None
        
        logger.info(f"✔ oracledbモジュール利用可能 (version: {oracledb.__version__})")
        
        # Wallet場所確認
        wallet_location = self._get_wallet_location()
        if not wallet_location:
            logger.error("✘ Wallet場所が取得できません")
            return None
        
        if not os.path.exists(wallet_location):
            logger.error(f"✘ Walletディレクトリが存在しません: {wallet_location}")
            return None
        
        # Walletファイルの確認
        wallet_files = os.listdir(wallet_location)
        required_files = ['cwallet.sso', 'ewallet.pem', 'sqlnet.ora', 'tnsnames.ora']
        missing_files = [f for f in required_files if f not in wallet_files]
        if missing_files:
            logger.error(f"✘ 必要なWalletファイルが不足: {missing_files}")
            return None
        
        logger.info(f"✔ Wallet場所確認完了: {wallet_location}")
        logger.info("✔ すべての必須Walletファイルが確認されました")
        
        # TNS_ADMIN設定
        os.environ['TNS_ADMIN'] = wallet_location
        
        # 接続プール作成
        try:
            logger.info(f"接続プール作成中...")
            logger.info(f"  user={username}, dsn={dsn}")
            logger.info(f"  min={self.POOL_MIN}, max={self.POOL_MAX}, increment={self.POOL_INCREMENT}")
            logger.info(f"  getmode=oracledb.POOL_GETMODE_WAIT")
            logger.info(f"  wait_timeout={self.GET_CONNECTION_TIMEOUT}, timeout={self.TCP_CONNECT_TIMEOUT}")
            
            start_time = time.time()
            
            # Thin mode接続プール作成
            pool = oracledb.create_pool(
                user=username,
                password=password,
                dsn=dsn,
                min=self.POOL_MIN,
                max=self.POOL_MAX,
                increment=self.POOL_INCREMENT,
                getmode=oracledb.POOL_GETMODE_WAIT,
                config_dir=wallet_location,
                wallet_location=wallet_location,
                wallet_password=password,
                wait_timeout=self.GET_CONNECTION_TIMEOUT,  # プールから接続取得時の待機タイムアウト
                timeout=self.TCP_CONNECT_TIMEOUT  # TCP接続タイムアウト
            )
            
            elapsed = time.time() - start_time
            logger.info(f"✔ 接続プール作成成功 ({elapsed:.2f}秒)")
            
            # 接続テスト
            logger.info("接続プールの動作確認中...")
            with pool.acquire() as connection:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT 1 FROM DUAL")
                    result = cursor.fetchone()
                    logger.info(f"✔ 接続プールテストクエリ成功: {result}")
            
            logger.info("========== 接続プール作成完了 ==========")
            return pool
            
        except Exception as e:
            logger.error(f"✘ 接続プール作成失敗: {e}")
            logger.error(f"  エラータイプ: {type(e).__name__}")
            
            # エラー詳細を解析
            error_str = str(e)
            if "DPY-6005" in error_str or "DPY-6000" in error_str:
                logger.error("  原因: データベースが停止している可能性があります")
            elif "ORA-01017" in error_str:
                logger.error("  原因: ユーザー名またはパスワードが正しくありません")
            elif "ORA-12154" in error_str:
                logger.error("  原因: DSNが見つかりません")
            elif "Broken pipe" in error_str or "errno 32" in error_str.lower():
                logger.error("  原因: ネットワーク接続が切断されました")
            elif "timeout" in error_str.lower() or "timed out" in error_str.lower():
                logger.error("  原因: データベースが起動していないか、ネットワーク接続が不可です")
            
            return None
    
    def _create_pool_with_retry(self, username: str, password: str, dsn: str) -> Optional[Any]:
        """リトライ機能付きで接続プールを作成
        
        Args:
            username: データベースユーザー名
            password: データベースパスワード
            dsn: データソース名
            
        Returns:
            接続プール、または失敗時はNone
        """
        logger.info(f"接続プール作成開始 (MAX_RETRIES={self.MAX_RETRIES})")
        
        for attempt in range(1, self.MAX_RETRIES + 1):
            logger.info(f"接続プール作成試行 {attempt}/{self.MAX_RETRIES}")
            
            pool = self._create_pool_internal(username, password, dsn)
            if pool:
                return pool
            
            if attempt < self.MAX_RETRIES:
                logger.info(f"{self.RETRY_DELAY}秒後にリトライ...")
                time.sleep(self.RETRY_DELAY)
        
        logger.error(f"接続プール作成失敗: {self.MAX_RETRIES}回試行後")
        return None
    
    def initialize_pool(self, username: str, password: str, dsn: str) -> bool:
        """接続プールを初期化（遅延初期化）
        
        Args:
            username: データベースユーザー名
            password: データベースパスワード
            dsn: データソース名
            
        Returns:
            初期化成功の場合True
        """
        # すでに接続プールが存在し、有効な場合はスキップ
        if self._pool is not None:
            try:
                # プールが有効かテスト
                with self._pool.acquire() as connection:
                    with connection.cursor() as cursor:
                        cursor.execute("SELECT 1 FROM DUAL")
                        cursor.fetchone()
                logger.info("既存の接続プールは有効です")
                return True
            except Exception as e:
                logger.warning(f"既存の接続プールが無効です: {e}")
                # プールをクローズして再作成
                self.close_pool()
        
        # 接続プールを作成
        pool = self._create_pool_with_retry(username, password, dsn)
        if pool:
            self._pool = pool
            self._pool_settings = {
                'username': username,
                'password': password,
                'dsn': dsn
            }
            logger.info("接続プールを初期化しました")
            return True
        else:
            logger.error("接続プールの初期化に失敗しました")
            return False
    
    def get_pool(self) -> Optional[Any]:
        """接続プールを取得
        
        Returns:
            接続プール、またはNone（未初期化の場合）
        """
        return self._pool
    
    @contextmanager
    def acquire_connection(self):
        """接続をプールから取得（コンテキストマネージャー）
        
        Yields:
            データベース接続
            
        Raises:
            Exception: 接続プールが未初期化または接続取得失敗
            
        使用例:
            with pool_manager.acquire_connection() as connection:
                cursor = connection.cursor()
                cursor.execute("SELECT 1 FROM DUAL")
                result = cursor.fetchone()
        """
        if self._pool is None:
            raise Exception("接続プールが初期化されていません。initialize_pool()を先に呼び出してください。")
        
        connection = None
        retry_count = 0
        
        while retry_count < self.MAX_RETRIES:
            try:
                # プールから接続を取得
                connection = self._pool.acquire()
                logger.debug("接続をプールから取得しました")
                
                try:
                    # 接続を返す
                    yield connection
                finally:
                    # 例外が発生しても必ず接続を返却
                    if connection:
                        try:
                            self._pool.release(connection)
                            logger.debug("接続をプールに返却しました")
                        except Exception as release_err:
                            logger.error(f"接続返却エラー: {release_err}")
                
                # 正常終了
                return
                
            except Exception as e:
                error_str = str(e)
                logger.error(f"接続取得エラー (試行{retry_count + 1}): {e}")
                
                # 接続が取得されていた場合はクローズ
                if connection:
                    try:
                        connection.close()
                    except:
                        pass
                    connection = None
                
                # プールが無効な場合は再初期化を試みる
                if "DPY-" in error_str or "pool" in error_str.lower():
                    logger.warning("接続プールが無効な可能性があります。再初期化を試みます...")
                    self.close_pool()
                    
                    if self._pool_settings:
                        success = self.initialize_pool(
                            self._pool_settings['username'],
                            self._pool_settings['password'],
                            self._pool_settings['dsn']
                        )
                        if not success:
                            logger.error("接続プールの再初期化に失敗しました")
                            raise
                    else:
                        logger.error("接続プール設定が見つかりません")
                        raise
                
                retry_count += 1
                if retry_count < self.MAX_RETRIES:
                    logger.info(f"{self.RETRY_DELAY}秒後にリトライ...")
                    time.sleep(self.RETRY_DELAY)
                else:
                    logger.error(f"接続取得失敗: {self.MAX_RETRIES}回試行後")
                    raise
    
    def close_pool(self):
        """接続プールをクローズ"""
        if self._pool:
            try:
                logger.info("接続プールをクローズしています...")
                self._pool.close()
                logger.info("✔ 接続プールをクローズしました")
            except Exception as e:
                logger.error(f"接続プールクローズエラー: {e}")
            finally:
                self._pool = None
    
    def get_pool_status(self) -> Dict[str, Any]:
        """接続プールの状態を取得
        
        Returns:
            プール状態情報
        """
        if self._pool is None:
            return {
                'initialized': False,
                'status': 'not_initialized'
            }
        
        try:
            return {
                'initialized': True,
                'status': 'active',
                'open_connections': self._pool.opened,
                'busy_connections': self._pool.busy,
                'max_connections': self._pool.max,
                'min_connections': self._pool.min,
                'increment': self._pool.increment
            }
        except Exception as e:
            logger.error(f"プール状態取得エラー: {e}")
            return {
                'initialized': True,
                'status': 'error',
                'error': str(e)
            }
