/**
 * 統一UIコンポーネントライブラリ
 * 
 * このファイルは、アプリケーション全体で一貫性のあるUI/UXを提供するための
 * 再利用可能なコンポーネント群を定義します。
 * 
 * @author Semantic Document Search
 * @version 1.0.0
 * @created 2026-01-19
 */

// ========================================
// 基礎インタラクティブコンポーネント
// ========================================

// ========================================
// 1. ボタンコンポーネント
// ========================================

/**
 * 統一されたボタンコンポーネントを生成
 * 
 * @param {Object} options - ボタン設定オプション
 * @param {string} options.text - ボタンのテキスト
 * @param {string} options.onClick - クリックイベントハンドラ
 * @param {string} [options.variant='primary'] - ボタンの種類 ('primary' | 'secondary' | 'danger' | 'success')
 * @param {string} [options.size='md'] - ボタンのサイズ ('sm' | 'md' | 'lg')
 * @param {boolean} [options.disabled=false] - 無効化フラグ
 * @param {string} [options.icon=''] - アイコン（絵文字またはSVG）
 * @param {string} [options.className=''] - 追加のCSSクラス
 * @param {string} [options.id=''] - ボタンのID属性
 * @returns {string} HTMLボタン文字列
 * 
 * @example
 * renderButton({
 *   text: 'データセット作成',
 *   onClick: 'createDataset()',
 *   variant: 'primary',
 *   icon: '➕'
 * })
 */
function renderButton({
  text,
  onClick,
  variant = 'primary',
  size = 'md',
  disabled = false,
  icon = '',
  className = '',
  id = ''
}) {
  // バリアント別のスタイル定義
  const variantClasses = {
    primary: 'bg-blue-500 hover:bg-blue-600 text-white',
    secondary: 'bg-gray-500 hover:bg-gray-600 text-white',
    danger: 'bg-red-500 hover:bg-red-600 text-white',
    success: 'bg-green-500 hover:bg-green-600 text-white',
    outline: 'border border-blue-500 text-blue-500 hover:bg-blue-50'
  };

  // サイズ別のスタイル定義
  const sizeClasses = {
    sm: 'px-2 py-1 text-xs',
    md: 'px-4 py-2 text-sm',
    lg: 'px-6 py-3 text-base'
  };

  // 基本クラスの組み立て
  const baseClasses = 'rounded transition-colors duration-200 font-medium';
  const disabledClasses = disabled ? 'opacity-50 cursor-not-allowed' : '';
  
  const finalClasses = [
    baseClasses,
    variantClasses[variant] || variantClasses.primary,
    sizeClasses[size] || sizeClasses.md,
    disabledClasses,
    className
  ].filter(Boolean).join(' ');

  // アイコンとテキストの組み合わせ
  const content = icon ? `${icon} ${text}` : text;

  return `
    <button
      ${id ? `id="${id}"` : ''}
      class="${finalClasses}"
      onclick="${onClick}"
      ${disabled ? 'disabled' : ''}
    >
      ${content}
    </button>
  `;
}

// ========================================
// 2. 入力フィールドコンポーネント
// ========================================

/**
 * 統一された入力フィールドコンポーネントを生成
 * 
 * @param {Object} options - 入力フィールド設定オプション
 * @param {string} options.type - 入力タイプ ('text' | 'number' | 'email' | 'password' | 'textarea')
 * @param {string} options.id - 入力フィールドのID
 * @param {string} [options.value=''] - 初期値
 * @param {string} [options.placeholder=''] - プレースホルダーテキスト
 * @param {string} [options.label=''] - ラベルテキスト
 * @param {boolean} [options.required=false] - 必須フラグ
 * @param {boolean} [options.disabled=false] - 無効化フラグ
 * @param {string} [options.className=''] - 追加のCSSクラス
 * @param {number} [options.min] - 最小値（数値型の場合）
 * @param {number} [options.max] - 最大値（数値型の場合）
 * @param {number} [options.step] - ステップ値（数値型の場合）
 * @param {number} [options.rows=4] - 行数（textareaの場合）
 * @returns {string} HTML入力フィールド文字列
 * 
 * @example
 * renderInput({
 *   type: 'number',
 *   id: 'maxDepth',
 *   label: '最大深度',
 *   value: '10',
 *   min: 1,
 *   max: 100
 * })
 */
function renderInput({
  type,
  id,
  value = '',
  placeholder = '',
  label = '',
  required = false,
  disabled = false,
  className = '',
  min,
  max,
  step,
  rows = 4
}) {
  const baseInputClasses = 'w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent';
  const disabledClasses = disabled ? 'bg-gray-100 cursor-not-allowed' : '';
  const finalClasses = `${baseInputClasses} ${disabledClasses} ${className}`.trim();

  // ラベル部分の生成
  const labelHtml = label ? `
    <label for="${id}" class="block text-sm font-medium text-gray-700 mb-1">
      ${label}${required ? '<span class="text-red-500 ml-1">*</span>' : ''}
    </label>
  ` : '';

  // 数値型の属性
  const numberAttrs = type === 'number' ? `
    ${min !== undefined ? `min="${min}"` : ''}
    ${max !== undefined ? `max="${max}"` : ''}
    ${step !== undefined ? `step="${step}"` : ''}
  ` : '';

  // テキストエリアの場合
  if (type === 'textarea') {
    return `
      <div class="mb-4">
        ${labelHtml}
        <textarea
          id="${id}"
          class="${finalClasses}"
          placeholder="${placeholder}"
          ${required ? 'required' : ''}
          ${disabled ? 'disabled' : ''}
          rows="${rows}"
        >${value}</textarea>
      </div>
    `;
  }

  // 通常の入力フィールド
  return `
    <div class="mb-4">
      ${labelHtml}
      <input
        type="${type}"
        id="${id}"
        class="${finalClasses}"
        value="${value}"
        placeholder="${placeholder}"
        ${required ? 'required' : ''}
        ${disabled ? 'disabled' : ''}
        ${numberAttrs}
      />
    </div>
  `;
}

// ========================================
// 3. セレクトボックスコンポーネント
// ========================================

/**
 * 統一されたセレクトボックスコンポーネントを生成
 * 
 * @param {Object} options - セレクトボックス設定オプション
 * @param {string} options.id - セレクトボックスのID
 * @param {Array<{value: string, label: string}>} options.options - 選択肢の配列
 * @param {string} [options.value=''] - 初期選択値
 * @param {string} [options.label=''] - ラベルテキスト
 * @param {boolean} [options.required=false] - 必須フラグ
 * @param {boolean} [options.disabled=false] - 無効化フラグ
 * @param {string} [options.onChange=''] - 変更イベントハンドラ
 * @param {string} [options.className=''] - 追加のCSSクラス
 * @returns {string} HTMLセレクトボックス文字列
 * 
 * @example
 * renderSelect({
 *   id: 'algorithm',
 *   label: 'アルゴリズム',
 *   options: [
 *     { value: 'dt', label: '決定木' },
 *     { value: 'rf', label: 'ランダムフォレスト' }
 *   ],
 *   value: 'dt'
 * })
 */
function renderSelect({
  id,
  options,
  value = '',
  label = '',
  required = false,
  disabled = false,
  onChange = '',
  className = ''
}) {
  const baseSelectClasses = 'w-full px-3 py-2 border border-gray-300 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white';
  const disabledClasses = disabled ? 'bg-gray-100 cursor-not-allowed' : '';
  const finalClasses = `${baseSelectClasses} ${disabledClasses} ${className}`.trim();

  // ラベル部分の生成
  const labelHtml = label ? `
    <label for="${id}" class="block text-sm font-medium text-gray-700 mb-1">
      ${label}${required ? '<span class="text-red-500 ml-1">*</span>' : ''}
    </label>
  ` : '';

  // オプションの生成
  const optionsHtml = options.map(opt => `
    <option value="${opt.value}" ${opt.value === value ? 'selected' : ''}>
      ${opt.label}
    </option>
  `).join('');

  return `
    <div class="mb-4">
      ${labelHtml}
      <select
        id="${id}"
        class="${finalClasses}"
        ${required ? 'required' : ''}
        ${disabled ? 'disabled' : ''}
        ${onChange ? `onchange="${onChange}"` : ''}
      >
        ${optionsHtml}
      </select>
    </div>
  `;
}

// ========================================
// ナビゲーションコンポーネント
// ========================================

// ========================================
// 4. ページネーションコンポーネント
// ========================================

/**
 * 統一されたページネーションコンポーネントを生成
 * 
 * @param {Object} options - ページネーション設定オプション
 * @param {number} options.currentPage - 現在のページ番号
 * @param {number} options.totalPages - 総ページ数
 * @param {number} options.totalItems - 総アイテム数
 * @param {number} options.startNum - 開始番号
 * @param {number} options.endNum - 終了番号
 * @param {string} options.onPrevClick - 前へボタンのクリックハンドラ
 * @param {string} options.onNextClick - 次へボタンのクリックハンドラ
 * @param {string} options.onJumpClick - ページジャンプのハンドラ
 * @param {string} options.inputId - ページ入力フィールドのID
 * @param {boolean} [options.disabled=false] - 無効化フラグ
 * @returns {string} HTMLページネーション文字列
 * 
 * @example
 * renderPagination({
 *   currentPage: 2,
 *   totalPages: 10,
 *   totalItems: 95,
 *   startNum: 11,
 *   endNum: 20,
 *   onPrevClick: 'handlePrevPage()',
 *   onNextClick: 'handleNextPage()',
 *   onJumpClick: 'handleJumpPage',
 *   inputId: 'pageInput'
 * })
 */
function renderPagination({
  currentPage,
  totalPages,
  totalItems,
  startNum,
  endNum,
  onPrevClick,
  onNextClick,
  onJumpClick,
  inputId,
  disabled = false
}) {
  const isPrevDisabled = currentPage <= 1 || disabled;
  const isNextDisabled = currentPage >= totalPages || disabled;

  return `
    <div class="flex items-center justify-between mb-2 text-xs text-gray-500">
      <span>${startNum}〜${endNum} 件目を表示（全 ${totalItems} 件）</span>
      <div class="flex items-center gap-2">
        <button 
          class="px-2 py-1 border rounded text-xs transition-colors ${isPrevDisabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-gray-100'}"
          onclick="${onPrevClick}"
          ${isPrevDisabled ? 'disabled' : ''}
        >
          前へ
        </button>
        <span>ページ ${currentPage} / ${totalPages}</span>
        <div class="flex items-center gap-1">
          <input 
            id="${inputId}" 
            type="number" 
            min="1" 
            max="${totalPages}" 
            value="${currentPage}" 
            class="w-16 px-1 py-0.5 border rounded text-xs focus:outline-none focus:ring-1 focus:ring-blue-500"
            onkeydown="if(event.key==='Enter'){event.preventDefault(); ${onJumpClick}();}"
            ${disabled ? 'disabled' : ''}
          />
          <button 
            class="px-2 py-1 border rounded text-xs transition-colors ${disabled ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-100'}"
            onclick="${onJumpClick}()"
            ${disabled ? 'disabled' : ''}
          >
            移動
          </button>
        </div>
        <button 
          class="px-2 py-1 border rounded text-xs transition-colors ${isNextDisabled ? 'opacity-40 cursor-not-allowed' : 'hover:bg-gray-100'}"
          onclick="${onNextClick}"
          ${isNextDisabled ? 'disabled' : ''}
        >
          次へ
        </button>
      </div>
    </div>
  `;
}

// ========================================
// コンテナコンポーネント
// ========================================

// ========================================
// 5. モーダルコンポーネント
// ========================================

/**
 * 統一されたモーダルダイアログを生成
 * 
 * @param {Object} options - モーダル設定オプション
 * @param {string} options.id - モーダルのID
 * @param {string} options.title - モーダルのタイトル
 * @param {string} options.content - モーダルの内容（HTML文字列）
 * @param {Array<{text: string, onClick: string, variant: string}>} [options.buttons=[]] - ボタン配列
 * @param {string} [options.size='md'] - モーダルサイズ ('sm' | 'md' | 'lg' | 'xl')
 * @param {boolean} [options.closeOnBackdrop=true] - 背景クリックで閉じるか
 * @returns {string} HTMLモーダル文字列
 * 
 * @example
 * renderModal({
 *   id: 'confirmModal',
 *   title: 'データセット削除',
 *   content: '<p>本当に削除しますか？</p>',
 *   buttons: [
 *     { text: 'キャンセル', onClick: 'closeModal("confirmModal")', variant: 'secondary' },
 *     { text: '削除', onClick: 'deleteDataset()', variant: 'danger' }
 *   ]
 * })
 */
function renderModal({
  id,
  title,
  content,
  buttons = [],
  size = 'md',
  closeOnBackdrop = true
}) {
  // サイズ別のクラス定義
  const sizeClasses = {
    sm: 'max-w-sm',
    md: 'max-w-2xl',
    lg: 'max-w-4xl',
    xl: 'max-w-6xl'
  };

  // ボタンの生成
  const buttonsHtml = buttons.length > 0 ? `
    <div class="flex justify-end gap-2 mt-6 pt-4 border-t">
      ${buttons.map(btn => renderButton({
        text: btn.text,
        onClick: btn.onClick,
        variant: btn.variant || 'primary',
        size: 'md'
      })).join('')}
    </div>
  ` : '';

  return `
    <dialog 
      id="${id}" 
      class="rounded-lg shadow-2xl p-0 ${sizeClasses[size]} w-full"
      ${closeOnBackdrop ? `onclick="if(event.target.id==='${id}') this.close()"` : ''}
    >
      <div class="bg-white rounded-lg">
        <!-- ヘッダー -->
        <div class="flex items-center justify-between p-4 border-b">
          <h3 class="text-lg font-semibold text-gray-800">${title}</h3>
          <button 
            onclick="document.getElementById('${id}').close()"
            class="text-gray-400 hover:text-gray-600 text-2xl leading-none"
            aria-label="閉じる"
          >
            &times;
          </button>
        </div>
        
        <!-- コンテンツ -->
        <div class="p-6">
          ${content}
        </div>
        
        <!-- フッター（ボタン） -->
        ${buttonsHtml}
      </div>
    </dialog>
  `;
}

/**
 * モーダルを開く
 * 
 * @param {string} modalId - モーダルのID
 * @example
 * openModal('confirmModal')
 */
function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.showModal();
    console.log(`モーダルを開きました: ${modalId}`);
  } else {
    console.error(`モーダルが見つかりません: ${modalId}`);
  }
}

/**
 * モーダルを閉じる
 * 
 * @param {string} modalId - モーダルのID
 * @example
 * closeModal('confirmModal')
 */
function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.close();
    console.log(`モーダルを閉じました: ${modalId}`);
  } else {
    console.error(`モーダルが見つかりません: ${modalId}`);
  }
}

/**
 * モダンな確認モーダルを表示
 * 
 * @param {Object} options - モーダル設定オプション
 * @param {string} options.title - モーダルのタイトル
 * @param {string} options.content - モーダルの内容（HTML文字列）
 * @param {string} [options.confirmText='確認'] - 確認ボタンのテキスト
 * @param {string} [options.cancelText='キャンセル'] - キャンセルボタンのテキスト
 * @param {Function} options.onConfirm - 確認時のコールバック
 * @param {Function} options.onCancel - キャンセル時のコールバック
 * @param {string} [options.variant='default'] - バリアント ('default' | 'danger' | 'warning' | 'info')
 * @param {string} [options.icon] - カスタムアイコン（省略時はvariantに基づく）
 * 
 * @example
 * showModal({
 *   title: '削除の確認',
 *   content: '本当に削除しますか？',
 *   confirmText: '削除',
 *   cancelText: 'キャンセル',
 *   variant: 'danger',
 *   onConfirm: () => console.log('削除実行'),
 *   onCancel: () => console.log('キャンセル')
 * })
 */
function showModal({
  title,
  content,
  confirmText = '確認',
  cancelText = 'キャンセル',
  onConfirm,
  onCancel,
  variant = 'default',
  icon = null
}) {
  // 既存のモーダルを削除
  const existingModal = document.getElementById('global-confirm-modal');
  if (existingModal) {
    existingModal.remove();
  }

  // モーダルIDを生成
  const modalId = 'global-confirm-modal';

  // バリアント別のスタイル設定（インラインスタイルを使用）
  const variantConfig = {
    default: {
      iconBgStyle: 'background: linear-gradient(135deg, #1a365d 0%, #0f2847 100%);',
      iconSvg: '<svg style="width:24px;height:24px;color:white;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>',
      confirmBtnStyle: 'background: linear-gradient(135deg, #1a365d 0%, #0f2847 100%); color: white;'
    },
    danger: {
      iconBgStyle: 'background: linear-gradient(135deg, #ef4444 0%, #e11d48 100%);',
      iconSvg: '<svg style="width:24px;height:24px;color:white;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>',
      confirmBtnStyle: 'background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); color: white;'
    },
    warning: {
      iconBgStyle: 'background: linear-gradient(135deg, #f59e0b 0%, #ea580c 100%);',
      iconSvg: '<svg style="width:24px;height:24px;color:white;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path></svg>',
      confirmBtnStyle: 'background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%); color: white;'
    },
    info: {
      iconBgStyle: 'background: linear-gradient(135deg, #06b6d4 0%, #3b82f6 100%);',
      iconSvg: '<svg style="width:24px;height:24px;color:white;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z"></path></svg>',
      confirmBtnStyle: 'background: linear-gradient(135deg, #06b6d4 0%, #0284c7 100%); color: white;'
    }
  };

  const config = variantConfig[variant] || variantConfig.default;

  // コンテンツ内のHTML強調を処理（強調タグを検出）
  const processedContent = content
    .replace(/<warning>(.*?)<\/warning>/gs, `
      <div class="modal-warning-block">
        <svg class="modal-warning-icon" fill="currentColor" viewBox="0 0 20 20">
          <path fill-rule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clip-rule="evenodd"></path>
        </svg>
        <span>$1</span>
      </div>
    `)
    .replace(/<strong>(.*?)<\/strong>/g, '<strong class="modal-strong-text">$1</strong>');

  // モーダルHTMLを作成
  const modalHtml = `
    <div id="${modalId}" class="modern-modal-overlay">
      <div class="modern-modal-backdrop" data-modal-close></div>
      <div class="modern-modal-container">
        <!-- アイコン -->
        <div class="modern-modal-icon" style="${config.iconBgStyle}">
          ${icon || config.iconSvg}
        </div>
        
        <!-- ヘッダー -->
        <div class="modern-modal-header">
          <h3 class="modern-modal-title">${title}</h3>
        </div>
        
        <!-- コンテンツ -->
        <div class="modern-modal-body">
          <div class="modern-modal-content">${processedContent}</div>
        </div>
        
        <!-- フッター（ボタン） -->
        <div class="modern-modal-footer">
          <button id="${modalId}-cancel-btn" class="modern-modal-btn modern-modal-btn-secondary">
            ${cancelText}
          </button>
          <button id="${modalId}-confirm-btn" class="modern-modal-btn modern-modal-btn-confirm" style="${config.confirmBtnStyle}">
            ${confirmText}
          </button>
        </div>
      </div>
    </div>
  `;

  // スタイルを追加（一度だけ）
  if (!document.getElementById('modern-modal-styles')) {
    const style = document.createElement('style');
    style.id = 'modern-modal-styles';
    style.textContent = `
      /* モダンモーダルオーバーレイ */
      .modern-modal-overlay {
        position: fixed;
        inset: 0;
        z-index: 10003;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
        animation: modernModalFadeIn 0.2s ease-out;
      }
      
      .modern-modal-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(15, 23, 42, 0.6);
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
      }
      
      .modern-modal-container {
        position: relative;
        background: white;
        border-radius: 16px;
        max-width: 420px;
        width: 100%;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.25);
        animation: modernModalSlideIn 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
        overflow: hidden;
      }
      
      .modern-modal-icon {
        width: 52px;
        height: 52px;
        border-radius: 12px;
        display: flex;
        align-items: center;
        justify-content: center;
        margin: 24px auto 0 auto;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      }
      
      .modern-modal-header {
        padding: 16px 24px 0 24px;
        text-align: center;
      }
      
      .modern-modal-title {
        font-size: 18px;
        font-weight: 600;
        color: #1e293b;
        margin: 0;
      }
      
      .modern-modal-body {
        padding: 12px 24px 20px 24px;
      }
      
      .modern-modal-content {
        font-size: 14px;
        color: #475569;
        line-height: 1.6;
        text-align: center;
        white-space: pre-line;
      }
      
      .modern-modal-footer {
        padding: 0 24px 24px 24px;
        display: flex;
        gap: 12px;
        justify-content: center;
      }
      
      .modern-modal-btn {
        padding: 10px 20px;
        border-radius: 6px;
        font-size: 14px;
        font-weight: 500;
        border: none;
        cursor: pointer;
        transition: all 0.2s ease;
        min-width: 100px;
      }
      
      .modern-modal-btn:hover {
        transform: translateY(-1px);
      }
      
      .modern-modal-btn:active {
        transform: translateY(0);
      }
      
      .modern-modal-btn-secondary {
        background: #fff;
        color: #475569;
        border: 1.5px solid #cbd5e1;
      }
      
      .modern-modal-btn-secondary:hover {
        background: #f8fafc;
        border-color: #94a3b8;
      }
      
      .modern-modal-btn-secondary:active {
        background: #f1f5f9;
      }
      
      .modern-modal-btn-confirm:hover {
        box-shadow: 0 4px 8px rgba(15, 40, 71, 0.35);
      }
      
      .modern-modal-btn-confirm:active {
        box-shadow: 0 2px 4px rgba(15, 40, 71, 0.25);
      }
      
      /* 警告ブロック */
      .modal-warning-block {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        background: #fef3c7;
        border: 1px solid #fcd34d;
        border-radius: 8px;
        padding: 10px 12px;
        margin-top: 12px;
        text-align: left;
      }
      
      .modal-warning-icon {
        width: 18px;
        height: 18px;
        color: #d97706;
        flex-shrink: 0;
        margin-top: 1px;
      }
      
      .modal-warning-block span {
        color: #92400e;
        font-size: 13px;
        font-weight: 500;
        line-height: 1.5;
      }
      
      .modal-strong-text {
        font-weight: 600;
        color: #0f172a;
      }
      
      /* アニメーション */
      @keyframes modernModalFadeIn {
        from { opacity: 0; }
        to { opacity: 1; }
      }
      
      @keyframes modernModalSlideIn {
        from {
          opacity: 0;
          transform: translateY(-30px) scale(0.9);
        }
        to {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
      }
      
      @keyframes modernModalSlideOut {
        from {
          opacity: 1;
          transform: translateY(0) scale(1);
        }
        to {
          opacity: 0;
          transform: translateY(10px) scale(0.95);
        }
      }
      
      @keyframes modernModalFadeOut {
        from { opacity: 1; }
        to { opacity: 0; }
      }
    `;
    document.head.appendChild(style);
  }

  // モーダルをDOMに追加
  const modalContainer = document.createElement('div');
  modalContainer.innerHTML = modalHtml;
  document.body.appendChild(modalContainer.firstElementChild);

  // ESCキーハンドラー（先に定義）
  let handleEsc = null;

  // モーダルを閉じる関数
  const closeConfirmModal = () => {
    // ESCキーハンドラーを先に削除（メモリリーク防止）
    if (handleEsc) {
      document.removeEventListener('keydown', handleEsc);
      handleEsc = null;
    }
    
    const modal = document.getElementById(modalId);
    if (modal) {
      const container = modal.querySelector('.modern-modal-container');
      const backdrop = modal.querySelector('.modern-modal-backdrop');
      if (container) {
        container.style.animation = 'modernModalSlideOut 0.2s ease-out forwards';
      }
      if (backdrop) {
        backdrop.style.animation = 'modernModalFadeOut 0.2s ease-out forwards';
      }
      setTimeout(() => modal.remove(), 200);
    }
  };

  // イベントリスナーを設定
  const modal = document.getElementById(modalId);
  const confirmBtn = document.getElementById(`${modalId}-confirm-btn`);
  const cancelBtn = document.getElementById(`${modalId}-cancel-btn`);
  const backdrop = modal.querySelector('[data-modal-close]');

  // 確認ボタン
  confirmBtn.addEventListener('click', () => {
    closeConfirmModal();
    if (onConfirm) onConfirm();
  });

  // キャンセルボタン
  cancelBtn.addEventListener('click', () => {
    closeConfirmModal();
    if (onCancel) onCancel();
  });

  // 背景クリックで閉じる
  if (backdrop) {
    backdrop.addEventListener('click', () => {
      closeConfirmModal();
      if (onCancel) onCancel();
    });
  }

  // ESCキーで閉じる
  handleEsc = (e) => {
    if (e.key === 'Escape') {
      closeConfirmModal();
      if (onCancel) onCancel();
    }
  };
  document.addEventListener('keydown', handleEsc);

  console.log(`確認モーダルを表示: ${title}`);
}

// ========================================
// 6. カードコンポーネント
// ========================================

/**
 * 統一されたカードコンポーネントを生成
 * 
 * @param {Object} options - カード設定オプション
 * @param {string} options.title - カードタイトル
 * @param {string} options.content - カード内容（HTML文字列）
 * @param {string} [options.footer=''] - カードフッター（HTML文字列）
 * @param {boolean} [options.collapsible=false] - 折りたたみ可能か
 * @param {boolean} [options.defaultExpanded=true] - デフォルトで展開するか
 * @param {string} [options.className=''] - 追加のCSSクラス
 * @returns {string} HTMLカード文字列
 * 
 * @example
 * renderCard({
 *   title: 'データセット情報',
 *   content: '<p>データセットの詳細...</p>',
 *   collapsible: true
 * })
 */
function renderCard({
  title,
  content,
  footer = '',
  collapsible = false,
  defaultExpanded = true,
  className = ''
}) {
  const cardId = `card-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  const contentId = `${cardId}-content`;

  // 折りたたみアイコン
  const collapseIcon = collapsible ? `
    <button 
      onclick="toggleCardCollapse('${contentId}')"
      class="text-gray-500 hover:text-gray-700 transition-transform"
      id="${contentId}-toggle"
    >
      <svg class="w-5 h-5 transform ${defaultExpanded ? '' : 'rotate-180'}" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path>
      </svg>
    </button>
  ` : '';

  // フッター部分
  const footerHtml = footer ? `
    <div class="border-t bg-gray-50 px-4 py-3">
      ${footer}
    </div>
  ` : '';

  return `
    <div class="bg-white border rounded-lg shadow-sm ${className}">
      <!-- ヘッダー -->
      <div class="flex items-center justify-between px-4 py-3 border-b bg-gray-50">
        <h3 class="text-base font-semibold text-gray-800">${title}</h3>
        ${collapseIcon}
      </div>
      
      <!-- コンテンツ -->
      <div id="${contentId}" class="${defaultExpanded ? '' : 'hidden'}">
        <div class="p-4">
          ${content}
        </div>
        ${footerHtml}
      </div>
    </div>
  `;
}

/**
 * カードの折りたたみトグル
 * 
 * @param {string} contentId - コンテンツ要素のID
 */
function toggleCardCollapse(contentId) {
  const content = document.getElementById(contentId);
  const toggle = document.getElementById(`${contentId}-toggle`);
  
  if (content && toggle) {
    const isHidden = content.classList.toggle('hidden');
    toggle.querySelector('svg').classList.toggle('rotate-180', isHidden);
    console.log(`カードを${isHidden ? '折りたたみ' : '展開'}ました: ${contentId}`);
  }
}

// ========================================
// フィードバックコンポーネント
// ========================================

// ========================================
// 7. ローディング状態コンポーネント
// ========================================

/**
 * 統一されたローディングインジケーターを生成
 * 
 * @param {Object} options - ローディング設定オプション
 * @param {string} [options.message='読み込み中...'] - ローディングメッセージ
 * @param {string} [options.size='md'] - サイズ ('sm' | 'md' | 'lg')
 * @param {string} [options.variant='spinner'] - バリアント ('spinner' | 'dots' | 'text')
 * @returns {string} HTMLローディング文字列
 * 
 * @example
 * renderLoading({ message: 'データを取得中...', size: 'lg' })
 */
function renderLoading({
  message = '読み込み中...',
  size = 'md',
  variant = 'spinner'
} = {}) {
  // サイズ別の設定
  const sizeConfig = {
    sm: { spinner: 'w-4 h-4', text: 'text-xs' },
    md: { spinner: 'w-6 h-6', text: 'text-sm' },
    lg: { spinner: 'w-8 h-8', text: 'text-base' }
  };

  const config = sizeConfig[size] || sizeConfig.md;

  // スピナー型
  if (variant === 'spinner') {
    return `
      <div class="flex items-center justify-center gap-2 py-4">
        <div class="${config.spinner} border-2 border-blue-500 border-t-transparent rounded-full animate-spin"></div>
        <span class="${config.text} text-gray-600">${message}</span>
      </div>
    `;
  }

  // ドット型
  if (variant === 'dots') {
    return `
      <div class="flex items-center justify-center gap-2 py-4">
        <div class="flex gap-1">
          <div class="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style="animation-delay: 0ms"></div>
          <div class="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style="animation-delay: 150ms"></div>
          <div class="w-2 h-2 bg-blue-500 rounded-full animate-bounce" style="animation-delay: 300ms"></div>
        </div>
        <span class="${config.text} text-gray-600">${message}</span>
      </div>
    `;
  }

  // テキスト型
  return `
    <div class="flex items-center justify-center py-4">
      <span class="${config.text} text-gray-600">⏳ ${message}</span>
    </div>
  `;
}

// ========================================
// 8. トースト通知コンポーネント
// ========================================

/**
 * 統一されたトースト通知を表示
 * 
 * @param {string} message - 通知メッセージ
 * @param {string} [type='info'] - 通知タイプ ('success' | 'error' | 'warning' | 'info')
 * @param {number} [duration=4000] - 表示時間（ミリ秒）
 * @returns {number} トーストID
 * 
 * @example
 * showToast('保存しました', 'success')
 * showToast('エラーが発生しました', 'error')
 */
function showToast(message, type = 'info', duration = 4000) {
  const id = Date.now() + Math.random();
  
  // タイプ別のアイコンとスタイル
  const config = {
    success: { icon: '✅', bgColor: 'bg-green-50', borderColor: 'border-green-500', textColor: 'text-green-800' },
    error: { icon: '❌', bgColor: 'bg-red-50', borderColor: 'border-red-500', textColor: 'text-red-800' },
    warning: { icon: '⚠️', bgColor: 'bg-yellow-50', borderColor: 'border-yellow-500', textColor: 'text-yellow-800' },
    info: { icon: 'ℹ️', bgColor: 'bg-blue-50', borderColor: 'border-blue-500', textColor: 'text-blue-800' }
  };

  const typeConfig = config[type] || config.info;

  // メッセージに既に絵文字が含まれているか確認
  const hasEmoji = /[\u{1F300}-\u{1F9FF}]|[✅❌⚠️ℹ️]/u.test(message);
  const finalMessage = hasEmoji ? message : `${typeConfig.icon} ${message}`;

  // トーストコンテナが存在しない場合は作成
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'fixed top-4 right-4 z-50 flex flex-col gap-2';
    document.body.appendChild(container);
  }

  // トースト要素の作成
  const toast = document.createElement('div');
  toast.id = `toast-${id}`;
  toast.className = `${typeConfig.bgColor} ${typeConfig.textColor} border-l-4 ${typeConfig.borderColor} px-4 py-3 rounded shadow-lg max-w-sm animate-slide-in-right`;
  toast.innerHTML = `
    <div class="flex items-center justify-between gap-2">
      <span class="text-sm font-medium">${finalMessage}</span>
      <button 
        onclick="document.getElementById('toast-${id}').remove()"
        class="text-gray-500 hover:text-gray-700 text-xl leading-none"
      >
        &times;
      </button>
    </div>
  `;

  container.appendChild(toast);
  console.log(`トースト通知を表示: [${type}] ${message}`);

  // 自動削除
  if (duration > 0) {
    setTimeout(() => {
      const toastEl = document.getElementById(`toast-${id}`);
      if (toastEl) {
        toastEl.style.animation = 'slide-out-right 0.3s ease-out';
        setTimeout(() => toastEl.remove(), 300);
      }
    }, duration);
  }

  return id;
}

// ========================================
// 9. アラートコンポーネント
// ========================================

/**
 * 統一されたアラートコンポーネントを生成
 * 
 * @param {Object} options - アラート設定オプション
 * @param {string} options.message - アラートメッセージ
 * @param {string} [options.type='info'] - タイプ ('success' | 'error' | 'warning' | 'info')
 * @param {boolean} [options.dismissible=true] - 閉じるボタンを表示するか
 * @param {string} [options.id=''] - アラートのID（dismissible時に必要）
 * @returns {string} HTMLアラート文字列
 * 
 * @example
 * renderAlert({
 *   message: '処理が完了しました',
 *   type: 'success',
 *   dismissible: true,
 *   id: 'successAlert'
 * })
 */
function renderAlert({
  message,
  type = 'info',
  dismissible = true,
  id = ''
}) {
  // タイプ別の設定
  const typeConfig = {
    success: { icon: '✅', bgColor: 'bg-green-50', borderColor: 'border-green-200', textColor: 'text-green-800' },
    error: { icon: '❌', bgColor: 'bg-red-50', borderColor: 'border-red-200', textColor: 'text-red-800' },
    warning: { icon: '⚠️', bgColor: 'bg-yellow-50', borderColor: 'border-yellow-200', textColor: 'text-yellow-800' },
    info: { icon: 'ℹ️', bgColor: 'bg-blue-50', borderColor: 'border-blue-200', textColor: 'text-blue-800' }
  };

  const config = typeConfig[type] || typeConfig.info;
  const alertId = id || `alert-${Date.now()}`;

  // 閉じるボタン
  const dismissBtn = dismissible ? `
    <button 
      onclick="document.getElementById('${alertId}').remove()"
      class="text-gray-500 hover:text-gray-700 text-xl leading-none ml-4"
    >
      &times;
    </button>
  ` : '';

  return `
    <div 
      id="${alertId}"
      class="${config.bgColor} ${config.textColor} ${config.borderColor} border rounded-lg px-4 py-3 mb-4"
      role="alert"
    >
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-2">
          <span class="text-lg">${config.icon}</span>
          <span class="text-sm font-medium">${message}</span>
        </div>
        ${dismissBtn}
      </div>
    </div>
  `;
}

// ========================================
// データ表示コンポーネント
// ========================================

// ========================================
// 10. テーブルコンポーネント
// ========================================

/**
 * 統一されたテーブルコンポーネントを生成
 * 
 * @param {Object} options - テーブル設定オプション
 * @param {Array<{key: string, label: string, align?: string}>} options.columns - カラム定義
 * @param {Array<Object>} options.data - データ配列
 * @param {boolean} [options.striped=true] - ストライプ表示
 * @param {boolean} [options.hoverable=true] - ホバー効果
 * @param {string} [options.emptyMessage='データがありません'] - 空データ時のメッセージ
 * @returns {string} HTMLテーブル文字列
 * 
 * @example
 * renderTable({
 *   columns: [
 *     { key: 'id', label: 'ID', align: 'center' },
 *     { key: 'name', label: '名前' },
 *     { key: 'score', label: 'スコア', align: 'right' }
 *   ],
 *   data: [
 *     { id: 1, name: 'データA', score: 95.5 },
 *     { id: 2, name: 'データB', score: 88.3 }
 *   ]
 * })
 */
function renderTable({
  columns,
  data,
  striped = true,
  hoverable = true,
  emptyMessage = 'データがありません'
}) {
  // 空データの場合
  if (!data || data.length === 0) {
    return `
      <div class="text-center py-8 text-gray-500">
        ${emptyMessage}
      </div>
    `;
  }

  // ヘッダーの生成
  const theadHtml = `
    <thead class="bg-gray-100 border-b-2 border-gray-200">
      <tr>
        ${columns.map(col => `
          <th class="px-4 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider ${col.align === 'center' ? 'text-center' : col.align === 'right' ? 'text-right' : ''}">
            ${col.label}
          </th>
        `).join('')}
      </tr>
    </thead>
  `;

  // ボディの生成
  const tbodyHtml = `
    <tbody class="bg-white divide-y divide-gray-200">
      ${data.map((row, idx) => `
        <tr class="${striped && idx % 2 === 1 ? 'bg-gray-50' : ''} ${hoverable ? 'hover:bg-blue-50 transition-colors' : ''}">
          ${columns.map(col => `
            <td class="px-4 py-3 text-sm text-gray-800 ${col.align === 'center' ? 'text-center' : col.align === 'right' ? 'text-right' : ''}">
              ${row[col.key] !== undefined ? row[col.key] : '-'}
            </td>
          `).join('')}
        </tr>
      `).join('')}
    </tbody>
  `;

  return `
    <div class="overflow-x-auto border rounded-lg">
      <table class="min-w-full divide-y divide-gray-200">
        ${theadHtml}
        ${tbodyHtml}
      </table>
    </div>
  `;
}

// ========================================
// 11. バッジコンポーネント
// ========================================

/**
 * 統一されたバッジコンポーネントを生成
 * 
 * @param {Object} options - バッジ設定オプション
 * @param {string} options.text - バッジテキスト
 * @param {string} [options.variant='default'] - バリアント ('default' | 'success' | 'error' | 'warning' | 'info')
 * @param {string} [options.size='md'] - サイズ ('sm' | 'md' | 'lg')
 * @returns {string} HTMLバッジ文字列
 * 
 * @example
 * renderBadge({ text: '完了', variant: 'success' })
 */
function renderBadge({
  text,
  variant = 'default',
  size = 'md'
}) {
  // バリアント別のスタイル
  const variantClasses = {
    default: 'bg-gray-100 text-gray-800',
    success: 'bg-green-100 text-green-800',
    error: 'bg-red-100 text-red-800',
    warning: 'bg-yellow-100 text-yellow-800',
    info: 'bg-blue-100 text-blue-800'
  };

  // サイズ別のスタイル
  const sizeClasses = {
    sm: 'px-2 py-0.5 text-xs',
    md: 'px-2.5 py-1 text-sm',
    lg: 'px-3 py-1.5 text-base'
  };

  const finalClasses = `inline-flex items-center font-medium rounded ${variantClasses[variant]} ${sizeClasses[size]}`;

  return `<span class="${finalClasses}">${text}</span>`;
}

// ========================================
// エクスポート（グローバルスコープで利用可能にする）
// ========================================

// ブラウザ環境でグローバルに公開
if (typeof window !== 'undefined') {
  window.UIComponents = {
    renderButton,
    renderInput,
    renderSelect,
    renderPagination,
    renderModal,
    openModal,
    closeModal,
    showModal,
    renderLoading,
    showToast,
    renderTable,
    renderCard,
    toggleCardCollapse,
    renderBadge,
    renderAlert
  };
  
  console.log('✅ 統一UIコンポーネントライブラリが読み込まれました');
}

// Node.js環境用のエクスポート
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    renderButton,
    renderInput,
    renderSelect,
    renderPagination,
    renderModal,
    openModal,
    closeModal,
    showModal,
    renderLoading,
    showToast,
    renderTable,
    renderCard,
    toggleCardCollapse,
    renderBadge,
    renderAlert
  };
}