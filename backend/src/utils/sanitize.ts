const RAW_SECRET_KEYS = new Set([
  'password',
  'currentPassword',
  'newPassword',
  'reauthPassword',
  'token',
  'refreshToken',
  'reauthToken',
  'firebaseIdToken',
  'idToken',
  'signature',
  'dataUrl',
  'apiKey',
  'keysText',
]);

/**
 * Loại bỏ các thẻ HTML / vector XSS nguy hiểm khỏi chuỗi văn bản người dùng nhập.
 * Giữ nguyên text tiếng Việt, URL chuẩn http(s):// và không chạm vào chuỗi mật khẩu / base64 ảnh.
 */
export function sanitizeXssText(raw: string): string {
  return raw
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, '')
    .replace(/<embed\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/javascript\s*:/gi, '')
    .replace(/vbscript\s*:/gi, '')
    .replace(/on[a-z]+\s*=\s*(['"]).*?\1/gi, '')
    .replace(/on[a-z]+\s*=[^\s>]+/gi, '')
    .trim();
}

/**
 * Chống NoSQL Injection & XSS:
 * - Loại bỏ mọi key bắt đầu bằng `$` hoặc chứa `.` ở mọi cấp độ.
 * - Làm sạch các chuỗi văn bản chứa thẻ HTML / `<script>` / `javascript:` (trừ các trường mật khẩu / token / dataUrl).
 */
export function stripMongoOperators<T>(input: T, depth = 0, keyName?: string): T {
  if (depth > 12) return input;
  if (typeof input === 'string') {
    if (keyName && RAW_SECRET_KEYS.has(keyName)) return input;
    if (input.startsWith('data:image/')) return input;
    return sanitizeXssText(input) as unknown as T;
  }
  if (Array.isArray(input)) {
    return input.map((v) => stripMongoOperators(v, depth + 1, keyName)) as unknown as T;
  }
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (k.startsWith('$') || k.includes('.')) continue;
      out[k] = stripMongoOperators(v, depth + 1, k);
    }
    return out as T;
  }
  return input;
}

export function hasMongoOperators(input: unknown, depth = 0): boolean {
  if (depth > 12) return false;
  if (Array.isArray(input)) return input.some((v) => hasMongoOperators(v, depth + 1));
  if (input && typeof input === 'object') {
    return Object.entries(input as Record<string, unknown>).some(
      ([k, v]) => k.startsWith('$') || k.includes('.') || hasMongoOperators(v, depth + 1),
    );
  }
  return false;
}
