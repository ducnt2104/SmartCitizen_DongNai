import type { Request, RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env';

const HOUR = 3600 * 1000;

function deviceKey(req: Request): string {
  const fp = req.headers['x-device-fp'];
  const f = typeof fp === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(fp) ? fp : 'nofp';
  return `${req.ip ?? 'ip'}|${f}`;
}

function limiter(opts: { windowMs: number; max: number; key: (req: Request) => string; code: string; message: string }): RequestHandler {
  return rateLimit({
    windowMs: opts.windowMs,
    limit: opts.max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: opts.key,
    validate: false,
    handler: (_req, res) => {
      res.status(429).json({ error: { code: opts.code, message: opts.message } });
    },
  });
}

/** Lớp 3: Rate limiting đa tầng theo IP + SĐT + deviceFingerprint. */
export const limits = {
  global: limiter({
    windowMs: 15 * 60 * 1000, max: 600, key: (r) => r.ip ?? 'ip', code: 'rate_limited',
    message: 'Quá nhiều yêu cầu, vui lòng thử lại sau ít phút.',
  }),
  otp: limiter({
    windowMs: HOUR, max: 10,
    key: (r) => `${r.ip ?? 'ip'}|${String((r.body as { phone?: string } | undefined)?.phone ?? '')}`,
    code: 'otp_rate_limited', message: 'Bạn yêu cầu OTP quá nhiều lần. Thử lại sau 1 giờ.',
  }),
  /** Tối đa 10 lần gọi AI Vision / giờ / thiết bị */
  vision: limiter({
    windowMs: HOUR, max: env.aiVisionPerHour, key: deviceKey, code: 'ai_rate_limited',
    message: `Mỗi thiết bị chỉ được phân tích ảnh bằng AI tối đa ${env.aiVisionPerHour} lần mỗi giờ.`,
  }),
  chat: limiter({
    windowMs: 10 * 60 * 1000, max: 40, key: deviceKey, code: 'chat_rate_limited',
    message: 'Bạn nhắn quá nhanh, vui lòng chờ một chút.',
  }),
  /** Chốt chặn thô theo người dùng; giới hạn 3 phản ánh/giờ/SĐT được thực thi chính xác trong ReportService. */
  reportBurst: limiter({
    windowMs: HOUR, max: 40, key: (r) => `${r.user?.id ?? r.ip ?? 'anon'}`, code: 'report_rate_limited',
    message: 'Thao tác quá dày, vui lòng thử lại sau.',
  }),
  confirm: limiter({
    windowMs: HOUR, max: 60, key: (r) => `${r.user?.id ?? r.ip ?? 'anon'}`, code: 'confirm_rate_limited',
    message: 'Bạn bấm "Cùng xác nhận" quá nhiều lần, vui lòng thử lại sau.',
  }),
  login: limiter({
    windowMs: 15 * 60 * 1000, max: 30, key: (r) => r.ip ?? 'ip', code: 'login_rate_limited',
    message: 'Quá nhiều lần đăng nhập, vui lòng thử lại sau.',
  }),
};
