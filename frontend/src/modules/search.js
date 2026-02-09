/**
 * 検索モジュール
 * 
 * セマンティック検索機能を担当（テキスト検索・画像検索）
 * 
 * 主な機能:
 * - テキストベースのセマンティック検索
 * - 画像ベースの類似画像検索
 * - 検索結果の表示と管理
 * - ファイルダウンロード機能
 * 
 * ネットワーク通信:
 * - バックエンドAPIとのHTTPS通信
 * - ファイルアップロード（FormData）
 * - 認証トークン付きリクエスト
 * - エラーハンドリングとユーザー通知
 */

import { apiCall as authApiCall } from './auth.js';
import { showLoading as utilsShowLoading, hideLoading as utilsHideLoading, showToast as utilsShowToast, showImageModal as utilsShowImageModal } from './utils.js';

// 検索画像の状態管理
let selectedSearchImage = null;
let currentSearchType = 'text'; // 'text' or 'image'

/**
 * 検索タイプを切り替え
 * 
 * テキスト検索と画像検索のUIを切り替える関数です。
 * 
 * @param {string} type - 検索タイプ ('text' または 'image')
 * 
 * ネットワーク通信の影響:
 * - UIの表示切り替えのみ（ネットワーク通信なし）
 * - ユーザーエクスペリエンスの向上
 */
export function switchSearchType(type) {
  currentSearchType = type;
  
  const textTab = document.getElementById('searchTypeTextTab');
  const imageTab = document.getElementById('searchTypeImageTab');
  const textPanel = document.getElementById('textSearchPanel');
  const imagePanel = document.getElementById('imageSearchPanel');
  
  if (type === 'text') {
    // テキスト検索タブをアクティブに
    textTab.style.borderBottomColor = '#1a365d';
    textTab.style.color = '#1a365d';
    imageTab.style.borderBottomColor = 'transparent';
    imageTab.style.color = '#64748b';
    
    textPanel.style.display = 'block';
    imagePanel.style.display = 'none';
  } else {
    // 画像検索タブをアクティブに
    imageTab.style.borderBottomColor = '#1a365d';
    imageTab.style.color = '#1a365d';
    textTab.style.borderBottomColor = 'transparent';
    textTab.style.color = '#64748b';
    
    imagePanel.style.display = 'block';
    textPanel.style.display = 'none';
  }
}

/**
 * 検索画像を選択
 * @param {Event} event - ファイル選択イベント
 */
export function handleSearchImageSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  // ファイルサイズチェック (最大10MB)
  const maxSize = 10 * 1024 * 1024;
  if (file.size > maxSize) {
    utilsShowToast('画像ファイルは10MB以下にしてください', 'warning');
    return;
  }
  
  // ファイルタイプチェック
  if (!file.type.match(/^image\/(png|jpeg|jpg)$/)) {
    utilsShowToast('PNG, JPG, JPEG形式の画像のみ対応しています', 'warning');
    return;
  }
  
  selectedSearchImage = file;
  
  // プレビュー表示
  const reader = new FileReader();
  reader.onload = (e) => {
    const previewImg = document.getElementById('searchImagePreviewImg');
    const previewDiv = document.getElementById('imageSearchPreview');
    const placeholder = document.getElementById('imageSearchPlaceholder');
    const filenameSpan = document.getElementById('searchImageFilename');
    
    if (previewImg && previewDiv && placeholder && filenameSpan) {
      previewImg.src = e.target.result;
      filenameSpan.textContent = file.name;
      previewDiv.style.display = 'block';
      placeholder.style.display = 'none';
    }
  };
  reader.readAsDataURL(file);
}

/**
 * 検索画像をクリア
 */
export function clearSearchImage() {
  selectedSearchImage = null;
  
  const fileInput = document.getElementById('searchImageInput');
  const previewDiv = document.getElementById('imageSearchPreview');
  const placeholder = document.getElementById('imageSearchPlaceholder');
  
  if (fileInput) fileInput.value = '';
  if (previewDiv) previewDiv.style.display = 'none';
  if (placeholder) placeholder.style.display = 'block';
}

/**
 * 画像検索を実行
 */
export async function performImageSearch() {
  if (!selectedSearchImage) {
    utilsShowToast('検索する画像を選択してください', 'warning');
    return;
  }
  
  // 共通のフィルター値を使用
  const filenameFilter = document.getElementById('filenameFilter').value.trim();
  const topK = parseInt(document.getElementById('topK').value) || 10;
  const minScore = parseFloat(document.getElementById('minScore').value) || 0.7;
  
  try {
    utilsShowLoading('画像検索中...');
    
    // FormDataを作成
    const formData = new FormData();
    formData.append('image', selectedSearchImage);
    formData.append('top_k', topK.toString());
    formData.append('min_score', minScore.toString());
    if (filenameFilter) {
      formData.append('filename_filter', filenameFilter);
    }
    
    const data = await authApiCall('/ai/api/search/image', {
      method: 'POST',
      body: formData
    });
    
    utilsHideLoading();
    displaySearchResults(data);
    
    // 検索完了メッセージを表示
    utilsShowToast('画像検索が完了しました', 'success');
    
  } catch (error) {
    utilsHideLoading();
    utilsShowToast(`画像検索に失敗しました: ${error.message}`, 'error');
  }
}

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

/**
 * 検索を実行
 */
export async function performSearch() {
  const query = document.getElementById('searchQuery').value.trim();
  const filenameFilter = document.getElementById('filenameFilter').value.trim();
  const topK = parseInt(document.getElementById('topK').value) || 10;
  const minScore = parseFloat(document.getElementById('minScore').value) || 0.7;
  
  if (!query) {
    utilsShowToast('検索クエリを入力してください', 'warning');
    return;
  }
  
  try {
    utilsShowLoading('検索中...');
    
    const requestBody = { query, top_k: topK, min_score: minScore };
    if (filenameFilter) {
      requestBody.filename_filter = filenameFilter;
    }
    
    const data = await authApiCall('/ai/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });
    
    utilsHideLoading();
    displaySearchResults(data);
    
    // 検索完了メッセージを表示
    utilsShowToast('検索が完了しました', 'success');
    
  } catch (error) {
    utilsHideLoading();
    utilsShowToast(`検索に失敗しました: ${error.message}`, 'error');
  }
}

/**
 * 検索結果を表示
 * @param {Object} data - 検索結果データ
 */
export function displaySearchResults(data) {
  const resultsDiv = document.getElementById('searchResults');
  const summarySpan = document.getElementById('searchResultsSummary');
  const listDiv = document.getElementById('searchResultsList');
  
  if (!data.results || data.results.length === 0) {
    resultsDiv.style.display = 'block';
    summarySpan.textContent = '検索結果なし';
    listDiv.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🔍</div>
        <div class="empty-state-title">検索結果が見つかりませんでした</div>
        <div class="empty-state-subtitle">別のキーワードで検索してみてください</div>
      </div>
    `;
    return;
  }
  
  resultsDiv.style.display = 'block';
  summarySpan.textContent = `${data.total_files}ファイル (${data.total_images}画像, ${data.processing_time.toFixed(2)}秒)`;
  
  // ファイル単位で表示
  listDiv.innerHTML = data.results.map((fileResult, fileIndex) => {
    const distancePercent = (1 - fileResult.min_distance) * 100;
    const originalFilename = fileResult.original_filename || fileResult.object_name.split('/').pop();
    
    // ファイル情報カード
    const fileCardHtml = `
      <div class="card search-result-card">
        <!-- ファイルヘッダー -->
        <div class="card-header search-result-header">
          <div class="search-result-header-row">
            <div class="search-result-header-left">
              <span class="badge search-result-badge-white">#${fileIndex + 1}</span>
              <div>
                <div class="search-result-filename">📄 ${originalFilename}</div>
                <div class="search-result-path">${fileResult.object_name}</div>
              </div>
            </div>
            <div class="search-result-stats">
              <span class="badge search-result-stat-badge">
                マッチ度: ${distancePercent.toFixed(1)}%
              </span>
              <span class="badge search-result-stat-badge">
                ${fileResult.matched_images.length}ページ
              </span>
              <button 
                onclick="window.searchModule.downloadFile('${fileResult.bucket}', '${encodeURIComponent(fileResult.object_name)}')"
                class="search-result-download-btn"
                title="ファイルをダウンロード"
              >
                📥 ダウンロード
              </button>
            </div>
          </div>
        </div>
        
        <!-- ページ画像グリッド -->
        <div class="card-body">
          <div class="search-result-body-title">
            🖼️ マッチしたページ画像（距離が小さい順）
          </div>
          <div class="search-result-images-grid">
            ${fileResult.matched_images.map((img, imgIndex) => {
              const imgDistancePercent = (1 - img.vector_distance) * 100;
              // img.url(APIから返却された絶対URL)を優先、なければbucket+object_nameから生成
              const imageUrl = img.url ? getAuthenticatedImageUrl(img.url) : getAuthenticatedImageUrl(img.bucket, img.object_name);
              
              return `
                <div 
                  class="image-card"
                  style="
                    border: 2px solid #e2e8f0; 
                    border-radius: 8px; 
                    overflow: hidden; 
                    cursor: pointer; 
                    transition: all 0.3s ease;
                    background: white;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                  "
                  onclick="window.searchModule.showSearchImageModal(${fileIndex}, ${imgIndex})"
                  onmouseover="this.style.transform='translateY(-4px)'; this.style.boxShadow='0 8px 16px rgba(15, 40, 71, 0.3)'; this.style.borderColor='#1a365d';"
                  onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 2px 4px rgba(0,0,0,0.1)'; this.style.borderColor='#e2e8f0';"
                >
                  <!-- サムネイル画像 -->
                  <div class="search-result-image-aspect">
                    <img 
                      src="${imageUrl}" 
                      alt="ページ ${img.page_number}"
                      style="
                        position: absolute;
                        top: 0;
                        left: 0;
                        width: 100%;
                        height: 100%;
                        object-fit: contain;
                      "
                      onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27200%27 height=%27200%27%3E%3Crect fill=%27%23f1f5f9%27 width=%27200%27 height=%27200%27/%3E%3Ctext x=%2750%25%27 y=%2750%25%27 text-anchor=%27middle%27 dy=%27.3em%27 fill=%27%2394a3b8%27 font-size=%2724%27%3E画像エラー%3C/text%3E%3C/svg%3E'"
                    />
                    <!-- マッチ度バッジ -->
                    <div style="
                      position: absolute;
                      top: 8px;
                      right: 8px;
                      background: rgba(26, 54, 93, 0.95);
                      color: white;
                      padding: 4px 8px;
                      border-radius: 4px;
                      font-size: 11px;
                      font-weight: 600;
                      box-shadow: 0 2px 4px rgba(0,0,0,0.2);
                    ">
                      ${imgDistancePercent.toFixed(1)}%
                    </div>
                  </div>
                  
                  <!-- 画像情報 -->
                  <div class="search-result-image-info">
                    <div class="search-result-image-title">
                      📄 ページ ${img.page_number}
                    </div>
                    <div class="search-result-image-similarity">
                      距離: ${img.vector_distance.toFixed(4)}
                    </div>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      </div>
    `;
    
    return fileCardHtml;
  }).join('');
  
  // 検索結果データをグローバルに保存（画像モーダル用）
  window._searchResultsData = data;
}

/**
 * 検索結果用画像モーダルを表示（ナビゲーション対応版）
 * @param {number} fileIndex - ファイルのインデックス
 * @param {number} imageIndex - 画像のインデックス
 */
export function showSearchImageModal(fileIndex, imageIndex) {
  // グローバルに保存された検索結果データを取得
  const data = window._searchResultsData;
  if (!data || !data.results || !data.results[fileIndex]) {
    utilsShowToast('画像データが見つかりません', 'error');
    return;
  }
  
  const fileResult = data.results[fileIndex];
  const matchedImages = fileResult.matched_images;
  
  if (!matchedImages || imageIndex >= matchedImages.length) {
    utilsShowToast('画像が見つかりません', 'error');
    return;
  }
  
  // 画像URLとタイトルのリストを作成
  const imageUrls = matchedImages.map(img => {
    return img.url ? getAuthenticatedImageUrl(img.url) : getAuthenticatedImageUrl(img.bucket, img.object_name);
  });
  
  const imageTitles = matchedImages.map(img => {
    const matchPercent = (1 - img.vector_distance) * 100;
    return `ページ ${img.page_number} - マッチ度: ${matchPercent.toFixed(1)}% | 距離: ${img.vector_distance.toFixed(4)}`;
  });
  
  // 共通のshowImageModal関数を呼び出す（画像リストとインデックスを渡す）
  utilsShowImageModal(imageUrls[imageIndex], imageTitles[imageIndex], imageUrls, imageIndex, imageTitles);
}

/**
 * ファイルをダウンロード
 * @param {string} bucket - バケット名
 * @param {string} encodedObjectName - エンコードされたオブジェクト名
 */
export async function downloadFile(bucket, encodedObjectName) {
  try {
    // bucket が既に完全なURLの場合(検索結果のurl)と、bucket+objectNameの場合の両対応
    let fileUrl;
    if (bucket && (bucket.startsWith('http://') || bucket.startsWith('https://') || bucket.startsWith('/'))) {
      fileUrl = getAuthenticatedImageUrl(bucket);
    } else {
      fileUrl = getAuthenticatedImageUrl(bucket, decodeURIComponent(encodedObjectName));
    }
    
    // 新しいタブで開く
    window.open(fileUrl, '_blank');
    
    utilsShowToast('ファイルを開きました', 'success');
  } catch (error) {
    utilsShowToast(`ダウンロードに失敗しました: ${error.message}`, 'error');
  }
}

/**
 * 検索結果をクリア
 */
export function clearSearchResults() {
  // テキスト検索のクリア
  document.getElementById('searchQuery').value = '';
  
  // 画像検索のクリア
  clearSearchImage();
  
  // 検索結果を非表示
  document.getElementById('searchResults').style.display = 'none';
}

// windowオブジェクトに登録（HTMLから呼び出せるように）
window.searchModule = {
  performSearch,
  performImageSearch,
  displaySearchResults,
  showSearchImageModal,
  downloadFile,
  clearSearchResults,
  switchSearchType,
  handleSearchImageSelect,
  clearSearchImage
};

// デフォルトエクスポート
export default {
  performSearch,
  performImageSearch,
  displaySearchResults,
  showSearchImageModal,
  downloadFile,
  clearSearchResults,
  switchSearchType,
  handleSearchImageSelect,
  clearSearchImage
}

/**
 * 画像モーダルを閉じる
 */
export function closeImageModal() {
  const modal = document.getElementById('imageModal');
  if (!modal) return;
  
  // ESCハンドラーを削除（グローバル変数を参照）
  const escapeHandler = window._imageModalEscapeHandler;
  if (escapeHandler) {
    document.removeEventListener('keydown', escapeHandler);
    window._imageModalEscapeHandler = null;
  }
  
  // 即座に削除（フラッシュを防ぐためアニメーションなし）
  modal.remove();
  
  // 追加の安全策：app.js側のグローバル変数もクリーンアップ
  if (typeof window._imageModalEscapeHandler !== 'undefined') {
    window._imageModalEscapeHandler = null;
  }
}