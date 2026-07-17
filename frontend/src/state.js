/**
 * アプリケーション状態管理
 * 
 * すべてのグローバル変数を一元管理し、状態の追跡と変更を容易にします。
 * Reactive State Patternを採用し、状態変更時のコールバックをサポートします。
 */

/**
 * 状態変更リスナーを管理するクラス
 */
class StateManager {
  constructor(initialState = {}) {
    this._state = { ...initialState };
    this._listeners = new Map(); // キー -> コールバック配列
  }

  /**
   * 状態を取得
   * @param {string} key - 状態のキー
   * @returns {any} 状態の値
   */
  get(key) {
    return this._state[key];
  }

  /**
   * 状態を設定（変更通知付き）
   * @param {string} key - 状態のキー
   * @param {any} value - 新しい値
   */
  set(key, value) {
    const oldValue = this._state[key];
    this._state[key] = value;
    
    // 変更があった場合のみリスナーに通知
    if (oldValue !== value) {
      this._notify(key, value, oldValue);
    }
  }

  /**
   * 複数の状態を一括設定
   * @param {Object} updates - {key: value}の形式
   */
  setBatch(updates) {
    Object.entries(updates).forEach(([key, value]) => {
      this.set(key, value);
    });
  }

  /**
   * 状態変更のリスナーを登録
   * @param {string} key - 監視する状態のキー
   * @param {Function} callback - コールバック関数
   */
  on(key, callback) {
    if (!this._listeners.has(key)) {
      this._listeners.set(key, []);
    }
    this._listeners.get(key).push(callback);
  }

  /**
   * リスナーを解除
   * @param {string} key - 状態のキー
   * @param {Function} callback - 解除するコールバック
   */
  off(key, callback) {
    if (this._listeners.has(key)) {
      const callbacks = this._listeners.get(key);
      const index = callbacks.indexOf(callback);
      if (index > -1) {
        callbacks.splice(index, 1);
      }
    }
  }

  /**
   * リスナーに通知
   * @private
   */
  _notify(key, newValue, oldValue) {
    if (this._listeners.has(key)) {
      this._listeners.get(key).forEach(callback => {
        callback(newValue, oldValue);
      });
    }
  }

  /**
   * 状態をリセット
   * @param {Object} initialState - 初期状態
   */
  reset(initialState = {}) {
    this._state = { ...initialState };
    this._listeners.clear();
  }

  /**
   * デバッグ用: すべての状態を取得
   * @returns {Object} 状態オブジェクト
   */
  getAll() {
    return { ...this._state };
  }
}

// ========================================
// アプリケーション状態の定義
// ========================================

/**
 * グローバル状態管理インスタンス
 */
export const appState = new StateManager({
  // API設定
  apiBase: '',
  
  // 認証関連（referenceプロジェクトに準拠：初期化時にlocalStorageから読み込み）
  isLoggedIn: !!localStorage.getItem('loginToken'),
  loginToken: localStorage.getItem('loginToken'),
  loginUser: localStorage.getItem('loginUser'),
  debugMode: false,
  requireLogin: true,  // 初期値はtrue、loadConfig()でバックエンド設定に更新
  
  // ファイル管理
  selectedFile: null,
  documentsCache: [],
  
  // AI Assistant関連
  copilotOpen: false,
  copilotExpanded: true,
  copilotMessages: [],
  copilotLoading: false,
  copilotImages: [],
  
  // データベーステーブル一覧
  dbTablesPage: 1,
  dbTablesPageSize: 20,
  dbTablesTotalPages: 1,
  selectedDbTables: [],
  dbTablesBatchDeleteLoading: false,
  currentPageDbTables: [],
  
  // テーブルデータプレビュー
  selectedTableForPreview: null,
  tableDataPage: 1,
  tableDataPageSize: 20,
  tableDataTotalPages: 1,
  selectedTableDataRows: [],
  currentPageTableDataRows: [],
  
  // OCI Objects管理
  ociObjectsPage: 1,
  ociObjectsPageSize: 20,
  ociObjectsTotalPages: 1,
  ociObjectsPrefix: '',
  selectedOciObjects: [],
  ociObjectsBatchDeleteLoading: false,
  allOciObjects: [],
  currentPageOciObjects: [], // 現在ページに表示されているオブジェクト
  
  // フィルター状態
  ociObjectsFilterPageImages: 'all',
  ociObjectsFilterEmbeddings: 'all',
  ociObjectsDisplayType: 'files_only', // 'files_only' | 'files_and_images'
  ociObjectsPageImageRelease: 'serving', // 'draft' | 'serving'
  pipelineJobIds: [],
});

// ========================================
// 便利なヘルパー関数
// ========================================

/**
 * 認証状態を取得
 * @returns {Object} {isLoggedIn, loginToken, loginUser}
 */
export function getAuthState() {
  return {
    isLoggedIn: appState.get('isLoggedIn'),
    loginToken: appState.get('loginToken'),
    loginUser: appState.get('loginUser')
  };
}

/**
 * 認証状態を設定
 * @param {boolean} isLoggedIn - ログイン状態
 * @param {string} token - トークン
 * @param {string} user - ユーザー名
 */
export function setAuthState(isLoggedIn, token, user) {
  appState.setBatch({
    isLoggedIn,
    loginToken: token,
    loginUser: user
  });
}

/**
 * OCI Objects選択状態を取得
 * @returns {Array<string>} 選択されたオブジェクト名の配列
 */
export function getSelectedOciObjects() {
  return appState.get('selectedOciObjects') || [];
}

/**
 * OCI Objectを選択/解除
 * @param {string} objectName - オブジェクト名
 * @param {boolean} selected - 選択状態
 */
export function toggleOciObjectSelection(objectName, selected) {
  const currentSelection = getSelectedOciObjects();
  
  if (selected && !currentSelection.includes(objectName)) {
    appState.set('selectedOciObjects', [...currentSelection, objectName]);
  } else if (!selected && currentSelection.includes(objectName)) {
    appState.set('selectedOciObjects', currentSelection.filter(n => n !== objectName));
  }
}

/**
 * すべてのOCI Objectsを選択/解除
 * @param {Array<string>} objectNames - オブジェクト名の配列
 * @param {boolean} selected - 選択状態
 */
export function setAllOciObjectsSelection(objectNames, selected) {
  if (selected) {
    const currentSelection = getSelectedOciObjects();
    const newSelection = [...new Set([...currentSelection, ...objectNames])];
    appState.set('selectedOciObjects', newSelection);
  } else {
    const currentSelection = getSelectedOciObjects();
    const newSelection = currentSelection.filter(n => !objectNames.includes(n));
    appState.set('selectedOciObjects', newSelection);
  }
}

/**
 * Copilot状態を取得
 * @returns {Object} Copilot関連の状態
 */
export function getCopilotState() {
  return {
    open: appState.get('copilotOpen'),
    expanded: appState.get('copilotExpanded'),
    messages: appState.get('copilotMessages'),
    loading: appState.get('copilotLoading'),
    images: appState.get('copilotImages')
  };
}

/**
 * Copilotメッセージを追加
 * @param {Object} message - メッセージオブジェクト
 */
export function addCopilotMessage(message) {
  const messages = appState.get('copilotMessages') || [];
  appState.set('copilotMessages', [...messages, message]);
}

/**
 * Copilotメッセージをクリア
 */
export function clearCopilotMessages() {
  appState.set('copilotMessages', []);
}

/**
 * ページネーション状態を取得
 * @param {string} target - 対象 ('ociObjects' | 'dbTables' | 'tableData')
 * @returns {Object} ページネーション情報
 */
export function getPaginationState(target) {
  switch (target) {
    case 'ociObjects':
      return {
        page: appState.get('ociObjectsPage'),
        pageSize: appState.get('ociObjectsPageSize'),
        prefix: appState.get('ociObjectsPrefix')
      };
    case 'dbTables':
      return {
        page: appState.get('dbTablesPage'),
        pageSize: appState.get('dbTablesPageSize'),
        totalPages: appState.get('dbTablesTotalPages')
      };
    case 'tableData':
      return {
        page: appState.get('tableDataPage'),
        pageSize: appState.get('tableDataPageSize'),
        totalPages: appState.get('tableDataTotalPages'),
        tableName: appState.get('selectedTableForPreview')
      };
    default:
      return {};
  }
}

/**
 * ページネーション状態を設定
 * @param {string} target - 対象
 * @param {Object} updates - 更新内容
 */
export function setPaginationState(target, updates) {
  const prefix = target.charAt(0).toLowerCase() + target.slice(1);
  const stateUpdates = {};
  
  Object.entries(updates).forEach(([key, value]) => {
    const stateKey = `${prefix}${key.charAt(0).toUpperCase()}${key.slice(1)}`;
    stateUpdates[stateKey] = value;
  });
  
  appState.setBatch(stateUpdates);
}

/**
 * 状態をデバッグ出力
 */
export function debugState() {
  console.group('🔍 Application State');
  console.table(appState.getAll());
  console.groupEnd();
}

// デフォルトエクスポート
export default {
  appState,
  getAuthState,
  setAuthState,
  getSelectedOciObjects,
  toggleOciObjectSelection,
  setAllOciObjectsSelection,
  getCopilotState,
  addCopilotMessage,
  clearCopilotMessages,
  getPaginationState,
  setPaginationState,
  debugState
};
