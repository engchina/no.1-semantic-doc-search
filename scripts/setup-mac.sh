#!/usr/bin/env bash
# macOS 用ローカル開発環境セットアップ
# Usage:
#   ./scripts/setup-mac.sh
#   ./scripts/setup-mac.sh /path/to/Wallet_xxx.zip

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CALLER_DIR="$PWD"
WALLET_ZIP="${1:-}"

usage() {
  cat <<'EOF'
使用方法:
  ./scripts/setup-mac.sh [Wallet ZIP]

Wallet ZIPを指定すると、ローカルのWalletディレクトリへ展開します。
指定しない場合も開発環境の依存関係と.envは準備されます。
EOF
}

if [ "$WALLET_ZIP" = "-h" ] || [ "$WALLET_ZIP" = "--help" ]; then
  usage
  exit 0
fi

if [ "$#" -gt 1 ]; then
  usage >&2
  exit 2
fi

if [ "$(uname -s)" != "Darwin" ]; then
  echo "[セットアップ] ERROR: このスクリプトはmacOS専用です。" >&2
  exit 1
fi

if ! command -v brew >/dev/null 2>&1; then
  for brew_bin in /opt/homebrew/bin /usr/local/bin; do
    if [ -x "${brew_bin}/brew" ]; then
      PATH="${brew_bin}:$PATH"
      break
    fi
  done
fi

if ! command -v brew >/dev/null 2>&1; then
  echo "[セットアップ] ERROR: Homebrewが見つかりません。" >&2
  echo "  https://brew.sh/ の手順でHomebrewをインストールしてから再実行してください。" >&2
  exit 1
fi

export PATH

install_formula_if_missing() {
  local formula="$1"
  local command_name="$2"

  if command -v "$command_name" >/dev/null 2>&1; then
    echo "[セットアップ] ${command_name} はインストール済みです。"
    return
  fi

  echo "[セットアップ] Homebrew formula ${formula} をインストールします..."
  brew install "$formula"
}

install_cask_if_missing() {
  local cask="$1"

  if brew list --cask "$cask" >/dev/null 2>&1; then
    echo "[セットアップ] Homebrew cask ${cask} はインストール済みです。"
    return
  fi

  echo "[セットアップ] Homebrew cask ${cask} をインストールします..."
  brew install --cask "$cask"
}

env_value() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key {sub(/^[^=]*=/, ""); value=$0} END {print value}' "$ROOT_DIR/.env"
}

set_env_value() {
  local key="$1"
  local value="$2"
  local temp_file

  temp_file="$(mktemp "${TMPDIR:-/tmp}/semantic-doc-search-env.XXXXXX")"
  awk -v key="$key" -v value="$value" '
    BEGIN { updated = 0 }
    index($0, key "=") == 1 {
      if (!updated) {
        print key "=" value
        updated = 1
      }
      next
    }
    { print }
    END {
      if (!updated) print key "=" value
    }
  ' "$ROOT_DIR/.env" > "$temp_file"
  chmod 600 "$temp_file"
  mv "$temp_file" "$ROOT_DIR/.env"
}

echo "[セットアップ] macOS用の依存関係を確認します..."

# init_script.sh の Node.js 20、uv、Poppler、LibreOffice、日本語フォントに対応。
node_major="0"
if command -v node >/dev/null 2>&1; then
  node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
fi
if [ "$node_major" -lt 20 ]; then
  echo "[セットアップ] Node.js 20をインストールします..."
  brew install node@20
fi

node20_prefix="$(brew --prefix node@20 2>/dev/null || true)"
if [ -n "$node20_prefix" ] && [ -d "${node20_prefix}/bin" ]; then
  PATH="${node20_prefix}/bin:$PATH"
fi

install_formula_if_missing uv uv
install_formula_if_missing poppler pdftoppm

if [ ! -x "/Applications/LibreOffice.app/Contents/MacOS/soffice" ] && ! command -v soffice >/dev/null 2>&1; then
  install_cask_if_missing libreoffice
fi
if [ -d "/Applications/LibreOffice.app/Contents/MacOS" ]; then
  PATH="/Applications/LibreOffice.app/Contents/MacOS:$PATH"
fi

if [ ! -f "$HOME/Library/Fonts/ipaexg.ttf" ] && [ ! -f "/Library/Fonts/ipaexg.ttf" ]; then
  install_cask_if_missing font-ipaexfont
fi
export PATH

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "[セットアップ] ERROR: Node.js/npmを利用できません。Homebrewのnode@20を確認してください。" >&2
  exit 1
fi

if ! command -v uv >/dev/null 2>&1; then
  echo "[セットアップ] ERROR: uvを利用できません。" >&2
  exit 1
fi

cd "$ROOT_DIR"

if [ ! -f .env ]; then
  cp .env.example .env
  chmod 600 .env
  env_created="true"
  echo "[セットアップ] .env.exampleから.envを作成しました。"
else
  env_created="false"
  echo "[セットアップ] 既存の.envを保持して使用します。"
fi

current_oracle_dir="$(env_value ORACLE_CLIENT_LIB_DIR)"
if [ -n "${ORACLE_CLIENT_LIB_DIR:-}" ]; then
  oracle_dir="$ORACLE_CLIENT_LIB_DIR"
elif [ -n "$current_oracle_dir" ] && [ "$current_oracle_dir" != "/u01/aipoc/instantclient_23_26" ]; then
  oracle_dir="$current_oracle_dir"
else
  oracle_dir="$ROOT_DIR/.local/oracle"
fi

mkdir -p "$oracle_dir/network/admin"
set_env_value ORACLE_CLIENT_LIB_DIR "$oracle_dir"

if [ "$(env_value OCI_CONFIG_FILE)" = "/root/.oci/config" ]; then
  set_env_value OCI_CONFIG_FILE "$HOME/.oci/config"
fi
if [ "$(env_value OCI_KEY_FILE)" = "/root/.oci/oci_api_key.pem" ]; then
  set_env_value OCI_KEY_FILE "$HOME/.oci/oci_api_key.pem"
fi
if [ "$env_created" = "true" ]; then
  set_env_value DEBUG true
  set_env_value EXTERNAL_IP 127.0.0.1
fi

font_path=""
for candidate in "$HOME/Library/Fonts/ipaexg.ttf" "/Library/Fonts/ipaexg.ttf"; do
  if [ -f "$candidate" ]; then
    font_path="$candidate"
    break
  fi
done
if [ -n "$font_path" ]; then
  set_env_value JAPANESE_FONT_PATH "$font_path"
fi

if [ -n "$WALLET_ZIP" ]; then
  case "$WALLET_ZIP" in
    /*) ;;
    *) WALLET_ZIP="$CALLER_DIR/$WALLET_ZIP" ;;
  esac

  if [ ! -f "$WALLET_ZIP" ]; then
    echo "[セットアップ] ERROR: Wallet ZIPが見つかりません: $WALLET_ZIP" >&2
    exit 1
  fi

  echo "[セットアップ] Walletを展開します: $oracle_dir/network/admin"
  unzip -o "$WALLET_ZIP" -d "$oracle_dir/network/admin"

  missing_wallet_files=""
  for required_file in cwallet.sso ewallet.pem sqlnet.ora tnsnames.ora; do
    if [ ! -f "$oracle_dir/network/admin/$required_file" ]; then
      missing_wallet_files="${missing_wallet_files} ${required_file}"
    fi
  done
  if [ -n "$missing_wallet_files" ]; then
    echo "[セットアップ] ERROR: Walletに必須ファイルがありません:${missing_wallet_files}" >&2
    exit 1
  fi
  echo "[セットアップ] Walletを確認しました。"
else
  echo "[セットアップ] Wallet ZIPは未指定です。必要な場合は後から同じスクリプトへ指定してください。"
fi

echo "[セットアップ] Python 3.13とバックエンド依存関係を準備します..."
uv python install 3.13
uv sync --directory backend

echo "[セットアップ] フロントエンド依存関係を準備します..."
npm ci --prefix frontend --no-audit --no-fund

echo ""
echo "[セットアップ] 完了しました。"
echo "  1. .envのOCI/ADB設定を確認してください。"
echo "  2. ./scripts/start-mac.sh で起動してください。"
echo "  3. http://localhost:5175/ai/ を開いてください。"
