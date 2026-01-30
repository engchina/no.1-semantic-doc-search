/**
 * OCI Object Storage管理モジュール
 * 
 * OCI Object Storageの操作、表示、フィルタリングを担当
 */

import { appState, getSelectedOciObjects, toggleOciObjectSelection, setAllOciObjectsSelection } from '../state.js';
import { apiCall, forceLogout, showLoginModal } from './auth.js';
import { showLoading, hideLoading, showToast, showConfirmModal, updateStatusBadge } from './utils.js';

// ========================================
// OCI Objects管理
// ========================================

/**
 * ページ画像化で生成されたファイルかどうかを判定
 * @param {string} objectName - オブジェクト名
 * @param {Array} allObjects - 全オブジェクトのリスト
 * @returns {boolean} ページ画像化されたファイルの場合true
 */
export function isGeneratedPageImage(objectName, allObjects = []) {
  const pageImagePattern = /\/page_\d{3}\.png$/;
  if (!pageImagePattern.test(objectName)) {
    return false;
  }
  
  const lastSlashIndex = objectName.lastIndexOf('/');
  if (lastSlashIndex === -1) {
    return false;
  }
  
  const parentFolderPath = objectName.substring(0, lastSlashIndex);
  return allObjects.some(obj => {
    const objNameWithoutExt = obj.name.replace(/\.[^.]+$/, '');
    return objNameWithoutExt === parentFolderPath;
  });
}

/**
 * OCI Object Storage一覧を読み込み
 */
export async function loadOciObjects() {
  try {
    showLoading('OCI Object Storage一覧を取得中...');
    
    const ociObjectsPage = appState.get('ociObjectsPage');
    const ociObjectsPageSize = appState.get('ociObjectsPageSize');
    const ociObjectsPrefix = appState.get('ociObjectsPrefix');
    const ociObjectsFilterPageImages = appState.get('ociObjectsFilterPageImages');
    const ociObjectsFilterEmbeddings = appState.get('ociObjectsFilterEmbeddings');
    const ociObjectsDisplayType = appState.get('ociObjectsDisplayType');
    
    const params = new URLSearchParams({
      prefix: ociObjectsPrefix,
      page: ociObjectsPage.toString(),
      page_size: ociObjectsPageSize.toString(),
      filter_page_images: ociObjectsFilterPageImages,
      filter_embeddings: ociObjectsFilterEmbeddings,
      display_type: ociObjectsDisplayType
    });
    
    const data = await apiCall(`/ai/api/oci/objects?${params}`);
    
    hideLoading();
    
    if (!data.success) {
      showToast(`エラー: ${data.message || 'オブジェクト一覧取得失敗'}`, 'error');
      updateDocumentsStatusBadge('エラー', 'error');
      return;
    }
    
    // 全オブジェクトキャッシュを更新
    const allOciObjects = appState.get('allOciObjects') || [];
    data.objects.forEach(obj => {
      const existingIndex = allOciObjects.findIndex(o => o.name === obj.name);
      if (existingIndex >= 0) {
        allOciObjects[existingIndex] = obj;
      } else {
        allOciObjects.push(obj);
      }
    });
    appState.set('allOciObjects', allOciObjects);
    
    displayOciObjectsList(data);
    
    // バッジを更新
    const totalCount = data.pagination?.total || 0;
    const statistics = data.statistics || { file_count: 0, page_image_count: 0, total_count: 0 };
    
    updateDocumentsStatusBadge(`${totalCount}件`, 'success');
    updateDocumentsStatisticsBadges(statistics, 'success');
    
  } catch (error) {
    hideLoading();
    showToast(`OCI Object Storage一覧取得エラー: ${error.message}`, 'error');
    updateDocumentsStatusBadge('エラー', 'error');
  }
}

/**
 * OCI Object Storage一覧を表示
 * @param {Object} data - OCI Objects データ
 */
export function displayOciObjectsList(data) {
  const listDiv = document.getElementById('documentsList');
  const objects = data.objects || [];
  const pagination = data.pagination || {};
  const allOciObjects = appState.get('allOciObjects') || [];
  const selectedOciObjects = getSelectedOciObjects();
  const ociObjectsBatchDeleteLoading = appState.get('ociObjectsBatchDeleteLoading');
  const ociObjectsFilterPageImages = appState.get('ociObjectsFilterPageImages');
  const ociObjectsFilterEmbeddings = appState.get('ociObjectsFilterEmbeddings');
  const ociObjectsDisplayType = appState.get('ociObjectsDisplayType');
  
  // デバッグログ
  console.log('========== displayOciObjectsList ==========');
  console.log('現在表示中のオブジェクト:', objects.map(o => o.name));
  console.log('selectedOciObjects:', selectedOciObjects);
  
  // 選択可能なオブジェクトをフィルタ
  const selectableObjects = objects.filter(obj => !isGeneratedPageImage(obj.name, allOciObjects));
  const allPageSelected = selectableObjects.length > 0 && selectableObjects.every(obj => selectedOciObjects.includes(obj.name));
  
  // フィルターUI
  const filterHtml = `
    <div class="flex items-center gap-4 mb-3 p-3 bg-gray-50 rounded-lg border border-gray-200">
      <div class="flex items-center gap-2">
        <span class="text-xs font-medium text-gray-600">📁 表示タイプ:</span>
        <div class="flex gap-1">
          <button 
            onclick="window.ociModule.setDisplayType('files_only')" 
            class="px-2.5 py-1 text-xs rounded-full transition-all ${ociObjectsDisplayType === 'files_only' ? 'bg-blue-600 text-white shadow-sm' : 'bg-white text-gray-600 border border-gray-300 hover:bg-gray-100'}"
          >
            ファイルのみ
          </button>
          <button 
            onclick="window.ociModule.setDisplayType('files_and_images')" 
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
            onclick="window.ociModule.setFilterPageImages('all')" 
            class="px-2.5 py-1 text-xs rounded-full transition-all ${ociObjectsFilterPageImages === 'all' ? 'bg-gray-700 text-white shadow-sm' : 'bg-white text-gray-600 border border-gray-300 hover:bg-gray-100'}"
          >
            すべて
          </button>
          <button 
            onclick="window.ociModule.setFilterPageImages('done')" 
            class="px-2.5 py-1 text-xs rounded-full transition-all ${ociObjectsFilterPageImages === 'done' ? 'bg-green-600 text-white shadow-sm' : 'bg-white text-gray-600 border border-gray-300 hover:bg-gray-100'}"
          >
            ✓ 完了
          </button>
          <button 
            onclick="window.ociModule.setFilterPageImages('not_done')" 
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
            onclick="window.ociModule.setFilterEmbeddings('all')" 
            class="px-2.5 py-1 text-xs rounded-full transition-all ${ociObjectsFilterEmbeddings === 'all' ? 'bg-gray-700 text-white shadow-sm' : 'bg-white text-gray-600 border border-gray-300 hover:bg-gray-100'}"
          >
            すべて
          </button>
          <button 
            onclick="window.ociModule.setFilterEmbeddings('done')" 
            class="px-2.5 py-1 text-xs rounded-full transition-all ${ociObjectsFilterEmbeddings === 'done' ? 'bg-green-600 text-white shadow-sm' : 'bg-white text-gray-600 border border-gray-300 hover:bg-gray-100'}"
          >
            ✓ 完了
          </button>
          <button 
            onclick="window.ociModule.setFilterEmbeddings('not_done')" 
            class="px-2.5 py-1 text-xs rounded-full transition-all ${ociObjectsFilterEmbeddings === 'not_done' ? 'bg-orange-500 text-white shadow-sm' : 'bg-white text-gray-600 border border-gray-300 hover:bg-gray-100'}"
          >
            未実行
          </button>
        </div>
      </div>
      ${(ociObjectsFilterPageImages !== 'all' || ociObjectsFilterEmbeddings !== 'all') ? `
        <button 
          onclick="window.ociModule.clearFilters()" 
          class="ml-auto px-2.5 py-1 text-xs rounded-full bg-red-50 text-red-600 border border-red-200 hover:bg-red-100 transition-all flex items-center gap-1"
        >
          <span>✕</span>
          <span>フィルタークリア</span>
        </button>
      ` : ''}
    </div>
  `;
  
  // 空状態の表示
  if (objects.length === 0) {
    listDiv.innerHTML = `
      <div>
        ${filterHtml}
        <div class="empty-state">
          <div class="empty-state-icon">📁</div>
          <div class="empty-state-title">オブジェクトがありません</div>
          <div class="empty-state-subtitle">バケット: ${data.bucket_name || '-'}</div>
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
        onclick="window.ociModule.selectAll()" 
        ${ociObjectsBatchDeleteLoading ? 'disabled' : ''}
      >
        すべて選択
      </button>
      <button 
        class="px-3 py-1 text-xs border rounded transition-colors ${ociObjectsBatchDeleteLoading ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-100'}" 
        onclick="window.ociModule.clearAll()" 
        ${ociObjectsBatchDeleteLoading ? 'disabled' : ''}
      >
        すべて解除
      </button>
      <button 
        class="px-3 py-1 text-xs rounded transition-colors ${selectedOciObjects.length === 0 || ociObjectsBatchDeleteLoading ? 'bg-gray-300 text-gray-500 cursor-not-allowed' : 'bg-red-500 hover:bg-red-600 text-white'}" 
        onclick="window.ociModule.deleteSelected()" 
        ${selectedOciObjects.length === 0 || ociObjectsBatchDeleteLoading ? 'disabled' : ''}
        title="選択されたアイテム（フォルダ配下の子アイテムを含む）を削除: ${selectedOciObjects.length}件"
      >
        🗑️ 削除 (${selectedOciObjects.length}件)
      </button>
      <button 
        class="px-3 py-1 text-xs rounded transition-colors ${selectedOciObjects.length === 0 || ociObjectsBatchDeleteLoading ? 'bg-blue-300 text-white cursor-not-allowed' : 'bg-blue-500 hover:bg-blue-600 text-white'}" 
        onclick="window.ociModule.downloadSelected()" 
        ${selectedOciObjects.length === 0 || ociObjectsBatchDeleteLoading ? 'disabled' : ''}
        title="選択されたアイテム（フォルダ配下の子アイテムを含む）をZIPでダウンロード: ${selectedOciObjects.length}件"
      >
        📥 ダウンロード (${selectedOciObjects.length}件)
      </button>
      <button 
        class="px-3 py-1 text-xs rounded transition-colors ${selectedOciObjects.length === 0 || ociObjectsBatchDeleteLoading ? 'bg-purple-300 text-white cursor-not-allowed' : 'bg-purple-500 hover:bg-purple-600 text-white'}" 
        onclick="window.ociModule.convertToImages()" 
        ${selectedOciObjects.length === 0 || ociObjectsBatchDeleteLoading ? 'disabled' : ''}
        title="選択されたファイル（フォルダ配下の子ファイルを含む）をページ毎に画像化: ${selectedOciObjects.length}件"
      >
        🖼️ ページ画像化 (${selectedOciObjects.length}件)
      </button>
      <button 
        class="px-3 py-1 text-xs rounded transition-colors ${selectedOciObjects.length === 0 || ociObjectsBatchDeleteLoading ? 'bg-green-300 text-white cursor-not-allowed' : 'bg-green-500 hover:bg-green-600 text-white'}" 
        onclick="window.ociModule.vectorizeSelected()" 
        ${selectedOciObjects.length === 0 || ociObjectsBatchDeleteLoading ? 'disabled' : ''}
        title="選択されたファイルの画像をベクトル化してDBに保存: ${selectedOciObjects.length}件"
      >
        🔢 ベクトル化 (${selectedOciObjects.length}件)
      </button>
    </div>
  `;
  
  // ページネーションUI
  const paginationHtml = window.UIComponents?.renderPagination({
    currentPage: pagination.current_page,
    totalPages: pagination.total_pages,
    totalItems: pagination.total,
    startNum: pagination.start_row,
    endNum: pagination.end_row,
    onPrevClick: 'window.ociModule.prevPage()',
    onNextClick: 'window.ociModule.nextPage()',
    onJumpClick: 'window.ociModule.jumpToPage',
    inputId: 'ociObjectsPageInput',
    disabled: ociObjectsBatchDeleteLoading
  }) || '';
  
  // テーブル行を生成
  const tableRowsHtml = objects.map(obj => generateObjectRow(obj, allOciObjects, selectedOciObjects, ociObjectsBatchDeleteLoading)).join('');
  
  listDiv.innerHTML = `
    <div>
      ${filterHtml}
      ${selectionButtonsHtml}
      ${paginationHtml}
      <div class="table-wrapper-scrollable">
        <table class="data-table">
          <thead>
            <tr>
              <th style="width: 40px;"><input type="checkbox" id="ociObjectsHeaderCheckbox" onchange="window.ociModule.toggleSelectAll(this.checked)" ${allPageSelected ? 'checked' : ''} class="w-4 h-4 rounded" ${ociObjectsBatchDeleteLoading ? 'disabled' : ''}></th>
              <th>タイプ</th>
              <th>名前</th>
              <th>サイズ</th>
              <th>作成日時</th>
              <th style="text-align: center;">ページ画像化</th>
              <th style="text-align: center;">ベクトル化</th>
            </tr>
          </thead>
          <tbody>
            ${tableRowsHtml}
          </tbody>
        </table>
      </div>
      ${paginationHtml}
    </div>
  `;
}

/**
 * オブジェクト行のHTMLを生成
 * @private
 */
function generateObjectRow(obj, allOciObjects, selectedOciObjects, ociObjectsBatchDeleteLoading) {
  const isFolder = obj.name.endsWith('/');
  const isPageImage = isGeneratedPageImage(obj.name, allOciObjects);
  const icon = isFolder ? '📁' : '📄';
  const isChecked = selectedOciObjects.includes(obj.name);
  
  // ページ画像化状態
  const hasPageImages = obj.has_page_images || false;
  const pageImagesStatusHtml = hasPageImages ? 
    '<span class="badge badge-success">✓ 完了</span>' : 
    '<span class="badge badge-neutral">-</span>';
  
  // ベクトル化状態
  const hasEmbeddings = obj.has_embeddings || false;
  const embeddingsStatusHtml = hasEmbeddings ? 
    '<span class="badge badge-success">✓ 完了</span>' : 
    '<span class="badge badge-neutral">-</span>';
  
  return `
    <tr>
      <td>
        ${!isPageImage ? `
          <input 
            type="checkbox" 
            ${isChecked ? 'checked' : ''} 
            onchange="window.ociModule.toggleSelection('${obj.name.replace(/'/g, "\\'")}')" 
            class="w-4 h-4 rounded"
            ${ociObjectsBatchDeleteLoading ? 'disabled' : ''}
          />
        ` : ''}
      </td>
      <td>${icon}</td>
      <td>${obj.name}</td>
      <td>${obj.size ? formatBytes(obj.size) : '-'}</td>
      <td>${obj.time_created || '-'}</td>
      <td style="text-align: center;">${pageImagesStatusHtml}</td>
      <td style="text-align: center;">${embeddingsStatusHtml}</td>
    </tr>
  `;
}

/**
 * バイト数をフォーマット
 * @private
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * ドキュメントステータスバッジを更新
 * @private
 */
function updateDocumentsStatusBadge(text, type) {
  updateStatusBadge('documentsStatusBadge', text, type);
}

/**
 * ドキュメント統計バッジを更新
 * @private
 */
function updateDocumentsStatisticsBadges(statistics, type) {
  const fileCountBadge = document.getElementById('fileCountBadge');
  const pageImageCountBadge = document.getElementById('pageImageCountBadge');
  const totalCountBadge = document.getElementById('totalCountBadge');
  
  if (fileCountBadge) fileCountBadge.textContent = `ファイル: ${statistics.file_count}`;
  if (pageImageCountBadge) pageImageCountBadge.textContent = `ページ画像: ${statistics.page_image_count}`;
  if (totalCountBadge) totalCountBadge.textContent = `合計: ${statistics.total_count}`;
}

// ========================================
// ページネーション操作
// ========================================

/**
 * 前ページへ移動
 */
export function handleOciObjectsPrevPage() {
  const currentPage = appState.get('ociObjectsPage');
  if (currentPage > 1) {
    appState.set('ociObjectsPage', currentPage - 1);
    loadOciObjects();
  }
}

/**
 * 次ページへ移動
 */
export function handleOciObjectsNextPage() {
  const currentPage = appState.get('ociObjectsPage');
  const totalPages = appState.get('ociObjectsTotalPages') || 1;
  if (currentPage < totalPages) {
    appState.set('ociObjectsPage', currentPage + 1);
    loadOciObjects();
  }
}

/**
 * 指定ページへジャンプ
 */
export function handleOciObjectsJumpPage() {
  const input = document.getElementById('ociObjectsPageInput');
  if (!input) return;
  
  const targetPage = parseInt(input.value);
  const totalPages = appState.get('ociObjectsTotalPages') || 1;
  
  if (targetPage >= 1 && targetPage <= totalPages) {
    appState.set('ociObjectsPage', targetPage);
    loadOciObjects();
  } else {
    showToast(`ページ番号は1〜${totalPages}の範囲で指定してください`, 'warning');
  }
}

// ========================================
// 選択操作
// ========================================

/**
 * オブジェクトの選択状態を切り替え
 * @param {string} objectName - オブジェクト名
 */
export function toggleOciObjectSelectionHandler(objectName) {
  const selectedOciObjects = getSelectedOciObjects();
  const isSelected = selectedOciObjects.includes(objectName);
  toggleOciObjectSelection(objectName, !isSelected);
  
  // 表示を更新（チェックボックスの状態を同期）
  const allOciObjects = appState.get('allOciObjects') || [];
  const checkbox = document.querySelector(`input[type="checkbox"][onchange*="${objectName}"]`);
  if (checkbox) {
    checkbox.checked = !isSelected;
  }
}

/**
 * ページ全体の選択状態を切り替え
 * @param {boolean} checked - チェック状態
 */
export function toggleSelectAllOciObjects(checked) {
  const allOciObjects = appState.get('allOciObjects') || [];
  const objects = Array.from(document.querySelectorAll('.data-table tbody tr')).map((row, idx) => {
    const nameCell = row.cells[2];
    return nameCell ? nameCell.textContent : null;
  }).filter(Boolean);
  
  const selectableObjects = objects.filter(name => !isGeneratedPageImage(name, allOciObjects));
  setAllOciObjectsSelection(selectableObjects, checked);
  
  // 再描画
  loadOciObjects();
}

/**
 * すべて選択
 */
export function selectAllOciObjects() {
  const allOciObjects = appState.get('allOciObjects') || [];
  const selectableObjects = allOciObjects
    .filter(obj => !isGeneratedPageImage(obj.name, allOciObjects))
    .map(obj => obj.name);
  
  setAllOciObjectsSelection(selectableObjects, true);
  loadOciObjects();
}

/**
 * すべて解除
 */
export function clearAllOciObjects() {
  appState.set('selectedOciObjects', []);
  loadOciObjects();
}

// ========================================
// フィルター操作
// ========================================

/**
 * ページ画像化フィルターを設定
 * @param {string} filter - フィルター値 ('all' | 'done' | 'not_done')
 */
export function setOciObjectsFilterPageImages(filter) {
  appState.set('ociObjectsFilterPageImages', filter);
  appState.set('ociObjectsPage', 1);
  loadOciObjects();
}

/**
 * ベクトル化フィルターを設定
 * @param {string} filter - フィルター値 ('all' | 'done' | 'not_done')
 */
export function setOciObjectsFilterEmbeddings(filter) {
  appState.set('ociObjectsFilterEmbeddings', filter);
  appState.set('ociObjectsPage', 1);
  loadOciObjects();
}

/**
 * すべてのフィルターをクリア
 */
export function clearOciObjectsFilters() {
  appState.set('ociObjectsFilterPageImages', 'all');
  appState.set('ociObjectsFilterEmbeddings', 'all');
  appState.set('ociObjectsPage', 1);
  loadOciObjects();
}

/**
 * 表示タイプフィルターを設定
 * @param {string} displayType - 表示タイプ ('files_only' | 'files_and_images')
 */
export function setOciObjectsDisplayType(displayType) {
  appState.set('ociObjectsDisplayType', displayType);
  appState.set('ociObjectsPage', 1);
  loadOciObjects();
}

// ========================================
// バッチ操作
// ========================================

/**
 * 選択されたOCIオブジェクトをZIPでダウンロード
 */
export async function downloadSelectedOciObjects() {
  const selectedOciObjects = getSelectedOciObjects();
  
  if (selectedOciObjects.length === 0) {
    showToast('ダウンロードするファイルを選択してください', 'warning');
    return;
  }
  
  const ociObjectsBatchDeleteLoading = appState.get('ociObjectsBatchDeleteLoading');
  if (ociObjectsBatchDeleteLoading) {
    showToast('処理中です。しばらくお待ちください', 'warning');
    return;
  }
  
  // トークンを確認（localStorageから直接取得 - referenceプロジェクトに準拠）
  const loginToken = localStorage.getItem('loginToken');
  const debugMode = appState.get('debugMode');
  
  if (!loginToken && !debugMode) {
    showToast('認証が必要です。ログインしてください', 'warning');
    showLoginModal();
    return;
  }
  
  try {
    appState.set('ociObjectsBatchDeleteLoading', true);
    showLoading(`${selectedOciObjects.length}件のファイルをZIPに圧縮中...`);
    
    // リクエストヘッダーを構築
    const headers = {
      'Content-Type': 'application/json'
    };
    
    // トークンがある場合のみAuthorizationヘッダーを追加
    if (loginToken) {
      headers['Authorization'] = `Bearer ${loginToken}`;
    }
    
    const response = await fetch('/ai/api/oci/objects/download', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        object_names: selectedOciObjects
      })
    });
    
    if (!response.ok) {
      // 401エラーの場合は強制ログアウト（referenceプロジェクトに準拠）
      if (response.status === 401) {
        hideLoading();
        appState.set('ociObjectsBatchDeleteLoading', false);
        const requireLogin = appState.get('requireLogin');
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
    
    hideLoading();
    appState.set('ociObjectsBatchDeleteLoading', false);
    showToast(`${selectedOciObjects.length}件のファイルをダウンロードしました`, 'success');
    
  } catch (error) {
    hideLoading();
    appState.set('ociObjectsBatchDeleteLoading', false);
    console.error('ダウンロードエラー:', error);
    showToast(`ダウンロードエラー: ${error.message}`, 'error');
  }
}

/**
 * 選択されたOCIオブジェクトをページ毎に画像化
 */
export async function convertSelectedOciObjectsToImages() {
  const selectedOciObjects = getSelectedOciObjects();
  
  if (selectedOciObjects.length === 0) {
    showToast('変換するファイルを選択してください', 'warning');
    return;
  }
  
  const ociObjectsBatchDeleteLoading = appState.get('ociObjectsBatchDeleteLoading');
  if (ociObjectsBatchDeleteLoading) {
    showToast('処理中です。しばらくお待ちください', 'warning');
    return;
  }
  
  // トークンを確認（localStorageから直接取得 - referenceプロジェクトに準拠）
  const loginToken = localStorage.getItem('loginToken');
  const debugMode = appState.get('debugMode');
  
  if (!loginToken && !debugMode) {
    showToast('認証が必要です。ログインしてください', 'warning');
    showLoginModal();
    return;
  }
  
  // 確認モーダルを表示
  const confirmed = await showConfirmModal(
    `選択された${selectedOciObjects.length}件のファイルを各ページPNG画像として同名フォルダに保存します。\n\n処理には時間がかかる場合があります。実行しますか？`,
    'ページ画像化確認'
  );
  
  if (!confirmed) {
    return;
  }
  
  try {
    appState.set('ociObjectsBatchDeleteLoading', true);
    showLoading('ページ画像化を準備中...\nサーバーに接続しています');
    
    // リクエストヘッダーを構築
    const headers = {
      'Content-Type': 'application/json'
    };
    
    // トークンがある場合のみAuthorizationヘッダーを追加
    if (loginToken) {
      headers['Authorization'] = `Bearer ${loginToken}`;
    }
    
    const response = await fetch('/ai/api/oci/objects/convert-to-images', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        object_names: selectedOciObjects
      })
    });
    
    if (!response.ok) {
      // 401エラーの場合は強制ログアウト（referenceプロジェクトに準拠）
      if (response.status === 401) {
        hideLoading();
        appState.set('ociObjectsBatchDeleteLoading', false);
        const requireLogin = appState.get('requireLogin');
        if (requireLogin) {
          forceLogout();
        }
        throw new Error('無効または期限切れのトークンです');
      }
      
      const errorData = await response.json();
      throw new Error(errorData.detail || 'ページ画像化に失敗しました');
    }
    
    // SSE (Server-Sent Events) を使用して進捗状況を受信
    await processStreamingResponse(response, selectedOciObjects.length, 'convert');
    
  } catch (error) {
    hideLoading();
    appState.set('ociObjectsBatchDeleteLoading', false);
    console.error('ページ画像化エラー:', error);
    showToast(`ページ画像化エラー: ${error.message}`, 'error');
  }
}

/**
 * 選択されたOCIオブジェクトをベクトル化してDBに保存
 */
export async function vectorizeSelectedOciObjects() {
  const selectedOciObjects = getSelectedOciObjects();
  
  if (selectedOciObjects.length === 0) {
    showToast('ベクトル化するファイルを選択してください', 'warning');
    return;
  }
  
  const ociObjectsBatchDeleteLoading = appState.get('ociObjectsBatchDeleteLoading');
  if (ociObjectsBatchDeleteLoading) {
    showToast('処理中です。しばらくお待ちください', 'warning');
    return;
  }
  
  // トークンを確認（localStorageから直接取得 - referenceプロジェクトに準拠）
  const loginToken = localStorage.getItem('loginToken');
  const debugMode = appState.get('debugMode');
  
  if (!loginToken && !debugMode) {
    showToast('認証が必要です。ログインしてください', 'warning');
    showLoginModal();
    return;
  }
  
  // 確認モーダルを表示
  const confirmed = await showConfirmModal(
    `選択された${selectedOciObjects.length}件のファイルを画像ベクトル化してデータベースに保存します。

ページ画像化されていないファイルは自動的に画像化されます。
既存のembeddingがある場合は削除してから再作成します。

処理には時間がかかる場合があります。実行しますか？`,
    'ベクトル化確認'
  );
  
  if (!confirmed) {
    return;
  }
  
  try {
    appState.set('ociObjectsBatchDeleteLoading', true);
    showLoading('ベクトル化を準備中...\nサーバーに接続しています');
    
    // リクエストヘッダーを構築
    const headers = {
      'Content-Type': 'application/json'
    };
    
    // トークンがある場合のみAuthorizationヘッダーを追加
    if (loginToken) {
      headers['Authorization'] = `Bearer ${loginToken}`;
    }
    
    const response = await fetch('/ai/api/oci/objects/vectorize', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        object_names: selectedOciObjects
      })
    });
    
    if (!response.ok) {
      // 401エラーの場合は強制ログアウト（referenceプロジェクトに準拠）
      if (response.status === 401) {
        hideLoading();
        appState.set('ociObjectsBatchDeleteLoading', false);
        const requireLogin = appState.get('requireLogin');
        if (requireLogin) {
          forceLogout();
        }
        throw new Error('無効または期限切れのトークンです');
      }
      
      const errorData = await response.json();
      throw new Error(errorData.detail || 'ベクトル化に失敗しました');
    }
    
    // SSE (Server-Sent Events) を使用して進捗状況を受信
    await processStreamingResponse(response, selectedOciObjects.length, 'vectorize');
    
  } catch (error) {
    hideLoading();
    appState.set('ociObjectsBatchDeleteLoading', false);
    console.error('ベクトル化エラー:', error);
    showToast(`ベクトル化エラー: ${error.message}`, 'error');
    
    // 選択をクリアして一覧を更新
    appState.set('selectedOciObjects', []);
    await loadOciObjects();
  }
}

/**
 * 選択されたオブジェクトを削除
 */
export async function deleteSelectedOciObjects() {
  const selectedOciObjects = getSelectedOciObjects();
  
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
  appState.set('ociObjectsBatchDeleteLoading', true);
  showLoading('オブジェクトを削除中...');
  
  // UIを更新（エラーは無視）
  loadOciObjects().catch(err => console.warn('UI更新エラー:', err));
  
  try {
    // 一括削除APIを呼び出す
    const response = await apiCall('/ai/api/oci/objects/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ object_names: selectedOciObjects })
    });
    
    if (response.success) {
      showToast(`${count}件のオブジェクトを削除しました`, 'success');
      // 選択をクリア
      appState.set('selectedOciObjects', []);
      // ページを1にリセット
      appState.set('ociObjectsPage', 1);
    } else {
      showToast(`削除エラー: ${response.message || '不明なエラー'}`, 'error');
    }
  } catch (error) {
    showToast(`削除エラー: ${error.message}`, 'error');
  } finally {
    // 処理中表示を解除
    appState.set('ociObjectsBatchDeleteLoading', false);
    hideLoading();
    // 一覧を再読み込み
    await loadOciObjects();
  }
}

/**
 * ストリーミングレスポンスの処理（共通）
 * @private
 */
async function processStreamingResponse(response, totalFiles, operationType) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  
  // ジョブIDをヘッダーから取得
  const jobId = response.headers.get('X-Job-ID');
  
  let currentFileIndex = 0;
  let currentPageIndex = 0;
  let totalPages = 0;
  let processedPages = 0;
  let totalPagesAllFiles = 0;
  let totalWorkers = 1; // 並列ワーカー数
  
  // イベント処理用の共通関数
  const processEventLine = async (line) => {
    if (!line.startsWith('data: ')) return;
    
    try {
      const jsonStr = line.substring(6);
      const data = JSON.parse(jsonStr);
          
          // イベントタイプごとに処理
          switch(data.type) {
            case 'start':
              totalFiles = data.total_files;
              totalWorkers = data.total_workers || 1;
              updateLoadingMessage(operationType === 'convert' ? 
                `ファイルをページ画像化中... (0/${totalFiles})\n並列ワーカー: ${totalWorkers}` :
                `ファイルをベクトル化中... (0/${totalFiles})\n並列ワーカー: ${totalWorkers}`, 0, jobId);
              break;
              
            case 'heartbeat':
              // ハートビートは接続維持のため、UIは更新せず接続続行を示す
              console.log('ハートビート受信:', data.timestamp);
              break;
              
            case 'file_queued':
              // ファイルが待機中になった
              updateLoadingMessage(`ファイル待機中: ${data.file_name}\nステータス: ⏳ ${data.status}`, 0, jobId);
              break;
              
            case 'file_processing':
              // ファイルが処理中になった
              currentFileIndex = data.file_index;
              if (data.total_files) totalFiles = data.total_files;
              const processingProgress = totalFiles > 0 ? (currentFileIndex - 1) / totalFiles : 0;
              updateLoadingMessage(`ファイル ${data.file_index}/${data.total_files || totalFiles}\n${data.file_name}\nステータス: 🔄 ${data.status}`, processingProgress, jobId);
              break;
              
            case 'file_start':
              currentFileIndex = data.file_index;
              if (data.total_files) totalFiles = data.total_files;
              const fileProgress = (currentFileIndex - 1) / (totalFiles || 1);
              updateLoadingMessage(`ファイル ${currentFileIndex}/${data.total_files || totalFiles} を処理中...\n${data.file_name}`, fileProgress, jobId);
              break;
              
            case 'page_progress':
              currentPageIndex = data.page_index;
              totalPages = data.total_pages;
              const pageProgress = operationType === 'convert' ?
                (processedPages + 1) / (totalPagesAllFiles || 1) :
                totalFiles > 0 ? (data.file_index - 1 + currentPageIndex / (totalPages || 1)) / totalFiles : 0;
              updateLoadingMessage(`ファイル ${data.file_index}/${data.total_files || totalFiles}\nページ ${currentPageIndex}/${totalPages} を${operationType === 'convert' ? '画像化' : 'ベクトル化'}中...`, pageProgress, jobId);
              processedPages++;
              break;
              
            case 'pages_count':
              totalPages = data.total_pages;
              totalPagesAllFiles += totalPages;
              break;
              
            case 'file_complete':
              currentFileIndex = data.file_index;
              const totalForComplete = data.total_files || totalFiles || 1;
              const completedFileProgress = currentFileIndex / totalForComplete;
              updateLoadingMessage(`ファイル ${data.file_index}/${data.total_files || totalFiles} ✓ 完了\n${data.file_name}`, completedFileProgress, jobId);
              // UI更新はprogress_updateイベントに任せる（重複回避）
              break;
              
            case 'file_error':
              console.error(`ファイル ${data.file_index}/${data.total_files || totalFiles} エラー: ${data.error}`);
              const totalForError = data.total_files || totalFiles || 1;
              const errorProgress = currentFileIndex > 0 ? (currentFileIndex - 1) / totalForError : 0;
              updateLoadingMessage(`ファイル ${data.file_index}/${data.total_files || totalFiles} ✗ エラー\n${data.file_name}\n${data.error}`, errorProgress, jobId);
              break;
              
            case 'cancelled':
              hideLoading();
              appState.set('ociObjectsBatchDeleteLoading', false);
              showToast(`処理がキャンセルされました\n${data.message}`, 'info');
              appState.set('selectedOciObjects', []);
              await loadOciObjects();
              break;
              
            case 'error':
              hideLoading();
              appState.set('ociObjectsBatchDeleteLoading', false);
              showToast(`エラー: ${data.message}`, 'error');
              break;
              
            case 'progress_update':
              // 進捗状況のリアルタイム更新
              const progressPercent = data.total_count > 0 ? data.completed_count / data.total_count : 0;
              updateLoadingMessage(
                `処理中: ${data.completed_count}/${data.total_count}\n成功: ${data.success_count}件 | 失敗: ${data.failed_count}件`,
                progressPercent,
                jobId
              );
              // リアルタイムでUIを更新（単一の更新ポイント、エラーは無視）
              loadOciObjects().catch(err => console.warn('UI更新エラー:', err));
              break;
              
            case 'sync_complete':
              // すべての処理が完了し、状態が完全に同期された
              console.log('同期完了イベント受信:', data);
              break;
              
            case 'complete':
              hideLoading();
              appState.set('ociObjectsBatchDeleteLoading', false);
              
              if (data.success) {
                showToast(data.message, 'success');
              } else {
                showToast(`${data.message}\n成功: ${data.success_count}件、失敗: ${data.failed_count}件`, 'warning');
              }
              
              console.log(`${operationType === 'convert' ? 'ページ画像化' : 'ベクトル化'}結果:`, data.results);
              
              // 選択をクリアして一覧を更新（最終同期）
              appState.set('selectedOciObjects', []);
              // 短時間待機してからリストを更新（バックエンドの処理完了を保証）
              await new Promise(resolve => setTimeout(resolve, 500));
              await loadOciObjects();
              break;
          }
    } catch (parseError) {
      console.error('JSONパースエラー:', parseError, '行:', line);
    }
  };
  
  while (true) {
    const { done, value } = await reader.read();
    
    if (done) {
      // ストリーム終了時にデコーダをフラッシュ
      buffer += decoder.decode(new Uint8Array(), { stream: false });
      
      // バッファに残っているデータを処理（最後のcomplete/sync_completeイベント等）
      if (buffer.trim()) {
        const remainingLines = buffer.split('\n');
        for (const line of remainingLines) {
          await processEventLine(line);
        }
      }
      break;
    }
    
    // バッファに追加
    buffer += decoder.decode(value, { stream: true });
    
    // 行ごとに処理
    const lines = buffer.split('\n');
    buffer = lines.pop(); // 最後の不完全な行をバッファに戻す
    
    for (const line of lines) {
      await processEventLine(line);
    }
  }
}

/**
 * ローディングメッセージを更新（プログレスバー付き、キャンセルボタン対応）
 * @private
 * @param {string} message - 表示するメッセージ
 * @param {number|null} progress - 進捗率 (0-1)
 * @param {string|null} jobId - ジョブID（キャンセル用）
 */
function updateLoadingMessage(message, progress = null, jobId = null) {
  const loadingOverlay = document.getElementById('loadingOverlay');
  if (!loadingOverlay) return;
  
  // メッセージを更新
  const textDiv = loadingOverlay.querySelector('.loading-overlay-text');
  if (textDiv) {
    textDiv.innerHTML = message.replace(/\n/g, '<br>');
  }
  
  // プログレスバーを更新（utils.jsのshowLoadingで作成済みの要素を使用）
  const progressContainer = loadingOverlay.querySelector('.loading-progress-container');
  if (progressContainer) {
    if (progress !== null) {
      progressContainer.classList.remove('hidden');
      const clampedProgress = Math.max(0, Math.min(1, progress));
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
  
  // キャンセルボタンを更新（utils.jsのshowLoadingで作成済みの要素を使用）
  const cancelContainer = loadingOverlay.querySelector('.loading-cancel-container');
  if (cancelContainer) {
    if (jobId) {
      cancelContainer.classList.remove('hidden');
      cancelContainer.innerHTML = `
        <button 
          onclick="window.cancelCurrentJob && window.cancelCurrentJob('${jobId}')" 
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

// ========================================
// windowオブジェクトへの登録
// ========================================

// windowオブジェクトに登録
window.ociModule = {
  loadOciObjects,
  displayOciObjectsList,
  isGeneratedPageImage,
  prevPage: handleOciObjectsPrevPage,
  nextPage: handleOciObjectsNextPage,
  jumpToPage: handleOciObjectsJumpPage,
  toggleSelection: toggleOciObjectSelectionHandler,
  toggleSelectAll: toggleSelectAllOciObjects,
  selectAll: selectAllOciObjects,
  clearAll: clearAllOciObjects,
  setFilterPageImages: setOciObjectsFilterPageImages,
  setFilterEmbeddings: setOciObjectsFilterEmbeddings,
  clearFilters: clearOciObjectsFilters,
  setDisplayType: setOciObjectsDisplayType,
  downloadSelected: downloadSelectedOciObjects,
  convertToImages: convertSelectedOciObjectsToImages,
  vectorizeSelected: vectorizeSelectedOciObjects,
  deleteSelected: deleteSelectedOciObjects
};

// デフォルトエクスポート
export default {
  loadOciObjects,
  displayOciObjectsList,
  isGeneratedPageImage,
  handleOciObjectsPrevPage,
  handleOciObjectsNextPage,
  handleOciObjectsJumpPage,
  toggleOciObjectSelectionHandler,
  toggleSelectAllOciObjects,
  selectAllOciObjects,
  clearAllOciObjects,
  setOciObjectsFilterPageImages,
  setOciObjectsFilterEmbeddings,
  clearOciObjectsFilters,
  setOciObjectsDisplayType,
  downloadSelectedOciObjects,
  convertSelectedOciObjectsToImages,
  vectorizeSelectedOciObjects,
  deleteSelectedOciObjects
};
