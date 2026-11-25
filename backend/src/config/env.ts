import crypto from 'node:crypto';
import dotenv from 'dotenv';
import path from 'node:path';
import { z } from 'zod';

dotenv.config();

export interface EnvValidationIssue {
  key: string;
  status: 'MISSING' | 'INVALID';
  detail: string;
  hint: string;
}

const nodeEnvSchema = z.enum(['development', 'production', 'test']);
const otpProviderSchema = z.enum(['auto', 'resend', 'brevo', 'webhook', 'smtp', 'twilio', 'esms']);

type NodeEnv = z.infer<typeof nodeEnvSchema>;
export type OtpProviderConfig = z.infer<typeof otpProviderSchema>;

function readTrimmed(source: NodeJS.ProcessEnv, key: string): string | undefined {
  const v = source[key];
  return v === undefined ? undefined : v.trim();
}

function parseBoolEnv(
  source: NodeJS.ProcessEnv,
  key: string,
  defaultValue: boolean,
  issues: EnvValidationIssue[],
): boolean {
  const raw = readTrimmed(source, key);
  if (raw === undefined || raw === '') return defaultValue;
  const low = raw.toLowerCase();
  if (['1', 'true', 'yes'].includes(low)) return true;
  if (['0', 'false', 'no'].includes(low)) return false;
  issues.push({
    key,
    status: 'INVALID',
    detail: `Giá trị "${raw}" không hợp lệ (chỉ chấp nhận true/false).`,
    hint: `Đặt ${key}=true hoặc ${key}=false.`,
  });
  return defaultValue;
}

function parseIntEnv(
  source: NodeJS.ProcessEnv,
  key: string,
  defaultValue: number,
  bounds: { min: number; max: number; hint: string },
  issues: EnvValidationIssue[],
): number {
  const raw = readTrimmed(source, key);
  if (raw === undefined || raw === '') return defaultValue;
  if (!/^-?\d+$/.test(raw)) {
    issues.push({
      key,
      status: 'INVALID',
      detail: `Giá trị "${raw}" không phải số nguyên hợp lệ.`,
      hint: bounds.hint,
    });
    return defaultValue;
  }
  const num = Number(raw);
  if (!Number.isSafeInteger(num) || num < bounds.min || num > bounds.max) {
    issues.push({
      key,
      status: 'INVALID',
      detail: `Giá trị ${raw} nằm ngoài khoảng cho phép (${bounds.min}–${bounds.max}).`,
      hint: bounds.hint,
    });
    return defaultValue;
  }
  return num;
}

function originMatcher(patterns: string[]): (origin: string) => boolean {
  const regs = patterns.map(
    (p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]+')}$`, 'i'),
  );
  return (origin) => regs.some((r) => r.test(origin));
}

function formatEnvErrorReport(issues: EnvValidationIssue[], nodeEnvLabel: string): string {
  const keyW = Math.max('BIẾN MÔI TRƯỜNG'.length, ...issues.map((i) => i.key.length));
  const statusW = Math.max('TRẠNG THÁI'.length, ...issues.map((i) => i.status.length));
  const pad = (text: string, width: number): string => text.padEnd(width, ' ');
  const sep = '-'.repeat(78);
  const border = '='.repeat(78);

  const rows = issues.map((i) => `${pad(i.key, keyW)} | ${pad(i.status, statusW)} | ${i.detail}`);
  const hints = issues.map((i) => `  - ${i.key}: ${i.hint}`);

  return [
    border,
    `[ENV ERROR] Khởi động thất bại: phát hiện ${issues.length} biến môi trường thiếu hoặc không hợp lệ`,
    `Môi trường (NODE_ENV): ${nodeEnvLabel}`,
    sep,
    `${pad('BIẾN MÔI TRƯỜNG', keyW)} | ${pad('TRẠNG THÁI', statusW)} | CHI TIẾT LỖI`,
    sep,
    ...rows,
    sep,
    'HƯỚNG DẪN KHẮC PHỤC (Render Dashboard -> Environment Variables hoặc backend/.env):',
    ...hints,
    border,
  ].join('\n');
}

export function parseEnv(source: NodeJS.ProcessEnv = process.env) {
  const issues: EnvValidationIssue[] = [];

  const rawNodeEnv = readTrimmed(source, 'NODE_ENV');
  let nodeEnv: NodeEnv = 'development';
  if (rawNodeEnv !== undefined && rawNodeEnv !== '') {
    const parsedNodeEnv = nodeEnvSchema.safeParse(rawNodeEnv);
    if (parsedNodeEnv.success) {
      nodeEnv = parsedNodeEnv.data;
    } else {
      issues.push({
        key: 'NODE_ENV',
        status: 'INVALID',
        detail: `Giá trị "${rawNodeEnv}" không hợp lệ.`,
        hint: 'Chỉ chấp nhận: development, production hoặc test.',
      });
    }
  }
  const isProd = nodeEnv === 'production';

  const port = parseIntEnv(
    source,
    'PORT',
    8080,
    { min: 1, max: 65535, hint: 'Số nguyên 1–65535 (vd: 8080; trên Render để hệ thống tự cấp PORT).' },
    issues,
  );

  const geminiApiKey = readTrimmed(source, 'GEMINI_API_KEY') ?? '';
  const geminiModel = readTrimmed(source, 'GEMINI_MODEL') || 'gemini-3.5-flash';

  const mongoUri = readTrimmed(source, 'MONGODB_URI') ?? '';
  if (mongoUri !== '' && !/^mongodb(\+srv)?:\/\/.+/.test(mongoUri)) {
    issues.push({
      key: 'MONGODB_URI',
      status: 'INVALID',
      detail: 'Chuỗi kết nối MongoDB không đúng định dạng URI.',
      hint: 'Dùng dạng mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/smartcitizen_dongnai hoặc để trống để dùng Local JSON Store.',
    });
  }

  const rawJwtSecret = readTrimmed(source, 'JWT_SECRET') ?? '';
  if (isProd) {
    if (rawJwtSecret === '') {
      issues.push({
        key: 'JWT_SECRET',
        status: 'MISSING',
        detail: 'Bắt buộc khai báo khi chạy production (yêu cầu tối thiểu 32 ký tự).',
        hint: 'Thêm JWT_SECRET >= 32 ký tự (vd: openssl rand -hex 32) vào Render Environment Variables.',
      });
    } else if (rawJwtSecret.length < 32) {
      issues.push({
        key: 'JWT_SECRET',
        status: 'INVALID',
        detail: `Quá ngắn (${rawJwtSecret.length} ký tự; yêu cầu tối thiểu 32 ký tự ở production).`,
        hint: 'Sinh chuỗi bí mật mạnh: openssl rand -hex 32.',
      });
    }
  }

  const rawAllowedOrigins = readTrimmed(source, 'ALLOWED_ORIGINS') ?? 'http://localhost:5173,https://*.onrender.com';
  const origins = rawAllowedOrigins
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (origins.length === 0) {
    issues.push({
      key: 'ALLOWED_ORIGINS',
      status: 'INVALID',
      detail: 'Danh sách ALLOWED_ORIGINS không được rỗng.',
      hint: 'Ví dụ: http://localhost:5173,https://*.onrender.com',
    });
  }

  // ── Nhà cung cấp OTP thật (Resend / SMTP / Twilio / eSMS) ──
  const rawOtpProvider = readTrimmed(source, 'OTP_PROVIDER') || 'auto';
  let otpProvider: OtpProviderConfig = 'auto';
  const parsedOtpProv = otpProviderSchema.safeParse(rawOtpProvider.toLowerCase());
  if (parsedOtpProv.success) {
    otpProvider = parsedOtpProv.data;
  } else {
    issues.push({
      key: 'OTP_PROVIDER',
      status: 'INVALID',
      detail: `Giá trị "${rawOtpProvider}" không hợp lệ.`,
      hint: 'Chỉ chấp nhận: auto | resend | brevo | webhook | smtp | twilio | esms.',
    });
  }

  const resendApiKey = readTrimmed(source, 'RESEND_API_KEY') ?? '';
  const brevoApiKey = readTrimmed(source, 'BREVO_API_KEY') ?? '';
  const otpWebhookUrl = readTrimmed(source, 'OTP_WEBHOOK_URL') ?? '';
  const otpWebhookSecret = readTrimmed(source, 'OTP_WEBHOOK_SECRET') ?? '';
  const otpFromEmail = readTrimmed(source, 'OTP_FROM_EMAIL') || 'SmartCitizen Đồng Nai <onboarding@resend.dev>';
  const smtpHost = readTrimmed(source, 'SMTP_HOST') ?? '';
  const smtpPort = parseIntEnv(source, 'SMTP_PORT', 587, { min: 1, max: 65535, hint: 'Cổng SMTP hợp lệ (vd: 587 hoặc 465).' }, issues);
  const smtpSecure = parseBoolEnv(source, 'SMTP_SECURE', smtpPort === 465, issues);
  const smtpUser = readTrimmed(source, 'SMTP_USER') ?? '';
  const smtpPass = readTrimmed(source, 'SMTP_PASS') ?? '';

  const twilioAccountSid = readTrimmed(source, 'TWILIO_ACCOUNT_SID') ?? '';
  const twilioAuthToken = readTrimmed(source, 'TWILIO_AUTH_TOKEN') ?? '';
  const twilioFromNumber = readTrimmed(source, 'TWILIO_FROM_NUMBER') ?? '';

  const esmsApiKey = readTrimmed(source, 'ESMS_API_KEY') ?? '';
  const esmsSecretKey = readTrimmed(source, 'ESMS_SECRET_KEY') ?? '';
  const esmsBrandname = readTrimmed(source, 'ESMS_BRANDNAME') ?? '';

  const reportsPerHour = parseIntEnv(
    source,
    'REPORTS_PER_HOUR',
    3,
    { min: 1, max: 1000, hint: 'Số nguyên dương 1–1000 (mặc định: 3).' },
    issues,
  );
  const aiVisionPerHour = parseIntEnv(
    source,
    'AI_VISION_PER_HOUR',
    10,
    { min: 1, max: 1000, hint: 'Số nguyên dương 1–1000 (mặc định: 10).' },
    issues,
  );
  const refreshTokenDays = parseIntEnv(
    source,
    'REFRESH_TOKEN_DAYS',
    7,
    { min: 1, max: 90, hint: 'Số ngày sống của Refresh Token (1–90, mặc định 7).' },
    issues,
  );
  const cookieSecure = parseBoolEnv(source, 'COOKIE_SECURE', isProd, issues);
  const dataDirRaw = readTrimmed(source, 'DATA_DIR') || './data';

  if (issues.length > 0) {
    throw new Error(`\n${formatEnvErrorReport(issues, rawNodeEnv || nodeEnv)}`);
  }

  /** Dev/test không có JWT_SECRET: sinh ngẫu nhiên mỗi lần chạy. */
  const jwtSecret = rawJwtSecret.length >= 16 ? rawJwtSecret : crypto.randomBytes(32).toString('hex');
  const jwtSecretEphemeral = rawJwtSecret.length < 16;
  const otpPepper = readTrimmed(source, 'OTP_PEPPER') || jwtSecret;

  return {
    isProd,
    nodeEnv,
    port,
    geminiApiKey,
    geminiModel,
    mongoUri,
    jwtSecret,
    jwtSecretEphemeral,
    otpPepper,
    allowedOrigins: origins,
    isOriginAllowed: originMatcher(origins),
    otpProvider,
    resendApiKey,
    brevoApiKey,
    otpWebhookUrl,
    otpWebhookSecret,
    otpFromEmail,
    smtpHost,
    smtpPort,
    smtpSecure,
    smtpUser,
    smtpPass,
    twilioAccountSid,
    twilioAuthToken,
    twilioFromNumber,
    esmsApiKey,
    esmsSecretKey,
    esmsBrandname,
    reportsPerHour,
    aiVisionPerHour,
    refreshTokenDays,
    cookieSecure,
    dataDir: path.resolve(dataDirRaw),
  } as const;
}

export const env = parseEnv(process.env);
