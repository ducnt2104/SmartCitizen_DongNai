import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { normalizeRole } from '../shared/constants';
import type { Role } from '../shared/types';
import { env } from '../config/env';
import type { UserRecord } from '../repositories/types';
import type { Services } from '../services/container';
import { sha256 } from '../utils/crypto';
import { forbidden, unauthorized } from '../utils/errors';

declare module 'express-serve-static-core' {
  interface Request {
    user?: UserRecord;
    sessionId?: string;
    tokenVersion?: number;
  }
}

export function normalizeClientIp(req: Request): string {
  const rawIp = (req.ip || req.socket?.remoteAddress || '').trim();
  const clean = rawIp.startsWith('::ffff:') ? rawIp.slice(7) : rawIp;
  return clean.slice(0, 64);
}

export function extractClientMeta(req: Request): {
  userAgent: string;
  ip: string;
  deviceFingerprint: string;
  deviceHash: string;
} {
  const fp = req.headers['x-device-fp'];
  const deviceFingerprint = typeof fp === 'string' && fp.trim() ? fp.trim().slice(0, 64) : 'web-browser';
  const ip = normalizeClientIp(req);
  const userAgent = (req.get('user-agent') ?? '').slice(0, 180);
  const deviceHash = sha256(`${userAgent}|${deviceFingerprint}`).slice(0, 24);
  return { userAgent, ip, deviceFingerprint, deviceHash };
}

export const ACCESS_COOKIE = 'sc_access';
export const REFRESH_COOKIE = 'sc_refresh';

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

/** Parse giá trị cookie từ header `Cookie` (nhẹ, không cần thêm middleware ngoài). */
export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim());
      } catch {
        return part.slice(idx + 1).trim();
      }
    }
  }
  return null;
}

/** Ghi cặp HTTP-only Cookie an toàn cho Access Token (15m) & Refresh Token (rotation, SameSite=Strict). */
export function setAuthCookies(res: Response, accessToken: string, refreshToken: string, refreshMaxAgeMs: number): void {
  const secure = env.cookieSecure;
  res.cookie(ACCESS_COOKIE, accessToken, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: '/',
    maxAge: 15 * 60 * 1000,
  });
  res.cookie(REFRESH_COOKIE, refreshToken, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: '/api/auth',
    maxAge: refreshMaxAgeMs,
  });
}

export function clearAuthCookies(res: Response): void {
  const secure = env.cookieSecure;
  res.clearCookie(ACCESS_COOKIE, { httpOnly: true, secure, sameSite: 'strict', path: '/' });
  res.clearCookie(REFRESH_COOKIE, { httpOnly: true, secure, sameSite: 'strict', path: '/api/auth' });
}

function extractAccessToken(req: Request): string | null {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) {
    const t = h.slice(7).trim();
    if (t) return t;
  }
  return readCookie(req, ACCESS_COOKIE);
}

/** Lớp 2: JWT HMAC + kiểm tra Strict Single-Session (sessionId + tokenVersion trong DB/LRU Cache). */
export function authMiddleware(s: Services) {
  const optional: RequestHandler = asyncHandler(async (req, _res, next) => {
    const token = extractAccessToken(req);
    if (token) {
      try {
        const verified = await s.auth.authenticateToken(token, { ip: req.ip ?? '' });
        req.user = verified.user;
        req.sessionId = verified.sessionId;
        req.tokenVersion = verified.tokenVersion;
      } catch {
        // Token hết hạn hoặc đã thay thế trên route optional: bỏ qua, coi như khách vãng lai
      }
    }
    next();
  });

  const required: RequestHandler = asyncHandler(async (req, _res, next) => {
    const token = extractAccessToken(req);
    if (!token) throw unauthorized();
    const verified = await s.auth.authenticateToken(token, { ip: req.ip ?? '' });
    req.user = verified.user;
    req.sessionId = verified.sessionId;
    req.tokenVersion = verified.tokenVersion;
    next();
  });

  const requireRole = (...roles: Role[]): RequestHandler[] => [
    required,
    asyncHandler(async (req: Request, _res: Response, next: NextFunction) => {
      if (!req.user || !req.sessionId) return next(forbidden());
      const [freshUser, freshSession] = await Promise.all([
        s.repos.users.get(req.user.id),
        s.repos.sessions.get(req.sessionId),
      ]);
      if (!freshUser || freshUser.revoked) {
        return next(unauthorized('Tài khoản không tồn tại hoặc đã bị thu hồi quyền truy cập.', 'SESSION_REVOKED'));
      }
      if (
        !freshSession ||
        freshSession.isRevoked ||
        freshSession.revokedAt !== null ||
        freshSession.expiresAt <= Date.now()
      ) {
        return next(unauthorized('Phiên làm việc đã hết hạn hoặc bị thu hồi.', 'SESSION_REVOKED'));
      }
      req.user = freshUser;
      if (!roles.includes(normalizeRole(freshUser.role))) return next(forbidden());
      next();
    }),
  ];

  const requireReauth: RequestHandler = asyncHandler(async (req, _res, next) => {
    if (!req.user || !req.sessionId) throw unauthorized();
    const body = (req.body ?? {}) as Record<string, unknown>;
    await s.auth.verifyReauth(req.user, req.sessionId, {
      reauthToken: typeof req.headers['x-reauth-token'] === 'string' ? req.headers['x-reauth-token'] : undefined,
      currentPassword:
        typeof req.headers['x-reauth-password'] === 'string'
          ? req.headers['x-reauth-password']
          : typeof body.reauthPassword === 'string'
            ? body.reauthPassword
            : typeof body.currentPassword === 'string'
              ? body.currentPassword
              : undefined,
    });
    next();
  });

  return { optional, required, requireRole, requireReauth };
}
