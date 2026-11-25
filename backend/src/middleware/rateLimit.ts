import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { LRUCache } from 'lru-cache';
import { env } from '../config/env';
import { extractClientMeta } from './auth';

const HOUR = 3600 * 1000;
const TEN_MIN = 10 * 60 * 1000;
const FIFTEEN_MIN = 15 * 60 * 1000;
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
        const backoffMs = Math.min(FIFTEEN_MIN, 30_000 * 2 ** Math.min(strikes - 1, 5));
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
      res.setHeader('Retry-After', String(verdict.retryAfterSec));
      res.status(429).json({
        error: {
          code: rule.code,
          message: rule.message,
          details: { retryAfterSec: verdict.retryAfterSec },
        },
      });
      return;
    }
    next();
  };
}

function dualReportActionMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!isStrictSecurityActive(req)) {
      // Giữ giới hạn burst nhẹ trong suite test mặc định khi không bật X-Security-Strict
      const k = `test_burst:${req.user?.id ?? req.ip ?? 'anon'}`;
      const v = sharedSlidingLimiter.checkAndConsume(k, { windowMs: HOUR, max: 40 });
      if (!v.allowed) {
        res.status(429).json({ error: { code: 'report_rate_limited', message: 'Thao tác quá dày, vui lòng thử lại sau.' } });
        return;
      }
      next();
      return;
    }

    // Production & Strict Security Mode:
    // 1) Tối đa 5 req / 10 phút / tài khoản (userId)
    if (req.user?.id) {
      const userRes = sharedSlidingLimiter.checkAndConsume(`act_u:${req.user.id}`, {
        windowMs: TEN_MIN,
        max: 5,
      });
      if (!userRes.allowed) {
        res.setHeader('Retry-After', String(userRes.retryAfterSec));
        res.status(429).json({
          error: {
            code: 'report_user_rate_limited',
            message: 'Tài khoản đã gửi quá 5 phản ánh/xác nhận trong 10 phút. Vui lòng chờ giây lát.',
            details: { retryAfterSec: userRes.retryAfterSec },
          },
        });
        return;
      }
    }

    // 2) Tối đa 10 req / 10 phút / IP + deviceHash
    const ipRes = sharedSlidingLimiter.checkAndConsume(`act_ip:${ipDeviceKey(req)}`, {
      windowMs: TEN_MIN,
      max: 10,
      exponentialBackoff: true,
    });
    if (!ipRes.allowed) {
      res.setHeader('Retry-After', String(ipRes.retryAfterSec));
      res.status(429).json({
        error: {
          code: 'report_ip_rate_limited',
          message: 'Thiết bị/IP đã gửi quá 10 thao tác trong 10 phút. Vui lòng thử lại sau.',
          details: { retryAfterSec: ipRes.retryAfterSec },
        },
      });
      return;
    }

    next();
  };
}

/** Lớp 3: Sliding-Window Rate Limiting đa tầng theo cặp (IP + deviceHash + userId). */
export const limits = {
  global: slidingMiddleware({
    windowMs: 15 * ONE_MIN,
    max: 600,
    key: hybridClientKey,
    code: 'rate_limited',
    message: 'Quá nhiều yêu cầu, vui lòng thử lại sau ít phút.',
  }),
  /** API đọc dữ liệu công khai: tối đa 120 req/phút theo (IP + deviceHash + userId) */
  publicRead: slidingMiddleware({
    windowMs: ONE_MIN,
    max: 120,
    key: hybridClientKey,
    code: 'public_read_rate_limited',
    message: 'Tốc độ đọc dữ liệu vượt quá 120 yêu cầu/phút. Vui lòng chậm lại.',
    strictOnly: true,
  }),
  /** API Auth / OTP: tối đa 5 req / 15 phút + Exponential Backoff */
  otp: slidingMiddleware({
    windowMs: FIFTEEN_MIN,
    max: 5,
    key: (r) => extractClientMeta(r).ip || 'ip',
    code: 'otp_rate_limited',
    message: 'IP của bạn đã yêu cầu OTP quá 5 lần trong 15 phút. Vui lòng thử lại sau.',
    exponentialBackoff: true,
  }),
  /** Tối đa 10 lần gọi AI Vision / giờ / thiết bị */
  vision: slidingMiddleware({
    windowMs: HOUR,
    max: env.aiVisionPerHour,
    key: ipDeviceKey,
    code: 'ai_rate_limited',
    message: `Mỗi thiết bị chỉ được phân tích ảnh bằng AI tối đa ${env.aiVisionPerHour} lần mỗi giờ.`,
  }),
  chat: slidingMiddleware({
    windowMs: TEN_MIN,
    max: 40,
    key: ipDeviceKey,
    code: 'chat_rate_limited',
    message: 'Bạn nhắn quá nhanh, vui lòng chờ một chút.',
  }),
  /** API gửi phản ánh / tạo hoặc xác nhận cảnh báo: 5 req/10 phút/tài khoản, 10 req/10 phút/IP+device */
  reportBurst: dualReportActionMiddleware(),
  confirm: dualReportActionMiddleware(),
  login: slidingMiddleware({
    windowMs: FIFTEEN_MIN,
    max: 30,
    key: ipDeviceKey,
    code: 'login_rate_limited',
    message: 'Quá nhiều lần đăng nhập từ thiết bị/IP này, vui lòng thử lại sau.',
  }),
};
