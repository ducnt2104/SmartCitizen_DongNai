import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function hmacSha256(secret: string, text: string): string {
  return crypto.createHmac('sha256', secret).update(text).digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function randomOpaqueToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function userIdFromPhone(phone: string): string {
  return `u_${sha256(`phone:${phone}`).slice(0, 14)}`;
}

export function userIdFromEmail(email: string): string {
  return `u_${sha256(`email:${email.toLowerCase()}`).slice(0, 14)}`;
}

/**
 * Băm mật khẩu chuẩn Production bằng `bcryptjs` (cost factor 12).
 * Tương thích ngược hai chiều với bản băm `salt:scryptHex` và cost 10 đã lưu trước đó trong DB.
 */
export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 12);
}

/**
 * Kiểm tra chính sách mật khẩu mạnh chuẩn Production:
 * tối thiểu 8 ký tự, gồm chữ hoa, chữ thường, chữ số và ký tự đặc biệt.
 */
export function validatePasswordStrength(password: string): { valid: boolean; reason?: string } {
  if (typeof password !== 'string' || password.length < 8) {
    return { valid: false, reason: 'Mật khẩu phải có tối thiểu 8 ký tự.' };
  }
  if (!/[A-Z]/.test(password)) {
    return { valid: false, reason: 'Mật khẩu phải chứa ít nhất 1 chữ cái viết hoa (A-Z).' };
  }
  if (!/[a-z]/.test(password)) {
    return { valid: false, reason: 'Mật khẩu phải chứa ít nhất 1 chữ cái viết thường (a-z).' };
  }
  if (!/[0-9]/.test(password)) {
    return { valid: false, reason: 'Mật khẩu phải chứa ít nhất 1 chữ số (0-9).' };
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    return { valid: false, reason: 'Mật khẩu phải chứa ít nhất 1 ký tự đặc biệt (!@#$%^&*...).' };
  }
  return { valid: true };
}

export function verifyPassword(password: string, stored: string): boolean {
  if (!stored) return false;
  if (stored.startsWith('$2a$') || stored.startsWith('$2b$') || stored.startsWith('$2y$')) {
    return bcrypt.compareSync(password, stored);
  }
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  try {
    const candidate = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(hash, 'hex');
    return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
  } catch {
    return false;
  }
}

/** Sinh mã OTP 6 chữ số an toàn bằng CSPRNG (`100000`–`999999`). */
export function randomOtp(): string {
  return String(crypto.randomInt(100_000, 1_000_000));
}
