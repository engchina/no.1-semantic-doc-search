import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';

let authModule;
let dbModule;
let retrievalSettingsModule;
let searchModule;
let stateModule;
let utilsModule;
let vite;

before(async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', {
    url: 'http://localhost/'
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    localStorage: dom.window.localStorage,
    FileReader: dom.window.FileReader,
    FormData: dom.window.FormData
  });
  vite = await createServer({
    root: process.cwd(),
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true }
  });
  authModule = await vite.ssrLoadModule('/src/modules/auth.js');
  dbModule = await vite.ssrLoadModule('/src/modules/db.js');
  retrievalSettingsModule = await vite.ssrLoadModule('/src/modules/retrieval-settings.js');
  searchModule = await vite.ssrLoadModule('/src/modules/search.js');
  stateModule = await vite.ssrLoadModule('/src/state.js');
  utilsModule = await vite.ssrLoadModule('/src/modules/utils.js');
});

after(async () => {
  await vite?.close();
});

test('ログイン成功後に検索フィルターを読み込む', async () => {
  document.body.innerHTML = `
    <form id="loginForm"><input id="loginUsername" value="tester"><input id="loginPassword" value="secret"></form>
    <div id="loginOverlay"></div><div id="loginError"></div><div id="loginErrorMessage"></div>
    <button id="loginSubmitBtn">ログイン</button><div id="userInfo"></div><span id="userName"></span>
  `;
  let filterLoads = 0;
  window.searchModule = { loadDynamicSearchFilters: async () => { filterLoads += 1; } };
  window.UIComponents = { showToast() {}, setSessionTimeoutToastMode() {} };
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ status: 'success', token: 'token', username: 'tester' })
  });

  await authModule.handleLogin({ preventDefault() {} });

  assert.equal(filterLoads, 1);
  assert.equal(localStorage.getItem('loginToken'), 'token');
});

test('新しい共有検索の有効状態に合わせて最小スコアを切り替える', async () => {
  document.body.innerHTML = `
    <fieldset id="dynamicSearchFilters" hidden><div id="dynamicSearchFilterFields"></div></fieldset>
    <label id="minScoreLabel" for="minScore">最小スコア</label><input id="minScore">
    <input id="imageSearchQuery">
  `;
  const responses = [
    { v2_retrieval_active: true, fields: [] },
    { v2_retrieval_active: false, fields: [] }
  ];
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => responses.shift() });

  await searchModule.loadDynamicSearchFilters();
  assert.equal(document.getElementById('minScore').disabled, true);
  assert.equal(document.getElementById('dynamicSearchFilters').hidden, true);
  assert.match(document.getElementById('minScoreLabel').textContent, /非適用/);

  await searchModule.loadDynamicSearchFilters();
  assert.equal(document.getElementById('minScore').disabled, false);
  assert.equal(document.getElementById('dynamicSearchFilters').hidden, true);
});

test('共有認証ヘルパーはVITE_API_BASE向けにプロキシ接頭辞を除く', async () => {
  let requestedUrl;
  stateModule.appState.set('apiBase', 'https://api.example.test/');
  globalThis.fetch = async (url, options = {}) => {
    requestedUrl = url;
    return { ok: true, status: 200, json: async () => ({}) };
  };

  await authModule.apiCall('/ai/api/settings/retrieval');

  assert.equal(requestedUrl, 'https://api.example.test/settings/retrieval');
  stateModule.appState.set('apiBase', '');
});

test('検索タイムアウト後も入力を保持して操作状態を復元する', async () => {
  document.body.innerHTML = `
    <textarea id="searchQuery">保持する検索条件</textarea>
    <input id="filenameFilter" value="report"><input id="topK" value="10"><input id="minScore" value="0.7">
    <button id="textSearchSubmitBtn"><span>検索実行</span></button>
  `;
  let toast;
  window.UIComponents = { showToast(message, type) { toast = { message, type }; } };
  globalThis.fetch = async () => { throw new Error('リクエストがタイムアウトしました'); };

  await searchModule.performSearch();

  const button = document.getElementById('textSearchSubmitBtn');
  assert.equal(document.getElementById('searchQuery').value, '保持する検索条件');
  assert.equal(button.disabled, false);
  assert.equal(button.hasAttribute('aria-busy'), false);
  assert.equal(document.getElementById('loadingOverlay'), null);
  assert.equal(toast.type, 'error');
  assert.match(toast.message, /再度お試しください/);
});

test('AG-UI検索イベントは進捗を表示して結果を描画する', async () => {
  document.body.innerHTML = `
    <fieldset id="dynamicSearchFilters" hidden><div id="dynamicSearchFilterFields"></div></fieldset>
    <label id="minScoreLabel" for="minScore">最小スコア</label><input id="minScore">
    <input id="imageSearchQuery">
    <input id="searchVlmVerify" type="checkbox">
    <textarea id="searchQuery">天井照明</textarea>
    <input id="filenameFilter" value=""><input id="topK" value="10">
    <button id="textSearchSubmitBtn"><span>検索実行</span></button>
    <details id="searchAgentProgress" hidden><summary><span id="searchAgentStatus"></span><small id="searchAgentElapsed"></small></summary><ol id="searchAgentSteps"></ol><div id="searchAgentDetails" hidden></div></details>
    <div id="searchResults" style="display:none"><span id="searchResultsSummary"></span><div id="searchResultsList"></div></div>
  `;
  window.UIComponents = { showToast() {} };
  let requestBody;
  const result = {
    success: true,
    trace_id: 'trace',
    query: '天井照明',
    results: [{ document_id: 'd1', file_name: 'lighting.pdf', object_name: 'lighting.pdf', bucket: 'bucket', score: 1, profile_slots: [], evidence: [] }],
    total_documents: 1,
    total_evidence: 0,
    processing_time: 0.12,
    diagnostics: { degraded: ['rerank'] }
  };
  const stream = [
    { type: 'RUN_STARTED' },
    { type: 'STATE_SNAPSHOT', snapshot: { status: 'started', message: '検索開始', result: null } },
    { type: 'STEP_STARTED', stepName: 'query_plan', message: '検索意図の整理' },
    { type: 'STEP_FINISHED', stepName: 'query_plan' },
    { type: 'STEP_STARTED', stepName: 'query_variants', message: '検索バリエーション生成' },
    { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/queryPlan', value: { variants: ['天井照明', 'ダウンライト'], intent: 'general', query_expansion_source: 'deterministic' } }] },
    { type: 'STEP_FINISHED', stepName: 'query_variants' },
    { type: 'STEP_STARTED', stepName: 'keyword_plan', message: '検索キーワード生成' },
    { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/keywordPlan', value: { terms: ['天井', '照明', 'ダウンライト'], target: 'Oracle Text', max_terms: 20 } }] },
    { type: 'STEP_FINISHED', stepName: 'keyword_plan' },
    { type: 'STEP_STARTED', stepName: 'retrieval', message: '候補取得' },
    { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/retrievalSummary', value: { channels: [{ channel: 'oracle_text', status: 'ok', count: 3, weight: 1 }] } }] },
    { type: 'STEP_FINISHED', stepName: 'retrieval' },
    { type: 'STEP_STARTED', stepName: 'candidate_merge', message: '候補統合' },
    { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/candidateMerge', value: { method: 'weighted_rrf', source_lists: 1, candidate_count: 1, limit: 100 } }] },
    { type: 'STEP_FINISHED', stepName: 'candidate_merge' },
    { type: 'STEP_STARTED', stepName: 'rerank', message: '再ランキング' },
    { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/rerankSummary', value: { enabled: true, skipped: false, candidate_count: 1, top_n: 30, degraded: true } }] },
    { type: 'STEP_FINISHED', stepName: 'rerank' },
    { type: 'STEP_STARTED', stepName: 'format_results', message: '結果整形' },
    { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/formatSummary', value: { total_documents: 1, total_evidence: 0 } }] },
    { type: 'STEP_FINISHED', stepName: 'format_results' },
    { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/result', value: result }] },
    { type: 'RUN_FINISHED', result }
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
  let searchUrl;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/search/v2/filters')) {
      return { ok: true, status: 200, json: async () => ({ v2_retrieval_active: true, fields: [] }) };
    }
    searchUrl = String(url);
    requestBody = JSON.parse(options.body);
    return {
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(stream));
          controller.close();
        }
      })
    };
  };

  searchModule.invalidateDynamicSearchFilters();
  await searchModule.loadDynamicSearchFilters();
  await searchModule.performSearch();

  assert.match(searchUrl, /\/ai\/api\/search\/v2\/events$/);
  assert.equal(requestBody.verify, false);
  assert.equal(document.getElementById('searchAgentProgress').hidden, false);
  assert.equal(document.getElementById('searchAgentProgress').open, false);
  assert.ok(document.querySelector('#searchAgentSteps details > summary'));
  const steps = document.getElementById('searchAgentSteps').textContent;
  assert.match(steps, /検索バリエーション生成/);
  assert.match(steps, /検索キーワード生成/);
  assert.match(steps, /候補取得/);
  assert.match(steps, /候補統合/);
  assert.match(steps, /検索バリエーション/);
  assert.match(steps, /検索意図: 一般検索/);
  assert.match(steps, /検索キーワード/);
  assert.match(steps, /対象: Oracle Text/);
  assert.match(steps, /ダウンライト/);
  assert.match(steps, /ルールベース/);
  assert.match(steps, /weighted_rrf/);
  assert.match(document.getElementById('searchAgentDetails').textContent, /rerank/);
  assert.doesNotMatch(steps, /検索意図: general/);
  assert.doesNotMatch(steps, /deterministic/);
  assert.doesNotMatch(steps, /AI整理キーワード\/検索語/);
  assert.doesNotMatch(steps, /検索語:/);
  assert.match(document.getElementById('searchResultsSummary').textContent, /1ファイル/);
});

test('検索結果はアップロード用プレフィクスを隠して元ファイル名だけ表示する', async () => {
  document.body.innerHTML = `
    <div id="searchResults" style="display:none"><span id="searchResultsSummary"></span><div id="searchResultsList"></div></div>
  `;

  searchModule.displaySearchResults({
    results: [{
      file_id: 'd1',
      bucket: 'bucket',
      object_name: '20260709_215027_e18cabda_設備・内装商品カタログ2026年1月版.pdf',
      original_filename: null,
      min_distance: 0,
      matched_images: []
    }],
    total_files: 1,
    total_images: 0,
    processing_time: 0.1
  });

  assert.equal(document.querySelector('.search-result-filename').textContent.trim(), '設備・内装商品カタログ2026年1月版.pdf');
  assert.equal(document.querySelector('.search-result-path'), null);
  assert.doesNotMatch(document.getElementById('searchResultsList').textContent, /20260709_215027_e18cabda_/);
});

test('AG-UI検索エラー後も入力と操作状態を保持する', async () => {
  document.body.innerHTML = `
    <fieldset id="dynamicSearchFilters" hidden><div id="dynamicSearchFilterFields"></div></fieldset>
    <label id="minScoreLabel" for="minScore">最小スコア</label><input id="minScore">
    <input id="imageSearchQuery">
    <input id="searchVlmVerify" type="checkbox">
    <textarea id="searchQuery">保持する検索条件</textarea>
    <input id="filenameFilter" value="report"><input id="topK" value="10">
    <button id="textSearchSubmitBtn"><span>検索実行</span></button>
    <details id="searchAgentProgress" hidden><summary><span id="searchAgentStatus"></span><small id="searchAgentElapsed"></small></summary><ol id="searchAgentSteps"></ol><div id="searchAgentDetails" hidden></div></details>
  `;
  let toast;
  window.UIComponents = { showToast(message, type) { toast = { message, type }; } };
  const stream = [
    { type: 'RUN_STARTED' },
    { type: 'STATE_SNAPSHOT', snapshot: { status: 'started', message: '検索開始', result: null } },
    { type: 'RUN_ERROR', message: '検索がタイムアウトしました' }
  ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
  globalThis.fetch = async url => String(url).endsWith('/search/v2/filters')
    ? { ok: true, status: 200, json: async () => ({ v2_retrieval_active: true, fields: [] }) }
    : {
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(stream));
            controller.close();
          }
        })
      };

  searchModule.invalidateDynamicSearchFilters();
  await searchModule.loadDynamicSearchFilters();
  await searchModule.performSearch();

  const button = document.getElementById('textSearchSubmitBtn');
  assert.equal(document.getElementById('searchQuery').value, '保持する検索条件');
  assert.equal(button.disabled, false);
  assert.equal(button.hasAttribute('aria-busy'), false);
  assert.equal(document.getElementById('searchAgentProgress').open, false);
  assert.equal(toast.type, 'error');
  assert.match(toast.message, /再度お試しください/);
});

test('検索中ボタンはキャンセルになり経過時間をローカル更新する', async () => {
  document.body.innerHTML = `
    <fieldset id="dynamicSearchFilters" hidden><div id="dynamicSearchFilterFields"></div></fieldset>
    <label id="minScoreLabel" for="minScore">最小スコア</label><input id="minScore">
    <input id="imageSearchQuery">
    <input id="searchVlmVerify" type="checkbox" checked>
    <textarea id="searchQuery">保持する検索条件</textarea>
    <input id="filenameFilter" value=""><input id="topK" value="10">
    <button id="textSearchSubmitBtn"><span>検索実行</span></button>
    <details id="searchAgentProgress" hidden><summary><span id="searchAgentStatus"></span><small id="searchAgentElapsed"></small></summary><ol id="searchAgentSteps"></ol><div id="searchAgentDetails" hidden></div></details>
  `;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const originalNow = Date.now;
  let intervalCallback;
  let requestBody;
  let streamController;
  let aborted = false;
  let now = 1000;
  globalThis.setInterval = callback => {
    intervalCallback = callback;
    return 1;
  };
  globalThis.clearInterval = () => {};
  Date.now = () => now;
  window.UIComponents = { showToast() {} };
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/search/v2/filters')) {
      return { ok: true, status: 200, json: async () => ({ v2_retrieval_active: true, fields: [] }) };
    }
    requestBody = JSON.parse(options.body);
    options.signal?.addEventListener('abort', () => {
      aborted = true;
      streamController?.error(new Error('aborted'));
    });
    return {
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          streamController = controller;
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'RUN_STARTED' })}\n\n`));
        }
      })
    };
  };

  try {
    searchModule.invalidateDynamicSearchFilters();
    const searchPromise = searchModule.performSearch();
    for (let attempt = 0; attempt < 10 && !intervalCallback; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    now = 2500;
    intervalCallback();
    assert.equal(requestBody.verify, true);
    assert.match(document.getElementById('textSearchSubmitBtn').textContent, /キャンセル/);
    assert.match(document.getElementById('searchAgentElapsed').textContent, /1\.5秒/);

    await searchModule.performSearch();
    await searchPromise;

    assert.equal(aborted, true);
    assert.equal(document.getElementById('searchQuery').value, '保持する検索条件');
    assert.match(document.getElementById('textSearchSubmitBtn').textContent, /検索実行/);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    Date.now = originalNow;
  }
});

test('検索とアップロードの進捗は入力カードと結果カードの間に置く', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const searchHeader = html.indexOf('セマンティック検索');
  const verify = html.indexOf('id="searchVlmVerify"');
  const textPanel = html.indexOf('id="textSearchPanel"');
  const searchProgress = html.indexOf('id="searchAgentProgress"');
  const searchResults = html.indexOf('id="searchResults"');
  const progressMarkup = html.slice(
    searchProgress,
    searchResults
  );
  const uploadHeader = html.indexOf('文書アップロード');
  const uploadButton = html.indexOf('id="uploadMultipleBtn"');
  const uploadProgress = html.indexOf('id="uploadProgress"');
  const processProgress = html.match(/<details id="processProgress"[^>]+>/)?.[0] || '';
  const documentsHeader = html.indexOf('登録済み文書');

  assert.ok(searchHeader < verify && verify < textPanel);
  assert.ok(textPanel < searchProgress && searchProgress < searchResults);
  assert.doesNotMatch(progressMarkup, /cancelCurrentSearch|キャンセル/);
  assert.match(progressMarkup, /class="search-agent-progress retrieval-global-section"[\s\S]*<summary>/);
  assert.match(html, /VLM精密確認（時間がかかります）/);
  assert.ok(uploadHeader < uploadButton && uploadButton < uploadProgress && uploadProgress < documentsHeader);
  assert.match(processProgress, /style="margin: 16px 0 24px;"/);
});

test('確認操作は共通モーダルを経由する', async () => {
  let options;
  window.UIComponents = {
    showModal(received) {
      options = received;
      received.onConfirm();
    }
  };

  const confirmed = await utilsModule.showConfirmModal('公開しますか', '公開確認', {
    variant: 'warning',
    confirmText: '公開'
  });

  assert.equal(confirmed, true);
  assert.equal(options.title, '公開確認');
  assert.equal(options.variant, 'warning');
  const source = await readFile(new URL('../src/modules/retrieval-settings.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /window\.confirm|\bconfirm\s*\(/);
  assert.match(source, /utilsShowConfirmModal/);
});

test('設定タブはDB・検索・OCIの順で、再ランキングはOCI設定の末尾に置く', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  const source = await readFile(new URL('../src/modules/retrieval-settings.js', import.meta.url), 'utf8');
  const retrieval = html.indexOf('id="admin-tab-retrieval"');
  const oci = html.indexOf('id="admin-tab-settings"');
  const database = html.indexOf('id="admin-tab-database"');
  const enterpriseAi = html.indexOf('id="enterpriseAiModel"');
  const rerank = html.indexOf('id="rerankSettingsRoot"');
  const databasePanel = html.indexOf('id="tab-database"');
  const globalPanels = source.slice(source.indexOf('function renderGlobalPanels'), source.indexOf('function renderRerankSettings'));

  assert.ok(database < retrieval && retrieval < oci);
  assert.ok(enterpriseAi < rerank && rerank < databasePanel);
  assert.doesNotMatch(globalPanels, /OCIテキスト再ランキング/);
  assert.match(app, /loadOciSettings\(\), loadRerankSettings\(\)/);
  assert.doesNotMatch(source, /max_chunks_per_document|max_tokens_per_document|rerank-chunks|rerank-tokens/);
});

test('共通設定は問い合わせ整理を既定で有効にし、保存後も詳細を閉じない', async () => {
  const source = await readFile(new URL('../src/modules/retrieval-settings.js', import.meta.url), 'utf8');
  const models = await readFile(new URL('../../backend/app/rag/models.py', import.meta.url), 'utf8');
  const globalPanels = source.slice(source.indexOf('function renderGlobalPanels'), source.indexOf('function renderRerankSettings'));
  const saveHandlers = source.slice(source.indexOf("else if (action === 'save-mineru')"), source.indexOf('} catch (error)'));

  assert.match(models.slice(models.indexOf('class GlobalVlmSettings'), models.indexOf('class RetrievalWeights')), /query_enabled: bool = True/);
  assert.match(models, /class QueryExpansionSettings/);
  assert.doesNotMatch(globalPanels, /OCI Enterprise AI モデル|retrieval-model-status/);
  assert.match(globalPanels, /MinerUで内容を取得できないページで使用する/);
  assert.match(globalPanels, /検索バリエーション/);
  assert.match(globalPanels, /原文のみ/);
  assert.match(globalPanels, /ルールベース/);
  assert.match(globalPanels, /query-expansion-mode-llm/);
  assert.match(globalPanels, /enabled: false, llm_enabled: false/);
  assert.match(globalPanels, /ルールベース同義語/);
  assert.match(saveHandlers, /save-query-expansion/);
  assert.doesNotMatch(globalPanels, /低テキストページ/);
  assert.doesNotMatch(saveHandlers, /\brender\(\)/);
});

test('検索バリエーション設定はUIから保存できる', async () => {
  document.body.innerHTML = '<div id="retrievalSettingsRoot"></div>';
  window.UIComponents = { showToast() {} };
  const engine = { enabled: true, base_url: 'http://ocr.test/v1', model: 'model', api_key: '', dpi: 200, workers: 1 };
  const settings = {
    schema_ready: true,
    profiles: [1, 2, 3].map(slot_no => ({ slot_no, name: `Profile ${slot_no}`, enabled: slot_no === 1, extraction_prompt: 'Extract facts', apply_status: 'READY', pending_document_count: 0 })),
    mineru: { enabled: true, base_url: 'http://mineru.test', timeout_seconds: 1800 },
    ocr: { enabled: true, dots: engine, glm: engine, unlimited: engine },
    rerank: { enabled: true, model: 'rerank', candidate_count: 100, top_n: 30 },
    vlm: { query_enabled: false, verify_enabled: true, query_prompt: 'Query', verify_prompt: 'Verify' },
    query_expansion: { enabled: true, llm_enabled: false, max_variants: 3, synonym_groups: [['浴室換気乾燥機', '浴乾']] },
    weights: { oracle_text: 1, text_vector: 1, visual_vector: 1, vlm_text: 1, vlm_vector: 1 },
    vlm_model: 'vlm'
  };
  let savedBody;
  let resolveSave;
  const saved = new Promise(resolve => { resolveSave = resolve; });
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/query-expansion') && options.method === 'PUT') {
      savedBody = JSON.parse(options.body);
      resolveSave();
      return { ok: true, status: 200, json: async () => savedBody };
    }
    return { ok: true, status: 200, json: async () => settings };
  };

  await retrievalSettingsModule.loadRetrievalSettings();
  document.getElementById('query-expansion-mode-llm').checked = true;
  document.getElementById('query-expansion-max').value = '4';
  document.getElementById('query-expansion-synonyms').value = '浴室換気乾燥機, 浴乾\n200V\n1室換気、1室';
  document.querySelector('[data-action="save-query-expansion"]').click();
  await saved;

  assert.equal(savedBody.enabled, true);
  assert.equal(savedBody.llm_enabled, true);
  assert.equal(savedBody.max_variants, 4);
  assert.deepEqual(savedBody.synonym_groups, [['浴室換気乾燥機', '浴乾'], ['1室換気', '1室']]);
});

test('検索バリエーションは原文のみモードを保存できる', async () => {
  document.body.innerHTML = '<div id="retrievalSettingsRoot"></div>';
  window.UIComponents = { showToast() {} };
  const engine = { enabled: true, base_url: 'http://ocr.test/v1', model: 'model', api_key: '', dpi: 200, workers: 1 };
  const settings = {
    schema_ready: true,
    profiles: [1, 2, 3].map(slot_no => ({ slot_no, name: `Profile ${slot_no}`, enabled: slot_no === 1, extraction_prompt: 'Extract facts', apply_status: 'READY', pending_document_count: 0 })),
    mineru: { enabled: true, base_url: 'http://mineru.test', timeout_seconds: 1800 },
    ocr: { enabled: true, dots: engine, glm: engine, unlimited: engine },
    rerank: { enabled: true, model: 'rerank', candidate_count: 100, top_n: 30 },
    vlm: { query_enabled: false, verify_enabled: true, query_prompt: 'Query', verify_prompt: 'Verify' },
    query_expansion: { enabled: true, llm_enabled: true, max_variants: 3, synonym_groups: [['浴室換気乾燥機', '浴乾']] },
    weights: { oracle_text: 1, text_vector: 1, visual_vector: 1, vlm_text: 1, vlm_vector: 1 },
    vlm_model: 'vlm'
  };
  let savedBody;
  let resolveSave;
  const saved = new Promise(resolve => { resolveSave = resolve; });
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/query-expansion') && options.method === 'PUT') {
      savedBody = JSON.parse(options.body);
      resolveSave();
      return { ok: true, status: 200, json: async () => savedBody };
    }
    return { ok: true, status: 200, json: async () => settings };
  };

  await retrievalSettingsModule.loadRetrievalSettings();
  document.getElementById('query-expansion-mode-off').checked = true;
  document.querySelector('[data-action="save-query-expansion"]').click();
  await saved;

  assert.equal(savedBody.enabled, false);
  assert.equal(savedBody.llm_enabled, false);
});

test('ステータスのポーリングは再描画せず、開いた詳細と編集内容を保持する', async () => {
  const source = await readFile(new URL('../src/modules/retrieval-settings.js', import.meta.url), 'utf8');
  const poll = source.slice(source.indexOf('function scheduleStatusRefresh'), source.indexOf('function bindEvents'));

  assert.doesNotMatch(poll, /\brender\(\)/);
  assert.match(poll, /apply_status/);
  assert.match(poll, /retrieval-pending-summary/);
});

test('VLMプロファイルは抽出プロンプト以外の検索設定を持たない', async () => {
  const source = await readFile(new URL('../src/modules/retrieval-settings.js', import.meta.url), 'utf8');
  const profilePanel = source.slice(source.indexOf('function renderProfilePanel'), source.indexOf('function engineCard'));
  const profileTabs = source.slice(source.indexOf('function render()'), source.indexOf('function collectEngine'));

  assert.match(profilePanel, /抽出したい内容/);
  assert.match(profilePanel, /<details class="retrieval-test-details">\s*<summary>テスト用の画像（任意）<\/summary>/);
  assert.match(profilePanel, /保存して反映/);
  assert.match(profilePanel, /テスト用の画像（任意）/);
  assert.match(profilePanel, /border-2 border-dashed border-gray-300/);
  assert.match(profilePanel, /handleDropForInput\(event, 'profile-test-image'\)/);
  assert.match(profilePanel, /profile-test-image-name/);
  assert.ok(profilePanel.indexOf('profile-enabled') < profilePanel.indexOf('profile-prompt'));
  assert.doesNotMatch(profilePanel, /profile-name|profile-test-text|ページテキスト|VLM抽出プロファイル|最終反映/);
  assert.doesNotMatch(profileTabs, /<small>|使用中|停止中/);
  assert.doesNotMatch(source, /page_text/);
  assert.match(source, /if \(action === 'test-profile'.*utilsShowToast\('テスト用の画像を選択してください', 'warning'\);\s*return;/s);
  assert.ok(source.indexOf("utilsShowToast('テスト用の画像を選択してください'") < source.indexOf('utilsShowLoading(', source.indexOf('function bindEvents')));
  assert.doesNotMatch(profilePanel, /MinerU|OCR|oracle_text|text_vector|visual_vector|profile-weight|対象範囲|フィールド定義|関係定義|同義語/);
});

test('検索ルート重みは相対倍率として表示する', async () => {
  const source = await readFile(new URL('../src/modules/retrieval-settings.js', import.meta.url), 'utf8');
  const weightPanel = source.slice(
    source.indexOf('<section class="retrieval-card"><h3>検索ルートの重み'),
    source.indexOf('data-action="save-weights"')
  );

  assert.match(weightPanel, /合計1不要/);
  assert.match(weightPanel, /0で無効/);
  assert.match(weightPanel, /有効Profile数で配分/);
  assert.ok(weightPanel.indexOf("['oracle_text'") < weightPanel.indexOf("['text_vector'"));
  assert.ok(weightPanel.indexOf("['text_vector'") < weightPanel.indexOf("['vlm_text'"));
  assert.ok(weightPanel.indexOf("['vlm_text'") < weightPanel.indexOf("['vlm_vector'"));
  assert.ok(weightPanel.indexOf("['vlm_vector'") < weightPanel.indexOf("['visual_vector'"));
});

test('長時間処理のheartbeatは進捗UIを更新する', async () => {
  const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  const documentModule = await readFile(new URL('../src/modules/document.js', import.meta.url), 'utf8');
  const uploadStream = app.slice(app.indexOf('async function processUploadStreamingResponse'), app.indexOf('function updateFileUploadStatus'));
  const documentStream = documentModule.slice(documentModule.indexOf('async function processStreamingResponse'), documentModule.indexOf('function updateLoadingMessage'));

  assert.match(uploadStream, /case 'heartbeat':/);
  assert.match(uploadStream, /updateFileUploadStatus/);
  assert.match(uploadStream, /updateUploadOverallStatus/);
  assert.match(documentStream, /case 'heartbeat':/);
  assert.match(documentStream, /updateProcessProgressUI/);
  assert.match(documentStream, /updateLoadingMessage/);
  assert.match(documentStream, /索引処理 \$\{currentPageIndex\}\/\$\{totalPages\}/);
  assert.doesNotMatch(documentStream, /ページ \$\{currentPageIndex\}\/\$\{totalPages\} をベクトル化中/);
});

test('接続テストのエラーは操作したサービスカード内に表示する', async () => {
  document.body.innerHTML = '<div id="retrievalSettingsRoot"></div>';
  window.UIComponents = { showToast() {} };
  const engine = { enabled: true, base_url: 'http://ocr.test/v1', model: 'model', api_key: '', dpi: 200, workers: 1 };
  const settings = {
    schema_ready: true,
    profiles: [1, 2, 3].map(slot_no => ({ slot_no, name: `Profile ${slot_no}`, enabled: slot_no === 1, extraction_prompt: 'Extract facts', apply_status: 'READY', pending_document_count: 0 })),
    mineru: { enabled: true, base_url: 'http://mineru.test', timeout_seconds: 1800 },
    ocr: { enabled: true, dots: engine, glm: engine, unlimited: engine },
    rerank: { enabled: true, model: 'rerank', candidate_count: 100, top_n: 30 },
    vlm: { query_enabled: false, verify_enabled: true, query_prompt: 'Query', verify_prompt: 'Verify' },
    weights: { oracle_text: 1, text_vector: 1, visual_vector: 1, vlm_text: 1, vlm_vector: 1 },
    vlm_model: 'vlm'
  };
  globalThis.fetch = async url => String(url).endsWith('/ocr/test/dots')
    ? { ok: false, status: 502, json: async () => ({ detail: 'Dots connection failed' }) }
    : { ok: true, status: 200, json: async () => settings };

  await retrievalSettingsModule.loadRetrievalSettings();
  document.querySelector('[data-action="test-ocr"][data-engine="dots"]').click();
  await new Promise(resolve => setTimeout(resolve, 0));

  const dotsCard = document.querySelector('[data-ocr-engine="dots"]');
  assert.equal(dotsCard.querySelector('.retrieval-inline-error').textContent, 'Dots connection failed');
  assert.equal(document.getElementById('profile-inline-error').hidden, true);
});

test('OCR設定保存は主スイッチと各エンジンのfalseを送る', async () => {
  document.body.innerHTML = '<div id="retrievalSettingsRoot"></div>';
  window.UIComponents = { showToast() {} };
  const engine = { enabled: true, base_url: 'http://ocr.test/v1', model: 'model', api_key: '', dpi: 200, workers: 1 };
  const settings = {
    schema_ready: true,
    profiles: [1, 2, 3].map(slot_no => ({ slot_no, name: `Profile ${slot_no}`, enabled: slot_no === 1, extraction_prompt: 'Extract facts', apply_status: 'READY', pending_document_count: 0 })),
    mineru: { enabled: true, base_url: 'http://mineru.test', timeout_seconds: 1800 },
    ocr: { enabled: true, dots: engine, glm: engine, unlimited: engine },
    rerank: { enabled: true, model: 'rerank', candidate_count: 100, top_n: 30 },
    vlm: { query_enabled: false, verify_enabled: true, query_prompt: 'Query', verify_prompt: 'Verify' },
    weights: { oracle_text: 1, text_vector: 1, visual_vector: 1, vlm_text: 1, vlm_vector: 1 },
    vlm_model: 'vlm'
  };
  let savedBody;
  let resolveSave;
  const saved = new Promise(resolve => { resolveSave = resolve; });
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/ocr') && options.method === 'PUT') {
      savedBody = JSON.parse(options.body);
      resolveSave();
      return { ok: true, status: 200, json: async () => savedBody };
    }
    return { ok: true, status: 200, json: async () => settings };
  };

  await retrievalSettingsModule.loadRetrievalSettings();
  for (const id of ['ocr-enabled', 'ocr-dots-enabled', 'ocr-glm-enabled', 'ocr-unlimited-enabled']) {
    document.getElementById(id).checked = false;
  }
  document.querySelector('[data-action="save-ocr"]').click();
  await saved;

  assert.equal(savedBody.enabled, false);
  assert.equal(savedBody.dots.enabled, false);
  assert.equal(savedBody.glm.enabled, false);
  assert.equal(savedBody.unlimited.enabled, false);
});

test('起動時のフィルター取得は認証確認後に限定される', async () => {
  const source = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  const authCheck = source.indexOf('await authCheckLoginStatus()');
  const filterLoad = source.indexOf('await loadDynamicSearchFilters()', authCheck);
  assert.ok(authCheck >= 0 && filterLoad > authCheck);
  assert.match(source.slice(authCheck, filterLoad), /isLoggedIn.*requireLogin/s);
});

test('システムテーブルの初期化状態をDB管理画面に表示する', async () => {
  document.body.innerHTML = `
    <span id="systemTablesStatusBadge"></span>
    <div id="systemTablesSummary"></div>
  `;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({
      success: true,
      status: 'ready',
      existing_count: 19,
      total_count: 19,
      missing_tables: []
    })
  });

  const result = await dbModule.loadSystemTableStatus();

  assert.equal(result.status, 'ready');
  assert.equal(document.getElementById('systemTablesStatusBadge').textContent, '初期化済み');
  assert.match(document.getElementById('systemTablesSummary').textContent, /19\/19/);
});

test('システムテーブル再作成は共通確認とサーバー側確認語を使う', async () => {
  const source = await readFile(new URL('../src/modules/db.js', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /window\.confirm|\bconfirm\s*\(/);
  assert.match(source, /utilsShowConfirmModal/);
  assert.match(source, /confirmation=RECREATE/);
});

test('テーブル一覧の統計更新は長時間処理として待つ', async () => {
  const source = await readFile(new URL('../src/modules/document.js', import.meta.url), 'utf8');
  const refresh = source.slice(source.indexOf('export async function refreshDbTables'));

  assert.match(refresh, /await loadDbTables\(\)/);
  assert.match(refresh, /tables\/refresh-statistics/);
  assert.match(refresh, /timeout:\s*180000/);
});
