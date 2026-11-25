import type { AuthSession } from '@shared/types';
import { authStore } from './authStore';
import { deviceFingerprintSync } from './deviceFp';

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
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Nội bộ: tránh đệ quy khi gọi /api/auth/refresh */
  _retried?: boolean;
}

export function apiUrl(path: string): string {
  return `${BASE}${path}`;
}

export function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = authStore.token();
  return {
    'X-Device-Fp': deviceFingerprintSync(),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
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
      if (!res.ok) return false;
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
  if (res.status === 401 && !alreadyRetried && !path.startsWith('/api/auth/')) {
    const refreshed = await tryRefreshSession();
    if (refreshed) {
      return retry();
    }
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new ApiError(res.status, 'bad_response', 'Máy chủ trả về dữ liệu không hợp lệ');
    }
  }
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
    if (res.status === 401 && authStore.token()) authStore.clear();
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `Lỗi ${res.status}`, e?.details);
  }
  return data as T;
}

export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  const ctrl = new AbortController();
  const timeout = window.setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20000);
  opts.signal?.addEventListener('abort', () => ctrl.abort());
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
      credentials: 'include',
      headers: authHeaders(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
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
  const ctrl = new AbortController();
  const timeout = window.setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30000);
  opts.signal?.addEventListener('abort', () => ctrl.abort());
  let res: Response;
  try {
    res = await fetch(apiUrl(path), {
      method: opts.method ?? 'POST',
      credentials: 'include',
      headers: authHeaders(),
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
export async function streamChat(
  body: { messages: Array<{ role: 'user' | 'model'; text: string }>; wardCode?: string; locale: 'vi' | 'en' },
  onChunk: (c: ChatChunk) => void,
  signal: AbortSignal,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(apiUrl('/api/ai/chat'), {
      method: 'POST',
      credentials: 'include',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return;
    throw new NetworkError();
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
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const line = frame.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      try {
        onChunk(JSON.parse(line.slice(6)) as ChatChunk);
      } catch (err) {
        console.warn('Khung SSE không hợp lệ:', err);
      }
    }
  }
}
