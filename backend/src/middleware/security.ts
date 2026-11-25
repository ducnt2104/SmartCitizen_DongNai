import crypto from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { LRUCache } from 'lru-cache';
import { env } from '../config/env';
import type { Services } from '../services/container';
import { hmacSha256, newId, safeEqualHex } from '../utils/crypto';
import { forbidden, tooMany } from '../utils/errors';
import { extractClientMeta } from './auth';
import { isStrictSecurityActive } from './rateLimit';

export const POW_CHALLENGE_TTL_MS = 2 * 60 * 1000; // Hết hạn sau 2 phút
export const POW_DIFFICULTY_BITS = 13; // ~8.192 lần thử SHA-256 (~100-250ms trên trình duyệt)
export const MIN_FORM_FILL_MS = 1500; // Submit nhanh hơn 1.5s -> nghi bot

const HONEYPOT_FIELD_NAMES = ['website', 'hp_field', 'hp_email', 'companyUrl', '_hp'] as const;

/** Lưu các challengeId đã sử dụng trong 2.5 phút để chống Replay Attack 100% */
const consumedPowChallenges = new LRUCache<string, true>({
  max: 50_000,
  ttl: POW_CHALLENGE_TTL_MS + 30_000,
});

export interface PowChallengePayload {
  challengeId: string;
  nonce: string;
  expiresAt: number;
  difficultyBits: number;
  signature: string;
}

function signPowChallenge(
  challengeId: string,
  nonce: string,
  expiresAt: number,
  difficultyBits: number,
  ip: string,
): string {
  return hmacSha256(env.jwtSecret, `pow:${challengeId}:${nonce}:${expiresAt}:${difficultyBits}:${ip}`);
}

export function hasLeadingZeroBits(digest: Buffer, bits: number): boolean {
  const fullBytes = Math.floor(bits / 8);
  const remBits = bits % 8;
  for (let i = 0; i < fullBytes; i++) {
    if (digest[i] !== 0) return false;
  }
  if (remBits > 0) {
    const mask = (0xff << (8 - remBits)) & 0xff;
    if ((digest[fullBytes] & mask) !== 0) return false;
  }
  return true;
}

/** Helper giải PoW dùng trong test hoặc CLI hợp lệ. */
export function solvePowChallenge(challenge: PowChallengePayload): string {
  for (let counter = 0; counter < 2_000_000; counter++) {
    const digest = crypto.createHash('sha256').update(`${challenge.nonce}:${counter}`).digest();
    if (hasLeadingZeroBits(digest, challenge.difficultyBits)) {
      return `${challenge.challengeId}.${challenge.nonce}.${challenge.expiresAt}.${challenge.difficultyBits}.${challenge.signature}.${counter}`;
    }
  }
  throw new Error('Không thể giải thử thách PoW trong giới hạn vòng lặp.');
}

/**
 * `GET /api/security/challenge`: Cấp thử thách Proof-of-Work nhẹ (hết hạn sau 2 phút, ký HMAC).
 */
export function issuePowChallengeHandler(req: Request, res: Response): void {
  const meta = extractClientMeta(req);
  const challengeId = newId('pow');
  const nonce = crypto.randomBytes(16).toString('hex');
  const expiresAt = Date.now() + POW_CHALLENGE_TTL_MS;
  const difficultyBits = POW_DIFFICULTY_BITS;
  const signature = signPowChallenge(challengeId, nonce, expiresAt, difficultyBits, meta.ip);

  res.setHeader('Cache-Control', 'no-store');
  res.json({
    challengeId,
    nonce,
    expiresAt,
    difficultyBits,
    signature,
  } satisfies PowChallengePayload);
}

export function verifyPowHeaderValue(
  rawHeader: string,
  clientIp: string,
): { ok: true; challengeId: string } | { ok: false; code: string; message: string } {
  const parts = rawHeader.trim().split('.');
  if (parts.length !== 6) {
    return { ok: false, code: 'pow_malformed', message: 'Header X-PoW-Solution không đúng định dạng.' };
  }

  const [challengeId, nonce, expRaw, diffRaw, signature, counterRaw] = parts;
  const expiresAt = Number(expRaw);
  const difficultyBits = Number(diffRaw);

  if (
    !/^pow_[a-zA-Z0-9_-]{8,40}$/.test(challengeId) ||
    !/^[a-f0-9]{16,64}$/i.test(nonce) ||
    !Number.isSafeInteger(expiresAt) ||
    !Number.isSafeInteger(difficultyBits) ||
    difficultyBits < POW_DIFFICULTY_BITS ||
    difficultyBits > 24 ||
    !/^\d{1,10}$/.test(counterRaw)
  ) {
    return { ok: false, code: 'pow_invalid', message: 'Thử thách xác thực trình duyệt không hợp lệ.' };
  }

  if (Date.now() > expiresAt) {
    return { ok: false, code: 'pow_expired', message: 'Thử thách bảo mật đã hết hạn (quá 2 phút), vui lòng thử lại.' };
  }

  const expectedSig = signPowChallenge(challengeId, nonce, expiresAt, difficultyBits, clientIp);
  if (!safeEqualHex(signature.toLowerCase(), expectedSig)) {
    return { ok: false, code: 'pow_invalid_signature', message: 'Chữ ký thử thách bảo mật không hợp lệ.' };
  }

  if (consumedPowChallenges.has(challengeId)) {
    return { ok: false, code: 'pow_replayed', message: 'Mã thử thách bảo mật đã được sử dụng.' };
  }

  const digest = crypto.createHash('sha256').update(`${nonce}:${counterRaw}`).digest();
  if (!hasLeadingZeroBits(digest, difficultyBits)) {
    return { ok: false, code: 'pow_unsolved', message: 'Lời giải Proof-of-Work chưa đạt độ khó yêu cầu.' };
  }

  consumedPowChallenges.set(challengeId, true);
  return { ok: true, challengeId };
}

export function securityMiddleware(s: Services) {
  const logSuspectedBot = (req: Request, action: string, reason: string, extra?: Record<string, unknown>): void => {
    const meta = extractClientMeta(req);
    void s.securityAudit
      .log({
        actorId: req.user?.id ?? 'anonymous',
        actorName: req.user?.name ?? 'Khách / Bot nghi vấn',
        actorRole: req.user?.role ?? 'anonymous',
        action,
        targetType: 'security_gate',
        targetId: req.originalUrl.slice(0, 120),
        ip: meta.ip,
        deviceHash: meta.deviceHash,
        userAgent: meta.userAgent,
        afterState: { reason, ...extra },
      })
      .catch(() => undefined);
  };

  /** Bắt buộc giải thử thách Proof-of-Work (SHA-256) với header `X-PoW-Solution`. */
  const requirePow: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
    const header = req.headers['x-pow-solution'];
    const hasHeader = typeof header === 'string' && header.trim().length > 0;
    const strict = isStrictSecurityActive(req) || req.headers['x-require-pow'] === '1';

    if (!hasHeader) {
      if (!strict) {
        next();
        return;
      }
      logSuspectedBot(req, 'bot.pow_missing', 'Thiếu header X-PoW-Solution');
      next(forbidden('Yêu cầu xác thực trình duyệt (Proof-of-Work) trước khi gửi dữ liệu.', 'pow_required'));
      return;
    }

    const meta = extractClientMeta(req);
    const verdict = verifyPowHeaderValue(header, meta.ip);
    if (!verdict.ok) {
      logSuspectedBot(req, `bot.${verdict.code}`, verdict.message);
      next(forbidden(verdict.message, verdict.code));
      return;
    }

    next();
  };

  /**
   * Honeypot & Timing Trap:
   * - Nếu trường ẩn (website, hp_field, hp_email, companyUrl, _hp) có dữ liệu -> chặn bot ngay.
   * - Nếu thời gian điền form (`Date.now() - formLoadedAt < 1500ms`) -> chặn bot gửi quá nhanh.
   * - Xóa sạch các trường bẫy khỏi `req.body` trước khi qua Zod validation.
   */
  const botTrapCheck: RequestHandler = (req: Request, _res: Response, next: NextFunction) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      next();
      return;
    }

    const body = req.body as Record<string, unknown>;
    for (const hpKey of HONEYPOT_FIELD_NAMES) {
      const val = body[hpKey];
      if (typeof val === 'string' && val.trim().length > 0) {
        logSuspectedBot(req, 'bot.honeypot_triggered', `Honeypot "${hpKey}" bị điền tự động`, { field: hpKey });
        next(forbidden('Hệ thống phát hiện hành vi gửi tự động bất thường.', 'bot_honeypot_triggered'));
        return;
      }
      if (hpKey in body) delete body[hpKey];
    }

    const rawLoadedAt = body.formLoadedAt;
    if ('formLoadedAt' in body) delete body.formLoadedAt;

    const strict = isStrictSecurityActive(req);
    if (rawLoadedAt !== undefined && rawLoadedAt !== null && rawLoadedAt !== '') {
      const loadedAt = Number(rawLoadedAt);
      const elapsedMs = Date.now() - loadedAt;
      if (!Number.isFinite(loadedAt) || elapsedMs < MIN_FORM_FILL_MS || loadedAt > Date.now() + 60_000) {
        logSuspectedBot(req, 'bot.timing_trap_triggered', 'Submit quá nhanh dưới 1.5s hoặc sai mốc thời gian', {
          elapsedMs: Number.isFinite(elapsedMs) ? elapsedMs : null,
        });
        next(tooMany('Thao tác gửi quá nhanh. Vui lòng kiểm tra lại thông tin và thử lại sau giây lát.', 'bot_too_fast'));
        return;
      }
    } else if (strict && req.headers['x-require-timing'] === '1') {
      logSuspectedBot(req, 'bot.missing_form_timing', 'Thiếu formLoadedAt trong chế độ kiểm tra chặt');
      next(forbidden('Thiếu thông số phiên biểu mẫu hợp lệ.', 'bot_timing_required'));
      return;
    }

    next();
  };

  return { requirePow, botTrapCheck, logSuspectedBot };
}
