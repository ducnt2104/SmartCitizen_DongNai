import crypto from 'node:crypto';
import dotenv from 'dotenv';
import path from 'node:path';
import { z } from 'zod';

dotenv.config();

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : ['1', 'true', 'yes'].includes(v.toLowerCase())));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  GEMINI_API_KEY: z.string().optional().default(''),
  GEMINI_MODEL: z.string().min(1).default('gemini-3.5-flash'),
  MONGODB_URI: z.string().optional().default(''),
  JWT_SECRET: z.string().optional().default(''),
  ALLOWED_ORIGINS: z.string().default('http://localhost:5173,https://*.onrender.com'),
  DEMO_OTP: bool(true),
  ENABLE_DEMO_AUTH: bool(true),
  REPORTS_PER_HOUR: z.coerce.number().int().positive().default(3),
  AI_VISION_PER_HOUR: z.coerce.number().int().positive().default(10),
  DATA_DIR: z.string().default('./data'),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // Fail-loud: cấu hình sai thì dừng ngay với thông điệp rõ ràng
  throw new Error(`Cấu hình .env không hợp lệ: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
}

const raw = parsed.data;
const isProd = raw.NODE_ENV === 'production';

if (isProd && raw.JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET phải có tối thiểu 32 ký tự khi chạy production.');
}

/** Dev không có JWT_SECRET: sinh ngẫu nhiên mỗi lần chạy (phiên cũ sẽ hết hiệu lực khi restart). */
const jwtSecret = raw.JWT_SECRET.length >= 16 ? raw.JWT_SECRET : crypto.randomBytes(32).toString('hex');
const jwtSecretEphemeral = raw.JWT_SECRET.length < 16;

function originMatcher(patterns: string[]): (origin: string) => boolean {
  const regs = patterns.map(
    (p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]+')}$`, 'i'),
  );
  return (origin) => regs.some((r) => r.test(origin));
}

const origins = raw.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);

export const env = {
  isProd,
  nodeEnv: raw.NODE_ENV,
  port: raw.PORT,
  geminiApiKey: raw.GEMINI_API_KEY,
  geminiModel: raw.GEMINI_MODEL,
  mongoUri: raw.MONGODB_URI,
  jwtSecret,
  jwtSecretEphemeral,
  allowedOrigins: origins,
  isOriginAllowed: originMatcher(origins),
  demoOtp: raw.DEMO_OTP,
  enableDemoAuth: raw.ENABLE_DEMO_AUTH,
  reportsPerHour: raw.REPORTS_PER_HOUR,
  aiVisionPerHour: raw.AI_VISION_PER_HOUR,
  dataDir: path.resolve(raw.DATA_DIR),
} as const;
