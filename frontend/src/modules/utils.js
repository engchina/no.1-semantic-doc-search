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
 * ローディングオーバーレイを表示（プログレスバー対応版）
 * @param {string} message - 表示メッセージ
 */
export function showLoading(message = '処理中...') {
  // メインページ進捗UIが表示されている場合は、ローディングオーバーレイを表示しない
  const processProgressDiv = document.getElementById('processProgress');
  if (processProgressDiv && !processProgressDiv.hidden) {
    console.log('ℹ️ メインページ進捗UIが表示中のため、showLoadingをスキップ');
    return;
  }
  
  const existing = document.getElementById('loadingOverlay');
  if (existing) {
    // 既存のオーバーレイがある場合はメッセージのみ更新
    const textEl = existing.querySelector('.loading-overlay-text');
    if (textEl) {
      textEl.innerHTML = message.replace(/\n/g, '<br>');
    }
    return;
  }
  
  const overlay = document.createElement('div');
  overlay.id = 'loadingOverlay';
  overlay.className = 'loading-overlay';
  overlay.innerHTML = `
    <div class="loading-overlay-content bg-white rounded-lg p-6 shadow-xl max-w-md w-full mx-4">
      <div class="flex flex-col items-center">
        <div class="loading-spinner">
          <svg class="loading-spinner-svg" viewBox="0 0 50 50">
            <defs>
              <linearGradient id="spinner-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" style="stop-color:#1a365d;stop-opacity:1" />
                <stop offset="100%" style="stop-color:#0f2847;stop-opacity:1" />
              </linearGradient>
            </defs>
            <circle class="loading-spinner-circle" cx="25" cy="25" r="20" fill="none" stroke-width="4"></circle>
          </svg>
        </div>
        <div class="loading-overlay-text mt-4 text-gray-700 text-center">${message.replace(/\n/g, '<br>')}</div>
        <div class="loading-progress-container hidden w-full mt-4">
          <div class="flex justify-between mb-1">
            <span class="text-sm font-medium text-gray-700">進捗状況</span>
            <span class="loading-progress-percent text-sm font-medium text-blue-800">0%</span>
          </div>
          <div class="w-full bg-gray-200 rounded-full h-2.5">
            <div class="loading-progress-bar bg-blue-800 h-2.5 rounded-full transition-all duration-300" style="width: 0%"></div>
          </div>
        </div>
        <div class="loading-cancel-container hidden mt-4"></div>
      </div>
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

// ESCキーハンドラーを保持するグローバル変数
let _imageModalEscHandler = null;
let _imageModalCurrentIndex = 0;
let _imageModalImages = [];
let _imageModalTitles = [];

/**
 * 画像モーダルを表示
 * @param {string} imageUrl - 画像URL
 * @param {string} filename - ファイル名
 * @param {Array} images - 画像URLの配列（ナビゲーション用、オプション）
 * @param {number} currentIndex - 現在の画像のインデックス（オプション）
 * @param {Array} titles - 画像タイトルの配列（オプション）
 */
export function showImageModal(
  imageUrl, filename = '', images = null, currentIndex = 0, titles = null
) {
  const focusReturnTarget = document.activeElement;
  const existingModal = document.getElementById('imageModalOverlay');
  if (existingModal) {
    existingModal.remove();
  }
  
  // 既存のESCハンドラーを削除
  if (_imageModalEscHandler) {
    document.removeEventListener('keydown', _imageModalEscHandler);
    _imageModalEscHandler = null;
  }
  
  // 画像リストとインデックスを保存
  _imageModalImages = images || [imageUrl];
  _imageModalCurrentIndex = currentIndex;
  _imageModalTitles = titles || [filename];
  
  const hasNavigation = images && images.length > 1;
  
  const modal = document.createElement('div');
  modal.id = 'imageModalOverlay';
  modal.className = 'image-modal-overlay';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'ページ画像プレビュー');
  
  // ナビゲーションボタンを含むHTML
  modal.innerHTML = `
    <div class="image-modal-content" style="position: relative; max-width: 90vw; max-height: 90vh; display: flex; align-items: center; justify-content: center;">
      <button type="button" id="imageModalCloseBtn" class="image-modal-close" aria-label="プレビューを閉じる">×</button>
      ${hasNavigation ? `
        <button 
          id="imageModalPrevBtn"
          style="
            position: absolute;
            left: -60px;
            top: 50%;
            transform: translateY(-50%);
            background: rgba(255, 255, 255, 0.9);
            border: 2px solid #1a365d;
            color: #1a365d;
            width: 48px;
            height: 48px;
            border-radius: 50%;
            cursor: pointer;
            font-size: 24px;
            font-weight: bold;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.3s ease;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
            z-index: 10001;
          "
          onclick="event.stopPropagation()"
          onmouseover="this.style.background='#1a365d'; this.style.color='white'; this.style.transform='translateY(-50%) scale(1.1)';"
          onmouseout="this.style.background='rgba(255, 255, 255, 0.9)'; this.style.color='#1a365d'; this.style.transform='translateY(-50%) scale(1)';"
        >&lt;</button>
      ` : ''}
      
      <div style="position: relative; display: flex; flex-direction: column; align-items: center;">
        ${hasNavigation ? `
          <div style="
            position: absolute;
            top: -40px;
            left: 0;
            right: 0;
            text-align: center;
            color: white;
            font-size: 14px;
            background: rgba(0,0,0,0.5);
            padding: 6px 12px;
            border-radius: 6px;
            backdrop-filter: blur(4px);
          ">
            <span id="imageModalFilename">${filename}</span>
            <span style="margin-left: 12px; opacity: 0.8;">${currentIndex + 1} / ${images.length}</span>
          </div>
        ` : `
          ${filename ? `
            <div style="
              position: absolute;
              top: -40px;
              left: 0;
              right: 0;
              text-align: center;
              color: white;
              font-size: 14px;
              background: rgba(0,0,0,0.5);
              padding: 6px 12px;
              border-radius: 6px;
              backdrop-filter: blur(4px);
            ">${filename}</div>
          ` : ''}
        `}
        <div id="imageModalLoading" class="image-modal-state" role="status">
          <i class="fas fa-spinner fa-spin" aria-hidden="true"></i>画像を読み込み中…
        </div>
        <div id="imageModalError" class="image-modal-state image-modal-error" role="alert" hidden>
          <span>画像を表示できません。</span>
          <button type="button" id="imageModalRetryBtn">再試行</button>
        </div>
        <img 
          id="imageModalImg"
          src="${imageUrl}" 
          alt="${filename}" 
          class="image-modal-img" 
          onclick="event.stopPropagation()"
          style="max-width: 90vw; max-height: 90vh; border-radius: 8px; box-shadow: 0 10px 40px rgba(0,0,0,0.5);"
        >
      </div>
      
      ${hasNavigation ? `
        <button 
          id="imageModalNextBtn"
          style="
            position: absolute;
            right: -60px;
            top: 50%;
            transform: translateY(-50%);
            background: rgba(255, 255, 255, 0.9);
            border: 2px solid #1a365d;
            color: #1a365d;
            width: 48px;
            height: 48px;
            border-radius: 50%;
            cursor: pointer;
            font-size: 24px;
            font-weight: bold;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.3s ease;
            box-shadow: 0 4px 12px rgba(0,0,0,0.2);
            z-index: 10001;
          "
          onclick="event.stopPropagation()"
          onmouseover="this.style.background='#1a365d'; this.style.color='white'; this.style.transform='translateY(-50%) scale(1.1)';"
          onmouseout="this.style.background='rgba(255, 255, 255, 0.9)'; this.style.color='#1a365d'; this.style.transform='translateY(-50%) scale(1)';"
        >&gt;</button>
      ` : ''}
    </div>
  `;
  
  // モーダルを閉じる関数
  const closeModal = () => {
    modal.remove();
    // ESCハンドラーを削除
    if (_imageModalEscHandler) {
      document.removeEventListener('keydown', _imageModalEscHandler);
      _imageModalEscHandler = null;
    }
    if (focusReturnTarget && typeof focusReturnTarget.focus === 'function') {
      focusReturnTarget.focus();
    }
  }
  
  // 画像を更新する関数
  const updateImage = (newIndex) => {
    if (newIndex < 0 || newIndex >= _imageModalImages.length) return;
    
    _imageModalCurrentIndex = newIndex;
    const img = document.getElementById('imageModalImg');
    const filenameEl = document.getElementById('imageModalFilename');
    
    if (img) {
      document.getElementById('imageModalLoading')?.removeAttribute('hidden');
      document.getElementById('imageModalError')?.setAttribute('hidden', '');
      img.src = _imageModalImages[newIndex];
      img.alt = _imageModalTitles[newIndex] || '';
    }
    
    if (filenameEl) {
      filenameEl.textContent = _imageModalTitles[newIndex] || '';
      // カウンター表示も更新
      const counterEl = filenameEl.nextElementSibling;
      if (counterEl) {
        counterEl.textContent = `${newIndex + 1} / ${_imageModalImages.length}`;
      }
    }
  }
  
  // ナビゲーションボタンのイベント設定
  if (hasNavigation) {
    setTimeout(() => {
      const prevBtn = document.getElementById('imageModalPrevBtn');
      const nextBtn = document.getElementById('imageModalNextBtn');
      
      if (prevBtn) {
        prevBtn.onclick = (e) => {
          e.stopPropagation();
          const newIndex = (_imageModalCurrentIndex - 1 + _imageModalImages.length) % _imageModalImages.length;
          updateImage(newIndex);
        };
      }
      
      if (nextBtn) {
        nextBtn.onclick = (e) => {
          e.stopPropagation();
          const newIndex = (_imageModalCurrentIndex + 1) % _imageModalImages.length;
          updateImage(newIndex);
        };
      }
    }, 0);
  }

  setTimeout(() => {
    const closeButton = document.getElementById('imageModalCloseBtn');
    if (closeButton) {
      closeButton.onclick = event => {
        event.stopPropagation();
        closeModal();
      };
      closeButton.focus();
    }
    const image = document.getElementById('imageModalImg');
    const loading = document.getElementById('imageModalLoading');
    const errorState = document.getElementById('imageModalError');
    if (image) {
      image.addEventListener('load', () => {
        loading?.setAttribute('hidden', '');
        errorState?.setAttribute('hidden', '');
      });
      image.addEventListener('error', () => {
        loading?.setAttribute('hidden', '');
        errorState?.removeAttribute('hidden');
      });
      // キャッシュ済み画像はリスナー登録前にload/errorが発火し得るため現状を反映する
      if (image.complete) {
        loading?.setAttribute('hidden', '');
        if (!image.naturalWidth) errorState?.removeAttribute('hidden');
      }
    }
    document.getElementById('imageModalRetryBtn')?.addEventListener('click', event => {
      event.stopPropagation();
      if (!image) return;
      errorState?.setAttribute('hidden', '');
      loading?.removeAttribute('hidden');
      const separator = image.src.includes('?') ? '&' : '?';
      image.src = image.src.replace(/([?&])retry=\d+/, '$1').replace(/[?&]$/, '') +
        separator + 'retry=' + Date.now();
    });
  }, 0);
  
  // クリックで閉じる
  modal.onclick = closeModal;
  
  // ESCキーで閉じる、矢印キーでナビゲーション
  _imageModalEscHandler = (e) => {
    if (e.key === 'Escape') {
      closeModal();
    } else if (hasNavigation && e.key === 'ArrowLeft') {
      e.preventDefault();
      const newIndex = (_imageModalCurrentIndex - 1 + _imageModalImages.length) % _imageModalImages.length;
      updateImage(newIndex);
    } else if (hasNavigation && e.key === 'ArrowRight') {
      e.preventDefault();
      const newIndex = (_imageModalCurrentIndex + 1) % _imageModalImages.length;
      updateImage(newIndex);
    }
  }
  document.addEventListener('keydown', _imageModalEscHandler);

  document.body.appendChild(modal);
}

/**
 * 生成テキストプレビューモーダルを表示
 * @param {string} title - モーダルタイトル
 * @param {Array} sections - タブ切替で表示するセクション [{label, text, meta}]
 * @param {Object} options - onPrev / onNext
 */
export function showTextPreviewModal(title, sections = [], options = {}) {
  const focusReturnTarget = document.activeElement;
  document.getElementById('textPreviewModalOverlay')?.remove();
  document.getElementById('imageModalOverlay')?.remove();

  const escape = value => String(value ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

  const modal = document.createElement('div');
  modal.id = 'textPreviewModalOverlay';
  modal.className = 'image-modal-overlay';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', '生成テキストプレビュー');

  modal.innerHTML = `
    <div class="image-modal-content text-preview-modal" onclick="event.stopPropagation()">
      <button type="button" id="textPreviewCloseBtn" class="image-modal-close" aria-label="プレビューを閉じる">×</button>
      <div class="text-preview-header">${escape(title)}</div>
      <div class="text-preview-tabs" role="tablist" aria-label="生成テキストの種類">
        ${sections.map((section, index) => `
          <button type="button" role="tab" data-text-tab="${index}"
            aria-selected="${index === 0}">${escape(section.label)}</button>
        `).join('')}
      </div>
      <div class="text-preview-meta" id="textPreviewMeta"></div>
      <pre class="text-preview-body" id="textPreviewBody" tabindex="0"></pre>
      ${options.onPrev ? '<button type="button" id="textPreviewPrevBtn" class="text-preview-nav text-preview-nav-prev" aria-label="前のページ">&lt;</button>' : ''}
      ${options.onNext ? '<button type="button" id="textPreviewNextBtn" class="text-preview-nav text-preview-nav-next" aria-label="次のページ">&gt;</button>' : ''}
    </div>
  `;

  const escHandler = e => {
    if (e.key === 'Escape') {
      closeModal();
    } else if (e.key === 'ArrowLeft' && options.onPrev) {
      e.preventDefault();
      closeModal();
      options.onPrev();
    } else if (e.key === 'ArrowRight' && options.onNext) {
      e.preventDefault();
      closeModal();
      options.onNext();
    }
  };
  const closeModal = () => {
    modal.remove();
    document.removeEventListener('keydown', escHandler);
    if (focusReturnTarget && typeof focusReturnTarget.focus === 'function') {
      focusReturnTarget.focus();
    }
  };
  const selectTab = index => {
    const section = sections[index];
    if (!section) return;
    modal.querySelectorAll('[data-text-tab]').forEach(button => {
      button.setAttribute('aria-selected', String(Number(button.dataset.textTab) === index));
    });
    const meta = modal.querySelector('#textPreviewMeta');
    if (meta) meta.textContent = section.meta || '';
    const body = modal.querySelector('#textPreviewBody');
    if (body) body.textContent = section.text || '（テキストなし）';
  };

  setTimeout(() => {
    const closeButton = modal.querySelector('#textPreviewCloseBtn');
    if (closeButton) {
      closeButton.onclick = event => {
        event.stopPropagation();
        closeModal();
      };
      closeButton.focus();
    }
    modal.querySelectorAll('[data-text-tab]').forEach(button => {
      button.addEventListener('click', () => selectTab(Number(button.dataset.textTab)));
    });
    [['#textPreviewPrevBtn', options.onPrev], ['#textPreviewNextBtn', options.onNext]].forEach(([selector, handler]) => {
      const button = modal.querySelector(selector);
      if (button && handler) {
        button.onclick = event => {
          event.stopPropagation();
          closeModal();
          handler();
        };
      }
    });
  }, 0);

  modal.onclick = closeModal;
  document.addEventListener('keydown', escHandler);
  document.body.appendChild(modal);
  selectTab(0);
}

/**
 * 確認モーダルを表示
 * @param {string} message - 確認メッセージ
 * @param {string} title - タイトル
 * @param {Object} options - オプション
 * @param {string} [options.variant='default'] - バリアント ('default' | 'danger' | 'warning' | 'info')
 * @param {string} [options.confirmText='確認'] - 確認ボタンのテキスト
 * @param {string} [options.cancelText='キャンセル'] - キャンセルボタンのテキスト
 * @param {Object} [options.checkbox] - チェックボックス ({ label, checked })。指定時は {confirmed, checked} を返す
 * @returns {Promise<boolean|{confirmed: boolean, checked: boolean}>} ユーザーの選択結果
 */
export function showConfirmModal(message, title = '確認', options = {}) {
  const {
    variant = 'default',
    confirmText = '確認',
    cancelText = 'キャンセル',
    checkbox = null
  } = options;

  return new Promise((resolve) => {
    // UIComponentsのshowModalを使用
    if (window.UIComponents && window.UIComponents.showModal) {
      const content = checkbox
        ? `${message}\n<label style="display:inline-flex;align-items:center;gap:8px;margin-top:12px;cursor:pointer;"><input type="checkbox" id="confirm-modal-checkbox" ${checkbox.checked ? 'checked' : ''} style="width:16px;height:16px;cursor:pointer;">${checkbox.label}</label>`
        : message;
      window.UIComponents.showModal({
        title,
        content,
        confirmText,
        cancelText,
        variant,
        // モーダルDOMの除去は閉じるアニメーション後なので、onConfirm時点でまだ読める
        onConfirm: () => resolve(checkbox ? { confirmed: true, checked: !!document.getElementById('confirm-modal-checkbox')?.checked } : true),
        onCancel: () => resolve(checkbox ? { confirmed: false, checked: false } : false)
      });
    } else {
      // フォールバック: ブラウザのconfirmダイアログ
      const ok = confirm(`${title}\n\n${message}`);
      resolve(checkbox ? { confirmed: ok, checked: checkbox.checked } : ok);
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
  const accents = { success: '#22c55e', error: '#ef4444', warning: '#f59e0b', info: '#3b82f6' };
  const accent = accents[type] || accents.info;
  
  const container = document.getElementById('toastContainer') || (() => {
    const el = document.createElement('div');
    el.id = 'toastContainer';
    el.style.cssText = 'position:fixed;top:16px;right:16px;z-index:10000;display:flex;flex-direction:column;gap:10px;';
    document.body.appendChild(el);
    return el;
  })();
  
  const toast = document.createElement('div');
  toast.style.cssText = `display:flex;align-items:center;gap:12px;background:#0f2847;color:#e2e8f0;border-left:4px solid ${accent};padding:14px 16px;border-radius:10px;box-shadow:0 8px 24px rgba(0,0,0,.25);max-width:380px;min-width:280px;animation:toast-slide-in .3s ease-out;font-size:14px;font-weight:500;`;
  toast.innerHTML = `
    <span style="flex:1;line-height:1.45;">${message}</span>
    <button onclick="this.parentElement.remove()" style="flex-shrink:0;background:none;border:none;color:rgba(255,255,255,.45);cursor:pointer;font-size:18px;line-height:1;padding:0;">&times;</button>
  `;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.animation = 'toast-slide-out .3s ease-out forwards';
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
    }
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  }
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
  }
}

// デフォルトエクスポート
export default {
  formatFileSize,
  formatDateTime,
  showLoading,
  hideLoading,
  showImageModal,
  showTextPreviewModal,
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
}
