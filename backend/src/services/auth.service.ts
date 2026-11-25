import jwt from 'jsonwebtoken';
import type { AuthSession, Role } from '../shared/types';
import { normalizeRole, UNIT_CODE_REGEX } from '../shared/constants';
import { getWard } from '../shared/dongNaiWards';
import { maskEmail, maskPhone, normalizeEmail, normalizePhone } from '../shared/geo';
import { env } from '../config/env';
import type { OtpRepository, SessionRepository, UserRecord, UserRepository } from '../repositories/types';
import { badRequest, forbidden, tooMany, unauthorized } from '../utils/errors';
import {
  hashPassword,
  hmacSha256,
  newId,
  randomOpaqueToken,
  randomOtp,
  safeEqualHex,
  sha256,
  userIdFromEmail,
  userIdFromPhone,
  verifyPassword,
} from '../utils/crypto';
import type { AuditService } from './audit.service';
import { parseVnPhone, type ParsedVnPhone, type PhoneOtpService } from './otp';
import type { OtpChannel, OtpDeliveryService } from './otpDelivery.service';
import { toProfile, type TrustService } from './trust.service';

export const OTP_TTL_MS = 5 * 60 * 1000;
export const OTP_RESEND_MS = 60 * 1000;
export const OTP_MAX_FAILS = 5;
export const OTP_LOCK_MS = 15 * 60 * 1000;
export const ACCESS_TOKEN_EXPIRES_IN = '15m';

export interface JwtClaims {
  sub: string;
  role: Role;
  wardCode: string | null;
}

export interface IssuedAuth {
  session: AuthSession;
  refreshToken: string;
  refreshMaxAgeMs: number;
}

function parseIdentifier(raw: string): { channel: OtpChannel; value: string; masked: string } | null {
  const email = normalizeEmail(raw);
  if (email) return { channel: 'email', value: email, masked: maskEmail(email) };
  const vnPhone = parseVnPhone(raw);
  if (vnPhone) return { channel: 'sms', value: vnPhone.local, masked: vnPhone.masked };
  const phone = normalizePhone(raw);
  if (phone) return { channel: 'sms', value: phone, masked: maskPhone(phone) };
  return null;
}

/**
 * Hệ thống Xác thực & Quản lý Phiên Thật (Zero Mock Auth / Zero Fake OTP):
 * - Sinh mã OTP 6 số bằng CSPRNG, lưu HMAC-SHA256 + `consumedAt` chống replay.
 * - Gửi đi thật qua OtpDeliveryService (Resend / SMTP / Twilio / eSMS) và PhoneOtpService (Multi-Provider +84).
 * - Quản lý phiên bằng Access Token ngắn hạn (15m) + Refresh Token xoay vòng (rotation) lưu HTTP-only Cookie.
 */
export class AuthService {
  private readonly staffFails = new Map<string, { count: number; lockedUntil: number }>();

  constructor(
    private readonly users: UserRepository,
    private readonly otps: OtpRepository,
    private readonly sessions: SessionRepository,
    private readonly delivery: OtpDeliveryService,
    private readonly trust: TrustService,
    private readonly audit: AuditService,
    private readonly phoneOtp?: PhoneOtpService,
  ) {}

  private hashOtp(identifier: string, code: string): string {
    return hmacSha256(env.otpPepper, `otp:${identifier}:${code}`);
  }

  signAccessToken(u: UserRecord): string {
    const claims: JwtClaims = { sub: u.id, role: normalizeRole(u.role), wardCode: u.wardCode };
    return jwt.sign(claims, env.jwtSecret, {
      expiresIn: ACCESS_TOKEN_EXPIRES_IN,
      issuer: 'smartcitizen-dongnai',
      algorithm: 'HS256',
    });
  }

  verifyToken(token: string): JwtClaims {
    try {
      const raw = jwt.verify(token, env.jwtSecret, {
        issuer: 'smartcitizen-dongnai',
        algorithms: ['HS256'],
      }) as unknown as JwtClaims;
      return { ...raw, role: normalizeRole(raw.role) };
    } catch {
      throw unauthorized('Phiên đăng nhập không hợp lệ hoặc đã hết hạn.');
    }
  }

  private async issueSession(u: UserRecord, userAgent = ''): Promise<IssuedAuth> {
    if (u.revoked) {
      throw forbidden('Tài khoản đã bị thu hồi quyền truy cập.');
    }
    const refreshToken = randomOpaqueToken();
    const refreshMaxAgeMs = env.refreshTokenDays * 24 * 3600 * 1000;
    const now = Date.now();
    await this.sessions.save({
      id: newId('ses'),
      userId: u.id,
      refreshHash: sha256(refreshToken),
      userAgent: userAgent.slice(0, 160),
      createdAt: now,
      expiresAt: now + refreshMaxAgeMs,
      revokedAt: null,
      replacedBySessionId: null,
    });
    return {
      session: { token: this.signAccessToken(u), user: toProfile(u) },
      refreshToken,
      refreshMaxAgeMs,
    };
  }

  /** Gửi mã OTP 6 chữ số thật qua Email (Resend/SMTP) hoặc SMS (Twilio/eSMS). KHÔNG trả mã OTP ra response. */
  async requestOtp(
    identifierRaw: string,
    purpose: 'login' | 'reset_password' = 'login',
  ): Promise<{ channel: OtpChannel; targetMasked: string; resendInSec: number; expiresInSec: number; provider: string }> {
    const parsed = parseIdentifier(identifierRaw);
    if (!parsed) {
      throw badRequest('Nhập địa chỉ Email hợp lệ hoặc số điện thoại Việt Nam (10 chữ số, bắt đầu bằng 0).', 'invalid_identifier');
    }

    const now = Date.now();
    const existing = await this.otps.get(parsed.value);
    if (existing && existing.lockedUntil > now) {
      throw tooMany(
        `Tài khoản đang bị tạm khóa do nhập sai nhiều lần. Thử lại sau ${Math.ceil((existing.lockedUntil - now) / 60000)} phút.`,
        'otp_locked',
      );
    }
    if (existing && existing.resendAt > now) {
      throw tooMany(
        `Vui lòng chờ ${Math.ceil((existing.resendAt - now) / 1000)} giây trước khi yêu cầu gửi lại mã.`,
        'otp_cooldown',
      );
    }

    const code = randomOtp();
    // Gửi thật qua nhà cung cấp trước — nếu thiếu cấu hình/gửi thất bại thì báo lỗi tường minh, không lưu challenge ảo
    const { provider } = await this.delivery.sendOtp({
      to: parsed.value,
      code,
      channel: parsed.channel,
      ttlMinutes: OTP_TTL_MS / 60000,
      purpose,
    });

    await this.otps.save({
      identifier: parsed.value,
      channel: parsed.channel,
      purpose,
      codeHash: this.hashOtp(parsed.value, code),
      expiresAt: now + OTP_TTL_MS,
      resendAt: now + OTP_RESEND_MS,
      failedAttempts: 0,
      lockedUntil: 0,
      consumedAt: null,
    });

    return {
      channel: parsed.channel,
      targetMasked: parsed.masked,
      resendInSec: OTP_RESEND_MS / 1000,
      expiresInSec: OTP_TTL_MS / 1000,
      provider,
    };
  }

  private async consumeOtpChallenge(identifierRaw: string, code: string): Promise<{ channel: OtpChannel; value: string; masked: string }> {
    const parsed = parseIdentifier(identifierRaw);
    if (!parsed) throw badRequest('Email hoặc số điện thoại không hợp lệ.', 'invalid_identifier');

    const rec = await this.otps.get(parsed.value);
    const now = Date.now();
    if (!rec) throw badRequest('Chưa có mã OTP cho tài khoản này. Hãy yêu cầu gửi mã.', 'otp_missing');
    if (rec.consumedAt !== null) {
      throw badRequest('Mã OTP này đã được sử dụng. Hãy yêu cầu gửi mã mới.', 'otp_consumed');
    }
    if (rec.lockedUntil > now) {
      throw tooMany(`Đã nhập sai quá ${OTP_MAX_FAILS} lần. Thử lại sau ${Math.ceil((rec.lockedUntil - now) / 60000)} phút.`, 'otp_locked');
    }
    if (rec.expiresAt < now) {
      await this.otps.delete(parsed.value);
      throw badRequest('Mã OTP đã hết hạn (5 phút). Hãy yêu cầu mã mới.', 'otp_expired');
    }

    const expectedHash = this.hashOtp(parsed.value, code);
    if (!safeEqualHex(rec.codeHash, expectedHash)) {
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

    // Đánh dấu đã tiêu thụ ngay lập tức (chống replay attack)
    rec.consumedAt = now;
    await this.otps.save(rec);
    return parsed;
  }

  async verifyOtp(
    identifierRaw: string,
    code: string,
    opts: { name?: string; password?: string; defaultWardCode?: string; userAgent?: string } = {},
  ): Promise<IssuedAuth> {
    const parsed = await this.consumeOtpChallenge(identifierRaw, code);
    const user =
      parsed.channel === 'email'
        ? await this.upsertCitizenByEmail(parsed.value, opts.name)
        : await this.upsertCitizenByPhone(parsed.value, opts.name);

    let changed = false;
    if (opts.name && opts.name.trim().length >= 2) {
      user.name = opts.name.trim().slice(0, 80);
      changed = true;
    }
    if (opts.password && opts.password.length >= 8) {
      user.passwordHash = hashPassword(opts.password);
      changed = true;
    }
    if (opts.defaultWardCode && getWard(opts.defaultWardCode)) {
      user.defaultWardCode = opts.defaultWardCode;
      changed = true;
    }
    if (changed) await this.users.save(user);

    return this.issueSession(user, opts.userAgent);
  }

  /**
   * Cấp phiên JWT + Refresh Cookie cho công dân sau khi xác thực SĐT Việt Nam (+84) thành công
   * qua PhoneOtpService hoặc Firebase Phone Auth (`verify-firebase`).
   */
  async issueCitizenSessionByPhone(
    phone: ParsedVnPhone,
    opts: {
      name?: string;
      password?: string;
      defaultWardCode?: string;
      userAgent?: string;
      firebaseUid?: string;
    } = {},
  ): Promise<IssuedAuth> {
    const user = await this.upsertCitizenByPhone(phone.local, opts.name, phone.e164);

    let changed = false;
    if (opts.name && opts.name.trim().length >= 2) {
      user.name = opts.name.trim().slice(0, 80);
      changed = true;
    }
    if (opts.password && opts.password.length >= 8) {
      user.passwordHash = hashPassword(opts.password);
      changed = true;
    }
    if (opts.defaultWardCode && getWard(opts.defaultWardCode)) {
      user.defaultWardCode = opts.defaultWardCode;
      changed = true;
    }
    if (changed) await this.users.save(user);

    if (opts.firebaseUid) {
      await this.audit.log(
        { id: user.id, name: user.name, role: user.role },
        'auth.firebase_phone_login',
        user.id,
        null,
        { phoneE164: phone.e164, firebaseUid: opts.firebaseUid },
      );
    }

    return this.issueSession(user, opts.userAgent);
  }

  /** Đặt lại mật khẩu cho công dân sau khi xác thực OTP thật (hỗ trợ cả Email OTP & Phone SMS OTP). */
  async resetPassword(identifierRaw: string, code: string, newPassword: string, userAgent?: string): Promise<IssuedAuth> {
    const parsedPhone = parseVnPhone(identifierRaw);
    if (parsedPhone && this.phoneOtp) {
      const challenge = await this.phoneOtp.peekChallenge(parsedPhone.e164);
      if (challenge) {
        await this.phoneOtp.verifyPhoneOtp(parsedPhone.e164, code);
        const user =
          (await this.users.getByPhone(parsedPhone.local)) ??
          (await this.users.getByPhone(parsedPhone.e164));
        if (!user) throw badRequest('Tài khoản chưa được đăng ký trên hệ thống.', 'account_not_found');
        user.passwordHash = hashPassword(newPassword);
        await this.users.save(user);
        await this.sessions.revokeAllForUser(user.id);
        await this.audit.log({ id: user.id, name: user.name, role: user.role }, 'auth.password_reset', user.id, null, { channel: 'sms' });
        return this.issueSession(user, userAgent);
      }
    }

    const parsed = await this.consumeOtpChallenge(identifierRaw, code);
    const user =
      parsed.channel === 'email'
        ? await this.users.getByEmail(parsed.value)
        : (await this.users.getByPhone(parsed.value)) ??
          (parsedPhone ? await this.users.getByPhone(parsedPhone.e164) : null);
    if (!user) throw badRequest('Tài khoản chưa được đăng ký trên hệ thống.', 'account_not_found');
    user.passwordHash = hashPassword(newPassword);
    await this.users.save(user);
    // Thu hồi toàn bộ phiên cũ khi đổi mật khẩu
    await this.sessions.revokeAllForUser(user.id);
    await this.audit.log({ id: user.id, name: user.name, role: user.role }, 'auth.password_reset', user.id, null, { channel: parsed.channel });
    return this.issueSession(user, userAgent);
  }

  /** Đăng nhập công dân bằng Email/SĐT + mật khẩu đã thiết lập. */
  async passwordLogin(identifierRaw: string, password: string, userAgent?: string): Promise<IssuedAuth> {
    const parsed = parseIdentifier(identifierRaw);
    if (!parsed) throw badRequest('Email hoặc số điện thoại không hợp lệ.', 'invalid_identifier');

    const failKey = `pw:${parsed.value}`;
    const now = Date.now();
    const fail = this.staffFails.get(failKey);
    if (fail && fail.lockedUntil > now) {
      throw tooMany('Đăng nhập sai nhiều lần — tạm khóa 15 phút.', 'login_locked');
    }

    const parsedPhone = parseVnPhone(identifierRaw);
    const user =
      parsed.channel === 'email'
        ? await this.users.getByEmail(parsed.value)
        : (await this.users.getByPhone(parsed.value)) ??
          (parsedPhone ? await this.users.getByPhone(parsedPhone.e164) : null);
    if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
      const next = { count: (fail?.count ?? 0) + 1, lockedUntil: 0 };
      if (next.count >= OTP_MAX_FAILS) next.lockedUntil = now + OTP_LOCK_MS;
      this.staffFails.set(failKey, next);
      throw unauthorized('Email/SĐT hoặc mật khẩu không đúng (hoặc tài khoản chưa đặt mật khẩu — hãy đăng nhập bằng OTP).');
    }
    this.staffFails.delete(failKey);
    return this.issueSession(user, userAgent);
  }

  private async upsertCitizenByPhone(phone: string, customName?: string, phoneE164?: string): Promise<UserRecord> {
    const found =
      (await this.users.getByPhone(phone)) ??
      (phoneE164 ? await this.users.getByPhone(phoneE164) : null);
    if (found) return found;
    const id = userIdFromPhone(phone);
    const u: UserRecord = {
      id,
      role: 'citizen',
      name: customName?.trim() || `Công dân ${maskPhone(phone)}`,
      phone,
      email: null,
      staffCode: null,
      passwordHash: null,
      wardCode: null,
      unitCode: null,
      createdAt: new Date().toISOString(),
      ...this.trust.newUserDefaults(),
    };
    await this.users.save(u);
    return u;
  }

  private async upsertCitizenByEmail(email: string, customName?: string): Promise<UserRecord> {
    const found = await this.users.getByEmail(email);
    if (found) return found;
    const id = userIdFromEmail(email);
    const localName = email.split('@')[0];
    const u: UserRecord = {
      id,
      role: 'citizen',
      name: customName?.trim() || localName,
      phone: null,
      email,
      staffCode: null,
      passwordHash: null,
      wardCode: null,
      unitCode: null,
      createdAt: new Date().toISOString(),
      ...this.trust.newUserDefaults(),
    };
    await this.users.save(u);
    return u;
  }

  /**
   * Đăng nhập Cổng Nội bộ Thống nhất (`/auth`):
   * Dành chung cho cả Quản trị viên (`ADMIN`), Cán bộ xử lý (`OFFICER`), và Đội cứu hộ (`RESCUE`)
   * bằng Mã tài khoản / Email / Số điện thoại + Mật khẩu.
   */
  async staffLogin(staffIdentifier: string, password: string, unit?: string, userAgent?: string): Promise<IssuedAuth> {
    const trimmed = staffIdentifier.trim();
    const key = `staff:${trimmed.toLowerCase()}`;
    const now = Date.now();
    const f = this.staffFails.get(key);
    if (f && f.lockedUntil > now) throw tooMany('Tài khoản tạm khóa do nhập sai nhiều lần.', 'staff_locked');

    const normalizedPhone = normalizePhone(trimmed);
    const u = trimmed.includes('@')
      ? await this.users.getByEmail(trimmed.toLowerCase())
      : normalizedPhone
        ? (await this.users.getByPhone(normalizedPhone)) ?? (await this.users.getByStaffCode(trimmed))
        : await this.users.getByStaffCode(trimmed);

    if (u?.revoked) {
      throw forbidden('Tài khoản đã bị khóa hoặc thu hồi quyền truy cập.');
    }

    const role = u ? normalizeRole(u.role) : null;
    const isInternalRole = role === 'admin' || role === 'officer' || role === 'rescue';
    const pwOk = !!u && !!u.passwordHash && verifyPassword(password, u.passwordHash);

    const explicitWardUnit = unit && unit !== 'city' && unit !== 'auto' ? unit : null;
    const scopeOk =
      isInternalRole &&
      (!explicitWardUnit ||
        role === 'admin' ||
        !u?.wardCode ||
        u.wardCode === explicitWardUnit);

    if (!pwOk || !scopeOk || !u || !role) {
      const next = { count: (f?.count ?? 0) + 1, lockedUntil: 0 };
      if (next.count >= OTP_MAX_FAILS) next.lockedUntil = now + OTP_LOCK_MS;
      this.staffFails.set(key, next);
      throw unauthorized('Mã tài khoản, Email/SĐT hoặc mật khẩu không đúng.');
    }

    u.role = role;
    this.staffFails.delete(key);
    await this.audit.log({ id: u.id, name: u.name, role: u.role }, 'auth.staff_login', u.id, null, {
      unit: unit ?? u.wardCode ?? 'city',
    });
    return this.issueSession(u, userAgent);
  }

  /** Tương thích ngược API cho Đội Cứu Hộ (`RESCUE` / `ADMIN`), ủy quyền về luồng đăng nhập nội bộ chuẩn. */
  async rescueLogin(identifierRaw: string, password: string, userAgent?: string): Promise<IssuedAuth> {
    const trimmed = identifierRaw.trim();
    const key = `rescue:${trimmed.toLowerCase()}`;
    const now = Date.now();
    const f = this.staffFails.get(key);
    if (f && f.lockedUntil > now) {
      throw tooMany('Tài khoản Đội Cứu Hộ tạm khóa 15 phút do nhập sai nhiều lần.', 'rescue_locked');
    }
    const normalizedPhone = normalizePhone(trimmed);
    const u = trimmed.includes('@')
      ? await this.users.getByEmail(trimmed.toLowerCase())
      : normalizedPhone
        ? (await this.users.getByPhone(normalizedPhone)) ?? (await this.users.getByStaffCode(trimmed))
        : await this.users.getByStaffCode(trimmed);
    if (u?.revoked) {
      throw forbidden('Tài khoản Đội Cứu Hộ đã bị khóa hoặc thu hồi quyền truy cập.');
    }
    const role = u ? normalizeRole(u.role) : null;
    const roleOk = role === 'rescue' || role === 'admin';
    const pwOk = !!u && !!u.passwordHash && verifyPassword(password, u.passwordHash);
    if (!roleOk || !pwOk || !u || !role) {
      const next = { count: (f?.count ?? 0) + 1, lockedUntil: 0 };
      if (next.count >= OTP_MAX_FAILS) next.lockedUntil = now + OTP_LOCK_MS;
      this.staffFails.set(key, next);
      throw unauthorized('Mã tài khoản / Email hoặc mật khẩu không đúng (yêu cầu quyền RESCUE).');
    }
    u.role = role;
    this.staffFails.delete(key);
    await this.audit.log(
      { id: u.id, name: u.name, role: u.role },
      'auth.rescue_login',
      u.id,
      null,
      { staffCode: u.staffCode, wardCode: u.wardCode },
    );
    return this.issueSession(u, userAgent);
  }

  /** Xoay vòng Refresh Token (rotation) + phát hiện tái sử dụng token cũ (reuse detection). */
  async refreshSession(refreshTokenRaw: string | null, userAgent?: string): Promise<IssuedAuth> {
    if (!refreshTokenRaw) throw unauthorized('Không tìm thấy phiên làm việc.');
    const rec = await this.sessions.getByRefreshHash(sha256(refreshTokenRaw));
    if (!rec) throw unauthorized('Refresh token không hợp lệ.');

    if (rec.revokedAt !== null) {
      // Phát hiện tái sử dụng refresh token đã xoay vòng/thu hồi -> thu hồi toàn bộ phiên người dùng
      await this.sessions.revokeAllForUser(rec.userId);
      throw unauthorized('Phát hiện tái sử dụng phiên cũ — đã đăng xuất toàn bộ thiết bị để bảo vệ tài khoản.');
    }
    if (rec.expiresAt < Date.now()) {
      await this.sessions.revoke(rec.id);
      throw unauthorized('Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.');
    }

    const user = await this.me(rec.userId);
    const next = await this.issueSession(user, userAgent);
    const nextRec = await this.sessions.getByRefreshHash(sha256(next.refreshToken));
    await this.sessions.revoke(rec.id, nextRec?.id ?? null);
    return next;
  }

  async logout(refreshTokenRaw: string | null): Promise<void> {
    if (!refreshTokenRaw) return;
    const rec = await this.sessions.getByRefreshHash(sha256(refreshTokenRaw));
    if (rec && !rec.revokedAt) await this.sessions.revoke(rec.id);
  }

  async logoutAll(userId: string): Promise<void> {
    await this.sessions.revokeAllForUser(userId);
  }

  async me(userId: string): Promise<UserRecord> {
    const u = await this.users.get(userId);
    if (!u) throw unauthorized('Tài khoản không còn tồn tại.');
    if (u.revoked) throw forbidden('Tài khoản đã bị thu hồi quyền truy cập.');
    u.role = normalizeRole(u.role);
    return u;
  }

  async updateProfile(
    userId: string,
    patch: { name?: string; defaultWardCode?: string | null; notificationsEnabled?: boolean; newPassword?: string },
  ): Promise<UserRecord> {
    const u = await this.me(userId);
    if (patch.name !== undefined) {
      const trimmed = patch.name.trim();
      if (trimmed.length < 2 || trimmed.length > 80) throw badRequest('Họ tên phải từ 2 đến 80 ký tự.');
      u.name = trimmed;
    }
    if (patch.defaultWardCode !== undefined) {
      if (patch.defaultWardCode !== null && !getWard(patch.defaultWardCode)) {
        throw badRequest('Phường/Xã cư trú không nằm trong 95 ĐVHC Thành phố Đồng Nai.', 'invalid_ward');
      }
      u.defaultWardCode = patch.defaultWardCode;
    }
    if (patch.notificationsEnabled !== undefined) {
      u.notificationsEnabled = patch.notificationsEnabled;
    }
    if (patch.newPassword !== undefined) {
      if (patch.newPassword.length < 8) throw badRequest('Mật khẩu mới tối thiểu 8 ký tự.');
      u.passwordHash = hashPassword(patch.newPassword);
    }
    await this.users.save(u);
    return u;
  }

  async markNotificationsRead(userId: string): Promise<void> {
    const u = await this.me(userId);
    u.notifications = u.notifications.map((n) => ({ ...n, read: true }));
    await this.users.save(u);
  }

  async registerVolunteer(userId: string, wardCode: string, unitCode: string): Promise<IssuedAuth> {
    const u = await this.me(userId);
    if (!getWard(wardCode)) throw badRequest('Phường/Xã công tác không hợp lệ.', 'invalid_ward');
    if (!UNIT_CODE_REGEX.test(unitCode)) throw badRequest('Mã đơn vị không hợp lệ (ví dụ: DN-TB-01).', 'invalid_unit');
    const before = { role: u.role, wardCode: u.wardCode, unitCode: u.unitCode };
    u.defaultWardCode = wardCode;
    u.unitCode = unitCode;
    await this.users.save(u);
    await this.audit.log({ id: u.id, name: u.name, role: u.role }, 'citizen.unit_register', u.id, before, {
      role: u.role,
      wardCode,
      unitCode,
    });
    return this.issueSession(u);
  }
}
