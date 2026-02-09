
// ========================================
// AI Assistant機能
// ========================================

// 必要な依存関係のインポート
import { appState } from '../state.js';
import { showToast as utilsShowToast, showConfirmModal as utilsShowConfirmModal } from './utils.js';

// グローバル関数として登録（既存コードとの互換性維持）
window.toggleCopilot = toggleCopilot;
window.toggleCopilotExpand = toggleCopilotExpand;
window.sendCopilotMessage = sendCopilotMessage;
window.renderCopilotMessages = renderCopilotMessages;
window.openCopilotImage = openCopilotImage;
window.clearCopilotHistory = clearCopilotHistory;
window.handleCopilotKeydown = handleCopilotKeydown;
window.startNewConversation = startNewConversation;
window.addCopilotImagesFromFiles = addCopilotImagesFromFiles;
window.handleCopilotPaste = handleCopilotPaste;
window.renderCopilotImagesPreview = renderCopilotImagesPreview;
window.removeCopilotImageAt = removeCopilotImageAt;
window.clearCopilotImages = clearCopilotImages;
window.showImageModal = showImageModal;

// モジュールエクスポート
export {
  toggleCopilot,
  toggleCopilotExpand,
  sendCopilotMessage,
  renderCopilotMessages,
  openCopilotImage,
  clearCopilotHistory,
  handleCopilotKeydown,
  startNewConversation,
  addCopilotImagesFromFiles,
  handleCopilotPaste,
  renderCopilotImagesPreview,
  removeCopilotImageAt,
  clearCopilotImages,
  showImageModal
};

/**
 * AI Assistantパネルの表示/非表示を切り替え
 */
function toggleCopilot() {
  appState.set('copilotOpen', !appState.get('copilotOpen'));
  const panel = document.getElementById('copilotPanel');
  const btn = document.getElementById('copilotToggleBtn');
  
  if (appState.get('copilotOpen')) {
    panel.style.display = 'flex';
    btn.style.display = 'none';
  } else {
    panel.style.display = 'none';
    btn.style.display = 'flex';
  }
}

/**
 * AI Assistantパネルの最大化/最小化
 */
function toggleCopilotExpand() {
  appState.set('copilotExpanded', !appState.get('copilotExpanded'));
  const panel = document.getElementById('copilotPanel');
  const icon = document.getElementById('copilotExpandIcon');
  
  if (appState.get('copilotExpanded')) {
    panel.classList.add('expanded');
    // 縮小アイコン
    icon.className = 'fas fa-chevron-left w-4 h-4';
  } else {
    panel.classList.remove('expanded');
    // 展開アイコン
    icon.className = 'fas fa-chevron-right w-4 h-4';
  }
}

/**
 * AI Assistantメッセージを送信
 */
async function sendCopilotMessage() {
  const input = document.getElementById('copilotInput');
  const message = input.value.trim();
  
  if ((!message && appState.get('copilotImages').length === 0) || appState.get('copilotLoading')) return;
  
  // 入力欄と画像を即座にクリア
  input.value = '';
  const currentImages = [...appState.get('copilotImages')];
  appState.set('copilotImages', []);
  renderCopilotImagesPreview();
  
  // ユーザーメッセージを追加
  const currentMessages = appState.get('copilotMessages');
  currentMessages.push({
    role: 'user',
    content: message,
    images: currentImages.length > 0 ? currentImages : null
  });
  appState.set('copilotMessages', currentMessages);
  
  renderCopilotMessages();
  
  // アシスタントメッセージのプレースホルダーに「考え中...」を表示
  const updatedMessages = appState.get('copilotMessages');
  updatedMessages.push({
    role: 'assistant',
    content: '考え中...'
  });
  appState.set('copilotMessages', updatedMessages);
  
  appState.set('copilotLoading', true);
  renderCopilotMessages();
  
  try {
    // API呼び出しでストリーミング受信
    // トークンを確認（localStorageから直接取得 - referenceプロジェクトに準拠）
    const loginToken = localStorage.getItem('loginToken');
    const response = await fetch('/ai/api/copilot/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(loginToken ? { 'Authorization': `Bearer ${loginToken}` } : {})
      },
      body: JSON.stringify({
        message: message,
        context: null,
        history: appState.get('copilotMessages').slice(0, -1),
        images: currentImages.length > 0 ? currentImages : null
      })
    });
    
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
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let isFirstChunk = true;
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.substring(6));
            if (data.done) {
              appState.set('copilotLoading', false);
              renderCopilotMessages();
            } else if (data.content) {
              // 最初のチャンクの場合、「考え中...」を置き換える
              if (isFirstChunk) {
                const messages = appState.get('copilotMessages');
                messages[messages.length - 1].content = data.content;
                appState.set('copilotMessages', messages);
                isFirstChunk = false;
              } else {
                const messages = appState.get('copilotMessages');
                messages[messages.length - 1].content += data.content;
                appState.set('copilotMessages', messages);
              }
              renderCopilotMessages();
            }
          } catch (e) {
            console.error('JSON parse error:', e);
          }
        }
      }
    }
  } catch (error) {
    console.error('AI Assistantエラー:', error);
    const messages = appState.get('copilotMessages');
    messages[messages.length - 1].content = `エラー: ${error.message}`;
    appState.set('copilotMessages', messages);
    appState.set('copilotLoading', false);
    renderCopilotMessages();
    utilsShowToast('AI Assistantの応答に失敗しました', 'error');
  }
}

/**
 * AI Assistantメッセージをレンダリング
 */
function renderCopilotMessages() {
  const messagesDiv = document.getElementById('copilotMessages');
  
  if (appState.get('copilotMessages').length === 0) {
    messagesDiv.innerHTML = `
      <div class="text-center text-gray-500 py-8">
        <p class="text-sm">何でもお聞きください！</p>
      </div>
    `;
    return;
  }
  
  // 画像データをグローバルに保存（イベントハンドラからアクセスするため）
  window._copilotImageData = {};
  
  messagesDiv.innerHTML = appState.get('copilotMessages').map((msg, msgIdx) => {
    const isUser = msg.role === 'user';
    const content = isUser ? msg.content : renderMarkdown(msg.content);
    const imagesHtml = isUser && msg.images && msg.images.length > 0 ? `
      <div style="display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap;">
        ${msg.images.map((img, imgIdx) => {
          const imageKey = `img_${msgIdx}_${imgIdx}`;
          // 画像データをグローバルに保存
          window._copilotImageData[imageKey] = {
            data_url: img.data_url,
            filename: img.filename || ''
          };
          return `
            <div 
              style="position: relative; cursor: pointer;"
              onclick="openCopilotImage('${imageKey}')"
            >
              <img 
                src="${img.data_url}" 
                style="max-width: 120px; max-height: 120px; border-radius: 8px; border: 2px solid #e2e8f0; object-fit: contain; transition: all 0.2s;" 
                onmouseover="this.style.borderColor='#1a365d'; this.style.transform='scale(1.05)';" 
                onmouseout="this.style.borderColor='#e2e8f0'; this.style.transform='scale(1)';" 
              />
              ${img.filename ? `<div style="position: absolute; bottom: 0; left: 0; right: 0; background: rgba(0,0,0,0.6); color: white; font-size: 10px; padding: 2px 4px; border-radius: 0 0 6px 6px; text-overflow: ellipsis; overflow: hidden; white-space: nowrap;">${img.filename}</div>` : ''}
            </div>
          `;
        }).join('')}
      </div>
    ` : '';
    
    return `
      <div class="copilot-message ${isUser ? 'user' : 'assistant'}">
        ${content}
        ${imagesHtml}
      </div>
    `;
  }).join('');
  
  // スクロールを一番下へ
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

/**
 * AI Assistantの画像をモーダルで開く
 */
function openCopilotImage(imageKey) {
  const imageData = window._copilotImageData && window._copilotImageData[imageKey];
  if (imageData) {
    showImageModal(imageData.data_url, imageData.filename);
  }
}

/**
 * 簡易的なMarkdownレンダリング
 */
function renderMarkdown(text) {
  if (!text) return '';
  
  // コードブロック
  text = text.replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  
  // インラインコード
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  
  // 太字
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  
  // リスト
  text = text.replace(/^- (.+)$/gm, '<li>$1</li>');
  text = text.replace(/(<li>.*<\/li>)/s, '<ul>$1</ul>');
  
  // 改行
  text = text.replace(/\n/g, '<br>');
  
  return text;
}

/**
 * AI Assistant履歴をクリア
 */
function clearCopilotHistory() {
  appState.set('copilotMessages', []);
  renderCopilotMessages();
  utilsShowToast('会話履歴をクリアしました', 'success');
}

/**
 * AI Assistant入力欄のEnterキー処理
 * Enter: 送信
 * Shift+Enter: 改行
 */
function handleCopilotKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    sendCopilotMessage();
  }
}

/**
 * 新しい会話を開始
 */
async function startNewConversation() {
  if (copilotMessages.length > 0) {
    const confirmed = await utilsShowConfirmModal(
      'AI Assistantの会話をリセットしますか？',
      '新しい会話の確認',
      { variant: 'info' }
    );
    if (confirmed) {
      appState.set('copilotMessages', []);
      appState.set('copilotImages', []);
      renderCopilotMessages();
      utilsShowToast('新しい会話を開始しました', 'success');
    }
  }
}

/**
 * 画像をファイルから追加
 */
function addCopilotImagesFromFiles(files) {
  if (!files || files.length === 0) return;
  
  const MAX_IMAGES = 5;
  
  // 既存の画像数を確認
  if (appState.get('copilotImages').length >= MAX_IMAGES) {
    utilsShowToast(`画像は最大${MAX_IMAGES}枚までアップロードできます`, 'warning');
    return;
  }
  
  // 追加可能な枚数を計算
  const remainingSlots = MAX_IMAGES - appState.get('copilotImages').length;
  const filesToAdd = Array.from(files).filter(f => f.type.startsWith('image/')).slice(0, remainingSlots);
  
  if (filesToAdd.length < files.length) {
    utilsShowToast(`画像は最大${MAX_IMAGES}枚までです。${filesToAdd.length}枚を追加します`, 'warning');
  }
  
  filesToAdd.forEach(file => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const currentImages = appState.get('copilotImages');
      currentImages.push({
        data_url: e.target.result,
        filename: file.name
      });
      appState.set('copilotImages', currentImages);
      renderCopilotImagesPreview();
    };
    reader.readAsDataURL(file);
  });
}

/**
 * クリップボードから画像を追加
 * @param {ClipboardEvent} event - 貼り付けイベント
 */
function handleCopilotPaste(event) {
  const items = event.clipboardData?.items;
  if (!items) return;
  
  const imageItems = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].type.startsWith('image/')) {
      imageItems.push(items[i]);
    }
  }
  
  if (imageItems.length === 0) return;
  
  // デフォルトの貼り付け動作を防止
  event.preventDefault();
  
  const MAX_IMAGES = 5;
  
  // 既存の画像数を確認
  if (appState.get('copilotImages').length >= MAX_IMAGES) {
    utilsShowToast(`画像は最大${MAX_IMAGES}枚までアップロードできます`, 'warning');
    return;
  }
  
  // 追加可能な枚数を計算
  const remainingSlots = MAX_IMAGES - appState.get('copilotImages').length;
  const itemsToAdd = imageItems.slice(0, remainingSlots);
  
  if (itemsToAdd.length < imageItems.length) {
    utilsShowToast(`画像は最大${MAX_IMAGES}枚までです。${itemsToAdd.length}枚を追加します`, 'warning');
  }
  
  itemsToAdd.forEach(item => {
    const file = item.getAsFile();
    if (file) {
      const reader = new FileReader();
      reader.onload = (e) => {
        const currentImages = appState.get('copilotImages');
        currentImages.push({
          data_url: e.target.result,
          filename: file.name || `貼り付け画像_${Date.now()}.png`
        });
        appState.set('copilotImages', currentImages);
        renderCopilotImagesPreview();
      };
      reader.readAsDataURL(file);
    }
  });
}

/**
 * 画像プレビューをレンダリング
 */
function renderCopilotImagesPreview() {
  const preview = document.getElementById('copilotImagesPreview');
  if (!preview) return;
  
  if (appState.get('copilotImages').length === 0) {
    preview.innerHTML = '';
    return;
  }
  
  preview.innerHTML = `
    <div style="display: flex; gap: 10px; align-items: center; overflow-x: auto; padding: 10px 2px 0 2px;">
      ${appState.get('copilotImages').map((img, i) => `
        <div style="position: relative; width: 56px; height: 56px; border-radius: 8px; overflow: hidden; border: 1px solid #e2e8f0; flex: 0 0 auto; background: #f8fafc;">
          <img src="${img.data_url}" style="width: 100%; height: 100%; object-fit: cover;" />
          <button type="button" onclick="removeCopilotImageAt(${i})" style="position: absolute; top: 4px; right: 4px; width: 18px; height: 18px; border-radius: 9px; border: 0; background: rgba(15, 23, 42, 0.65); color: white; font-size: 12px; line-height: 18px; cursor: pointer;"><i class="fas fa-times"></i></button>
        </div>
      `).join('')}
      <button type="button" onclick="clearCopilotImages()" class="apex-button-secondary px-3 py-1.5 text-xs"><i class="fas fa-broom"></i> 画像クリア</button>
    </div>
  `;
}

/**
 * 画像を削除
 */
function removeCopilotImageAt(index) {
  const currentImages = appState.get('copilotImages');
  currentImages.splice(index, 1);
  appState.set('copilotImages', currentImages);
  renderCopilotImagesPreview();
}

/**
 * 全画像をクリア
 */
function clearCopilotImages() {
  appState.set('copilotImages', []);
  renderCopilotImagesPreview();
}

/**
 * 画像モーダルを表示
 */
window._imageModalEscapeHandler = null;

function showImageModal(imageUrl, filename = '') {
  // 既存のモーダルがあれば先に適切にクリーンアップ
  const existingModal = document.getElementById('imageModal');
  if (existingModal) {
    // 既存のイベントリスナーをクリーンアップ
    if (window._imageModalEscapeHandler) {
      document.removeEventListener('keydown', window._imageModalEscapeHandler);
      window._imageModalEscapeHandler = null;
    }
    existingModal.remove();
  }
  
  // 既存のESCハンドラーを削除
  if (window._imageModalEscapeHandler) {
    document.removeEventListener('keydown', window._imageModalEscapeHandler);
    window._imageModalEscapeHandler = null;
  }
  
  // モーダルを作成
  const modal = document.createElement('div');
  modal.id = 'imageModal';
  modal.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    background: rgba(0, 0, 0, 0.9);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10000;
    cursor: pointer;
  `;
  
  modal.innerHTML = `
    <div style="position: relative; max-width: 90vw; max-height: 90vh; display: flex; flex-direction: column; align-items: center; cursor: default;">
      <div style="position: absolute; top: -40px; right: 0; display: flex; gap: 10px; align-items: center;">
        ${filename ? `<span style="color: white; font-size: 14px; background: rgba(255,255,255,0.1); padding: 6px 12px; border-radius: 6px;">${filename}</span>` : ''}
        <button 
          id="imageModalCloseBtn"
          style="background: rgba(255, 255, 255, 0.2); border: none; color: white; width: 36px; height: 36px; border-radius: 50%; cursor: pointer; font-size: 20px; display: flex; align-items: center; justify-content: center; transition: all 0.2s;"
        >×</button>
      </div>
      <img 
        src="${imageUrl}" 
        style="max-width: 100%; max-height: 90vh; border-radius: 8px; box-shadow: 0 10px 40px rgba(0,0,0,0.5); object-fit: contain;"
      />
    </div>
  `;
  
  document.body.appendChild(modal);
  
  // 閉じるボタンのイベント設定
  const closeBtn = document.getElementById('imageModalCloseBtn');
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    searchCloseImageModal();
  });
  closeBtn.addEventListener('mouseover', function() {
    this.style.background = 'rgba(255, 255, 255, 0.3)';
    this.style.transform = 'scale(1.1)';
  });
  closeBtn.addEventListener('mouseout', function() {
    this.style.background = 'rgba(255, 255, 255, 0.2)';
    this.style.transform = 'scale(1)';
  });
  
  // 内側コンテンツのクリック伝播を停止
  const innerContent = modal.querySelector('div');
  innerContent.addEventListener('click', (e) => {
    e.stopPropagation();
  });
  
  // 背景クリックで閉じる（1回だけ実行）
  modal.addEventListener('click', () => {
    searchCloseImageModal();
  }, { once: true });
  
  // ESCキーで閉じる
  window._imageModalEscapeHandler = (e) => {
    if (e.key === 'Escape') {
      searchCloseImageModal();
    }
  };
  document.addEventListener('keydown', window._imageModalEscapeHandler);
}

// AI Assistantテキストエリアにペーストイベントリスナーを追加
const copilotInput = document.getElementById('copilotInput');
if (copilotInput) {
  copilotInput.addEventListener('paste', handleCopilotPaste);
}