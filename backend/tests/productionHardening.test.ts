import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Services } from '../src/services/container';
import { MultiTierGeocodeService } from '../src/services/geocode';
import { KeyPoolManager } from '../src/services/keyPool';
import { runSharpAuthenticityCheck, runSharpBeforeAfterVerify } from '../src/services/localCvPipeline';
import sharp from 'sharp';

describe('Production Hardening: Zero-Downtime SQLite Fallback, <100ms Local AI, Geocoding, KeyPool & Clean UI', () => {
  let base = '';
  let dir = '';
  let services: Services;
  let closeServer: () => Promise<void> = async () => undefined;
  let stopResilient: () => Promise<void> = async () => undefined;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-prod-hardening-'));
    process.env.DATA_DIR = dir;
    process.env.NODE_ENV = 'test';
    process.env.MONGODB_URI = '';
    process.env.GEMINI_API_KEY = '';
    process.env.GEMINI_API_KEYS = '';
    process.env.ALLOW_DEMO_OTP = 'false';

    const { createNonBlockingServerRepositories } = await import('../src/repositories');
    const { createServices } = await import('../src/services/container');
    const { seedIfEmpty } = await import('../src/data/seedStore');
    const { createApp } = await import('../src/app');

    // Khởi tạo qua đúng kiến trúc Dual-Layer SQLite WAL đang dùng cho Production trên Render
    const resilient = createNonBlockingServerRepositories();
    stopResilient = resilient.stop;
    services = createServices(resilient.boot.repos);
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
    await new Promise((r) => setTimeout(r, 250));
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* bỏ qua nếu tiến trình Windows giải phóng file WAL chậm */
    }
  });

  it('1. Chatbot trả lời câu "Cách gửi phản ánh?" trong <100ms ngay cả khi không có MongoDB', async () => {
    // Khởi tạo sẵn kết nối HTTP keep-alive tới loopback trước khi đo độ trễ xử lý thực tế
    await fetch(`${base}/healthz`);

    const t0 = performance.now();
    const res = await fetch(`${base}/api/ai/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', text: 'Cách gửi phản ánh?' }],
        locale: 'vi',
      }),
    });
    const sseBody = await res.text();
    const elapsedMs = performance.now() - t0;
    console.info(`[benchmark] Chatbot "Cách gửi phản ánh?" HTTP SSE latency = ${elapsedMs.toFixed(2)}ms`);

    expect(res.status).toBe(200);
    expect(elapsedMs).toBeLessThan(100);
    expect(sseBody).toContain('3 bước');
    expect(sseBody).toContain('"done":true');
    expect(sseBody).not.toMatch(/MongooseServerSelectionError|NETWORK_OR_IP_WHITELIST/i);
  });

  it('2. Đăng nhập SUPER-ADMIN, TP-01, CB-TB-01 và CUUHO-01 thành công 100% trên lớp Resilient Local Persistence', async () => {
    const { INITIAL_STAFF_PASSWORD, INITIAL_SUPER_ADMIN_PASSWORD } = await import('../src/data/seedStore');
    const { env } = await import('../src/config/env');

    // SUPER-ADMIN
    const superRes = await fetch(`${base}/api/auth/staff/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        staffCode: env.superAdminCode,
        password: INITIAL_SUPER_ADMIN_PASSWORD,
        unit: 'city',
      }),
    });
    expect(superRes.status).toBe(200);
    const superJson = (await superRes.json()) as { token: string; user: { role: string } };
    expect(superJson.token).toBeTruthy();
    expect(superJson.user.role).toBe('super_admin');

    // TP-01
    const cityRes = await fetch(`${base}/api/auth/staff/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        staffCode: 'TP-01',
        password: INITIAL_STAFF_PASSWORD,
        unit: 'city',
      }),
    });
    expect(cityRes.status).toBe(200);

    // CB-TB-01 (Cán bộ Phường Trấn Biên)
    const officerRes = await fetch(`${base}/api/auth/staff/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        staffCode: 'CB-TB-01',
        password: INITIAL_STAFF_PASSWORD,
        unit: 'DN-TB',
      }),
    });
    expect(officerRes.status).toBe(200);
    const officerJson = (await officerRes.json()) as { token: string; user: { wardCode: string } };
    expect(officerJson.user.wardCode).toBe('DN-TB');

    // CUUHO-01 (Đội Cứu Hộ Hiện Trường)
    const rescueRes = await fetch(`${base}/api/auth/rescue/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: 'CUUHO-01',
        password: INITIAL_STAFF_PASSWORD,
      }),
    });
    expect(rescueRes.status).toBe(200);
    const rescueJson = (await rescueRes.json()) as { token: string; user: { role: string } };
    expect(rescueJson.user.role).toBe('rescue_team');
  });

  it('3. Reverse Geocoding đa tầng trả về địa chỉ cụ thể (Số nhà + Đường + Khu phố + Phường Trấn Biên, Thành phố Đồng Nai) và cache 5 chữ số thập phân', async () => {
    let fetchCount = 0;
    const mockFetch = vi.fn(async (url: string | URL | Request) => {
      fetchCount += 1;
      expect(String(url)).toContain('nominatim.openstreetmap.org/reverse');
      return new Response(
        JSON.stringify({
          display_name: '128 Đường Võ Thị Sáu, Khu phố 7, Phường Thống Nhất, Biên Hòa, Đồng Nai',
          address: {
            house_number: '128',
            road: 'Đường Võ Thị Sáu',
            quarter: 'Khu phố 7',
            suburb: 'Phường Thống Nhất',
            city: 'Biên Hòa',
            state: 'Đồng Nai',
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const geocoder = new MultiTierGeocodeService(mockFetch);
    const r1 = await geocoder.reverseGeocode(10.94651, 106.82431);
    expect(r1.inBounds).toBe(true);
    expect(r1.wardCode).toBe('DN-TB');
    expect(r1.wardName).toBe('Phường Trấn Biên');
    expect(r1.address).toContain('128 Đường Võ Thị Sáu');
    expect(r1.address).toContain('Khu phố 7');
    expect(r1.address).toContain('Phường Trấn Biên, Thành phố Đồng Nai');
    expect(fetchCount).toBe(1);

    // Gọi lại trong cùng ô 5 chữ số thập phân (10.946514 -> 10.94651) phải lấy tức thì từ cache 0 lần gọi mạng mới
    const tCache = performance.now();
    const r2 = await geocoder.reverseGeocode(10.946514, 106.824312);
    expect(performance.now() - tCache).toBeLessThan(5);
    expect(r2.address).toBe(r1.address);
    expect(fetchCount).toBe(1);
  });

  it('4. KeyPool hỗ trợ cả AQ.* (Vertex AI Express) lẫn AIza* (AI Studio) và tự xoay sang key hợp lệ khi 401/404', async () => {
    const calledUrls: string[] = [];
    const poolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-keypool-vertex-'));
    try {
      const pool = new KeyPoolManager({
        dataDir: poolDir,
        encryptionSecret: 'test-secret-32-bytes-minimum-key!!',
        envSource: {
          GEMINI_API_KEYS: 'AQ.Ab8RN6InvalidVertexKey12345678,AIzaSyValidStudioKey9876543210000',
          GEMINI_MODEL: 'gemini-3.5-flash',
        },
      });

      const out = await pool.executeWithRotation(async (apiKey) => {
        if (apiKey.startsWith('AQ.')) {
          calledUrls.push(`https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash:generateContent?key=${apiKey}`);
          throw Object.assign(new Error('401 API keys are not supported by this endpoint'), { status: 401 });
        }
        calledUrls.push(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent`);
        return 'OK_FROM_AIZA_KEY';
      });

      expect(out).toBe('OK_FROM_AIZA_KEY');
      expect(calledUrls).toHaveLength(2);
      expect(calledUrls[0]).toContain('aiplatform.googleapis.com');
      expect(calledUrls[1]).toContain('generativelanguage.googleapis.com');
    } finally {
      fs.rmSync(poolDir, { recursive: true, force: true });
    }
  });

  it('5. SMS OTP không báo gửi thành công giả khi chưa cấu hình SMS, và hỗ trợ test an toàn khi ALLOW_DEMO_OTP=true', async () => {
    services.phoneOtp.resetMemory();
    process.env.ALLOW_DEMO_OTP = 'false';
    const failRes = await fetch(`${base}/api/auth/otp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.99.0.1' },
      body: JSON.stringify({ channel: 'phone', phone: '0912345678' }),
    });
    expect(failRes.status).toBe(503);
    const failBody = (await failRes.json()) as { error: { code: string; message: string } };
    expect(failBody.error.code).toBe('sms_provider_not_configured');

    // Khi bật ALLOW_DEMO_OTP=true -> trả devOtpPreview và xác thực thành công
    process.env.ALLOW_DEMO_OTP = 'true';
    try {
      const okRes = await fetch(`${base}/api/auth/otp/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.99.0.2' },
        body: JSON.stringify({ channel: 'phone', phone: '0912 345 678' }),
      });
      expect(okRes.status).toBe(200);
      const okBody = (await okRes.json()) as { target: string; devOtpPreview?: string };
      expect(okBody.target).toBe('+84912345678');
      expect(okBody.devOtpPreview).toMatch(/^\d{6}$/);

      const verifyRes = await fetch(`${base}/api/auth/otp/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.99.0.2' },
        body: JSON.stringify({ channel: 'phone', phone: '0912345678', code: okBody.devOtpPreview }),
      });
      expect(verifyRes.status).toBe(200);
    } finally {
      process.env.ALLOW_DEMO_OTP = 'false';
    }
  });

  it('6. Local CV Pipeline (sharp) xử lý ảnh cực nhanh và tách biệt sceneMatchScore + resolutionScore', async () => {
    const beforeBuf = await sharp({
      create: { width: 320, height: 240, channels: 3, background: { r: 165, g: 120, b: 95 } },
    })
      .composite([
        {
          input: await sharp({
            create: { width: 120, height: 90, channels: 3, background: { r: 30, g: 30, b: 35 } },
          })
            .png()
            .toBuffer(),
          left: 100,
          top: 90,
        },
      ])
      .jpeg({ quality: 82 })
      .toBuffer();

    const afterBuf = await sharp({
      create: { width: 320, height: 240, channels: 3, background: { r: 162, g: 122, b: 98 } },
    })
      .jpeg({ quality: 82 })
      .toBuffer();

    const beforeDataUrl = `data:image/jpeg;base64,${beforeBuf.toString('base64')}`;
    const afterDataUrl = `data:image/jpeg;base64,${afterBuf.toString('base64')}`;

    const auth = await runSharpAuthenticityCheck(beforeDataUrl, 45);
    expect(auth).not.toBeNull();
    expect(auth.latency_ms).toBeLessThan(250);

    const ba = await runSharpBeforeAfterVerify({
      beforeBase64: beforeDataUrl,
      afterBase64: afterDataUrl,
      category: 'mat_duong',
      sceneMatchThreshold: 55,
      resolutionThreshold: 55,
    });
    expect(ba).not.toBeNull();
    expect(typeof ba.scene_match_score).toBe('number');
    expect(typeof ba.resolution_score).toBe('number');
  });

  it('7. Không còn chuỗi kỹ thuật ($nearSphere, INITIAL_STAFF_PASSWORD, (/rescue/login), "OTP thật") trong frontend/src/', () => {
    const frontendSrc = path.resolve(__dirname, '../../frontend/src');
    const forbidden = [
      '$nearSphere',
      'nearSphereMatched',
      'INITIAL_STAFF_PASSWORD',
      '(/rescue/login)',
      '→ /rescue/login',
      'OTP thật',
      'dữ liệu thật',
      'xác thực thật',
      'MongoDB Atlas',
      'NETWORK_OR_IP_WHITE',
      'MongooseServerSelectionError',
    ];

    function collectFiles(dirPath: string): string[] {
      const out: string[] = [];
      for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
        const full = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'tests') continue;
          out.push(...collectFiles(full));
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
          out.push(full);
        }
      }
      return out;
    }

    const leaks: string[] = [];
    for (const file of collectFiles(frontendSrc)) {
      const content = fs.readFileSync(file, 'utf8');
      for (const token of forbidden) {
        if (content.includes(token)) {
          leaks.push(`${path.relative(frontendSrc, file)}: "${token}"`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });
});
