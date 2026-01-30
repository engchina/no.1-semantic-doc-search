import os
import json
import oci
import logging
import configparser
import base64
from pathlib import Path
from dotenv import load_dotenv, find_dotenv
from typing import Dict, Any, Optional
from datetime import datetime
from app.models.oci import OCISettings

logger = logging.getLogger(__name__)

# .envファイルを読み込む
project_root = Path(__file__).parent.parent.parent
env_path = project_root / ".env"
if env_path.exists():
    load_dotenv(env_path)
elif find_dotenv():
    load_dotenv(find_dotenv())

# 環境変数から設定ファイルのパスを取得、デフォルトは ~/.oci/config
OCI_CONFIG_FILE = os.environ.get("OCI_CONFIG_FILE", os.path.expanduser("~/.oci/config"))
# キーファイルのパスは設定ファイルと同じディレクトリ内の oci_api_key.pem をデフォルトとする
OCI_KEY_FILE = os.environ.get("OCI_KEY_FILE", os.path.join(os.path.dirname(OCI_CONFIG_FILE), "oci_api_key.pem"))

class OCIService:
    def __init__(self):
        self.config_file = OCI_CONFIG_FILE
        self.key_file = OCI_KEY_FILE
        self._oci_config = None
        self._object_storage_client = None

    def get_settings(self) -> OCISettings:
        """保存された設定を読み込む"""
        # 環境変数から基本設定を取得
        bucket_name = os.environ.get("OCI_BUCKET")
        namespace = os.environ.get("OCI_NAMESPACE", "")  # 空でもOK
        region = os.environ.get("OCI_REGION")
        
        # Configファイルがない場合、環境変数のみで返す
        if not os.path.exists(self.config_file) or not os.path.exists(self.key_file):
            return OCISettings(
                region=region,
                bucket_name=bucket_name,
                namespace=namespace
            )
        
        try:
            # Configファイルを読み込む
            config = configparser.ConfigParser()
            config.read(self.config_file)
            
            if 'DEFAULT' not in config:
                return OCISettings(
                    region=region,
                    bucket_name=bucket_name,
                    namespace=namespace
                )
                
            defaults = config['DEFAULT']
            
            # Private Keyを読み込む
            # パーミッションを確認・修正
            if os.path.exists(self.key_file):
                os.chmod(self.key_file, 0o600)
                
            with open(self.key_file, 'r') as f:
                key_content = f.read()
            
            # Regionは環境変数を優先、なければconfigファイルから取得
            if not region:
                region = defaults.get('region')
                
            return OCISettings(
                user_ocid=defaults.get('user'),
                tenancy_ocid=defaults.get('tenancy'),
                fingerprint=defaults.get('fingerprint'),
                region=region,
                key_content=key_content,
                bucket_name=bucket_name,
                namespace=namespace
            )
        except Exception as e:
            logger.error(f"設定ファイルの読み込みエラー: {e}")
            return OCISettings(
                region=region,
                bucket_name=bucket_name,
                namespace=namespace
            )

    def save_settings(self, settings: OCISettings) -> bool:
        """設定を保存する"""
        try:
            # ディレクトリを作成
            config_dir = os.path.dirname(self.config_file)
            os.makedirs(config_dir, exist_ok=True)
            os.chmod(config_dir, 0o700)
            
            # Private Keyの処理: 新規アップロードがない場合は既存のキーを保持
            if settings.key_content and settings.key_content != '[CONFIGURED]':
                # 新しいキーが提供された場合のみ保存
                with open(self.key_file, 'w') as f:
                    f.write(settings.key_content)
                os.chmod(self.key_file, 0o600)
                logger.info("Private Keyを保存しました")
            elif not os.path.exists(self.key_file):
                # キーファイルが存在せず、新しいキーも提供されていない場合はエラー
                logger.error("Private Keyが必要です")
                return False
            # else: 既存のキーファイルをそのまま使用
            
            # Configファイルを保存（Regionを含む）
            config = configparser.ConfigParser()
            config['DEFAULT'] = {
                'user': settings.user_ocid,
                'fingerprint': settings.fingerprint,
                'tenancy': settings.tenancy_ocid,
                'region': settings.region,
                'key_file': self.key_file
            }
            
            with open(self.config_file, 'w') as f:
                config.write(f)
            
            # Configファイルのパーミッションも600に設定
            os.chmod(self.config_file, 0o600)
            
            logger.info(f"OCI設定を保存しました: config={self.config_file}, region={settings.region}")
                
            return True
        except Exception as e:
            logger.error(f"設定ファイルの保存エラー: {e}")
            return False

    def test_connection(self, settings: Optional[OCISettings] = None) -> Dict[str, Any]:
        """
        OCI接続テストを実行
        
        Args:
            settings: OCI設定(認証情報)
        """
        try:
            # 設定が渡されていない場合は保存済み設定を使用
            if settings is None:
                settings = self.get_settings()
            # キーが[CONFIGURED]の場合は既存のキーを読み込む
            elif settings.key_content == '[CONFIGURED]' and os.path.exists(self.key_file):
                with open(self.key_file, 'r') as f:
                    settings.key_content = f.read()
            
            # 必須フィールドのチェック
            if not all([settings.user_ocid, settings.tenancy_ocid, settings.fingerprint, settings.key_content, settings.region]):
                return {
                    "success": False,
                    "message": "認証情報が不完全です。User OCID, Tenancy OCID, Fingerprint, Region, Private Keyが必要です。"
                }
            
            # OCI設定を作成
            config = {
                "user": settings.user_ocid,
                "tenancy": settings.tenancy_ocid,
                "fingerprint": settings.fingerprint,
                "key_content": settings.key_content,
                "region": settings.region
            }
            
            # Identity Clientを使って接続テスト
            identity = oci.identity.IdentityClient(config)
            
            # ユーザー情報の取得を試行
            user = identity.get_user(config["user"]).data
            
            result = {
                "success": True,
                "message": "接続テストが成功しました",
                "details": {
                    "user_name": user.name,
                    "user_ocid": user.id,
                    "region": config["region"],
                    "tenancy": config["tenancy"]
                }
            }

            return result

        except Exception as e:
            logger.error(f"接続テストエラー: {e}")
            return {
                "success": False,
                "message": f"接続エラー: {str(e)}"
            }
    
    def get_oci_config(self) -> Dict[str, Any]:
        """OCI設定を取得"""
        if self._oci_config is None:
            settings = self.get_settings()
            if settings.key_content and settings.key_content != '[CONFIGURED]':
                self._oci_config = {
                    "user": settings.user_ocid,
                    "tenancy": settings.tenancy_ocid,
                    "fingerprint": settings.fingerprint,
                    "key_content": settings.key_content,
                    "region": settings.region
                }
        return self._oci_config
    
    def get_object_storage_client(self) -> oci.object_storage.ObjectStorageClient:
        """Object Storage Clientを取得（OCI_REGION_DEPLOYを使用）"""
        if self._object_storage_client is None:
            config = self.get_oci_config()
            if config:
                # Object Storageは OCI_REGION_DEPLOY を使用
                deploy_region = os.environ.get("OCI_REGION_DEPLOY")
                if deploy_region:
                    # 設定をコピーしてregionを上書き
                    storage_config = config.copy()
                    storage_config["region"] = deploy_region
                    logger.info(f"Object Storage ClientをOCI_REGION_DEPLOYで作成: {deploy_region}")
                    self._object_storage_client = oci.object_storage.ObjectStorageClient(storage_config)
                else:
                    # OCI_REGION_DEPLOYがない場合はデフォルトregionを使用
                    logger.warning("OCI_REGION_DEPLOYが設定されていません。OCI_REGIONを使用します")
                    self._object_storage_client = oci.object_storage.ObjectStorageClient(config)
        return self._object_storage_client
    
    def get_namespace(self) -> Dict[str, Any]:
        """
        Object StorageのNamespaceを取得
        環境変数から優先、空ならOCI SDKで取得
        
        Returns:
            namespace情報
        """
        try:
            # 環境変数から取得を試みる
            namespace_from_env = os.environ.get("OCI_NAMESPACE", "").strip()
            if namespace_from_env:
                logger.info(f"Namespaceを環境変数から取得: {namespace_from_env}")
                return {
                    "success": True,
                    "namespace": namespace_from_env,
                    "source": "env"
                }
            
            # 環境変数が空の場合、OCI SDKで取得
            client = self.get_object_storage_client()
            if not client:
                raise Exception("Object Storage Clientの取得に失敗しました")
            
            # Namespaceを取得
            namespace = client.get_namespace().data
            logger.info(f"NamespaceをOCI SDKから取得: {namespace}")
            
            return {
                "success": True,
                "namespace": namespace,
                "source": "api"
            }
            
        except Exception as e:
            logger.error(f"Namespace取得エラー: {e}")
            return {
                "success": False,
                "message": f"Namespace取得エラー: {str(e)}"
            }
    
    def save_object_storage_settings(self, bucket_name: str, namespace: str) -> Dict[str, Any]:
        """
        Object Storage設定を.envファイルに保存
        
        Args:
            bucket_name: バケット名
            namespace: ネームスペース
            
        Returns:
            保存結果
        """
        try:
            # .envファイルのパスを取得
            # backend/app/services/oci_service.py から 4階層上がプロジェクトルート
            project_root = Path(__file__).parent.parent.parent.parent
            env_path = project_root / ".env"
            
            logger.info(f".envファイルパス: {env_path}")
            logger.info(f".envファイル存在確認: {env_path.exists()}")
            
            if not env_path.exists():
                raise Exception(f".envファイルが見つかりません: {env_path}")
            
            # .envファイルを読み込む
            with open(env_path, 'r', encoding='utf-8') as f:
                lines = f.readlines()
            
            # 設定を更新
            bucket_updated = False
            namespace_updated = False
            new_lines = []
            
            for line in lines:
                if line.startswith('OCI_BUCKET='):
                    new_lines.append(f'OCI_BUCKET={bucket_name}\n')
                    bucket_updated = True
                elif line.startswith('OCI_NAMESPACE='):
                    new_lines.append(f'OCI_NAMESPACE={namespace}\n')
                    namespace_updated = True
                else:
                    new_lines.append(line)
            
            # 設定が存在しない場合は追加
            if not bucket_updated:
                # OCI_BUCKETを追加（OCI関連設定の後に）
                for i, line in enumerate(new_lines):
                    if line.startswith('OCI_REGION_DEPLOY=') or line.startswith('OCI_COMPARTMENT_OCID='):
                        new_lines.insert(i + 1, f'OCI_BUCKET={bucket_name}\n')
                        bucket_updated = True
                        break
                if not bucket_updated:
                    new_lines.append(f'OCI_BUCKET={bucket_name}\n')
            
            if not namespace_updated:
                # OCI_NAMESPACEを追加（OCI_BUCKETの後に）
                for i, line in enumerate(new_lines):
                    if line.startswith('OCI_BUCKET='):
                        new_lines.insert(i + 1, f'OCI_NAMESPACE={namespace}\n')
                        namespace_updated = True
                        break
                if not namespace_updated:
                    new_lines.append(f'OCI_NAMESPACE={namespace}\n')
            
            # ファイルに書き込む
            with open(env_path, 'w', encoding='utf-8') as f:
                f.writelines(new_lines)
            
            # 環境変数を更新（再読み込み）
            load_dotenv(env_path, override=True)
            
            logger.info(f"Object Storage設定を保存: bucket={bucket_name}, namespace={namespace}")
            
            return {
                "success": True,
                "message": "Object Storage設定を保存しました"
            }
            
        except Exception as e:
            logger.error(f"Object Storage設定保存エラー: {e}")
            return {
                "success": False,
                "message": f"Object Storage設定保存エラー: {str(e)}"
            }
    
    def list_objects(self, bucket_name: str, namespace: str, prefix: str = "", page_size: int = 50, page_token: Optional[str] = None, include_metadata: bool = False) -> Dict[str, Any]:
        """
        Object Storage内のオブジェクト一覧を取得
        
        Args:
            bucket_name: バケット名
            namespace: ネームスペース
            prefix: プレフィックス（フォルダパス）
            page_size: ページサイズ
            page_token: ページトークン（次ページ取得用）
            include_metadata: メタデータ（原始ファイル名など）を含めるか
            
        Returns:
            オブジェクト一覧とページ情報（階層構造情報付き）
        """
        try:
            client = self.get_object_storage_client()
            if not client:
                raise Exception("Object Storage Clientの取得に失敗しました")
            
            # オブジェクト一覧を取得
            kwargs = {
                "namespace_name": namespace,
                "bucket_name": bucket_name,
                "prefix": prefix,
                "limit": page_size,
                "fields": "name,size,timeCreated,md5"
            }
            
            if page_token:
                kwargs["start"] = page_token
                
            response = client.list_objects(**kwargs)
            
            # レスポンスを整形
            objects = []
            
            for obj in response.data.objects:
                # フォルダかファイルかを判定
                is_folder = obj.name.endswith('/')
                
                # 階層深度を計算（スラッシュの数で判定）
                depth = obj.name.count('/')
                if is_folder and depth > 0:
                    depth -= 1  # フォルダの場合、末尾の/を除外
                
                # 親パスを計算
                parent = None
                if '/' in obj.name:
                    parent = obj.name.rsplit('/', 2 if is_folder else 1)[0]
                    if parent and not parent.endswith('/'):
                        parent += '/'
                
                obj_data = {
                    "name": obj.name,
                    "size": obj.size if obj.size else 0,
                    "time_created": obj.time_created.isoformat() if obj.time_created else None,
                    "md5": obj.md5 if hasattr(obj, 'md5') else None,
                    "is_folder": is_folder,
                    "type": "folder" if is_folder else "file",
                    "depth": depth,
                    "parent": parent
                }
                
                # メタデータを含める場合（ファイルのみ）
                # 注意: 大量のファイルがある場合はパフォーマンス問題が発生する可能性があります
                if include_metadata and not is_folder:
                    try:
                        metadata_result = self.get_object_metadata(bucket_name, namespace, obj.name)
                        if metadata_result.get("success"):
                            obj_data["original_filename"] = metadata_result.get("original_filename")
                            obj_data["metadata"] = metadata_result.get("metadata", {})
                    except Exception as e:
                        logger.warning(f"メタデータ取得エラー: {obj.name} - {e}")
                        # エラーが発生してもオブジェクト名から推測
                        obj_data["original_filename"] = obj.name.split("/")[-1]
                
                objects.append(obj_data)
            
            return {
                "success": True,
                "objects": objects,
                "next_start_with": response.data.next_start_with,
                "prefixes": response.data.prefixes if hasattr(response.data, 'prefixes') else []
            }
            
        except Exception as e:
            logger.error(f"オブジェクト一覧取得エラー: {e}")
            return {
                "success": False,
                "message": f"オブジェクト一覧取得エラー: {str(e)}",
                "objects": [],
                "next_start_with": None,
                "prefixes": []
            }
    
    
    def upload_file(self, file_content, object_name: str, content_type: str = None, original_filename: str = None, file_size: int = None) -> bool:
        """
        ファイルをObject Storageにアップロード（メタデータ付き）
        
        Args:
            file_content: ファイル内容（バイナリデータまたはBytesIO）
            object_name: Object名（パス含む）
            content_type: Content-Type
            original_filename: 原始ファイル名（日本語・スペース対応）
            file_size: ファイルサイズ
            
        Returns:
            成功した場合True
        """
        try:
            client = self.get_object_storage_client()
            if not client:
                raise Exception("Object Storage Clientの取得に失敗しました")
            
            # 環境変数から設定を取得
            bucket_name = os.environ.get("OCI_BUCKET")
            if not bucket_name:
                raise Exception("OCI_BUCKETが設定されていません")
            
            # Namespaceを取得
            namespace_result = self.get_namespace()
            if not namespace_result.get("success"):
                raise Exception(namespace_result.get("message", "Namespace取得失敗"))
            
            namespace = namespace_result.get("namespace")
            
            # メタデータを準備（日本語対応のためbase64エンコード）
            opc_meta = {}
            if original_filename and original_filename.strip():  # 空白のみの文字列を除外
                try:
                    # ASCII文字のみかチェック
                    original_filename.strip().encode('latin-1')
                    opc_meta['original-filename'] = original_filename.strip()
                except UnicodeEncodeError:
                    # 非ASCII文字（日本語など）が含まれる場合はbase64エンコード
                    encoded_value = base64.b64encode(original_filename.strip().encode('utf-8')).decode('ascii')
                    opc_meta['original-filename-b64'] = encoded_value
                    logger.debug(f"ファイル名をbase64エンコード: {original_filename.strip()}")
            
            # その他のメタデータ
            if file_size is not None:
                opc_meta['file-size'] = str(file_size)
            
            opc_meta['upload-source'] = 'file'
            opc_meta['uploaded-at'] = datetime.now().isoformat()
            
            # Object Storageにアップロード
            put_object_kwargs = {
                "namespace_name": namespace,
                "bucket_name": bucket_name,
                "object_name": object_name,
                "put_object_body": file_content,
                "opc_meta": opc_meta
            }
            
            if content_type:
                put_object_kwargs["content_type"] = content_type
            
            client.put_object(**put_object_kwargs)
            
            logger.info(f"Object Storageアップロード成功: {object_name} (原始ファイル名: {original_filename})")
            return True
            
        except Exception as e:
            logger.error(f"Object Storageアップロードエラー: {e}")
            return False
    
    def get_object_metadata(self, bucket_name: str, namespace: str, object_name: str) -> Dict[str, Any]:
        """
        Object Storage内のオブジェクトのメタデータを取得
        
        Args:
            bucket_name: バケット名
            namespace: ネームスペース
            object_name: オブジェクト名
            
        Returns:
            メタデータ情報
        """
        try:
            client = self.get_object_storage_client()
            if not client:
                raise Exception("Object Storage Clientの取得に失敗しました")
            
            # HEADリクエストでメタデータを取得
            response = client.head_object(
                namespace_name=namespace,
                bucket_name=bucket_name,
                object_name=object_name
            )
            
            # メタデータを抽出（キーを正規化）
            metadata = {}
            if response.headers:
                # opc-meta-*で始まるヘッダーを抽出
                for key, value in response.headers.items():
                    if key.lower().startswith('opc-meta-'):
                        # キーを小文字に正規化（大文字小文字の不一致を防ぐ）
                        meta_key = key.lower()[9:]  # 'opc-meta-'を除去して小文字化
                        metadata[meta_key] = value
            
            # 原始ファイル名を復元（base64エンコードされている場合）
            original_filename = None
            if 'original-filename-b64' in metadata:
                try:
                    encoded_value = metadata['original-filename-b64']
                    original_filename = base64.b64decode(encoded_value).decode('utf-8')
                    logger.debug(f"base64ファイル名をデコード: {original_filename}")
                except Exception as e:
                    logger.warning(f"base64ファイル名のデコード失敗: {e}")
            
            # フォールバック: 通常のファイル名またはオブジェクト名
            if not original_filename:
                original_filename = metadata.get('original-filename', object_name.split("/")[-1])
            
            return {
                "success": True,
                "metadata": metadata,
                "original_filename": original_filename,
                "content_type": response.headers.get('Content-Type'),
                "content_length": response.headers.get('Content-Length'),
                "last_modified": response.headers.get('Last-Modified')
            }
            
        except Exception as e:
            logger.error(f"メタデータ取得エラー: {e}")
            return {
                "success": False,
                "message": f"メタデータ取得エラー: {str(e)}"
            }
    
    def delete_objects(self, bucket_name: str, namespace: str, object_names: list) -> Dict[str, Any]:
        """
        Object Storage内のオブジェクトを削除
        削除順序：画像ファイル → 画像フォルダ → ファイル本体
        
        Args:
            bucket_name: バケット名
            namespace: ネームスペース
            object_names: 削除するオブジェクト名のリスト
            
        Returns:
            削除結果
        """
        try:
            client = self.get_object_storage_client()
            if not client:
                raise Exception("Object Storage Clientの取得に失敗しました")
            
            success_count = 0
            failed_objects = []
            
            for obj_name in object_names:
                try:
                    # フォルダの場合は配下のオブジェクトも削除
                    if obj_name.endswith('/'):
                        # フォルダ配下のオブジェクトを取得（メタデータ不要）
                        prefix_objects = self.list_objects(
                            bucket_name, 
                            namespace, 
                            prefix=obj_name, 
                            page_size=1000, 
                            include_metadata=False  # 削除時はメタデータ不要
                        )
                        if prefix_objects.get("success"):
                            for sub_obj in prefix_objects.get("objects", []):
                                try:
                                    client.delete_object(
                                        namespace_name=namespace,
                                        bucket_name=bucket_name,
                                        object_name=sub_obj["name"]
                                    )
                                    success_count += 1
                                except Exception as sub_e:
                                    # ObjectNotFoundエラーは無視（既に削除済み）
                                    error_str = str(sub_e)
                                    if "ObjectNotFound" not in error_str and "404" not in error_str:
                                        logger.error(f"サブオブジェクト削除エラー: {sub_obj['name']} - {sub_e}")
                                        failed_objects.append(sub_obj["name"])
                        
                        # フォルダ自体も削除
                        try:
                            client.delete_object(
                                namespace_name=namespace,
                                bucket_name=bucket_name,
                                object_name=obj_name
                            )
                            success_count += 1
                        except Exception as folder_e:
                            # フォルダが存在しない場合はエラーを無視
                            error_str = str(folder_e)
                            if "ObjectNotFound" not in error_str and "NoSuchKey" not in error_str and "404" not in error_str:
                                logger.error(f"フォルダ削除エラー: {obj_name} - {folder_e}")
                                failed_objects.append(obj_name)
                    else:
                        # ファイルの場合：画像ファイル → 画像フォルダ → ファイル本体の順に削除
                        # ステップ1: ページ画像化で生成された画像ファイルを削除
                        # 注: 画像フォルダ名は「ファイル名.pdf/」ではなく「ファイル名/」（拡張子なし）
                        from pathlib import Path
                        file_path = Path(obj_name)
                        file_name_without_ext = file_path.stem  # 拡張子を除去
                        image_folder_name = file_name_without_ext + '/'
                        logger.info(f"画像フォルダ名: {image_folder_name} (元のファイル: {obj_name})")
                        try:
                            # 画像フォルダ配下のファイルを検索
                            image_objects = self.list_objects(
                                bucket_name,
                                namespace,
                                prefix=image_folder_name,
                                page_size=1000,
                                include_metadata=False
                            )
                            
                            logger.info(f"画像フォルダ検索結果: success={image_objects.get('success')}, objects_count={len(image_objects.get('objects', []))}")
                            
                            if image_objects.get("success"):
                                image_files = image_objects.get("objects", [])
                                if image_files:
                                    logger.info(f"画像ファイル削除開始: {len(image_files)}件 (フォルダ: {image_folder_name})")
                                    for img_obj in image_files:
                                        try:
                                            logger.debug(f"画像ファイル削除中: {img_obj['name']}")
                                            client.delete_object(
                                                namespace_name=namespace,
                                                bucket_name=bucket_name,
                                                object_name=img_obj["name"]
                                            )
                                            logger.debug(f"画像ファイル削除成功: {img_obj['name']}")
                                            success_count += 1
                                        except Exception as img_e:
                                            # ObjectNotFoundエラーは無視（既に削除済み）
                                            error_str = str(img_e)
                                            if "ObjectNotFound" not in error_str and "404" not in error_str:
                                                logger.error(f"画像ファイル削除エラー: {img_obj['name']} - {img_e}")
                                                failed_objects.append(img_obj["name"])
                                else:
                                    logger.info(f"画像ファイルなし: {image_folder_name}")
                        except Exception as folder_check_e:
                            # フォルダが存在しない場合はエラーを無視（画像化されていないファイル）
                            logger.debug(f"画像フォルダなし: {image_folder_name}")
                        
                        # ステップ2: 画像フォルダを削除
                        try:
                            client.delete_object(
                                namespace_name=namespace,
                                bucket_name=bucket_name,
                                object_name=image_folder_name
                            )
                            logger.info(f"画像フォルダ削除成功: {image_folder_name}")
                            success_count += 1
                        except Exception as folder_e:
                            # フォルダが存在しない場合はエラーを無視（ObjectNotFound or NoSuchKey）
                            error_str = str(folder_e)
                            if "ObjectNotFound" in error_str or "NoSuchKey" in error_str or "404" in error_str:
                                logger.debug(f"画像フォルダは存在しません: {image_folder_name}")
                            else:
                                logger.error(f"画像フォルダ削除エラー: {image_folder_name} - {folder_e}")
                                failed_objects.append(image_folder_name)
                        
                        # ステップ3: ファイル本体を削除
                        client.delete_object(
                            namespace_name=namespace,
                            bucket_name=bucket_name,
                            object_name=obj_name
                        )
                        logger.info(f"ファイル本体削除成功: {obj_name}")
                        success_count += 1
                        
                except Exception as e:
                    logger.error(f"オブジェクト削除エラー: {obj_name} - {e}")
                    failed_objects.append(obj_name)
            
            if failed_objects:
                return {
                    "success": False,
                    "message": f"{success_count}件削除成功、{len(failed_objects)}件失敗",
                    "success_count": success_count,
                    "failed_count": len(failed_objects),
                    "failed_objects": failed_objects
                }
            else:
                return {
                    "success": True,
                    "message": f"{success_count}件のオブジェクトを削除しました",
                    "success_count": success_count,
                    "failed_count": 0
                }
                
        except Exception as e:
            logger.error(f"オブジェクト削除エラー: {e}")
            return {
                "success": False,
                "message": f"オブジェクト削除エラー: {str(e)}"
            }
    
    def download_object(self, object_name: str) -> Optional[bytes]:
        """
        Object Storageからオブジェクトをダウンロード
        
        Args:
            object_name: オブジェクト名
            
        Returns:
            オブジェクトのバイナリデータ、失敗時はNone
        """
        try:
            client = self.get_object_storage_client()
            if not client:
                raise Exception("Object Storage Clientの取得に失敗しました")
            
            # 環境変数から設定を取得
            bucket_name = os.environ.get("OCI_BUCKET")
            if not bucket_name:
                raise Exception("OCI_BUCKETが設定されていません")
            
            # Namespaceを取得
            namespace_result = self.get_namespace()
            if not namespace_result.get("success"):
                raise Exception(namespace_result.get("message", "Namespace取得失敗"))
            
            namespace = namespace_result.get("namespace")
            
            # オブジェクトを取得
            response = client.get_object(
                namespace_name=namespace,
                bucket_name=bucket_name,
                object_name=object_name
            )
            
            # データを読み込む
            return response.data.content
            
        except Exception as e:
            logger.error(f"オブジェクトダウンロードエラー: {object_name} - {e}")
            return None

# シングルトンインスタンス
oci_service = OCIService()
