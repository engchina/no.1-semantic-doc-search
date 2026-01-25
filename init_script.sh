#!/bin/bash
set -euo pipefail

# Redirect all output to log file
exec > >(tee -a /var/log/init_script.log) 2>&1

echo "アプリケーションのセットアップを初期化中..."

# Configuration
INSTALL_DIR="/u01/aipoc"
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
    fonts-ipafont-gothic \
    fonts-ipafont-mincho \
    fonts-noto-cjk \
    fonts-noto-cjk-extra \
    fonts-ipafont \
    fonts-takao \
    fonts-wqy-microhei \
    fonts-wqy-zenhei

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
    
    # Set ADB OCID (if available)
    if [ -f "${INSTALL_DIR}/props/adb_ocid.txt" ]; then
        ADB_OCID=$(cat "${INSTALL_DIR}/props/adb_ocid.txt")
        sed -i "s|ADB_OCID=.*|ADB_OCID=${ADB_OCID}|g" .env
    fi
    
    # Set Oracle Client Library Directory
    sed -i "s|ORACLE_CLIENT_LIB_DIR=.*|ORACLE_CLIENT_LIB_DIR=${INSTANTCLIENT_DIR}|g" .env
    
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
    
    # Configure nginx
    echo "nginxを設定中..."
    cat > /etc/nginx/sites-available/semantic-doc-search << 'NGINX_EOF'
server {
    listen 80;
    server_name _;

    # ログ設定
    access_log /var/log/nginx/semantic-doc-search-access.log;
    error_log /var/log/nginx/semantic-doc-search-error.log warn;

    # クライアント最大ボディサイズ（アップロード用）
    client_max_body_size 100M;

    # フロントエンド（静的ファイル）
    location / {
        proxy_pass http://127.0.0.1:5175;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }

    # APIエンドポイント
    location /api/ {
        proxy_pass http://127.0.0.1:8081/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 300s;
        proxy_send_timeout 300s;
    }

    # ヘルスチェック
    location /health {
        proxy_pass http://127.0.0.1:8081/health;
        proxy_set_header Host $host;
        access_log off;
    }
}
NGINX_EOF

    # サイトを有効化
    ln -sf /etc/nginx/sites-available/semantic-doc-search /etc/nginx/sites-enabled/
    
    # デフォルトサイトを無効化
    rm -f /etc/nginx/sites-enabled/default
    
    # nginx設定をテスト
    echo "nginx設定をテスト中..."
    nginx -t
    
    # nginxをリロード
    echo "nginxをリロード中..."
    systemctl reload nginx || systemctl restart nginx
    
    # nginx自動起動を有効化
    echo "nginx自動起動を有効化中..."
    systemctl enable nginx
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

echo "セマンティック文書検索バックエンドサービスを起動中..."
# 環境変数からAPI_HOSTとAPI_PORTを読み取る（デフォルト値付き）
API_HOST=${API_HOST:-0.0.0.0}
API_PORT=${API_PORT:-8081}
nohup uv run --directory backend uvicorn app.main:app --host "${API_HOST}" --port "${API_PORT}" > /var/log/semantic-doc-search-backend.log 2>&1 &

sleep 5

echo "セマンティック文書検索フロントエンドサービスを起動中..."
cd /u01/aipoc/no.1-semantic-doc-search/frontend
nohup npm run preview -- --host 0.0.0.0 --port 5175 > /var/log/semantic-doc-search-frontend.log 2>&1 &

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

echo "初期化が完了しました。"
