import { appState, getSelectedOciObjects } from '../state.js';
import { apiCall as authApiCall } from './auth.js';
import { showConfirmModal, showToast } from './utils.js';

const STORAGE_KEY = 'sdsPipelineJobIds';
const TERMINAL = new Set(['SUCCEEDED', 'PARTIAL_FAILED', 'FAILED', 'CANCELLED']);
const AUTO_DISMISS_TERMINAL = new Set(['SUCCEEDED', 'CANCELLED']);
const jobs = new Map();
let pollTimer;
let pollFailureCount = 0;
let trayDismissed = false;

// The document list is also rendered in a few unauthenticated/SSR contexts
// (for example while the login screen is bootstrapping).  Keep persistence
// best-effort so a missing or blocked Storage implementation never prevents
// the processing controls from rendering.
function storage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const escapeHtml = value => String(value ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#039;');

function openDialog(dialog) {
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

function persistJobs() {
  const ids = [...jobs.keys()].slice(-20);
  appState.set('pipelineJobIds', ids);
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Storage quota/privacy mode must not interrupt a running pipeline.
  }
}

function pruneFinishedJobs() {
  let removed = false;
  for (const [jobId, job] of jobs) {
    if (AUTO_DISMISS_TERMINAL.has(job.status)) {
      jobs.delete(jobId);
      removed = true;
    }
  }
  return removed;
}

function statusLabel(status) {
  return {
    QUEUED: '待機中', RUNNING: '処理中', SUCCEEDED: '完了',
    PARTIAL_FAILED: '一部失敗', FAILED: '失敗', CANCELLED: 'キャンセル済み'
  }[status] || status;
}

function statusClass(status) {
  if (status === 'SUCCEEDED') return 'success';
  if (status === 'RUNNING') return 'running';
  if (status === 'FAILED' || status === 'PARTIAL_FAILED') return 'error';
  return 'neutral';
}

function ensureTray() {
  let tray = document.getElementById('pipelineJobTray');
  if (tray) return tray;
  tray = document.createElement('aside');
  tray.id = 'pipelineJobTray';
  tray.className = 'pipeline-job-tray';
  tray.setAttribute('aria-label', '文書処理タスク');
  tray.innerHTML =
    '<div class="pipeline-job-tray-header">' +
      '<div><strong>処理タスク</strong><span id="pipelineJobCount" aria-live="polite"></span></div>' +
      '<button type="button" class="pipeline-icon-button" data-pipeline-action="close-tray" aria-label="処理タスクを閉じる"><i class="fas fa-times" aria-hidden="true"></i></button>' +
    '</div><div id="pipelineJobList" class="pipeline-job-list"></div>';
  tray.addEventListener('click', async event => {
    const button = event.target.closest('[data-pipeline-action]');
    if (!button) return;
    const action = button.dataset.pipelineAction;
    const jobId = button.dataset.jobId;
    if (action === 'close-tray') {
      trayDismissed = true;
      tray.hidden = true;
    }
    if (action === 'cancel') await cancelJob(jobId);
    if (action === 'retry') await retryJob(jobId);
    if (action === 'refresh') pollJobs();
    if (action === 'details') {
      const details = tray.querySelector('[data-job-details="' + jobId + '"]');
      if (details) details.hidden = !details.hidden;
    }
  });
  document.body.appendChild(tray);
  return tray;
}

function jobHtml(job) {
  const completed = Number(job.completed_steps || 0);
  const failed = Number(job.failed_steps || 0);
  const total = Math.max(1, Number(job.total_steps || 0));
  const percent = Math.min(100, Math.round(((completed + failed) / total) * 100));
  const errors = (job.steps || []).filter(step => step.error_summary);
  const pollError = job.poll_error
    ? '<div class="pipeline-poll-warning" role="status"><span>状態を取得できません。自動的に再接続します。<small>' +
      escapeHtml(job.poll_error) + '</small></span><button type="button" data-pipeline-action="refresh" data-job-id="' +
      job.job_id + '">今すぐ再試行</button></div>'
    : '';
  const icon = job.status === 'RUNNING' ? 'fa-spinner fa-spin'
    : job.status === 'SUCCEEDED' ? 'fa-check-circle'
      : String(job.status).includes('FAILED') ? 'fa-exclamation-circle' : 'fa-clock';
  const actions = ['QUEUED', 'RUNNING'].includes(job.status)
    ? '<button type="button" data-pipeline-action="cancel" data-job-id="' + job.job_id + '">キャンセル</button>'
    : errors.length
      ? '<button type="button" data-pipeline-action="retry" data-job-id="' + job.job_id + '">失敗項目を再試行</button>' +
        '<button type="button" data-pipeline-action="details" data-job-id="' + job.job_id + '">エラー詳細</button>'
      : '';
  const errorHtml = errors.map(step =>
    '<p><strong>' + escapeHtml(step.object_name) + '</strong><br>' +
    escapeHtml(stepLabel(step.component_key)) + ': ' + escapeHtml(step.error_summary) + '</p>'
  ).join('');
  return '<article class="pipeline-job-card" data-status="' + escapeHtml(job.status) + '">' +
    '<div class="pipeline-job-card-title"><span class="pipeline-status ' + statusClass(job.status) + '">' +
    '<i class="fas ' + icon + '" aria-hidden="true"></i>' + statusLabel(job.status) + '</span>' +
    '<code title="' + escapeHtml(job.job_id) + '">' + escapeHtml(job.job_id.slice(0, 8)) + '</code></div>' +
    '<div class="pipeline-progress" role="progressbar" aria-label="処理進捗" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + percent + '"><span style="width:' + percent + '%"></span></div>' +
    '<p>' + (completed + failed) + '/' + total + '段階' + (failed ? '・失敗' + failed + '件' : '') + '</p>' +
    pollError + '<div class="pipeline-job-actions">' + actions + '</div>' +
    '<div class="pipeline-job-errors" data-job-details="' + job.job_id + '" hidden>' + errorHtml + '</div></article>';
}

function renderTray() {
  const tray = ensureTray();
  tray.hidden = jobs.size === 0 || trayDismissed;
  tray.querySelector('#pipelineJobCount').textContent = '（' + jobs.size + '件）';
  tray.querySelector('#pipelineJobList').innerHTML = [...jobs.values()].reverse().map(jobHtml).join('');
}

async function pollJobs() {
  clearTimeout(pollTimer);
  const active = [...jobs.entries()].filter(([, job]) => !TERMINAL.has(job.status));
  let hadFailure = false;
  await Promise.all(active.map(async ([jobId]) => {
    try {
      jobs.set(jobId, {
        ...await authApiCall('/ai/api/pipeline/jobs/' + encodeURIComponent(jobId)),
        poll_error: null
      });
    } catch (error) {
      hadFailure = true;
      jobs.set(jobId, {
        ...jobs.get(jobId), poll_error: error.message
      });
    }
  }));
  const reachedTerminal = active.some(([jobId]) => TERMINAL.has(jobs.get(jobId)?.status));
  pollFailureCount = hadFailure ? Math.min(pollFailureCount + 1, 4) : 0;
  pruneFinishedJobs();
  renderTray();
  persistJobs();
  const stillActive = [...jobs.values()].some(job => !TERMINAL.has(job.status));
  if (stillActive) {
    pollTimer = setTimeout(pollJobs, 2000 * (2 ** pollFailureCount));
  }
  if (reachedTerminal) window.ociModule?.loadOciObjects?.(false);
}

function rememberJob(job, startPolling = true) {
  if (!job?.job_id) return;
  trayDismissed = false;
  jobs.set(job.job_id, {
    job_id: job.job_id, status: job.status || 'QUEUED',
    total_steps: 1, completed_steps: 0, failed_steps: 0, steps: []
  });
  persistJobs();
  renderTray();
  if (startPolling) pollJobs();
}

export function trackPipelineJob(job) {
  const ids = Array.isArray(job?.job_ids) && job.job_ids.length
    ? job.job_ids
    : job?.job_id ? [job.job_id] : [];
  ids.forEach(jobId => rememberJob(
    { job_id: jobId, status: job.status || 'QUEUED' }, false
  ));
  if (ids.length) pollJobs();
}

export function showPipelineJobs() {
  const tray = ensureTray();
  trayDismissed = false;
  tray.hidden = jobs.size === 0;
  if (!jobs.size) showToast('表示できる処理タスクはありません', 'info');
}

function requestFor(action, key) {
  if (action === 'FULL') return { mode: 'FULL', steps: [], publish_mode: 'AUTO' };
  if (action === 'PREPROCESS') {
    return {
      mode: 'CUSTOM',
      steps: [
        { kind: 'NATIVE_PARSE' }, { kind: 'OCR' },
        { kind: 'NORMALIZE' }
      ],
      publish_mode: 'DRAFT'
    };
  }
  if (action === 'RENDER') {
    return {
      mode: 'CUSTOM',
      steps: [{ kind: 'RENDER' }],
      publish_mode: 'DRAFT'
    };
  }
  if (action === 'VLM') {
    const keys = Array.isArray(key) ? key : [key];
    return { mode: 'CUSTOM', steps: keys.map(k => ({ kind: 'VLM', key: String(k) })), publish_mode: 'DRAFT' };
  }
  if (action === 'EMBED') {
    const keys = Array.isArray(key) ? key : [key];
    return { mode: 'CUSTOM', steps: keys.map(k => ({ kind: 'EMBED', key: String(k) })), publish_mode: 'DRAFT' };
  }
  throw new Error('未対応の処理です');
}

const STEP_LABELS = {
  embedding: '埋め込み', vlm: 'VLM解析', ocr: 'OCR',
  normalize: '正規化', render: 'ページ画像', native_parse: 'テキスト抽出',
  mineru_parse: 'MinerU解析'
};

export function stepLabel(key) {
  const [kind, detail] = String(key).split(':');
  const label = STEP_LABELS[kind.toLowerCase()] || kind;
  return detail ? label + ' (' + detail + ')' : label;
}

// ドロップダウンメニューと同じ区分・順序で表示する（前処理系は1項目にまとめる）
const STEP_GROUPS = {
  render: [1, 'ページ画像を再生成'],
  native_parse: [2, '前処理・解析'], mineru_parse: [2, '前処理・解析'],
  ocr: [2, '前処理・解析'], normalize: [2, '前処理・解析'],
  vlm: [3, 'VLMを再実行'],
  embedding: [4, 'Embeddingを再生成']
};

function stepSummary(steps) {
  const groups = new Map();
  for (const step of steps || []) {
    const kind = String(step).split(':')[0].toLowerCase();
    const [order, label] = STEP_GROUPS[kind] || [99, kind];
    groups.set(label, order);
  }
  if (!groups.size) return 'なし';
  const labels = [...groups.entries()].sort((a, b) => a[1] - b[1]).map(([label]) => label);
  return '\n' + labels.map(label => '・' + label).join('\n');
}

function previewMessage(preview) {
  return preview.object_count + '件の文書を処理します。\n\n' +
    '自動補完する前提段階: ' + stepSummary(preview.prerequisite_steps) + '\n' +
    '更新対象になる下流段階: ' + stepSummary(preview.downstream_steps) + '\n' +
    'OCI呼び出し概算: ' + preview.estimated_oci_calls + '回（ページ数確定前）\n' +
    '検索への反映: ' + (preview.publish_mode === 'AUTO' ? '完了後に自動公開' : 'Draftとして保存') +
    '\n\n処理を開始しますか？';
}

function pageImagePreviewMessage(preview) {
  return preview.object_count + '件の文書をページごとのPNGに再生成します。\n\n' +
    '予想ページ数: ' + preview.estimated_pages + 'ページ（概算）\n' +
    '要更新になる下流段階: ' + stepSummary(preview.downstream_steps) + '\n' +
    '結果: Draftに保存\n' +
    '検索への反映: 自動では行いません\n\n処理を開始しますか？';
}

export async function runSelectedPipeline(action = 'FULL', key = null) {
  const objectNames = getSelectedOciObjects().filter(Boolean);
  if (!objectNames.length) {
    showToast('処理するファイルを選択してください', 'warning');
    return;
  }
  const request = {
    object_names: objectNames, ...requestFor(action, key),
    // Every document-management action is an explicit rerun.  FULL must also
    // bypass immutable stage caches so every enabled VLM profile and embedding
    // recipe is regenerated instead of silently retaining an older result.
    force: true, include_downstream: false
  };
  try {
    const preview = await authApiCall('/ai/api/pipeline/jobs/preview', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    });
    const confirmed = await showConfirmModal(
      action === 'RENDER' ? pageImagePreviewMessage(preview) : previewMessage(preview),
      action === 'FULL' ? 'すべての処理を実行'
        : action === 'RENDER' ? 'ページ画像を再生成'
          : '個別段階を実行',
      { variant: 'warning', confirmText: '実行', cancelText: 'キャンセル' }
    );
    if (!confirmed) return;
    const response = await authApiCall('/ai/api/pipeline/jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Idempotency is part of the API contract.  Older embedded browsers
        // do not expose crypto.randomUUID(), so retain a collision-resistant
        // fallback rather than dropping the header.
        'Idempotency-Key': createIdempotencyKey()
      },
      body: JSON.stringify(request)
    });
    rememberJob(response);
    appState.set('selectedOciObjects', []);
    showToast(objectNames.length + '件の処理を開始しました。タスク欄で進捗を確認できます', 'success');
    window.ociModule?.loadOciObjects?.(false);
  } catch (error) {
    showToast('文書処理を開始できませんでした: ' + error.message, 'error');
  }
}

export async function publishSelectedDrafts() {
  const names = getSelectedOciObjects();
  if (!names.length) {
    showToast('公開するファイルを選択してください', 'warning');
    return;
  }
  const objects = appState.get('allOciObjects') || [];
  const targets = names.map(name => objects.find(item => item.name === name)?.processing)
    .filter(item => item?.document_id && item?.draft_release_id);
  if (!targets.length) {
    showToast('選択した文書に公開可能なDraftがありません', 'warning');
    return;
  }
  const confirmed = await showConfirmModal(
    targets.length + '件のDraftを検証し、検索へ原子的に反映します。検証に失敗した文書は現在の公開版を継続します。',
    '検索へ反映',
    { variant: 'warning', confirmText: '検証して公開', cancelText: 'キャンセル' }
  );
  if (!confirmed) return;
  const results = await Promise.allSettled(targets.map(item => authApiCall(
    '/ai/api/documents/' + encodeURIComponent(item.document_id) +
      '/releases/' + encodeURIComponent(item.draft_release_id) + '/publish',
    { method: 'POST' }
  )));
  const failures = results.filter(item => item.status === 'rejected');
  const failed = failures.length;
  const firstFailure = failures[0]?.reason?.message;
  showToast(
    failed ? (targets.length - failed) + '件を公開しました。' + failed + '件は検証に失敗しました' +
      (firstFailure ? '：' + firstFailure : '')
      : targets.length + '件を検索へ反映しました',
    failed ? 'warning' : 'success'
  );
  window.ociModule?.loadOciObjects?.(false);
}

export async function chooseEmbeddingRecipe() {
  try {
    const recipes = await authApiCall('/ai/api/settings/retrieval/embedding-recipes');
    const enabled = recipes.filter(item => item.enabled);
    if (!enabled.length) {
      showToast('有効なEmbeddingレシピがありません', 'warning');
      return;
    }
    await runSelectedPipeline('EMBED', enabled.map(recipe => recipe.code));
  } catch (error) {
    showToast('Embeddingレシピを取得できませんでした: ' + error.message, 'error');
  }
}

function createIdempotencyKey() {
  try {
    if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  } catch {
    // Fall through to the portable value below.
  }
  return 'sds-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
}

/**
 * Select an enabled VLM profile at execution time.  Profiles are configurable
 * in Retrieval settings, so the menu must not assume a fixed set of slots.
 */
export async function chooseVlmProfile() {
  try {
    const settings = await authApiCall('/ai/api/settings/retrieval');
    const profiles = (settings?.profiles || []).filter(profile => profile.enabled);
    if (!profiles.length) {
      showToast('有効なVLMプロファイルがありません', 'warning');
      return;
    }
    if (profiles.length === 1) {
      await runSelectedPipeline('VLM', profiles[0].slot_no);
      return;
    }
    showVlmDialog(profiles);
  } catch (error) {
    showToast('VLMプロファイルを取得できませんでした: ' + error.message, 'error');
  }
}

function showVlmDialog(profiles) {
  document.getElementById('pipelineVlmDialog')?.remove();
  const dialog = document.createElement('dialog');
  dialog.id = 'pipelineVlmDialog';
  dialog.className = 'pipeline-recipe-dialog';
  dialog.setAttribute('aria-labelledby', 'pipelineVlmDialogTitle');
  const choices = profiles.map((profile, index) =>
    '<label><input type="checkbox" name="vlm-profile" value="' + escapeHtml(profile.slot_no) + '"' +
    (index === 0 ? ' checked' : '') + '><span><strong>プロファイル ' +
    escapeHtml(profile.slot_no) + '</strong><small>' +
    escapeHtml(profile.name || profile.extraction_prompt || 'VLM抽出設定') +
    '</small></span></label>'
  ).join('');
  dialog.innerHTML = '<form method="dialog"><h2 id="pipelineVlmDialogTitle">VLMを再実行</h2>' +
    '<p>再実行する有効なプロファイルを選択してください（複数選択可）。結果はDraftに保存されます。</p>' +
    '<div class="pipeline-recipe-list">' + choices + '</div>' +
    '<div class="pipeline-dialog-actions"><button value="cancel" class="apex-button-secondary">キャンセル</button>' +
    '<button value="run" class="apex-button">再実行</button></div></form>';
  dialog.addEventListener('close', () => {
    const values = new FormData(dialog.querySelector('form')).getAll('vlm-profile');
    if (dialog.returnValue === 'run') {
      if (values.length) runSelectedPipeline('VLM', values);
      else showToast('プロファイルを1つ以上選択してください', 'warning');
    }
    dialog.remove();
  });
  document.body.appendChild(dialog);
  openDialog(dialog);
}

export function togglePipelineMenu(force) {
  const menu = document.getElementById('pipelineStageMenu');
  const button = document.getElementById('pipelineStageMenuButton');
  if (!menu || !button) return;
  const open = typeof force === 'boolean' ? force : menu.hidden;
  menu.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
  if (open) {
    // 下に収まらず、かつ上に収まる場合のみ上向きに開く
    const rect = button.getBoundingClientRect();
    const spaceBelow = window.innerHeight - rect.bottom;
    menu.classList.toggle('drop-up',
      spaceBelow < menu.offsetHeight + 12 && rect.top > menu.offsetHeight + 12);
    menu.querySelector('button')?.focus();
  }
}

document.addEventListener('click', event => {
  const menu = document.getElementById('pipelineStageMenu');
  const button = document.getElementById('pipelineStageMenuButton');
  if (!menu || menu.hidden || menu.contains(event.target) || button?.contains(event.target)) return;
  togglePipelineMenu(false);
});

document.addEventListener('keydown', event => {
  const menu = document.getElementById('pipelineStageMenu');
  if (!menu || menu.hidden) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    togglePipelineMenu(false);
    document.getElementById('pipelineStageMenuButton')?.focus();
    return;
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const items = [...menu.querySelectorAll('[role="menuitem"]:not(:disabled)')];
  if (!items.length) return;
  const current = items.indexOf(document.activeElement);
  const next = event.key === 'Home' ? 0
    : event.key === 'End' ? items.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  event.preventDefault();
  items[next].focus();
});

async function cancelJob(jobId) {
  try {
    await authApiCall('/ai/api/pipeline/jobs/' + encodeURIComponent(jobId) + '/cancel', { method: 'POST' });
    showToast('キャンセルを受け付けました', 'success');
    pollJobs();
  } catch (error) {
    showToast('キャンセルできませんでした: ' + error.message, 'error');
  }
}

async function retryJob(jobId) {
  try {
    const result = await authApiCall('/ai/api/pipeline/jobs/' + encodeURIComponent(jobId) + '/retry', { method: 'POST' });
    rememberJob({ job_id: result.job_id, status: 'QUEUED' });
    showToast('失敗した項目を再試行します', 'success');
  } catch (error) {
    showToast('再試行できませんでした: ' + error.message, 'error');
  }
}

export async function restorePipelineJobs() {
  jobs.clear();
  let ids = [];
  try {
    const saved = storage()?.getItem(STORAGE_KEY) || '[]';
    ids = JSON.parse(saved);
    if (!Array.isArray(ids)) ids = [];
  } catch {
    try { storage()?.removeItem(STORAGE_KEY); } catch { /* ignore blocked storage */ }
  }
  appState.set('pipelineJobIds', ids);
  await Promise.all(ids.map(async jobId => {
    try {
      jobs.set(jobId, await authApiCall('/ai/api/pipeline/jobs/' + encodeURIComponent(jobId)));
    } catch (error) {
      if (error.status !== 404) {
        jobs.set(jobId, {
          job_id: jobId, status: 'QUEUED', total_steps: 1,
          completed_steps: 0, failed_steps: 0, steps: [],
          poll_error: error.message
        });
      }
    }
  }));
  pruneFinishedJobs();
  persistJobs();
  if (jobs.size) {
    renderTray();
    pollJobs();
  } else if (document.getElementById('pipelineJobTray')) {
    renderTray();
  }
}

window.pipelineModule = {
  run: runSelectedPipeline,
  publish: publishSelectedDrafts,
  chooseEmbedding: chooseEmbeddingRecipe,
  chooseVlm: chooseVlmProfile,
  toggleMenu: togglePipelineMenu,
  showJobs: showPipelineJobs,
  restore: restorePipelineJobs
};
