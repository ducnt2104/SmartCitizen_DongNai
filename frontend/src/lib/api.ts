import type { AuthSession } from '@shared/types';
import { authStore } from './authStore';
import { deviceFingerprintSync } from './deviceFp';
import { requiresPowSolution, solvePowHeader } from './securityChallenge';

const BASE = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? '';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Lỗi mạng (offline / server ngủ / CORS). Khác với ApiError (server đã phản hồi). */
export class NetworkError extends Error {
  constructor(message = 'Không kết nối được máy chủ') {
    super(message);
    this.name = 'NetworkError';
  }
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  token?: string | null;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Nội bộ: tránh đệ quy khi gọi /api/auth/refresh */
  _retried?: boolean;
}

export interface SessionTerminatedDetail {
  code: string;
  message: string;
}

export const sessionTerminatedBus = new EventTarget();

let lastSessionTerminationMsgAt = 0;
function emitSessionTerminated(code: string, message: string): void {
  authStore.clear();
  const now = Date.now();
  if (now - lastSessionTerminationMsgAt > 1200) {
    lastSessionTerminationMsgAt = now;
    sessionTerminatedBus.dispatchEvent(
      new CustomEvent<SessionTerminatedDetail>('terminated', { detail: { code, message } }),
    );
  }
}

let cachedReauthToken: { token: string; expiresAt: number } | null = null;

export function getCachedReauthHeader(): Record<string, string> {
  if (cachedReauthToken && cachedReauthToken.expiresAt > Date.now() + 5000) {
    return { 'X-Reauth-Token': cachedReauthToken.token };
  }
  return {};
}

export async function authenticateReauth(currentPassword: string): Promise<string> {
  const res = await api<{ reauthToken: string; expiresInSec: number }>('/api/auth/reauth', {
    method: 'POST',
    body: { currentPassword },
  });
  cachedReauthToken = {
    token: res.reauthToken,
    expiresAt: Date.now() + res.expiresInSec * 1000,
  };
  return res.reauthToken;
}

export function clearCachedReauth(): void {
  cachedReauthToken = null;
}

export function apiUrl(path: string): string {
  return `${BASE}${path}`;
}

export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = authStore.token();
  return {
    'X-Device-Fp': deviceFingerprintSync(),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...getCachedReauthHeader(),
    ...extra,
  };
}

let refreshingPromise: Promise<boolean> | null = null;

/** Thử xoay vòng Refresh Token qua HTTP-only Cookie khi Access Token ngắn hạn (15m) hết hạn. */
async function tryRefreshSession(): Promise<boolean> {
  if (refreshingPromise) return refreshingPromise;
  refreshingPromise = (async () => {
    try {
      const res = await fetch(apiUrl('/api/auth/refresh'), {
        method: 'POST',
        credentials: 'include',
        headers: { 'X-Device-Fp': deviceFingerprintSync() },
      });
      if (!res.ok) {
        const errJson = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
        if (errJson?.error?.code === 'SESSION_REPLACED' || errJson?.error?.code === 'SESSION_COMPROMISED') {
          emitSessionTerminated(
            errJson.error.code,
            errJson.error.message ?? 'Tài khoản đã được đăng nhập trên thiết bị khác.',
          );
        }
        return false;
      }
      const session = (await res.json()) as AuthSession;
      authStore.set(session);
      return true;
    } catch {
      return false;
    } finally {
      refreshingPromise = null;
    }
  })();
  return refreshingPromise;
}

export interface MultipartOptions {
  method?: 'POST' | 'PUT' | 'PATCH';
  body: FormData;
  signal?: AbortSignal;
  timeoutMs?: number;
  _retried?: boolean;
}

async function parseJsonResponse<T>(
  path: string,
  res: Response,
  alreadyRetried: boolean | undefined,
  retry: () => Promise<T>,
): Promise<T> {
  let preParsedData: unknown = null;
  let hasPreParsed = false;

  if (res.status === 401 && !alreadyRetried && !path.startsWith('/api/auth/')) {
    const rawText = await res.clone().text().catch(() => '');
    try {
      preParsedData = rawText ? JSON.parse(rawText) : null;
      hasPreParsed = true;
    } catch {
      preParsedData = null;
    }
    const errCode = (preParsedData as { error?: { code?: string } } | null)?.error?.code;
    const isTerminated =
      errCode === 'SESSION_REPLACED' || errCode === 'SESSION_REVOKED' || errCode === 'SESSION_COMPROMISED';
    if (!isTerminated) {
      const refreshed = await tryRefreshSession();
      if (refreshed) {
        return retry();
      }
    }
  }

  const text = hasPreParsed ? '' : await res.text();
  const data: unknown = hasPreParsed
    ? preParsedData
    : (() => {
        if (!text) return null;
        try {
          return JSON.parse(text);
        } catch {
          throw new ApiError(res.status, 'bad_response', 'Máy chủ trả về dữ liệu không hợp lệ');
        }
      })();
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    if (res.status === 401) {
      const code = e?.code ?? 'unauthorized';
      if (code === 'SESSION_REPLACED' || code === 'SESSION_REVOKED' || code === 'SESSION_COMPROMISED') {
        emitSessionTerminated(code, e?.message ?? 'Tài khoản đã được đăng nhập trên thiết bị khác.');
      } else if (authStore.token()) {
        authStore.clear();
      }
    }
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `Lỗi ${res.status}`, e?.details);
  }
  return data as T;
}

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const method = opts.method ?? (opts.body === undefined ? 'GET' : 'POST');
  const powHeaders: Record<string, string> = {};
  if (requiresPowSolution(path, method) && !opts.headers?.['X-PoW-Solution']) {
    powHeaders['X-PoW-Solution'] = await solvePowHeader(BASE, authHeaders());
  }
  const ctrl = new AbortController();
  const timeout = window.setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20000);
  opts.signal?.addEventListener('abort', () => ctrl.abort());
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      method,
      credentials: 'include',
      headers: authHeaders({
        ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...powHeaders,
        ...(opts.headers ?? {}),
      }),
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new NetworkError(err instanceof Error && err.name === 'AbortError' ? 'Máy chủ phản hồi quá chậm' : undefined);
  } finally {
    window.clearTimeout(timeout);
  }

  return parseJsonResponse<T>(path, res, opts._retried, () => api<T>(path, { ...opts, _retried: true }));
}

export async function apiMultipart<T>(path: string, opts: MultipartOptions): Promise<T> {
  const method = opts.method ?? 'POST';
  const powHeaders: Record<string, string> = {};
  if (requiresPowSolution(path, method)) {
    powHeaders['X-PoW-Solution'] = await solvePowHeader(BASE, authHeaders());
  }
  const ctrl = new AbortController();
  const timeout = window.setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30000);
  opts.signal?.addEventListener('abort', () => ctrl.abort());
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      method,
      credentials: 'include',
      headers: authHeaders(powHeaders),
      body: opts.body,
      signal: ctrl.signal,
    });
  } catch (err) {
    throw new NetworkError(err instanceof Error && err.name === 'AbortError' ? 'Máy chủ phản hồi quá chậm' : undefined);
  } finally {
    window.clearTimeout(timeout);
  }

  return parseJsonResponse<T>(path, res, opts._retried, () => apiMultipart<T>(path, { ...opts, _retried: true }));
}

export async function downloadFile(path: string, filename: string): Promise<void> {
  const res = await fetch(apiUrl(path), { credentials: 'include', headers: authHeaders() }).catch(() => {
    throw new NetworkError();
  });
  if (!res.ok) throw new ApiError(res.status, 'download_failed', 'Không tải được tệp báo cáo');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export interface ChatChunk {
  delta?: string;
  mode?: 'gemini' | 'fallback';
  done?: boolean;
  error?: string;
}

/** Đọc SSE từ POST /api/ai/chat (fetch + ReadableStream, hỗ trợ AbortController). */
export const GEMINI_KEY_STORAGE = 'gemini_api_key';
const LEGACY_GEMINI_KEY_STORAGE = 'sc_gemini_api_key';

export function getStoredGeminiApiKey(): string {
  const envKey = (import.meta.env?.VITE_GEMINI_API_KEY as string | undefined)?.trim() ?? '';
  if (envKey) return envKey;
  try {
    const primary = window.localStorage.getItem(GEMINI_KEY_STORAGE)?.trim() ?? '';
    if (primary) return primary;
    const legacy = window.localStorage.getItem(LEGACY_GEMINI_KEY_STORAGE)?.trim() ?? '';
    if (legacy) return legacy;
  } catch {
    /* ignore storage errors */
  }
  return '';
}

export function saveStoredGeminiApiKey(rawKey: string): void {
  const clean = rawKey.trim();
  try {
    if (clean) {
      window.localStorage.setItem(GEMINI_KEY_STORAGE, clean);
      window.localStorage.setItem(LEGACY_GEMINI_KEY_STORAGE, clean);
    } else {
      window.localStorage.removeItem(GEMINI_KEY_STORAGE);
      window.localStorage.removeItem(LEGACY_GEMINI_KEY_STORAGE);
    }
  } catch {
    /* ignore storage errors */
  }
}

let cachedClientGeminiModel = 'gemini-3.8-flash';

async function discoverLatestFlashModelClient(apiKey: string, signal: AbortSignal): Promise<string | null> {
  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
      { signal },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
    };
    const candidates = (data.models ?? [])
      .filter((m) => {
        const name = (m.name ?? '').toLowerCase();
        const methods = m.supportedGenerationMethods ?? [];
        return (
          name.includes('flash') &&
          !/embedding|tts|image|audio|lite-preview/i.test(name) &&
          (methods.includes('streamGenerateContent') || methods.includes('generateContent'))
        );
      })
      .map((m) => (m.name ?? '').replace(/^models\//, ''))
      .filter(Boolean)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    return candidates[0] ?? null;
  } catch {
    return null;
  }
}

async function streamDirectGeminiClient(
  apiKey: string,
  body: { messages: Array<{ role: 'user' | 'model'; text: string }>; wardCode?: string; locale: 'vi' | 'en' },
  onChunk: (c: ChatChunk) => void,
  signal: AbortSignal,
): Promise<void> {
  const sysText =
    `Bạn là Trợ lý AI Công dân TP. Đồng Nai thân thiện, lễ phép, hỗ trợ người dân (đặc biệt là người lớn tuổi). ` +
    `Trả lời ngắn gọn, súc tích (khoảng 3-5 gạch đầu dòng rõ ý), dùng từ ngữ đời thường dễ hiểu, không viết quá dài dòng. ` +
    `Khu vực đang chọn: ${body.wardCode ?? 'Toàn TP. Đồng Nai'}. Số khẩn cấp Đồng Nai: Công an 113, Cứu hỏa 114, Cấp cứu 115.`;

  const callModel = (modelId: string) => {
    const isV3OrNewer = /^gemini-(?:3|4)(?:\.|-|$)/i.test(modelId);
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelId)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sysText }] },
        contents: body.messages.slice(-20).map((m) => ({
          role: m.role === 'model' ? 'model' : 'user',
          parts: [{ text: m.text }],
        })),
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 800,
          thinkingConfig: isV3OrNewer ? { thinkingLevel: 'low' } : { thinkingBudget: 0 },
        },
      }),
      signal,
    });
  };

  let modelId = cachedClientGeminiModel;
  let res = await callModel(modelId);
  if (res.status === 404) {
    const discovered = await discoverLatestFlashModelClient(apiKey, signal);
    if (discovered && discovered !== modelId) {
      modelId = discovered;
      cachedClientGeminiModel = discovered;
      res = await callModel(modelId);
    }
  }

  if (!res.ok || !res.body) {
    const raw = await res.text().catch(() => '');
    let detail = `HTTP ${res.status}`;
    try {
      detail = (JSON.parse(raw) as { error?: { message?: string } }).error?.message ?? detail;
    } catch {
      if (raw) detail = `${detail}: ${raw.slice(0, 120)}`;
    }
    throw new ApiError(res.status, 'gemini_direct_failed', `Lỗi ${res.status}: ${detail}`);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const parseFrame = (frame: string): void => {
    const dataLines = frame
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .filter((l) => l && l !== '[DONE]');
    if (dataLines.length === 0) return;
    try {
      const parsed = JSON.parse(dataLines.join('\n')) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      };
      const delta = (parsed.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      if (delta) onChunk({ delta, mode: 'gemini' });
    } catch {
      /* ignore partial SSE frame */
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      parseFrame(frame);
    }
  }
  if (buf.trim()) parseFrame(buf);
}

export async function streamChat(
  body: { messages: Array<{ role: 'user' | 'model'; text: string }>; wardCode?: string; locale: 'vi' | 'en' },
  onChunk: (c: ChatChunk) => void,
  externalSignal: AbortSignal,
): Promise<void> {
  const userGeminiKey = getStoredGeminiApiKey();
  const timeoutCtrl = new AbortController();
  let timedOut = false;
  const timeoutId = window.setTimeout(() => {
    timedOut = true;
    timeoutCtrl.abort();
  }, 15_000);
  const onExternalAbort = (): void => timeoutCtrl.abort();
  externalSignal.addEventListener('abort', onExternalAbort, { once: true });

  const headers = authHeaders({ 'Content-Type': 'application/json' });
  if (userGeminiKey) {
    headers['X-Gemini-Api-Key'] = userGeminiKey;
  }

  try {
    let res: Response | null = null;
    try {
      res = await fetch(apiUrl('/api/ai/chat'), {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify(body),
        signal: timeoutCtrl.signal,
      });
    } catch (err) {
      if (timedOut) throw new ApiError(408, 'timeout', 'Kết nối quá hạn (15 giây), vui lòng thử lại.');
      if (externalSignal.aborted) return;
      if (userGeminiKey) {
        await streamDirectGeminiClient(userGeminiKey, body, onChunk, timeoutCtrl.signal);
        return;
      }
      throw new NetworkError();
    }

    const contentType = res.headers.get('content-type') ?? '';
    const isStaticHtmlOr404 = res.status === 404 || contentType.includes('text/html');
    if (isStaticHtmlOr404) {
      if (!userGeminiKey) {
        throw new ApiError(
          res.status,
          'missing_gemini_key',
          'Chưa kết nối API Key của Gemini. Vui lòng nhập API Key bên dưới hoặc trong mục Cài đặt ⚙️',
        );
      }
      await streamDirectGeminiClient(userGeminiKey, body, onChunk, timeoutCtrl.signal);
      return;
    }

    if (!res.ok || !res.body) {
      const t = await res.text().catch(() => '');
      let msg = `Lỗi ${res.status}`;
      try {
        msg = (JSON.parse(t) as { error?: { message?: string } }).error?.message ?? msg;
      } catch {
        /* giữ thông điệp mặc định */
      }
      throw new ApiError(res.status, 'chat_failed', msg);
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const emitFrame = (frame: string): void => {
      const line = frame.split(/\r?\n/).find((l) => l.startsWith('data: '));
      if (!line) return;
      try {
        onChunk(JSON.parse(line.slice(6)) as ChatChunk);
      } catch (err) {
        console.warn('Khung SSE không hợp lệ:', err);
      }
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        emitFrame(frame);
      }
    }
    if (buf.trim()) emitFrame(buf);
  } catch (err) {
    if (timedOut) {
      throw new ApiError(408, 'timeout', 'Kết nối quá hạn (15 giây), vui lòng thử lại.');
    }
    if (externalSignal.aborted) return;
    throw err;
  } finally {
    window.clearTimeout(timeoutId);
    externalSignal.removeEventListener('abort', onExternalAbort);
  }
}
