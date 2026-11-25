import crypto from 'node:crypto';
import mongoose from 'mongoose';
import { OtpToken } from '../../models/OtpToken';
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
} from './smsProviders';

export const PHONE_OTP_TTL_MS = 5 * 60 * 1000;

export interface StoredPhoneOtpChallenge {
  target: string;
  channel: 'phone';
  purpose: 'login' | 'reset_password' | 'verify_phone';
  otpHash: string;
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
  provider: ConcreteSmsProviderName;
  clientSideFirebase?: boolean;
  devOtpPreview?: string;
}

/** Sinh mã OTP 6 chữ số ngẫu nhiên mật mã học (`100000`–`999999`). */
export function generateSixDigitOtp(): string {
  return String(crypto.randomInt(100_000, 1_000_000));
}

/** Băm mã OTP bằng SHA-256 trước khi lưu xuống MongoDB. */
export function hashOtpCodeSha256(otp: string): string {
  return sha256(otp.trim());
}

function isMongoReady(): boolean {
  return mongoose.connection.readyState === 1;
}

/**
 * Dịch vụ quản lý vòng đời SMS OTP cho Số điện thoại Việt Nam (`+84`):
 * - Chuẩn hóa E.164 nghiêm ngặt (`03`, `05`, `07`, `08`, `09`, đủ 10 số).
 * - Chống spam: Cooldown 60s + tối đa 5 tin SMS / giờ / SĐT.
 * - Lưu SHA-256 vào `OtpToken` (MongoDB TTL 5 phút) + bộ nhớ đồng bộ khi chạy JSON/test.
 * - Chống brute-force: Nhập sai đến lần thứ 5 (hoặc quá 5 lần) lập tức hủy/khóa mã OTP đó.
 */
export class PhoneOtpService {
  readonly rateLimiter: OtpSendRateLimiter;
  readonly smsDispatcher: MultiSmsOtpDispatcher;
  private readonly memoryStore = new Map<string, StoredPhoneOtpChallenge>();

  constructor(opts?: {
    rateLimiter?: OtpSendRateLimiter;
    smsDispatcher?: MultiSmsOtpDispatcher;
    fetchImpl?: FetchLike;
  }) {
    this.rateLimiter = opts?.rateLimiter ?? new OtpSendRateLimiter();
    this.smsDispatcher = opts?.smsDispatcher ?? new MultiSmsOtpDispatcher(opts?.fetchImpl);
  }

  private async loadLatestChallenge(phoneE164: string): Promise<StoredPhoneOtpChallenge | null> {
    if (isMongoReady()) {
      const doc = await OtpToken.findOne({ channel: 'phone', target: phoneE164 })
        .sort({ createdAt: -1 })
        .lean();
      if (doc) {
        return {
          target: doc.target,
          channel: 'phone',
          purpose: doc.purpose,
          otpHash: doc.otpHash,
          attempts: doc.attempts ?? 0,
          resendAt: doc.resendAt ? new Date(doc.resendAt).getTime() : 0,
          expiresAt: new Date(doc.expiresAt).getTime(),
          consumedAt: doc.consumedAt ? new Date(doc.consumedAt).getTime() : null,
          invalidatedAt: doc.invalidatedAt ? new Date(doc.invalidatedAt).getTime() : null,
        };
      }
    }
    const mem = this.memoryStore.get(phoneE164);
    return mem ? { ...mem } : null;
  }

  private async persistNewChallenge(rec: StoredPhoneOtpChallenge): Promise<void> {
    this.memoryStore.set(rec.target, { ...rec });
    if (isMongoReady()) {
      // Hủy các mã OTP cũ chưa dùng của cùng SĐT trước khi ghi mã mới
      await OtpToken.deleteMany({ channel: 'phone', target: rec.target });
      await OtpToken.create({
        target: rec.target,
        identifier: rec.target,
        channel: 'phone',
        purpose: rec.purpose,
        otpHash: rec.otpHash,
        codeHash: rec.otpHash,
        attempts: 0,
        failedAttempts: 0,
        resendAt: new Date(rec.resendAt),
        expiresAt: new Date(rec.expiresAt),
        consumedAt: null,
        invalidatedAt: null,
        lockedUntil: null,
      });
    }
  }

  private async updateChallengeState(rec: StoredPhoneOtpChallenge): Promise<void> {
    this.memoryStore.set(rec.target, { ...rec });
    if (isMongoReady()) {
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
    }
  }

  /** Gửi mã OTP 6 số thật về SĐT Việt Nam (`+84...`). */
  async sendPhoneOtp(
    rawPhone: string,
    opts?: {
      purpose?: 'login' | 'reset_password' | 'verify_phone';
      now?: number;
      envSource?: NodeJS.ProcessEnv;
    },
  ): Promise<SendPhoneOtpResponse> {
    const parsed = requireVnPhone(rawPhone);
    const now = opts?.now ?? Date.now();
    const purpose = opts?.purpose ?? 'login';
    const envSource = opts?.envSource ?? process.env;

    // 1. Kiểm tra Cooldown 60s & Giới hạn 5 lần/giờ/SĐT
    this.rateLimiter.assertCanSend(parsed.e164, now);

    // Kiểm tra thêm resendAt lưu trong DB (phòng trường hợp đa tiến trình / vừa restart server)
    const existing = await this.loadLatestChallenge(parsed.e164);
    if (existing && existing.resendAt > now) {
      const waitSec = Math.max(1, Math.ceil((existing.resendAt - now) / 1000));
      throw tooMany(`Vui lòng chờ ${waitSec} giây trước khi yêu cầu gửi lại mã OTP.`, 'otp_cooldown');
    }

    // 2. Sinh mã 6 số CSPRNG & băm SHA-256
    const otp = generateSixDigitOtp();
    const otpHash = hashOtpCodeSha256(otp);

    // 3. Gửi qua Multi-Provider SMS Dispatcher (8s timeout)
    const sendResult = await this.smsDispatcher.sendOtp(
      {
        phoneE164: parsed.e164,
        phoneLocal: parsed.local,
        otp,
        ttlMinutes: PHONE_OTP_TTL_MS / 60_000,
        purpose,
      },
      envSource,
    );

    // 4. Chỉ lưu bản ghi OTP và tính lượt gửi sau khi nhà mạng xác nhận gửi thành công
    if (!sendResult.clientSideFirebase) {
      await this.persistNewChallenge({
        target: parsed.e164,
        channel: 'phone',
        purpose,
        otpHash,
        attempts: 0,
        resendAt: now + OTP_COOLDOWN_MS,
        expiresAt: now + PHONE_OTP_TTL_MS,
        consumedAt: null,
        invalidatedAt: null,
      });
    }
    this.rateLimiter.recordSent(parsed.e164, now);

    return {
      channel: 'phone',
      target: parsed.e164,
      targetMasked: parsed.masked,
      resendInSec: OTP_COOLDOWN_MS / 1000,
      expiresInSec: PHONE_OTP_TTL_MS / 1000,
      provider: sendResult.provider,
      ...(sendResult.clientSideFirebase ? { clientSideFirebase: true } : {}),
      ...(sendResult.devOtpPreview ? { devOtpPreview: sendResult.devOtpPreview } : {}),
    };
  }

  /**
   * Xác thực mã OTP 6 số cho SĐT Việt Nam:
   * - Kiểm tra hạn 5 phút, chống dùng lại (`consumedAt`), và hủy mã ngay khi sai đủ/quá 5 lần.
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
        `Mã OTP đã bị hủy do nhập sai quá ${OTP_MAX_VERIFY_ATTEMPTS} lần. Vui lòng yêu cầu gửi mã mới.`,
        'otp_locked',
      );
    }
    if (rec.expiresAt < now) {
      this.memoryStore.delete(parsed.e164);
      if (isMongoReady()) {
        await OtpToken.deleteMany({ channel: 'phone', target: parsed.e164 });
      }
      throw badRequest('Mã OTP đã hết hạn (5 phút). Vui lòng yêu cầu gửi mã mới.', 'otp_expired');
    }

    const candidateHash = hashOtpCodeSha256(otpCode);
    if (!safeEqualHex(rec.otpHash, candidateHash)) {
      rec.attempts += 1;
      if (rec.attempts >= OTP_MAX_VERIFY_ATTEMPTS) {
        rec.invalidatedAt = now;
        await this.updateChallengeState(rec);
        throw tooMany(
          `Nhập sai ${OTP_MAX_VERIFY_ATTEMPTS} lần — mã OTP này đã bị hủy ngay lập tức để bảo vệ tài khoản. Vui lòng yêu cầu mã mới.`,
          'otp_locked',
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

  /** Kiểm tra trạng thái bản ghi OTP trong bộ nhớ/DB (hỗ trợ kiểm thử). */
  async peekChallenge(rawPhone: string): Promise<StoredPhoneOtpChallenge | null> {
    const parsed = requireVnPhone(rawPhone);
    return this.loadLatestChallenge(parsed.e164);
  }

  resetMemory(): void {
    this.memoryStore.clear();
    this.rateLimiter.reset();
  }
}
