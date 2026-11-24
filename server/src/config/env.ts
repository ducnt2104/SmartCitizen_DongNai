import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

/**
 * Chỉ nạp file .env khi file tồn tại trên máy local (bỏ qua khi test hoặc chạy cloud).
 * Trên Render/Docker, biến môi trường được truyền trực tiếp qua process.env nên không gọi dotenv
 * khi không có file .env để tránh cảnh báo gây hiểu nhầm ("injected env (0) from .env").
 */
function loadLocalEnv(): void {
  if (process.env.NODE_ENV === 'test') return;

  const cwd = process.cwd();
  const candidates = [path.resolve(cwd, '.env')];
  if (path.basename(cwd) === 'server' && fs.existsSync(path.resolve(cwd, '..', 'package.json'))) {
    candidates.push(path.resolve(cwd, '..', '.env'));
  } else if (fs.existsSync(path.resolve(cwd, 'server', 'package.json'))) {
    candidates.push(path.resolve(cwd, 'server', '.env'));
  }

  for (const filePath of new Set(candidates)) {
    if (fs.existsSync(filePath)) {
      dotenv.config({ path: filePath, quiet: true });
    }
  }
}

loadLocalEnv();

export type NodeEnv = 'development' | 'production' | 'test';

export interface EnvValidationIssue {
  key: string;
  status: 'MISSING' | 'INVALID';
  detail: string;
  hint: string;
}

const nodeEnvSchema = z.enum(['development', 'production', 'test']);
const DEFAULT_ALLOWED_ORIGINS = 'http://localhost:5173,https://*.onrender.com';

function readTrimmed(source: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value.trim() : undefined;
}

function parseBoolEnv(
  source: NodeJS.ProcessEnv,
  key: string,
  defaultValue: boolean,
  issues: EnvValidationIssue[],
): boolean {
  const raw = readTrimmed(source, key);
  if (raw === undefined || raw === '') return defaultValue;
  const normalized = raw.toLowerCase();
  if (['1', 'true', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'no'].includes(normalized)) return false;
  issues.push({
    key,
    status: 'INVALID',
    detail: `Giá trị "${raw}" không phải kiểu boolean hợp lệ.`,
    hint: 'Chỉ dùng một trong các giá trị: true, false, 1, 0, yes, no.',
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
  if (!/^\d+$/.test(raw)) {
    issues.push({
      key,
      status: 'INVALID',
      detail: `Giá trị "${raw}" phải là số nguyên dương trong khoảng ${bounds.min}–${bounds.max}.`,
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
    'HƯỚNG DẪN KHẮC PHỤC (Render Dashboard -> Environment Variables hoặc server/.env):',
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
      hint: 'Dùng dạng mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/<db> hoặc để trống để dùng Local JSON Store.',
    });
  }

  const rawJwtSecret = readTrimmed(source, 'JWT_SECRET') ?? '';
  if (isProd) {
    if (rawJwtSecret.length === 0) {
      issues.push({
        key: 'JWT_SECRET',
        status: 'MISSING',
        detail: 'Bắt buộc khai báo khi chạy production (yêu cầu tối thiểu 32 ký tự).',
        hint: 'Thêm JWT_SECRET >= 32 ký tự (vd: openssl rand -hex 32) vào Render Environment Variables hoặc bật generateValue: true trong render.yaml.',
      });
    } else if (rawJwtSecret.length < 32) {
      issues.push({
        key: 'JWT_SECRET',
        status: 'INVALID',
        detail: `Độ dài hiện tại ${rawJwtSecret.length} ký tự — yêu cầu tối thiểu 32 ký tự khi chạy production.`,
        hint: 'Thay bằng chuỗi ngẫu nhiên >= 32 ký tự (vd: openssl rand -hex 32).',
      });
    }
  }

  const rawOrigins = readTrimmed(source, 'ALLOWED_ORIGINS') || DEFAULT_ALLOWED_ORIGINS;
  const origins = rawOrigins
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (origins.length === 0) {
    issues.push({
      key: 'ALLOWED_ORIGINS',
      status: 'INVALID',
      detail: 'Danh sách origin được phép đang rỗng.',
      hint: `Khai báo các origin cách nhau bằng dấu phẩy (vd: ${DEFAULT_ALLOWED_ORIGINS}).`,
    });
  }

  const demoOtp = parseBoolEnv(source, 'DEMO_OTP', true, issues);
  const enableDemoAuth = parseBoolEnv(source, 'ENABLE_DEMO_AUTH', true, issues);
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
  const dataDirRaw = readTrimmed(source, 'DATA_DIR') || './data';

  if (issues.length > 0) {
    // Fail-loud: gom toàn bộ lỗi cấu hình và in thành bảng rõ ràng trên Render Logs
    throw new Error(`\n${formatEnvErrorReport(issues, rawNodeEnv || nodeEnv)}`);
  }

  /** Dev/test không có JWT_SECRET: sinh ngẫu nhiên mỗi lần chạy (phiên cũ sẽ hết hiệu lực khi restart). */
  const jwtSecret = rawJwtSecret.length >= 16 ? rawJwtSecret : crypto.randomBytes(32).toString('hex');
  const jwtSecretEphemeral = rawJwtSecret.length < 16;

  return {
    isProd,
    nodeEnv,
    port,
    geminiApiKey,
    geminiModel,
    mongoUri,
    jwtSecret,
    jwtSecretEphemeral,
    allowedOrigins: origins,
    isOriginAllowed: originMatcher(origins),
    demoOtp,
    enableDemoAuth,
    reportsPerHour,
    aiVisionPerHour,
    dataDir: path.resolve(dataDirRaw),
  } as const;
}

export const env = parseEnv(process.env);
