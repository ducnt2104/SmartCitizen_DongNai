import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler, extractClientMeta, setAuthCookies } from '../middleware/auth';
import { limits } from '../middleware/rateLimit';
import { securityMiddleware } from '../middleware/security';
import { validateBody } from '../middleware/validate';
import type { Services } from '../services/container';
import { parseVnPhone } from '../services/otp';
import type { OtpPurpose } from '../services/otpDelivery.service';
import { badRequest } from '../utils/errors';

const wardCodeSchema = z.string().regex(/^DN-[A-Z]{2,4}$/);

export const phoneAuthSchemas = {
  otpSend: z
    .object({
      channel: z.enum(['phone', 'email', 'sms']).optional(),
      phone: z.string().min(3).max(40).optional(),
      email: z.string().min(5).max(120).optional(),
      target: z.string().min(3).max(120).optional(),
      identifier: z.string().min(3).max(120).optional(),
      purpose: z.enum(['login', 'reset_password', 'verify_phone', 'change_email', 'change_phone']).default('login'),
      preferDirectSms: z.boolean().optional(),
    })
    .refine(
      (d) => Boolean(d.phone || d.email || d.target || d.identifier),
      'Vui lòng cung cấp số điện thoại (+84/09...) hoặc địa chỉ Email.',
    ),

  otpVerify: z
    .object({
      channel: z.enum(['phone', 'email', 'sms']).optional(),
      phone: z.string().min(3).max(40).optional(),
      email: z.string().min(5).max(120).optional(),
      target: z.string().min(3).max(120).optional(),
      identifier: z.string().min(3).max(120).optional(),
      code: z.string().regex(/^\d{6}$/, 'Mã OTP gồm đúng 6 chữ số').optional(),
      otp: z.string().regex(/^\d{6}$/, 'Mã OTP gồm đúng 6 chữ số').optional(),
      name: z.string().min(2).max(80).optional(),
      password: z.string().min(8).max(128).optional(),
      defaultWardCode: wardCodeSchema.optional(),
    })
    .refine(
      (d) => Boolean(d.phone || d.email || d.target || d.identifier),
      'Vui lòng cung cấp số điện thoại hoặc địa chỉ Email.',
    )
    .refine((d) => Boolean(d.code || d.otp), 'Vui lòng nhập mã OTP gồm 6 chữ số.'),

  verifyFirebase: z
    .object({
      firebaseIdToken: z.string().min(20).max(8192).optional(),
      idToken: z.string().min(20).max(8192).optional(),
      name: z.string().min(2).max(80).optional(),
      password: z.string().min(8).max(128).optional(),
      defaultWardCode: wardCodeSchema.optional(),
    })
    .refine((d) => Boolean(d.firebaseIdToken || d.idToken), 'Thiếu firebaseIdToken từ Firebase Phone Auth.'),
} as const;

function detectIsEmailChannel(input: {
  channel?: 'phone' | 'email' | 'sms';
  phone?: string;
  email?: string;
  target?: string;
  identifier?: string;
}): { isEmail: boolean; rawTarget: string } {
  if (input.channel === 'email' || (input.email && !input.phone)) {
    const rawTarget = (input.email ?? input.target ?? input.identifier ?? '').trim();
    return { isEmail: true, rawTarget };
  }
  if (input.channel === 'phone' || input.channel === 'sms' || input.phone) {
    const rawTarget = (input.phone ?? input.target ?? input.identifier ?? '').trim();
    return { isEmail: false, rawTarget };
  }
  const rawTarget = (input.target ?? input.identifier ?? '').trim();
  return { isEmail: rawTarget.includes('@'), rawTarget };
}

/**
 * Router Xác thực OTP Đa kênh (Email + Phone SMS +84 + Firebase Phone Auth):
 * - `GET  /api/auth/otp/status`
 * - `POST /api/auth/otp/send`
 * - `POST /api/auth/otp/verify`
 * - `POST /api/auth/otp/verify-firebase`
 * Giữ nguyên 100% tương thích ngược với luồng OTP Email hiện có.
 */
export function buildAuthRouter(s: Services): Router {
  const router = Router();
  const h = asyncHandler;
  const sec = securityMiddleware(s);

  router.get(
    '/otp/status',
    h(async (_req: Request, res: Response) => {
      const legacy = s.otpDelivery.status;
      const sms = s.phoneOtp.smsDispatcher.getStatus();
      const smsConfigured = legacy.smsConfigured || sms.realSmsConfigured;
      res.json({
        ...legacy,
        smsConfigured,
        activeSmsProvider: sms.realSmsConfigured
          ? sms.activeSmsProvider
          : (legacy.activeSmsProvider ?? sms.activeSmsProvider),
        smsProviderMode: sms.smsProviderMode,
        directSmsConfigured: sms.directSmsConfigured,
        directSmsProvider: sms.directSmsProvider,
        smsPhoneAuthReady:
          smsConfigured || sms.firebaseClientReady || Boolean(sms.firebaseClientConfig),
        firebaseClientReady: sms.firebaseClientReady,
        firebaseClientConfig: sms.firebaseClientConfig,
        emailFallbackAvailable: legacy.emailConfigured,
      });
    }),
  );

  router.post(
    '/otp/send',
    sec.requirePow,
    sec.botTrapCheck,
    validateBody(phoneAuthSchemas.otpSend),
    limits.otp,
    h(async (req: Request, res: Response) => {
      const b = req.body as z.infer<typeof phoneAuthSchemas.otpSend>;
      const { isEmail, rawTarget } = detectIsEmailChannel(b);
      if (!rawTarget) {
        throw badRequest('Vui lòng nhập số điện thoại Việt Nam (+84) hoặc địa chỉ Email.', 'invalid_identifier');
      }

      if (isEmail) {
        const emailPurpose: OtpPurpose =
          b.purpose === 'reset_password' || b.purpose === 'change_email' || b.purpose === 'change_phone'
            ? b.purpose
            : 'login';
        const out = await s.auth.requestOtp(rawTarget, emailPurpose);
        res.json(out);
        return;
      }

      const phonePurpose =
        b.purpose === 'reset_password'
          ? 'reset_password'
          : b.purpose === 'verify_phone' || b.purpose === 'change_phone'
            ? 'verify_phone'
            : 'login';
      const out = await s.phoneOtp.sendPhoneOtp(rawTarget, {
        purpose: phonePurpose,
        preferDirectSms: b.preferDirectSms,
      });
      res.json(out);
    }),
  );

  router.post(
    '/otp/verify',
    sec.requirePow,
    sec.botTrapCheck,
    validateBody(phoneAuthSchemas.otpVerify),
    limits.login,
    h(async (req: Request, res: Response) => {
      const b = req.body as z.infer<typeof phoneAuthSchemas.otpVerify>;
      const { isEmail, rawTarget } = detectIsEmailChannel(b);
      const otpCode = (b.code ?? b.otp ?? '').trim();
      const meta = extractClientMeta(req);
      const sessionOpts = {
        name: b.name,
        password: b.password,
        defaultWardCode: b.defaultWardCode,
        userAgent: meta.userAgent,
        meta,
      };

      if (isEmail) {
        const issued = await s.auth.verifyOtp(rawTarget, otpCode, sessionOpts);
        setAuthCookies(res, issued.session.token, issued.refreshToken, issued.refreshMaxAgeMs);
        res.json(issued.session);
        return;
      }

      const parsedPhone = parseVnPhone(rawTarget);
      if (!parsedPhone) {
        throw badRequest(
          'Số điện thoại Việt Nam không hợp lệ. Vui lòng nhập đúng 10 số di động (03, 05, 07, 08, 09).',
          'invalid_phone',
        );
      }

      // Hỗ trợ song song cả mã OTP gửi qua /otp/send mới lẫn /otp/request cũ
      const phoneChallenge = await s.phoneOtp.peekChallenge(parsedPhone.e164);
      if (!phoneChallenge) {
        const legacyChallenge = await s.repos.otps.get(parsedPhone.local);
        if (legacyChallenge) {
          const issued = await s.auth.verifyOtp(parsedPhone.local, otpCode, sessionOpts);
          setAuthCookies(res, issued.session.token, issued.refreshToken, issued.refreshMaxAgeMs);
          res.json(issued.session);
          return;
        }
      }

      const verifiedPhone = await s.phoneOtp.verifyPhoneOtp(parsedPhone.e164, otpCode);
      const issued = await s.auth.issueCitizenSessionByPhone(verifiedPhone, sessionOpts);
      setAuthCookies(res, issued.session.token, issued.refreshToken, issued.refreshMaxAgeMs);
      res.json(issued.session);
    }),
  );

  router.post(
    '/otp/verify-firebase',
    sec.botTrapCheck,
    validateBody(phoneAuthSchemas.verifyFirebase),
    limits.login,
    h(async (req: Request, res: Response) => {
      const b = req.body as z.infer<typeof phoneAuthSchemas.verifyFirebase>;
      const idToken = (b.firebaseIdToken ?? b.idToken ?? '').trim();
      const verified = await s.firebaseVerifier.verifyPhoneIdToken(idToken);
      const meta = extractClientMeta(req);
      const issued = await s.auth.issueCitizenSessionByPhone(verified.phone, {
        name: b.name,
        password: b.password,
        defaultWardCode: b.defaultWardCode,
        userAgent: meta.userAgent,
        meta,
        firebaseUid: verified.uid,
      });
      setAuthCookies(res, issued.session.token, issued.refreshToken, issued.refreshMaxAgeMs);
      res.json(issued.session);
    }),
  );

  return router;
}
