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

test('新しい共有検索の有効状態でも最小ベクトル類似度を有効のままにする', async () => {
  document.body.innerHTML = `
    <fieldset id="dynamicSearchFilters" hidden><div id="dynamicSearchFilterFields"></div></fieldset>
    <label id="minScoreLabel" for="minScore">最小ベクトル類似度</label><input id="minScore" value="0.35">
    <input id="imageSearchQuery">
  `;
  const responses = [
    { v2_retrieval_active: true, fields: [] },
    { v2_retrieval_active: false, fields: [] }
  ];
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => responses.shift() });

  await searchModule.loadDynamicSearchFilters();
  assert.equal(document.getElementById('minScore').disabled, false);
  assert.equal(document.getElementById('dynamicSearchFilters').hidden, true);
  assert.equal(document.getElementById('minScoreLabel').textContent, '最小ベクトル類似度');

  await searchModule.loadDynamicSearchFilters();
  assert.equal(document.getElementById('minScore').disabled, false);
  assert.equal(document.getElementById('dynamicSearchFilters').hidden, true);
});

test('検索画面は共通の5カテゴリを初期選択で表示する', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const page = new JSDOM(html);
  const fieldset = page.window.document.getElementById('searchRetrievalModes');
  const inputs = [...fieldset.querySelectorAll('input[name="retrievalMode"]')];
  const minScore = page.window.document.getElementById('minScore');

  assert.equal(fieldset.tagName, 'FIELDSET');
  assert.equal(fieldset.querySelector('legend').textContent.trim(), '検索方式');
  assert.deepEqual(inputs.map(input => input.value), [
    'visual_vector', 'oracle_text', 'text_vector', 'vlm_text', 'vlm_vector'
  ]);
  assert.equal(inputs.every(input => input.checked), true);
  assert.equal(page.window.document.getElementById('minScoreLabel').textContent, '最小ベクトル類似度');
  assert.equal(minScore.value, '0.35');
  assert.equal(minScore.getAttribute('aria-describedby'), 'minScoreHelp');
  assert.match(page.window.document.getElementById('minScoreHelp').textContent, /1 − COSINE距離/);
});

test('検索方式の利用可否と無効理由をフィルターAPIから反映する', async () => {
  document.body.innerHTML = `
    <fieldset id="dynamicSearchFilters" hidden><div id="dynamicSearchFilterFields"></div></fieldset>
    <fieldset id="searchRetrievalModes">
      ${['oracle_text', 'text_vector', 'vlm_text', 'vlm_vector', 'visual_vector'].map(value => `
        <label class="search-retrieval-mode-option"><input type="checkbox" name="retrievalMode" value="${value}" checked><span><strong></strong><small data-mode-description></small><small data-mode-status hidden></small></span></label>
      `).join('')}
    </fieldset>
    <p id="searchRetrievalModesError" hidden></p>
    <input id="imageSearchQuery">
  `;
  const options = ['oracle_text', 'text_vector', 'vlm_text', 'vlm_vector', 'visual_vector'].map(value => ({
    value,
    label: value,
    description: `${value} description`,
    available: value !== 'visual_vector',
    unavailable_reason: value === 'visual_vector' ? '管理者設定で重みが0になっています。' : null
  }));
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ v2_retrieval_active: true, fields: [], retrieval_modes: options })
  });

  await searchModule.loadDynamicSearchFilters();

  const visual = document.querySelector('input[value="visual_vector"]');
  assert.equal(document.querySelector('input[value="oracle_text"]').checked, true);
  assert.equal(visual.disabled, true);
  assert.equal(visual.checked, false);
  assert.match(visual.closest('label').textContent, /重みが0/);
});

test('検索方式が未選択なら送信せずインラインエラーを表示する', async () => {
  document.body.innerHTML = `
    <fieldset id="searchRetrievalModes">
      <input type="checkbox" name="retrievalMode" value="oracle_text">
      <input type="checkbox" name="retrievalMode" value="text_vector">
      <input type="checkbox" name="retrievalMode" value="vlm_text">
      <input type="checkbox" name="retrievalMode" value="vlm_vector">
      <input type="checkbox" name="retrievalMode" value="visual_vector">
    </fieldset>
    <p id="searchRetrievalModesError" role="alert" hidden></p>
    <textarea id="searchQuery">照明</textarea>
    <input id="filenameFilter" value=""><input id="topK" value="10"><input id="minScore" value="0.35">
    <button id="textSearchSubmitBtn"><span>検索実行</span></button>
  `;
  let fetchCalls = 0;
  window.UIComponents = { showToast() {} };
  globalThis.fetch = async () => { fetchCalls += 1; throw new Error('must not fetch'); };

  await searchModule.performSearch();

  assert.equal(fetchCalls, 0);
  assert.equal(document.getElementById('searchRetrievalModes').getAttribute('aria-invalid'), 'true');
  assert.equal(document.getElementById('searchRetrievalModesError').hidden, false);
  assert.match(document.getElementById('searchRetrievalModesError').textContent, /1つ以上/);
});

test('検索方式の選択はタブ切替とクリア後も維持する', () => {
  document.body.innerHTML = `
    <button id="searchTypeTextTab"></button><button id="searchTypeImageTab"></button>
    <div id="textSearchPanel"></div><div id="imageSearchPanel"></div>
    <fieldset id="searchRetrievalModes"><input id="keptMode" type="checkbox" name="retrievalMode" value="oracle_text"><input id="selectedMode" type="checkbox" name="retrievalMode" value="visual_vector" checked></fieldset>
    <p id="searchRetrievalModesError" hidden></p>
    <textarea id="searchQuery">照明</textarea><input id="imageSearchQuery" value="条件"><input id="searchImageInput">
    <div id="imageSearchPreview"></div><div id="imageSearchPlaceholder"></div>
    <div id="searchResults"></div><details id="searchAgentProgress"></details>
  `;

  searchModule.switchSearchType('image');
  searchModule.clearSearchResults();

  assert.equal(document.getElementById('keptMode').checked, false);
  assert.equal(document.getElementById('selectedMode').checked, true);
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
    <label id="minScoreLabel" for="minScore">最小ベクトル類似度</label><input id="minScore" value="0.35">
    <input id="imageSearchQuery">
    <input id="searchVlmVerify" type="checkbox">
    <fieldset id="searchRetrievalModes"><input type="checkbox" name="retrievalMode" value="oracle_text" checked><input type="checkbox" name="retrievalMode" value="visual_vector" checked></fieldset>
    <p id="searchRetrievalModesError" hidden></p>
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
    { type: 'STEP_STARTED', stepName: 'initialization', message: '検索を準備しています' },
    { type: 'STEP_FINISHED', stepName: 'initialization' },
    { type: 'STEP_STARTED', stepName: 'query_variants', message: '検索バリエーション生成' },
    { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/queryPlan', value: { variants: ['天井照明', 'ダウンライト'], query_expansion_source: 'deterministic' } }] },
    { type: 'STEP_FINISHED', stepName: 'query_variants' },
    { type: 'STEP_STARTED', stepName: 'keyword_plan', message: '検索キーワード生成' },
    { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/keywordPlan', value: { terms: ['天井', '照明', 'ダウンライト'], target: 'Oracle Text', max_terms: 20 } }] },
    { type: 'STEP_FINISHED', stepName: 'keyword_plan' },
    { type: 'STEP_STARTED', stepName: 'embedding', message: '検索ベクトルを作成しています' },
    { type: 'STEP_FINISHED', stepName: 'embedding' },
    { type: 'STEP_STARTED', stepName: 'retrieval', message: '候補取得' },
    { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/retrievalSummary', value: { channels: [{ channel: 'oracle_text', status: 'ok', count: 3, weight: 1 }] } }] },
    { type: 'STEP_FINISHED', stepName: 'retrieval' },
    { type: 'STEP_STARTED', stepName: 'candidate_merge', message: '候補統合' },
    { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/candidateMerge', value: { method: 'weighted_rrf', source_lists: 1, candidate_count: 1, limit: 100 } }] },
    { type: 'STEP_FINISHED', stepName: 'candidate_merge' },
    { type: 'STEP_STARTED', stepName: 'rerank', message: '再ランキング' },
    { type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/rerankSummary', value: { enabled: true, skipped: false, candidate_count: 1, top_n: 30, degraded: true } }] },
    { type: 'STEP_FINISHED', stepName: 'rerank' },
    { type: 'STEP_STARTED', stepName: 'llm_judge', message: 'LLMが最終候補を判定しています' },
    { type: 'STEP_FINISHED', stepName: 'llm_judge' },
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
  assert.equal(requestBody.min_score, 0.35);
  assert.deepEqual(requestBody.retrieval_modes, ['oracle_text', 'visual_vector']);
  assert.equal(requestBody.verify, false);
  assert.equal(document.getElementById('searchAgentProgress').hidden, false);
  assert.equal(document.getElementById('searchAgentProgress').open, false);
  assert.ok(document.querySelector('#searchAgentSteps details > summary'));
  const steps = document.getElementById('searchAgentSteps').textContent;
  assert.match(steps, /検索準備/);
  assert.match(steps, /検索バリエーション生成/);
  assert.match(steps, /検索キーワード生成/);
  assert.match(steps, /候補取得/);
  assert.match(steps, /候補統合/);
  assert.match(steps, /検索バリエーション/);
  assert.match(steps, /検索キーワード/);
  assert.match(steps, /対象: Oracle Text/);
  assert.match(steps, /ダウンライト/);
  assert.match(steps, /ルールベース/);
  assert.match(steps, /weighted_rrf/);
  assert.match(document.getElementById('searchAgentDetails').textContent, /rerank/);
  assert.doesNotMatch(steps, /検索意図/);
  assert.doesNotMatch(steps, /deterministic/);
  assert.doesNotMatch(steps, /AI整理キーワード\/検索語/);
  assert.doesNotMatch(steps, /検索語:/);
  assert.doesNotMatch(steps, /詳細は処理後に表示されます/);
  const stepItems = [...document.querySelectorAll('#searchAgentSteps .search-agent-step')];
  const findStep = label => stepItems.find(item => item.textContent.includes(label));
  for (const label of ['検索準備', 'ベクトル作成', 'LLM最終判定']) {
    const item = findStep(label);
    assert.ok(item);
    assert.equal(item.querySelector('details'), null);
    assert.equal(item.querySelector('.search-agent-step-static').tabIndex, -1);
    assert.match(item.textContent, /完了/);
  }
  for (const label of ['検索バリエーション生成', '検索キーワード生成', '候補取得', '候補統合', '再ランキング', '結果整形']) {
    assert.ok(findStep(label).querySelector('details'));
  }
  assert.match(document.getElementById('searchResultsSummary').textContent, /1ファイル/);
});

test('画像検索の分割SSEはheartbeatを無視して段階進捗を描画する', async () => {
  document.body.innerHTML = `
    <fieldset id="dynamicSearchFilters" hidden><div id="dynamicSearchFilterFields"></div></fieldset>
    <input id="imageSearchQuery"><input id="searchVlmVerify" type="checkbox">
    <fieldset id="searchRetrievalModes"><input type="checkbox" name="retrievalMode" value="text_vector" checked><input type="checkbox" name="retrievalMode" value="visual_vector" checked></fieldset>
    <p id="searchRetrievalModesError" hidden></p>
    <input id="filenameFilter" value=""><input id="topK" value="10"><input id="minScore" value="0.35">
    <button id="imageSearchSubmitBtn"><span>画像検索実行</span></button>
    <details id="searchAgentProgress" hidden><summary><span id="searchAgentStatus"></span><small id="searchAgentElapsed"></small></summary><ol id="searchAgentSteps"></ol><div id="searchAgentDetails" hidden></div></details>
    <div id="searchResults" style="display:none"><span id="searchResultsSummary"></span><div id="searchResultsList"></div></div>
  `;
  window.UIComponents = { showToast() {} };
  const result = {
    success: true,
    trace_id: 'image-trace',
    query: '',
    results: [{
      document_id: 'd1',
      file_name: 'lighting.pdf',
      object_name: 'lighting.pdf',
      bucket: 'bucket',
      score: 0.01,
      rerank_score: null,
      image_similarity_score: 0.923,
      profile_slots: [],
      evidence: [{
        evidence_id: 'e1',
        page_number: 2,
        asset_url: 'lighting_page_2.png',
        score: 0.01,
        rerank_score: null,
        image_similarity_score: 0.876,
        retrieval_channels: ['vector:page_image'],
        verification_status: 'not_requested'
      }]
    }],
    total_documents: 1,
    total_evidence: 1,
    processing_time: 0.12,
    diagnostics: { degraded: [] }
  };
  const eventChunks = [
    `data: ${JSON.stringify({ type: 'RUN_STARTED' })}\n\n`,
    `data: ${JSON.stringify({ type: 'STATE_SNAPSHOT', snapshot: { status: 'started', message: '検索開始', result: null } })}\n\n`,
    `data: ${JSON.stringify({ type: 'STEP_STARTED', stepName: 'initialization', message: '検索を準備しています' })}\n\n`,
    ': heartbeat\n\n',
    `data: ${JSON.stringify({ type: 'STEP_FINISHED', stepName: 'initialization' })}\n\n`,
    `data: ${JSON.stringify({ type: 'STEP_STARTED', stepName: 'embedding', message: '検索ベクトルを作成しています' })}\n\n`,
    `data: ${JSON.stringify({ type: 'STEP_FINISHED', stepName: 'embedding' })}\n\n`,
    `data: ${JSON.stringify({ type: 'STEP_STARTED', stepName: 'format_results', message: '検索結果を整形しています' })}\n\n`,
    `data: ${JSON.stringify({ type: 'STEP_FINISHED', stepName: 'format_results' })}\n\n`,
    `data: ${JSON.stringify({ type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/result', value: result }] })}\n\n`,
    `data: ${JSON.stringify({ type: 'RUN_FINISHED', result })}\n\n`
  ];
  let searchUrl;
  let requestBody;
  globalThis.fetch = async (url, options = {}) => {
    if (String(url).endsWith('/search/v2/filters')) {
      return { ok: true, status: 200, json: async () => ({ v2_retrieval_active: true, fields: [] }) };
    }
    searchUrl = String(url);
    requestBody = options.body;
    return {
      ok: true,
      status: 200,
      body: new ReadableStream({
        start(controller) {
          eventChunks.forEach(chunk => controller.enqueue(new TextEncoder().encode(chunk)));
          controller.close();
        }
      })
    };
  };

  const image = new window.File([new Uint8Array([1, 2, 3])], 'query.png', { type: 'image/png' });
  searchModule.handleSearchImageSelect({ target: { files: [image] } });
  searchModule.invalidateDynamicSearchFilters();
  await searchModule.performImageSearch();

  assert.match(searchUrl, /\/ai\/api\/search\/v2\/image\/events$/);
  assert.equal(requestBody.get('image').name, 'query.png');
  assert.equal(requestBody.get('min_score'), '0.35');
  assert.deepEqual(JSON.parse(requestBody.get('retrieval_modes')), ['text_vector', 'visual_vector']);
  assert.equal(document.getElementById('searchAgentProgress').hidden, false);
  const steps = document.getElementById('searchAgentSteps').textContent;
  assert.match(steps, /検索準備/);
  assert.match(steps, /ベクトル作成/);
  assert.match(steps, /結果整形/);
  assert.match(document.getElementById('searchResultsSummary').textContent, /1ファイル/);
  const resultText = document.getElementById('searchResultsList').textContent;
  assert.match(resultText, /画像類似度:\s*92\.3%/);
  assert.match(resultText, /画像類似度:\s*87\.6%/);
  assert.match(resultText, /画像類似度が高い順/);
  assert.doesNotMatch(resultText, /関連度:/);
  assert.doesNotMatch(resultText, /NaN/);
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
      match_percent: null,
      matched_images: []
    }],
    total_files: 1,
    total_images: 0,
    processing_time: 0.1
  });

  assert.equal(document.querySelector('.search-result-filename').textContent.trim(), '設備・内装商品カタログ2026年1月版.pdf');
  assert.equal(document.querySelector('.search-result-path'), null);
  assert.doesNotMatch(document.getElementById('searchResultsList').textContent, /20260709_215027_e18cabda_/);
  assert.match(document.getElementById('searchResultsList').textContent, /検索順位順/);
});

test('検索結果がない場合は最小ベクトル類似度を下げるよう案内する', async () => {
  document.body.innerHTML = `
    <input id="minScore" value="0.55">
    <div id="searchResults" style="display:none"><span id="searchResultsSummary"></span><div id="searchResultsList"></div></div>
  `;

  searchModule.displaySearchResults({ results: [] });

  assert.equal(document.getElementById('searchResultsSummary').textContent, '検索結果なし');
  assert.match(document.getElementById('searchResultsList').textContent, /最小ベクトル類似度（現在 0\.55）を下げる/);
});

test('画像類似度と関連度を別々に表示し、無いスコアのバッジは出さない', async () => {
  document.body.innerHTML = `
    <div id="searchResults" style="display:none"><span id="searchResultsSummary"></span><div id="searchResultsList"></div></div>
  `;

  searchModule.displaySearchResults({
    result_order: 'image_similarity',
    results: [{
      file_id: 'd1',
      bucket: 'bucket',
      object_name: 'a.pdf',
      original_filename: 'a.pdf',
      match_percent: 87.3,
      image_similarity_percent: 91.2,
      matched_images: [{
        embed_id: 'e1',
        bucket: 'bucket',
        object_name: 'a_p3.png',
        page_number: 3,
        match_percent: 87.3,
        image_similarity_percent: 84.6,
        url: '/ai/api/object/bucket/a_p3.png'
      }]
    }, {
      file_id: 'd2',
      bucket: 'bucket',
      object_name: 'b.pdf',
      original_filename: 'b.pdf',
      match_percent: null,
      image_similarity_percent: null,
      matched_images: []
    }],
    total_files: 2,
    total_images: 1,
    processing_time: 0.1
  });

  const text = document.getElementById('searchResultsList').textContent;
  assert.match(text, /関連度: 87\.3%/);
  assert.match(text, /画像類似度: 91\.2%/);
  assert.match(text, /画像類似度: 84\.6%/);
  assert.match(text, /画像類似度が高い順/);
  assert.doesNotMatch(text, /マッチ度/);
  assert.doesNotMatch(text, /距離:/);
  const cards = document.querySelectorAll('.search-result-card');
  assert.doesNotMatch(cards[1].textContent, /関連度:/);
  assert.doesNotMatch(cards[1].textContent, /画像類似度:/);
});

test('AG-UI検索エラー後も入力と操作状態を保持する', async () => {
  document.body.innerHTML = `
    <fieldset id="dynamicSearchFilters" hidden><div id="dynamicSearchFilterFields"></div></fieldset>
    <label id="minScoreLabel" for="minScore">最小ベクトル類似度</label><input id="minScore">
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
    <label id="minScoreLabel" for="minScore">最小ベクトル類似度</label><input id="minScore">
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
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'STEP_STARTED', stepName: 'initialization', message: '検索を準備しています' })}\n\n`));
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
    const runningStep = document.querySelector('#searchAgentSteps .search-agent-step');
    assert.match(runningStep.textContent, /検索準備/);
    assert.match(runningStep.textContent, /処理中/);
    assert.equal(runningStep.querySelector('details'), null);
    assert.equal(runningStep.querySelector('.search-agent-step-static').tabIndex, -1);
    assert.doesNotMatch(runningStep.textContent, /詳細は処理後に表示されます/);

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

test('問い合わせ整理を持たずLLM検索バリエーションと画像確認を設定する', async () => {
  const source = await readFile(new URL('../src/modules/retrieval-settings.js', import.meta.url), 'utf8');
  const models = await readFile(new URL('../../backend/app/rag/models.py', import.meta.url), 'utf8');
  const globalPanels = source.slice(source.indexOf('function renderGlobalPanels'), source.indexOf('function renderRerankSettings'));
  const saveHandlersStart = source.indexOf("else if (action === 'save-mineru')");
  const saveHandlers = source.slice(saveHandlersStart, source.indexOf('} catch (error)', saveHandlersStart));

  assert.match(models, /class QueryExpansionSettings/);
  assert.doesNotMatch(models, /query_enabled|query_prompt/);
  assert.doesNotMatch(globalPanels, /OCI Enterprise AI モデル|retrieval-model-status/);
  assert.match(globalPanels, /MinerUで内容を取得できないページで使用する/);
  assert.match(globalPanels, /検索バリエーション/);
  assert.match(globalPanels, /原文のみ/);
  assert.match(globalPanels, /ルールベース/);
  assert.match(globalPanels, /query-expansion-mode-llm/);
  assert.match(globalPanels, /enabled: false, llm_enabled: false/);
  assert.match(globalPanels, /ルールベース同義語/);
  assert.match(globalPanels, /LLM検索バリエーションの指示/);
  assert.match(globalPanels, /VLMの画像確認/);
  assert.doesNotMatch(globalPanels, /問い合わせ整理/);
  assert.doesNotMatch(globalPanels, /画像確認を使用する|vlm-verify-enabled/);
  assert.match(globalPanels, /検索画面の「VLM精密確認」/);
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
    vlm: { verify_prompt: 'Verify' },
    query_expansion: { enabled: true, llm_enabled: false, max_variants: 3, llm_prompt: 'Expand', synonym_groups: [['浴室換気乾燥機', '浴乾']] },
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
  document.getElementById('query-expansion-llm-prompt').value = 'Create variants';
  document.getElementById('query-expansion-synonyms').value = '浴室換気乾燥機, 浴乾\n200V\n1室換気、1室';
  document.querySelector('[data-action="save-query-expansion"]').click();
  await saved;

  assert.equal(savedBody.enabled, true);
  assert.equal(savedBody.llm_enabled, true);
  assert.equal(savedBody.max_variants, 4);
  assert.equal(savedBody.llm_prompt, 'Create variants');
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
    vlm: { verify_prompt: 'Verify' },
    query_expansion: { enabled: true, llm_enabled: true, max_variants: 3, llm_prompt: 'Expand', synonym_groups: [['浴室換気乾燥機', '浴乾']] },
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
  assert.ok(weightPanel.indexOf("['visual_vector'") < weightPanel.indexOf("['oracle_text'"));
  assert.ok(weightPanel.indexOf("['oracle_text'") < weightPanel.indexOf("['text_vector'"));
  assert.ok(weightPanel.indexOf("['text_vector'") < weightPanel.indexOf("['vlm_text'"));
  assert.ok(weightPanel.indexOf("['vlm_text'") < weightPanel.indexOf("['vlm_vector'"));
});

test('Embeddingレシピの設定UIを提供しない', async () => {
  const source = await readFile(new URL('../src/modules/retrieval-settings.js', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /Embeddingレシピ/);
  assert.doesNotMatch(source, /embedding-recipes/);
  assert.doesNotMatch(source, /embedding_recipes/);
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
    vlm: { verify_prompt: 'Verify' },
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
    vlm: { verify_prompt: 'Verify' },
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

test('Object Storage一覧は既定の10秒で中断しない', async () => {
  const source = await readFile(new URL('../src/modules/document.js', import.meta.url), 'utf8');
  const load = source.slice(
    source.indexOf('export async function loadOciObjects'),
    source.indexOf('export function displayOciObjectsList')
  );

  assert.match(load, /authApiCall\(`\/ai\/api\/oci\/objects\?\$\{params\}`,\s*\{\s*timeout:\s*180000\s*\}\)/s);
});

test('文書管理は一括処理と独立ステージを同じ操作群に表示する', async () => {
  const source = await readFile(new URL('../src/modules/document.js', import.meta.url), 'utf8');
  const entrypoint = await readFile(new URL('../app.js', import.meta.url), 'utf8');
  const styles = await readFile(new URL('../src/style.css', import.meta.url), 'utf8');
  assert.match(source, /すべて処理 \(\$\{selectedOciObjects\.length\}件\)/);
  for (const label of ['ページ画像を再生成', '前処理・解析', 'VLMを再実行', 'Embeddingを再生成', '検索へ反映']) {
    assert.match(source, new RegExp(label));
  }
  assert.doesNotMatch(source, /OCRを再実行/);
  assert.ok(
    source.indexOf('ページ画像を再生成') < source.indexOf('前処理・解析'),
    'ページ画像を再生成が前処理・解析より先に表示される'
  );
  const pipelineSource = await readFile(new URL('../src/modules/pipeline.js', import.meta.url), 'utf8');
  assert.match(pipelineSource, /'PREPROCESS'[\s\S]*?\{ kind: 'NATIVE_PARSE' \}, \{ kind: 'OCR' \},\s*\{ kind: 'NORMALIZE' \}/);
  assert.doesNotMatch(pipelineSource, /'PREPROCESS'[\s\S]{0,200}\{ kind: 'RENDER' \}/);
  assert.match(source, /role="menu"/);
  assert.match(source, /aria-expanded/);
  assert.doesNotMatch(source, /pipeline-stage-menu-group/);
  assert.doesNotMatch(styles, /pipeline-stage-menu-group/);
  assert.match(source, /\/page-images\?release=/);
  assert.match(source, /page-image-child-row/);
  // 子行はサムネイルクリックでプレビュー（専用リンクなし）、ステータスはファイル行に集約（子行バッジなし）
  assert.doesNotMatch(source, /page-image-preview-link/);
  assert.doesNotMatch(source, /pageImageStageBadge|pageImageReleaseBadge/);
  assert.match(styles, /\.page-image-expand-button\[aria-expanded=true\]/);
  assert.doesNotMatch(source, /\/oci\/objects\/convert-to-images/);
  assert.doesNotMatch(entrypoint, /isGeneratedPageImage|convertSelectedOciObjectsToImages|convertToImages/);
});

test('パイプラインタスクは永続IDを復元し、キャンセルと失敗項目再試行を提供する', async () => {
  const source = await readFile(new URL('../src/modules/pipeline.js', import.meta.url), 'utf8');
  const auth = await readFile(new URL('../src/modules/auth.js', import.meta.url), 'utf8');
  assert.match(source, /sdsPipelineJobIds/);
  assert.match(source, /restorePipelineJobs/);
  assert.match(source, /\/pipeline\/jobs\/.*\/cancel/);
  assert.match(source, /\/pipeline\/jobs\/.*\/retry/);
  assert.match(source, /Idempotency-Key/);
  assert.match(source, /poll_error/);
  assert.doesNotMatch(source, /status: 'FAILED', failed_steps: 1/);
  assert.match(source, /job\.job_ids/);
  assert.match(auth, /window\.pipelineModule\?\.restore/);
});

test('生成する両方のNginx API設定はSSEレスポンスをバッファしない', async () => {
  const source = await readFile(new URL('../../init_script.sh', import.meta.url), 'utf8');
  const apiLocations = [
    ...source.matchAll(/location \/ai\/api\/ \{([\s\S]*?)\n    \}/g)
  ].map(match => match[1]);

  assert.equal(apiLocations.length, 2);
  for (const location of apiLocations) {
    assert.match(location, /proxy_buffering off;/);
    assert.match(location, /proxy_cache off;/);
  }
});
