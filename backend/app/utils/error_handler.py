"""
共通エラーハンドリングユーティリティ

このモジュールは、APIエンドポイント全体で一貫したエラー処理を提供します。
"""
import functools
import logging
from typing import Any, Callable

from fastapi import HTTPException
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)


def handle_api_errors(func: Callable) -> Callable:
    """
    APIエンドポイント用の共通エラーハンドリングデコレータ
    
    使用例:
        @app.get("/api/example")
        @handle_api_errors
        async def example_endpoint():
            # 処理
            return {"success": True}
    
    Args:
        func: デコレートする関数
        
    Returns:
        ラップされた関数
    """
    @functools.wraps(func)
    async def wrapper(*args, **kwargs):
        try:
            return await func(*args, **kwargs)
        except HTTPException:
            # HTTPExceptionはそのまま伝播
            raise
        except ValueError as e:
            # バリデーションエラー
            logger.error(f"バリデーションエラー in {func.__name__}: {e}")
            return JSONResponse(
                status_code=400,
                content={"success": False, "message": f"入力値に問題があります: {str(e)}"}
            )
        except KeyError as e:
            # 必須パラメータ不足
            logger.error(f"必須パラメータ不足 in {func.__name__}: {e}")
            return JSONResponse(
                status_code=400,
                content={"success": False, "message": f"必須パラメータが不足しています: {str(e)}"}
            )
        except Exception as e:
            # 予期しないエラー
            logger.error(f"予期しないエラー in {func.__name__}: {e}", exc_info=True)
            return JSONResponse(
                status_code=500,
                content={"success": False, "message": f"サーバー処理に失敗しました: {str(e)}"}
            )
    
    return wrapper


def handle_sync_errors(func: Callable) -> Callable:
    """
    同期関数用の共通エラーハンドリングデコレータ
    
    使用例:
        @app.get("/api/sync-example")
        @handle_sync_errors
        def sync_example():
            # 処理
            return {"success": True}
    
    Args:
        func: デコレートする関数
        
    Returns:
        ラップされた関数
    """
    @functools.wraps(func)
    def wrapper(*args, **kwargs):
        try:
            return func(*args, **kwargs)
        except HTTPException:
            raise
        except ValueError as e:
            logger.error(f"バリデーションエラー in {func.__name__}: {e}")
            return JSONResponse(
                status_code=400,
                content={"success": False, "message": f"入力値に問題があります: {str(e)}"}
            )
        except KeyError as e:
            logger.error(f"必須パラメータ不足 in {func.__name__}: {e}")
            return JSONResponse(
                status_code=400,
                content={"success": False, "message": f"必須パラメータが不足しています: {str(e)}"}
            )
        except Exception as e:
            logger.error(f"予期しないエラー in {func.__name__}: {e}", exc_info=True)
            return JSONResponse(
                status_code=500,
                content={"success": False, "message": f"サーバー処理に失敗しました: {str(e)}"}
            )
    
    return wrapper


class APIError(Exception):
    """カスタムAPIエラークラス"""
    def __init__(self, message: str, status_code: int = 500, details: Any = None):
        self.message = message
        self.status_code = status_code
        self.details = details
        super().__init__(self.message)


def raise_api_error(message: str, status_code: int = 500, details: Any = None):
    """
    APIエラーを発生させる便利関数
    
    Args:
        message: エラーメッセージ
        status_code: HTTPステータスコード
        details: 追加の詳細情報
    """
    raise HTTPException(
        status_code=status_code,
        detail={"message": message, "details": details} if details else message
    )
