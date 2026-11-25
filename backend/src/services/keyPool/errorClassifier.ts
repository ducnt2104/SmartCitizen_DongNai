import type { ApiKeyStatus } from './types';

export type KeyErrorKind =
  | 'RATE_LIMIT_429'
  | 'DAILY_QUOTA_EXHAUSTED'
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
  /(api[_ -]?key[_ -]?invalid|api key not valid|invalid[_ -]?api[_ -]?key|api_key_service_blocked|api_key_http_referrer_blocked|unauthenticated|permission_denied|invalid authentication|incorrect api key|key.*revoked|key.*expired|unauthorized)/i;

const PAYLOAD_ONLY_400_RE =
  /(inlinedata|mimetype|responseschema|safety|blocked by safety|recitation|context length|maximum context)/i;

const TRANSIENT_RE =
  /(\b500\b|\b502\b|\b503\b|\b504\b|unavailable|deadline_exceeded|internal error|overloaded|quá thời gian|timeout|timed out|econnreset|etimedout|fetch failed|socket hang up)/i;

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

/** Phân loại lỗi từ Gemini / OpenRouter / Groq để quyết định trạng thái Circuit Breaker của từng key. */
export function classifyUpstreamError(err: unknown): ClassifiedKeyError {
  const status = extractHttpStatus(err);
  const fullText = stringifyError(err);
  const shortReason = (err instanceof Error ? err.message : fullText).slice(0, 240);

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

  // 2. Key chết / bị thu hồi / sai quyền (400/401/403 hoặc thông điệp xác thực)
  if (
    status === 401 ||
    status === 403 ||
    INVALID_KEY_RE.test(fullText) ||
    (status === 400 && !PAYLOAD_ONLY_400_RE.test(fullText))
  ) {
    return {
      kind: 'INVALID_KEY',
      httpStatus: status ?? 401,
      targetStatus: 'INVALID',
      retryable: true,
      reasonSummary: shortReason || `HTTP ${status ?? 401} Invalid or Revoked API Key`,
    };
  }

  // 3. Lỗi máy chủ upstream tạm thời / quá tải / mạng chập chờn -> giữ key HEALTHY và xoay sang key kế tiếp
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
