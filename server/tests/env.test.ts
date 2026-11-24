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
        DEMO_OTP: 'maybe',
      });
    } catch (err) {
      caught = err as Error;
    }

    expect(caught).toBeInstanceOf(Error);
    const msg = caught!.message;
    expect(msg).toContain('phát hiện 4 biến môi trường thiếu hoặc không hợp lệ');
    expect(msg).toContain('PORT');
    expect(msg).toContain('MONGODB_URI');
    expect(msg).toContain('JWT_SECRET');
    expect(msg).toContain('MISSING');
    expect(msg).toContain('DEMO_OTP');
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
    expect(parsed.mongoUri).toBe('');
    expect(parsed.geminiApiKey).toBe('');
  });

  it('sinh JWT_SECRET tạm thời ở chế độ development khi chưa khai báo', () => {
    const parsed = parseEnv({
      NODE_ENV: 'development',
    });

    expect(parsed.isProd).toBe(false);
    expect(parsed.jwtSecretEphemeral).toBe(true);
    expect(parsed.jwtSecret.length).toBeGreaterThanOrEqual(64);
  });
});
