import { invalidateDynamicSearchFilters } from './search.js';
import { apiCall as authApiCall } from './auth.js';
import {
  hideLoading as utilsHideLoading,
  showConfirmModal as utilsShowConfirmModal,
  showLoading as utilsShowLoading,
  showToast as utilsShowToast
} from './utils.js';

const API = '/ai/api/settings/retrieval';

let settings = null;
let activeSlot = 1;
let statusTimer;

export function invalidateRetrievalSettings() {
  settings = null;
  clearTimeout(statusTimer);
}

const escapeHtml = value => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

async function api(path = '', options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  return authApiCall(`${API}${path}`, { ...options, headers });
}

function checkbox(id, label, checked) {
  return `<label class="retrieval-check" for="${id}"><input id="${id}" type="checkbox" ${checked ? 'checked' : ''}><span>${escapeHtml(label)}</span></label>`;
}

function radio(name, id, label, value, checked) {
  return `<label class="retrieval-check" for="${id}"><input id="${id}" name="${name}" type="radio" value="${escapeHtml(value)}" ${checked ? 'checked' : ''}><span>${escapeHtml(label)}</span></label>`;
}

function synonymGroupsToText(groups = []) {
  return groups.map(group => group.join(', ')).join('\n');
}

function queryExpansionMode(value) {
  if (!value?.enabled) return 'off';
  return value.llm_enabled ? 'llm' : 'rule';
}

function synonymTextToGroups(text = '') {
  return text.split(/\r?\n/)
    .map(line => line.split(/[、,]/).map(term => term.trim()).filter(Boolean))
    .filter(group => group.length > 1);
}

function currentProfile() {
  return settings.profiles.find(profile => profile.slot_no === activeSlot);
}

function collectProfile() {
  const previous = currentProfile();
  const extractionPrompt = document.getElementById('profile-prompt')?.value.trim() ?? previous.extraction_prompt;
  return {
    ...previous,
    enabled: document.getElementById('profile-enabled')?.checked ?? previous.enabled,
    extraction_prompt: extractionPrompt
  };
}

function renderProfilePanel() {
  const panel = document.getElementById('retrievalProfilePanel');
  if (!panel) return;
  const profile = currentProfile();
  panel.innerHTML = `
    <div class="retrieval-profile-form">
      ${checkbox('profile-enabled', 'このプロファイルを使用する', profile.enabled)}
      <div class="form-group">
        <label class="form-label" for="profile-prompt">抽出したい内容</label>
        <textarea id="profile-prompt" class="form-input retrieval-prompt" maxlength="40000" aria-describedby="profile-prompt-help">${escapeHtml(profile.extraction_prompt)}</textarea>
        <p id="profile-prompt-help" class="retrieval-help">画像やページから、検索に利用したい情報を自然な文章で指示してください。テンプレート記法やJSON Schemaは不要です。</p>
      </div>
      <details class="retrieval-test-details">
        <summary>テスト用の画像（任意）</summary>
        <div class="retrieval-test-grid">
          <div class="form-group">
            <label class="form-label" for="profile-test-image">画像</label>
            <button type="button" class="w-full border-2 border-dashed border-gray-300 rounded-lg p-4 text-center hover:border-blue-800 transition cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
              onclick="document.getElementById('profile-test-image').click()"
              ondragover="handleDragOver(event)"
              ondragleave="handleDragLeave(event)"
              ondrop="handleDropForInput(event, 'profile-test-image')">
              <i class="fas fa-cloud-upload-alt text-gray-400" aria-hidden="true" style="font-size:32px;display:block;margin:0 auto 8px"></i>
              <span class="block text-sm font-medium text-gray-700 mb-1">画像をドラッグ＆ドロップまたはクリックして選択</span>
              <span id="profile-test-image-name" class="block text-xs text-gray-500" aria-live="polite">対応形式: PNG, JPG, WEBP</span>
            </button>
            <input id="profile-test-image" type="file" accept="image/png,image/jpeg,image/webp" class="hidden"
              onchange="document.getElementById('profile-test-image-name').textContent=this.files[0]?'選択済み: '+this.files[0].name:'対応形式: PNG, JPG, WEBP'">
          </div>
        </div>
      </details>
      <pre id="profile-test-result" class="retrieval-test-result" hidden></pre>
      <div class="retrieval-actions retrieval-primary-actions">
        <button type="button" class="apex-button px-4 py-2" data-action="apply-profile" ${settings.schema_ready ? '' : 'disabled'}><i class="fas fa-save"></i> 保存して反映</button>
        <button type="button" class="apex-button-secondary px-4 py-2" data-action="test-profile"><i class="fas fa-vial"></i> 抽出をテスト</button>
      </div>
      <div id="profile-inline-error" class="retrieval-inline-error" role="alert" tabindex="-1" hidden></div>
      <p class="retrieval-pending-summary">反映待ち文書: ${profile.pending_document_count || 0}件</p>
    </div>`;
}

function engineCard(key, title, value) {
  return `<section class="retrieval-service-card" data-ocr-engine="${key}">
    <h4>${escapeHtml(title)} ${checkbox(`ocr-${key}-enabled`, '使用する', value.enabled)}</h4>
    <div class="form-group"><label class="form-label" for="ocr-${key}-url">接続先URL</label><input id="ocr-${key}-url" class="form-input" value="${escapeHtml(value.base_url)}"></div>
    <div class="form-group"><label class="form-label" for="ocr-${key}-model">モデル</label><input id="ocr-${key}-model" class="form-input" value="${escapeHtml(value.model)}"></div>
    <div class="form-group"><label class="form-label" for="ocr-${key}-key">APIキー</label><input id="ocr-${key}-key" type="password" class="form-input" placeholder="${value.api_key ? '設定済み（空欄で保持）' : ''}"></div>
    <div class="retrieval-grid retrieval-grid-2"><div><label class="form-label" for="ocr-${key}-dpi">DPI</label><input id="ocr-${key}-dpi" type="number" min="72" max="600" class="form-input" value="${value.dpi}"></div><div><label class="form-label" for="ocr-${key}-workers">並列数</label><input id="ocr-${key}-workers" type="number" min="1" max="32" class="form-input" value="${value.workers}"></div></div>
    <div class="retrieval-actions"><button type="button" class="apex-button-secondary px-4 py-2" data-action="test-ocr" data-engine="${key}"><i class="fas fa-vial"></i> 接続テスト</button></div>
  </section>`;
}

function renderGlobalPanels() {
  const root = document.getElementById('retrievalGlobalPanels');
  const { mineru, ocr, vlm, weights } = settings;
  const queryExpansion = settings.query_expansion || { enabled: false, llm_enabled: false, max_variants: 3, synonym_groups: [] };
  const mode = queryExpansionMode(queryExpansion);
  root.innerHTML = `
    <details class="retrieval-global-section">
      <summary><span><i class="fas fa-file-alt"></i> 共通の文書解析</span><small>MinerU・OCR</small></summary>
      <div class="retrieval-global-content">
        <section class="retrieval-card">
          <h3>MinerU</h3>${checkbox('mineru-enabled', 'すべての文書で使用する', mineru.enabled)}
          <div class="retrieval-grid retrieval-grid-3"><div class="retrieval-span-2"><label class="form-label" for="mineru-url">接続先URL</label><input id="mineru-url" class="form-input" value="${escapeHtml(mineru.base_url)}"></div><div><label class="form-label" for="mineru-timeout">タイムアウト（秒）</label><input id="mineru-timeout" type="number" class="form-input" value="${mineru.timeout_seconds}"></div></div>
          <div class="retrieval-actions"><button type="button" class="apex-button px-4 py-2" data-action="save-mineru">保存</button><button type="button" class="apex-button-secondary px-4 py-2" data-action="test-mineru">接続テスト</button></div>
        </section>
        <section class="retrieval-card"><h3>OCR</h3>${checkbox('ocr-enabled', 'MinerUで内容を取得できないページで使用する', ocr.enabled)}<div class="retrieval-actions"><button type="button" class="apex-button px-4 py-2" data-action="save-ocr">OCR設定を保存</button></div><div class="retrieval-grid retrieval-grid-3">${engineCard('dots', 'Dots', ocr.dots)}${engineCard('glm', 'GLM', ocr.glm)}${engineCard('unlimited', 'Unlimited', ocr.unlimited)}</div></section>
      </div>
    </details>
    <details class="retrieval-global-section">
      <summary><span><i class="fas fa-search"></i> 共通の検索</span><small>Oracle Text・ベクトル</small></summary>
      <div class="retrieval-global-content">
        <section class="retrieval-card"><h3>検索バリエーション</h3>
          <div class="retrieval-actions">
            ${radio('query-expansion-mode', 'query-expansion-mode-off', '原文のみ', 'off', mode === 'off')}
            ${radio('query-expansion-mode', 'query-expansion-mode-rule', 'ルールベース', 'rule', mode === 'rule')}
            ${radio('query-expansion-mode', 'query-expansion-mode-llm', 'LLM', 'llm', mode === 'llm')}
          </div>
          <div class="retrieval-grid retrieval-grid-3">
            <div><label class="form-label" for="query-expansion-max">最大バリエーション数</label><input id="query-expansion-max" type="number" min="1" max="8" class="form-input" value="${queryExpansion.max_variants}"></div>
          </div>
          <label class="form-label" for="query-expansion-synonyms">ルールベース同義語</label>
          <textarea id="query-expansion-synonyms" class="form-input retrieval-prompt-small">${escapeHtml(synonymGroupsToText(queryExpansion.synonym_groups))}</textarea>
          <p class="retrieval-help">1行に1グループ、カンマ区切りで入力します。例: 浴室換気乾燥機, 浴乾, 換気乾燥機</p>
          <div class="retrieval-actions"><button type="button" class="apex-button px-4 py-2" data-action="save-query-expansion">保存</button></div>
        </section>
        <section class="retrieval-card"><h3>検索ルートの重み</h3><p class="retrieval-help">相対倍率です。合計1不要、0で無効。VLM抽出は有効Profile数で配分します。通常は変更不要です。</p>
          <div class="retrieval-weight-grid">${[
            ['oracle_text', 'キーワード検索'], ['text_vector', 'テキスト類似'],
            ['vlm_text', 'VLM抽出キーワード'], ['vlm_vector', 'VLM抽出類似'],
            ['visual_vector', '画像類似']
          ].map(([key, label]) => `<div><label class="form-label" for="weight-${key}">${label}</label><input id="weight-${key}" type="number" min="0" max="10" step="0.1" class="form-input" value="${weights[key]}"></div>`).join('')}</div>
          <div class="retrieval-actions"><button type="button" class="apex-button px-4 py-2" data-action="save-weights">重みを保存</button></div>
        </section>
      </div>
    </details>
    <details class="retrieval-global-section">
      <summary><span><i class="fas fa-brain"></i> VLMの共通処理（詳細設定）</span><small>問い合わせ整理・画像確認</small></summary>
      <div class="retrieval-global-content">
        <section class="retrieval-card">${checkbox('vlm-query-enabled', '問い合わせ整理を使用する', vlm.query_enabled)}<label class="form-label" for="vlm-query-prompt">問い合わせ整理の指示</label><textarea id="vlm-query-prompt" class="form-input retrieval-prompt-small">${escapeHtml(vlm.query_prompt)}</textarea></section>
        <section class="retrieval-card">${checkbox('vlm-verify-enabled', '画像確認を使用する', vlm.verify_enabled)}<label class="form-label" for="vlm-verify-prompt">画像確認の指示</label><textarea id="vlm-verify-prompt" class="form-input retrieval-prompt-small">${escapeHtml(vlm.verify_prompt)}</textarea></section>
        <div class="retrieval-actions"><button type="button" class="apex-button px-4 py-2" data-action="save-vlm">VLM共通設定を保存</button></div>
      </div>
    </details>`;
}

function renderRerankSettings() {
  const root = document.getElementById('rerankSettingsRoot');
  if (!root || !settings) return;
  const { rerank } = settings;
  root.innerHTML = `<section class="apex-region">
    <div class="apex-region-header"><span><i class="fas fa-sort-amount-down"></i> OCIテキスト再ランキング</span></div>
    <div class="retrieval-panel">${checkbox('rerank-enabled', '使用する', rerank.enabled)}
      <div class="retrieval-grid retrieval-grid-3"><div><label class="form-label" for="rerank-model">モデル</label><input id="rerank-model" class="form-input" value="${escapeHtml(rerank.model)}"></div><div><label class="form-label" for="rerank-candidates">候補数</label><input id="rerank-candidates" type="number" min="1" max="500" class="form-input" value="${rerank.candidate_count}"></div><div><label class="form-label" for="rerank-topn">採用件数</label><input id="rerank-topn" type="number" min="1" max="100" class="form-input" value="${rerank.top_n}"></div></div>
      <p class="retrieval-help">候補を100件ずつ再ランキングし、中間上位100件から最終${rerank.top_n}件の画像・ページ証拠を選び、文書単位にまとめます。画像だけの検索では呼び出しません。</p>
      <div class="retrieval-actions"><button type="button" class="apex-button px-4 py-2" data-action="save-rerank">保存</button><button type="button" class="apex-button-secondary px-4 py-2" data-action="test-rerank">接続テスト</button></div>
    </div>
  </section>`;
  bindEvents(root);
}

function render() {
  const root = document.getElementById('retrievalSettingsRoot');
  root.innerHTML = `
    <div class="apex-region retrieval-profile-region">
      <div class="retrieval-profile-tabs" role="tablist" aria-label="VLM抽出プロファイル">${settings.profiles.map(profile => `<button id="profile-tab-${profile.slot_no}" type="button" role="tab" aria-selected="${profile.slot_no === activeSlot}" aria-controls="retrievalProfilePanel" tabindex="${profile.slot_no === activeSlot ? '0' : '-1'}" data-slot="${profile.slot_no}" class="${profile.slot_no === activeSlot ? 'active' : ''}"><span class="retrieval-status-icon ${profile.enabled ? 'ready' : 'disabled'}" aria-hidden="true"></span><span>プロファイル ${profile.slot_no}</span></button>`).join('')}</div>
      <div id="retrievalProfilePanel" class="retrieval-panel" role="tabpanel" aria-labelledby="profile-tab-${activeSlot}"></div>
    </div>
    <div id="retrievalGlobalPanels" class="retrieval-global-stack"></div>`;
  bindEvents(root);
  renderProfilePanel();
  renderGlobalPanels();
}

function collectEngine(key) {
  const secret = document.getElementById(`ocr-${key}-key`).value;
  return {
    enabled: document.getElementById(`ocr-${key}-enabled`).checked,
    base_url: document.getElementById(`ocr-${key}-url`).value.trim(),
    model: document.getElementById(`ocr-${key}-model`).value.trim(),
    api_key: secret || settings.ocr[key].api_key,
    dpi: Number(document.getElementById(`ocr-${key}-dpi`).value),
    workers: Number(document.getElementById(`ocr-${key}-workers`).value)
  };
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve(null);
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function inlineError(button, message = '') {
  const actions = button.closest('.retrieval-actions');
  let node = actions?.nextElementSibling;
  if (!node?.classList.contains('retrieval-inline-error')) {
    if (!message || !actions) return;
    node = document.createElement('div');
    node.className = 'retrieval-inline-error';
    node.setAttribute('role', 'alert');
    node.tabIndex = -1;
    actions.insertAdjacentElement('afterend', node);
  }
  node.textContent = message;
  node.hidden = !message;
  if (message) node.focus();
}

function scheduleStatusRefresh() {
  clearTimeout(statusTimer);
  if (!settings.profiles.some(profile => ['PENDING', 'PROCESSING'].includes(profile.apply_status))) return;
  statusTimer = setTimeout(async () => {
    try {
      // ponytail: ポーリングはステータス表示のみ更新。全再描画すると開いた<details>や編集中の入力が消える
      const latest = await api();
      settings.profiles = settings.profiles.map(profile => {
        const fresh = latest.profiles.find(item => item.slot_no === profile.slot_no);
        return fresh ? { ...profile, apply_status: fresh.apply_status, pending_document_count: fresh.pending_document_count } : profile;
      });
      const summary = document.querySelector('.retrieval-pending-summary');
      if (summary) summary.textContent = `反映待ち文書: ${currentProfile().pending_document_count || 0}件`;
      scheduleStatusRefresh();
    } catch { /* keep the last visible status */ }
  }, 5000);
}

function bindEvents(root) {
  root.onclick = async event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.slot) {
      const y = window.scrollY;
      settings.profiles = settings.profiles.map(profile => profile.slot_no === activeSlot ? collectProfile() : profile);
      activeSlot = Number(button.dataset.slot);
      render();
      requestAnimationFrame(() => { window.scrollTo(0, y); document.getElementById(`profile-tab-${activeSlot}`)?.focus(); });
      return;
    }
    const action = button.dataset.action;
    if (!action) return;
    if (action === 'test-profile' && !document.getElementById('profile-test-image').files[0]) {
      utilsShowToast('テスト用の画像を選択してください', 'warning');
      return;
    }
    let original = button.innerHTML;
    try {
      inlineError(button);
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      utilsShowLoading(action.includes('test') ? '接続または抽出を確認中...\n（最大120秒かかる場合があります）' : '設定を保存中...');
      if (action === 'test-profile') {
        const profile = collectProfile();
        if (!profile.name || !profile.extraction_prompt) throw new Error('名前と抽出したい内容を入力してください');
        const image = document.getElementById('profile-test-image').files[0];
        const result = await api(`/profiles/${activeSlot}/test`, { method: 'POST', timeout: 120000, body: JSON.stringify({ extraction_prompt: profile.extraction_prompt, image_base64: await fileToBase64(image) }) });
        const output = document.getElementById('profile-test-result');
        output.textContent = JSON.stringify(result.result, null, 2);
        output.hidden = false;
        utilsShowToast('抽出テストが完了しました', 'success');
      } else if (action === 'apply-profile') {
        const profile = collectProfile();
        const preview = await api(`/profiles/${activeSlot}/preview`, { method: 'POST', body: JSON.stringify(profile) });
        utilsHideLoading();
        const confirmed = await utilsShowConfirmModal(`設定を保存し、${preview.affected_documents}件の文書を反映対象にします。\n推定VLM呼び出し: ${preview.estimated_vlm_calls}回`, 'VLM抽出設定を反映', { variant: 'warning', confirmText: '保存して反映', cancelText: 'キャンセル' });
        if (!confirmed) return;
        utilsShowLoading('設定を保存して反映を開始中...');
        const result = await api(`/profiles/${activeSlot}/apply`, { method: 'POST', body: JSON.stringify(profile) });
        settings.profiles = settings.profiles.map(item => item.slot_no === activeSlot ? result.profile : item);
        invalidateDynamicSearchFilters();
        render();
        scheduleStatusRefresh();
        utilsShowToast(`${result.queued_documents}件の文書でVLM抽出の反映を開始しました`, 'success');
      } else if (action === 'save-mineru') {
        settings.mineru = await api('/mineru', { method: 'PUT', body: JSON.stringify({ enabled: document.getElementById('mineru-enabled').checked, base_url: document.getElementById('mineru-url').value.trim(), timeout_seconds: Number(document.getElementById('mineru-timeout').value), backend: 'pipeline', effort: 'medium' }) }); utilsShowToast('MinerU設定を保存しました', 'success');
      } else if (action === 'test-mineru') {
        await api('/mineru/test', { method: 'POST', timeout: 120000 }); utilsShowToast('MinerU接続に成功しました', 'success');
      } else if (action === 'save-ocr') {
        settings.ocr = await api('/ocr', { method: 'PUT', body: JSON.stringify({ enabled: document.getElementById('ocr-enabled').checked, dots: collectEngine('dots'), glm: collectEngine('glm'), unlimited: collectEngine('unlimited') }) }); utilsShowToast('OCR設定を保存しました', 'success');
      } else if (action === 'test-ocr') {
        await api(`/ocr/test/${button.dataset.engine}`, { method: 'POST', timeout: 120000 }); utilsShowToast(`${button.dataset.engine} OCR接続に成功しました`, 'success');
      } else if (action === 'save-rerank') {
        settings.rerank = await api('/rerank', { method: 'PUT', body: JSON.stringify({ enabled: document.getElementById('rerank-enabled').checked, model: document.getElementById('rerank-model').value.trim(), candidate_count: Number(document.getElementById('rerank-candidates').value), top_n: Number(document.getElementById('rerank-topn').value) }) }); renderRerankSettings(); utilsShowToast('再ランキング設定を保存しました', 'success');
      } else if (action === 'test-rerank') {
        await api('/rerank/test', { method: 'POST', timeout: 120000 }); utilsShowToast('再ランキング接続に成功しました', 'success');
      } else if (action === 'save-vlm') {
        settings.vlm = await api('/vlm', { method: 'PUT', body: JSON.stringify({ query_enabled: document.getElementById('vlm-query-enabled').checked, verify_enabled: document.getElementById('vlm-verify-enabled').checked, query_prompt: document.getElementById('vlm-query-prompt').value.trim(), verify_prompt: document.getElementById('vlm-verify-prompt').value.trim() }) }); utilsShowToast('VLM共通設定を保存しました', 'success');
      } else if (action === 'save-query-expansion') {
        const mode = document.querySelector('input[name="query-expansion-mode"]:checked')?.value || 'rule';
        settings.query_expansion = await api('/query-expansion', { method: 'PUT', body: JSON.stringify({ enabled: mode !== 'off', llm_enabled: mode === 'llm', max_variants: Number(document.getElementById('query-expansion-max').value), synonym_groups: synonymTextToGroups(document.getElementById('query-expansion-synonyms').value) }) }); utilsShowToast('検索バリエーション設定を保存しました', 'success');
      } else if (action === 'save-weights') {
        const keys = ['oracle_text', 'text_vector', 'vlm_text', 'vlm_vector', 'visual_vector'];
        settings.weights = await api('/weights', { method: 'PUT', body: JSON.stringify(Object.fromEntries(keys.map(key => [key, Number(document.getElementById(`weight-${key}`).value)]))) }); utilsShowToast('検索ルートの重みを保存しました', 'success');
      }
    } catch (error) {
      inlineError(button, error.message);
      utilsShowToast(`処理に失敗しました: ${error.message}。入力内容を確認して再度お試しください`, 'error');
    } finally {
      utilsHideLoading();
      if (document.body.contains(button)) {
        button.disabled = false;
        button.removeAttribute('aria-busy');
        button.innerHTML = original;
      }
    }
  };
  root.onkeydown = event => {
    const tab = event.target.closest('[role="tab"]');
    if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const tabs = [...root.querySelectorAll('.retrieval-profile-tabs [role="tab"]')];
    const index = tabs.indexOf(tab);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    event.preventDefault();
    tabs[next].click();
  };
}

export async function loadRetrievalSettings() {
  settings = await api();
  if (!settings.profiles.some(profile => profile.slot_no === activeSlot)) activeSlot = 1;
  render();
  scheduleStatusRefresh();
}

export async function loadRerankSettings() {
  settings = await api();
  renderRerankSettings();
}
