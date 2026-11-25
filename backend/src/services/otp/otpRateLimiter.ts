import { tooMany } from '../../utils/errors';

export const OTP_COOLDOWN_MS = 60 * 1000;
export const OTP_SEND_WINDOW_MS = 10 * 60 * 1000;
export const OTP_MAX_SENDS_PER_WINDOW = 3;
export const OTP_HOURLY_WINDOW_MS = OTP_SEND_WINDOW_MS;
export const OTP_MAX_SENDS_PER_HOUR = OTP_MAX_SENDS_PER_WINDOW;
export const OTP_MAX_VERIFY_ATTEMPTS = 5;

interface TargetQuotaBucket {
  lastSentAt: number;
  sendTimestamps: number[];
}

/**
 * Bộ giới hạn tần suất gửi OTP chống spam (SMS Pumping / Bombing Protection):
 * - Cooldown cứng 60 giây giữa 2 lần gửi liên tiếp cho cùng 1 SĐT / Email.
 * - Tối đa 3 lần gửi / 10 phút (cửa sổ trượt 600s) trên mỗi SĐT / Email.
 * - Hỗ trợ truyền `now` tùy chỉnh để kiểm thử đơn vị (deterministic unit test) chính xác từng mili-giây.
 */
export class OtpSendRateLimiter {
  private readonly buckets = new Map<string, TargetQuotaBucket>();

  constructor(
    private readonly cooldownMs = OTP_COOLDOWN_MS,
    private readonly maxPerWindow = OTP_MAX_SENDS_PER_WINDOW,
    private readonly windowMs = OTP_SEND_WINDOW_MS,
  ) {}

  /** Kiểm tra hạn mức trước khi gọi nhà mạng SMS (không ghi nhận nếu gửi thất bại). */
  assertCanSend(target: string, now = Date.now()): void {
    const key = target.trim().toLowerCase();
    const bucket = this.buckets.get(key);
    if (!bucket) return;

    const cutoff = now - this.windowMs;
    const recent = bucket.sendTimestamps.filter((ts) => ts > cutoff);
    bucket.sendTimestamps = recent;

    const elapsedSinceLast = now - bucket.lastSentAt;
    if (bucket.lastSentAt > 0 && elapsedSinceLast < this.cooldownMs) {
      const waitSec = Math.max(1, Math.ceil((this.cooldownMs - elapsedSinceLast) / 1000));
      throw tooMany(
        `Vui lòng chờ ${waitSec} giây trước khi yêu cầu gửi lại mã OTP.`,
        'otp_cooldown',
      );
    }

    if (recent.length >= this.maxPerWindow) {
      const oldestInWindow = recent[0] ?? now;
      const waitMin = Math.max(1, Math.ceil((oldestInWindow + this.windowMs - now) / 60_000));
      throw tooMany(
        `Số điện thoại này đã nhận tối đa ${this.maxPerWindow} mã OTP trong 10 phút. Vui lòng thử lại sau khoảng ${waitMin} phút.`,
        'otp_rate_limit_10m',
      );
    }
  }

  /** Ghi nhận 1 lần phát SMS thành công vào cửa sổ hạn mức của SĐT. */
  recordSent(target: string, now = Date.now()): { remainingInWindow: number; resendInSec: number } {
    const key = target.trim().toLowerCase();
    const cutoff = now - this.windowMs;
    const existing = this.buckets.get(key);
    const recent = existing ? existing.sendTimestamps.filter((ts) => ts > cutoff) : [];
    recent.push(now);

    this.buckets.set(key, {
      lastSentAt: now,
      sendTimestamps: recent,
    });

    return {
      remainingInWindow: Math.max(0, this.maxPerWindow - recent.length),
      resendInSec: Math.round(this.cooldownMs / 1000),
    };
  }

  /** Xóa trạng thái hạn mức (phục vụ cô lập giữa các ca unit test). */
  reset(target?: string): void {
    if (target) {
      this.buckets.delete(target.trim().toLowerCase());
    } else {
      this.buckets.clear();
    }
  }
}
