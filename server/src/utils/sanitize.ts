/**
 * Chống NoSQL Injection: loại bỏ mọi key bắt đầu bằng `$` hoặc chứa `.` ở mọi cấp độ.
 * Chạy TRƯỚC Zod trên req.body / req.query / req.params.
 */
export function stripMongoOperators<T>(input: T, depth = 0): T {
  if (depth > 12) return input;
  if (Array.isArray(input)) return input.map((v) => stripMongoOperators(v, depth + 1)) as unknown as T;
  if (input && typeof input === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (k.startsWith('$') || k.includes('.')) continue;
      out[k] = stripMongoOperators(v, depth + 1);
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
