import type { ApiKeyStatus } from './types';

export type KeyErrorKind =
  | 'RATE_LIMIT_429'
  | 'OVERLOADED_503'
  | 'DAILY_QUOTA_EXHAUSTED'
  | 'MODEL_NOT_FOUND_404'
  | 'INVALID_KEY'
  | 'TRANSIENT_UPSTREAM'
  | 'NON_RETRYABLE';

export interface ClassifiedKeyError {
  kind: KeyErrorKind;
  httpStatus: number | null;
  targetStatus: ApiKeyStatus;
  retryable: boolean;
  reasonSummary: string;
}

/** Lịch Exponential Backoff chuẩn cho lỗi 429 RPM/TPM: 1 phút -> 3 phút -> 10 phút. */
export const DEFAULT_COOLDOWN_STEPS_MS: readonly number[] = [
  60_000,
  180_000,
  600_000,
] as const;

const DAILY_QUOTA_RE =
  /(per[_ -]?day|daily\s*(quota|limit)|requests?\s*per\s*day|\brpd\b|generaterequestsperday|free_tier_requests.*day|quota.*day|hết\s*quota\s*ngày)/i;

const RATE_LIMIT_RE =
  /(\b429\b|too many requests|resource_exhausted|rate[_ -]?limit|quota exceeded|tokens? per minute|\brpm\b|\btpm\b)/i;

const INVALID_KEY_RE =
  /(api[_ -]?key[_ -]?invalid|api key not valid|invalid[_ -]?api[_ -]?key|api_key_service_blocked|api_key_http_referrer_blocked|service_disabled|has not been used in project|accessnotconfigured|unauthenticated|permission_denied|invalid authentication|incorrect api key|key.*revoked|key.*leaked|key.*expired|unauthorized|forbidden)/i;

const MODEL_NOT_FOUND_RE =
  /(is not found for api version|publisher model.*not found|model.*not found|models\/[^\s]+.*not found)/i;

const OVERLOADED_503_RE = /(\b503\b|model is overloaded|service unavailable|high demand)/i;

const TRANSIENT_RE =
  /(\b500\b|\b502\b|\b504\b|unavailable|deadline_exceeded|internal error|quá thời gian|timeout|timed out|econnreset|etimedout|fetch failed|socket hang up)/i;

function extractHttpStatus(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as Record<string, unknown>;
  for (const field of ['status', 'statusCode', 'httpStatus', 'code']) {
    const val = e[field];
    if (typeof val === 'number' && val >= 100 && val <= 599) return val;
  }
  const nestedErr = e.error;
  if (nestedErr && typeof nestedErr === 'object') {
    const code = (nestedErr as Record<string, unknown>).code;
    if (typeof code === 'number' && code >= 100 && code <= 599) return code;
  }
  const msg = err instanceof Error ? err.message : String(err);
  const match = msg.match(/\b(400|401|403|404|408|429|500|502|503|504)\b/);
  return match ? Number(match[1]) : null;
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) {
    const extra: string[] = [err.message];
    const rec = err as unknown as Record<string, unknown>;
    if (rec.details) {
      try {
        extra.push(JSON.stringify(rec.details));
      } catch {
        // Bỏ qua nếu vòng tham chiếu
      }
    }
    if (rec.error && typeof rec.error === 'object') {
      try {
        extra.push(JSON.stringify(rec.error));
      } catch {
        // Bỏ qua nếu vòng tham chiếu
      }
    }
    return extra.join(' | ');
  }
  if (typeof err === 'string') return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Làm sạch thông điệp lỗi từ SDK/HTTP để tuyệt đối không trả mảng/chuỗi JSON lỗi thô ra log hay response. */
export function sanitizeUpstreamErrorReason(rawText: string, status: number | null): string {
  const trimmed = rawText.trim();
  if (!trimmed) return status ? `HTTP ${status} Upstream Error` : 'Upstream AI Error';

  // Nếu chuỗi chứa khối JSON `{"error": ...}` hoặc `[{"error": ...}]`, trích xuất `error.message` và `error.status` gọn gàng
  const jsonStart = trimmed.search(/[\[{]\s*"error"\s*:/);
  const candidateJson =
    jsonStart >= 0
      ? trimmed.slice(jsonStart)
      : trimmed.startsWith('{') || trimmed.startsWith('[')
        ? trimmed
        : null;

  if (candidateJson) {
    try {
      const parsed = JSON.parse(candidateJson) as unknown;
      const root = Array.isArray(parsed) ? (parsed[0] as Record<string, unknown> | undefined) : (parsed as Record<string, unknown>);
      const errObj =
        root && typeof root === 'object' && root.error && typeof root.error === 'object'
          ? (root.error as Record<string, unknown>)
          : root;
      if (errObj && typeof errObj === 'object') {
        const code = typeof errObj.code === 'number' ? errObj.code : status;
        const statusStr = typeof errObj.status === 'string' ? errObj.status : '';
        const msgStr = typeof errObj.message === 'string' ? errObj.message.replace(/\s+/g, ' ').trim() : '';
        const prefix = [code ? `HTTP ${code}` : '', statusStr].filter(Boolean).join(' ');
        if (msgStr) {
          return `${prefix ? `${prefix}: ` : ''}${msgStr}`.slice(0, 200);
        }
      }
    } catch {
      // Nếu JSON bị cắt cụt, loại bỏ phần ngoặc nhọn/mảng JSON thô phía sau
    }
  }

  const strippedJson = trimmed
    .replace(/\s*[\[{]\s*"error"[\s\S]*$/i, '')
    .replace(/\s*\[\s*\{\s*"@type"[\s\S]*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();

  return (strippedJson || (status ? `HTTP ${status} Upstream Error` : 'Upstream AI Error')).slice(0, 200);
}

/** Phân loại lỗi từ Gemini / OpenRouter / Groq để quyết định trạng thái Circuit Breaker của từng key. */
export function classifyUpstreamError(err: unknown): ClassifiedKeyError {
  const status = extractHttpStatus(err);
  const fullText = stringifyError(err);
  const rawMessage = err instanceof Error ? err.message : fullText;
  const shortReason = sanitizeUpstreamErrorReason(rawMessage, status);

  // 1. Lỗi 429 / RESOURCE_EXHAUSTED: tách bạch RPD (hết quota ngày) vs RPM/TPM (tạm thời)
  if (status === 429 || RATE_LIMIT_RE.test(fullText)) {
    if (DAILY_QUOTA_RE.test(fullText)) {
      return {
        kind: 'DAILY_QUOTA_EXHAUSTED',
        httpStatus: status ?? 429,
        targetStatus: 'EXHAUSTED',
        retryable: true,
        reasonSummary: shortReason || '429 Daily Quota Exhausted (RPD)',
      };
    }
    return {
      kind: 'RATE_LIMIT_429',
      httpStatus: status ?? 429,
      targetStatus: 'COOLDOWN',
      retryable: true,
      reasonSummary: shortReason || '429 Too Many Requests (RPM/TPM)',
    };
  }

  // 2. HTTP 404 (Model Not Found): TUYỆT ĐỐI không đánh dấu API key INVALID/REVOKED; giữ key HEALTHY để thử model/key khác
  if (
    status === 404 ||
    (status !== 401 &&
      status !== 403 &&
      !INVALID_KEY_RE.test(fullText) &&
      (/\b404\b|not[_ -]?found/i.test(fullText) && MODEL_NOT_FOUND_RE.test(fullText)))
  ) {
    return {
      kind: 'MODEL_NOT_FOUND_404',
      httpStatus: 404,
      targetStatus: 'HEALTHY',
      retryable: true,
      reasonSummary: shortReason || 'HTTP 404 Model Not Found',
    };
  }

  // 3. Key chết / bị thu hồi / sai quyền (401/403 hoặc thông điệp xác thực API_KEY_INVALID)
  if (status === 401 || status === 403 || INVALID_KEY_RE.test(fullText)) {
    return {
      kind: 'INVALID_KEY',
      httpStatus: status ?? 401,
      targetStatus: 'INVALID',
      retryable: true,
      reasonSummary: shortReason || `HTTP ${status ?? 401} Invalid or Revoked API Key`,
    };
  }

  // 4. Lỗi 503 (Model Overloaded / Service Unavailable): tạm thời Cooldown (60s) và xoay sang key kế tiếp, không đánh dấu INVALID
  if (status === 503 || OVERLOADED_503_RE.test(fullText)) {
    return {
      kind: 'OVERLOADED_503',
      httpStatus: status ?? 503,
      targetStatus: 'COOLDOWN',
      retryable: true,
      reasonSummary: shortReason || 'HTTP 503 Service Unavailable / Overloaded',
    };
  }

  // 5. Lỗi máy chủ upstream tạm thời / mạng chập chờn -> giữ key HEALTHY và xoay sang key kế tiếp
  if ((status !== null && status >= 500) || status === 408 || TRANSIENT_RE.test(fullText)) {
    return {
      kind: 'TRANSIENT_UPSTREAM',
      httpStatus: status,
      targetStatus: 'HEALTHY',
      retryable: true,
      reasonSummary: shortReason || 'Transient Upstream Error',
    };
  }

  // 4. Lỗi nội dung / schema không liên quan tới sức khỏe API key
  return {
    kind: 'NON_RETRYABLE',
    httpStatus: status,
    targetStatus: 'HEALTHY',
    retryable: false,
    reasonSummary: shortReason || 'Non-retryable AI Request Error',
  };
}

/** Tính thời gian Cooldown Exponential Backoff (1m -> 3m -> 10m) theo số lần chạm 429 liên tiếp. */
export function computeCooldownMs(
  consecutive429: number,
  stepsMs: readonly number[] = DEFAULT_COOLDOWN_STEPS_MS,
): number {
  const palette = stepsMs.length > 0 ? stepsMs : DEFAULT_COOLDOWN_STEPS_MS;
  const idx = Math.max(0, Math.min(consecutive429 - 1, palette.length - 1));
  return palette[idx];
}

/**
 * Tính mốc Unix timestamp (ms) của 00:00:00 ngày kế tiếp theo múi giờ cấu hình
 * (mặc định `Asia/Ho_Chi_Minh`, hỗ trợ cả `America/Los_Angeles` / PST).
 */
export function computeNextMidnightMs(nowMs: number, timeZone = 'Asia/Ho_Chi_Minh'): number {
  let effectiveTz = timeZone;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: effectiveTz }).format(new Date(nowMs));
  } catch {
    effectiveTz = 'Asia/Ho_Chi_Minh';
  }

  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: effectiveTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });

  const partsOf = (ms: number) => {
    const map: Record<string, number> = {};
    for (const p of fmt.formatToParts(new Date(ms))) {
      if (p.type !== 'literal') map[p.type] = Number(p.value);
    }
    return map;
  };

  const cur = partsOf(nowMs);
  // Ước lượng khoảng cách từ thời điểm hiện tại tới 24:00:00 địa phương, sau đó tinh chỉnh chính xác
  const elapsedSecToday = (cur.hour ?? 0) * 3600 + (cur.minute ?? 0) * 60 + (cur.second ?? 0);
  const secUntilMidnight = Math.max(1, 86_400 - elapsedSecToday);
  let candidateMs = Math.floor(nowMs / 1000) * 1000 + secUntilMidnight * 1000;

  // Tinh chỉnh bù sai số DST (vd: America/Los_Angeles chuyển PST <-> PDT)
  const check = partsOf(candidateMs);
  if (check.hour !== 0 || check.minute !== 0 || check.second !== 0) {
    const driftSec =
      (check.hour >= 12 ? check.hour - 24 : check.hour) * 3600 +
      check.minute * 60 +
      check.second;
    candidateMs -= driftSec * 1000;
  }

  return candidateMs > nowMs ? candidateMs : nowMs + 60_000;
}
