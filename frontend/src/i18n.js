/**
 * 国際化（i18n）サポートモジュール
 * 
 * 多言語対応の基盤を提供します。
 * 将来的に英語、中国語などの言語サポートを追加する際に活用してください。
 */

/**
 * サポートされている言語
 */
export const SUPPORTED_LANGUAGES = {
  ja: '日本語',
  // 将来追加予定:
  // en: 'English',
  // zh: '中文简体',
  // ko: '한국어'
};

/**
 * デフォルト言語
 */
export const DEFAULT_LANGUAGE = 'ja';

/**
 * 翻訳辞書
 */
const translations = {
  ja: {
    // 共通
    common: {
      loading: '読み込み中...',
      saving: '保存中...',
      error: 'エラー',
      success: '成功',
      cancel: 'キャンセル',
      confirm: '確認',
      delete: '削除',
      edit: '編集',
      save: '保存',
      close: '閉じる',
      back: '戻る',
      next: '次へ',
      previous: '前へ',
      search: '検索',
      clear: 'クリア',
      upload: 'アップロード',
      download: 'ダウンロード',
      refresh: '更新',
      select_all: 'すべて選択',
      deselect_all: 'すべて解除',
      no_data: 'データがありません',
      processing: '処理中...'
    },
    
    // 認証
    auth: {
      login: 'ログイン',
      logout: 'ログアウト',
      username: 'ユーザー名',
      password: 'パスワード',
      login_required: 'ログインが必要です',
      login_success: 'ログインしました',
      login_failed: 'ログインに失敗しました',
      invalid_credentials: 'ユーザー名またはパスワードが正しくありません'
    },
    
    // ドキュメント管理
    documents: {
      title: 'ドキュメント管理',
      upload_files: 'ファイルをアップロード',
      select_files: 'ファイルを選択',
      upload_success: 'アップロードが完了しました',
      upload_failed: 'アップロードに失敗しました',
      delete_selected: '選択したファイルを削除',
      delete_confirm: '本当に削除しますか？',
      delete_success: '削除しました',
      delete_failed: '削除に失敗しました',
      file_too_large: 'ファイルサイズが大きすぎます（最大: {max}MB）',
      invalid_file_type: 'サポートされていないファイル形式です',
      page_images: 'ページ画像化',
      vectorize: 'ベクトル化',
      processing_images: 'ページ画像化処理中...',
      processing_vectors: 'ベクトル化処理中...'
    },
    
    // 検索
    search: {
      title: '検索',
      placeholder: 'キーワードを入力してください',
      search_button: '検索',
      no_results: '検索結果が見つかりませんでした',
      try_different_keywords: '別のキーワードで検索してみてください',
      results_count: '{count}件の結果',
      similarity: '類似度: {score}%',
      file_name: 'ファイル名',
      page_number: 'ページ {page}',
      matched_images: '一致した画像: {count}枚'
    },
    
    // データベース
    database: {
      title: 'データベース管理',
      connection: '接続設定',
      connect: '接続',
      disconnect: '切断',
      connection_success: 'データベースに接続しました',
      connection_failed: '接続に失敗しました',
      tables: 'テーブル一覧',
      preview: 'データプレビュー',
      refresh: 'テーブルを更新',
      table_count: '{count}件のテーブル',
      row_count: '{count}行',
      no_tables: 'テーブルがありません'
    },
    
    // AI Copilot
    copilot: {
      title: 'AI アシスタント',
      placeholder: 'メッセージを入力...',
      send: '送信',
      clear: '会話をクリア',
      thinking: '考え中...',
      error: 'エラーが発生しました',
      welcome: 'こんにちは！何かお手伝いできることはありますか？',
      image_analysis: '画像を分析中...',
      code_execution: 'コードを実行中...'
    },
    
    // エラーメッセージ
    errors: {
      network_error: 'ネットワークエラーが発生しました',
      server_error: 'サーバーエラーが発生しました',
      invalid_request: '無効なリクエストです',
      permission_denied: '権限がありません',
      not_found: '見つかりませんでした',
      timeout: 'タイムアウトしました',
      unknown: '予期しないエラーが発生しました'
    },
    
    // ページネーション
    pagination: {
      page: 'ページ',
      of: '/',
      showing: '表示中: {start}〜{end}件',
      total: '全{total}件',
      per_page: '{size}件/ページ',
      jump_to_page: 'ページジャンプ',
      go: '移動'
    },
    
    // OCI Object Storage
    oci: {
      bucket: 'バケット',
      objects: 'オブジェクト',
      folder: 'フォルダ',
      file: 'ファイル',
      size: 'サイズ',
      created_at: '作成日時',
      filter: 'フィルター',
      filter_all: 'すべて',
      filter_done: '完了',
      filter_not_done: '未実行',
      clear_filter: 'フィルタークリア'
    },
    
    // 設定
    settings: {
      title: '設定',
      api_base: 'APIベースURL',
      debug_mode: 'デバッグモード',
      language: '言語',
      theme: 'テーマ',
      save_settings: '設定を保存',
      reset_settings: '設定をリセット'
    }
  }
  
  // 将来追加予定の言語:
  // en: { ... },
  // zh: { ... }
};

/**
 * 現在の言語を保持
 */
let currentLanguage = DEFAULT_LANGUAGE;

/**
 * 現在の言語を取得
 * @returns {string} 言語コード
 */
export function getCurrentLanguage() {
  return currentLanguage;
}

/**
 * 言語を設定
 * @param {string} language - 言語コード
 */
export function setLanguage(language) {
  if (SUPPORTED_LANGUAGES[language]) {
    currentLanguage = language;
    // LocalStorageに保存
    localStorage.setItem('app_language', language);
    return true;
  }
  return false;
}

/**
 * LocalStorageから言語設定を読み込み
 */
export function loadLanguageFromStorage() {
  const savedLanguage = localStorage.getItem('app_language');
  if (savedLanguage && SUPPORTED_LANGUAGES[savedLanguage]) {
    currentLanguage = savedLanguage;
  }
}

/**
 * 翻訳キーから文字列を取得
 * @param {string} key - キー（例: 'common.loading', 'auth.login'）
 * @param {Object} params - プレースホルダーの置換パラメータ
 * @returns {string} 翻訳された文字列
 */
export function t(key, params = {}) {
  const keys = key.split('.');
  let value = translations[currentLanguage];
  
  // ネストされたキーをたどる
  for (const k of keys) {
    if (value && typeof value === 'object') {
      value = value[k];
    } else {
      // キーが見つからない場合はキー自体を返す
      console.warn(`Translation key not found: ${key}`);
      return key;
    }
  }
  
  // プレースホルダーを置換
  if (typeof value === 'string' && Object.keys(params).length > 0) {
    return value.replace(/\{(\w+)\}/g, (match, paramKey) => {
      return params[paramKey] !== undefined ? params[paramKey] : match;
    });
  }
  
  return value || key;
}

/**
 * 複数の翻訳を一括取得
 * @param {Array<string>} keys - キーの配列
 * @returns {Object} {key: translation}の形式
 */
export function tBatch(keys) {
  const result = {};
  keys.forEach(key => {
    result[key] = t(key);
  });
  return result;
}

/**
 * カテゴリ内のすべての翻訳を取得
 * @param {string} category - カテゴリ名（例: 'common', 'auth'）
 * @returns {Object} 翻訳オブジェクト
 */
export function tCategory(category) {
  return translations[currentLanguage][category] || {};
}

/**
 * 数値を言語に応じてフォーマット
 * @param {number} number - 数値
 * @param {Object} options - フォーマットオプション
 * @returns {string} フォーマットされた文字列
 */
export function formatNumber(number, options = {}) {
  const locale = currentLanguage === 'ja' ? 'ja-JP' : 'en-US';
  return new Intl.NumberFormat(locale, options).format(number);
}

/**
 * 日付を言語に応じてフォーマット
 * @param {Date|string} date - 日付
 * @param {Object} options - フォーマットオプション
 * @returns {string} フォーマットされた文字列
 */
export function formatDate(date, options = {}) {
  const locale = currentLanguage === 'ja' ? 'ja-JP' : 'en-US';
  const dateObj = typeof date === 'string' ? new Date(date) : date;
  return new Intl.DateTimeFormat(locale, options).format(dateObj);
}

/**
 * 相対時間をフォーマット（例: "3分前", "2時間前"）
 * @param {Date|string} date - 日付
 * @returns {string} フォーマットされた文字列
 */
export function formatRelativeTime(date) {
  const dateObj = typeof date === 'string' ? new Date(date) : date;
  const now = new Date();
  const diffMs = now - dateObj;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);
  
  if (currentLanguage === 'ja') {
    if (diffSec < 60) return `${diffSec}秒前`;
    if (diffMin < 60) return `${diffMin}分前`;
    if (diffHour < 24) return `${diffHour}時間前`;
    if (diffDay < 7) return `${diffDay}日前`;
    return formatDate(dateObj, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  
  // 英語など他の言語の場合
  if (diffSec < 60) return `${diffSec} seconds ago`;
  if (diffMin < 60) return `${diffMin} minutes ago`;
  if (diffHour < 24) return `${diffHour} hours ago`;
  if (diffDay < 7) return `${diffDay} days ago`;
  return formatDate(dateObj, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * ファイルサイズを人間が読める形式にフォーマット
 * @param {number} bytes - バイト数
 * @returns {string} フォーマットされた文字列
 */
export function formatFileSize(bytes) {
  if (bytes === 0) return '0 B';
  
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

// 初期化: LocalStorageから言語設定を読み込む
loadLanguageFromStorage();

// デフォルトエクスポート
export default {
  SUPPORTED_LANGUAGES,
  DEFAULT_LANGUAGE,
  getCurrentLanguage,
  setLanguage,
  loadLanguageFromStorage,
  t,
  tBatch,
  tCategory,
  formatNumber,
  formatDate,
  formatRelativeTime,
  formatFileSize
};
