#!/usr/bin/env bash
# Semantic Doc Search Backend dev server launcher
# Usage:
#   BACKEND_PORT=8081 ./scripts/start-backend.sh
# Notes:
#   - Requires: uv (https://astral.sh)
#   - This will run `uv sync` for backend/ and then start uvicorn with --reload.

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../" && pwd)"
cd "$ROOT_DIR"

# .envファイルから環境変数を読み込み
if [ -f "$ROOT_DIR/.env" ]; then
  export $(grep -v '^#' "$ROOT_DIR/.env" | xargs)
fi

# Oracle Client環境変数を設定
if [ -n "${ORACLE_CLIENT_LIB_DIR:-}" ]; then
  export TNS_ADMIN="${ORACLE_CLIENT_LIB_DIR}/network/admin"
  export LD_LIBRARY_PATH="${ORACLE_CLIENT_LIB_DIR}:${LD_LIBRARY_PATH:-}"
  echo "[バックエンド] Oracle Client設定:"
  echo "  ORACLE_CLIENT_LIB_DIR: ${ORACLE_CLIENT_LIB_DIR}"
  echo "  TNS_ADMIN: ${TNS_ADMIN}"
fi

PORT="${BACKEND_PORT:-8081}"

echo "[バックエンド] FastAPI dev serverをポート ${PORT} で起動中..."

if ! command -v uv >/dev/null 2>&1; then
  echo "[バックエンド] ERROR: 'uv' が見つかりません。" 1>&2
  echo "         uvをインストール:  curl -LsSf https://astral.sh/uv/install.sh | sh" 1>&2
  exit 1
fi

if command -v lsof >/dev/null 2>&1; then
  PIDS="$(lsof -PiTCP:"$PORT" -sTCP:LISTEN -t || true)"
  if [ -n "$PIDS" ]; then
    if [ "${BACKEND_KILL_EXISTING:-}" = "1" ] || [ "${BACKEND_KILL_EXISTING:-}" = "true" ]; then
      echo "[バックエンド] ポート ${PORT} が使用中です。停止中: ${PIDS}"
      kill $PIDS || true
      sleep 1
    else
      echo "[バックエンド] ERROR: ポート ${PORT} が既に使用中です (pids: ${PIDS})" 1>&2
      echo "         BACKEND_PORTを変更するか、BACKEND_KILL_EXISTING=1 で停止してください。" 1>&2
      exit 1
    fi
  fi
fi

echo "[バックエンド] Python依存関係をuvで同期中 (backend/)"
uv sync --directory backend

echo "[バックエンド] uvicorn app.main:app を自動リロードで起動 (0.0.0.0:${PORT})"
exec uv run --directory backend uvicorn app.main:app --reload --host 0.0.0.0 --port "$PORT"
