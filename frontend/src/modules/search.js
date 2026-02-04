/**
 * 検索モジュール
 * 
 * セマンティック検索機能を担当
 */

import { apiCall as authApiCall } from './auth.js';
import { showLoading as utilsShowLoading, hideLoading as utilsHideLoading, showToast as utilsShowToast, showImageModal as utilsShowImageModal } from './utils.js';

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
  const topK = parseInt(document.getElementById('topK').value) || 10;
  const minScore = parseFloat(document.getElementById('minScore').value) || 0.7;
  
  if (!query) {
    utilsShowToast('検索クエリを入力してください', 'warning');
    return;
  }
  
  try {
    utilsShowLoading('検索中...');
    
    const data = await authApiCall('/ai/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, top_k: topK, min_score: minScore })
    });
    
    utilsHideLoading();
    displaySearchResults(data);
    
  } catch (error) {
    utilsHideLoading();
    utilsShowToast(`検索エラー: ${error.message}`, 'error');
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
                  onclick="window.searchModule.showSearchImageModal('${imageUrl}', 'ページ ${img.page_number}', ${img.vector_distance})"
                  onmouseover="this.style.transform='translateY(-4px)'; this.style.boxShadow='0 8px 16px rgba(102, 126, 234, 0.3)'; this.style.borderColor='#667eea';"
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
                      background: rgba(102, 126, 234, 0.95);
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
}

/**
 * 検索結果用画像モーダルを表示（vectorDistance対応版）
 * @param {string} imageUrl - 画像URL
 * @param {string} title - タイトル
 * @param {number} vectorDistance - ベクトル距離
 */
export function showSearchImageModal(imageUrl, title, vectorDistance) {
  const matchPercent = (1 - vectorDistance) * 100;
  const filename = `${title} - マッチ度: ${matchPercent.toFixed(1)}% | 距離: ${vectorDistance.toFixed(4)}`;
  
  // 共通のshowImageModal関数を呼び出す
  utilsShowImageModal(imageUrl, filename);
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
    utilsShowToast(`ダウンロードエラー: ${error.message}`, 'error');
  }
}

/**
 * 検索結果をクリア
 */
export function clearSearchResults() {
  document.getElementById('searchQuery').value = '';
  document.getElementById('searchResults').style.display = 'none';
}

// windowオブジェクトに登録（HTMLから呼び出せるように）
window.searchModule = {
  performSearch,
  displaySearchResults,
  showSearchImageModal,
  downloadFile,
  clearSearchResults
};

// デフォルトエクスポート
export default {
  performSearch,
  displaySearchResults,
  showSearchImageModal,
  downloadFile,
  clearSearchResults
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