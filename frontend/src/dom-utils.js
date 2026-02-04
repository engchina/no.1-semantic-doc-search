/**
 * DOM操作ユーティリティ
 * 
 * 効率的なDOM更新とパフォーマンス最適化のためのヘルパー関数群
 */

// ========================================
// インポート文
// ========================================
import { debounce as utilsDebounce, throttle as utilsThrottle } from './modules/utils.js';

// ========================================
// 要素属性操作関数
// ========================================

/**
 * 要素の属性を効率的に更新
 * @param {HTMLElement} element - 対象要素
 * @param {Object} attributes - 属性のキーバリューペア
 */
export function updateAttributes(element, attributes) {
  Object.entries(attributes).forEach(([key, value]) => {
    if (value === null || value === undefined) {
      element.removeAttribute(key);
    } else {
      element.setAttribute(key, value);
    }
  });
}

// ========================================
// チェックボックス操作関数
// ========================================

/**
 * チェックボックスの状態を効率的に更新（再描画を最小化）
 * @param {string} checkboxId - チェックボックスのID
 * @param {boolean} checked - チェック状態
 */
export function updateCheckbox(checkboxId, checked) {
  const checkbox = document.getElementById(checkboxId);
  if (checkbox && checkbox.checked !== checked) {
    checkbox.checked = checked;
  }
}

/**
 * 複数のチェックボックスを一括更新
 * @param {Array<{id: string, checked: boolean}>} updates - 更新情報の配列
 */
export function batchUpdateCheckboxes(updates) {
  const fragment = document.createDocumentFragment();
  updates.forEach(({id, checked}) => {
    updateCheckbox(id, checked);
  });
}

// ========================================
// テキスト操作関数
// ========================================

/**
 * テキストコンテンツを効率的に更新
 * @param {string} elementId - 要素ID
 * @param {string} text - 新しいテキスト
 */
export function updateText(elementId, text) {
  const element = document.getElementById(elementId);
  if (element && element.textContent !== text) {
    element.textContent = text;
  }
}

/**
 * 複数の要素のテキストを一括更新
 * @param {Object} updates - {elementId: text}の形式
 */
export function batchUpdateText(updates) {
  Object.entries(updates).forEach(([id, text]) => {
    updateText(id, text);
  });
}

// ========================================
// クラス操作関数
// ========================================

/**
 * クラスを効率的に切り替え
 * @param {string} elementId - 要素ID
 * @param {string} className - クラス名
 * @param {boolean} add - 追加(true)または削除(false)
 */
export function toggleClass(elementId, className, add) {
  const element = document.getElementById(elementId);
  if (element) {
    if (add) {
      element.classList.add(className);
    } else {
      element.classList.remove(className);
    }
  }
}

/**
 * バッジの状態を更新（再描画を最小化）
 * @param {string} badgeId - バッジ要素のID
 * @param {string} text - バッジテキスト
 * @param {string} type - バッジタイプ ('success' | 'error' | 'info')
 */
export function updateBadge(badgeId, text, type = 'info') {
  const badge = document.getElementById(badgeId);
  if (!badge) return;
  
  // テキスト更新
  if (badge.textContent !== text) {
    badge.textContent = text;
  }
  
  // スタイル更新
  const typeClasses = {
    success: ['bg-green-100', 'text-green-800'],
    error: ['bg-red-100', 'text-red-800'],
    info: ['bg-gray-100', 'text-gray-600']
  };
  
  const currentClasses = typeClasses[type] || typeClasses.info;
  const allClasses = Object.values(typeClasses).flat();
  
  // 不要なクラスを削除
  badge.classList.remove(...allClasses);
  // 必要なクラスを追加
  badge.classList.add(...currentClasses);
  
  // インラインスタイルをクリア
  badge.style.background = '';
  badge.style.color = '';
}

// ========================================
// スクロール操作関数
// ========================================

/**
 * スクロール位置を保存
 * @param {string} containerId - コンテナ要素のID
 * @returns {number} スクロール位置
 */
export function saveScrollPosition(containerId) {
  const container = document.getElementById(containerId);
  return container ? container.scrollTop : 0;
}

/**
 * スクロール位置を復元
 * @param {string} containerId - コンテナ要素のID
 * @param {number} position - スクロール位置
 */
export function restoreScrollPosition(containerId, position) {
  const container = document.getElementById(containerId);
  if (container) {
    container.scrollTop = position;
  }
}

// ========================================
// テーブル操作関数
// ========================================

/**
 * テーブル行を効率的に更新（差分更新）
 * @param {string} tableBodyId - tbody要素のID
 * @param {Array} newRows - 新しい行データ
 * @param {Function} renderRowFn - 行をレンダリングする関数
 */
export function updateTableRows(tableBodyId, newRows, renderRowFn) {
  const tbody = document.getElementById(tableBodyId);
  if (!tbody) return;
  
  const existingRows = Array.from(tbody.children);
  const newRowsHtml = newRows.map(renderRowFn);
  
  // 行数が異なる場合は全体を更新
  if (existingRows.length !== newRows.length) {
    tbody.innerHTML = newRowsHtml.join('');
    return;
  }
  
  // 各行を比較して必要な部分のみ更新
  newRows.forEach((rowData, index) => {
    const existingRow = existingRows[index];
    const newRowHtml = renderRowFn(rowData);
    
    if (existingRow.outerHTML !== newRowHtml) {
      const tempDiv = document.createElement('div');
      tempDiv.innerHTML = newRowHtml;
      existingRow.replaceWith(tempDiv.firstChild);
    }
  });
}

// ========================================
// DOM構築関数
// ========================================

/**
 * DocumentFragmentを使った効率的なDOM構築
 * @param {string} html - HTML文字列
 * @returns {DocumentFragment} DocumentFragment
 */
export function createFragment(html) {
  const template = document.createElement('template');
  template.innerHTML = html.trim();
  return template.content;
}

/**
 * 要素を効率的に置き換え
 * @param {string} targetId - 置き換え対象のID
 * @param {string} html - 新しいHTML
 */
export function replaceElement(targetId, html) {
  const target = document.getElementById(targetId);
  if (target) {
    const fragment = createFragment(html);
    target.replaceWith(fragment);
  }
}

/**
 * 子要素を効率的に追加
 * @param {string} parentId - 親要素のID
 * @param {string} html - 追加するHTML
 * @param {boolean} prepend - 先頭に追加する場合true
 */
export function appendHTML(parentId, html, prepend = false) {
  const parent = document.getElementById(parentId);
  if (parent) {
    const fragment = createFragment(html);
    if (prepend) {
      parent.prepend(fragment);
    } else {
      parent.appendChild(fragment);
    }
  }
}

// ========================================
// パフォーマンス測定関数
// ========================================

/**
 * パフォーマンス測定
 * @param {string} label - ラベル
 * @param {Function} fn - 測定する関数
 * @returns {Promise<any>} 関数の戻り値
 */
export async function measurePerformance(label, fn) {
  const start = performance.now();
  try {
    const result = await fn();
    const end = performance.now();
    console.log(`[Performance] ${label}: ${(end - start).toFixed(2)}ms`);
    return result;
  } catch (error) {
    const end = performance.now();
    console.error(`[Performance] ${label} failed after ${(end - start).toFixed(2)}ms:`, error);
    throw error;
  }
}

/**
 * Virtual Scroll用のビューポート計算
 * @param {number} totalItems - 総アイテム数
 * @param {number} itemHeight - アイテムの高さ
 * @param {number} containerHeight - コンテナの高さ
 * @param {number} scrollTop - スクロール位置
 * @returns {Object} {startIndex, endIndex, offsetY}
 */
export function calculateViewport(totalItems, itemHeight, containerHeight, scrollTop) {
  const startIndex = Math.floor(scrollTop / itemHeight);
  const endIndex = Math.min(
    totalItems - 1,
    Math.ceil((scrollTop + containerHeight) / itemHeight)
  );
  const offsetY = startIndex * itemHeight;
  
  return { startIndex, endIndex, offsetY };
}

// ========================================
// エクスポート
// ========================================

export default {
  updateAttributes,
  updateCheckbox,
  batchUpdateCheckboxes,
  updateText,
  batchUpdateText,
  toggleClass,
  updateBadge,
  saveScrollPosition,
  restoreScrollPosition,
  updateTableRows,
  createFragment,
  replaceElement,
  appendHTML,
  debounce: utilsDebounce,
  throttle: utilsThrottle,
  measurePerformance,
  calculateViewport
};
