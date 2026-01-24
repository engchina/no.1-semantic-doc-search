/**
 * 認証モジュール
 * 
 * ログイン、ログアウト、認証状態管理を担当
 */

import { appState, setAuthState } from '../state.js';

/**
 * ログインモーダルを表示
 */
export function showLoginModal() {
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
  const input = document.getElementById('loginPassword');
  if (!input) return;
  input.type = input.type === 'password' ? 'text' : 'password';
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

/**
 * ログイン処理
 * @param {Event} event - フォーム送信イベント
 */
export async function handleLogin(event) {
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
    const url = apiBase ? `${apiBase}/api/login` : '/api/login';
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
      
      // AI Assistantボタンを表示
      const copilotBtn = document.getElementById('copilotToggleBtn');
      if (copilotBtn) {
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
  try {
    const loginToken = appState.get('loginToken');
    if (loginToken) {
      const apiBase = appState.get('apiBase') || '';
      const url = apiBase ? `${apiBase}/api/logout` : '/api/logout';
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

/**
 * ユーザー情報表示を更新
 */
export function updateUserInfo() {
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
  // ローカルストレージからトークンを取得
  const token = localStorage.getItem('loginToken');
  const user = localStorage.getItem('loginUser');
  
  if (token && user) {
    setAuthState(true, token, user);
    updateUserInfo();
    
    // AI Assistantボタンを表示
    const copilotBtn = document.getElementById('copilotToggleBtn');
    if (copilotBtn) {
      copilotBtn.style.display = 'flex';
    }
  } else {
    const requireLogin = appState.get('requireLogin');
    if (requireLogin) {
      // ログインが必要な場合はログイン画面を表示
      showLoginModal();
    } else {
      // デバッグモードでログイン不要の場合もAI Assistantボタンを表示
      const copilotBtn = document.getElementById('copilotToggleBtn');
      if (copilotBtn) {
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

/**
 * APIコールヘルパー（認証トークン付き）
 * @param {string} endpoint - APIエンドポイント
 * @param {Object} options - fetchオプション
 * @returns {Promise<any>} レスポンスJSON
 */
export async function apiCall(endpoint, options = {}) {
  const apiBase = appState.get('apiBase') || '';
  const url = apiBase ? `${apiBase}${endpoint}` : endpoint;
  const headers = options.headers || {};
  
  // トークンがあれば追加
  const loginToken = appState.get('loginToken');
  if (loginToken) {
    headers['Authorization'] = `Bearer ${loginToken}`;
  }
  
  const response = await fetch(url, {
    ...options,
    headers
  });
  
  // 401エラーの場合、デバッグモードでなければ強制ログアウト
  const debugMode = appState.get('debugMode');
  if (response.status === 401 && !debugMode) {
    const requireLogin = appState.get('requireLogin');
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
}

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
  apiCall
};

// デフォルトエクスポート
export default {
  showLoginModal,
  hideLoginModal,
  toggleLoginPassword,
  handleLogin,
  handleLogout,
  updateUserInfo,
  checkLoginStatus,
  forceLogout,
  apiCall
};
