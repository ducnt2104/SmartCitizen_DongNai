import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PowChallengePayload } from '../src/middleware/security';
import type { OtpSendPayload, OtpTransport } from '../src/services/otpDelivery.service';
import type { Services } from '../src/services/container';

let solvePowChallengeFn: (c: PowChallengePayload) => string;
let assertSafeOfficialUrlFn: (u: string) => Promise<URL>;
let isPrivateOrInternalIpFn: (ip: string) => boolean;
let detectImageMagicBytesFn: (b: Buffer) => string | null;
let parsePhotoDataUrlFn: (dataUrl: string) => { buffer: Buffer; mime: string };

class TestOtpTransport implements OtpTransport {
  readonly provider = 'test_upgrade';
  readonly channel = 'email' as const;
  readonly sent = new Map<string, string>();
  async send(payload: OtpSendPayload): Promise<void> {
    this.sent.set(payload.to, payload.code);
  }
}

const otpTransport = new TestOtpTransport();

async function makeRealisticPhotoDataUrl(seed: number): Promise<string> {
  const w = 320;
  const h = 240;
  const raw = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const micro = (((Math.imul(x + seed * 17, 73856093) ^ Math.imul(y + seed * 31, 19349663)) & 31) - 16) * 0.7;
      // 3 bố cục phi đối xứng hoàn toàn độc lập về tần số, pha và kênh màu cho 3 ảnh hiện trường khác nhau
      const u = x / w;
      const v = y / h;
      const p1 = Math.sin(u * (3.1 + seed * 1.9) + v * (2.3 + seed * 1.3) + seed * 2.7);
      const p2 = Math.cos(u * (5.7 + seed * 0.8) - v * (4.1 + seed * 2.1) + seed * 5.1);
      const r = 128 + p1 * 55 + p2 * 35 + seed * 12 + micro;
      const g = 128 + Math.sin((u + seed) * 6.3 + p2) * 50 + (seed === 2 ? 30 : -15) + micro;
      const b = 128 + Math.cos((v + seed * 2) * 5.2 - p1) * 50 + (seed === 3 ? 35 : -10) + micro;
      const idx = (y * w + x) * 3;
      raw[idx] = Math.max(0, Math.min(255, Math.round(r)));
      raw[idx + 1] = Math.max(0, Math.min(255, Math.round(g)));
      raw[idx + 2] = Math.max(0, Math.min(255, Math.round(b)));
    }
  }
  const jpegBuf = await sharp(raw, { raw: { width: w, height: h, channels: 3 } }).jpeg({ quality: 90 }).toBuffer();
  return `data:image/jpeg;base64,${jpegBuf.toString('base64')}`;
}

describe('Nâng cấp SmartCitizen Đồng Nai: Defense-in-Depth, Aggregator, Ward Overview & Geo-Clustering Alerts', () => {
  let base = '';
  let dir = '';
  let services: Services;
  let adminCode = '';
  let adminPassword = '';
  let closeServer: () => Promise<void> = async () => undefined;
  let stopResilient: () => Promise<void> = async () => undefined;

  async function apiCall<T = any>(
    p: string,
    init: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; data: T }> {
    const res = await fetch(`${base}${p}`, {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
      headers: {
        'Content-Type': 'application/json',
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
        'X-Device-Fp': 'upgrade-test-device-01',
        ...(init.headers ?? {}),
      },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    let data: T = null as T;
    try {
      data = text ? (JSON.parse(text) as T) : (null as T);
    } catch {
      data = text as unknown as T;
    }
    return { status: res.status, data };
  }

  async function fetchSolvedPow(): Promise<string> {
    const { status, data } = await apiCall<PowChallengePayload>('/api/security/challenge');
    expect(status).toBe(200);
    return solvePowChallengeFn(data);
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-upgrade-suite-'));
    process.env.DATA_DIR = dir;
    process.env.NODE_ENV = 'test';
    process.env.MONGODB_URI = '';
    process.env.GEMINI_API_KEY = '';
    process.env.GEMINI_API_KEYS = '';

    const secMod = await import('../src/middleware/security');
    const ssrfMod = await import('../src/services/ssrfGuard');
    const magicMod = await import('../src/utils/magicBytes');
    const accessMod = await import('../src/services/access');
    solvePowChallengeFn = secMod.solvePowChallenge;
    assertSafeOfficialUrlFn = ssrfMod.assertSafeOfficialUrl;
    isPrivateOrInternalIpFn = ssrfMod.isPrivateOrInternalIp;
    detectImageMagicBytesFn = magicMod.detectImageMagicBytes;
    parsePhotoDataUrlFn = accessMod.parsePhotoDataUrl;

    const { createNonBlockingServerRepositories } = await import('../src/repositories');
    const { createServices } = await import('../src/services/container');
    const { env } = await import('../src/config/env');
    const { INITIAL_SUPER_ADMIN_PASSWORD, seedIfEmpty } = await import('../src/data/seedStore');
    const { createApp } = await import('../src/app');

    const resilient = createNonBlockingServerRepositories();
    stopResilient = resilient.stop;
    services = createServices(resilient.boot.repos);
    services.otpDelivery.setTestTransport(otpTransport);
    await seedIfEmpty(resilient.localRepos, services.audit);
    adminCode = env.superAdminCode.toUpperCase();
    adminPassword = INITIAL_SUPER_ADMIN_PASSWORD;

    const server = createApp(services, resilient.boot).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    closeServer = async () => {
      await new Promise((r) => server.close(r));
    };
  });

  afterAll(async () => {
    services.aggregator.stopScheduler();
    await closeServer();
    await stopResilient();
    await new Promise((r) => setTimeout(r, 200));
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* bỏ qua lock tệp tạm trên Windows */
    }
  });

  it('1. PoW Challenge chặn thiếu/giả/tái sử dụng solution khi bật X-Security-Strict', async () => {
    const missingRes = await apiCall('/api/auth/otp/request', {
      body: { identifier: 'citizen.pow@dongnai.test', purpose: 'login' },
      headers: { 'X-Security-Strict': '1' },
    });
    expect(missingRes.status).toBe(403);
    expect(missingRes.data.error.code).toBe('pow_required');

    const powHeader = await fetchSolvedPow();
    const okRes = await apiCall('/api/auth/otp/request', {
      body: {
        identifier: 'citizen.pow@dongnai.test',
        purpose: 'login',
        formLoadedAt: Date.now() - 3000,
      },
      headers: {
        'X-Security-Strict': '1',
        'X-PoW-Solution': powHeader,
      },
    });
    expect(okRes.status).toBe(200);

    // Replay attack phải bị từ chối ở lần gửi thứ 2 với cùng challengeId
    const replayRes = await apiCall('/api/auth/otp/request', {
      body: {
        identifier: 'citizen.pow2@dongnai.test',
        purpose: 'login',
        formLoadedAt: Date.now() - 3000,
      },
      headers: {
        'X-Security-Strict': '1',
        'X-PoW-Solution': powHeader,
      },
    });
    expect(replayRes.status).toBe(403);
    expect(replayRes.data.error.code).toBe('pow_replayed');
  });

  it('2. Honeypot & Timing Trap chặn bot điền trường ẩn hoặc submit < 1.5s', async () => {
    const pow1 = await fetchSolvedPow();
    const hpRes = await apiCall('/api/auth/otp/request', {
      body: {
        identifier: 'bot.honeypot@dongnai.test',
        website: 'https://spam-bot.invalid',
        formLoadedAt: Date.now() - 5000,
      },
      headers: { 'X-Security-Strict': '1', 'X-PoW-Solution': pow1 },
    });
    expect(hpRes.status).toBe(403);
    expect(hpRes.data.error.code).toBe('bot_honeypot_triggered');

    const pow2 = await fetchSolvedPow();
    const fastRes = await apiCall('/api/auth/otp/request', {
      body: {
        identifier: 'bot.fast@dongnai.test',
        formLoadedAt: Date.now() - 200,
      },
      headers: { 'X-Security-Strict': '1', 'X-PoW-Solution': pow2 },
    });
    expect(fastRes.status).toBe(429);
    expect(fastRes.data.error.code).toBe('bot_too_fast');
  });

  it('3. Giới hạn Payload 100KB, kiểm tra Magic Bytes thật và chống NoSQL Injection / XSS', async () => {
    const oversizedText = 'A'.repeat(130 * 1024);
    const bigRes = await apiCall('/api/ai/chat', {
      body: { messages: [{ role: 'user', text: oversizedText }] },
    });
    expect(bigRes.status).toBe(413);

    const nosqlRes = await apiCall('/api/auth/password/login', {
      body: { identifier: { $ne: '' }, password: '123' },
    });
    expect(nosqlRes.status).toBe(400);

    expect(detectImageMagicBytesFn(Buffer.from('MZfakeexecutablepayload'))).toBeNull();
    const fakePng = `data:image/png;base64,${Buffer.from('<html>not-an-image</html>').toString('base64')}`;
    const fakeImgRes = await apiCall('/api/ai/analyze-image', {
      body: { image: { dataUrl: fakePng, dHash: '0123456789abcdef' } },
    });
    expect(fakeImgRes.status).toBe(400);
    expect(fakeImgRes.data.error.code).toBe('invalid_image_magic_bytes');
  });

  it('4. SSRF Guard chặn dải IP nội bộ / metadata và domain ngoài whitelist', async () => {
    expect(isPrivateOrInternalIpFn('127.0.0.1')).toBe(true);
    expect(isPrivateOrInternalIpFn('169.254.169.254')).toBe(true);
    expect(isPrivateOrInternalIpFn('10.20.30.40')).toBe(true);
    expect(isPrivateOrInternalIpFn('192.168.1.1')).toBe(true);

    await expect(assertSafeOfficialUrlFn('http://127.0.0.1:8080/internal')).rejects.toThrow();
    await expect(assertSafeOfficialUrlFn('https://169.254.169.254/latest/meta-data/')).rejects.toThrow();
    await expect(assertSafeOfficialUrlFn('https://untrusted-site.example.org/rss.xml')).rejects.toThrow();
  });

  it('5. Aggregator đồng bộ Open-Meteo (tự kích hoạt Alert mưa lớn) & RSS chống trùng lặp SHA-256 + AI Digest Cache', async () => {
    const mockWeatherPayload = Array.from({ length: 9 }, (_, idx) => ({
      current: {
        temperature_2m: 26 + idx * 0.2,
        relative_humidity_2m: 92,
        precipitation: idx === 0 ? 42.5 : 3.2,
        weather_code: idx === 0 ? 95 : 61,
        wind_gusts_10m: idx === 0 ? 64 : 18,
        time: new Date().toISOString(),
      },
      hourly: {
        precipitation: Array.from({ length: 24 }, () => (idx === 0 ? 3.5 : 0.4)),
        precipitation_probability: [90, 85, 80],
      },
    }));

    const mockRssXml = `<?xml version="1.0" encoding="UTF-8" ?>
      <rss version="2.0"><channel>
        <item>
          <title>Cảnh báo ngập cục bộ và thi công cống thoát nước tại Trấn Biên Đồng Nai</title>
          <link>https://baodongnai.com.vn/xa-hoi/202611/canh-bao-ngap-ql1a/</link>
          <description>Mưa lớn gây ngập cục bộ trên Quốc lộ 1A qua Phường Trấn Biên, lực lượng CSGT phân luồng.</description>
          <pubDate>${new Date().toUTCString()}</pubDate>
        </item>
      </channel></rss>`;

    const classifySpy = vi.spyOn(services.gemini, 'classifyOfficialBulletin');
    const mockFetcher = async (url: string): Promise<Response> => {
      if (url.includes('open-meteo.com')) {
        return new Response(JSON.stringify(mockWeatherPayload), { status: 200 });
      }
      if (url.includes('baodongnai.com.vn')) {
        return new Response(mockRssXml, { status: 200 });
      }
      return new Response('<rss><channel></channel></rss>', { status: 200 });
    };

    const run1 = await services.aggregator.syncAll({ fetcher: mockFetcher });
    expect(run1.weatherZonesUpdated).toBe(9);
    expect(run1.weatherAlertsTriggered).toBeGreaterThanOrEqual(1);
    expect(run1.bulletinsSaved).toBe(1);
    expect(classifySpy).toHaveBeenCalledTimes(1);

    // Chạy lại với cùng bài RSS -> sourceUrlHash trùng khớp nên không được gọi Gemini lần 2
    const run2 = await services.aggregator.syncAll({ skipWeather: true, fetcher: mockFetcher });
    expect(run2.bulletinsSaved).toBe(0);
    expect(classifySpy).toHaveBeenCalledTimes(1);
    classifySpy.mockRestore();

    const wApi = await apiCall('/api/weather');
    expect(wApi.status).toBe(200);
    expect(wApi.data.items.length).toBe(9);

    const d1 = await apiCall('/api/ai/daily-digest');
    expect(d1.status).toBe(200);
    expect(d1.data.bullets.length).toBeGreaterThan(0);

    const d2 = await apiCall('/api/ai/daily-digest');
    expect(d2.status).toBe(200);
    expect(d2.data.cached).toBe(true);
  });

  it('6. Geo-Clustering Auto-Escalation (>= 3 người báo trong 500m) + Ward Overview + Route Check + SecurityAuditLogs', async () => {
    // Chèn 3 tài khoản và 3 report gần nhau qua service/repo để kiểm thử logic cluster không phụ thuộc code OTP random
    const users = [
      { id: 'u_cl_1', role: 'citizen' as const, name: 'Công dân A', phone: '0911000001' },
      { id: 'u_cl_2', role: 'citizen' as const, name: 'Công dân B', phone: '0911000002' },
      { id: 'u_cl_3', role: 'citizen' as const, name: 'Công dân C', phone: '0911000003' },
    ];
    for (const u of users) {
      await services.repos.users.save({
        id: u.id,
        role: u.role,
        name: u.name,
        phone: u.phone,
        email: null,
        staffCode: null,
        passwordHash: null,
        wardCode: 'DN-TB',
        unitCode: null,
        ...services.trust.newUserDefaults(),
        createdAt: new Date().toISOString(),
      });
    }

    const coords = [
      { lat: 10.9465, lng: 106.8243 },
      { lat: 10.9488, lng: 106.8243 }, // ~255m Bắc (trong cụm 500m, ngoài vùng đối chiếu CV 200m)
      { lat: 10.9465, lng: 106.8267 }, // ~262m Đông (trong cụm 500m, ngoài vùng đối chiếu CV 200m)
    ];
    const dHashHex = ['a53c9e17b248d06f', '1f80e34c9a275db0', 'c2719d046e8ab351'];
    for (let i = 0; i < 3; i++) {
      const userObj = await services.repos.users.get(users[i].id);
      const dataUrl = await makeRealisticPhotoDataUrl(i + 1);
      const parsed = parsePhotoDataUrlFn(dataUrl);
      const r = await services.reports.create(userObj!, {
        idempotencyKey: `cluster-e2e-report-${i}-${Date.now()}`,
        category: 'ngap_nuoc',
        title: `Ngập nước ngã ba Trấn Biên #${i + 1}`,
        description: 'Nước dâng cao cản trở xe máy trên Quốc lộ 1A đoạn Trấn Biên',
        lat: coords[i].lat,
        lng: coords[i].lng,
        wardCode: 'DN-TB',
        address: 'Quốc lộ 1A, Phường Trấn Biên, Đồng Nai',
        photoInput: {
          dataUrl,
          buffer: parsed.buffer,
          dHash: dHashHex[i],
        },
        exif: {
          capturedAt: new Date().toISOString(),
          cameraMake: 'Apple',
          cameraModel: 'iPhone 15',
          gps: { lat: coords[i].lat, lng: coords[i].lng, inBounds: true },
        },
        edge: {
          blurScore: 145,
          brightness: 128,
          flatRatio: 0.12,
          aspect: 360 / 280,
          sharpEdgeDensity: 0.16,
          likelyScreenshot: false,
          screenshotConfidence: 0.05,
        },
        leftScene: false,
        seniorSubmitted: false,
      });
      expect(r.report.wardCode).toBe('DN-TB');
    }

    const alertsRes = await apiCall('/api/alerts?wardId=DN-TB');
    expect(alertsRes.status).toBe(200);
    const clusterAlert = alertsRes.data.items.find((a: any) => a.sourceType === 'community_cluster');
    expect(clusterAlert).toBeDefined();
    expect(clusterAlert.sourceLabel).toContain('Cảnh báo cộng đồng');
    expect(clusterAlert.radiusM).toBe(500);

    // Ward Overview thật 100%
    const wardOv = await apiCall('/api/wards/DN-TB/overview');
    expect(wardOv.status).toBe(200);
    expect(wardOv.data.ward.wardCode).toBe('DN-TB');
    expect(wardOv.data.stats30d.totalReports).toBeGreaterThanOrEqual(3);
    expect(wardOv.data.heatmapPoints.length).toBeGreaterThanOrEqual(3);
    expect(wardOv.data.alerts.length).toBeGreaterThanOrEqual(1);

    // Route Check QL1A
    const routeRes = await apiCall('/api/alerts/route-check?road=QL1A');
    expect(routeRes.status).toBe(200);
    expect(routeRes.data.status).not.toBe('clear');
    expect(routeRes.data.activeAlerts.length).toBeGreaterThanOrEqual(1);

    // Admin đăng nhập -> Tạo Alert đường thi công (Polyline) -> Sửa -> Xóa (Reauth) -> Kiểm tra SecurityAuditLogs
    const loginRes = await apiCall<{ token: string }>('/api/auth/staff/login', {
      body: { staffCode: adminCode, password: adminPassword },
    });
    expect(loginRes.status).toBe(200);
    const adminToken = loginRes.data.token;

    const createAlertRes = await apiCall('/api/admin/alerts', {
      method: 'POST',
      token: adminToken,
      body: {
        title: 'Thi công thảm nhựa đường Đồng Khởi ban đêm',
        description: 'Rào chắn một phần làn xe cơ giới phục vụ thi công.',
        category: 'traffic',
        severity: 2,
        wardIds: ['DN-TB'],
        affectedRoads: ['Đường Đồng Khởi'],
        detourNote: 'Đi đường Nguyễn Ái Quốc để tránh ùn ứ.',
        geometryType: 'polyline',
        lat: 10.955,
        lng: 106.842,
        polyline: [
          [10.955, 106.842],
          [10.959, 106.847],
        ],
      },
    });
    expect(createAlertRes.status).toBe(201);
    const createdId = createAlertRes.data.id;

    const patchRes = await apiCall(`/api/admin/alerts/${createdId}`, {
      method: 'PATCH',
      token: adminToken,
      body: { status: 'resolved' },
    });
    expect(patchRes.status).toBe(200);
    expect(patchRes.data.status).toBe('resolved');

    const delRes = await apiCall(`/api/admin/alerts/${createdId}`, {
      method: 'DELETE',
      token: adminToken,
      headers: { 'X-Reauth-Password': adminPassword },
    });
    expect(delRes.status).toBe(200);

    const auditLogsRes = await apiCall('/api/admin/security-audit-logs?limit=20', {
      token: adminToken,
    });
    expect(auditLogsRes.status).toBe(200);
    expect(auditLogsRes.data.some((x: any) => x.action === 'admin.alert_create' && x.targetId === createdId)).toBe(true);
    expect(auditLogsRes.data.some((x: any) => x.action === 'admin.alert_delete' && x.targetId === createdId)).toBe(true);
  });
});
