import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { Role } from '../../../shared/types';
import type { UserRecord } from '../repositories/types';
import type { Services } from '../services/container';
import { forbidden, unauthorized } from '../utils/errors';

declare module 'express-serve-static-core' {
  interface Request {
    user?: UserRecord;
  }
}

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

function bearer(req: Request): string | null {
  const h = req.headers.authorization;
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice(7).trim() || null;
}

/** Lớp 2: JWT HMAC + nạp lại người dùng từ DB để quyền/điểm tín nhiệm luôn mới nhất. */
export function authMiddleware(s: Services) {
  const optional: RequestHandler = asyncHandler(async (req, _res, next) => {
    const token = bearer(req);
    if (token) {
      const claims = s.auth.verifyToken(token);
      req.user = await s.auth.me(claims.sub);
    }
    next();
  });

  const required: RequestHandler = asyncHandler(async (req, _res, next) => {
    const token = bearer(req);
    if (!token) throw unauthorized();
    const claims = s.auth.verifyToken(token);
    req.user = await s.auth.me(claims.sub);
    next();
  });

  const requireRole = (...roles: Role[]): RequestHandler[] => [
    required,
    (req: Request, _res: Response, next: NextFunction) => {
      if (!req.user || !roles.includes(req.user.role)) return next(forbidden());
      next();
    },
  ];

  return { optional, required, requireRole };
}
