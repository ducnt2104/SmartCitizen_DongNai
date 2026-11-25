export type ApiKeyProvider = 'gemini' | 'openrouter' | 'groq';
export const API_KEY_PROVIDERS: readonly ApiKeyProvider[] = ['gemini', 'openrouter', 'groq'] as const;

export type GeminiEndpointKind = 'ai_studio' | 'vertex';
export const GEMINI_ENDPOINT_KINDS: readonly GeminiEndpointKind[] = ['ai_studio', 'vertex'] as const;

export type GeminiKeyFormat = 'ai_studio_aiza' | 'vertex_aq' | 'oauth_bearer' | 'unknown';

export type ApiKeyStatus = 'HEALTHY' | 'COOLDOWN' | 'EXHAUSTED' | 'INVALID';
export const API_KEY_STATUSES: readonly ApiKeyStatus[] = [
  'HEALTHY',
  'COOLDOWN',
  'EXHAUSTED',
  'INVALID',
] as const;

export type ApiKeySource = 'env' | 'db';

export interface PoolKeyRecord {
  id: string;
  slotNumber: number;
  label: string;
  provider: ApiKeyProvider;
  geminiEndpoint: GeminiEndpointKind;
  keyFormat?: GeminiKeyFormat;
  source: ApiKeySource;
  rawKey: string;
  maskedKey: string;
  shortMask: string;
  keyFingerprint: string;
  weight: number;
  isEnabled: boolean;
  status: ApiKeyStatus;
  totalRequests: number;
  successCount: number;
  errorCount: number;
  error429Count: number;
  consecutive429: number;
  inFlight: number;
  lastUsedAt: number | null;
  lastUsedSeq: number;
  cooldownUntil: number | null;
  dailyQuotaExhaustedAt: number | null;
  quotaResetAt: number | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** DTO an toàn trả qua Admin API — tuyệt đối KHÔNG chứa rawKey hoặc bản mã AES. */
export interface MaskedApiKeyInfo {
  id: string;
  slotNumber: number;
  label: string;
  provider: ApiKeyProvider;
  geminiEndpoint?: GeminiEndpointKind;
  keyFormat?: GeminiKeyFormat;
  source: ApiKeySource;
  maskedKey: string;
  weight: number;
  isEnabled: boolean;
  status: ApiKeyStatus;
  totalRequests: number;
  successCount: number;
  errorCount: number;
  error429Count: number;
  lastUsedAt: string | null;
  cooldownUntil: string | null;
  cooldownRemainingMs: number;
  dailyQuotaExhaustedAt: string | null;
  quotaResetAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KeyPoolSummary {
  totalKeys: number;
  enabledKeys: number;
  healthyKeys: number;
  cooldownKeys: number;
  exhaustedKeys: number;
  invalidKeys: number;
  totalRequests: number;
  totalSuccess: number;
  totalErrors: number;
  total429: number;
  byProvider: Record<ApiKeyProvider, { total: number; healthy: number }>;
}

export interface SelectedKeyMeta {
  id: string;
  slotNumber: number;
  label: string;
  provider: ApiKeyProvider;
  geminiEndpoint?: GeminiEndpointKind;
  keyFormat?: GeminiKeyFormat;
  maskedKey: string;
  shortMask: string;
  /** Cờ kích hoạt tự động hạ cấp sang model dự phòng khi model chính gặp 503 >= 3 key liên tiếp. */
  preferFallbackModel?: boolean;
  fallbackModel?: string;
  consecutive503Count?: number;
}

export interface ExecuteWithRotationOptions {
  /** Lọc theo nhà cung cấp (mặc định ưu tiên mọi key khả dụng hoặc theo danh sách chỉ định). */
  provider?: ApiKeyProvider | readonly ApiKeyProvider[];
  /** Giới hạn số key thử tối đa trong 1 request (mặc định 10). */
  maxAttempts?: number;
  /** Nhãn thao tác phục vụ ghi log truy vết (vd: "Gemini Vision", "Gemini Chat"). */
  operationName?: string;
  /** Số lần lỗi 503 liên tiếp trên model chính để tự động hạ cấp sang fallbackModel (mặc định 3). */
  fallbackOn503Threshold?: number;
  /** Model hạ cấp khi 503 liên tiếp (mặc định "gemini-3.5-flash-lite"). */
  fallbackModel?: string;
}

export interface AddApiKeyInputItem {
  apiKey: string;
  label?: string;
  provider?: ApiKeyProvider;
  geminiEndpoint?: GeminiEndpointKind;
  weight?: number;
}

export interface BulkAddApiKeysInput {
  apiKey?: string;
  apiKeys?: string[];
  keysText?: string;
  items?: AddApiKeyInputItem[];
  provider?: ApiKeyProvider;
  geminiEndpoint?: GeminiEndpointKind;
  labelPrefix?: string;
  weight?: number;
  addedBy?: string | null;
}

export interface BulkAddApiKeysResult {
  addedCount: number;
  skippedDuplicateCount: number;
  invalidFormatCount: number;
  added: MaskedApiKeyInfo[];
  skippedDuplicates: string[];
}

export interface UpdateApiKeyPatch {
  isEnabled?: boolean;
  resetCooldown?: boolean;
  label?: string;
  weight?: number;
}

export interface ApiKeyTestResult {
  id: string;
  maskedKey: string;
  provider: ApiKeyProvider;
  ok: boolean;
  status: ApiKeyStatus;
  latencyMs: number;
  detail: string;
}

export type KeyHealthProbeFn = (
  apiKey: string,
  meta: SelectedKeyMeta,
) => Promise<{ ok: boolean; detail?: string }>;
