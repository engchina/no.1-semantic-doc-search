/**
 * OCI Object Storage管理モジュール
 * 
 * OCI Object Storageの操作、表示、フィルタリング、および
 * ファイルのページ画像化・ベクトル化などのバッチ処理を担当します。
 * 
 * @module document
 */

// ========================================
// インポート文
// ========================================
import { appState, getSelectedOciObjects, toggleOciObjectSelection, setAllOciObjectsSelection } from '../state.js';
import { apiCall as authApiCall, forceLogout as authForceLogout, showLoginModal as authShowLoginModal } from './auth.js';
import { showLoading as utilsShowLoading, hideLoading as utilsHideLoading, showToast as utilsShowToast, showConfirmModal as utilsShowConfirmModal, updateStatusBadge as utilsUpdateStatusBadge, showImageModal as utilsShowImageModal } from './utils.js';

// ========================================
// OCI Objects管理
// ========================================

/**
 * ページ画像化で生成されたファイルかどうかを判定します。
 * 親ファイル名とフォルダ構造に基づいて判定します。
 * 3桁（page_001.png）および6桁（page_000001.png）の形式に対応しています。
 * 
 * @param {string} objectName - 判定対象のオブジェクト名
 * @param {Array<Object>} [allObjects=[]] - 全オブジェクトのリスト（親ファイルの存在確認用）
 * @returns {boolean} ページ画像化されたファイルの場合true
 */
export function isGeneratedPageImage(objectName, allObjects = []) {
  // 3桁または6桁のページ番号に対応
  const pageImagePattern = /\/page_(\d{3}|\d{6})\.png$/;
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
 * ページ画像からページ番号を抽出します。
 * 3桁（page_001.png）および6桁（page_000001.png）の形式に対応しています。
 * 
 * @param {string} objectName - ページ画像のオブジェクト名
 * @returns {number|null} ページ番号（数値）、抽出できない場合はnull
 */
export function extractPageNumber(objectName) {
  const match = objectName.match(/\/page_(\d{3}|\d{6})\.png$/);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

/**
 * ページ画像の親ファイルパス（拡張子なし）を取得します。
 * 
 * @param {string} objectName - ページ画像のオブジェクト名
 * @returns {string|null} 親ファイルパス、取得できない場合はnull
 */
export function getPageImageParentPath(objectName) {
  const lastSlashIndex = objectName.lastIndexOf('/');
  if (lastSlashIndex === -1) {
    return null;
  }
  return objectName.substring(0, lastSlashIndex);
}

/**
 * OCI Object Storageからオブジェクト一覧を読み込み、状態を更新します。
 * ページネーション、フィルタリング、ソートが適用されます。
 * 
 * @async
 * @param {boolean} [showLoadingOverlay=true] - ローディングオーバーレイを表示するかどうか
 * @returns {Promise<void>}
 */
export async function loadOciObjects(showLoadingOverlay = true) {
  try {
    if (showLoadingOverlay) {
      utilsShowLoading('OCI Object Storage一覧を取得中...');
    }
    
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
    
    const data = await authApiCall(`/ai/api/oci/objects?${params}`);
    
    if (showLoadingOverlay) {
      utilsHideLoading();
    }
    
    if (!data.success) {
      utilsShowToast(data.message || 'オブジェクト一覧の取得に失敗しました', 'error');
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
    
    // 総ページ数を更新
    if (data.pagination?.total_pages) {
      appState.set('ociObjectsTotalPages', data.pagination.total_pages);
    }
    
    displayOciObjectsList(data);
    
    // バッジを更新
    const totalCount = data.pagination?.total || 0;
    const statistics = data.statistics || { file_count: 0, page_image_count: 0, total_count: 0 }
    
    updateDocumentsStatusBadge(`合計: ${totalCount}件`, 'success');
    updateDocumentsStatisticsBadges(statistics, 'success');
    
  } catch (error) {
    if (showLoadingOverlay) {
      utilsHideLoading();
    }
    utilsShowToast(`OCI Object Storage一覧の取得に失敗しました: ${error.message}`, 'error');
    updateDocumentsStatusBadge('エラー', 'error');
    
    // エラー時もバッジをリセット
    updateDocumentsStatisticsBadges({ file_count: 0, page_image_count: 0, total_count: 0 }, 'error');
  }
}

/**
 * 取得したOCIオブジェクト一覧をUIに表示します。
 * フィルタリングUI、ページネーションUI、操作ボタンなども生成します。
 * 
 * @param {Object} data - APIから返却されたOCIオブジェクトデータ
 * @param {Array} data.objects - オブジェクトのリスト
 * @param {Object} data.pagination - ページネーション情報
 */
export function displayOciObjectsList(data) {
  const listDiv = document.getElementById('documentsList');
  const objects = data.objects || [];
  const pagination = data.pagination || {}
  const allOciObjects = appState.get('allOciObjects') || [];
  const selectedOciObjects = getSelectedOciObjects();
  const ociObjectsBatchDeleteLoading = appState.get('ociObjectsBatchDeleteLoading');
  const ociObjectsFilterPageImages = appState.get('ociObjectsFilterPageImages');
  const ociObjectsFilterEmbeddings = appState.get('ociObjectsFilterEmbeddings');
  const ociObjectsDisplayType = appState.get('ociObjectsDisplayType');
  
  // 現在のページに表示されているオブジェクトを保存
  appState.set('currentPageOciObjects', objects);
  
  // バケット名を保存（画像プレビュー用）
  if (data.bucket_name) {
    appState.set('ociBucketName', data.bucket_name);
  }
  
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
        <span class="text-xs font-medium text-gray-600"><i class="fas fa-folder-open"></i> 表示タイプ：</span>
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
      <div class="w-px h-6 bg-gray-300" style="display: none;"></div>
      <div class="flex items-center gap-2" style="display: none;">
        <span class="text-xs font-medium text-gray-600"><i class="fas fa-image"></i> ページ画像化:</span>
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
            完了
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
        <span class="text-xs font-medium text-gray-600">ベクトル化：</span>
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
            完了
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
          <span><i class="fas fa-times"></i></span>
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
          <div class="empty-state-icon"><i class="fas fa-folder-open" style="color: #94a3b8;"></i></div>
          <div class="empty-state-title">オブジェクトがありません</div>
          <div class="empty-state-subtitle">バケット: ${data.bucket_name || '-'}</div>
        </div>
      </div>
    `;
    
    // 空状態でもバッジを更新
    const statistics = data.statistics || { file_count: 0, page_image_count: 0, total_count: 0 };
    updateDocumentsStatisticsBadges(statistics, 'success');
    return;
  }
  
  // ボタン活性化条件の判定
  // システム安全性: 処理中でもボタンは非活性化しない（クリック時に警告メッセージを表示）
  // 操作可能性: 選択数が0の場合は、実行ボタンを非活性化
  // 合理性: 「すべて選択」「すべて解除」は選択数に関係なく使用可能（ただし処理中は不可）
  const isProcessing = ociObjectsBatchDeleteLoading;
  const hasSelection = selectedOciObjects.length > 0;
  const canSelectAction = !isProcessing; // 選択操作は処理中以外は常に可能
  const canExecuteAction = hasSelection; // 実行操作は選択がある場合のみ可能（処理中でもボタンは活性化）
  
  // 選択ボタンHTML
  const selectionButtonsHtml = `
    <div class="flex items-center gap-2 mb-2">
      <button 
        class="px-3 py-1 text-xs border rounded transition-colors ${canSelectAction ? 'hover:bg-gray-100' : 'opacity-50 cursor-not-allowed'}" 
        onclick="window.ociModule.selectAll()" 
        ${canSelectAction ? '' : 'disabled'}
        title="すべてのオブジェクトを選択"
      >
        すべて選択
      </button>
      <button 
        class="px-3 py-1 text-xs border rounded transition-colors ${canSelectAction ? 'hover:bg-gray-100' : 'opacity-50 cursor-not-allowed'}" 
        onclick="window.ociModule.clearAll()" 
        ${canSelectAction ? '' : 'disabled'}
        title="すべての選択を解除"
      >
        すべて解除
      </button>
      <button 
        class="px-2 py-1 text-xs rounded border border-red-300 text-red-600 hover:bg-red-50 transition-colors ${canExecuteAction ? '' : 'opacity-40 cursor-not-allowed'}" 
        onclick="window.ociModule.deleteSelected()" 
        ${canExecuteAction ? '' : 'disabled'}
        title="${canExecuteAction ? `選択されたアイテム（フォルダ配下の子アイテムを含む）を削除: ${selectedOciObjects.length}件` : '削除するオブジェクトを選択してください'}"
      >
        <i class="fas fa-trash-alt"></i> 削除 (${selectedOciObjects.length}件)
      </button>
      <button 
        class="px-2 py-1 text-xs rounded border border-blue-300 text-blue-600 hover:bg-blue-50 transition-colors ${canExecuteAction ? '' : 'opacity-40 cursor-not-allowed'}" 
        onclick="window.ociModule.downloadSelected()" 
        ${canExecuteAction ? '' : 'disabled'}
        title="${canExecuteAction ? `選択されたアイテム（フォルダ配下の子アイテムを含む）をZIPでダウンロード: ${selectedOciObjects.length}件` : 'ダウンロードするオブジェクトを選択してください'}"
      >
        <i class="fas fa-download"></i> ダウンロード (${selectedOciObjects.length}件)
      </button>
      <button 
        class="hidden px-3 py-1 text-xs rounded transition-colors ${canExecuteAction ? 'bg-blue-700 hover:bg-blue-800 text-white' : 'bg-blue-300 text-white cursor-not-allowed'}" 
        onclick="window.ociModule.convertToImages()" 
        ${canExecuteAction ? '' : 'disabled'}
        title="${canExecuteAction ? `選択されたファイル（フォルダ配下の子ファイルを含む）をページ毎に画像化: ${selectedOciObjects.length}件` : 'ページ画像化するファイルを選択してください'}"
      >
        <i class="fas fa-image"></i> ページ画像化 (${selectedOciObjects.length}件)
      </button>
      <button 
        class="apex-button px-4 py-2" 
        onclick="window.ociModule.vectorizeSelected()" 
        ${canExecuteAction ? '' : 'disabled'}
        title="${canExecuteAction ? `選択されたファイルの画像をベクトル化してDBに保存: ${selectedOciObjects.length}件` : 'ベクトル化するファイルを選択してください'}"
      >
        ベクトル化 (${selectedOciObjects.length}件)
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
    onPrevClick: 'window.ociModule.handleOciObjectsPrevPage()',
    onNextClick: 'window.ociModule.handleOciObjectsNextPage()',
    onJumpClick: 'window.ociModule.handleOciObjectsJumpPage',
    inputId: 'ociObjectsPageInput',
    disabled: ociObjectsBatchDeleteLoading
  }) || '';
  
  // テーブル行を生成（ファイル先 → ページ画像後、ページ画像は数値順でソート）
  // 期待順序: ファイルA → ファイルAのページ画像（001,002,...,010,011,...） → ファイルB → ファイルBのページ画像...
  const sortedObjects = [...objects].sort((a, b) => {
    const nameA = a.name || '';
    const nameB = b.name || '';
    
    const isPageImageA = isGeneratedPageImage(nameA, allOciObjects);
    const isPageImageB = isGeneratedPageImage(nameB, allOciObjects);
    
    // ソート用の基準名を取得（ファイルは拡張子なし名、ページ画像は親ファイル名）
    const baseNameA = isPageImageA ? getPageImageParentPath(nameA) : nameA.replace(/\.[^.]+$/, '');
    const baseNameB = isPageImageB ? getPageImageParentPath(nameB) : nameB.replace(/\.[^.]+$/, '');
    
    // 基準名が異なる場合、基準名の降順でソート
    if (baseNameA !== baseNameB) {
      return (baseNameB || '').localeCompare(baseNameA || '', 'ja');
    }
    
    // 基準名が同じ場合（同じファイルグループ内）
    // ファイル優先（ファイルが先、ページ画像が後）
    if (!isPageImageA && isPageImageB) {
      return -1; // ファイルが先
    }
    if (isPageImageA && !isPageImageB) {
      return 1; // ページ画像が後
    }
    
    // 両方ともファイル（通常起きないが念のため）
    if (!isPageImageA && !isPageImageB) {
      return nameB.localeCompare(nameA, 'ja');
    }
    
    // 両方ともページ画像の場合、ページ番号昇順
    const pageNumA = extractPageNumber(nameA);
    const pageNumB = extractPageNumber(nameB);
    
    if (pageNumA !== null && pageNumB !== null) {
      return pageNumA - pageNumB; // 昇順（001, 002, ..., 010, 011, ...）
    }
    
    // ページ番号が抽出できない場合はフォールバック
    return nameA.localeCompare(nameB, 'ja');
  });
  const tableRowsHtml = sortedObjects.map(obj => generateObjectRow(obj, allOciObjects, selectedOciObjects, ociObjectsBatchDeleteLoading)).join('');
  
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
              <th style="text-align: center;" class="hidden">ページ画像化</th>
              <th style="text-align: center;">ベクトル化</th>
            </tr>
          </thead>
          <tbody>
            ${tableRowsHtml}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

// ========================================
// プライベートヘルパー関数
// ========================================

/**
 * オブジェクト一覧の各行のHTMLを生成します。
 * 
 * @private
 * @param {Object} obj - オブジェクトデータ
 * @param {Array} allOciObjects - 全オブジェクトリスト
 * @param {Array} selectedOciObjects - 選択済みオブジェクトリスト
 * @param {boolean} ociObjectsBatchDeleteLoading - 処理中フラグ
 * @returns {string} HTML文字列
 */
function generateObjectRow(obj, allOciObjects, selectedOciObjects, ociObjectsBatchDeleteLoading) {
  const isFolder = obj.name.endsWith('/');
  const isPageImage = isGeneratedPageImage(obj.name, allOciObjects);
  
  // 画像ファイルかどうかを判定（PNG, JPG, JPEG）
  // 注: 元のファイルではなく、生成されたページ画像のみプレビュー可能
  const isImageFile = !isFolder && /^.+\.(png|jpg|jpeg)$/i.test(obj.name);
  const isPreviewable = isPageImage; // ページ画像のみプレビュー可能
  
  // アイコンまたはサムネイル画像
  let typeCellContent;
  if (isImageFile && isPreviewable) {
    // ページ画像の場合はサムネイルを表示（プレビュー可能）
    // 統一サイズ（20x20px）で表示し、クリックでプレビュー
    const bucketName = appState.get('ociBucketName') || '';
    const thumbnailUrl = getAuthenticatedImageUrl(bucketName, obj.name);
    // オブジェクト名をエスケープ
    const escapedName = obj.name.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    typeCellContent = `<img src="${thumbnailUrl}" alt="${obj.name.split('/').pop()}" class="file-type-thumbnail" style="width: 20px; height: 20px; border-radius: 2px; object-fit: cover; cursor: pointer; vertical-align: middle; border: 1px solid #e2e8f0;" onclick="window.ociModule.showImagePreview('${escapedName}')" onmouseover="this.style.borderColor='#1a365d'; this.style.boxShadow='0 1px 4px rgba(0,0,0,0.2)';" onmouseout="this.style.borderColor='#e2e8f0'; this.style.boxShadow='none';" title="クリックでプレビュー" onerror="this.onerror=null; this.src='data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2720%27 height=%2720%27%3E%3Crect fill=%27%23f1f5f9%27 width=%2720%27 height=%2720%27/%3E%3Ctext x=%2750%25%27 y=%2750%25%27 text-anchor=%27middle%27 dy=%27.3em%27 fill=%27%2394a3b8%27 font-size=%2712%27%3E?%3C/text%3E%3C/svg%3E';" />`;
  } else {
    // フォルダ、元ファイル、または画像以外のファイルはアイコンを表示
    const icon = isFolder ? '<i class="fas fa-folder-open"></i>' : (isPageImage ? '<i class="fas fa-image"></i>' : '<i class="fas fa-file"></i>');
    typeCellContent = icon;
  }
  
  const isChecked = selectedOciObjects.includes(obj.name);
  
  // ページ画像化状態（ページ画像の場合は空表示）
  const hasPageImages = obj.has_page_images;
  const pageImagesStatusHtml = (isPageImage || hasPageImages == null) ? '' :
    (hasPageImages ? '<span class="badge badge-success">完了</span>' : 
    '<span class="badge badge-neutral">未実行</span>');
  
  // ベクトル化状態（ページ画像の場合は空表示）
  const hasEmbeddings = obj.has_embeddings;
  const embeddingsStatusHtml = (isPageImage || hasEmbeddings == null) ? '' :
    (hasEmbeddings ? '<span class="badge badge-success">完了</span>' : 
    '<span class="badge badge-neutral">未実行</span>');
  
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
      <td>${typeCellContent}</td>
      <td>${obj.name}</td>
      <td>${obj.size ? formatBytes(obj.size) : '-'}</td>
      <td>${obj.time_created || '-'}</td>
      <td style="text-align: center;" class="hidden">${pageImagesStatusHtml}</td>
      <td style="text-align: center;">${embeddingsStatusHtml}</td>
    </tr>
  `;
}

/**
 * バイト数を人間が読みやすい形式（KB, MB, GB）にフォーマットします。
 * 
 * @private
 * @param {number} bytes - バイト数
 * @returns {string} フォーマットされた文字列
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

/**
 * 認証トークン付きの画像URLを生成します。
 * 
 * @private
 * @param {string} bucket - バケット名
 * @param {string} objectName - オブジェクト名
 * @returns {string} 認証トークン付きのURL
 */
function getAuthenticatedImageUrl(bucket, objectName) {
  const token = localStorage.getItem('loginToken');
  const baseUrl = `/ai/api/object/${bucket}/${encodeURIComponent(objectName)}`;
  if (token) {
    return `${baseUrl}?token=${encodeURIComponent(token)}`;
  }
  return baseUrl;
}

/**
 * 画像プレビューモーダルを表示します。
 * 登録済み文書一覧のサムネイルクリック時に呼び出されます。
 * 
 * @param {string} objectName - オブジェクト名
 */
export function showImagePreview(objectName) {
  const bucketName = appState.get('ociBucketName') || '';
  const imageUrl = getAuthenticatedImageUrl(bucketName, objectName);
  const filename = objectName.split('/').pop();
  
  // 共通のshowImageModal関数を呼び出し
  utilsShowImageModal(imageUrl, filename);
}

/**
 * ドキュメントステータスバッジを更新します。
 * 
 * @private
 * @param {string} text - 表示テキスト
 * @param {string} type - バッジタイプ ('success', 'error'など)
 */
function updateDocumentsStatusBadge(text, type) {
  const badge = document.getElementById('documentsStatusBadge');
  if (!badge) return;
  badge.textContent = text;
}

/**
 * ドキュメント統計バッジを更新します。
 * ファイル数とページ画像数を表示します。
 * 
 * @private
 * @param {Object} statistics - 統計情報
 * @param {string} type - バッジタイプ
 */
function updateDocumentsStatisticsBadges(statistics, type) {
  const fileCountBadge = document.getElementById('documentsFileCountBadge');
  const pageImageCountBadge = document.getElementById('documentsPageImageCountBadge');
  
  if (fileCountBadge) {
    fileCountBadge.textContent = `ファイル: ${statistics.file_count}件`;
    fileCountBadge.style.display = 'inline-block';
  }
  if (pageImageCountBadge) {
    pageImageCountBadge.textContent = `ページ画像: ${statistics.page_image_count}件`;
    pageImageCountBadge.style.display = 'inline-block';
  }
}

// ========================================
// ページネーション操作
// ========================================

/**
 * 前のページへ移動します。
 */
export function handleOciObjectsPrevPage() {
  const currentPage = appState.get('ociObjectsPage');
  if (currentPage > 1) {
    appState.set('ociObjectsPage', currentPage - 1);
    loadOciObjects();
  }
}

/**
 * 次のページへ移動します。
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
 * 指定されたページへジャンプします。
 * 入力フィールドの値を使用します。
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
    utilsShowToast(`ページ番号は1〜${totalPages}の範囲で指定してください`, 'warning');
  }
}

// ========================================
// 選択操作
// ========================================

/**
 * 指定されたオブジェクトの選択状態を切り替えます。
 * 画面のスクロール位置を保持しながら再描画します。
 * 
 * @param {string} objectName - オブジェクト名
 */
export function toggleOciObjectSelectionHandler(objectName) {
  // スクロール位置を保存
  const scrollableArea = document.querySelector('#documentsList .table-wrapper-scrollable');
  const scrollTop = scrollableArea ? scrollableArea.scrollTop : 0;
  
  const selectedOciObjects = getSelectedOciObjects();
  const isSelected = selectedOciObjects.includes(objectName);
  toggleOciObjectSelection(objectName, !isSelected);
  
  // UIを再描画して、ボタンの活性状態を更新
  loadOciObjects(false).then(() => {
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
 * 現在のページのすべてのオブジェクトの選択状態を切り替えます。
 * 
 * @param {boolean} checked - チェック状態
 */
export function toggleSelectAllOciObjects(checked) {
  // スクロール位置を保存
  const scrollableArea = document.querySelector('#documentsList .table-wrapper-scrollable');
  const scrollTop = scrollableArea ? scrollableArea.scrollTop : 0;
  
  // 現在のページに表示されているオブジェクトを使用
  const currentPageObjects = appState.get('currentPageOciObjects') || [];
  const allOciObjects = appState.get('allOciObjects') || [];
  
  const selectableObjects = currentPageObjects
    .filter(obj => !isGeneratedPageImage(obj.name, allOciObjects))
    .map(obj => obj.name);
  
  setAllOciObjectsSelection(selectableObjects, checked);
  
  // 再描画
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
 * リスト内のすべての選択可能なオブジェクトを選択します。
 * 現在のページに表示されているオブジェクトのみを選択します。
 */
export function selectAllOciObjects() {
  // スクロール位置を保存
  const scrollableArea = document.querySelector('#documentsList .table-wrapper-scrollable');
  const scrollTop = scrollableArea ? scrollableArea.scrollTop : 0;
  
  // 現在のページに表示されているオブジェクトのみを対象にする
  const currentPageObjects = appState.get('currentPageOciObjects') || [];
  const allOciObjects = appState.get('allOciObjects') || [];
  const selectableObjects = currentPageObjects
    .filter(obj => !isGeneratedPageImage(obj.name, allOciObjects))
    .map(obj => obj.name);
  
  // 現在の選択に追加（既存の選択を保持しながら追加）
  const currentSelection = getSelectedOciObjects();
  const newSelection = [...new Set([...currentSelection, ...selectableObjects])];
  appState.set('selectedOciObjects', newSelection);
  
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
 * すべての選択を解除します。
 */
export function clearAllOciObjects() {
  // スクロール位置を保存
  const scrollableArea = document.querySelector('#documentsList .table-wrapper-scrollable');
  const scrollTop = scrollableArea ? scrollableArea.scrollTop : 0;
  
  appState.set('selectedOciObjects', []);
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

// ========================================
// フィルター操作
// ========================================

/**
 * ページ画像化状態によるフィルターを設定します。
 * 
 * @param {string} filter - フィルター値 ('all' | 'done' | 'not_done')
 */
export function setOciObjectsFilterPageImages(filter) {
  appState.set('ociObjectsFilterPageImages', filter);
  appState.set('ociObjectsPage', 1);
  loadOciObjects();
}

/**
 * ベクトル化状態によるフィルターを設定します。
 * 
 * @param {string} filter - フィルター値 ('all' | 'done' | 'not_done')
 */
export function setOciObjectsFilterEmbeddings(filter) {
  appState.set('ociObjectsFilterEmbeddings', filter);
  appState.set('ociObjectsPage', 1);
  loadOciObjects();
}

/**
 * すべてのフィルターをクリアし、デフォルト状態に戻します。
 */
export function clearOciObjectsFilters() {
  appState.set('ociObjectsFilterPageImages', 'all');
  appState.set('ociObjectsFilterEmbeddings', 'all');
  appState.set('ociObjectsPage', 1);
  loadOciObjects();
}

/**
 * 表示タイプフィルター（ファイルのみ/すべて）を設定します。
 * 
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
 * 選択されたOCIオブジェクトをZIP形式でダウンロードします。
 * フォルダが含まれる場合は再帰的にダウンロードされます。
 * 
 * @async
 * @returns {Promise<void>}
 */
export async function downloadSelectedOciObjects() {
  const selectedOciObjects = getSelectedOciObjects();
  
  if (selectedOciObjects.length === 0) {
    utilsShowToast('ダウンロードするファイルを選択してください', 'warning');
    return;
  }
  
  const ociObjectsBatchDeleteLoading = appState.get('ociObjectsBatchDeleteLoading');
  if (ociObjectsBatchDeleteLoading) {
    utilsShowToast('処理中です。しばらくお待ちください', 'warning');
    return;
  }
  
  // トークンを確認（localStorageから直接取得 - referenceプロジェクトに準拠）
  const loginToken = localStorage.getItem('loginToken');
  const debugMode = appState.get('debugMode');
  
  if (!loginToken && !debugMode) {
    utilsShowToast('認証が必要です。ログインしてください', 'warning');
    authShowLoginModal();
    return;
  }
  
  try {
    appState.set('ociObjectsBatchDeleteLoading', true);
    utilsShowLoading(`${selectedOciObjects.length}件のファイルをZIPに圧縮中...`);
    
    // リクエストヘッダーを構築
    const headers = {
      'Content-Type': 'application/json'
    }
    
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
        utilsHideLoading();
        appState.set('ociObjectsBatchDeleteLoading', false);
        const requireLogin = appState.get('requireLogin');
        if (requireLogin) {
          authForceLogout();
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
    appState.set('ociObjectsBatchDeleteLoading', false);
    utilsShowToast(`${selectedOciObjects.length}件のファイルをダウンロードしました`, 'success');
    
    // 一覧を再読み込みして状態を同期
    await loadOciObjects(false);
    
  } catch (error) {
    console.error('ダウンロードエラー:', error);
    utilsShowToast(`ダウンロードに失敗しました: ${error.message}`, 'error');
    
    // エラー時も一覧を再読み込みして状態を同期
    utilsHideLoading();
    appState.set('ociObjectsBatchDeleteLoading', false);
    await loadOciObjects(false);
  }
}

/**
 * 選択されたOCIオブジェクトをページごとに画像化（PDF/PPTX等）します。
 * サーバー側で処理を実行し、進捗をSSEで受信します。
 * 
 * @async
 * @returns {Promise<void>}
 */
export async function convertSelectedOciObjectsToImages() {
  const selectedOciObjects = getSelectedOciObjects();
  
  if (selectedOciObjects.length === 0) {
    utilsShowToast('変換するファイルを選択してください', 'warning');
    return;
  }
  
  const ociObjectsBatchDeleteLoading = appState.get('ociObjectsBatchDeleteLoading');
  if (ociObjectsBatchDeleteLoading) {
    utilsShowToast('処理中です。しばらくお待ちください', 'warning');
    return;
  }
  
  // トークンを確認（localStorageから直接取得 - referenceプロジェクトに準拠）
  const loginToken = localStorage.getItem('loginToken');
  const debugMode = appState.get('debugMode');
  
  if (!loginToken && !debugMode) {
    utilsShowToast('認証が必要です。ログインしてください', 'warning');
    authShowLoginModal();
    return;
  }
  
  // 確認モーダルを表示
  const confirmed = await utilsShowConfirmModal(
    `選択された${selectedOciObjects.length}件のファイルを各ページPNG画像として同名フォルダに保存します。\n\n処理には時間がかかる場合があります。実行しますか？`,
    'ページ画像化確認'
  );
  
  if (!confirmed) {
    return;
  }
  
  try {
    appState.set('ociObjectsBatchDeleteLoading', true);
    utilsShowLoading('ページ画像化を準備中...\nサーバーに接続しています');
    
    // リクエストヘッダーを構築
    const headers = {
      'Content-Type': 'application/json'
    }
    
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
        utilsHideLoading();
        appState.set('ociObjectsBatchDeleteLoading', false);
        const requireLogin = appState.get('requireLogin');
        if (requireLogin) {
          authForceLogout();
        }
        throw new Error('無効または期限切れのトークンです');
      }
      
      utilsHideLoading();
      appState.set('ociObjectsBatchDeleteLoading', false);
      const errorData = await response.json();
      throw new Error(errorData.detail || 'ページ画像化に失敗しました');
    }
    
    // SSE (Server-Sent Events) を使用して進捗状況を受信
    await processStreamingResponse(response, selectedOciObjects.length, 'convert');
    
  } catch (error) {
    console.error('ページ画像化エラー:', error);
    utilsShowToast(`ページ画像化に失敗しました: ${error.message}`, 'error');
    
    // エラー時も一覧を再読み込みして状態を同期
    utilsHideLoading();
    appState.set('ociObjectsBatchDeleteLoading', false);
    await loadOciObjects(false);
  }
}

/**
 * 選択されたOCIオブジェクトをベクトル化してデータベースに保存します。
 * 未画像化のファイルは自動的に画像化されます。既存のベクトルデータは削除・再作成されます。
 * 
 * @async
 * @returns {Promise<void>}
 */
export async function vectorizeSelectedOciObjects() {
  const selectedOciObjects = getSelectedOciObjects();
  
  if (selectedOciObjects.length === 0) {
    utilsShowToast('ベクトル化するファイルを選択してください', 'warning');
    return;
  }
  
  const ociObjectsBatchDeleteLoading = appState.get('ociObjectsBatchDeleteLoading');
  if (ociObjectsBatchDeleteLoading) {
    utilsShowToast('処理中です。しばらくお待ちください', 'warning');
    return;
  }
  
  // トークンを確認（localStorageから直接取得 - referenceプロジェクトに準拠）
  const loginToken = localStorage.getItem('loginToken');
  const debugMode = appState.get('debugMode');
  
  if (!loginToken && !debugMode) {
    utilsShowToast('認証が必要です。ログインしてください', 'warning');
    authShowLoginModal();
    return;
  }
  
  // 確認モーダルを表示
  const confirmed = await utilsShowConfirmModal(
    `選択された<strong>${selectedOciObjects.length}件のファイル</strong>を画像ベクトル化してデータベースに保存します。
<warning>既存の画像イメージやEmbeddingがある場合は削除してから再作成します。</warning>
<small>※ファイルが未画像化の場合は、自動的にページ画像化を実行してからベクトル化します。</small>
処理には時間がかかる場合があります。実行しますか？`,
    'ベクトル化確認',
    { variant: 'warning' }
  );
  
  if (!confirmed) {
    console.log('❌ User cancelled vectorization');
    return;
  }
  
  console.log('✅ User confirmed vectorization');
  console.log('✅ selectedOciObjects:', selectedOciObjects);
  
  try {
    console.log('✅ Setting loading state...');
    appState.set('ociObjectsBatchDeleteLoading', true);
    
    console.log('🔵 Before showProcessProgressUI:', selectedOciObjects);
    
    // メインページに進捗UIを表示
    showProcessProgressUI(selectedOciObjects, 'vectorize');
    
    console.log('🔵 After showProcessProgressUI');
    
    // リクエストヘッダーを構築
    const headers = {
      'Content-Type': 'application/json'
    }
    
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
        hideProcessProgressUI();
        appState.set('ociObjectsBatchDeleteLoading', false);
        const requireLogin = appState.get('requireLogin');
        if (requireLogin) {
          authForceLogout();
        }
        throw new Error('無効または期限切れのトークンです');
      }
      
      hideProcessProgressUI();
      appState.set('ociObjectsBatchDeleteLoading', false);
      const errorData = await response.json();
      throw new Error(errorData.detail || 'ベクトル化に失敗しました');
    }
    
    // SSE (Server-Sent Events) を使用して進捗状況を受信
    await processStreamingResponse(response, selectedOciObjects.length, 'vectorize');
    
  } catch (error) {
    hideProcessProgressUI();
    appState.set('ociObjectsBatchDeleteLoading', false);
    console.error('ベクトル化エラー:', error);
    utilsShowToast(`ベクトル化エラー: ${error.message}`, 'error');
    
    // 選択をクリアして一覧を更新
    appState.set('selectedOciObjects', []);
    await loadOciObjects();
  }
}

/**
 * 選択されたOCIオブジェクトを削除します。
 * 確認モーダルを表示後、サーバーに削除リクエストを送信します。
 * 
 * @async
 * @returns {Promise<void>}
 */
export async function deleteSelectedOciObjects() {
  const selectedOciObjects = getSelectedOciObjects();
  
  if (selectedOciObjects.length === 0) {
    utilsShowToast('削除するオブジェクトを選択してください', 'warning');
    return;
  }
  
  // ベクトル化処理中かどうかをチェック
  const ociObjectsBatchDeleteLoading = appState.get('ociObjectsBatchDeleteLoading');
  if (ociObjectsBatchDeleteLoading) {
    utilsShowToast('処理中です。しばらくお待ちください', 'warning');
    return;
  }
  
  const count = selectedOciObjects.length;
  const confirmed = await utilsShowConfirmModal(
    `選択された${count}件のオブジェクトを削除しますか？\n\nこの操作は元に戻せません。`,
    'オブジェクト削除の確認',
    { variant: 'danger', confirmText: '削除' }
  );
  
  if (!confirmed) {
    return;
  }
  
  // 処理中表示を設定
  appState.set('ociObjectsBatchDeleteLoading', true);
  
  console.log('🔴 Before showProcessProgressUI (delete):', selectedOciObjects);
  
  // メインページに進捗UIを表示
  showProcessProgressUI(selectedOciObjects, 'delete');
  
  console.log('🔴 After showProcessProgressUI (delete)');
  
  try {
    // SSEストリーミング対応のAPI呼び出し
    const loginToken = localStorage.getItem('loginToken');
    const headers = {
      'Content-Type': 'application/json'
    }
    // トークンがある場合のみAuthorizationヘッダーを追加
    if (loginToken) {
      headers['Authorization'] = `Bearer ${loginToken}`;
    }
    
    const response = await fetch('/ai/api/oci/objects/delete', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        object_names: selectedOciObjects
      })
    });
    
    if (!response.ok) {
      // 401エラーの場合は強制ログアウト（referenceプロジェクトに準拠）
      if (response.status === 401) {
        hideProcessProgressUI();
        appState.set('ociObjectsBatchDeleteLoading', false);
        const requireLogin = appState.get('requireLogin');
        if (requireLogin) {
          authForceLogout();
        }
        throw new Error('無効または期限切れのトークンです');
      }
      hideProcessProgressUI();
      appState.set('ociObjectsBatchDeleteLoading', false);
      const errorData = await response.json();
      throw new Error(errorData.detail || '削除に失敗しました');
    }
    
    // SSE (Server-Sent Events) を使用して進捗状況を受信
    await processStreamingResponse(response, selectedOciObjects.length, 'delete');
    
  } catch (error) {
    hideProcessProgressUI();
    appState.set('ociObjectsBatchDeleteLoading', false);
    console.error('削除エラー:', error);
    utilsShowToast(`削除エラー: ${error.message}`, 'error');
    
    // 選択をクリアして一覧を更新
    appState.set('selectedOciObjects', []);
    await loadOciObjects();
  }
}

// ========================================
// ストリーミング処理関数
// ========================================

/**
 * SSE (Server-Sent Events) ストリーミングレスポンスを処理します。
 * 各種イベント（進捗、エラー、完了など）に応じてUIを更新します。
 * 
 * @private
 * @async
 * @param {Response} response - Fetch APIのレスポンスオブジェクト
 * @param {number} totalFiles - 処理対象の総ファイル数
 * @param {string} operationType - 操作種別 ('convert', 'vectorize', 'delete')
 * @returns {Promise<void>}
 */
async function processStreamingResponse(response, totalFiles, operationType) {
  console.log('🔴 processStreamingResponse called:', { totalFiles, operationType });
  
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  const streamStartedAt = Date.now();
  
  // ジョブIDをヘッダーから取得
  const jobId = response.headers.get('X-Job-ID');
  
  let currentFileIndex = 0;
  let currentPageIndex = 0;
  let totalPages = 0;
  let processedPages = 0;
  let totalPagesAllFiles = 0;
  let totalWorkers = 1; // 並列ワーカー数
  
  // 各ファイルの進捗状態を追跡（進捗が下がらないようにするため）
  const fileProgressMap = new Map();
  
  /**
   * ファイルの進捗を更新（単調増加を保証）
   * @param {number} fileIndex - ファイルインデックス (1始まり)
   * @param {number} newProgress - 新しい進捗値 (0-100)
   * @returns {number} - 適用すべき進捗値
   */
  const getMonotonicProgress = (fileIndex, newProgress) => {
    const currentProgress = fileProgressMap.get(fileIndex) || 0;
    const finalProgress = Math.max(currentProgress, newProgress);
    fileProgressMap.set(fileIndex, finalProgress);
    return finalProgress;
  };
  
  // 削除・ベクトル化はメインページ進捗UIを使用
  const useProgressUI = operationType === 'delete' || operationType === 'vectorize';
  
  console.log('🔴 useProgressUI:', useProgressUI);
  
  // メインページ進捗UIを使用する場合は、既存のローディングオーバーレイを確実に削除
  if (useProgressUI) {
    console.log('🔴 Hiding loading overlay...');
    utilsHideLoading();
  }
  
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
              if (useProgressUI) {
                let overallStatus = operationType === 'vectorize' 
                  ? `ベクトル化を開始しています... (並列ワーカー: ${totalWorkers})`
                  : `削除を開始しています...`;
                updateProcessProgressUI({ overallStatus, jobId });
              } else {
                let startMessage = `ファイルをページ画像化中... (0/${totalFiles})\n並列ワーカー: ${totalWorkers}`;
                updateLoadingMessage(startMessage, 0, jobId);
              }
              break;
                        
            case 'heartbeat':
              {
                const elapsedSeconds = Number.isFinite(Number(data.elapsed_seconds))
                  ? Number(data.elapsed_seconds)
                  : Math.round((Date.now() - streamStartedAt) / 1000);
                const elapsedLabel = `${Math.max(0, Math.round(elapsedSeconds))}秒経過`;
                const heartbeatFileIndex = data.file_index || currentFileIndex;
                const heartbeatTotalFiles = data.total_files || totalFiles;
                const heartbeatJobId = data.job_id || jobId;
                const actionLabel = operationType === 'vectorize'
                  ? '索引処理中'
                  : operationType === 'delete'
                    ? '削除中'
                    : 'ページ画像化中';
                if (useProgressUI) {
                  const update = {
                    overallStatus: heartbeatFileIndex > 0
                      ? `処理中: ${heartbeatFileIndex}/${heartbeatTotalFiles}件 (${elapsedLabel})`
                      : `${actionLabel}... ${elapsedLabel}`,
                    jobId: heartbeatJobId
                  };
                  if (heartbeatFileIndex > 0) {
                    update.fileIndex = heartbeatFileIndex;
                    update.status = `${actionLabel}... ${elapsedLabel}`;
                  }
                  updateProcessProgressUI(update);
                } else {
                  const progressText = document.querySelector('#loadingOverlay .loading-progress-percent')?.textContent || '';
                  const progressMatch = progressText.match(/(\d+)%/);
                  const currentProgress = progressMatch ? Number(progressMatch[1]) / 100 : null;
                  const fileLine = data.file_name ? `\n${data.file_name}` : '';
                  updateLoadingMessage(`${actionLabel}... ${elapsedLabel}${fileLine}`, currentProgress, heartbeatJobId);
                }
              }
              break;
                        
            case 'file_start':
              currentFileIndex = data.file_index;
              if (data.total_files) totalFiles = data.total_files;
              if (useProgressUI) {
                updateProcessProgressUI({
                  fileIndex: currentFileIndex,
                  status: '待機中...',
                  progress: getMonotonicProgress(currentFileIndex, 0),
                  overallStatus: `処理中: ${currentFileIndex - 1}/${totalFiles}件`,
                  jobId
                });
              } else {
                const fileStartProgress = (currentFileIndex - 1) / (totalFiles || 1);
                let fileStartMessage = `ファイル ${currentFileIndex}/${totalFiles} 待機中...\n${data.file_name}`;
                updateLoadingMessage(fileStartMessage, fileStartProgress, jobId);
              }
              break;
            
            case 'file_checking':
              currentFileIndex = data.file_index;
              if (data.total_files) totalFiles = data.total_files;
              if (useProgressUI) {
                updateProcessProgressUI({
                  fileIndex: currentFileIndex,
                  status: 'DB確認中',
                  progress: getMonotonicProgress(currentFileIndex, 10),
                  jobId
                });
              } else {
                const checkingProgress = (currentFileIndex - 1) / (totalFiles || 1);
                updateLoadingMessage(`ファイル ${currentFileIndex}/${totalFiles}\n${data.file_name}\nステータス: DB確認中`, checkingProgress, jobId);
              }
              break;
            
            case 'delete_existing_embeddings':
              // 既存のembeddingを削除中
              if (useProgressUI) {
                updateProcessProgressUI({
                  fileIndex: currentFileIndex,
                  status: '既存ベクトルデータ削除中',
                  progress: getMonotonicProgress(currentFileIndex, 20),
                  jobId
                });
              } else {
                const deleteEmbProgress = (currentFileIndex - 1) / (totalFiles || 1);
                updateLoadingMessage(`ファイル ${currentFileIndex}/${totalFiles}\n${data.file_name}\nステータス: 既存ベクトルデータ削除中`, deleteEmbProgress, jobId);
              }
              break;
            
            case 'cleanup_start':
              // 既存画像の確認開始
              if (useProgressUI) {
                updateProcessProgressUI({
                  fileIndex: currentFileIndex,
                  status: '既存画像を確認中',
                  progress: getMonotonicProgress(currentFileIndex, 25),
                  jobId
                });
              } else {
                const cleanupStartProgress = totalFiles > 0 ? (currentFileIndex - 1) / totalFiles : 0;
                updateLoadingMessage(`ファイル ${currentFileIndex}/${totalFiles}\n${data.file_name}\nステータス: 既存画像を確認中`, cleanupStartProgress, jobId);
              }
              break;
            
            case 'cleanup_progress':
              // 既存画像を削除中
              if (useProgressUI) {
                updateProcessProgressUI({
                  fileIndex: currentFileIndex,
                  status: `既存画像 ${data.cleanup_count}件を削除中`,
                  progress: getMonotonicProgress(currentFileIndex, 30),
                  jobId
                });
              } else {
                const cleanupProgress = totalFiles > 0 ? (currentFileIndex - 1) / totalFiles : 0;
                updateLoadingMessage(`ファイル ${currentFileIndex}/${totalFiles}\n${data.file_name}\nステータス: 既存画像 ${data.cleanup_count}件を削除中`, cleanupProgress, jobId);
              }
              break;
            
            case 'cleanup_complete':
              // 既存画像削除完了
              if (useProgressUI) {
                updateProcessProgressUI({
                  fileIndex: currentFileIndex,
                  status: `既存画像 ${data.deleted_count}件を削除完了`,
                  progress: getMonotonicProgress(currentFileIndex, 35),
                  jobId
                });
              } else {
                const cleanupCompleteProgress = totalFiles > 0 ? (currentFileIndex - 1) / totalFiles : 0;
                updateLoadingMessage(`ファイル ${currentFileIndex}/${totalFiles}\n${data.file_name}\nステータス: 既存画像 ${data.deleted_count}件を削除完了`, cleanupCompleteProgress, jobId);
              }
              break;
                        
            case 'auto_convert_start':
              // 自動ページ画像化開始
              if (useProgressUI) {
                updateProcessProgressUI({
                  fileIndex: currentFileIndex,
                  status: '自動ページ画像化開始',
                  progress: getMonotonicProgress(currentFileIndex, 40),
                  jobId
                });
              } else {
                updateLoadingMessage(`ファイル ${currentFileIndex}/${totalFiles}\n${data.file_name}\nステータス: 自動ページ画像化開始`, totalFiles > 0 ? (currentFileIndex - 1) / totalFiles : 0, jobId);
              }
              utilsShowToast(`自動的にページ画像化を実行中: ${data.file_name}`, 'info');
              break;
            
            case 'auto_convert_progress':
              // 自動ページ画像化の進捗
              if (useProgressUI) {
                updateProcessProgressUI({
                  fileIndex: currentFileIndex,
                  status: `${data.total_pages}ページをアップロード中`,
                  progress: getMonotonicProgress(currentFileIndex, 45),
                  jobId
                });
              } else {
                updateLoadingMessage(`ファイル ${currentFileIndex}/${totalFiles}\n${data.file_name}\nステータス: ${data.total_pages}ページをアップロード中`, totalFiles > 0 ? (currentFileIndex - 1) / totalFiles : 0, jobId);
              }
              break;
            
            case 'auto_convert_complete':
              // 自動ページ画像化完了
              if (useProgressUI) {
                updateProcessProgressUI({
                  fileIndex: currentFileIndex,
                  status: `ページ画像化完了 (${data.total_pages}ページ)`,
                  progress: getMonotonicProgress(currentFileIndex, 50),
                  jobId
                });
              } else {
                updateLoadingMessage(`ファイル ${currentFileIndex}/${totalFiles}\n${data.file_name}\nステータス: ページ画像化完了 (${data.total_pages}ページ)`, totalFiles > 0 ? (currentFileIndex - 1) / totalFiles : 0, jobId);
              }
              utilsShowToast(`ページ画像化完了: ${data.file_name} (${data.total_pages}ページ)`, 'success');
              break;
            
            case 'vectorize_start':
              // ベクトル化処理開始
              currentFileIndex = data.file_index || currentFileIndex;
              totalPages = data.total_pages;
              const vectorizeStatus = data.total_pages
                ? `ベクトル化開始 (${data.total_pages}ページ)`
                : 'インデックス作成開始';
              if (useProgressUI) {
                updateProcessProgressUI({
                  fileIndex: currentFileIndex,
                  status: vectorizeStatus,
                  progress: getMonotonicProgress(currentFileIndex, 55),
                  jobId
                });
              } else {
                updateLoadingMessage(`ファイル ${currentFileIndex}/${totalFiles}\n${data.file_name}\nステータス: ${vectorizeStatus}`, totalFiles > 0 ? (currentFileIndex - 1) / totalFiles : 0, jobId);
              }
              break;
                        
            case 'file_uploading':
              currentFileIndex = data.file_index;
              if (data.total_files) totalFiles = data.total_files;
              if (useProgressUI) {
                let statusMsg = operationType === 'vectorize' ? 'ベクトル化中' : '削除中';
                updateProcessProgressUI({
                  fileIndex: currentFileIndex,
                  status: statusMsg,
                  progress: getMonotonicProgress(currentFileIndex, 50),
                  overallStatus: `処理中: ${currentFileIndex}/${totalFiles}件`,
                  jobId
                });
              } else {
                const processingProgress = totalFiles > 0 ? (currentFileIndex - 1) / totalFiles : 0;
                let uploadingMessage = `ファイル ${data.file_index}/${totalFiles}\n${data.file_name}\nステータス: 画像化中`;
                updateLoadingMessage(uploadingMessage, processingProgress, jobId);
              }
              break;
              
            case 'page_progress':
              currentPageIndex = data.page_index;
              totalPages = data.total_pages;
              const fileIdx = data.file_index || currentFileIndex || 1;
              if (useProgressUI) {
                // ベクトル化進捗: 55%～99%の範囲で計算（完了時に100%になるように余地を残す）
                const rawProgress = totalPages > 0 ? Math.round((currentPageIndex / totalPages) * 44) + 55 : 55;
                const pageProgressPercent = getMonotonicProgress(fileIdx, rawProgress);
                let pageStatusMsg = operationType === 'vectorize' 
                  ? `索引処理 ${currentPageIndex}/${totalPages} を実行中`
                  : `ページ ${currentPageIndex}/${totalPages} を処理中`;
                updateProcessProgressUI({
                  fileIndex: fileIdx,
                  status: pageStatusMsg,
                  progress: pageProgressPercent,
                  jobId
                });
              } else {
                const pageProgress = operationType === 'convert' ?
                  (totalPagesAllFiles > 0 ? (processedPages + 1) / totalPagesAllFiles : 0) :
                  (totalFiles > 0 ? (fileIdx - 1 + (currentPageIndex || 0) / (totalPages || 1)) / totalFiles : 0);
                updateLoadingMessage(`ファイル ${fileIdx}/${data.total_files || totalFiles}\nページ ${currentPageIndex}/${totalPages} を${operationType === 'convert' ? '画像化' : 'ベクトル化'}中...`, pageProgress, jobId);
              }
              processedPages++;
              break;
              
            case 'pages_count':
              totalPages = data.total_pages;
              totalPagesAllFiles += totalPages;
              break;
              
            case 'file_complete':
              currentFileIndex = data.file_index || currentFileIndex;
              const totalForComplete = data.total_files || totalFiles || 1;
              // 完了時は確実に100%に設定（getMonotonicProgressを通す）
              const completeProgress = getMonotonicProgress(currentFileIndex, 100);
              if (useProgressUI) {
                updateProcessProgressUI({
                  fileIndex: currentFileIndex,
                  status: '完了',
                  progress: completeProgress,
                  isSuccess: true,
                  overallStatus: `処理中: ${currentFileIndex}/${totalForComplete}件 完了`,
                  jobId
                });
              } else {
                const completedFileProgress = totalForComplete > 0 ? currentFileIndex / totalForComplete : 0;
                let completeMessage = `ファイル ${currentFileIndex}/${totalForComplete} 完了\n${data.file_name}`;
                updateLoadingMessage(completeMessage, completedFileProgress, jobId);
              }
              break;
              
            case 'file_error':
              console.error(`${operationType === 'delete' ? 'オブジェクト' : 'ファイル'} ${data.file_index}/${data.total_files || totalFiles} エラー: ${data.error}`);
              const totalForError = data.total_files || totalFiles || 1;
              const errorFileIdx = data.file_index || currentFileIndex || 1;
              // エラー時も進捗バーを完了状態にする
              const errorProgress = getMonotonicProgress(errorFileIdx, 100);
              if (useProgressUI) {
                updateProcessProgressUI({
                  fileIndex: errorFileIdx,
                  status: `✗ エラー: ${data.error}`,
                  progress: errorProgress,
                  isError: true,
                  overallStatus: `処理中: ${errorFileIdx}/${totalForError}件`,
                  jobId
                });
              } else {
                const errorProgress = totalForError > 0 && errorFileIdx > 0 ? (errorFileIdx - 1) / totalForError : 0;
                let errorMessage = `ファイル ${errorFileIdx}/${totalForError} ✗ エラー\n${data.file_name}\n${data.error}`;
                updateLoadingMessage(errorMessage, errorProgress, jobId);
              }
              break;
              
            case 'cancelled':
              utilsShowToast(`処理がキャンセルされました\n${data.message}`, 'info');
              appState.set('selectedOciObjects', []);
              
              // フラグをクリアしてから確実に再描画
              if (useProgressUI) {
                hideProcessProgressUI();
              } else {
                utilsHideLoading();
              }
              appState.set('ociObjectsBatchDeleteLoading', false);
              // メインページ進捗UIを使用している場合は、ローディングオーバーレイを表示しない
              await loadOciObjects(!useProgressUI);
              break;
              
            case 'error':
              utilsShowToast(`エラー: ${data.message}`, 'error');
              
              // フラグをクリアしてから確実に再描画
              if (useProgressUI) {
                hideProcessProgressUI();
              } else {
                utilsHideLoading();
              }
              appState.set('ociObjectsBatchDeleteLoading', false);
              await loadOciObjects(!useProgressUI);
              break;
              
            case 'progress_update':
              // 進捗状況のリアルタイム更新
              const progressPercent = data.total_count > 0 ? data.completed_count / data.total_count : 0;
              if (useProgressUI) {
                updateProcessProgressUI({
                  overallStatus: `処理中: ${data.completed_count}/${data.total_count} | 成功: ${data.success_count}件 | 失敗: ${data.failed_count}件`,
                  jobId
                });
              } else {
                updateLoadingMessage(
                  `処理中: ${data.completed_count}/${data.total_count}\n成功: ${data.success_count}件 | 失敗: ${data.failed_count}件`,
                  progressPercent,
                  jobId
                );
              }
              // 注: progress_update時にUI更新を行わない（処理中フラグがtrueのため、チェックボックスがdisabledになり、ユーザーが選択できなくなる）
              // 最終的にcompleteイベントでUIを更新する
              break;
              
            case 'sync_complete':
              // すべての処理が完了し、状態が完全に同期された
              console.log('同期完了イベント受信:', data);
              break;
              
            case 'complete':
              appState.set('ociObjectsBatchDeleteLoading', false);
              
              if (useProgressUI) {
                // メインページ進捗UIに完了表示
                let finalStatus = data.success 
                  ? `すべて完了しました (${data.success_count}件)`
                  : `完了: 成功 ${data.success_count}件 | 失敗 ${data.failed_count}件`;
                updateProcessProgressUI({ overallStatus: finalStatus });
                showProcessProgressCloseButton();
              } else {
                utilsHideLoading();
              }
              
              if (data.success) {
                utilsShowToast(data.message, 'success');
              } else {
                utilsShowToast(`${data.message}\n成功: ${data.success_count}件、失敗: ${data.failed_count}件`, 'warning');
              }
              
              let operationName = '';
              if (operationType === 'convert') {
                operationName = 'ページ画像化';
              } else if (operationType === 'vectorize') {
                operationName = 'ベクトル化';
              } else if (operationType === 'delete') {
                operationName = '削除';
              }
              console.log(`${operationName}結果:`, data.results || data);
              
              // 選択をクリアして一覧を更新（最終同期）
              appState.set('selectedOciObjects', []);
              // 短時間待機してからリストを更新（バックエンドの処理完了を保証）
              await new Promise(resolve => setTimeout(resolve, 500));
              // メインページ進捗UIを使用している場合は、ローディングオーバーレイを表示しない
              await loadOciObjects(!useProgressUI);
              break;
          }
    } catch (parseError) {
      console.error('JSONパースエラー:', parseError, '行:', line);
    }
  }
  
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
 * ローディングメッセージを更新します。プログレスバーとキャンセルボタンも制御します。
 * メインページ進捗UIが表示されている場合は、そちらが優先されるためスキップします。
 * 
 * @private
 * @param {string} message - 表示するメッセージ
 * @param {number|null} [progress=null] - 進捗率 (0-1)
 * @param {string|null} [jobId=null] - ジョブID（キャンセル用）
 */
function updateLoadingMessage(message, progress = null, jobId = null) {
  // メインページ進捗UIが表示されている場合は、ローディングオーバーレイを更新しない
  const processProgressDiv = document.getElementById('processProgress');
  if (processProgressDiv && processProgressDiv.style.display !== 'none') {
    console.log('ℹ️ メインページ進捗UIが表示中のため、updateLoadingMessageをスキップ');
    return;
  }
  
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
  
  // キャンセルボタンを更新（utils.jsのshowLoadingで作成済みの要素を使用）
  const cancelContainer = loadingOverlay.querySelector('.loading-cancel-container');
  if (cancelContainer) {
    if (jobId) {
      cancelContainer.classList.remove('hidden');
      // XSS対策: jobIdをエスケープ
      const safeJobId = jobId.replace(/'/g, "\\'").replace(/"/g, '&quot;');
      cancelContainer.innerHTML = `
        <button 
          onclick="window.cancelCurrentJob && window.cancelCurrentJob('${safeJobId}')" 
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
// メインページ進捗表示UI（削除・ベクトル化用）
// ========================================

// 処理中のファイル情報を保持
let processTargetFiles = [];
let processOperationType = null;
let processJobId = null;

/**
 * メインページに進捗状況を表示するUIを初期化・表示します。
 * （削除やベクトル化などの長時間処理用）
 * 
 * @param {Array<string>} objectNames - 対象オブジェクト名の配列
 * @param {string} operationType - 操作種別 ('delete' | 'vectorize')
 */
function showProcessProgressUI(objectNames, operationType) {
  console.log('✅ showProcessProgressUI called:', { objectNames, operationType });
  
  // 既存のローディングオーバーレイを非表示にする
  utilsHideLoading();
  
  // 文書管理タブに切り替え（メインページに進捗UIを表示するため）
  const documentManagementTab = document.querySelector('[onclick="switchTab(\'documentManagement\')"]');
  if (documentManagementTab && !document.getElementById('documentManagement').classList.contains('active')) {
    console.log('✅ Switching to documentManagement tab');
    documentManagementTab.click();
  }
  
  const progressDiv = document.getElementById('processProgress');
  console.log('✅ progressDiv found:', progressDiv);
  
  if (!progressDiv) {
    console.error('❌ processProgress element not found!');
    return;
  }
  
  processTargetFiles = objectNames;
  processOperationType = operationType;
  progressDiv.style.display = 'block';
  
  console.log('✅ progressDiv display set to block');
  
  const totalFiles = objectNames.length;
  const operationLabel = operationType === 'delete' ? 'オブジェクトを削除中' : 'ファイルをベクトル化中';
  const operationIcon = operationType === 'delete' ? '<i class="fas fa-trash-alt"></i>' : '';
  
  // 各ファイルのHTMLを生成
  let filesHtml = '';
  objectNames.forEach((objName, index) => {
    const displayName = objName.includes('/') ? objName.split('/').pop() || objName : objName;
    const safeDisplayName = displayName.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // XSS対策: title属性用にエスケープ
    const safeTitleName = objName.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    filesHtml += `
      <div id="process-file-${index}" class="flex items-start gap-2 p-3 rounded bg-gray-50 border border-gray-200" style="margin-bottom: 8px;">
        <div class="flex-1">
          <div class="text-sm font-medium text-gray-800" title="${safeTitleName}">${safeDisplayName}</div>
          <div class="flex items-center gap-2 mt-1">
            <div class="flex-1 bg-gray-200 rounded-full h-2">
              <div id="process-progress-bar-${index}" class="bg-blue-500 h-2 rounded-full transition-all duration-300" style="width: 0%"></div>
            </div>
            <span id="process-progress-percent-${index}" class="text-xs font-semibold text-gray-600" style="min-width: 40px;">0%</span>
          </div>
          <div id="process-status-${index}" class="text-xs text-gray-500 mt-1" aria-live="polite">待機中...</div>
        </div>
      </div>
    `;
  });
  
  const borderColor = operationType === 'delete' ? 'border-red-400' : 'border-blue-600';
  
  progressDiv.innerHTML = `
    <div class="bg-white border-2 ${borderColor} rounded-lg p-4" style="margin-bottom: 16px;">
      <div class="mb-3 pb-3 border-b border-gray-200 flex items-center justify-between">
        <div>
          <div class="text-base font-bold text-gray-800 mb-1">${operationIcon} ${operationLabel}</div>
          <div class="text-xs text-gray-600">対象ファイル: ${totalFiles}件</div>
        </div>
        <button 
          id="closeProcessProgressBtn" 
          onclick="window.ociModule.closeProcessProgress()" 
          class="text-gray-400 hover:text-gray-600 transition-colors" 
          style="display: none; font-size: 24px; line-height: 1; padding: 4px;"
          title="閉じる"
        >
          <i class="fas fa-times"></i>
        </button>
      </div>
      
      <div id="process-files-container" style="max-height: 400px; overflow-y: auto;">
        ${filesHtml}
      </div>
      
      <div class="mt-3 pt-3 border-t border-gray-200">
        <div id="process-overall-status" class="text-sm font-semibold text-gray-700" aria-live="polite">準備中...</div>
      </div>
      
      <div id="process-cancel-container" class="mt-3 hidden">
      </div>
    </div>
  `;
}

/**
 * メインページ進捗UIの内容を更新します。
 * 
 * @param {Object} params - 更新パラメータ
 * @param {number} [params.fileIndex] - ファイルインデックス (1始まり)
 * @param {string} [params.status] - ステータスメッセージ
 * @param {number} [params.progress] - 進捗率 (0-100)
 * @param {boolean} [params.isSuccess] - 成功フラグ
 * @param {boolean} [params.isError] - エラーフラグ
 * @param {string} [params.overallStatus] - 全体ステータス
 * @param {string} [params.jobId] - ジョブID（キャンセル用）
 */
function updateProcessProgressUI(params) {
  const { fileIndex, status, progress, isSuccess, isError, overallStatus, jobId } = params;
  
  // ジョブIDを保存
  if (jobId) {
    processJobId = jobId;
    // キャンセルボタンを表示
    const cancelContainer = document.getElementById('process-cancel-container');
    if (cancelContainer) {
      cancelContainer.classList.remove('hidden');
      // XSS対策: jobIdをエスケープ
      const safeJobId = jobId.replace(/'/g, "\\'").replace(/"/g, '&quot;');
      cancelContainer.innerHTML = `
        <button 
          onclick="window.cancelCurrentJob && window.cancelCurrentJob('${safeJobId}')" 
          class="px-4 py-2 text-sm font-medium text-white bg-red-500 hover:bg-red-600 rounded-md transition-colors"
        >
          キャンセル
        </button>
      `;
    }
  }
  
  // ファイルの進捗を更新
  if (fileIndex !== undefined && fileIndex >= 1) {
    const idx = fileIndex - 1; // 0始まりに変換
    const fileDiv = document.getElementById(`process-file-${idx}`);
    const progressBar = document.getElementById(`process-progress-bar-${idx}`);
    const progressPercent = document.getElementById(`process-progress-percent-${idx}`);
    const statusDiv = document.getElementById(`process-status-${idx}`);
    
    if (progressBar && progress !== undefined) {
      progressBar.style.width = `${progress}%`;
    }
    if (progressPercent && progress !== undefined) {
      progressPercent.textContent = `${progress}%`;
    }
    if (statusDiv && status) {
      statusDiv.textContent = status;
    }
    
    // 色の変更
    if (fileDiv) {
      if (isSuccess) {
        fileDiv.classList.remove('bg-gray-50', 'border-gray-200', 'bg-red-50', 'border-red-200', 'progress-active');
        fileDiv.setAttribute('aria-busy', 'false');
        fileDiv.classList.add('bg-green-50', 'border-green-200');
        if (progressBar) {
          progressBar.classList.remove('bg-blue-500', 'bg-red-500');
          progressBar.classList.add('bg-green-500');
        }
        if (statusDiv) {
          statusDiv.classList.remove('text-gray-500', 'text-red-600');
          statusDiv.classList.add('text-green-600');
        }
      } else if (isError) {
        fileDiv.classList.remove('bg-gray-50', 'border-gray-200', 'bg-green-50', 'border-green-200', 'progress-active');
        fileDiv.setAttribute('aria-busy', 'false');
        fileDiv.classList.add('bg-red-50', 'border-red-200');
        if (progressBar) {
          progressBar.classList.remove('bg-blue-500', 'bg-green-500');
          progressBar.classList.add('bg-red-500');
        }
        if (statusDiv) {
          statusDiv.classList.remove('text-gray-500', 'text-green-600');
          statusDiv.classList.add('text-red-600');
        }
      } else if (status || progress !== undefined) {
        fileDiv.classList.add('progress-active');
        fileDiv.setAttribute('aria-busy', 'true');
      }
    }
  }
  
  // 全体ステータスを更新
  if (overallStatus) {
    const overallStatusDiv = document.getElementById('process-overall-status');
    if (overallStatusDiv) {
      // XSS対策: textContentを使用
      overallStatusDiv.textContent = overallStatus;
    }
  }
}

/**
 * メインページ進捗UIを非表示にします。
 * 状態をリセットし、オブジェクト一覧を再読み込みします。
 */
function hideProcessProgressUI() {
  const progressDiv = document.getElementById('processProgress');
  if (progressDiv) {
    progressDiv.style.display = 'none';
  }
  processTargetFiles = [];
  processOperationType = null;
  processJobId = null;
  
  // 重要: 処理中フラグをリセットして、ボタンを活性化できるようにする
  appState.set('ociObjectsBatchDeleteLoading', false);
  
  // UIを更新して、ボタンの状態を反映
  loadOciObjects(false);
}

/**
 * 処理完了時に、進捗UIに「閉じる」ボタンを表示します。
 * キャンセルボタンは非表示になります。
 */
function showProcessProgressCloseButton() {
  const closeBtn = document.getElementById('closeProcessProgressBtn');
  if (closeBtn) {
    closeBtn.style.display = 'block';
  }
  // キャンセルボタンを非表示
  const cancelContainer = document.getElementById('process-cancel-container');
  if (cancelContainer) {
    cancelContainer.classList.add('hidden');
    cancelContainer.innerHTML = '';
  }
}

/**
 * 処理進捗UIを手動で閉じます。
 * 選択状態もクリアされます。
 */
function closeProcessProgress() {
  hideProcessProgressUI();
  // 選択状態をクリアして、UI全体を更新
  appState.set('selectedOciObjects', []);
}

// ========================================
// エクスポート設定
// ========================================

// windowオブジェクトに登録
window.ociModule = {
  loadOciObjects,
  displayOciObjectsList,
  isGeneratedPageImage,
  prevPage: handleOciObjectsPrevPage,
  nextPage: handleOciObjectsNextPage,
  jumpToPage: handleOciObjectsJumpPage,
  // ページネーション関数（別名）
  handleOciObjectsPrevPage,
  handleOciObjectsNextPage,
  handleOciObjectsJumpPage,
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
  deleteSelected: deleteSelectedOciObjects,
  closeProcessProgress: closeProcessProgress,
  showImagePreview
}

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

/**
 * データベースのテーブル一覧と統計情報を再取得します。
 * 
 * @async
 * @returns {Promise<void>}
 */
export async function refreshDbTables() {
  try {
    utilsShowLoading('統計情報を再取得中...');

    const statsResult = await authApiCall('/ai/api/database/tables/refresh-statistics', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 180000
    });

    // ページを1にリセット
    appState.set('dbTablesPage', 1);
    
    // テーブル一覧を再読み込み
    utilsShowLoading('テーブル一覧を再取得中...');
    await loadDbTables();
    utilsHideLoading();

    utilsShowToast(
      statsResult.message,
      statsResult.success ? 'success' : 'error'
    );
  } catch (error) {
    utilsHideLoading();
    utilsShowToast(`再取得エラー: ${error.message}`, 'error');
  }
}

/**
 * データベースのストレージ使用状況を取得し、UIに表示します。
 * 
 * @async
 * @returns {Promise<void>}
 */
export async function loadDbStorage() {
  console.log('[DEBUG] db.jsのloadDbStorageが呼び出されました');
  try {
    utilsShowLoading('ストレージ情報を取得中...');
    
    const data = await authApiCall('/ai/api/database/storage');
    
    utilsHideLoading();
    
    const storageDiv = document.getElementById('dbStorageContent');
    const statusBadge = document.getElementById('dbStorageStatusBadge');
    
    if (!data.success || !data.storage_info) {
      storageDiv.innerHTML = `
        <div style="text-align: center; padding: 40px; color: #64748b;">
          <div style="font-size: 48px; margin-bottom: 16px;"><i class="fas fa-hdd" style="color: #94a3b8;"></i></div>
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
      <div class="card" style="margin-bottom: 24px; background: linear-gradient(135deg, #1a365d 0%, #0f2847 100%); color: white; border: none;">
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

/**
 * データベースのストレージ使用状況を再取得します（手動リフレッシュ）。
 * 
 * @async
 * @returns {Promise<void>}
 */
export async function refreshDbStorage() {
  console.log('[DEBUG] db.jsのrefreshDbStorageが呼び出されました');
  try {
    utilsShowLoading('ストレージ情報を再取得中...');
    await loadDbStorage();
    utilsHideLoading();
  } catch (error) {
    utilsHideLoading();
    utilsShowToast(`再取得エラー: ${error.message}`, 'error');
  }
}
