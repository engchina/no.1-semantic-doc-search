// ========================================
// モジュールインポート
// ========================================
import { appState, setAuthState, getAuthState } from './src/state.js';
import { apiCall as authApiCall, loadConfig } from './src/modules/auth.js';
import { closeImageModal as searchCloseImageModal } from './src/modules/search.js';
import { 
  showToast as utilsShowToast, 
  showLoading as utilsShowLoading, 
  hideLoading as utilsHideLoading,
  formatFileSize as utilsFormatFileSize,
  formatDateTime as utilsFormatDateTime,
  showConfirmModal as utilsShowConfirmModal
} from './src/modules/utils.js';
import {
  loadOciSettings,
  saveOciSettings,
  testOciConnection,
  handlePrivateKeyFileSelect,
  clearPrivateKey,
  updateObjectStorageStatusBadge,
  refreshObjectStorageSettings,
  testObjectStorageConnection
} from './src/modules/oci.js';
import {
  vectorizeSelectedOciObjects as ociVectorizeSelectedOciObjects,
  deleteSelectedOciObjects as ociDeleteSelectedOciObjects,
  loadOciObjects as ociLoadOciObjects
} from './src/modules/document.js';
import { 
  loadDbConnectionSettings, 
  refreshDbConnectionFromEnv, 
  retryLoadDbSettings,
  handleWalletFileSelect,
  uploadWalletFile,
  saveDbConnection,
  testDbConnection,
  loadDbInfo,
  loadDbTables,
  toggleTablePreview,
  loadTableData,
  escapeHtml,
  showTablePreview,
  hideTablePreview,
  refreshTableData,
  handleTableDataPrevPage,
  handleTableDataNextPage,
  handleTableDataJumpPage,
  selectAllTableData,
  clearAllTableData,
  deleteSelectedTableData,
  toggleTableDataRowSelection,
  toggleSelectAllTableData,
  handleDbTablesPrevPage,
  handleDbTablesNextPage,
  handleDbTablesJumpPage,
  toggleDbTableSelection,
  toggleSelectAllDbTables,
  selectAllDbTables,
  clearAllDbTables,
  deleteSelectedDbTables,
  refreshDbInfo,
  refreshDbTables
} from './src/modules/db.js';
import {
  toggleCopilot,
  toggleCopilotExpand,
  sendCopilotMessage,
  renderCopilotMessages,
  openCopilotImage,
  clearCopilotHistory,
  handleCopilotKeydown,
  startNewConversation,
  addCopilotImagesFromFiles,
  handleCopilotPaste,
  renderCopilotImagesPreview,
  removeCopilotImageAt,
  clearCopilotImages,
  showImageModal
} from './src/modules/ai.js';

// ========================================
// グローバル変数（非推奨 - appStateへの移行中）
// ========================================
// 開発時はViteのプロキシを使うため空文字列、本番ビルド時は環境変数から設定
// const API_BASE = import.meta.env.VITE_API_BASE || '';
// NOTE: API_BASEはauth.jsに移動しました

// 注: 以下の変数はappStateに完全移行済み。削除済み。
// let selectedFile = null;           // -> appState.get('selectedFile')
// let documentsCache = [];           // -> appState.get('documentsCache')
// let isLoggedIn = false;            // -> appState.get('isLoggedIn')
// let loginToken = null;             // -> appState.get('loginToken')
// let loginUser = null;              // -> appState.get('loginUser')
// let debugMode = false;             // -> appState.get('debugMode')
// let requireLogin = true;           // -> appState.get('requireLogin')

// AI Assistant状態（appStateへ移行済み）
// let copilotOpen = false;            // -> appState.get('copilotOpen')
// let copilotExpanded = false;        // -> appState.get('copilotExpanded')
// let copilotMessages = [];           // -> appState.get('copilotMessages')
// let copilotLoading = false;         // -> appState.get('copilotLoading')
// let copilotImages = [];             // -> appState.get('copilotImages')

// テーブル一覧ページング状態（appStateへ移行済み）
// let dbTablesPage = 1;               // -> appState.get('dbTablesPage')
// let dbTablesPageSize = 20;          // -> appState.get('dbTablesPageSize')
// let dbTablesTotalPages = 1;         // -> appState.get('dbTablesTotalPages')

// テーブル一覧選択状態（appStateへ移行済み）
// let selectedDbTables = [];          // -> appState.get('selectedDbTables')
// let dbTablesBatchDeleteLoading = false; // -> appState.get('dbTablesBatchDeleteLoading')
// let currentPageDbTables = [];       // -> appState.get('currentPageDbTables')

// テーブルデータプレビュー状態（appStateへ移行済み）
// let selectedTableForPreview = null; // -> appState.get('selectedTableForPreview')
// let tableDataPage = 1;              // -> appState.get('tableDataPage')
// let tableDataPageSize = 20;         // -> appState.get('tableDataPageSize')
// let tableDataTotalPages = 1;        // -> appState.get('tableDataTotalPages')
// let selectedTableDataRows = [];     // -> appState.get('selectedTableDataRows')
// let currentPageTableDataRows = [];  // -> appState.get('currentPageTableDataRows')

// ========================================
// ユーティリティ関数（モジュールから直接使用）
// ========================================

/**
 * 認証トークン付きのURLを生成
 * @param {string} url - ベースURL(検索APIから返却されたURLまたはバケット/オブジェクト名)
 * @param {string} bucket - バケット名(オプション、旧形式互換用)
 * @param {string} objectName - オブジェクト名(オプション、旧形式互換用)
 * @returns {string} トークン付きのURL
 */
function getAuthenticatedImageUrl(urlOrBucket, objectName) {
  const token = localStorage.getItem('loginToken');
  
  // 既に完全なURLが渡された場合(検索APIのurlフィールド)
  if (urlOrBucket && (urlOrBucket.startsWith('http://') || urlOrBucket.startsWith('https://') || urlOrBucket.startsWith('/'))) {
    const url = urlOrBucket;
    if (token) {
      const separator = url.includes('?') ? '&' : '?';
      return `${url}${separator}token=${encodeURIComponent(token)}`;
    }
    return url;
  }
  
  // 旧形式互換: bucket + objectName が渡された場合
  if (urlOrBucket && objectName) {
    const baseUrl = `/ai/api/object/${urlOrBucket}/${encodeURIComponent(objectName)}`;
    if (token) {
      return `${baseUrl}?token=${encodeURIComponent(token)}`;
    }
    return baseUrl;
  }
  
  return urlOrBucket || '';
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
  
  // タブに応じた初期化処理(バックエンドAPI呼び出し時はオーバーレイ表示)
  // 注: 文書管理タブの自動刷新は無効(🔄 更新ボタンで手動刷新)
  try {
    if (tabName === 'settings') {
      console.log('Loading OCI settings...');
      utilsShowLoading('OCI設定を読み込み中...');
      await loadOciSettings();
      utilsHideLoading();
      console.log('OCI settings loaded');
    } else if (tabName === 'database') {
      console.log('Loading DB connection settings, ADB OCID, and connection info from .env...');
      utilsShowLoading('データベース設定を読み込み中...');
      
      // 既存の警告メッセージをクリア（重複防止）
      const dbContent = document.getElementById('tab-database');
      if (dbContent) {
        const existingWarnings = dbContent.querySelectorAll('.bg-yellow-50.border-yellow-400');
        existingWarnings.forEach(warning => warning.remove());
      }
      
      try {
        await loadDbConnectionSettings();
      } catch (error) {
        // タイムアウトエラーの場合は特別な処理
        if (error.message.includes('タイムアウト')) {
          utilsHideLoading();
          
          // リトライボタンを表示（トーストは表示しない - 画面内の警告のみ）
          if (dbContent) {
            const retryHtml = `
              <div class="bg-yellow-50 border-l-4 border-yellow-400 p-4 mb-4" role="alert">
                <div class="flex items-start">
                  <div class="flex-shrink-0">
                    <svg class="h-5 w-5 text-yellow-400" viewBox="0 0 20 20" fill="currentColor">
                      <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
                    </svg>
                  </div>
                  <div class="ml-3 flex-1">
                    <p class="text-sm text-yellow-700">
                      データベース設定の読み込みに失敗しました。データベースが起動していない可能性があります。
                    </p>
                    <p class="mt-2 text-sm text-yellow-700">
                      データベースを起動してから、下のボタンをクリックして再読み込みしてください。
                    </p>
                    <div class="mt-3">
                      <button 
                        onclick="window.retryLoadDbSettings()" 
                        class="bg-yellow-500 hover:bg-yellow-600 text-white px-4 py-2 rounded transition-colors"
                      >
                        🔄 再読み込み
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            `;
            dbContent.insertAdjacentHTML('afterbegin', retryHtml);
          }
          return; // エラー後は後続処理をスキップ
        }
        
        // その他のエラーの場合
        utilsHideLoading();
        utilsShowToast(`設定読み込みエラー: ${error.message}`, 'error');
        return;
      }
      
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
    // データベースタブの場合は既にエラー処理済みなのでスキップ
    if (tabName === 'database') {
      return;
    }
    console.error('Tab initialization error:', error);
    utilsHideLoading();
    utilsShowToast(`設定読み込みエラー: ${error.message}`, 'error');
  }
}

// ========================================
// ページ画像化されたファイルの判定
// ※ 移動先: src/modules/document.js
// ========================================

// /**
//  * ページ画像化で生成されたファイルかどうかを判定
//  * 構造: 親ファイル名/page_001.png, 親ファイル名/page_002.png ...
//  * 例: "example.pdf" → "example/page_001.png"
//  * 
//  * @param {string} objectName - オブジェクト名
//  * @param {Array} allObjects - 全オブジェクトのリスト（親ファイルの存在確認用）
//  * @returns {boolean} ページ画像化されたファイルの場合true
//  */
// function isGeneratedPageImage(objectName, allObjects = appState.get('allOciObjects')) {
//   // page_001.pngのパターンにマッチするかチェック
//   if (!/\/page_\d{3}\.png$/.test(objectName)) {
//     return false;
//   }
//    
//   // 親ファイル名を抽出（例: "example/page_001.png" → "example"）
//   const lastSlashIndex = objectName.lastIndexOf('/');
//   if (lastSlashIndex === -1) {
//     // ルート直下のpage_001.pngはページ画像化されたファイルではない
//     return false;
//   }
//   
//   const parentFolderPath = objectName.substring(0, lastSlashIndex);
//   
//   // 親フォルダと同名のファイルが存在するかチェック
//   // 例: "example/page_001.png" の場合、"example", "example.pdf", "example.pptx" などが存在すればページ画像化されたファイル
//   const parentFileExists = allObjects.some(obj => {
//     // フォルダを除外
//     if (obj.name.endsWith('/')) {
//       return false;
//     }
//     
//     // 拡張子を除いたファイル名を比較
//     const objNameWithoutExt = obj.name.replace(/\.[^.]+$/, '');
//     return objNameWithoutExt === parentFolderPath;
//   });
//   
//   return parentFileExists;
// }
// src/modules/document.jsのisGeneratedPageImage関数を使用
const isGeneratedPageImage = (objectName, allObjects) => {
  return window.ociModule?.isGeneratedPageImage?.(objectName, allObjects) ?? false;
};

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
/**
 * 複数ファイルアップロード（SSE対応・進捗表示付き）
 */
async function uploadMultipleDocuments() {
  if (selectedMultipleFiles.length === 0) {
    utilsShowToast('ファイルを選択してください', 'warning');
    return;
  }
  
  try {
    // ボタンを無効化
    const uploadBtn = document.getElementById('uploadMultipleBtn');
    uploadBtn.disabled = true;
    
    // 選択されたファイルリストを非表示
    const selectedFilesList = document.getElementById('selectedFilesList');
    if (selectedFilesList) {
      selectedFilesList.style.display = 'none';
    }
    
    // 進捗表示UIを初期化
    showUploadProgressUI(selectedMultipleFiles);
    
    // FormDataを作成
    const formData = new FormData();
    selectedMultipleFiles.forEach(file => {
      formData.append('files', file);
    });
    
    // トークンを取得
    const loginToken = localStorage.getItem('loginToken');
    const headers = {};
    if (loginToken) {
      headers['Authorization'] = `Bearer ${loginToken}`;
    }
    
    // API呼び出し（SSE）
    const response = await fetch('/ai/api/documents/upload/multiple', {
      method: 'POST',
      headers: headers,
      body: formData
    });
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    // SSEストリーミング処理
    await processUploadStreamingResponse(response, selectedMultipleFiles.length);
    
  } catch (error) {
    console.error('アップロードエラー:', error);
    hideUploadProgressUI();
    const uploadBtn = document.getElementById('uploadMultipleBtn');
    if (uploadBtn) {
      uploadBtn.disabled = false;
    }
    utilsShowToast(`アップロードエラー: ${error.message}`, 'error');
  }
}

/**
 * アップロード進捗UIを表示
 */
function showUploadProgressUI(files) {
  const progressDiv = document.getElementById('uploadProgress');
  progressDiv.style.display = 'block';
  
  const filesArray = Array.from(files);
  const totalFiles = filesArray.length;
  
  let filesHtml = '';
  filesArray.forEach((file, index) => {
    // ファイル名をエスケープ
    const safeFileName = escapeHtml(file.name);
    filesHtml += `
      <div id="upload-file-${index}" class="flex items-start gap-2 p-3 rounded bg-gray-50 border border-gray-200" style="margin-bottom: 8px;">
        <div class="flex-1">
          <div class="text-sm font-medium text-gray-800">${safeFileName}</div>
          <div class="flex items-center gap-2 mt-1">
            <div class="flex-1 bg-gray-200 rounded-full h-2">
              <div id="upload-progress-bar-${index}" class="bg-blue-500 h-2 rounded-full transition-all duration-300" style="width: 0%"></div>
            </div>
            <span id="upload-progress-percent-${index}" class="text-xs font-semibold text-gray-600" style="min-width: 40px;">0%</span>
          </div>
          <div id="upload-status-${index}" class="text-xs text-gray-500 mt-1"></div>
        </div>
      </div>
    `;
  });
  
  progressDiv.innerHTML = `
    <div class="bg-white border-2 border-blue-400 rounded-lg p-4" style="margin-bottom: 16px;">
      <div class="mb-3 pb-3 border-b border-gray-200 flex items-center justify-between">
        <div>
          <div class="text-base font-bold text-gray-800 mb-1">オブジェクト・ストアにファイルをアップロード中</div>
          <div class="text-xs text-gray-600">選択されたファイル: ${totalFiles}件</div>
        </div>
        <button 
          id="closeUploadProgressBtn" 
          onclick="closeUploadProgress()" 
          class="text-gray-400 hover:text-gray-600 transition-colors" 
          style="display: none; font-size: 24px; line-height: 1; padding: 4px;"
          title="閉じる"
        >
          ✕
        </button>
      </div>
      
      <div id="upload-files-container" style="max-height: 400px; overflow-y: auto;">
        ${filesHtml}
      </div>
      
      <div class="mt-3 pt-3 border-t border-gray-200">
        <div id="upload-overall-status" class="text-sm font-semibold text-gray-700">準備中...</div>
      </div>
    </div>
  `;
}

/**
 * アップロード進捗UIを非表示
 */
function hideUploadProgressUI() {
  const progressDiv = document.getElementById('uploadProgress');
  if (progressDiv) {
    progressDiv.style.display = 'none';
  }
}

/**
 * アップロード進捗UIを手動で閉じる
 */
function closeUploadProgress() {
  clearMultipleFileSelection();
  hideUploadProgressUI();
}

/**
 * ストリーミングレスポンスの処理（アップロード専用）
 */
async function processUploadStreamingResponse(response, totalFiles) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  
  let currentFileIndex = 0;
  let successCount = 0;
  let failedCount = 0;
  let processingCompleted = false;
  
  const processEventLine = async (line) => {
    if (!line.startsWith('data: ')) return;
    
    try {
      const jsonStr = line.substring(6);
      const data = JSON.parse(jsonStr);
      
      switch(data.type) {
        case 'start':
          totalFiles = data.total_files;
          updateUploadOverallStatus(`アップロード開始: ${totalFiles}件`);
          break;
          
        case 'file_start':
          currentFileIndex = data.file_index;
          updateFileUploadStatus(data.file_index - 1, '待機中', 0);
          updateUploadOverallStatus(`ファイル ${data.file_index}/${data.total_files} を処理中...`);
          break;
          
        case 'file_uploading':
          updateFileUploadStatus(data.file_index - 1, 'アップロード中...', 50);
          break;
          
        case 'file_complete':
          successCount++;
          updateFileUploadStatus(data.file_index - 1, '完了', 100, true);
          updateUploadOverallStatus(`完了: ${successCount}/${totalFiles}件`);
          break;
          
        case 'file_error':
          failedCount++;
          updateFileUploadStatus(data.file_index - 1, `エラー: ${data.error}`, 100, false, true);
          updateUploadOverallStatus(`進行中: 成功 ${successCount}件、失敗 ${failedCount}件`);
          break;
          
        case 'complete':
          processingCompleted = true;
          updateUploadOverallStatus(
            data.success ? 
              `✓ すべて完了しました (${data.success_count}件)` : 
              `完了: 成功 ${data.success_count}件、失敗 ${data.failed_count}件`
          );
          
          // 成功時のトースト
          if (data.success) {
            utilsShowToast(`${data.success_count}件のファイルアップロードが完了しました`, 'success');
          } else {
            utilsShowToast(data.message, 'warning');
          }
          
          // 閉じるボタンを表示
          const closeBtn = document.getElementById('closeUploadProgressBtn');
          if (closeBtn) {
            closeBtn.style.display = 'block';
          }
          
          const uploadBtn = document.getElementById('uploadMultipleBtn');
          if (uploadBtn) {
            uploadBtn.disabled = false;
          }
          break;
          
        case 'error':
          processingCompleted = true;
          updateUploadOverallStatus(`エラー: ${data.message}`);
          utilsShowToast(`エラー: ${data.message}`, 'error');
          const uploadBtnError = document.getElementById('uploadMultipleBtn');
          if (uploadBtnError) {
            uploadBtnError.disabled = false;
          }
          hideUploadProgressUI();
          break;
      }
    } catch (parseError) {
      console.error('JSONパースエラー:', parseError, '行:', line);
    }
  };
  
  try {
    while (true) {
      const { done, value } = await reader.read();
      
      if (done) {
        buffer += decoder.decode(new Uint8Array(), { stream: false });
        if (buffer.trim()) {
          const remainingLines = buffer.split('\n');
          for (const line of remainingLines) {
            await processEventLine(line);
          }
        }
        break;
      }
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      
      for (const line of lines) {
        await processEventLine(line);
      }
    }
  } catch (error) {
    console.error('ストリーム読み取りエラー:', error);
    throw error;
  } finally {
    // ストリームが異常終了してもUIをリセット
    if (!processingCompleted) {
      const uploadBtn = document.getElementById('uploadMultipleBtn');
      if (uploadBtn) {
        uploadBtn.disabled = false;
      }
    }
  }
}

/**
 * ファイルアップロード状態を更新
 */
function updateFileUploadStatus(fileIndex, status, progress, isSuccess = false, isError = false) {
  const fileDiv = document.getElementById(`upload-file-${fileIndex}`);
  const progressBar = document.getElementById(`upload-progress-bar-${fileIndex}`);
  const progressPercent = document.getElementById(`upload-progress-percent-${fileIndex}`);
  const statusDiv = document.getElementById(`upload-status-${fileIndex}`);
  
  if (!fileDiv || !progressBar || !progressPercent || !statusDiv) return;
  
  // プログレスバー更新
  progressBar.style.width = `${progress}%`;
  progressPercent.textContent = `${progress}%`;
  
  // 状態テキスト更新
  statusDiv.textContent = status;
  
  // 色の変更
  if (isSuccess) {
    fileDiv.classList.remove('bg-gray-50', 'border-gray-200', 'bg-red-50', 'border-red-200');
    fileDiv.classList.add('bg-green-50', 'border-green-200');
    progressBar.classList.remove('bg-blue-500', 'bg-red-500');
    progressBar.classList.add('bg-green-500');
    statusDiv.classList.remove('text-gray-500', 'text-red-600');
    statusDiv.classList.add('text-green-600');
  } else if (isError) {
    fileDiv.classList.remove('bg-gray-50', 'border-gray-200', 'bg-green-50', 'border-green-200');
    fileDiv.classList.add('bg-red-50', 'border-red-200');
    progressBar.classList.remove('bg-blue-500', 'bg-green-500');
    progressBar.classList.add('bg-red-500');
    statusDiv.classList.remove('text-gray-500', 'text-green-600');
    statusDiv.classList.add('text-red-600');
  }
}

/**
 * 全体ステータスを更新
 */
function updateUploadOverallStatus(message) {
  const statusDiv = document.getElementById('upload-overall-status');
  if (statusDiv) {
    statusDiv.textContent = message;
  }
}

function handleFileSelect(event) {
  const file = event.target.files[0];
  if (file) {
    // appStateに保存
    appState.set('selectedFile', file);
    
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
  
  document.getElementById('fileInput').value = '';
  document.getElementById('uploadBtn').disabled = true;
  document.getElementById('uploadStatus').style.display = 'none';
}

async function uploadDocument() {
  if (!appState.get('selectedFile')) {
    utilsShowToast('ファイルを選択してください', 'warning');
    return;
  }
  
  try {
    utilsShowLoading('文書をアップロード中...');
    
    const formData = new FormData();
    formData.append('file', appState.get('selectedFile'));
    
    const data = await authApiCall('/ai/api/documents/upload', {
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
    const data = await authApiCall('/ai/api/documents');
    appState.set('documentsCache', data.documents);
    displayDocumentsList(data.documents);
  } catch (error) {
    utilsShowToast(`エラー: ${error.message}`, 'error');
  }
}

// ========================================
// OCI Object Storage一覧表示
// ========================================

/**
 * 指定したフォルダの子オブジェクトをすべて取得
 */
function getChildObjects(folderName) {
  // フォルダ名が/で終わっていることを確認
  const folderPath = folderName.endsWith('/') ? folderName : folderName + '/';
  
  // フォルダの配下にあるすべてのオブジェクトを検索
  const allOciObjects = appState.get('allOciObjects') || [];
  return allOciObjects.filter(obj => obj.name.startsWith(folderPath));
}

/**
 * 文書一覧を更新(通知付き)
 */
window.refreshDocumentsWithNotification = async function() {
  try {
    utilsShowLoading('文書一覧を再取得中...');
    await loadOciObjects();
    utilsHideLoading();
    utilsShowToast('文書一覧を再取得しました', 'success');
  } catch (error) {
    utilsHideLoading();
    utilsShowToast(`文書一覧再取得エラー: ${error.message}`, 'error');
  }
}

/**
 * 文書ステータスバッジを更新
 * ※ 移動先: src/modules/document.js
 */
// function updateDocumentsStatusBadge(text, type = 'info') {
//   const badge = document.getElementById('documentsStatusBadge');
//   if (!badge) return;
//   
//   badge.textContent = text;
//   
//   // タイプに応じてスタイルを変更
//   badge.style.background = '';
//   badge.style.color = '';
//   badge.classList.remove('bg-green-100', 'text-green-800', 'bg-red-100', 'text-red-800', 'bg-gray-100', 'text-gray-600');
//   
//   if (type === 'success') {
//     badge.classList.add('bg-green-100', 'text-green-800');
//   } else if (type === 'error') {
//     badge.classList.add('bg-red-100', 'text-red-800');
//   } else {
//     badge.classList.add('bg-gray-100', 'text-gray-600');
//   }
// }

/**
 * 文書統計情報バッジを更新
 * ※ 移動先: src/modules/document.js
 */
// function updateDocumentsStatisticsBadges(statistics, type = 'success') {
//   // ファイル数バッジ
//   const fileBadge = document.getElementById('documentsFileCountBadge');
//   if (fileBadge && statistics) {
//     fileBadge.textContent = `ファイル: ${statistics.file_count}件`;
//     fileBadge.style.background = '';
//     fileBadge.style.color = '';
//     fileBadge.classList.remove('bg-green-100', 'text-green-800', 'bg-red-100', 'text-red-800', 'bg-gray-100', 'text-gray-600');
//     
//     if (type === 'success') {
//       fileBadge.classList.add('bg-blue-100', 'text-blue-800');
//     } else if (type === 'error') {
//       fileBadge.classList.add('bg-red-100', 'text-red-800');
//     } else {
//       fileBadge.classList.add('bg-gray-100', 'text-gray-600');
//     }
//     fileBadge.style.display = 'inline-block';
//   }
//   
//   // ページ画像数バッジ
//   const pageImageBadge = document.getElementById('documentsPageImageCountBadge');
//   if (pageImageBadge && statistics) {
//     pageImageBadge.textContent = `ページ画像: ${statistics.page_image_count}件`;
//     pageImageBadge.style.background = '';
//     pageImageBadge.style.color = '';
//     pageImageBadge.classList.remove('bg-green-100', 'text-green-800', 'bg-red-100', 'text-red-800', 'bg-gray-100', 'text-gray-600');
//     
//     if (type === 'success') {
//       pageImageBadge.classList.add('bg-purple-100', 'text-purple-800');
//     } else if (type === 'error') {
//       pageImageBadge.classList.add('bg-red-100', 'text-red-800');
//     } else {
//       pageImageBadge.classList.add('bg-gray-100', 'text-gray-600');
//     }
//     pageImageBadge.style.display = 'inline-block';
//   }
// }

/**
 * OCI Object Storage一覧を読み込む
 * ※ 移動先: src/modules/document.js
 */
// async function loadOciObjects() {
//   try {
//     utilsShowLoading('OCI Object Storage一覧を取得中...');
//     
//     const params = new URLSearchParams({
//       prefix: appState.get('ociObjectsPrefix'),
//       page: appState.get('ociObjectsPage').toString(),
//       page_size: appState.get('ociObjectsPageSize').toString(),
//       filter_page_images: appState.get('ociObjectsFilterPageImages'),
//       filter_embeddings: appState.get('ociObjectsFilterEmbeddings'),
//       display_type: appState.get('ociObjectsDisplayType')
//     });
//     
//     const data = await authApiCall(`/ai/api/oci/objects?${params}`);
//     
//     utilsHideLoading();
//     
//     if (!data.success) {
//       utilsShowToast(`エラー: ${data.message || 'オブジェクト一覧取得失敗'}`, 'error');
//       updateDocumentsStatusBadge('エラー', 'error');
//       return;
//     }
//     
//     // 全オブジェクトキャッシュを更新（ページネーションで分割されているため、一度取得したものを保持）
//     // 注: ページ変更時には前ページのデータも保持
//     const currentAllObjects = appState.get('allOciObjects');
//     data.objects.forEach(obj => {
//       const existingIndex = currentAllObjects.findIndex(o => o.name === obj.name);
//       if (existingIndex >= 0) {
//         currentAllObjects[existingIndex] = obj;
//       } else {
//         currentAllObjects.push(obj);
//       }
//     });
//     appState.set('allOciObjects', currentAllObjects);
//     
//     displayOciObjectsList(data);
//     
//     // バッジを更新
//     const totalCount = data.pagination?.total || 0;
//     const statistics = data.statistics || { file_count: 0, page_image_count: 0, total_count: 0 };
//     
//     updateDocumentsStatusBadge(`${totalCount}件`, 'success');
//     updateDocumentsStatisticsBadges(statistics, 'success');
//     
//   } catch (error) {
//     utilsHideLoading();
//     utilsShowToast(`OCI Object Storage一覧取得エラー: ${error.message}`, 'error');
//     updateDocumentsStatusBadge('エラー', 'error');
//   }
// }
// src/modules/document.jsのloadOciObjects関数を使用
const loadOciObjects = ociLoadOciObjects;

/**
 * OCI Object Storage一覧を表示
 * ※ 移動先: src/modules/document.js
 */
// function displayOciObjectsList(data) {
//   const listDiv = document.getElementById('documentsList');
//   
//   const objects = data.objects || [];
//   const pagination = data.pagination || {};
//   const allOciObjects = appState.get('allOciObjects') || [];
//   const selectedOciObjects = appState.get('selectedOciObjects') || [];
//   
//   // デバッグ: 選択状態を確認
//   
//   
//   // 全ページ選択状態をチェック（チェックボックスを持つオブジェクトのみ対象）
//   // ページ画像化で生成されたファイル（page_*.png）はチェックボックスを持たないため除外
//   const selectableObjects = objects.filter(obj => {
//     return !isGeneratedPageImage(obj.name, allOciObjects);
//   });
//   const allPageSelected = selectableObjects.length > 0 && selectableObjects.every(obj => selectedOciObjects.includes(obj.name));
//   
//   // フィルターUI HTML（常に表示）
//   // ... (省略 - 詳細はsrc/modules/document.jsを参照)
// }
// src/modules/document.jsのdisplayOciObjectsList関数を使用
const displayOciObjectsList = (data) => {
  window.ociModule?.displayOciObjectsList?.(data);
};

/**
 * ページネーション - 前ページ
 * ※ 移動先: src/modules/document.js
 */
// function handleOciObjectsPrevPage() {
//   if (ociObjectsPage > 1 && !ociObjectsBatchDeleteLoading) {
//     ociObjectsPage--;
//     loadOciObjects();
//   }
// }
const handleOciObjectsPrevPage = () => { window.ociModule?.prevPage?.(); };

/**
 * ページネーション - 次ページ
 * ※ 移動先: src/modules/document.js
 */
// function handleOciObjectsNextPage() {
//   if (!ociObjectsBatchDeleteLoading) {
//     ociObjectsPage++;
//     loadOciObjects();
//   }
// }
const handleOciObjectsNextPage = () => { window.ociModule?.nextPage?.(); };

/**
 * ページネーション - ページジャンプ
 * ※ 移動先: src/modules/document.js
 */
// function handleOciObjectsJumpPage() {
//   if (ociObjectsBatchDeleteLoading) return;
//   
//   const input = document.getElementById('ociObjectsPageInput');
//   const page = parseInt(input.value);
//   
//   if (page && page >= 1) {
//     ociObjectsPage = page;
//     loadOciObjects();
//   }
// }
const handleOciObjectsJumpPage = () => { window.ociModule?.jumpToPage?.(); };

/**
 * ページ画像化フィルターを設定
 * ※ 移動先: src/modules/document.js
 */
// window.setOciObjectsFilterPageImages = function(value) {
//   if (appState.get('ociObjectsBatchDeleteLoading')) return;
//   appState.set('ociObjectsFilterPageImages', value);
//   appState.set('ociObjectsPage', 1);  // フィルター変更時は1ページ目に戻る
//   appState.set('selectedOciObjects', []);  // 選択状態をクリア
//   loadOciObjects();
// }
window.setOciObjectsFilterPageImages = (value) => { window.ociModule?.setFilterPageImages?.(value); };

/**
 * ベクトル化フィルターを設定
 * ※ 移動先: src/modules/document.js
 */
// window.setOciObjectsFilterEmbeddings = function(value) {
//   if (appState.get('ociObjectsBatchDeleteLoading')) return;
//   appState.set('ociObjectsFilterEmbeddings', value);
//   appState.set('ociObjectsPage', 1);  // フィルター変更時は1ページ目に戻る
//   appState.set('selectedOciObjects', []);  // 選択状態をクリア
//   loadOciObjects();
// }
window.setOciObjectsFilterEmbeddings = (value) => { window.ociModule?.setFilterEmbeddings?.(value); };

/**
 * すべてのフィルターをクリア
 * ※ 移動先: src/modules/document.js
 */
// window.clearOciObjectsFilters = function() {
//   if (ociObjectsBatchDeleteLoading) return;
//   ociObjectsFilterPageImages = "all";
//   ociObjectsFilterEmbeddings = "all";
//   ociObjectsPage = 1;
//   selectedOciObjects = [];
//   appState.set('selectedOciObjects', []);  // oci.jsモジュールとの同期
//   loadOciObjects();
// }
window.clearOciObjectsFilters = () => { window.ociModule?.clearFilters?.(); };

/**
 * 表示タイプフィルターを設定
 * ※ 移動先: src/modules/document.js
 * @param {string} value - 表示タイプ ('files_only' | 'files_and_images')
 */
// window.setOciObjectsDisplayType = function(value) {
//   if (appState.get('ociObjectsBatchDeleteLoading')) return;
//   appState.set('ociObjectsDisplayType', value);
//   appState.set('ociObjectsPage', 1);  // フィルター変更時は1ページ目に戻る
//   appState.set('selectedOciObjects', []);  // 選択状態をクリア
//   loadOciObjects();
// }
window.setOciObjectsDisplayType = (value) => { window.ociModule?.setDisplayType?.(value); };

/**
 * オブジェクト選択状態をトグル（親子関係対応、page_*.png除外）
 * ※ 移動先: src/modules/document.js
 */
// function toggleOciObjectSelection(objectName) {
//   // ... (省略 - 詳細はsrc/modules/document.jsを参照)
// }
const toggleOciObjectSelection = (objectName) => { window.ociModule?.toggleSelection?.(objectName); };

/**
 * 全選択トグル（ヘッダーチェックボックス）（親子関係対応）
 * ※ 移動先: src/modules/document.js
 */
// function toggleSelectAllOciObjects(checked) {
//   // ... (省略 - 詳細はsrc/modules/document.jsを参照)
// }
const toggleSelectAllOciObjects = (checked) => { window.ociModule?.toggleSelectAll?.(checked); };

/**
 * すべて選択（親子関係対応、page_*.png除外）
 * ※ 移動先: src/modules/document.js
 */
// function selectAllOciObjects() {
//   // ... (省略 - 詳細はsrc/modules/document.jsを参照)
// }
const selectAllOciObjects = () => { window.ociModule?.selectAll?.(); };

/**
 * すべて解除
 * ※ 移動先: src/modules/document.js
 */
// function clearAllOciObjects() {
//   // ... (省略 - 詳細はsrc/modules/document.jsを参照)
// }
const clearAllOciObjects = () => { window.ociModule?.clearAll?.(); };

/**
 * 選択されたオブジェクトを削除
 * 注: この関数はsrc/modules/oci.jsに移行済み。window.deleteSelectedOciObjectsで公開されています。
 */

/**
 * 選択されたOCIオブジェクトをZIPでダウンロード
 * ※ 移動先: src/modules/document.js
 */
// window.downloadSelectedOciObjects = async function() {
//   if (selectedOciObjects.length === 0) {
//     utilsShowToast('ダウンロードするファイルを選択してください', 'warning');
//     return;
//   }
//   
//   if (ociObjectsBatchDeleteLoading) {
//     utilsShowToast('処理中です。しばらくお待ちください', 'warning');
//     return;
//   }
//   
//   // トークンを確認
//   const token = localStorage.getItem('loginToken');
//   if (!token && !appState.get('debugMode')) {
//     utilsShowToast('認証が必要です。ログインしてください', 'warning');
//     showLoginModal();
//     return;
//   }
//   
//   try {
//     ociObjectsBatchDeleteLoading = true;
//     utilsShowLoading(`${selectedOciObjects.length}件のファイルをZIPに圧縮中...`);
//     
//     // リクエストヘッダーを構築
//     const headers = {
//       'Content-Type': 'application/json'
//     };
//     if (token) {
//       headers['Authorization'] = `Bearer ${token}`;
//     }
//     
//     const response = await fetch('/ai/api/oci/objects/download', {
//       method: 'POST',
//       headers: headers,
//       body: JSON.stringify({
//         object_names: selectedOciObjects
//       })
//     });
//     
//     if (!response.ok) {
//       // 401エラーの場合は強制ログアウト（referenceプロジェクトに準拠）
//       if (response.status === 401) {
//         utilsHideLoading();
//         ociObjectsBatchDeleteLoading = false;
//         if (appState.get('requireLogin')) {
//           forceLogout();
//         }
//         throw new Error('無効または期限切れのトークンです');
//       }
//       
//       const errorData = await response.json();
//       throw new Error(errorData.detail || 'ダウンロードに失敗しました');
//     }
//     
//     // ZIPファイルをダウンロード
//     const blob = await response.blob();
//     const url = window.URL.createObjectURL(blob);
//     const a = document.createElement('a');
//     a.href = url;
//     a.download = 'documents.zip';
//     document.body.appendChild(a);
//     a.click();
//     window.URL.revokeObjectURL(url);
//     document.body.removeChild(a);
//     
//     utilsHideLoading();
//     ociObjectsBatchDeleteLoading = false;
//     utilsShowToast(`${selectedOciObjects.length}件のファイルをダウンロードしました`, 'success');
//     
//     // 一覧を再読み込みして状態を同期
//     await loadOciObjects();
//     
//   } catch (error) {
//     utilsHideLoading();
//     ociObjectsBatchDeleteLoading = false;
//     console.error('ダウンロードエラー:', error);
//     utilsShowToast(`ダウンロードエラー: ${error.message}`, 'error');
//     
//     // エラー時も一覧を再読み込みして状態を同期
//     await loadOciObjects();
//   }
// };
// src/modules/document.jsのdownloadSelectedOciObjects関数を使用
window.downloadSelectedOciObjects = () => { window.ociModule?.downloadSelected?.(); };

/**
 * 選択されたOCIオブジェクトをページ毎に画像化
 * ※ 移動先: src/modules/document.js
 */
// window.convertSelectedOciObjectsToImages = async function() {
//   // ... (省略 - 詳細はsrc/modules/document.jsを参照)
// };
// src/modules/document.jsのconvertSelectedOciObjectsToImages関数を使用
window.convertSelectedOciObjectsToImages = () => { window.ociModule?.convertToImages?.(); };

/**
 * 選択されたOCIオブジェクトをベクトル化してDBに保存
 * ※ 移動先: src/modules/document.js
 */
// window.vectorizeSelectedOciObjects = async function() {
//   // ... (省略 - 詳細はsrc/modules/document.jsを参照)
// };
// 注: ベクトル化機能は既にdocument.jsモジュールからインポートされています（ociVectorizeSelectedOciObjects）

/**
 * ローディングメッセージを更新（プログレスバー付き、キャンセルボタン対応）
 * @param {string} message - 表示するメッセージ
 * @param {number|null} progress - 進捗率 (0-1)
 * @param {string|null} jobId - ジョブID（キャンセル用）
 */
function updateLoadingMessage(message, progress = null, jobId = null) {
  const loadingOverlay = document.getElementById('loadingOverlay');
  if (!loadingOverlay) return;
  
  // メッセージを更新
  const textEl = loadingOverlay.querySelector('.loading-overlay-text');
  if (textEl) {
    textEl.innerHTML = message.replace(/\n/g, '<br>');
  }
  
  // プログレスバーを更新
  const progressContainer = loadingOverlay.querySelector('.loading-progress-container');
  if (progressContainer) {
    if (progress !== null && progress !== undefined) {
      progressContainer.classList.remove('hidden');
      // NaN、Infinity、-Infinityをゼロに変換
      const validProgress = (typeof progress === 'number' && isFinite(progress)) ? progress : 0;
      const clampedProgress = Math.max(0, Math.min(1, validProgress));
      const percentage = Math.round(clampedProgress * 100);
      
      const progressBar = progressContainer.querySelector('.loading-progress-bar');
      const progressPercent = progressContainer.querySelector('.loading-progress-percent');
      
      if (progressBar) {
        progressBar.style.width = `${percentage}%`;
      }
      if (progressPercent) {
        progressPercent.textContent = `${percentage}%`;
      }
    } else {
      progressContainer.classList.add('hidden');
    }
  }
  
  // キャンセルボタンを更新
  const cancelContainer = loadingOverlay.querySelector('.loading-cancel-container');
  if (cancelContainer) {
    if (jobId) {
      cancelContainer.classList.remove('hidden');
      cancelContainer.innerHTML = `
        <button 
          onclick="cancelCurrentJob('${jobId}')" 
          class="px-4 py-2 text-sm font-medium text-white bg-red-500 hover:bg-red-600 rounded-md transition-colors"
        >
          キャンセル
        </button>
      `;
    } else {
      cancelContainer.classList.add('hidden');
      cancelContainer.innerHTML = '';
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
    '実行中の処理をキャンセルしますか？\n\n進行中のファイルは処理が完了してから停止します。',
    'キャンセル確認',
    { variant: 'warning' }
  );
  
  if (!confirmed) {
    return;
  }
  
  try {
    const token = localStorage.getItem('loginToken');
    const headers = {
      'Content-Type': 'application/json'
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    
    const response = await fetch(`/ai/api/jobs/${jobId}/cancel`, {
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
    '文書削除の確認',
    { variant: 'danger', confirmText: '削除' }
  );
  
  if (!confirmed) {
    return;
  }
  
  try {
    utilsShowLoading('文書を削除中...');
    
    // 認証トークンを取得
    const loginToken = localStorage.getItem('loginToken');
    const headers = {
      'Authorization': `Bearer ${loginToken}`
    };
    
    const response = await fetch(`/ai/api/documents/${documentId}`, {
      method: 'DELETE',
      headers: headers
    });
    
    // 401エラーの場合は認証エラー
    if (response.status === 401) {
      utilsHideLoading();
      utilsShowToast('認証が必要です', 'error');
      if (window.authModule && window.authModule.forceLogout) {
        window.authModule.forceLogout();
      }
      return;
    }
    
    // レスポンスのContent-Typeを確認
    const contentType = response.headers.get('Content-Type');
    
    if (!response.ok) {
      // エラーレスポンスを適切にパース
      let errorMessage = 'リクエストに失敗しました';
      try {
        if (contentType && contentType.includes('application/json')) {
          const error = await response.json();
          errorMessage = error.detail || errorMessage;
        } else {
          errorMessage = await response.text();
        }
      } catch (e) {
        errorMessage = response.statusText || errorMessage;
      }
      throw new Error(errorMessage);
    }
    
    // 成功レスポンスをパース
    let result;
    if (contentType && contentType.includes('application/json')) {
      result = await response.json();
    } else if (contentType && contentType.includes('text/event-stream')) {
      // SSE形式の場合はエラー（単一文書削除ではSSEは使用しない）
      throw new Error('予期しないレスポンス形式（SSE）を受信しました');
    } else {
      // その他のテキストレスポンス
      const text = await response.text();
      // SSE形式かどうかを確認
      if (text.startsWith('data:')) {
        throw new Error('予期しないレスポンス形式（SSE）を受信しました。バックエンドのエンドポイントを確認してください。');
      }
      throw new Error('予期しないレスポンス形式を受信しました');
    }
    
    utilsHideLoading();
    utilsShowToast('文書を削除しました', 'success');
    
    await loadDocuments();
    
  } catch (error) {
    utilsHideLoading();
    console.error('削除エラー詳細:', error);
    utilsShowToast(`削除エラー: ${error.message}`, 'error');
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
// 注: handlePrivateKeyFileSelect, clearPrivateKey は oci.js モジュールで登録済み
window.handleDragOver = handleDragOver;
window.handleDragLeave = handleDragLeave;
window.handleDropForInput = handleDropForInput;

// ========================================
// DB管理
// ========================================

// async function loadDbConnectionSettings() {
//   try {
//     const data = await authApiCall('/ai/api/settings/database');
//     const settings = data.settings;
    
//     document.getElementById('dbUser').value = settings.username || '';
    
//     // Walletアップロード状況を表示
//     if (settings.wallet_uploaded) {
//       const walletStatus = document.getElementById('walletStatus');
//       walletStatus.style.display = 'block';
//       walletStatus.innerHTML = '<span class="text-green-600">✅ Walletアップロード済み</span>';
      
//       // 利用可能なDSNを表示
//       if (settings.available_services && settings.available_services.length > 0) {
//         const dsnDisplay = document.getElementById('dsnDisplay');
//         const dsnSelect = document.getElementById('dbDsn');
//         dsnDisplay.style.display = 'block';
        
//         dsnSelect.innerHTML = '<option value="">選択してください</option>';
//         settings.available_services.forEach(dsn => {
//           const option = document.createElement('option');
//           option.value = dsn;
//           option.textContent = dsn;
//           if (dsn === settings.dsn) {
//             option.selected = true;
//           }
//           dsnSelect.appendChild(option);
//         });
//       }
//     }
    
//     const statusBadge = document.getElementById('dbConnectionStatusBadge');
//     if (data.is_connected) {
//       statusBadge.textContent = '接続済み';
//       statusBadge.style.background = '#10b981';
//       statusBadge.style.color = '#fff';
//     } else {
//       statusBadge.textContent = '未設定';
//       statusBadge.style.background = '#e2e8f0';
//       statusBadge.style.color = '#64748b';
//     }
    
//   } catch (error) {
//     console.error('DB設定読み込みエラー:', error);
//     // エラーを再スローしてswitchTabでキャッチさせる（トーストは表示しない）
//     throw error;
//   }
// }

// async function refreshDbConnectionFromEnv() {
//   try {
//     utilsShowLoading('接続設定を再取得中...');
    
//     // 環境変数から情報を取得
//     const envData = await authApiCall('/ai/api/settings/database/env');
    
//     if (!envData.success) {
//       utilsHideLoading();
//       utilsShowToast(envData.message, 'error');
//       return;
//     }
    
//     // ユーザー名を設定
//     if (envData.username) {
//       document.getElementById('dbUser').value = envData.username;
//     }
    
//     // Wallet情報を表示
//     const walletStatus = document.getElementById('walletStatus');
//     if (envData.wallet_exists) {
//       walletStatus.style.display = 'block';
//       walletStatus.innerHTML = '<span class="text-green-600">✅ Wallet検出済み (' + envData.wallet_location + ')</span>';
      
//       // 利用可能なDSNを表示
//       if (envData.available_services && envData.available_services.length > 0) {
//         const dsnDisplay = document.getElementById('dsnDisplay');
//         const dsnSelect = document.getElementById('dbDsn');
//         dsnDisplay.style.display = 'block';
        
//         dsnSelect.innerHTML = '<option value="">選択してください</option>';
//         envData.available_services.forEach(dsn => {
//           const option = document.createElement('option');
//           option.value = dsn;
//           option.textContent = dsn;
//           // 環境変数のDSNを選択
//           if (dsn === envData.dsn) {
//             option.selected = true;
//           }
//           dsnSelect.appendChild(option);
//         });
//       }
//     } else {
//       walletStatus.style.display = 'block';
//       // ダウンロードエラーがあれば表示
//       if (envData.download_error) {
//         walletStatus.innerHTML = '<span class="text-red-600">❌ Wallet自動ダウンロード失敗: ' + envData.download_error + '</span><br><span class="text-gray-600">手動でZIPファイルをアップロードしてください。</span>';
//       } else {
//         walletStatus.innerHTML = '<span class="text-yellow-600">⚠️ Walletが見つかりません。ZIPファイルをアップロードしてください。</span>';
//       }
//     }
    
//     // ステータスバッジを更新（設定ファイルの有無で判定、実際の接続確認はしない）
//     const statusBadge = document.getElementById('dbConnectionStatusBadge');
    
//     if (envData.username && envData.dsn && envData.wallet_exists) {
//       statusBadge.textContent = '設定済み';
//       statusBadge.style.background = '#10b981';
//       statusBadge.style.color = '#fff';
//     } else {
//       statusBadge.textContent = '未設定';
//       statusBadge.style.background = '#e2e8f0';
//       statusBadge.style.color = '#64748b';
//     }
    
//     utilsHideLoading();
//     utilsShowToast('接続設定を再取得しました', 'success');
    
//   } catch (error) {
//     utilsHideLoading();
//     utilsShowToast(`接続設定再取得エラー: ${error.message}`, 'error');
//   }
// }

// グローバルスコープに公開
window.refreshDbConnectionFromEnv = refreshDbConnectionFromEnv;

// /**
//  * DB設定再読み込み(リトライ機能)
//  */
// window.retryLoadDbSettings = async function() {
//   try {
//     // 警告メッセージを削除
//     const alerts = document.querySelectorAll('#tab-database > .bg-yellow-50');
//     alerts.forEach(alert => alert.remove());
    
//     utilsShowLoading('データベース設定を再読み込み中...');
    
//     await loadDbConnectionSettings();
    
//     // ADB OCIDのみを自動取得
//     try {
//       await loadAdbOcidOnly();
//     } catch (error) {
//       console.warn('ADB OCID取得エラー（スキップ）:', error);
//     }
    
//     // .envからDB接続情報を自動取得
//     try {
//       await loadDbConnectionInfoFromEnv();
//     } catch (error) {
//       console.warn('DB接続情報取得エラー（スキップ）:', error);
//     }
    
//     utilsHideLoading();
//     utilsShowToast('データベース設定を読み込みました', 'success');
//   } catch (error) {
//     utilsHideLoading();
    
//     if (error.message.includes('タイムアウト')) {
//       utilsShowToast('まだデータベースが起動していません。もう一度お試しください。', 'warning');
      
//       // 警告メッセージを再表示
//       const dbContent = document.getElementById('tab-database');
//       if (dbContent && !dbContent.querySelector('.bg-yellow-50')) {
//         const retryHtml = `
//           <div class="bg-yellow-50 border-l-4 border-yellow-400 p-4 mb-4" role="alert">
//             <div class="flex items-start">
//               <div class="flex-shrink-0">
//                 <svg class="h-5 w-5 text-yellow-400" viewBox="0 0 20 20" fill="currentColor">
//                   <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd" />
//                 </svg>
//               </div>
//               <div class="ml-3 flex-1">
//                 <p class="text-sm text-yellow-700">
//                   データベース設定の読み込みに失敗しました。データベースが起動していない可能性があります。
//                 </p>
//                 <p class="mt-2 text-sm text-yellow-700">
//                   データベースを起動してから、下のボタンをクリックして再読み込みしてください。
//                 </p>
//                 <div class="mt-3">
//                   <button 
//                     onclick="window.retryLoadDbSettings()" 
//                     class="bg-yellow-500 hover:bg-yellow-600 text-white px-4 py-2 rounded transition-colors"
//                   >
//                     🔄 再読み込み
//                   </button>
//                 </div>
//               </div>
//             </div>
//           </div>
//         `;
//         dbContent.insertAdjacentHTML('afterbegin', retryHtml);
//       }
//     } else {
//       utilsShowToast(`再読み込みエラー: ${error.message}`, 'error');
//     }
//   }
// };

// let selectedWalletFile = null;

// function handleWalletFileSelect(event) {
//   const file = event.target.files[0];
//   if (!file) return;
  
//   if (!file.name.toLowerCase().endsWith('.zip')) {
//     utilsShowToast('ZIPファイルを選択してください', 'error');
//     return;
//   }
  
//   selectedWalletFile = file;
//   const fileNameDiv = document.getElementById('walletFileName');
//   fileNameDiv.style.display = 'block';
//   fileNameDiv.textContent = `選択されたファイル: ${file.name}`;
  
//   // Walletを自動アップロード
//   uploadWalletFile(file);
// }

// async function uploadWalletFile(file) {
//   try {
//     utilsShowLoading('Walletをアップロード中...');
    
//     const formData = new FormData();
//     formData.append('file', file);
    
//     const headers = {};
//     if (loginToken) {
//       headers['Authorization'] = `Bearer ${loginToken}`;
//     }
    
//     const response = await fetch(API_BASE ? `${API_BASE}/api/settings/database/wallet` : '/ai/api/settings/database/wallet', {
//       method: 'POST',
//       headers: headers,
//       body: formData
//     });
    
//     utilsHideLoading();
    
//     if (!response.ok) {
//       const error = await response.json();
//       throw new Error(error.detail || 'Walletアップロードに失敗しました');
//     }
    
//     const data = await response.json();
    
//     if (data.success) {
//       const walletStatus = document.getElementById('walletStatus');
//       walletStatus.style.display = 'block';
//       walletStatus.innerHTML = '<span class="text-green-600">✅ Walletアップロード成功</span>';
      
//       utilsShowToast(data.message, 'success');
      
//       // 利用可能なDSNを表示
//       if (data.available_services && data.available_services.length > 0) {
//         const dsnDisplay = document.getElementById('dsnDisplay');
//         const dsnSelect = document.getElementById('dbDsn');
//         dsnDisplay.style.display = 'block';
        
//         dsnSelect.innerHTML = '<option value="">選択してください</option>';
//         data.available_services.forEach(dsn => {
//           const option = document.createElement('option');
//           option.value = dsn;
//           option.textContent = dsn;
//           dsnSelect.appendChild(option);
//         });
//       }
//     }
    
//   } catch (error) {
//     utilsHideLoading();
//     utilsShowToast(`Walletアップロードエラー: ${error.message}`, 'error');
    
//     const walletStatus = document.getElementById('walletStatus');
//     walletStatus.style.display = 'block';
//     walletStatus.innerHTML = `<span class="text-red-600">❌ ${error.message}</span>`;
//   }
// }

// async function saveDbConnection() {
//   const username = document.getElementById('dbUser').value.trim();
//   const password = document.getElementById('dbPassword').value;
//   const dsn = document.getElementById('dbDsn').value;
  
//   if (!username || !password) {
//     utilsShowToast('ユーザー名とパスワードを入力してください', 'warning');
//     return;
//   }
  
//   if (!dsn) {
//     utilsShowToast('サービス名/DSNを選択してください', 'warning');
//     return;
//   }
  
//   const settings = {
//     username: username,
//     password: password,
//     dsn: dsn
//   };
  
//   try {
//     utilsShowLoading('DB設定を保存中...');
    
//     await authApiCall('/ai/api/settings/database', {
//       method: 'POST',
//       headers: { 'Content-Type': 'application/json' },
//       body: JSON.stringify(settings)
//     });
    
//     utilsHideLoading();
//     utilsShowToast('DB設定を保存しました', 'success');
    
//     await loadDbConnectionSettings();
    
//   } catch (error) {
//     utilsHideLoading();
//     utilsShowToast(`保存エラー: ${error.message}`, 'error');
//   }
// }

// async function testDbConnection() {
//   try {
//     // パスワードフィールドを取得
//     const passwordField = document.getElementById('dbPassword');
    
//     // 少し待ってから値を取得（スクロール防止のためfocus/blurは削除）
//     await new Promise(resolve => setTimeout(resolve, 100));
    
//     // 入力されている値を取得（保存前でもテストできるように）
//     const username = document.getElementById('dbUser').value.trim();
//     let password = passwordField.value;
//     const dsn = document.getElementById('dbDsn').value;
    
//     // パスワードが入力されていない場合、環境変数から取得
//     if (!password) {
//       utilsShowLoading('環境変数からパスワードを取得中...');
//       try {
//         const envData = await authApiCall('/ai/api/settings/database/env?include_password=true');
//         if (envData.success && envData.password && envData.password !== '[CONFIGURED]') {
//           password = envData.password;
//         }
//         utilsHideLoading();
//       } catch (error) {
//         utilsHideLoading();
//         // console.warn('環境変数からパスワード取得エラー:', error);
//       }
//     }
    
//     // デバッグログ
//     // デバッグ情報（本番環境ではコメントアウト）
//     // console.log('=== 接続テスト情報 ===');
//     // console.log('Username:', username);
//     // console.log('Password length:', password ? password.length : 0);
//     // console.log('DSN:', dsn);
//     // console.log('Password exists:', !!password);
//     // console.log('Password from env:', !passwordField.value && !!password);
//     // console.log('=====================');
    
//     // 入力チェック
//     if (!username || !password || !dsn) {
//       utilsShowToast('ユーザー名、パスワード、DSNを入力してください', 'warning');
//       return;
//     }
    
//     utilsShowLoading('接続テスト中...');
    
//     const requestBody = {
//       settings: {
//         username: username,
//         password: password,
//         dsn: dsn
//       }
//     };
    
//     // console.log('Request body:', JSON.stringify({...requestBody, settings: {...requestBody.settings, password: '[HIDDEN]'}}));
    
//     // タイムアウト処理を追加（20秒）- バックエンド側も15秒でタイムアウトする
//     const timeoutPromise = new Promise((_, reject) => 
//       setTimeout(() => reject(new Error('接続テストがタイムアウトしました（20秒）')), 20000)
//     );
    
//     const apiPromise = authApiCall('/ai/api/settings/database/test', {
//       method: 'POST',
//       headers: { 'Content-Type': 'application/json' },
//       body: JSON.stringify(requestBody)
//     });
    
//     const data = await Promise.race([apiPromise, timeoutPromise]);
    
//     utilsHideLoading();
    
//     if (data.success) {
//       utilsShowToast(data.message, 'success');
      
//       // 接続成功時、DB情報を自動読み込み
//       // await loadDbInfo();
//     } else {
//       utilsShowToast(data.message, 'error');
//     }
    
//   } catch (error) {
//     utilsHideLoading();
//     utilsShowToast(`接続テストエラー: ${error.message}`, 'error');
//   }
// }

// async function loadDbInfo() {
//   try {
//     utilsShowLoading('データベース情報を取得中...');
    
//     const data = await authApiCall('/ai/api/database/info');
    
//     utilsHideLoading();
    
//     const infoDiv = document.getElementById('dbInfoContent');
//     const statusBadge = document.getElementById('dbInfoStatusBadge');
    
//     if (!data.info) {
//       infoDiv.innerHTML = `
//         <div style="text-align: center; padding: 40px; color: #64748b;">
//           <div style="font-size: 48px; margin-bottom: 16px;">🗄️</div>
//           <div style="font-size: 16px; font-weight: 500;">データベースに接続してください</div>
//           <div style="font-size: 14px; margin-top: 8px;">接続後、データベース情報が表示されます</div>
//         </div>
//       `;
//       if (statusBadge) {
//         statusBadge.textContent = '未取得';
//         statusBadge.style.background = '#e2e8f0';
//         statusBadge.style.color = '#64748b';
//       }
//       return;
//     }
    
//     // ステータスバッジを更新
//     if (statusBadge) {
//       statusBadge.textContent = '取得済み';
//       statusBadge.style.background = '#10b981';
//       statusBadge.style.color = '#fff';
//     }
    
//     const info = data.info;
//     infoDiv.innerHTML = `
//       <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px;">
//         <div class="card">
//           <div class="card-body">
//             <div style="font-size: 13px; color: #64748b; margin-bottom: 4px;">データベースバージョン</div>
//             <div style="font-size: 16px; font-weight: 600; color: #1e293b;">${info.version || '-'}</div>
//           </div>
//         </div>
        
//         <div class="card">
//           <div class="card-body">
//             <div style="font-size: 13px; color: #64748b; margin-bottom: 4px;">接続ユーザー</div>
//             <div style="font-size: 16px; font-weight: 600; color: #1e293b;">${info.current_user || '-'}</div>
//           </div>
//         </div>
        
//         <div class="card">
//           <div class="card-body">
//             <div style="font-size: 13px; color: #64748b; margin-bottom: 4px;">インスタンス名</div>
//             <div style="font-size: 16px; font-weight: 600; color: #1e293b;">${info.instance_name || '-'}</div>
//           </div>
//         </div>
        
//         <div class="card">
//           <div class="card-body">
//             <div style="font-size: 13px; color: #64748b; margin-bottom: 4px;">データベース名</div>
//             <div style="font-size: 16px; font-weight: 600; color: #1e293b;">${info.database_name || '-'}</div>
//           </div>
//         </div>
//       </div>
//     `;
    
//   } catch (error) {
//     utilsHideLoading();
//     utilsShowToast(`データベース情報取得エラー: ${error.message}`, 'error');
//   }
// }

// async function loadDbTables() {
//   try {
//     utilsShowLoading('テーブル一覧を取得中...');
    
//     // ページングパラメータ付きでAPIを呼び出し
//     const data = await authApiCall(`/ai/api/database/tables?page=${dbTablesPage}&page_size=${dbTablesPageSize}`);
    
//     utilsHideLoading();
    
//     // 総ページ数を保存
//     dbTablesTotalPages = data.total_pages || 1;
    
//     // '$'を含むテーブルをフィルタリング（バックエンドでも処理済みだが、念のため）
//     const filteredTables = (data.tables || []).filter(t => !t.table_name.includes('$'));
    
//     // 現在ページのテーブル一覧を保存（チェック用）
//     currentPageDbTables = filteredTables.map(t => t.table_name);
    
//     const tablesDiv = document.getElementById('dbTablesContent');
//     const statusBadge = document.getElementById('dbTablesStatusBadge');
    
//     if (!filteredTables || filteredTables.length === 0) {
//       currentPageDbTables = [];
//       tablesDiv.innerHTML = `
//         <div style="text-align: center; padding: 40px; color: #64748b;">
//           <div style="font-size: 48px; margin-bottom: 16px;">📋</div>
//           <div style="font-size: 16px; font-weight: 500;">テーブル情報なし</div>
//           <div style="font-size: 14px; margin-top: 8px;">データベースに接続後、テーブル一覧が表示されます</div>
//         </div>
//       `;
//       if (statusBadge) {
//         statusBadge.textContent = '未取得';
//         statusBadge.style.background = '#e2e8f0';
//         statusBadge.style.color = '#64748b';
//       }
//       return;
//     }
    
//     // ステータスバッジを更新（総件数を表示）
//     if (statusBadge) {
//       statusBadge.textContent = `${data.total}件`;
//       statusBadge.style.background = '#10b981';
//       statusBadge.style.color = '#fff';
//     }
    
//     // ヘッダーチェックボックスの状態を判定
//     const allPageSelected = currentPageDbTables.length > 0 && 
//                             currentPageDbTables.every(t => selectedDbTables.includes(t));
    
//     // 選択操作ボタンHTML
//     const selectionButtonsHtml = `
//       <div class="flex items-center justify-between mb-3">
//         <div class="flex gap-2">
//           <button onclick="selectAllDbTables()" class="px-2 py-1 border rounded text-xs hover:bg-gray-100 ${dbTablesBatchDeleteLoading ? 'opacity-50 cursor-not-allowed' : ''}" ${dbTablesBatchDeleteLoading ? 'disabled' : ''}>すべて選択</button>
//           <button onclick="clearAllDbTables()" class="px-2 py-1 border rounded text-xs hover:bg-gray-100 ${dbTablesBatchDeleteLoading ? 'opacity-50 cursor-not-allowed' : ''}" ${dbTablesBatchDeleteLoading ? 'disabled' : ''}>すべて解除</button>
//           <button onclick="deleteSelectedDbTables()" class="px-2 py-1 text-xs rounded border border-red-300 text-red-600 hover:bg-red-50 ${(selectedDbTables.length === 0 || dbTablesBatchDeleteLoading) ? 'opacity-40 cursor-not-allowed' : ''}" ${(selectedDbTables.length === 0 || dbTablesBatchDeleteLoading) ? 'disabled' : ''}>
//             ${dbTablesBatchDeleteLoading ? '<span class="spinner spinner-sm"></span> 処理中...' : `削除 (${selectedDbTables.length})`}
//           </button>
//         </div>
//       </div>
//     `;
    
//     // ページネーションUI生成
//     const paginationHtml = UIComponents.renderPagination({
//       currentPage: data.current_page,
//       totalPages: data.total_pages,
//       totalItems: data.total,
//       startNum: data.start_row,
//       endNum: data.end_row,
//       onPrevClick: 'handleDbTablesPrevPage()',
//       onNextClick: 'handleDbTablesNextPage()',
//       onJumpClick: 'handleDbTablesJumpPage',
//       inputId: 'dbTablesPageInput',
//       disabled: dbTablesBatchDeleteLoading
//     });
    
//     tablesDiv.innerHTML = `
//       <div>
//         ${selectionButtonsHtml}
//         ${paginationHtml}
//         <div class="table-wrapper-scrollable">
//           <table class="data-table">
//             <thead>
//               <tr>
//                 <th style="width: 40px;"><input type="checkbox" id="dbTablesHeaderCheckbox" onchange="toggleSelectAllDbTables(this.checked)" ${allPageSelected ? 'checked' : ''} class="w-4 h-4 rounded" ${dbTablesBatchDeleteLoading ? 'disabled' : ''}></th>
//                 <th>テーブル名</th>
//                 <th>行数</th>
//                 <th>作成日時</th>
//                 <th>最終更新</th>
//                 <th>コメント</th>
//                 <th style="width: 100px;">操作</th>
//               </tr>
//             </thead>
//             <tbody>
//               ${filteredTables.map(table => {
//                 const isSelected = selectedTableForPreview === table.table_name;
//                 // テーブル名をJavaScript文字列としてエスケープ（シングルクォート対応）
//                 const escapedTableName = table.table_name.replace(/'/g, "\\'");
//                 return `
//                 <tr>
//                   <td><input type="checkbox" onchange="toggleDbTableSelection('${escapedTableName}')" ${selectedDbTables.includes(table.table_name) ? 'checked' : ''} class="w-4 h-4 rounded" ${dbTablesBatchDeleteLoading ? 'disabled' : ''}></td>
//                   <td style="font-weight: 500; font-family: monospace;">${table.table_name}</td>
//                   <td>${table.num_rows !== null ? table.num_rows.toLocaleString() : '-'}</td>
//                   <td>${table.created ? utilsFormatDateTime(table.created) : '-'}</td>
//                   <td>${table.last_analyzed ? utilsFormatDateTime(table.last_analyzed) : '-'}</td>
//                   <td style="max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
//                     ${table.comments || '-'}
//                   </td>
//                   <td>
//                     <button 
//                       onclick="toggleTablePreview('${escapedTableName}')" 
//                       class="px-2 py-1 text-xs rounded ${isSelected ? 'bg-blue-500 text-white' : 'border border-blue-300 text-blue-600 hover:bg-blue-50'}" 
//                       ${dbTablesBatchDeleteLoading ? 'disabled' : ''}>
//                       ${isSelected ? '選択中' : '選択'}
//                     </button>
//                   </td>
//                 </tr>
//               `}).join('')}
//             </tbody>
//           </table>
//         </div>
//       </div>
//     `;
    
//   } catch (error) {
//     utilsHideLoading();
//     utilsShowToast(`テーブル一覧取得エラー: ${error.message}`, 'error');
//   }
// }

// // テーブルプレビューのトグル
// async function toggleTablePreview(tableName) {
//   // スクロール位置を保存
//   const scrollableArea = document.querySelector('#dbTablesContent .table-wrapper-scrollable');
//   const scrollTop = scrollableArea ? scrollableArea.scrollTop : 0;
  
//   if (selectedTableForPreview === tableName) {
//     // 選択解除
//     selectedTableForPreview = null;
//     hideTablePreview();
//     await loadDbTables();  // テーブル一覧を更新してボタン表示を切り替え
//   } else {
//     // 新しいテーブルを選択
//     selectedTableForPreview = tableName;
//     tableDataPage = 1;  // ページをリセット
//     await loadDbTables();  // テーブル一覧を更新してボタン表示を切り替え
//     await loadTableData(tableName);
//   }
  
//   // スクロール位置を復元
//   const scrollableAreaAfter = document.querySelector('#dbTablesContent .table-wrapper-scrollable');
//   if (scrollableAreaAfter) {
//     requestAnimationFrame(() => {
//       scrollableAreaAfter.scrollTop = scrollTop;
//     });
//   }
// }

// // テーブルデータを読み込む
// async function loadTableData(tableName) {
//   try {
//     utilsShowLoading(`テーブル ${tableName} のデータを読み込み中...`);
    
//     const data = await authApiCall(`/ai/api/database/tables/${encodeURIComponent(tableName)}/data?page=${tableDataPage}&page_size=${tableDataPageSize}`);
    
//     utilsHideLoading();
    
//     if (!data.success) {
//       // エラーメッセージを明確に表示
//       utilsShowToast(data.message || 'データ取得に失敗しました', 'error');
//       showTablePreview(tableName, [], [], 0, data);
//       return;
//     }
    
//     if (!data.rows || data.rows.length === 0) {
//       // データが空の場合
//       showTablePreview(tableName, [], [], 0, data);
//       return;
//     }
    
//     tableDataTotalPages = data.total_pages || 1;
    
//     showTablePreview(tableName, data.columns, data.rows, data.total, data);
    
//   } catch (error) {
//     utilsHideLoading();
//     utilsShowToast(`データ取得エラー: ${error.message}`, 'error');
//     // エラー時もプレビューを非表示にする
//     hideTablePreview();
//     selectedTableForPreview = null;
//     await loadDbTables();
//   }
// }

// // HTMLエスケープ関数
// function escapeHtml(text) {
//   if (text === null || text === undefined) return '-';
  
//   let str = String(text);
  
//   // BLOB/LOBデータの判定：配列形式、BLOBタグ、LOBタグ、または500文字以上の長いデータ
//   const isBlobLike = str.startsWith('array([') || 
//                      str.startsWith('array("[') ||
//                      str.startsWith('<BLOB:') || 
//                      str.startsWith('<LOB:') ||
//                      str.length > 500;
  
//   if (isBlobLike) {
//     // BLOB/LOB類データは100文字に制限
//     if (str.length > 100) {
//       str = str.substring(0, 100) + '...';
//     }
//   }
  
//   const div = document.createElement('div');
//   div.textContent = str;
//   return div.innerHTML;
// }

// // テーブルプレビューを表示
// function showTablePreview(tableName, columns, rows, total, paginationData) {
//   let previewDiv = document.getElementById('tableDataPreview');
  
//   if (!previewDiv) {
//     console.error('tableDataPreview element not found');
//     return;
//   }
  
//   // プレビューDivを表示
//   previewDiv.style.display = 'block';
  
//   if (rows.length === 0) {
//     previewDiv.innerHTML = `
//       <div class="apex-region-header">
//         📋 ${escapeHtml(tableName)} - データプレビュー
//         <div style="display: flex; align-items: center; gap: 8px;">
//           <button class="apex-button-secondary apex-button-xs" onclick="refreshTableData()">
//             🔄 再取得
//           </button>
//           <span class="px-2 py-1 text-xs font-semibold rounded-md" style="background: #e2e8f0; color: #64748b;">
//             0件
//           </span>
//         </div>
//       </div>
//       <div style="padding: 24px;">
//         <div style="text-align: center; padding: 40px; color: #64748b;">
//           <div style="font-size: 48px; margin-bottom: 16px;">📋</div>
//           <div style="font-size: 16px; font-weight: 500;">データがありません</div>
//           <div style="font-size: 14px; margin-top: 8px;">テーブル ${escapeHtml(tableName)} にデータがありません</div>
//         </div>
//       </div>
//     `;
//     return;
//   }
  
//   // paginationDataのnullチェックとデフォルト値設定
//   const safePageData = paginationData || {
//     current_page: 1,
//     total_pages: 1,
//     total: total,
//     start_row: 1,
//     end_row: rows.length
//   };
  
//   // 現在ページの行を一意に識別する（最初の列を識別子として使用）
//   // ※ どのテーブルでも対応できるよう、特定の列名に依存しない汎用的な処理
//   currentPageTableDataRows = rows.map((row, index) => {
//     if (columns.length > 0 && row.length > 0) {
//       // 最初の列の値を識別子として使用（通常は主キー）
//       const primaryValue = row[0];
//       // ページ番号とインデックスを組み合わせてグローバルに一意にする
//       return `${safePageData.current_page}_${index}_${primaryValue}`;
//     } else {
//       // データがない場合は行インデックスのみ使用
//       return `${safePageData.current_page}_${index}`;
//     }
//   });
  
//   // ヘッダーチェックボックスの状態を判定
//   const allPageSelected = currentPageTableDataRows.length > 0 && 
//                           currentPageTableDataRows.every(i => selectedTableDataRows.includes(i));
  
//   // 選択操作ボタンHTML（テーブル一覧と同じスタイル）
//   const selectionButtonsHtml = `
//     <div class="flex items-center justify-between mb-3">
//       <div class="flex gap-2">
//         <button onclick="selectAllTableData()" class="px-2 py-1 border rounded text-xs hover:bg-gray-100">すべて選択</button>
//         <button onclick="clearAllTableData()" class="px-2 py-1 border rounded text-xs hover:bg-gray-100">すべて解除</button>
//         <button onclick="deleteSelectedTableData()" class="px-2 py-1 text-xs rounded border border-red-300 text-red-600 hover:bg-red-50 ${selectedTableDataRows.length === 0 ? 'opacity-40 cursor-not-allowed' : ''}" ${selectedTableDataRows.length === 0 ? 'disabled' : ''}>
//           削除 (${selectedTableDataRows.length})
//         </button>
//       </div>
//     </div>
//   `;
  
//   // ページネーションUI生成
//   const paginationHtml = UIComponents.renderPagination({
//     currentPage: safePageData.current_page,
//     totalPages: safePageData.total_pages,
//     totalItems: safePageData.total,
//     startNum: safePageData.start_row,
//     endNum: safePageData.end_row,
//     onPrevClick: 'handleTableDataPrevPage()',
//     onNextClick: 'handleTableDataNextPage()',
//     onJumpClick: 'handleTableDataJumpPage',
//     inputId: 'tableDataPageInput'
//   });
  
//   previewDiv.innerHTML = `
//     <div class="apex-region-header">
//       📋 ${escapeHtml(tableName)} - データプレビュー
//       <div style="display: flex; align-items: center; gap: 8px;">
//         <button class="apex-button-secondary apex-button-xs" onclick="refreshTableData()">
//           🔄 再取得
//         </button>
//         <span class="px-2 py-1 text-xs font-semibold rounded-md" style="background: #dcfce7; color: #166534;">
//           ${total}件
//         </span>
//       </div>
//     </div>
//     <div style="padding: 24px;">
//       ${selectionButtonsHtml}
//       ${paginationHtml}
//       <div class="table-wrapper-scrollable">
//         <table class="data-table">
//           <thead>
//             <tr>
//               <th style="width: 40px;"><input type="checkbox" id="tableDataHeaderCheckbox" onchange="toggleSelectAllTableData(this.checked)" ${allPageSelected ? 'checked' : ''} class="w-4 h-4 rounded"></th>
//               ${columns.map(col => `<th>${escapeHtml(col)}</th>`).join('')}
//             </tr>
//           </thead>
//           <tbody>
//             ${rows.map((row, index) => {
//               // 行を一意に識別する（currentPageTableDataRowsと同じロジック）
//               let rowId;
//               if (columns.length > 0 && row.length > 0) {
//                 const primaryValue = row[0];
//                 rowId = `${safePageData.current_page}_${index}_${primaryValue}`;
//               } else {
//                 rowId = `${safePageData.current_page}_${index}`;
//               }
//               const isChecked = selectedTableDataRows.includes(rowId);
//               // HTMLエスケープしたrowIdを使用
//               const escapedRowId = rowId.replace(/'/g, "&#39;").replace(/"/g, "&quot;");
//               return `
//               <tr>
//                 <td><input type="checkbox" onchange="toggleTableDataRowSelection('${escapedRowId}')" ${isChecked ? 'checked' : ''} class="w-4 h-4 rounded"></td>
//                 ${row.map(cell => `<td>${escapeHtml(cell)}</td>`).join('')}
//               </tr>
//             `;
//             }).join('')}
//           </tbody>
//         </table>
//       </div>
//     </div>
//   `;
// }

// // テーブルプレビューを非表示
// function hideTablePreview() {
//   const previewDiv = document.getElementById('tableDataPreview');
//   if (previewDiv) {
//     previewDiv.style.display = 'none';
//     previewDiv.innerHTML = '';  // 内容もクリア
//   }
//   // 選択状態をクリア
//   selectedTableDataRows = [];
//   currentPageTableDataRows = [];
// }

// // テーブルデータを更新
// async function refreshTableData() {
//   if (selectedTableForPreview) {
//     tableDataPage = 1;
//     await loadTableData(selectedTableForPreview);
//   }
// }

// // テーブルデータページング - 前のページへ
// function handleTableDataPrevPage() {
//   if (tableDataPage > 1 && selectedTableForPreview) {
//     tableDataPage--;
//     loadTableData(selectedTableForPreview);
//   }
// }

// // テーブルデータページング - 次のページへ
// function handleTableDataNextPage() {
//   if (tableDataPage < tableDataTotalPages && selectedTableForPreview) {
//     tableDataPage++;
//     loadTableData(selectedTableForPreview);
//   }
// }

// // テーブルデータページング - ページジャンプ
// function handleTableDataJumpPage() {
//   const input = document.getElementById('tableDataPageInput');
//   if (!input) {
//     utilsShowToast('ページ入力エラー', 'error');
//     return;
//   }
  
//   const page = parseInt(input.value, 10);
  
//   // NaNチェックを追加
//   if (isNaN(page)) {
//     utilsShowToast('有効な数値を入力してください', 'error');
//     input.value = tableDataPage;
//     return;
//   }
  
//   if (page >= 1 && page <= tableDataTotalPages && selectedTableForPreview) {
//     tableDataPage = page;
//     loadTableData(selectedTableForPreview);
//   } else {
//     utilsShowToast('無効なページ番号です', 'error');
//     input.value = tableDataPage;
//   }
// }

// // プレースホルダー関数（将来の機能拡張用）
// function selectAllTableData() {
//   toggleSelectAllTableData(true);
//   // ヘッダーチェックボックスを更新
//   const headerCheckbox = document.getElementById('tableDataHeaderCheckbox');
//   if (headerCheckbox) headerCheckbox.checked = true;
// }

// function clearAllTableData() {
//   selectedTableDataRows = [];
//   // ヘッダーチェックボックスを更新
//   const headerCheckbox = document.getElementById('tableDataHeaderCheckbox');
//   if (headerCheckbox) headerCheckbox.checked = false;
  
//   // UIを更新
//   if (selectedTableForPreview) {
//     loadTableData(selectedTableForPreview);
//   }
// }

// function deleteSelectedTableData() {
//   if (selectedTableDataRows.length === 0) {
//     utilsShowToast('削除するデータを選択してください', 'warning');
//     return;
//   }
  
//   const count = selectedTableDataRows.length;
  
//   // 確認モーダルを表示
//   window.UIComponents.showModal({
//     title: 'レコード削除の確認',
//     content: `選択された${count}件のレコードを削除しますか？\n\n※テーブル「${selectedTableForPreview}」から直接削除されます。\n※この操作は元に戻せません。`,
//     confirmText: '削除',
//     cancelText: 'キャンセル',
//     variant: 'danger',
//     onConfirm: async () => {
//       try {
//         utilsShowLoading('レコードを削除中...');
        
//         // 選択された行の主キー値を抽出（rowIdから最後の部分を取得）
//         const primaryKeyValues = selectedTableDataRows.map(rowId => {
//           // rowId形式: "page_index_primaryValue"
//           const parts = rowId.split('_');
//           return parts.length >= 3 ? parts.slice(2).join('_') : parts[parts.length - 1];
//         });
        
//         // 汎用的な削除APIを呼び出す
//         const response = await authApiCall(`/ai/api/database/tables/${encodeURIComponent(selectedTableForPreview)}/delete`, {
//           method: 'POST',
//           headers: { 'Content-Type': 'application/json' },
//           body: JSON.stringify({ primary_keys: primaryKeyValues })
//         });
        
//         utilsHideLoading();
        
//         if (response.success) {
//           utilsShowToast(`${response.deleted_count}件のレコードを削除しました`, 'success');
//           // 選択をクリア
//           selectedTableDataRows = [];
//           // ページを1にリセット
//           tableDataPage = 1;
//           // テーブルデータを再読み込み
//           loadTableData(selectedTableForPreview);
//         } else {
//           const errMsg = response.errors && response.errors.length > 0 
//             ? response.errors.join(', ') 
//             : response.message || '不明なエラー';
//           utilsShowToast(`削除エラー: ${errMsg}`, 'error');
//         }
//       } catch (error) {
//         utilsHideLoading();
//         utilsShowToast(`削除エラー: ${error.message}`, 'error');
//       }
//     }
//   });
// }

// // テーブルデータ - 個別チェックボックス切り替え
// function toggleTableDataRowSelection(rowId) {
//   // HTMLエスケープされた値をデコード
//   const decodedRowId = rowId.replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  
//   // スクロール位置を保存
//   const scrollableArea = document.querySelector('#tableDataPreview .table-wrapper-scrollable');
//   const scrollTop = scrollableArea ? scrollableArea.scrollTop : 0;
  
//   // 文字列に統一
//   const rowIdStr = String(decodedRowId);
//   const index = selectedTableDataRows.indexOf(rowIdStr);
//   if (index > -1) {
//     selectedTableDataRows.splice(index, 1);
//   } else {
//     selectedTableDataRows.push(rowIdStr);
//   }
  
//   // UIを更新
//   if (selectedTableForPreview) {
//     loadTableData(selectedTableForPreview).then(() => {
//       // スクロール位置を復元
//       const scrollableAreaAfter = document.querySelector('#tableDataPreview .table-wrapper-scrollable');
//       if (scrollableAreaAfter) {
//         requestAnimationFrame(() => {
//           scrollableAreaAfter.scrollTop = scrollTop;
//         });
//       }
//     });
//   }
// }

// // テーブルデータ - ヘッダーチェックボックス切り替え（現在ページ全選択/解除）
// function toggleSelectAllTableData(checked) {
//   // スクロール位置を保存
//   const scrollableArea = document.querySelector('#tableDataPreview .table-wrapper-scrollable');
//   const scrollTop = scrollableArea ? scrollableArea.scrollTop : 0;
  
//   if (checked) {
//     // 現在ページのすべてを選択に追加
//     currentPageTableDataRows.forEach(rowId => {
//       if (!selectedTableDataRows.includes(rowId)) {
//         selectedTableDataRows.push(rowId);
//       }
//     });
//   } else {
//     // 現在ページのすべてを選択から除外
//     currentPageTableDataRows.forEach(rowId => {
//       const index = selectedTableDataRows.indexOf(rowId);
//       if (index > -1) {
//         selectedTableDataRows.splice(index, 1);
//       }
//     });
//   }
  
//   // UIを更新
//   if (selectedTableForPreview) {
//     loadTableData(selectedTableForPreview).then(() => {
//       // スクロール位置を復元
//       const scrollableAreaAfter = document.querySelector('#tableDataPreview .table-wrapper-scrollable');
//       if (scrollableAreaAfter) {
//         requestAnimationFrame(() => {
//           scrollableAreaAfter.scrollTop = scrollTop;
//         });
//       }
//     });
//   }
// }

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

// // テーブル一覧ページング - 前のページへ
// function handleDbTablesPrevPage() {
//   if (dbTablesPage > 1) {
//     dbTablesPage--;
//     loadDbTables();
//   }
// }

// // テーブル一覧ページング - 次のページへ
// function handleDbTablesNextPage() {
//   if (dbTablesPage < dbTablesTotalPages) {
//     dbTablesPage++;
//     loadDbTables();
//   }
// }

// // テーブル一覧ページング - ページジャンプ
// function handleDbTablesJumpPage() {
//   const input = document.getElementById('dbTablesPageInput');
//   if (!input) {
//     utilsShowToast('ページ入力エラー', 'error');
//     return;
//   }
  
//   const page = parseInt(input.value, 10);
  
//   // NaNチェックを追加
//   if (isNaN(page)) {
//     utilsShowToast('有効な数値を入力してください', 'error');
//     input.value = dbTablesPage;
//     return;
//   }
  
//   if (page >= 1 && page <= dbTablesTotalPages) {
//     dbTablesPage = page;
//     loadDbTables();
//   } else {
//     utilsShowToast('無効なページ番号です', 'error');
//     input.value = dbTablesPage;
//   }
// }

// // テーブル一覧 - 個別チェックボックス切り替え
// function toggleDbTableSelection(tableName) {
//   // スクロール位置を保存
//   const scrollableArea = document.querySelector('#dbTablesContent .table-wrapper-scrollable');
//   const scrollTop = scrollableArea ? scrollableArea.scrollTop : 0;
  
//   const index = selectedDbTables.indexOf(tableName);
//   if (index > -1) {
//     selectedDbTables.splice(index, 1);
//   } else {
//     selectedDbTables.push(tableName);
//   }
  
//   // UIを更新
//   loadDbTables().then(() => {
//     // スクロール位置を復元
//     const scrollableAreaAfter = document.querySelector('#dbTablesContent .table-wrapper-scrollable');
//     if (scrollableAreaAfter) {
//       requestAnimationFrame(() => {
//         scrollableAreaAfter.scrollTop = scrollTop;
//       });
//     }
//   });
// }

// // テーブル一覧 - ヘッダーチェックボックス切り替え（現在ページ全選択/解除）
// function toggleSelectAllDbTables(checked) {
//   // スクロール位置を保存
//   const scrollableArea = document.querySelector('#dbTablesContent .table-wrapper-scrollable');
//   const scrollTop = scrollableArea ? scrollableArea.scrollTop : 0;
  
//   if (checked) {
//     // 現在ページのすべてを選択に追加
//     currentPageDbTables.forEach(tableName => {
//       if (!selectedDbTables.includes(tableName)) {
//         selectedDbTables.push(tableName);
//       }
//     });
//   } else {
//     // 現在ページのすべてを選択から除外
//     currentPageDbTables.forEach(tableName => {
//       const index = selectedDbTables.indexOf(tableName);
//       if (index > -1) {
//         selectedDbTables.splice(index, 1);
//       }
//     });
//   }
  
//   // UIを更新
//   loadDbTables().then(() => {
//     // スクロール位置を復元
//     const scrollableAreaAfter = document.querySelector('#dbTablesContent .table-wrapper-scrollable');
//     if (scrollableAreaAfter) {
//       requestAnimationFrame(() => {
//         scrollableAreaAfter.scrollTop = scrollTop;
//       });
//     }
//   });
// }

// // テーブル一覧 - すべて選択
// function selectAllDbTables() {
//   toggleSelectAllDbTables(true);
//   // ヘッダーチェックボックスを更新
//   const headerCheckbox = document.getElementById('dbTablesHeaderCheckbox');
//   if (headerCheckbox) headerCheckbox.checked = true;
// }

// // テーブル一覧 - すべて解除
// function clearAllDbTables() {
//   // スクロール位置を保存
//   const scrollableArea = document.querySelector('#dbTablesContent .table-wrapper-scrollable');
//   const scrollTop = scrollableArea ? scrollableArea.scrollTop : 0;
  
//   selectedDbTables = [];
//   // ヘッダーチェックボックスを更新
//   const headerCheckbox = document.getElementById('dbTablesHeaderCheckbox');
//   if (headerCheckbox) headerCheckbox.checked = false;
  
//   // UIを更新
//   loadDbTables().then(() => {
//     // スクロール位置を復元
//     const scrollableAreaAfter = document.querySelector('#dbTablesContent .table-wrapper-scrollable');
//     if (scrollableAreaAfter) {
//       requestAnimationFrame(() => {
//         scrollableAreaAfter.scrollTop = scrollTop;
//       });
//     }
//   });
// }

// // テーブル一覧 - 選択されたテーブルを削除
// async function deleteSelectedDbTables() {
//   if (selectedDbTables.length === 0) {
//     utilsShowToast('削除するテーブルを選択してください', 'warning');
//     return;
//   }
  
//   const count = selectedDbTables.length;
//   const confirmed = await showConfirmModal(
//     `選択された${count}件のテーブルを削除しますか？\n\nこの操作は元に戻せません。`,
//     'テーブル削除の確認',
//     { variant: 'danger', confirmText: '削除' }
//   );
  
//   if (!confirmed) {
//     return;
//   }
  
//   // 処理中表示を設定
//   dbTablesBatchDeleteLoading = true;
//   loadDbTables();
  
//   try {
//     // 一括削除APIを呼び出す
//     const response = await authApiCall('/ai/api/database/tables/batch-delete', {
//       method: 'POST',
//       headers: { 'Content-Type': 'application/json' },
//       body: JSON.stringify({ table_names: selectedDbTables })
//     });
    
//     if (response.success) {
//       utilsShowToast(`${count}件のテーブルを削除しました`, 'success');
//       // 選択をクリア
//       selectedDbTables = [];
//       // ページを1にリセット
//       dbTablesPage = 1;
//     } else {
//       utilsShowToast(`削除エラー: ${response.message || '不明なエラー'}`, 'error');
//     }
//   } catch (error) {
//     utilsShowToast(`削除エラー: ${error.message}`, 'error');
//   } finally {
//     // 処理中表示を解除
//     dbTablesBatchDeleteLoading = false;
//     // テーブル一覧を再読み込み
//     loadDbTables();
//   }
// }

// // データベース情報再取得ボタン
// async function refreshDbInfo() {
//   try {
//     utilsShowLoading('データベース情報を再取得中...');
//     await loadDbInfo();
//     utilsHideLoading();
//   } catch (error) {
//     utilsHideLoading();
//     utilsShowToast(`再取得エラー: ${error.message}`, 'error');
//   }
// }

// // テーブル一覧再取得ボタン
// async function refreshDbTables() {
//   try {
//     utilsShowLoading('統計情報を再取得中...');
    
//     // 先に統計情報を更新
//     const statsResult = await authApiCall('/ai/api/database/tables/refresh-statistics', {
//       method: 'POST',
//       headers: {
//         'Content-Type': 'application/json'
//       }
//     });
    
//     // ページを1にリセット
//     dbTablesPage = 1;
    
//     // テーブル一覧を再読み込み
//     utilsShowLoading('テーブル一覧を再取得中...');
//     await loadDbTables();
//     utilsHideLoading();
    
//     // オーバーレイが非表示になった後にトーストを表示
//     if (!statsResult.success) {
//       utilsShowToast(`統計情報再取得エラー: ${statsResult.message}`, 'error');
//     } else {
//       utilsShowToast(statsResult.message, 'success');
//     }
//   } catch (error) {
//     utilsHideLoading();
//     utilsShowToast(`再取得エラー: ${error.message}`, 'error');
//   }
// }

// ストレージ情報を読み込み
async function loadDbStorage() {
  try {
    utilsShowLoading('ストレージ情報を取得中...');
    
    const data = await authApiCall('/ai/api/database/storage');
    
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

// ストレージ情報再取得ボタン
async function refreshDbStorage() {
  try {
    utilsShowLoading('ストレージ情報を再取得中...');
    await loadDbStorage();
    utilsHideLoading();
  } catch (error) {
    utilsHideLoading();
    utilsShowToast(`再取得エラー: ${error.message}`, 'error');
  }
}

/**
 * UI機能トグルを適用
 * @deprecated auth.jsに移動しました
 */
// function applyUIFeatureToggles(config) {
//   // 関数はauth.jsに移動しました
// }

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
  // appStateをクリア
  setAuthState(false, null, null);
  
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
    
    const apiBase = appState.get('apiBase') || '';
    const url = apiBase ? `${apiBase}/api/login` : '/ai/api/login';
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
      
      // appStateに保存
      setAuthState(true, data.token, data.username);
      
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
    const currentToken = appState.get('loginToken');
    if (currentToken) {
      const apiBase = appState.get('apiBase') || '';
      const url = apiBase ? `${apiBase}/api/logout` : '/ai/api/logout';
      await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${currentToken}` }
      });
    }
  } catch (error) {
    // console.warn('ログアウトエラー:', error);
  } finally {
    // ローカル状態をクリア - appStateと同期
    setAuthState(false, null, null);
    
    // 後方互換性のためグローバル変数も更新（TODO: 削除予定）
    setAuthState(false, null, null);
    
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
    
    updateUserInfo();
    
    // AI Assistantボタンを表示
    const copilotBtn = document.getElementById('copilotToggleBtn');
    if (copilotBtn) {
      copilotBtn.style.display = 'flex';
    }
  } else if (appState.get('requireLogin')) {
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
    const data = await authApiCall('/ai/api/database/target/ocid', {
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
    const data = await authApiCall('/ai/api/database/connection-info', {
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
    const data = await authApiCall('/ai/api/database/target', {
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
    
    const data = await authApiCall('/ai/api/database/target/start', {
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
    
    const data = await authApiCall('/ai/api/database/target/stop', {
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

// 注: 秘密鍵関連（handlePrivateKeyFileSelect, clearPrivateKey）は oci.js モジュールで登録済み

// データベース接続関連
window.loadDbConnectionSettings = loadDbConnectionSettings;
window.refreshDbConnectionFromEnv = refreshDbConnectionFromEnv;
window.retryLoadDbSettings = retryLoadDbSettings;
window.handleWalletFileSelect = handleWalletFileSelect;
window.uploadWalletFile = uploadWalletFile;
window.saveDbConnection = saveDbConnection;
window.testDbConnection = testDbConnection;
window.loadDbInfo = loadDbInfo;
window.loadDbTables = loadDbTables;
window.toggleTablePreview = toggleTablePreview;
window.loadTableData = loadTableData;
window.escapeHtml = escapeHtml;
window.showTablePreview = showTablePreview;
window.hideTablePreview = hideTablePreview;
window.refreshTableData = refreshTableData;
window.handleTableDataPrevPage = handleTableDataPrevPage;
window.handleTableDataNextPage = handleTableDataNextPage;
window.handleTableDataJumpPage = handleTableDataJumpPage;
window.selectAllTableData = selectAllTableData;
window.clearAllTableData = clearAllTableData;
window.deleteSelectedTableData = deleteSelectedTableData;
window.toggleTableDataRowSelection = toggleTableDataRowSelection;
window.toggleSelectAllTableData = toggleSelectAllTableData;
window.handleDbTablesPrevPage = handleDbTablesPrevPage;
window.handleDbTablesNextPage = handleDbTablesNextPage;
window.handleDbTablesJumpPage = handleDbTablesJumpPage;
window.toggleDbTableSelection = toggleDbTableSelection;
window.toggleSelectAllDbTables = toggleSelectAllDbTables;
window.selectAllDbTables = selectAllDbTables;
window.clearAllDbTables = clearAllDbTables;
window.deleteSelectedDbTables = deleteSelectedDbTables;
window.refreshDbInfo = refreshDbInfo;
window.refreshDbTables = refreshDbTables;

// ADB関連関数
window.getAdbInfo = getAdbInfo;
window.startAdb = startAdb;
window.stopAdb = stopAdb;

// OCI Object Storage関連関数
// ※ 移動先: src/modules/document.js（window.ociModuleを使用）
// window.loadOciObjects = loadOciObjects;
// window.handleOciObjectsPrevPage = handleOciObjectsPrevPage;
// window.handleOciObjectsNextPage = handleOciObjectsNextPage;
// window.handleOciObjectsJumpPage = handleOciObjectsJumpPage;
// window.toggleOciObjectSelection = toggleOciObjectSelection;
// window.toggleSelectAllOciObjects = toggleSelectAllOciObjects;
// window.selectAllOciObjects = selectAllOciObjects;
// window.clearAllOciObjects = clearAllOciObjects;
// 上記の関数はsrc/modules/document.jsでwindow.ociModuleとして公開されています

// ========================================
// グローバル関数公開（window経由） - AI Assistant関連
// ========================================

// AI Assistant関数をグローバルスコープに公開（modules/ai.jsで処理済み）

// 検索関連（削除済み - window.searchModuleを使用）
// 注: showSearchImageModal, downloadFileはsearch.jsモジュールに移行済み
// 下位互換性のため、ファイル末尾でwindow.searchModuleから再エクスポート

// モーダル（utils.jsからインポート済みの関数を再エクスポート）
window.showConfirmModal = utilsShowConfirmModal;
// 注: closeConfirmModalはutils.jsのshowConfirmModal内で内部的に処理されるため、外部公開不要

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
// 注: Object Storage関連の関数は全て oci.js モジュールに移動済み
// - updateObjectStorageStatusBadge
// - refreshObjectStorageSettings
// - testObjectStorageConnection

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
window.closeUploadProgress = closeUploadProgress;

// OCI設定関連（全て oci.js モジュールで登録済み）
// - loadOciSettings, saveOciSettings, testOciConnection
// - handlePrivateKeyFileSelect, clearPrivateKey
// - refreshObjectStorageSettings, testObjectStorageConnection

// OCI Object Storage操作（モジュール版を使用）
window.vectorizeSelectedOciObjects = ociVectorizeSelectedOciObjects;
window.deleteSelectedOciObjects = ociDeleteSelectedOciObjects;

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

// ========================================
// 画像検索: ドラッグ&ドロップ
// ========================================

/**
 * 画像検索ドロップゾーンの初期化
 */
function initImageSearchDropZone() {
  const dropZone = document.getElementById('imageSearchDropZone');
  if (!dropZone) return;
  
  // ドラッグオーバー
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.style.borderColor = '#667eea';
    dropZone.style.background = '#f0f4ff';
  });
  
  // ドラッグリーブ
  dropZone.addEventListener('dragleave', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.style.borderColor = '#cbd5e1';
    dropZone.style.background = '#f8fafc';
  });
  
  // ドロップ
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.style.borderColor = '#cbd5e1';
    dropZone.style.background = '#f8fafc';
    
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      const file = files[0];
      
      // ファイルタイプチェック
      if (!file.type.match(/^image\/(png|jpeg|jpg)$/)) {
        utilsShowToast('PNG, JPG, JPEG形式の画像のみ対応しています', 'warning');
        return;
      }
      
      // ファイル選択を疑似的に実行
      const fileInput = document.getElementById('searchImageInput');
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(file);
      fileInput.files = dataTransfer.files;
      
      // ファイル選択イベントを発火
      const event = new Event('change', { bubbles: true });
      fileInput.dispatchEvent(event);
    }
  });
}

// DOMContentLoaded時に初期化
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initImageSearchDropZone);
} else {
  initImageSearchDropZone();
}
