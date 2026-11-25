import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

async function buildRealisticSmartphoneSnapshot(seed: number, width = 1024, height = 768): Promise<Buffer> {
  const raw = Buffer.allocUnsafe(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 3;
      const hash = ((x * 374761393 + y * 668265263 + seed * 1442695041) ^ (x >> 2)) >>> 0;
      const grain = (hash % 49) - 24;
      const waveR = Math.round(45 * Math.sin((x + seed) * 0.045) + 30 * Math.cos(y * 0.035));
      const waveG = Math.round(40 * Math.cos((y + seed) * 0.04) + 25 * Math.sin((x - y) * 0.03));
      const waveB = Math.round(35 * Math.sin((x + y) * 0.03));

      let r = 128 + waveR + grain;
      let g = 124 + waveG + grain;
      let b = 112 + waveB + grain;

      if (y > height * 0.45 && x > width * 0.2 && x < width * 0.8) {
        r = Math.max(0, Math.min(255, 72 + ((hash >> 3) % 95)));
        g = Math.max(0, Math.min(255, 68 + ((hash >> 5) % 85)));
        b = Math.max(0, Math.min(255, 58 + ((hash >> 7) % 75)));
      }

      raw[idx] = Math.max(0, Math.min(255, r));
      raw[idx + 1] = Math.max(0, Math.min(255, g));
      raw[idx + 2] = Math.max(0, Math.min(255, b));
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 80, mozjpeg: true })
    .toBuffer();
}

function makeGeminiStage1Response(params: {
  standardizedCategory: 'RAC_THAI_MOI_TRUONG' | 'HA_TANG_GIAO_THONG' | 'NGAP_UNG_THOAT_NUOC';
  severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';
  suggestedUnit: string;
  title: string;
  description: string;
  addressHint: string;
}) {
  return {
    candidates: [
      {
        content: {
          parts: [
            {
              text: JSON.stringify({
                authenticity: {
                  authenticity_score: 94,
                  is_screen_capture_or_fake: false,
                  forensic_flags: [],
                },
                moderation: {
                  relevance_score: 95,
                  abuse_risk: 'NONE',
                },
                classification: {
                  standardized_category: params.standardizedCategory,
                  severity: params.severity,
                  priority_score: params.severity === 'CRITICAL' ? 92 : 82,
                  suggested_unit: params.suggestedUnit,
                  is_emergency: params.severity === 'CRITICAL',
                  safety_hazards: ['cản trở giao thông'],
                },
                auto_fill: {
                  suggested_title: params.title,
                  suggested_description: params.description,
                  address_hint: params.addressHint,
                  key_evidence_tags: ['hien_truong', 'dong_nai', 'khac_phuc'],
                },
              }),
            },
          ],
        },
      },
    ],
  };
}

describe('AI Vision Report Hotfix: Speed, Gemini 3.8 Flash Interactions Config, SHA-256 Cache & KeyPool Failover', () => {
  let tmpDir = '';

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-ai-hotfix-'));
    process.env.DATA_DIR = tmpDir;
    process.env.MONGODB_URI = '';
    process.env.ALLOW_CLOUD_AI_FALLBACK = 'true';
  });

  afterAll(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('POST /api/ai/analyze-image: ép gemini-3.8-flash (thinking_level: low, không gửi temperature, <= 600 tokens), cold call < 2s & SHA-256 cache hit < 20ms', async () => {
    const { createRepositories } = await import('../src/repositories');
    const { createServices } = await import('../src/services/container');
    const { createApp } = await import('../src/app');

    const boot = await createRepositories();
    const s = createServices(boot.repos);
    s.keyPool.setProbeFn(async () => undefined);
    await s.keyPool.addKeys({ provider: 'gemini', apiKey: 'AIzaSyHotfixBenchKey000000000000000001', labelPrefix: 'bench' });
    await s.keyPool.init();

    const server = createApp(s, boot).listen(0);
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const prevFetch = globalThis.fetch;

    let geminiCalls = 0;
    let capturedUrl = '';
    let capturedBody: Record<string, unknown> = {};
    let capturedGenConfig: Record<string, unknown> | undefined;

    try {
      const snapshotBuf = await buildRealisticSmartphoneSnapshot(101);
      const sha256Hex = crypto.createHash('sha256').update(snapshotBuf).digest('hex');
      expect(snapshotBuf.byteLength).toBeGreaterThan(20_000);
      expect(snapshotBuf.byteLength).toBeLessThanOrEqual(220 * 1024);

      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (!url.includes('googleapis.com')) return prevFetch(input, init);

        geminiCalls += 1;
        capturedUrl = url;
        const parsedBody = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
        capturedBody = parsedBody;
        capturedGenConfig = (parsedBody.generation_config ?? parsedBody.generationConfig) as Record<string, unknown> | undefined;

        const mockClassic = makeGeminiStage1Response({
          standardizedCategory: 'RAC_THAI_MOI_TRUONG',
          severity: 'HIGH',
          suggestedUnit: 'Đội Môi trường Đô thị Phường Trấn Biên',
          title: 'Rác thải sinh hoạt ùn ứ ven đường Phạm Văn Thuận',
          description: 'Nhiều bao tải rác sinh hoạt tập kết trái phép lấn chiếm vỉa hè. Cần thu gom sớm để tránh ô nhiễm.',
          addressHint: 'Gần chợ Tân Mai, đường Phạm Văn Thuận',
        });
        const text = mockClassic.candidates[0].content.parts[0].text;

        return new Response(
          JSON.stringify({
            id: 'int_hotfix_bench_1',
            status: 'completed',
            steps: [{ type: 'model_output', content: [{ type: 'text', text }] }],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as typeof fetch;

      const buildMultipartForm = () => {
        const fd = new FormData();
        fd.append('aiImage', new Blob([new Uint8Array(snapshotBuf)], { type: 'image/jpeg' }), 'snapshot.jpg');
        fd.append(
          'payload',
          JSON.stringify({
            imageSha256: sha256Hex,
            forceCloud: true,
            dHash: '0123456789abcdef',
          }),
        );
        return fd;
      };

      // 1. Cold Call E2E qua HTTP multipart
      const tCold0 = performance.now();
      const coldRes = await prevFetch(`${base}/api/ai/analyze-image`, {
        method: 'POST',
        body: buildMultipartForm(),
      });
      const coldMs = performance.now() - tCold0;
      expect(coldRes.status).toBe(200);
      const coldJson = (await coldRes.json()) as Record<string, unknown>;

      console.info(
        `[bench] Cold POST /api/ai/analyze-image (${Math.round(snapshotBuf.byteLength / 1024)}KB): ${coldMs.toFixed(1)}ms | model=${String(coldJson.modelUsed)} | thinking_level=${String(capturedGenConfig?.thinking_level)}`,
      );

      expect(geminiCalls).toBe(1);
      expect(capturedUrl).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
      expect(capturedBody.model).toBe('gemini-3.8-flash');
      expect(capturedGenConfig?.temperature).toBeUndefined();
      expect(Number(capturedGenConfig?.max_output_tokens)).toBeLessThanOrEqual(600);
      expect((capturedBody.response_format as Record<string, unknown> | undefined)?.mime_type).toBe('application/json');
      expect(capturedGenConfig?.thinking_level).toBe('low');

      expect(coldJson.category).toBe('rac_thai');
      expect(coldJson.title).toContain('Phạm Văn Thuận');
      expect(coldJson.addressHint).toBe('Gần chợ Tân Mai, đường Phạm Văn Thuận');
      expect(coldJson.imageSha256).toBe(sha256Hex);
      expect(coldJson.modelUsed).toBe('gemini-3.8-flash');
      expect(coldJson.cached).toBe(false);
      expect(coldJson.degraded).not.toBe(true);
      expect(coldMs).toBeLessThan(2000);

      // 2. Cache Hit E2E qua SHA-256 (không tốn lượt gọi Gemini API nào thêm)
      const tHit0 = performance.now();
      const hitRes = await prevFetch(`${base}/api/ai/analyze-image`, {
        method: 'POST',
        body: buildMultipartForm(),
      });
      const hitMs = performance.now() - tHit0;
      expect(hitRes.status).toBe(200);
      const hitJson = (await hitRes.json()) as Record<string, unknown>;

      console.info(`[bench] SHA-256 Repeat POST /api/ai/analyze-image cache hit: ${hitMs.toFixed(2)}ms (internal=${String(hitJson.latencyMs)}ms, total upstream calls=${geminiCalls})`);

      expect(geminiCalls).toBe(1);
      expect(hitJson.cached).toBe(true);
      expect(hitJson.title).toBe(coldJson.title);
      expect(hitJson.addressHint).toBe(coldJson.addressHint);
      expect(Number(hitJson.latencyMs ?? 999)).toBeLessThan(15);
      expect(hitMs).toBeLessThan(80);
    } finally {
      globalThis.fetch = prevFetch;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await boot.repos.close();
    }
  }, 15_000);

  it('KeyPool Failover tức thì khi gặp 429, 403 (quota), 503 và 408 timeout trong <= 3 lượt; trả lỗi có cấu trúc nếu kiệt pool', async () => {
    const { KeyPoolManager } = await import('../src/services/keyPool');
    const { GeminiService } = await import('../src/services/gemini.service');

    const snapshotBuf = await buildRealisticSmartphoneSnapshot(202, 480, 360);
    const kp = new KeyPoolManager({
      persistenceMode: 'memory',
      cooldownMinutes: 5,
      cooldown503Minutes: 1,
      envSource: {
        GEMINI_API_KEYS: [
          'AIzaSyFailoverKeyOne000000000000000001',
          'AIzaSyFailoverKeyTwo000000000000000002',
          'AIzaSyFailoverKeyThr000000000000000003',
        ].join(','),
      },
    });
    kp.setProbeFn(async () => undefined);
    await kp.init();
    const initSnap = await kp.listMaskedKeys();
    const [k1, k2, k3] = initSnap.keys;

    const svc = new GeminiService(kp);
    const prevFetch = globalThis.fetch;
    const seenKeys: string[] = [];

    try {
      // Kịch bản A: Key 1 trả 429, Key 2 trả 403 quotaExceeded, Key 3 thành công ở lượt thứ 3
      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seenKeys.push(headers.get('x-goog-api-key') ?? '');

        if (seenKeys.length === 1) {
          return new Response(JSON.stringify({ error: { code: 429, message: 'Resource has been exhausted (429)' } }), { status: 429 });
        }
        if (seenKeys.length === 2) {
          return new Response(
            JSON.stringify({ error: { code: 403, status: 'RESOURCE_EXHAUSTED', message: 'Quota exceeded for generative-language' } }),
            { status: 403 },
          );
        }
        return new Response(
          JSON.stringify(
            makeGeminiStage1Response({
              standardizedCategory: 'HA_TANG_GIAO_THONG',
              severity: 'HIGH',
              suggestedUnit: 'Ban An toàn Giao thông Phường Tam Phước',
              title: 'Ổ gà sâu trên mặt đường Quốc lộ 51',
              description: 'Mặt đường bong tróc tạo hố sâu trên làn xe máy. Cần dặm vá sớm để đảm bảo an toàn.',
              addressHint: 'Đoạn gần ngã tư Vũng Tàu, Quốc lộ 51',
            }),
          ),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }) as typeof fetch;

      const tFailover0 = performance.now();
      const res = await svc.analyzeImage({
        imageBuffer: snapshotBuf,
        imageBase64: snapshotBuf.toString('base64'),
        aiMimeType: 'image/jpeg',
        imageSha256: crypto.createHash('sha256').update(snapshotBuf).digest('hex'),
        forceCloud: true,
        skipCache: true,
        dHash: 'fedcba9876543210',
      });
      const failoverMs = performance.now() - tFailover0;
      console.info(`[bench] KeyPool 429 + 403 -> healthy failover (3 attempts) finished in ${failoverMs.toFixed(1)}ms`);

      expect(seenKeys).toHaveLength(3);
      expect(new Set(seenKeys).size).toBe(3);
      expect(res.category).toBe('mat_duong');
      expect(res.addressHint).toBe('Đoạn gần ngã tư Vũng Tàu, Quốc lộ 51');
      expect(res.degraded).not.toBe(true);
      expect(res.modelUsed).toBe('gemini-3.8-flash');
      expect(failoverMs).toBeLessThan(1500);

      const keysSnap = await kp.listMaskedKeys();
      const rec1 = keysSnap.keys.find((k) => k.id === k1.id);
      const rec2 = keysSnap.keys.find((k) => k.id === k2.id);
      const rec3 = keysSnap.keys.find((k) => k.id === k3.id);
      expect(rec1?.status).toBe('COOLDOWN');
      expect(rec2?.status).toBe('COOLDOWN');
      expect(rec3?.status).toBe('HEALTHY');

      // Kịch bản B: Reset cooldown -> giả lập 503 + 408 timeout liên tiếp -> dừng nhanh <= 3 lượt & trả degraded + errorCode rõ ràng
      await kp.updateKey(k1.id, { resetCooldown: true });
      await kp.updateKey(k2.id, { resetCooldown: true });
      seenKeys.length = 0;

      globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        seenKeys.push(headers.get('x-goog-api-key') ?? '');
        if (seenKeys.length === 1) {
          return new Response(JSON.stringify({ error: { code: 503, message: 'Service temporarily overloaded' } }), { status: 503 });
        }
        return new Response(JSON.stringify({ error: { code: 408, message: 'Upstream timeout exceeded' } }), { status: 408 });
      }) as typeof fetch;

      const degradedRes = await svc.analyzeImage({
        imageBuffer: snapshotBuf,
        imageBase64: snapshotBuf.toString('base64'),
        aiMimeType: 'image/jpeg',
        forceCloud: true,
        skipCache: true,
        dHash: 'fedcba9876543211',
      });

      expect(seenKeys.length).toBeLessThanOrEqual(3);
      expect(degradedRes.degraded).toBe(true);
      expect(degradedRes.errorCode).toBeTruthy();
      expect(degradedRes.errorMessage).toBeTruthy();
      expect(degradedRes.upstreamStatus).toBeTruthy();
    } finally {
      globalThis.fetch = prevFetch;
    }
  });
});
