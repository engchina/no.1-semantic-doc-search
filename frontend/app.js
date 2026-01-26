// ========================================
// モジュールインポート
// ========================================
import { appState, setAuthState, getAuthState } from './src/state.js';
import { apiCall as authApiCall } from './src/modules/auth.js';
import { 
  showToast as utilsShowToast, 
  showLoading as utilsShowLoading, 
  hideLoading as utilsHideLoading,
  formatFileSize as utilsFormatFileSize,
  formatDateTime as utilsFormatDateTime,
  showConfirmModal as utilsShowConfirmModal
} from './src/modules/utils.js';

// ========================================
// グローバル変数（非推奨 - appStateへの移行中）
// ========================================
// 開発時はViteのプロキシを使うため空文字列、本番ビルド時は環境変数から設定
const API_BASE = import.meta.env.VITE_API_BASE || '';

// 注: 以下の変数はappStateに移行済み。後方互換性のため一時的に残しています。
// TODO: すべての参照をappState.get()に置き換えた後、これらを削除します。
let selectedFile = null;           // -> appState.get('selectedFile')
let documentsCache = [];           // -> appState.get('documentsCache')
let isLoggedIn = false;            // -> appState.get('isLoggedIn')
let loginToken = null;             // -> appState.get('loginToken')
let loginUser = null;              // -> appState.get('loginUser')
let debugMode = false;             // -> appState.get('debugMode')
let requireLogin = true;           // -> appState.get('requireLogin')

// AI Assistant状態（TODO: appStateへ移行）
let copilotOpen = false;            // -> appState.get('copilotOpen')
let copilotExpanded = false;        // -> appState.get('copilotExpanded')
let copilotMessages = [];           // -> appState.get('copilotMessages')
let copilotLoading = false;         // -> appState.get('copilotLoading')
let copilotImages = [];             // -> appState.get('copilotImages')

// テーブル一覧ページング状態（TODO: appStateへ移行）
let dbTablesPage = 1;               // -> appState.get('dbTablesPage')
let dbTablesPageSize = 20;          // -> appState.get('dbTablesPageSize')
let dbTablesTotalPages = 1;         // -> appState.get('dbTablesTotalPages')

// テーブル一覧選択状態（TODO: appStateへ移行）
let selectedDbTables = [];          // -> appState.get('selectedDbTables')
let dbTablesBatchDeleteLoading = false; // -> appState.get('dbTablesBatchDeleteLoading')
let currentPageDbTables = [];       // -> appState.get('currentPageDbTables')

// テーブルデータプレビュー状態（TODO: appStateへ移行）
let selectedTableForPreview = null; // -> appState.get('selectedTableForPreview')
let tableDataPage = 1;              // -> appState.get('tableDataPage')
let tableDataPageSize = 20;         // -> appState.get('tableDataPageSize')
let tableDataTotalPages = 1;        // -> appState.get('tableDataTotalPages')
let selectedTableDataRows = [];     // -> appState.get('selectedTableDataRows')
let currentPageTableDataRows = [];  // -> appState.get('currentPageTableDataRows')

// ========================================
// ユーティリティ関数（モジュールから直接使用）
// ========================================
// 注: 非推奨ラッパー関数は削除済み。
// 以下のインポートを直接使用:
// - authApiCall: APIコール
// - utilsShowToast: トースト通知
// - utilsShowLoading/utilsHideLoading: ローディング
// - utilsFormatFileSize/utilsFormatDateTime: フォーマット
// - utilsShowConfirmModal: 確認モーダル

/**
 * 認証トークン付きの画像URLを生成（referenceプロジェクトに準拠）
 * @param {string} bucket - バケット名
 * @param {string} objectName - オブジェクト名
 * @returns {string} トークン付きの画像URL
 */
function getAuthenticatedImageUrl(bucket, objectName) {
  const baseUrl = `/api/oci/image/${bucket}/${encodeURIComponent(objectName)}`;
  const token = localStorage.getItem('loginToken');
  if (token) {
    return `${baseUrl}?token=${encodeURIComponent(token)}`;
  }
  return baseUrl;
}

// ========================================
// タブ切り替え
// ========================================

async function switchTab(tabName, event) {
  console.log('switchTab called:', tabName);
  
  // タブボタンのアクティブ状態を更新
  document.querySelectorAll('.apex-tab').forEach(tab => {
    tab.classList.remove('active');
  });
  if (event && event.target) {
    event.target.classList.add('active');
  }
  
  // タブコンテンツの表示切り替え
  document.querySelectorAll('.tab-content').forEach(content => {
    content.style.display = 'none';
  });
  document.getElementById(`tab-${tabName}`).style.display = 'block';
  
  // ページ全体のスクロールコンテナをトップにスクロール
  const tabScrollContainer = document.querySelector('.tab-scroll-container');
  if (tabScrollContainer) {
    tabScrollContainer.scrollTop = 0;
  }
  
  // タブ内のすべてのスクロール可能なテーブルもトップにスクロール
  const scrollableTables = document.querySelectorAll('.table-wrapper-scrollable');
  scrollableTables.forEach(table => {
    if (table.offsetParent !== null) { // 表示中のエリアのみ
      table.scrollTop = 0;
    }
  });
  
  // タブに応じた初期化処理（バックエンドAPI呼び出し時はオーバーレイ表示）
  // 注: 文書管理タブの自動刷新は無効（🔄 更新ボタンで手動刷新）
  try {
    if (tabName === 'settings') {
      console.log('Loading OCI settings...');
      utilsShowLoading('OCI設定を読み込み中...');
      await loadOciSettings();
      await loadObjectStorageSettings();
      utilsHideLoading();
      console.log('OCI settings loaded');
    } else if (tabName === 'database') {
      console.log('Loading DB connection settings, ADB OCID, and connection info from .env...');
      utilsShowLoading('データベース設定を読み込み中...');
      await loadDbConnectionSettings();
      // ADB OCIDのみを自動取得（Display NameやLifecycle Stateは取得しない）
      try {
        await loadAdbOcidOnly();
      } catch (error) {
        console.warn('ADB OCID取得エラー（スキップ）:', error);
      }
      // .envからDB接続情報を自動取得（ユーザー名、パスワード、DSN）
      try {
        await loadDbConnectionInfoFromEnv();
      } catch (error) {
        console.warn('DB接続情報取得エラー（スキップ）:', error);
      }
      utilsHideLoading();
      console.log('DB connection settings, ADB OCID, and connection info loaded');
    }
  } catch (error) {
    console.error('Tab initialization error:', error);
    utilsHideLoading();
    utilsShowToast(`設定読み込みエラー: ${error.message}`, 'error');
  }
}

// ========================================
// 検索機能（search.jsモジュールを使用）
// ========================================
// 注: 検索機能はsrc/modules/search.jsに移行済み
// window.searchModule.performSearch(), window.searchModule.clearSearchResults() を使用してください

// ========================================
// ページ画像化されたファイルの判定
// ========================================

/**
 * ページ画像化で生成されたファイルかどうかを判定
 * 構造: 親ファイル名/page_001.png, 親ファイル名/page_002.png ...
 * 例: "example.pdf" → "example/page_001.png"
 * 
 * @param {string} objectName - オブジェクト名
 * @param {Array} allObjects - 全オブジェクトのリスト（親ファイルの存在確認用）
 * @returns {boolean} ページ画像化されたファイルの場合true
 */
function isGeneratedPageImage(objectName, allObjects = allOciObjects) {
  // page_001.pngのパターンにマッチするかチェック
  if (!/\/page_\d{3}\.png$/.test(objectName)) {
    return false;
  }
  
  // デバッグ用ログ（本番環境ではコメントアウト）
  // console.log('[isGeneratedPageImage] objectName:', objectName);
  
  // 親ファイル名を抽出（例: "example/page_001.png" → "example"）
  const lastSlashIndex = objectName.lastIndexOf('/');
  if (lastSlashIndex === -1) {
    // ルート直下のpage_001.pngはページ画像化されたファイルではない
    return false;
  }
  
  const parentFolderPath = objectName.substring(0, lastSlashIndex);
  // console.log('[isGeneratedPageImage] parentFolderPath:', parentFolderPath);
  
  // 親フォルダと同名のファイルが存在するかチェック
  // 例: "example/page_001.png" の場合、"example", "example.pdf", "example.pptx" などが存在すればページ画像化されたファイル
  const parentFileExists = allObjects.some(obj => {
    // フォルダを除外
    if (obj.name.endsWith('/')) {
      return false;
    }
    
    // 拡張子を除いたファイル名を比較
    const objNameWithoutExt = obj.name.replace(/\.[^.]+$/, '');
    return objNameWithoutExt === parentFolderPath;
  });
  
  // console.log('[isGeneratedPageImage] parentFileExists:', parentFileExists);
  
  return parentFileExists;
}

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
    utilsShowToast(`アップロード可能なファイル数は最大${MAX_FILES}個です`, 'warning');
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
    utilsShowToast(`アップロード可能なファイル数は最大${MAX_FILES}個です`, 'warning');
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
          <div class="text-xs text-gray-500">${utilsFormatFileSize(file.size)}</div>
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
    utilsShowToast('ファイルを選択してください', 'warning');
    return;
  }
  
  try {
    // ボタンを無効化
    document.getElementById('uploadMultipleBtn').disabled = true;
    
    // オーバーレイを表示
    utilsShowLoading(`${selectedMultipleFiles.length}個のファイルをアップロード中...`);
    
    // FormDataを作成
    const formData = new FormData();
    selectedMultipleFiles.forEach(file => {
      formData.append('files', file);
    });
    
    // API呼び出し
    const data = await authApiCall('/api/documents/upload/multiple', {
      method: 'POST',
      body: formData
    });
    
    // オーバーレイを非表示
    utilsHideLoading();
    
    // 結果を表示
    displayUploadResults(data);
    
    // 成功した場合のトースト
    if (data.success) {
      utilsShowToast(`${data.success_count}件のファイルアップロードが完了しました`, 'success');
    } else {
      utilsShowToast(data.message, 'warning');
    }
    
    // フォームをリセット（5秒後：showToastと同じタイミング）
    setTimeout(() => {
      clearMultipleFileSelection();
      // 注: 文書リストの自動刷新は行わない（🔄 更新ボタンで手動刷新）
    }, 5000);
    
  } catch (error) {
    utilsHideLoading();
    document.getElementById('uploadProgress').style.display = 'none';
    document.getElementById('uploadMultipleBtn').disabled = false;
    utilsShowToast(`アップロードエラー: ${error.message}`, 'error');
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
    // appStateに保存
    appState.set('selectedFile', file);
    // 後方互換性（TODO: 削除予定）
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
          📄 ${file.name} (${utilsFormatFileSize(file.size)})
        </div>
      </div>
    `;
  }
}

function clearFileSelection() {
  // appStateをクリア
  appState.set('selectedFile', null);
  // 後方互換性（TODO: 削除予定）
  selectedFile = null;
  
  document.getElementById('fileInput').value = '';
  document.getElementById('uploadBtn').disabled = true;
  document.getElementById('uploadStatus').style.display = 'none';
}

async function uploadDocument() {
  if (!selectedFile) {
    utilsShowToast('ファイルを選択してください', 'warning');
    return;
  }
  
  try {
    utilsShowLoading('文書をアップロード中...');
    
    const formData = new FormData();
    formData.append('file', selectedFile);
    
    const data = await authApiCall('/api/documents/upload', {
      method: 'POST',
      body: formData
    });
    
    utilsHideLoading();
    utilsShowToast('文書のアップロードと処理が完了しました', 'success');
    
    // フォームをリセット
    clearFileSelection();
    
    // 文書リストを更新
    await loadDocuments();
    
  } catch (error) {
    utilsHideLoading();
    utilsShowToast(`アップロードエラー: ${error.message}`, 'error');
  }
}

async function loadDocuments() {
  try {
    const data = await authApiCall('/api/documents');
    documentsCache = data.documents;
    displayDocumentsList(data.documents);
  } catch (error) {
    utilsShowToast(`エラー: ${error.message}`, 'error');
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

// フィルター状態
let ociObjectsFilterPageImages = "all";  // all, done, not_done
let ociObjectsFilterEmbeddings = "all";  // all, done, not_done
let ociObjectsDisplayType = "files_only";  // files_only, files_and_images

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
window.refreshDocumentsWithNotification = async function() {
  try {
    utilsShowLoading('文書一覧を更新中...');
    await loadOciObjects();
    utilsHideLoading();
    utilsShowToast('文書一覧を更新しました', 'success');
  } catch (error) {
    utilsHideLoading();
    utilsShowToast(`文書一覧更新エラー: ${error.message}`, 'error');
  }
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
 * 文書統計情報バッジを更新
 */
function updateDocumentsStatisticsBadges(statistics, type = 'success') {
  // ファイル数バッジ
  const fileBadge = document.getElementById('documentsFileCountBadge');
  if (fileBadge && statistics) {
    fileBadge.textContent = `ファイル: ${statistics.file_count}件`;
    fileBadge.style.background = '';
    fileBadge.style.color = '';
    fileBadge.classList.remove('bg-green-100', 'text-green-800', 'bg-red-100', 'text-red-800', 'bg-gray-100', 'text-gray-600');
    
    if (type === 'success') {
      fileBadge.classList.add('bg-blue-100', 'text-blue-800');
    } else if (type === 'error') {
      fileBadge.classList.add('bg-red-100', 'text-red-800');
    } else {
      fileBadge.classList.add('bg-gray-100', 'text-gray-600');
    }
    fileBadge.style.display = 'inline-block';
  }
  
  // ページ画像数バッジ
  const pageImageBadge = document.getElementById('documentsPageImageCountBadge');
  if (pageImageBadge && statistics) {
    pageImageBadge.textContent = `ページ画像: ${statistics.page_image_count}件`;
    pageImageBadge.style.background = '';
    pageImageBadge.style.color = '';
    pageImageBadge.classList.remove('bg-green-100', 'text-green-800', 'bg-red-100', 'text-red-800', 'bg-gray-100', 'text-gray-600');
    
    if (type === 'success') {
      pageImageBadge.classList.add('bg-purple-100', 'text-purple-800');
    } else if (type === 'error') {
      pageImageBadge.classList.add('bg-red-100', 'text-red-800');
    } else {
      pageImageBadge.classList.add('bg-gray-100', 'text-gray-600');
    }
    pageImageBadge.style.display = 'inline-block';
  }
}

/**
 * OCI Object Storage一覧を読み込む
 */
async function loadOciObjects() {
  try {
    utilsShowLoading('OCI Object Storage一覧を取得中...');
    
    const params = new URLSearchParams({
      prefix: ociObjectsPrefix,
      page: ociObjectsPage.toString(),
      page_size: ociObjectsPageSize.toString(),
      filter_page_images: ociObjectsFilterPageImages,
      filter_embeddings: ociObjectsFilterEmbeddings,
      display_type: ociObjectsDisplayType
    });
    
    const data = await authApiCall(`/api/oci/objects?${params}`);
    
    utilsHideLoading();
    
    if (!data.success) {
      utilsShowToast(`エラー: ${data.message || 'オブジェクト一覧取得失敗'}`, 'error');
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
    const statistics = data.statistics || { file_count: 0, page_image_count: 0, total_count: 0 };
    
    updateDocumentsStatusBadge(`${totalCount}件`, 'success');
    updateDocumentsStatisticsBadges(statistics, 'success');
    
  } catch (error) {
    utilsHideLoading();
    utilsShowToast(`OCI Object Storage一覧取得エラー: ${error.message}`, 'error');
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
  
  // デバッグ: 選択状態を確認
  // console.log('========== displayOciObjectsList ==========');
  // console.log('現在表示中のオブジェクト:', objects.map(o => o.name));
  // console.log('selectedOciObjects:', selectedOciObjects);
  // console.log('selectedOciObjects.length:', selectedOciObjects.length);
  // console.log('allOciObjects.length:', allOciObjects.length);
  
  // 全ページ選択状態をチェック（チェックボックスを持つオブジェクトのみ対象）
  // ページ画像化で生成されたファイル（page_*.png）はチェックボックスを持たないため除外
  const selectableObjects = objects.filter(obj => {
    return !isGeneratedPageImage(obj.name, allOciObjects);
  });
  const allPageSelected = selectableObjects.length > 0 && selectableObjects.every(obj => selectedOciObjects.includes(obj.name));
  
  // フィルターUI HTML（常に表示）
  const filterHtml = `
    <div class="flex items-center gap-4 mb-3 p-3 bg-gray-50 rounded-lg border border-gray-200">
      <div class="flex items-center gap-2">
        <span class="text-xs font-medium text-gray-600">📁 表示タイプ:</span>
        <div class="flex gap-1">
          <button 
            onclick="setOciObjectsDisplayType('files_only')" 
            class="px-2.5 py-1 text-xs rounded-full transition-all ${ociObjectsDisplayType === 'files_only' ? 'bg-blue-600 text-white shadow-sm' : 'bg-white text-gray-600 border border-gray-300 hover:bg-gray-100'}"
          >
            ファイルのみ
          </button>
          <button 
            onclick="setOciObjectsDisplayType('files_and_images')" 
            class="px-2.5 py-1 text-xs rounded-full transition-all ${ociObjectsDisplayType === 'files_and_images' ? 'bg-blue-600 text-white shadow-sm' : 'bg-white text-gray-600 border border-gray-300 hover:bg-gray-100'}"
          >
            ファイル+ページ画像
          </button>
        </div>
      </div>
      <div class="w-px h-6 bg-gray-300"></div>
      <div class="flex items-center gap-2">
        <span class="text-xs font-medium text-gray-600">🖼️ ページ画像化:</span>
        <div class="flex gap-1">
          <button 
            onclick="setOciObjectsFilterPageImages('all')" 
            class="px-2.5 py-1 text-xs rounded-full transition-all ${ociObjectsFilterPageImages === 'all' ? 'bg-gray-700 text-white shadow-sm' : 'bg-white text-gray-600 border border-gray-300 hover:bg-gray-100'}"
          >
            すべて
          </button>
          <button 
            onclick="setOciObjectsFilterPageImages('done')" 
            class="px-2.5 py-1 text-xs rounded-full transition-all ${ociObjectsFilterPageImages === 'done' ? 'bg-green-600 text-white shadow-sm' : 'bg-white text-gray-600 border border-gray-300 hover:bg-gray-100'}"
          >
            ✓ 完了
          </button>
          <button 
            onclick="setOciObjectsFilterPageImages('not_done')" 
            class="px-2.5 py-1 text-xs rounded-full transition-all ${ociObjectsFilterPageImages === 'not_done' ? 'bg-orange-500 text-white shadow-sm' : 'bg-white text-gray-600 border border-gray-300 hover:bg-gray-100'}"
          >
            未実行
          </button>
        </div>
      </div>
      <div class="w-px h-6 bg-gray-300"></div>
      <div class="flex items-center gap-2">
        <span class="text-xs font-medium text-gray-600">🔢 ベクトル化:</span>
        <div class="flex gap-1">
          <button 
            onclick="setOciObjectsFilterEmbeddings('all')" 
            class="px-2.5 py-1 text-xs rounded-full transition-all ${ociObjectsFilterEmbeddings === 'all' ? 'bg-gray-700 text-white shadow-sm' : 'bg-white text-gray-600 border border-gray-300 hover:bg-gray-100'}"
          >
            すべて
          </button>
          <button 
            onclick="setOciObjectsFilterEmbeddings('done')" 
            class="px-2.5 py-1 text-xs rounded-full transition-all ${ociObjectsFilterEmbeddings === 'done' ? 'bg-green-600 text-white shadow-sm' : 'bg-white text-gray-600 border border-gray-300 hover:bg-gray-100'}"
          >
            ✓ 完了
          </button>
          <button 
            onclick="setOciObjectsFilterEmbeddings('not_done')" 
            class="px-2.5 py-1 text-xs rounded-full transition-all ${ociObjectsFilterEmbeddings === 'not_done' ? 'bg-orange-500 text-white shadow-sm' : 'bg-white text-gray-600 border border-gray-300 hover:bg-gray-100'}"
          >
            未実行
          </button>
        </div>
      </div>
      ${(ociObjectsFilterPageImages !== 'all' || ociObjectsFilterEmbeddings !== 'all') ? `
        <button 
          onclick="clearOciObjectsFilters()" 
          class="ml-auto px-2.5 py-1 text-xs rounded-full bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 transition-all flex items-center gap-1"
        >
          <span>✕</span>
          <span>フィルタークリア</span>
        </button>
      ` : ''}
    </div>
  `;
  
  // データが0件の場合の表示
  if (objects.length === 0) {
    listDiv.innerHTML = `
      <div>
        ${filterHtml}
        <div style="text-align: center; padding: 40px; color: #64748b;">
          <div style="font-size: 48px; margin-bottom: 16px;">📁</div>
          <div style="font-size: 16px; font-weight: 500;">オブジェクトがありません</div>
          <div style="font-size: 14px; margin-top: 8px;">バケット: ${data.bucket_name || '-'}</div>
        </div>
      </div>
    `;
    return;
  }
  
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
        class="px-3 py-1 text-xs rounded transition-colors ${selectedOciObjects.length === 0 || ociObjectsBatchDeleteLoading ? 'bg-blue-300 text-white cursor-not-allowed' : 'bg-blue-500 hover:bg-blue-600 text-white'}" 
        onclick="downloadSelectedOciObjects()" 
        ${selectedOciObjects.length === 0 || ociObjectsBatchDeleteLoading ? 'disabled' : ''}
        title="選択されたアイテム（フォルダ配下の子アイテムを含む）をZIPでダウンロード: ${selectedOciObjects.length}件"
      >
        📥 ダウンロード (${selectedOciObjects.length}件)
      </button>
      <button 
        class="px-3 py-1 text-xs rounded transition-colors ${selectedOciObjects.length === 0 || ociObjectsBatchDeleteLoading ? 'bg-purple-300 text-white cursor-not-allowed' : 'bg-purple-500 hover:bg-purple-600 text-white'}" 
        onclick="convertSelectedOciObjectsToImages()" 
        ${selectedOciObjects.length === 0 || ociObjectsBatchDeleteLoading ? 'disabled' : ''}
        title="選択されたファイル（フォルダ配下の子ファイルを含む）をページ毎に画像化: ${selectedOciObjects.length}件"
      >
        🖼️ ページ画像化 (${selectedOciObjects.length}件)
      </button>
      <button 
        class="px-3 py-1 text-xs rounded transition-colors ${selectedOciObjects.length === 0 || ociObjectsBatchDeleteLoading ? 'bg-green-300 text-white cursor-not-allowed' : 'bg-green-500 hover:bg-green-600 text-white'}" 
        onclick="vectorizeSelectedOciObjects()" 
        ${selectedOciObjects.length === 0 || ociObjectsBatchDeleteLoading ? 'disabled' : ''}
        title="選択されたファイルの画像をベクトル化してDBに保存: ${selectedOciObjects.length}件"
      >
        🔢 ベクトル化 (${selectedOciObjects.length}件)
      </button>
      <button 
        class="px-3 py-1 text-xs rounded transition-colors ${selectedOciObjects.length === 0 || ociObjectsBatchDeleteLoading ? 'bg-gray-300 text-gray-500 cursor-not-allowed' : 'bg-red-500 hover:bg-red-600 text-white'}" 
        onclick="deleteSelectedOciObjects()" 
        ${selectedOciObjects.length === 0 || ociObjectsBatchDeleteLoading ? 'disabled' : ''}
        title="選択されたアイテム（フォルダ配下の子アイテムを含む）を削除: ${selectedOciObjects.length}件"
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
      ${filterHtml}
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
              <th style="text-align: center;">ページ画像化</th>
              <th style="text-align: center;">ベクトル化</th>
            </tr>
          </thead>
          <tbody>
            ${objects.map(obj => {
              const isFolder = obj.type === 'folder';
              
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
              
              // ページ画像化で生成されたファイル（page_001.png, page_002.pngなど）かどうかを判定
              // 注: 親ファイルが別のページにある場合もあるため、全オブジェクトキャッシュを使用
              const isPageImage = !isFolder && isGeneratedPageImage(obj.name, allOciObjects);
              
              // タイプラベルとアイコンを設定
              let icon, typeLabel;
              if (isFolder) {
                icon = '📁';
                typeLabel = 'フォルダ';
              } else if (isPageImage) {
                icon = '🖼️';
                typeLabel = 'ページ画像';
              } else {
                icon = '📄';
                typeLabel = 'ファイル';
              }
              
              // ページ画像化・ベクトル化ステータスバッジを生成
              let pageImageStatusHtml = '';
              let vectorizeStatusHtml = '';
              
              if (isFolder || isPageImage) {
                // フォルダやページ画像は対象外
                pageImageStatusHtml = '<span style="color: #9ca3af;">-</span>';
                vectorizeStatusHtml = '<span style="color: #9ca3af;">-</span>';
              } else {
                // ファイルの場合
                if (obj.has_page_images === true) {
                  pageImageStatusHtml = '<span class="px-2 py-0.5 text-xs font-semibold rounded" style="background: #dcfce7; color: #166534;">✓ 完了</span>';
                } else {
                  pageImageStatusHtml = '<span class="px-2 py-0.5 text-xs font-semibold rounded" style="background: #f3f4f6; color: #6b7280;">未実行</span>';
                }
                
                if (obj.has_embeddings === true) {
                  vectorizeStatusHtml = '<span class="px-2 py-0.5 text-xs font-semibold rounded" style="background: #dcfce7; color: #166534;">✓ 完了</span>';
                } else {
                  vectorizeStatusHtml = '<span class="px-2 py-0.5 text-xs font-semibold rounded" style="background: #f3f4f6; color: #6b7280;">未実行</span>';
                }
              }
              
              return `
                <tr>
                  <td>${isPageImage ? '' : `<input type="checkbox" data-object-name="${escapedNameForHtml}" onchange="toggleOciObjectSelection(this.getAttribute('data-object-name'))" ${selectedOciObjects.includes(obj.name) ? 'checked' : ''} class="w-4 h-4 rounded" ${ociObjectsBatchDeleteLoading ? 'disabled' : ''}>`}</td>
                  <td>${icon} ${typeLabel}</td>
                  <td style="font-weight: 500; font-family: monospace; max-width: 400px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                    <span style="display: inline-block; padding-left: ${indentPx}px;">${displayName}</span>
                  </td>
                  <td>${isFolder ? '-' : utilsFormatFileSize(obj.size)}</td>
                  <td>${obj.time_created ? utilsFormatDateTime(obj.time_created) : '-'}</td>
                  <td style="text-align: center;">${pageImageStatusHtml}</td>
                  <td style="text-align: center;">${vectorizeStatusHtml}</td>
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
 * ページ画像化フィルターを設定
 */
window.setOciObjectsFilterPageImages = function(value) {
  if (ociObjectsBatchDeleteLoading) return;
  ociObjectsFilterPageImages = value;
  ociObjectsPage = 1;  // フィルター変更時は1ページ目に戻る
  selectedOciObjects = [];  // 選択状態をクリア
  loadOciObjects();
}

/**
 * ベクトル化フィルターを設定
 */
window.setOciObjectsFilterEmbeddings = function(value) {
  if (ociObjectsBatchDeleteLoading) return;
  ociObjectsFilterEmbeddings = value;
  ociObjectsPage = 1;  // フィルター変更時は1ページ目に戻る
  selectedOciObjects = [];  // 選択状態をクリア
  loadOciObjects();
}

/**
 * すべてのフィルターをクリア
 */
window.clearOciObjectsFilters = function() {
  if (ociObjectsBatchDeleteLoading) return;
  ociObjectsFilterPageImages = "all";
  ociObjectsFilterEmbeddings = "all";
  ociObjectsPage = 1;
  selectedOciObjects = [];
  loadOciObjects();
}

/**
 * 表示タイプフィルターを設定
 * @param {string} value - 表示タイプ ('files_only' | 'files_and_images')
 */
window.setOciObjectsDisplayType = function(value) {
  if (ociObjectsBatchDeleteLoading) return;
  ociObjectsDisplayType = value;
  ociObjectsPage = 1;  // フィルター変更時は1ページ目に戻る
  selectedOciObjects = [];  // 選択状態をクリア
  loadOciObjects();
}

/**
 * オブジェクト選択状態をトグル（親子関係対応、page_*.png除外）
 */
function toggleOciObjectSelection(objectName) {
  if (ociObjectsBatchDeleteLoading) return;
  
  // スクロール位置を保存
  const scrollableArea = document.querySelector('#documentsList .table-wrapper-scrollable');
  const scrollTop = scrollableArea ? scrollableArea.scrollTop : 0;
  
  const index = selectedOciObjects.indexOf(objectName);
  const isCurrentlySelected = index > -1;
  
  if (isCurrentlySelected) {
    // 選択解除
    selectedOciObjects.splice(index, 1);
    
    // フォルダの場合、子オブジェクトも解除（page_*.png除外）
    if (objectName.endsWith('/')) {
      const children = getChildObjects(objectName);
      children.forEach(child => {
        // ページ画像化されたファイルは除外
        if (isGeneratedPageImage(child.name)) {
          return;
        }
        
        const childIndex = selectedOciObjects.indexOf(child.name);
        if (childIndex > -1) {
          selectedOciObjects.splice(childIndex, 1);
        }
      });
    }
  } else {
    // 選択
    selectedOciObjects.push(objectName);
    
    // フォルダの場合、子オブジェクトも選択（page_*.png除外）
    if (objectName.endsWith('/')) {
      const children = getChildObjects(objectName);
      children.forEach(child => {
        // ページ画像化されたファイルは除外
        if (isGeneratedPageImage(child.name)) {
          return;
        }
        
        if (!selectedOciObjects.includes(child.name)) {
          selectedOciObjects.push(child.name);
        }
      });
    }
  }
  
  // 再描画（非同期処理を同期的に待つ）
  loadOciObjects().then(() => {
    // スクロール位置を復元
    const scrollableAreaAfter = document.querySelector('#documentsList .table-wrapper-scrollable');
    if (scrollableAreaAfter) {
      // 少し遅延させてDOMが完全にレンダリングされるのを待つ
      requestAnimationFrame(() => {
        scrollableAreaAfter.scrollTop = scrollTop;
      });
    }
  });
}

/**
 * 全選択トグル（ヘッダーチェックボックス）（親子関係対応）
 */
function toggleSelectAllOciObjects(checked) {
  if (ociObjectsBatchDeleteLoading) return;
  
  // スクロール位置を保存
  const scrollableArea = document.querySelector('#documentsList .table-wrapper-scrollable');
  const scrollTop = scrollableArea ? scrollableArea.scrollTop : 0;
  
  // 現在表示中のオブジェクトを取得（ページ画像化されたファイルは除外）
  const checkboxes = document.querySelectorAll('#documentsList tbody input[type="checkbox"]');
  const currentPageObjects = Array.from(checkboxes).map(cb => {
    return cb.getAttribute('data-object-name');
  }).filter(Boolean);
  
  if (checked) {
    // 現在ページのオブジェクトをすべて選択（親子関係を考慮）
    currentPageObjects.forEach(objName => {
      // ページ画像化されたファイルは除外
      if (isGeneratedPageImage(objName)) {
        return;
      }
      
      if (!selectedOciObjects.includes(objName)) {
        selectedOciObjects.push(objName);
      }
      
      // フォルダの場合、子オブジェクトも選択
      if (objName.endsWith('/')) {
        const children = getChildObjects(objName);
        children.forEach(child => {
          // 子オブジェクトもページ画像化されたファイルを除外
          if (isGeneratedPageImage(child.name)) {
            return;
          }
          
          if (!selectedOciObjects.includes(child.name)) {
            selectedOciObjects.push(child.name);
          }
        });
      }
    });
  } else {
    // 現在ページのオブジェクトをすべて解除（親子関係を考慮）
    currentPageObjects.forEach(objName => {
      // ページ画像化されたファイルは除外
      if (isGeneratedPageImage(objName)) {
        return;
      }
      
      const index = selectedOciObjects.indexOf(objName);
      if (index > -1) {
        selectedOciObjects.splice(index, 1);
      }
      
      // フォルダの場合、子オブジェクトも解除
      if (objName.endsWith('/')) {
        const children = getChildObjects(objName);
        children.forEach(child => {
          // 子オブジェクトもページ画像化されたファイルを除外
          if (isGeneratedPageImage(child.name)) {
            return;
          }
          
          const childIndex = selectedOciObjects.indexOf(child.name);
          if (childIndex > -1) {
            selectedOciObjects.splice(childIndex, 1);
          }
        });
      }
    });
  }
  
  // 再描画（非同期処理を同期的に待つ）
  loadOciObjects().then(() => {
    // スクロール位置を復元
    const scrollableAreaAfter = document.querySelector('#documentsList .table-wrapper-scrollable');
    if (scrollableAreaAfter) {
      requestAnimationFrame(() => {
        scrollableAreaAfter.scrollTop = scrollTop;
      });
    }
  });
}

/**
 * すべて選択（親子関係対応、page_*.png除外）
 */
function selectAllOciObjects() {
  if (ociObjectsBatchDeleteLoading) return;
  
  // スクロール位置を保存
  const scrollableArea = document.querySelector('#documentsList .table-wrapper-scrollable');
  const scrollTop = scrollableArea ? scrollableArea.scrollTop : 0;
  
  // チェックボックスを持つオブジェクトのみを取得（page_*.pngを除外）
  const checkboxes = document.querySelectorAll('#documentsList tbody input[type="checkbox"]');
  const currentPageObjects = Array.from(checkboxes).map(cb => {
    return cb.getAttribute('data-object-name');
  }).filter(Boolean);
  
  currentPageObjects.forEach(objName => {
    if (!selectedOciObjects.includes(objName)) {
      selectedOciObjects.push(objName);
    }
    
    // フォルダの場合、子オブジェクトも選択（page_*.pngを除外）
    if (objName.endsWith('/')) {
      const children = getChildObjects(objName);
      children.forEach(child => {
        // ページ画像化されたファイルを除外
        if (isGeneratedPageImage(child.name)) {
          return;
        }
        
        if (!selectedOciObjects.includes(child.name)) {
          selectedOciObjects.push(child.name);
        }
      });
    }
  });
  
  loadOciObjects().then(() => {
    // スクロール位置を復元
    const scrollableAreaAfter = document.querySelector('#documentsList .table-wrapper-scrollable');
    if (scrollableAreaAfter) {
      requestAnimationFrame(() => {
        scrollableAreaAfter.scrollTop = scrollTop;
      });
    }
  });
}

/**
 * すべて解除
 */
function clearAllOciObjects() {
  if (ociObjectsBatchDeleteLoading) return;
  
  // スクロール位置を保存
  const scrollableArea = document.querySelector('#documentsList .table-wrapper-scrollable');
  const scrollTop = scrollableArea ? scrollableArea.scrollTop : 0;
  
  selectedOciObjects = [];
  loadOciObjects().then(() => {
    // スクロール位置を復元
    const scrollableAreaAfter = document.querySelector('#documentsList .table-wrapper-scrollable');
    if (scrollableAreaAfter) {
      requestAnimationFrame(() => {
        scrollableAreaAfter.scrollTop = scrollTop;
      });
    }
  });
}

/**
 * 選択されたオブジェクトを削除
 */
async function deleteSelectedOciObjects() {
  if (selectedOciObjects.length === 0) {
    utilsShowToast('削除するオブジェクトを選択してください', 'warning');
    return;
  }
  
  const count = selectedOciObjects.length;
  const confirmed = await utilsShowConfirmModal(
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
    const response = await authApiCall('/api/oci/objects/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ object_names: selectedOciObjects })
    });
    
    if (response.success) {
      utilsShowToast(`${count}件のオブジェクトを削除しました`, 'success');
      // 選択をクリア
      selectedOciObjects = [];
      // ページを1にリセット
      ociObjectsPage = 1;
    } else {
      utilsShowToast(`削除エラー: ${response.message || '不明なエラー'}`, 'error');
    }
  } catch (error) {
    utilsShowToast(`削除エラー: ${error.message}`, 'error');
  } finally {
    // 処理中表示を解除
    ociObjectsBatchDeleteLoading = false;
    // 一覧を再読み込み
    loadOciObjects();
  }
}

/**
 * 選択されたOCIオブジェクトをZIPでダウンロード
 */
window.downloadSelectedOciObjects = async function() {
  if (selectedOciObjects.length === 0) {
    utilsShowToast('ダウンロードするファイルを選択してください', 'warning');
    return;
  }
  
  if (ociObjectsBatchDeleteLoading) {
    utilsShowToast('処理中です。しばらくお待ちください', 'warning');
    return;
  }
  
  // トークンを確認
  const token = localStorage.getItem('loginToken');
  if (!token && !debugMode) {
    utilsShowToast('認証が必要です。ログインしてください', 'warning');
    showLoginModal();
    return;
  }
  
  try {
    ociObjectsBatchDeleteLoading = true;
    utilsShowLoading(`${selectedOciObjects.length}件のファイルをZIPに圧縮中...`);
    
    // リクエストヘッダーを構築
    const headers = {
      'Content-Type': 'application/json'
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    
    const response = await fetch('/api/oci/objects/download', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        object_names: selectedOciObjects
      })
    });
    
    if (!response.ok) {
      // 401エラーの場合は強制ログアウト（referenceプロジェクトに準拠）
      if (response.status === 401) {
        utilsHideLoading();
        ociObjectsBatchDeleteLoading = false;
        if (requireLogin) {
          forceLogout();
        }
        throw new Error('無効または期限切れのトークンです');
      }
      
      const errorData = await response.json();
      throw new Error(errorData.detail || 'ダウンロードに失敗しました');
    }
    
    // ZIPファイルをダウンロード
    const blob = await response.blob();
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'documents.zip';
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
    
    utilsHideLoading();
    ociObjectsBatchDeleteLoading = false;
    utilsShowToast(`${selectedOciObjects.length}件のファイルをダウンロードしました`, 'success');
    
  } catch (error) {
    utilsHideLoading();
    ociObjectsBatchDeleteLoading = false;
    console.error('ダウンロードエラー:', error);
    utilsShowToast(`ダウンロードエラー: ${error.message}`, 'error');
  }
};

/**
 * 選択されたOCIオブジェクトをページ毎に画像化
 */
window.convertSelectedOciObjectsToImages = async function() {
  if (selectedOciObjects.length === 0) {
    utilsShowToast('変換するファイルを選択してください', 'warning');
    return;
  }
  
  if (ociObjectsBatchDeleteLoading) {
    utilsShowToast('処理中です。しばらくお待ちください', 'warning');
    return;
  }
  
  // トークンを確認
  const token = localStorage.getItem('loginToken');
  if (!token && !debugMode) {
    utilsShowToast('認証が必要です。ログインしてください', 'warning');
    showLoginModal();
    return;
  }
  
  // 確認モーダルを表示
  const confirmed = await utilsShowConfirmModal(
    'ページ画像化確認',
    `選択された${selectedOciObjects.length}件のファイルを各ページPNG画像として同名フォルダに保存します。\n\n処理には時間がかかる場合があります。実行しますか？`
  );
  
  if (!confirmed) {
    return;
  }
  
  try {
    ociObjectsBatchDeleteLoading = true;
    utilsShowLoading('ページ画像化を開始しています...');
    
    // リクエストヘッダーを構築
    const headers = {
      'Content-Type': 'application/json'
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    
    const response = await fetch('/api/oci/objects/convert-to-images', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        object_names: selectedOciObjects
      })
    });
    
    if (!response.ok) {
      // 401エラーの場合は強制ログアウト（referenceプロジェクトに準拠）
      if (response.status === 401) {
        utilsHideLoading();
        ociObjectsBatchDeleteLoading = false;
        if (requireLogin) {
          forceLogout();
        }
        throw new Error('無効または期限切れのトークンです');
      }
      
      const errorData = await response.json();
      throw new Error(errorData.detail || 'ページ画像化に失敗しました');
    }
    
    // SSE (Server-Sent Events) を使用して進捗状況を受信
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    
    // ジョブIDをヘッダーから取得
    const jobId = response.headers.get('X-Job-ID');
    
    let currentFileIndex = 0;
    let totalFiles = selectedOciObjects.length;
    let currentPageIndex = 0;
    let totalPages = 0;
    let results = [];
    let processedPages = 0; // 全体の処理済みページ数
    let totalPagesAllFiles = 0; // 全ファイルの総ページ数（動的に計算）
    let totalWorkers = 1; // 並列ワーカー数
    
    while (true) {
      const { done, value } = await reader.read();
      
      if (done) {
        break;
      }
      
      // バッファに追加
      buffer += decoder.decode(value, { stream: true });
      
      // 行ごとに処理
      const lines = buffer.split('\n');
      buffer = lines.pop(); // 最後の不完全な行をバッファに戻す
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const jsonStr = line.substring(6); // 'data: ' を除去
            const data = JSON.parse(jsonStr);
            
            // イベントタイプごとに処理
            switch(data.type) {
              case 'start':
                totalFiles = data.total_files;
                totalWorkers = data.total_workers || 1;
                updateLoadingMessage(`ファイルをページ画像化中... (0/${totalFiles})\n並列ワーカー: ${totalWorkers}`, 0, jobId);
                break;
                
              case 'file_queued':
                // ファイルが待機中になった
                updateLoadingMessage(`ファイル待機中: ${data.file_name}\nステータス: ⏳ ${data.status}`, 0, jobId);
                break;
                
              case 'file_processing':
                // ファイルが処理中になった
                currentFileIndex = data.file_index;
                const processingProgress = (currentFileIndex - 1) / totalFiles;
                updateLoadingMessage(`ファイル ${data.file_index}/${totalFiles}\n${data.file_name}\nステータス: 🔄 ${data.status}`, processingProgress, jobId);
                break;
                
              case 'file_start':
                currentFileIndex = data.file_index;
                totalFiles = data.total_files;
                totalPages = 0;
                currentPageIndex = 0;
                const fileProgress = (currentFileIndex - 1) / totalFiles;
                updateLoadingMessage(`ファイル ${currentFileIndex}/${totalFiles} を処理中...\n${data.file_name}`, fileProgress, jobId);
                break;
                
              case 'cleanup_start':
                const cleanupStartProgress = (currentFileIndex - 1) / totalFiles;
                updateLoadingMessage(`ファイル ${data.file_index}/${data.total_files}\n${data.file_name}\n既存の画像ファイルを確認中...`, cleanupStartProgress, jobId);
                break;
                
              case 'cleanup_progress':
                const cleanupProgress = (currentFileIndex - 1) / totalFiles;
                updateLoadingMessage(`ファイル ${data.file_index}/${data.total_files}\n${data.file_name}\n既存画像 ${data.cleanup_count}件を削除中...`, cleanupProgress, jobId);
                break;
                
              case 'cleanup_complete':
                const cleanupCompleteProgress = (currentFileIndex - 1) / totalFiles;
                updateLoadingMessage(`ファイル ${data.file_index}/${data.total_files}\n${data.file_name}\n既存画像 ${data.deleted_count}件を削除完了`, cleanupCompleteProgress, jobId);
                break;
                
              case 'pages_count':
                totalPages = data.total_pages;
                totalPagesAllFiles += totalPages;
                const pagesCountProgress = (currentFileIndex - 1) / totalFiles;
                updateLoadingMessage(`ファイル ${data.file_index}/${data.total_files} を処理中...\n${data.file_name}\n総ページ数: ${totalPages}`, pagesCountProgress, jobId);
                break;
                
              case 'page_progress':
                currentPageIndex = data.page_index;
                totalPages = data.total_pages;
                
                // 全体の進捗率を計算
                const currentProgress = totalPagesAllFiles > 0 ? (processedPages + 1) / totalPagesAllFiles : (currentFileIndex - 1) / totalFiles;
                const overallProgress = Math.min(currentProgress, 1.0);
                updateLoadingMessage(`ファイル ${data.file_index}/${totalFiles} を処理中...\n${data.file_name}\nページ ${currentPageIndex}/${totalPages} を画像化中...`, overallProgress, jobId);
                
                // ページ処理完了後にカウンタを増やす
                processedPages++;
                break;
                
              case 'file_complete':
                const completedFileProgress = currentFileIndex / totalFiles;
                updateLoadingMessage(`ファイル ${data.file_index}/${totalFiles} ✓ 完了\n${data.file_name}\n${data.image_count}ページを画像化しました`, completedFileProgress, jobId);
                break;
                
              case 'file_error':
                console.error(`ファイル ${data.file_index}/${totalFiles} エラー: ${data.error}`);
                const errorProgress = currentFileIndex > 0 ? (currentFileIndex - 1) / totalFiles : 0;
                updateLoadingMessage(`ファイル ${data.file_index}/${totalFiles} ✗ エラー\n${data.file_name}\n${data.error}`, errorProgress, jobId);
                break;
                
              case 'cancelled':
                utilsHideLoading();
                ociObjectsBatchDeleteLoading = false;
                utilsShowToast(`処理がキャンセルされました\n${data.message}`, 'info');
                selectedOciObjects = [];
                await loadOciObjects();
                break;
                
              case 'error':
                utilsHideLoading();
                ociObjectsBatchDeleteLoading = false;
                utilsShowToast(`エラー: ${data.message}`, 'error');
                break;
                
              case 'complete':
                results = data.results;
                utilsHideLoading();
                ociObjectsBatchDeleteLoading = false;
                
                // 結果表示（経過時間を含む）
                const elapsedTime = data.elapsed_time ? ` (${data.elapsed_time.toFixed(1)}秒)` : '';
                if (data.success) {
                  utilsShowToast(`${data.message}${elapsedTime}`, 'success');
                } else {
                  utilsShowToast(`${data.message}${elapsedTime}\n成功: ${data.success_count}件、失敗: ${data.failed_count}件`, 'warning');
                }
                
                // 選択をクリアして一覧を更新
                selectedOciObjects = [];
                await loadOciObjects();
                break;
            }
          } catch (parseError) {
            console.error('JSONパースエラー:', parseError, '行:', line);
          }
        }
      }
    }
    
  } catch (error) {
    utilsHideLoading();
    ociObjectsBatchDeleteLoading = false;
    console.error('ページ画像化エラー:', error);
    utilsShowToast(`ページ画像化エラー: ${error.message}`, 'error');
  }
};

/**
 * 選択されたOCIオブジェクトをベクトル化してDBに保存
 */
window.vectorizeSelectedOciObjects = async function() {
  if (selectedOciObjects.length === 0) {
    utilsShowToast('ベクトル化するファイルを選択してください', 'warning');
    return;
  }
  
  if (ociObjectsBatchDeleteLoading) {
    utilsShowToast('処理中です。しばらくお待ちください', 'warning');
    return;
  }
  
  // トークンを確認
  const token = localStorage.getItem('loginToken');
  if (!token && !debugMode) {
    utilsShowToast('認証が必要です。ログインしてください', 'warning');
    showLoginModal();
    return;
  }
  
  // 確認モーダルを表示
  const confirmed = await utilsShowConfirmModal(
    'ベクトル化確認',
    `選択された${selectedOciObjects.length}件のファイルを画像ベクトル化してデータベースに保存します。

ページ画像化されていないファイルは自動的に画像化されます。
既存のembeddingがある場合は削除してから再作成します。

処理には時間がかかる場合があります。実行しますか？`
  );
  
  if (!confirmed) {
    return;
  }
  
  try {
    ociObjectsBatchDeleteLoading = true;
    utilsShowLoading('ベクトル化を開始しています...');
    
    // リクエストヘッダーを構築
    const headers = {
      'Content-Type': 'application/json'
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    
    const response = await fetch('/api/oci/objects/vectorize', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        object_names: selectedOciObjects
      })
    });
    
    if (!response.ok) {
      // 401エラーの場合は強制ログアウト（referenceプロジェクトに準拠）
      if (response.status === 401) {
        utilsHideLoading();
        ociObjectsBatchDeleteLoading = false;
        if (requireLogin) {
          forceLogout();
        }
        throw new Error('無効または期限切れのトークンです');
      }
      
      const errorData = await response.json();
      throw new Error(errorData.detail || 'ベクトル化に失敗しました');
    }
    
    // SSE (Server-Sent Events) を使用して進捗状況を受信
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    
    // ジョブIDをヘッダーから取得
    const jobId = response.headers.get('X-Job-ID');
    
    let currentFileIndex = 0;
    let totalFiles = selectedOciObjects.length;
    let currentPageIndex = 0;
    let totalPages = 0;
    let results = [];
    let totalWorkers = 1; // 並列ワーカー数
    
    while (true) {
      const { done, value } = await reader.read();
      
      if (done) {
        break;
      }
      
      // バッファに追加
      buffer += decoder.decode(value, { stream: true });
      
      // 行ごとに処理
      const lines = buffer.split('\n');
      buffer = lines.pop(); // 最後の不完全な行をバッファに戻す
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const jsonStr = line.substring(6); // 'data: ' を除去
            const data = JSON.parse(jsonStr);
            
            // イベントタイプごとに処理
            switch(data.type) {
              case 'start':
                totalFiles = data.total_files;
                totalWorkers = data.total_workers || 1;
                updateLoadingMessage(`ファイルをベクトル化中... (0/${totalFiles})\n並列ワーカー: ${totalWorkers}`, 0, jobId);
                break;
                
              case 'file_queued':
                // ファイルが待機中になった
                updateLoadingMessage(`ファイル待機中: ${data.file_name}\nステータス: ⏳ ${data.status}`, 0, jobId);
                break;
                
              case 'file_processing':
                // ファイルが処理中になった
                currentFileIndex = data.file_index;
                const processingProgress = (currentFileIndex - 1) / totalFiles;
                updateLoadingMessage(`ファイル ${data.file_index}/${totalFiles}\n${data.file_name}\nステータス: 🔄 ${data.status}`, processingProgress, jobId);
                break;
                
              case 'file_start':
                currentFileIndex = data.file_index;
                totalFiles = data.total_files;
                totalPages = 0;
                currentPageIndex = 0;
                const fileProgress = (currentFileIndex - 1) / totalFiles;
                updateLoadingMessage(`ファイル ${currentFileIndex}/${totalFiles} を処理中...\n${data.file_name}`, fileProgress, jobId);
                break;
                
              case 'save_file_info':
                const saveProgress = (currentFileIndex - 1) / totalFiles;
                updateLoadingMessage(`ファイル ${currentFileIndex}/${totalFiles}\nファイル情報を保存中...`, saveProgress, jobId);
                break;
                
              case 'delete_existing':
                const deleteProgress = (currentFileIndex - 1) / totalFiles;
                updateLoadingMessage(`ファイル ${currentFileIndex}/${totalFiles}\n既存embeddingを削除中...`, deleteProgress, jobId);
                break;
                
              case 'auto_convert_start':
                const convertProgress = (currentFileIndex - 1) / totalFiles;
                updateLoadingMessage(`ファイル ${currentFileIndex}/${totalFiles}\n画像化を開始...`, convertProgress, jobId);
                break;
                
              case 'auto_convert_complete':
                const convertCompleteProgress = (currentFileIndex - 1) / totalFiles;
                updateLoadingMessage(`ファイル ${currentFileIndex}/${totalFiles}\n画像化完了: ${data.image_count}ページ`, convertCompleteProgress, jobId);
                break;
                
              case 'vectorize_start':
                totalPages = data.total_pages;
                const vectorizeProgress = (currentFileIndex - 1) / totalFiles;
                updateLoadingMessage(`ファイル ${currentFileIndex}/${totalFiles}\nベクトル化開始: ${totalPages}ページ`, vectorizeProgress, jobId);
                break;
                
              case 'page_progress':
                currentPageIndex = data.page_index;
                totalPages = data.total_pages;
                // file_indexを使用して正確な進捗率を計算
                const pageProgress = (data.file_index - 1 + currentPageIndex / totalPages) / totalFiles;
                updateLoadingMessage(`ファイル ${data.file_index}/${totalFiles}\nページ ${currentPageIndex}/${totalPages} をベクトル化中...`, pageProgress, jobId);
                break;
                
              case 'file_complete':
                const completedFileProgress = currentFileIndex / totalFiles;
                updateLoadingMessage(`ファイル ${data.file_index}/${totalFiles} ✓ 完了\n${data.file_name}\n${data.embedding_count}ページをベクトル化しました`, completedFileProgress, jobId);
                break;
                
              case 'file_error':
                console.error(`ファイル ${data.file_index}/${totalFiles} エラー: ${data.error}`);
                const errorProgress = currentFileIndex > 0 ? (currentFileIndex - 1) / totalFiles : 0;
                updateLoadingMessage(`ファイル ${data.file_index}/${totalFiles} ✗ エラー\n${data.file_name}\n${data.error}`, errorProgress, jobId);
                break;
                
              case 'cancelled':
                utilsHideLoading();
                ociObjectsBatchDeleteLoading = false;
                utilsShowToast(`処理がキャンセルされました\n${data.message}`, 'info');
                selectedOciObjects = [];
                await loadOciObjects();
                break;
                
              case 'error':
                utilsHideLoading();
                ociObjectsBatchDeleteLoading = false;
                utilsShowToast(`エラー: ${data.message}`, 'error');
                break;
                
              case 'complete':
                results = data.results;
                utilsHideLoading();
                ociObjectsBatchDeleteLoading = false;
                
                // 結果表示（経過時間を含む）
                const elapsedTime = data.elapsed_time ? ` (${data.elapsed_time.toFixed(1)}秒)` : '';
                if (data.success) {
                  utilsShowToast(`${data.message}${elapsedTime}`, 'success');
                } else {
                  utilsShowToast(`${data.message}${elapsedTime}\n成功: ${data.success_count}件、失敗: ${data.failed_count}件`, 'warning');
                }
                
                // 選択をクリアして一覧を更新
                selectedOciObjects = [];
                await loadOciObjects();
                break;
            }
          } catch (parseError) {
            console.error('JSONパースエラー:', parseError, '行:', line);
          }
        }
      }
    }
    
  } catch (error) {
    utilsHideLoading();
    ociObjectsBatchDeleteLoading = false;
    console.error('ベクトル化エラー:', error);
    utilsShowToast(`ベクトル化エラー: ${error.message}`, 'error');
    
    // 選択をクリアして一覧を更新
    selectedOciObjects = [];
    await loadOciObjects();
  }
};

/**
 * ローディングメッセージを更新（プログレスバー付き、キャンセルボタン対応）
 * @param {string} message - 表示するメッセージ
 * @param {number|null} progress - 進捗率 (0-1)
 * @param {string|null} jobId - ジョブID（キャンセル用）
 */
function updateLoadingMessage(message, progress = null, jobId = null) {
  const loadingOverlay = document.getElementById('loadingOverlay');
  if (loadingOverlay && loadingOverlay.style.display !== 'none') {
    const contentDiv = loadingOverlay.querySelector('.bg-white');
    if (contentDiv) {
      // プログレスバー付きUI
      let progressHtml = '';
      if (progress !== null) {
        // 進捗率を0-1の範囲に制限
        const clampedProgress = Math.max(0, Math.min(1, progress));
        const percentage = Math.round(clampedProgress * 100);
        progressHtml = `
          <div class="w-full mt-4">
            <div class="flex justify-between mb-1">
              <span class="text-sm font-medium text-gray-700">進捗状況</span>
              <span class="text-sm font-medium text-purple-600">${percentage}%</span>
            </div>
            <div class="w-full bg-gray-200 rounded-full h-2.5">
              <div class="bg-purple-600 h-2.5 rounded-full transition-all duration-300" style="width: ${percentage}%"></div>
            </div>
          </div>
        `;
      }
      
      // キャンセルボタン（jobIdがある場合のみ表示）
      let cancelButtonHtml = '';
      if (jobId) {
        cancelButtonHtml = `
          <div class="mt-4">
            <button 
              onclick="cancelCurrentJob('${jobId}')" 
              class="px-4 py-2 text-sm font-medium text-white bg-red-500 hover:bg-red-600 rounded-md transition-colors"
            >
              キャンセル
            </button>
          </div>
        `;
      }
      
      contentDiv.innerHTML = `
        <div class="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-500 mx-auto"></div>
        <p class="mt-4 text-gray-700">${message.replace(/\n/g, '<br>')}</p>
        ${progressHtml}
        ${cancelButtonHtml}
      `;
    }
  }
}

/**
 * 実行中のジョブをキャンセル
 * @param {string} jobId - キャンセルするジョブのID
 */
window.cancelCurrentJob = async function(jobId) {
  if (!jobId) {
    console.error('ジョブIDが指定されていません');
    return;
  }
  
  const confirmed = await utilsShowConfirmModal(
    'キャンセル確認',
    '実行中の処理をキャンセルしますか？\n\n進行中のファイルは処理が完了してから停止します。'
  );
  
  if (!confirmed) {
    return;
  }
  
  try {
    const token = localStorage.getItem('loginToken');
    const headers = {};
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    
    const response = await fetch(`/api/jobs/${jobId}/cancel`, {
      method: 'POST',
      headers: headers
    });
    
    if (response.ok) {
      utilsShowToast('キャンセルリクエストを送信しました', 'info');
    } else {
      const errorData = await response.json();
      utilsShowToast(`キャンセルに失敗しました: ${errorData.detail || 'エラー'}`, 'error');
    }
  } catch (error) {
    console.error('キャンセルエラー:', error);
    utilsShowToast(`キャンセルエラー: ${error.message}`, 'error');
  }
};

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
              <td>${utilsFormatFileSize(doc.file_size)}</td>
              <td>${utilsFormatDateTime(doc.uploaded_at)}</td>
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
  const confirmed = await utilsShowConfirmModal(
    `文書「${filename}」を削除してもよろしいですか?

※以下のデータも削除されます:
- データベース内のレコード（FILE_INFO, IMG_EMBEDDINGS）
- 生成された画像ファイル
- Object Storageのファイル

この操作は元に戻せません。`,
    '文書削除の確認'
  );
  
  if (!confirmed) {
    return;
  }
  
  try {
    utilsShowLoading('文書を削除中...');
    
    await authApiCall(`/api/documents/${documentId}`, {
      method: 'DELETE'
    });
    
    utilsHideLoading();
    utilsShowToast('文書を削除しました', 'success');
    
    await loadDocuments();
    
  } catch (error) {
    utilsHideLoading();
    utilsShowToast(`削除エラー: ${error.message}`, 'error');
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
    const data = await authApiCall('/api/oci/settings');
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
    utilsShowToast('必須項目をすべて入力してください', 'warning');
    return;
  }
  
  // 初回設定時はPrivate Keyが必須
  if (!ociSettings.key_content || ociSettings.key_content === '') {
    if (ociSettingsStatus !== 'configured' && ociSettingsStatus !== 'saved') {
      utilsShowToast('Private Keyが必要です', 'warning');
      return;
    }
  }
  
  ociLoading = true;
  ociAction = 'save';
  ociSaveResult = null;
  ociConnectionTestResult = null;
  
  try {
    utilsShowLoading('APIキーを保存中...');
    
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
    
    const result = await authApiCall('/api/oci/settings', {
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
    
    utilsHideLoading();
    utilsShowToast(result.message || '設定を保存しました', 'success');
    updateOciStatusBadge();
    
  } catch (error) {
    ociSaveResult = {
      success: false,
      message: '設定の保存に失敗しました'
    };
    utilsHideLoading();
    utilsShowToast('設定の保存に失敗しました', 'error');
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
    utilsShowToast('必須項目をすべて入力してください', 'warning');
    return;
  }
  
  // 初回設定時はPrivate Keyが必須
  if (!ociSettings.key_content || ociSettings.key_content === '') {
    if (ociSettingsStatus !== 'configured' && ociSettingsStatus !== 'saved') {
      utilsShowToast('Private Keyが必要です', 'warning');
      return;
    }
  }
  
  ociLoading = true;
  ociAction = 'test';
  ociConnectionTestResult = null;
  ociSaveResult = null;
  
  try {
    utilsShowLoading('OCI接続テスト実行中...');
    
    const result = await authApiCall('/api/oci/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: ociSettings })
    });
    
    ociConnectionTestResult = result;
    
    utilsHideLoading();
    
    if (result.success) {
      utilsShowToast('OCI接続テストに成功しました', 'success');
    } else {
      utilsShowToast('OCI接続テストに失敗しました', 'error');
    }
    
  } catch (error) {
    utilsHideLoading();
    utilsShowToast('接続テスト中にエラーが発生しました', 'error');
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
        utilsShowToast('無効なPEMファイル形式です: ファイルが空です', 'error');
        event.target.value = '';
        return;
      }
      
      if (!pemPattern.test(content)) {
        utilsShowToast('無効なPEMファイル形式です: 正しいPRIVATE KEYフォーマットが見つかりません', 'error');
        event.target.value = '';
        return;
      }
      
      ociSettings.key_content = content;
      utilsShowToast('Private Keyファイルを読み込みました', 'success');
      event.target.value = '';
      updatePrivateKeyStatus();
    };
    reader.onerror = function() {
      utilsShowToast('ファイルの読み込みに失敗しました', 'error');
      event.target.value = '';
    };
    reader.readAsText(file);
  } catch (error) {
    utilsShowToast('ファイル処理中にエラーが発生しました: ' + error.message, 'error');
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
    const data = await authApiCall('/api/settings/database');
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
    console.error('DB設定読み込みエラー:', error);
    utilsShowToast(`設定の読み込みエラー: ${error.message}`, 'error');
    throw error; // エラーを再スローしてswitchTabでキャッチさせる
  }
}

async function refreshDbConnectionFromEnv() {
  try {
    utilsShowLoading('接続設定を更新中...');
    
    // 環境変数から情報を取得
    const envData = await authApiCall('/api/settings/database/env');
    
    if (!envData.success) {
      utilsHideLoading();
      utilsShowToast(envData.message, 'error');
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
      // ダウンロードエラーがあれば表示
      if (envData.download_error) {
        walletStatus.innerHTML = '<span class="text-red-600">❌ Wallet自動ダウンロード失敗: ' + envData.download_error + '</span><br><span class="text-gray-600">手動でZIPファイルをアップロードしてください。</span>';
      } else {
        walletStatus.innerHTML = '<span class="text-yellow-600">⚠️ Walletが見つかりません。ZIPファイルをアップロードしてください。</span>';
      }
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
    
    utilsHideLoading();
    utilsShowToast('接続設定を更新しました', 'success');
    
  } catch (error) {
    utilsHideLoading();
    utilsShowToast(`接続設定更新エラー: ${error.message}`, 'error');
  }
}

// グローバルスコープに公開
window.refreshDbConnectionFromEnv = refreshDbConnectionFromEnv;

let selectedWalletFile = null;

function handleWalletFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  if (!file.name.toLowerCase().endsWith('.zip')) {
    utilsShowToast('ZIPファイルを選択してください', 'error');
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
    utilsShowLoading('Walletをアップロード中...');
    
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
    
    utilsHideLoading();
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'Walletアップロードに失敗しました');
    }
    
    const data = await response.json();
    
    if (data.success) {
      const walletStatus = document.getElementById('walletStatus');
      walletStatus.style.display = 'block';
      walletStatus.innerHTML = '<span class="text-green-600">✅ Walletアップロード成功</span>';
      
      utilsShowToast(data.message, 'success');
      
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
    utilsHideLoading();
    utilsShowToast(`Walletアップロードエラー: ${error.message}`, 'error');
    
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
    utilsShowToast('ユーザー名とパスワードを入力してください', 'warning');
    return;
  }
  
  if (!dsn) {
    utilsShowToast('サービス名/DSNを選択してください', 'warning');
    return;
  }
  
  const settings = {
    username: username,
    password: password,
    dsn: dsn
  };
  
  try {
    utilsShowLoading('DB設定を保存中...');
    
    await authApiCall('/api/settings/database', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });
    
    utilsHideLoading();
    utilsShowToast('DB設定を保存しました', 'success');
    
    await loadDbConnectionSettings();
    
  } catch (error) {
    utilsHideLoading();
    utilsShowToast(`保存エラー: ${error.message}`, 'error');
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
      utilsShowLoading('環境変数からパスワードを取得中...');
      try {
        const envData = await authApiCall('/api/settings/database/env?include_password=true');
        if (envData.success && envData.password && envData.password !== '[CONFIGURED]') {
          password = envData.password;
        }
        utilsHideLoading();
      } catch (error) {
        utilsHideLoading();
        // console.warn('環境変数からパスワード取得エラー:', error);
      }
    }
    
    // デバッグログ
    // デバッグ情報（本番環境ではコメントアウト）
    // console.log('=== 接続テスト情報 ===');
    // console.log('Username:', username);
    // console.log('Password length:', password ? password.length : 0);
    // console.log('DSN:', dsn);
    // console.log('Password exists:', !!password);
    // console.log('Password from env:', !passwordField.value && !!password);
    // console.log('=====================');
    
    // 入力チェック
    if (!username || !password || !dsn) {
      utilsShowToast('ユーザー名、パスワード、DSNを入力してください', 'warning');
      return;
    }
    
    utilsShowLoading('接続テスト中...');
    
    const requestBody = {
      settings: {
        username: username,
        password: password,
        dsn: dsn
      }
    };
    
    // console.log('Request body:', JSON.stringify({...requestBody, settings: {...requestBody.settings, password: '[HIDDEN]'}}));
    
    // タイムアウト処理を追加（90秒）
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('接続テストがタイムアウトしました（90秒）')), 90000)
    );
    
    const apiPromise = authApiCall('/api/settings/database/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });
    
    const data = await Promise.race([apiPromise, timeoutPromise]);
    
    utilsHideLoading();
    
    if (data.success) {
      utilsShowToast(data.message, 'success');
      
      // 接続成功時、DB情報を自動読み込み
      // await loadDbInfo();
    } else {
      utilsShowToast(data.message, 'error');
    }
    
  } catch (error) {
    utilsHideLoading();
    utilsShowToast(`接続テストエラー: ${error.message}`, 'error');
  }
}

async function loadDbInfo() {
  try {
    utilsShowLoading('データベース情報を取得中...');
    
    const data = await authApiCall('/api/database/info');
    
    utilsHideLoading();
    
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
    utilsHideLoading();
    utilsShowToast(`データベース情報取得エラー: ${error.message}`, 'error');
  }
}

async function loadDbTables() {
  try {
    utilsShowLoading('テーブル一覧を取得中...');
    
    // ページングパラメータ付きでAPIを呼び出し
    const data = await authApiCall(`/api/database/tables?page=${dbTablesPage}&page_size=${dbTablesPageSize}`);
    
    utilsHideLoading();
    
    // 総ページ数を保存
    dbTablesTotalPages = data.total_pages || 1;
    
    // '$'を含むテーブルをフィルタリング（バックエンドでも処理済みだが、念のため）
    const filteredTables = (data.tables || []).filter(t => !t.table_name.includes('$'));
    
    // 現在ページのテーブル一覧を保存（チェック用）
    currentPageDbTables = filteredTables.map(t => t.table_name);
    
    const tablesDiv = document.getElementById('dbTablesContent');
    const statusBadge = document.getElementById('dbTablesStatusBadge');
    
    if (!filteredTables || filteredTables.length === 0) {
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
                <th style="width: 100px;">操作</th>
              </tr>
            </thead>
            <tbody>
              ${filteredTables.map(table => {
                const isSelected = selectedTableForPreview === table.table_name;
                // テーブル名をJavaScript文字列としてエスケープ（シングルクォート対応）
                const escapedTableName = table.table_name.replace(/'/g, "\\'");
                return `
                <tr>
                  <td><input type="checkbox" onchange="toggleDbTableSelection('${escapedTableName}')" ${selectedDbTables.includes(table.table_name) ? 'checked' : ''} class="w-4 h-4 rounded" ${dbTablesBatchDeleteLoading ? 'disabled' : ''}></td>
                  <td style="font-weight: 500; font-family: monospace;">${table.table_name}</td>
                  <td>${table.num_rows !== null ? table.num_rows.toLocaleString() : '-'}</td>
                  <td>${table.created ? utilsFormatDateTime(table.created) : '-'}</td>
                  <td>${table.last_analyzed ? utilsFormatDateTime(table.last_analyzed) : '-'}</td>
                  <td style="max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                    ${table.comments || '-'}
                  </td>
                  <td>
                    <button 
                      onclick="toggleTablePreview('${escapedTableName}')" 
                      class="px-2 py-1 text-xs rounded ${isSelected ? 'bg-blue-500 text-white' : 'border border-blue-300 text-blue-600 hover:bg-blue-50'}" 
                      ${dbTablesBatchDeleteLoading ? 'disabled' : ''}>
                      ${isSelected ? '選択中' : '選択'}
                    </button>
                  </td>
                </tr>
              `}).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
    
  } catch (error) {
    utilsHideLoading();
    utilsShowToast(`テーブル一覧取得エラー: ${error.message}`, 'error');
  }
}

// テーブルプレビューのトグル
async function toggleTablePreview(tableName) {
  // スクロール位置を保存
  const scrollableArea = document.querySelector('#dbTablesContent .table-wrapper-scrollable');
  const scrollTop = scrollableArea ? scrollableArea.scrollTop : 0;
  
  if (selectedTableForPreview === tableName) {
    // 選択解除
    selectedTableForPreview = null;
    hideTablePreview();
    await loadDbTables();  // テーブル一覧を更新してボタン表示を切り替え
  } else {
    // 新しいテーブルを選択
    selectedTableForPreview = tableName;
    tableDataPage = 1;  // ページをリセット
    await loadDbTables();  // テーブル一覧を更新してボタン表示を切り替え
    await loadTableData(tableName);
  }
  
  // スクロール位置を復元
  const scrollableAreaAfter = document.querySelector('#dbTablesContent .table-wrapper-scrollable');
  if (scrollableAreaAfter) {
    requestAnimationFrame(() => {
      scrollableAreaAfter.scrollTop = scrollTop;
    });
  }
}

// テーブルデータを読み込む
async function loadTableData(tableName) {
  try {
    utilsShowLoading(`テーブル ${tableName} のデータを読み込み中...`);
    
    const data = await authApiCall(`/api/database/tables/${encodeURIComponent(tableName)}/data?page=${tableDataPage}&page_size=${tableDataPageSize}`);
    
    utilsHideLoading();
    
    if (!data.success) {
      // エラーメッセージを明確に表示
      utilsShowToast(data.message || 'データ取得に失敗しました', 'error');
      showTablePreview(tableName, [], [], 0, data);
      return;
    }
    
    if (!data.rows || data.rows.length === 0) {
      // データが空の場合
      showTablePreview(tableName, [], [], 0, data);
      return;
    }
    
    tableDataTotalPages = data.total_pages || 1;
    
    showTablePreview(tableName, data.columns, data.rows, data.total, data);
    
  } catch (error) {
    utilsHideLoading();
    utilsShowToast(`データ取得エラー: ${error.message}`, 'error');
    // エラー時もプレビューを非表示にする
    hideTablePreview();
    selectedTableForPreview = null;
    await loadDbTables();
  }
}

// HTMLエスケープ関数
function escapeHtml(text) {
  if (text === null || text === undefined) return '-';
  
  let str = String(text);
  
  // BLOB/LOBデータの判定：配列形式、BLOBタグ、LOBタグ、または500文字以上の長いデータ
  const isBlobLike = str.startsWith('array([') || 
                     str.startsWith('array("[') ||
                     str.startsWith('<BLOB:') || 
                     str.startsWith('<LOB:') ||
                     str.length > 500;
  
  if (isBlobLike) {
    // BLOB/LOB類データは100文字に制限
    if (str.length > 100) {
      str = str.substring(0, 100) + '...';
    }
  }
  
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// テーブルプレビューを表示
function showTablePreview(tableName, columns, rows, total, paginationData) {
  let previewDiv = document.getElementById('tableDataPreview');
  
  if (!previewDiv) {
    console.error('tableDataPreview element not found');
    return;
  }
  
  // プレビューDivを表示
  previewDiv.style.display = 'block';
  
  if (rows.length === 0) {
    previewDiv.innerHTML = `
      <div class="apex-region-header">
        📋 ${escapeHtml(tableName)} - データプレビュー
        <div style="display: flex; align-items: center; gap: 8px;">
          <button class="apex-button-secondary apex-button-xs" onclick="refreshTableData()">
            🔄 更新
          </button>
          <span class="px-2 py-1 text-xs font-semibold rounded-md" style="background: #e2e8f0; color: #64748b;">
            0件
          </span>
        </div>
      </div>
      <div style="padding: 24px;">
        <div style="text-align: center; padding: 40px; color: #64748b;">
          <div style="font-size: 48px; margin-bottom: 16px;">📋</div>
          <div style="font-size: 16px; font-weight: 500;">データがありません</div>
          <div style="font-size: 14px; margin-top: 8px;">テーブル ${escapeHtml(tableName)} にデータがありません</div>
        </div>
      </div>
    `;
    return;
  }
  
  // paginationDataのnullチェックとデフォルト値設定
  const safePageData = paginationData || {
    current_page: 1,
    total_pages: 1,
    total: total,
    start_row: 1,
    end_row: rows.length
  };
  
  // 現在ページの行を一意に識別する（最初の列を識別子として使用）
  // ※ どのテーブルでも対応できるよう、特定の列名に依存しない汎用的な処理
  currentPageTableDataRows = rows.map((row, index) => {
    if (columns.length > 0 && row.length > 0) {
      // 最初の列の値を識別子として使用（通常は主キー）
      const primaryValue = row[0];
      // ページ番号とインデックスを組み合わせてグローバルに一意にする
      return `${safePageData.current_page}_${index}_${primaryValue}`;
    } else {
      // データがない場合は行インデックスのみ使用
      return `${safePageData.current_page}_${index}`;
    }
  });
  
  // ヘッダーチェックボックスの状態を判定
  const allPageSelected = currentPageTableDataRows.length > 0 && 
                          currentPageTableDataRows.every(i => selectedTableDataRows.includes(i));
  
  // 選択操作ボタンHTML（テーブル一覧と同じスタイル）
  const selectionButtonsHtml = `
    <div class="flex items-center justify-between mb-3">
      <div class="flex gap-2">
        <button onclick="selectAllTableData()" class="px-2 py-1 border rounded text-xs hover:bg-gray-100">すべて選択</button>
        <button onclick="clearAllTableData()" class="px-2 py-1 border rounded text-xs hover:bg-gray-100">すべて解除</button>
        <button onclick="deleteSelectedTableData()" class="px-2 py-1 text-xs rounded border border-red-300 text-red-600 hover:bg-red-50 ${selectedTableDataRows.length === 0 ? 'opacity-40 cursor-not-allowed' : ''}" ${selectedTableDataRows.length === 0 ? 'disabled' : ''}>
          削除 (${selectedTableDataRows.length})
        </button>
      </div>
    </div>
  `;
  
  // ページネーションUI生成
  const paginationHtml = UIComponents.renderPagination({
    currentPage: safePageData.current_page,
    totalPages: safePageData.total_pages,
    totalItems: safePageData.total,
    startNum: safePageData.start_row,
    endNum: safePageData.end_row,
    onPrevClick: 'handleTableDataPrevPage()',
    onNextClick: 'handleTableDataNextPage()',
    onJumpClick: 'handleTableDataJumpPage',
    inputId: 'tableDataPageInput'
  });
  
  previewDiv.innerHTML = `
    <div class="apex-region-header">
      📋 ${escapeHtml(tableName)} - データプレビュー
      <div style="display: flex; align-items: center; gap: 8px;">
        <button class="apex-button-secondary apex-button-xs" onclick="refreshTableData()">
          🔄 更新
        </button>
        <span class="px-2 py-1 text-xs font-semibold rounded-md" style="background: #dcfce7; color: #166534;">
          ${total}件
        </span>
      </div>
    </div>
    <div style="padding: 24px;">
      ${selectionButtonsHtml}
      ${paginationHtml}
      <div class="table-wrapper-scrollable">
        <table class="data-table">
          <thead>
            <tr>
              <th style="width: 40px;"><input type="checkbox" id="tableDataHeaderCheckbox" onchange="toggleSelectAllTableData(this.checked)" ${allPageSelected ? 'checked' : ''} class="w-4 h-4 rounded"></th>
              ${columns.map(col => `<th>${escapeHtml(col)}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${rows.map((row, index) => {
              // 行を一意に識別する（currentPageTableDataRowsと同じロジック）
              let rowId;
              if (columns.length > 0 && row.length > 0) {
                const primaryValue = row[0];
                rowId = `${safePageData.current_page}_${index}_${primaryValue}`;
              } else {
                rowId = `${safePageData.current_page}_${index}`;
              }
              const isChecked = selectedTableDataRows.includes(rowId);
              // HTMLエスケープしたrowIdを使用
              const escapedRowId = rowId.replace(/'/g, "&#39;").replace(/"/g, "&quot;");
              return `
              <tr>
                <td><input type="checkbox" onchange="toggleTableDataRowSelection('${escapedRowId}')" ${isChecked ? 'checked' : ''} class="w-4 h-4 rounded"></td>
                ${row.map(cell => `<td>${escapeHtml(cell)}</td>`).join('')}
              </tr>
            `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// テーブルプレビューを非表示
function hideTablePreview() {
  const previewDiv = document.getElementById('tableDataPreview');
  if (previewDiv) {
    previewDiv.style.display = 'none';
    previewDiv.innerHTML = '';  // 内容もクリア
  }
  // 選択状態をクリア
  selectedTableDataRows = [];
  currentPageTableDataRows = [];
}

// テーブルデータを更新
async function refreshTableData() {
  if (selectedTableForPreview) {
    tableDataPage = 1;
    await loadTableData(selectedTableForPreview);
  }
}

// テーブルデータページング - 前のページへ
function handleTableDataPrevPage() {
  if (tableDataPage > 1 && selectedTableForPreview) {
    tableDataPage--;
    loadTableData(selectedTableForPreview);
  }
}

// テーブルデータページング - 次のページへ
function handleTableDataNextPage() {
  if (tableDataPage < tableDataTotalPages && selectedTableForPreview) {
    tableDataPage++;
    loadTableData(selectedTableForPreview);
  }
}

// テーブルデータページング - ページジャンプ
function handleTableDataJumpPage() {
  const input = document.getElementById('tableDataPageInput');
  if (!input) {
    utilsShowToast('ページ入力エラー', 'error');
    return;
  }
  
  const page = parseInt(input.value, 10);
  
  // NaNチェックを追加
  if (isNaN(page)) {
    utilsShowToast('有効な数値を入力してください', 'error');
    input.value = tableDataPage;
    return;
  }
  
  if (page >= 1 && page <= tableDataTotalPages && selectedTableForPreview) {
    tableDataPage = page;
    loadTableData(selectedTableForPreview);
  } else {
    utilsShowToast('無効なページ番号です', 'error');
    input.value = tableDataPage;
  }
}

// プレースホルダー関数（将来の機能拡張用）
function selectAllTableData() {
  toggleSelectAllTableData(true);
  // ヘッダーチェックボックスを更新
  const headerCheckbox = document.getElementById('tableDataHeaderCheckbox');
  if (headerCheckbox) headerCheckbox.checked = true;
}

function clearAllTableData() {
  selectedTableDataRows = [];
  // ヘッダーチェックボックスを更新
  const headerCheckbox = document.getElementById('tableDataHeaderCheckbox');
  if (headerCheckbox) headerCheckbox.checked = false;
  
  // UIを更新
  if (selectedTableForPreview) {
    loadTableData(selectedTableForPreview);
  }
}

function deleteSelectedTableData() {
  if (selectedTableDataRows.length === 0) {
    utilsShowToast('削除するデータを選択してください', 'warning');
    return;
  }
  
  const count = selectedTableDataRows.length;
  
  // 確認モーダルを表示
  window.UIComponents.showModal({
    title: 'レコード削除の確認',
    content: `選択された${count}件のレコードを削除しますか？\n\n※テーブル「${selectedTableForPreview}」から直接削除されます。\n※この操作は元に戻せません。`,
    confirmText: '削除',
    cancelText: 'キャンセル',
    variant: 'danger',
    onConfirm: async () => {
      try {
        utilsShowLoading('レコードを削除中...');
        
        // 選択された行の主キー値を抽出（rowIdから最後の部分を取得）
        const primaryKeyValues = selectedTableDataRows.map(rowId => {
          // rowId形式: "page_index_primaryValue"
          const parts = rowId.split('_');
          return parts.length >= 3 ? parts.slice(2).join('_') : parts[parts.length - 1];
        });
        
        // 汎用的な削除APIを呼び出す
        const response = await authApiCall(`/api/database/tables/${encodeURIComponent(selectedTableForPreview)}/delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ primary_keys: primaryKeyValues })
        });
        
        utilsHideLoading();
        
        if (response.success) {
          utilsShowToast(`${response.deleted_count}件のレコードを削除しました`, 'success');
          // 選択をクリア
          selectedTableDataRows = [];
          // ページを1にリセット
          tableDataPage = 1;
          // テーブルデータを再読み込み
          loadTableData(selectedTableForPreview);
        } else {
          const errMsg = response.errors && response.errors.length > 0 
            ? response.errors.join(', ') 
            : response.message || '不明なエラー';
          utilsShowToast(`削除エラー: ${errMsg}`, 'error');
        }
      } catch (error) {
        utilsHideLoading();
        utilsShowToast(`削除エラー: ${error.message}`, 'error');
      }
    }
  });
}

// テーブルデータ - 個別チェックボックス切り替え
function toggleTableDataRowSelection(rowId) {
  // HTMLエスケープされた値をデコード
  const decodedRowId = rowId.replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  
  // スクロール位置を保存
  const scrollableArea = document.querySelector('#tableDataPreview .table-wrapper-scrollable');
  const scrollTop = scrollableArea ? scrollableArea.scrollTop : 0;
  
  // 文字列に統一
  const rowIdStr = String(decodedRowId);
  const index = selectedTableDataRows.indexOf(rowIdStr);
  if (index > -1) {
    selectedTableDataRows.splice(index, 1);
  } else {
    selectedTableDataRows.push(rowIdStr);
  }
  
  // UIを更新
  if (selectedTableForPreview) {
    loadTableData(selectedTableForPreview).then(() => {
      // スクロール位置を復元
      const scrollableAreaAfter = document.querySelector('#tableDataPreview .table-wrapper-scrollable');
      if (scrollableAreaAfter) {
        requestAnimationFrame(() => {
          scrollableAreaAfter.scrollTop = scrollTop;
        });
      }
    });
  }
}

// テーブルデータ - ヘッダーチェックボックス切り替え（現在ページ全選択/解除）
function toggleSelectAllTableData(checked) {
  // スクロール位置を保存
  const scrollableArea = document.querySelector('#tableDataPreview .table-wrapper-scrollable');
  const scrollTop = scrollableArea ? scrollableArea.scrollTop : 0;
  
  if (checked) {
    // 現在ページのすべてを選択に追加
    currentPageTableDataRows.forEach(rowId => {
      if (!selectedTableDataRows.includes(rowId)) {
        selectedTableDataRows.push(rowId);
      }
    });
  } else {
    // 現在ページのすべてを選択から除外
    currentPageTableDataRows.forEach(rowId => {
      const index = selectedTableDataRows.indexOf(rowId);
      if (index > -1) {
        selectedTableDataRows.splice(index, 1);
      }
    });
  }
  
  // UIを更新
  if (selectedTableForPreview) {
    loadTableData(selectedTableForPreview).then(() => {
      // スクロール位置を復元
      const scrollableAreaAfter = document.querySelector('#tableDataPreview .table-wrapper-scrollable');
      if (scrollableAreaAfter) {
        requestAnimationFrame(() => {
          scrollableAreaAfter.scrollTop = scrollTop;
        });
      }
    });
  }
}

// グローバルスコープに公開（HTMLインラインイベントハンドラから呼び出せるように）
window.toggleTableDataRowSelection = toggleTableDataRowSelection;
window.toggleSelectAllTableData = toggleSelectAllTableData;
window.selectAllTableData = selectAllTableData;
window.clearAllTableData = clearAllTableData;
window.deleteSelectedTableData = deleteSelectedTableData;
window.refreshTableData = refreshTableData;
window.handleTableDataPrevPage = handleTableDataPrevPage;
window.handleTableDataNextPage = handleTableDataNextPage;
window.handleTableDataJumpPage = handleTableDataJumpPage;

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
  if (!input) {
    utilsShowToast('ページ入力エラー', 'error');
    return;
  }
  
  const page = parseInt(input.value, 10);
  
  // NaNチェックを追加
  if (isNaN(page)) {
    utilsShowToast('有効な数値を入力してください', 'error');
    input.value = dbTablesPage;
    return;
  }
  
  if (page >= 1 && page <= dbTablesTotalPages) {
    dbTablesPage = page;
    loadDbTables();
  } else {
    utilsShowToast('無効なページ番号です', 'error');
    input.value = dbTablesPage;
  }
}

// テーブル一覧 - 個別チェックボックス切り替え
function toggleDbTableSelection(tableName) {
  // スクロール位置を保存
  const scrollableArea = document.querySelector('#dbTablesContent .table-wrapper-scrollable');
  const scrollTop = scrollableArea ? scrollableArea.scrollTop : 0;
  
  const index = selectedDbTables.indexOf(tableName);
  if (index > -1) {
    selectedDbTables.splice(index, 1);
  } else {
    selectedDbTables.push(tableName);
  }
  
  // UIを更新
  loadDbTables().then(() => {
    // スクロール位置を復元
    const scrollableAreaAfter = document.querySelector('#dbTablesContent .table-wrapper-scrollable');
    if (scrollableAreaAfter) {
      requestAnimationFrame(() => {
        scrollableAreaAfter.scrollTop = scrollTop;
      });
    }
  });
}

// テーブル一覧 - ヘッダーチェックボックス切り替え（現在ページ全選択/解除）
function toggleSelectAllDbTables(checked) {
  // スクロール位置を保存
  const scrollableArea = document.querySelector('#dbTablesContent .table-wrapper-scrollable');
  const scrollTop = scrollableArea ? scrollableArea.scrollTop : 0;
  
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
  loadDbTables().then(() => {
    // スクロール位置を復元
    const scrollableAreaAfter = document.querySelector('#dbTablesContent .table-wrapper-scrollable');
    if (scrollableAreaAfter) {
      requestAnimationFrame(() => {
        scrollableAreaAfter.scrollTop = scrollTop;
      });
    }
  });
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
  // スクロール位置を保存
  const scrollableArea = document.querySelector('#dbTablesContent .table-wrapper-scrollable');
  const scrollTop = scrollableArea ? scrollableArea.scrollTop : 0;
  
  selectedDbTables = [];
  // ヘッダーチェックボックスを更新
  const headerCheckbox = document.getElementById('dbTablesHeaderCheckbox');
  if (headerCheckbox) headerCheckbox.checked = false;
  
  // UIを更新
  loadDbTables().then(() => {
    // スクロール位置を復元
    const scrollableAreaAfter = document.querySelector('#dbTablesContent .table-wrapper-scrollable');
    if (scrollableAreaAfter) {
      requestAnimationFrame(() => {
        scrollableAreaAfter.scrollTop = scrollTop;
      });
    }
  });
}

// テーブル一覧 - 選択されたテーブルを削除
async function deleteSelectedDbTables() {
  if (selectedDbTables.length === 0) {
    utilsShowToast('削除するテーブルを選択してください', 'warning');
    return;
  }
  
  const count = selectedDbTables.length;
  const confirmed = await showConfirmModal(
    `選択された${count}件のテーブルを削除しますか？\n\nこの操作は元に戻せません。`,
    'テーブル削除の確認'
  );
  
  if (!confirmed) {
    return;
  }
  
  // 処理中表示を設定
  dbTablesBatchDeleteLoading = true;
  loadDbTables();
  
  try {
    // 一括削除APIを呼び出す
    const response = await authApiCall('/api/database/tables/batch-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table_names: selectedDbTables })
    });
    
    if (response.success) {
      utilsShowToast(`${count}件のテーブルを削除しました`, 'success');
      // 選択をクリア
      selectedDbTables = [];
      // ページを1にリセット
      dbTablesPage = 1;
    } else {
      utilsShowToast(`削除エラー: ${response.message || '不明なエラー'}`, 'error');
    }
  } catch (error) {
    utilsShowToast(`削除エラー: ${error.message}`, 'error');
  } finally {
    // 処理中表示を解除
    dbTablesBatchDeleteLoading = false;
    // テーブル一覧を再読み込み
    loadDbTables();
  }
}

// データベース情報更新ボタン
async function refreshDbInfo() {
  try {
    utilsShowLoading('データベース情報を更新中...');
    await loadDbInfo();
    utilsHideLoading();
  } catch (error) {
    utilsHideLoading();
    utilsShowToast(`更新エラー: ${error.message}`, 'error');
  }
}

// テーブル一覧更新ボタン
async function refreshDbTables() {
  try {
    utilsShowLoading('統計情報を更新中...');
    
    // 先に統計情報を更新
    const statsResult = await authApiCall('/api/database/tables/refresh-statistics', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    if (!statsResult.success) {
      utilsShowToast(`統計情報更新エラー: ${statsResult.message}`, 'error');
    } else {
      utilsShowToast(statsResult.message, 'success');
    }
    
    // ページを1にリセット
    dbTablesPage = 1;
    
    // テーブル一覧を再読み込み
    utilsShowLoading('テーブル一覧を更新中...');
    await loadDbTables();
    utilsHideLoading();
  } catch (error) {
    utilsHideLoading();
    utilsShowToast(`更新エラー: ${error.message}`, 'error');
  }
}

// ストレージ情報を読み込み
async function loadDbStorage() {
  try {
    utilsShowLoading('ストレージ情報を取得中...');
    
    const data = await authApiCall('/api/database/storage');
    
    utilsHideLoading();
    
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
    utilsHideLoading();
    utilsShowToast(`ストレージ情報取得エラー: ${error.message}`, 'error');
  }
}

// ストレージ情報更新ボタン
async function refreshDbStorage() {
  try {
    utilsShowLoading('ストレージ情報を更新中...');
    await loadDbStorage();
    utilsHideLoading();
  } catch (error) {
    utilsHideLoading();
    utilsShowToast(`更新エラー: ${error.message}`, 'error');
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
      
      // appStateにも設定（oci.js等のモジュールから参照されるため）
      appState.set('debugMode', config.debug);
      appState.set('requireLogin', config.require_login);
      appState.set('apiBase', API_BASE);
      
      // console.log('設定を読み込みました:', config);
    }
  } catch (error) {
    // console.warn('設定の読み込みに失敗しました:', error);
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
 * 強制ログアウト処理（401エラー時に呼び出し）
 * referenceプロジェクトの実装に準拠
 */
function forceLogout() {
  // セッションを完全にクリア
  setAuthState(false, null, null);
  
  // 後方互換性のためグローバル変数もクリア
  isLoggedIn = false;
  loginToken = null;
  loginUser = null;
  
  localStorage.removeItem('loginToken');
  localStorage.removeItem('loginUser');
  
  // ログイン画面を表示してユーザーに通知
  setTimeout(() => {
    utilsShowToast('ログインの有効期限が切れました。再度ログインしてください。', 'error');
    showLoginModal();
  }, 0);
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
      // ログイン成功 - appStateに保存
      setAuthState(true, data.token, data.username);
      
      // 後方互換性のためグローバル変数も更新（TODO: 削除予定）
      isLoggedIn = true;
      loginToken = data.token;
      loginUser = data.username;
      
      // ローカルストレージに保存
      localStorage.setItem('loginToken', data.token);
      localStorage.setItem('loginUser', data.username);
      
      hideLoginModal();
      utilsShowToast('ログインしました', 'success');
      
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
    // console.warn('ログアウトエラー:', error);
  } finally {
    // ローカル状態をクリア - appStateと同期
    setAuthState(false, null, null);
    
    // 後方互換性のためグローバル変数も更新（TODO: 削除予定）
    isLoggedIn = false;
    loginToken = null;
    loginUser = null;
    
    localStorage.removeItem('loginToken');
    localStorage.removeItem('loginUser');
    
    utilsShowToast('ログアウトしました');
    
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
  
  // appStateから取得
  const authState = getAuthState();
  
  if (authState.isLoggedIn && authState.loginUser) {
    userName.textContent = `${authState.loginUser}`;
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
    // appStateに保存
    setAuthState(true, token, user);
    
    // 後方互換性のためグローバル変数も更新（TODO: 削除予定）
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
  // console.log('資料みつかるくん - 初期化開始');
  
  // 設定を読み込む
  await loadConfig();
  
  // ログイン状態を確認
  await checkLoginStatus();
  
  // console.log('資料みつかるくん - 初期化完了');
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
/**
 * ADB OCIDのみを読み込む（軽量版、Display NameやLifecycle Stateは取得しない）
 */
async function loadAdbOcidOnly() {
  try {
    const data = await authApiCall('/api/database/target/ocid', {
      method: 'GET'
    });
    
    if (data.success && data.ocid) {
      // OCIDのみを表示
      document.getElementById('adbOcid').textContent = data.ocid;
      console.log('ADB OCIDを読み込みました:', data.ocid);
    } else {
      document.getElementById('adbOcid').textContent = '-';
    }
  } catch (error) {
    console.error('ADB OCID読み込みエラー:', error);
    document.getElementById('adbOcid').textContent = '-';
  }
}

/**
 * DB接続情報を.envから読み込む（軽量版）
 */
async function loadDbConnectionInfoFromEnv() {
  try {
    const data = await authApiCall('/api/database/connection-info', {
      method: 'GET'
    });
    
    if (data.success) {
      // ユーザー名、パスワード、DSNをフォームに設定
      const userInput = document.getElementById('dbUser');
      const passwordInput = document.getElementById('dbPassword');
      const dsnSelect = document.getElementById('dbDsn');
      
      if (userInput) userInput.value = data.username || '';
      if (passwordInput) passwordInput.value = data.password || '';
      
      // DSNをセレクトボックスに追加
      if (dsnSelect && data.dsn) {
        // 既存のオプションをクリア
        dsnSelect.innerHTML = '<option value="">選択してください</option>';
        // DSNを追加して選択
        const option = document.createElement('option');
        option.value = data.dsn;
        option.textContent = data.dsn;
        option.selected = true;
        dsnSelect.appendChild(option);
        // DSN表示エリアを表示
        document.getElementById('dsnDisplay').style.display = 'block';
      }
      
      console.log('.envからDB接続情報を読み込みました');
    } else {
      console.warn('DB接続情報の取得失敗:', data.message);
    }
  } catch (error) {
    console.error('DB接続情報読み込みエラー:', error);
  }
}

/**
 * ADB情報を取得（フル情報）
 */
async function getAdbInfo() {
  try {
    utilsShowLoading('ADB情報を取得中...');
    
    // バックエンドのADB_OCIDを使用するため、
    // 環境変数から読み取る（参考コードと同じパターン）
    const data = await authApiCall('/api/database/target', {
      method: 'GET'
    });
    
    utilsHideLoading();
    
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
    
    // 操作結果は表示しない（ユーザー要望により削除）
    // showAdbOperationResult([...]);
    
    utilsShowToast('ADB情報を取得しました', 'success');
    
  } catch (error) {
    utilsHideLoading();
    utilsShowToast(`ADB情報取得エラー: ${error.message}`, 'error');
  }
}

/**
 * ADBを起動
 */
async function startAdb() {
  if (!currentAdbInfo.id) {
    utilsShowToast('まずADB情報を取得してください', 'warning');
    return;
  }
  
  try {
    utilsShowLoading('ADBを起動中...');
    
    const data = await authApiCall('/api/database/target/start', {
      method: 'POST'
    });
    
    utilsHideLoading();
    
    if (data.status === 'accepted' || data.status === 'noop') {
      utilsShowToast(data.message, 'success');
      // 操作結果は表示しない（ユーザー要望により削除）
      // showAdbOperationResult([...]);
      
      // 少し待ってから情報を再取得
      setTimeout(() => {
        getAdbInfo();
      }, 3000);
    } else {
      utilsShowToast(`エラー: ${data.message}`, 'error');
      // 操作結果は表示しない（ユーザー要望により削除）
      // showAdbOperationResult([...]);
    }
    
  } catch (error) {
    utilsHideLoading();
    utilsShowToast(`ADB起動エラー: ${error.message}`, 'error');
  }
}

/**
 * ADBを停止
 */
async function stopAdb() {
  if (!currentAdbInfo.id) {
    utilsShowToast('まずADB情報を取得してください', 'warning');
    return;
  }
  
  try {
    utilsShowLoading('ADBを停止中...');
    
    const data = await authApiCall('/api/database/target/stop', {
      method: 'POST'
    });
    
    utilsHideLoading();
    
    if (data.status === 'accepted' || data.status === 'noop') {
      utilsShowToast(data.message, 'success');
      // 操作結果は表示しない（ユーザー要望により削除）
      // showAdbOperationResult([...]);
      
      // 少し待ってから情報を再取得
      setTimeout(() => {
        getAdbInfo();
      }, 3000);
    } else {
      utilsShowToast(`エラー: ${data.message}`, 'error');
      // 操作結果は表示しない（ユーザー要望により削除）
      // showAdbOperationResult([...]);
    }
    
  } catch (error) {
    utilsHideLoading();
    utilsShowToast(`ADB停止エラー: ${error.message}`, 'error');
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

// ========================================
// グローバル関数公開（window経由） - 初期初期化部分
// ========================================
// 注: 以下はページ初期化時に必要な関数公開（最終的な公開はファイル末尾で行います）

// ドキュメント管理
window.loadDocuments = loadDocuments;

// 秘密鍵関連
window.handlePrivateKeyFileSelect = handlePrivateKeyFileSelect;
window.clearPrivateKey = clearPrivateKey;

// データベース接続関連
window.loadDbConnectionSettings = loadDbConnectionSettings;
window.saveDbConnection = saveDbConnection;
window.testDbConnection = testDbConnection;
window.loadDbInfo = loadDbInfo;
window.loadDbTables = loadDbTables;

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
    utilsShowToast('AI Assistantの応答に失敗しました', 'error');
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
  utilsShowToast('会話履歴をクリアしました', 'success');
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
      utilsShowToast('新しい会話を開始しました', 'success');
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
    utilsShowToast(`画像は最大${MAX_IMAGES}枚までアップロードできます`, 'warning');
    return;
  }
  
  // 追加可能な枚数を計算
  const remainingSlots = MAX_IMAGES - copilotImages.length;
  const filesToAdd = Array.from(files).filter(f => f.type.startsWith('image/')).slice(0, remainingSlots);
  
  if (filesToAdd.length < files.length) {
    utilsShowToast(`画像は最大${MAX_IMAGES}枚までです。${filesToAdd.length}枚を追加します`, 'warning');
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
    utilsShowToast(`画像は最大${MAX_IMAGES}枚までアップロードできます`, 'warning');
    return;
  }
  
  // 追加可能な枚数を計算
  const remainingSlots = MAX_IMAGES - copilotImages.length;
  const itemsToAdd = imageItems.slice(0, remainingSlots);
  
  if (itemsToAdd.length < imageItems.length) {
    utilsShowToast(`画像は最大${MAX_IMAGES}枚までです。${itemsToAdd.length}枚を追加します`, 'warning');
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

// ========================================
// グローバル関数公開（window経由） - AI Assistant関連
// ========================================

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
window.openCopilotImage = openCopilotImage;

// 検索関連（削除済み - window.searchModuleを使用）
// 注: showSearchImageModal, downloadFileはsearch.jsモジュールに移行済み
// 下位互換性のため、ファイル末尾でwindow.searchModuleから再エクスポート

// モーダル（utils.jsからインポート済みの関数を再エクスポート）
window.showConfirmModal = utilsShowConfirmModal;
// 注: closeConfirmModalはutils.jsのshowConfirmModal内で内部的に処理されるため、外部公開不要

// AI Assistantテキストエリアにペーストイベントリスナーを追加
const copilotInput = document.getElementById('copilotInput');
if (copilotInput) {
  copilotInput.addEventListener('paste', handleCopilotPaste);
}

// ========================================
// グローバル関数公開（window経由） - データベース関連
// ========================================

// データベース関連関数をグローバルスコープに公開
window.refreshDbInfo = refreshDbInfo;
window.refreshDbTables = refreshDbTables;
window.refreshDbStorage = refreshDbStorage;
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

// テーブルプレビュー関連関数をグローバルスコープに公開
window.toggleTablePreview = toggleTablePreview;
window.loadTableData = loadTableData;
window.refreshTableData = refreshTableData;
window.handleTableDataPrevPage = handleTableDataPrevPage;
window.handleTableDataNextPage = handleTableDataNextPage;
window.handleTableDataJumpPage = handleTableDataJumpPage;
window.selectAllTableData = selectAllTableData;
window.clearAllTableData = clearAllTableData;
window.deleteSelectedTableData = deleteSelectedTableData;
window.escapeHtml = escapeHtml;

// ========================================
// 確認モーダル機能
// ========================================
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
 * Object Storage設定を更新（更新ボタン用）
 * .envからBucket NameとNamespaceを取得し、入力欄に反映
 */
async function refreshObjectStorageSettings() {
  try {
    utilsShowLoading('.envからObject Storage設定を取得中...');
    
    // OCI設定を取得
    const settingsData = await authApiCall('/api/oci/settings');
    
    // Bucket Nameを設定
    const bucketNameInput = document.getElementById('bucketName');
    const namespaceInput = document.getElementById('namespace');
    const namespaceStatus = document.getElementById('namespaceStatus');
    
    if (bucketNameInput && settingsData.settings.bucket_name) {
      bucketNameInput.value = settingsData.settings.bucket_name;
      utilsShowToast('Bucket Nameを更新しました', 'success');
    } else {
      utilsShowToast('Bucket Nameが.envに設定されていません', 'warning');
    }
    
    // Namespaceを取得（.env優先、空ならAPI）
    if (settingsData.settings.namespace) {
      // .envから取得できた場合
      namespaceInput.value = settingsData.settings.namespace;
      namespaceStatus.textContent = '環境変数から読み込み済み';
      namespaceStatus.className = 'text-xs text-green-600';
      utilsShowToast('Namespaceを更新しました', 'success');
    } else {
      // 空の場合、APIで取得を試みる
      namespaceStatus.textContent = 'Namespaceを取得中...';
      namespaceStatus.className = 'text-xs text-blue-600';
      
      try {
        const namespaceData = await authApiCall('/api/oci/namespace');
        if (namespaceData.success) {
          namespaceInput.value = namespaceData.namespace;
          namespaceStatus.textContent = `OCI APIから自動取得済み`;
          namespaceStatus.className = 'text-xs text-green-600';
          utilsShowToast('NamespaceをAPIから取得しました', 'success');
        } else {
          namespaceStatus.textContent = '⚠️ Namespaceの取得に失敗しました';
          namespaceStatus.className = 'text-xs text-red-600';
          utilsShowToast(namespaceData.message || 'Namespaceの取得に失敗しました', 'error');
        }
      } catch (namespaceError) {
        // console.error('Namespace取得エラー:', namespaceError);
        namespaceStatus.textContent = `⚠️ 取得エラー: ${namespaceError.message}`;
        namespaceStatus.className = 'text-xs text-red-600';
        utilsShowToast(`Namespace取得エラー: ${namespaceError.message}`, 'error');
      }
    }
    
    // ステータスバッジを更新
    updateObjectStorageStatusBadge(
      bucketNameInput?.value,
      namespaceInput?.value
    );
    
  } catch (error) {
    // console.error('Object Storage設定更新エラー:', error);
    utilsShowToast(`設定更新エラー: ${error.message}`, 'error');
  } finally {
    utilsHideLoading();
  }
}

/**
 * Object Storage設定を読み込む
 */
async function loadObjectStorageSettings() {
  try {
    // OCI設定を取得
    const settingsData = await authApiCall('/api/oci/settings');
    
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
        const namespaceData = await authApiCall('/api/oci/namespace');
        if (namespaceData.success) {
          namespaceInput.value = namespaceData.namespace;
          namespaceStatus.textContent = `OCI APIから自動取得済み`;
          namespaceStatus.className = 'text-xs text-green-600';
        } else {
          namespaceStatus.textContent = '⚠️ Namespaceの取得に失敗しました';
          namespaceStatus.className = 'text-xs text-red-600';
        }
      } catch (namespaceError) {
        // console.error('Namespace取得エラー:', namespaceError);
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
    // console.error('Object Storage設定読み込みエラー:', error);
    utilsShowToast('Object Storage設定の読み込みに失敗しました', 'error');
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
      utilsShowToast('Bucket Nameを入力してください', 'warning');
      return;
    }
    
    if (!namespace) {
      utilsShowToast('Namespaceが取得されていません', 'warning');
      return;
    }
    
    utilsShowLoading('Object Storage設定を保存中...');
    
    const response = await authApiCall('/api/oci/object-storage/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bucket_name: bucketName,
        namespace: namespace
      })
    });
    
    if (response.success) {
      utilsShowToast('Object Storage設定を保存しました', 'success');
      // ステータスバッジを更新
      updateObjectStorageStatusBadge(bucketName, namespace);
      // 設定を再読み込み
      await loadObjectStorageSettings();
    } else {
      utilsShowToast(response.message || '保存に失敗しました', 'error');
    }
    
  } catch (error) {
    // console.error('Object Storage設定保存エラー:', error);
    utilsShowToast(`保存エラー: ${error.message}`, 'error');
  } finally {
    utilsHideLoading();
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
      utilsShowToast('Bucket Nameを入力してください', 'warning');
      return;
    }
    
    if (!namespace) {
      utilsShowToast('Namespaceが取得されていません', 'warning');
      return;
    }
    
    utilsShowLoading('Object Storage接続テスト中...');
    
    const response = await authApiCall('/api/oci/object-storage/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bucket_name: bucketName,
        namespace: namespace
      })
    });
    
    if (response.success) {
      utilsShowToast(response.message || '接続テストに成功しました', 'success');
    } else {
      utilsShowToast(response.message || '接続テストに失敗しました', 'error');
    }
    
  } catch (error) {
    // console.error('Object Storage接続テストエラー:', error);
    utilsShowToast(`テストエラー: ${error.message}`, 'error');
  } finally {
    utilsHideLoading();
  }
}

// ========================================
// グローバル関数公開（window経由）
// ========================================
// 注: 以下の関数はHTMLから直接呼び出されるため、windowオブジェクトに公開しています。
// 新規機能はモジュール経由（window.searchModule, window.authModule等）を使用してください。

// タブ切り替え
window.switchTab = switchTab;

// ファイルアップロード関連
window.handleFileSelect = handleFileSelect;
window.uploadDocument = uploadDocument;
window.deleteDocument = deleteDocument;
window.handleMultipleFileSelect = handleMultipleFileSelect;
window.handleDropForMultipleInput = handleDropForMultipleInput;
window.uploadMultipleDocuments = uploadMultipleDocuments;
window.clearMultipleFileSelection = clearMultipleFileSelection;
window.removeFileFromSelection = removeFileFromSelection;

// OCI設定関連
window.loadOciSettings = loadOciSettings;
window.saveOciSettings = saveOciSettings;
window.testOciConnection = testOciConnection;
window.loadObjectStorageSettings = loadObjectStorageSettings;
window.refreshObjectStorageSettings = refreshObjectStorageSettings;
window.saveObjectStorageSettings = saveObjectStorageSettings;
window.testObjectStorageConnection = testObjectStorageConnection;

// 認証関連（TODO: window.authModuleに移行予定）
window.handleLogin = handleLogin;
window.handleLogout = handleLogout;
window.toggleLoginPassword = toggleLoginPassword;

// 検索関連（window.searchModuleを使用）
// 注: window.searchModule.performSearch(), window.searchModule.clearSearchResults() を使用してください
// 下位互換性のために委譲関数を定義
window.performSearch = function() {
  if (window.searchModule?.performSearch) {
    return window.searchModule.performSearch();
  }
  console.warn('searchModuleがまだ読み込まれていません');
};
window.clearSearchResults = function() {
  if (window.searchModule?.clearSearchResults) {
    return window.searchModule.clearSearchResults();
  }
};
window.downloadFile = function(bucket, encodedObjectName) {
  if (window.searchModule?.downloadFile) {
    return window.searchModule.downloadFile(bucket, encodedObjectName);
  }
};
window.showSearchImageModal = function(imageUrl, title, vectorDistance) {
  if (window.searchModule?.showSearchImageModal) {
    return window.searchModule.showSearchImageModal(imageUrl, title, vectorDistance);
  }
};
