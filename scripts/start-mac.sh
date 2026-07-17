#!/usr/bin/env bash
# macOS 上でバックエンドとフロントエンドをまとめて起動する。

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_PORT="${BACKEND_PORT:-8081}"
FRONTEND_PORT="${FRONTEND_PORT:-5175}"
BACKEND_PID=""
FRONTEND_PID=""

cleanup() {
  local pid
  trap - EXIT INT TERM

  for pid in "$FRONTEND_PID" "$BACKEND_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1 || true
    fi
  done

  for pid in "$FRONTEND_PID" "$BACKEND_PID"; do
    if [ -n "$pid" ]; then
      wait "$pid" >/dev/null 2>&1 || true
    fi
  done
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ "$(uname -s)" != "Darwin" ]; then
  echo "[Mac起動] ERROR: このスクリプトはmacOS専用です。" >&2
  exit 1
fi

if [ ! -f "$ROOT_DIR/.env" ]; then
  echo "[Mac起動] ERROR: .envがありません。先に ./scripts/setup-mac.sh を実行してください。" >&2
  exit 1
fi

echo "[Mac起動] バックエンドを起動します (port: ${BACKEND_PORT})..."
BACKEND_PORT="$BACKEND_PORT" "$ROOT_DIR/scripts/start-backend.sh" &
BACKEND_PID=$!

echo "[Mac起動] フロントエンドを起動します (port: ${FRONTEND_PORT})..."
FRONTEND_PORT="$FRONTEND_PORT" \
  VITE_PROXY_TARGET="http://127.0.0.1:${BACKEND_PORT}" \
  "$ROOT_DIR/scripts/start-frontend.sh" &
FRONTEND_PID=$!

echo ""
echo "[Mac起動] 起動処理を開始しました。"
echo "  アプリ: http://localhost:${FRONTEND_PORT}/ai/"
echo "  API:    http://localhost:${BACKEND_PORT}/docs"
echo "  終了:   Control-C"
echo ""

while kill -0 "$BACKEND_PID" >/dev/null 2>&1 && kill -0 "$FRONTEND_PID" >/dev/null 2>&1; do
  sleep 1
done

exit_code=0
if ! kill -0 "$BACKEND_PID" >/dev/null 2>&1; then
  wait "$BACKEND_PID" || exit_code=$?
  echo "[Mac起動] バックエンドが終了しました。" >&2
fi
if ! kill -0 "$FRONTEND_PID" >/dev/null 2>&1; then
  wait "$FRONTEND_PID" || exit_code=$?
  echo "[Mac起動] フロントエンドが終了しました。" >&2
fi

exit "$exit_code"
