// ========================================
// モジュールインポート
// ========================================
import '@fortawesome/fontawesome-free/css/all.min.css';
import { appState, setAuthState } from './src/state.js';
import { apiCall as authApiCall, fetchWithAuth as authFetchWithAuth, loadConfig as authLoadConfig, showLoginModal as authShowLoginModal, 
         checkLoginStatus as authCheckLoginStatus, forceLogout as authForceLogout } from './src/modules/auth.js';
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
} from './src/modules/oci.js';
import { UPLOAD_CONFIG } from './src/config.js';
// DB関連機能はdocument.jsモジュールに移動済み
import { 
  loadDbStorage,
  refreshDbStorage,
  refreshDbTables,
  loadOciObjects,
  vectorizeSelectedOciObjects,
  deleteSelectedOciObjects
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
  refreshDbInfo
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
  
  // メインタブのアクティブ状態を更新（サブタブを除外）
  const mainTabsContainer = document.querySelector('.apex-tabs:not(#adminSubTabs)');
  if (mainTabsContainer) {
    mainTabsContainer.querySelectorAll('.apex-tab').forEach(tab => {
      tab.classList.remove('active');
    });
  }
  if (event && event.target) {
    event.target.classList.add('active');
  }
  
  // サブタブの表示/非表示
  const adminSubTabs = document.getElementById('adminSubTabs');
  if (tabName === 'admin') {
    adminSubTabs.style.display = 'flex';
    // デフォルトで「DB管理」サブタブを表示（サブタブのアクティブ状態もリセット）
    const firstSubTab = adminSubTabs.querySelector('.apex-tab:first-child');
    adminSubTabs.querySelectorAll('.apex-tab').forEach(tab => {
      tab.classList.remove('active');
    });
    if (firstSubTab) {
      firstSubTab.classList.add('active');
    }
    const subTabEvent = { target: firstSubTab };
    await switchAdminSubTab('database', subTabEvent);
  } else {
    adminSubTabs.style.display = 'none';
    // タブコンテンツの表示切り替え
    document.querySelectorAll('.tab-content').forEach(content => {
      content.style.display = 'none';
    });
    const tabContent = document.getElementById(`tab-${tabName}`);
    if (tabContent) {
      tabContent.style.display = 'block';
    }
  }
  
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
  // adminタブの初期化はswitchAdminSubTabで処理
  // 注: settings/databaseタブは廃止され、adminサブタブに統合されたため、ここでは何もしない
}

/**
 * 管理タブのサブタブ切り替え
 */
async function switchAdminSubTab(subTabName, event) {
  console.log('switchAdminSubTab called:', subTabName);
  
  // サブタブボタンのアクティブ状態を更新
  const adminSubTabs = document.getElementById('adminSubTabs');
  adminSubTabs.querySelectorAll('.apex-tab').forEach(tab => {
    tab.classList.remove('active');
  });
  if (event && event.target) {
    event.target.classList.add('active');
  }
  
  // タブコンテンツの表示切り替え
  document.querySelectorAll('.tab-content').forEach(content => {
    content.style.display = 'none';
  });
  const tabContent = document.getElementById(`tab-${subTabName}`);
  if (tabContent) {
    tabContent.style.display = 'block';
  }
  
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
  
  // サブタブに応じた初期化処理
  try {
    if (subTabName === 'settings') {
      console.log('Loading OCI settings...');
      utilsShowLoading('OCI設定を読み込み中...');
      await loadOciSettings();
      utilsHideLoading();
      console.log('OCI settings loaded');
    } else if (subTabName === 'database') {
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
                    <i class="fas fa-exclamation-triangle text-yellow-400 h-5 w-5"></i>
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
                        <i class="fas fa-sync-alt"></i> 再読み込み
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
        utilsShowToast(`設定の読み込みに失敗しました: ${error.message}`, 'error');
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
    if (subTabName === 'database') {
      return;
    }
    console.error('SubTab initialization error:', error);
    utilsHideLoading();
    utilsShowToast(`設定の読み込みに失敗しました: ${error.message}`, 'error');
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
const MAX_FILES = UPLOAD_CONFIG.MAX_FILES;

/**
 * 複数ファイル選択ハンドラー
 */
function handleMultipleFileSelect(event) {
  const files = Array.from(event.target.files);
  
  if (files.length === 0) {
    return;
  }
  
  // 最大ファイル数チェック
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
  
  // 最大ファイル数チェック
  if (files.length > MAX_FILES) {
    utilsShowToast(`アップロード可能なファイル数は最大${MAX_FILES}個です`, 'warning');
    return;
  }
  
  selectedMultipleFiles = files;
  displaySelectedFiles();
  document.getElementById('uploadMultipleBtn').disabled = false;
  
  // ドラッグオーバースタイルを解除
  event.currentTarget.classList.remove('border-blue-800');
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
        <span class="text-xs font-semibold text-blue-800">#${index + 1}</span>
        <div class="flex-1">
          <div class="text-sm font-medium text-gray-800"><i class="fas fa-file"></i> ${file.name}</div>
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
  
  // トークンを確認（debugModeではスキップ）
  const loginToken = localStorage.getItem('loginToken');
  const debugMode = appState.get('debugMode');
  
  if (!loginToken && !debugMode) {
    utilsShowToast('認証が必要です。ログインしてください', 'warning');
    authShowLoginModal();
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
    
    // API呼び出し（SSE）
    const response = await authFetchWithAuth('/ai/api/documents/upload/multiple', {
      method: 'POST',
      body: formData
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({ detail: `HTTP error! status: ${response.status}` }));
      throw new Error(errorData.detail || `HTTP error! status: ${response.status}`);
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
    utilsShowToast(`アップロードに失敗しました: ${error.message}`, 'error');
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
          <i class="fas fa-times"></i>
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
  // 進捗UIのみを非表示にし、選択されたファイルリストは保持する
  hideUploadProgressUI();
  
  // 選択されたファイルリストを再表示
  const selectedFilesList = document.getElementById('selectedFilesList');
  if (selectedFilesList && selectedMultipleFiles.length > 0) {
    selectedFilesList.style.display = 'block';
  }
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
              `すべて完了しました (${data.success_count}件)` : 
              `完了: 成功 ${data.success_count}件、失敗 ${data.failed_count}件`
          );
          
          // 成功時のトースト
          if (data.success) {
            utilsShowToast(`${data.success_count}件のファイルアップロードが完了しました。<br />一覧に反映するには、登録済み文書の「再取得」を押してください。`, 'success');
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
          updateUploadOverallStatus(data.message);
          utilsShowToast(data.message, 'error');
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
          <i class="fas fa-file"></i> ${file.name} (${utilsFormatFileSize(file.size)})
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
    utilsShowToast(`アップロードに失敗しました: ${error.message}`, 'error');
  }
}

async function loadDocuments() {
  try {
    const data = await authApiCall('/ai/api/documents');
    appState.set('documentsCache', data.documents);
    displayDocumentsList(data.documents);
  } catch (error) {
    utilsShowToast(error.message, 'error');
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
    utilsShowToast(`文書一覧の再取得に失敗しました: ${error.message}`, 'error');
  }
}



/**
 * OCI Object Storage一覧を表示
 * ※ 移動先: src/modules/document.js
 */
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
const handleOciObjectsPrevPage = () => { window.ociModule?.handleOciObjectsPrevPage?.(); };

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
const handleOciObjectsNextPage = () => { window.ociModule?.handleOciObjectsNextPage?.(); };

/**
 * ページネーション - ページジャンプ
 * ※ 移動先: src/modules/document.js
 */
const handleOciObjectsJumpPage = () => { window.ociModule?.handleOciObjectsJumpPage?.(); };

/**
 * ページ画像化フィルターを設定
 * ※ 移動先: src/modules/document.js
 */
window.setOciObjectsFilterPageImages = (value) => { window.ociModule?.setFilterPageImages?.(value); };

/**
 * ベクトル化フィルターを設定
 * ※ 移動先: src/modules/document.js
 */
window.setOciObjectsFilterEmbeddings = (value) => { window.ociModule?.setFilterEmbeddings?.(value); };

/**
 * すべてのフィルターをクリア
 * ※ 移動先: src/modules/document.js
 */
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
  
  // トークンを確認（debugModeではスキップ）
  const token = localStorage.getItem('loginToken');
  const debugMode = appState.get('debugMode');
  
  if (!token && !debugMode) {
    utilsShowToast('認証が必要です。ログインしてください', 'warning');
    authShowLoginModal();
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
    
    // 401エラーの場合は強制ログアウト（referenceプロジェクトに準拠）
    if (response.status === 401) {
      const requireLogin = appState.get('requireLogin');
      if (requireLogin) {
        authForceLogout();
        utilsShowToast('無効または期限切れのトークンです', 'error');
        return;
      }
    }
    
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
        <div style="font-size: 48px; margin-bottom: 16px;"><i class="fas fa-folder-open" style="color: #94a3b8;"></i></div>
        <div style="font-size: 16px; font-weight: 500;">登録済み文書がありません</div>
        <div style="font-size: 14px; margin-top: 8px;">文書をアップロードして検索を開始してください</div>
      </div>
    `;
    return;
  }
  
  // 名前降順でソート
  const sortedDocuments = [...documents].sort((a, b) => {
    const nameA = (a.filename || '').toLowerCase();
    const nameB = (b.filename || '').toLowerCase();
    return nameB.localeCompare(nameA, 'ja');
  });
  
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
          ${sortedDocuments.map(doc => `
            <tr>
              <td style="font-weight: 500;">${doc.filename}</td>
              <td>${doc.page_count || '-'}</td>
              <td>${utilsFormatFileSize(doc.file_size)}</td>
              <td>${utilsFormatDateTime(doc.uploaded_at)}</td>
              <td>
                <span class="badge ${doc.status === 'completed' ? 'badge-success' : 'badge-warning'}">
                  ${doc.status === 'completed' ? '<i class="fas fa-check"></i> 完了' : '<i class="fas fa-hourglass-half"></i> 処理中'}
                </span>
              </td>
              <td>
                <button class="apex-button-secondary" style="padding: 4px 8px; font-size: 12px;" onclick="deleteDocument('${doc.document_id}', '${doc.filename}')">
                  <i class="fas fa-trash-alt"></i> 削除
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
  // トークンを確認（debugModeではスキップ）
  const loginToken = localStorage.getItem('loginToken');
  const debugMode = appState.get('debugMode');
  
  if (!loginToken && !debugMode) {
    utilsShowToast('認証が必要です。ログインしてください', 'warning');
    authShowLoginModal();
    return;
  }
  
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
    
    // リクエストヘッダーを構築
    const headers = {};
    if (loginToken) {
      headers['Authorization'] = `Bearer ${loginToken}`;
    }
    
    const response = await fetch(`/ai/api/documents/${documentId}`, {
      method: 'DELETE',
      headers: headers
    });
    
    // 401エラーの場合は強制ログアウト（referenceプロジェクトに準拠）
    if (response.status === 401) {
      utilsHideLoading();
      const requireLogin = appState.get('requireLogin');
      if (requireLogin) {
        authForceLogout();
        utilsShowToast('無効または期限切れのトークンです', 'error');
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
  event.currentTarget.classList.add('border-blue-800', 'bg-blue-50');
}

function handleDragLeave(event) {
  event.preventDefault();
  event.stopPropagation();
  event.currentTarget.classList.remove('border-blue-800', 'bg-blue-50');
}

function handleDropForInput(event, inputId) {
  event.preventDefault();
  event.stopPropagation();
  event.currentTarget.classList.remove('border-blue-800', 'bg-blue-50');
  
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
    
//     // ウォレットアップロード状況を表示
//     if (settings.wallet_uploaded) {
//       const walletStatus = document.getElementById('walletStatus');
//       walletStatus.style.display = 'block';
//       walletStatus.innerHTML = '<span class="text-green-600">✅ ウォレットアップロード済み</span>';
      
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
//       walletStatus.innerHTML = '<span class="text-green-600">✅ ウォレット検出済み (' + envData.wallet_location + ')</span>';
      
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

/**
 * 強制ログアウト処理（401エラー時に呼び出し）
 * referenceプロジェクトの実装に準拠
 */
function forceLogout() {
  console.log('[APP.JS] forceLogout が呼び出されました');
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
    authShowLoginModal();
  }, 0);
}

// ========================================
// 初期化
// ========================================

// ページロード時の初期化
window.addEventListener('DOMContentLoaded', async () => {
  // console.log('資料見つかるくん - 初期化開始');
  
  // 設定を読み込む
  await authLoadConfig();
  
  // ログイン状態を確認
  await authCheckLoginStatus();
  
  // console.log('資料見つかるくん - 初期化完了');
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
window.refreshDbStorage = refreshDbStorage;
window.handleWalletFileSelect = handleWalletFileSelect;
window.loadDbStorage = loadDbStorage;

// テーブル一覧ページング関連関数をグローバルスコープに公開
window.handleDbTablesPrevPage = handleDbTablesPrevPage;
window.handleDbTablesNextPage = handleDbTablesNextPage;
window.handleDbTablesJumpPage = handleDbTablesJumpPage;
window.toggleDbTableSelection = toggleDbTableSelection;
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
// グローバル関数公開（window経由）
// ========================================
// 注: 以下の関数はHTMLから直接呼び出されるため、windowオブジェクトに公開しています。
// 新規機能はモジュール経由（window.searchModule, window.authModule等）を使用してください。

// タブ切り替え
window.switchTab = switchTab;
window.switchAdminSubTab = switchAdminSubTab;

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

// OCI Object Storage操作（モジュール版を使用）
window.vectorizeSelectedOciObjects = vectorizeSelectedOciObjects;
window.deleteSelectedOciObjects = deleteSelectedOciObjects;

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
    dropZone.style.borderColor = '#1a365d';
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

/**
 * 画像検索ペースト機能の初期化
 */
function initImageSearchPaste() {
  const pasteZone = document.getElementById('imageSearchPasteZone');
  if (!pasteZone) return;
  
  // ペーストゾーンのフォーカススタイル
  pasteZone.addEventListener('focus', () => {
    pasteZone.style.borderColor = '#1a365d';
    pasteZone.style.background = '#e0e7ff';
    pasteZone.style.boxShadow = '0 0 0 3px rgba(26, 54, 93, 0.1)';
  });
  
  pasteZone.addEventListener('blur', () => {
    pasteZone.style.borderColor = '#94a3b8';
    pasteZone.style.background = '#f1f5f9';
    pasteZone.style.boxShadow = 'none';
  });
  
  // ホバー効果
  pasteZone.addEventListener('mouseenter', () => {
    if (document.activeElement !== pasteZone) {
      pasteZone.style.borderColor = '#1a365d';
      pasteZone.style.background = '#f0f4ff';
    }
  });
  
  pasteZone.addEventListener('mouseleave', () => {
    if (document.activeElement !== pasteZone) {
      pasteZone.style.borderColor = '#94a3b8';
      pasteZone.style.background = '#f1f5f9';
    }
  });
  
  // クリックでフォーカス（ファイル選択ダイアログは開かない）
  pasteZone.addEventListener('click', () => {
    pasteZone.focus();
  });
  
  // グローバルペーストイベントをリスン
  document.addEventListener('paste', (e) => {
    // 画像検索タブがアクティブかチェック
    const imageSearchPanel = document.getElementById('imageSearchPanel');
    if (!imageSearchPanel || imageSearchPanel.style.display === 'none') {
      return; // 画像検索タブが表示されていない場合は何もしない
    }
    
    // テキストエリアやインプットフィールドにフォーカスがある場合は通常のペースト動作を維持
    const activeElement = document.activeElement;
    if (activeElement && (activeElement.tagName === 'INPUT' || activeElement.tagName === 'TEXTAREA')) {
      return;
    }
    
    const items = e.clipboardData?.items;
    if (!items) return;
    
    // クリップボードから画像を探す
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      
      if (item.type.match(/^image\/(png|jpeg|jpg)$/)) {
        e.preventDefault(); // デフォルトのペースト動作を防ぐ
        
        const blob = item.getAsFile();
        if (!blob) continue;
        
        // ファイルサイズチェック (最大10MB)
        const maxSize = 10 * 1024 * 1024;
        if (blob.size > maxSize) {
          utilsShowToast('画像ファイルは10MB以下にしてください', 'warning');
          return;
        }
        
        // ファイル名を生成（タイムスタンプ付き）
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const ext = blob.type.split('/')[1] || 'png';
        const fileName = `pasted-image-${timestamp}.${ext}`;
        
        // Blobから新しいFileオブジェクトを作成
        const file = new File([blob], fileName, { type: blob.type });
        
        // ファイル選択を疑似的に実行
        const fileInput = document.getElementById('searchImageInput');
        const dataTransfer = new DataTransfer();
        dataTransfer.items.add(file);
        fileInput.files = dataTransfer.files;
        
        // ファイル選択イベントを発火
        const event = new Event('change', { bubbles: true });
        fileInput.dispatchEvent(event);
        
        // トーストで通知
        utilsShowToast('クリップボードから画像を読み込みました', 'success');
        
        break; // 最初の画像のみ処理
      }
    }
  });
}

// DOMContentLoaded時に初期化
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initImageSearchDropZone();
    initImageSearchPaste();
  });
} else {
  initImageSearchDropZone();
  initImageSearchPaste();
}
