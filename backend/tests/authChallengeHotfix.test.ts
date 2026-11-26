import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PowChallengePayload } from '../src/middleware/security';
import type { OtpSendPayload, OtpTransport } from '../src/services/otpDelivery.service';
import type { Services } from '../src/services/container';

class HotfixOtpTransport implements OtpTransport {
  readonly provider = 'test_hotfix_email';
  readonly channel = 'email' as const;
  readonly sent = new Map<string, string>();

  async send(payload: OtpSendPayload): Promise<void> {
    this.sent.set(payload.to.toLowerCase(), payload.code);
  }
}

const otpTransport = new HotfixOtpTransport();

async function makeTestJpegDataUrl(seed: number): Promise<string> {
  const w = 320;
  const h = 240;
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 3;
      const micro = (((Math.imul(x + seed * 17, 73856093) ^ Math.imul(y + seed * 31, 19349663)) & 31) - 16) * 0.7;
      const u = x / w;
      const v = y / h;
      const p1 = Math.sin(u * (3.1 + seed * 1.9) + v * (2.3 + seed * 1.3) + seed * 2.7);
      const p2 = Math.cos(u * (5.7 + seed * 0.8) - v * (4.1 + seed * 2.1) + seed * 5.1);
      const sharpStep = ((Math.floor(x / (18 + seed)) + Math.floor(y / (14 + seed))) % 2 === 0 ? 18 : -18);
      const r = 128 + p1 * 55 + p2 * 35 + seed * 9 + sharpStep + micro;
      const g = 128 + Math.sin((u + seed) * 6.3 + p2) * 50 + (seed % 2 === 0 ? 22 : -15) - sharpStep * 0.5 + micro;
      const b = 128 + Math.cos((v + seed * 2) * 5.2 - p1) * 50 + (seed % 3 === 0 ? 25 : -10) + micro;
      raw[idx] = Math.max(0, Math.min(255, Math.round(r)));
      raw[idx + 1] = Math.max(0, Math.min(255, Math.round(g)));
      raw[idx + 2] = Math.max(0, Math.min(255, Math.round(b)));
    }
  }
  const buf = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

describe('Hotfix Auth + PoW Challenge + Rate Limit (E2E)', () => {
  let base = '';
  let dir = '';
  let services: Services;
  let solvePowFn: (c: PowChallengePayload) => string;
  let powBits = 0;
  let powTtlMs = 0;
  let closeServer: () => Promise<void> = async () => undefined;
  let stopResilient: () => Promise<void> = async () => undefined;

  async function apiCall<T = any>(
    p: string,
    init: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; data: T; headers: Headers }> {
    const res = await fetch(`${base}${p}`, {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
      headers: {
        'Content-Type': 'application/json',
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
        'X-Device-Fp': 'hotfix-test-device',
        ...(init.headers ?? {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    let data = null as T;
    try {
      data = text ? (JSON.parse(text) as T) : (null as T);
    } catch {
      data = text as unknown as T;
    }
    return { status: res.status, data, headers: res.headers };
  }

  async function fetchAndSolvePow(headers?: Record<string, string>): Promise<{ header: string; solveMs: number }> {
    const challengeRes = await apiCall<PowChallengePayload>('/api/security/challenge', {
      headers: { 'X-Security-Strict': '1', ...(headers ?? {}) },
    });
    expect(challengeRes.status).toBe(200);
    const t0 = performance.now();
    const header = solvePowFn(challengeRes.data);
    const solveMs = performance.now() - t0;
    return { header, solveMs };
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-hotfix-auth-pow-'));
    process.env.DATA_DIR = dir;
    process.env.NODE_ENV = 'test';
    process.env.MONGODB_URI = '';
    process.env.GEMINI_API_KEY = '';
    process.env.GEMINI_API_KEYS = '';

    const secMod = await import('../src/middleware/security');
    solvePowFn = secMod.solvePowChallenge;
    powBits = secMod.POW_DIFFICULTY_BITS;
    powTtlMs = secMod.POW_CHALLENGE_TTL_MS;

    const { createNonBlockingServerRepositories } = await import('../src/repositories');
    const { createServices } = await import('../src/services/container');
    const { seedIfEmpty } = await import('../src/data/seedStore');
    const { createApp } = await import('../src/app');

    const resilient = createNonBlockingServerRepositories();
    stopResilient = resilient.stop;
    services = createServices(resilient.boot.repos);
    services.otpDelivery.setTestTransport(otpTransport);
    await seedIfEmpty(resilient.localRepos, services.audit);

    const server = createApp(services, resilient.boot).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    closeServer = async () => {
      await new Promise((r) => server.close(r));
    };
  });

  afterAll(async () => {
    await closeServer();
    await stopResilient();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('1. Hạ độ khó PoW (~8 bit, giải < 300ms), TTL 10 phút, tách quota /challenge và hỗ trợ đổi IP 4G', async () => {
    expect(powBits).toBeLessThanOrEqual(8);
    expect(powTtlMs).toBeGreaterThanOrEqual(5 * 60 * 1000);

    // Xin challenge liên tục 40 lần không bị global/publicRead chặn
    for (let i = 0; i < 40; i++) {
      const { header, solveMs } = await fetchAndSolvePow({
        'X-Forwarded-For': '113.161.10.1',
        'X-Device-Fp': 'weak-phone-sim',
      });
      expect(header.split('.')).toHaveLength(6);
      expect(solveMs).toBeLessThan(300);
    }

    // Lấy challenge ở IP 4G cũ, giải PoW rồi gửi request ở IP 4G mới vẫn hợp lệ 100%
    const cRes = await apiCall<PowChallengePayload>('/api/security/challenge', {
      headers: { 'X-Forwarded-For': '113.161.10.1', 'X-Security-Strict': '1' },
    });
    expect(cRes.status).toBe(200);
    const powHeader = solvePowFn(cRes.data);

    const reqRes = await apiCall('/api/auth/otp/request', {
      headers: {
        'X-Forwarded-For': '113.161.10.2',
        'X-Security-Strict': '1',
        'X-PoW-Solution': powHeader,
      },
      body: { identifier: 'roaming4g.citizen@dongnai.vn', formLoadedAt: Date.now() - 1000 },
    });
    expect(reqRes.status).toBe(200);
  });

  it('2. Không trừ lượt oan (Double-Penalty) khi thử thách PoW hết hạn/lỗi hoặc validation sai', async () => {
    services.phoneOtp.smsDispatcher.setOverrideProvider({
      name: 'android_gateway',
      isConfigured: () => true,
      send: async () => ({ provider: 'android_gateway', delivered: true, messageId: 'ok' }),
    });

    try {
      const otpIp = '10.88.0.10';
      const otpDevice = 'dp-double-penalty-otp';

      // Gửi 35 lần PoW hết hạn/sai chữ ký + honeypot + body lỗi (> hạn mức 30/5p) -> không được trừ vào hạn mức OTP
      for (let i = 0; i < 35; i++) {
        const fakePow = `pow_invalidid00${i}.0123456789abcdef0123456789abcdef.${Date.now() - 5000}.8.${'a'.repeat(64)}.0`;
        const badRes = await apiCall('/api/auth/otp/send', {
          headers: {
            'X-Forwarded-For': otpIp,
            'X-Device-Fp': otpDevice,
            'X-Security-Strict': '1',
            'X-PoW-Solution': fakePow,
          },
          body: { channel: 'phone', phone: '0912345678', formLoadedAt: Date.now() - 1000 },
        });
        expect(badRes.status).toBe(403);
        expect(badRes.data.error.code).toBe('pow_expired');
      }

      // Gửi 10 request sai định dạng SĐT (400) -> không trừ lượt OTP
      for (let i = 0; i < 10; i++) {
        const { header } = await fetchAndSolvePow({ 'X-Forwarded-For': otpIp, 'X-Device-Fp': otpDevice });
        const invalidRes = await apiCall('/api/auth/otp/send', {
          headers: {
            'X-Forwarded-For': otpIp,
            'X-Device-Fp': otpDevice,
            'X-Security-Strict': '1',
            'X-PoW-Solution': header,
          },
          body: { channel: 'phone', phone: '123', formLoadedAt: Date.now() - 1000 },
        });
        expect(invalidRes.status).toBe(400);
      }

      // Request hợp lệ đầu tiên vẫn phải thành công 200 OK
      const { header } = await fetchAndSolvePow({ 'X-Forwarded-For': otpIp, 'X-Device-Fp': otpDevice });
      const okOtp = await apiCall('/api/auth/otp/send', {
        headers: {
          'X-Forwarded-For': otpIp,
          'X-Device-Fp': otpDevice,
          'X-Security-Strict': '1',
          'X-PoW-Solution': header,
        },
        body: { channel: 'phone', phone: '0988776655', formLoadedAt: Date.now() - 1000 },
      });
      expect(okOtp.status).toBe(200);
    } finally {
      services.phoneOtp.smsDispatcher.setOverrideProvider(null);
    }
  });

  it('3. Đăng ký 10 tài khoản liên tiếp + Đăng nhập mật khẩu + Không khóa oan người dùng dùng chung IP 4G/Wi-Fi', async () => {
    const sharedIp = '203.160.88.99';
    const userTokens: string[] = [];

    for (let i = 0; i < 10; i++) {
      const email = `hotfix.reg.${i}@dongnai.vn`;
      const devFp = `citizen-device-${i}`;
      const pow1 = await fetchAndSolvePow({ 'X-Forwarded-For': sharedIp, 'X-Device-Fp': devFp });
      const r1 = await apiCall('/api/auth/otp/request', {
        headers: { 'X-Forwarded-For': sharedIp, 'X-Device-Fp': devFp, 'X-Security-Strict': '1', 'X-PoW-Solution': pow1.header },
        body: { identifier: email, formLoadedAt: Date.now() - 1000 },
      });
      expect(r1.status).toBe(200);

      const code = otpTransport.sent.get(email)!;
      const pow2 = await fetchAndSolvePow({ 'X-Forwarded-For': sharedIp, 'X-Device-Fp': devFp });
      const r2 = await apiCall<{ token: string }>('/api/auth/otp/verify', {
        headers: { 'X-Forwarded-For': sharedIp, 'X-Device-Fp': devFp, 'X-Security-Strict': '1', 'X-PoW-Solution': pow2.header },
        body: {
          identifier: email,
          code,
          name: `Công dân ${i}`,
          password: 'ValidPass@2026!',
          formLoadedAt: Date.now() - 1000,
        },
      });
      expect(r2.status).toBe(200);
      expect(r2.data.token).toBeTruthy();
      userTokens.push(r2.data.token);
    }

    // Thử sai mật khẩu 3 lần -> thông báo rõ ràng 401, lần 4 nhập đúng vẫn vào ngay
    const email0 = 'hotfix.reg.0@dongnai.vn';
    for (let attempt = 0; attempt < 3; attempt++) {
      const bad = await apiCall('/api/auth/password/login', {
        headers: { 'X-Forwarded-For': sharedIp, 'X-Device-Fp': 'citizen-device-0', 'X-Security-Strict': '1' },
        body: { identifier: email0, password: `SaiMatKhau#${attempt}` },
      });
      expect(bad.status).toBe(401);
      expect(bad.data.error.message).toMatch(/không đúng/i);
    }
    const okLogin = await apiCall<{ token: string }>('/api/auth/password/login', {
      headers: { 'X-Forwarded-For': sharedIp, 'X-Device-Fp': 'citizen-device-0', 'X-Security-Strict': '1' },
      body: { identifier: email0, password: 'ValidPass@2026!' },
    });
    expect(okLogin.status).toBe(200);

    // Khóa brute-force User 0 trên thiết bị 0 -> User 1 trên CÙNG IP (khác thiết bị) vẫn đăng nhập trơn tru
    for (let attempt = 0; attempt < 6; attempt++) {
      await apiCall('/api/auth/password/login', {
        headers: { 'X-Forwarded-For': sharedIp, 'X-Device-Fp': 'citizen-device-0', 'X-Security-Strict': '1' },
        body: { identifier: email0, password: `BruteWrong#${attempt}` },
      });
    }
    const lockedUser0 = await apiCall('/api/auth/password/login', {
      headers: { 'X-Forwarded-For': sharedIp, 'X-Device-Fp': 'citizen-device-0', 'X-Security-Strict': '1' },
      body: { identifier: email0, password: 'ValidPass@2026!' },
    });
    expect(lockedUser0.status).toBe(429);
    expect(lockedUser0.data.error.retryAfter).toBeGreaterThan(0);

    const siblingUser1 = await apiCall<{ token: string }>('/api/auth/password/login', {
      headers: { 'X-Forwarded-For': sharedIp, 'X-Device-Fp': 'citizen-device-1', 'X-Security-Strict': '1' },
      body: { identifier: 'hotfix.reg.1@dongnai.vn', password: 'ValidPass@2026!' },
    });
    expect(siblingUser1.status).toBe(200);
  }, 30_000);

  it('4. Gửi đơn và Xác nhận đơn/cảnh báo liên tiếp không bị chặn 429 & không dính Double-Penalty PoW', async () => {
    const emailOwner = 'hotfix.owner@dongnai.vn';
    const ipOwner = '10.66.1.1';
    await apiCall('/api/auth/otp/request', { headers: { 'X-Forwarded-For': ipOwner }, body: { identifier: emailOwner } });
    const ownerAuth = await apiCall<{ token: string }>('/api/auth/otp/verify', {
      headers: { 'X-Forwarded-For': ipOwner },
      body: { identifier: emailOwner, code: otpTransport.sent.get(emailOwner), name: 'Người gửi đơn' },
    });
    expect(ownerAuth.status).toBe(200);
    const ownerToken = ownerAuth.data.token;

    // Gửi 35 lần PoW hết hạn lên /api/reports -> không tiêu hao hạn mức gửi đơn
    for (let i = 0; i < 35; i++) {
      const expiredPow = `pow_repexp000${i}.0123456789abcdef0123456789abcdef.${Date.now() - 5000}.8.${'b'.repeat(64)}.0`;
      const failRes = await apiCall('/api/reports', {
        token: ownerToken,
        headers: {
          'X-Forwarded-For': ipOwner,
          'X-Device-Fp': 'owner-device',
          'X-Security-Strict': '1',
          'X-PoW-Solution': expiredPow,
        },
        body: {
          idempotencyKey: `hotfix-exp-rep-${i}`,
          category: 'ngap_nuoc',
          title: 'Kiểm thử PoW hết hạn không trừ lượt',
          description: 'Mô tả đầy đủ dài trên 12 ký tự để qua schema.',
          lat: 10.9465,
          lng: 106.8243,
        },
      });
      expect(failRes.status).toBe(403);
      expect(failRes.data.error.code).toBe('pow_expired');
    }

    // Gửi liên tiếp 8 đơn thật với PoW hợp lệ (< 300ms) -> tất cả 201 Created (vượt xa ngưỡng cũ 5/10p và 3/giờ)
    const hashes = ['1111000011110000', '0000111100001111', '3333cccc3333cccc', 'cccc3333cccc3333', '5555aaaa5555aaaa', 'aaaa5555aaaa5555', '7777888877778888', '9999666699996666'];
    const createdIds: string[] = [];
    for (let i = 0; i < hashes.length; i++) {
      const photoUrl = await makeTestJpegDataUrl(i + 1);
      const { header, solveMs } = await fetchAndSolvePow({ 'X-Forwarded-For': ipOwner, 'X-Device-Fp': 'owner-device' });
      expect(solveMs).toBeLessThan(300);
      const createRes = await apiCall<any>('/api/reports', {
        token: ownerToken,
        headers: {
          'X-Forwarded-For': ipOwner,
          'X-Device-Fp': 'owner-device',
          'X-Security-Strict': '1',
          'X-PoW-Solution': header,
        },
        body: {
          idempotencyKey: `hotfix-ok-rep-${i}`,
          category: 'ngap_nuoc',
          title: `Điểm ngập số ${i + 1} đường Đồng Khởi`,
          description: `Nước ngập sâu tại điểm kiểm tra số ${i + 1}, cần thoát nước gấp.`,
          lat: 10.93 + i * 0.004,
          lng: 106.82 + i * 0.004,
          photo: { dataUrl: photoUrl, dHash: hashes[i] },
          formLoadedAt: Date.now() - 1000,
        },
      });
      expect(createRes.status, JSON.stringify(createRes.data)).toBe(201);
      createdIds.push(createRes.data.report.id);
    }

    // Người dân khác xác nhận liên tiếp nhiều đơn + nhiều cảnh báo cộng đồng trơn tru
    const emailConfirmer = 'hotfix.confirmer@dongnai.vn';
    const ipConfirmer = '10.66.1.2';
    await apiCall('/api/auth/otp/request', { headers: { 'X-Forwarded-For': ipConfirmer }, body: { identifier: emailConfirmer } });
    const confAuth = await apiCall<{ token: string }>('/api/auth/otp/verify', {
      headers: { 'X-Forwarded-For': ipConfirmer },
      body: { identifier: emailConfirmer, code: otpTransport.sent.get(emailConfirmer), name: 'Người xác nhận' },
    });
    const confToken = confAuth.data.token;

    for (const rid of createdIds) {
      const cRes = await apiCall<any>(`/api/reports/${rid}/confirm`, {
        token: confToken,
        headers: { 'X-Forwarded-For': ipConfirmer, 'X-Device-Fp': 'confirmer-dev', 'X-Security-Strict': '1' },
        body: {},
      });
      expect(cRes.status).toBe(200);
      expect(cRes.data.confirmCount).toBe(1);
    }

    // Tạo cảnh báo cộng đồng và gửi 65 PoW hết hạn trước khi confirm thành công
    const powComm = await fetchAndSolvePow({ 'X-Forwarded-For': ipOwner, 'X-Device-Fp': 'owner-device' });
    const commRes = await apiCall<any>('/api/alerts/community', {
      token: ownerToken,
      headers: {
        'X-Forwarded-For': ipOwner,
        'X-Device-Fp': 'owner-device',
        'X-Security-Strict': '1',
        'X-PoW-Solution': powComm.header,
      },
      body: {
        title: 'Cảnh báo ngập đoạn ngã tư Amata',
        description: 'Mưa lớn gây ngập cục bộ, các phương tiện gầm thấp nên tránh.',
        category: 'traffic',
        severity: 2,
        wardCode: 'DN-TB',
        lat: 10.9465,
        lng: 106.8243,
        affectedRoads: ['Quốc lộ 1A'],
        formLoadedAt: Date.now() - 1000,
      },
    });
    expect(commRes.status).toBe(201);
    const alertId = commRes.data.id;

    for (let i = 0; i < 65; i++) {
      const badPow = `pow_altexp000${i}.0123456789abcdef0123456789abcdef.${Date.now() - 5000}.8.${'c'.repeat(64)}.0`;
      const failConf = await apiCall(`/api/alerts/${alertId}/confirm`, {
        token: confToken,
        headers: {
          'X-Forwarded-For': ipConfirmer,
          'X-Device-Fp': 'confirmer-dev',
          'X-Security-Strict': '1',
          'X-PoW-Solution': badPow,
        },
        body: {},
      });
      expect(failConf.status).toBe(403);
      expect(failConf.data.error.code).toBe('pow_expired');
    }

    const powConfirm = await fetchAndSolvePow({ 'X-Forwarded-For': ipConfirmer, 'X-Device-Fp': 'confirmer-dev' });
    const okConfirm = await apiCall<any>(`/api/alerts/${alertId}/confirm`, {
      token: confToken,
      headers: {
        'X-Forwarded-For': ipConfirmer,
        'X-Device-Fp': 'confirmer-dev',
        'X-Security-Strict': '1',
        'X-PoW-Solution': powConfirm.header,
      },
      body: {},
    });
    expect(okConfirm.status).toBe(200);
    expect(okConfirm.data.confirmCount).toBe((commRes.data.confirmCount ?? 0) + 1);
  }, 30_000);
});
