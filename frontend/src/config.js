/**
 * フロントエンド設定ファイル
 * 
 * すべての定数とマジックナンバーをここに集約し、
 * 保守性とテストの容易性を向上させます。
 */

// ========================================
// API設定
// ========================================
export const API_CONFIG = {
  // 開発時はViteのプロキシを使うため空文字列、本番ビルド時は環境変数から設定
  BASE_URL: import.meta.env.VITE_API_BASE || '',
  TIMEOUT: 30000, // 30秒
};

// ========================================
// ファイルアップロード設定
// ========================================
export const UPLOAD_CONFIG = {
  MAX_FILES: 10,
  MAX_FILE_SIZE: 200 * 1024 * 1024, // 200MB
  ALLOWED_EXTENSIONS: ['pdf', 'pptx', 'ppt', 'png', 'jpg', 'jpeg'],
  ALLOWED_MIME_TYPES: {
    pdf: 'application/pdf',
    pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    ppt: 'application/vnd.ms-powerpoint',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg'
  }
};

// ========================================
// ページネーション設定
// ========================================
export const PAGINATION_CONFIG = {
  DEFAULT_PAGE_SIZE: 20,
  MIN_PAGE_SIZE: 10,
  MAX_PAGE_SIZE: 100,
  OCI_OBJECTS_PAGE_SIZE: 20,
  DB_TABLES_PAGE_SIZE: 20,
  TABLE_DATA_PAGE_SIZE: 20
};

// ========================================
// Toast通知設定
// ========================================
export const TOAST_CONFIG = {
  DEFAULT_DURATION: 5000, // 5秒
  SUCCESS_DURATION: 4000,
  ERROR_DURATION: 6000,
  WARNING_DURATION: 5000,
  INFO_DURATION: 4000,
  MAX_TOASTS: 5 // 同時表示最大数
};

// ========================================
// セッション設定
// ========================================
export const SESSION_CONFIG = {
  TIMEOUT_SECONDS: 86400, // 24時間
  CHECK_INTERVAL: 60000, // 1分ごとにチェック
};

// ========================================
// 検索設定
// ========================================
export const SEARCH_CONFIG = {
  DEFAULT_TOP_K: 10,
  MIN_TOP_K: 1,
  MAX_TOP_K: 50,
  DEFAULT_MIN_SCORE: 0.7,
  MIN_SCORE: 0.0,
  MAX_SCORE: 1.0,
  SCORE_STEP: 0.05
};

// ========================================
// UI設定
// ========================================
export const UI_CONFIG = {
  // ローディングオーバーレイ
  LOADING_DELAY: 300, // ローディング表示前の遅延（ms）
  
  // モーダル
  MODAL_ANIMATION_DURATION: 300,
  
  // スクロール
  SCROLL_SMOOTH_DURATION: 300,
  
  // Copilot
  COPILOT_MAX_IMAGES: 5,
  COPILOT_DEFAULT_WIDTH: 480,
  COPILOT_EXPANDED_WIDTH: 900,
  
  // テーブル
  TABLE_MAX_HEIGHT: 480,
  TABLE_HEADER_HEIGHT: 48,
  
  // 機能表示制御（サーバーから取得）
  SHOW_AI_ASSISTANT: true, // デフォルト値（サーバーから上書きされる）
  SHOW_SEARCH_TAB: true    // デフォルト値（サーバーから上書きされる）
};

// ========================================
// デバッグ設定
// ========================================
export const DEBUG_CONFIG = {
  ENABLE_CONSOLE_LOG: import.meta.env.DEV,
  ENABLE_PERFORMANCE_LOG: false,
  ENABLE_ERROR_DETAIL: import.meta.env.DEV
};

// ========================================
// 正規表現パターン
// ========================================
export const REGEX_PATTERNS = {
  PAGE_IMAGE: /\/page_\d{3}\.png$/,
  EMAIL: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  OCID: /^ocid1\.[a-z]+\.oc1\.[a-z-]+\.[a-z0-9]+$/,
  FINGERPRINT: /^[a-f0-9]{2}(:[a-f0-9]{2}){15}$/i
};

// ========================================
// エラーメッセージ
// ========================================
export const ERROR_MESSAGES = {
  NETWORK_ERROR: 'ネットワークエラーが発生しました',
  AUTH_REQUIRED: '認証が必要です',
  SESSION_EXPIRED: 'セッションが期限切れです',
  INVALID_INPUT: '入力値が不正です',
  FILE_TOO_LARGE: 'ファイルサイズが大きすぎます',
  UNSUPPORTED_FILE_TYPE: 'サポートされていないファイル形式です',
  UPLOAD_FAILED: 'アップロードに失敗しました',
  FETCH_FAILED: 'データ取得に失敗しました'
};

// ========================================
// 成功メッセージ
// ========================================
export const SUCCESS_MESSAGES = {
  UPLOAD_COMPLETE: 'アップロードが完了しました',
  DELETE_COMPLETE: '削除が完了しました',
  SAVE_COMPLETE: '保存が完了しました',
  CONNECTION_SUCCESS: '接続テストが成功しました',
  OPERATION_SUCCESS: '操作が完了しました'
};

// ========================================
// デフォルトエクスポート
// ========================================
export default {
  API_CONFIG,
  UPLOAD_CONFIG,
  PAGINATION_CONFIG,
  TOAST_CONFIG,
  SESSION_CONFIG,
  SEARCH_CONFIG,
  UI_CONFIG,
  DEBUG_CONFIG,
  REGEX_PATTERNS,
  ERROR_MESSAGES,
  SUCCESS_MESSAGES
};
