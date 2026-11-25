import { parseGeminiKeyRouting } from './cryptoVault';
import { sanitizeUpstreamErrorReason } from './errorClassifier';
import type { GeminiEndpointKind } from './types';

/** Chuỗi model Gemini 2026 ổn định theo thứ tự: Tốc độ tối đa -> Đa phương thức cân bằng -> Độ chính xác cao. */
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';
export const ACTIVE_GEMINI_MODEL_CHAIN: readonly string[] = [
  'gemini-3.5-flash-lite',
  'gemini-3.6-flash',
  'gemini-3.8-flash',
] as const;

const DEPRECATED_GEMINI_MODEL_RE = /^gemini-(?:1\.5|2\.0|2\.5)(?:-|$)/i;

export interface GeminiRestConfig {
  systemInstruction?: string;
  temperature?: number;
  maxOutputTokens?: number;
  responseMimeType?: string;
  responseSchema?: Record<string, unknown>;
  /** Tuỳ chọn cho Gemini 3.5+: dùng thinkingLevel thay vì thinkingBudget đã lỗi thời. */
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH' | 'XHIGH';
}

export interface ExecuteGeminiChainOptions {
  apiKey: string;
  geminiEndpoint?: GeminiEndpointKind;
  models: readonly string[];
  contents: unknown | ((modelId: string) => unknown);
  config?: GeminiRestConfig | ((modelId: string) => GeminiRestConfig);
  timeoutMs: number;
  label: string;
  fetchImpl?: typeof fetch;
  /** Cho phép thử Vertex Express đúng 1 lần nếu key `AQ.*` mặc định AI Studio bị từ chối 401/403. */
  allowAqVertexFallbackOnAuthError?: boolean;
  onModelNotFound?: (modelId: string, err: unknown) => void;
  onModelSuccess?: (modelId: string, endpoint: GeminiEndpointKind) => void;
}

/** Chuẩn hóa tên model Gemini: nâng cấp tự động các model đã ngừng hỗ trợ (`1.5`/`2.0`/`2.5`) sang `gemini-3.5-flash-lite`. */
export function normalizeGeminiModelName(rawModel?: string | null): string {
  const trimmed = (rawModel ?? '').trim();
  if (!trimmed || DEPRECATED_GEMINI_MODEL_RE.test(trimmed)) {
    return DEFAULT_GEMINI_MODEL;
  }
  return trimmed;
}

/** Kiểm tra quyền gọi Cloud AI động (hỗ trợ key nạp từ MongoDB/Admin UI sau khi server đã khởi động). */
export function isCloudAiAllowed(configuredKeyCount: number, staticDefault = false): boolean {
  const raw = process.env.ALLOW_CLOUD_AI_FALLBACK?.trim().toLowerCase();
  if (raw !== undefined && raw !== '') {
    if (['0', 'false', 'no'].includes(raw)) return false;
    if (['1', 'true', 'yes'].includes(raw)) return true;
  }
  return configuredKeyCount > 0 || staticDefault;
}

/** Xây dựng chuỗi model dự phòng bắt đầu từ model cấu hình (hoặc model live vừa thành công). */
export function buildGeminiModelChain(
  configuredModel?: string | null,
  cachedLiveModel?: string | null,
): string[] {
  const normalizedConfigured = normalizeGeminiModelName(configuredModel);
  const normalizedCached =
    cachedLiveModel && !DEPRECATED_GEMINI_MODEL_RE.test(cachedLiveModel.trim())
      ? cachedLiveModel.trim()
      : null;

  const chain = [
    ...(normalizedCached ? [normalizedCached] : []),
    normalizedConfigured,
    ...ACTIVE_GEMINI_MODEL_CHAIN,
  ];
  return Array.from(new Set(chain));
}

export function isModelNotFoundError(err: unknown): boolean {
  const st =
    err && typeof err === 'object' && 'status' in err
      ? Number((err as { status?: unknown }).status)
      : 0;
  if (st === 404) return true;
  if (st === 401 || st === 403 || st === 429 || st === 503) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return /\b404\b|is not found for api version|publisher model.*not found|model.*not supported/i.test(
    msg,
  );
}

export function isGeminiAuthOrInvalidKeyError(err: unknown): boolean {
  const st =
    err && typeof err === 'object' && 'status' in err
      ? Number((err as { status?: unknown }).status)
      : 0;
  if (st === 401 || st === 403) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /(api[_ -]?key[_ -]?invalid|api key not valid|invalid[_ -]?api[_ -]?key|permission_denied|unauthenticated|unauthorized|forbidden)/i.test(
    msg,
  );
}

/** Tạo URL, headers và payload REST chuẩn cho Google AI Studio hoặc Vertex AI Express Mode. */
export function buildGeminiRestRequest(params: {
  cleanKey: string;
  endpoint: GeminiEndpointKind;
  modelId: string;
  contents: unknown;
  config?: GeminiRestConfig;
}): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  endpointLabel: 'AIStudio' | 'VertexAI';
} {
  const isVertex = params.endpoint === 'vertex';
  const encodedModel = encodeURIComponent(params.modelId);
  const url = isVertex
    ? `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodedModel}:generateContent?key=${encodeURIComponent(params.cleanKey)}`
    : `https://generativelanguage.googleapis.com/v1beta/models/${encodedModel}:generateContent`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(isVertex ? {} : { 'x-goog-api-key': params.cleanKey }),
  };

  const cfg = params.config ?? {};
  const generationConfig: Record<string, unknown> = {};
  if (cfg.temperature !== undefined) generationConfig.temperature = cfg.temperature;
  if (cfg.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = cfg.maxOutputTokens;
  if (cfg.responseMimeType !== undefined) generationConfig.responseMimeType = cfg.responseMimeType;
  if (cfg.responseSchema !== undefined) generationConfig.responseSchema = cfg.responseSchema;
  // Tương thích Gemini 3.5+: dùng thinkingLevel thay vì thinkingBudget lỗi thời (mặc định bỏ qua để đạt độ trễ thấp nhất)
  if (cfg.thinkingLevel !== undefined) {
    generationConfig.thinkingConfig = { thinkingLevel: cfg.thinkingLevel };
  }

  const contents =
    typeof params.contents === 'string'
      ? [{ role: 'user', parts: [{ text: params.contents }] }]
      : params.contents;

  const body: Record<string, unknown> = {
    contents,
    ...(Object.keys(generationConfig).length > 0 ? { generationConfig } : {}),
  };

  if (typeof cfg.systemInstruction === 'string' && cfg.systemInstruction) {
    body.systemInstruction = isVertex
      ? { role: 'system', parts: [{ text: cfg.systemInstruction }] }
      : { parts: [{ text: cfg.systemInstruction }] };
  }

  return {
    url,
    headers,
    body,
    endpointLabel: isVertex ? 'VertexAI' : 'AIStudio',
  };
}

async function callSingleGeminiRequest(params: {
  cleanKey: string;
  endpoint: GeminiEndpointKind;
  modelId: string;
  contents: unknown;
  config?: GeminiRestConfig;
  timeoutMs: number;
  label: string;
  fetchImpl: typeof fetch;
}): Promise<string> {
  const req = buildGeminiRestRequest({
    cleanKey: params.cleanKey,
    endpoint: params.endpoint,
    modelId: params.modelId,
    contents: params.contents,
    config: params.config,
  });

  const effectiveTimeoutMs = Math.min(params.timeoutMs, 8_000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), effectiveTimeoutMs);
  try {
    let res: Response;
    try {
      res = await params.fetchImpl(req.url, {
        method: 'POST',
        headers: req.headers,
        body: JSON.stringify(req.body),
        signal: ctrl.signal,
      });
    } catch (err) {
      if (ctrl.signal.aborted) {
        throw Object.assign(
          new Error(`${params.label} ${req.endpointLabel}(${params.modelId}) quá thời gian ${effectiveTimeoutMs}ms`),
          { status: 408 },
        );
      }
      throw err;
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      const cleanSummary = sanitizeUpstreamErrorReason(errBody, res.status);
      throw Object.assign(
        new Error(`${req.endpointLabel}(${params.modelId}) ${cleanSummary}`),
        { status: res.status },
      );
    }

    const json = (await res.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text = (json.candidates?.[0]?.content?.parts ?? [])
      .map((p) => p.text ?? '')
      .join('')
      .trim();
    if (!text) {
      throw new Error(`${req.endpointLabel}(${params.modelId}) trả về rỗng`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

async function runChainOnEndpoint(
  opts: ExecuteGeminiChainOptions,
  cleanKey: string,
  endpoint: GeminiEndpointKind,
  fetchImpl: typeof fetch,
): Promise<{ text: string; modelUsed: string; endpointUsed: GeminiEndpointKind }> {
  const models = opts.models.length > 0 ? opts.models : ACTIVE_GEMINI_MODEL_CHAIN;
  let lastErr: unknown = null;

  for (const modelId of models) {
    const resolvedContents =
      typeof opts.contents === 'function' ? opts.contents(modelId) : opts.contents;
    const resolvedConfig = typeof opts.config === 'function' ? opts.config(modelId) : opts.config;

    try {
      const text = await callSingleGeminiRequest({
        cleanKey,
        endpoint,
        modelId,
        contents: resolvedContents,
        config: resolvedConfig,
        timeoutMs: opts.timeoutMs,
        label: opts.label,
        fetchImpl,
      });
      opts.onModelSuccess?.(modelId, endpoint);
      return { text, modelUsed: modelId, endpointUsed: endpoint };
    } catch (err) {
      lastErr = err;
      if (isModelNotFoundError(err)) {
        opts.onModelNotFound?.(modelId, err);
        continue;
      }
      throw err;
    }
  }

  throw (
    lastErr ??
    Object.assign(new Error('Không có model Gemini khả dụng trong chuỗi dự phòng.'), { status: 404 })
  );
}

/**
 * Thực thi gọi Gemini REST qua chuỗi model dự phòng trên CÙNG một API key khỏe:
 * - Gặp HTTP 404: tự động chuyển sang model kế tiếp trong chuỗi trên cùng key (không đánh dấu key hỏng).
 * - Gặp HTTP 429 / 503: ném lỗi ngay để KeyPool Cooldown và xoay key tức thì.
 * - Gặp HTTP 401 / 403 trên AI Studio với key `AQ.*`: tùy chọn thử Vertex Express 1 lần trước khi báo INVALID.
 */
export async function executeGeminiWithModelFallback(
  opts: ExecuteGeminiChainOptions,
): Promise<{ text: string; modelUsed: string; endpointUsed: GeminiEndpointKind }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { cleanKey, geminiEndpoint } = parseGeminiKeyRouting(
    opts.apiKey,
    opts.geminiEndpoint ?? 'ai_studio',
  );

  try {
    return await runChainOnEndpoint(opts, cleanKey, geminiEndpoint, fetchImpl);
  } catch (err) {
    const canTryVertexOnce =
      opts.allowAqVertexFallbackOnAuthError !== false &&
      geminiEndpoint === 'ai_studio' &&
      /^AQ\./.test(cleanKey) &&
      isGeminiAuthOrInvalidKeyError(err);

    if (!canTryVertexOnce) {
      throw err;
    }

    return await runChainOnEndpoint(opts, cleanKey, 'vertex', fetchImpl);
  }
}
