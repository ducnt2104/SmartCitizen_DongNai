import jwt from 'jsonwebtoken';
import { z } from 'zod';
import type { AuthSession, Role } from '../../../shared/types';
import { UNIT_CODE_REGEX } from '../../../shared/constants';
import { getWard } from '../../../shared/dongNaiWards';
import { maskPhone, normalizePhone } from '../../../shared/geo';
import { env } from '../config/env';
import type { OtpRepository, UserRecord, UserRepository } from '../repositories/types';
import { badRequest, forbidden, tooMany, unauthorized } from '../utils/errors';
import { randomOtp, sha256, userIdFromEmail, userIdFromPhone, verifyPassword } from '../utils/crypto';
import type { AuditService } from './audit.service';
import { toProfile, type TrustService } from './trust.service';

export const OTP_TTL_MS = 5 * 60 * 1000;
export const OTP_RESEND_MS = 60 * 1000;
export const OTP_MAX_FAILS = 5;
export const OTP_LOCK_MS = 15 * 60 * 1000;

export interface JwtClaims {
  sub: string;
  role: Role;
  wardCode: string | null;
}

export const DEMO_ACCOUNTS = {
  citizen: { id: userIdFromPhone('0900000001') },
  volunteer: { id: userIdFromPhone('0900000002') },
  ward_officer: { staffCode: 'CB-TB-01' },
  city_admin: { staffCode: 'TP-01' },
} as const;

export const DemoLoginSchema = z.object({ kind: z.enum(['citizen', 'volunteer', 'ward_officer', 'city_admin']) });

export class AuthService {
  private readonly staffFails = new Map<string, { count: number; lockedUntil: number }>();

  constructor(
    private readonly users: UserRepository,
    private readonly otps: OtpRepository,
    private readonly trust: TrustService,
    private readonly audit: AuditService,
  ) {}

  private hashOtp(phone: string, code: string): string {
    return sha256(`otp:${phone}:${code}:${env.jwtSecret}`);
  }

  sign(u: UserRecord): string {
    const claims: JwtClaims = { sub: u.id, role: u.role, wardCode: u.wardCode };
    return jwt.sign(claims, env.jwtSecret, { expiresIn: '12h', issuer: 'smartcitizen-dongnai', algorithm: 'HS256' });
  }

  verifyToken(token: string): JwtClaims {
    try {
      return jwt.verify(token, env.jwtSecret, { issuer: 'smartcitizen-dongnai', algorithms: ['HS256'] }) as unknown as JwtClaims;
    } catch {
      throw unauthorized('Phiên đăng nhập không hợp lệ hoặc đã hết hạn.');
    }
  }

  private session(u: UserRecord): AuthSession {
    return { token: this.sign(u), user: toProfile(u) };
  }

  /** Lớp 1 — gửi OTP (hash SHA-256, hiệu lực 5 phút, chờ gửi lại 60 giây). */
  async requestOtp(phoneRaw: string): Promise<{ resendInSec: number; expiresInSec: number; demoOtp?: string; phoneMasked: string }> {
    const phone = normalizePhone(phoneRaw);
    if (!phone) throw badRequest('Số điện thoại không hợp lệ (10 số, bắt đầu bằng 0).', 'invalid_phone');
    const now = Date.now();
    const existing = await this.otps.get(phone);
    if (existing && existing.lockedUntil > now) {
      throw tooMany(`Số điện thoại đang bị khóa tạm thời. Thử lại sau ${Math.ceil((existing.lockedUntil - now) / 60000)} phút.`, 'otp_locked');
    }
    if (existing && existing.resendAt > now) {
      throw tooMany(`Vui lòng chờ ${Math.ceil((existing.resendAt - now) / 1000)} giây trước khi gửi lại mã.`, 'otp_cooldown');
    }
    const code = randomOtp();
    await this.otps.save({
      phone,
      codeHash: this.hashOtp(phone, code),
      expiresAt: now + OTP_TTL_MS,
      resendAt: now + OTP_RESEND_MS,
      failedAttempts: existing?.failedAttempts ?? 0,
      lockedUntil: 0,
    });
    return {
      resendInSec: OTP_RESEND_MS / 1000,
      expiresInSec: OTP_TTL_MS / 1000,
      phoneMasked: maskPhone(phone),
      ...(env.demoOtp ? { demoOtp: code } : {}),
    };
  }

  async verifyOtp(phoneRaw: string, code: string): Promise<AuthSession> {
    const phone = normalizePhone(phoneRaw);
    if (!phone) throw badRequest('Số điện thoại không hợp lệ.', 'invalid_phone');
    const rec = await this.otps.get(phone);
    const now = Date.now();
    if (!rec) throw badRequest('Chưa có mã OTP cho số này. Hãy yêu cầu gửi mã.', 'otp_missing');
    if (rec.lockedUntil > now) throw tooMany(`Đã nhập sai quá ${OTP_MAX_FAILS} lần. Thử lại sau ${Math.ceil((rec.lockedUntil - now) / 60000)} phút.`, 'otp_locked');
    if (rec.expiresAt < now) {
      await this.otps.delete(phone);
      throw badRequest('Mã OTP đã hết hạn (5 phút). Hãy yêu cầu mã mới.', 'otp_expired');
    }
    if (rec.codeHash !== this.hashOtp(phone, code)) {
      rec.failedAttempts += 1;
      if (rec.failedAttempts >= OTP_MAX_FAILS) {
        rec.lockedUntil = now + OTP_LOCK_MS;
        rec.failedAttempts = 0;
        await this.otps.save(rec);
        throw tooMany(`Nhập sai ${OTP_MAX_FAILS} lần — khóa tạm thời ${OTP_LOCK_MS / 60000} phút.`, 'otp_locked');
      }
      await this.otps.save(rec);
      throw badRequest(`Mã OTP chưa đúng. Còn ${OTP_MAX_FAILS - rec.failedAttempts} lần thử.`, 'otp_invalid');
    }
    await this.otps.delete(phone);
    const user = await this.upsertCitizenByPhone(phone, `Công dân ${maskPhone(phone)}`);
    return this.session(user);
  }

  private async upsertCitizenByPhone(phone: string, name: string): Promise<UserRecord> {
    const id = userIdFromPhone(phone);
    const found = await this.users.get(id);
    if (found) return found;
    const u: UserRecord = {
      id, role: 'citizen', name, phone, email: null, staffCode: null, passwordHash: null,
      wardCode: null, unitCode: null, createdAt: new Date().toISOString(), ...this.trust.newUserDefaults(),
    };
    await this.users.save(u);
    return u;
  }

  /** Google OAuth chế độ Mock Demo (không gọi Google). Chỉ bật khi ENABLE_DEMO_AUTH=true. */
  async googleMock(name: string, email: string): Promise<AuthSession> {
    if (!env.enableDemoAuth) throw forbidden('Đăng nhập Google Mock đang tắt.');
    const id = userIdFromEmail(email);
    let u = await this.users.get(id);
    if (!u) {
      u = {
        id, role: 'citizen', name, phone: null, email, staffCode: null, passwordHash: null,
        wardCode: null, unitCode: null, createdAt: new Date().toISOString(), ...this.trust.newUserDefaults(),
      };
      await this.users.save(u);
    }
    return this.session(u);
  }

  async staffLogin(staffCode: string, password: string, unit: string): Promise<AuthSession> {
    const key = staffCode.toLowerCase();
    const now = Date.now();
    const f = this.staffFails.get(key);
    if (f && f.lockedUntil > now) throw tooMany('Tài khoản cán bộ tạm khóa do nhập sai nhiều lần.', 'staff_locked');
    const u = await this.users.getByStaffCode(staffCode);
    const ok = !!u && !!u.passwordHash && verifyPassword(password, u.passwordHash);
    const scopeOk = !!u && (unit === 'city' ? u.role === 'city_admin' : u.role === 'ward_officer' && u.wardCode === unit);
    if (!ok || !scopeOk || !u) {
      const next = { count: (f?.count ?? 0) + 1, lockedUntil: 0 };
      if (next.count >= OTP_MAX_FAILS) next.lockedUntil = now + OTP_LOCK_MS;
      this.staffFails.set(key, next);
      throw unauthorized('Mã cán bộ, mật khẩu hoặc cấp đơn vị không đúng.');
    }
    this.staffFails.delete(key);
    await this.audit.log({ id: u.id, name: u.name, role: u.role }, 'auth.staff_login', u.id, null, { unit });
    return this.session(u);
  }

  async demoLogin(kind: keyof typeof DEMO_ACCOUNTS): Promise<AuthSession> {
    if (!env.enableDemoAuth) throw forbidden('Đăng nhập demo đang tắt (ENABLE_DEMO_AUTH=false).');
    const def = DEMO_ACCOUNTS[kind];
    const u = 'id' in def ? await this.users.get(def.id) : await this.users.getByStaffCode(def.staffCode);
    if (!u) throw badRequest('Tài khoản demo chưa được seed.', 'demo_missing');
    return this.session(u);
  }

  async me(userId: string): Promise<UserRecord> {
    const u = await this.users.get(userId);
    if (!u) throw unauthorized('Tài khoản không còn tồn tại.');
    return u;
  }

  async markNotificationsRead(userId: string): Promise<void> {
    const u = await this.me(userId);
    u.notifications = u.notifications.map((n) => ({ ...n, read: true }));
    await this.users.save(u);
  }

  async registerVolunteer(userId: string, wardCode: string, unitCode: string): Promise<AuthSession> {
    const u = await this.me(userId);
    if (u.role !== 'citizen' && u.role !== 'volunteer') throw forbidden('Chỉ công dân mới đăng ký làm Đoàn viên Tình nguyện.');
    if (!getWard(wardCode)) throw badRequest('Xã/phường công tác không hợp lệ.', 'invalid_ward');
    if (!UNIT_CODE_REGEX.test(unitCode)) throw badRequest('Mã chi đoàn không hợp lệ (ví dụ: DN-TB-01).', 'invalid_unit');
    const before = { role: u.role, wardCode: u.wardCode, unitCode: u.unitCode };
    u.role = 'volunteer';
    u.wardCode = wardCode;
    u.unitCode = unitCode;
    await this.users.save(u);
    await this.audit.log({ id: u.id, name: u.name, role: 'volunteer' }, 'volunteer.register', u.id, before, { role: u.role, wardCode, unitCode });
    return this.session(u);
  }
}
