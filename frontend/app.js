// ========================================
// グローバル変数
// ========================================
// 開発時はViteのプロキシを使うため空文字列、本番ビルド時は環境変数から設定
const API_BASE = import.meta.env.VITE_API_BASE || '';

let selectedFile = null;
let documentsCache = [];
let isLoggedIn = false;
let loginToken = null;
let loginUser = null;
let debugMode = false;
let requireLogin = true;

// AI Assistant状態
let copilotOpen = false;
let copilotExpanded = false;
let copilotMessages = [];
let copilotLoading = false;
let copilotImages = [];

// テーブル一覧ページング状態
let dbTablesPage = 1;           // 現在のページ
let dbTablesPageSize = 20;      // ページサイズ
let dbTablesTotalPages = 1;     // 総ページ数

// テーブル一覧選択状態
let selectedDbTables = [];              // 選択されたテーブル名の配列
let dbTablesBatchDeleteLoading = false; // 削除処理中フラグ
let currentPageDbTables = [];           // 現在ページのテーブル一覧（チェック用）

// ========================================
// ユーティリティ関数
// ========================================

/**
 * APIコールヘルパー（認証トークン付き）
 */
async function apiCall(endpoint, options = {}) {
  // API_BASEが空の場合は相対パス、設定されている場合は絶対パス
  const url = API_BASE ? `${API_BASE}${endpoint}` : endpoint;
  const headers = options.headers || {};
  
  // トークンがあれば追加
  if (loginToken) {
    headers['Authorization'] = `Bearer ${loginToken}`;
  }
  
  const response = await fetch(url, {
    ...options,
    headers
  });
  
  // 401エラーの場合、デバッグモードでなければログイン画面へ
  if (response.status === 401 && !debugMode) {
    showLoginModal();
    throw new Error('認証が必要です');
  }
  
  if (!response.ok) {
    const error = await response.json().catch(() => ({ detail: response.statusText }));
    throw new Error(error.detail || 'リクエストに失敗しました');
  }
  
  return await response.json();
}

/**
 * Toastメッセージを表示
 */
function showToast(message, type = 'info') {
  const container = document.getElementById('toastContainer');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  
  const icon = type === 'success' ? '✓' : type === 'error' ? '✕' : type === 'warning' ? '⚠' : 'ℹ';
  
  toast.innerHTML = `
    <div class="toast-icon">${icon}</div>
    <div class="toast-content">
      <div class="toast-message">${message}</div>
    </div>
    <div class="toast-close" onclick="this.parentElement.remove()">✕</div>
  `;
  
  container.appendChild(toast);
  
  setTimeout(() => {
    toast.classList.add('removing');
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}

/**
 * ローディングオーバーレイを表示/非表示
 */
function showLoading(message = '処理中...') {
  const existing = document.getElementById('loadingOverlay');
  if (existing) return;
  
  const overlay = document.createElement('div');
  overlay.id = 'loadingOverlay';
  overlay.className = 'loading-overlay';
  overlay.innerHTML = `
    <div class="loading-overlay-content">
      <div class="loading-spinner">
        <svg class="loading-spinner-svg" viewBox="0 0 50 50">
          <defs>
            <linearGradient id="spinner-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" style="stop-color:#667eea;stop-opacity:1" />
              <stop offset="100%" style="stop-color:#764ba2;stop-opacity:1" />
            </linearGradient>
          </defs>
          <circle class="loading-spinner-circle" cx="25" cy="25" r="20" fill="none" stroke-width="4"></circle>
        </svg>
      </div>
      <div class="loading-overlay-text">${message}</div>
    </div>
  `;
  document.body.appendChild(overlay);
}

function hideLoading() {
  const overlay = document.getElementById('loadingOverlay');
  if (overlay) overlay.remove();
}

/**
 * ファイルサイズを人間が読みやすい形式に変換
 */
function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

/**
 * 日時フォーマット
 */
function formatDateTime(isoString) {
  const date = new Date(isoString);
  return date.toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// ========================================
// タブ切り替え
// ========================================

function switchTab(tabName) {
  // タブボタンのアクティブ状態を更新
  document.querySelectorAll('.apex-tab').forEach(tab => {
    tab.classList.remove('active');
  });
  event.target.classList.add('active');
  
  // タブコンテンツの表示切り替え
  document.querySelectorAll('.tab-content').forEach(content => {
    content.style.display = 'none';
  });
  document.getElementById(`tab-${tabName}`).style.display = 'block';
  
  // タブに応じた初期化処理
  // 注: 文書管理タブの自動刷新は無効（🔄 更新ボタンで手動刷新）
  if (tabName === 'settings') {
    loadOciSettings();
    loadObjectStorageSettings(); // Object Storage設定も読み込む
  } else if (tabName === 'database') {
    loadDbConnectionSettings();
  }
}

// ========================================
// 検索機能
// ========================================

async function performSearch() {
  const query = document.getElementById('searchQuery').value.trim();
  const topK = parseInt(document.getElementById('topK').value) || 10;
  const minScore = parseFloat(document.getElementById('minScore').value) || 0;
  
  if (!query) {
    showToast('検索クエリを入力してください', 'warning');
    return;
  }
  
  try {
    showLoading('検索中...');
    
    const data = await apiCall('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, top_k: topK, min_score: minScore })
    });
    
    hideLoading();
    displaySearchResults(data);
    
  } catch (error) {
    hideLoading();
    showToast(`検索エラー: ${error.message}`, 'error');
  }
}

function displaySearchResults(data) {
  const resultsDiv = document.getElementById('searchResults');
  const summarySpan = document.getElementById('searchResultsSummary');
  const listDiv = document.getElementById('searchResultsList');
  
  if (data.results.length === 0) {
    resultsDiv.style.display = 'block';
    summarySpan.textContent = '検索結果なし';
    listDiv.innerHTML = `
      <div style="text-align: center; padding: 40px; color: #64748b;">
        <div style="font-size: 48px; margin-bottom: 16px;">🔍</div>
        <div style="font-size: 16px; font-weight: 500;">検索結果が見つかりませんでした</div>
        <div style="font-size: 14px; margin-top: 8px;">別のキーワードで検索してみてください</div>
      </div>
    `;
    return;
  }
  
  resultsDiv.style.display = 'block';
  summarySpan.textContent = `${data.total_results}件 (${data.processing_time.toFixed(2)}秒)`;
  
  listDiv.innerHTML = data.results.map((result, index) => `
    <div class="card" style="margin-bottom: 16px;">
      <div class="card-header" style="display: flex; justify-content: space-between; align-items: center;">
        <div style="display: flex; align-items: center; gap: 12px;">
          <span class="badge badge-info">#${index + 1}</span>
          <span style="font-weight: 600;">${result.filename}</span>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          ${result.page_number ? `<span class="badge badge-neutral">ページ ${result.page_number}</span>` : ''}
          <span class="badge badge-success">スコア: ${(result.score * 100).toFixed(1)}%</span>
        </div>
      </div>
      <div class="card-body">
        <div style="white-space: pre-wrap; line-height: 1.6; color: #1e293b; background: #f8fafc; padding: 16px; border-radius: 6px; border-left: 4px solid #667eea;">
          ${highlightQuery(result.chunk_text, data.query)}
        </div>
      </div>
    </div>
  `).join('');
}

function highlightQuery(text, query) {
  // シンプルなハイライト処理
  const words = query.split(/\s+/);
  let highlighted = text;
  
  words.forEach(word => {
    const regex = new RegExp(`(${word})`, 'gi');
    highlighted = highlighted.replace(regex, '<mark style="background: #fef08a; padding: 2px 4px; border-radius: 2px;">$1</mark>');
  });
  
  return highlighted;
}

function clearSearchResults() {
  document.getElementById('searchQuery').value = '';
  document.getElementById('searchResults').style.display = 'none';
}

// ========================================
// 文書管理
// ========================================

// 複数ファイルアップロード用の状態管理
let selectedMultipleFiles = [];
const MAX_FILES = 10;

/**
 * 複数ファイル選択ハンドラー
 */
function handleMultipleFileSelect(event) {
  const files = Array.from(event.target.files);
  
  if (files.length === 0) {
    return;
  }
  
  // 最大10ファイルチェック
  if (files.length > MAX_FILES) {
    showToast(`アップロード可能なファイル数は最大${MAX_FILES}個です`, 'warning');
    event.target.value = '';
    return;
  }
  
  selectedMultipleFiles = files;
  displaySelectedFiles();
  document.getElementById('uploadMultipleBtn').disabled = false;
}

/**
 * ドラッグ＆ドロップハンドラー
 */
function handleDropForMultipleInput(event) {
  event.preventDefault();
  event.stopPropagation();
  
  const dt = event.dataTransfer;
  const files = Array.from(dt.files);
  
  if (files.length === 0) {
    return;
  }
  
  // 最大10ファイルチェック
  if (files.length > MAX_FILES) {
    showToast(`アップロード可能なファイル数は最大${MAX_FILES}個です`, 'warning');
    return;
  }
  
  selectedMultipleFiles = files;
  displaySelectedFiles();
  document.getElementById('uploadMultipleBtn').disabled = false;
  
  // ドラッグオーバースタイルを解除
  event.currentTarget.classList.remove('border-purple-400');
  event.currentTarget.classList.add('border-gray-300');
}

/**
 * 選択されたファイルリストを表示
 */
function displaySelectedFiles() {
  const listDiv = document.getElementById('selectedFilesList');
  const countSpan = document.getElementById('selectedFilesCount');
  const contentDiv = document.getElementById('selectedFilesListContent');
  
  if (selectedMultipleFiles.length === 0) {
    listDiv.style.display = 'none';
    return;
  }
  
  listDiv.style.display = 'block';
  countSpan.textContent = selectedMultipleFiles.length;
  
  contentDiv.innerHTML = selectedMultipleFiles.map((file, index) => `
    <div class="flex items-center justify-between p-2 bg-white border border-gray-200 rounded">
      <div class="flex items-center gap-2 flex-1">
        <span class="text-xs font-semibold text-purple-600">#${index + 1}</span>
        <div class="flex-1">
          <div class="text-sm font-medium text-gray-800">📄 ${file.name}</div>
          <div class="text-xs text-gray-500">${formatFileSize(file.size)}</div>
        </div>
      </div>
      <button 
        onclick="removeFileFromSelection(${index})" 
        class="text-xs text-red-600 hover:text-red-800 hover:bg-red-50 px-2 py-1 rounded transition"
      >
        削除
      </button>
    </div>
  `).join('');
}

/**
 * ファイルリストから削除
 */
function removeFileFromSelection(index) {
  // 配列をフィルタリングして新しい配列を作成
  const newFiles = [];
  for (let i = 0; i < selectedMultipleFiles.length; i++) {
    if (i !== index) {
      newFiles.push(selectedMultipleFiles[i]);
    }
  }
  selectedMultipleFiles = newFiles;
  
  // すべて削除された場合はクリア
  if (selectedMultipleFiles.length === 0) {
    clearMultipleFileSelection();
  } else {
    // ファイルinputをリセット（残りのファイルを保持しながら）
    const input = document.getElementById('fileInputMultiple');
    input.value = ''; // inputをリセット
    displaySelectedFiles();
    // アップロードボタンを有効化
    document.getElementById('uploadMultipleBtn').disabled = selectedMultipleFiles.length === 0;
  }
}

/**
 * 選択をクリア
 */
function clearMultipleFileSelection() {
  selectedMultipleFiles = [];
  document.getElementById('fileInputMultiple').value = '';
  document.getElementById('uploadMultipleBtn').disabled = true;
  document.getElementById('selectedFilesList').style.display = 'none';
  document.getElementById('uploadProgress').style.display = 'none';
}

/**
 * 複数ファイルをアップロード
 */
async function uploadMultipleDocuments() {
  if (selectedMultipleFiles.length === 0) {
    showToast('ファイルを選択してください', 'warning');
    return;
  }
  
  try {
    // ボタンを無効化
    document.getElementById('uploadMultipleBtn').disabled = true;
    
    // オーバーレイを表示
    showLoading(`${selectedMultipleFiles.length}個のファイルをアップロード中...`);
    
    // FormDataを作成
    const formData = new FormData();
    selectedMultipleFiles.forEach(file => {
      formData.append('files', file);
    });
    
    // API呼び出し
    const data = await apiCall('/api/documents/upload/multiple', {
      method: 'POST',
      body: formData
    });
    
    // オーバーレイを非表示
    hideLoading();
    
    // 結果を表示
    displayUploadResults(data);
    
    // 成功した場合のトースト
    if (data.success) {
      showToast(`✅ ${data.success_count}件のファイルアップロードが完了しました`, 'success');
    } else {
      showToast(`⚠️ ${data.message}`, 'warning');
    }
    
    // フォームをリセット（5秒後：showToastと同じタイミング）
    setTimeout(() => {
      clearMultipleFileSelection();
      // 注: 文書リストの自動刷新は行わない（🔄 更新ボタンで手動刷新）
    }, 5000);
    
  } catch (error) {
    hideLoading();
    document.getElementById('uploadProgress').style.display = 'none';
    document.getElementById('uploadMultipleBtn').disabled = false;
    showToast(`アップロードエラー: ${error.message}`, 'error');
  }
}

/**
 * アップロード結果を表示
 */
function displayUploadResults(data) {
  const progressDiv = document.getElementById('uploadProgress');
  progressDiv.style.display = 'block';
  
  const results = data.results || [];
  
  const successResults = results.filter(r => r.success);
  const failedResults = results.filter(r => !r.success);
  
  progressDiv.innerHTML = `
    <div class="bg-white border border-gray-200 rounded-lg p-4">
      <div class="mb-3">
        <div class="text-sm font-semibold text-gray-800 mb-2">アップロード結果</div>
        <div class="flex items-center gap-4 text-xs">
          <span class="text-green-600 font-semibold">✅ 成功: ${data.success_count}件</span>
          ${data.failed_count > 0 ? `<span class="text-red-600 font-semibold">❌ 失敗: ${data.failed_count}件</span>` : ''}
        </div>
      </div>
      
      <div class="space-y-2">
        ${results.map(result => `
          <div class="flex items-start gap-2 p-2 rounded ${result.success ? 'bg-green-50 border border-green-200' : 'bg-red-50 border border-red-200'}">
            <span class="text-lg">${result.success ? '✅' : '❌'}</span>
            <div class="flex-1">
              <div class="text-sm font-medium ${result.success ? 'text-green-800' : 'text-red-800'}">${result.filename}</div>
              <div class="text-xs ${result.success ? 'text-green-600' : 'text-red-600'} mt-1">${result.message}</div>
              ${result.success && result.page_count ? `<div class="text-xs text-gray-500 mt-1">ページ数: ${result.page_count}</div>` : ''}
            </div>
          </div>
        `).join('')}
      </div>
    </div>
  `;
}

function handleFileSelect(event) {
  const file = event.target.files[0];
  if (file) {
    selectedFile = file;
    document.getElementById('uploadBtn').disabled = false;
    
    const statusDiv = document.getElementById('uploadStatus');
    statusDiv.style.display = 'block';
    statusDiv.innerHTML = `
      <div class="mt-3 p-3 bg-green-50 border border-green-200 rounded-lg">
        <div class="flex items-center justify-between mb-2">
          <span class="text-sm font-medium text-gray-700">ファイルがアップロードされました</span>
          <button onclick="clearFileSelection();" class="text-xs text-red-600 hover:text-red-800 hover:underline">クリア</button>
        </div>
        <div class="text-sm text-gray-600">
          📄 ${file.name} (${formatFileSize(file.size)})
        </div>
      </div>
    `;
  }
}

function clearFileSelection() {
  selectedFile = null;
  document.getElementById('fileInput').value = '';
  document.getElementById('uploadBtn').disabled = true;
  document.getElementById('uploadStatus').style.display = 'none';
}

async function uploadDocument() {
  if (!selectedFile) {
    showToast('ファイルを選択してください', 'warning');
    return;
  }
  
  try {
    showLoading('文書をアップロード中...');
    
    const formData = new FormData();
    formData.append('file', selectedFile);
    
    const data = await apiCall('/api/documents/upload', {
      method: 'POST',
      body: formData
    });
    
    hideLoading();
    showToast('文書のアップロードと処理が完了しました', 'success');
    
    // フォームをリセット
    clearFileSelection();
    
    // 文書リストを更新
    await loadDocuments();
    
  } catch (error) {
    hideLoading();
    showToast(`アップロードエラー: ${error.message}`, 'error');
  }
}

async function loadDocuments() {
  try {
    const data = await apiCall('/api/documents');
    documentsCache = data.documents;
    displayDocumentsList(data.documents);
  } catch (error) {
    showToast(`エラー: ${error.message}`, 'error');
  }
}

// ========================================
// OCI Object Storage一覧表示
// ========================================

// 状態管理
let ociObjectsPage = 1;
let ociObjectsPageSize = 20;
let ociObjectsPrefix = "";
let selectedOciObjects = [];
let ociObjectsBatchDeleteLoading = false;
let allOciObjects = []; // 全オブジェクトのキャッシュ（親子関係処理用）

/**
 * 指定したフォルダの子オブジェクトをすべて取得
 */
function getChildObjects(folderName) {
  // フォルダ名が/で終わっていることを確認
  const folderPath = folderName.endsWith('/') ? folderName : folderName + '/';
  
  // フォルダの配下にあるすべてのオブジェクトを検索
  return allOciObjects.filter(obj => obj.name.startsWith(folderPath));
}

/**
 * 文書一覧を更新(通知付き)
 */
window.refreshDocumentsWithNotification = function() {
  showToast('🔄 文書一覧を更新します...', 'info');
  loadOciObjects();
}

/**
 * 文書ステータスバッジを更新
 */
function updateDocumentsStatusBadge(text, type = 'info') {
  const badge = document.getElementById('documentsStatusBadge');
  if (!badge) return;
  
  badge.textContent = text;
  
  // タイプに応じてスタイルを変更
  badge.style.background = '';
  badge.style.color = '';
  badge.classList.remove('bg-green-100', 'text-green-800', 'bg-red-100', 'text-red-800', 'bg-gray-100', 'text-gray-600');
  
  if (type === 'success') {
    badge.classList.add('bg-green-100', 'text-green-800');
  } else if (type === 'error') {
    badge.classList.add('bg-red-100', 'text-red-800');
  } else {
    badge.classList.add('bg-gray-100', 'text-gray-600');
  }
}

/**
 * OCI Object Storage一覧を読み込む
 */
async function loadOciObjects() {
  try {
    showLoading('OCI Object Storage一覧を取得中...');
    
    const params = new URLSearchParams({
      prefix: ociObjectsPrefix,
      page: ociObjectsPage.toString(),
      page_size: ociObjectsPageSize.toString()
    });
    
    const data = await apiCall(`/api/oci/objects?${params}`);
    
    hideLoading();
    
    if (!data.success) {
      showToast(`エラー: ${data.message || 'オブジェクト一覧取得失敗'}`, 'error');
      updateDocumentsStatusBadge('エラー', 'error');
      return;
    }
    
    // 全オブジェクトキャッシュを更新（ページネーションで分割されているため、一度取得したものを保持）
    // 注: ページ変更時には前ページのデータも保持
    data.objects.forEach(obj => {
      const existingIndex = allOciObjects.findIndex(o => o.name === obj.name);
      if (existingIndex >= 0) {
        allOciObjects[existingIndex] = obj;
      } else {
        allOciObjects.push(obj);
      }
    });
    
    displayOciObjectsList(data);
    
    // バッジを更新
    const totalCount = data.pagination?.total || 0;
    updateDocumentsStatusBadge(`${totalCount}件`, 'success');
    
  } catch (error) {
    hideLoading();
    showToast(`OCI Object Storage一覧取得エラー: ${error.message}`, 'error');
    updateDocumentsStatusBadge('エラー', 'error');
  }
}

/**
 * OCI Object Storage一覧を表示
 */
function displayOciObjectsList(data) {
  const listDiv = document.getElementById('documentsList');
  
  const objects = data.objects || [];
  const pagination = data.pagination || {};
  
  if (objects.length === 0) {
    listDiv.innerHTML = `
      <div style="text-align: center; padding: 40px; color: #64748b;">
        <div style="font-size: 48px; margin-bottom: 16px;">📁</div>
        <div style="font-size: 16px; font-weight: 500;">オブジェクトがありません</div>
        <div style="font-size: 14px; margin-top: 8px;">バケット: ${data.bucket_name || '-'}</div>
      </div>
    `;
    return;
  }
  
  // 全ページ選択状態をチェック
  const allPageSelected = objects.every(obj => selectedOciObjects.includes(obj.name));
  
  // 選択ボタンHTML
  const selectionButtonsHtml = `
    <div class="flex items-center gap-2 mb-2">
      <button 
        class="px-3 py-1 text-xs border rounded transition-colors ${ociObjectsBatchDeleteLoading ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-100'}" 
        onclick="selectAllOciObjects()" 
        ${ociObjectsBatchDeleteLoading ? 'disabled' : ''}
      >
        すべて選択
      </button>
      <button 
        class="px-3 py-1 text-xs border rounded transition-colors ${ociObjectsBatchDeleteLoading ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-100'}" 
        onclick="clearAllOciObjects()" 
        ${ociObjectsBatchDeleteLoading ? 'disabled' : ''}
      >
        すべて解除
      </button>
      <button 
        class="px-3 py-1 text-xs rounded transition-colors ${selectedOciObjects.length === 0 || ociObjectsBatchDeleteLoading ? 'bg-gray-300 text-gray-500 cursor-not-allowed' : 'bg-red-500 hover:bg-red-600 text-white'}" 
        onclick="deleteSelectedOciObjects()" 
        ${selectedOciObjects.length === 0 || ociObjectsBatchDeleteLoading ? 'disabled' : ''}
        title="選択されたアイテム数（フォルダ配下の子アイテムを含む）: ${selectedOciObjects.length}件"
      >
        🗑️ 削除 (${selectedOciObjects.length}件)
      </button>
    </div>
  `;
  
  // ページネーションUI生成
  const paginationHtml = UIComponents.renderPagination({
    currentPage: pagination.current_page,
    totalPages: pagination.total_pages,
    totalItems: pagination.total,
    startNum: pagination.start_row,
    endNum: pagination.end_row,
    onPrevClick: 'handleOciObjectsPrevPage()',
    onNextClick: 'handleOciObjectsNextPage()',
    onJumpClick: 'handleOciObjectsJumpPage',
    inputId: 'ociObjectsPageInput',
    disabled: ociObjectsBatchDeleteLoading
  });
  
  listDiv.innerHTML = `
    <div>
      ${selectionButtonsHtml}
      ${paginationHtml}
      <div class="table-wrapper-scrollable">
        <table class="data-table">
          <thead>
            <tr>
              <th style="width: 40px;"><input type="checkbox" id="ociObjectsHeaderCheckbox" onchange="toggleSelectAllOciObjects(this.checked)" ${allPageSelected ? 'checked' : ''} class="w-4 h-4 rounded" ${ociObjectsBatchDeleteLoading ? 'disabled' : ''}></th>
              <th>タイプ</th>
              <th>名前</th>
              <th>サイズ</th>
              <th>作成日時</th>
            </tr>
          </thead>
          <tbody>
            ${objects.map(obj => {
              const isFolder = obj.type === 'folder';
              const icon = isFolder ? '📁' : '📄';
              const typeLabel = isFolder ? 'フォルダ' : 'ファイル';
              // HTML属性用にエスケープ
              const escapedNameForHtml = obj.name.replace(/"/g, '&quot;');
              
              // 階層深度に応じたインデントを計算（20px×深度）
              const depth = obj.depth || 0;
              const indentPx = depth * 20;
              
              // 表示名（フルパスではなく最後のセグメントのみ）
              let displayName = obj.name;
              if (obj.name.includes('/')) {
                const parts = obj.name.split('/');
                if (isFolder) {
                  // フォルダの場合、末尾の/を除いて最後のセグメント
                  displayName = parts[parts.length - 2] || obj.name;
                } else {
                  // ファイルの場合、最後のセグメント
                  displayName = parts[parts.length - 1] || obj.name;
                }
              }
              
              return `
                <tr>
                  <td><input type="checkbox" data-object-name="${escapedNameForHtml}" onchange="toggleOciObjectSelection(this.getAttribute('data-object-name'))" ${selectedOciObjects.includes(obj.name) ? 'checked' : ''} class="w-4 h-4 rounded" ${ociObjectsBatchDeleteLoading ? 'disabled' : ''}></td>
                  <td>${icon} ${typeLabel}</td>
                  <td style="font-weight: 500; font-family: monospace; max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                    <span style="display: inline-block; padding-left: ${indentPx}px;">${displayName}</span>
                  </td>
                  <td>${isFolder ? '-' : formatFileSize(obj.size)}</td>
                  <td>${obj.time_created ? formatDateTime(obj.time_created) : '-'}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

/**
 * ページネーション - 前ページ
 */
function handleOciObjectsPrevPage() {
  if (ociObjectsPage > 1 && !ociObjectsBatchDeleteLoading) {
    ociObjectsPage--;
    loadOciObjects();
  }
}

/**
 * ページネーション - 次ページ
 */
function handleOciObjectsNextPage() {
  if (!ociObjectsBatchDeleteLoading) {
    ociObjectsPage++;
    loadOciObjects();
  }
}

/**
 * ページネーション - ページジャンプ
 */
function handleOciObjectsJumpPage() {
  if (ociObjectsBatchDeleteLoading) return;
  
  const input = document.getElementById('ociObjectsPageInput');
  const page = parseInt(input.value);
  
  if (page && page >= 1) {
    ociObjectsPage = page;
    loadOciObjects();
  }
}

/**
 * オブジェクト選択状態をトグル（親子関係対応）
 */
function toggleOciObjectSelection(objectName) {
  if (ociObjectsBatchDeleteLoading) return;
  
  const index = selectedOciObjects.indexOf(objectName);
  const isCurrentlySelected = index > -1;
  
  if (isCurrentlySelected) {
    // 選択解除
    selectedOciObjects.splice(index, 1);
    
    // フォルダの場合、子オブジェクトも解除
    if (objectName.endsWith('/')) {
      const children = getChildObjects(objectName);
      children.forEach(child => {
        const childIndex = selectedOciObjects.indexOf(child.name);
        if (childIndex > -1) {
          selectedOciObjects.splice(childIndex, 1);
        }
      });
    }
  } else {
    // 選択
    selectedOciObjects.push(objectName);
    
    // フォルダの場合、子オブジェクトも選択
    if (objectName.endsWith('/')) {
      const children = getChildObjects(objectName);
      children.forEach(child => {
        if (!selectedOciObjects.includes(child.name)) {
          selectedOciObjects.push(child.name);
        }
      });
    }
  }
  
  // 再描画
  loadOciObjects();
}

/**
 * 全選択トグル（ヘッダーチェックボックス）（親子関係対応）
 */
function toggleSelectAllOciObjects(checked) {
  if (ociObjectsBatchDeleteLoading) return;
  
  // 現在表示中のオブジェクトを取得
  const checkboxes = document.querySelectorAll('#documentsList tbody input[type="checkbox"]');
  const currentPageObjects = Array.from(checkboxes).map(cb => {
    return cb.getAttribute('data-object-name');
  }).filter(Boolean);
  
  if (checked) {
    // 現在ページのオブジェクトをすべて選択（親子関係を考慮）
    currentPageObjects.forEach(objName => {
      if (!selectedOciObjects.includes(objName)) {
        selectedOciObjects.push(objName);
      }
      
      // フォルダの場合、子オブジェクトも選択
      if (objName.endsWith('/')) {
        const children = getChildObjects(objName);
        children.forEach(child => {
          if (!selectedOciObjects.includes(child.name)) {
            selectedOciObjects.push(child.name);
          }
        });
      }
    });
  } else {
    // 現在ページのオブジェクトをすべて解除（親子関係を考慮）
    currentPageObjects.forEach(objName => {
      const index = selectedOciObjects.indexOf(objName);
      if (index > -1) {
        selectedOciObjects.splice(index, 1);
      }
      
      // フォルダの場合、子オブジェクトも解除
      if (objName.endsWith('/')) {
        const children = getChildObjects(objName);
        children.forEach(child => {
          const childIndex = selectedOciObjects.indexOf(child.name);
          if (childIndex > -1) {
            selectedOciObjects.splice(childIndex, 1);
          }
        });
      }
    });
  }
  
  // 再描画
  loadOciObjects();
}

/**
 * すべて選択（親子関係対応）
 */
function selectAllOciObjects() {
  if (ociObjectsBatchDeleteLoading) return;
  
  const checkboxes = document.querySelectorAll('#documentsList tbody input[type="checkbox"]');
  const currentPageObjects = Array.from(checkboxes).map(cb => {
    return cb.getAttribute('data-object-name');
  }).filter(Boolean);
  
  currentPageObjects.forEach(objName => {
    if (!selectedOciObjects.includes(objName)) {
      selectedOciObjects.push(objName);
    }
    
    // フォルダの場合、子オブジェクトも選択
    if (objName.endsWith('/')) {
      const children = getChildObjects(objName);
      children.forEach(child => {
        if (!selectedOciObjects.includes(child.name)) {
          selectedOciObjects.push(child.name);
        }
      });
    }
  });
  
  loadOciObjects();
}

/**
 * すべて解除
 */
function clearAllOciObjects() {
  if (ociObjectsBatchDeleteLoading) return;
  selectedOciObjects = [];
  loadOciObjects();
}

/**
 * 選択されたオブジェクトを削除
 */
async function deleteSelectedOciObjects() {
  if (selectedOciObjects.length === 0) {
    showToast('削除するオブジェクトを選択してください', 'warning');
    return;
  }
  
  const count = selectedOciObjects.length;
  const confirmed = await showConfirmModal(
    `選択された${count}件のオブジェクトを削除しますか？\n\nこの操作は元に戻せません。`,
    'オブジェクト削除の確認'
  );
  
  if (!confirmed) {
    return;
  }
  
  // 処理中表示を設定
  ociObjectsBatchDeleteLoading = true;
  loadOciObjects();
  
  try {
    // 一括削除APIを呼び出す
    const response = await apiCall('/api/oci/objects/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ object_names: selectedOciObjects })
    });
    
    if (response.success) {
      showToast(`${count}件のオブジェクトを削除しました`, 'success');
      // 選択をクリア
      selectedOciObjects = [];
      // ページを1にリセット
      ociObjectsPage = 1;
    } else {
      showToast(`削除エラー: ${response.message || '不明なエラー'}`, 'error');
    }
  } catch (error) {
    showToast(`削除エラー: ${error.message}`, 'error');
  } finally {
    // 処理中表示を解除
    ociObjectsBatchDeleteLoading = false;
    // 一覧を再読み込み
    loadOciObjects();
  }
}

function displayDocumentsList(documents) {
  const listDiv = document.getElementById('documentsList');
  
  if (documents.length === 0) {
    listDiv.innerHTML = `
      <div style="text-align: center; padding: 40px; color: #64748b;">
        <div style="font-size: 48px; margin-bottom: 16px;">📁</div>
        <div style="font-size: 16px; font-weight: 500;">登録済み文書がありません</div>
        <div style="font-size: 14px; margin-top: 8px;">文書をアップロードして検索を開始してください</div>
      </div>
    `;
    return;
  }
  
  listDiv.innerHTML = `
    <div class="table-wrapper">
      <table class="data-table">
        <thead>
          <tr>
            <th>ファイル名</th>
            <th>ページ数</th>
            <th>サイズ</th>
            <th>アップロード日時</th>
            <th>ステータス</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          ${documents.map(doc => `
            <tr>
              <td style="font-weight: 500;">${doc.filename}</td>
              <td>${doc.page_count || '-'}</td>
              <td>${formatFileSize(doc.file_size)}</td>
              <td>${formatDateTime(doc.uploaded_at)}</td>
              <td>
                <span class="badge ${doc.status === 'completed' ? 'badge-success' : 'badge-warning'}">
                  ${doc.status === 'completed' ? '✓ 完了' : '⏳ 処理中'}
                </span>
              </td>
              <td>
                <button class="apex-button-secondary" style="padding: 4px 8px; font-size: 12px;" onclick="deleteDocument('${doc.document_id}', '${doc.filename}')">
                  🗑️ 削除
                </button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

async function deleteDocument(documentId, filename) {
  const confirmed = await showConfirmModal(
    `文書「${filename}」を削除してもよろしいですか?`,
    '文書削除の確認'
  );
  
  if (!confirmed) {
    return;
  }
  
  try {
    showLoading('文書を削除中...');
    
    await apiCall(`/api/documents/${documentId}`, {
      method: 'DELETE'
    });
    
    hideLoading();
    showToast('文書を削除しました', 'success');
    
    await loadDocuments();
    
  } catch (error) {
    hideLoading();
    showToast(`削除エラー: ${error.message}`, 'error');
  }
}

// ========================================
// OCI設定
// ========================================

// OCI設定の状態管理
let ociSettings = {
  user_ocid: '',
  tenancy_ocid: '',
  fingerprint: '',
  region: 'us-chicago-1',
  key_content: '',
  bucket_name: '',
  namespace: ''
};

let ociSettingsStatus = 'not_configured';
let ociLoading = false;
let ociAction = null;
let ociSaveResult = null;
let ociConnectionTestResult = null;

/**
 * OCI設定をロード
 */
async function loadOciSettings() {
  try {
    const data = await apiCall('/api/oci/settings');
    ociSettings = data.settings;
    ociSettings.region = 'us-chicago-1'; // 固定値
    ociSettingsStatus = data.status;
    
    // UIに反映
    document.getElementById('userOcid').value = ociSettings.user_ocid || '';
    document.getElementById('tenancyOcid').value = ociSettings.tenancy_ocid || '';
    document.getElementById('fingerprint').value = ociSettings.fingerprint || '';
    document.getElementById('region').value = 'us-chicago-1';
    document.getElementById('bucketName').value = ociSettings.bucket_name || '';
    document.getElementById('namespace').value = ociSettings.namespace || '';
    
    // Private Key の状態を表示
    updatePrivateKeyStatus();
    
    // ステータスバッジを更新
    updateOciStatusBadge();
    
  } catch (error) {
    // 初回ロード時はエラーでも表示しない（未設定扱い）
  }
}

/**
 * OCI設定を保存
 */
async function saveOciSettings() {
  // 入力値を取得
  const userOcid = document.getElementById('userOcid').value.trim();
  const tenancyOcid = document.getElementById('tenancyOcid').value.trim();
  const fingerprint = document.getElementById('fingerprint').value.trim();
  
  // 入力検証
  if (!userOcid || !tenancyOcid || !fingerprint) {
    showToast('必須項目をすべて入力してください', 'warning');
    return;
  }
  
  // 初回設定時はPrivate Keyが必須
  if (!ociSettings.key_content || ociSettings.key_content === '') {
    if (ociSettingsStatus !== 'configured' && ociSettingsStatus !== 'saved') {
      showToast('Private Keyが必要です', 'warning');
      return;
    }
  }
  
  ociLoading = true;
  ociAction = 'save';
  ociSaveResult = null;
  ociConnectionTestResult = null;
  
  try {
    showLoading('APIキーを保存中...');
    
    // 設定を保存
    const settingsToSave = {
      user_ocid: userOcid,
      tenancy_ocid: tenancyOcid,
      fingerprint: fingerprint,
      region: 'us-chicago-1',
      key_content: ociSettings.key_content,
      bucket_name: document.getElementById('bucketName').value.trim(),
      namespace: document.getElementById('namespace').value.trim()
    };
    
    const result = await apiCall('/api/oci/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settingsToSave)
    });
    
    // レスポンスから設定を更新
    ociSettings = result.settings;
    ociSettings.region = 'us-chicago-1';
    ociSettingsStatus = result.status;
    
    ociSaveResult = {
      success: true,
      message: result.message || '設定を保存しました',
      details: {
        region: result.settings.region,
        user_ocid: result.settings.user_ocid,
        tenancy_ocid: result.settings.tenancy_ocid,
        fingerprint: result.settings.fingerprint
      }
    };
    
    hideLoading();
    showToast(result.message || '設定を保存しました', 'success');
    updateOciStatusBadge();
    
  } catch (error) {
    ociSaveResult = {
      success: false,
      message: '設定の保存に失敗しました'
    };
    hideLoading();
    showToast('設定の保存に失敗しました', 'error');
  } finally {
    ociLoading = false;
    ociAction = null;
  }
}

/**
 * OCI接続テスト
 */
async function testOciConnection() {
  // 入力値を取得
  const userOcid = document.getElementById('userOcid').value.trim();
  const tenancyOcid = document.getElementById('tenancyOcid').value.trim();
  const fingerprint = document.getElementById('fingerprint').value.trim();
  
  // 入力検証
  if (!userOcid || !tenancyOcid || !fingerprint) {
    showToast('必須項目をすべて入力してください', 'warning');
    return;
  }
  
  // 初回設定時はPrivate Keyが必須
  if (!ociSettings.key_content || ociSettings.key_content === '') {
    if (ociSettingsStatus !== 'configured' && ociSettingsStatus !== 'saved') {
      showToast('Private Keyが必要です', 'warning');
      return;
    }
  }
  
  ociLoading = true;
  ociAction = 'test';
  ociConnectionTestResult = null;
  ociSaveResult = null;
  
  try {
    showLoading('OCI接続テスト実行中...');
    
    const result = await apiCall('/api/oci/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: ociSettings })
    });
    
    ociConnectionTestResult = result;
    
    hideLoading();
    
    if (result.success) {
      showToast('OCI接続テストに成功しました', 'success');
    } else {
      showToast('OCI接続テストに失敗しました', 'error');
    }
    
  } catch (error) {
    hideLoading();
    showToast('接続テスト中にエラーが発生しました', 'error');
  } finally {
    ociLoading = false;
    ociAction = null;
  }
}

/**
 * Private Keyファイル選択ハンドラー
 */
function handlePrivateKeyFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  try {
    const reader = new FileReader();
    reader.onload = function(e) {
      const content = e.target.result;
      
      // PEMファイルの厳密な検証
      const pemPattern = /-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?PRIVATE KEY-----/;
      
      if (!content || typeof content !== 'string' || content.trim() === '') {
        showToast('無効なPEMファイル形式です: ファイルが空です', 'error');
        event.target.value = '';
        return;
      }
      
      if (!pemPattern.test(content)) {
        showToast('無効なPEMファイル形式です: 正しいPRIVATE KEYフォーマットが見つかりません', 'error');
        event.target.value = '';
        return;
      }
      
      ociSettings.key_content = content;
      showToast('Private Keyファイルを読み込みました', 'success');
      event.target.value = '';
      updatePrivateKeyStatus();
    };
    reader.onerror = function() {
      showToast('ファイルの読み込みに失敗しました', 'error');
      event.target.value = '';
    };
    reader.readAsText(file);
  } catch (error) {
    showToast('ファイル処理中にエラーが発生しました: ' + error.message, 'error');
    event.target.value = '';
  }
}

/**
 * Private Keyをクリア
 */
function clearPrivateKey() {
  ociSettings.key_content = '';
  const fileInput = document.getElementById('privateKeyFileInput');
  if (fileInput) {
    fileInput.value = '';
  }
  updatePrivateKeyStatus();
}

/**
 * Private Keyステータス表示を更新
 */
function updatePrivateKeyStatus() {
  const statusDiv = document.getElementById('privateKeyStatus');
  if (!statusDiv) return;
  
  const settings = ociSettings;
  
  if (settings.key_content && settings.key_content !== '[CONFIGURED]') {
    statusDiv.innerHTML = `
      <div class="mt-3 p-3 bg-gray-50 rounded-md border border-gray-200">
        <div class="flex items-center justify-between mb-2">
          <span class="text-sm font-medium text-gray-700">ファイルがアップロードされました</span>
          <button onclick="clearPrivateKey();" class="text-xs text-red-600 hover:text-red-800 hover:underline">クリア</button>
        </div>
        <div class="text-xs font-mono text-gray-600 bg-white p-2 rounded border border-gray-200 max-h-32 overflow-y-auto">
          ${settings.key_content.substring(0, 200)}${settings.key_content.length > 200 ? '...' : ''}
        </div>
      </div>
    `;
  } else if (settings.key_content === '[CONFIGURED]') {
    statusDiv.innerHTML = `
      <div class="mt-3 p-3 bg-green-50 rounded-md border border-green-200">
        <div class="flex items-center justify-between">
          <span class="text-sm font-medium text-green-800">✅ Private Keyが設定済み</span>
          <span class="text-xs text-gray-500">再アップロードで更新</span>
        </div>
      </div>
    `;
  } else {
    statusDiv.innerHTML = '';
  }
}

/**
 * OCI設定ステータスバッジを更新
 */
function updateOciStatusBadge() {
  const statusBadge = document.getElementById('ociSettingsStatusBadge');
  if (!statusBadge) return;
  
  if (ociSettingsStatus === 'configured' || ociSettingsStatus === 'saved') {
    statusBadge.textContent = '設定済み';
    statusBadge.className = 'px-2 py-1 text-xs font-semibold rounded-md';
    statusBadge.style.background = '#10b981';
    statusBadge.style.color = '#fff';
  } else {
    statusBadge.textContent = '未設定';
    statusBadge.className = 'px-2 py-1 text-xs font-semibold rounded-md';
    statusBadge.style.background = '#e2e8f0';
    statusBadge.style.color = '#64748b';
  }
}

/**
 * ドラッグ&ドロップハンドラー
 */
function handleDragOver(event) {
  event.preventDefault();
  event.stopPropagation();
  event.currentTarget.classList.add('border-purple-400', 'bg-purple-50');
}

function handleDragLeave(event) {
  event.preventDefault();
  event.stopPropagation();
  event.currentTarget.classList.remove('border-purple-400', 'bg-purple-50');
}

function handleDropForInput(event, inputId) {
  event.preventDefault();
  event.stopPropagation();
  event.currentTarget.classList.remove('border-purple-400', 'bg-purple-50');
  
  const files = event.dataTransfer.files;
  if (files.length > 0) {
    const input = document.getElementById(inputId);
    if (input) {
      input.files = files;
      input.dispatchEvent(new Event('change'));
    }
  }
}

// グローバル関数として公開
window.handlePrivateKeyFileSelect = handlePrivateKeyFileSelect;
window.clearPrivateKey = clearPrivateKey;
window.handleDragOver = handleDragOver;
window.handleDragLeave = handleDragLeave;
window.handleDropForInput = handleDropForInput;

// ========================================
// DB管理
// ========================================

async function loadDbConnectionSettings() {
  try {
    const data = await apiCall('/api/settings/database');
    const settings = data.settings;
    
    document.getElementById('dbUser').value = settings.username || '';
    
    // Walletアップロード状況を表示
    if (settings.wallet_uploaded) {
      const walletStatus = document.getElementById('walletStatus');
      walletStatus.style.display = 'block';
      walletStatus.innerHTML = '<span class="text-green-600">✅ Walletアップロード済み</span>';
      
      // 利用可能なDSNを表示
      if (settings.available_services && settings.available_services.length > 0) {
        const dsnDisplay = document.getElementById('dsnDisplay');
        const dsnSelect = document.getElementById('dbDsn');
        dsnDisplay.style.display = 'block';
        
        dsnSelect.innerHTML = '<option value="">選択してください</option>';
        settings.available_services.forEach(dsn => {
          const option = document.createElement('option');
          option.value = dsn;
          option.textContent = dsn;
          if (dsn === settings.dsn) {
            option.selected = true;
          }
          dsnSelect.appendChild(option);
        });
      }
    }
    
    const statusBadge = document.getElementById('dbConnectionStatusBadge');
    if (data.is_connected) {
      statusBadge.textContent = '接続済み';
      statusBadge.style.background = '#10b981';
      statusBadge.style.color = '#fff';
    } else {
      statusBadge.textContent = '未設定';
      statusBadge.style.background = '#e2e8f0';
      statusBadge.style.color = '#64748b';
    }
    
  } catch (error) {
    showToast(`設定の読み込みエラー: ${error.message}`, 'error');
  }
}

async function refreshDbConnectionFromEnv() {
  try {
    showLoading('接続設定を更新中...');
    
    // 環境変数から情報を取得
    const envData = await apiCall('/api/settings/database/env');
    
    if (!envData.success) {
      hideLoading();
      showToast(envData.message, 'error');
      return;
    }
    
    // ユーザー名を設定
    if (envData.username) {
      document.getElementById('dbUser').value = envData.username;
    }
    
    // Wallet情報を表示
    const walletStatus = document.getElementById('walletStatus');
    if (envData.wallet_exists) {
      walletStatus.style.display = 'block';
      walletStatus.innerHTML = '<span class="text-green-600">✅ Wallet検出済み (' + envData.wallet_location + ')</span>';
      
      // 利用可能なDSNを表示
      if (envData.available_services && envData.available_services.length > 0) {
        const dsnDisplay = document.getElementById('dsnDisplay');
        const dsnSelect = document.getElementById('dbDsn');
        dsnDisplay.style.display = 'block';
        
        dsnSelect.innerHTML = '<option value="">選択してください</option>';
        envData.available_services.forEach(dsn => {
          const option = document.createElement('option');
          option.value = dsn;
          option.textContent = dsn;
          // 環境変数のDSNを選択
          if (dsn === envData.dsn) {
            option.selected = true;
          }
          dsnSelect.appendChild(option);
        });
      }
    } else {
      walletStatus.style.display = 'block';
      walletStatus.innerHTML = '<span class="text-yellow-600">⚠️ Walletが見つかりません。ZIPファイルをアップロードしてください。</span>';
    }
    
    // ステータスバッジを更新（設定ファイルの有無で判定、実際の接続確認はしない）
    const statusBadge = document.getElementById('dbConnectionStatusBadge');
    
    if (envData.username && envData.dsn && envData.wallet_exists) {
      statusBadge.textContent = '設定済み';
      statusBadge.style.background = '#10b981';
      statusBadge.style.color = '#fff';
    } else {
      statusBadge.textContent = '未設定';
      statusBadge.style.background = '#e2e8f0';
      statusBadge.style.color = '#64748b';
    }
    
    hideLoading();
    showToast('接続設定を更新しました', 'success');
    
  } catch (error) {
    hideLoading();
    showToast(`接続設定更新エラー: ${error.message}`, 'error');
  }
}

// グローバルスコープに公開
window.refreshDbConnectionFromEnv = refreshDbConnectionFromEnv;

let selectedWalletFile = null;

function handleWalletFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  if (!file.name.toLowerCase().endsWith('.zip')) {
    showToast('ZIPファイルを選択してください', 'error');
    return;
  }
  
  selectedWalletFile = file;
  const fileNameDiv = document.getElementById('walletFileName');
  fileNameDiv.style.display = 'block';
  fileNameDiv.textContent = `選択されたファイル: ${file.name}`;
  
  // Walletを自動アップロード
  uploadWalletFile(file);
}

async function uploadWalletFile(file) {
  try {
    showLoading('Walletをアップロード中...');
    
    const formData = new FormData();
    formData.append('file', file);
    
    const headers = {};
    if (loginToken) {
      headers['Authorization'] = `Bearer ${loginToken}`;
    }
    
    const response = await fetch(API_BASE ? `${API_BASE}/api/settings/database/wallet` : '/api/settings/database/wallet', {
      method: 'POST',
      headers: headers,
      body: formData
    });
    
    hideLoading();
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Walletアップロードに失敗しました');
    }
    
    const data = await response.json();
    
    if (data.success) {
      const walletStatus = document.getElementById('walletStatus');
      walletStatus.style.display = 'block';
      walletStatus.innerHTML = '<span class="text-green-600">✅ Walletアップロード成功</span>';
      
      showToast(data.message, 'success');
      
      // 利用可能なDSNを表示
      if (data.available_services && data.available_services.length > 0) {
        const dsnDisplay = document.getElementById('dsnDisplay');
        const dsnSelect = document.getElementById('dbDsn');
        dsnDisplay.style.display = 'block';
        
        dsnSelect.innerHTML = '<option value="">選択してください</option>';
        data.available_services.forEach(dsn => {
          const option = document.createElement('option');
          option.value = dsn;
          option.textContent = dsn;
          dsnSelect.appendChild(option);
        });
      }
    }
    
  } catch (error) {
    hideLoading();
    showToast(`Walletアップロードエラー: ${error.message}`, 'error');
    
    const walletStatus = document.getElementById('walletStatus');
    walletStatus.style.display = 'block';
    walletStatus.innerHTML = `<span class="text-red-600">❌ ${error.message}</span>`;
  }
}

function toggleConnectionFields(connectionType) {
  // Wallet方式に統一したため、この関数は不要
  // 互換性のため残しておく
}

async function saveDbConnection() {
  const username = document.getElementById('dbUser').value.trim();
  const password = document.getElementById('dbPassword').value;
  const dsn = document.getElementById('dbDsn').value;
  
  if (!username || !password) {
    showToast('ユーザー名とパスワードを入力してください', 'warning');
    return;
  }
  
  if (!dsn) {
    showToast('サービス名/DSNを選択してください', 'warning');
    return;
  }
  
  const settings = {
    username: username,
    password: password,
    dsn: dsn
  };
  
  try {
    showLoading('DB設定を保存中...');
    
    await apiCall('/api/settings/database', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });
    
    hideLoading();
    showToast('DB設定を保存しました', 'success');
    
    await loadDbConnectionSettings();
    
  } catch (error) {
    hideLoading();
    showToast(`保存エラー: ${error.message}`, 'error');
  }
}

async function testDbConnection() {
  try {
    // パスワードフィールドを取得
    const passwordField = document.getElementById('dbPassword');
    
    // ブラウザの自動入力を確実に取得するため、一度フォーカスしてから取得
    passwordField.focus();
    passwordField.blur();
    
    // 少し待ってから値を取得
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // 入力されている値を取得（保存前でもテストできるように）
    const username = document.getElementById('dbUser').value.trim();
    let password = passwordField.value;
    const dsn = document.getElementById('dbDsn').value;
    
    // パスワードが入力されていない場合、環境変数から取得
    if (!password) {
      showLoading('環境変数からパスワードを取得中...');
      try {
        const envData = await apiCall('/api/settings/database/env?include_password=true');
        if (envData.success && envData.password && envData.password !== '[CONFIGURED]') {
          password = envData.password;
        }
        hideLoading();
      } catch (error) {
        hideLoading();
        console.warn('環境変数からパスワード取得エラー:', error);
      }
    }
    
    // デバッグログ
    console.log('=== 接続テスト情報 ===');
    console.log('Username:', username);
    console.log('Password length:', password ? password.length : 0);
    console.log('DSN:', dsn);
    console.log('Password exists:', !!password);
    console.log('Password from env:', !passwordField.value && !!password);
    console.log('=====================');
    
    // 入力チェック
    if (!username || !password || !dsn) {
      showToast('ユーザー名、パスワード、DSNを入力してください', 'warning');
      return;
    }
    
    showLoading('接続テスト中...');
    
    const requestBody = {
      settings: {
        username: username,
        password: password,
        dsn: dsn
      }
    };
    
    console.log('Request body:', JSON.stringify({...requestBody, settings: {...requestBody.settings, password: '[HIDDEN]'}}));
    
    const data = await apiCall('/api/settings/database/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });
    
    hideLoading();
    
    if (data.success) {
      showToast(data.message, 'success');
      
      // 接続成功時、DB情報を自動読み込み
      await loadDbInfo();
    } else {
      showToast(data.message, 'error');
    }
    
  } catch (error) {
    hideLoading();
    showToast(`接続テストエラー: ${error.message}`, 'error');
  }
}

async function loadDbInfo() {
  try {
    showLoading('データベース情報を取得中...');
    
    const data = await apiCall('/api/database/info');
    
    hideLoading();
    
    const infoDiv = document.getElementById('dbInfoContent');
    const statusBadge = document.getElementById('dbInfoStatusBadge');
    
    if (!data.info) {
      infoDiv.innerHTML = `
        <div style="text-align: center; padding: 40px; color: #64748b;">
          <div style="font-size: 48px; margin-bottom: 16px;">🗄️</div>
          <div style="font-size: 16px; font-weight: 500;">データベースに接続してください</div>
          <div style="font-size: 14px; margin-top: 8px;">接続後、データベース情報が表示されます</div>
        </div>
      `;
      if (statusBadge) {
        statusBadge.textContent = '未取得';
        statusBadge.style.background = '#e2e8f0';
        statusBadge.style.color = '#64748b';
      }
      return;
    }
    
    // ステータスバッジを更新
    if (statusBadge) {
      statusBadge.textContent = '取得済み';
      statusBadge.style.background = '#10b981';
      statusBadge.style.color = '#fff';
    }
    
    const info = data.info;
    infoDiv.innerHTML = `
      <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px;">
        <div class="card">
          <div class="card-body">
            <div style="font-size: 13px; color: #64748b; margin-bottom: 4px;">データベースバージョン</div>
            <div style="font-size: 16px; font-weight: 600; color: #1e293b;">${info.version || '-'}</div>
          </div>
        </div>
        
        <div class="card">
          <div class="card-body">
            <div style="font-size: 13px; color: #64748b; margin-bottom: 4px;">接続ユーザー</div>
            <div style="font-size: 16px; font-weight: 600; color: #1e293b;">${info.current_user || '-'}</div>
          </div>
        </div>
        
        <div class="card">
          <div class="card-body">
            <div style="font-size: 13px; color: #64748b; margin-bottom: 4px;">インスタンス名</div>
            <div style="font-size: 16px; font-weight: 600; color: #1e293b;">${info.instance_name || '-'}</div>
          </div>
        </div>
        
        <div class="card">
          <div class="card-body">
            <div style="font-size: 13px; color: #64748b; margin-bottom: 4px;">データベース名</div>
            <div style="font-size: 16px; font-weight: 600; color: #1e293b;">${info.database_name || '-'}</div>
          </div>
        </div>
      </div>
    `;
    
  } catch (error) {
    hideLoading();
    showToast(`データベース情報取得エラー: ${error.message}`, 'error');
  }
}

async function loadDbTables() {
  try {
    showLoading('テーブル一覧を取得中...');
    
    // ページングパラメータ付きでAPIを呼び出し
    const data = await apiCall(`/api/database/tables?page=${dbTablesPage}&page_size=${dbTablesPageSize}`);
    
    hideLoading();
    
    // 総ページ数を保存
    dbTablesTotalPages = data.total_pages || 1;
    
    // 現在ページのテーブル一覧を保存（チェック用）
    currentPageDbTables = data.tables ? data.tables.map(t => t.table_name) : [];
    
    const tablesDiv = document.getElementById('dbTablesContent');
    const statusBadge = document.getElementById('dbTablesStatusBadge');
    
    if (!data.tables || data.tables.length === 0) {
      currentPageDbTables = [];
      tablesDiv.innerHTML = `
        <div style="text-align: center; padding: 40px; color: #64748b;">
          <div style="font-size: 48px; margin-bottom: 16px;">📋</div>
          <div style="font-size: 16px; font-weight: 500;">テーブル情報なし</div>
          <div style="font-size: 14px; margin-top: 8px;">データベースに接続後、テーブル一覧が表示されます</div>
        </div>
      `;
      if (statusBadge) {
        statusBadge.textContent = '未取得';
        statusBadge.style.background = '#e2e8f0';
        statusBadge.style.color = '#64748b';
      }
      return;
    }
    
    // ステータスバッジを更新（総件数を表示）
    if (statusBadge) {
      statusBadge.textContent = `${data.total}件`;
      statusBadge.style.background = '#10b981';
      statusBadge.style.color = '#fff';
    }
    
    // ヘッダーチェックボックスの状態を判定
    const allPageSelected = currentPageDbTables.length > 0 && 
                            currentPageDbTables.every(t => selectedDbTables.includes(t));
    
    // 選択操作ボタンHTML
    const selectionButtonsHtml = `
      <div class="flex items-center justify-between mb-3">
        <div class="flex gap-2">
          <button onclick="selectAllDbTables()" class="px-2 py-1 border rounded text-xs hover:bg-gray-100 ${dbTablesBatchDeleteLoading ? 'opacity-50 cursor-not-allowed' : ''}" ${dbTablesBatchDeleteLoading ? 'disabled' : ''}>すべて選択</button>
          <button onclick="clearAllDbTables()" class="px-2 py-1 border rounded text-xs hover:bg-gray-100 ${dbTablesBatchDeleteLoading ? 'opacity-50 cursor-not-allowed' : ''}" ${dbTablesBatchDeleteLoading ? 'disabled' : ''}>すべて解除</button>
          <button onclick="deleteSelectedDbTables()" class="px-2 py-1 text-xs rounded border border-red-300 text-red-600 hover:bg-red-50 ${(selectedDbTables.length === 0 || dbTablesBatchDeleteLoading) ? 'opacity-40 cursor-not-allowed' : ''}" ${(selectedDbTables.length === 0 || dbTablesBatchDeleteLoading) ? 'disabled' : ''}>
            ${dbTablesBatchDeleteLoading ? '<span class="spinner spinner-sm"></span> 処理中...' : `削除 (${selectedDbTables.length})`}
          </button>
        </div>
      </div>
    `;
    
    // ページネーションUI生成
    const paginationHtml = UIComponents.renderPagination({
      currentPage: data.current_page,
      totalPages: data.total_pages,
      totalItems: data.total,
      startNum: data.start_row,
      endNum: data.end_row,
      onPrevClick: 'handleDbTablesPrevPage()',
      onNextClick: 'handleDbTablesNextPage()',
      onJumpClick: 'handleDbTablesJumpPage',
      inputId: 'dbTablesPageInput',
      disabled: dbTablesBatchDeleteLoading
    });
    
    tablesDiv.innerHTML = `
      <div>
        ${selectionButtonsHtml}
        ${paginationHtml}
        <div class="table-wrapper-scrollable">
          <table class="data-table">
            <thead>
              <tr>
                <th style="width: 40px;"><input type="checkbox" id="dbTablesHeaderCheckbox" onchange="toggleSelectAllDbTables(this.checked)" ${allPageSelected ? 'checked' : ''} class="w-4 h-4 rounded" ${dbTablesBatchDeleteLoading ? 'disabled' : ''}></th>
                <th>テーブル名</th>
                <th>行数</th>
                <th>作成日時</th>
                <th>最終更新</th>
                <th>コメント</th>
              </tr>
            </thead>
            <tbody>
              ${data.tables.map(table => `
                <tr>
                  <td><input type="checkbox" onchange="toggleDbTableSelection('${table.table_name}')" ${selectedDbTables.includes(table.table_name) ? 'checked' : ''} class="w-4 h-4 rounded" ${dbTablesBatchDeleteLoading ? 'disabled' : ''}></td>
                  <td style="font-weight: 500; font-family: monospace;">${table.table_name}</td>
                  <td>${table.num_rows !== null ? table.num_rows.toLocaleString() : '-'}</td>
                  <td>${table.created ? formatDateTime(table.created) : '-'}</td>
                  <td>${table.last_analyzed ? formatDateTime(table.last_analyzed) : '-'}</td>
                  <td style="max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                    ${table.comments || '-'}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
    
  } catch (error) {
    hideLoading();
    showToast(`テーブル一覧取得エラー: ${error.message}`, 'error');
  }
}

// テーブル一覧ページング - 前のページへ
function handleDbTablesPrevPage() {
  if (dbTablesPage > 1) {
    dbTablesPage--;
    loadDbTables();
  }
}

// テーブル一覧ページング - 次のページへ
function handleDbTablesNextPage() {
  if (dbTablesPage < dbTablesTotalPages) {
    dbTablesPage++;
    loadDbTables();
  }
}

// テーブル一覧ページング - ページジャンプ
function handleDbTablesJumpPage() {
  const input = document.getElementById('dbTablesPageInput');
  const page = parseInt(input.value, 10);
  if (page >= 1 && page <= dbTablesTotalPages) {
    dbTablesPage = page;
    loadDbTables();
  } else {
    showToast('無効なページ番号です', 'error');
    input.value = dbTablesPage;
  }
}

// テーブル一覧 - 個別チェックボックス切り替え
function toggleDbTableSelection(tableName) {
  const index = selectedDbTables.indexOf(tableName);
  if (index > -1) {
    selectedDbTables.splice(index, 1);
  } else {
    selectedDbTables.push(tableName);
  }
  // UIを更新
  loadDbTables();
}

// テーブル一覧 - ヘッダーチェックボックス切り替え（現在ページ全選択/解除）
function toggleSelectAllDbTables(checked) {
  if (checked) {
    // 現在ページのすべてを選択に追加
    currentPageDbTables.forEach(tableName => {
      if (!selectedDbTables.includes(tableName)) {
        selectedDbTables.push(tableName);
      }
    });
  } else {
    // 現在ページのすべてを選択から除外
    currentPageDbTables.forEach(tableName => {
      const index = selectedDbTables.indexOf(tableName);
      if (index > -1) {
        selectedDbTables.splice(index, 1);
      }
    });
  }
  // UIを更新
  loadDbTables();
}

// テーブル一覧 - すべて選択
function selectAllDbTables() {
  toggleSelectAllDbTables(true);
  // ヘッダーチェックボックスを更新
  const headerCheckbox = document.getElementById('dbTablesHeaderCheckbox');
  if (headerCheckbox) headerCheckbox.checked = true;
}

// テーブル一覧 - すべて解除
function clearAllDbTables() {
  selectedDbTables = [];
  // ヘッダーチェックボックスを更新
  const headerCheckbox = document.getElementById('dbTablesHeaderCheckbox');
  if (headerCheckbox) headerCheckbox.checked = false;
  // UIを更新
  loadDbTables();
}

// テーブル一覧 - 選択されたテーブルを削除
async function deleteSelectedDbTables() {
  if (selectedDbTables.length === 0) {
    showToast('削除するテーブルを選択してください', 'warning');
    return;
  }
  
  const count = selectedDbTables.length;
  const confirmed = confirm(`選択された${count}件のテーブルを削除しますか？\n\nこの操作は元に戻せません。`);
  
  if (!confirmed) {
    return;
  }
  
  // 処理中表示を設定
  dbTablesBatchDeleteLoading = true;
  loadDbTables();
  
  try {
    // 一括削除APIを呼び出す
    const response = await apiCall('/api/database/tables/batch-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table_names: selectedDbTables })
    });
    
    if (response.success) {
      showToast(`${count}件のテーブルを削除しました`, 'success');
      // 選択をクリア
      selectedDbTables = [];
      // ページを1にリセット
      dbTablesPage = 1;
    } else {
      showToast(`削除エラー: ${response.message || '不明なエラー'}`, 'error');
    }
  } catch (error) {
    showToast(`削除エラー: ${error.message}`, 'error');
  } finally {
    // 処理中表示を解除
    dbTablesBatchDeleteLoading = false;
    // テーブル一覧を再読み込み
    loadDbTables();
  }
}

// データベース情報更新ボタン
async function refreshDbInfo() {
  const btn = document.getElementById('refreshDbInfoBtn');
  if (!btn) return;
  
  const originalText = btn.innerHTML;
  
  try {
    // ボタンを処理中状態に
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner spinner-sm" style="border-top-color: #667eea;"></span> 処理中';
    
    await loadDbInfo();
    
  } finally {
    // ボタンを元に戻す
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

// テーブル一覧更新ボタン
async function refreshDbTables() {
  const btn = document.getElementById('refreshDbTablesBtn');
  if (!btn) return;
  
  const originalText = btn.innerHTML;
  
  try {
    // ボタンを処理中状態に
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner spinner-sm" style="border-top-color: #667eea;"></span> 処理中';
    
    // ページを1にリセット
    dbTablesPage = 1;
    await loadDbTables();
    
  } finally {
    // ボタンを元に戻す
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

// ストレージ情報を読み込み
async function loadDbStorage() {
  try {
    showLoading('ストレージ情報を取得中...');
    
    const data = await apiCall('/api/database/storage');
    
    hideLoading();
    
    const storageDiv = document.getElementById('dbStorageContent');
    const statusBadge = document.getElementById('dbStorageStatusBadge');
    
    if (!data.success || !data.storage_info) {
      storageDiv.innerHTML = `
        <div style="text-align: center; padding: 40px; color: #64748b;">
          <div style="font-size: 48px; margin-bottom: 16px;">💾</div>
          <div style="font-size: 16px; font-weight: 500;">ストレージ情報なし</div>
          <div style="font-size: 14px; margin-top: 8px;">データベースに接続後、ストレージ情報が表示されます</div>
        </div>
      `;
      if (statusBadge) {
        statusBadge.textContent = '未取得';
        statusBadge.style.background = '#e2e8f0';
        statusBadge.style.color = '#64748b';
      }
      return;
    }
    
    const storage = data.storage_info;
    
    // ステータスバッジを更新
    if (statusBadge) {
      statusBadge.textContent = `${storage.used_percent.toFixed(1)}% 使用中`;
      const usedPercent = storage.used_percent;
      if (usedPercent >= 90) {
        statusBadge.style.background = '#ef4444';
        statusBadge.style.color = '#fff';
      } else if (usedPercent >= 70) {
        statusBadge.style.background = '#f59e0b';
        statusBadge.style.color = '#fff';
      } else {
        statusBadge.style.background = '#10b981';
        statusBadge.style.color = '#fff';
      }
    }
    
    storageDiv.innerHTML = `
      <!-- 全体サマリ -->
      <div class="card" style="margin-bottom: 24px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none;">
        <div class="card-body">
          <h3 style="font-size: 14px; font-weight: 600; margin-bottom: 12px; opacity: 0.9;">全体ストレージ使用状況</h3>
          <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px;">
            <div>
              <div style="font-size: 12px; opacity: 0.8; margin-bottom: 4px;">総容量</div>
              <div style="font-size: 20px; font-weight: 700;">${storage.total_size_mb.toFixed(0)} MB</div>
            </div>
            <div>
              <div style="font-size: 12px; opacity: 0.8; margin-bottom: 4px;">使用済み</div>
              <div style="font-size: 20px; font-weight: 700;">${storage.used_size_mb.toFixed(0)} MB</div>
            </div>
            <div>
              <div style="font-size: 12px; opacity: 0.8; margin-bottom: 4px;">空き容量</div>
              <div style="font-size: 20px; font-weight: 700;">${storage.free_size_mb.toFixed(0)} MB</div>
            </div>
            <div>
              <div style="font-size: 12px; opacity: 0.8; margin-bottom: 4px;">使用率</div>
              <div style="font-size: 20px; font-weight: 700;">${storage.used_percent.toFixed(1)}%</div>
            </div>
          </div>
          <div style="margin-top: 16px; height: 8px; background: rgba(255,255,255,0.2); border-radius: 4px; overflow: hidden;">
            <div style="width: ${storage.used_percent}%; height: 100%; background: white; border-radius: 4px; transition: width 0.3s ease;"></div>
          </div>
        </div>
      </div>
      
      <!-- テーブルスペース詳細 -->
      <h3 style="font-size: 16px; font-weight: 600; margin-bottom: 16px; color: #1e293b;">テーブルスペース別使用状況</h3>
      <div class="table-wrapper">
        <table class="data-table">
          <thead>
            <tr>
              <th>テーブルスペース名</th>
              <th>総容量 (MB)</th>
              <th>使用済み (MB)</th>
              <th>空き容量 (MB)</th>
              <th>使用率</th>
              <th>ステータス</th>
            </tr>
          </thead>
          <tbody>
            ${storage.tablespaces.map(ts => {
              const usedPercent = ts.used_percent;
              let statusColor = '#10b981';
              let statusText = '正常';
              if (usedPercent >= 90) {
                statusColor = '#ef4444';
                statusText = '警告';
              } else if (usedPercent >= 70) {
                statusColor = '#f59e0b';
                statusText = '注意';
              }
              
              return `
                <tr>
                  <td style="font-weight: 500; font-family: monospace;">${ts.tablespace_name}</td>
                  <td>${ts.total_size_mb.toFixed(2)}</td>
                  <td>${ts.used_size_mb.toFixed(2)}</td>
                  <td>${ts.free_size_mb.toFixed(2)}</td>
                  <td>
                    <div style="display: flex; align-items: center; gap: 8px;">
                      <div style="flex: 1; height: 6px; background: #e2e8f0; border-radius: 3px; overflow: hidden;">
                        <div style="width: ${usedPercent}%; height: 100%; background: ${statusColor}; transition: width 0.3s ease;"></div>
                      </div>
                      <span style="font-weight: 500; min-width: 50px; text-align: right;">${usedPercent.toFixed(1)}%</span>
                    </div>
                  </td>
                  <td>
                    <span class="px-2 py-1 text-xs font-semibold rounded-md" style="background: ${statusColor}; color: white;">${statusText}</span>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
    
  } catch (error) {
    hideLoading();
    showToast(`ストレージ情報取得エラー: ${error.message}`, 'error');
  }
}

// ストレージ情報更新ボタン
async function refreshDbStorage() {
  const btn = document.getElementById('refreshDbStorageBtn');
  if (!btn) return;
  
  const originalText = btn.innerHTML;
  
  try {
    // ボタンを処理中状態に
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner spinner-sm" style="border-top-color: #667eea;"></span> 処理中';
    
    await loadDbStorage();
    
  } finally {
    // ボタンを元に戻す
    btn.disabled = false;
    btn.innerHTML = originalText;
  }
}

// ========================================
// 認証機能
// ========================================

/**
 * 設定を読み込む
 */
async function loadConfig() {
  try {
    // API_BASEが空の場合は相対パス、設定されている場合は絶対パス
    const url = API_BASE ? `${API_BASE}/api/config` : '/api/config';
    const response = await fetch(url);
    if (response.ok) {
      const config = await response.json();
      debugMode = config.debug;
      requireLogin = config.require_login;
      console.log('設定を読み込みました:', config);
    }
  } catch (error) {
    console.warn('設定の読み込みに失敗しました:', error);
  }
}

/**
 * ログインモーダルを表示
 */
function showLoginModal() {
  const modal = document.getElementById('loginOverlay');
  if (modal) {
    modal.style.display = 'flex';
    const usernameInput = document.getElementById('loginUsername');
    if (usernameInput) {
      usernameInput.focus();
    }
  }
}

/**
 * ログインモーダルを非表示
 */
function hideLoginModal() {
  const modal = document.getElementById('loginOverlay');
  if (modal) {
    modal.style.display = 'none';
    const errorDiv = document.getElementById('loginError');
    if (errorDiv) {
      errorDiv.style.display = 'none';
    }
    const form = document.getElementById('loginForm');
    if (form) {
      form.reset();
    }
  }
}

/**
 * パスワード表示切替
 */
function toggleLoginPassword() {
  const input = document.getElementById('loginPassword');
  if (!input) return;
  input.type = input.type === 'password' ? 'text' : 'password';
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

/**
 * ログイン処理
 */
async function handleLogin(event) {
  event.preventDefault();
  
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errorDiv = document.getElementById('loginError');
  const errorMessage = document.getElementById('loginErrorMessage');
  const submitBtn = document.getElementById('loginSubmitBtn');
  
  if (!username || !password) {
    if (errorMessage) {
      errorMessage.textContent = 'ユーザー名とパスワードを入力してください';
    }
    if (errorDiv) {
      errorDiv.style.display = 'flex';
    }
    return;
  }
  
  try {
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="inline-flex items-center gap-2"><span class="spinner spinner-sm"></span>ログイン中...</span>';
    }
    if (errorDiv) {
      errorDiv.style.display = 'none';
    }
    
    const url = API_BASE ? `${API_BASE}/api/login` : '/api/login';
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'ログインに失敗しました');
    }
    
    const data = await response.json();
    
    if (data.status === 'success') {
      // ログイン成功
      isLoggedIn = true;
      loginToken = data.token;
      loginUser = data.username;
      
      // ローカルストレージに保存
      localStorage.setItem('loginToken', loginToken);
      localStorage.setItem('loginUser', loginUser);
      
      hideLoginModal();
      showToast('ログインしました', 'success');
      
      // UI更新
      updateUserInfo();
      
      // AI Assistantボタンを表示
      const copilotBtn = document.getElementById('copilotToggleBtn');
      if (copilotBtn) {
        copilotBtn.style.display = 'flex';
      }
    }
  } catch (error) {
    if (errorMessage) {
      errorMessage.textContent = error.message;
    }
    if (errorDiv) {
      errorDiv.style.display = 'flex';
    }
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'ログイン';
    }
  }
}

/**
 * ログアウト処理
 */
async function handleLogout() {
  try {
    if (loginToken) {
      const url = API_BASE ? `${API_BASE}/api/logout` : '/api/logout';
      await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${loginToken}` }
      });
    }
  } catch (error) {
    console.warn('ログアウトエラー:', error);
  } finally {
    // ローカル状態をクリア
    isLoggedIn = false;
    loginToken = null;
    loginUser = null;
    localStorage.removeItem('loginToken');
    localStorage.removeItem('loginUser');
    
    showToast('ログアウトしました');
    
    // ページをリロードしてログイン画面へ遷移
    setTimeout(() => {
      window.location.reload();
    }, 500);
  }
}

/**
 * ユーザー情報表示を更新
 */
function updateUserInfo() {
  const userInfo = document.getElementById('userInfo');
  const userName = document.getElementById('userName');
  
  if (isLoggedIn && loginUser) {
    userName.textContent = `${loginUser}`;
    userInfo.style.display = 'block';
  } else {
    userInfo.style.display = 'none';
  }
}

/**
 * ログイン状態を確認
 */
async function checkLoginStatus() {
  // ローカルストレージからトークンを取得
  const token = localStorage.getItem('loginToken');
  const user = localStorage.getItem('loginUser');
  
  if (token && user) {
    loginToken = token;
    loginUser = user;
    isLoggedIn = true;
    updateUserInfo();
    
    // AI Assistantボタンを表示
    const copilotBtn = document.getElementById('copilotToggleBtn');
    if (copilotBtn) {
      copilotBtn.style.display = 'flex';
    }
  } else if (requireLogin) {
    // ログインが必要な場合はログイン画面を表示
    showLoginModal();
  } else {
    // デバッグモードでログイン不要の場合もAI Assistantボタンを表示
    const copilotBtn = document.getElementById('copilotToggleBtn');
    if (copilotBtn) {
      copilotBtn.style.display = 'flex';
    }
  }
}

// ========================================
// 初期化
// ========================================

// ページロード時の初期化
window.addEventListener('DOMContentLoaded', async () => {
  console.log('資料みつかるくん - 初期化開始');
  
  // 設定を読み込む
  await loadConfig();
  
  // ログイン状態を確認
  await checkLoginStatus();
  
  console.log('資料みつかるくん - 初期化完了');
});

// ========================================
// Autonomous Database 管理
// ========================================

// ADB情報をキャッシュ
let currentAdbInfo = {
  id: null,
  display_name: null,
  lifecycle_state: null
};

/**
 * ADB情報を取得
 */
async function getAdbInfo() {
  try {
    showLoading('ADB情報を取得中...');
    
    // バックエンドのADB_NAMEとOCI_COMPARTMENT_OCIDを使用するため、
    // 環境変数から読み取る（参考コードと同じパターン）
    const data = await apiCall('/api/database/target', {
      method: 'GET'
    });
    
    hideLoading();
    
    // 情報を保存
    currentAdbInfo = {
      id: data.id,
      display_name: data.display_name,
      lifecycle_state: data.lifecycle_state,
      db_name: data.db_name,
      cpu_core_count: data.cpu_core_count,
      data_storage_size_in_tbs: data.data_storage_size_in_tbs
    };
    
    // UIを更新
    updateAdbDisplay();
    
    // 操作結果を表示
    showAdbOperationResult([
      `ID: ${data.id}`,
      `Display Name: ${data.display_name}`,
      `DB Name: ${data.db_name}`,
      `Lifecycle State: ${data.lifecycle_state}`,
      `CPU Core Count: ${data.cpu_core_count}`,
      `Storage (TB): ${data.data_storage_size_in_tbs}`
    ]);
    
    showToast('ADB情報を取得しました', 'success');
    
  } catch (error) {
    hideLoading();
    showToast(`ADB情報取得エラー: ${error.message}`, 'error');
  }
}

/**
 * ADBを起動
 */
async function startAdb() {
  if (!currentAdbInfo.id) {
    showToast('まずADB情報を取得してください', 'warning');
    return;
  }
  
  try {
    showLoading('ADBを起動中...');
    
    const data = await apiCall('/api/database/target/start', {
      method: 'POST'
    });
    
    hideLoading();
    
    if (data.status === 'accepted' || data.status === 'noop') {
      showToast(data.message, 'success');
      showAdbOperationResult([
        `Status: ${data.status}`,
        `Message: ${data.message}`,
        `ID: ${data.id}`
      ]);
      
      // 少し待ってから情報を再取得
      setTimeout(() => {
        getAdbInfo();
      }, 3000);
    } else {
      showToast(`エラー: ${data.message}`, 'error');
      showAdbOperationResult([`Status: ${data.status}`, `Message: ${data.message}`]);
    }
    
  } catch (error) {
    hideLoading();
    showToast(`ADB起動エラー: ${error.message}`, 'error');
  }
}

/**
 * ADBを停止
 */
async function stopAdb() {
  if (!currentAdbInfo.id) {
    showToast('まずADB情報を取得してください', 'warning');
    return;
  }
  
  try {
    showLoading('ADBを停止中...');
    
    const data = await apiCall('/api/database/target/stop', {
      method: 'POST'
    });
    
    hideLoading();
    
    if (data.status === 'accepted' || data.status === 'noop') {
      showToast(data.message, 'success');
      showAdbOperationResult([
        `Status: ${data.status}`,
        `Message: ${data.message}`,
        `ID: ${data.id}`
      ]);
      
      // 少し待ってから情報を再取得
      setTimeout(() => {
        getAdbInfo();
      }, 3000);
    } else {
      showToast(`エラー: ${data.message}`, 'error');
      showAdbOperationResult([`Status: ${data.status}`, `Message: ${data.message}`]);
    }
    
  } catch (error) {
    hideLoading();
    showToast(`ADB停止エラー: ${error.message}`, 'error');
  }
}

/**
 * ADB表示を更新
 */
function updateAdbDisplay() {
  // Display Name
  document.getElementById('adbDisplayName').textContent = currentAdbInfo.display_name || '-';
  
  // Lifecycle State (詳細)
  document.getElementById('adbLifecycleStateDetail').textContent = currentAdbInfo.lifecycle_state || '-';
  
  // OCID
  document.getElementById('adbOcid').textContent = currentAdbInfo.id || '-';
  
  // ヘッダーの状態バッジを更新
  const stateBadge = document.getElementById('adbLifecycleState');
  const state = currentAdbInfo.lifecycle_state;
  
  if (state === 'AVAILABLE') {
    stateBadge.textContent = 'AVAILABLE';
    stateBadge.style.background = '#10b981';
    stateBadge.style.color = '#ffffff';
  } else if (state === 'STOPPED') {
    stateBadge.textContent = 'STOPPED';
    stateBadge.style.background = '#ef4444';
    stateBadge.style.color = '#ffffff';
  } else if (state === 'STARTING' || state === 'STOPPING') {
    stateBadge.textContent = state;
    stateBadge.style.background = '#f59e0b';
    stateBadge.style.color = '#ffffff';
  } else {
    stateBadge.textContent = state || '未取得';
    stateBadge.style.background = '#e2e8f0';
    stateBadge.style.color = '#64748b';
  }
}

/**
 * ADB操作結果を表示
 */
function showAdbOperationResult(items) {
  const resultDiv = document.getElementById('adbOperationResult');
  const listDiv = document.getElementById('adbOperationResultList');
  
  listDiv.innerHTML = '';
  
  items.forEach(item => {
    const li = document.createElement('li');
    li.textContent = item;
    listDiv.appendChild(li);
  });
  
  resultDiv.style.display = 'block';
}

// グローバルスコープに関数を公開
window.switchTab = switchTab;
window.performSearch = performSearch;
window.clearSearchResults = clearSearchResults;
window.handleFileSelect = handleFileSelect;
window.uploadDocument = uploadDocument;
window.loadDocuments = loadDocuments;
window.deleteDocument = deleteDocument;
window.loadOciSettings = loadOciSettings;
window.saveOciSettings = saveOciSettings;
window.testOciConnection = testOciConnection;
window.handlePrivateKeyFileSelect = handlePrivateKeyFileSelect;
window.clearPrivateKey = clearPrivateKey;
window.loadDbConnectionSettings = loadDbConnectionSettings;
window.saveDbConnection = saveDbConnection;
window.testDbConnection = testDbConnection;
window.loadDbInfo = loadDbInfo;
window.loadDbTables = loadDbTables;
window.handleLogin = handleLogin;
window.handleLogout = handleLogout;
window.toggleLoginPassword = toggleLoginPassword;

// ADB関連関数
window.getAdbInfo = getAdbInfo;
window.startAdb = startAdb;
window.stopAdb = stopAdb;

// OCI Object Storage関連関数
window.loadOciObjects = loadOciObjects;
window.handleOciObjectsPrevPage = handleOciObjectsPrevPage;
window.handleOciObjectsNextPage = handleOciObjectsNextPage;
window.handleOciObjectsJumpPage = handleOciObjectsJumpPage;
window.toggleOciObjectSelection = toggleOciObjectSelection;
window.toggleSelectAllOciObjects = toggleSelectAllOciObjects;
window.selectAllOciObjects = selectAllOciObjects;
window.clearAllOciObjects = clearAllOciObjects;
window.deleteSelectedOciObjects = deleteSelectedOciObjects;

// ========================================
// AI Assistant機能
// ========================================

/**
 * AI Assistantパネルの表示/非表示を切り替え
 */
function toggleCopilot() {
  copilotOpen = !copilotOpen;
  const panel = document.getElementById('copilotPanel');
  const btn = document.getElementById('copilotToggleBtn');
  
  if (copilotOpen) {
    panel.style.display = 'flex';
    btn.style.display = 'none';
  } else {
    panel.style.display = 'none';
    btn.style.display = 'flex';
  }
}

/**
 * AI Assistantパネルの最大化/最小化
 */
function toggleCopilotExpand() {
  copilotExpanded = !copilotExpanded;
  const panel = document.getElementById('copilotPanel');
  const icon = document.getElementById('copilotExpandIcon');
  
  if (copilotExpanded) {
    panel.classList.add('expanded');
    // 縮小アイコン
    icon.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 19l-7-7 7-7"/>`;
  } else {
    panel.classList.remove('expanded');
    // 展開アイコン
    icon.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7"/>`;
  }
}

/**
 * AI Assistantメッセージを送信
 */
async function sendCopilotMessage() {
  const input = document.getElementById('copilotInput');
  const message = input.value.trim();
  
  if ((!message && copilotImages.length === 0) || copilotLoading) return;
  
  // ユーザーメッセージを追加
  copilotMessages.push({
    role: 'user',
    content: message,
    images: copilotImages.length > 0 ? [...copilotImages] : null
  });
  
  renderCopilotMessages();
  input.value = '';
  
  // 画像をクリア
  const currentImages = [...copilotImages];
  copilotImages = [];
  renderCopilotImagesPreview();
  
  // アシスタントメッセージのプレースホルダーに「考え...」を表示
  copilotMessages.push({
    role: 'assistant',
    content: '考え...'
  });
  
  copilotLoading = true;
  renderCopilotMessages();
  
  try {
    // API呼び出しでストリーミング受信
    const response = await fetch(`${API_BASE}/api/copilot/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(loginToken ? { 'Authorization': `Bearer ${loginToken}` } : {})
      },
      body: JSON.stringify({
        message: message,
        context: null,
        history: copilotMessages.slice(0, -1),
        images: currentImages.length > 0 ? currentImages : null
      })
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let isFirstChunk = true;
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.substring(6));
            if (data.done) {
              copilotLoading = false;
              renderCopilotMessages();
            } else if (data.content) {
              // 最初のチャンクの場合、「考え...」を置き換える
              if (isFirstChunk) {
                copilotMessages[copilotMessages.length - 1].content = data.content;
                isFirstChunk = false;
              } else {
                copilotMessages[copilotMessages.length - 1].content += data.content;
              }
              renderCopilotMessages();
            }
          } catch (e) {
            console.error('JSON parse error:', e);
          }
        }
      }
    }
  } catch (error) {
    console.error('AI Assistantエラー:', error);
    copilotMessages[copilotMessages.length - 1].content = `エラー: ${error.message}`;
    copilotLoading = false;
    renderCopilotMessages();
    showToast('AI Assistantの応答に失敗しました', 'error');
  }
}

/**
 * AI Assistantメッセージをレンダリング
 */
function renderCopilotMessages() {
  const messagesDiv = document.getElementById('copilotMessages');
  
  if (copilotMessages.length === 0) {
    messagesDiv.innerHTML = `
      <div class="text-center text-gray-500 py-8">
        <p class="text-sm">何でもお聞きください！</p>
      </div>
    `;
    return;
  }
  
  // 画像データをグローバルに保存（イベントハンドラからアクセスするため）
  window._copilotImageData = {};
  
  messagesDiv.innerHTML = copilotMessages.map((msg, msgIdx) => {
    const isUser = msg.role === 'user';
    const content = isUser ? msg.content : renderMarkdown(msg.content);
    const imagesHtml = isUser && msg.images && msg.images.length > 0 ? `
      <div style="display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap;">
        ${msg.images.map((img, imgIdx) => {
          const imageKey = `img_${msgIdx}_${imgIdx}`;
          // 画像データをグローバルに保存
          window._copilotImageData[imageKey] = {
            data_url: img.data_url,
            filename: img.filename || ''
          };
          return `
            <div 
              style="position: relative; cursor: pointer;"
              onclick="openCopilotImage('${imageKey}')"
            >
              <img 
                src="${img.data_url}" 
                style="max-width: 120px; max-height: 120px; border-radius: 8px; border: 2px solid #e2e8f0; object-fit: contain; transition: all 0.2s;" 
                onmouseover="this.style.borderColor='#667eea'; this.style.transform='scale(1.05)';" 
                onmouseout="this.style.borderColor='#e2e8f0'; this.style.transform='scale(1)';" 
              />
              ${img.filename ? `<div style="position: absolute; bottom: 0; left: 0; right: 0; background: rgba(0,0,0,0.6); color: white; font-size: 10px; padding: 2px 4px; border-radius: 0 0 6px 6px; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${img.filename}</div>` : ''}
            </div>
          `;
        }).join('')}
      </div>
    ` : '';
    
    return `
      <div class="copilot-message ${isUser ? 'user' : 'assistant'}">
        ${content}
        ${imagesHtml}
      </div>
    `;
  }).join('');
  
  // スクロールを一番下へ
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

/**
 * AI Assistantの画像をモーダルで開く
 */
function openCopilotImage(imageKey) {
  const imageData = window._copilotImageData && window._copilotImageData[imageKey];
  if (imageData) {
    showImageModal(imageData.data_url, imageData.filename);
  }
}

/**
 * 簡易的なMarkdownレンダリング
 */
function renderMarkdown(text) {
  if (!text) return '';
  
  // コードブロック
  text = text.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  
  // インラインコード
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  
  // 太字
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  
  // リスト
  text = text.replace(/^- (.+)$/gm, '<li>$1</li>');
  text = text.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');
  
  // 改行
  text = text.replace(/\n/g, '<br>');
  
  return text;
}

/**
 * AI Assistant履歴をクリア
 */
function clearCopilotHistory() {
  copilotMessages = [];
  renderCopilotMessages();
  showToast('会話履歴をクリアしました', 'success');
}

/**
 * AI Assistant入力欄のEnterキー処理
 * Enter: 送信
 * Shift+Enter: 改行
 */
function handleCopilotKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendCopilotMessage();
  }
}

/**
 * 新しい会話を開始
 */
async function startNewConversation() {
  if (copilotMessages.length > 0) {
    const confirmed = await showConfirmModal(
      'AI Assistantの会話をリセットしますか？',
      '新しい会話の確認'
    );
    if (confirmed) {
      copilotMessages = [];
      copilotImages = [];
      renderCopilotMessages();
      showToast('新しい会話を開始しました', 'success');
    }
  }
}

/**
 * 画像をファイルから追加
 */
function addCopilotImagesFromFiles(files) {
  if (!files || files.length === 0) return;
  
  const MAX_IMAGES = 5;
  
  // 既存の画像数を確認
  if (copilotImages.length >= MAX_IMAGES) {
    showToast(`画像は最大${MAX_IMAGES}枚までアップロードできます`, 'warning');
    return;
  }
  
  // 追加可能な枚数を計算
  const remainingSlots = MAX_IMAGES - copilotImages.length;
  const filesToAdd = Array.from(files).filter(f => f.type.startsWith('image/')).slice(0, remainingSlots);
  
  if (filesToAdd.length < files.length) {
    showToast(`画像は最大${MAX_IMAGES}枚までです。${filesToAdd.length}枚を追加します`, 'warning');
  }
  
  filesToAdd.forEach(file => {
    const reader = new FileReader();
    reader.onload = (e) => {
      copilotImages.push({
        data_url: e.target.result,
        filename: file.name
      });
      renderCopilotImagesPreview();
    };
    reader.readAsDataURL(file);
  });
}

/**
 * クリップボードから画像を追加
 * @param {ClipboardEvent} event - 貼り付けイベント
 */
function handleCopilotPaste(event) {
  const items = event.clipboardData?.items;
  if (!items) return;
  
  const imageItems = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].type.startsWith('image/')) {
      imageItems.push(items[i]);
    }
  }
  
  if (imageItems.length === 0) return;
  
  // デフォルトの貼り付け動作を防止
  event.preventDefault();
  
  const MAX_IMAGES = 5;
  
  // 既存の画像数を確認
  if (copilotImages.length >= MAX_IMAGES) {
    showToast(`画像は最大${MAX_IMAGES}枚までアップロードできます`, 'warning');
    return;
  }
  
  // 追加可能な枚数を計算
  const remainingSlots = MAX_IMAGES - copilotImages.length;
  const itemsToAdd = imageItems.slice(0, remainingSlots);
  
  if (itemsToAdd.length < imageItems.length) {
    showToast(`画像は最大${MAX_IMAGES}枚までです。${itemsToAdd.length}枚を追加します`, 'warning');
  }
  
  itemsToAdd.forEach(item => {
    const file = item.getAsFile();
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        copilotImages.push({
          data_url: e.target.result,
          filename: file.name || `貼り付け画像_${Date.now()}.png`
        });
        renderCopilotImagesPreview();
      };
      reader.readAsDataURL(file);
    }
  });
}

/**
 * 画像プレビューをレンダリング
 */
function renderCopilotImagesPreview() {
  const preview = document.getElementById('copilotImagesPreview');
  if (!preview) return;
  
  if (copilotImages.length === 0) {
    preview.innerHTML = '';
    return;
  }
  
  preview.innerHTML = `
    <div style="display: flex; gap: 10px; align-items: center; overflow-x: auto; padding: 10px 2px 0 2px;">
      ${copilotImages.map((img, i) => `
        <div style="position: relative; width: 56px; height: 56px; border-radius: 8px; overflow: hidden; border: 1px solid #e2e8f0; flex: 0 0 auto; background: #f8fafc;">
          <img src="${img.data_url}" style="width: 100%; height: 100%; object-fit: cover;" />
          <button type="button" onclick="removeCopilotImageAt(${i})" style="position: absolute; top: 4px; right: 4px; width: 18px; height: 18px; border-radius: 9px; border: 0; background: rgba(15, 23, 42, 0.65); color: white; font-size: 12px; line-height: 18px; cursor: pointer;">❌</button>
        </div>
      `).join('')}
      <button type="button" onclick="clearCopilotImages()" class="apex-button-secondary px-3 py-1.5 text-xs">🧹 画像クリア</button>
    </div>
  `;
}

/**
 * 画像を削除
 */
function removeCopilotImageAt(index) {
  copilotImages.splice(index, 1);
  renderCopilotImagesPreview();
}

/**
 * 全画像をクリア
 */
function clearCopilotImages() {
  copilotImages = [];
  renderCopilotImagesPreview();
}

/**
 * 画像モーダルを表示
 */
let _imageModalEscapeHandler = null;

function showImageModal(imageUrl, filename = '') {
  // 既存のモーダルがあれば即座に削除
  const existingModal = document.getElementById('imageModal');
  if (existingModal) {
    existingModal.remove();
  }
  
  // 既存のESCハンドラーを削除
  if (_imageModalEscapeHandler) {
    document.removeEventListener('keydown', _imageModalEscapeHandler);
    _imageModalEscapeHandler = null;
  }
  
  // モーダルを作成
  const modal = document.createElement('div');
  modal.id = 'imageModal';
  modal.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.9);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    cursor: pointer;
  `;
  
  modal.innerHTML = `
    <div style="position: relative; max-width: 90vw; max-height: 90vh; display: flex; flex-direction: column; align-items: center; cursor: default;">
      <div style="position: absolute; top: -40px; right: 0; display: flex; gap: 10px; align-items: center;">
        ${filename ? `<span style="color: white; font-size: 14px; background: rgba(255,255,255,0.1); padding: 6px 12px; border-radius: 6px;">${filename}</span>` : ''}
        <button 
          id="imageModalCloseBtn"
          style="background: rgba(255, 255, 255, 0.2); border: none; color: white; width: 36px; height: 36px; border-radius: 50%; cursor: pointer; font-size: 20px; display: flex; align-items: center; justify-content: center; transition: all 0.2s;"
        >×</button>
      </div>
      <img 
        src="${imageUrl}" 
        style="max-width: 100%; max-height: 90vh; border-radius: 8px; box-shadow: 0 10px 40px rgba(0,0,0,0.5); object-fit: contain;"
      />
    </div>
  `;
  
  document.body.appendChild(modal);
  
  // 閉じるボタンのイベント設定
  const closeBtn = document.getElementById('imageModalCloseBtn');
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    closeImageModal();
  });
  closeBtn.addEventListener('mouseover', function() {
    this.style.background = 'rgba(255, 255, 255, 0.3)';
    this.style.transform = 'scale(1.1)';
  });
  closeBtn.addEventListener('mouseout', function() {
    this.style.background = 'rgba(255, 255, 255, 0.2)';
    this.style.transform = 'scale(1)';
  });
  
  // 内側コンテンツのクリック伝播を停止
  const innerContent = modal.querySelector('div');
  innerContent.addEventListener('click', (e) => {
    e.stopPropagation();
  });
  
  // 背景クリックで閉じる（1回だけ実行）
  modal.addEventListener('click', () => {
    closeImageModal();
  }, { once: true });
  
  // ESCキーで閉じる
  _imageModalEscapeHandler = (e) => {
    if (e.key === 'Escape') {
      closeImageModal();
    }
  };
  document.addEventListener('keydown', _imageModalEscapeHandler);
}

/**
 * 画像モーダルを閉じる
 */
function closeImageModal() {
  const modal = document.getElementById('imageModal');
  if (!modal) return;
  
  // ESCハンドラーを削除
  if (_imageModalEscapeHandler) {
    document.removeEventListener('keydown', _imageModalEscapeHandler);
    _imageModalEscapeHandler = null;
  }
  
  // 即座に削除（フラッシュを防ぐためアニメーションなし）
  modal.remove();
}

// AI Assistant関数をグローバルスコープに公開
window.toggleCopilot = toggleCopilot;
window.toggleCopilotExpand = toggleCopilotExpand;
window.sendCopilotMessage = sendCopilotMessage;
window.clearCopilotHistory = clearCopilotHistory;
window.handleCopilotKeydown = handleCopilotKeydown;
window.startNewConversation = startNewConversation;
window.addCopilotImagesFromFiles = addCopilotImagesFromFiles;
window.handleCopilotPaste = handleCopilotPaste;
window.removeCopilotImageAt = removeCopilotImageAt;
window.clearCopilotImages = clearCopilotImages;
window.showImageModal = showImageModal;
window.closeImageModal = closeImageModal;
window.showConfirmModal = showConfirmModal;
window.closeConfirmModal = closeConfirmModal;
window.openCopilotImage = openCopilotImage;

// AI Assistantテキストエリアにペーストイベントリスナーを追加
const copilotInput = document.getElementById('copilotInput');
if (copilotInput) {
  copilotInput.addEventListener('paste', handleCopilotPaste);
}

// データベース関連関数をグローバルスコープに公開
window.refreshDbInfo = refreshDbInfo;
window.refreshDbTables = refreshDbTables;
window.refreshDbStorage = refreshDbStorage;
window.loadDbConnectionSettings = loadDbConnectionSettings;
window.testDbConnection = testDbConnection;
window.getAdbInfo = getAdbInfo;
window.startAdb = startAdb;
window.stopAdb = stopAdb;
window.handleWalletFileSelect = handleWalletFileSelect;
window.loadDbStorage = loadDbStorage;

// テーブル一覧ページング関連関数をグローバルスコープに公開
window.handleDbTablesPrevPage = handleDbTablesPrevPage;
window.handleDbTablesNextPage = handleDbTablesNextPage;
window.handleDbTablesJumpPage = handleDbTablesJumpPage;
window.toggleDbTableSelection = toggleDbTableSelection;
window.toggleSelectAllDbTables = toggleSelectAllDbTables;
window.selectAllDbTables = selectAllDbTables;
window.clearAllDbTables = clearAllDbTables;
window.deleteSelectedDbTables = deleteSelectedDbTables;

// ========================================
// 確認モーダル機能
// ========================================

let confirmModalResolve = null;

/**
 * 確認モーダルを表示
 * @param {string} message - 確認メッセージ
 * @param {string} title - タイトル（オプション）
 * @returns {Promise<boolean>} - ユーザーの選択
 */
function showConfirmModal(message, title = '確認') {
  return new Promise((resolve) => {
    confirmModalResolve = resolve;
    
    const modal = document.getElementById('confirmModal');
    const titleElement = document.getElementById('confirmModalTitle');
    const messageElement = document.getElementById('confirmModalMessage');
    
    titleElement.textContent = title;
    messageElement.textContent = message;
    modal.style.display = 'flex';
  });
}

/**
 * 確認モーダルを閉じる
 * @param {boolean} result - ユーザーの選択結果
 */
function closeConfirmModal(result) {
  const modal = document.getElementById('confirmModal');
  modal.style.display = 'none';
  
  if (confirmModalResolve) {
    confirmModalResolve(result);
    confirmModalResolve = null;
  }
}

// ========================================
// Object Storage設定機能
// ========================================

/**
 * Object Storage設定ステータスバッジを更新
 */
function updateObjectStorageStatusBadge(bucketName, namespace) {
  const statusBadge = document.getElementById('objectStorageStatusBadge');
  if (!statusBadge) return;
  
  if (bucketName && namespace) {
    statusBadge.textContent = '設定済み';
    statusBadge.style.background = '#10b981';
    statusBadge.style.color = '#fff';
  } else {
    statusBadge.textContent = '未設定';
    statusBadge.style.background = '#e2e8f0';
    statusBadge.style.color = '#64748b';
  }
}

/**
 * Object Storage設定を読み込む
 */
async function loadObjectStorageSettings() {
  try {
    showLoading('Object Storage設定を読み込み中...');
    
    // OCI設定を取得
    const settingsData = await apiCall('/api/oci/settings');
    
    // Bucket Nameを設定
    const bucketNameInput = document.getElementById('bucketName');
    if (bucketNameInput && settingsData.settings.bucket_name) {
      bucketNameInput.value = settingsData.settings.bucket_name;
    }
    
    // Namespaceを取得（.env優先、空ならAPI）
    const namespaceInput = document.getElementById('namespace');
    const namespaceStatus = document.getElementById('namespaceStatus');
    
    if (settingsData.settings.namespace) {
      // .envから取得できた場合
      namespaceInput.value = settingsData.settings.namespace;
      namespaceStatus.textContent = '環境変数から読み込み済み';
      namespaceStatus.className = 'text-xs text-green-600';
    } else {
      // 空の場合、APIで取得を試みる
      namespaceStatus.textContent = 'Namespaceを取得中...';
      namespaceStatus.className = 'text-xs text-blue-600';
      
      try {
        const namespaceData = await apiCall('/api/oci/namespace');
        if (namespaceData.success) {
          namespaceInput.value = namespaceData.namespace;
          namespaceStatus.textContent = `OCI APIから自動取得済み`;
          namespaceStatus.className = 'text-xs text-green-600';
        } else {
          namespaceStatus.textContent = '⚠️ Namespaceの取得に失敗しました';
          namespaceStatus.className = 'text-xs text-red-600';
        }
      } catch (namespaceError) {
        console.error('Namespace取得エラー:', namespaceError);
        namespaceStatus.textContent = `⚠️ 取得エラー: ${namespaceError.message}`;
        namespaceStatus.className = 'text-xs text-red-600';
      }
    }
    
    // ステータスバッジを更新
    updateObjectStorageStatusBadge(
      bucketNameInput?.value,
      namespaceInput?.value
    );
    
  } catch (error) {
    console.error('Object Storage設定読み込みエラー:', error);
    showToast('⚠️ Object Storage設定の読み込みに失敗しました', 'error');
  } finally {
    hideLoading();
  }
}

/**
 * Object Storage設定を保存
 */
async function saveObjectStorageSettings() {
  try {
    const bucketName = document.getElementById('bucketName').value.trim();
    const namespace = document.getElementById('namespace').value.trim();
    
    if (!bucketName) {
      showToast('⚠️ Bucket Nameを入力してください', 'warning');
      return;
    }
    
    if (!namespace) {
      showToast('⚠️ Namespaceが取得されていません', 'warning');
      return;
    }
    
    showLoading('Object Storage設定を保存中...');
    
    const response = await apiCall('/api/oci/object-storage/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bucket_name: bucketName,
        namespace: namespace
      })
    });
    
    if (response.success) {
      showToast('✅ Object Storage設定を保存しました', 'success');
      // ステータスバッジを更新
      updateObjectStorageStatusBadge(bucketName, namespace);
      // 設定を再読み込み
      await loadObjectStorageSettings();
    } else {
      showToast(`⚠️ ${response.message || '保存に失敗しました'}`, 'error');
    }
    
  } catch (error) {
    console.error('Object Storage設定保存エラー:', error);
    showToast(`⚠️ 保存エラー: ${error.message}`, 'error');
  } finally {
    hideLoading();
  }
}

/**
 * Object Storage接続テスト
 */
async function testObjectStorageConnection() {
  try {
    const bucketName = document.getElementById('bucketName').value.trim();
    const namespace = document.getElementById('namespace').value.trim();
    
    if (!bucketName) {
      showToast('⚠️ Bucket Nameを入力してください', 'warning');
      return;
    }
    
    if (!namespace) {
      showToast('⚠️ Namespaceが取得されていません', 'warning');
      return;
    }
    
    showLoading('Object Storage接続テスト中...');
    
    const response = await apiCall('/api/oci/object-storage/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bucket_name: bucketName,
        namespace: namespace
      })
    });
    
    if (response.success) {
      showToast(response.message || '✅ 接続テストに成功しました', 'success');
    } else {
      showToast(response.message || '⚠️ 接続テストに失敗しました', 'error');
    }
    
  } catch (error) {
    console.error('Object Storage接続テストエラー:', error);
    showToast(`⚠️ テストエラー: ${error.message}`, 'error');
  } finally {
    hideLoading();
  }
}

// Object Storage関連関数をグローバルスコープに公開
window.loadObjectStorageSettings = loadObjectStorageSettings;
window.saveObjectStorageSettings = saveObjectStorageSettings;
window.testObjectStorageConnection = testObjectStorageConnection;

// その他のグローバル関数
window.switchTab = switchTab;
window.performSearch = performSearch;
window.clearSearchResults = clearSearchResults;
window.handleFileSelect = handleFileSelect;
window.uploadDocument = uploadDocument;
window.deleteDocument = deleteDocument;
window.loadOciSettings = loadOciSettings;
window.saveOciSettings = saveOciSettings;
window.testOciConnection = testOciConnection;
window.handleLogin = handleLogin;
window.handleLogout = handleLogout;
window.toggleLoginPassword = toggleLoginPassword;

// 複数ファイルアップロード関連関数をグローバルスコープに公開
window.handleMultipleFileSelect = handleMultipleFileSelect;
window.handleDropForMultipleInput = handleDropForMultipleInput;
window.uploadMultipleDocuments = uploadMultipleDocuments;
window.clearMultipleFileSelection = clearMultipleFileSelection;
window.removeFileFromSelection = removeFileFromSelection;
