import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiKey } from '../src/models/ApiKey';
import { runKeyPoolVerificationSuite } from '../src/services/keyPool/__tests__/keyPool.test';

describe('KeyPoolManager — Xoay vòng 10 Key, Cooldown Backoff, RPD Reset & AES-256-GCM', () => {
  it('vượt qua trọn vẹn bộ kiểm thử mô phỏng 10 key, 429 Cooldown 1m->3m->10m, RPD 00:00 và AES-256-GCM', async () => {
    await runKeyPoolVerificationSuite();
  });

  it('ApiKey Mongoose Schema ẩn hoàn toàn trường mã hóa khi serialize toJSON()', () => {
    const doc = new ApiKey({
      keyId: 'ak_schema_test_01',
      label: 'Gemini Key #1',
      provider: 'gemini',
      encryptedKey: 'v1:aXYxMjM0NTY3ODkw:dGFnMTIzNDU2Nzg5MDEy:Y2lwaGVydGV4dA==',
      iv: 'aXYxMjM0NTY3ODkw',
      authTag: 'dGFnMTIzNDU2Nzg5MDEy',
      keyFingerprint: 'a'.repeat(64),
      maskedKey: 'AIzaSy...9xQp',
      weight: 2,
      isEnabled: true,
      status: 'HEALTHY',
    });
    expect(doc.validateSync()).toBeUndefined();
    const json = JSON.stringify(doc.toJSON());
    expect(json).toContain('AIzaSy...9xQp');
    expect(json).not.toContain('encryptedKey');
    expect(json).not.toContain('authTag');
    expect(json).not.toContain('Y2lwaGVydGV4dA==');
  });
});

describe('Admin API `/api/admin/api-keys` — Bảo mật RBAC, Bulk Import AES-256-GCM & Quản lý vòng đời Key', () => {
  let base = '';
  let dir = '';
  let close: () => Promise<void> = async () => undefined;
  let cityToken = '';
  let wardToken = '';

  const bulkKeys = Array.from(
    { length: 10 },
    (_, idx) => `AIzaSyAdminBulkKey_${String(idx + 1).padStart(2, '0')}_z${String(idx + 1).padStart(3, '0')}`,
  );
  const openRouterKey = 'sk-or-v1-99887766554433221100aabbccddeeff_or99';
  const groqKey = 'gsk_11223344556677889900aabbccddeeff_gq88';

  async function apiCall<T = any>(
    endpoint: string,
    init: { method?: string; body?: unknown; token?: string } = {},
  ): Promise<{ status: number; data: T }> {
    const res = await fetch(`${base}${endpoint}`, {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers: {
        'Content-Type': 'application/json',
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-keypool-api-'));
    process.env.DATA_DIR = dir;
    process.env.NODE_ENV = 'test';
    process.env.GEMINI_API_KEY = '';
    process.env.GEMINI_API_KEYS = '';
    process.env.KEY_ENCRYPTION_SECRET =
      '9f8e7d6c5b4a39281716151413121110fedcba9876543210abcdef0123456789';
    process.env.MONGODB_URI = '';

    const { createRepositories } = await import('../src/repositories');
    const { createServices } = await import('../src/services/container');
    const { INITIAL_STAFF_PASSWORD, seedIfEmpty } = await import('../src/data/seedStore');
    const { createApp } = await import('../src/app');

    const boot = await createRepositories();
    const s = createServices(boot.repos);

    // Gắn mock probe để kiểm thử endpoint POST /api/admin/api-keys/:id/test không phụ thuộc mạng ngoài
    s.keyPool.setProbeFn(async (rawKey, meta) => {
      if (rawKey.endsWith('_z002')) {
        throw Object.assign(new Error('429 Too Many Requests (Simulated RPM)'), { status: 429 });
      }
      if (rawKey.endsWith('_z003')) {
        throw Object.assign(new Error('403 API_KEY_INVALID: Key revoked'), { status: 403 });
      }
      return { ok: true, detail: `Mock probe OK for ${meta.provider}` };
    });

    await s.keyPool.init();
    await seedIfEmpty(boot.repos, s.audit, { includeFixtures: true });
    const server = createApp(s, boot).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const cityLogin = await apiCall<{ token: string }>('/api/auth/staff/login', {
      body: { staffCode: 'TP-01', password: INITIAL_STAFF_PASSWORD, unit: 'city' },
    });
    expect(cityLogin.status).toBe(200);
    cityToken = cityLogin.data.token;

    const wardLogin = await apiCall<{ token: string }>('/api/auth/staff/login', {
      body: { staffCode: 'CB-TB-01', password: INITIAL_STAFF_PASSWORD, unit: 'DN-TB' },
    });
    expect(wardLogin.status).toBe(200);
    wardToken = wardLogin.data.token;

    close = async () => {
      await new Promise((r) => server.close(r));
      await boot.repos.close();
    };
  });

  afterAll(async () => {
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('chặn truy cập trái phép (401 khi thiếu token, 403 khi là cán bộ phường WARD_OFFICER)', async () => {
    const unauth = await apiCall('/api/admin/api-keys');
    expect(unauth.status).toBe(401);

    const forbiddenWard = await apiCall('/api/admin/api-keys', { token: wardToken });
    expect(forbiddenWard.status).toBe(403);
  });

  it('POST /api/admin/api-keys cho phép dán hàng loạt 12 key (Gemini + OpenRouter + Groq), mã hóa AES-256-GCM và chống lộ raw key ở GET', async () => {
    const pastedText = [...bulkKeys, openRouterKey, groqKey, bulkKeys[0]].join('\n');
    const created = await apiCall<any>('/api/admin/api-keys', {
      token: cityToken,
      body: { keysText: pastedText, labelPrefix: 'Pool Đồng Nai' },
    });

    expect(created.status).toBe(201);
    expect(created.data.addedCount).toBe(12);
    expect(created.data.skippedDuplicateCount).toBe(0); // Khử trùng ngay trong parseBulkApiKeys

    // Gửi trùng lại key đầu tiên -> báo skippedDuplicateCount = 1
    const dupRes = await apiCall<any>('/api/admin/api-keys', {
      token: cityToken,
      body: { apiKey: bulkKeys[0] },
    });
    expect(dupRes.status).toBe(200);
    expect(dupRes.data.addedCount).toBe(0);
    expect(dupRes.data.skippedDuplicateCount).toBe(1);

    // Kiểm tra file lưu trữ chỉ chứa bản mã AES-256-GCM (v1:...), KHÔNG chứa bất kỳ raw key nào
    const encryptedDiskContent = fs.readFileSync(path.join(dir, 'api_keys.encrypted.json'), 'utf8');
    expect(encryptedDiskContent).toContain('v1:');
    for (const raw of [...bulkKeys, openRouterKey, groqKey]) {
      expect(encryptedDiskContent).not.toContain(raw);
    }

    // Kiểm tra GET /api/admin/api-keys chỉ trả maskedKey dạng AIzaSy...z001
    const listRes = await apiCall<any>('/api/admin/api-keys', { token: cityToken });
    expect(listRes.status).toBe(200);
    expect(listRes.data.summary.totalKeys).toBe(12);
    expect(listRes.data.summary.healthyKeys).toBe(12);
    expect(listRes.data.summary.byProvider.gemini.total).toBe(10);
    expect(listRes.data.summary.byProvider.openrouter.total).toBe(1);
    expect(listRes.data.summary.byProvider.groq.total).toBe(1);

    const serializedGet = JSON.stringify(listRes.data);
    for (const raw of [...bulkKeys, openRouterKey, groqKey]) {
      expect(serializedGet).not.toContain(raw);
    }
    expect(serializedGet).not.toContain('encryptedKey');
    expect(listRes.data.keys[0].maskedKey).toBe('AIzaSy...z001');
  });

  it('POST /:id/test, PATCH /:id (isEnabled & resetCooldown) và DELETE /:id hoạt động chuẩn xác kèm Audit Log', async () => {
    const list = (await apiCall<any>('/api/admin/api-keys', { token: cityToken })).data.keys as any[];
    const k1 = list[0];
    const k2 = list[1];
    const k3 = list[2];

    // Test key #1 -> HEALTHY
    const t1 = await apiCall<any>(`/api/admin/api-keys/${k1.id}/test`, {
      method: 'POST',
      token: cityToken,
    });
    expect(t1.status).toBe(200);
    expect(t1.data.ok).toBe(true);
    expect(t1.data.status).toBe('HEALTHY');

    // Test key #2 (mô phỏng 429) -> COOLDOWN
    const t2 = await apiCall<any>(`/api/admin/api-keys/${k2.id}/test`, {
      method: 'POST',
      token: cityToken,
    });
    expect(t2.status).toBe(200);
    expect(t2.data.ok).toBe(false);
    expect(t2.data.status).toBe('COOLDOWN');

    // Test key #3 (mô phỏng 403) -> INVALID
    const t3 = await apiCall<any>(`/api/admin/api-keys/${k3.id}/test`, {
      method: 'POST',
      token: cityToken,
    });
    expect(t3.status).toBe(200);
    expect(t3.data.ok).toBe(false);
    expect(t3.data.status).toBe('INVALID');

    // PATCH resetCooldown cho key #2 và tắt isEnabled cho key #3
    const resetK2 = await apiCall<any>(`/api/admin/api-keys/${k2.id}`, {
      method: 'PATCH',
      token: cityToken,
      body: { resetCooldown: true, weight: 3 },
    });
    expect(resetK2.status).toBe(200);
    expect(resetK2.data.status).toBe('HEALTHY');
    expect(resetK2.data.cooldownUntil).toBeNull();
    expect(resetK2.data.weight).toBe(3);

    const disableK3 = await apiCall<any>(`/api/admin/api-keys/${k3.id}`, {
      method: 'PATCH',
      token: cityToken,
      body: { isEnabled: false },
    });
    expect(disableK3.status).toBe(200);
    expect(disableK3.data.isEnabled).toBe(false);

    // DELETE key #3
    const delK3 = await apiCall<any>(`/api/admin/api-keys/${k3.id}`, {
      method: 'DELETE',
      token: cityToken,
    });
    expect(delK3.status).toBe(200);
    expect(delK3.data.deleted).toBe(true);

    const afterDelete = await apiCall<any>('/api/admin/api-keys', { token: cityToken });
    expect(afterDelete.data.summary.totalKeys).toBe(11);

    // Chuỗi băm AuditLog vẫn toàn vẹn tuyệt đối và không lộ raw key
    const auditVerify = await apiCall<any>('/api/admin/audit/verify', { token: cityToken });
    expect(auditVerify.data).toMatchObject({ valid: true, brokenAtSeq: null });
  });
});

describe('Cloud AI Routing & Fallback Chain (AQ.* AI Studio, 404 Model Chain, 503 Cooldown)', () => {
  it('GeminiService & VisionAnalyzerService dùng key AQ.* qua AI Studio (x-goog-api-key), đổi model khi 404, cooldown khi 503, giữ responseSchema và bỏ thinkingBudget', async () => {
    const { KeyPoolManager } = await import('../src/services/keyPool');
    const { GeminiService } = await import('../src/services/gemini.service');

    const prevFetch = globalThis.fetch;
    const prevAllowCloud = process.env.ALLOW_CLOUD_AI_FALLBACK;
    process.env.ALLOW_CLOUD_AI_FALLBACK = 'true';

    const requests: Array<{ url: string; headerKey: string | null; body: Record<string, any> }> = [];
    let attempt = 0;

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes('googleapis.com')) {
        return prevFetch(input, init);
      }
      const headers = new Headers(init?.headers);
      const parsedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>;
      requests.push({
        url,
        headerKey: headers.get('x-goog-api-key'),
        body: parsedBody,
      });
      attempt += 1;

      // Request 1: key #1 (AQ.*) chạm 503 Overloaded -> cooldown 60s và xoay sang key #2 (AIzaSy*)
      if (attempt === 1) {
        return new Response(
          JSON.stringify({ error: { code: 503, message: 'Model overloaded', status: 'UNAVAILABLE' } }),
          { status: 503 },
        );
      }
      // Request 2: key #2 (AIzaSy*) gặp 404 trên gemini-3.5-flash-lite -> giữ nguyên key #2, chuyển sang gemini-3.6-flash
      if (url.includes('gemini-3.5-flash-lite')) {
        return new Response(
          JSON.stringify({ error: { code: 404, message: 'models/gemini-3.5-flash-lite is not found', status: 'NOT_FOUND' } }),
          { status: 404 },
        );
      }
      // Request 3: key #2 (AIzaSy*) thành công trên gemini-3.6-flash
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      riskSummary: 'Ngập cục bộ trên Quốc lộ 1A cần cảnh giới ngay.',
                      equipmentAndCrew: '01 Tổ Thoát nước đô thị + máy bơm dã chiến.',
                      safetyWarning: 'Cắm cọc tiêu quanh miệng hố ga bị ngập.',
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    try {
      const pool = new KeyPoolManager({
        persistenceMode: 'memory',
        envSource: {
          GEMINI_API_KEYS: 'AQ.Ab8RN6TestStudioKey_001,AIzaSyTestStudioKey_002',
          GEMINI_MODEL: 'gemini-3.5-flash-lite',
        },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      });
      const svc = new GeminiService(pool);

      const briefing = await svc.generateTacticalBriefing({
        category: 'ngap_nuoc',
        title: 'Ngập nước trên Quốc lộ 1A',
        severity: 4,
        wardCode: 'DN-TB',
        forceRefresh: true,
      });

      expect(briefing.mode).toBe('gemini');
      expect(requests.length).toBe(3);
      // Key #1 (AQ.*) phải gọi AI Studio (generativelanguage.googleapis.com) với x-goog-api-key
      expect(requests[0].url).toContain('generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
      expect(requests[0].headerKey).toBe('AQ.Ab8RN6TestStudioKey_001');
      expect(requests[0].body.generationConfig.responseMimeType).toBe('application/json');
      expect(requests[0].body.generationConfig.responseSchema).toBeDefined();
      expect(requests[0].body.generationConfig.thinkingConfig).toBeUndefined();

      // Key #2 (AIzaSy*) gặp 404 ở 3.5-flash-lite -> chuyển sang 3.6-flash trên CÙNG Key #2
      expect(requests[1].headerKey).toBe('AIzaSyTestStudioKey_002');
      expect(requests[1].url).toContain('gemini-3.5-flash-lite');
      expect(requests[2].headerKey).toBe('AIzaSyTestStudioKey_002');
      expect(requests[2].url).toContain('gemini-3.6-flash');

      const snap = await pool.listMaskedKeys();
      expect(snap.keys[0].status).toBe('COOLDOWN');
      expect(snap.keys[1].status).toBe('HEALTHY');

      // Kiểm chứng thêm Stage1 VisionAnalyzerService (gọi Gemini Vision qua AQ.* hoặc AIzaSy* sau khi reset cooldown)
      await pool.updateKey(snap.keys[0].id, { resetCooldown: true });
      const prevCount = requests.length;
      const visionPayload = {
        authenticity: { authenticity_score: 95, is_screen_capture_or_fake: false, forensic_flags: [] },
        moderation: { relevance_score: 92, abuse_risk: 'NONE' },
        classification: {
          standardized_category: 'NGAP_UNG_THOAT_NUOC',
          severity: 'HIGH',
          priority_score: 82,
          suggested_unit: 'Tổ Thoát nước Phường Trấn Biên',
          is_emergency: false,
          safety_hazards: ['Ngập mặt đường'],
        },
        auto_fill: {
          suggested_title: 'Ngập cục bộ mặt đường QL1A',
          suggested_description: 'Nước đọng sâu trên làn xe máy gây ùn ứ nhẹ.',
          key_evidence_tags: ['ngap_nuoc', 'ql1a'],
        },
      };
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (!url.includes('googleapis.com')) return prevFetch(input, init);
        const headers = new Headers(init?.headers);
        const parsedBody = JSON.parse(String(init?.body ?? '{}')) as Record<string, any>;
        requests.push({ url, headerKey: headers.get('x-goog-api-key'), body: parsedBody });
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(visionPayload) }] } }] }),
          { status: 200 },
        );
      }) as typeof fetch;

      const sharp = (await import('sharp')).default;
      const validJpegBuf = await sharp({
        create: { width: 240, height: 240, channels: 3, background: { r: 145, g: 130, b: 120 } },
      })
        .composite([
          {
            input: await sharp({
              create: { width: 80, height: 80, channels: 3, background: { r: 30, g: 45, b: 60 } },
            })
              .png()
              .toBuffer(),
            left: 60,
            top: 60,
          },
        ])
        .jpeg({ quality: 80 })
        .toBuffer();

      const visionOut = await svc.analyzeImage({
        imageBuffer: validJpegBuf,
        imageBase64: validJpegBuf.toString('base64'),
        mimeType: 'image/jpeg',
        dHash: '0123456789abcdef',
        skipDedup: true,
        skipCache: true,
        wardCode: 'DN-TB',
      });
      expect(visionOut.mode).toBe('gemini');
      expect(requests.length).toBe(prevCount + 1);
      expect(requests[prevCount].url).toContain('generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent');
      expect(requests[prevCount].headerKey).toBe('AQ.Ab8RN6TestStudioKey_001');
      expect(requests[prevCount].body.generationConfig.responseMimeType).toBe('application/json');
      expect(requests[prevCount].body.generationConfig.responseSchema).toBeDefined();
      expect(requests[prevCount].body.generationConfig.thinkingConfig).toBeUndefined();
    } finally {
      globalThis.fetch = prevFetch;
      if (prevAllowCloud === undefined) delete process.env.ALLOW_CLOUD_AI_FALLBACK;
      else process.env.ALLOW_CLOUD_AI_FALLBACK = prevAllowCloud;
    }
  });
});
