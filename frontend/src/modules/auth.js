/**
 * 認証モジュール
 * 
 * ログイン、ログアウト、認証状態管理を担当
 */

// ========================================
// インポート文
// ========================================
import { appState, setAuthState } from '../state.js';

// ========================================
// グローバル変数
// ========================================
// 開発時はViteのプロキシを使うため空文字列、本番ビルド時は環境変数から設定
const API_BASE = import.meta.env.VITE_API_BASE || '';

// ========================================
// グローバル変数
// ========================================
// （認証モジュールではグローバル変数は不要）

// ========================================
// 認証機能
// ========================================

/**
 * UI機能トグルを適用
 * @param {Object} config - 設定オブジェクト
 */
function applyUIFeatureToggles(config) {
  // AI Assistantの表示制御
  const showAiAssistant = config.show_ai_assistant !== false; // デフォルトはtrue
  const copilotToggleBtn = document.getElementById('copilotToggleBtn');
  const copilotPanel = document.getElementById('copilotPanel');
  
  if (showAiAssistant) {
    if (copilotToggleBtn) copilotToggleBtn.style.display = 'block';
  } else {
    if (copilotToggleBtn) copilotToggleBtn.style.display = 'none';
    if (copilotPanel) copilotPanel.style.display = 'none';
  }
  
  // 検索タブの表示制御
  const showSearchTab = config.show_search_tab !== false; // デフォルトはtrue
  const searchTabElements = document.querySelectorAll('.apex-tab');
  
  if (searchTabElements.length > 0) {
    const searchTab = searchTabElements[0]; // 最初のタブが検索タブ
    const searchTabContent = document.getElementById('tab-search');
    
    if (showSearchTab) {
      if (searchTab) searchTab.style.display = '';
    } else {
      if (searchTab) searchTab.style.display = 'none';
      if (searchTabContent) searchTabContent.style.display = 'none';
      // 検索タブが非表示の場合、文書管理タブに切り替え
      if (searchTabElements.length > 1) {
        // switchTab関数はapp.jsで定義されているため、ここではコメントアウト
        // switchTab('documents', { target: searchTabElements[1] });
      }
    }
  }
  
  // appStateにも保存
  appState.set('showAiAssistant', showAiAssistant);
  appState.set('showSearchTab', showSearchTab);
}

/**
 * 設定を読み込む
 */
export async function loadConfig() {
  console.log('[AUTH.JS] loadConfig が呼び出されました');
  try {
    // API_BASEが空の場合は相対パス、設定されている場合は絶対パス
    const url = API_BASE ? `${API_BASE}/config` : '/ai/api/config';
    const response = await fetch(url);
    if (response.ok) {
      const config = await response.json();
      
      // appStateに設定（oci.js等のモジュールから参照されるため）
      appState.set('debugMode', config.debug);
      appState.set('requireLogin', config.require_login);
      appState.set('apiBase', API_BASE);
      
      // UI機能トグルを適用
      applyUIFeatureToggles(config);
      
      // console.log('設定を読み込みました:', config);
    }
  } catch (error) {
    // console.warn('設定の読み込みに失敗しました:', error);
  }
}

// ========================================
// モーダル操作関数
// ========================================

/**
 * ログインモーダルを表示
 */
export function showLoginModal() {
  console.log('[AUTH.JS] showLoginModal が呼び出されました');
  const modal = document.getElementById('loginOverlay');
  if (modal) {
    modal.style.display = 'flex';
    const usernameInput = document.getElementById('loginUsername');
    if (usernameInput) {
      usernameInput.focus();
    }
  }
}

/**
 * ログインモーダルを非表示
 */
export function hideLoginModal() {
  console.log('[AUTH.JS] hideLoginModal が呼び出されました');
  const modal = document.getElementById('loginOverlay');
  if (modal) {
    modal.style.display = 'none';
    const errorDiv = document.getElementById('loginError');
    if (errorDiv) {
      errorDiv.style.display = 'none';
    }
    const form = document.getElementById('loginForm');
    if (form) {
      form.reset();
    }
  }
}

/**
 * パスワード表示切替
 */
export function toggleLoginPassword() {
  console.log('[AUTH.JS] toggleLoginPassword が呼び出されました');
  const input = document.getElementById('loginPassword');
  if (!input) return;
  input.type = input.type === 'password' ? 'text' : 'password';
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

// ========================================
// 認証処理関数
// ========================================

/**
 * ログイン処理
 * @param {Event} event - フォーム送信イベント
 */
export async function handleLogin(event) {
  console.log('[AUTH.JS] handleLogin が呼び出されました');
  event.preventDefault();
  
  const username = document.getElementById('loginUsername').value.trim();
  const password = document.getElementById('loginPassword').value;
  const errorDiv = document.getElementById('loginError');
  const errorMessage = document.getElementById('loginErrorMessage');
  const submitBtn = document.getElementById('loginSubmitBtn');
  
  if (!username || !password) {
    if (errorMessage) {
      errorMessage.textContent = 'ユーザー名とパスワードを入力してください';
    }
    if (errorDiv) {
      errorDiv.style.display = 'flex';
    }
    return;
  }
  
  try {
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerHTML = '<span class="inline-flex items-center gap-2"><span class="spinner spinner-sm"></span>ログイン中...</span>';
    }
    if (errorDiv) {
      errorDiv.style.display = 'none';
    }
    
    const apiBase = appState.get('apiBase') || '';
    const url = apiBase ? `${apiBase}/api/login` : '/ai/api/login';
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.detail || 'ログインに失敗しました');
    }
    
    const data = await response.json();
    
    if (data.status === 'success') {
      // 状態管理に保存
      setAuthState(true, data.token, data.username);
      
      // ローカルストレージに保存
      localStorage.setItem('loginToken', data.token);
      localStorage.setItem('loginUser', data.username);
      
      hideLoginModal();
      
      // Toast表示（グローバル関数を使用）
      if (window.UIComponents && window.UIComponents.showToast) {
        window.UIComponents.showToast('ログインしました', 'success');
      }
      
      // UI更新
      updateUserInfo();
      
      // AI Assistantボタンの表示制御（設定に応じて）
      const showAiAssistant = appState.get('showAiAssistant');
      const copilotBtn = document.getElementById('copilotToggleBtn');
      if (copilotBtn && showAiAssistant) {
        copilotBtn.style.display = 'flex';
      }
    }
  } catch (error) {
    if (errorMessage) {
      errorMessage.textContent = error.message;
    }
    if (errorDiv) {
      errorDiv.style.display = 'flex';
    }
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.textContent = 'ログイン';
    }
  }
}

/**
 * ログアウト処理
 */
export async function handleLogout() {
  console.log('[AUTH.JS] handleLogout が呼び出されました');
  try {
    const loginToken = appState.get('loginToken');
    if (loginToken) {
      const apiBase = appState.get('apiBase') || '';
      const url = apiBase ? `${apiBase}/api/logout` : '/ai/api/logout';
      await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${loginToken}` }
      });
    }
  } catch (error) {
    console.warn('ログアウトエラー:', error);
  } finally {
    // 状態をクリア
    setAuthState(false, null, null);
    localStorage.removeItem('loginToken');
    localStorage.removeItem('loginUser');
    
    // Toast表示
    if (window.UIComponents && window.UIComponents.showToast) {
      window.UIComponents.showToast('ログアウトしました');
    }
    
    // ページをリロードしてログイン画面へ遷移
    setTimeout(() => {
      window.location.reload();
    }, 500);
  }
}

// ========================================
// 認証状態管理関数
// ========================================

/**
 * ユーザー情報表示を更新
 */
export function updateUserInfo() {
  console.log('[AUTH.JS] updateUserInfo が呼び出されました');
  const userInfo = document.getElementById('userInfo');
  const userName = document.getElementById('userName');
  
  const isLoggedIn = appState.get('isLoggedIn');
  const loginUser = appState.get('loginUser');
  
  if (isLoggedIn && loginUser) {
    userName.textContent = `${loginUser}`;
    userInfo.style.display = 'block';
  } else {
    userInfo.style.display = 'none';
  }
}

/**
 * ログイン状態を確認
 */
export async function checkLoginStatus() {
  console.log('[AUTH.JS] checkLoginStatus が呼び出されました');
  // ローカルストレージからトークンを取得
  const token = localStorage.getItem('loginToken');
  const user = localStorage.getItem('loginUser');
  
  if (token && user) {
    setAuthState(true, token, user);
    updateUserInfo();
    
    // AI Assistantボタンの表示制御（設定に応じて）
    const showAiAssistant = appState.get('showAiAssistant');
    const copilotBtn = document.getElementById('copilotToggleBtn');
    if (copilotBtn && showAiAssistant) {
      copilotBtn.style.display = 'flex';
    }
  } else {
    const requireLogin = appState.get('requireLogin');
    if (requireLogin) {
      // ログインが必要な場合はログイン画面を表示
      showLoginModal();
    } else {
      // デバッグモードでログイン不要の場合も、設定に応じてAI Assistantボタンを表示
      const showAiAssistant = appState.get('showAiAssistant');
      const copilotBtn = document.getElementById('copilotToggleBtn');
      if (copilotBtn && showAiAssistant) {
        copilotBtn.style.display = 'flex';
      }
    }
  }
}

/**
 * 強制ログアウト処理（401エラー時に呼び出し）
 * referenceプロジェクトの実装に準拠
 */
export function forceLogout() {
  console.log('[AUTH.JS] forceLogout が呼び出されました');
  // セッションを完全にクリア
  setAuthState(false, null, null);
  localStorage.removeItem('loginToken');
  localStorage.removeItem('loginUser');
  
  // ログイン画面を表示してユーザーに通知
  setTimeout(() => {
    if (window.UIComponents && window.UIComponents.showToast) {
      window.UIComponents.showToast('ログインの有効期限が切れました。再度ログインしてください。', 'error');
    }
    showLoginModal();
  }, 0);
}

// ========================================
// APIヘルパー関数
// ========================================

/**
 * APIコールヘルパー(認証トークン付き)
 * @param {string} endpoint - APIエンドポイント
 * @param {Object} options - fetchオプション
 * @returns {Promise<any>} レスポンスJSON
 */
export async function apiCall(endpoint, options = {}) {
  console.log(`[AUTH.JS] apiCall が呼び出されました: ${endpoint}`);
  const apiBase = appState.get('apiBase') || '';
  const url = apiBase ? `${apiBase}${endpoint}` : endpoint;
  const headers = options.headers || {};
  
  // トークンがあれば追加（localStorageから直接取得 - 確実にトークンを取得）
  const loginToken = localStorage.getItem('loginToken');
  if (loginToken) {
    headers['Authorization'] = `Bearer ${loginToken}`;
  }
  
  // タイムアウト設定（デフォルト10秒）
  const timeout = options.timeout || 10000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    
    // 401エラーの場合、ログインが必要な場合は強制ログアウト（referenceプロジェクトに準拠）
    const requireLogin = appState.get('requireLogin');
    if (response.status === 401) {
      if (requireLogin) {
        forceLogout();
      } else {
        showLoginModal();
      }
      throw new Error('認証が必要です');
    }
    
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(error.detail || 'リクエストに失敗しました');
    }
    
    return await response.json();
  } catch (error) {
    clearTimeout(timeoutId);
    
    if (error.name === 'AbortError') {
      throw new Error('リクエストがタイムアウトしました。データベースが起動していない可能性があります。');
    }
    
    throw error;
  }
}

// ========================================
// エクスポート設定
// ========================================

// windowオブジェクトに登録（HTMLから呼び出せるように）
window.authModule = {
  showLoginModal,
  hideLoginModal,
  toggleLoginPassword,
  handleLogin,
  handleLogout,
  updateUserInfo,
  checkLoginStatus,
  forceLogout,
  apiCall,
  loadConfig
};

// 個別関数も直接登録（後方互換性のため）
window.showLoginModal = showLoginModal;
window.hideLoginModal = hideLoginModal;
window.toggleLoginPassword = toggleLoginPassword;
window.handleLogin = handleLogin;
window.handleLogout = handleLogout;
window.updateUserInfo = updateUserInfo;
window.checkLoginStatus = checkLoginStatus;
window.forceLogout = forceLogout;
window.apiCall = apiCall;
window.loadConfig = loadConfig;
