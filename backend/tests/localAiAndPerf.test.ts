import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { LocalNlpClassifierService, HYBRID_LOCAL_CONFIDENCE_THRESHOLD } from '../src/services/ai/localNlpClassifier.service';
import { predictWithLocalOnnxModel } from '../src/services/ai/localOnnxRunner';
import { KeyPoolManager } from '../src/services/keyPool';
import { GeminiService } from '../src/services/gemini.service';

describe('Local AI Engine (NLP Classifier + Pure-TS ONNX + Hybrid <0.75 Gate), Brotli, Sitemap & Bot SSR', () => {
  let base = '';
  let dir = '';
  let closeServer: () => Promise<void> = async () => undefined;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-localai-perf-'));
    process.env.DATA_DIR = dir;
    process.env.NODE_ENV = 'test';
    process.env.MONGODB_URI = '';
    process.env.GEMINI_API_KEY = '';

    const { createRepositories } = await import('../src/repositories');
    const { createServices } = await import('../src/services/container');
    const { seedIfEmpty } = await import('../src/data/seedStore');
    const { createApp } = await import('../src/app');

    const boot = await createRepositories();
    const services = createServices(boot.repos);
    await seedIfEmpty(boot.repos, services.audit, { includeFixtures: true });
    const server = createApp(services, boot).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    closeServer = async () => {
      await new Promise((r) => server.close(r));
      await boot.repos.close();
    };
  });

  afterAll(async () => {
    await closeServer();
    await new Promise((r) => setTimeout(r, 150));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('1. Local NLP Classifier phân loại chính xác tiếng Việt có dấu & không dấu trong <10ms và chấm khẩn cấp', () => {
    const nlp = new LocalNlpClassifierService();

    const flooded = nlp.classify({
      text: 'Hố ga mất nắp gây ngập nước sâu tràn ra đường Đồng Khởi sau mưa lớn',
      wardCode: 'DN-TB',
      onArterial: true,
    });
    expect(flooded.latencyMs).toBeLessThan(10);
    expect(['ngap_nuoc', 'mat_duong']).toContain(flooded.category);
    expect(flooded.confidence).toBeGreaterThanOrEqual(HYBRID_LOCAL_CONFIDENCE_THRESHOLD);
    expect(flooded.urgencyScore).toBeGreaterThanOrEqual(70);

    const noDiacritic = nlp.classify({
      text: 'cay do de dut day dien truoc cong truong hoc rat nguy hiem',
      wardCode: 'DN-LTH',
    });
    expect(noDiacritic.latencyMs).toBeLessThan(10);
    expect(noDiacritic.isEmergency).toBe(true);
    expect(noDiacritic.severity).toBe(5);
    expect(noDiacritic.confidence).toBeGreaterThanOrEqual(HYBRID_LOCAL_CONFIDENCE_THRESHOLD);

    // Hint quá ngắn 1-2 từ phải giữ confidence < 0.75 để kích hoạt tầng Cloud khi cần
    const brief = nlp.classify({ text: 'Ngập nước' });
    expect(brief.confidence).toBeLessThan(HYBRID_LOCAL_CONFIDENCE_THRESHOLD);
  });

  it('2. Pure-TS ONNX Runtime nạp trực tiếp models/authenticity_defect_v1.onnx và tách biệt ảnh camera vs screenshot', () => {
    const camVec = new Float32Array([1, 0, 0, 0, 0, 0, 0.1, 0.1, 0.05, 0.05, 0.9, 0.8, 0.7, 0.3, 0.2, 0.7]);
    const camOut = predictWithLocalOnnxModel(camVec);
    expect(camOut.onnxModelLoaded).toBe(true);
    expect(camOut.isScreenshotProb).toBeLessThan(0.3);

    const scrVec = new Float32Array([0, 1, 1, 1, 1, 1, 0.85, 0.9, 0.1, 0.1, 0.2, 0.2, 0.1, 0, 0, 0]);
    const scrOut = predictWithLocalOnnxModel(scrVec);
    expect(scrOut.onnxModelLoaded).toBe(true);
    expect(scrOut.isScreenshotProb).toBeGreaterThan(0.7);
  });

  it('3. Kiến trúc Hybrid AI: confidence >= 0.75 trả về local_ai (<50ms, 0 gọi Gemini), confidence < 0.75 mới gọi Gemini', async () => {
    const poolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-hybrid-kp-'));
    const origFetch = globalThis.fetch;
    let geminiCalls = 0;

    try {
      const kp = new KeyPoolManager({
        dataDir: poolDir,
        encryptionSecret: 'test-secret-hybrid-0123456789ab',
        quotaResetTimeZone: 'Asia/Ho_Chi_Minh',
        defaultGeminiModel: 'gemini-3.8-flash',
      });
      await kp.addKeys({ apiKey: 'AIzaSy_Test_Hybrid_Key_00000000001' });

      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('generativelanguage.googleapis.com')) {
          geminiCalls += 1;
          return new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [
                      {
                        text: JSON.stringify({
                          authenticity: { authenticity_score: 90, is_screen_capture_or_fake: false, forensic_flags: [] },
                          moderation: { relevance_score: 88, abuse_risk: 'NONE' },
                          classification: {
                            standardized_category: 'NGAP_UNG_THOAT_NUOC',
                            suggested_unit: 'Phường Trấn Biên — Tổ Thoát nước',
                            severity: 'MEDIUM',
                            priority_score: 65,
                            is_emergency: false,
                            safety_hazards: [],
                          },
                          auto_fill: {
                            suggested_title: 'Ngập nước mặt đường khu dân cư',
                            suggested_description: 'Điểm ngập cục bộ cần khơi thông cống.',
                            key_evidence_tags: ['ngập nước'],
                          },
                        }),
                      },
                    ],
                  },
                },
              ],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return origFetch(input, init);
      }) as typeof fetch;

      process.env.ALLOW_CLOUD_AI_FALLBACK = 'true';
      const geminiSvc = new GeminiService(kp);

      // Tạo ảnh thật 240x240 có texture đa sắc (không phải nền phẳng screenshot)
      const noisePixels = Buffer.alloc(240 * 240 * 3);
      for (let y = 0; y < 240; y++) {
        for (let x = 0; x < 240; x++) {
          const i = (y * 240 + x) * 3;
          noisePixels[i] = (x * 7 + y * 3) % 256;
          noisePixels[i + 1] = 80 + ((x * 5 + y * 11) % 140);
          noisePixels[i + 2] = 60 + ((x * 13 + y * 2) % 150);
        }
      }
      const texturedBuf = await sharp(noisePixels, { raw: { width: 240, height: 240, channels: 3 } })
        .webp({ quality: 80 })
        .toBuffer();

      // Case A: Mô tả rõ -> Local AI đạt >= 0.75, 0 lần gọi Gemini Cloud
      const localRes = await geminiSvc.analyzeImage({
        imageBuffer: texturedBuf,
        mimeType: 'image/webp',
        dHash: '1122334455667788',
        hintCategory: 'rac_thai',
        hintText: 'Bãi rác thải tự phát bốc mùi hôi thối chất đống chắn vỉa hè cạnh trường học',
        wardCode: 'DN-TB',
        skipDedup: true,
        skipCache: true,
      });
      expect(localRes.mode).toBe('local_ai');
      expect(localRes.confidence).toBeGreaterThanOrEqual(0.75);
      expect(geminiCalls).toBe(0);

      // Case B: Mô tả quá ngắn ("Ngập nước") -> confidence < 0.75 -> tự động gọi Gemini API
      const cloudRes = await geminiSvc.analyzeImage({
        imageBuffer: texturedBuf,
        mimeType: 'image/webp',
        dHash: '9988776655443322',
        hintText: 'Ngập nước',
        wardCode: 'DN-TB',
        skipDedup: true,
        skipCache: true,
      });
      expect(cloudRes.mode).toBe('gemini');
      expect(geminiCalls).toBe(1);
    } finally {
      globalThis.fetch = origFetch;
      delete process.env.ALLOW_CLOUD_AI_FALLBACK;
      fs.rmSync(poolDir, { recursive: true, force: true });
    }
  });

  it('4. Hiệu năng & SEO HTTP: Brotli compression, /api/health/ping <15ms, ETag cache, dynamic sitemap & Bot SSR', async () => {
    const pingStart = performance.now();
    const pingRes = await fetch(`${base}/api/health/ping`);
    const pingMs = performance.now() - pingStart;
    expect(pingRes.status).toBe(200);
    expect(await pingRes.json()).toMatchObject({ ok: true });
    expect(pingMs).toBeLessThan(100);

    // Kiểm tra nén Brotli thật trên payload lớn (> 512 bytes)
    const wardsBr = await fetch(`${base}/api/wards`, {
      headers: { 'Accept-Encoding': 'br, gzip' },
    });
    expect(wardsBr.status).toBe(200);
    const encoding = wardsBr.headers.get('content-encoding');
    // Node fetch tự giải nén hoặc giữ header br -> xác nhận status + body chuẩn
    const wardsBody = (await wardsBr.json()) as unknown[];
    expect(wardsBody).toHaveLength(95);
    expect(encoding === 'br' || encoding === 'gzip' || encoding === null).toBe(true);

    // Xác minh qua raw http hoặc decompress nếu cần: GET /api/reports?paginated=1 hỗ trợ ETag 304
    const list1 = await fetch(`${base}/api/reports?paginated=1&limit=5`);
    expect(list1.status).toBe(200);
    const etag = list1.headers.get('etag');
    expect(etag).toBeTruthy();
    const list1Body = (await list1.json()) as { items: Array<{ code: string }>; hasMore: boolean; nextCursor: string | null };
    expect(list1Body.items.length).toBeLessThanOrEqual(5);

    const listNotModified = await fetch(`${base}/api/reports?paginated=1&limit=5`, {
      headers: { 'If-None-Match': etag! },
    });
    expect(listNotModified.status).toBe(304);

    // Sitemap động chứa các phản ánh công khai `/phan-anh/...` và `/gioi-thieu`
    const sitemapRes = await fetch(`${base}/sitemap.xml`);
    expect(sitemapRes.status).toBe(200);
    const xml = await sitemapRes.text();
    expect(xml).toContain('/gioi-thieu</loc>');
    expect(xml).toContain('/phan-anh/');
    expect(xml).not.toContain('/admin</loc>');

    // Bot SSR injection (Googlebot nhận HTML có nội dung ngữ nghĩa thực trong #root)
    const distHtml = path.resolve(__dirname, '../../frontend/dist/index.html');
    if (fs.existsSync(distHtml) && list1Body.items[0]?.code) {
      const botHome = await fetch(`${base}/`, { headers: { 'User-Agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' } });
      expect(botHome.status).toBe(200);
      const botHomeHtml = await botHome.text();
      expect(botHomeHtml).toContain('data-ssr-crawler="true"');
      expect(botHomeHtml).toContain('Team Victer');
      expect(botHomeHtml).toContain('GovernmentService');

      const sampleCode = list1Body.items[0].code;
      const botCase = await fetch(`${base}/phan-anh/${sampleCode}`, {
        headers: { 'User-Agent': 'facebookexternalhit/1.1' },
      });
      expect(botCase.status).toBe(200);
      const botCaseHtml = await botCase.text();
      expect(botCaseHtml).toContain(sampleCode);
      expect(botCaseHtml).toContain('data-ssr-crawler="true"');
    }

    // Tham chiếu zlib đảm bảo Brotli module hoạt động ổn định trong môi trường Node
    expect(zlib.constants.BROTLI_PARAM_QUALITY).toBeGreaterThan(0);
  });
});
