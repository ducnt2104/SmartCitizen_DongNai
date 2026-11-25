import jwt from 'jsonwebtoken';
import { LRUCache } from 'lru-cache';
import type { AuthSession, Role, SessionInfo } from '../shared/types';
import { normalizeRole, UNIT_CODE_REGEX } from '../shared/constants';
import { getWard } from '../shared/dongNaiWards';
import { maskEmail, maskPhone, normalizeEmail, normalizePhone } from '../shared/geo';
import { env } from '../config/env';
import type { OtpRepository, SessionRecord, SessionRepository, UserRecord, UserRepository } from '../repositories/types';
import { badRequest, forbidden, HttpError, tooMany, unauthorized } from '../utils/errors';
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
  validatePasswordStrength,
  verifyPassword,
} from '../utils/crypto';
import type { AuditService } from './audit.service';
import { parseVnPhone, type ParsedVnPhone, type PhoneOtpService } from './otp';
import type { OtpChannel, OtpDeliveryService, OtpPurpose } from './otpDelivery.service';
import { notifySessionTerminated } from './sessionEvents';
import { toProfile, type TrustService } from './trust.service';

export const OTP_TTL_MS = 5 * 60 * 1000;
export const OTP_RESEND_MS = 60 * 1000;
export const OTP_MAX_FAILS = 5;
export const OTP_LOCK_MS = 15 * 60 * 1000;
export const ACCESS_TOKEN_EXPIRES_IN = '15m';
export const REAUTH_TOKEN_EXPIRES_IN = '5m';

export interface JwtClaims {
  sub: string;
  role: Role;
  wardCode: string | null;
  sid: string;
  tv: number;
  jti?: string;
}

export interface ReauthClaims {
  sub: string;
  sid: string;
  tv: number;
  scope: 'reauth';
}

export interface RequestMeta {
  userAgent?: string;
  ip?: string;
  deviceFingerprint?: string;
}

export interface IssuedAuth {
  session: AuthSession;
  refreshToken: string;
  refreshMaxAgeMs: number;
}

interface BruteForceBucket {
  count: number;
  lockedUntil: number;
}

function normalizeMeta(input?: RequestMeta | string): Required<RequestMeta> {
  if (typeof input === 'string') {
    return { userAgent: input.slice(0, 180), ip: '', deviceFingerprint: 'web-browser' };
  }
  return {
    userAgent: (input?.userAgent ?? '').slice(0, 180),
    ip: (input?.ip ?? '').slice(0, 64),
    deviceFingerprint: (input?.deviceFingerprint ?? 'web-browser').slice(0, 64),
  };
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
 * Hệ thống Xác thực & Quản lý Phiên Bảo mật Cao (Strict Single-Session + Rotation + Reuse Detection):
 * - Mỗi tài khoản chỉ duy nhất 1 phiên hoạt động tại 1 thời điểm (`activeSessionId` + `tokenVersion`).
 * - Xác thực phiên ở tốc độ RAM bằng `LRUCache` đồng bộ tức thời với MongoDB Atlas & SQLite WAL.
 * - Đổi mật khẩu / email / SĐT yêu cầu xác thực lại, tăng `tokenVersion` và thu hồi toàn bộ thiết bị khác.
 * - Phát hiện tái sử dụng Refresh Token (Reuse Detection) khóa tức thì mọi phiên của tài khoản.
 */
export class AuthService {
  private readonly bruteForceCache = new LRUCache<string, BruteForceBucket>({
    max: 10_000,
    ttl: 30 * 60 * 1000,
  });

  private readonly sessionCache = new LRUCache<string, SessionRecord>({
    max: 5_000,
    ttl: 60 * 1000,
  });

  private readonly userVersionCache = new LRUCache<
    string,
    { tokenVersion: number; activeSessionId: string | null; revoked: boolean }
  >({
    max: 5_000,
    ttl: 60 * 1000,
  });

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

  /** Xóa cache phiên/tokenVersion trong RAM khi quyền/phiên bị thay đổi từ Auth hoặc Admin. */
  invalidateSessionCache(userId: string, sessionId?: string | null): void {
    this.userVersionCache.delete(userId);
    if (sessionId) this.sessionCache.delete(sessionId);
    for (const [sid, cached] of this.sessionCache.entries()) {
      if (cached.userId === userId && (!sessionId || sid !== sessionId)) {
        this.sessionCache.delete(sid);
      }
    }
  }

  private assertNotRateLocked(keys: string[], label: string): void {
    const now = Date.now();
    for (const k of keys) {
      if (!k) continue;
      const b = this.bruteForceCache.get(k);
      if (b && b.lockedUntil > now) {
        const waitSec = Math.max(1, Math.ceil((b.lockedUntil - now) / 1000));
        throw tooMany(
          `${label} tạm khóa do nhập sai nhiều lần (exponential backoff). Thử lại sau ${waitSec} giây.`,
          'login_locked',
        );
      }
    }
  }

  private recordAuthFailure(keys: string[]): void {
    const now = Date.now();
    for (const k of keys) {
      if (!k) continue;
      const cur = this.bruteForceCache.get(k);
      const count = (cur?.count ?? 0) + 1;
      let lockedUntil = 0;
      if (count >= OTP_MAX_FAILS) {
        // Exponential backoff: 30s -> 60s -> 120s -> 240s -> tối đa 15 phút
        const backoffMs = Math.min(OTP_LOCK_MS, 30_000 * 2 ** (count - OTP_MAX_FAILS));
        lockedUntil = now + backoffMs;
      }
      this.bruteForceCache.set(k, { count, lockedUntil });
    }
  }

  private clearAuthFailures(keys: string[]): void {
    for (const k of keys) {
      if (k) this.bruteForceCache.delete(k);
    }
  }

  private assertPasswordIfProvided(password?: string): void {
    if (password === undefined) return;
    const check = validatePasswordStrength(password);
    if (!check.valid) {
      throw badRequest(check.reason ?? 'Mật khẩu chưa đạt chuẩn an toàn.', 'weak_password');
    }
  }

  signAccessToken(u: UserRecord, sessionId: string, tokenVersion: number): string {
    const claims: JwtClaims = {
      sub: u.id,
      role: normalizeRole(u.role),
      wardCode: u.wardCode,
      sid: sessionId,
      tv: tokenVersion,
      jti: newId('jti'),
    };
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
      if (!raw || typeof raw.sub !== 'string' || typeof raw.sid !== 'string' || typeof raw.tv !== 'number') {
        throw unauthorized('Token thiếu thông tin phiên hợp lệ.', 'SESSION_REVOKED');
      }
      return { ...raw, role: normalizeRole(raw.role) };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw unauthorized('Phiên đăng nhập không hợp lệ hoặc đã hết hạn.');
    }
  }

  /** Xác thực JWT kết hợp kiểm tra Single-Session (`sid` + `tv`) qua LRU RAM + DB. */
  async authenticateToken(
    token: string,
    opts?: { ip?: string },
  ): Promise<{ user: UserRecord; sessionId: string; tokenVersion: number }> {
    const claims = this.verifyToken(token);
    const u = await this.me(claims.sub);

    let sess: SessionRecord | undefined | null = this.sessionCache.get(claims.sid);
    if (!sess) {
      sess = await this.sessions.get(claims.sid);
      if (sess) this.sessionCache.set(claims.sid, sess);
    }

    const expectedTv = u.tokenVersion ?? 0;

    if (!sess) {
      if (u.activeSessionId && u.activeSessionId !== claims.sid) {
        throw new HttpError(401, 'Tài khoản đã được đăng nhập trên thiết bị khác.', 'SESSION_REPLACED');
      }
      throw new HttpError(401, 'Phiên đăng nhập không tồn tại hoặc đã hết hạn.', 'SESSION_REVOKED');
    }

    if (sess.isRevoked || sess.revokedAt !== null) {
      if (sess.revokedReason === 'SESSION_REPLACED') {
        throw new HttpError(401, 'Tài khoản đã được đăng nhập trên thiết bị khác.', 'SESSION_REPLACED');
      }
      if (sess.revokedReason === 'REUSE_DETECTED') {
        throw new HttpError(
          401,
          'Phát hiện tái sử dụng refresh token — toàn bộ phiên đã bị khóa để bảo vệ tài khoản.',
          'SESSION_COMPROMISED',
        );
      }
      throw new HttpError(401, 'Phiên đăng nhập đã bị thu hồi. Vui lòng đăng nhập lại.', 'SESSION_REVOKED');
    }

    if (sess.expiresAt <= Date.now()) {
      throw new HttpError(401, 'Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.', 'SESSION_REVOKED');
    }

    if (u.activeSessionId && u.activeSessionId !== claims.sid) {
      throw new HttpError(401, 'Tài khoản đã được đăng nhập trên thiết bị khác.', 'SESSION_REPLACED');
    }

    if (expectedTv !== claims.tv) {
      throw new HttpError(401, 'Phiên đăng nhập đã bị vô hiệu hóa do thay đổi bảo mật.', 'SESSION_REVOKED');
    }

    const now = Date.now();
    if (now - (sess.lastActiveAt ?? sess.createdAt) > 30_000) {
      sess.lastActiveAt = now;
      if (opts?.ip) sess.ip = opts.ip;
      this.sessionCache.set(sess.id, sess);
      void this.sessions.touch(sess.id, now, opts?.ip).catch(() => undefined);
    }

    return { user: u, sessionId: claims.sid, tokenVersion: claims.tv };
  }

  private async issueSession(
    u: UserRecord,
    metaInput?: RequestMeta | string,
    opts?: { rotationOfSessionId?: string; reasonForPrior?: string; skipBumpVersion?: boolean },
  ): Promise<IssuedAuth> {
    if (u.revoked) {
      throw forbidden('Tài khoản đã bị thu hồi quyền truy cập.');
    }
    const meta = normalizeMeta(metaInput);
    const now = Date.now();
    const sessionId = newId('ses');
    const refreshToken = randomOpaqueToken();
    const refreshHash = sha256(refreshToken);
    const refreshMaxAgeMs = env.refreshTokenDays * 24 * 3600 * 1000;
    const nextTv = opts?.skipBumpVersion ? (u.tokenVersion ?? 0) : (u.tokenVersion ?? 0) + 1;

    // Thu hồi tức thời toàn bộ phiên cũ (Strict Single-Session Enforcement)
    if (opts?.rotationOfSessionId) {
      await this.sessions.revoke(opts.rotationOfSessionId, sessionId, 'ROTATED');
      await this.sessions.revokeAllExcept(u.id, sessionId, 'SESSION_REPLACED');
    } else {
      await this.sessions.revokeAllForUser(u.id, opts?.reasonForPrior ?? 'SESSION_REPLACED');
    }

    u.tokenVersion = nextTv;
    u.activeSessionId = sessionId;
    if (meta.ip) u.lastLoginIp = meta.ip;
    u.lastLoginAt = now;
    await this.users.save(u);

    const record: SessionRecord = {
      id: sessionId,
      userId: u.id,
      refreshHash,
      tokenHash: refreshHash,
      deviceFingerprint: meta.deviceFingerprint,
      ip: meta.ip,
      userAgent: meta.userAgent,
      tokenVersion: nextTv,
      createdAt: now,
      lastActiveAt: now,
      expiresAt: now + refreshMaxAgeMs,
      isRevoked: false,
      revokedAt: null,
      revokedReason: null,
      replacedBySessionId: null,
    };
    await this.sessions.save(record);

    // Cập nhật cache phiên + bắn sự kiện SSE đá mọi thiết bị cũ ngay lập tức
    this.invalidateSessionCache(u.id, sessionId);
    this.sessionCache.set(sessionId, record);
    this.userVersionCache.set(u.id, {
      tokenVersion: nextTv,
      activeSessionId: sessionId,
      revoked: false,
    });

    if (!opts?.rotationOfSessionId) {
      notifySessionTerminated(u.id, {
        excludeSessionId: sessionId,
        code: 'SESSION_REPLACED',
        message: 'Tài khoản đã được đăng nhập trên thiết bị khác.',
      });
    }

    return {
      session: { token: this.signAccessToken(u, sessionId, nextTv), user: toProfile(u) },
      refreshToken,
      refreshMaxAgeMs,
    };
  }

  /** Gửi mã OTP 6 chữ số thật qua Email (Resend/SMTP) hoặc SMS (Twilio/eSMS). KHÔNG trả mã OTP ra response. */
  async requestOtp(
    identifierRaw: string,
    purpose: OtpPurpose = 'login',
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
    opts: { name?: string; password?: string; defaultWardCode?: string; userAgent?: string; meta?: RequestMeta } = {},
  ): Promise<IssuedAuth> {
    this.assertPasswordIfProvided(opts.password);
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
    if (opts.password) {
      user.passwordHash = hashPassword(opts.password);
      changed = true;
    }
    if (opts.defaultWardCode && getWard(opts.defaultWardCode)) {
      user.defaultWardCode = opts.defaultWardCode;
      changed = true;
    }
    if (changed) await this.users.save(user);

    const meta = opts.meta ?? { userAgent: opts.userAgent };
    await this.audit.log({ id: user.id, name: user.name, role: user.role, ip: meta.ip }, 'auth.otp_login', user.id, null, {
      channel: parsed.channel,
      deviceFingerprint: meta.deviceFingerprint ?? 'web-browser',
    }, meta.ip);
    return this.issueSession(user, meta);
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
      meta?: RequestMeta;
    } = {},
  ): Promise<IssuedAuth> {
    this.assertPasswordIfProvided(opts.password);
    const user = await this.upsertCitizenByPhone(phone.local, opts.name, phone.e164);

    let changed = false;
    if (opts.name && opts.name.trim().length >= 2) {
      user.name = opts.name.trim().slice(0, 80);
      changed = true;
    }
    if (opts.password) {
      user.passwordHash = hashPassword(opts.password);
      changed = true;
    }
    if (opts.defaultWardCode && getWard(opts.defaultWardCode)) {
      user.defaultWardCode = opts.defaultWardCode;
      changed = true;
    }
    if (changed) await this.users.save(user);

    const meta = opts.meta ?? { userAgent: opts.userAgent };
    if (opts.firebaseUid) {
      await this.audit.log(
        { id: user.id, name: user.name, role: user.role, ip: meta.ip },
        'auth.firebase_phone_login',
        user.id,
        null,
        { phoneE164: phone.e164, firebaseUid: opts.firebaseUid },
        meta.ip,
      );
    }

    return this.issueSession(user, meta);
  }

  /** Đặt lại mật khẩu cho công dân sau khi xác thực OTP thật (hỗ trợ cả Email OTP & Phone SMS OTP). */
  async resetPassword(
    identifierRaw: string,
    code: string,
    newPassword: string,
    metaInput?: RequestMeta | string,
  ): Promise<IssuedAuth> {
    this.assertPasswordIfProvided(newPassword);
    const meta = normalizeMeta(metaInput);
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
        await this.audit.log(
          { id: user.id, name: user.name, role: user.role, ip: meta.ip },
          'auth.password_reset',
          user.id,
          null,
          { channel: 'sms' },
          meta.ip,
        );
        return this.issueSession(user, meta, { reasonForPrior: 'PASSWORD_CHANGED' });
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
    await this.audit.log(
      { id: user.id, name: user.name, role: user.role, ip: meta.ip },
      'auth.password_reset',
      user.id,
      null,
      { channel: parsed.channel },
      meta.ip,
    );
    return this.issueSession(user, meta, { reasonForPrior: 'PASSWORD_CHANGED' });
  }

  /** Đăng nhập công dân bằng Email/SĐT + mật khẩu đã thiết lập (Exponential Backoff IP+Account). */
  async passwordLogin(identifierRaw: string, password: string, metaInput?: RequestMeta | string): Promise<IssuedAuth> {
    const meta = normalizeMeta(metaInput);
    const parsed = parseIdentifier(identifierRaw);
    if (!parsed) throw badRequest('Email hoặc số điện thoại không hợp lệ.', 'invalid_identifier');

    const failKeys = [`pw:${parsed.value}`, meta.ip ? `ip_pw:${meta.ip}` : ''];
    this.assertNotRateLocked(failKeys, 'Đăng nhập');

    const parsedPhone = parseVnPhone(identifierRaw);
    const user =
      parsed.channel === 'email'
        ? await this.users.getByEmail(parsed.value)
        : (await this.users.getByPhone(parsed.value)) ??
          (parsedPhone ? await this.users.getByPhone(parsedPhone.e164) : null);
    if (!user || !user.passwordHash || !verifyPassword(password, user.passwordHash)) {
      this.recordAuthFailure(failKeys);
      throw unauthorized('Email/SĐT hoặc mật khẩu không đúng (hoặc tài khoản chưa đặt mật khẩu — hãy đăng nhập bằng OTP).');
    }
    this.clearAuthFailures(failKeys);
    await this.audit.log(
      { id: user.id, name: user.name, role: user.role, ip: meta.ip },
      'auth.password_login',
      user.id,
      null,
      { channel: parsed.channel, deviceFingerprint: meta.deviceFingerprint },
      meta.ip,
    );
    return this.issueSession(user, meta);
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
  async staffLogin(
    staffIdentifier: string,
    password: string,
    unit?: string,
    metaInput?: RequestMeta | string,
  ): Promise<IssuedAuth> {
    const meta = normalizeMeta(metaInput);
    const trimmed = staffIdentifier.trim();
    const failKeys = [`staff:${trimmed.toLowerCase()}`, meta.ip ? `ip_staff:${meta.ip}` : ''];
    this.assertNotRateLocked(failKeys, 'Tài khoản');

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
      this.recordAuthFailure(failKeys);
      throw unauthorized('Mã tài khoản, Email/SĐT hoặc mật khẩu không đúng.');
    }

    u.role = role;
    this.clearAuthFailures(failKeys);
    await this.audit.log(
      { id: u.id, name: u.name, role: u.role, ip: meta.ip },
      'auth.staff_login',
      u.id,
      null,
      { unit: unit ?? u.wardCode ?? 'city', deviceFingerprint: meta.deviceFingerprint },
      meta.ip,
    );
    return this.issueSession(u, meta);
  }

  /** Tương thích ngược API cho Đội Cứu Hộ (`RESCUE` / `ADMIN`), ủy quyền về luồng đăng nhập nội bộ chuẩn. */
  async rescueLogin(identifierRaw: string, password: string, metaInput?: RequestMeta | string): Promise<IssuedAuth> {
    const meta = normalizeMeta(metaInput);
    const trimmed = identifierRaw.trim();
    const failKeys = [`rescue:${trimmed.toLowerCase()}`, meta.ip ? `ip_rescue:${meta.ip}` : ''];
    this.assertNotRateLocked(failKeys, 'Tài khoản Đội Cứu Hộ');

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
      this.recordAuthFailure(failKeys);
      throw unauthorized('Mã tài khoản / Email hoặc mật khẩu không đúng (yêu cầu quyền RESCUE).');
    }
    u.role = role;
    this.clearAuthFailures(failKeys);
    await this.audit.log(
      { id: u.id, name: u.name, role: u.role, ip: meta.ip },
      'auth.rescue_login',
      u.id,
      null,
      { staffCode: u.staffCode, wardCode: u.wardCode, deviceFingerprint: meta.deviceFingerprint },
      meta.ip,
    );
    return this.issueSession(u, meta);
  }

  /** Xoay vòng Refresh Token (rotation) + phát hiện tái sử dụng token cũ (Reuse Detection). */
  async refreshSession(refreshTokenRaw: string | null, metaInput?: RequestMeta | string): Promise<IssuedAuth> {
    if (!refreshTokenRaw) throw unauthorized('Không tìm thấy phiên làm việc.', 'SESSION_REVOKED');
    const rec = await this.sessions.getByRefreshHash(sha256(refreshTokenRaw));
    if (!rec) throw unauthorized('Refresh token không hợp lệ.', 'SESSION_REVOKED');

    if (rec.isRevoked || rec.revokedAt !== null) {
      if (rec.revokedReason === 'SESSION_REPLACED') {
        throw new HttpError(401, 'Tài khoản đã được đăng nhập trên thiết bị khác.', 'SESSION_REPLACED');
      }
      // Phát hiện tái sử dụng refresh token đã xoay vòng -> lập tức thu hồi toàn bộ phiên người dùng
      const targetUser = await this.users.get(rec.userId);
      await this.sessions.revokeAllForUser(rec.userId, 'REUSE_DETECTED');
      if (targetUser) {
        targetUser.tokenVersion = (targetUser.tokenVersion ?? 0) + 1;
        targetUser.activeSessionId = null;
        await this.users.save(targetUser);
        await this.audit.log(
          { id: targetUser.id, name: targetUser.name, role: targetUser.role },
          'security.refresh_reuse_detected',
          targetUser.id,
          { sessionId: rec.id },
          { action: 'REVOKE_ALL_SESSIONS' },
        );
      }
      this.invalidateSessionCache(rec.userId);
      notifySessionTerminated(rec.userId, {
        code: 'SESSION_COMPROMISED',
        message: 'Phát hiện tái sử dụng phiên cũ — đã đăng xuất toàn bộ thiết bị để bảo vệ tài khoản.',
      });
      throw new HttpError(
        401,
        'Phát hiện tái sử dụng phiên cũ — đã đăng xuất toàn bộ thiết bị để bảo vệ tài khoản.',
        'SESSION_COMPROMISED',
      );
    }
    if (rec.expiresAt <= Date.now()) {
      await this.sessions.revoke(rec.id, null, 'EXPIRED');
      this.invalidateSessionCache(rec.userId, rec.id);
      throw unauthorized('Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.', 'SESSION_REVOKED');
    }

    const user = await this.me(rec.userId);
    if (user.activeSessionId && user.activeSessionId !== rec.id) {
      await this.sessions.revoke(rec.id, null, 'SESSION_REPLACED');
      this.invalidateSessionCache(user.id, rec.id);
      throw new HttpError(401, 'Tài khoản đã được đăng nhập trên thiết bị khác.', 'SESSION_REPLACED');
    }

    // Xoay vòng phiên: giữ tokenVersion nhất quán, đánh dấu phiên cũ `ROTATED` và trỏ `replacedBySessionId`
    return this.issueSession(user, metaInput, {
      rotationOfSessionId: rec.id,
      skipBumpVersion: true,
    });
  }

  /** Đổi mật khẩu: yêu cầu xác thực lại, tăng `tokenVersion`, thu hồi mọi phiên khác (giữ lại `currentSessionId`) và cấp cặp token mới. */
  async changePassword(
    userId: string,
    currentSessionId: string,
    input: { currentPassword?: string; otpCode?: string; newPassword: string },
    metaInput?: RequestMeta,
  ): Promise<{ issued: IssuedAuth; revokedOtherSessions: number }> {
    this.assertPasswordIfProvided(input.newPassword);
    const meta = normalizeMeta(metaInput);
    const u = await this.me(userId);

    if (u.passwordHash) {
      const ok = Boolean(input.currentPassword && verifyPassword(input.currentPassword, u.passwordHash));
      if (!ok) {
        if (input.otpCode && (u.email || u.phone)) {
          await this.consumeOtpChallenge(u.email ?? u.phone!, input.otpCode);
        } else {
          throw forbidden('Mật khẩu hiện tại không chính xác.', 'invalid_current_password');
        }
      }
    } else if (input.otpCode && (u.email || u.phone)) {
      await this.consumeOtpChallenge(u.email ?? u.phone!, input.otpCode);
    } else if (!input.otpCode && !input.currentPassword) {
      throw forbidden('Vui lòng xác thực lại bằng mật khẩu hiện tại hoặc mã OTP.', 'REAUTH_REQUIRED');
    }

    const nextTv = (u.tokenVersion ?? 0) + 1;
    u.passwordHash = hashPassword(input.newPassword);
    u.tokenVersion = nextTv;
    u.activeSessionId = currentSessionId;
    await this.users.save(u);

    const revokedOtherSessions = await this.sessions.revokeAllExcept(u.id, currentSessionId, 'PASSWORD_CHANGED');
    const issued = await this.rotateCurrentSessionKeepingId(u, currentSessionId, meta, nextTv);

    await this.audit.log(
      { id: u.id, name: u.name, role: u.role, ip: meta.ip },
      'auth.password_change',
      u.id,
      null,
      { currentSessionId, tokenVersion: nextTv, revokedOtherSessions },
      meta.ip,
    );
    return { issued, revokedOtherSessions };
  }

  /** Đổi Email: xác thực lại (mật khẩu hiện tại nếu có + OTP gửi tới email mới), tăng `tokenVersion`, đá toàn bộ thiết bị khác. */
  async changeEmail(
    userId: string,
    currentSessionId: string,
    input: { newEmail: string; otpCode: string; currentPassword?: string },
    metaInput?: RequestMeta,
  ): Promise<{ issued: IssuedAuth; revokedOtherSessions: number }> {
    const meta = normalizeMeta(metaInput);
    const normalized = normalizeEmail(input.newEmail);
    if (!normalized) throw badRequest('Địa chỉ Email mới không hợp lệ.', 'invalid_email');

    const u = await this.me(userId);
    if (u.passwordHash) {
      if (!input.currentPassword || !verifyPassword(input.currentPassword, u.passwordHash)) {
        throw forbidden('Mật khẩu hiện tại không đúng.', 'REAUTH_REQUIRED');
      }
    }
    const existing = await this.users.getByEmail(normalized);
    if (existing && existing.id !== u.id) {
      throw badRequest('Email này đã thuộc về tài khoản khác.', 'duplicate_email');
    }

    const parsed = await this.consumeOtpChallenge(normalized, input.otpCode);
    if (parsed.channel !== 'email') {
      throw badRequest('Mã OTP phải được xác thực từ địa chỉ Email mới.', 'invalid_otp_channel');
    }

    const beforeEmail = u.email;
    const nextTv = (u.tokenVersion ?? 0) + 1;
    u.email = normalized;
    u.tokenVersion = nextTv;
    u.activeSessionId = currentSessionId;
    await this.users.save(u);

    const revokedOtherSessions = await this.sessions.revokeAllExcept(u.id, currentSessionId, 'EMAIL_CHANGED');
    const issued = await this.rotateCurrentSessionKeepingId(u, currentSessionId, meta, nextTv);

    await this.audit.log(
      { id: u.id, name: u.name, role: u.role, ip: meta.ip },
      'auth.email_change',
      u.id,
      { email: beforeEmail },
      { email: normalized, revokedOtherSessions },
      meta.ip,
    );
    return { issued, revokedOtherSessions };
  }

  /** Đổi SĐT: xác thực lại (mật khẩu hiện tại nếu có + SMS OTP tới SĐT mới), tăng `tokenVersion`, đá toàn bộ thiết bị khác. */
  async changePhone(
    userId: string,
    currentSessionId: string,
    input: { newPhone: string; otpCode?: string; firebaseIdToken?: string; currentPassword?: string },
    metaInput?: RequestMeta,
  ): Promise<{ issued: IssuedAuth; revokedOtherSessions: number }> {
    const meta = normalizeMeta(metaInput);
    const parsedPhone = parseVnPhone(input.newPhone);
    if (!parsedPhone) throw badRequest('Số điện thoại Việt Nam không hợp lệ.', 'invalid_phone');

    const u = await this.me(userId);
    if (u.passwordHash) {
      if (!input.currentPassword || !verifyPassword(input.currentPassword, u.passwordHash)) {
        throw forbidden('Mật khẩu hiện tại không đúng.', 'REAUTH_REQUIRED');
      }
    }

    const existing =
      (await this.users.getByPhone(parsedPhone.local)) ??
      (await this.users.getByPhone(parsedPhone.e164));
    if (existing && existing.id !== u.id) {
      throw badRequest('Số điện thoại này đã thuộc về tài khoản khác.', 'duplicate_phone');
    }

    if (input.otpCode) {
      const ch = this.phoneOtp ? await this.phoneOtp.peekChallenge(parsedPhone.e164) : null;
      if (ch && this.phoneOtp) {
        await this.phoneOtp.verifyPhoneOtp(parsedPhone.e164, input.otpCode);
      } else {
        await this.consumeOtpChallenge(parsedPhone.local, input.otpCode);
      }
    } else {
      throw badRequest('Vui lòng cung cấp mã OTP xác thực SĐT mới.', 'otp_required');
    }

    const beforePhone = u.phone ? maskPhone(u.phone) : null;
    const nextTv = (u.tokenVersion ?? 0) + 1;
    u.phone = parsedPhone.local;
    u.tokenVersion = nextTv;
    u.activeSessionId = currentSessionId;
    await this.users.save(u);

    const revokedOtherSessions = await this.sessions.revokeAllExcept(u.id, currentSessionId, 'PHONE_CHANGED');
    const issued = await this.rotateCurrentSessionKeepingId(u, currentSessionId, meta, nextTv);

    await this.audit.log(
      { id: u.id, name: u.name, role: u.role, ip: meta.ip },
      'auth.phone_change',
      u.id,
      { phone: beforePhone },
      { phone: parsedPhone.masked, revokedOtherSessions },
      meta.ip,
    );
    return { issued, revokedOtherSessions };
  }

  private async rotateCurrentSessionKeepingId(
    u: UserRecord,
    currentSessionId: string,
    meta: Required<RequestMeta>,
    tokenVersion: number,
  ): Promise<IssuedAuth> {
    const now = Date.now();
    const refreshToken = randomOpaqueToken();
    const refreshHash = sha256(refreshToken);
    const refreshMaxAgeMs = env.refreshTokenDays * 24 * 3600 * 1000;
    const existing = await this.sessions.get(currentSessionId);

    const updated: SessionRecord = {
      id: currentSessionId,
      userId: u.id,
      refreshHash,
      tokenHash: refreshHash,
      deviceFingerprint: existing?.deviceFingerprint || meta.deviceFingerprint,
      ip: meta.ip || existing?.ip || '',
      userAgent: meta.userAgent || existing?.userAgent || '',
      tokenVersion,
      createdAt: existing?.createdAt ?? now,
      lastActiveAt: now,
      expiresAt: now + refreshMaxAgeMs,
      isRevoked: false,
      revokedAt: null,
      revokedReason: null,
      replacedBySessionId: null,
    };
    await this.sessions.save(updated);

    this.invalidateSessionCache(u.id, currentSessionId);
    this.sessionCache.set(currentSessionId, updated);
    this.userVersionCache.set(u.id, {
      tokenVersion,
      activeSessionId: currentSessionId,
      revoked: false,
    });

    notifySessionTerminated(u.id, {
      excludeSessionId: currentSessionId,
      code: 'SESSION_REVOKED',
      message: 'Thông tin bảo mật tài khoản vừa thay đổi — các thiết bị khác đã bị đăng xuất.',
    });

    return {
      session: { token: this.signAccessToken(u, currentSessionId, tokenVersion), user: toProfile(u) },
      refreshToken,
      refreshMaxAgeMs,
    };
  }

  /** Cấp Re-auth Token (5 phút) cho thao tác nhạy cảm (đổi quyền, xóa tài khoản, sửa cấu hình AI, purge). */
  async issueReauthToken(
    user: UserRecord,
    sessionId: string,
    input: { currentPassword?: string; otpCode?: string; ip?: string },
  ): Promise<{ reauthToken: string; expiresInSec: number }> {
    if (user.passwordHash) {
      if (!input.currentPassword || !verifyPassword(input.currentPassword, user.passwordHash)) {
        throw forbidden('Mật khẩu xác thực lại không đúng.', 'REAUTH_FAILED');
      }
    } else if (input.otpCode && (user.email || user.phone)) {
      await this.consumeOtpChallenge(user.email ?? user.phone!, input.otpCode);
    } else {
      throw forbidden('Tài khoản cần xác thực OTP để thực hiện hành động nhạy cảm.', 'REAUTH_FAILED');
    }

    const claims: ReauthClaims = {
      sub: user.id,
      sid: sessionId,
      tv: user.tokenVersion ?? 0,
      scope: 'reauth',
    };
    const reauthToken = jwt.sign(claims, env.jwtSecret, {
      expiresIn: REAUTH_TOKEN_EXPIRES_IN,
      issuer: 'smartcitizen-dongnai',
      algorithm: 'HS256',
    });
    await this.audit.log(
      { id: user.id, name: user.name, role: user.role, ip: input.ip },
      'auth.reauth',
      user.id,
      null,
      { sessionId },
      input.ip,
    );
    return { reauthToken, expiresInSec: 300 };
  }

  /** Kiểm tra Re-auth từ Header `X-Reauth-Token` hoặc mật khẩu hiện tại trong Request. */
  async verifyReauth(
    user: UserRecord,
    sessionId: string,
    opts: { reauthToken?: string; currentPassword?: string },
  ): Promise<void> {
    if (opts.reauthToken) {
      try {
        const claims = jwt.verify(opts.reauthToken, env.jwtSecret, {
          issuer: 'smartcitizen-dongnai',
          algorithms: ['HS256'],
        }) as unknown as ReauthClaims;
        if (
          claims?.scope === 'reauth' &&
          claims.sub === user.id &&
          claims.sid === sessionId &&
          claims.tv === (user.tokenVersion ?? 0)
        ) {
          return;
        }
      } catch {
        // Fall through to password check or error
      }
    }
    if (opts.currentPassword && user.passwordHash && verifyPassword(opts.currentPassword, user.passwordHash)) {
      return;
    }
    throw new HttpError(
      403,
      'Thao tác nguy hiểm yêu cầu xác thực lại mật khẩu hiện tại (Re-auth).',
      'REAUTH_REQUIRED',
    );
  }

  async listMySessions(userId: string, currentSessionId?: string): Promise<SessionInfo[]> {
    const list = await this.sessions.listActive({ userId, includeRevoked: false, limit: 20 });
    return list.map((s) => ({
      id: s.id,
      userId: s.userId,
      deviceFingerprint: s.deviceFingerprint || 'web-browser',
      ip: s.ip || '0.0.0.0',
      userAgent: s.userAgent,
      createdAt: s.createdAt,
      lastActiveAt: s.lastActiveAt ?? s.createdAt,
      expiresAt: s.expiresAt,
      isRevoked: Boolean(s.isRevoked || s.revokedAt !== null),
      revokedAt: s.revokedAt,
      revokedReason: s.revokedReason ?? null,
      isCurrent: Boolean(currentSessionId && s.id === currentSessionId),
    }));
  }

  async logout(refreshTokenRaw: string | null, sessionId?: string | null, userId?: string): Promise<void> {
    if (refreshTokenRaw) {
      const rec = await this.sessions.getByRefreshHash(sha256(refreshTokenRaw));
      if (rec && !rec.revokedAt) {
        await this.sessions.revoke(rec.id, null, 'LOGOUT');
        this.invalidateSessionCache(rec.userId, rec.id);
        const u = await this.users.get(rec.userId);
        if (u && u.activeSessionId === rec.id) {
          u.activeSessionId = null;
          await this.users.save(u);
        }
        return;
      }
    }
    if (sessionId && userId) {
      await this.sessions.revoke(sessionId, null, 'LOGOUT');
      this.invalidateSessionCache(userId, sessionId);
      const u = await this.users.get(userId);
      if (u && u.activeSessionId === sessionId) {
        u.activeSessionId = null;
        await this.users.save(u);
      }
    }
  }

  async logoutAll(userId: string): Promise<void> {
    const u = await this.users.get(userId);
    if (u) {
      u.tokenVersion = (u.tokenVersion ?? 0) + 1;
      u.activeSessionId = null;
      await this.users.save(u);
    }
    await this.sessions.revokeAllForUser(userId, 'FORCE_LOGOUT');
    this.invalidateSessionCache(userId);
    notifySessionTerminated(userId, {
      code: 'SESSION_REVOKED',
      message: 'Toàn bộ phiên đăng nhập đã bị đăng xuất.',
    });
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
    patch: {
      name?: string;
      defaultWardCode?: string | null;
      followedWardCodes?: string[];
      notificationsEnabled?: boolean;
      newPassword?: string;
      currentPassword?: string;
    },
    currentSessionId?: string,
    metaInput?: RequestMeta,
  ): Promise<{ user: UserRecord; issued?: IssuedAuth }> {
    const u = await this.me(userId);
    if (patch.newPassword !== undefined) {
      if (currentSessionId) {
        const { issued } = await this.changePassword(
          userId,
          currentSessionId,
          { currentPassword: patch.currentPassword, newPassword: patch.newPassword },
          metaInput,
        );
        if (
          patch.name !== undefined ||
          patch.defaultWardCode !== undefined ||
          patch.followedWardCodes !== undefined ||
          patch.notificationsEnabled !== undefined
        ) {
          return this.updateProfile(
            userId,
            {
              name: patch.name,
              defaultWardCode: patch.defaultWardCode,
              followedWardCodes: patch.followedWardCodes,
              notificationsEnabled: patch.notificationsEnabled,
            },
            currentSessionId,
            metaInput,
          );
        }
        return { user: await this.me(userId), issued };
      }
      this.assertPasswordIfProvided(patch.newPassword);
      u.passwordHash = hashPassword(patch.newPassword);
    }
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
    if (patch.followedWardCodes !== undefined) {
      const unique: string[] = [];
      for (const rawCode of patch.followedWardCodes) {
        const code = String(rawCode).trim().toUpperCase();
        if (!getWard(code)) {
          throw badRequest(`Mã xã/phường theo dõi không hợp lệ: ${code}`, 'invalid_ward');
        }
        if (!unique.includes(code)) unique.push(code);
      }
      u.followedWardCodes = unique.slice(0, 30);
    }
    if (patch.notificationsEnabled !== undefined) {
      u.notificationsEnabled = patch.notificationsEnabled;
    }
    await this.users.save(u);
    return { user: u };
  }

  async markNotificationsRead(userId: string): Promise<void> {
    const u = await this.me(userId);
    u.notifications = u.notifications.map((n) => ({ ...n, read: true }));
    await this.users.save(u);
  }

  async registerVolunteer(userId: string, wardCode: string, unitCode: string, metaInput?: RequestMeta): Promise<IssuedAuth> {
    const u = await this.me(userId);
    if (!getWard(wardCode)) throw badRequest('Phường/Xã công tác không hợp lệ.', 'invalid_ward');
    if (!UNIT_CODE_REGEX.test(unitCode)) throw badRequest('Mã đơn vị không hợp lệ (ví dụ: DN-TB-01).', 'invalid_unit');
    const before = { role: u.role, wardCode: u.wardCode, unitCode: u.unitCode };
    u.defaultWardCode = wardCode;
    u.unitCode = unitCode;
    await this.users.save(u);
    await this.audit.log(
      { id: u.id, name: u.name, role: u.role },
      'citizen.unit_register',
      u.id,
      before,
      { role: u.role, wardCode, unitCode },
    );
    return this.issueSession(u, metaInput);
  }
}
