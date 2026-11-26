import fs from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { OtpSendPayload, OtpTransport } from '../src/services/otpDelivery.service';
import type { Services } from '../src/services/container';

class MemoryOtpTransport implements OtpTransport {
  readonly provider = 'test_mem';
  readonly channel = 'sms' as const;
  codes = new Map<string, string>();
  async send(p: OtpSendPayload): Promise<void> {
    this.codes.set(p.to, p.code);
  }
}

async function makeRealisticNoExifStreetJpeg(width = 640, height = 480): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    const ny = y / height;
    const base = 175 - Math.round(ny * 100);
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 3;
      // Vân tự nhiên liên tục không nhảy bậc sắc cạnh kiểu UI screenshot
      const tex =
        Math.round(Math.sin(x * 0.08 + y * 0.05) * 18) +
        Math.round(Math.cos(x * 0.19 - y * 0.13) * 14) +
        Math.round(Math.sin((x + y) * 0.31) * 9);
      raw[idx] = Math.max(0, Math.min(255, base + tex));
      raw[idx + 1] = Math.max(0, Math.min(255, base + Math.round(tex * 0.85)));
      raw[idx + 2] = Math.max(0, Math.min(255, base - 8 + Math.round(tex * 0.7)));
    }
  }
  // JPEG tải từ PC/Zalo không chứa EXIF
  return sharp(raw, { raw: { width, height, channels: 3 } }).jpeg({ quality: 82 }).toBuffer();
}

async function makeCompressedScreenshotWebp(width = 450, height = 900): Promise<Buffer> {
  // Mô phỏng ảnh chụp màn hình dọc 9:18 (vùng phẳng lớn + thanh UI sắc cạnh) được nén WebP
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    const isBanner = (y >= 40 && y <= 110) || (y >= 540 && y <= 620);
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 3;
      const v = isBanner ? 24 : 242;
      raw[idx] = v;
      raw[idx + 1] = isBanner ? 36 : 245;
      raw[idx + 2] = isBanner ? 60 : 250;
    }
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).webp({ quality: 60 }).toBuffer();
}

describe('Report Soft-Flag Gatekeeper & Gemini 429/5xx Controlled Fail-Open E2E', () => {
  let dir = '';
  let base = '';
  let close: () => Promise<void>;
  let services: Services;
  const otp = new MemoryOtpTransport();

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-softflag-'));
    process.env.DATA_DIR = dir;
    process.env.NODE_ENV = 'test';
    process.env.GEMINI_API_KEY = '';
    process.env.MONGODB_URI = '';

    const srv = net.createServer();
    await new Promise<void>((res) => srv.listen(0, '127.0.0.1', res));
    srv.close();

    const { createRepositories } = await import('../src/repositories');
    const { createServices } = await import('../src/services/container');
    const { seedIfEmpty } = await import('../src/data/seedStore');
    const { createApp } = await import('../src/app');

    const boot = await createRepositories();
    services = createServices(boot.repos);
    services.otpDelivery.setTestTransport(otp);
    await seedIfEmpty(boot.repos, services.audit, { includeFixtures: true });
    const server = createApp(services, boot).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = async () => {
      services.otpDelivery.setTestTransport(null);
      await new Promise((r) => server.close(r));
      await boot.repos.close();
    };
  });

  afterAll(async () => {
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const { stage0PreFilter } = await import('../src/services/ai');
    stage0PreFilter.resetForTests();
  });

  async function loginCitizen(phone: string): Promise<string> {
    await fetch(`${base}/api/auth/otp/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    });
    const r = await fetch(`${base}/api/auth/otp/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, code: otp.codes.get(phone), name: 'Nguyen Dan Dong Nai' }),
    });
    const d = (await r.json()) as { token: string };
    return d.token;
  }

  it('(a) chấp nhận mượt mà ảnh tải từ máy tính/Zalo thiếu EXIF và dùng tọa độ bản đồ/GPS trình duyệt', async () => {
    const token = await loginCitizen('0911112201');
    const pcJpeg = await makeRealisticNoExifStreetJpeg(640, 480);

    const fd = new FormData();
    fd.append('displayImage', new Blob([new Uint8Array(pcJpeg)], { type: 'image/jpeg' }), 'pc_upload.jpg');
    fd.append('aiImage', new Blob([new Uint8Array(pcJpeg)], { type: 'image/jpeg' }), 'pc_ai.jpg');
    fd.append(
      'metadata',
      JSON.stringify({
        idempotencyKey: `noexif-pc-${Date.now()}`,
        category: 'mat_duong',
        title: 'Hố ga sụt lún mặt đường khu vực chợ',
        description: 'Mặt đường nứt võng sau mưa lớn, ảnh tải từ máy tính không có EXIF.',
        lat: 10.9462,
        lng: 106.8228,
        wardCode: 'DN-TB',
        dHash: '1357246813572468',
        edge: {
          blurScore: 95,
          brightness: 132,
          flatRatio: 0.22,
          aspect: 4 / 3,
          sharpEdgeDensity: 0.14,
          likelyScreenshot: false,
          screenshotConfidence: 0.12,
        },
        exif: null,
      }),
    );

    const res = await fetch(`${base}/api/reports`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      outcome: string;
      report: { lat: number; lng: number; status: string; ai: { decision?: string } };
    };
    expect(body.outcome).toBe('created');
    expect(body.report.status).toBe('received');
    expect(body.report.lat).toBeCloseTo(10.9462, 4);
    expect(body.report.lng).toBeCloseTo(106.8228, 4);
  });

  it('(b) ảnh chụp màn hình / ảnh nén gắt vẫn gửi thành công (201), gắn Soft Flag aiFlag/needsManualReview và đưa vào hàng chờ IOC', async () => {
    const token = await loginCitizen('0911112202');
    const screenshotBuf = await makeCompressedScreenshotWebp(450, 900);

    const fd = new FormData();
    fd.append('displayImage', new Blob([new Uint8Array(screenshotBuf)], { type: 'image/webp' }), 'shot.webp');
    fd.append('aiImage', new Blob([new Uint8Array(screenshotBuf)], { type: 'image/webp' }), 'shot_ai.webp');
    fd.append(
      'metadata',
      JSON.stringify({
        idempotencyKey: `screenshot-soft-${Date.now()}`,
        category: 'rac_thai',
        title: 'Điểm rác ứ đọng chụp từ màn hình camera an ninh',
        description: 'Người dân chụp lại màn hình camera gửi lên phường kiểm tra.',
        lat: 10.9475,
        lng: 106.8245,
        wardCode: 'DN-TB',
        dHash: '9876543210fedcba',
        edge: {
          blurScore: 30,
          brightness: 210,
          flatRatio: 0.85,
          aspect: 0.5,
          sharpEdgeDensity: 0.72,
          likelyScreenshot: true,
          screenshotConfidence: 0.91,
        },
      }),
    );

    const res = await fetch(`${base}/api/reports`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: fd,
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      outcome: string;
      report: {
        id: string;
        status: string;
        aiFlag?: string | null;
        needsManualReview?: boolean;
        ai: { decision?: string; moderationDecision?: string; softFlags?: string[] };
      };
    };
    expect(body.outcome).toBe('created');
    expect(body.report.status).toBe('received');
    expect(body.report.needsManualReview).toBe(true);
    expect(body.report.ai.decision).toBe('HUMAN_REVIEW');
    expect(body.report.ai.moderationDecision).toBe('HUMAN_REVIEW');
    expect(body.report.aiFlag).toBeTruthy();
  });

  it('(c) khi Gemini API gặp 429 hoặc 5xx, hệ thống fail-open có kiểm soát (201 + aiFlag + needsManualReview)', async () => {
    const token = await loginCitizen('0911112203');
    const photoBuf = await makeRealisticNoExifStreetJpeg(480, 360);

    await services.keyPool.addKeys({ apiKey: 'AIzaSyTestFailOpen429Key000000000001' });
    const origFetch = globalThis.fetch;
    const prevFallback = process.env.ALLOW_CLOUD_AI_FALLBACK;
    process.env.ALLOW_CLOUD_AI_FALLBACK = 'true';

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('generativelanguage.googleapis.com')) {
        return new Response(JSON.stringify({ error: { code: 429, message: 'Quota exceeded' } }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '10' },
        });
      }
      return origFetch(input, init);
    }) as typeof fetch;

    try {
      const fd = new FormData();
      fd.append('displayImage', new Blob([new Uint8Array(photoBuf)], { type: 'image/jpeg' }), 'real.jpg');
      fd.append('aiImage', new Blob([new Uint8Array(photoBuf)], { type: 'image/jpeg' }), 'real_ai.jpg');
      fd.append(
        'metadata',
        JSON.stringify({
          idempotencyKey: `gemini-429-${Date.now()}`,
          // Title trung tính ngắn để Local NLP không tự tin >= 0.75 -> đi qua Stage 1 Gemini
          category: 'khac',
          title: 'Sự cố hiện trường',
          description: 'Cần kiểm tra tại chỗ.',
          lat: 10.9488,
          lng: 106.8266,
          wardCode: 'DN-TB',
          dHash: '2468135790abcdef',
          edge: {
            blurScore: 70,
            brightness: 120,
            flatRatio: 0.25,
            aspect: 4 / 3,
            sharpEdgeDensity: 0.15,
            likelyScreenshot: false,
            screenshotConfidence: 0.1,
          },
        }),
      );

      const res = await fetch(`${base}/api/reports`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as {
        outcome: string;
        report: {
          status: string;
          aiFlag?: string | null;
          needsManualReview?: boolean;
          ai: { decision?: string; softFlags?: string[] };
        };
      };
      expect(body.outcome).toBe('created');
      expect(body.report.status).toBe('received');
      expect(body.report.needsManualReview).toBe(true);
      expect(body.report.ai.decision).toBe('HUMAN_REVIEW');
      expect(body.report.aiFlag).toBe('ai_fallback_manual_review');
      expect(body.report.ai.softFlags).toContain('ai_cloud_fallback_manual_review');
    } finally {
      globalThis.fetch = origFetch;
      if (prevFallback === undefined) delete process.env.ALLOW_CLOUD_AI_FALLBACK;
      else process.env.ALLOW_CLOUD_AI_FALLBACK = prevFallback;
    }
  });

  it('(d) vẫn chặn cứng file hỏng / quá nhỏ / nội dung vô nghĩa spam quảng cáo kèm thông báo cụ thể', async () => {
    const token = await loginCitizen('0911112204');

    const badFd = new FormData();
    badFd.append('displayImage', new Blob([Buffer.from('corrupt-bytes')], { type: 'image/jpeg' }), 'corrupt.jpg');
    badFd.append(
      'metadata',
      JSON.stringify({
        idempotencyKey: `corrupt-img-${Date.now()}`,
        category: 'rac_thai',
        title: 'Ảnh hỏng không đọc được',
        description: 'Kiểm tra file không hợp lệ',
        lat: 10.9462,
        lng: 106.8228,
        wardCode: 'DN-TB',
        dHash: '0102030405060708',
      }),
    );

    const badImgRes = await fetch(`${base}/api/reports`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: badFd,
    });
    expect(badImgRes.status).toBe(400);

    const validBuf = await makeRealisticNoExifStreetJpeg(320, 240);
    const spamFd = new FormData();
    spamFd.append('displayImage', new Blob([new Uint8Array(validBuf)], { type: 'image/jpeg' }), 'ok.jpg');
    spamFd.append(
      'metadata',
      JSON.stringify({
        idempotencyKey: `spam-text-${Date.now()}`,
        category: 'khac',
        title: 'Quảng cáo vay tiền nhanh https://spam-loan.example/go',
        description: 'Vào link https://spam-loan.example để nhận ưu đãi ngay',
        lat: 10.9462,
        lng: 106.8228,
        wardCode: 'DN-TB',
        dHash: '0807060504030201',
      }),
    );

    const spamRes = await fetch(`${base}/api/reports`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: spamFd,
    });
    expect(spamRes.status).toBe(422);
    const spamJson = (await spamRes.json()) as { error: { code: string; message: string } };
    expect(spamJson.error.code).toBe('SPAM_TEXT_REJECTED');
    expect(spamJson.error.message).not.toContain('Cổng kiểm định AI đa tầng');
  });
});
