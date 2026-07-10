/**
 * 検索モジュール
 * 
 * セマンティック検索機能を担当（テキスト検索・画像検索）
 * 
 * 主な機能:
 * - テキストベースのセマンティック検索
 * - 画像ベースの類似画像検索
 * - 検索結果の表示と管理
 * - ファイルダウンロード機能
 * 
 * ネットワーク通信:
 * - バックエンドAPIとのHTTPS通信
 * - ファイルアップロード（FormData）
 * - 認証トークン付きリクエスト
 * - エラーハンドリングとユーザー通知
 */

import { apiCall as authApiCall, fetchWithAuth as authFetchWithAuth } from './auth.js';
import { showLoading as utilsShowLoading, hideLoading as utilsHideLoading, showToast as utilsShowToast, showImageModal as utilsShowImageModal } from './utils.js';

// 検索画像の状態管理
let selectedSearchImage = null;
let currentSearchType = 'text'; // 'text' or 'image'
let dynamicFieldDefinitions = [];
let dynamicFiltersLoaded = false;
let v2RetrievalActive = false;
let currentSearchController = null;
let searchCancelled = false;
let searchProgressTimer = null;
const searchProgress = { startedAt: 0, state: {}, steps: new Map() };

const stepLabels = {
  query_plan: '検索意図の整理',
  query_variants: '検索バリエーション生成',
  keyword_plan: '検索キーワード生成',
  embedding: 'ベクトル作成',
  retrieval: '候補取得',
  candidate_merge: '候補統合',
  rerank: '再ランキング',
  verify: 'VLM確認',
  format_results: '結果整形'
};

const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

const displayFilename = (fileResult) => {
  const fallback = fileResult.object_name?.split('/').pop() || '';
  return (fileResult.original_filename || fallback).replace(/^\d{8}_\d{6}_[a-f0-9]{8}_/i, '');
};

export async function loadDynamicSearchFilters() {
  try {
    const data = await authApiCall('/ai/api/search/v2/filters');
    v2RetrievalActive = Boolean(data.v2_retrieval_active);
    dynamicFieldDefinitions = data.fields || [];
    dynamicFiltersLoaded = true;
    const wrapper = document.getElementById('dynamicSearchFilters');
    const container = document.getElementById('dynamicSearchFilterFields');
    if (!wrapper || !container) return;
    wrapper.hidden = !(v2RetrievalActive && dynamicFieldDefinitions.length);
    const operatorLabels = { eq: '一致', contains: '含む', gte: '以上', lte: '以下', between: '範囲' };
    container.innerHTML = dynamicFieldDefinitions.map((field, index) => {
      const type = field.value_type === 'number' ? 'number' : (field.value_type === 'date' ? 'date' : 'text');
      const valueId = `dynamic-filter-value-${index}`;
      const valueControl = field.value_type === 'boolean'
        ? `<select id="${valueId}" class="form-input" data-filter-value ${field.conflicted ? 'disabled' : ''}><option value="">指定なし</option><option value="true">はい</option><option value="false">いいえ</option></select>`
        : `<input id="${valueId}" class="form-input" data-filter-value type="${type}" ${field.conflicted ? 'disabled' : ''}>`;
      return `<div class="dynamic-search-filter" data-filter-key="${escapeHtml(field.key)}" data-value-type="${escapeHtml(field.value_type)}" data-conflicted="${field.conflicted ? 'true' : 'false'}">
        <label class="form-label" for="${valueId}">${escapeHtml(field.label)} <small>${escapeHtml(field.key)}</small></label>
        <div class="dynamic-search-filter-controls">
          <select class="form-input" data-filter-operator aria-label="${escapeHtml(field.label)}の比較方法" ${field.conflicted ? 'disabled' : ''} onchange="window.searchModule.toggleFilterBetween(this)">${(field.allowed_operators || []).map(operator => `<option value="${operator}">${operatorLabels[operator] || escapeHtml(operator)}</option>`).join('')}</select>
          ${valueControl}
          <input class="form-input" data-filter-value-second type="${type}" hidden placeholder="上限値" aria-label="${escapeHtml(field.label)}の上限値">
        </div>
        ${field.conflicted ? '<div class="dynamic-search-filter-error" role="alert">有効なプロファイル間で型または演算子が一致していません。</div>' : ''}
      </div>`;
    }).join('');
    const imageQuery = document.getElementById('imageSearchQuery');
    if (imageQuery) {
      imageQuery.disabled = !v2RetrievalActive;
      imageQuery.placeholder = v2RetrievalActive
        ? '画像と組み合わせる条件を入力'
        : '検索索引の初期化後に利用できます';
      if (!v2RetrievalActive) imageQuery.value = '';
    }
    updateMinScoreState();
  } catch (error) {
    v2RetrievalActive = false;
    const wrapper = document.getElementById('dynamicSearchFilters');
    const imageQuery = document.getElementById('imageSearchQuery');
    if (wrapper) wrapper.hidden = true;
    if (imageQuery) imageQuery.disabled = true;
    updateMinScoreState();
    console.warn('Dynamic search filters are unavailable:', error);
  }
}

function updateMinScoreState() {
  const input = document.getElementById('minScore');
  const label = document.getElementById('minScoreLabel');
  if (input) input.disabled = v2RetrievalActive;
  if (label) label.textContent = v2RetrievalActive ? '最小スコア（新しい検索では非適用）' : '最小スコア';
}

function isSearchButtonBusy(button) {
  return button?.dataset.searchBusy === 'true';
}

function setSearchButtonBusy(button, busy, label, cancellable = true) {
  if (!button) return;
  if (busy) {
    if (!button.dataset.originalHtml) button.dataset.originalHtml = button.innerHTML;
    button.dataset.searchBusy = 'true';
    button.disabled = !cancellable;
    button.setAttribute('aria-busy', 'true');
    button.innerHTML = cancellable
      ? '<i class="fas fa-times" aria-hidden="true"></i> キャンセル'
      : `<span class="spinner spinner-sm" aria-hidden="true"></span> ${label}`;
    return;
  }
  button.disabled = false;
  button.removeAttribute('aria-busy');
  delete button.dataset.searchBusy;
  if (button.dataset.originalHtml) button.innerHTML = button.dataset.originalHtml;
  delete button.dataset.originalHtml;
}

function updateSearchElapsed() {
  const elapsed = document.getElementById('searchAgentElapsed');
  if (elapsed && searchProgress.startedAt) {
    elapsed.textContent = `${((Date.now() - searchProgress.startedAt) / 1000).toFixed(1)}秒`;
  }
}

function stopSearchProgressTimer() {
  if (searchProgressTimer) clearInterval(searchProgressTimer);
  searchProgressTimer = null;
  updateSearchElapsed();
}

function startSearchProgressTimer() {
  stopSearchProgressTimer();
  updateSearchElapsed();
  searchProgressTimer = setInterval(updateSearchElapsed, 1000);
}

const chips = (values = []) => values.map(value => `
  <span class="search-agent-chip">${escapeHtml(value)}</span>
`).join('');

function stepDetails(name) {
  const diagnostics = searchProgress.state.result?.diagnostics || {};
  const queryPlan = searchProgress.state.queryPlan || searchProgress.state.result?.diagnostics?.query_plan;
  const keywordPlan = searchProgress.state.keywordPlan || searchProgress.state.result?.diagnostics?.keyword_plan;
  const retrievalSummary = searchProgress.state.retrievalSummary || diagnostics.retrieval_summary;
  const candidateMerge = searchProgress.state.candidateMerge || diagnostics.candidate_merge;
  const rerankSummary = searchProgress.state.rerankSummary || diagnostics.rerank_summary;
  const formatSummary = searchProgress.state.formatSummary || diagnostics.format_summary;
  if (name === 'query_plan' && queryPlan?.intent) {
    const intentLabels = { general: '一般検索' };
    return `<div>検索意図: ${escapeHtml(intentLabels[queryPlan.intent] || queryPlan.intent)}</div>`;
  }
  if (name === 'query_variants' && queryPlan) {
    const sourceLabels = { deterministic: 'ルールベース', llm: 'LLM', off: '原文のみ' };
    return `
      <strong>検索バリエーション</strong>
      <div class="search-agent-chip-list">${chips(queryPlan.variants || [])}</div>
      ${queryPlan.query_expansion_source ? `<div>生成方式: ${escapeHtml(sourceLabels[queryPlan.query_expansion_source] || queryPlan.query_expansion_source)}</div>` : ''}
    `;
  }
  if (name === 'keyword_plan' && keywordPlan?.terms?.length) {
    return `
      <strong>検索キーワード</strong>
      <div class="search-agent-chip-list">${chips(keywordPlan.terms)}</div>
      <div>対象: ${escapeHtml(keywordPlan.target || 'Oracle Text')}</div>
    `;
  }
  if (name === 'retrieval' && retrievalSummary?.channels?.length) {
    return `
      <strong>検索チャンネル</strong>
      <div class="search-agent-step-grid">
        ${retrievalSummary.channels.map(channel => `
          <div>${escapeHtml(channel.channel)}</div>
          <div>${channel.status === 'ok' ? '成功' : '失敗'} / ${escapeHtml(channel.count)}件</div>
        `).join('')}
      </div>
      ${retrievalSummary.filename_filter ? `<div>ファイル名条件: ${escapeHtml(retrievalSummary.filename_filter)}</div>` : ''}
    `;
  }
  if (name === 'candidate_merge' && candidateMerge) {
    return `
      <div>方式: ${escapeHtml(candidateMerge.method || 'weighted_rrf')}</div>
      <div>入力リスト: ${escapeHtml(candidateMerge.source_lists)} / 統合後候補: ${escapeHtml(candidateMerge.candidate_count)}件</div>
      <div>上限: ${escapeHtml(candidateMerge.limit)}件</div>
    `;
  }
  if (name === 'rerank' && rerankSummary) {
    return `
      <div>状態: ${rerankSummary.skipped ? 'スキップ' : (rerankSummary.enabled ? '有効' : '無効')}</div>
      <div>候補: ${escapeHtml(rerankSummary.candidate_count)}件 / 採用上限: ${escapeHtml(rerankSummary.top_n)}件</div>
      ${rerankSummary.degraded ? '<div>一部降格: rerank</div>' : ''}
    `;
  }
  if (name === 'format_results' && formatSummary) {
    return `
      <div>文書: ${escapeHtml(formatSummary.total_documents)}件</div>
      <div>証拠: ${escapeHtml(formatSummary.total_evidence)}件</div>
    `;
  }
  return '';
}

function renderSearchProgress(message = '') {
  const root = document.getElementById('searchAgentProgress');
  if (!root) return;
  root.hidden = false;
  const status = document.getElementById('searchAgentStatus');
  const elapsed = document.getElementById('searchAgentElapsed');
  const steps = document.getElementById('searchAgentSteps');
  const details = document.getElementById('searchAgentDetails');
  if (status) status.textContent = message || searchProgress.state.message || '検索中...';
  updateSearchElapsed();
  if (steps) {
    steps.innerHTML = [...searchProgress.steps.entries()].map(([name, statusValue]) => `
      <li class="search-agent-step search-agent-step-${statusValue}">
        <details>
          <summary>
            <span>${escapeHtml(stepLabels[name] || name)}</span>
            <span>${statusValue === 'done' ? '完了' : '処理中'}</span>
          </summary>
          <div class="search-agent-step-body">${stepDetails(name) || '詳細は処理後に表示されます'}</div>
        </details>
      </li>
    `).join('');
  }
  if (details) {
    const degraded = searchProgress.state.result?.diagnostics?.degraded || [];
    details.innerHTML = degraded.length ? `<div>一部降格: ${escapeHtml(degraded.join(', '))}</div>` : '';
    details.hidden = !details.innerHTML;
  }
}

function resetSearchProgress(message = '検索を開始しました') {
  searchProgress.startedAt = Date.now();
  searchProgress.state = { message };
  searchProgress.steps = new Map();
  const root = document.getElementById('searchAgentProgress');
  if (root) root.open = true;
  renderSearchProgress(message);
  startSearchProgressTimer();
}

function finishSearchProgress(message) {
  if (message) searchProgress.state.message = message;
  stopSearchProgressTimer();
  renderSearchProgress(message);
  const root = document.getElementById('searchAgentProgress');
  if (root) root.open = false;
}

function applyStateDelta(delta = []) {
  delta.forEach(operation => {
    if (operation.op !== 'replace' || !operation.path?.startsWith('/')) return;
    searchProgress.state[operation.path.slice(1)] = operation.value;
  });
}

function handleSearchEvent(event) {
  if (event.type === 'RUN_STARTED') resetSearchProgress();
  if (event.type === 'STATE_SNAPSHOT') searchProgress.state = event.snapshot || {};
  if (event.type === 'STEP_STARTED') searchProgress.steps.set(event.stepName, 'running');
  if (event.type === 'STEP_FINISHED') searchProgress.steps.set(event.stepName, 'done');
  if (event.type === 'STATE_DELTA') applyStateDelta(event.delta);
  if (event.type === 'RUN_FINISHED') {
    const result = event.result || searchProgress.state.result;
    if (result) searchProgress.state.result = result;
    finishSearchProgress('検索が完了しました');
    return result;
  }
  if (event.type === 'RUN_ERROR') {
    finishSearchProgress(event.message || '検索に失敗しました');
    throw new Error(event.message || '検索に失敗しました');
  }
  renderSearchProgress(event.message);
  return null;
}

function parseSseBlock(block) {
  const data = block.split(/\r?\n/)
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n');
  return data ? JSON.parse(data) : null;
}

async function readSearchEventStream(response) {
  let finalResult = null;
  let buffer = '';
  const consume = text => {
    buffer += text;
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() || '';
    blocks.forEach(block => {
      const event = parseSseBlock(block);
      if (!event) return;
      finalResult = handleSearchEvent(event) || finalResult;
    });
  };

  if (!response.body?.getReader) {
    consume(await response.text());
  } else {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      consume(decoder.decode(value, { stream: true }));
    }
    consume(decoder.decode());
  }
  if (buffer.trim()) {
    const event = parseSseBlock(buffer);
    if (event) finalResult = handleSearchEvent(event) || finalResult;
  }
  if (!finalResult) throw new Error('検索結果が返されませんでした');
  return finalResult;
}

async function streamSearch(endpoint, options) {
  searchCancelled = false;
  currentSearchController = new AbortController();
  resetSearchProgress();
  try {
    const response = await authFetchWithAuth(endpoint, {
      ...options,
      signal: currentSearchController.signal
    });
    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: response.statusText }));
      throw new Error(error.detail || '検索に失敗しました');
    }
    return await readSearchEventStream(response);
  } catch (error) {
    if (searchCancelled) {
      finishSearchProgress('検索をキャンセルしました');
      throw new Error('検索をキャンセルしました');
    }
    finishSearchProgress(error.message || '検索に失敗しました');
    throw error;
  } finally {
    currentSearchController = null;
  }
}

export function cancelCurrentSearch() {
  searchCancelled = true;
  currentSearchController?.abort();
  if (currentSearchController) finishSearchProgress('検索をキャンセルしました');
}

export function invalidateDynamicSearchFilters() {
  dynamicFiltersLoaded = false;
}

export function toggleFilterBetween(select) {
  const row = select.closest('[data-filter-key]');
  const second = row?.querySelector('[data-filter-value-second]');
  if (second) second.hidden = select.value !== 'between';
}

function collectDynamicFilters() {
  return [...document.querySelectorAll('[data-filter-key]')].flatMap(row => {
    if (row.dataset.conflicted === 'true') return [];
    const operator = row.querySelector('[data-filter-operator]').value;
    const first = row.querySelector('[data-filter-value]').value;
    if (first === '') return [];
    const second = row.querySelector('[data-filter-value-second]').value;
    if (operator === 'between' && second === '') {
      throw new Error(`${row.dataset.filterKey}: 範囲指定には下限値と上限値が必要です`);
    }
    const convert = value => {
      if (row.dataset.valueType !== 'number') return value;
      const number = Number(value);
      if (!Number.isFinite(number)) throw new Error(`${row.dataset.filterKey}: 数値を入力してください`);
      return number;
    };
    return [{
      field_key: row.dataset.filterKey,
      operator,
      value: operator === 'between' ? [convert(first), convert(second)] : convert(first)
    }];
  });
}

function objectUrl(bucket, objectName) {
  const encoded = String(objectName).split('/').map(encodeURIComponent).join('/');
  return `/ai/api/object/${encodeURIComponent(bucket)}/${encoded}`;
}

function adaptV2Response(data) {
  const source = data.results || [];
  const maxScore = Math.max(...source.map(item => item.score || 0), 1e-9);
  const results = source.map(document => {
    const seen = new Set();
    const matched_images = (document.evidence || []).flatMap(evidence => {
      if (!evidence.asset_url || seen.has(evidence.asset_url)) return [];
      seen.add(evidence.asset_url);
      const score = evidence.rerank_score ?? evidence.score ?? 0;
      return [{
        embed_id: evidence.evidence_id,
        bucket: document.bucket,
        object_name: evidence.asset_url,
        page_number: evidence.page_number,
        vector_distance: Math.max(0, 1 - Math.min(1, score / maxScore)),
        url: objectUrl(document.bucket, evidence.asset_url),
        retrieval_channels: evidence.retrieval_channels,
        verification_status: evidence.verification_status,
        caption: evidence.caption,
        text_excerpt: evidence.text_excerpt
      }];
    });
    return {
      file_id: document.document_id,
      bucket: document.bucket,
      object_name: document.object_name,
      original_filename: document.file_name,
      min_distance: Math.max(0, 1 - Math.min(1, (document.score || 0) / maxScore)),
      matched_images,
      url: objectUrl(document.bucket, document.object_name),
      profile_slots: document.profile_slots
    };
  });
  return {
    success: data.success,
    query: data.query,
    results,
    total_files: results.length,
    total_images: results.reduce((count, item) => count + item.matched_images.length, 0),
    processing_time: data.processing_time || 0,
    trace_id: data.trace_id
  };
}

/**
 * 検索タイプを切り替え
 * 
 * テキスト検索と画像検索のUIを切り替える関数です。
 * 
 * @param {string} type - 検索タイプ ('text' または 'image')
 * 
 * ネットワーク通信の影響:
 * - UIの表示切り替えのみ（ネットワーク通信なし）
 * - ユーザーエクスペリエンスの向上
 */
export function switchSearchType(type) {
  currentSearchType = type;
  
  const textTab = document.getElementById('searchTypeTextTab');
  const imageTab = document.getElementById('searchTypeImageTab');
  const textPanel = document.getElementById('textSearchPanel');
  const imagePanel = document.getElementById('imageSearchPanel');
  
  if (type === 'text') {
    // テキスト検索タブをアクティブに
    textTab.style.borderBottomColor = '#1a365d';
    textTab.style.color = '#1a365d';
    imageTab.style.borderBottomColor = 'transparent';
    imageTab.style.color = '#64748b';
    
    textPanel.style.display = 'block';
    imagePanel.style.display = 'none';
    textTab.setAttribute('aria-selected', 'true');
    imageTab.setAttribute('aria-selected', 'false');
    textTab.tabIndex = 0;
    imageTab.tabIndex = -1;
  } else {
    // 画像検索タブをアクティブに
    imageTab.style.borderBottomColor = '#1a365d';
    imageTab.style.color = '#1a365d';
    textTab.style.borderBottomColor = 'transparent';
    textTab.style.color = '#64748b';
    
    imagePanel.style.display = 'block';
    textPanel.style.display = 'none';
    imageTab.setAttribute('aria-selected', 'true');
    textTab.setAttribute('aria-selected', 'false');
    imageTab.tabIndex = 0;
    textTab.tabIndex = -1;
  }
}

/**
 * 検索画像を選択
 * @param {Event} event - ファイル選択イベント
 */
export function handleSearchImageSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  
  // ファイルサイズチェック (最大10MB)
  const maxSize = 10 * 1024 * 1024;
  if (file.size > maxSize) {
    utilsShowToast('画像ファイルは10MB以下にしてください', 'warning');
    return;
  }
  
  // ファイルタイプチェック
  if (!file.type.match(/^image\/(png|jpeg|jpg|webp)$/)) {
    utilsShowToast('PNG, JPG, JPEG, WebP形式の画像のみ対応しています', 'warning');
    return;
  }
  
  selectedSearchImage = file;
  
  // プレビュー表示
  const reader = new FileReader();
  reader.onload = (e) => {
    const previewImg = document.getElementById('searchImagePreviewImg');
    const previewDiv = document.getElementById('imageSearchPreview');
    const placeholder = document.getElementById('imageSearchPlaceholder');
    const filenameSpan = document.getElementById('searchImageFilename');
    
    if (previewImg && previewDiv && placeholder && filenameSpan) {
      previewImg.src = e.target.result;
      filenameSpan.textContent = file.name;
      previewDiv.style.display = 'block';
      placeholder.style.display = 'none';
    }
  };
  reader.readAsDataURL(file);
}

/**
 * 検索画像をクリア
 */
export function clearSearchImage() {
  selectedSearchImage = null;
  
  const fileInput = document.getElementById('searchImageInput');
  const previewDiv = document.getElementById('imageSearchPreview');
  const placeholder = document.getElementById('imageSearchPlaceholder');
  
  if (fileInput) fileInput.value = '';
  if (previewDiv) previewDiv.style.display = 'none';
  if (placeholder) placeholder.style.display = 'block';
}

/**
 * 画像検索を実行
 */
export async function performImageSearch() {
  const submitButton = document.getElementById('imageSearchSubmitBtn');
  if (isSearchButtonBusy(submitButton)) {
    cancelCurrentSearch();
    return;
  }
  if (!selectedSearchImage) {
    utilsShowToast('検索する画像を選択してください', 'warning');
    return;
  }
  
  // 共通のフィルター値を使用
  const filenameFilter = document.getElementById('filenameFilter').value.trim();
  const topK = parseInt(document.getElementById('topK').value) || 10;
  const imageQuery = document.getElementById('imageSearchQuery')?.value.trim() || '';
  const verify = Boolean(document.getElementById('searchVlmVerify')?.checked);
  let usesEventStream = false;
  searchCancelled = false;
  
  try {
    setSearchButtonBusy(submitButton, true, '検索中...');
    if (!dynamicFiltersLoaded) await loadDynamicSearchFilters();
    usesEventStream = v2RetrievalActive;
    setSearchButtonBusy(submitButton, true, '検索中...', usesEventStream);
    if (searchCancelled) throw new Error('検索をキャンセルしました');
    
    // FormDataを作成
    const formData = new FormData();
    formData.append('image', selectedSearchImage);
    formData.append('top_k', topK.toString());
    if (filenameFilter) formData.append('filename_filter', filenameFilter);
    let endpoint = '/ai/api/search/image';
    if (v2RetrievalActive) {
      endpoint = '/ai/api/search/v2/image/events';
      formData.append('query', imageQuery);
      formData.append('field_filters', JSON.stringify(collectDynamicFilters()));
      formData.append('document_types', '[]');
      formData.append('verify', verify ? 'true' : 'false');
    } else {
      utilsShowLoading('画像検索中...（最大70秒かかる場合があります）');
      formData.append('min_score', document.getElementById('minScore').value || '0.7');
    }

    const data = usesEventStream ? await streamSearch(endpoint, {
      method: 'POST',
      body: formData
    }) : await authApiCall(endpoint, {
      method: 'POST',
      body: formData,
      timeout: 70000
    });

    displaySearchResults(v2RetrievalActive ? adaptV2Response(data) : data);
    
    // 検索完了メッセージを表示
    utilsShowToast('画像検索が完了しました', 'success');
    
  } catch (error) {
    const message = error.message.includes('タイムアウト')
      ? '画像検索がタイムアウトしました。条件を見直して再度お試しください'
      : `画像検索に失敗しました: ${error.message}。再度お試しください`;
    utilsShowToast(message, 'error');
  } finally {
    if (!usesEventStream) utilsHideLoading();
    setSearchButtonBusy(submitButton, false);
  }
}

/**
 * 認証トークン付きのURLを生成
 * @param {string} url - ベースURL(検索APIから返却されたURLまたはバケット/オブジェクト名)
 * @param {string} bucket - バケット名(オプション、旧形式互換用)
 * @param {string} objectName - オブジェクト名(オプション、旧形式互換用)
 * @returns {string} トークン付きのURL
 */
function getAuthenticatedImageUrl(urlOrBucket, objectName) {
  const token = localStorage.getItem('loginToken');
  
  // 既に完全なURLが渡された場合(検索APIのurlフィールド)
  if (urlOrBucket && (urlOrBucket.startsWith('http://') || urlOrBucket.startsWith('https://') || urlOrBucket.startsWith('/'))) {
    const url = urlOrBucket;
    if (token) {
      const separator = url.includes('?') ? '&' : '?';
      return `${url}${separator}token=${encodeURIComponent(token)}`;
    }
    return url;
  }
  
  // 旧形式互換: bucket + objectName が渡された場合
  if (urlOrBucket && objectName) {
    const baseUrl = `/ai/api/object/${urlOrBucket}/${encodeURIComponent(objectName)}`;
    if (token) {
      return `${baseUrl}?token=${encodeURIComponent(token)}`;
    }
    return baseUrl;
  }
  
  return urlOrBucket || '';
}

/**
 * 検索を実行
 */
export async function performSearch() {
  const submitButton = document.getElementById('textSearchSubmitBtn');
  if (isSearchButtonBusy(submitButton)) {
    cancelCurrentSearch();
    return;
  }
  const query = document.getElementById('searchQuery').value.trim();
  const filenameFilter = document.getElementById('filenameFilter').value.trim();
  const topK = parseInt(document.getElementById('topK').value) || 10;
  const verify = Boolean(document.getElementById('searchVlmVerify')?.checked);
  let usesEventStream = false;
  searchCancelled = false;
  
  if (!query) {
    utilsShowToast('検索クエリを入力してください', 'warning');
    return;
  }
  
  try {
    setSearchButtonBusy(submitButton, true, '検索中...');
    if (!dynamicFiltersLoaded) await loadDynamicSearchFilters();
    usesEventStream = v2RetrievalActive;
    setSearchButtonBusy(submitButton, true, '検索中...', usesEventStream);
    if (searchCancelled) throw new Error('検索をキャンセルしました');
    
    const requestBody = v2RetrievalActive
      ? { query, top_k: topK, filename_filter: filenameFilter || null, field_filters: [], document_types: [], current_version_only: true, verify }
      : { query, top_k: topK, min_score: Number(document.getElementById('minScore').value) || 0.7, filename_filter: filenameFilter || null };
    const endpoint = v2RetrievalActive ? '/ai/api/search/v2/events' : '/ai/api/search';
    if (!usesEventStream) utilsShowLoading('検索中...（最大70秒かかる場合があります）');

    const data = usesEventStream ? await streamSearch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody)
    }) : await authApiCall(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
      timeout: 70000
    });

    displaySearchResults(v2RetrievalActive ? adaptV2Response(data) : data);
    
    // 検索完了メッセージを表示
    utilsShowToast('検索が完了しました', 'success');
    
  } catch (error) {
    const message = error.message.includes('タイムアウト')
      ? '検索がタイムアウトしました。条件を見直して再度お試しください'
      : `検索に失敗しました: ${error.message}。再度お試しください`;
    utilsShowToast(message, 'error');
  } finally {
    if (!usesEventStream) utilsHideLoading();
    setSearchButtonBusy(submitButton, false);
  }
}

/**
 * 検索結果を表示
 * @param {Object} data - 検索結果データ
 */
export function displaySearchResults(data) {
  const resultsDiv = document.getElementById('searchResults');
  const summarySpan = document.getElementById('searchResultsSummary');
  const listDiv = document.getElementById('searchResultsList');
  
  if (!data.results || data.results.length === 0) {
    resultsDiv.style.display = 'block';
    summarySpan.textContent = '検索結果なし';
    listDiv.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon"><i class="fas fa-search" style="color: #94a3b8;"></i></div>
        <div class="empty-state-title">検索結果が見つかりませんでした</div>
        <div class="empty-state-subtitle">別のキーワードで検索してみてください</div>
      </div>
    `;
    return;
  }
  
  resultsDiv.style.display = 'block';
  summarySpan.textContent = `${data.total_files}ファイル (${data.total_images}画像, ${data.processing_time.toFixed(2)}秒)`;
  
  // ファイル単位で表示
  listDiv.innerHTML = data.results.map((fileResult, fileIndex) => {
    const distancePercent = (1 - fileResult.min_distance) * 100;
    const originalFilename = displayFilename(fileResult);
    
    // ファイル情報カード
    const fileCardHtml = `
      <div class="card search-result-card">
        <!-- ファイルヘッダー -->
        <div class="card-header search-result-header">
          <div class="search-result-header-row">
            <div class="search-result-header-left">
              <span class="badge search-result-badge-white">#${fileIndex + 1}</span>
              <div>
                <div class="search-result-filename"><i class="fas fa-file"></i> ${escapeHtml(originalFilename)}</div>
              </div>
            </div>
            <div class="search-result-stats">
              <span class="badge search-result-stat-badge">
                マッチ度: ${distancePercent.toFixed(1)}%
              </span>
              <span class="badge search-result-stat-badge">
                ${fileResult.matched_images.length}ページ
              </span>
              <button 
                onclick="window.searchModule.downloadFile('${fileResult.bucket}', '${encodeURIComponent(fileResult.object_name)}')"
                class="search-result-download-btn"
                title="ファイルをダウンロード"
              >
                <i class="fas fa-download"></i> ダウンロード
              </button>
            </div>
          </div>
        </div>
        
        <!-- ページ画像グリッド -->
        <div class="card-body">
          <div class="search-result-body-title">
            <i class="fas fa-images"></i> マッチしたページ画像（距離が小さい順）
          </div>
          <div class="search-result-images-grid">
            ${fileResult.matched_images.map((img, imgIndex) => {
              const imgDistancePercent = (1 - img.vector_distance) * 100;
              // img.url(APIから返却された絶対URL)を優先、なければbucket+object_nameから生成
              const imageUrl = img.url ? getAuthenticatedImageUrl(img.url) : getAuthenticatedImageUrl(img.bucket, img.object_name);
              
              return `
                <button
                  type="button"
                  class="image-card search-result-image-card"
                  style="
                    border: 2px solid #e2e8f0; 
                    border-radius: 8px; 
                    overflow: hidden; 
                    cursor: pointer; 
                    transition: all 0.3s ease;
                    background: white;
                    box-shadow: 0 2px 4px rgba(0,0,0,0.1);
                  "
                  onclick="window.searchModule.showSearchImageModal(${fileIndex}, ${imgIndex})"
                  onmouseover="this.style.transform='translateY(-4px)'; this.style.boxShadow='0 8px 16px rgba(15, 40, 71, 0.3)'; this.style.borderColor='#1a365d';"
                  onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 2px 4px rgba(0,0,0,0.1)'; this.style.borderColor='#e2e8f0';"
                >
                  <!-- サムネイル画像 -->
                  <div class="search-result-image-aspect">
                    <img
                      src="${imageUrl}" 
                      alt="ページ ${img.page_number}"
                      loading="lazy"
                      decoding="async"
                      style="
                        position: absolute;
                        top: 0;
                        left: 0;
                        width: 100%;
                        height: 100%;
                        object-fit: contain;
                      "
                      onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%27200%27 height=%27200%27%3E%3Crect fill=%27%23f1f5f9%27 width=%27200%27 height=%27200%27/%3E%3Ctext x=%2750%25%27 y=%2750%25%27 text-anchor=%27middle%27 dy=%27.3em%27 fill=%27%2394a3b8%27 font-size=%2724%27%3E画像エラー%3C/text%3E%3C/svg%3E'"
                    />
                    <!-- マッチ度バッジ -->
                    <div style="
                      position: absolute;
                      top: 8px;
                      right: 8px;
                      background: rgba(26, 54, 93, 0.95);
                      color: white;
                      padding: 4px 8px;
                      border-radius: 4px;
                      font-size: 11px;
                      font-weight: 600;
                      box-shadow: 0 2px 4px rgba(0,0,0,0.2);
                    ">
                      ${imgDistancePercent.toFixed(1)}%
                    </div>
                  </div>
                  
                  <!-- 画像情報 -->
                  <div class="search-result-image-info">
                    <div class="search-result-image-title">
                      <i class="fas fa-file"></i> ページ ${img.page_number}
                    </div>
                    <div class="search-result-image-similarity">
                      距離: ${img.vector_distance.toFixed(4)}
                    </div>
                    ${img.retrieval_channels?.length ? `<div class="text-xs text-gray-500">${escapeHtml(img.retrieval_channels.join(' · '))}</div>` : ''}
                    ${img.verification_status && img.verification_status !== 'not_requested' ? `<div class="text-xs text-gray-500">VLM: ${escapeHtml(img.verification_status)}</div>` : ''}
                    ${img.caption ? `<div class="text-xs text-gray-600" style="margin-top:6px;line-height:1.5">${escapeHtml(img.caption.slice(0, 180))}</div>` : ''}
                  </div>
                </button>
              `;
            }).join('')}
          </div>
        </div>
      </div>
    `;
    
    return fileCardHtml;
  }).join('');
  
  // 検索結果データをグローバルに保存（画像モーダル用）
  window._searchResultsData = data;
}

/**
 * 検索結果用画像モーダルを表示（ナビゲーション対応版）
 * @param {number} fileIndex - ファイルのインデックス
 * @param {number} imageIndex - 画像のインデックス
 */
export function showSearchImageModal(fileIndex, imageIndex) {
  // グローバルに保存された検索結果データを取得
  const data = window._searchResultsData;
  if (!data || !data.results || !data.results[fileIndex]) {
    utilsShowToast('画像データが見つかりません', 'error');
    return;
  }
  
  const fileResult = data.results[fileIndex];
  const matchedImages = fileResult.matched_images;
  
  if (!matchedImages || imageIndex >= matchedImages.length) {
    utilsShowToast('画像が見つかりません', 'error');
    return;
  }
  
  // 画像URLとタイトルのリストを作成
  const imageUrls = matchedImages.map(img => {
    return img.url ? getAuthenticatedImageUrl(img.url) : getAuthenticatedImageUrl(img.bucket, img.object_name);
  });
  
  const imageTitles = matchedImages.map(img => {
    const matchPercent = (1 - img.vector_distance) * 100;
    return `ページ ${img.page_number} - マッチ度: ${matchPercent.toFixed(1)}% | 距離: ${img.vector_distance.toFixed(4)}`;
  });
  
  // 共通のshowImageModal関数を呼び出す（画像リストとインデックスを渡す）
  utilsShowImageModal(imageUrls[imageIndex], imageTitles[imageIndex], imageUrls, imageIndex, imageTitles);
}

/**
 * ファイルをダウンロード
 * @param {string} bucket - バケット名
 * @param {string} encodedObjectName - エンコードされたオブジェクト名
 */
export async function downloadFile(bucket, encodedObjectName) {
  try {
    // bucket が既に完全なURLの場合(検索結果のurl)と、bucket+objectNameの場合の両対応
    let fileUrl;
    if (bucket && (bucket.startsWith('http://') || bucket.startsWith('https://') || bucket.startsWith('/'))) {
      fileUrl = getAuthenticatedImageUrl(bucket);
    } else {
      fileUrl = getAuthenticatedImageUrl(bucket, decodeURIComponent(encodedObjectName));
    }
    
    // 新しいタブで開く
    window.open(fileUrl, '_blank');
    
    utilsShowToast('ファイルを開きました', 'success');
  } catch (error) {
    utilsShowToast(`ダウンロードに失敗しました: ${error.message}`, 'error');
  }
}

/**
 * 検索結果をクリア
 */
export function clearSearchResults() {
  cancelCurrentSearch();
  // テキスト検索のクリア
  document.getElementById('searchQuery').value = '';
  
  // 画像検索のクリア
  clearSearchImage();
  const imageQuery = document.getElementById('imageSearchQuery');
  if (imageQuery) imageQuery.value = '';
  
  // 検索結果を非表示
  document.getElementById('searchResults').style.display = 'none';
  const progress = document.getElementById('searchAgentProgress');
  if (progress) progress.hidden = true;
  stopSearchProgressTimer();
}

// windowオブジェクトに登録（HTMLから呼び出せるように）
window.searchModule = {
  performSearch,
  performImageSearch,
  displaySearchResults,
  showSearchImageModal,
  downloadFile,
  clearSearchResults,
  switchSearchType,
  handleSearchImageSelect,
  clearSearchImage,
  cancelCurrentSearch,
  loadDynamicSearchFilters,
  toggleFilterBetween
};

// デフォルトエクスポート
export default {
  performSearch,
  performImageSearch,
  displaySearchResults,
  showSearchImageModal,
  downloadFile,
  clearSearchResults,
  switchSearchType,
  handleSearchImageSelect,
  clearSearchImage,
  cancelCurrentSearch,
  loadDynamicSearchFilters,
  toggleFilterBetween
}

/**
 * 画像モーダルを閉じる
 */
export function closeImageModal() {
  const modal = document.getElementById('imageModal');
  if (!modal) return;
  
  // ESCハンドラーを削除（グローバル変数を参照）
  const escapeHandler = window._imageModalEscapeHandler;
  if (escapeHandler) {
    document.removeEventListener('keydown', escapeHandler);
    window._imageModalEscapeHandler = null;
  }
  
  // 即座に削除（フラッシュを防ぐためアニメーションなし）
  modal.remove();
  
  // 追加の安全策：app.js側のグローバル変数もクリーンアップ
  if (typeof window._imageModalEscapeHandler !== 'undefined') {
    window._imageModalEscapeHandler = null;
  }
}
