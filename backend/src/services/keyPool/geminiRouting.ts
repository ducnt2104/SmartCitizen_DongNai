import { parseGeminiKeyRouting, redactSecretsInText } from './cryptoVault';
import { sanitizeUpstreamErrorReason } from './errorClassifier';
import type { GeminiEndpointKind, GeminiKeyFormat } from './types';

/** Chuỗi model Gemini Flash hiện hành, ổn định 2026: `gemini-3.8-flash` -> `gemini-3.5-flash-lite` -> `gemini-3.1-flash-lite`. */
export const PRIMARY_GEMINI_MODEL = 'gemini-3.8-flash';
export const DEFAULT_GEMINI_MODEL = PRIMARY_GEMINI_MODEL;
export const FALLBACK_GEMINI_MODEL = 'gemini-3.5-flash-lite';
export const ACTIVE_GEMINI_MODEL_CHAIN: readonly string[] = [
  'gemini-3.8-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
] as const;

export const SUPPORTED_GEMINI_MODELS: ReadonlySet<string> = new Set([
  'gemini-3.8-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-4-argon',
  'gemini-4-carbon',
]);

const DEPRECATED_OR_INVALID_GEMINI_MODEL_RE =
  /^(?:gemini-(?:1\.0|1\.5|2\.0|2\.5)(?:-|$)|gemini-3\.1-flash-lite-preview$)/i;
const warnedUnsupportedModels = new Set<string>();
const INTERACTIONS_API_REVISION = '2026-05-20';

function isGemini3OrNewer(modelId: string): boolean {
  return /^gemini-(?:3|4)(?:\.|-|$)/i.test(modelId.trim());
}

function isMinimalThinkingUnsupported(modelId: string): boolean {
  return /^gemini-(?:3\.8|4)(?:-|$)/i.test(modelId.trim());
}

function resolveEffectiveThinkingLevel(
  modelId: string,
  cfg: GeminiRestConfig,
): 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | undefined {
  if (cfg.thinkingLevel) {
    const lower = cfg.thinkingLevel.toLowerCase() as 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
    if (lower === 'minimal' && isMinimalThinkingUnsupported(modelId)) {
      return 'low';
    }
    return lower;
  }
  if (cfg.thinkingBudget !== undefined) {
    if (cfg.thinkingBudget <= 0) {
      return isMinimalThinkingUnsupported(modelId) ? 'low' : 'minimal';
    }
    if (cfg.thinkingBudget <= 2_048) return 'low';
    if (cfg.thinkingBudget <= 8_192) return 'medium';
    return 'high';
  }
  return undefined;
}

const UPPERCASE_JSON_SCHEMA_TYPES: Readonly<Record<string, string>> = {
  OBJECT: 'object',
  ARRAY: 'array',
  STRING: 'string',
  INTEGER: 'integer',
  NUMBER: 'number',
  BOOLEAN: 'boolean',
  NULL: 'null',
};

function normalizeJsonSchemaTypes(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => normalizeJsonSchemaTypes(item));
  }
  if (!node || typeof node !== 'object') {
    return node;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === 'type' && typeof v === 'string') {
      out[k] = UPPERCASE_JSON_SCHEMA_TYPES[v] ?? v.toLowerCase();
    } else {
      out[k] = normalizeJsonSchemaTypes(v);
    }
  }
  return out;
}

interface LegacyContentTurn {
  role?: string;
  parts?: Array<{
    text?: string;
    inlineData?: { mimeType?: string; data?: string };
  }>;
}

function mapPartsToInteractionContent(
  parts: NonNullable<LegacyContentTurn['parts']>,
): Array<Record<string, unknown>> {
  const mapped: Array<Record<string, unknown>> = [];
  for (const part of parts) {
    if (typeof part.text === 'string' && part.text.length > 0) {
      mapped.push({ type: 'text', text: part.text });
    } else if (part.inlineData?.data) {
      const mimeType = part.inlineData.mimeType || 'image/jpeg';
      const contentType = mimeType.startsWith('audio/')
        ? 'audio'
        : mimeType.startsWith('video/')
          ? 'video'
          : mimeType === 'application/pdf'
            ? 'document'
            : 'image';
      mapped.push({
        type: contentType,
        data: part.inlineData.data,
        mime_type: mimeType,
      });
    }
  }
  return mapped;
}

function convertContentsToInteractionInput(contents: unknown): unknown {
  if (typeof contents === 'string') {
    return contents;
  }
  if (!Array.isArray(contents)) {
    return contents;
  }
  const turns = contents as LegacyContentTurn[];
  if (turns.length === 0) {
    return '';
  }
  if (turns.length === 1 && Array.isArray(turns[0]?.parts)) {
    const singleParts = mapPartsToInteractionContent(turns[0].parts);
    if (singleParts.length === 1 && singleParts[0].type === 'text') {
      return singleParts[0].text;
    }
    return singleParts;
  }
  const steps: Array<Record<string, unknown>> = [];
  for (const turn of turns) {
    const content = Array.isArray(turn?.parts) ? mapPartsToInteractionContent(turn.parts) : [];
    if (content.length === 0) continue;
    steps.push({
      type: turn.role === 'model' ? 'model_output' : 'user_input',
      content,
    });
  }
  return steps;
}

export interface GeminiRestConfig {
  systemInstruction?: string;
  temperature?: number;
  maxOutputTokens?: number;
  responseMimeType?: string;
  responseSchema?: Record<string, unknown>;
  /** Tắt thinking (`0`) trên Gemini 2.5 để tối ưu độ trễ < 2s. */
  thinkingBudget?: number;
  /** Tuỳ chọn cho các dòng hỗ trợ thinkingLevel. */
  thinkingLevel?: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH' | 'XHIGH';
}

export interface ExecuteGeminiChainOptions {
  apiKey: string;
  geminiEndpoint?: GeminiEndpointKind;
  keyFormat?: GeminiKeyFormat;
  models: readonly string[];
  contents: unknown | ((modelId: string) => unknown);
  config?: GeminiRestConfig | ((modelId: string) => GeminiRestConfig);
  timeoutMs: number;
  label: string;
  fetchImpl?: typeof fetch;
  /** Cho phép thử Vertex Express đúng 1 lần nếu key `AQ.*` gọi qua AI Studio trả về 401/403. */
  allowAqVertexFallbackOnAuthError?: boolean;
  /** Cho phép thử AI Studio đúng 1 lần nếu key `AQ.*` gọi qua Vertex Express trả về 401/403 (`SERVICE_DISABLED`). */
  allowAqAiStudioFallbackOnAuthError?: boolean;
  /** Cho phép hạ cấp sang model kế tiếp trong chuỗi ngay trên cùng key khi gặp 503 Overloaded (vd: khi probe/còn 1 key). */
  fallbackModelOn503?: boolean;
  onModelNotFound?: (modelId: string, err: unknown) => void;
  onModelSuccess?: (modelId: string, endpoint: GeminiEndpointKind) => void;
}

export function isValidGeminiModel(modelId?: string | null): boolean {
  const trimmed = (modelId ?? '').trim();
  if (!trimmed || DEPRECATED_OR_INVALID_GEMINI_MODEL_RE.test(trimmed)) return false;
  return SUPPORTED_GEMINI_MODELS.has(trimmed);
}

/** Chuẩn hóa tên model Gemini: thay thế các model cũ/không hợp lệ (`gemini-1.5-*`, `gemini-2.0-*`, `gemini-2.5-*`, ...) về `gemini-3.8-flash`. */
export function normalizeGeminiModelName(rawModel?: string | null): string {
  const trimmed = (rawModel ?? '').trim();
  if (!trimmed) return DEFAULT_GEMINI_MODEL;
  if (!isValidGeminiModel(trimmed)) {
    if (!warnedUnsupportedModels.has(trimmed)) {
      warnedUnsupportedModels.add(trimmed);
      console.warn(
        `[ai] Model "${trimmed}" đã ngừng hỗ trợ hoặc không nằm trong danh sách model Gemini hiện hành (${Array.from(SUPPORTED_GEMINI_MODELS).join(', ')}). Tự động chuyển sang "${DEFAULT_GEMINI_MODEL}".`,
      );
    }
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

/** Xây dựng chuỗi model dự phòng bắt đầu từ model cấu hình (hoặc tự động hạ cấp sang FALLBACK_GEMINI_MODEL khi 503 liên tiếp). */
export function buildGeminiModelChain(
  configuredModel?: string | null,
  cachedLiveModel?: string | null,
  options?: { preferFallbackModel?: boolean; fallbackModel?: string },
): string[] {
  const normalizedConfigured = normalizeGeminiModelName(configuredModel);
  const normalizedCached =
    cachedLiveModel && isValidGeminiModel(cachedLiveModel) ? cachedLiveModel.trim() : null;

  if (options?.preferFallbackModel) {
    const fb = normalizeGeminiModelName(options.fallbackModel ?? FALLBACK_GEMINI_MODEL);
    const ordered = [
      fb,
      FALLBACK_GEMINI_MODEL,
      ...ACTIVE_GEMINI_MODEL_CHAIN,
    ].filter((m) => isValidGeminiModel(m));
    const unique = Array.from(new Set(ordered));
    // Đẩy model chính đang bị 503 xuống cuối (chỉ dùng nếu mọi fallback đều 404)
    const primary = normalizedConfigured;
    const withoutPrimary = unique.filter((m) => m !== primary);
    return withoutPrimary.length > 0 ? [...withoutPrimary, primary] : unique;
  }

  const chain = [
    ...(normalizedCached ? [normalizedCached] : []),
    normalizedConfigured,
    ...ACTIVE_GEMINI_MODEL_CHAIN,
  ].filter((m) => isValidGeminiModel(m));
  return Array.from(new Set(chain.length > 0 ? chain : ACTIVE_GEMINI_MODEL_CHAIN));
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

/** Tạo URL, headers và payload REST chuẩn cho Google AI Studio (Interactions API), Vertex AI Express Mode hoặc OAuth Bearer. */
export function buildGeminiRestRequest(params: {
  cleanKey: string;
  endpoint: GeminiEndpointKind;
  keyFormat?: GeminiKeyFormat;
  modelId: string;
  contents: unknown;
  config?: GeminiRestConfig;
}): {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  endpointLabel: 'AIStudio' | 'VertexAI';
} {
  const isOAuthBearer = params.keyFormat === 'oauth_bearer' || params.cleanKey.startsWith('ya29.');
  const isVertex = params.endpoint === 'vertex';
  const resolvedModel = isValidGeminiModel(params.modelId) ? params.modelId.trim() : DEFAULT_GEMINI_MODEL;
  const encodedModel = encodeURIComponent(resolvedModel);
  const cfg = params.config ?? {};
  const thinkingLevel = resolveEffectiveThinkingLevel(resolvedModel, cfg);
  const modernModel = isGemini3OrNewer(resolvedModel);

  if (!isVertex) {
    const url = 'https://generativelanguage.googleapis.com/v1beta/interactions';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Api-Revision': INTERACTIONS_API_REVISION,
      ...(isOAuthBearer
        ? { Authorization: `Bearer ${params.cleanKey}` }
        : { 'x-goog-api-key': params.cleanKey }),
    };

    const generationConfig: Record<string, unknown> = {};
    if (!modernModel && cfg.temperature !== undefined) {
      generationConfig.temperature = cfg.temperature;
    }
    if (cfg.maxOutputTokens !== undefined) {
      generationConfig.max_output_tokens = cfg.maxOutputTokens;
    }
    if (thinkingLevel !== undefined) {
      generationConfig.thinking_level = thinkingLevel;
    }

    const body: Record<string, unknown> = {
      model: resolvedModel,
      input: convertContentsToInteractionInput(params.contents),
      store: false,
      ...(Object.keys(generationConfig).length > 0 ? { generation_config: generationConfig } : {}),
    };

    if (typeof cfg.systemInstruction === 'string' && cfg.systemInstruction) {
      body.system_instruction = cfg.systemInstruction;
    }

    if (cfg.responseMimeType === 'application/json' || cfg.responseSchema !== undefined) {
      const responseFormat: Record<string, unknown> = {
        type: 'text',
        mime_type: cfg.responseMimeType ?? 'application/json',
      };
      if (cfg.responseSchema !== undefined) {
        responseFormat.schema = normalizeJsonSchemaTypes(cfg.responseSchema);
      }
      body.response_format = responseFormat;
    }

    return {
      url,
      headers,
      body,
      endpointLabel: 'AIStudio',
    };
  }

  const url = isOAuthBearer
    ? `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodedModel}:generateContent`
    : `https://aiplatform.googleapis.com/v1/publishers/google/models/${encodedModel}:generateContent?key=${encodeURIComponent(params.cleanKey)}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(isOAuthBearer ? { Authorization: `Bearer ${params.cleanKey}` } : {}),
  };

  const generationConfig: Record<string, unknown> = {};
  if (!modernModel && cfg.temperature !== undefined) {
    generationConfig.temperature = cfg.temperature;
  }
  if (cfg.maxOutputTokens !== undefined) generationConfig.maxOutputTokens = cfg.maxOutputTokens;
  if (cfg.responseMimeType !== undefined) generationConfig.responseMimeType = cfg.responseMimeType;
  if (cfg.responseSchema !== undefined) generationConfig.responseSchema = cfg.responseSchema;
  if (modernModel) {
    if (thinkingLevel !== undefined) {
      generationConfig.thinkingConfig = { thinkingLevel: thinkingLevel.toUpperCase() };
    }
  } else if (cfg.thinkingBudget !== undefined) {
    generationConfig.thinkingConfig = { thinkingBudget: cfg.thinkingBudget };
  } else if (cfg.thinkingLevel !== undefined) {
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
    body.systemInstruction = { role: 'system', parts: [{ text: cfg.systemInstruction }] };
  }

  return {
    url,
    headers,
    body,
    endpointLabel: 'VertexAI',
  };
}

interface InteractionStepLike {
  type?: string;
  content?: Array<{ type?: string; text?: string }>;
  text?: string;
}

function extractGeminiResponseText(json: unknown, endpointLabel: string, modelId: string): string {
  if (!json || typeof json !== 'object') return '';
  const data = json as {
    status?: string;
    output_text?: string;
    errors?: Array<{ code?: number | string; message?: string }>;
    steps?: InteractionStepLike[];
    outputs?: Array<{ type?: string; text?: string; content?: Array<{ type?: string; text?: string }> }>;
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };

  if (typeof data.output_text === 'string' && data.output_text.trim()) {
    return data.output_text.trim();
  }

  if (Array.isArray(data.steps) && data.steps.length > 0) {
    const textParts: string[] = [];
    let collecting = false;
    outer: for (let i = data.steps.length - 1; i >= 0; i--) {
      const step = data.steps[i];
      if (!step) continue;
      if (step.type === 'user_input') break;
      if (step.type === 'thought') continue;
      if (step.type !== 'model_output') {
        if (collecting) break;
        continue;
      }
      if (!Array.isArray(step.content)) continue;
      for (let j = step.content.length - 1; j >= 0; j--) {
        const item = step.content[j];
        if (item?.type === 'text') {
          collecting = true;
          textParts.push(item.text ?? '');
        } else if (collecting) {
          break outer;
        }
      }
    }
    const joined = textParts.reverse().join('').trim();
    if (joined) return joined;
  }

  if (Array.isArray(data.outputs) && data.outputs.length > 0) {
    const outputParts: string[] = [];
    for (const out of data.outputs) {
      if (out?.type === 'text' && typeof out.text === 'string') {
        outputParts.push(out.text);
      } else if (Array.isArray(out?.content)) {
        for (const c of out.content) {
          if (c?.type === 'text' && typeof c.text === 'string') {
            outputParts.push(c.text);
          }
        }
      }
    }
    const joined = outputParts.join('').trim();
    if (joined) return joined;
  }

  const candidateText = (data.candidates?.[0]?.content?.parts ?? [])
    .map((p) => p.text ?? '')
    .join('')
    .trim();
  if (candidateText) return candidateText;

  if (data.status === 'failed' || (Array.isArray(data.errors) && data.errors.length > 0)) {
    const errMsg = data.errors?.[0]?.message || 'Interaction failed';
    throw new Error(`${endpointLabel}(${modelId}) ${sanitizeUpstreamErrorReason(errMsg, null)}`);
  }

  return '';
}

async function callSingleGeminiRequest(params: {
  cleanKey: string;
  endpoint: GeminiEndpointKind;
  keyFormat?: GeminiKeyFormat;
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
    keyFormat: params.keyFormat,
    modelId: params.modelId,
    contents: params.contents,
    config: params.config,
  });

  const effectiveTimeoutMs = Math.max(1_000, Math.min(params.timeoutMs, 8_000));
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
          { status: 408, code: 'UPSTREAM_TIMEOUT' },
        );
      }
      const msg = err instanceof Error ? redactSecretsInText(err.message) : redactSecretsInText(String(err));
      throw Object.assign(new Error(msg || `${req.endpointLabel}(${params.modelId}) fetch failed`), {
        cause: undefined,
      });
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      const cleanSummary = sanitizeUpstreamErrorReason(errBody, res.status);
      throw Object.assign(
        new Error(`${req.endpointLabel}(${params.modelId}) ${cleanSummary}`),
        { status: res.status },
      );
    }

    const json = await res.json();
    const text = extractGeminiResponseText(json, req.endpointLabel, params.modelId);
    if (!text) {
      throw new Error(`${req.endpointLabel}(${params.modelId}) trả về rỗng`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

function isOverloaded503Error(err: unknown): boolean {
  const st =
    err && typeof err === 'object' && 'status' in err
      ? Number((err as { status?: unknown }).status)
      : 0;
  if (st === 503) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /\b503\b|service_unavailable|overloaded|high demand/i.test(msg);
}

async function runChainOnEndpoint(
  opts: ExecuteGeminiChainOptions,
  cleanKey: string,
  endpoint: GeminiEndpointKind,
  keyFormat: GeminiKeyFormat,
  fetchImpl: typeof fetch,
): Promise<{ text: string; modelUsed: string; endpointUsed: GeminiEndpointKind }> {
  const validModels = opts.models.filter((m) => isValidGeminiModel(m));
  const models = validModels.length > 0 ? validModels : ACTIVE_GEMINI_MODEL_CHAIN;
  let lastErr: unknown = null;

  for (const modelId of models) {
    const resolvedContents =
      typeof opts.contents === 'function' ? opts.contents(modelId) : opts.contents;
    const resolvedConfig = typeof opts.config === 'function' ? opts.config(modelId) : opts.config;

    try {
      const text = await callSingleGeminiRequest({
        cleanKey,
        endpoint,
        keyFormat,
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
      if (isModelNotFoundError(err) || (opts.fallbackModelOn503 && isOverloaded503Error(err))) {
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
 * - Gặp HTTP 404 (hoặc 503 khi bật `fallbackModelOn503`): tự động chuyển sang model kế tiếp trong chuỗi trên cùng key.
 * - Gặp HTTP 429 / 503 (mặc định): ném lỗi ngay để KeyPool Cooldown + Backoff và xoay key tức thì.
 * - Định tuyến thông minh cho `AQ.*`: thử endpoint chính trước, nếu gặp 401/403 (chưa bật API ở endpoint đó) sẽ thử chéo endpoint còn lại đúng 1 lần.
 */
export async function executeGeminiWithModelFallback(
  opts: ExecuteGeminiChainOptions,
): Promise<{ text: string; modelUsed: string; endpointUsed: GeminiEndpointKind }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const routing = parseGeminiKeyRouting(opts.apiKey, opts.geminiEndpoint ?? 'ai_studio');
  const keyFormat = opts.keyFormat ?? routing.keyFormat;
  const primaryEndpoint = opts.geminiEndpoint ?? routing.geminiEndpoint;

  try {
    return await runChainOnEndpoint(opts, routing.cleanKey, primaryEndpoint, keyFormat, fetchImpl);
  } catch (err) {
    const isAqKey = /^AQ\./.test(routing.cleanKey);
    if (!isAqKey || !isGeminiAuthOrInvalidKeyError(err)) {
      throw err;
    }

    const alternateEndpoint: GeminiEndpointKind | null =
      primaryEndpoint === 'ai_studio' && opts.allowAqVertexFallbackOnAuthError !== false
        ? 'vertex'
        : primaryEndpoint === 'vertex' && opts.allowAqAiStudioFallbackOnAuthError !== false
          ? 'ai_studio'
          : null;

    if (!alternateEndpoint) {
      throw err;
    }

    return await runChainOnEndpoint(opts, routing.cleanKey, alternateEndpoint, keyFormat, fetchImpl);
  }
}

/** Kiểm tra trực tiếp một key Gemini (`AIzaSy*`/`AQ.*` qua AI Studio hoặc `vertex:`/`ya29.*` qua Vertex/OAuth). */
export async function probeGeminiKeyEndpoint(params: {
  apiKey: string;
  geminiEndpoint?: GeminiEndpointKind;
  keyFormat?: GeminiKeyFormat;
  defaultModel?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; endpointUsed: GeminiEndpointKind; modelUsed: string; detail: string }> {
  const modelsToTry = buildGeminiModelChain(params.defaultModel ?? DEFAULT_GEMINI_MODEL);
  const { text, modelUsed, endpointUsed } = await executeGeminiWithModelFallback({
    apiKey: params.apiKey,
    geminiEndpoint: params.geminiEndpoint,
    keyFormat: params.keyFormat,
    models: modelsToTry,
    contents: [{ role: 'user', parts: [{ text: 'Trả lời duy nhất từ: OK' }] }],
    config: { maxOutputTokens: 64, thinkingLevel: 'low' },
    timeoutMs: params.timeoutMs ?? 8_000,
    label: 'KeyPool Probe',
    fallbackModelOn503: true,
    fetchImpl: params.fetchImpl,
  });
  const endpointLabel = endpointUsed === 'vertex' ? 'Vertex AI' : 'Google AI Studio';
  return {
    ok: true,
    endpointUsed,
    modelUsed,
    detail: `${endpointLabel} (${modelUsed}) phản hồi thành công${text ? `: "${text.trim().slice(0, 24)}"` : ''}.`,
  };
}
