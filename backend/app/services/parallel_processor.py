"""
並列処理マネージャー
ページ画像化（ProcessPool）とベクトル化（ThreadPool）を管理

このモジュールは以下の機能を提供します：
- ProcessPoolExecutorによるCPU集中型処理の並列化（ページ画像化）
- ThreadPoolExecutorによるI/O集中型処理の並列化（ベクトル化）
- ジョブ管理とキャンセル機能
- 指数バックオフによるリトライ
- SSEイベント生成
"""
import asyncio
import io
import logging
import os
import random
import re
import shutil
import subprocess
import tempfile
import time
from concurrent.futures import Future, ProcessPoolExecutor, ThreadPoolExecutor, as_completed
from dataclasses import dataclass, field
from datetime import datetime
from functools import partial
from pathlib import Path
from typing import Any, AsyncGenerator, Callable, Dict, List, Optional, Tuple

from pdf2image import convert_from_path
from PIL import Image as PILImage

logger = logging.getLogger(__name__)


# ========================================
# ジョブ状態管理
# ========================================

@dataclass
class JobState:
    """ジョブ状態"""
    job_id: str
    status: str  # 'running' | 'completed' | 'cancelled' | 'failed'
    total_items: int
    completed_items: int = 0
    failed_items: int = 0
    cancel_requested: bool = False
    created_at: datetime = field(default_factory=datetime.now)
    
    # ファイルごとの状態追跡
    file_states: Dict[str, str] = field(default_factory=dict)  # file_name -> status


class JobManager:
    """ジョブライフサイクル管理"""
    _active_jobs: Dict[str, JobState] = {}
    _lock = asyncio.Lock()
    
    @classmethod
    async def create_job(cls, job_id: str, total_items: int) -> JobState:
        """新規ジョブを作成"""
        async with cls._lock:
            job = JobState(
                job_id=job_id, 
                status='running', 
                total_items=total_items
            )
            cls._active_jobs[job_id] = job
            logger.info(f"ジョブ作成: job_id={job_id}, total_items={total_items}")
            return job
    
    @classmethod
    def get_job(cls, job_id: str) -> Optional[JobState]:
        """ジョブを取得"""
        return cls._active_jobs.get(job_id)
    
    @classmethod
    def is_cancelled(cls, job_id: str) -> bool:
        """キャンセルリクエストされているか確認"""
        job = cls._active_jobs.get(job_id)
        return job.cancel_requested if job else False
    
    @classmethod
    async def cancel_job(cls, job_id: str) -> bool:
        """ジョブをキャンセル"""
        async with cls._lock:
            job = cls._active_jobs.get(job_id)
            if job and job.status == 'running':
                job.cancel_requested = True
                job.status = 'cancelled'
                logger.info(f"ジョブキャンセル: job_id={job_id}")
                return True
            return False
    
    @classmethod
    async def complete_job(cls, job_id: str, success: bool = True):
        """ジョブを完了"""
        async with cls._lock:
            job = cls._active_jobs.get(job_id)
            if job:
                job.status = 'completed' if success else 'failed'
                logger.info(f"ジョブ完了: job_id={job_id}, status={job.status}")
    
    @classmethod
    async def update_file_state(cls, job_id: str, file_name: str, state: str):
        """ファイルの状態を更新"""
        job = cls._active_jobs.get(job_id)
        if job:
            job.file_states[file_name] = state
    
    @classmethod
    async def increment_completed(cls, job_id: str):
        """完了数をインクリメント"""
        job = cls._active_jobs.get(job_id)
        if job:
            job.completed_items += 1
    
    @classmethod
    async def increment_failed(cls, job_id: str):
        """失敗数をインクリメント"""
        job = cls._active_jobs.get(job_id)
        if job:
            job.failed_items += 1
    
    @classmethod
    async def cleanup_old_jobs(cls, max_age_seconds: int = 3600):
        """古いジョブをクリーンアップ"""
        async with cls._lock:
            now = datetime.now()
            to_delete = []
            for job_id, job in cls._active_jobs.items():
                age = (now - job.created_at).total_seconds()
                if age > max_age_seconds and job.status != 'running':
                    to_delete.append(job_id)
            
            for job_id in to_delete:
                del cls._active_jobs[job_id]
                logger.info(f"古いジョブを削除: job_id={job_id}")


# ========================================
# ワーカー関数（ProcessPoolで実行）
# ========================================

def _convert_file_to_images_worker(
    file_content: bytes,
    file_ext: str,
    file_name: str
) -> Tuple[bool, List[Tuple[int, bytes]], str]:
    """
    ワーカープロセスで実行される画像変換関数
    
    Args:
        file_content: ファイルの内容（バイト列）
        file_ext: ファイル拡張子
        file_name: ファイル名（ログ用）
        
    Returns:
        Tuple[success, List[(page_number, png_bytes)], error_message]
    """
    temp_dir = None
    try:
        temp_dir = tempfile.mkdtemp()
        temp_file = Path(temp_dir) / f"temp.{file_ext}"
        temp_file.write_bytes(file_content)
        
        images = []
        
        if file_ext == 'pdf':
            pil_images = convert_from_path(str(temp_file), dpi=200, fmt='PNG')
            images = pil_images
        elif file_ext in ['ppt', 'pptx']:
            # LibreOfficeでPDFに変換
            subprocess.run(
                ['soffice', '--headless', '--convert-to', 'pdf', '--outdir', str(temp_dir), str(temp_file)],
                check=True,
                timeout=300
            )
            pdf_path = Path(temp_dir) / "temp.pdf"
            if pdf_path.exists():
                images = convert_from_path(str(pdf_path), dpi=200, fmt='PNG')
            else:
                return False, [], "PDF変換に失敗しました"
        elif file_ext in ['png', 'jpg', 'jpeg']:
            img = PILImage.open(temp_file)
            img_copy = img.copy()
            img.close()
            images = [img_copy]
        else:
            return False, [], f"サポートされていないファイル形式: {file_ext}"
        
        # 画像をバイト列に変換
        result_images = []
        for i, img in enumerate(images, start=1):
            img_bytes = io.BytesIO()
            img.save(img_bytes, format='PNG')
            img_bytes.seek(0)
            result_images.append((i, img_bytes.getvalue()))
        
        return True, result_images, ""
        
    except Exception as e:
        logger.error(f"画像変換エラー ({file_name}): {e}")
        return False, [], str(e)
    finally:
        if temp_dir and Path(temp_dir).exists():
            try:
                shutil.rmtree(temp_dir)
            except Exception as cleanup_error:
                logger.warning(f"一時ディレクトリ削除エラー: {cleanup_error}")


# ========================================
# 並列処理マネージャー
# ========================================

class ParallelProcessor:
    """並列処理マネージャー"""
    
    def __init__(
        self,
        image_workers: Optional[int] = None,
        vector_workers: Optional[int] = None,
        api_semaphore_limit: int = 5
    ):
        """
        Args:
            image_workers: ページ画像化の最大プロセス数（デフォルト: CPU数）
            vector_workers: ベクトル化の最大スレッド数（デフォルト: min(8, CPU数*2)）
            api_semaphore_limit: OCI API同時呼び出し数（デフォルト: 5、レート制限対応で調整）
        """
        # 環境変数から設定を読み込み
        cpu_count = os.cpu_count() or 4
        self.image_workers = image_workers or int(os.getenv('CONVERT_MAX_WORKERS', cpu_count))
        self.vector_workers = vector_workers or int(os.getenv('VECTORIZE_MAX_WORKERS', min(8, cpu_count * 2)))
        # レート制限対応のAPI同時呼び出し数制限（デフォルトをより保守的に設定）
        self.api_semaphore_limit = int(os.getenv('API_CONCURRENT_LIMIT', api_semaphore_limit))
        
        # リトライ設定
        self.max_retries = int(os.getenv('API_MAX_RETRIES', 5))
        self.retry_base_delay = float(os.getenv('API_RETRY_BASE_DELAY', 1.0))
        
        self._process_pool: Optional[ProcessPoolExecutor] = None
        self._thread_pool: Optional[ThreadPoolExecutor] = None
        self._api_semaphore: Optional[asyncio.Semaphore] = None
        
        logger.info(f"ParallelProcessor初期化: image_workers={self.image_workers}, "
                   f"vector_workers={self.vector_workers}, api_limit={self.api_semaphore_limit}")
    
    def _get_process_pool(self) -> ProcessPoolExecutor:
        """ProcessPoolを遅延初期化"""
        if self._process_pool is None:
            self._process_pool = ProcessPoolExecutor(max_workers=self.image_workers)
            logger.info(f"ProcessPoolExecutor作成: max_workers={self.image_workers}")
        return self._process_pool
    
    def _get_thread_pool(self) -> ThreadPoolExecutor:
        """ThreadPoolを遅延初期化"""
        if self._thread_pool is None:
            self._thread_pool = ThreadPoolExecutor(max_workers=self.vector_workers)
            logger.info(f"ThreadPoolExecutor作成: max_workers={self.vector_workers}")
        return self._thread_pool
    
    def _get_api_semaphore(self) -> asyncio.Semaphore:
        """APIセマフォを遅延初期化"""
        if self._api_semaphore is None:
            self._api_semaphore = asyncio.Semaphore(self.api_semaphore_limit)
        return self._api_semaphore
    
    async def process_image_conversion(
        self,
        object_names: List[str],
        oci_service: Any,
        job_id: str
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        複数ファイルを並列でページ画像化（真の並列処理版）
        
        Args:
            object_names: 変換するオブジェクト名のリスト
            oci_service: OCIサービスインスタンス
            job_id: ジョブID
            
        Yields:
            SSEイベント辞書
        """
        start_time = time.time()
        total_files = len(object_names)
        
        # ジョブ作成
        job = await JobManager.create_job(job_id, total_files)
        
        # 開始イベント
        yield {
            'type': 'start',
            'job_id': job_id,
            'total_files': total_files,
            'total_workers': self.image_workers
        }
        
        # Namespace取得
        namespace_result = oci_service.get_namespace()
        if not namespace_result.get("success"):
            yield {
                'type': 'error',
                'message': 'Namespace取得エラー'
            }
            return
        
        namespace = namespace_result.get("namespace")
        bucket_name = os.getenv("OCI_BUCKET")
        
        if not bucket_name:
            yield {
                'type': 'error',
                'message': 'OCI_BUCKET環境変数が設定されていません'
            }
            return
        
        # イベントキュー（並列タスクからイベントを収集）
        event_queue: asyncio.Queue = asyncio.Queue()
        
        # ProcessPool
        pool = self._get_process_pool()
        loop = asyncio.get_running_loop()
        
        # 処理結果を追跡（スレッドセーフ用にlock使用）
        results = []
        results_lock = asyncio.Lock()
        success_count = 0
        failed_count = 0
        completed_count = 0
        
        # 完了シグナル用のイベント
        all_tasks_done = asyncio.Event()
        
        async def process_single_file(file_idx: int, obj_name: str):
            """単一ファイルを処理（非同期）"""
            nonlocal success_count, failed_count, completed_count
            
            if JobManager.is_cancelled(job_id):
                return
            
            file_path = Path(obj_name)
            file_ext = file_path.suffix.lower().lstrip('.')
            file_name = file_path.stem
            
            # フォルダ名を決定
            parent_str = str(file_path.parent)
            if parent_str and parent_str != '.':
                folder_name = f"{parent_str}/{file_name}"
            else:
                folder_name = file_name
            
            try:
                # ファイルダウンロード（非同期化）
                file_content = await asyncio.to_thread(oci_service.download_object, obj_name)
                if not file_content:
                    await JobManager.increment_failed(job_id)
                    async with results_lock:
                        failed_count += 1
                        results.append({
                            'object_name': obj_name,
                            'success': False,
                            'message': 'ファイルが見つかりません'
                        })
                    await event_queue.put({
                        'type': 'file_error',
                        'file_index': file_idx,
                        'file_name': obj_name,
                        'total_files': total_files,
                        'error': 'ファイルが見つかりません'
                    })
                    
                    # リアルタイム進捗イベントを送信
                    await event_queue.put({
                        'type': 'progress_update',
                        'completed_count': success_count + failed_count,
                        'total_count': total_files,
                        'success_count': success_count,
                        'failed_count': failed_count
                    })
                    return
                
                # ファイル処理開始（待機中状態通知）
                await event_queue.put({
                    'type': 'file_start',
                    'file_index': file_idx,
                    'file_name': obj_name,
                    'total_files': total_files
                })
                
                # 処理中に更新
                await JobManager.update_file_state(job_id, obj_name, '画像化中')
                await event_queue.put({
                    'type': 'file_uploading',
                    'file_index': file_idx,
                    'file_name': obj_name,
                    'total_files': total_files
                })
                
                # ProcessPoolで変換（run_in_executorを直接使用）
                try:
                    success, page_images, error_msg = await loop.run_in_executor(
                        pool,
                        _convert_file_to_images_worker,
                        file_content,
                        file_ext,
                        obj_name
                    )
                except Exception as conv_error:
                    logger.error(f"画像変換実行エラー ({obj_name}): {conv_error}")
                    success, page_images, error_msg = False, [], str(conv_error)
                
                if JobManager.is_cancelled(job_id):
                    return
                
                if not success:
                    await JobManager.increment_failed(job_id)
                    async with results_lock:
                        failed_count += 1
                        results.append({
                            'object_name': obj_name,
                            'success': False,
                            'message': error_msg
                        })
                    await event_queue.put({
                        'type': 'file_error',
                        'file_index': file_idx,
                        'file_name': obj_name,
                        'total_files': total_files,
                        'error': error_msg
                    })
                    
                    # リアルタイム進捗イベントを送信
                    await event_queue.put({
                        'type': 'progress_update',
                        'completed_count': success_count + failed_count,
                        'total_count': total_files,
                        'success_count': success_count,
                        'failed_count': failed_count
                    })
                    return
                
                # 既存画像を削除（非同期化）
                existing_images_result = await asyncio.to_thread(
                    oci_service.list_objects,
                    bucket_name=bucket_name,
                    namespace=namespace,
                    prefix=f"{folder_name}/",
                    page_size=1000
                )
                
                if existing_images_result.get("success"):
                    existing_objects = existing_images_result.get("objects", [])
                    images_to_delete = [
                        obj.get("name", "") for obj in existing_objects
                        if not obj.get("name", "").endswith('/') and 
                        re.search(r'/page_\d{3}\.png$', obj.get("name", ""))
                    ]
                    
                    if images_to_delete:
                        await asyncio.to_thread(
                            oci_service.delete_objects,
                            bucket_name=bucket_name,
                            namespace=namespace,
                            object_names=images_to_delete
                        )
                        # Object Storageの一貫性を保証するため短時間待機
                        await asyncio.sleep(1.0)
                        logger.info(f"既存画像削除完了: {len(images_to_delete)}件 ({obj_name})")
                
                # 各ページをアップロード（非同期）
                total_pages = len(page_images)
                uploaded_count = 0
                
                for page_num, img_bytes in page_images:
                    if JobManager.is_cancelled(job_id):
                        return
                    
                    image_object_name = f"{folder_name}/page_{page_num:03d}.png"
                    
                    img_stream = io.BytesIO(img_bytes)
                    upload_success = await asyncio.to_thread(
                        oci_service.upload_file,
                        file_content=img_stream,
                        object_name=image_object_name,
                        content_type="image/png",
                        original_filename=f"page_{page_num:03d}.png",
                        file_size=len(img_bytes)
                    )
                    
                    if upload_success:
                        uploaded_count += 1
                    
                    # ページ進捗
                    await event_queue.put({
                        'type': 'page_progress',
                        'file_index': file_idx,
                        'file_name': obj_name,
                        'total_files': total_files,
                        'page_index': page_num,
                        'total_pages': total_pages
                    })
                
                # アップロード完了後、Object Storageの一貫性を保証するため短時間待機
                await asyncio.sleep(0.5)
                
                # アップロードされた画像を再確認
                verification_result = await asyncio.to_thread(
                    oci_service.list_objects,
                    bucket_name=bucket_name,
                    namespace=namespace,
                    prefix=f"{folder_name}/",
                    page_size=1000
                )
                
                if verification_result.get("success"):
                    verification_objects = verification_result.get("objects", [])
                    verified_count = sum(1 for obj in verification_objects 
                                       if re.search(r'/page_\d{3}\.png$', obj.get("name", "")))
                    if verified_count != total_pages:
                        logger.warning(f"アップロード検証: 期待{total_pages}ページ、実際{verified_count}ページ ({obj_name})")
                    else:
                        logger.info(f"アップロード検証成功: {verified_count}ページ ({obj_name})")
                
                # 完了
                await JobManager.update_file_state(job_id, obj_name, '完了')
                await JobManager.increment_completed(job_id)
                async with results_lock:
                    success_count += 1
                    results.append({
                        'object_name': obj_name,
                        'success': True,
                        'message': f'{uploaded_count}ページを画像化しました',
                        'image_count': uploaded_count,
                        'folder_name': folder_name
                    })
                
                # ファイル完了イベントを送信
                await event_queue.put({
                    'type': 'file_complete',
                    'file_index': file_idx,
                    'file_name': obj_name,
                    'total_files': total_files,
                    'image_count': uploaded_count,
                    'status': '完了'
                })
                
                # リアルタイム進捗イベントを送信（フロントエンドのUI即時更新用）
                await event_queue.put({
                    'type': 'progress_update',
                    'completed_count': success_count + failed_count,
                    'total_count': total_files,
                    'success_count': success_count,
                    'failed_count': failed_count
                })
                
            except Exception as e:
                await JobManager.increment_failed(job_id)
                async with results_lock:
                    failed_count += 1
                    results.append({
                        'object_name': obj_name,
                        'success': False,
                        'message': str(e)
                    })
                logger.error(f"ファイル処理エラー ({obj_name}): {e}")
                await event_queue.put({
                    'type': 'file_error',
                    'file_index': file_idx,
                    'file_name': obj_name,
                    'total_files': total_files,
                    'error': str(e)
                })
                
                # リアルタイム進捗イベントを送信（フロントエンドのUI即時更新用）
                await event_queue.put({
                    'type': 'progress_update',
                    'completed_count': success_count + failed_count,
                    'total_count': total_files,
                    'success_count': success_count,
                    'failed_count': failed_count
                })
            finally:
                async with results_lock:
                    completed_count += 1
                    if completed_count >= total_files:
                        all_tasks_done.set()
        
        # 並列タスクを作成・実行
        tasks = [
            asyncio.create_task(process_single_file(file_idx, obj_name))
            for file_idx, obj_name in enumerate(object_names, start=1)
        ]
        
        # イベント収集とタスク完了を同時に処理
        async def collect_events():
            """タスク完了までイベントを収集（ハートビート付き）"""
            heartbeat_interval = 2.0  # ハートビート間隔（秒）
            last_heartbeat = time.time()
            event_timeout = 0.5  # イベント待機タイムアウト（秒）
            
            while not all_tasks_done.is_set():
                try:
                    # タイムアウト付きでイベントを待機
                    event = await asyncio.wait_for(event_queue.get(), timeout=event_timeout)
                    yield event
                    last_heartbeat = time.time()  # イベント送信後にリセット
                except asyncio.TimeoutError:
                    # ハートビートを定期的に送信（接続維持のため）
                    current_time = time.time()
                    if current_time - last_heartbeat >= heartbeat_interval:
                        yield {
                            'type': 'heartbeat',
                            'timestamp': current_time,
                            'status': 'processing'
                        }
                        last_heartbeat = current_time
                    continue
            
            # 残りのイベントをすべて取得
            while not event_queue.empty():
                try:
                    event = event_queue.get_nowait()
                    yield event
                except Exception:
                    # QueueEmptyを含む例外をキャッチ
                    break
        
        # イベントをyield
        async for event in collect_events():
            yield event
        
        # すべてのタスクの完了を待機（確実に完了させる）
        await asyncio.gather(*tasks, return_exceptions=True)
        
        # 完了処理
        elapsed_time = time.time() - start_time
        
        if JobManager.is_cancelled(job_id):
            yield {
                'type': 'cancelled',
                'message': f'処理がキャンセルされました。完了: {success_count}件、未処理: {total_files - success_count - failed_count}件',
                'success_count': success_count,
                'failed_count': failed_count,
                'elapsed_time': elapsed_time
            }
        else:
            await JobManager.complete_job(job_id, failed_count == 0)
            
            overall_success = failed_count == 0
            summary_message = f"ページ画像化完了: 成功 {success_count}件、失敗 {failed_count}件"
            
            yield {
                'type': 'complete',
                'success': overall_success,
                'message': summary_message,
                'total_files': total_files,
                'success_count': success_count,
                'failed_count': failed_count,
                'elapsed_time': elapsed_time,
                'results': results
            }
            
            # クライアントが最後のイベントを確実に受信できるように短時間待機
            await asyncio.sleep(0.1)
            
            # 完了通知イベント（状態が完全に同期されたことを保証）
            yield {
                'type': 'sync_complete',
                'message': 'すべての処理が完了し、状態が同期されました',
                'timestamp': time.time()
            }
    
    async def process_vectorization(
        self,
        object_names: List[str],
        oci_service: Any,
        image_vectorizer: Any,
        job_id: str
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        複数ファイルを並列でベクトル化（真の並列処理版）
        
        Args:
            object_names: ベクトル化するオブジェクト名のリスト
            oci_service: OCIサービスインスタンス
            image_vectorizer: ImageVectorizerインスタンス
            job_id: ジョブID
            
        Yields:
            SSEイベント辞書
        """
        start_time = time.time()
        total_files = len(object_names)
        
        # ジョブ作成
        job = await JobManager.create_job(job_id, total_files)
        
        # 開始イベント
        yield {
            'type': 'start',
            'job_id': job_id,
            'total_files': total_files,
            'total_workers': self.vector_workers
        }
        
        # Namespace取得
        namespace_result = oci_service.get_namespace()
        if not namespace_result.get("success"):
            yield {
                'type': 'error',
                'message': 'Namespace取得エラー'
            }
            return
        
        namespace = namespace_result.get("namespace")
        bucket_name = os.getenv("OCI_BUCKET")
        
        if not bucket_name:
            yield {
                'type': 'error',
                'message': 'OCI_BUCKET環境変数が設定されていません'
            }
            return
        
        # イベントキュー（並列タスクからイベントを収集）
        event_queue: asyncio.Queue = asyncio.Queue()
        
        # セマフォ（API呼び出し同時実行数制限）
        semaphore = self._get_api_semaphore()
        
        # 処理結果を追跡（スレッドセーフ用にlock使用）
        results = []
        results_lock = asyncio.Lock()
        success_count = 0
        failed_count = 0
        completed_count = 0
        
        # 完了シグナル用のイベント
        all_tasks_done = asyncio.Event()
        
        async def process_single_file(file_idx: int, obj_name: str):
            """単一ファイルを処理（非同期・並列）"""
            nonlocal success_count, failed_count, completed_count
            
            if JobManager.is_cancelled(job_id):
                return
            
            result = {
                'object_name': obj_name,
                'success': False,
                'message': '',
                'embedding_count': 0,
                'folder_name': ''
            }
            
            try:
                file_path = Path(obj_name)
                file_name = file_path.stem
                file_ext = file_path.suffix.lower().lstrip('.')
                
                # フォルダ名を決定
                parent_str = str(file_path.parent)
                if parent_str and parent_str != '.':
                    folder_name = f"{parent_str}/{file_name}"
                else:
                    folder_name = file_name
                
                result['folder_name'] = folder_name
                
                # ファイル処理開始（待機中状態通知）
                await event_queue.put({
                    'type': 'file_start',
                    'file_index': file_idx,
                    'file_name': obj_name,
                    'total_files': total_files
                })
                
                # 処理中に更新（DBチェック中）
                await JobManager.update_file_state(job_id, obj_name, 'DB確認中')
                await event_queue.put({
                    'type': 'file_checking',
                    'file_index': file_idx,
                    'file_name': obj_name,
                    'total_files': total_files
                })
                
                # FILE_IDを取得または作成（非同期化）
                file_id = await asyncio.to_thread(
                    image_vectorizer.get_file_id_by_object_name, bucket_name, obj_name
                )
                
                # ファイルコンテンツを先に定義（スコープ問題回避）
                file_content = None
                
                if file_id:
                    # 既存の画像イメージやembeddingを削除
                    await event_queue.put({
                        'type': 'delete_existing_embeddings',
                        'file_index': file_idx,
                        'file_name': obj_name,
                        'file_id': file_id
                    })
                    await asyncio.to_thread(image_vectorizer.delete_file_embeddings, file_id)
                    
                    # 既存のページ画像を削除
                    await event_queue.put({
                        'type': 'cleanup_start',
                        'file_index': file_idx,
                        'file_name': obj_name,
                        'total_files': total_files
                    })
                    
                    # ページ画像フォルダ内のファイルを取得
                    page_images_to_delete_result = await asyncio.to_thread(
                        oci_service.list_objects,
                        bucket_name=bucket_name,
                        namespace=namespace,
                        prefix=f"{folder_name}/",
                        page_size=1000
                    )
                    
                    page_images_to_delete = []
                    if page_images_to_delete_result.get("success"):
                        objects = page_images_to_delete_result.get("objects", [])
                        for obj in objects:
                            obj_name_str = obj.get("name", "")
                            # フォルダ自体は除外し、ページ画像のみを対象
                            if not obj_name_str.endswith('/'):
                                page_images_to_delete.append(obj_name_str)
                    
                    if page_images_to_delete:
                        await event_queue.put({
                            'type': 'cleanup_progress',
                            'file_index': file_idx,
                            'file_name': obj_name,
                            'total_files': total_files,
                            'cleanup_count': len(page_images_to_delete)
                        })
                        
                        # 既存のページ画像を削除（並列）
                        async def delete_page_image(page_image_name: str):
                            try:
                                async with semaphore:
                                    await asyncio.to_thread(
                                        oci_service.delete_object,
                                        object_name=page_image_name
                                    )
                                    return True
                            except Exception as e:
                                logger.error(f"ページ画像削除エラー ({page_image_name}): {e}")
                                return False
                        
                        delete_tasks = [delete_page_image(img) for img in page_images_to_delete]
                        await asyncio.gather(*delete_tasks, return_exceptions=True)
                        
                        await event_queue.put({
                            'type': 'cleanup_complete',
                            'file_index': file_idx,
                            'file_name': obj_name,
                            'total_files': total_files,
                            'deleted_count': len(page_images_to_delete)
                        })
                    
                else:
                    # 新規ファイル情報を保存
                    file_content = await asyncio.to_thread(oci_service.download_object, obj_name)
                    if not file_content:
                        result['message'] = 'ファイルが見つかりません'
                        await JobManager.increment_failed(job_id)
                        async with results_lock:
                            failed_count += 1
                            results.append(result)
                        await event_queue.put({
                            'type': 'file_error',
                            'file_index': file_idx,
                            'file_name': obj_name,
                            'total_files': total_files,
                            'error': result['message']
                        })
                        
                        # リアルタイム進捗イベントを送信
                        await event_queue.put({
                            'type': 'progress_update',
                            'completed_count': success_count + failed_count,
                            'total_count': total_files,
                            'success_count': success_count,
                            'failed_count': failed_count
                        })
                        return
                    
                    file_size = len(file_content)
                    content_type = f"application/{file_ext}"
                    
                    # OCIメタデータからoriginal_filenameを取得（プレフィクスなしの元のファイル名）
                    metadata_result = await asyncio.to_thread(
                        oci_service.get_object_metadata,
                        bucket_name=bucket_name,
                        namespace=namespace,
                        object_name=obj_name
                    )
                    
                    # メタデータからoriginal_filenameを取得、失敗時はフォールバック
                    if metadata_result.get('success') and metadata_result.get('original_filename'):
                        clean_filename = metadata_result.get('original_filename')
                    else:
                        # フォールバック: プレフィクスを除去
                        prefix_pattern = r'^\d{8}_\d{6}_[a-f0-9]{8}_'
                        clean_filename = re.sub(prefix_pattern, '', file_path.name)
                    
                    file_id = await asyncio.to_thread(
                        image_vectorizer.save_file_info,
                        bucket=bucket_name,
                        object_name=obj_name,
                        original_filename=clean_filename,
                        file_size=file_size,
                        content_type=content_type
                    )
                    
                    if not file_id:
                        result['message'] = 'ファイル情報保存エラー'
                        await JobManager.increment_failed(job_id)
                        async with results_lock:
                            failed_count += 1
                            results.append(result)
                        await event_queue.put({
                            'type': 'file_error',
                            'file_index': file_idx,
                            'file_name': obj_name,
                            'total_files': total_files,
                            'error': result['message']
                        })
                        return
                
                # Object Storageの一貫性を保証するため短時間待機（ページ画像化直後の場合）
                await asyncio.sleep(0.3)
                
                # ページ画像を取得（非同期化、リトライ付き）
                max_retries = 3
                page_images = []
                for retry in range(max_retries):
                    page_images_result = await asyncio.to_thread(
                        oci_service.list_objects,
                        bucket_name=bucket_name,
                        namespace=namespace,
                        prefix=f"{folder_name}/",
                        page_size=1000
                    )
                    
                    page_images = []
                    if page_images_result.get("success"):
                        objects = page_images_result.get("objects", [])
                        for obj in objects:
                            obj_name_str = obj.get("name", "")
                            if not obj_name_str.endswith('/') and re.search(r'/page_\d{3}\.png$', obj_name_str):
                                page_images.append(obj_name_str)
                    
                    if page_images:
                        break
                    
                    # リトライ前に待機
                    if retry < max_retries - 1:
                        logger.warning(f"ページ画像取得リトライ {retry + 1}/{max_retries}: {obj_name}")
                        await asyncio.sleep(1.0)
                
                page_images.sort()
                
                # ページ画像が見つからない場合、自動的にページ画像化を実行
                if not page_images:
                    logger.info(f"自動的にページ画像化を実行: {obj_name}")
                    await event_queue.put({
                        'type': 'auto_convert_start',
                        'file_index': file_idx,
                        'file_name': obj_name,
                        'total_files': total_files,
                        'message': '自動的にページ画像化を開始しています...'
                    })
                    
                    # ページ画像化を実行
                    try:
                        # キャンセルチェック
                        if JobManager.is_cancelled(job_id):
                            return
                        
                        # ファイルコンテンツが既に存在するか確認
                        if file_content is None:
                            # ファイルをダウンロード
                            file_content = await asyncio.to_thread(oci_service.download_object, obj_name)
                            if not file_content:
                                result['message'] = 'ファイルのダウンロードに失敗しました'
                                await JobManager.increment_failed(job_id)
                                async with results_lock:
                                    failed_count += 1
                                    results.append(result)
                                await event_queue.put({
                                    'type': 'file_error',
                                    'file_index': file_idx,
                                    'file_name': obj_name,
                                    'total_files': total_files,
                                    'error': result['message']
                                })
                                await event_queue.put({
                                    'type': 'progress_update',
                                    'completed_count': success_count + failed_count,
                                    'total_count': total_files,
                                    'success_count': success_count,
                                    'failed_count': failed_count
                                })
                                return
                        
                        # file_idがない場合、FILE_INFOテーブルにファイル情報を保存
                        if not file_id:
                            file_size = len(file_content)
                            content_type = f"application/{file_ext}"
                            
                            # OCIメタデータからoriginal_filenameを取得
                            metadata_result = await asyncio.to_thread(
                                oci_service.get_object_metadata,
                                bucket_name=bucket_name,
                                namespace=namespace,
                                object_name=obj_name
                            )
                            
                            # メタデータからoriginal_filenameを取得、失敗時はフォールバック
                            if metadata_result.get('success') and metadata_result.get('original_filename'):
                                clean_filename = metadata_result.get('original_filename')
                            else:
                                # フォールバック: プレフィクスを除去
                                prefix_pattern = r'^\d{8}_\d{6}_[a-f0-9]{8}_'
                                clean_filename = re.sub(prefix_pattern, '', file_path.name)
                            
                            file_id = await asyncio.to_thread(
                                image_vectorizer.save_file_info,
                                bucket=bucket_name,
                                object_name=obj_name,
                                original_filename=clean_filename,
                                file_size=file_size,
                                content_type=content_type
                            )
                            
                            if not file_id:
                                result['message'] = 'ファイル情報保存エラー'
                                await JobManager.increment_failed(job_id)
                                async with results_lock:
                                    failed_count += 1
                                    results.append(result)
                                await event_queue.put({
                                    'type': 'file_error',
                                    'file_index': file_idx,
                                    'file_name': obj_name,
                                    'total_files': total_files,
                                    'error': result['message']
                                })
                                
                                # リアルタイム進捗イベントを送信
                                await event_queue.put({
                                    'type': 'progress_update',
                                    'completed_count': success_count + failed_count,
                                    'total_count': total_files,
                                    'success_count': success_count,
                                    'failed_count': failed_count
                                })
                                return
                        
                        # キャンセルチェック
                        if JobManager.is_cancelled(job_id):
                            return
                        
                        # ワーカープロセスで画像変換を実行
                        loop = asyncio.get_event_loop()
                        process_pool = self._get_process_pool()
                        
                        convert_future = process_pool.submit(
                            _convert_file_to_images_worker,
                            file_content,
                            file_ext,
                            obj_name
                        )
                        
                        # 非同期で結果を待機
                        success, converted_images, error_msg = await loop.run_in_executor(None, convert_future.result)
                        
                        # キャンセルチェック
                        if JobManager.is_cancelled(job_id):
                            return
                        
                        if not success:
                            result['message'] = f'ページ画像化に失敗しました: {error_msg}'
                            await JobManager.increment_failed(job_id)
                            async with results_lock:
                                failed_count += 1
                                results.append(result)
                            await event_queue.put({
                                'type': 'file_error',
                                'file_index': file_idx,
                                'file_name': obj_name,
                                'total_files': total_files,
                                'error': result['message']
                            })
                            
                            # リアルタイム進捗イベントを送信
                            await event_queue.put({
                                'type': 'progress_update',
                                'completed_count': success_count + failed_count,
                                'total_count': total_files,
                                'success_count': success_count,
                                'failed_count': failed_count
                            })
                            return
                        
                        # 変換した画像をObject Storageにアップロード
                        total_converted_pages = len(converted_images)
                        await event_queue.put({
                            'type': 'auto_convert_progress',
                            'file_index': file_idx,
                            'file_name': obj_name,
                            'total_pages': total_converted_pages,
                            'message': f'{total_converted_pages}ページの画像変換完了。アップロード中...'
                        })
                        
                        # 並列アップロード（セマフォで制限）
                        async def upload_single_page(page_num: int, img_bytes: bytes) -> dict:
                            """1ページをアップロード"""
                            page_file_name = f"{folder_name}/page_{page_num:03d}.png"
                            async with semaphore:
                                if JobManager.is_cancelled(job_id):
                                    return {'success': False, 'page': page_num}
                                try:
                                    result = await asyncio.to_thread(
                                        oci_service.upload_file,
                                        file_content=img_bytes,
                                        object_name=page_file_name,
                                        content_type="image/png"
                                    )
                                    return {'success': result, 'page': page_num}
                                except Exception as e:
                                    logger.error(f"ページ {page_num} アップロードエラー: {e}")
                                    return {'success': False, 'page': page_num, 'error': str(e)}
                        
                        # 全ページを並列アップロード
                        upload_tasks = [
                            upload_single_page(page_num, img_bytes)
                            for page_num, img_bytes in converted_images
                        ]
                        upload_results = await asyncio.gather(*upload_tasks, return_exceptions=True)
                        
                        # キャンセルチェック
                        if JobManager.is_cancelled(job_id):
                            return
                        
                        # アップロード結果を確認
                        successful_uploads = 0
                        failed_uploads = []
                        for i, result_item in enumerate(upload_results, start=1):
                            if isinstance(result_item, Exception):
                                logger.error(f"ページ {i} アップロード例外: {result_item}")
                                failed_uploads.append(i)
                            elif isinstance(result_item, dict) and result_item.get('success'):
                                successful_uploads += 1
                            else:
                                failed_uploads.append(i)
                        
                        # アップロードが全て失敗した場合はエラー
                        if successful_uploads == 0:
                            result['message'] = 'ページ画像のアップロードが全て失敗しました'
                            await JobManager.increment_failed(job_id)
                            async with results_lock:
                                failed_count += 1
                                results.append(result)
                            await event_queue.put({
                                'type': 'file_error',
                                'file_index': file_idx,
                                'file_name': obj_name,
                                'total_files': total_files,
                                'error': result['message']
                            })
                            return
                        
                        # アップロードが部分的に失敗した場合は警告
                        if successful_uploads < total_converted_pages:
                            warning_msg = f'ページ画像のアップロードが部分的に失敗しました: {successful_uploads}/{total_converted_pages} (失敗ページ: {failed_uploads})'
                            logger.warning(warning_msg)
                            await event_queue.put({
                                'type': 'auto_convert_complete',
                                'file_index': file_idx,
                                'file_name': obj_name,
                                'total_pages': successful_uploads,
                                'message': f'ページ画像化完了: {successful_uploads}ページ (警告: {len(failed_uploads)}ページ失敗)'
                            })
                        else:
                            await event_queue.put({
                                'type': 'auto_convert_complete',
                                'file_index': file_idx,
                                'file_name': obj_name,
                                'total_pages': successful_uploads,
                                'message': f'ページ画像化完了: {successful_uploads}ページ'
                            })
                        
                        # Object Storageの一貫性を保証するため待機
                        await asyncio.sleep(1.0)
                        
                        # 再度ページ画像を取得
                        page_images_result = await asyncio.to_thread(
                            oci_service.list_objects,
                            bucket_name=bucket_name,
                            namespace=namespace,
                            prefix=f"{folder_name}/",
                            page_size=1000
                        )
                        
                        page_images = []
                        if page_images_result.get("success"):
                            objects = page_images_result.get("objects", [])
                            for obj in objects:
                                obj_name_str = obj.get("name", "")
                                if not obj_name_str.endswith('/') and re.search(r'/page_\d{3}\.png$', obj_name_str):
                                    page_images.append(obj_name_str)
                        
                        page_images.sort()
                        
                        if not page_images:
                            result['message'] = 'ページ画像化後もページ画像が見つかりません'
                            await JobManager.increment_failed(job_id)
                            async with results_lock:
                                failed_count += 1
                                results.append(result)
                            await event_queue.put({
                                'type': 'file_error',
                                'file_index': file_idx,
                                'file_name': obj_name,
                                'total_files': total_files,
                                'error': result['message']
                            })
                            await event_queue.put({
                                'type': 'progress_update',
                                'completed_count': success_count + failed_count,
                                'total_count': total_files,
                                'success_count': success_count,
                                'failed_count': failed_count
                            })
                            return
                        
                    except Exception as convert_error:
                        logger.error(f"自動ページ画像化エラー: {convert_error}", exc_info=True)
                        result['message'] = f'自動ページ画像化に失敗しました: {str(convert_error)}'
                        await JobManager.increment_failed(job_id)
                        async with results_lock:
                            failed_count += 1
                            results.append(result)
                        await event_queue.put({
                            'type': 'file_error',
                            'file_index': file_idx,
                            'file_name': obj_name,
                            'total_files': total_files,
                            'error': result['message']
                        })
                        await event_queue.put({
                            'type': 'progress_update',
                            'completed_count': success_count + failed_count,
                            'total_count': total_files,
                            'success_count': success_count,
                            'failed_count': failed_count
                        })
                        return
                
                total_pages = len(page_images)
                
                await event_queue.put({
                    'type': 'vectorize_start',
                    'file_index': file_idx,
                    'file_name': obj_name,
                    'total_pages': total_pages
                })
                
                # ベクトル化をリトライ付きで実行（最大3回）
                max_vectorize_retries = 3
                embedding_count = 0
                failed_pages = []
                embedding_count_lock = asyncio.Lock()
                
                # ページベクトル化関数（ループの外で定義）
                async def vectorize_page(page_idx: int, page_image_name: str) -> bool:
                    """単一ページをベクトル化（セマフォ付き）"""
                    nonlocal embedding_count
                    
                    async with semaphore:
                        if JobManager.is_cancelled(job_id):
                            return False
                        
                        try:
                            # 画像をダウンロード（非同期化）
                            image_content = await asyncio.to_thread(
                                oci_service.download_object, page_image_name
                            )
                            if not image_content:
                                logger.warning(f"画像が見つかりません: {page_image_name}")
                                return False
                            
                            image_bytes = io.BytesIO(image_content)
                            
                            # リトライ付きでEmbedding生成（BytesIOの位置をリセットするためlambda内でseek）
                            def generate_embedding_with_seek():
                                image_bytes.seek(0)
                                return image_vectorizer.generate_embedding(image_bytes, "image/png")
                            
                            embedding = await self._retry_with_backoff(generate_embedding_with_seek)
                            
                            if embedding is None:
                                logger.warning(f"Embedding生成失敗: {page_image_name}")
                                return False
                            
                            # DBに保存（非同期化）
                            embedding_id = await asyncio.to_thread(
                                image_vectorizer.save_image_embedding,
                                file_id=file_id,
                                bucket=bucket_name,
                                object_name=page_image_name,
                                page_number=page_idx,
                                content_type="image/png",
                                file_size=len(image_content),
                                embedding=embedding
                            )
                            
                            if embedding_id:
                                async with embedding_count_lock:
                                    embedding_count += 1
                                return True
                            return False
                            
                        except Exception as e:
                            logger.error(f"ページベクトル化エラー ({page_image_name}): {e}")
                            return False
                
                # 初回は全ページを処理対象に
                pages_to_process = list(enumerate(page_images, start=1))
                
                for vectorize_attempt in range(max_vectorize_retries):
                    if JobManager.is_cancelled(job_id):
                        break
                    
                    # リトライの場合、失敗したページのみを再処理
                    if vectorize_attempt > 0:
                        if not failed_pages:
                            break  # すべて成功したので終了
                        
                        logger.warning(f"ベクトル化リトライ {vectorize_attempt}/{max_vectorize_retries - 1}: {len(failed_pages)}ページ ({obj_name})")
                        await event_queue.put({
                            'type': 'vectorize_retry',
                            'file_index': file_idx,
                            'file_name': obj_name,
                            'retry_attempt': vectorize_attempt,
                            'failed_pages': len(failed_pages),
                            'total_pages': total_pages
                        })
                        # リトライ前に待機
                        await asyncio.sleep(2.0)
                        pages_to_process = failed_pages.copy()
                    
                    # 各試行で失敗ページをリセット
                    failed_pages = []
                    
                    # 並列でページをベクトル化（asyncio.gatherで真の並列実行）
                    page_tasks = [
                        (page_idx, page_image_name, asyncio.create_task(vectorize_page(page_idx, page_image_name)))
                        for page_idx, page_image_name in pages_to_process
                    ]
                    
                    # ページ処理を並列で待機し、失敗したページを記録
                    for page_idx, page_image_name, task in page_tasks:
                        if JobManager.is_cancelled(job_id):
                            task.cancel()
                            continue
                        
                        try:
                            success = await task
                            if not success:
                                failed_pages.append((page_idx, page_image_name))
                        except asyncio.CancelledError:
                            failed_pages.append((page_idx, page_image_name))
                        except Exception as e:
                            logger.error(f"ページタスク実行エラー ({page_image_name}): {e}")
                            failed_pages.append((page_idx, page_image_name))
                        
                        await event_queue.put({
                            'type': 'page_progress',
                            'file_index': file_idx,
                            'file_name': obj_name,
                            'total_files': total_files,
                            'page_index': page_idx,
                            'total_pages': total_pages
                        })
                    
                    # 数量検証：すべてのページがベクトル化されたかチェック
                    if embedding_count == total_pages:
                        logger.info(f"ベクトル化成功: {embedding_count}/{total_pages}ページ ({obj_name})")
                        break  # 成功したのでループを抜ける
                    elif vectorize_attempt < max_vectorize_retries - 1:
                        logger.warning(f"ベクトル化数量不一致: {embedding_count}/{total_pages}ページ、リトライします ({obj_name})")
                    else:
                        logger.error(f"ベクトル化数量不一致（最大リトライ到達）: {embedding_count}/{total_pages}ページ ({obj_name})")
                
                # 最終結果の判定
                if embedding_count == total_pages:
                    result['success'] = True
                    result['message'] = f'{embedding_count}ページをベクトル化しました'
                elif embedding_count > 0:
                    result['success'] = False
                    result['message'] = f'ベクトル化が一部失敗しました: {embedding_count}/{total_pages}ページ（{len(failed_pages)}ページ失敗）'
                    result['failed_pages'] = [page_idx for page_idx, _ in failed_pages]
                else:
                    result['success'] = False
                    result['message'] = f'ベクトル化に完全に失敗しました: 0/{total_pages}ページ'
                
                result['embedding_count'] = embedding_count
                result['expected_count'] = total_pages
                
                # 成功/失敗の判定
                if result['success']:
                    await JobManager.update_file_state(job_id, obj_name, '完了')
                    await JobManager.increment_completed(job_id)
                    async with results_lock:
                        success_count += 1
                        results.append(result)
                    
                    # ファイル完了イベントを送信
                    await event_queue.put({
                        'type': 'file_complete',
                        'file_index': file_idx,
                        'file_name': obj_name,
                        'total_files': total_files,
                        'embedding_count': embedding_count,
                        'expected_count': total_pages,
                        'status': '完了'
                    })
                    
                    # リアルタイム進捗イベントを送信（フロントエンドのUI即時更新用）
                    await event_queue.put({
                        'type': 'progress_update',
                        'completed_count': success_count + failed_count,
                        'total_count': total_files,
                        'success_count': success_count,
                        'failed_count': failed_count
                    })
                else:
                    # 一部失敗または完全失敗
                    await JobManager.update_file_state(job_id, obj_name, '一部失敗' if embedding_count > 0 else '失敗')
                    await JobManager.increment_failed(job_id)
                    async with results_lock:
                        failed_count += 1
                        results.append(result)
                    
                    await event_queue.put({
                        'type': 'file_partial_failure' if embedding_count > 0 else 'file_error',
                        'file_index': file_idx,
                        'file_name': obj_name,
                        'total_files': total_files,
                        'embedding_count': embedding_count,
                        'expected_count': total_pages,
                        'failed_pages': result.get('failed_pages', []),
                        'status': '一部失敗' if embedding_count > 0 else '失敗',
                        'error': result['message']
                    })
                    
                    # リアルタイム進捗イベントを送信（フロントエンドのUI即時更新用）
                    await event_queue.put({
                        'type': 'progress_update',
                        'completed_count': success_count + failed_count,
                        'total_count': total_files,
                        'success_count': success_count,
                        'failed_count': failed_count
                    })
                
            except Exception as e:
                result['message'] = f'処理エラー: {str(e)}'
                await JobManager.increment_failed(job_id)
                async with results_lock:
                    failed_count += 1
                    results.append(result)
                logger.error(f"ベクトル化エラー ({obj_name}): {e}", exc_info=True)
                
                await event_queue.put({
                    'type': 'file_error',
                    'file_index': file_idx,
                    'file_name': obj_name,
                    'total_files': total_files,
                    'error': str(e)
                })
                
                # リアルタイム進捗イベントを送信（フロントエンドのUI即時更新用）
                await event_queue.put({
                    'type': 'progress_update',
                    'completed_count': success_count + failed_count,
                    'total_count': total_files,
                    'success_count': success_count,
                    'failed_count': failed_count
                })
            finally:
                async with results_lock:
                    completed_count += 1
                    if completed_count >= total_files:
                        all_tasks_done.set()
        
        # 並列タスクを作成・実行
        tasks = [
            asyncio.create_task(process_single_file(file_idx, obj_name))
            for file_idx, obj_name in enumerate(object_names, start=1)
        ]
        
        # イベント収集とタスク完了を同時に処理
        async def collect_events():
            """タスク完了までイベントを収集（ハートビート付き）"""
            heartbeat_interval = 2.0  # ハートビート間隔（秒）
            last_heartbeat = time.time()
            event_timeout = 0.5  # イベント待機タイムアウト（秒）
            
            while not all_tasks_done.is_set():
                try:
                    # タイムアウト付きでイベントを待機
                    event = await asyncio.wait_for(event_queue.get(), timeout=event_timeout)
                    yield event
                    last_heartbeat = time.time()  # イベント送信後にリセット
                except asyncio.TimeoutError:
                    # ハートビートを定期的に送信（接続維持のため）
                    current_time = time.time()
                    if current_time - last_heartbeat >= heartbeat_interval:
                        yield {
                            'type': 'heartbeat',
                            'timestamp': current_time,
                            'status': 'processing'
                        }
                        last_heartbeat = current_time
                    continue
            
            # 残りのイベントをすべて取得
            while not event_queue.empty():
                try:
                    event = event_queue.get_nowait()
                    yield event
                except Exception:
                    # QueueEmptyを含む例外をキャッチ
                    break
        
        # イベントをyield
        async for event in collect_events():
            yield event
        
        # すべてのタスクの完了を待機（確実に完了させる）
        await asyncio.gather(*tasks, return_exceptions=True)
        
        # 完了処理
        elapsed_time = time.time() - start_time
        
        if JobManager.is_cancelled(job_id):
            yield {
                'type': 'cancelled',
                'message': f'処理がキャンセルされました。完了: {success_count}件、未処理: {total_files - success_count - failed_count}件',
                'success_count': success_count,
                'failed_count': failed_count,
                'elapsed_time': elapsed_time
            }
        else:
            await JobManager.complete_job(job_id, failed_count == 0)
            
            overall_success = failed_count == 0
            summary_message = f"ベクトル化完了: 成功 {success_count}件、失敗 {failed_count}件"
            
            yield {
                'type': 'complete',
                'success': overall_success,
                'message': summary_message,
                'total_files': total_files,
                'success_count': success_count,
                'failed_count': failed_count,
                'elapsed_time': elapsed_time,
                'results': results
            }
            
            # クライアントが最後のイベントを確実に受信できるように短時間待機
            await asyncio.sleep(0.1)
            
            # 完了通知イベント（状態が完全に同期されたことを保証）
            yield {
                'type': 'sync_complete',
                'message': 'すべての処理が完了し、状態が同期されました',
                'timestamp': time.time()
            }
    
    async def _retry_with_backoff(
        self,
        func: Callable,
        max_retries: Optional[int] = None,
        base_delay: Optional[float] = None
    ) -> Any:
        """
        指数バックオフリトライ
        
        Args:
            func: 実行する関数
            max_retries: 最大リトライ回数
            base_delay: 基本待機時間（秒）
            
        Returns:
            関数の戻り値
        """
        max_retries = max_retries or self.max_retries
        base_delay = base_delay or self.retry_base_delay
        
        for attempt in range(max_retries):
            try:
                result = await asyncio.to_thread(func)
                return result
            except Exception as e:
                if attempt == max_retries - 1:
                    raise
                
                # Rate Limitエラーの場合は長めに待機
                error_str = str(e).lower()
                if '429' in error_str or 'too many' in error_str or 'rate' in error_str:
                    # レート制限エラーの場合は指数バックオフを強化
                    delay = base_delay * (4 ** attempt) + random.uniform(0, 2)
                    logger.warning(f"レート制限エラー検出、長めの待機時間: {delay:.1f}秒")
                else:
                    delay = base_delay * (2 ** attempt) + random.uniform(0, 1)
                
                logger.warning(f"リトライ {attempt + 1}/{max_retries}, {delay:.1f}秒後に再試行: {e}")
                await asyncio.sleep(delay)
        
        return None
    
    def cancel_job(self, job_id: str) -> bool:
        """ジョブをキャンセル（同期版）"""
        job = JobManager.get_job(job_id)
        if job and job.status == 'running':
            job.cancel_requested = True
            job.status = 'cancelled'
            logger.info(f"ジョブキャンセル: job_id={job_id}")
            return True
        return False
    
    async def shutdown(self):
        """グレースフルシャットダウン"""
        logger.info("ParallelProcessorをシャットダウン中...")
        
        if self._process_pool:
            self._process_pool.shutdown(wait=True)
            self._process_pool = None
            logger.info("ProcessPoolExecutorをシャットダウンしました")
        
        if self._thread_pool:
            self._thread_pool.shutdown(wait=True)
            self._thread_pool = None
            logger.info("ThreadPoolExecutorをシャットダウンしました")
        
        logger.info("ParallelProcessorシャットダウン完了")
    
    async def process_deletion(
        self,
        object_names: List[str],
        oci_service: Any,
        image_vectorizer: Any,
        database_service: Any,
        job_id: str
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        複数オブジェクトを並列で削除（SSEストリーミング対応）
        
        削除順序:
        1. object_nameからFILE_IDを取得
        2. FILE_INFOテーブルのレコード削除（IMG_EMBEDDINGSはCASCADE自動削除）
        3. 生成された画像ファイル削除
        4. 生成された画像フォルダ削除
        5. ファイル本体削除
        
        Args:
            object_names: 削除するオブジェクト名のリスト
            oci_service: OCIサービスインスタンス
            image_vectorizer: 画像ベクトル化インスタンス
            database_service: データベースサービスインスタンス
            job_id: ジョブID
            
        Yields:
            SSEイベント辞書
        """
        start_time = time.time()
        total_files = len(object_names)
        
        # ジョブ作成
        job = await JobManager.create_job(job_id, total_files)
        
        # 開始イベント
        yield {
            'type': 'start',
            'job_id': job_id,
            'total_files': total_files
        }
        
        # Namespace取得
        namespace_result = oci_service.get_namespace()
        if not namespace_result.get("success"):
            yield {
                'type': 'error',
                'message': 'Namespace取得エラー'
            }
            return
        
        namespace = namespace_result.get("namespace")
        bucket_name = os.getenv("OCI_BUCKET")
        
        if not bucket_name:
            yield {
                'type': 'error',
                'message': 'OCI_BUCKET環境変数が設定されていません'
            }
            return
        
        # イベントキュー（並列タスクからイベントを収集）
        event_queue: asyncio.Queue = asyncio.Queue()
        
        # 処理結果を追跡（スレッドセーフ用にlock使用）
        results = []
        results_lock = asyncio.Lock()
        success_count = 0
        failed_count = 0
        completed_count = 0
        
        # 完了シグナル用のイベント
        all_tasks_done = asyncio.Event()
        
        async def delete_single_object(file_idx: int, obj_name: str):
            """単一オブジェクトを削除（非同期）"""
            nonlocal success_count, failed_count, completed_count
            
            if JobManager.is_cancelled(job_id):
                return
            
            result = {
                'object_name': obj_name,
                'success': False,
                'message': ''
            }
            
            try:
                # ファイル処理開始（待機中状態通知）
                await event_queue.put({
                    'type': 'file_start',
                    'file_index': file_idx,
                    'file_name': obj_name,
                    'total_files': total_files
                })
                
                # 削除中に更新
                await event_queue.put({
                    'type': 'file_uploading',
                    'file_index': file_idx,
                    'file_name': obj_name,
                    'total_files': total_files
                })
                
                # フォルダや画像ファイルはデータベース削除をスキップ
                if not (obj_name.endswith('/') or '/page_' in obj_name):
                    try:
                        # FILE_IDを取得
                        file_id = await asyncio.to_thread(
                            image_vectorizer.get_file_id_by_object_name,
                            bucket_name,
                            obj_name
                        )
                        
                        if file_id:
                            # FILE_INFOレコードを削除（IMG_EMBEDDINGSはCASCADE制約で自動削除）
                            delete_result = await asyncio.to_thread(
                                database_service.delete_file_info_records,
                                [str(file_id)]
                            )
                            
                            if not delete_result.get("success"):
                                logger.warning(f"データベース削除失敗: {delete_result.get('message')}")
                        
                    except Exception as db_error:
                        logger.error(f"データベース削除エラー: {obj_name}, {db_error}")
                
                # OCI Object Storageから削除
                delete_result = await asyncio.to_thread(
                    oci_service.delete_objects,
                    bucket_name=bucket_name,
                    namespace=namespace,
                    object_names=[obj_name]
                )
                
                if JobManager.is_cancelled(job_id):
                    return
                
                if delete_result.get('success'):
                    result['success'] = True
                    result['message'] = '削除完了'
                    await JobManager.increment_completed(job_id)
                    async with results_lock:
                        success_count += 1
                        results.append(result)
                    
                    # ファイル完了イベント
                    await event_queue.put({
                        'type': 'file_complete',
                        'file_index': file_idx,
                        'file_name': obj_name,
                        'total_files': total_files,
                        'status': '完了'
                    })
                    
                    # リアルタイム進捗イベントを送信（フロントエンドのUI即時更新用）
                    await event_queue.put({
                        'type': 'progress_update',
                        'completed_count': success_count + failed_count,
                        'total_count': total_files,
                        'success_count': success_count,
                        'failed_count': failed_count
                    })
                else:
                    result['message'] = delete_result.get('message', '削除失敗')
                    await JobManager.increment_failed(job_id)
                    async with results_lock:
                        failed_count += 1
                        results.append(result)
                    
                    await event_queue.put({
                        'type': 'file_error',
                        'file_index': file_idx,
                        'file_name': obj_name,
                        'total_files': total_files,
                        'error': result['message']
                    })
                    
                    # リアルタイム進捗イベントを送信（フロントエンドのUI即時更新用）
                    await event_queue.put({
                        'type': 'progress_update',
                        'completed_count': success_count + failed_count,
                        'total_count': total_files,
                        'success_count': success_count,
                        'failed_count': failed_count
                    })
                
            except Exception as e:
                result['message'] = f'削除エラー: {str(e)}'
                await JobManager.increment_failed(job_id)
                async with results_lock:
                    failed_count += 1
                    results.append(result)
                logger.error(f"削除エラー ({obj_name}): {e}")
                
                await event_queue.put({
                    'type': 'file_error',
                    'file_index': file_idx,
                    'file_name': obj_name,
                    'total_files': total_files,
                    'error': str(e)
                })
                
                # リアルタイム進捗イベントを送信（フロントエンドのUI即時更新用）
                await event_queue.put({
                    'type': 'progress_update',
                    'completed_count': success_count + failed_count,
                    'total_count': total_files,
                    'success_count': success_count,
                    'failed_count': failed_count
                })
            finally:
                async with results_lock:
                    completed_count += 1
                    if completed_count >= total_files:
                        all_tasks_done.set()
        
        # 並列タスクを作成・実行
        tasks = [
            asyncio.create_task(delete_single_object(file_idx, obj_name))
            for file_idx, obj_name in enumerate(object_names, start=1)
        ]
        
        # イベント収集とタスク完了を同時に処理
        async def collect_events():
            """タスク完了までイベントを収集（ハートビート付き）"""
            heartbeat_interval = 2.0  # ハートビート間隔（秒）
            last_heartbeat = time.time()
            event_timeout = 0.5  # イベント待機タイムアウト（秒）
            
            while not all_tasks_done.is_set():
                try:
                    # タイムアウト付きでイベントを待機
                    event = await asyncio.wait_for(event_queue.get(), timeout=event_timeout)
                    yield event
                    last_heartbeat = time.time()  # イベント送信後にリセット
                except asyncio.TimeoutError:
                    # ハートビートを定期的に送信（接続維持のため）
                    current_time = time.time()
                    if current_time - last_heartbeat >= heartbeat_interval:
                        yield {
                            'type': 'heartbeat',
                            'timestamp': current_time,
                            'status': 'processing'
                        }
                        last_heartbeat = current_time
                    continue
            
            # 残りのイベントをすべて取得
            while not event_queue.empty():
                try:
                    event = event_queue.get_nowait()
                    yield event
                except asyncio.QueueEmpty:
                    break
        
        # イベントをストリーミング
        async for event in collect_events():
            yield event
        
        # タスク完了を待機
        await asyncio.gather(*tasks, return_exceptions=True)
        
        # 完了イベント
        elapsed = time.time() - start_time
        overall_success = failed_count == 0
        
        yield {
            'type': 'complete',
            'success': overall_success,
            'message': f'削除完了: 成功 {success_count}件、失敗 {failed_count}件',
            'total_files': total_files,
            'success_count': success_count,
            'failed_count': failed_count,
            'elapsed_time': round(elapsed, 2)
        }



# グローバルインスタンス
parallel_processor = ParallelProcessor()
