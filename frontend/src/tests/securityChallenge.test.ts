import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  hasLeadingZeroBits,
  requiresPowSolution,
  sha256Bytes,
  solveChallengePayload,
  solvePowHeader,
  type PowChallengePayload,
} from '../lib/securityChallenge';

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

describe('securityChallenge (SHA-256 PoW thuần JS & tối ưu tốc độ)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('khớp 100% chuẩn SHA-256 NIST và WebCrypto trên các chuỗi đầu vào', async () => {
    expect(toHex(sha256Bytes(''))).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(toHex(sha256Bytes('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

    const encoder = new TextEncoder();
    for (const sample of ['nonce123:0', 'pow_test:9999', 'dong-nai-smart-citizen-2026']) {
      const jsHex = toHex(sha256Bytes(sample));
      const subtleBuf = await globalThis.crypto.subtle.digest('SHA-256', encoder.encode(sample));
      expect(jsHex).toBe(toHex(new Uint8Array(subtleBuf)));
    }
  });

  it('giải thử thách PoW 8-bit tức thì (< 50ms) kể cả khi thiếu crypto.subtle (môi trường HTTP LAN)', async () => {
    const challenge: PowChallengePayload = {
      challengeId: 'pow_lan_mobile_01',
      nonce: '0123456789abcdef0123456789abcdef',
      expiresAt: Date.now() + 600_000,
      difficultyBits: 8,
      signature: 'a'.repeat(64),
    };

    const subtle = globalThis.crypto.subtle;
    vi.stubGlobal('crypto', undefined);
    const t0 = performance.now();
    const token = await solveChallengePayload(challenge);
    const elapsedMs = performance.now() - t0;

    expect(elapsedMs).toBeLessThan(50);
    const parts = token.split('.');
    expect(parts).toHaveLength(6);
    const counter = parts[5];
    const digestBuf = await subtle.digest('SHA-256', new TextEncoder().encode(`${challenge.nonce}:${counter}`));
    expect(hasLeadingZeroBits(new Uint8Array(digestBuf), 8)).toBe(true);
  });

  it('tự động thử xin lại challenge 1 lần nếu mạng chập chờn tạm thời', async () => {
    const challenge: PowChallengePayload = {
      challengeId: 'pow_retry_fetch_01',
      nonce: 'fedcba9876543210fedcba9876543210',
      expiresAt: Date.now() + 600_000,
      difficultyBits: 8,
      signature: 'b'.repeat(64),
    };

    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('Transient socket error'))
      .mockResolvedValueOnce(
        new Response(JSON.stringify(challenge), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const token = await solvePowHeader('http://localhost:8080', {});
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(token.startsWith('pow_retry_fetch_01.')).toBe(true);
  });

  it('xác định chính xác các endpoint nhạy cảm cần PoW', () => {
    expect(requiresPowSolution('/api/reports', 'POST')).toBe(true);
    expect(requiresPowSolution('/api/auth/otp/send', 'POST')).toBe(true);
    expect(requiresPowSolution('/api/auth/otp/verify', 'POST')).toBe(true);
    expect(requiresPowSolution('/api/alerts/community', 'POST')).toBe(true);
    expect(requiresPowSolution('/api/alerts/alert-1/confirm', 'POST')).toBe(true);
    expect(requiresPowSolution('/api/reports', 'GET')).toBe(false);
    expect(requiresPowSolution('/api/security/challenge', 'GET')).toBe(false);
  });

  it('api() tự động làm mới PoW và thử lại ngầm tối đa 1 lần khi bị 403 pow_expired, đồng thời đọc retryAfter khi bị 429', async () => {
    vi.stubGlobal('window', globalThis);

    let challengeCounter = 0;
    let otpCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/api/security/challenge')) {
        challengeCounter += 1;
        const payload: PowChallengePayload = {
          challengeId: `pow_auto_${challengeCounter}`,
          nonce: `00112233445566778899aabbccddeef${challengeCounter}`,
          expiresAt: Date.now() + 600_000,
          difficultyBits: 8,
          signature: 'c'.repeat(64),
        };
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/api/auth/otp/send')) {
        otpCalls += 1;
        if (otpCalls === 1) {
          return new Response(
            JSON.stringify({
              error: { code: 'pow_expired', message: 'Phiên xác thực đã hết hạn' },
            }),
            { status: 403, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (otpCalls === 2) {
          return new Response(JSON.stringify({ ok: true, targetMasked: '091***678' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            error: {
              code: 'otp_cooldown',
              message: 'Vui lòng chờ 42 giây trước khi yêu cầu gửi lại mã OTP.',
              retryAfter: 42,
              details: { retryAfterSec: 42 },
            },
          }),
          {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'Retry-After': '42' },
          },
        );
      }
      return new Response('{}', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { api, ApiError } = await import('../lib/api');

    const res = await api<{ ok: boolean; targetMasked: string }>('/api/auth/otp/send', {
      body: { channel: 'phone', phone: '+84912345678' },
    });
    expect(res.ok).toBe(true);
    expect(challengeCounter).toBe(2);
    expect(otpCalls).toBe(2);

    await expect(
      api('/api/auth/otp/send', { body: { channel: 'phone', phone: '+84912345678' } }),
    ).rejects.toSatisfy((err: unknown) => err instanceof ApiError && err.status === 429 && err.retryAfter === 42);
  });
});
