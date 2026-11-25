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
    init: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; data: T }> {
    const res = await fetch(`${base}${endpoint}`, {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers: {
        'Content-Type': 'application/json',
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
        ...(init.headers ?? {}),
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

    // DELETE key #3 (yêu cầu Re-auth khi thiếu, xóa thành công khi có X-Reauth-Password)
    const delUnauth = await apiCall<any>(`/api/admin/api-keys/${k3.id}`, {
      method: 'DELETE',
      token: cityToken,
    });
    expect(delUnauth.status).toBe(403);

    const { INITIAL_STAFF_PASSWORD } = await import('../src/data/seedStore');
    const delK3 = await apiCall<any>(`/api/admin/api-keys/${k3.id}`, {
      method: 'DELETE',
      token: cityToken,
      headers: { 'X-Reauth-Password': INITIAL_STAFF_PASSWORD },
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

describe('Cloud AI Routing & Fallback Chain (AIzaSy AI Studio, AQ.* Vertex, 404 Model Chain, 503 Cooldown)', () => {
  it('GeminiService & VisionAnalyzerService dùng key AIzaSy qua AI Studio, AQ.* qua Vertex AI, đổi model khi 404, cooldown + backoff khi 503', async () => {
    const { KeyPoolManager } = await import('../src/services/keyPool');
    const { GeminiService } = await import('../src/services/gemini.service');

    const prevFetch = globalThis.fetch;
    const prevAllowCloud = process.env.ALLOW_CLOUD_AI_FALLBACK;
    process.env.ALLOW_CLOUD_AI_FALLBACK = 'true';

    const requests: Array<{ url: string; headerKey: string | null; apiRevision: string | null; body: Record<string, any> }> = [];
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
        apiRevision: headers.get('api-revision'),
        body: parsedBody,
      });
      attempt += 1;

      // Request 1: key #1 (AIzaSy*) chạm 503 Overloaded -> cooldown 60s + backoff và xoay sang key #2 (AQ.* Vertex)
      if (attempt === 1) {
        return new Response(
          JSON.stringify({ error: { code: 503, message: 'Model overloaded', status: 'UNAVAILABLE' } }),
          { status: 503 },
        );
      }
      // Request 2: key #2 (AQ.*) gặp 404 trên gemini-3.8-flash -> giữ nguyên key #2, chuyển sang gemini-3.5-flash-lite
      if (url.includes('gemini-3.8-flash')) {
        return new Response(
          JSON.stringify({ error: { code: 404, message: 'models/gemini-3.8-flash is not found', status: 'NOT_FOUND' } }),
          { status: 404 },
        );
      }
      // Request 3: key #2 (AQ.*) thành công trên gemini-3.5-flash-lite
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
      const sleepSpy: number[] = [];
      const pool = new KeyPoolManager({
        persistenceMode: 'memory',
        envSource: {
          GEMINI_API_KEYS: 'AIzaSyTestStudioKey_001,vertex:AQ.Ab8RN6TestVertexKey_002',
          GEMINI_MODEL: 'gemini-3.8-flash',
        },
        fallbackOn503Threshold: 3,
        retry503JitterMaxMs: 0,
        sleepFn: async (ms) => {
          sleepSpy.push(ms);
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
      expect(sleepSpy).toEqual([500]);
      // Key #1 (AIzaSy*) phải gọi AI Studio Interactions API (/v1beta/interactions) với x-goog-api-key + Api-Revision
      expect(requests[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
      expect(requests[0].headerKey).toBe('AIzaSyTestStudioKey_001');
      expect(requests[0].apiRevision).toBe('2026-05-20');
      expect(requests[0].body.model).toBe('gemini-3.8-flash');
      expect(requests[0].body.store).toBe(false);
      expect(requests[0].body.response_format.mime_type).toBe('application/json');
      expect(requests[0].body.response_format.schema.type).toBe('object');
      expect(requests[0].body.generation_config.thinking_level).toBe('low');
      expect(requests[0].body.generation_config.temperature).toBeUndefined();

      // Key #2 (vertex:AQ.*) định tuyến sang Vertex AI Express và gặp 404 ở 3.8-flash -> chuyển sang 3.5-flash-lite trên CÙNG Key #2
      expect(requests[1].url).toContain('aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.8-flash:generateContent');
      expect(requests[1].url).toContain('key=AQ.Ab8RN6TestVertexKey_002');
      expect(requests[2].url).toContain('aiplatform.googleapis.com/v1/publishers/google/models/gemini-3.5-flash-lite:generateContent');

      const snap = await pool.listMaskedKeys();
      expect(snap.keys[0].status).toBe('COOLDOWN');
      expect(snap.keys[1].status).toBe('HEALTHY');

      // Kiểm chứng thêm Stage1 VisionAnalyzerService dùng key AIzaSy qua Interactions API sau khi reset cooldown
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
        requests.push({
          url,
          headerKey: headers.get('x-goog-api-key'),
          apiRevision: headers.get('api-revision'),
          body: parsedBody,
        });
        return new Response(
          JSON.stringify({
            id: 'int_vision_mock_1',
            status: 'completed',
            steps: [{ type: 'model_output', content: [{ type: 'text', text: JSON.stringify(visionPayload) }] }],
          }),
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
      expect(requests[prevCount].url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
      expect(requests[prevCount].headerKey).toBe('AIzaSyTestStudioKey_001');
      expect(requests[prevCount].apiRevision).toBe('2026-05-20');
      expect(requests[prevCount].body.model).toBe('gemini-3.8-flash');
      expect(requests[prevCount].body.response_format.mime_type).toBe('application/json');
      expect(requests[prevCount].body.response_format.schema.type).toBe('object');
      expect(requests[prevCount].body.generation_config.thinking_level).toBe('low');
      expect(requests[prevCount].body.generation_config.temperature).toBeUndefined();
      expect(Array.isArray(requests[prevCount].body.input)).toBe(true);
      expect(requests[prevCount].body.input[0]).toMatchObject({ type: 'image', mime_type: 'image/jpeg' });
    } finally {
      globalThis.fetch = prevFetch;
      if (prevAllowCloud === undefined) delete process.env.ALLOW_CLOUD_AI_FALLBACK;
      else process.env.ALLOW_CLOUD_AI_FALLBACK = prevAllowCloud;
    }
  });

  it('Interactions API chuyển đổi an toàn thinking_level, loại bỏ temperature, chuẩn hóa model 2.x->3.8 và xoay model 404 trên cùng key AI Studio', async () => {
    const {
      buildGeminiModelChain,
      buildGeminiRestRequest,
      executeGeminiWithModelFallback,
      KeyPoolManager,
      normalizeGeminiModelName,
    } = await import('../src/services/keyPool');

    // 1. Tự động nâng cấp các model cũ 2.x/1.5 về gemini-3.8-flash
    expect(normalizeGeminiModelName('gemini-2.5-flash')).toBe('gemini-3.8-flash');
    expect(normalizeGeminiModelName('gemini-2.5-flash-lite')).toBe('gemini-3.8-flash');
    expect(normalizeGeminiModelName('gemini-2.0-flash')).toBe('gemini-3.8-flash');
    expect(buildGeminiModelChain('gemini-2.5-flash')).toEqual([
      'gemini-3.8-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
    ]);

    // 2. Clamp thinking_level='minimal' -> 'low' trên gemini-3.8-flash, giữ 'minimal' trên gemini-3.5-flash-lite, bỏ temperature
    const req38 = buildGeminiRestRequest({
      cleanKey: 'AIzaSyMockKey38',
      endpoint: 'ai_studio',
      modelId: 'gemini-3.8-flash',
      contents: [
        { role: 'user', parts: [{ text: 'Xin chào' }] },
        { role: 'model', parts: [{ text: 'Chào bạn!' }] },
        { role: 'user', parts: [{ text: 'Hướng dẫn gửi phản ánh?' }] },
      ],
      config: {
        systemInstruction: 'Bạn là trợ lý.',
        temperature: 0.3,
        thinkingBudget: 0,
        maxOutputTokens: 400,
      },
    });
    expect(req38.url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(req38.headers['Api-Revision']).toBe('2026-05-20');
    expect(req38.body.generation_config).toEqual({
      max_output_tokens: 400,
      thinking_level: 'low',
    });
    expect(req38.body.input).toEqual([
      { type: 'user_input', content: [{ type: 'text', text: 'Xin chào' }] },
      { type: 'model_output', content: [{ type: 'text', text: 'Chào bạn!' }] },
      { type: 'user_input', content: [{ type: 'text', text: 'Hướng dẫn gửi phản ánh?' }] },
    ]);

    const req35Lite = buildGeminiRestRequest({
      cleanKey: 'AIzaSyMockKey35',
      endpoint: 'ai_studio',
      modelId: 'gemini-3.5-flash-lite',
      contents: 'Ping',
      config: { temperature: 0.1, thinkingBudget: 0 },
    });
    expect(req35Lite.body.generation_config).toEqual({
      thinking_level: 'minimal',
    });

    // 3. Chuỗi 404 trên Interactions API: gemini-3.8-flash (404) -> gemini-3.5-flash-lite (404) -> gemini-3.1-flash-lite (200)
    const triedModels: string[] = [];
    const pool = new KeyPoolManager({
      persistenceMode: 'memory',
      envSource: { GEMINI_API_KEYS: 'AIzaSySingleHealthyStudioKey_0001' },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });

    const out = await pool.executeWithRotation(async (apiKey, meta) =>
      executeGeminiWithModelFallback({
        apiKey,
        geminiEndpoint: meta.geminiEndpoint,
        keyFormat: meta.keyFormat,
        models: buildGeminiModelChain(),
        contents: 'Ping',
        timeoutMs: 5_000,
        label: 'Interactions404Test',
        fetchImpl: (async (_input: string | URL | Request, init?: RequestInit) => {
          const parsed = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
          triedModels.push(parsed.model ?? '');
          if (parsed.model !== 'gemini-3.1-flash-lite') {
            return new Response(
              JSON.stringify({ error: { code: 404, message: `models/${parsed.model} not found`, status: 'NOT_FOUND' } }),
              { status: 404 },
            );
          }
          return new Response(
            JSON.stringify({
              id: 'int_ok_31',
              status: 'completed',
              steps: [
                { type: 'thought', summary: [{ type: 'text', text: 'thinking...' }] },
                { type: 'model_output', content: [{ type: 'text', text: 'OK_31_LITE' }] },
              ],
            }),
            { status: 200 },
          );
        }) as unknown as typeof fetch,
      }),
    );

    expect(out.modelUsed).toBe('gemini-3.1-flash-lite');
    expect(out.text).toBe('OK_31_LITE');
    expect(triedModels).toEqual(['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite']);
    const snap = await pool.listMaskedKeys();
    expect(snap.keys[0].status).toBe('HEALTHY');
  });

  it('AQ.* trong GEMINI_API_KEYS chạy AI Studio, tự phục hồi key DB từng dính lỗi SERVICE_DISABLED và hạ cấp 503 khi chỉ còn 1 key', async () => {
    const { encryptApiKey, KeyPoolManager } = await import('../src/services/keyPool');
    const { GeminiService } = await import('../src/services/gemini.service');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-kp-aq-heal-'));
    const secret = 'test-heal-encryption-secret-32-bytes-ok!';
    const enc = encryptApiKey('AQ.Ab8RN6PersistedStudioKey0001', secret);
    fs.writeFileSync(
      path.join(tmpDir, 'api_keys.encrypted.json'),
      JSON.stringify([
        {
          keyId: 'ak_old_misrouted_aq',
          label: 'Old AQ Key',
          provider: 'gemini',
          geminiEndpoint: 'vertex',
          encryptedKey: enc.encryptedKey,
          iv: enc.iv,
          authTag: enc.authTag,
          keyFingerprint: enc.keyFingerprint,
          maskedKey: enc.maskedKey,
          weight: 1,
          isEnabled: true,
          status: 'INVALID',
          totalRequests: 1,
          successCount: 0,
          errorCount: 1,
          error429Count: 0,
          consecutive429: 0,
          lastUsedAt: null,
          cooldownUntil: null,
          dailyQuotaExhaustedAt: null,
          quotaResetAt: null,
          lastError: 'VertexAI(gemini-3.8-flash) HTTP 403 PERMISSION_DENIED SERVICE_DISABLED [CHƯA_BẬT_API]: Agent Platform API has not been used in project 123',
          addedBy: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]),
      'utf8',
    );

    const prevFetch = globalThis.fetch;
    const prevAllowCloud = process.env.ALLOW_CLOUD_AI_FALLBACK;
    process.env.ALLOW_CLOUD_AI_FALLBACK = 'true';
    const seenCalls: Array<{ url: string; model: string; key: string | null }> = [];

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes('googleapis.com')) return prevFetch(input, init);
      const headers = new Headers(init?.headers);
      const body = JSON.parse(String(init?.body ?? '{}')) as { model?: string };
      seenCalls.push({ url, model: body.model ?? '', key: headers.get('x-goog-api-key') });

      if (body.model === 'gemini-3.8-flash') {
        return new Response(
          JSON.stringify({ error: { code: 'service_unavailable', message: 'gemini-3.8-flash is currently experiencing high demand' } }),
          { status: 503 },
        );
      }
      return new Response(
        JSON.stringify({
          id: 'int_single_503_recovered',
          status: 'completed',
          steps: [
            {
              type: 'model_output',
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    riskSummary: 'Ngập cục bộ tại nút giao cần đặt biển cảnh báo.',
                    equipmentAndCrew: '01 Tổ Thoát nước đô thị.',
                    safetyWarning: 'Kiểm tra hố ga trước khi tiếp cận.',
                  }),
                },
              ],
            },
          ],
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    try {
      const pool = new KeyPoolManager({
        dataDir: tmpDir,
        encryptionSecret: secret,
        envSource: {},
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      });
      await pool.init();
      const healedSnap = await pool.listMaskedKeys();
      expect(healedSnap.keys).toHaveLength(1);
      expect(healedSnap.keys[0].status).toBe('HEALTHY');
      expect(healedSnap.keys[0].geminiEndpoint).toBe('ai_studio');

      const svc = new GeminiService(pool);
      const b1 = await svc.generateTacticalBriefing({
        category: 'ngap_nuoc',
        title: 'Ngập nước đường Nguyễn Ái Quốc',
        severity: 4,
        forceRefresh: true,
      });
      expect(b1.mode).toBe('gemini');
      expect(seenCalls.map((c) => c.model)).toEqual(['gemini-3.8-flash', 'gemini-3.5-flash-lite']);
      expect(seenCalls[0].url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
      expect(seenCalls[0].key).toBe('AQ.Ab8RN6PersistedStudioKey0001');

      // Request kế tiếp tự đi thẳng gemini-3.5-flash-lite vì 3.8-flash đã được ghi nhớ quá tải 503
      const b2 = await svc.generateTacticalBriefing({
        category: 'mat_duong',
        title: 'Ổ gà sâu trên đường Đồng Khởi',
        severity: 3,
        forceRefresh: true,
      });
      expect(b2.mode).toBe('gemini');
      expect(seenCalls[2].model).toBe('gemini-3.5-flash-lite');
    } finally {
      globalThis.fetch = prevFetch;
      if (prevAllowCloud === undefined) delete process.env.ALLOW_CLOUD_AI_FALLBACK;
      else process.env.ALLOW_CLOUD_AI_FALLBACK = prevAllowCloud;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
