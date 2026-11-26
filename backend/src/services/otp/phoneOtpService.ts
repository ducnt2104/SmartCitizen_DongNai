import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { OtpToken } from '../../models/OtpToken';
import type { Repositories } from '../../repositories/types';
import { badRequest, tooMany } from '../../utils/errors';
import { safeEqualHex, sha256 } from '../../utils/crypto';
import {
  OTP_COOLDOWN_MS,
  OTP_MAX_VERIFY_ATTEMPTS,
  OtpSendRateLimiter,
} from './otpRateLimiter';
import { requireVnPhone, type ParsedVnPhone } from './phoneNormalizer';
import {
  MultiSmsOtpDispatcher,
  type ConcreteSmsProviderName,
  type FetchLike,
  type RuntimeFirebaseClientConfig,
} from './smsProviders';

export const PHONE_OTP_TTL_MS = 5 * 60 * 1000;

export interface StoredPhoneOtpChallenge {
  target: string;
  channel: 'phone';
  purpose: 'login' | 'reset_password' | 'verify_phone';
  otpHash: string;
  otpSalt?: string;
  attempts: number;
  resendAt: number;
  expiresAt: number;
  consumedAt: number | null;
  invalidatedAt: number | null;
}

export interface SendPhoneOtpResponse {
  channel: 'phone';
  target: string;
  targetMasked: string;
  resendInSec: number;
  expiresInSec: number;
  provider: ConcreteSmsProviderName | string;
  clientSideFirebase?: boolean;
  firebaseClientConfig?: RuntimeFirebaseClientConfig | null;
  directSmsAvailable?: boolean;
}

/** Sinh mã OTP 6 chữ số ngẫu nhiên mật mã học (`100000`–`999999`). */
export function generateSixDigitOtp(): string {
  return String(crypto.randomInt(100_000, 1_000_000));
}

/** Sinh salt ngẫu nhiên 128-bit cho mỗi mã OTP trước khi băm SHA-256. */
export function generateOtpSalt(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Băm mã OTP bằng SHA-256 (+ salt nếu có) trước khi lưu xuống MongoDB.
 */
export function hashOtpCodeSha256(otp: string, salt?: string): string {
  const clean = otp.trim();
  return salt ? sha256(`${salt}:${clean}`) : sha256(clean);
}

function isMongoReady(): boolean {
  return mongoose.connection.readyState === 1;
}

/**
 * Dịch vụ quản lý vòng đời SMS OTP (`SmsOtpService` / `PhoneOtpService`):
 * - Chuẩn hóa E.164 nghiêm ngặt (`03`, `05`, `07`, `08`, `09`, đủ 10 số -> `+84...`).
 * - Chống spam: Cooldown 60s + tối đa 3 lần gửi / 10 phút / SĐT.
 * - Lưu SHA-256 + salt vào `OtpToken` (MongoDB TTL 300 giây) + bộ nhớ/SQLite đồng bộ.
 * - Chống brute-force: Nhập sai quá 5 lần lập tức hủy/khóa mã OTP đó.
 */
export class PhoneOtpService {
  readonly rateLimiter: OtpSendRateLimiter;
  readonly smsDispatcher: MultiSmsOtpDispatcher;
  private readonly otpRepo?: Repositories['otps'];
  private readonly memoryStore = new Map<string, StoredPhoneOtpChallenge>();

  constructor(opts?: {
    rateLimiter?: OtpSendRateLimiter;
    smsDispatcher?: MultiSmsOtpDispatcher;
    fetchImpl?: FetchLike;
    otpRepo?: Repositories['otps'];
  }) {
    this.rateLimiter = opts?.rateLimiter ?? new OtpSendRateLimiter();
    this.smsDispatcher = opts?.smsDispatcher ?? new MultiSmsOtpDispatcher(opts?.fetchImpl);
    this.otpRepo = opts?.otpRepo;
  }

  private async loadLatestChallenge(phoneE164: string): Promise<StoredPhoneOtpChallenge | null> {
    if (isMongoReady()) {
      try {
        const doc = await OtpToken.findOne({ channel: 'phone', target: phoneE164 })
          .sort({ createdAt: -1 })
          .lean();
        if (doc) {
          return {
            target: doc.target,
            channel: 'phone',
            purpose: doc.purpose,
            otpHash: doc.otpHash,
            otpSalt: doc.otpSalt,
            attempts: doc.attempts ?? 0,
            resendAt: doc.resendAt ? new Date(doc.resendAt).getTime() : 0,
            expiresAt: new Date(doc.expiresAt).getTime(),
            consumedAt: doc.consumedAt ? new Date(doc.consumedAt).getTime() : null,
            invalidatedAt: doc.invalidatedAt ? new Date(doc.invalidatedAt).getTime() : null,
          };
        }
      } catch {
        /* fallback xuống bộ nhớ / SQLite local */
      }
    }
    const mem = this.memoryStore.get(phoneE164);
    if (mem) return { ...mem };
    if (this.otpRepo) {
      const localRec = await this.otpRepo.get(phoneE164).catch(() => null);
      if (localRec) {
        return {
          target: phoneE164,
          channel: 'phone',
          purpose:
            localRec.purpose === 'reset_password'
              ? 'reset_password'
              : localRec.purpose === 'change_phone'
                ? 'verify_phone'
                : 'login',
          otpHash: localRec.codeHash,
          otpSalt: localRec.otpSalt,
          attempts: localRec.failedAttempts ?? 0,
          resendAt: localRec.resendAt ?? 0,
          expiresAt: localRec.expiresAt,
          consumedAt: localRec.consumedAt ?? null,
          invalidatedAt: localRec.lockedUntil && localRec.lockedUntil > 0 ? localRec.lockedUntil : null,
        };
      }
    }
    return null;
  }

  private async persistNewChallenge(rec: StoredPhoneOtpChallenge): Promise<void> {
    this.memoryStore.set(rec.target, { ...rec });
    if (this.otpRepo) {
      await this.otpRepo
        .save({
          identifier: rec.target,
          channel: 'sms',
          purpose: rec.purpose === 'reset_password' ? 'reset_password' : 'login',
          codeHash: rec.otpHash,
          otpSalt: rec.otpSalt,
          expiresAt: rec.expiresAt,
          resendAt: rec.resendAt,
          failedAttempts: 0,
          lockedUntil: 0,
          consumedAt: null,
        })
        .catch(() => undefined);
    }
    if (isMongoReady()) {
      try {
        await OtpToken.deleteMany({ channel: 'phone', target: rec.target });
        await OtpToken.create({
          target: rec.target,
          identifier: rec.target,
          channel: 'phone',
          purpose: rec.purpose,
          otpHash: rec.otpHash,
          otpSalt: rec.otpSalt,
          codeHash: rec.otpHash,
          attempts: 0,
          failedAttempts: 0,
          resendAt: new Date(rec.resendAt),
          expiresAt: new Date(rec.expiresAt),
          consumedAt: null,
          invalidatedAt: null,
          lockedUntil: null,
        });
      } catch {
        /* đã lưu ở memoryStore + SQLite local */
      }
    }
  }

  private async updateChallengeState(rec: StoredPhoneOtpChallenge): Promise<void> {
    this.memoryStore.set(rec.target, { ...rec });
    if (this.otpRepo) {
      await this.otpRepo
        .save({
          identifier: rec.target,
          channel: 'sms',
          purpose: rec.purpose === 'reset_password' ? 'reset_password' : 'login',
          codeHash: rec.otpHash,
          otpSalt: rec.otpSalt,
          expiresAt: rec.expiresAt,
          resendAt: rec.resendAt,
          failedAttempts: rec.attempts,
          lockedUntil: rec.invalidatedAt ?? 0,
          consumedAt: rec.consumedAt,
        })
        .catch(() => undefined);
    }
    if (isMongoReady()) {
      try {
        await OtpToken.findOneAndUpdate(
          { channel: 'phone', target: rec.target },
          {
            $set: {
              attempts: rec.attempts,
              failedAttempts: rec.attempts,
              consumedAt: rec.consumedAt ? new Date(rec.consumedAt) : null,
              invalidatedAt: rec.invalidatedAt ? new Date(rec.invalidatedAt) : null,
              lockedUntil: rec.invalidatedAt ? new Date(rec.invalidatedAt) : null,
            },
          },
          { sort: { createdAt: -1 } },
        );
      } catch {
        /* đã cập nhật ở memoryStore + SQLite local */
      }
    }
  }

  /** Gửi mã OTP 6 số thật về SĐT Việt Nam (`+84...`). */
  async sendPhoneOtp(
    rawPhone: string,
    opts?: {
      purpose?: 'login' | 'reset_password' | 'verify_phone';
      now?: number;
      envSource?: NodeJS.ProcessEnv;
      preferDirectSms?: boolean;
    },
  ): Promise<SendPhoneOtpResponse> {
    const parsed = requireVnPhone(rawPhone);
    const now = opts?.now ?? Date.now();
    const purpose = opts?.purpose ?? 'login';
    const envSource = opts?.envSource ?? process.env;
    const preferDirectSms = Boolean(opts?.preferDirectSms);

    // 1. Kiểm tra Cooldown 60s & Giới hạn 3 lần / 10 phút / SĐT
    this.rateLimiter.assertCanSend(parsed.e164, now, {
      allowFirebaseFallbackBypass: preferDirectSms,
    });

    // Kiểm tra thêm resendAt lưu trong DB (phòng trường hợp vừa restart server)
    const existing = await this.loadLatestChallenge(parsed.e164);
    if (existing && existing.resendAt > now) {
      const waitSec = Math.max(1, Math.ceil((existing.resendAt - now) / 1000));
      throw tooMany(`Vui lòng chờ ${waitSec} giây trước khi yêu cầu gửi lại mã OTP.`, 'otp_cooldown', {
        retryAfter: waitSec,
        retryAfterSec: waitSec,
      });
    }

    // 2. Sinh mã 6 số CSPRNG + salt ngẫu nhiên 128-bit & băm SHA-256
    const otp = generateSixDigitOtp();
    const otpSalt = generateOtpSalt();
    const otpHash = hashOtpCodeSha256(otp, otpSalt);

    // 3. Gửi qua Multi-Provider SMS Dispatcher (tự chọn kênh khả dụng hoặc ném SMS_PROVIDER_NOT_CONFIGURED)
    const sendResult = await this.smsDispatcher.sendOtp(
      {
        phoneE164: parsed.e164,
        phoneLocal: parsed.local,
        otp,
        ttlMinutes: PHONE_OTP_TTL_MS / 60_000,
        purpose,
      },
      envSource,
      { preferDirectSms },
    );

    // 4. Lưu challenge & ghi nhận rate limit sau khi cổng SMS xác nhận
    if (!sendResult.clientSideFirebase) {
      await this.persistNewChallenge({
        target: parsed.e164,
        channel: 'phone',
        purpose,
        otpHash,
        otpSalt,
        attempts: 0,
        resendAt: now + OTP_COOLDOWN_MS,
        expiresAt: now + PHONE_OTP_TTL_MS,
        consumedAt: null,
        invalidatedAt: null,
      });
    }
    this.rateLimiter.recordSent(parsed.e164, now, {
      isFirebasePrecheck: Boolean(sendResult.clientSideFirebase),
    });

    const statusSnapshot = sendResult.clientSideFirebase ? this.smsDispatcher.getStatus(envSource) : null;

    return {
      channel: 'phone',
      target: parsed.e164,
      targetMasked: parsed.masked,
      resendInSec: OTP_COOLDOWN_MS / 1000,
      expiresInSec: PHONE_OTP_TTL_MS / 1000,
      provider: sendResult.provider,
      ...(sendResult.clientSideFirebase
        ? {
            clientSideFirebase: true,
            firebaseClientConfig: statusSnapshot?.firebaseClientConfig ?? null,
            directSmsAvailable: Boolean(statusSnapshot?.directSmsConfigured),
          }
        : {}),
    };
  }

  /**
   * Xác thực mã OTP 6 số cho SĐT Việt Nam:
   * - Kiểm tra hạn 300 giây (5 phút), chống dùng lại (`consumedAt`), và khóa ngay khi sai >= 5 lần.
   */
  async verifyPhoneOtp(
    rawPhone: string,
    rawOtpCode: string,
    now = Date.now(),
  ): Promise<ParsedVnPhone> {
    const parsed = requireVnPhone(rawPhone);
    const otpCode = rawOtpCode.trim();
    if (!/^\d{6}$/.test(otpCode)) {
      throw badRequest('Mã OTP phải gồm đúng 6 chữ số.', 'invalid_otp_format');
    }

    const rec = await this.loadLatestChallenge(parsed.e164);
    if (!rec) {
      throw badRequest('Chưa có mã OTP cho số điện thoại này hoặc mã đã hết hạn. Vui lòng yêu cầu gửi mã.', 'otp_missing');
    }
    if (rec.consumedAt !== null) {
      throw badRequest('Mã OTP này đã được sử dụng. Vui lòng yêu cầu gửi mã mới.', 'otp_consumed');
    }
    if (rec.invalidatedAt !== null || rec.attempts >= OTP_MAX_VERIFY_ATTEMPTS) {
      throw tooMany(
        `Mã OTP đã bị khóa do nhập sai quá ${OTP_MAX_VERIFY_ATTEMPTS} lần. Vui lòng yêu cầu gửi mã mới.`,
        'otp_locked',
        { retryAfter: 10, retryAfterSec: 10 },
      );
    }
    if (rec.expiresAt < now) {
      this.memoryStore.delete(parsed.e164);
      if (isMongoReady()) {
        await OtpToken.deleteMany({ channel: 'phone', target: parsed.e164 });
      }
      throw badRequest('Mã OTP đã hết hạn (5 phút). Vui lòng yêu cầu gửi mã mới.', 'otp_expired');
    }

    const candidateHash = hashOtpCodeSha256(otpCode, rec.otpSalt);
    if (!safeEqualHex(rec.otpHash, candidateHash)) {
      rec.attempts += 1;
      if (rec.attempts >= OTP_MAX_VERIFY_ATTEMPTS) {
        rec.invalidatedAt = now;
        await this.updateChallengeState(rec);
        throw tooMany(
          `Nhập sai ${OTP_MAX_VERIFY_ATTEMPTS} lần — mã OTP này đã bị khóa để bảo vệ tài khoản. Vui lòng yêu cầu mã mới.`,
          'otp_locked',
          { retryAfter: 10, retryAfterSec: 10 },
        );
      }
      await this.updateChallengeState(rec);
      throw badRequest(
        `Mã OTP chưa chính xác. Bạn còn ${OTP_MAX_VERIFY_ATTEMPTS - rec.attempts} lần thử.`,
        'otp_invalid',
      );
    }

    rec.consumedAt = now;
    await this.updateChallengeState(rec);
    return parsed;
  }

  /** Kiểm tra trạng thái bản ghi OTP trong bộ nhớ/DB. */
  async peekChallenge(rawPhone: string): Promise<StoredPhoneOtpChallenge | null> {
    const parsed = requireVnPhone(rawPhone);
    return this.loadLatestChallenge(parsed.e164);
  }

  resetMemory(): void {
    this.memoryStore.clear();
    this.rateLimiter.reset();
  }
}

export class SmsOtpService extends PhoneOtpService {}
