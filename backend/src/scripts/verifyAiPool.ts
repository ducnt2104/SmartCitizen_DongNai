import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

// Cô lập hoàn toàn khỏi .env / MongoDB thật trước khi nạp bất kỳ module cấu hình nào
process.env.NODE_ENV = 'test';
process.env.VITEST = 'true';
process.env.MONGODB_URI = '';
process.env.GEMINI_API_KEY = '';
process.env.GEMINI_API_KEYS = '';
process.env.VERTEX_API_KEYS = '';
process.env.ALLOW_CLOUD_AI_FALLBACK = 'true';

function makeResponse(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function main(): Promise<void> {
  const {
    buildGeminiModelChain,
    KeyPoolManager,
    normalizeGeminiModelName,
    redactSecretsInText,
  } = await import('../services/keyPool/index.js');
  const { GeminiService } = await import('../services/gemini.service.js');

  console.log('=== [test:ai-pool] Bắt đầu kiểm thử KeyPool, Backoff 503, Model Fallback & Zod Validation ===');

  // 1. Phân loại Key (AIzaSy* vs AQ.* vs unknown) & Bảo mật log
  {
    const logs: { info: string[]; warn: string[]; error: string[] } = { info: [], warn: [], error: [] };
    const rawKeys = [
      'AIzaSyMockStudioPoolKey_Alpha_0001',
      'AIzaSyMockStudioPoolKey_Alpha_0002',
      'AQ.Ab8RN6MockVertexExpressKey_0003',
      'AQ.Ab8RN6MockVertexExpressKey_0004',
      'CUSTOM_NON_STANDARD_KEY_0005',
    ];
    const pool = new KeyPoolManager({
      persistenceMode: 'memory',
      envSource: {
        GEMINI_API_KEYS: rawKeys.join(','),
        VERTEX_API_KEYS: 'AQ.Ab8RN6MockExplicitVertex_0006',
        GEMINI_MODEL: 'gemini-2.5-flash', // Cố tình truyền model cũ/đã ngừng hỗ trợ để kiểm tra tự chuẩn hóa
      },
      logger: {
        info: (m) => logs.info.push(m),
        warn: (m) => logs.warn.push(m),
        error: (m) => logs.error.push(m),
      },
    });

    assert.equal(normalizeGeminiModelName('gemini-2.5-flash'), 'gemini-3.8-flash');
    assert.equal(normalizeGeminiModelName('gemini-3.5-flash-lite'), 'gemini-3.5-flash-lite');
    assert.deepEqual(buildGeminiModelChain('gemini-2.5-flash'), [
      'gemini-3.8-flash',
      'gemini-3.5-flash-lite',
      'gemini-3.1-flash-lite',
    ]);
    assert.ok(
      logs.info.some((l) => l.includes('Loaded 6 keys (AI Studio: 4, Vertex: 2)')),
      `Log khởi động phải phân tách chuẩn AI Studio: 4, Vertex: 2. Thực tế: ${logs.info.join(' | ')}`,
    );
    assert.ok(
      logs.warn.length >= 1,
      'Phải ghi cảnh báo rõ ràng cho key định dạng lạ không bắt đầu bằng AIzaSy hay AQ.',
    );

    const allLogs = [...logs.info, ...logs.warn, ...logs.error].join('\n');
    for (const rk of rawKeys) {
      assert.ok(!allLogs.includes(rk), `Tuyệt đối không được log nguyên vẹn key ${rk}`);
    }

    const snap = await pool.listMaskedKeys();
    assert.equal(snap.keys[0].geminiEndpoint, 'ai_studio');
    assert.equal(snap.keys[2].geminiEndpoint, 'ai_studio');
    assert.equal(snap.keys[4].geminiEndpoint, 'vertex');
    assert.equal(snap.keys[5].geminiEndpoint, 'vertex');
    console.log('✅ [1/4] Phân loại Key (AIzaSy & AQ.* -> AI Studio, VERTEX_API_KEYS/unknown -> Vertex), chuẩn hóa Model & bảo mật log: PASS');
  }

  // 2. Xử lý lỗi 401/403 -> Đánh dấu INVALID vĩnh viễn + Log chi tiết Google API (không xoay lại)
  {
    const logs: { info: string[]; warn: string[]; error: string[] } = { info: [], warn: [], error: [] };
    const keys = [
      'AIzaSyBadKey_Disabled_000000001001',
      'AIzaSyBadKey_Referer_0000000001002',
      'AIzaSyHealthyKey_Final_00000001003',
    ];
    const pool = new KeyPoolManager({
      persistenceMode: 'memory',
      envSource: { GEMINI_API_KEYS: keys.join(',') },
      logger: {
        info: (m) => logs.info.push(m),
        warn: (m) => logs.warn.push(m),
        error: (m) => logs.error.push(m),
      },
    });

    const attempted: number[] = [];
    const out = await pool.executeWithRotation(async (_k, meta) => {
      attempted.push(meta.slotNumber);
      if (meta.slotNumber === 1) {
        throw Object.assign(
          new Error(
            JSON.stringify({
              error: {
                code: 403,
                message: 'Generative Language API has not been used in project 12345 or it is disabled.',
                status: 'PERMISSION_DENIED',
                details: [{ reason: 'SERVICE_DISABLED' }],
              },
            }),
          ),
          { status: 403 },
        );
      }
      if (meta.slotNumber === 2) {
        throw Object.assign(
          new Error(
            JSON.stringify({
              error: {
                code: 403,
                message: 'Requests from referer https://smartcitizen.example are blocked.',
                status: 'PERMISSION_DENIED',
                details: [{ reason: 'API_KEY_HTTP_REFERRER_BLOCKED' }],
              },
            }),
          ),
          { status: 403 },
        );
      }
      return 'OK_KEY_3';
    });

    assert.equal(out, 'OK_KEY_3');
    assert.deepEqual(attempted, [1, 2, 3]);
    const snap = await pool.listMaskedKeys();
    assert.equal(snap.keys[0].status, 'INVALID');
    assert.equal(snap.keys[1].status, 'INVALID');
    assert.equal(snap.keys[2].status, 'HEALTHY');
    assert.ok(logs.error.some((l) => l.includes('CHƯA_BẬT_API') && l.includes('SERVICE_DISABLED')));
    assert.ok(logs.error.some((l) => l.includes('GIỚI_HẠN_IP_REFERER') && l.includes('API_KEY_HTTP_REFERRER_BLOCKED')));

    // Gọi lại lần 2 -> không bao giờ xoay lại vào key 1 & 2 đã INVALID
    const secondRunSlots: number[] = [];
    await pool.executeWithRotation(async (_k, meta) => {
      secondRunSlots.push(meta.slotNumber);
      return 'OK';
    });
    assert.deepEqual(secondRunSlots, [3]);

    // Kiểm tra redactSecretsInText che ?key=...
    const redacted = redactSecretsInText(
      'Fetch failed at https://aiplatform.googleapis.com/v1/models/gemini-3.8-flash?key=AQ.Ab8RN6SuperSecretToken9999',
    );
    assert.ok(!redacted.includes('AQ.Ab8RN6SuperSecretToken9999'));
    assert.ok(redacted.includes('..9999'));
    console.log('✅ [2/4] Lỗi 401/403 đánh dấu INVALID vĩnh viễn, log chi tiết Google API & che secret URL: PASS');
  }

  // 3. Lỗi 503 Overloaded -> Cooldown 60s + Exponential Backoff + Jitter + Hạ cấp sang gemini-3.5-flash-lite sau 3 key 503
  {
    const prevFetch = globalThis.fetch;
    const callTrace: Array<{ url: string; model: string; atMs: number; keyMask: string }> = [];
    const logs: { info: string[]; warn: string[]; error: string[] } = { info: [], warn: [], error: [] };

    const pool = new KeyPoolManager({
      persistenceMode: 'memory',
      envSource: {
        GEMINI_API_KEYS: [
          'AIzaSyOverloadTestKey_000000005031',
          'AIzaSyOverloadTestKey_000000005032',
          'AIzaSyOverloadTestKey_000000005033',
          'AIzaSyFallbackSuccessKey_000005034',
        ].join(','),
        GEMINI_MODEL: 'gemini-3.8-flash',
      },
      logger: {
        info: (m) => logs.info.push(m),
        warn: (m) => logs.warn.push(m),
        error: (m) => logs.error.push(m),
      },
    });
    const gemini = new GeminiService(pool);

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes('googleapis.com')) return prevFetch(input, init);
      const headers = new Headers(init?.headers);
      const key = headers.get('x-goog-api-key') ?? '';
      const parsedBody = init?.body ? (JSON.parse(String(init.body)) as { model?: string }) : {};
      const modelMatch = url.match(/models\/([^:]+):generateContent/);
      const model = parsedBody.model ?? modelMatch?.[1] ?? 'unknown';
      callTrace.push({ url, model, atMs: performance.now(), keyMask: key.slice(-4) });

      if (callTrace.length <= 3) {
        return makeResponse(503, {
          error: { code: 503, message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' },
        });
      }
      return makeResponse(200, {
        id: 'int_mock_503_recovered',
        status: 'completed',
        steps: [
          {
            type: 'model_output',
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  riskSummary: 'Ngập sâu trên Quốc lộ 1A gây cản trở giao thông.',
                  equipmentAndCrew: '01 Tổ Thoát nước đô thị kèm máy bơm công suất lớn.',
                  safetyWarning: 'Cắm cọc tiêu phản quang cảnh báo khu vực hố ga ngập.',
                }),
              },
            ],
          },
        ],
      });
    }) as typeof fetch;

    try {
      const t0 = performance.now();
      const briefing = await gemini.generateTacticalBriefing({
        category: 'ngap_nuoc',
        title: 'Ngập sâu mặt đường Quốc lộ 1A trước cổng khu công nghiệp',
        severity: 4,
        wardCode: 'DN-TB',
        forceRefresh: true,
      });
      const totalMs = performance.now() - t0;

      assert.equal(briefing.mode, 'gemini');
      assert.equal(callTrace.length, 4, 'Phải thử 3 key đầu bị 503 và thành công ở key #4');
      assert.equal(callTrace[0].model, 'gemini-3.8-flash');
      assert.equal(callTrace[1].model, 'gemini-3.8-flash');
      assert.equal(callTrace[2].model, 'gemini-3.8-flash');
      assert.equal(callTrace[3].model, 'gemini-3.5-flash-lite', 'Sau 3 key liên tiếp 503 phải tự động hạ cấp sang gemini-3.5-flash-lite');

      const gap12 = callTrace[1].atMs - callTrace[0].atMs;
      const gap23 = callTrace[2].atMs - callTrace[1].atMs;
      const gap34 = callTrace[3].atMs - callTrace[2].atMs;
      assert.ok(gap12 >= 450, `Backoff lần 1 phải >= 500ms (thực tế ${gap12.toFixed(0)}ms)`);
      assert.ok(gap23 >= 900, `Backoff lần 2 phải >= 1000ms (thực tế ${gap23.toFixed(0)}ms)`);
      assert.ok(gap34 >= 1400, `Backoff lần 3 phải >= 1500ms (thực tế ${gap34.toFixed(0)}ms)`);
      assert.ok(totalMs >= 2800, `Tổng backoff 3 lần phải >= 2800ms (thực tế ${totalMs.toFixed(0)}ms)`);

      const snap = await pool.listMaskedKeys();
      assert.equal(snap.keys[0].status, 'COOLDOWN');
      assert.equal(snap.keys[1].status, 'COOLDOWN');
      assert.equal(snap.keys[2].status, 'COOLDOWN');
      assert.equal(snap.keys[3].status, 'HEALTHY');
      assert.ok(logs.warn.some((l) => l.includes('Tự động hạ cấp sang gemini-3.5-flash-lite')));
      console.log(
        `✅ [3/4] Lỗi 503 Cooldown 60s + Exponential Backoff+Jitter (${gap12.toFixed(0)}ms -> ${gap23.toFixed(0)}ms -> ${gap34.toFixed(0)}ms) + Hạ cấp gemini-3.5-flash-lite: PASS`,
      );
    } finally {
      globalThis.fetch = prevFetch;
    }
  }

  // 4. Input < 4 ký tự, lỗi Zod cleanSummary rỗng & Local AI Brain Fallback không văng lỗi
  {
    const prevFetch = globalThis.fetch;
    let cloudCalls = 0;
    const pool = new KeyPoolManager({
      persistenceMode: 'memory',
      envSource: { GEMINI_API_KEYS: 'AIzaSyZodAndInputGuardTestKey_0004' },
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    const gemini = new GeminiService(pool);

    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (!url.includes('googleapis.com')) return prevFetch(input, init);
      cloudCalls += 1;
      // Mô phỏng Gemini trả cleanSummary rỗng ("") khi isRelevant=false -> từng gây ZodError "String must contain at least 4 character(s)"
      return makeResponse(200, {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    isRelevant: false,
                    category: 'official_notice',
                    severity: 1,
                    wardIds: [],
                    affectedRoads: [],
                    cleanSummary: '',
                  }),
                },
              ],
            },
          },
        ],
      });
    }) as typeof fetch;

    try {
      // 4A. Input < 4 ký tự phải bị chặn trước khi gọi KeyPool
      const shortBriefing = await gemini.generateTacticalBriefing({
        category: 'khac',
        title: 'ab',
        description: '  ',
        forceRefresh: true,
      });
      assert.equal(cloudCalls, 0, 'Input < 4 ký tự không được gọi vào KeyPool');
      assert.equal(shortBriefing.mode, 'fallback');
      assert.ok(shortBriefing.riskSummary.length >= 10);

      const shortBulletin = await gemini.classifyOfficialBulletin({
        title: 'Tin',
        summary: '',
        sourceName: 'TestFeed',
        sourceUrl: 'https://baodongnai.com.vn/test',
      });
      assert.equal(cloudCalls, 0, 'Bulletin input < 4 ký tự không được gọi vào KeyPool');
      assert.ok(shortBulletin.cleanSummary.length >= 4);

      // 4B. Cloud Gemini trả cleanSummary: "" -> không văng ZodError "String must contain at least 4 character(s)"
      const cloudShortSummary = await gemini.classifyOfficialBulletin({
        title: 'Tin giải trí cuối tuần không thuộc Đồng Nai',
        summary: 'Nội dung giải trí tổng hợp.',
        sourceName: 'TestFeed',
        sourceUrl: 'https://baodongnai.com.vn/ent',
      });
      assert.equal(cloudCalls, 1);
      assert.equal(gemini.lastError, null, 'Không được dính lỗi Zod validation lên GeminiService.lastError');
      assert.ok(cloudShortSummary.cleanSummary.length >= 4);

      // 4C. Local AI Brain Fallback với input cực ngắn
      const fbVision = gemini.fallbackVision({
        mimeType: 'image/webp',
        dHash: '0123456789abcdef',
        hintText: 'Hư',
      });
      assert.ok(fbVision.title.length >= 4);
      assert.ok(fbVision.description.length >= 8);

      // 4D. Controller HTTP validation cho input < 4 ký tự (dùng local temp dir, 0% chạm MongoDB thật)
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-ai-pool-http-'));
      process.env.DATA_DIR = tmpDir;
      process.env.MONGODB_URI = '';
      try {
        const { createRepositories } = await import('../repositories/index.js');
        const { createServices } = await import('../services/container.js');
        const { INITIAL_STAFF_PASSWORD, seedIfEmpty } = await import('../data/seedStore.js');
        const { createApp } = await import('../app.js');

        const boot = await createRepositories();
        const services = createServices(boot.repos);
        await seedIfEmpty(boot.repos, services.audit, { includeFixtures: true });
        const server = createApp(services, boot).listen(0);
        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

        try {
          const loginRes = await fetch(`${base}/api/auth/staff/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ staffCode: 'TP-01', password: INITIAL_STAFF_PASSWORD, unit: 'city' }),
          });
          const { token } = (await loginRes.json()) as { token: string };

          const shortBriefHttp = await fetch(`${base}/api/ai/tactical-briefing`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify({ category: 'rac_thai', title: 'abc' }),
          });
          assert.equal(shortBriefHttp.status, 400, 'HTTP /api/ai/tactical-briefing phải chặn title < 4 ký tự ngay ở validation');

          const shortVisionHttp = await fetch(`${base}/api/ai/analyze-image`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hintText: 'ab' }),
          });
          assert.equal(shortVisionHttp.status, 400, 'HTTP /api/ai/analyze-image phải chặn khi thiếu ảnh và hintText < 4 ký tự');
        } finally {
          await new Promise<void>((r) => server.close(() => r()));
          await boot.repos.close();
        }
      } finally {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup lock
        }
      }

      console.log('✅ [4/4] Guard Input < 4 ký tự, chống ZodError & Local AI Brain Fallback: PASS');
    } finally {
      globalThis.fetch = prevFetch;
    }
  }

  console.log('🎉 [test:ai-pool] TẤT CẢ KỊCH BẢN KIỂM THỬ AI KEYPOOL & FALLBACK ĐỀU PASS!');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ [test:ai-pool] Thất bại:', err);
  process.exit(1);
});
