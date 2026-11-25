import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { HttpError, badRequest } from '../utils/errors';
import { hasMongoOperators, stripMongoOperators } from '../utils/sanitize';

/** Chống NoSQL Injection: loại key `$...` / chứa `.` khỏi body, query, params ở mọi cấp. */
export const sanitizeInput: RequestHandler = (req, _res, next) => {
  if (hasMongoOperators(req.body) || hasMongoOperators(req.query)) {
    return next(badRequest('Dữ liệu chứa ký tự không được phép ($ hoặc .) trong tên trường.', 'forbidden_characters'));
  }
  req.body = stripMongoOperators(req.body);
  next();
};

/** Validate 100% payload bằng Zod. Kết quả đã parse được gắn vào req.body. */
export const validateBody =
  <T extends ZodTypeAny>(schema: T): RequestHandler =>
  (req, _res, next) => {
    const r = schema.safeParse(req.body);
    if (!r.success) return next(r.error);
    req.body = r.data as z.infer<T>;
    next();
  };

const SENSITIVE_INFRA_RE =
  /(MongoServerSelectionError|MongooseServerSelectionError|MongoNetworkError|NETWORK_OR_IP_WHITELIST|mongodb\.com\/docs|querySrv|ECONNREFUSED|ETIMEDOUT|mongodb(?:\+srv)?:\/\/|INITIAL_STAFF_PASSWORD)/i;

function sanitizeClientErrorMessage(rawMessage: string, status: number): string {
  if (status >= 500 || SENSITIVE_INFRA_RE.test(rawMessage)) {
    return 'Hệ thống đang tạm gián đoạn kết nối, vui lòng thử lại sau giây lát.';
  }
  return rawMessage;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  void _next;
  if (res.headersSent) {
    res.end();
    return;
  }
  if (err instanceof HttpError) {
    if (err.status >= 500 || SENSITIVE_INFRA_RE.test(err.message)) {
      console.error(`[http-error ${err.status}] code=${err.code} msg=${err.message}`, err.details ?? '');
    }
    const safeMsg =
      err.code === 'otp_provider_not_configured' || err.code === 'sms_provider_not_configured'
        ? err.message
        : sanitizeClientErrorMessage(err.message, err.status);
    const safeDetails = err.status >= 500 ? undefined : err.details;
    res.status(err.status).json({
      error: {
        code: err.code,
        message: safeMsg,
        ...(safeDetails !== undefined ? { details: safeDetails } : {}),
      },
    });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'validation_error',
        message: 'Dữ liệu gửi lên không hợp lệ.',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    });
    return;
  }
  const e = err as { type?: string; status?: number };
  if (e?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'payload_too_large', message: 'Dữ liệu quá lớn (ảnh vượt giới hạn).' } });
    return;
  }
  if (e?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'invalid_json', message: 'Dữ liệu gửi lên không đúng định dạng.' } });
    return;
  }
  console.error('[error]', err);
  res.status(500).json({
    error: {
      code: 'internal_error',
      message: 'Hệ thống đang tạm gián đoạn kết nối, vui lòng thử lại sau giây lát.',
    },
  });
}
