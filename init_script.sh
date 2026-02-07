#!/bin/bash
set -euo pipefail

# Redirect all output to log file
exec > >(tee -a /var/log/init_script.log) 2>&1

echo "アプリケーションのセットアップを初期化中..."

# Configuration
INSTALL_DIR="/u01/aipoc"

# Read configuration flags
ENABLE_DIFY="false"

if [ -f "${INSTALL_DIR}/props/enable_dify.txt" ]; then
    ENABLE_DIFY=$(cat "${INSTALL_DIR}/props/enable_dify.txt")
fi

echo "Difyインストール有効: $ENABLE_DIFY"
NODE_VERSION="20.x"
INSTANTCLIENT_VERSION="23.26.0.0.0"
INSTANTCLIENT_ZIP="instantclient-basic-linux.x64-${INSTANTCLIENT_VERSION}.zip"
INSTANTCLIENT_URL="https://download.oracle.com/otn_software/linux/instantclient/2326000/${INSTANTCLIENT_ZIP}"
INSTANTCLIENT_SQLPLUS_ZIP="instantclient-sqlplus-linux.x64-${INSTANTCLIENT_VERSION}.zip"
INSTANTCLIENT_SQLPLUS_URL="https://download.oracle.com/otn_software/linux/instantclient/2326000/${INSTANTCLIENT_SQLPLUS_ZIP}"
LIBAIO_DEB="libaio1_0.3.113-4_amd64.deb"
LIBAIO_URL="http://ftp.de.debian.org/debian/pool/main/liba/libaio/${LIBAIO_DEB}"
INSTANTCLIENT_DIR="${INSTALL_DIR}/instantclient_23_26"

# Helper function for retrying commands
retry_command() {
    local max_attempts=5
    local timeout=10
    local attempt=1
    local exit_code=0

    while [ $attempt -le $max_attempts ]; do
        echo "Attempt $attempt of $max_attempts: $@"
        "$@" && return 0
        exit_code=$?
        echo "Command failed with exit code $exit_code. Retrying in $timeout seconds..."
        sleep $timeout
        attempt=$((attempt + 1))
        timeout=$((timeout * 2))
    done

    echo "Command failed after $max_attempts attempts."
    return $exit_code
}

cd "$INSTALL_DIR"

export DEBIAN_FRONTEND=noninteractive

# Install essential dependencies
echo "必須の依存関係をインストール中..."
retry_command apt-get update -y
retry_command apt-get install -y \
    curl \
    wget \
    unzip \
    git \
    build-essential \
    ca-certificates \
    gnupg \
    nginx \
    libreoffice \
    poppler-utils \
    fonts-ipafont-gothic \
    fonts-ipafont-mincho \
    fonts-noto-cjk \
    fonts-noto-cjk-extra \
    fonts-ipafont \
    fonts-takao \
    fonts-wqy-microhei \
    fonts-wqy-zenhei

# フォントキャッシュを更新
echo "フォントキャッシュを更新中..."
fc-cache -fv

# 日本語フォントの検証（TXT/MD変換に必要）
echo "日本語フォントを検証中..."
REQUIRED_FONTS=(
    "/usr/share/fonts/opentype/ipafont-gothic/ipag.ttf:fonts-ipafont-gothic"
    "/usr/share/fonts/truetype/takao-gothic/TakaoGothic.ttf:fonts-takao"
)

FONT_FOUND=false
for font_info in "${REQUIRED_FONTS[@]}"; do
    font_path="${font_info%%:*}"
    package_name="${font_info##*:}"
    if [ -f "$font_path" ]; then
        echo "✓ 日本語フォント検証成功: $font_path"
        FONT_FOUND=true
        break
    fi
done

if [ "$FONT_FOUND" = "false" ]; then
    echo "警告: 推奨される日本語フォントが見つかりません。TXT/MD変換で日本語が正しく表示されない可能性があります。"
    echo "  以下のコマンドでインストールしてください:"
    echo "  apt-get install -y fonts-ipafont-gothic fonts-takao"
fi

# Install Node.js
echo "Node.js $NODE_VERSION LTS をインストール中..."
if ! command -v node >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION} | bash -
    retry_command apt-get update -y
    retry_command apt-get install -y nodejs
else
    echo "Node.jsは既にインストールされています。"
fi

# Verify Node.js and npm
echo "Node.jsとnpmのインストールを検証中..."
node -v
if ! command -v npm >/dev/null 2>&1; then
    echo "npmが見つかりません。明示的にインストール中..."
    retry_command apt-get install -y npm
fi
npm -v

# Install uv (Python package manager)
echo "uv（Pythonパッケージマネージャー）をインストール中..."
if [ ! -f "/root/.local/bin/uv" ]; then
    retry_command curl -LsSf https://astral.sh/uv/install.sh | sh
else
    echo "uvは既にインストールされています。"
fi

# Ensure uv is in PATH for current session
export PATH="/root/.local/bin:$PATH"

# Idempotent addition to .bashrc
if ! grep -q 'export PATH="/root/.local/bin:$PATH"' /root/.bashrc; then
    echo 'export PATH="/root/.local/bin:$PATH"' >> /root/.bashrc
fi

# Install Oracle Instant Client
echo "Oracle Instant Clientをインストール中..."
if [ ! -d "${INSTANTCLIENT_DIR}" ]; then
    if [ ! -f "$INSTANTCLIENT_ZIP" ]; then
        retry_command wget "$INSTANTCLIENT_URL" -O "$INSTANTCLIENT_ZIP"
    fi
    unzip -o "$INSTANTCLIENT_ZIP" -d ./
    
    # Install SQL*Plus
    echo "SQL*Plusをインストール中..."
    if [ ! -f "$INSTANTCLIENT_SQLPLUS_ZIP" ]; then
        retry_command wget "$INSTANTCLIENT_SQLPLUS_URL" -O "$INSTANTCLIENT_SQLPLUS_ZIP"
    fi
    unzip -o "$INSTANTCLIENT_SQLPLUS_ZIP" -d ./

    if [ ! -f "$LIBAIO_DEB" ]; then
        retry_command wget "$LIBAIO_URL"
    fi
    dpkg -i "$LIBAIO_DEB" || apt-get install -f -y
    
    sh -c "echo ${INSTANTCLIENT_DIR} > /etc/ld.so.conf.d/oracle-instantclient.conf"
    ldconfig
    
    if ! grep -q "LD_LIBRARY_PATH=${INSTANTCLIENT_DIR}" /etc/profile; then
        echo "export LD_LIBRARY_PATH=${INSTANTCLIENT_DIR}:\$LD_LIBRARY_PATH" >> /etc/profile
        echo "export PATH=${INSTANTCLIENT_DIR}:\$PATH" >> /etc/profile
    fi
else
    echo "Oracle Instant Clientは既にインストールされています。"
fi

# Safe sourcing of profile
set +eu
source /etc/profile
set -eu
# Explicitly export in case sourcing failed or didn't pick up immediately
export LD_LIBRARY_PATH="${INSTANTCLIENT_DIR}:${LD_LIBRARY_PATH:-}"
export PATH="${INSTANTCLIENT_DIR}:$PATH"

# Verify sqlplus installation
if command -v sqlplus >/dev/null 2>&1; then
    echo "SQL*Plusのインストール検証が成功しました"
else
    echo "エラー: SQL*Plusのインストール検証に失敗しました"
    exit 1
fi

# Setup ADB wallet
WALLET_DIR="${INSTANTCLIENT_DIR}/network/admin"
echo "ADBウォレットをセットアップ中..."
if [ -f "${INSTALL_DIR}/wallet.zip" ]; then
    mkdir -p "${WALLET_DIR}"
    unzip -o "${INSTALL_DIR}/wallet.zip" -d "${WALLET_DIR}"
    
    # 必須ウォレットファイルのチェック（Thin mode用）
    echo "必須ウォレットファイルをチェック中... (Thin mode)"
    REQUIRED_FILES=("cwallet.sso" "ewallet.pem" "sqlnet.ora" "tnsnames.ora")
    MISSING_FILES=()
    
    for file in "${REQUIRED_FILES[@]}"; do
        if [ ! -f "${WALLET_DIR}/${file}" ]; then
            MISSING_FILES+=("$file")
        fi
    done
    
    if [ ${#MISSING_FILES[@]} -gt 0 ]; then
        echo "エラー: 以下の必須ウォレットファイルが見つかりません:"
        for file in "${MISSING_FILES[@]}"; do
            echo "  ⚠️ $file"
        done
        exit 1
    fi
    
    echo "✓ すべての必須ウォレットファイルが確認されました (Thin mode)"
    echo "  - cwallet.sso (自動ログイン)"
    echo "  - ewallet.pem (PEM形式証明書)"
    echo "  - sqlnet.ora (ネットワーク設定)"
    echo "  - tnsnames.ora (接続文字列)"
    
    echo "ADBウォレットのセットアップが完了しました"
else
    echo "警告: ${INSTALL_DIR}/wallet.zip が見つかりません。ウォレットのセットアップをスキップします。"
fi

# Setup no.1-semantic-doc-search project
PROJECT_DIR="${INSTALL_DIR}/no.1-semantic-doc-search"
if [ -d "$PROJECT_DIR" ]; then
    echo "セマンティック文書検索プロジェクトをセットアップ中..."
    cd "$PROJECT_DIR"
    
    # Make scripts executable
    chmod +x scripts/*.sh
    
    # Environment Setup
    # Check for property files before reading
    if [ -f "${INSTALL_DIR}/props/db.env" ]; then
        DB_CONNECTION_STRING=$(cat "${INSTALL_DIR}/props/db.env")
    else
        echo "警告: ${INSTALL_DIR}/props/db.env が見つかりません！"
        DB_CONNECTION_STRING=""
    fi

    if [ -f "${INSTALL_DIR}/props/compartment_id.txt" ]; then
        COMPARTMENT_ID=$(cat "${INSTALL_DIR}/props/compartment_id.txt")
    else
        echo "警告: ${INSTALL_DIR}/props/compartment_id.txt が見つかりません！"
        COMPARTMENT_ID=""
    fi

    cp .env.example .env
    
    if [ -n "$DB_CONNECTION_STRING" ]; then
        sed -i "s|ORACLE_26AI_CONNECTION_STRING=.*|ORACLE_26AI_CONNECTION_STRING=$DB_CONNECTION_STRING|g" .env
    fi
    
    if [ -n "$COMPARTMENT_ID" ]; then
        sed -i "s|OCI_COMPARTMENT_OCID=.*|OCI_COMPARTMENT_OCID=$COMPARTMENT_ID|g" .env
    fi
    
    ADB_NAME=$(cat "${INSTALL_DIR}/props/adb_name.txt" 2>/dev/null || true)
    if [ -n "$ADB_NAME" ]; then 
        sed -i "s|ADB_NAME=.*|ADB_NAME=$ADB_NAME|g" .env
    fi
    
    # Set External API Keys (if available)
    if [ -f "${INSTALL_DIR}/props/external_api_keys.txt" ]; then
        EXTERNAL_API_KEYS=$(cat "${INSTALL_DIR}/props/external_api_keys.txt")
        # Remove leading/trailing whitespace
        EXTERNAL_API_KEYS=$(echo "$EXTERNAL_API_KEYS" | xargs)
        if [ -n "$EXTERNAL_API_KEYS" ]; then
            sed -i "s|EXTERNAL_API_KEYS=.*|EXTERNAL_API_KEYS=${EXTERNAL_API_KEYS}|g" .env
            echo "外部APIキーが設定されました"
        fi
    fi
    
    # Set ADB OCID (if available)
    if [ -f "${INSTALL_DIR}/props/adb_ocid.txt" ]; then
        ADB_OCID=$(cat "${INSTALL_DIR}/props/adb_ocid.txt")
        sed -i "s|ADB_OCID=.*|ADB_OCID=${ADB_OCID}|g" .env
    fi
    
    # Set Oracle Client Library Directory
    sed -i "s|ORACLE_CLIENT_LIB_DIR=.*|ORACLE_CLIENT_LIB_DIR=${INSTANTCLIENT_DIR}|g" .env
    
    # TNS_ADMIN is automatically set to ORACLE_CLIENT_LIB_DIR/network/admin
    # No need to set TNS_ADMIN explicitly in .env
    
    # Set OCI Region (if available)
    if [ -n "${OCI_REGION:-}" ]; then
        sed -i "s|OCI_REGION=.*|OCI_REGION=${OCI_REGION}|g" .env
    fi
    
    # Set OCI Namespace (get from OCI API or properties)
    if [ -f "${INSTALL_DIR}/props/oci_namespace.txt" ]; then
        OCI_NAMESPACE=$(cat "${INSTALL_DIR}/props/oci_namespace.txt")
        sed -i "s|OCI_NAMESPACE=.*|OCI_NAMESPACE=${OCI_NAMESPACE}|g" .env
    fi
    
    # Set OCI Bucket (default or from properties)
    if [ -f "${INSTALL_DIR}/props/oci_bucket.txt" ]; then
        OCI_BUCKET=$(cat "${INSTALL_DIR}/props/oci_bucket.txt")
        sed -i "s|OCI_BUCKET=.*|OCI_BUCKET=${OCI_BUCKET}|g" .env
    else
        # デフォルト値を設定
        sed -i "s|OCI_BUCKET=.*|OCI_BUCKET=semantic-doc-search|g" .env
    fi
    
    # Set API Host and Port for production
    sed -i "s|API_HOST=.*|API_HOST=0.0.0.0|g" .env
    sed -i "s|API_PORT=.*|API_PORT=8081|g" .env
    
    # External IP
    EXTERNAL_IP=$(curl -s -m 10 http://whatismyip.akamai.com/ || echo "")
    echo "外部IP: $EXTERNAL_IP"
    
    if [ -n "$EXTERNAL_IP" ]; then
        sed -i "s|^EXTERNAL_IP=.*|EXTERNAL_IP=$EXTERNAL_IP|g" .env
    else
        echo "警告: EXTERNAL_IPの検出に失敗しました"
    fi
    
    # Debug Mode
    if grep -q "^DEBUG=" .env; then
        sed -i "s|^DEBUG=.*|DEBUG=false|g" .env
    else
        echo "DEBUG=false" >> .env
    fi

    # UI Feature Toggles
    # Set SHOW_AI_ASSISTANT (if available)
    if [ -f "${INSTALL_DIR}/props/show_ai_assistant.txt" ]; then
        SHOW_AI_ASSISTANT=$(cat "${INSTALL_DIR}/props/show_ai_assistant.txt" | xargs)
        if [ -n "$SHOW_AI_ASSISTANT" ]; then
            if grep -q "^SHOW_AI_ASSISTANT=" .env; then
                sed -i "s|^SHOW_AI_ASSISTANT=.*|SHOW_AI_ASSISTANT=${SHOW_AI_ASSISTANT}|g" .env
            else
                echo "SHOW_AI_ASSISTANT=${SHOW_AI_ASSISTANT}" >> .env
            fi
            echo "AIアシスタント表示: ${SHOW_AI_ASSISTANT}"
        fi
    fi

    # Set SHOW_SEARCH_TAB (if available)
    if [ -f "${INSTALL_DIR}/props/show_search_tab.txt" ]; then
        SHOW_SEARCH_TAB=$(cat "${INSTALL_DIR}/props/show_search_tab.txt" | xargs)
        if [ -n "$SHOW_SEARCH_TAB" ]; then
            if grep -q "^SHOW_SEARCH_TAB=" .env; then
                sed -i "s|^SHOW_SEARCH_TAB=.*|SHOW_SEARCH_TAB=${SHOW_SEARCH_TAB}|g" .env
            else
                echo "SHOW_SEARCH_TAB=${SHOW_SEARCH_TAB}" >> .env
            fi
            echo "検索タブ表示: ${SHOW_SEARCH_TAB}"
        fi
    fi

    # Setup backend with Python 3.13
    echo "Python 3.13でバックエンドをセットアップ中..."
    cd "${PROJECT_DIR}"
    
    # Ensure specific python version
    uv python install 3.13
    
    # Create venv and sync dependencies
    echo "依存関係を同期中..."
    uv venv --python 3.13 backend/.venv
    uv sync --directory backend
    
    echo "バックエンドのセットアップが完了しました。"
    
    # Setup frontend
    echo "フロントエンドをセットアップ中..."
    cd "${PROJECT_DIR}/frontend"
    
    rm -f .env.development
    echo "VITE_API_BASE=" > .env.production
    echo "VITE_API_BASE=" > .env
    
    # Ensure npm install succeeds
    echo "npm install を実行中..."
    retry_command npm install --no-audit --no-fund
    
    echo "本番用フロントエンドをビルド中..."
    npm run build
    
    # Configure nginx based on ENABLE_DIFY
    if [ "$ENABLE_DIFY" = "true" ]; then
        # Configure nginx (Difyあり版)
        echo "nginxを設定中 (Difyあり)..."
        cat > /etc/nginx/sites-available/app << 'NGINX_DIFY_EOF'
server {
    listen 80;
    server_name _;

    # ログ設定
    access_log /var/log/nginx/app.log;
    error_log /var/log/nginx/app-error.log warn;

    # クライアント最大ボディサイズ（アップロード用）
    client_max_body_size 100M;

    # 本アプリのAPI (/ai/api と /ai/api/)
    location /ai/api/ {
        proxy_pass http://127.0.0.1:8081/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    # /ai/api を /ai/api/ にリダイレクト
    location = /ai/api {
        return 301 /ai/api/;
    }

    # 画像プロキシエンドポイント (/oci/image)
    location /oci/image/ {
        proxy_pass http://127.0.0.1:8081/oci/image/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_buffering off;
        # キャッシュ設定（画像用）
        proxy_cache_valid 200 1h;
    }

    # OCI Object Storageプロキシ (/object) - ファイル・画像配信
    location /object/ {
        proxy_pass http://127.0.0.1:8081/object/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_buffering off;
        proxy_cache_valid 200 1h;
    }

    # 後方互換性: /img/ -> /object/
    location /img/ {
        return 307 /object/$request_uri;
    }

    # 本アプリのヘルスチェック
    location /ai/health {
        proxy_pass http://127.0.0.1:8081/health;
        proxy_set_header Host $host;
        access_log off;
    }

    # 本アプリのフロントエンド (/ai/ と /ai/xxx)
    location /ai/ {
        proxy_pass http://127.0.0.1:5175/ai/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    # /ai を /ai/ にリダイレクト
    location = /ai {
        return 301 /ai/;
    }

    # Dify (ルートパス / と /xxx)
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # WebSocketサポート
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        
        proxy_connect_timeout 300s;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_buffering off;
        proxy_cache_bypass $http_upgrade;
    }
}
NGINX_DIFY_EOF
    else
        # Configure nginx (Difyなし版)
        echo "nginxを設定中 (Difyなし)..."
        cat > /etc/nginx/sites-available/app << 'NGINX_EOF'
server {
    listen 80;
    server_name _;

    # ログ設定
    access_log /var/log/nginx/app.log;
    error_log /var/log/nginx/app-error.log warn;

    # クライアント最大ボディサイズ（アップロード用）
    client_max_body_size 100M;

    # 本アプリのAPI (/ai/api と /ai/api/)
    location /ai/api/ {
        proxy_pass http://127.0.0.1:8081/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    # /ai/api を /ai/api/ にリダイレクト
    location = /ai/api {
        return 301 /ai/api/;
    }

    # 画像プロキシエンドポイント (/oci/image)
    location /oci/image/ {
        proxy_pass http://127.0.0.1:8081/oci/image/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_buffering off;
        # キャッシュ設定（画像用）
        proxy_cache_valid 200 1h;
    }

    # OCI Object Storageプロキシ (/object) - ファイル・画像配信
    location /object/ {
        proxy_pass http://127.0.0.1:8081/object/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-Host $host;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
        proxy_buffering off;
        proxy_cache_valid 200 1h;
    }

    # 後方互換性: /img/ -> /object/
    location /img/ {
        return 307 /object/$request_uri;
    }

    # 本アプリのヘルスチェック
    location /ai/health {
        proxy_pass http://127.0.0.1:8081/health;
        proxy_set_header Host $host;
        access_log off;
    }

    # 本アプリのフロントエンド (/ai/ と /ai/xxx)
    location /ai/ {
        proxy_pass http://127.0.0.1:5175/ai/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    # /ai を /ai/ にリダイレクト
    location = /ai {
        return 301 /ai/;
    }

    # ルートパスは/ai/にリダイレクト (Difyがない場合)
    location = / {
        return 302 /ai/;
    }

    # その他のルートパスも/ai/にリダイレクト
    location / {
        return 302 /ai/;
    }
}
NGINX_EOF
    fi

    # サイトを有効化
    ln -sf /etc/nginx/sites-available/app /etc/nginx/sites-enabled/
    
    # デフォルトサイトを無効化・削除
    rm -f /etc/nginx/sites-enabled/default
    rm -f /etc/nginx/sites-available/default
    
    # nginx設定をテスト
    echo "nginx設定をテスト中..."
    nginx -t
    
    # nginxをリロード
    echo "nginxをリロード中..."
    systemctl reload nginx || systemctl restart nginx
    
    # nginx自動起動を有効化
    echo "nginx自動起動を有効化中..."
    systemctl enable nginx
    
    # 完了メッセージ
    EXTERNAL_IP=$(curl -s -m 10 http://whatismyip.akamai.com/ || echo "localhost")
    if [ "$ENABLE_DIFY" = "true" ]; then
        echo "========================================"
        echo "nginx設定が完了しました (Difyあり)。"
        echo "  Dify:       http://${EXTERNAL_IP}/"
        echo "  本アプリ:   http://${EXTERNAL_IP}/ai"
        echo "  API:        http://${EXTERNAL_IP}/ai/api"
        echo "========================================"
    else
        echo "========================================"
        echo "初期化が完了しました。"
        echo "  本アプリ: http://${EXTERNAL_IP}/ai"
        echo "  API:      http://${EXTERNAL_IP}/ai/api"
        echo "  (ルート'/'は/aiにリダイレクトされます)"
        echo "========================================"
    fi
fi

# Create startup script
cat > "${INSTALL_DIR}/start_semantic_doc_search_services.sh" << 'EOF'
#!/bin/bash
if [ -f /root/.bashrc ]; then
  source /root/.bashrc
fi

export PATH="/root/.local/bin:$PATH"
cd /u01/aipoc/no.1-semantic-doc-search

if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# Set TNS_ADMIN for Oracle Wallet
export TNS_ADMIN="${ORACLE_CLIENT_LIB_DIR}/network/admin"

echo "セマンティック文書検索バックエンドサービスを起動中..."
# 環境変数からAPI_HOSTとAPI_PORTを読み取る（デフォルト値付き）
API_HOST=${API_HOST:-0.0.0.0}
API_PORT=${API_PORT:-8081}
nohup uv run --directory backend uvicorn app.main:app --host "${API_HOST}" --port "${API_PORT}" > /var/log/app-backend.log 2>&1 &

sleep 5

echo "セマンティック文書検索フロントエンドサービスを起動中..."
cd /u01/aipoc/no.1-semantic-doc-search/frontend
nohup npm run preview -- --host 0.0.0.0 --port 5175 > /var/log/app-frontend.log 2>&1 &

echo "セマンティック文書検索サービスが起動しました。"
EOF

chmod +x "${INSTALL_DIR}/start_semantic_doc_search_services.sh"

# Cron job (Idempotent)
echo "cronジョブをセットアップ中..."
CRON_CMD="@reboot ${INSTALL_DIR}/start_semantic_doc_search_services.sh"
(crontab -l 2>/dev/null | grep -v "$CRON_CMD" || true; echo "$CRON_CMD") | crontab -

# Start services
echo "セマンティック文書検索サービスを起動中..."
"${INSTALL_DIR}/start_semantic_doc_search_services.sh"

# Install Dify if enabled
if [ "$ENABLE_DIFY" = "true" ]; then
    echo "Difyインストールを開始します..."
    
    # Verify required configuration files
    REQUIRED_FILES=(
        "${INSTALL_DIR}/props/dify_branch.txt"
        "${INSTALL_DIR}/props/db.env"
        "${INSTALL_DIR}/props/adb_dsn.txt"
        "${INSTALL_DIR}/props/adb_password.txt"
        "${INSTALL_DIR}/props/bucket_namespace.txt"
        "${INSTALL_DIR}/props/dify_bucket.txt"
        "${INSTALL_DIR}/props/bucket_region.txt"
        "${INSTALL_DIR}/props/oci_access_key.txt"
        "${INSTALL_DIR}/props/oci_secret_key.txt"
    )
    
    for file in "${REQUIRED_FILES[@]}"; do
        if [ ! -f "$file" ]; then
            echo "エラー: 必要な設定ファイルが見つかりません: $file"
            echo "Difyインストールをスキップします"
            ENABLE_DIFY="false"
            break
        fi
    done
    
    if [ "$ENABLE_DIFY" = "true" ]; then
        # Read configuration
        DIFY_BRANCH=$(cat "${INSTALL_DIR}/props/dify_branch.txt")
        ORACLE_PASSWORD=$(cat "${INSTALL_DIR}/props/adb_password.txt")
        ORACLE_DSN=$(cat "${INSTALL_DIR}/props/adb_dsn.txt")
        ORACLE_WALLET_PASSWORD=$(cat "${INSTALL_DIR}/props/adb_password.txt")
        BUCKET_NAMESPACE=$(cat "${INSTALL_DIR}/props/bucket_namespace.txt")
        BUCKET_NAME=$(cat "${INSTALL_DIR}/props/dify_bucket.txt")
        BUCKET_REGION=$(cat "${INSTALL_DIR}/props/bucket_region.txt")
        OCI_ACCESS_KEY=$(cat "${INSTALL_DIR}/props/oci_access_key.txt")
        OCI_SECRET_KEY=$(cat "${INSTALL_DIR}/props/oci_secret_key.txt")
        
        echo "Difyブランチ: $DIFY_BRANCHを使用します"
        
        # Install Docker if not already installed
        if ! command -v docker >/dev/null 2>&1; then
            echo "Dockerをインストール中..."
            
            # Check if install_docker.sh exists
            if [ -f "${PROJECT_DIR}/install_docker.sh" ]; then
                echo "install_docker.shを使用してDockerをインストールします..."
                chmod +x "${PROJECT_DIR}/install_docker.sh"
                
                if bash "${PROJECT_DIR}/install_docker.sh"; then
                    echo "Dockerインストールに成功しました"
                else
                    echo "警告: install_docker.shが失敗しました。フォールバックメソッドを使用します..."
                    retry_command curl -fsSL https://get.docker.com -o get-docker.sh
                    sh get-docker.sh
                    rm get-docker.sh
                fi
            else
                echo "install_docker.shが見つかりません。Docker公式スクリプトを使用します..."
                retry_command curl -fsSL https://get.docker.com -o get-docker.sh
                sh get-docker.sh
                rm get-docker.sh
            fi
            
            # Start Docker service
            echo "Dockerサービスを起動中..."
            if systemctl start docker; then
                echo "Dockerサービスの起動に成功しました"
            else
                echo "エラー: Dockerサービスの起動に失敗しました"
                echo "Difyインストールをスキップします"
                ENABLE_DIFY="false"
            fi
            
            # Enable Docker service
            echo "Docker自動起動を有効化中..."
            systemctl enable docker
        else
            echo "Dockerは既にインストールされています"
            
            # Ensure Docker service is running even if already installed
            if ! systemctl is-active --quiet docker; then
                echo "Dockerサービスが停止しています。起動中..."
                systemctl start docker
            fi
        fi
        
        # Verify Docker status
        if systemctl is-active --quiet docker; then
            echo "Dockerサービスが正常に動作しています"
            
            # Verify Docker Compose plugin
            if docker compose version >/dev/null 2>&1; then
                echo "Docker Composeプラグインが利用可能です"
            else
                echo "警告: Docker Composeプラグインが見つかりません"
            fi
        else
            echo "エラー: Dockerサービスが正常に動作していません"
            echo "Difyインストールをスキップします"
            ENABLE_DIFY="false"
        fi
    fi
    
    if [ "$ENABLE_DIFY" = "true" ]; then
        # Clone Dify repository
        cd "${INSTALL_DIR}"
        echo "Difyリポジトリをクローン中..."
        if [ -d "dify" ]; then
            echo "Difyディレクトリが既に存在します。スキップします。"
        else
            retry_command git clone -b "${DIFY_BRANCH}" https://github.com/langgenius/dify.git
        fi
        
        cd "${INSTALL_DIR}/dify/docker"
        
        # Get external IP
        EXTERNAL_IP=$(curl -s -m 10 http://whatismyip.akamai.com/ || echo "localhost")
        if [ "$EXTERNAL_IP" = "localhost" ]; then
            echo "警告: 外部IPを取得できません。localhostを使用します。"
        else
            echo "外部IP: $EXTERNAL_IP"
        fi
        
        # Configure Dify environment
        echo "Dify環境ファイルを設定中..."
        cp -f .env.example .env
        
        # Configure Oracle ADB as vector store
        echo "Oracle ADBをベクトルストアとして設定中..."
        sed -i "s|VECTOR_STORE=.*|VECTOR_STORE=oracle|g" .env
        sed -i "s|ORACLE_USER=.*|ORACLE_USER=admin|g" .env
        sed -i "s|ORACLE_PASSWORD=.*|ORACLE_PASSWORD=${ORACLE_PASSWORD}|g" .env
        sed -i "s|ORACLE_DSN=.*|ORACLE_DSN=${ORACLE_DSN}|g" .env
        sed -i "s|ORACLE_WALLET_PASSWORD=.*|ORACLE_WALLET_PASSWORD=${ORACLE_WALLET_PASSWORD}|g" .env
        sed -i "s|ORACLE_IS_AUTONOMOUS=.*|ORACLE_IS_AUTONOMOUS=true|g" .env
        
        # Modify docker-compose.yaml to skip Oracle container
        sed -i "s|      - oracle|      - oracle-skip|g" docker-compose.yaml
        
        # Configure OCI object storage
        echo "OCI Object Storageを設定中..."
        sed -i "s|STORAGE_TYPE=opendal|STORAGE_TYPE=oci-storage|g" .env
        
        # Configure OCI object storage environment variables
        OCI_ENDPOINT="https://${BUCKET_NAMESPACE}.compat.objectstorage.${BUCKET_REGION}.oraclecloud.com"
        OCI_BUCKET_NAME=${BUCKET_NAME}
        OCI_REGION=${BUCKET_REGION}
        
        echo "OCIエンドポイント: $OCI_ENDPOINT"
        echo "OCIバケット: $OCI_BUCKET_NAME"
        echo "OCIリージョン: $OCI_REGION"
        
        sed -i "s|OCI_ENDPOINT=.*|OCI_ENDPOINT=${OCI_ENDPOINT}|g" .env
        sed -i "s|OCI_BUCKET_NAME=.*|OCI_BUCKET_NAME=${OCI_BUCKET_NAME}|g" .env
        sed -i "s|OCI_ACCESS_KEY=.*|OCI_ACCESS_KEY=${OCI_ACCESS_KEY}|g" .env
        sed -i "s|OCI_SECRET_KEY=.*|OCI_SECRET_KEY=${OCI_SECRET_KEY}|g" .env
        sed -i "s|OCI_REGION=.*|OCI_REGION=${OCI_REGION}|g" .env
        
        # Update URL configuration (Difyをルートパスで動作)
        # 注意: CONSOLE_API_URLなどはベースURLのみ。フロントエンドが/console/api/xxxを自動追加する
        echo "URL設定を更新中 (ルートパス)..."
        sed -i "s|^CONSOLE_API_URL=.*|CONSOLE_API_URL=http://${EXTERNAL_IP}|" .env
        sed -i "s|^CONSOLE_WEB_URL=.*|CONSOLE_WEB_URL=http://${EXTERNAL_IP}|" .env
        sed -i "s|^SERVICE_API_URL=.*|SERVICE_API_URL=http://${EXTERNAL_IP}|" .env
        sed -i "s|^APP_API_URL=.*|APP_API_URL=http://${EXTERNAL_IP}|" .env
        sed -i "s|^APP_WEB_URL=.*|APP_WEB_URL=http://${EXTERNAL_IP}|" .env
        sed -i "s|^FILES_URL=.*|FILES_URL=|" .env
        
        # Configure file upload and processing limits
        sed -i "s|^UPLOAD_FILE_SIZE_LIMIT=15|UPLOAD_FILE_SIZE_LIMIT=100|g" .env
        sed -i "s|^CODE_MAX_STRING_ARRAY_LENGTH=30|CODE_MAX_STRING_ARRAY_LENGTH=1000|g" .env
        sed -i "s|^CODE_MAX_OBJECT_ARRAY_LENGTH=30|CODE_MAX_OBJECT_ARRAY_LENGTH=1000|g" .env
        sed -i "s|^HTTP_REQUEST_NODE_MAX_BINARY_SIZE=10485760|HTTP_REQUEST_NODE_MAX_BINARY_SIZE=104857600|g" .env
        
        # Change nginx port binding via environment variable (fix "address already in use" error)
        # External nginx (host) uses port 80, Dify internal nginx uses 8080
        echo "EXPOSE_NGINX_PORT=127.0.0.1:8080" >> .env
        echo "EXPOSE_NGINX_SSL_PORT=127.0.0.1:8443" >> .env
        
        # Create custom nginx config with DNS resolver (fix "host not found in upstream" error)
        echo "カスタムnginx設定を作成中 (DNSリゾルバ付き)..."
        mkdir -p nginx-custom
        cat > nginx-custom/default.conf << 'NGINX_CONF_EOF'
# Docker DNS resolver (fix "host not found in upstream" error)
resolver 127.0.0.11 valid=10s;

server {
    listen 80;
    server_name _;

    location /console/api {
        set $upstream_api api:5001;
        proxy_pass http://$upstream_api;
        include proxy.conf;
    }

    location /api {
        set $upstream_api api:5001;
        proxy_pass http://$upstream_api;
        include proxy.conf;
    }

    location /v1 {
        set $upstream_api api:5001;
        proxy_pass http://$upstream_api;
        include proxy.conf;
    }

    location /files {
        set $upstream_api api:5001;
        proxy_pass http://$upstream_api;
        include proxy.conf;
    }

    location / {
        set $upstream_web web:3000;
        proxy_pass http://$upstream_web;
        include proxy.conf;
    }
}
NGINX_CONF_EOF
        
        # Create docker-compose.override.yaml
        # NLTK設定とカスタムnginx設定のみ（ポートは.envで制御）
        echo "Docker Compose override設定を作成中..."
        cat > docker-compose.override.yaml << 'EOL'
services:
  nginx:
    volumes:
      - ./nginx-custom/default.conf:/etc/nginx/conf.d/default.conf:ro
  api:
    environment:
      - NLTK_DATA=/tmp/nltk_data
      - WEB_API_CORS_ALLOW_ORIGINS=*
      - CONSOLE_CORS_ALLOW_ORIGINS=*
    volumes:
      - ./volumes/nltk_data:/tmp/nltk_data
  worker:
    environment:
      - NLTK_DATA=/tmp/nltk_data
    volumes:
      - ./volumes/nltk_data:/tmp/nltk_data
EOL
        
        # Set permissions for storage directories
        echo "ストレージディレクトリの権限を設定中..."
        mkdir -p volumes/app/storage
        mkdir -p volumes/nltk_data
        chown -R 1001:1001 volumes/app/storage
        chown -R 1001:1001 volumes/nltk_data
        
        # Start Docker Compose
        echo "Difyサービスを起動中..."
        docker compose up -d
        
        # Wait for all services to start
        echo "全サービスの起動を待機中..."
        sleep 45
        
        # Configure wallet files to containers
        echo "Difyコンテナにwalletファイルを設定中..."
        if [ -d "${WALLET_DIR}" ]; then
            # Copy wallet to Dify containers
            WORKER_CONTAINER=$(docker ps --filter "name=worker" --format "{{.Names}}" | head -n 1)
            if [ -n "$WORKER_CONTAINER" ]; then
                echo "walletを${WORKER_CONTAINER}にコピー中..."
                docker cp "${WALLET_DIR}" "${WORKER_CONTAINER}:/app/api/storage/wallet"
                chown -R 1001:1001 volumes/app/storage/wallet 2>/dev/null || true
            fi
            
            # Fix NLTK download issues
            echo "NLTKダウンロード問題を修正中..."
            API_CONTAINER=$(docker ps --filter "name=api" --format "{{.Names}}" | head -n 1)
            if [ -n "$API_CONTAINER" ]; then
                docker exec "$API_CONTAINER" bash -c 'mkdir -p /tmp/nltk_data && export NLTK_DATA=/tmp/nltk_data && python -c "import nltk; nltk.download(\"punkt\", download_dir=\"/tmp/nltk_data\", quiet=True); nltk.download(\"punkt_tab\", download_dir=\"/tmp/nltk_data\", quiet=True)"' || true
            fi
            
            if [ -n "$WORKER_CONTAINER" ]; then
                docker exec "$WORKER_CONTAINER" bash -c 'mkdir -p /tmp/nltk_data && export NLTK_DATA=/tmp/nltk_data && python -c "import nltk; nltk.download(\"punkt\", download_dir=\"/tmp/nltk_data\", quiet=True); nltk.download(\"punkt_tab\", download_dir=\"/tmp/nltk_data\", quiet=True)"' || true
            fi
            
            # Restart containers to apply configuration
            echo "設定を適用するためにコンテナを再起動中..."
            docker restart "$WORKER_CONTAINER" "$API_CONTAINER" || true
            sleep 30
        fi
        
        # Final service verification (nginxは既に設定済み)
        echo "サービスの最終検証を実施中..."
        max_attempts=12
        wait_time=30
        
        for attempt in $(seq 1 $max_attempts); do
            echo "サービスの可用性を検証中 (attempt $attempt/$max_attempts)..."
            
            if curl -s -f "http://127.0.0.1:8080" >/dev/null 2>&1; then
                echo "Difyサービスの検証に成功しました"
                break
            fi
            
            if [ $attempt -lt $max_attempts ]; then
                echo "サービスがまだ準備できていません。${wait_time}秒待機してから再試行します..."
                sleep $wait_time
            else
                echo "サービスの検証が$max_attempts回の試行後に失敗しました"
                echo "http://${EXTERNAL_IP}/ を手動でアクセスして確認してください"
            fi
        done
        
        echo "========================================"
        echo "Difyが準備完了しました。"
        echo "  Dify:       http://${EXTERNAL_IP}/"
        echo "  本アプリ:   http://${EXTERNAL_IP}/ai"
        echo "  API:        http://${EXTERNAL_IP}/ai/api"
        echo "========================================"
    fi
else
    echo "Difyインストールが無効になっています。スキップします。"
fi

echo "初期化が完了しました。"
