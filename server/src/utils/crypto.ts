import crypto from 'node:crypto';

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function userIdFromPhone(phone: string): string {
  return `u_${sha256(`phone:${phone}`).slice(0, 14)}`;
}

export function userIdFromEmail(email: string): string {
  return `u_${sha256(`email:${email.toLowerCase()}`).slice(0, 14)}`;
}

/** scrypt: không cần thêm dependency native (bcrypt). Định dạng: salt:hash (hex). */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

export function randomOtp(): string {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}
