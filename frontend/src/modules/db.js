
// グローバル変数（app.jsからの移行）
let dbTablesPage = 1;

// デバッグ用：db.jsの関数が呼び出されたことを示すフラグ
console.log('[DEBUG] db.jsモジュールがロードされました');
let dbTablesTotalPages = 1;
let selectedDbTables = [];
let dbTablesBatchDeleteLoading = false;
let selectedTableForPreview = null;
let tableDataPage = 1;
let tableDataPageSize = 20;
let tableDataTotalPages = 1;
let selectedTableDataRows = [];
let currentPageTableDataRows = [];
let currentPageDbTables = [];

import { appState } from '../state.js';
import { apiCall as authApiCall } from './auth.js';
import { showLoading as utilsShowLoading, hideLoading as utilsHideLoading, showToast as utilsShowToast, formatDateTime as utilsFormatDateTime } from './utils.js';

/**
 * DB接続設定を読み込み、UIに反映する
 */
export async function loadDbConnectionSettings() {
  try {
    const data = await authApiCall('/ai/api/settings/database');
    const settings = data.settings;
    
    document.getElementById('dbUser').value = settings.username || '';
    
    // Walletアップロード状況を表示
    if (settings.wallet_uploaded) {
      const walletStatus = document.getElementById('walletStatus');
      walletStatus.style.display = 'block';
      walletStatus.innerHTML = '<span class="text-green-600"><i class="fas fa-check-circle"></i> Walletアップロード済み</span>';
      
      // 利用可能なDSNを表示
      if (settings.available_services && settings.available_services.length > 0) {
        const dsnDisplay = document.getElementById('dsnDisplay');
        const dsnSelect = document.getElementById('dbDsn');
        dsnDisplay.style.display = 'block';
        
        dsnSelect.innerHTML = '<option value="">選択してください</option>';
        settings.available_services.forEach(dsn => {
          const option = document.createElement('option');
          option.value = dsn;
          option.textContent = dsn;
          if (dsn === settings.dsn) {
            option.selected = true;
          }
          dsnSelect.appendChild(option);
        });
      }
    }
    
    const statusBadge = document.getElementById('dbConnectionStatusBadge');
    if (data.is_connected) {
      statusBadge.textContent = '接続済み';
      statusBadge.style.background = '#10b981';
      statusBadge.style.color = '#fff';
    } else {
      statusBadge.textContent = '未設定';
      statusBadge.style.background = '#e2e8f0';
      statusBadge.style.color = '#64748b';
    }
    
  } catch (error) {
    console.error('DB設定読み込みエラー:', error);
    // エラーを再スローしてswitchTabでキャッチさせる（トーストは表示しない）
    throw error;
  }
}

/**
 * 環境変数からDB接続設定を再取得する
 */
export async function refreshDbConnectionFromEnv() {
  try {
    utilsShowLoading('接続設定を再取得中...');
    
    // 環境変数から情報を取得
    const envData = await authApiCall('/ai/api/settings/database/env');
    
    if (!envData.success) {
      utilsHideLoading();
      utilsShowToast(envData.message, 'error');
      return;
    }
    
    // ユーザー名を設定
    if (envData.username) {
      document.getElementById('dbUser').value = envData.username;
    }
    
    // Wallet情報を表示
    const walletStatus = document.getElementById('walletStatus');
    if (envData.wallet_exists) {
      walletStatus.style.display = 'block';
      walletStatus.innerHTML = '<span class="text-green-600"><i class="fas fa-check-circle"></i> Wallet検出済み (' + envData.wallet_location + ')</span>';
      
      // 利用可能なDSNを表示
      if (envData.available_services && envData.available_services.length > 0) {
        const dsnDisplay = document.getElementById('dsnDisplay');
        const dsnSelect = document.getElementById('dbDsn');
        dsnDisplay.style.display = 'block';
        
        dsnSelect.innerHTML = '<option value="">選択してください</option>';
        envData.available_services.forEach(dsn => {
          const option = document.createElement('option');
          option.value = dsn;
          option.textContent = dsn;
          // 環境変数のDSNを選択
          if (dsn === envData.dsn) {
            option.selected = true;
          }
          dsnSelect.appendChild(option);
        });
      }
    } else {
      walletStatus.style.display = 'block';
      // ダウンロードエラーがあれば表示
      if (envData.download_error) {
        walletStatus.innerHTML = '<span class="text-red-600"><i class="fas fa-times-circle"></i> Wallet自動ダウンロード失敗: ' + envData.download_error + '</span><br><span class="text-gray-600">手動でZIPファイルをアップロードしてください。</span>';
      } else {
        walletStatus.innerHTML = '<span class="text-yellow-600"><i class="fas fa-exclamation-triangle"></i> Walletが見つかりません。ZIPファイルをアップロードしてください。</span>';
      }
    }
    
    // ステータスバッジを更新（設定ファイルの有無で判定、実際の接続確認はしない）
    const statusBadge = document.getElementById('dbConnectionStatusBadge');
    
    if (envData.username && envData.dsn && envData.wallet_exists) {
      statusBadge.textContent = '設定済み';
      statusBadge.style.background = '#10b981';
      statusBadge.style.color = '#fff';
    } else {
      statusBadge.textContent = '未設定';
      statusBadge.style.background = '#e2e8f0';
      statusBadge.style.color = '#64748b';
    }
    
    utilsHideLoading();
    utilsShowToast('接続設定を再取得しました', 'success');
    
  } catch (error) {
    utilsHideLoading();
    utilsShowToast(`接続設定の再取得に失敗しました: ${error.message}`, 'error');
  }
}


/**
 * DB設定再読み込み(リトライ機能)
 */
export async function retryLoadDbSettings() {
  try {
    // 警告メッセージを削除
    const alerts = document.querySelectorAll('#tab-database > .bg-yellow-50');
    alerts.forEach(alert => alert.remove());
    
    utilsShowLoading('データベース設定を再読み込み中...');
    
    await loadDbConnectionSettings();
    
    // ADB OCIDのみを自動取得
    try {
      await loadAdbOcidOnly();
    } catch (error) {
      console.warn('ADB OCID取得エラー（スキップ）:', error);
    }
    
    // .envからDB接続情報を自動取得
    try {
      await loadDbConnectionInfoFromEnv();
    } catch (error) {
      console.warn('DB接続情報取得エラー（スキップ）:', error);
    }
    
    utilsHideLoading();
    utilsShowToast('データベース設定を読み込みました', 'success');
  } catch (error) {
    utilsHideLoading();
    
    if (error.message.includes('タイムアウト')) {
      utilsShowToast('まだデータベースが起動していません。もう一度お試しください。', 'warning');
      
      // 警告メッセージを再表示
      const dbContent = document.getElementById('tab-database');
      if (dbContent && !dbContent.querySelector('.bg-yellow-50')) {
        const retryHtml = `
          <div class="bg-yellow-50 border-l-4 border-yellow-400 p-4 mb-4" role="alert">
            <div class="flex items-start">
              <div class="flex-shrink-0">
                <i class="fas fa-exclamation-triangle text-yellow-400 h-5 w-5"></i>
              </div>
              <div class="ml-3 flex-1">
                <p class="text-sm text-yellow-700">
                  データベース設定の読み込みに失敗しました。データベースが起動していない可能性があります。
                </p>
                <p class="mt-2 text-sm text-yellow-700">
                  データベースを起動してから、下のボタンをクリックして再読み込みしてください。
                </p>
                <div class="mt-3">
                  <button 
                    onclick="window.retryLoadDbSettings()" 
                    class="bg-yellow-500 hover:bg-yellow-600 text-white px-4 py-2 rounded transition-colors"
                  >
                    <i class="fas fa-sync-alt"></i> 再読み込み
                  </button>
                </div>
              </div>
            </div>
          </div>
        `;
        dbContent.insertAdjacentHTML('afterbegin', retryHtml);
      }
    } else {
      utilsShowToast(`再読み込みに失敗しました: ${error.message}`, 'error');
    }
  }
}


let selectedWalletFile = null;

/**
 * Walletファイル選択時の処理
 * @param {Event} event - ファイル選択イベント
 */
export function handleWalletFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  if (!file.name.toLowerCase().endsWith('.zip')) {
    utilsShowToast('ZIPファイルを選択してください', 'error');
    return;
  }
  
  selectedWalletFile = file;
  const fileNameDiv = document.getElementById('walletFileName');
  fileNameDiv.style.display = 'block';
  fileNameDiv.textContent = `選択されたファイル: ${file.name}`;
  
  // Walletを自動アップロード
  uploadWalletFile(file);
}

export async function uploadWalletFile(file) {
  try {
    utilsShowLoading('Walletをアップロード中...');
    
    const formData = new FormData();
    formData.append('file', file);
    
    // トークンを確認（localStorageから直接取得 - referenceプロジェクトに準拠）
    const loginToken = localStorage.getItem('loginToken');
    const headers = {};
    if (loginToken) {
      headers['Authorization'] = `Bearer ${loginToken}`;
    }
    
    const apiBase = appState.get('apiBase') || '';
    const response = await fetch(apiBase ? `${apiBase}/api/settings/database/wallet` : '/ai/api/settings/database/wallet', {
      method: 'POST',
      headers: headers,
      body: formData
    });
    
    utilsHideLoading();
    
    if (!response.ok) {
      // 401エラーの場合は強制ログアウト（referenceプロジェクトに準拠）
      if (response.status === 401) {
        const { forceLogout: authForceLogout } = await import('./auth.js');
        const requireLogin = appState.get('requireLogin');
        if (requireLogin) {
          authForceLogout();
          throw new Error('無効または期限切れのトークンです');
        }
      }
      const error = await response.json();
      throw new Error(error.detail || 'Walletアップロードに失敗しました');
    }
    
    const data = await response.json();
    
    if (data.success) {
      const walletStatus = document.getElementById('walletStatus');
      walletStatus.style.display = 'block';
      walletStatus.innerHTML = '<span class="text-green-600"><i class="fas fa-check-circle"></i> Walletアップロード成功</span>';
      
      utilsShowToast(data.message, 'success');
      
      // 利用可能なDSNを表示
      if (data.available_services && data.available_services.length > 0) {
        const dsnDisplay = document.getElementById('dsnDisplay');
        const dsnSelect = document.getElementById('dbDsn');
        dsnDisplay.style.display = 'block';
        
        dsnSelect.innerHTML = '<option value="">選択してください</option>';
        data.available_services.forEach(dsn => {
          const option = document.createElement('option');
          option.value = dsn;
          option.textContent = dsn;
          dsnSelect.appendChild(option);
        });
      }
    }
    
  } catch (error) {
    utilsHideLoading();
    utilsShowToast(`Walletのアップロードに失敗しました: ${error.message}`, 'error');
    
    const walletStatus = document.getElementById('walletStatus');
    walletStatus.style.display = 'block';
    walletStatus.innerHTML = `<span class="text-red-600"><i class="fas fa-times-circle"></i> ${error.message}</span>`;
  }
}

export async function saveDbConnection() {
  const username = document.getElementById('dbUser').value.trim();
  const password = document.getElementById('dbPassword').value;
  const dsn = document.getElementById('dbDsn').value;
  
  if (!username || !password) {
    utilsShowToast('ユーザー名とパスワードを入力してください', 'warning');
    return;
  }
  
  if (!dsn) {
    utilsShowToast('サービス名/DSNを選択してください', 'warning');
    return;
  }
  
  const settings = {
    username: username,
    password: password,
    dsn: dsn
  }
  
  try {
    utilsShowLoading('DB設定を保存中...');
    
    await authApiCall('/ai/api/settings/database', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
    });
    
    utilsHideLoading();
    utilsShowToast('DB設定を保存しました', 'success');
    
    await loadDbConnectionSettings();
    
  } catch (error) {
    utilsHideLoading();
    utilsShowToast(`保存に失敗しました: ${error.message}`, 'error');
  }
}

export async function testDbConnection() {
  try {
    // パスワードフィールドを取得
    const passwordField = document.getElementById('dbPassword');
    
    // 少し待ってから値を取得（スクロール防止のためfocus/blurは削除）
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // 入力されている値を取得（保存前でもテストできるように）
    const username = document.getElementById('dbUser').value.trim();
    let password = passwordField.value;
    const dsn = document.getElementById('dbDsn').value;
    
    // パスワードが入力されていない場合、環境変数から取得
    if (!password) {
      utilsShowLoading('環境変数からパスワードを取得中...');
      try {
        const envData = await authApiCall('/ai/api/settings/database/env?include_password=true');
        if (envData.success && envData.password && envData.password !== '[CONFIGURED]') {
          password = envData.password;
        }
        utilsHideLoading();
      } catch (error) {
        utilsHideLoading();
        // console.warn('環境変数からパスワード取得エラー:', error);
      }
    }
    
    // デバッグログ
    // デバッグ情報（本番環境ではコメントアウト）
    // console.log('=== 接続テスト情報 ===');
    // console.log('Username:', username);
    // console.log('Password length:', password ? password.length : 0);
    // console.log('DSN:', dsn);
    // console.log('Password exists:', !!password);
    // console.log('Password from env:', !passwordField.value && !!password);
    // console.log('=====================');
    
    // 入力チェック
    if (!username || !password || !dsn) {
      utilsShowToast('ユーザー名、パスワード、DSNを入力してください', 'warning');
      return;
    }
    
    utilsShowLoading('接続テスト中...');
    
    const requestBody = {
      settings: {
        username: username,
        password: password,
        dsn: dsn
      }
    }
    
    // console.log('Request body:', JSON.stringify({...requestBody, settings: {...requestBody.settings, password: '[HIDDEN]'}}));
    
    // タイムアウト処理を追加（20秒）- バックエンド側も15秒でタイムアウトする
    const timeoutPromise = new Promise((_, reject) => 
      setTimeout(() => reject(new Error('接続テストがタイムアウトしました（20秒）')), 20000)
    );
    
    const apiPromise = authApiCall('/ai/api/settings/database/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    });
    
    const data = await Promise.race([apiPromise, timeoutPromise]);
    
    utilsHideLoading();
    
    if (data.success) {
      utilsShowToast(data.message, 'success');
      
      // 接続成功時、DB情報を自動読み込み
      // await loadDbInfo();
    } else {
      utilsShowToast(data.message, 'error');
    }
    
  } catch (error) {
    utilsHideLoading();
    utilsShowToast(`接続テストエラー: ${error.message}`, 'error');
  }
}

/**
 * データベース基本情報を取得・表示する
 */
export async function loadDbInfo() {
  try {
    utilsShowLoading('データベース情報を取得中...');
    
    const data = await authApiCall('/ai/api/database/info');
    
    utilsHideLoading();
    
    const infoDiv = document.getElementById('dbInfoContent');
    const statusBadge = document.getElementById('dbInfoStatusBadge');
    
    if (!data.info) {
      infoDiv.innerHTML = `
        <div style="text-align: center; padding: 40px; color: #64748b;">
          <div style="font-size: 48px; margin-bottom: 16px;"><i class="fas fa-database" style="color: #94a3b8;"></i></div>
          <div style="font-size: 16px; font-weight: 500;">データベースに接続してください</div>
          <div style="font-size: 14px; margin-top: 8px;">接続後、データベース情報が表示されます</div>
        </div>
      `;
      if (statusBadge) {
        statusBadge.textContent = '未取得';
        statusBadge.style.background = '#e2e8f0';
        statusBadge.style.color = '#64748b';
      }
      return;
    }
    
    // ステータスバッジを更新
    if (statusBadge) {
      statusBadge.textContent = '取得済み';
      statusBadge.style.background = '#10b981';
      statusBadge.style.color = '#fff';
    }
    
    const info = data.info;
    infoDiv.innerHTML = `
      <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px;">
        <div class="card">
          <div class="card-body">
            <div style="font-size: 13px; color: #64748b; margin-bottom: 4px;">データベースバージョン</div>
            <div style="font-size: 16px; font-weight: 600; color: #1e293b;">${info.version || '-'}</div>
          </div>
        </div>
        
        <div class="card">
          <div class="card-body">
            <div style="font-size: 13px; color: #64748b; margin-bottom: 4px;">接続ユーザー</div>
            <div style="font-size: 16px; font-weight: 600; color: #1e293b;">${info.current_user || '-'}</div>
          </div>
        </div>
        
        <div class="card">
          <div class="card-body">
            <div style="font-size: 13px; color: #64748b; margin-bottom: 4px;">インスタンス名</div>
            <div style="font-size: 16px; font-weight: 600; color: #1e293b;">${info.instance_name || '-'}</div>
          </div>
        </div>
        
        <div class="card">
          <div class="card-body">
            <div style="font-size: 13px; color: #64748b; margin-bottom: 4px;">データベース名</div>
            <div style="font-size: 16px; font-weight: 600; color: #1e293b;">${info.database_name || '-'}</div>
          </div>
        </div>
      </div>
    `;
    
  } catch (error) {
    utilsHideLoading();
    utilsShowToast(`データベース情報取得エラー: ${error.message}`, 'error');
  }
}

/**
 * テーブル一覧を取得・表示する
 */
export async function loadDbTables() {
  try {
    utilsShowLoading('テーブル一覧を取得中...');
    
    // appStateからページ情報を取得
    const currentPage = appState.get('dbTablesPage') || 1;
    const pageSize = appState.get('dbTablesPageSize') || 20;
    
    // ページングパラメータ付きでAPIを呼び出し
    const data = await authApiCall(`/ai/api/database/tables?page=${currentPage}&page_size=${pageSize}`);
    
    utilsHideLoading();
    
    // 総ページ数を保存
    dbTablesTotalPages = data.total_pages || 1;
    
    // '$'を含むテーブルをフィルタリング（バックエンドでも処理済みだが、念のため）
    const filteredTables = (data.tables || []).filter(t => !t.table_name.includes('$'));
    
    // 現在ページのテーブル一覧を保存（チェック用）
    currentPageDbTables = filteredTables.map(t => t.table_name);
    
    const tablesDiv = document.getElementById('dbTablesContent');
    const statusBadge = document.getElementById('dbTablesStatusBadge');
    
    if (!filteredTables || filteredTables.length === 0) {
      currentPageDbTables = [];
      tablesDiv.innerHTML = `
        <div style="text-align: center; padding: 40px; color: #64748b;">
          <div style="font-size: 48px; margin-bottom: 16px;"><i class="fas fa-table" style="color: #94a3b8;"></i></div>
          <div style="font-size: 16px; font-weight: 500;">テーブル情報なし</div>
          <div style="font-size: 14px; margin-top: 8px;">データベースに接続後、テーブル一覧が表示されます</div>
        </div>
      `;
      if (statusBadge) {
        statusBadge.textContent = '0件';
        statusBadge.style.background = '#e2e8f0';
        statusBadge.style.color = '#64748b';
      }
      return;
    }
    
    // ステータスバッジを更新（総件数を表示）
    if (statusBadge) {
      statusBadge.textContent = `${data.total}件`;
      statusBadge.style.background = '#10b981';
      statusBadge.style.color = '#fff';
    }
    
    // ヘッダーチェックボックスの状態を判定
    const allPageSelected = currentPageDbTables.length > 0 && 
                            currentPageDbTables.every(t => selectedDbTables.includes(t));
    
    // 選択操作ボタンHTML
    const selectionButtonsHtml = `
      <div class="flex items-center justify-between mb-3">
        <div class="flex gap-2">
          <button onclick="selectAllDbTables()" class="px-2 py-1 border rounded text-xs hover:bg-gray-100 ${dbTablesBatchDeleteLoading ? 'opacity-50 cursor-not-allowed' : ''}" ${dbTablesBatchDeleteLoading ? 'disabled' : ''}>すべて選択</button>
          <button onclick="clearAllDbTables()" class="px-2 py-1 border rounded text-xs hover:bg-gray-100 ${dbTablesBatchDeleteLoading ? 'opacity-50 cursor-not-allowed' : ''}" ${dbTablesBatchDeleteLoading ? 'disabled' : ''}>すべて解除</button>
          <button onclick="deleteSelectedDbTables()" class="px-2 py-1 text-xs rounded border border-red-300 text-red-600 hover:bg-red-50 ${(selectedDbTables.length === 0 || dbTablesBatchDeleteLoading) ? 'opacity-40 cursor-not-allowed' : ''}" ${(selectedDbTables.length === 0 || dbTablesBatchDeleteLoading) ? 'disabled' : ''}>
            ${dbTablesBatchDeleteLoading ? '<span class="spinner spinner-sm"></span> 処理中...' : `削除 (${selectedDbTables.length})`}
          </button>
        </div>
      </div>
    `;
    
    // ページネーションUI生成
    const paginationHtml = UIComponents.renderPagination({
      currentPage: data.current_page,
      totalPages: data.total_pages,
      totalItems: data.total,
      startNum: data.start_row,
      endNum: data.end_row,
      onPrevClick: 'handleDbTablesPrevPage()',
      onNextClick: 'handleDbTablesNextPage()',
      onJumpClick: 'handleDbTablesJumpPage',
      inputId: 'dbTablesPageInput',
      disabled: dbTablesBatchDeleteLoading
    });
    
    tablesDiv.innerHTML = `
      <div>
        ${selectionButtonsHtml}
        ${paginationHtml}
        <div class="table-wrapper-scrollable">
          <table class="data-table">
            <thead>
              <tr>
                <th style="width: 40px;"><input type="checkbox" id="dbTablesHeaderCheckbox" onchange="toggleSelectAllDbTables(this.checked)" ${allPageSelected ? 'checked' : ''} class="w-4 h-4 rounded" ${dbTablesBatchDeleteLoading ? 'disabled' : ''}></th>
                <th>テーブル名</th>
                <th>行数</th>
                <th>作成日時</th>
                <th>最終更新</th>
                <th>コメント</th>
                <th style="width: 100px;">操作</th>
              </tr>
            </thead>
            <tbody>
              ${filteredTables.map(table => {
                const isSelected = selectedTableForPreview === table.table_name;
                // テーブル名をJavaScript文字列としてエスケープ（シングルクォート対応）
                const escapedTableName = table.table_name.replace(/'/g, "\\'");
                return `
                <tr>
                  <td><input type="checkbox" onchange="toggleDbTableSelection('${escapedTableName}')" ${selectedDbTables.includes(table.table_name) ? 'checked' : ''} class="w-4 h-4 rounded" ${dbTablesBatchDeleteLoading ? 'disabled' : ''}></td>
                  <td style="font-weight: 500; font-family: monospace;">${table.table_name}</td>
                  <td>${table.num_rows !== null ? table.num_rows.toLocaleString() : '-'}</td>
                  <td>${table.created ? utilsFormatDateTime(table.created) : '-'}</td>
                  <td>${table.last_analyzed ? utilsFormatDateTime(table.last_analyzed) : '-'}</td>
                  <td style="max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                    ${table.comments || '-'}
                  </td>
                  <td>
                    <button 
                      onclick="toggleTablePreview('${escapedTableName}')" 
                      class="px-2 py-1 text-xs rounded ${isSelected ? 'bg-blue-500 text-white' : 'border border-blue-300 text-blue-600 hover:bg-blue-50'}" 
                      ${dbTablesBatchDeleteLoading ? 'disabled' : ''}>
                      ${isSelected ? '選択中' : '選択'}
                    </button>
                  </td>
                </tr>
              `}).join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;
    
  } catch (error) {
    utilsHideLoading();
    utilsShowToast(`テーブル一覧取得エラー: ${error.message}`, 'error');
  }
}

export async function toggleTablePreview(tableName) {
  // スクロール位置を保存
  const scrollableArea = document.querySelector('#dbTablesContent .table-wrapper-scrollable');
  const scrollTop = scrollableArea ? scrollableArea.scrollTop : 0;
  
  if (selectedTableForPreview === tableName) {
    // 選択解除
    selectedTableForPreview = null;
    hideTablePreview();
    await loadDbTables();  // テーブル一覧を更新してボタン表示を切り替え
  } else {
    // 新しいテーブルを選択
    selectedTableForPreview = tableName;
    tableDataPage = 1;  // ページをリセット
    await loadDbTables();  // テーブル一覧を更新してボタン表示を切り替え
    await loadTableData(tableName);
  }
  
  // スクロール位置を復元
  const scrollableAreaAfter = document.querySelector('#dbTablesContent .table-wrapper-scrollable');
  if (scrollableAreaAfter) {
    requestAnimationFrame(() => {
      scrollableAreaAfter.scrollTop = scrollTop;
    });
  }
}

/**
 * テーブルデータを取得・表示する
 * @param {string} tableName - 対象テーブル名
 */
export async function loadTableData(tableName) {
  try {
    utilsShowLoading(`テーブル ${tableName} のデータを読み込み中...`);
    
    const data = await authApiCall(`/ai/api/database/tables/${encodeURIComponent(tableName)}/data?page=${tableDataPage}&page_size=${tableDataPageSize}`);
    
    utilsHideLoading();
    
    if (!data.success) {
      // エラーメッセージを明確に表示
      utilsShowToast(data.message || 'データ取得に失敗しました', 'error');
      showTablePreview(tableName, [], [], 0, data);
      return;
    }
    
    if (!data.rows || data.rows.length === 0) {
      // データが空の場合
      showTablePreview(tableName, [], [], 0, data);
      return;
    }
    
    tableDataTotalPages = data.total_pages || 1;
    
    showTablePreview(tableName, data.columns, data.rows, data.total, data);
    
  } catch (error) {
    utilsHideLoading();
    utilsShowToast(`データ取得エラー: ${error.message}`, 'error');
    // エラー時もプレビューを非表示にする
    hideTablePreview();
    selectedTableForPreview = null;
    await loadDbTables();
  }
}

/**
 * HTML特殊文字をエスケープする
 * @param {string} text - エスケープ対象の文字列
 * @returns {string} エスケープ後の文字列
 */
export function escapeHtml(text) {
  if (text === null || text === undefined) return '-';
  
  let str = String(text);
  
  // BLOB/LOBデータの判定：配列形式、BLOBタグ、LOBタグ、または500文字以上の長いデータ
  const isBlobLike = str.startsWith('array([') || 
                     str.startsWith('array("[') ||
                     str.startsWith('<BLOB:') || 
                     str.startsWith('<LOB:') ||
                     str.length > 500;
  
  if (isBlobLike) {
    // BLOB/LOB類データは100文字に制限
    if (str.length > 100) {
      str = str.substring(0, 100) + '...';
    }
  }
  
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

/**
 * テーブルデータプレビューを表示する
 * @param {string} tableName - テーブル名
 * @param {Array} columns - カラム名配列
 * @param {Array} rows - データ行配列
 * @param {number} total - 総レコード数
 * @param {Object} paginationData - ページネーション情報
 */
export function showTablePreview(tableName, columns, rows, total, paginationData) {
  let previewDiv = document.getElementById('tableDataPreview');
  
  if (!previewDiv) {
    console.error('tableDataPreview element not found');
    return;
  }
  
  // プレビューDivを表示
  previewDiv.style.display = 'block';
  
  if (rows.length === 0) {
    previewDiv.innerHTML = `
      <div class="apex-region-header">
        <span><i class="fas fa-table"></i> ${escapeHtml(tableName)} - データプレビュー</span>
        <div style="display: flex; align-items: center; gap: 8px;">
          <button class="apex-button-secondary apex-button-xs" onclick="refreshTableData()">
            <i class="fas fa-sync-alt"></i> 再取得
          </button>
          <span class="px-2 py-1 text-xs font-semibold rounded-md" style="background: #e2e8f0; color: #64748b;">
            0件
          </span>
        </div>
      </div>
      <div style="padding: 24px;">
        <div style="text-align: center; padding: 40px; color: #64748b;">
          <div style="font-size: 48px; margin-bottom: 16px;"><i class="fas fa-table" style="color: #94a3b8;"></i></div>
          <div style="font-size: 16px; font-weight: 500;">データがありません</div>
          <div style="font-size: 14px; margin-top: 8px;">テーブル ${escapeHtml(tableName)} にデータがありません</div>
        </div>
      </div>
    `;
    return;
  }
  
  // paginationDataのnullチェックとデフォルト値設定
  const safePageData = paginationData || {
    current_page: 1,
    total_pages: 1,
    total: total,
    start_row: 1,
    end_row: rows.length
  }
  
  // 現在ページの行を一意に識別する（最初の列を識別子として使用）
  // ※ どのテーブルでも対応できるよう、特定の列名に依存しない汎用的な処理
  currentPageTableDataRows = rows.map((row, index) => {
    if (columns.length > 0 && row.length > 0) {
      // 最初の列の値を識別子として使用（通常は主キー）
      const primaryValue = row[0];
      // ページ番号とインデックスを組み合わせてグローバルに一意にする
      return `${safePageData.current_page}_${index}_${primaryValue}`;
    } else {
      // データがない場合は行インデックスのみ使用
      return `${safePageData.current_page}_${index}`;
    }
  });
  
  // ヘッダーチェックボックスの状態を判定
  const allPageSelected = currentPageTableDataRows.length > 0 && 
                          currentPageTableDataRows.every(i => selectedTableDataRows.includes(i));
  
  // 選択操作ボタンHTML（テーブル一覧と同じスタイル）
  const selectionButtonsHtml = `
    <div class="flex items-center justify-between mb-3">
      <div class="flex gap-2">
        <button onclick="selectAllTableData()" class="px-2 py-1 border rounded text-xs hover:bg-gray-100">すべて選択</button>
        <button onclick="clearAllTableData()" class="px-2 py-1 border rounded text-xs hover:bg-gray-100">すべて解除</button>
        <button onclick="deleteSelectedTableData()" class="px-2 py-1 text-xs rounded border border-red-300 text-red-600 hover:bg-red-50 ${selectedTableDataRows.length === 0 ? 'opacity-40 cursor-not-allowed' : ''}" ${selectedTableDataRows.length === 0 ? 'disabled' : ''}>
          削除 (${selectedTableDataRows.length})
        </button>
      </div>
    </div>
  `;
  
  // ページネーションUI生成
  const paginationHtml = UIComponents.renderPagination({
    currentPage: safePageData.current_page,
    totalPages: safePageData.total_pages,
    totalItems: safePageData.total,
    startNum: safePageData.start_row,
    endNum: safePageData.end_row,
    onPrevClick: 'handleTableDataPrevPage()',
    onNextClick: 'handleTableDataNextPage()',
    onJumpClick: 'handleTableDataJumpPage',
    inputId: 'tableDataPageInput'
  });
  
  previewDiv.innerHTML = `
    <div class="apex-region-header">
      <span><i class="fas fa-table"></i> ${escapeHtml(tableName)} - データプレビュー</span>
      <div style="display: flex; align-items: center; gap: 8px;">
        <button class="apex-button-secondary apex-button-xs" onclick="refreshTableData()">
          <i class="fas fa-sync-alt"></i> 再取得
        </button>
        <span class="px-2 py-1 text-xs font-semibold rounded-md" style="background: #dcfce7; color: #166534;">
          ${total}件
        </span>
      </div>
    </div>
    <div style="padding: 24px;">
      ${selectionButtonsHtml}
      ${paginationHtml}
      <div class="table-wrapper-scrollable">
        <table class="data-table">
          <thead>
            <tr>
              <th style="width: 40px;"><input type="checkbox" id="tableDataHeaderCheckbox" onchange="toggleSelectAllTableData(this.checked)" ${allPageSelected ? 'checked' : ''} class="w-4 h-4 rounded"></th>
              ${columns.map(col => `<th>${escapeHtml(col)}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${rows.map((row, index) => {
              // 行を一意に識別する（currentPageTableDataRowsと同じロジック）
              let rowId;
              if (columns.length > 0 && row.length > 0) {
                const primaryValue = row[0];
                rowId = `${safePageData.current_page}_${index}_${primaryValue}`;
              } else {
                rowId = `${safePageData.current_page}_${index}`;
              }
              const isChecked = selectedTableDataRows.includes(rowId);
              // HTMLエスケープしたrowIdを使用
              const escapedRowId = rowId.replace(/'/g, "&#39;").replace(/"/g, "&quot;");
              return `
              <tr>
                <td><input type="checkbox" onchange="toggleTableDataRowSelection('${escapedRowId}')" ${isChecked ? 'checked' : ''} class="w-4 h-4 rounded"></td>
                ${row.map(cell => `<td>${escapeHtml(cell)}</td>`).join('')}
              </tr>
            `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}

export function hideTablePreview() {
  const previewDiv = document.getElementById('tableDataPreview');
  if (previewDiv) {
    previewDiv.style.display = 'none';
    previewDiv.innerHTML = '';  // 内容もクリア
  }
  // 選択状態をクリア
  selectedTableDataRows = [];
  currentPageTableDataRows = [];
}

export async function refreshTableData() {
  if (selectedTableForPreview) {
    tableDataPage = 1;
    await loadTableData(selectedTableForPreview);
  }
}

export function handleTableDataPrevPage() {
  if (tableDataPage > 1 && selectedTableForPreview) {
    tableDataPage--;
    loadTableData(selectedTableForPreview);
  }
}

/**
 * テーブルデータの次のページへ
 */
export function handleTableDataNextPage() {
  if (tableDataPage < tableDataTotalPages && selectedTableForPreview) {
    tableDataPage++;
    loadTableData(selectedTableForPreview);
  }
}

/**
 * 指定ページへジャンプ（テーブルデータ）
 */
export function handleTableDataJumpPage() {
  const input = document.getElementById('tableDataPageInput');
  if (!input) {
    utilsShowToast('ページ入力エラー', 'error');
    return;
  }
  
  const page = parseInt(input.value, 10);
  
  // NaNチェックを追加
  if (isNaN(page)) {
    utilsShowToast('有効な数値を入力してください', 'error');
    input.value = tableDataPage;
    return;
  }
  
  if (page >= 1 && page <= tableDataTotalPages && selectedTableForPreview) {
    tableDataPage = page;
    loadTableData(selectedTableForPreview);
  } else {
    utilsShowToast('無効なページ番号です', 'error');
    input.value = tableDataPage;
  }
}

/**
 * テーブルデータの全行を選択
 */
export function selectAllTableData() {
  toggleSelectAllTableData(true);
  // ヘッダーチェックボックスを更新
  const headerCheckbox = document.getElementById('tableDataHeaderCheckbox');
  if (headerCheckbox) headerCheckbox.checked = true;
}

/**
 * テーブルデータの全選択を解除
 */
export function clearAllTableData() {
  selectedTableDataRows = [];
  // ヘッダーチェックボックスを更新
  const headerCheckbox = document.getElementById('tableDataHeaderCheckbox');
  if (headerCheckbox) headerCheckbox.checked = false;
  
  // UIを更新
  if (selectedTableForPreview) {
    loadTableData(selectedTableForPreview);
  }
}

export function deleteSelectedTableData() {
  if (selectedTableDataRows.length === 0) {
    utilsShowToast('削除するデータを選択してください', 'warning');
    return;
  }
  
  const count = selectedTableDataRows.length;
  
  // 確認モーダルを表示
  window.UIComponents.showModal({
    title: 'レコード削除の確認',
    content: `選択された${count}件のレコードを削除しますか？\n\n※テーブル「${selectedTableForPreview}」から直接削除されます。\n※この操作は元に戻せません。`,
    confirmText: '削除',
    cancelText: 'キャンセル',
    variant: 'danger',
    onConfirm: async () => {
      try {
        utilsShowLoading('レコードを削除中...');
        
        // 選択された行の主キー値を抽出（rowIdから最後の部分を取得）
        const primaryKeyValues = selectedTableDataRows.map(rowId => {
          // rowId形式: "page_index_primaryValue"
          const parts = rowId.split('_');
          return parts.length >= 3 ? parts.slice(2).join('_') : parts[parts.length - 1];
        });
        
        // 汎用的な削除APIを呼び出す
        const response = await authApiCall(`/ai/api/database/tables/${encodeURIComponent(selectedTableForPreview)}/delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ primary_keys: primaryKeyValues })
        });
        
        utilsHideLoading();
        
        if (response.success) {
          utilsShowToast(`${response.deleted_count}件のレコードを削除しました`, 'success');
          // 選択をクリア
          selectedTableDataRows = [];
          // ページを1にリセット
          tableDataPage = 1;
          // テーブルデータを再読み込み
          loadTableData(selectedTableForPreview);
        } else {
          const errMsg = response.errors && response.errors.length > 0 
            ? response.errors.join(', ') 
            : response.message || '不明なエラー';
          utilsShowToast(`削除エラー: ${errMsg}`, 'error');
        }
      } catch (error) {
        utilsHideLoading();
        utilsShowToast(`削除エラー: ${error.message}`, 'error');
      }
    }
  });
}

/**
 * テーブルデータの行選択を切り替え
 * @param {string} rowId - 行ID
 */
export function toggleTableDataRowSelection(rowId) {
  // HTMLエスケープされた値をデコード
  const decodedRowId = rowId.replace(/&#39;/g, "'").replace(/&quot;/g, '"');
  
  // スクロール位置を保存
  const scrollableArea = document.querySelector('#tableDataPreview .table-wrapper-scrollable');
  const scrollTop = scrollableArea ? scrollableArea.scrollTop : 0;
  
  // 文字列に統一
  const rowIdStr = String(decodedRowId);
  const index = selectedTableDataRows.indexOf(rowIdStr);
  if (index > -1) {
    selectedTableDataRows.splice(index, 1);
  } else {
    selectedTableDataRows.push(rowIdStr);
  }
  
  // UIを更新
  if (selectedTableForPreview) {
    loadTableData(selectedTableForPreview).then(() => {
      // スクロール位置を復元
      const scrollableAreaAfter = document.querySelector('#tableDataPreview .table-wrapper-scrollable');
      if (scrollableAreaAfter) {
        requestAnimationFrame(() => {
          scrollableAreaAfter.scrollTop = scrollTop;
        });
      }
    });
  }
}

export function toggleSelectAllTableData(checked) {
  // スクロール位置を保存
  const scrollableArea = document.querySelector('#tableDataPreview .table-wrapper-scrollable');
  const scrollTop = scrollableArea ? scrollableArea.scrollTop : 0;
  
  if (checked) {
    // 現在ページのすべてを選択に追加
    currentPageTableDataRows.forEach(rowId => {
      if (!selectedTableDataRows.includes(rowId)) {
        selectedTableDataRows.push(rowId);
      }
    });
  } else {
    // 現在ページのすべてを選択から除外
    currentPageTableDataRows.forEach(rowId => {
      const index = selectedTableDataRows.indexOf(rowId);
      if (index > -1) {
        selectedTableDataRows.splice(index, 1);
      }
    });
  }
  
  // UIを更新
  if (selectedTableForPreview) {
    loadTableData(selectedTableForPreview).then(() => {
      // スクロール位置を復元
      const scrollableAreaAfter = document.querySelector('#tableDataPreview .table-wrapper-scrollable');
      if (scrollableAreaAfter) {
        requestAnimationFrame(() => {
          scrollableAreaAfter.scrollTop = scrollTop;
        });
      }
    });
  }
}

// // グローバルスコープに公開（HTMLインラインイベントハンドラから呼び出せるように）
// window.toggleTableDataRowSelection = toggleTableDataRowSelection;
// window.toggleSelectAllTableData = toggleSelectAllTableData;
// window.selectAllTableData = selectAllTableData;
// window.clearAllTableData = clearAllTableData;
// window.deleteSelectedTableData = deleteSelectedTableData;
// window.refreshTableData = refreshTableData;
// window.handleTableDataPrevPage = handleTableDataPrevPage;
// window.handleTableDataNextPage = handleTableDataNextPage;
// window.handleTableDataJumpPage = handleTableDataJumpPage;

export function handleDbTablesPrevPage() {
  const currentPage = appState.get('dbTablesPage') || 1;
  if (currentPage > 1) {
    appState.set('dbTablesPage', currentPage - 1);
    loadDbTables();
  }
}

/**
 * テーブル一覧の次のページへ
 */
export function handleDbTablesNextPage() {
  const currentPage = appState.get('dbTablesPage') || 1;
  if (currentPage < dbTablesTotalPages) {
    appState.set('dbTablesPage', currentPage + 1);
    loadDbTables();
  }
}

/**
 * 指定ページへジャンプ（テーブル一覧）
 */
export function handleDbTablesJumpPage() {
  const input = document.getElementById('dbTablesPageInput');
  if (!input) {
    utilsShowToast('ページ入力エラー', 'error');
    return;
  }
  
  const page = parseInt(input.value, 10);
  const currentPage = appState.get('dbTablesPage') || 1;
  
  // NaNチェックを追加
  if (isNaN(page)) {
    utilsShowToast('有効な数値を入力してください', 'error');
    input.value = currentPage;
    return;
  }
  
  if (page >= 1 && page <= dbTablesTotalPages) {
    appState.set('dbTablesPage', page);
    loadDbTables();
  } else {
    utilsShowToast('無効なページ番号です', 'error');
    input.value = currentPage;
  }
}

/**
 * テーブル一覧の行選択を切り替え
 * @param {string} tableName - テーブル名
 */
export function toggleDbTableSelection(tableName) {
  // スクロール位置を保存
  const scrollableArea = document.querySelector('#dbTablesContent .table-wrapper-scrollable');
  const scrollTop = scrollableArea ? scrollableArea.scrollTop : 0;
  
  const index = selectedDbTables.indexOf(tableName);
  if (index > -1) {
    selectedDbTables.splice(index, 1);
  } else {
    selectedDbTables.push(tableName);
  }
  
  // UIを更新
  loadDbTables().then(() => {
    // スクロール位置を復元
    const scrollableAreaAfter = document.querySelector('#dbTablesContent .table-wrapper-scrollable');
    if (scrollableAreaAfter) {
      requestAnimationFrame(() => {
        scrollableAreaAfter.scrollTop = scrollTop;
      });
    }
  });
}

export function toggleSelectAllDbTables(checked) {
  // スクロール位置を保存
  const scrollableArea = document.querySelector('#dbTablesContent .table-wrapper-scrollable');
  const scrollTop = scrollableArea ? scrollableArea.scrollTop : 0;
  
  if (checked) {
    // 現在ページのすべてを選択に追加
    currentPageDbTables.forEach(tableName => {
      if (!selectedDbTables.includes(tableName)) {
        selectedDbTables.push(tableName);
      }
    });
  } else {
    // 現在ページのすべてを選択から除外
    currentPageDbTables.forEach(tableName => {
      const index = selectedDbTables.indexOf(tableName);
      if (index > -1) {
        selectedDbTables.splice(index, 1);
      }
    });
  }
  
  // UIを更新
  loadDbTables().then(() => {
    // スクロール位置を復元
    const scrollableAreaAfter = document.querySelector('#dbTablesContent .table-wrapper-scrollable');
    if (scrollableAreaAfter) {
      requestAnimationFrame(() => {
        scrollableAreaAfter.scrollTop = scrollTop;
      });
    }
  });
}

/**
 * テーブル一覧を全選択
 */
export function selectAllDbTables() {
  toggleSelectAllDbTables(true);
  // ヘッダーチェックボックスを更新
  const headerCheckbox = document.getElementById('dbTablesHeaderCheckbox');
  if (headerCheckbox) headerCheckbox.checked = true;
}

export function clearAllDbTables() {
  // スクロール位置を保存
  const scrollableArea = document.querySelector('#dbTablesContent .table-wrapper-scrollable');
  const scrollTop = scrollableArea ? scrollableArea.scrollTop : 0;
  
  selectedDbTables = [];
  // ヘッダーチェックボックスを更新
  const headerCheckbox = document.getElementById('dbTablesHeaderCheckbox');
  if (headerCheckbox) headerCheckbox.checked = false;
  
  // UIを更新
  loadDbTables().then(() => {
    // スクロール位置を復元
    const scrollableAreaAfter = document.querySelector('#dbTablesContent .table-wrapper-scrollable');
    if (scrollableAreaAfter) {
      requestAnimationFrame(() => {
        scrollableAreaAfter.scrollTop = scrollTop;
      });
    }
  });
}

export async function deleteSelectedDbTables() {
  if (selectedDbTables.length === 0) {
    utilsShowToast('削除するテーブルを選択してください', 'warning');
    return;
  }
  
  const count = selectedDbTables.length;
  const confirmed = await showConfirmModal(
    `選択された${count}件のテーブルを削除しますか？\n\nこの操作は元に戻せません。`,
    'テーブル削除の確認',
    { variant: 'danger', confirmText: '削除' }
  );
  
  if (!confirmed) {
    return;
  }
  
  // 処理中表示を設定
  dbTablesBatchDeleteLoading = true;
  loadDbTables();
  
  try {
    // 一括削除APIを呼び出す
    const response = await authApiCall('/ai/api/database/tables/batch-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ table_names: selectedDbTables })
    });
    
    if (response.success) {
      utilsShowToast(`${count}件のテーブルを削除しました`, 'success');
      // 選択をクリア
      selectedDbTables = [];
      // ページを1にリセット
      appState.set('dbTablesPage', 1);
    } else {
      utilsShowToast(`削除エラー: ${response.message || '不明なエラー'}`, 'error');
    }
  } catch (error) {
    utilsShowToast(`削除エラー: ${error.message}`, 'error');
  } finally {
    // 処理中表示を解除
    dbTablesBatchDeleteLoading = false;
    // テーブル一覧を再読み込み
    loadDbTables();
  }
}

/**
 * データベース情報を再取得
 */
export async function refreshDbInfo() {
  try {
    utilsShowLoading('データベース情報を再取得中...');
    await loadDbInfo();
    utilsHideLoading();
  } catch (error) {
    utilsHideLoading();
    utilsShowToast(`再取得エラー: ${error.message}`, 'error');
  }
}
