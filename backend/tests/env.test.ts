import { describe, expect, it } from 'vitest';
import { parseEnv } from '../src/config/env';

describe('parseEnv — kiểm tra biến môi trường', () => {
  it('gom tất cả biến thiếu/không hợp lệ vào một bảng báo lỗi ở chế độ production', () => {
    let caught: Error | null = null;
    try {
      parseEnv({
        NODE_ENV: 'production',
        PORT: 'not-a-port',
        MONGODB_URI: 'https://invalid-uri.example.com',
        JWT_SECRET: '',
        OTP_PROVIDER: 'invalid_provider',
        COOKIE_SECURE: 'maybe',
      });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeInstanceOf(Error);
    const msg = caught!.message;
    expect(msg).toContain('phát hiện 5 biến môi trường thiếu hoặc không hợp lệ');
    expect(msg).toContain('PORT');
    expect(msg).toContain('MONGODB_URI');
    expect(msg).toContain('JWT_SECRET');
    expect(msg).toContain('MISSING');
    expect(msg).toContain('OTP_PROVIDER');
    expect(msg).toContain('COOKIE_SECURE');
  });

  it('từ chối JWT_SECRET ngắn hơn 32 ký tự ở production và không làm lộ giá trị secret', () => {
    const shortSecret = 'super_short_secret_12345';
    let caught: Error | null = null;
    try {
      parseEnv({
        NODE_ENV: 'production',
        JWT_SECRET: shortSecret,
      });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught!.message).toContain('JWT_SECRET');
    expect(caught!.message).toContain('INVALID');
    expect(caught!.message).not.toContain(shortSecret);
  });

  it('khởi động thành công ở production khi JWT_SECRET hợp lệ (>= 32 ký tự)', () => {
    const parsed = parseEnv({
      NODE_ENV: 'production',
      PORT: '',
      JWT_SECRET: 'test_secret_key_minimum_32_characters_long_2026',
      MONGODB_URI: '',
      GEMINI_API_KEY: '',
    });

    expect(parsed.isProd).toBe(true);
    expect(parsed.port).toBe(8080);
    expect(parsed.jwtSecretEphemeral).toBe(false);
    expect(parsed.cookieSecure).toBe(true);
    expect(parsed.refreshTokenDays).toBe(7);
    expect(parsed.otpProvider).toBe('auto');
    expect(parsed.mongoUri).toBe('');
    expect(parsed.geminiApiKey).toBe('');
  });

  it('sinh JWT_SECRET tạm thời ở chế độ development khi chưa khai báo', () => {
    const parsed = parseEnv({
      NODE_ENV: 'development',
    });

    expect(parsed.isProd).toBe(false);
    expect(parsed.jwtSecretEphemeral).toBe(true);
    expect(parsed.cookieSecure).toBe(false);
    expect(parsed.jwtSecret.length).toBeGreaterThanOrEqual(64);
  });

  it('chuẩn hóa GEMINI_MODEL sang model production nhanh nhất (mặc định gemini-2.5-flash) và nhận diện đủ key pool', () => {
    const def = parseEnv({ NODE_ENV: 'development' });
    expect(def.geminiModel).toBe('gemini-2.5-flash');
    expect(def.geminiFastModel).toBe('gemini-2.5-flash');

    const deprecated = parseEnv({ NODE_ENV: 'development', GEMINI_MODEL: 'gemini-1.5-flash' });
    expect(deprecated.geminiModel).toBe('gemini-2.5-flash');

    const unsupported = parseEnv({ NODE_ENV: 'development', GEMINI_MODEL: 'gemini-3.5-flash-lite' });
    expect(unsupported.geminiModel).toBe('gemini-2.5-flash');

    const customLite = parseEnv({
      NODE_ENV: 'development',
      GEMINI_MODEL: 'gemini-2.5-flash-lite',
      GEMINI_API_KEY_1: 'AQ.Ab8RN6MockEnvStudioKey1234',
    });
    expect(customLite.geminiModel).toBe('gemini-2.5-flash-lite');
    expect(customLite.allowCloudAiFallback).toBe(true);

    const vertexOnly = parseEnv({
      NODE_ENV: 'development',
      VERTEX_API_KEYS: 'AQ.Ab8RN6MockEnvVertexKey5678',
    });
    expect(vertexOnly.allowCloudAiFallback).toBe(true);
  });
});
