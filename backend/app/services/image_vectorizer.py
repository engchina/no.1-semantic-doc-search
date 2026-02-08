"""
画像ベクトル化サービス
OCI Generative AI Embedding Modelを使用して画像をベクトル化し、DBに保存
"""
import array
import base64
import io
import logging
import os
import random
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np
import oci
import oracledb
from pdf2image import convert_from_path
from PIL import Image

logger = logging.getLogger(__name__)

# レート制限対応のリトライ設定（OCI Embedding API用）
EMBEDDING_API_MAX_RETRIES = int(os.environ.get("EMBEDDING_API_MAX_RETRIES", "5"))
EMBEDDING_API_BASE_DELAY = float(os.environ.get("EMBEDDING_API_BASE_DELAY", "1.5"))  # 秒
EMBEDDING_API_MAX_DELAY = float(os.environ.get("EMBEDDING_API_MAX_DELAY", "120.0"))   # 秒
EMBEDDING_API_JITTER = float(os.environ.get("EMBEDDING_API_JITTER", "0.2"))          # ランダム遅延の範囲


class ImageVectorizer:
    """画像ベクトル化クラス
    
    注意: DB接続は各メソッドで独立して取得・解放します。
    接続プールを使用し、グローバルインスタンスでの接続共有による
    並列処理時の競合を防止します。
    """
    
    def __init__(self):
        """初期化"""
        self.genai_client = None
        # 注: self.db_connectionは使用しない（並列処理の競合防止）
        self._initialize_genai_only()
        logger.info("ImageVectorizerを初期化しました（DB接続は各メソッドで取得）")
    
    def _is_embedding_rate_limit_error(self, error: Exception) -> bool:
        """
        Embedding APIのレート制限エラーを判定します。
        
        Args:
            error (Exception): 発生した例外オブジェクト
            
        Returns:
            bool: レート制限エラーの場合はTrue、それ以外はFalse
        """
        error_str = str(error).lower()
        return (
            '429' in error_str or 
            'too many requests' in error_str or 
            'rate limit exceeded' in error_str or
            'quota exceeded' in error_str or
            'embedding model' in error_str and 'busy' in error_str
        )
    
    def _calculate_embedding_backoff_delay(self, attempt: int, is_rate_limit: bool = False) -> float:
        """
        Embedding API用の指数バックオフ遅延時間を計算します。
        
        Args:
            attempt (int): 現在の試行回数 (0から開始)
            is_rate_limit (bool): レート制限エラーによるリトライかどうか
            
        Returns:
            float: 次のリトライまでの待機時間（秒）
        """
        if is_rate_limit:
            # レート制限の場合はより長い待機時間
            base_multiplier = 4.0  # Embedding APIはより慎重に
        else:
            # 通常のエラーの場合は標準的なバックオフ
            base_multiplier = 2.5
        
        # 指数バックオフ計算
        delay = EMBEDDING_API_BASE_DELAY * (base_multiplier ** attempt)
        
        # 最大遅延時間を制限
        delay = min(delay, EMBEDDING_API_MAX_DELAY)
        
        # ランダムなジッターを追加（スロットリング回避）
        jitter = random.uniform(-EMBEDDING_API_JITTER, EMBEDDING_API_JITTER) * delay
        delay = max(0.5, delay + jitter)  # 最小0.5秒を保証（Embedding APIは重いので）
        
        return delay
    
    def _retry_embedding_api_call(self, func, *args, **kwargs) -> Any:
        """
        Embedding API呼び出しにリトライメカニズムを適用して実行します。
        
        Args:
            func (Callable): 実行するAPI関数
            *args: 関数への位置引数
            **kwargs: 関数へのキーワード引数
            
        Returns:
            Any: API関数の実行結果
            
        Raises:
            Exception: 最大リトライ回数に達しても成功しなかった場合に送出されます
        """
        last_exception = None
        
        for attempt in range(EMBEDDING_API_MAX_RETRIES):
            try:
                result = func(*args, **kwargs)
                if attempt > 0:
                    logger.info(f"Embedding API呼び出し成功（リトライ {attempt}回目後）")
                return result
                
            except Exception as e:
                last_exception = e
                is_rate_limit = self._is_embedding_rate_limit_error(e)
                
                if attempt == EMBEDDING_API_MAX_RETRIES - 1:
                    # 最終リトライでも失敗
                    logger.error(f"Embedding API呼び出し最終リトライ失敗（{EMBEDDING_API_MAX_RETRIES}回）: {e}")
                    raise
                
                # 待機時間計算
                delay = self._calculate_embedding_backoff_delay(attempt, is_rate_limit)
                
                error_type = "レート制限" if is_rate_limit else "エラー"
                logger.warning(
                    f"Embedding API {error_type}（リトライ {attempt + 1}/{EMBEDDING_API_MAX_RETRIES}）: "
                    f"{delay:.1f}秒後に再試行 - {str(e)[:100]}"
                )
                
                time.sleep(delay)
        
        # 到達しないはずだが、念のため
        if last_exception:
            raise last_exception
    
    def _initialize_genai_only(self):
        """
        OCI Generative AIクライアントのみを初期化します（DB接続は遅延作成）。
        設定ファイルが見つからない場合はログに警告を出力して終了します。
        """
        try:
            # OCI設定を読み込み
            config_file = os.path.expanduser("~/.oci/config")
            profile = os.getenv("OCI_PROFILE", "DEFAULT")
            
            if not os.path.exists(config_file):
                logger.warning(f"OCI設定ファイルが見つかりません: {config_file}")
                return
            
            config = oci.config.from_file(file_location=config_file, profile_name=profile)
            
            # OCI Generative AI Clientを初期化
            region = os.getenv("OCI_REGION", "us-chicago-1")
            service_endpoint = f"https://inference.generativeai.{region}.oci.oraclecloud.com"
            
            self.genai_client = oci.generative_ai_inference.GenerativeAiInferenceClient(
                config=config,
                service_endpoint=service_endpoint,
                retry_strategy=oci.retry.NoneRetryStrategy(),
                timeout=(10, 240)
            )
            
            logger.info("OCI Generative AIクライアント初期化成功")
            
        except Exception as e:
            logger.error(f"GenAI初期化エラー: {e}")
            self.genai_client = None
    
    def _get_pool_manager(self):
        """
        データベース接続プールマネージャーを取得します。
        
        Returns:
            ConnectionPoolManager: 接続プールマネージャーのインスタンス
        """
        from app.services.database_service import database_service
        return database_service.pool_manager
    
    def _ensure_pool_initialized(self) -> bool:
        """
        接続プールが初期化されているか確認し、必要であれば初期化を試みます。
        
        Returns:
            bool: プールが利用可能な場合はTrue、そうでない場合はFalse
        """
        from app.services.database_service import database_service
        return database_service._ensure_pool_initialized()
    
    def is_connected(self) -> bool:
        """
        データベース接続状態をチェックします（接続プール経由）。
        
        Returns:
            bool: 接続が有効な場合はTrue、そうでない場合はFalse
        """
        try:
            if not self._ensure_pool_initialized():
                return False
            
            with self._get_pool_manager().acquire_connection() as connection:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT 1 FROM DUAL")
                    cursor.fetchone()
            return True
        except Exception:
            return False
    
    def _ensure_tables_exist(self, connection):
        """
        必要なテーブル（FILE_INFO, IMG_EMBEDDINGS）が存在することを確認し、なければ作成します。
        
        Args:
            connection (oracledb.Connection): データベース接続オブジェクト
        """
        if not connection:
            return
        
        try:
            with connection.cursor() as cursor:
                # FILE_INFOテーブルの存在確認
                cursor.execute("""
                    SELECT COUNT(*) 
                    FROM USER_TABLES 
                    WHERE TABLE_NAME = 'FILE_INFO'
                """)
                file_info_exists = cursor.fetchone()[0] > 0
                
                if not file_info_exists:
                    logger.info("FILE_INFOテーブルを作成します...")
                    cursor.execute("""
                        CREATE TABLE FILE_INFO (
                            FILE_ID NUMBER GENERATED BY DEFAULT AS IDENTITY 
                                MINVALUE 1 
                                MAXVALUE 9999999999999999999999999999 
                                INCREMENT BY 1 
                                START WITH 1 
                                CACHE 20 
                                NOORDER NOCYCLE NOKEEP NOSCALE,
                            BUCKET VARCHAR2(128 BYTE) COLLATE USING_NLS_COMP,
                            OBJECT_NAME VARCHAR2(1024 BYTE) COLLATE USING_NLS_COMP,
                            ORIGINAL_FILENAME VARCHAR2(1024 BYTE) COLLATE USING_NLS_COMP,
                            FILE_SIZE NUMBER,
                            CONTENT_TYPE VARCHAR2(128 BYTE) COLLATE USING_NLS_COMP,
                            UPLOADED_AT TIMESTAMP(6) DEFAULT SYSTIMESTAMP,
                            CONSTRAINT PK_FILE_INFO PRIMARY KEY (FILE_ID)
                        ) DEFAULT COLLATION USING_NLS_COMP
                    """)
                    connection.commit()
                    logger.info("FILE_INFOテーブル作成完了")
                
                # IMG_EMBEDDINGSテーブルの存在確認
                cursor.execute("""
                    SELECT COUNT(*) 
                    FROM USER_TABLES 
                    WHERE TABLE_NAME = 'IMG_EMBEDDINGS'
                """)
                img_embeddings_exists = cursor.fetchone()[0] > 0
                
                if not img_embeddings_exists:
                    logger.info("IMG_EMBEDDINGSテーブルを作成します...")
                    cursor.execute("""
                        CREATE TABLE IMG_EMBEDDINGS (
                            ID NUMBER GENERATED BY DEFAULT AS IDENTITY 
                                MINVALUE 1 
                                MAXVALUE 9999999999999999999999999999 
                                INCREMENT BY 1 
                                START WITH 1 
                                CACHE 20 
                                NOORDER NOCYCLE NOKEEP NOSCALE,
                            FILE_ID NUMBER,
                            BUCKET VARCHAR2(128 BYTE) COLLATE USING_NLS_COMP,
                            OBJECT_NAME VARCHAR2(1024 BYTE) COLLATE USING_NLS_COMP,
                            PAGE_NUMBER NUMBER,
                            CONTENT_TYPE VARCHAR2(128 BYTE) COLLATE USING_NLS_COMP,
                            FILE_SIZE NUMBER,
                            UPLOADED_AT TIMESTAMP(6) DEFAULT SYSTIMESTAMP,
                            EMBEDDING VECTOR(1536, FLOAT32),
                            CONSTRAINT PK_IMG_EMBEDDINGS PRIMARY KEY (ID),
                            CONSTRAINT FK_IMG_FILE FOREIGN KEY (FILE_ID) 
                                REFERENCES FILE_INFO(FILE_ID) ON DELETE CASCADE
                        ) DEFAULT COLLATION USING_NLS_COMP
                    """)
                    connection.commit()
                    logger.info("IMG_EMBEDDINGSテーブル作成完了")
                
        except Exception as e:
            logger.error(f"テーブル作成エラー: {e}")
            if connection:
                connection.rollback()
    
    def _image_to_base64(self, image_data: io.BytesIO, content_type: str = "image/png") -> str:
        """
        画像データをbase64エンコード文字列に変換します。
        
        Args:
            image_data (io.BytesIO): 画像のバイナリデータ
            content_type (str): 画像のMIMEタイプ (例: "image/png")
            
        Returns:
            str: Data URIスキーム形式のbase64文字列
        """
        image_data.seek(0)
        image_bytes = image_data.read()
        base64_string = base64.b64encode(image_bytes).decode('utf-8')
        return f"data:{content_type};base64,{base64_string}"
    
    def generate_embedding(self, image_data: io.BytesIO, content_type: str = "image/png") -> Optional[np.ndarray]:
        """
        画像からembeddingベクトルを生成します（リトライ対応）。
        
        Args:
            image_data (io.BytesIO): 画像データ
            content_type (str): 画像のContent-Type
            
        Returns:
            Optional[np.ndarray]: embeddingベクトル（numpy array）、生成失敗時はNone
        """
        # GenAIクライアントが初期化されていない場合、リトライして初期化を試みる
        if not self.genai_client:
            max_init_retries = 3
            for retry in range(1, max_init_retries + 1):
                logger.warning(f"OCI Generative AIクライアントが初期化されていません。再初期化を試みます（{retry}/{max_init_retries}回目）")
                self._initialize_genai_only()
                if self.genai_client:
                    logger.info(f"OCI Generative AIクライアント再初期化成功（{retry}回目）")
                    break
                if retry < max_init_retries:
                    time.sleep(1)  # 1秒待機してリトライ
            
            if not self.genai_client:
                logger.error(f"OCI Generative AIクライアントの初期化に失敗しました（{max_init_retries}回リトライ）")
                return None
        
        try:
            # 画像をbase64エンコード
            base64_image = self._image_to_base64(image_data, content_type)
            
            # Embedding生成リクエストを作成
            embed_detail = oci.generative_ai_inference.models.EmbedTextDetails()
            embed_detail.serving_mode = oci.generative_ai_inference.models.OnDemandServingMode(
                model_id=os.getenv("OCI_COHERE_EMBED_MODEL", "cohere.embed-v4.0")
            )
            embed_detail.input_type = os.getenv("OCI_EMBEDDING_INPUT_TYPE", "IMAGE")
            embed_detail.inputs = [base64_image]
            embed_detail.truncate = os.getenv("OCI_EMBEDDING_TRUNCATE", "END")
            embed_detail.compartment_id = os.getenv("OCI_COMPARTMENT_OCID")
            
            # Embedding API呼び出し（リトライ対応）
            response = self._retry_embedding_api_call(
                self.genai_client.embed_text,
                embed_detail
            )
            
            if response.data.embeddings:
                embedding = response.data.embeddings[0]
                embedding_array = np.array(embedding, dtype=np.float32)
                
                logger.info(f"画像embedding生成成功: shape={embedding_array.shape}")
                return embedding_array
            else:
                logger.error("Embeddingが空です")
                return None
                
        except Exception as e:
            logger.error(f"予期しないエラー: {e}")
            return None
    
    def generate_text_embedding(self, text: str) -> Optional[np.ndarray]:
        """
        テキストからembeddingベクトルを生成します（検索クエリ用、リトライ対応）。
        
        Args:
            text (str): 入力テキスト
            
        Returns:
            Optional[np.ndarray]: embeddingベクトル（numpy array）、生成失敗時はNone
        """
        # GenAIクライアントが初期化されていない場合、リトライして初期化を試みる
        if not self.genai_client:
            max_init_retries = 3
            for retry in range(1, max_init_retries + 1):
                logger.warning(f"OCI Generative AIクライアントが初期化されていません。再初期化を試みます（{retry}/{max_init_retries}回目）")
                self._initialize_genai_only()
                if self.genai_client:
                    logger.info(f"OCI Generative AIクライアント再初期化成功（{retry}回目）")
                    break
                if retry < max_init_retries:
                    time.sleep(1)  # 1秒待機してリトライ
            
            if not self.genai_client:
                logger.error(f"OCI Generative AIクライアントの初期化に失敗しました（{max_init_retries}回リトライ）")
                return None
        
        try:
            # Embedding生成リクエストを作成
            embed_detail = oci.generative_ai_inference.models.EmbedTextDetails()
            embed_detail.serving_mode = oci.generative_ai_inference.models.OnDemandServingMode(
                model_id=os.getenv("OCI_COHERE_EMBED_MODEL", "cohere.embed-v4.0")
            )
            embed_detail.input_type = "SEARCH_QUERY"  # 検索クエリ用
            embed_detail.inputs = [text]
            embed_detail.truncate = os.getenv("OCI_EMBEDDING_TRUNCATE", "END")
            embed_detail.compartment_id = os.getenv("OCI_COMPARTMENT_OCID")
            
            # Embedding API呼び出し（リトライ対応）
            response = self._retry_embedding_api_call(
                self.genai_client.embed_text,
                embed_detail
            )
            
            if response.data.embeddings:
                embedding = response.data.embeddings[0]
                embedding_array = np.array(embedding, dtype=np.float32)
                
                logger.info(f"テキストembedding生成成功: text_len={len(text)}, shape={embedding_array.shape}")
                return embedding_array
            else:
                logger.error("Embeddingが空です")
                return None
                
        except Exception as e:
            logger.error(f"テキストembedding生成エラー: {e}")
            return None
    
    def save_file_info(self, bucket: str, object_name: str, original_filename: str, 
                      file_size: int, content_type: str) -> Optional[int]:
        """
        ファイル情報をFILE_INFOテーブルに保存します（接続プール経由）。
        
        Args:
            bucket (str): バケット名
            object_name (str): オブジェクト名
            original_filename (str): 元のファイル名
            file_size (int): ファイルサイズ（バイト）
            content_type (str): コンテンツタイプ
            
        Returns:
            Optional[int]: 保存されたファイルのID、失敗時はNone
        """
        try:
            if not self._ensure_pool_initialized():
                logger.error("接続プールの初期化に失敗")
                return None
            
            with self._get_pool_manager().acquire_connection() as connection:
                # テーブル存在確認（初回のみ）
                self._ensure_tables_exist(connection)
                
                with connection.cursor() as cursor:
                    cursor.execute("""
                        INSERT INTO FILE_INFO 
                        (BUCKET, OBJECT_NAME, ORIGINAL_FILENAME, FILE_SIZE, CONTENT_TYPE)
                        VALUES (:bucket, :object_name, :original_filename, :file_size, :content_type)
                        RETURNING FILE_ID INTO :file_id
                    """, {
                        'bucket': bucket,
                        'object_name': object_name,
                        'original_filename': original_filename,
                        'file_size': file_size,
                        'content_type': content_type,
                        'file_id': cursor.var(oracledb.NUMBER)
                    })
                    
                    file_id_var = cursor.bindvars['file_id']
                    file_id = file_id_var.getvalue()
                    
                    if isinstance(file_id, list) and len(file_id) > 0:
                        file_id = file_id[0]
                    
                    connection.commit()
                    
                    logger.info(f"ファイル情報保存成功: FILE_ID={file_id}")
                    return int(file_id)
                
        except Exception as e:
            logger.error(f"ファイル情報保存エラー: {e}")
            return None
    
    def save_image_embedding(self, file_id: int, bucket: str, object_name: str, 
                           page_number: int, content_type: str, file_size: int, 
                           embedding: np.ndarray) -> Optional[int]:
        """
        画像embeddingをIMG_EMBEDDINGSテーブルに保存します（接続プール経由）。
        
        Args:
            file_id (int): 関連するファイルのID
            bucket (str): バケット名
            object_name (str): オブジェクト名
            page_number (int): ページ番号
            content_type (str): コンテンツタイプ
            file_size (int): ファイルサイズ
            embedding (np.ndarray): embeddingベクトル
            
        Returns:
            Optional[int]: 保存されたembeddingのID、失敗時はNone
        """
        try:
            if not self._ensure_pool_initialized():
                logger.error("接続プールの初期化に失敗")
                return None
            
            with self._get_pool_manager().acquire_connection() as connection:
                # NumPy配列をFLOAT32配列に変換
                embedding_array = array.array("f", embedding.tolist())
                
                with connection.cursor() as cursor:
                    cursor.execute("""
                        INSERT INTO IMG_EMBEDDINGS 
                        (FILE_ID, BUCKET, OBJECT_NAME, PAGE_NUMBER, CONTENT_TYPE, FILE_SIZE, EMBEDDING)
                        VALUES (:file_id, :bucket, :object_name, :page_number, :content_type, :file_size, :embedding)
                        RETURNING ID INTO :id
                    """, {
                        'file_id': file_id,
                        'bucket': bucket,
                        'object_name': object_name,
                        'page_number': page_number,
                        'content_type': content_type,
                        'file_size': file_size,
                        'embedding': embedding_array,
                        'id': cursor.var(oracledb.NUMBER)
                    })
                    
                    id_var = cursor.bindvars['id']
                    embedding_id = id_var.getvalue()
                    
                    if isinstance(embedding_id, list) and len(embedding_id) > 0:
                        embedding_id = embedding_id[0]
                    
                    connection.commit()
                    
                    logger.info(f"画像embedding保存成功: ID={embedding_id}, FILE_ID={file_id}, PAGE={page_number}")
                    return int(embedding_id)
                
        except Exception as e:
            logger.error(f"画像embedding保存エラー: {e}")
            return None
    
    def delete_file_embeddings(self, file_id: int) -> bool:
        """
        ファイルに関連するすべてのembeddingを削除します（接続プール経由）。
        
        Args:
            file_id (int): 削除対象のファイルID
            
        Returns:
            bool: 削除成功時はTrue、失敗時はFalse
        """
        try:
            if not self._ensure_pool_initialized():
                logger.error("接続プールの初期化に失敗")
                return False
            
            with self._get_pool_manager().acquire_connection() as connection:
                with connection.cursor() as cursor:
                    cursor.execute("""
                        DELETE FROM IMG_EMBEDDINGS 
                        WHERE FILE_ID = :file_id
                    """, {'file_id': file_id})
                    
                    deleted_count = cursor.rowcount
                    connection.commit()
                    
                    logger.info(f"FILE_ID={file_id}のembedding削除完了: {deleted_count}件")
                    return True
                
        except Exception as e:
            logger.error(f"Embedding削除エラー: {e}")
            return False
    
    def get_file_id_by_object_name(self, bucket: str, object_name: str) -> Optional[int]:
        """
        Object NameからFILE_IDを取得します（接続プール経由）。
        
        Args:
            bucket (str): バケット名
            object_name (str): オブジェクト名
            
        Returns:
            Optional[int]: ファイルID、見つからない場合やエラー時はNone
        """
        try:
            if not self._ensure_pool_initialized():
                return None
            
            with self._get_pool_manager().acquire_connection() as connection:
                with connection.cursor() as cursor:
                    cursor.execute("""
                        SELECT FILE_ID 
                        FROM FILE_INFO 
                        WHERE BUCKET = :bucket AND OBJECT_NAME = :object_name
                    """, {
                        'bucket': bucket,
                        'object_name': object_name
                    })
                    
                    result = cursor.fetchone()
                    return result[0] if result else None
                
        except Exception as e:
            logger.error(f"FILE_ID取得エラー: {e}")
            return None

    def get_vectorization_status(self, bucket: str, object_names: List[str]) -> Dict[str, bool]:
        """
        複数ファイルのベクトル化状態を一括取得します（接続プール経由）。
        
        Args:
            bucket (str): バケット名
            object_names (List[str]): オブジェクト名のリスト
            
        Returns:
            Dict[str, bool]: {object_name: has_embeddings} の形式で各ファイルのベクトル化状態を返します
        """
        result = {name: False for name in object_names}
        
        if not object_names:
            return result
        
        try:
            if not self._ensure_pool_initialized():
                logger.warning("DB接続なし、ベクトル化状態をすべてFalseで返します")
                return result
            
            with self._get_pool_manager().acquire_connection() as connection:
                with connection.cursor() as cursor:
                    # FILE_INFOテーブルとIMG_EMBEDDINGSテーブルを結合して、
                    # 各ファイルにembeddingが存在するかチェック
                    placeholders = ', '.join([f":obj_{i}" for i in range(len(object_names))])
                    
                    query = f"""
                        SELECT f.OBJECT_NAME, 
                               CASE WHEN e.FILE_ID IS NOT NULL THEN 1 ELSE 0 END as HAS_EMBEDDINGS
                        FROM FILE_INFO f
                        LEFT JOIN (
                            SELECT DISTINCT FILE_ID FROM IMG_EMBEDDINGS
                        ) e ON f.FILE_ID = e.FILE_ID
                        WHERE f.BUCKET = :bucket 
                        AND f.OBJECT_NAME IN ({placeholders})
                    """
                    
                    # パラメータを構築
                    params = {'bucket': bucket}
                    for i, name in enumerate(object_names):
                        params[f'obj_{i}'] = name
                    
                    cursor.execute(query, params)
                    rows = cursor.fetchall()
                    
                    for row in rows:
                        object_name = row[0]
                        has_embeddings = row[1] == 1
                        result[object_name] = has_embeddings
                    
                    logger.info(f"ベクトル化状態取得完了: {len(rows)}件のファイルを確認")
                    return result
                
        except Exception as e:
            logger.error(f"ベクトル化状態取得エラー: {e}")
            return result
    
    def search_similar_images(self, query_embedding: np.ndarray, limit: int = 10, threshold: float = 0.7, filename_filter: Optional[str] = None) -> Optional[List[Dict[str, Any]]]:
        """
        類似画像を検索します（2テーブルJOIN、接続プール経由）。
            
        Args:
            query_embedding (np.ndarray): 検索用のembeddingベクトル
            limit (int): 最大取得件数
            threshold (float): 類似度閾値（0.0-1.0）
            filename_filter (Optional[str]): ファイル名部分一致フィルタ（任意）
                
        Returns:
            Optional[List[Dict[str, Any]]]: 類似画像のリスト（FILE_INFOとIMG_EMBEDDINGSをJOINした結果）、失敗時はNone
        """
        try:
            if not self._ensure_pool_initialized():
                logger.error("接続プールの初期化に失敗")
                return None
                
            with self._get_pool_manager().acquire_connection() as connection:
                # NumPy配列をFLOAT32配列に変換
                embedding_array = array.array("f", query_embedding.tolist())
                    
                with connection.cursor() as cursor:
                    # FILE_INFOとIMG_EMBEDDINGSをJOINしてベクトル検索
                    # filename_filterが指定されている場合はLIKE検索を追加（大文字小文字を区別しない）
                    where_clause = "VECTOR_DISTANCE(ie.EMBEDDING, :query_embedding, COSINE) <= :threshold"
                    if filename_filter:
                        where_clause += " AND UPPER(f.ORIGINAL_FILENAME) LIKE UPPER(:filename_filter)"
                    
                    sql = f"""
                    SELECT 
                        ie.ID as embed_id,
                        ie.FILE_ID as file_id,
                        ie.BUCKET as bucket,
                        ie.OBJECT_NAME as object_name,
                        ie.PAGE_NUMBER as page_number,
                        ie.CONTENT_TYPE as content_type,
                        ie.FILE_SIZE as img_file_size,
                        f.BUCKET as file_bucket,
                        f.OBJECT_NAME as file_object_name,
                        f.ORIGINAL_FILENAME as original_filename,
                        f.FILE_SIZE as file_size,
                        f.CONTENT_TYPE as file_content_type,
                        f.UPLOADED_AT as uploaded_at,
                        VECTOR_DISTANCE(ie.EMBEDDING, :query_embedding, COSINE) as vector_distance
                    FROM 
                        IMG_EMBEDDINGS ie
                    INNER JOIN 
                        FILE_INFO f ON ie.FILE_ID = f.FILE_ID
                    WHERE 
                        {where_clause}
                    ORDER BY 
                        vector_distance
                    FETCH FIRST :limit ROWS ONLY
                    """
                    
                    # パラメータ設定
                    params = {
                        'query_embedding': embedding_array,
                        'threshold': threshold,
                        'limit': limit
                    }
                    if filename_filter:
                        params['filename_filter'] = f'%{filename_filter}%'
                        
                    cursor.execute(sql, params)
                        
                    results = []
                    for row in cursor:
                        # タイムスタンプをISO形式に変換
                        uploaded_at = row[12]
                        uploaded_at_str = uploaded_at.isoformat() if uploaded_at else None
                            
                        results.append({
                            'embed_id': row[0],
                            'file_id': row[1],
                            'bucket': row[2],
                            'object_name': row[3],
                            'page_number': row[4],
                            'content_type': row[5],
                            'img_file_size': row[6],
                            'file_bucket': row[7],
                            'file_object_name': row[8],
                            'original_filename': row[9],
                            'file_size': row[10],
                            'file_content_type': row[11],
                            'uploaded_at': uploaded_at_str,
                            'vector_distance': float(row[13])
                        })
                    
                    filter_info = f", filename_filter='{filename_filter}'" if filename_filter else ""
                    logger.info(f"ベクトル検索完了: {len(results)}件の画像がマッチ, threshold={threshold}{filter_info}")
                    return results
                    
        except Exception as e:
            logger.error(f"ベクトル検索エラー: {e}", exc_info=True)
            return None
    
    async def search_similar_images_async(self, query_embedding: np.ndarray, limit: int = 10, threshold: float = 0.7, filename_filter: Optional[str] = None) -> Optional[List[Dict[str, Any]]]:
        """
        非同期バージョン: 類似画像を検索します（イベントループをブロックしない）。
            
        接続プールを使用し、asyncio.to_thread()で同期メソッドを非同期実行します。
            
        Args:
            query_embedding (np.ndarray): 検索用のembeddingベクトル
            limit (int): 最大取得件数
            threshold (float): 類似度閾値（0.0-1.0）
            filename_filter (Optional[str]): ファイル名部分一致フィルタ（任意）
                
        Returns:
            Optional[List[Dict[str, Any]]]: 類似画像のリスト、または失敗時はNone
        """
        import asyncio
            
        try:
            logger.info("非同期ベクトル検索: 接続プール経由で実行")
                
            # 同期メソッドをスレッドプールで非同期実行（イベントループをブロックしない）
            results = await asyncio.to_thread(
                self.search_similar_images,
                query_embedding,
                limit,
                threshold,
                filename_filter
            )
                
            if results is not None:
                logger.info(f"非同期ベクトル検索完了: {len(results)}件の画像がマッチ")
            else:
                logger.warning("非同期ベクトル検索: 結果なし")
                
            return results
                
        except Exception as e:
            logger.error(f"非同期ベクトル検索エラー: {e}", exc_info=True)
            return None


# グローバルインスタンス
image_vectorizer = ImageVectorizer()
