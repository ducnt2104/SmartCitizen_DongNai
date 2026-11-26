import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { LRUCache } from 'lru-cache';
import { env } from '../config/env';
import { extractClientMeta } from './auth';

const HOUR = 3600 * 1000;
const FIVE_MIN = 5 * 60 * 1000;
const THREE_MIN = 3 * 60 * 1000;
const ONE_MIN = 60 * 1000;

export function isStrictSecurityActive(req: Request): boolean {
  const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
  if (!isTest) return true;
  return req.headers['x-security-strict'] === '1';
}

export function hybridClientKey(req: Request): string {
  const meta = extractClientMeta(req);
  const userId = req.user?.id ?? 'anon';
  return `${meta.ip || 'ip'}|${meta.deviceHash}|${userId}`;
}

export function ipDeviceKey(req: Request): string {
  const meta = extractClientMeta(req);
  return `${meta.ip || 'ip'}|${meta.deviceHash}`;
}

export interface SlidingWindowRule {
  windowMs: number;
  max: number;
  key: (req: Request) => string;
  code: string;
  message: string;
  /** Nếu true: khi lỗi vượt ngưỡng sẽ áp dụng khóa Exponential Backoff tạm thời. */
  exponentialBackoff?: boolean;
  /** Chỉ áp dụng giới hạn chặt khi !test hoặc có header X-Security-Strict: 1 (giữ tương thích test legacy). */
  strictOnly?: boolean;
}

/**
 * Bộ giới hạn tần suất Sliding-Window lưu trong LRU Cache giới hạn RAM (tối đa 25,000 bucket trên Render).
 * Hỗ trợ theo dõi cặp (IP + deviceHash + userId) và Exponential Backoff chống brute-force / DDoS ứng dụng.
 */
export class SlidingWindowLimiter {
  private readonly hits: LRUCache<string, number[]>;
  private readonly penalties: LRUCache<string, { strikes: number; lockedUntil: number }>;

  constructor(private readonly maxBuckets = 25_000) {
    this.hits = new LRUCache<string, number[]>({
      max: this.maxBuckets,
      ttl: HOUR,
    });
    this.penalties = new LRUCache<string, { strikes: number; lockedUntil: number }>({
      max: 10_000,
      ttl: HOUR,
    });
  }

  checkAndConsume(
    bucketKey: string,
    opts: { windowMs: number; max: number; exponentialBackoff?: boolean; now?: number },
  ): { allowed: boolean; remaining: number; retryAfterSec: number } {
    const now = opts.now ?? Date.now();

    if (opts.exponentialBackoff) {
      const pen = this.penalties.get(bucketKey);
      if (pen && pen.lockedUntil > now) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterSec: Math.max(1, Math.ceil((pen.lockedUntil - now) / 1000)),
        };
      }
    }

    const cutoff = now - opts.windowMs;
    const prev = this.hits.get(bucketKey) ?? [];
    const recent = prev.filter((ts) => ts > cutoff);

    if (recent.length >= opts.max) {
      this.hits.set(bucketKey, recent, { ttl: Math.max(opts.windowMs, 60_000) });
      const oldest = recent[0] ?? now;
      let retryAfterMs = Math.max(1000, oldest + opts.windowMs - now);

      if (opts.exponentialBackoff) {
        const curPen = this.penalties.get(bucketKey);
        const strikes = (curPen?.strikes ?? 0) + 1;
        const backoffMs = Math.min(THREE_MIN, 15_000 * 2 ** Math.min(strikes - 1, 3));
        retryAfterMs = Math.max(retryAfterMs, backoffMs);
        this.penalties.set(bucketKey, { strikes, lockedUntil: now + backoffMs });
      }

      return {
        allowed: false,
        remaining: 0,
        retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
      };
    }

    recent.push(now);
    this.hits.set(bucketKey, recent, { ttl: Math.max(opts.windowMs, 60_000) });
    return {
      allowed: true,
      remaining: Math.max(0, opts.max - recent.length),
      retryAfterSec: 0,
    };
  }

  reset(bucketKey?: string): void {
    if (bucketKey) {
      this.hits.delete(bucketKey);
      this.penalties.delete(bucketKey);
    } else {
      this.hits.clear();
      this.penalties.clear();
    }
  }
}

export const sharedSlidingLimiter = new SlidingWindowLimiter();

function sendRateLimitResponse(res: Response, code: string, message: string, retryAfterSec: number): void {
  const safeRetry = Math.max(1, Math.ceil(retryAfterSec));
  res.setHeader('Retry-After', String(safeRetry));
  res.status(429).json({
    error: {
      code,
      message,
      retryAfter: safeRetry,
      details: { retryAfter: safeRetry, retryAfterSec: safeRetry },
    },
  });
}

function slidingMiddleware(rule: SlidingWindowRule): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (rule.strictOnly && !isStrictSecurityActive(req)) {
      next();
      return;
    }

    const k = `${rule.code}:${rule.key(req)}`;
    const verdict = sharedSlidingLimiter.checkAndConsume(k, {
      windowMs: rule.windowMs,
      max: rule.max,
      exponentialBackoff: rule.exponentialBackoff,
    });

    res.setHeader('X-RateLimit-Limit', String(rule.max));
    res.setHeader('X-RateLimit-Remaining', String(verdict.remaining));

    if (!verdict.allowed) {
      sendRateLimitResponse(res, rule.code, rule.message, verdict.retryAfterSec);
      return;
    }
    next();
  };
}

interface DualActionConfig {
  prefix: string;
  windowMs: number;
  userMax: number;
  ipMax: number;
  testMax: number;
  userMessage: string;
  ipMessage: string;
}

function dualActionMiddleware(cfg: DualActionConfig): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isStrictSecurityActive(req)) {
      const k = `test_burst:${cfg.prefix}:${req.user?.id ?? req.ip ?? 'anon'}`;
      const v = sharedSlidingLimiter.checkAndConsume(k, { windowMs: HOUR, max: cfg.testMax });
      if (!v.allowed) {
        sendRateLimitResponse(res, `${cfg.prefix}_rate_limited`, 'Thao tác quá dày, vui lòng chờ vài giây rồi thử lại.', v.retryAfterSec);
        return;
      }
      next();
      return;
    }

    if (req.user?.id) {
      const userRes = sharedSlidingLimiter.checkAndConsume(`act_u:${cfg.prefix}:${req.user.id}`, {
        windowMs: cfg.windowMs,
        max: cfg.userMax,
      });
      if (!userRes.allowed) {
        sendRateLimitResponse(res, `${cfg.prefix}_user_rate_limited`, cfg.userMessage, userRes.retryAfterSec);
        return;
      }
    }

    const ipRes = sharedSlidingLimiter.checkAndConsume(`act_ip:${cfg.prefix}:${ipDeviceKey(req)}`, {
      windowMs: cfg.windowMs,
      max: cfg.ipMax,
    });
    if (!ipRes.allowed) {
      sendRateLimitResponse(res, `${cfg.prefix}_ip_rate_limited`, cfg.ipMessage, ipRes.retryAfterSec);
      return;
    }

    next();
  };
}

/** Lớp 3: Sliding-Window Rate Limiting đa tầng thân thiện người dùng (ưu tiên tách theo IP + deviceHash + userId, tránh khóa oan CGNAT). */
export const limits = {
  global: slidingMiddleware({
    windowMs: FIVE_MIN,
    max: 2000,
    key: hybridClientKey,
    code: 'rate_limited',
    message: 'Hệ thống đang nhận quá nhiều yêu cầu cùng lúc, vui lòng chờ vài giây rồi thử lại.',
  }),
  /** Endpoint cấp PoW challenge: tách riêng hạn mức cao để không bao giờ gây Double-Penalty */
  challenge: slidingMiddleware({
    windowMs: ONE_MIN,
    max: 300,
    key: ipDeviceKey,
    code: 'challenge_rate_limited',
    message: 'Yêu cầu làm mới xác thực bảo mật quá nhanh, vui lòng chờ vài giây rồi thử lại.',
  }),
  /** API đọc dữ liệu công khai: tối đa 300 req/phút theo (IP + deviceHash + userId) */
  publicRead: slidingMiddleware({
    windowMs: ONE_MIN,
    max: 300,
    key: hybridClientKey,
    code: 'public_read_rate_limited',
    message: 'Tốc độ đọc dữ liệu hơi nhanh. Vui lòng chờ vài giây rồi thử lại.',
    strictOnly: true,
  }),
  /** API Auth / OTP: nới lỏng 30 req / 5 phút theo (IP + deviceHash), không khóa chéo CGNAT */
  otp: slidingMiddleware({
    windowMs: FIVE_MIN,
    max: 30,
    key: ipDeviceKey,
    code: 'otp_rate_limited',
    message: 'Thiết bị của bạn đã gửi quá 30 yêu cầu OTP trong 5 phút. Vui lòng thử lại sau ít phút.',
  }),
  /** Tối đa AI Vision / giờ / thiết bị */
  vision: slidingMiddleware({
    windowMs: HOUR,
    max: env.aiVisionPerHour,
    key: ipDeviceKey,
    code: 'ai_rate_limited',
    message: `Mỗi thiết bị chỉ được phân tích ảnh bằng AI tối đa ${env.aiVisionPerHour} lần mỗi giờ.`,
  }),
  chat: slidingMiddleware({
    windowMs: FIVE_MIN,
    max: 80,
    key: ipDeviceKey,
    code: 'chat_rate_limited',
    message: 'Bạn nhắn quá nhanh, vui lòng chờ một chút rồi gửi tiếp.',
  }),
  /** API gửi phản ánh / tạo cảnh báo: 30 req/5 phút/tài khoản, 60 req/5 phút/thiết bị */
  reportBurst: dualActionMiddleware({
    prefix: 'report',
    windowMs: FIVE_MIN,
    userMax: 30,
    ipMax: 60,
    testMax: 120,
    userMessage: 'Tài khoản đã gửi quá 30 phản ánh trong 5 phút. Vui lòng chờ giây lát rồi thử lại.',
    ipMessage: 'Thiết bị đã gửi quá 60 phản ánh trong 5 phút. Vui lòng chờ giây lát rồi thử lại.',
  }),
  /** API xác nhận phản ánh / cảnh báo: 60 req/5 phút/tài khoản, 120 req/5 phút/thiết bị */
  confirm: dualActionMiddleware({
    prefix: 'confirm',
    windowMs: FIVE_MIN,
    userMax: 60,
    ipMax: 120,
    testMax: 240,
    userMessage: 'Bạn đã xác nhận quá 60 lần trong 5 phút. Vui lòng chờ giây lát rồi thử lại.',
    ipMessage: 'Thiết bị đã gửi quá 120 lượt xác nhận trong 5 phút. Vui lòng chờ giây lát rồi thử lại.',
  }),
  login: slidingMiddleware({
    windowMs: FIVE_MIN,
    max: 80,
    key: ipDeviceKey,
    code: 'login_rate_limited',
    message: 'Bạn thao tác đăng nhập hơi nhanh từ thiết bị này, vui lòng chờ giây lát rồi thử lại.',
  }),
};
