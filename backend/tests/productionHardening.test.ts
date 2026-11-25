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
    // Khởi tạo sẵn kết nối HTTP keep-alive & JIT route trước khi đo độ trễ xử lý thực tế khi chạy song song đa tiến trình
    await fetch(`${base}/healthz`);
    await (
      await fetch(`${base}/api/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: [{ role: 'user', text: 'Xin chào' }], locale: 'vi' }),
      })
    ).text();

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

  it('2. Mặc định AUTO_SEED_DEMO_REPORTS=false chỉ tạo 1 ADMIN & 0 đơn giả; đăng nhập chung (/api/auth/staff/login) hỗ trợ đủ ADMIN, OFFICER, RESCUE & dọn sạch bằng purge-seed', async () => {
    const { INITIAL_STAFF_PASSWORD, INITIAL_SUPER_ADMIN_PASSWORD, seedIfEmpty } = await import('../src/data/seedStore');
    const { env } = await import('../src/config/env');

    // 2A. Khởi tạo mặc định Production: 0 hồ sơ mẫu, đúng 1 tài khoản ADMIN ban đầu
    expect(await services.repos.reports.count()).toBe(0);
    expect(await services.repos.users.count()).toBe(1);

    // 2B. SUPER-ADMIN đăng nhập qua cổng chung không cần truyền unit
    const superRes = await fetch(`${base}/api/auth/staff/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: env.superAdminCode,
        password: INITIAL_SUPER_ADMIN_PASSWORD,
      }),
    });
    expect(superRes.status).toBe(200);
    const superJson = (await superRes.json()) as { token: string; user: { role: string; roleCode: string } };
    expect(superJson.token).toBeTruthy();
    expect(superJson.user.role).toBe('admin');
    expect(superJson.user.roleCode).toBe('ADMIN');

    // 2C. Nạp thử dữ liệu mẫu rồi kiểm tra đăng nhập chung cho TP-01 (ADMIN), CB-TB-01 (OFFICER), CUUHO-01 (RESCUE)
    await seedIfEmpty(services.repos, services.audit, { includeFixtures: true });
    expect(await services.repos.reports.count()).toBe(80);

    const cityRes = await fetch(`${base}/api/auth/staff/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: 'TP-01',
        password: INITIAL_STAFF_PASSWORD,
      }),
    });
    expect(cityRes.status).toBe(200);
    const cityJson = (await cityRes.json()) as { user: { role: string } };
    expect(cityJson.user.role).toBe('admin');

    const officerRes = await fetch(`${base}/api/auth/staff/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: 'CB-TB-01',
        password: INITIAL_STAFF_PASSWORD,
      }),
    });
    expect(officerRes.status).toBe(200);
    const officerJson = (await officerRes.json()) as { user: { role: string; wardCode: string } };
    expect(officerJson.user.role).toBe('officer');
    expect(officerJson.user.wardCode).toBe('DN-TB');

    const rescueRes = await fetch(`${base}/api/auth/staff/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: 'CUUHO-01',
        password: INITIAL_STAFF_PASSWORD,
      }),
    });
    expect(rescueRes.status).toBe(200);
    const rescueJson = (await rescueRes.json()) as { user: { role: string; roleCode: string } };
    expect(rescueJson.user.role).toBe('rescue');
    expect(rescueJson.user.roleCode).toBe('RESCUE');

    // 2D. Gọi API dọn sạch dữ liệu mẫu -> yêu cầu Re-auth khi thiếu, thực thi xóa sạch khi có X-Reauth-Password
    const unauthPurge = await fetch(`${base}/api/admin/maintenance/purge-seed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${superJson.token}` },
      body: JSON.stringify({}),
    });
    expect(unauthPurge.status).toBe(403);

    const purgeRes = await fetch(`${base}/api/admin/maintenance/purge-seed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${superJson.token}`,
        'X-Reauth-Password': INITIAL_STAFF_PASSWORD,
      },
      body: JSON.stringify({}),
    });
    expect(purgeRes.status).toBe(200);
    const purgeJson = (await purgeRes.json()) as { deletedReports: number; remainingReports: number; wardsPreserved: number };
    expect(purgeJson.deletedReports).toBe(80);
    expect(purgeJson.remainingReports).toBe(0);
    expect(purgeJson.wardsPreserved).toBe(95);
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

  it('4. KeyPool parse đa định dạng (dấu phẩy, xuống dòng, khoảng trắng, dấu ngoặc kép): chỉ AIzaSy* -> AI Studio, AQ.* -> Vertex kèm cảnh báo', async () => {
    const calledEndpoints: string[] = [];
    const poolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-keypool-vertex-'));
    try {
      const multiFormatRaw = [
        '"AQ.Ab8RN6StudioKeyNewFormat12345"',
        'AIzaSyDisabledStudioKey111111111111\\nAIzaSyHealthyStudioKey9876543210000',
        '   vertex:AQ.Ab8RN6ExplicitVertexKey22222 ; AIzaSyHealthyStudioKey9876543210000 ',
      ].join(',\n');

      const warnings: string[] = [];
      const pool = new KeyPoolManager({
        dataDir: poolDir,
        encryptionSecret: 'test-secret-32-bytes-minimum-key!!',
        envSource: {
          GEMINI_API_KEYS: multiFormatRaw,
          VERTEX_API_KEYS: 'AQ.Ab8RN6EnvVertexPoolKey33333',
          GEMINI_MODEL: 'gemini-3.8-flash',
        },
        logger: {
          info: () => undefined,
          warn: (m) => warnings.push(m),
          error: () => undefined,
        },
      });
      await pool.init();
      const snap = await pool.listMaskedKeys();
      // Đúng 5 key duy nhất sau khi tách đa định dạng và lọc trùng
      expect(snap.summary.totalKeys).toBe(5);
      // AQ.* phải được phân loại sang Vertex thay vì gán nhầm AI Studio; chỉ AIzaSy* mới là ai_studio
      expect(snap.keys.find((k) => k.maskedKey.endsWith('2345'))?.geminiEndpoint).toBe('vertex');
      expect(snap.keys.find((k) => k.maskedKey.endsWith('0000'))?.geminiEndpoint).toBe('ai_studio');
      expect(snap.keys.find((k) => k.maskedKey.endsWith('2222'))?.geminiEndpoint).toBe('vertex');
      expect(snap.keys.find((k) => k.maskedKey.endsWith('3333'))?.geminiEndpoint).toBe('vertex');
      expect(warnings.some((w) => w.includes('2345'))).toBe(true);

      const out = await pool.executeWithRotation(async (apiKey, meta) => {
        if (meta.geminiEndpoint === 'vertex') {
          calledEndpoints.push(`vertex:${apiKey.slice(0, 6)}`);
          throw Object.assign(
            new Error('[{"error":{"code":403,"message":"Vertex key revoked","status":"PERMISSION_DENIED"}}]'),
            { status: 403 },
          );
        }
        if (apiKey.includes('DisabledStudioKey')) {
          calledEndpoints.push('ai_studio:disabled');
          throw Object.assign(new Error('403 API_KEY_INVALID: Key revoked'), { status: 403 });
        }
        calledEndpoints.push(`ai_studio:${apiKey.slice(0, 6)}`);
        return 'OK_FROM_HEALTHY_AI_STUDIO_KEY';
      });

      expect(out).toBe('OK_FROM_HEALTHY_AI_STUDIO_KEY');
      expect(calledEndpoints.some((e) => e.startsWith('ai_studio:AIzaSy'))).toBe(true);
      expect(calledEndpoints.some((e) => e.startsWith('vertex:AQ.Ab8'))).toBe(true);
    } finally {
      fs.rmSync(poolDir, { recursive: true, force: true });
    }
  });

  it('5. SMS OTP trả SMS_PROVIDER_NOT_CONFIGURED (503) khi chưa cấu hình và giới hạn tối đa 5 lần / 15 phút / IP', async () => {
    services.phoneOtp.resetMemory();
    const failRes = await fetch(`${base}/api/auth/otp/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.99.0.1' },
      body: JSON.stringify({ channel: 'phone', phone: '0912345678' }),
    });
    expect(failRes.status).toBe(503);
    const failBody = (await failRes.json()) as { error: { code: string; message: string } };
    expect(failBody.error.code).toBe('SMS_PROVIDER_NOT_CONFIGURED');
    expect((failBody as { devOtpPreview?: unknown }).devOtpPreview).toBeUndefined();

    services.phoneOtp.smsDispatcher.setOverrideProvider({
      name: 'android_gateway',
      isConfigured: () => true,
      send: async () => ({ provider: 'android_gateway', delivered: true, messageId: 'ok' }),
    });
    try {
      const phones = ['0911000001', '0911000002', '0911000003', '0911000004', '0911000005'];
      for (const ph of phones) {
        const res = await fetch(`${base}/api/auth/otp/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.99.0.55' },
          body: JSON.stringify({ channel: 'phone', phone: ph }),
        });
        expect(res.status).toBe(200);
      }
      const blockedIpRes = await fetch(`${base}/api/auth/otp/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.99.0.55' },
        body: JSON.stringify({ channel: 'phone', phone: '0911000006' }),
      });
      expect(blockedIpRes.status).toBe(429);
    } finally {
      services.phoneOtp.smsDispatcher.setOverrideProvider(null);
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

  it('7. Không còn chuỗi debug/demo/kỹ thuật thừa trong frontend/src/', () => {
    const frontendSrc = path.resolve(__dirname, '../../frontend/src');
    const forbidden = [
      'trước Giờ Demo',
      'trước giờ demo',
      'Self-Test',
      '$nearSphere',
      'nearSphereMatched',
      'ALLOW_CLOUD_AI_FALLBACK',
      'Mock Fallback',
      'CHỌN NHANH ĐƠN VỊ',
      'thử nghiệm',
      'dữ liệu mẫu',
      'DEMO_MAP_ID',
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
