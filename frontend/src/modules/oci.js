/**
 * OCI設定モジュール
 * 
 * OCI API設定の読み込み、保存、接続テストを担当
 */

// ========================================
// インポート文
// ========================================
import { apiCall as authApiCall } from './auth.js';
import { 
  showToast as utilsShowToast, 
  showLoading as utilsShowLoading, 
  hideLoading as utilsHideLoading 
} from './utils.js';

// ========================================
// グローバル変数
// ========================================
let ociSettings = {
  user_ocid: '',
  tenancy_ocid: '',
  fingerprint: '',
  region: 'us-chicago-1',
  key_content: '',
  bucket_name: '',
  namespace: ''
};

let ociSettingsStatus = 'not_configured';
let ociLoading = false;
let ociAction = null;
let ociSaveResult = null;
let ociConnectionTestResult = null;

// ========================================
// OCI設定ロード/保存関数
// ========================================

/**
 * OCI設定をロード
 */
export async function loadOciSettings() {
  try {
    const data = await authApiCall('/ai/api/oci/settings');
    ociSettings = data.settings;
    // Regionは環境変数から取得、なければus-chicago-1をデフォルトにする
    ociSettings.region = ociSettings.region || 'us-chicago-1';
    ociSettingsStatus = data.status;
    
    // UIに反映
    document.getElementById('userOcid').value = ociSettings.user_ocid || '';
    document.getElementById('tenancyOcid').value = ociSettings.tenancy_ocid || '';
    document.getElementById('fingerprint').value = ociSettings.fingerprint || '';
    document.getElementById('region').value = ociSettings.region;
    document.getElementById('bucketName').value = ociSettings.bucket_name || '';
    document.getElementById('namespace').value = ociSettings.namespace || '';
    
    // Namespaceの自動取得処理
    const namespaceInput = document.getElementById('namespace');
    const namespaceStatus = document.getElementById('namespaceStatus');
    
    if (ociSettings.namespace) {
      // .envから取得できた場合
      namespaceStatus.textContent = '環境変数から読み込み済み';
      namespaceStatus.className = 'text-xs text-green-600';
    } else {
      // 空の場合、APIで取得を試みる（エラーは表示せず静かに失敗）
      namespaceStatus.textContent = 'Namespaceを取得中...';
      namespaceStatus.className = 'text-xs text-blue-600';
      
      try {
        const namespaceData = await authApiCall('/ai/api/oci/namespace');
        if (namespaceData.success) {
          namespaceInput.value = namespaceData.namespace;
          ociSettings.namespace = namespaceData.namespace;
          namespaceStatus.textContent = `OCI APIから自動取得済み`;
          namespaceStatus.className = 'text-xs text-green-600';
        } else {
          // エラーメッセージを表示せず、空白のまま
          namespaceStatus.textContent = '環境変数から読み込み中...';
          namespaceStatus.className = 'text-xs text-gray-500';
        }
      } catch (namespaceError) {
        // API Key未設定などのエラーは表示せず、空白のまま
        namespaceStatus.textContent = '環境変数から読み込み中...';
        namespaceStatus.className = 'text-xs text-gray-500';
      }
    }
    
    // Private Key の状態を表示
    updatePrivateKeyStatus();
    
    // ステータスバッジを更新
    updateOciStatusBadge();
    
    // Object Storageステータスバッジを更新
    updateObjectStorageStatusBadge(
      ociSettings.bucket_name,
      namespaceInput?.value
    );
    
  } catch (error) {
    // 初回ロード時はエラーでも表示しない（未設定扱い）
  }
}

/**
 * OCI設定を保存
 */
export async function saveOciSettings() {
  // 入力値を取得
  const userOcid = document.getElementById('userOcid').value.trim();
  const tenancyOcid = document.getElementById('tenancyOcid').value.trim();
  const fingerprint = document.getElementById('fingerprint').value.trim();
  
  // 入力検証
  if (!userOcid || !tenancyOcid || !fingerprint) {
    utilsShowToast('必須項目をすべて入力してください', 'warning');
    return;
  }
  
  // 初回設定時はPrivate Keyが必須
  if (!ociSettings.key_content || ociSettings.key_content === '') {
    if (ociSettingsStatus !== 'configured' && ociSettingsStatus !== 'saved') {
      utilsShowToast('Private Keyが必要です', 'warning');
      return;
    }
  }
  
  ociLoading = true;
  ociAction = 'save';
  ociSaveResult = null;
  ociConnectionTestResult = null;
  
  try {
    utilsShowLoading('APIキーを保存中...');
    
    // 設定を保存
    const settingsToSave = {
      user_ocid: userOcid,
      tenancy_ocid: tenancyOcid,
      fingerprint: fingerprint,
      region: document.getElementById('region').value,
      key_content: ociSettings.key_content,
      bucket_name: document.getElementById('bucketName').value.trim(),
      namespace: document.getElementById('namespace').value.trim()
    };
    
    const result = await authApiCall('/ai/api/oci/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settingsToSave)
    });
    
    // レスポンスから設定を更新
    ociSettings = result.settings;
    // Regionはレスポンスの値を使用、なければデフォルト値
    ociSettings.region = ociSettings.region || 'us-chicago-1';
    ociSettingsStatus = result.status;
    
    ociSaveResult = {
      success: true,
      message: result.message || '設定を保存しました',
      details: {
        region: result.settings.region,
        user_ocid: result.settings.user_ocid,
        tenancy_ocid: result.settings.tenancy_ocid,
        fingerprint: result.settings.fingerprint
      }
    };
    
    utilsHideLoading();
    utilsShowToast(result.message || '設定を保存しました', 'success');
    updateOciStatusBadge();
    
  } catch (error) {
    ociSaveResult = {
      success: false,
      message: '設定の保存に失敗しました'
    };
    utilsHideLoading();
    utilsShowToast('設定の保存に失敗しました', 'error');
  } finally {
    ociLoading = false;
    ociAction = null;
  }
}

// ========================================
// OCI接続テスト関数
// ========================================

/**
 * OCI接続テスト
 */
export async function testOciConnection() {
  // 入力値を取得
  const userOcid = document.getElementById('userOcid').value.trim();
  const tenancyOcid = document.getElementById('tenancyOcid').value.trim();
  const fingerprint = document.getElementById('fingerprint').value.trim();
  
  // 入力検証
  if (!userOcid || !tenancyOcid || !fingerprint) {
    utilsShowToast('必須項目をすべて入力してください', 'warning');
    return;
  }
  
  // 初回設定時はPrivate Keyが必須
  if (!ociSettings.key_content || ociSettings.key_content === '') {
    if (ociSettingsStatus !== 'configured' && ociSettingsStatus !== 'saved') {
      utilsShowToast('Private Keyが必要です', 'warning');
      return;
    }
  }
  
  ociLoading = true;
  ociAction = 'test';
  ociConnectionTestResult = null;
  ociSaveResult = null;
  
  try {
    utilsShowLoading('OCI接続テスト実行中...');
    
    const result = await authApiCall('/ai/api/oci/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: ociSettings })
    });
    
    ociConnectionTestResult = result;
    
    utilsHideLoading();
    
    if (result.success) {
      utilsShowToast('OCI接続テストに成功しました', 'success');
    } else {
      utilsShowToast('OCI接続テストに失敗しました', 'error');
    }
    
  } catch (error) {
    utilsHideLoading();
    utilsShowToast('接続テストに失敗しました', 'error');
  } finally {
    ociLoading = false;
    ociAction = null;
  }
}

// ========================================
// Private Key処理関数
// ========================================

/**
 * Private Keyファイル選択ハンドラー
 */
export function handlePrivateKeyFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  try {
    const reader = new FileReader();
    reader.onload = function(e) {
      const content = e.target.result;
      
      // PEMファイルの厳密な検証
      const pemPattern = /-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?PRIVATE KEY-----/;
      
      if (!content || typeof content !== 'string' || content.trim() === '') {
        utilsShowToast('無効なPEMファイル形式です: ファイルが空です', 'error');
        event.target.value = '';
        return;
      }
      
      if (!pemPattern.test(content)) {
        utilsShowToast('無効なPEMファイル形式です: 正しいPRIVATE KEYフォーマットが見つかりません', 'error');
        event.target.value = '';
        return;
      }
      
      ociSettings.key_content = content;
      utilsShowToast('Private Keyファイルを読み込みました', 'success');
      event.target.value = '';
      updatePrivateKeyStatus();
    };
    reader.onerror = function() {
      utilsShowToast('ファイルの読み込みに失敗しました', 'error');
      event.target.value = '';
    };
    reader.readAsText(file);
  } catch (error) {
    utilsShowToast('ファイルの処理に失敗しました: ' + error.message, 'error');
    event.target.value = '';
  }
}

/**
 * Private Keyをクリア
 */
export function clearPrivateKey() {
  ociSettings.key_content = '';
  const fileInput = document.getElementById('privateKeyFileInput');
  if (fileInput) {
    fileInput.value = '';
  }
  updatePrivateKeyStatus();
}

// ========================================
// ステータス表示更新関数
// ========================================

/**
 * Private Keyステータス表示を更新
 * @private
 */
function updatePrivateKeyStatus() {
  const statusDiv = document.getElementById('privateKeyStatus');
  if (!statusDiv) return;
  
  const settings = ociSettings;
  
  if (settings.key_content && settings.key_content !== '[CONFIGURED]') {
    statusDiv.innerHTML = `
      <div class="mt-3 p-3 bg-gray-50 rounded-md border border-gray-200">
        <div class="flex items-center justify-between mb-2">
          <span class="text-sm font-medium text-gray-700">ファイルがアップロードされました</span>
          <button onclick="clearPrivateKey();" class="text-xs text-red-600 hover:text-red-800 hover:underline">クリア</button>
        </div>
        <div class="text-xs font-mono text-gray-600 bg-white p-2 rounded border border-gray-200 max-h-32 overflow-y-auto">
          ${settings.key_content.substring(0, 200)}${settings.key_content.length > 200 ? '...' : ''}
        </div>
      </div>
    `;
  } else if (settings.key_content === '[CONFIGURED]') {
    statusDiv.innerHTML = `
      <div class="mt-3 p-3 bg-green-50 rounded-md border border-green-200">
        <div class="flex items-center justify-between">
          <span class="text-sm font-medium text-green-800"><i class="fas fa-check-circle"></i> Private Keyが設定済み</span>
          <span class="text-xs text-gray-500">再アップロードで更新</span>
        </div>
      </div>
    `;
  } else {
    statusDiv.innerHTML = '';
  }
}

/**
 * OCI設定ステータスバッジを更新
 * @private
 */
function updateOciStatusBadge() {
  const statusBadge = document.getElementById('ociSettingsStatusBadge');
  if (!statusBadge) return;
  
  if (ociSettingsStatus === 'configured' || ociSettingsStatus === 'saved') {
    statusBadge.textContent = '設定済み';
    statusBadge.className = 'px-2 py-1 text-xs font-semibold rounded-md';
    statusBadge.style.background = '#10b981';
    statusBadge.style.color = '#fff';
  } else {
    statusBadge.textContent = '未設定';
    statusBadge.className = 'px-2 py-1 text-xs font-semibold rounded-md';
    statusBadge.style.background = '#e2e8f0';
    statusBadge.style.color = '#64748b';
  }
}

/**
 * Object Storage設定ステータスバッジを更新
 * @param {string} bucketName - バケット名
 * @param {string} namespace - ネームスペース
 */
export function updateObjectStorageStatusBadge(bucketName, namespace) {
  const statusBadge = document.getElementById('objectStorageStatusBadge');
  if (!statusBadge) return;
  
  if (bucketName && namespace) {
    statusBadge.textContent = '設定済み';
    statusBadge.style.background = '#10b981';
    statusBadge.style.color = '#fff';
  } else {
    statusBadge.textContent = '未設定';
    statusBadge.style.background = '#e2e8f0';
    statusBadge.style.color = '#64748b';
  }
}

// ========================================
// Object Storage設定関数
// ========================================

/**
 * Object Storage設定を更新（更新ボタン用）
 * .envからBucket NameとNamespaceを取得し、入力欄に反映
 * OCI SDK経由でNamespaceを取得した場合、環境変数に保存
 */
export async function refreshObjectStorageSettings() {
  try {
    utilsShowLoading('.envからObject Storage設定を再取得中...');
    
    // OCI設定を取得
    const data = await authApiCall('/ai/api/oci/settings');
    const settings = data.settings;
    
    // ociSettingsとociSettingsStatusを更新
    ociSettings = settings;
    ociSettings.region = ociSettings.region || 'us-chicago-1';
    ociSettingsStatus = data.status;
    
    // OCI APIキー設定をUIに反映
    document.getElementById('userOcid').value = ociSettings.user_ocid || '';
    document.getElementById('tenancyOcid').value = ociSettings.tenancy_ocid || '';
    document.getElementById('fingerprint').value = ociSettings.fingerprint || '';
    document.getElementById('region').value = ociSettings.region;
    
    // Bucket Nameを設定
    const bucketNameInput = document.getElementById('bucketName');
    if (bucketNameInput) {
      bucketNameInput.value = settings.bucket_name || '';
    }
    
    // Namespaceの処理
    const namespaceInput = document.getElementById('namespace');
    const namespaceStatus = document.getElementById('namespaceStatus');
    let toastMessage = '';
    let toastType = 'success';
    
    if (settings.namespace) {
      // .envから取得できた場合
      namespaceInput.value = settings.namespace;
      namespaceStatus.textContent = '環境変数から読み込み済み';
      namespaceStatus.className = 'text-xs text-green-600';
      toastMessage = 'Bucket NameとNamespaceを再取得しました';
    } else {
      // 空の場合、OCI SDK経由で取得を試みる
      namespaceStatus.textContent = 'Namespaceを取得中...';
      namespaceStatus.className = 'text-xs text-blue-600';
      
      try {
        const namespaceData = await authApiCall('/ai/api/oci/namespace');
        if (namespaceData.success && namespaceData.namespace) {
          namespaceInput.value = namespaceData.namespace;
          ociSettings.namespace = namespaceData.namespace;
          
          // OCI SDK経由で取得した場合、環境変数に保存
          try {
            const saveResponse = await authApiCall('/ai/api/oci/object-storage/save', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                bucket_name: settings.bucket_name || '',
                namespace: namespaceData.namespace
              })
            });
            
            if (saveResponse.success) {
              namespaceStatus.textContent = 'OCI APIから自動取得し、環境変数に保存済み';
              namespaceStatus.className = 'text-xs text-green-600';
              toastMessage = 'NamespaceをOCI APIから取得し、環境変数に保存しました';
            } else {
              namespaceStatus.textContent = 'OCI APIから自動取得済み（環境変数保存失敗）';
              namespaceStatus.className = 'text-xs text-yellow-600';
              toastMessage = 'Namespaceを取得しましたが、環境変数への保存に失敗しました';
              toastType = 'warning';
            }
          } catch (saveError) {
            namespaceStatus.textContent = 'OCI APIから自動取得済み（環境変数保存エラー）';
            namespaceStatus.className = 'text-xs text-yellow-600';
            toastMessage = 'Namespaceを取得しましたが、環境変数への保存に失敗しました';
            toastType = 'warning';
          }
        } else {
          // API Key未設定などの場合はエラーを表示せず空白のまま
          namespaceStatus.textContent = '環境変数から読み込み中...';
          namespaceStatus.className = 'text-xs text-gray-500';
          toastMessage = bucketNameInput?.value ? 'Bucket Nameを再取得しました' : 'Bucket Nameが.envに設定されていません';
          toastType = bucketNameInput?.value ? 'success' : 'warning';
        }
      } catch (namespaceError) {
        // API Key未設定などのエラーは表示せず空白のまま
        namespaceStatus.textContent = '環境変数から読み込み中...';
        namespaceStatus.className = 'text-xs text-gray-500';
        toastMessage = bucketNameInput?.value ? 'Bucket Nameを再取得しました' : 'Bucket Nameが.envに設定されていません';
        toastType = bucketNameInput?.value ? 'success' : 'warning';
      }
    }
    
    // Private Keyの状態を表示
    updatePrivateKeyStatus();
    
    // ステータスバッジを更新
    updateOciStatusBadge();
    updateObjectStorageStatusBadge(
      bucketNameInput?.value,
      namespaceInput?.value
    );
    
    utilsHideLoading();
    
    // トーストメッセージを表示
    if (toastMessage) {
      utilsShowToast(toastMessage, toastType);
    }
    
  } catch (error) {
    utilsHideLoading();
    utilsShowToast(`設定再取得エラー: ${error.message}`, 'error');
  }
}

/**
 * Object Storage接続テスト
 */
export async function testObjectStorageConnection() {
  try {
    const bucketName = document.getElementById('bucketName').value.trim();
    const namespace = document.getElementById('namespace').value.trim();
    
    if (!bucketName) {
      utilsShowToast('Bucket Nameを入力してください', 'warning');
      return;
    }
    
    if (!namespace) {
      utilsShowToast('Namespaceが取得されていません', 'warning');
      return;
    }
    
    utilsShowLoading('Object Storage接続テスト中...');
    
    const response = await authApiCall('/ai/api/oci/object-storage/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bucket_name: bucketName,
        namespace: namespace
      })
    });
    
    if (response.success) {
      utilsShowToast(response.message || '接続テストに成功しました', 'success');
    } else {
      utilsShowToast(response.message || '接続テストに失敗しました', 'error');
    }
    
  } catch (error) {
    utilsShowToast(`テストエラー: ${error.message}`, 'error');
  } finally {
    utilsHideLoading();
  }
}

// ========================================
// エクスポート設定
// ========================================

// HTMLのonclickから直接呼び出せるようにグローバル登録
window.loadOciSettings = loadOciSettings;
window.saveOciSettings = saveOciSettings;
window.testOciConnection = testOciConnection;
window.handlePrivateKeyFileSelect = handlePrivateKeyFileSelect;
window.clearPrivateKey = clearPrivateKey;
window.refreshObjectStorageSettings = refreshObjectStorageSettings;
window.testObjectStorageConnection = testObjectStorageConnection;
