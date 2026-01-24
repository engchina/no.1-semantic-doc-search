/**
 * 共通ユーティリティモジュール
 * 
 * フォーマット、ローディング、モーダル表示などの共通機能
 */

/**
 * ファイルサイズを人間が読みやすい形式に変換
 * @param {number} bytes - バイト数
 * @returns {string} フォーマットされた文字列
 */
export function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
}

/**
 * 日時フォーマット
 * @param {string} isoString - ISO形式の日時文字列
 * @returns {string} フォーマットされた日時
 */
export function formatDateTime(isoString) {
  const date = new Date(isoString);
  return date.toLocaleString('ja-JP', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/**
 * ローディングオーバーレイを表示
 * @param {string} message - 表示メッセージ
 */
export function showLoading(message = '処理中...') {
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

/**
 * ローディングオーバーレイを非表示
 */
export function hideLoading() {
  const overlay = document.getElementById('loadingOverlay');
  if (overlay) overlay.remove();
}

/**
 * 画像モーダルを表示
 * @param {string} imageUrl - 画像URL
 * @param {string} filename - ファイル名
 */
export function showImageModal(imageUrl, filename = '') {
  const existingModal = document.getElementById('imageModalOverlay');
  if (existingModal) {
    existingModal.remove();
  }
  
  const modal = document.createElement('div');
  modal.id = 'imageModalOverlay';
  modal.className = 'image-modal-overlay';
  modal.innerHTML = `
    <img src="${imageUrl}" alt="${filename}" class="image-modal-img" onclick="event.stopPropagation()">
  `;
  modal.onclick = () => modal.remove();
  document.body.appendChild(modal);
}

/**
 * 確認モーダルを表示
 * @param {string} message - 確認メッセージ
 * @param {string} title - タイトル
 * @returns {Promise<boolean>} ユーザーの選択結果
 */
export function showConfirmModal(message, title = '確認') {
  return new Promise((resolve) => {
    // UIComponentsのshowModalを使用
    if (window.UIComponents && window.UIComponents.showModal) {
      window.UIComponents.showModal({
        title,
        content: message,
        confirmText: '確認',
        cancelText: 'キャンセル',
        onConfirm: () => resolve(true),
        onCancel: () => resolve(false)
      });
    } else {
      // フォールバック: ブラウザのconfirmダイアログ
      resolve(confirm(`${title}\n\n${message}`));
    }
  });
}

/**
 * Toastメッセージを表示
 * @param {string} message - メッセージ
 * @param {string} type - タイプ ('info' | 'success' | 'error' | 'warning')
 * @param {number} duration - 表示時間（ミリ秒）
 */
export function showToast(message, type = 'info', duration = 4000) {
  // components.jsの実装に委譲
  if (window.UIComponents && window.UIComponents.showToast) {
    return window.UIComponents.showToast(message, type, duration);
  }
  
  // フォールバック実装（components.js読み込み前）
  console.warn('components.jsが読み込まれていません');
  const container = document.getElementById('toastContainer') || (() => {
    const el = document.createElement('div');
    el.id = 'toastContainer';
    el.className = 'toast-container';
    document.body.appendChild(el);
    return el;
  })();
  
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
  }, duration);
}

/**
 * ページ全体のスクロールコンテナをトップにスクロール
 */
export function scrollToTop() {
  const tabScrollContainer = document.querySelector('.tab-scroll-container');
  if (tabScrollContainer) {
    tabScrollContainer.scrollTop = 0;
  }
}

/**
 * テーブルをトップにスクロール
 */
export function scrollTablesToTop() {
  const scrollableTables = document.querySelectorAll('.table-wrapper-scrollable');
  scrollableTables.forEach(table => {
    table.scrollTop = 0;
  });
}

/**
 * ステータスバッジを更新
 * @param {string} badgeId - バッジ要素のID
 * @param {string} text - テキスト
 * @param {string} type - タイプ ('success' | 'error' | 'info' | 'warning')
 */
export function updateStatusBadge(badgeId, text, type = 'info') {
  const badge = document.getElementById(badgeId);
  if (!badge) return;
  
  badge.textContent = text;
  
  // クラスをクリア
  badge.className = 'badge';
  
  // タイプに応じたクラスを追加
  switch (type) {
    case 'success':
      badge.classList.add('badge-success');
      break;
    case 'error':
      badge.classList.add('badge-error');
      break;
    case 'warning':
      badge.classList.add('badge-warning');
      break;
    default:
      badge.classList.add('badge-info');
  }
}

/**
 * 配列から重複を除去
 * @param {Array} array - 配列
 * @returns {Array} 重複除去された配列
 */
export function uniqueArray(array) {
  return [...new Set(array)];
}

/**
 * オブジェクトが空かどうかをチェック
 * @param {Object} obj - オブジェクト
 * @returns {boolean} 空の場合true
 */
export function isEmptyObject(obj) {
  return Object.keys(obj).length === 0;
}

/**
 * URLからクエリパラメータを取得
 * @param {string} name - パラメータ名
 * @returns {string|null} パラメータ値
 */
export function getQueryParam(name) {
  const urlParams = new URLSearchParams(window.location.search);
  return urlParams.get(name);
}

/**
 * クリップボードにテキストをコピー
 * @param {string} text - コピーするテキスト
 * @returns {Promise<boolean>} 成功/失敗
 */
export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (error) {
    console.error('クリップボードへのコピーに失敗:', error);
    return false;
  }
}

/**
 * デバウンス処理
 * @param {Function} func - 実行する関数
 * @param {number} wait - 待機時間（ミリ秒）
 * @returns {Function} デバウンスされた関数
 */
export function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

/**
 * スロットル処理
 * @param {Function} func - 実行する関数
 * @param {number} limit - 実行間隔（ミリ秒）
 * @returns {Function} スロットルされた関数
 */
export function throttle(func, limit) {
  let inThrottle;
  return function executedFunction(...args) {
    if (!inThrottle) {
      func(...args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  };
}

// デフォルトエクスポート
export default {
  formatFileSize,
  formatDateTime,
  showLoading,
  hideLoading,
  showImageModal,
  showConfirmModal,
  showToast,
  scrollToTop,
  scrollTablesToTop,
  updateStatusBadge,
  uniqueArray,
  isEmptyObject,
  getQueryParam,
  copyToClipboard,
  debounce,
  throttle
};
