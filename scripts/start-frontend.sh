#!/usr/bin/env bash
# Semantic Doc Search Frontend dev server launcher (Vite)
# Usage examples:
#   ./scripts/start-frontend.sh
#   FRONTEND_PORT=5174 ./scripts/start-frontend.sh
#   FRONTEND_PORT=5174 VITE_API_BASE=http://localhost:8081 ./scripts/start-frontend.sh
# Notes:
#   - Requires: Node.js + npm
#   - Will install frontend deps if node_modules is missing
#   - Pass VITE_API_BASE to point the UI at your backend

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PORT="${FRONTEND_PORT:-5175}"

if ! command -v node >/dev/null 2>&1; then
  echo "[フロントエンド] ERROR: 'node' が見つかりません (Node.js 18+ をインストールしてください)" 1>&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "[フロントエンド] ERROR: 'npm' が見つかりません" 1>&2
  exit 1
fi

echo "[フロントエンド] Vite Proxyを使用してバックエンドに接続 (/api -> http://localhost:8081)"

if command -v lsof >/dev/null 2>&1; then
  PIDS="$(lsof -PiTCP:"$PORT" -sTCP:LISTEN -t || true)"
  if [ -n "$PIDS" ]; then
    if [ "${FRONTEND_KILL_EXISTING:-}" = "1" ] || [ "${FRONTEND_KILL_EXISTING:-}" = "true" ]; then
      echo "[フロントエンド] ポート ${PORT} が使用中です。停止中: ${PIDS}"
      kill $PIDS || true
      sleep 1
    else
      echo "[フロントエンド] ERROR: ポート ${PORT} が既に使用中です (pids: ${PIDS})" 1>&2
      echo "          FRONTEND_PORTを変更するか、FRONTEND_KILL_EXISTING=1 で停止してください。" 1>&2
      exit 1
    fi
  fi
fi

echo "[フロントエンド] 依存関係を確認中"
if [ ! -d "frontend/node_modules" ]; then
  echo "[フロントエンド] npm install 実行中..."
  (cd frontend && npm install)
fi

echo "[フロントエンド] Vite dev server をポート ${PORT} で起動中"
cd frontend
exec npm run dev -- --port "$PORT"
