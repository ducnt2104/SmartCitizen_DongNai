import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OtpSendPayload, OtpTransport } from '../src/services/otpDelivery.service';

class MemoryOtpTransport implements OtpTransport {
  readonly provider = 'test_memory';
  readonly channel = 'email' as const;
  sent: Array<{ to: string; code: string; purpose: string }> = [];
  async send(payload: OtpSendPayload): Promise<void> {
    this.sent.push({ to: payload.to.toLowerCase(), code: payload.code, purpose: payload.purpose });
  }
  lastCodeFor(target: string): string {
    const found = [...this.sent].reverse().find((x) => x.to === target.toLowerCase() || x.to === target);
    if (!found) throw new Error(`Missing OTP in memory transport for ${target}`);
    return found.code;
  }
}

function parseSetCookies(res: Response): { map: Record<string, string>; raw: string[] } {
  const raw = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  const map: Record<string, string> = {};
  for (const line of raw) {
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) map[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return { map, raw };
}

function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .filter(([, v]) => Boolean(v))
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

function computeDHashFromGray(gray: Uint8Array, w: number, h: number): string {
  const out = new Float32Array(9 * 8);
  for (let gy = 0; gy < 8; gy++) {
    const y0 = Math.floor((gy * h) / 8);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * h) / 8));
    for (let gx = 0; gx < 9; gx++) {
      const x0 = Math.floor((gx * w) / 9);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * w) / 9));
      let sum = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          sum += gray[sy * w + sx];
          count += 1;
        }
      }
      out[gy * 9 + gx] = count > 0 ? sum / count : 0;
    }
  }
  let hex = '';
  let cur = 0;
  let bits = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      cur = (cur << 1) | (out[y * 9 + x] > out[y * 9 + x + 1] ? 1 : 0);
      bits += 1;
      if (bits === 4) {
        hex += cur.toString(16);
        cur = 0;
        bits = 0;
      }
    }
  }
  return hex;
}

async function encodeImageWithHash(
  w: number,
  h: number,
  pixelFn: (x: number, y: number) => [number, number, number],
  opts: { format?: 'png' | 'jpeg'; jpegQuality?: number; exifSoftware?: string } = {},
): Promise<{ buffer: Buffer; dataUrl: string; dHash: string }> {
  const raw = Buffer.alloc(w * h * 3);
  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixelFn(x, y);
      const rc = Math.max(0, Math.min(255, Math.round(r)));
      const gc = Math.max(0, Math.min(255, Math.round(g)));
      const bc = Math.max(0, Math.min(255, Math.round(b)));
      const i = y * w + x;
      raw[i * 3] = rc;
      raw[i * 3 + 1] = gc;
      raw[i * 3 + 2] = bc;
      gray[i] = Math.round(0.299 * rc + 0.587 * gc + 0.114 * bc);
    }
  }

  let pipeline = sharp(raw, { raw: { width: w, height: h, channels: 3 } });
  if (opts.exifSoftware) {
    pipeline = pipeline.withMetadata({
      exif: { IFD0: { Software: opts.exifSoftware } },
    });
  }
  const buffer =
    opts.format === 'jpeg'
      ? await pipeline.jpeg({ quality: opts.jpegQuality ?? 90 }).toBuffer()
      : await pipeline.png().toBuffer();

  const mime = opts.format === 'jpeg' ? 'image/jpeg' : 'image/png';
  const dHash = computeDHashFromGray(gray, w, h);
  return {
    buffer,
    dataUrl: `data:${mime};base64,${buffer.toString('base64')}`,
    dHash,
  };
}

/** Ảnh đường phố Đồng Nai chân thực: mây trời, dãy nhà/cột điện/vỉa hè giàu chi tiết đa tỷ lệ và tùy chọn sự cố. */
async function makeStreetScene(opts: {
  defect: 'full' | 'partial' | 'none';
  exifSoftware?: string;
  bright?: number;
  water?: boolean;
} = { defect: 'full' }): Promise<{ buffer: Buffer; dataUrl: string; dHash: string }> {
  const w = 640;
  const h = 480;
  const bright = opts.bright ?? 1.0;
  const water = Boolean(opts.water);
  return encodeImageWithHash(
    w,
    h,
    (x, y) => {
      const shift = water ? 190 : 0;
      const cx = Math.floor((x + shift) / 4);
      const cy = Math.floor((y + shift) / 4);
      const hash = (Math.imul(cx, 374761393) + Math.imul(cy, 668265263)) ^ Math.imul(cx, cy);
      const tex = ((hash & 0x1f) - 16) * 1.1;

      let r = 90;
      let g = 92;
      let b = 96;
      if (y < h * 0.28) {
        const cloud = Math.sin((x + shift) * 0.018 + y * 0.03) * 18;
        r = 140 + cloud + tex * 0.6;
        g = 186 + cloud + tex * 0.6;
        b = 230 + tex * 0.4;
      } else if (y < h * 0.58) {
        const bx = Math.floor((x + shift) / 32) % 7;
        const by = Math.floor((y + shift) / 24) % 5;
        const win = (x + shift) % 32 > 7 && (x + shift) % 32 < 24 && (y + shift) % 24 > 6 && (y + shift) % 24 < 18;
        const pole = (x > w * 0.2 && x < w * 0.2 + 14) || (x > w * 0.78 && x < w * 0.78 + 14);
        if (pole) {
          r = 62 + tex;
          g = 68 + tex;
          b = 75 + tex;
        } else if (win) {
          r = water ? 180 + bx * 8 + tex : 48 + bx * 16 + tex;
          g = water ? 90 + by * 10 + tex : 64 + by * 14 + tex;
          b = water ? 65 + tex : 94 + tex;
        } else {
          r = water ? 120 + tex : 166 + bx * 9 + tex;
          g = water ? 150 + by * 8 + tex : 156 + by * 8 + tex;
          b = water ? 165 + tex : 140 + tex;
        }
      } else if (water) {
        const ripple = Math.sin(x * 0.08 + y * 0.14) * 16;
        r = 48 + ripple + tex;
        g = 96 + ripple + tex;
        b = 162 + ripple + tex;
      } else {
        const curb = y < h * 0.61;
        const dash = y > h * 0.76 && y < h * 0.79 && Math.floor(x / 48) % 2 === 0;
        if (curb) {
          r = 182 + tex;
          g = 178 + tex;
          b = 168 + tex;
        } else if (dash) {
          r = 228 + tex * 0.5;
          g = 222 + tex * 0.5;
          b = 196 + tex * 0.5;
        } else {
          r = 84 + tex * 1.2;
          g = 86 + tex * 1.2;
          b = 92 + tex * 1.2;
        }
      }

      if (opts.defect !== 'none') {
        const rx = opts.defect === 'partial' ? 50 : 155;
        const ry = opts.defect === 'partial' ? 30 : 84;
        const dx = x - w * 0.5;
        const dy = y - h * 0.74;
        if ((dx * dx) / (rx * rx) + (dy * dy) / (ry * ry) <= 1.0) {
          const dbx = Math.floor(x / 18);
          const dby = Math.floor(y / 14);
          const bh = (Math.imul(dbx, 2246822519) + Math.imul(dby, 3266489917)) >>> 0;
          const clump = bh % 5;
          if (clump === 0) [r, g, b] = [22 + tex, 24 + tex, 28 + tex];
          else if (clump === 1) [r, g, b] = [215 + tex, 48 + tex, 38 + tex];
          else if (clump === 2) [r, g, b] = [28 + tex, 160 + tex, 58 + tex];
          else if (clump === 3) [r, g, b] = [235 + tex, 195 + tex, 25 + tex];
          else [r, g, b] = [35 + tex, 90 + tex, 205 + tex];
        }
      }

      return [r * bright, g * bright, b * bright];
    },
    { format: 'png', exifSoftware: opts.exifSoftware },
  );
}

/** Ảnh màn hình điện thoại (tỷ lệ dọc 9:20, thanh trạng thái phẳng, chữ UI sắc nét). */
async function makeMobileScreenshot(): Promise<{ dataUrl: string; dHash: string }> {
  const { dataUrl, dHash } = await encodeImageWithHash(360, 800, (x, y) => {
    if (y < 42) {
      const icon = y > 14 && y < 26 && ((x > 20 && x < 75 && x % 6 < 3) || (x > 280 && x < 335 && x % 7 < 4));
      return icon ? [255, 255, 255] : [15, 23, 42];
    }
    if (y >= 746) {
      const bar = y > 780 && y < 788 && x > 130 && x < 230;
      return bar ? [255, 255, 255] : [15, 23, 42];
    }
    if (y > 90 && y < 690 && x > 22 && x < 338) {
      const textRow = y % 44 > 14 && y % 44 < 21 && x > 40 && x < 290 && x % 5 !== 0;
      return textRow ? [18, 24, 38] : [255, 255, 255];
    }
    return [241, 245, 249];
  });
  return { dataUrl, dHash };
}

/** Ảnh ghép ELA bất thường: nền có nhiễu cảm biến thực tế nhưng ghép 1 khối checkerboard tái nén lệch chuẩn. */
async function makeElaTamperedJpeg(): Promise<{ dataUrl: string; dHash: string }> {
  const { dataUrl, dHash } = await encodeImageWithHash(
    384,
    384,
    (x, y) => {
      if (x >= 144 && x < 192 && y >= 144 && y < 192) {
        const v = (Math.floor(x / 4) + Math.floor(y / 4)) % 2 === 0 ? 255 : 10;
        return [v, 265 - v, v];
      }
      const cx = Math.floor(x / 6);
      const cy = Math.floor(y / 6);
      const hash = (Math.imul(cx, 374761393) + Math.imul(cy, 668265263)) ^ Math.imul(cx, cy);
      const grain = ((hash & 15) - 8) * 1.5;
      return [115 + grain, 135 + grain, 155 + grain];
    },
    { format: 'jpeg', jpegQuality: 99 },
  );
  return { dataUrl, dHash };
}

/** Ảnh hiện trường khác địa điểm hoàn toàn (không khớp mốc cố định). */
async function makeDifferentScene(): Promise<{ dataUrl: string; dHash: string }> {
  const { dataUrl, dHash } = await encodeImageWithHash(640, 320, (x, y) => {
    const hash = (Math.imul(x, 1597334677) + Math.imul(y, 3812015801)) ^ Math.imul(x + 17, y + 31);
    const grain = ((hash & 0x1f) - 16) * 0.9;
    if ((Math.floor((x + y) / 40)) % 2 === 0) {
      return [220 + grain, 125 + grain, 40 + grain];
    }
    return [35 + grain, 75 + grain, 175 + grain];
  });
  return { dataUrl, dHash };
}

async function transformBufferWithHash(buf: Buffer, mode: 'flop' | 'crop'): Promise<{ dataUrl: string; dHash: string }> {
  let out: Buffer;
  let w = 640;
  let h = 480;
  if (mode === 'flop') {
    out = await sharp(buf).flop().png().toBuffer();
  } else {
    w = 320;
    h = 240;
    out = await sharp(buf).extract({ left: 0, top: 0, width: 320, height: 240 }).png().toBuffer();
  }
  const rawGray = await sharp(out).grayscale().raw().toBuffer();
  const dHash = computeDHashFromGray(new Uint8Array(rawGray), w, h);
  return {
    dataUrl: `data:image/png;base64,${out.toString('base64')}`,
    dHash,
  };
}

describe('E2E Full-Stack: Strict Single-Session, Re-auth, RBAC & Multi-Layer AI Forensics', () => {
  let base = '';
  let dir = '';
  let close: () => Promise<void> = async () => undefined;
  let services!: ReturnType<(typeof import('../src/services/container'))['createServices']>;
  const transport = new MemoryOtpTransport();

  let ipCounter = 20;
  const nextIp = () => `198.51.100.${(ipCounter++ % 200) + 1}`;

  async function call<T = any>(
    p: string,
    opts: {
      method?: string;
      body?: unknown;
      token?: string;
      cookies?: Record<string, string>;
      ip?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<{ status: number; data: T; cookies: Record<string, string>; rawSetCookie: string[]; rawText: string }> {
    const res = await fetch(`${base}${p}`, {
      method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
      headers: {
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.cookies ? { Cookie: cookieHeader(opts.cookies) } : {}),
        'X-Forwarded-For': opts.ip ?? '198.51.100.1',
        'X-Device-Fp': opts.headers?.['X-Device-Fp'] ?? 'e2e-default-fp',
        ...(opts.headers ?? {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const rawText = await res.text();
    const { map, raw } = parseSetCookies(res);
    let parsed: any = null;
    try {
      parsed = rawText ? JSON.parse(rawText) : null;
    } catch {
      parsed = rawText;
    }
    return { status: res.status, data: parsed as T, cookies: map, rawSetCookie: raw, rawText };
  }

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-sec-forensics-e2e-'));
    process.env.DATA_DIR = dir;
    process.env.NODE_ENV = 'test';
    delete process.env.MONGODB_URI;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEYS;
    delete process.env.ALLOW_JSON_FALLBACK;

    const { createRepositories } = await import('../src/repositories');
    const { createServices } = await import('../src/services/container');
    const { seedIfEmpty } = await import('../src/data/seedStore');
    const { createApp } = await import('../src/app');

    const boot = await createRepositories();
    services = createServices(boot.repos);
    services.otpDelivery.setTestTransport(transport);
    await seedIfEmpty(boot.repos, services.audit, { includeFixtures: true });
    const server = createApp(services, boot).listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = async () => {
      await new Promise((r) => server.close(r));
      await boot.repos.close();
    };
  });

  afterAll(async () => {
    services.otpDelivery.setTestTransport(null);
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('1. Strict Single-Session (đá phiên cũ 401 SESSION_REPLACED + SSE live kick), Refresh Rotation & Reuse Detection (401 SESSION_COMPROMISED)', async () => {
    const email = 'single.session.citizen@dongnai.vn';
    const pass1 = 'CitizenStrong@2026!';
    const regIp = nextIp();

    expect((await call('/api/auth/otp/request', { body: { identifier: email }, ip: regIp })).status).toBe(200);
    const code = transport.lastCodeFor(email);
    const verifyRes = await call<any>('/api/auth/otp/verify', {
      ip: regIp,
      headers: { 'X-Device-Fp': 'device-init' },
      body: { identifier: email, code, name: 'Trần Văn Phiên', password: pass1 },
    });
    expect(verifyRes.status).toBe(200);

    // Chặn mật khẩu yếu không đạt chuẩn production
    const weakPwAttempt = await call<any>('/api/auth/change-password', {
      token: verifyRes.data.token,
      body: { currentPassword: pass1, newPassword: 'password123' },
    });
    expect(weakPwAttempt.status).toBe(400);

    // Thiết bị A đăng nhập thành công và mở luồng SSE theo dõi phiên
    const loginA = await call<any>('/api/auth/password/login', {
      ip: nextIp(),
      headers: { 'X-Device-Fp': 'device-A-chrome' },
      body: { identifier: email, password: pass1 },
    });
    expect(loginA.status).toBe(200);
    const tokenA = loginA.data.token as string;
    expect(loginA.rawSetCookie.some((c) => c.startsWith('sc_access=') && c.includes('SameSite=Strict'))).toBe(true);

    const sseRes = await fetch(`${base}/api/auth/session-events`, {
      headers: { Authorization: `Bearer ${tokenA}`, 'X-Device-Fp': 'device-A-chrome' },
    });
    expect(sseRes.status).toBe(200);
    const sseReader = sseRes.body!.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';
    const firstChunk = await sseReader.read();
    sseBuffer += decoder.decode(firstChunk.value, { stream: true });
    expect(sseBuffer).toContain('session-stream-connected');

    // Thiết bị B đăng nhập cùng tài khoản -> Thu hồi ngay phiên A & đẩy SSE SESSION_REPLACED
    const loginB = await call<any>('/api/auth/password/login', {
      ip: nextIp(),
      headers: { 'X-Device-Fp': 'device-B-iphone' },
      body: { identifier: email, password: pass1 },
    });
    expect(loginB.status).toBe(200);
    const tokenB = loginB.data.token as string;
    const cookiesB = loginB.cookies;

    // Đọc thông báo đá phiên live từ SSE của Thiết bị A
    const kickDeadline = Date.now() + 3000;
    while (!sseBuffer.includes('SESSION_REPLACED') && Date.now() < kickDeadline) {
      const next = await sseReader.read();
      if (next.value) sseBuffer += decoder.decode(next.value, { stream: true });
      if (next.done) break;
    }
    expect(sseBuffer).toContain('event: session_terminated');
    expect(sseBuffer).toContain('SESSION_REPLACED');

    // Mọi request tiếp theo từ Thiết bị A -> 401 SESSION_REPLACED
    const kickedA = await call<any>('/api/me', {
      token: tokenA,
      headers: { 'X-Device-Fp': 'device-A-chrome' },
    });
    expect(kickedA.status).toBe(401);
    expect(kickedA.data.error.code).toBe('SESSION_REPLACED');
    expect(kickedA.data.error.message).toContain('đăng nhập trên thiết bị khác');

    // Refresh Token Rotation trên Thiết bị B: xoay vòng R1 -> R2, sau đó tái sử dụng R1 cũ -> phát hiện đánh cắp 401 SESSION_COMPROMISED
    const rotated = await call<any>('/api/auth/refresh', {
      method: 'POST',
      ip: nextIp(),
      cookies: cookiesB,
      headers: { 'X-Device-Fp': 'device-B-iphone' },
    });
    expect(rotated.status).toBe(200);
    const tokenB2 = rotated.data.token as string;
    expect((await call('/api/me', { token: tokenB2 })).status).toBe(200);

    // Kẻ gian replay Refresh cookie cũ `cookiesB`
    const reuse = await call<any>('/api/auth/refresh', {
      method: 'POST',
      ip: nextIp(),
      cookies: cookiesB,
      headers: { 'X-Device-Fp': 'device-B-iphone' },
    });
    expect(reuse.status).toBe(401);
    expect(reuse.data.error.code).toBe('SESSION_COMPROMISED');

    // Phiên B hiện hành (tokenB2) cũng bị khóa ngay lập tức do nghi ngờ lộ Refresh token
    const compromisedAfterReuse = await call<any>('/api/me', { token: tokenB2 });
    expect(compromisedAfterReuse.status).toBe(401);
    expect(compromisedAfterReuse.data.error.code).toBe('SESSION_COMPROMISED');

    // Brute-force lock (exponential backoff) khi nhập sai mật khẩu quá 5 lần
    const bruteIp = nextIp();
    let bruteStatus = 200;
    for (let i = 0; i < 6; i++) {
      const bad = await call('/api/auth/password/login', {
        ip: bruteIp,
        body: { identifier: email, password: `WrongPass@${i}` },
      });
      bruteStatus = bad.status;
    }
    expect(bruteStatus).toBe(429);
  });

  it('2. Đổi Mật khẩu / Email / SĐT yêu cầu xác thực lại, tăng tokenVersion, thu hồi phiên khác và giữ phiên hiện tại hoạt động liền mạch', async () => {
    const email = 'sec.change.flow@dongnai.vn';
    const pass1 = 'OldSecretPass@2026!';
    const pass2 = 'NewRotatedPass@2027!';
    const ip = nextIp();

    expect((await call('/api/auth/otp/request', { body: { identifier: email }, ip })).status).toBe(200);
    const code1 = transport.lastCodeFor(email);
    const reg = await call<any>('/api/auth/otp/verify', {
      ip,
      headers: { 'X-Device-Fp': 'fp-current' },
      body: { identifier: email, code: code1, name: 'Nguyễn Văn Bảo Mật', password: pass1 },
    });
    expect(reg.status).toBe(200);
    const oldToken = reg.data.token as string;
    const prevVersion = reg.data.user.tokenVersion as number;

    // Sai mật khẩu hiện tại -> bị từ chối
    const wrongCur = await call<any>('/api/auth/change-password', {
      token: oldToken,
      body: { currentPassword: 'WrongCurrent@123', newPassword: pass2 },
    });
    expect([400, 401, 403]).toContain(wrongCur.status);

    // Đổi mật khẩu hợp lệ -> cấp cặp token & cookie mới, tăng tokenVersion, thu hồi token cũ nhưng giữ phiên hiện tại sống
    const chPass = await call<any>('/api/auth/change-password', {
      token: oldToken,
      headers: { 'X-Device-Fp': 'fp-current' },
      body: { currentPassword: pass1, newPassword: pass2 },
    });
    expect(chPass.status).toBe(200);
    expect(chPass.data.token).toBeTruthy();
    expect(chPass.data.token).not.toBe(oldToken);
    expect(chPass.data.user.tokenVersion).toBeGreaterThan(prevVersion);
    expect(chPass.rawSetCookie.some((c) => c.startsWith('sc_access=') && c.includes('SameSite=Strict'))).toBe(true);

    // Token cũ trước khi đổi mật khẩu bị vô hiệu hóa ngay
    expect((await call('/api/me', { token: oldToken })).status).toBe(401);
    // Token mới vừa cấp hoạt động bình thường
    expect((await call('/api/me', { token: chPass.data.token })).status).toBe(200);

    // Đổi Email bằng OTP + Mật khẩu hiện tại
    const newEmail = 'sec.change.updated@dongnai.vn';
    expect(
      (await call('/api/auth/otp/request', {
        body: { identifier: newEmail, purpose: 'change_email' },
        ip: nextIp(),
      })).status,
    ).toBe(200);
    const emailOtp = transport.lastCodeFor(newEmail);
    const chEmail = await call<any>('/api/auth/change-email', {
      token: chPass.data.token,
      headers: { 'X-Device-Fp': 'fp-current' },
      body: { newEmail, otpCode: emailOtp, currentPassword: pass2 },
    });
    expect(chEmail.status).toBe(200);
    expect(chEmail.data.user.email).toBe(newEmail);
    expect(chEmail.data.user.tokenVersion).toBeGreaterThan(chPass.data.user.tokenVersion);
    expect((await call('/api/me', { token: chPass.data.token })).status).toBe(401);
    expect((await call('/api/me', { token: chEmail.data.token })).status).toBe(200);

    // Đổi Số điện thoại: yêu cầu OTP qua SĐT mới + Mật khẩu hiện tại -> cập nhật SĐT, tăng tokenVersion
    const newPhone = '0987654321';
    expect(
      (await call('/api/auth/otp/request', {
        body: { identifier: newPhone, purpose: 'change_phone' },
        ip: nextIp(),
      })).status,
    ).toBe(200);
    const phoneOtp = transport.lastCodeFor(newPhone);
    const chPhoneOk = await call<any>('/api/auth/change-phone', {
      token: chEmail.data.token,
      headers: { 'X-Device-Fp': 'fp-current' },
      body: { newPhone, otpCode: phoneOtp, currentPassword: pass2 },
    });
    expect(chPhoneOk.status).toBe(200);
    expect(chPhoneOk.data.user.tokenVersion).toBeGreaterThan(chEmail.data.user.tokenVersion);
    expect((await call('/api/me', { token: chEmail.data.token })).status).toBe(401);
    expect((await call('/api/me', { token: chPhoneOk.data.token })).status).toBe(200);
  });

  it('3. Multi-Layer Local AI Forensics: Chặn cứng Screenshot / AI / ELA / Ảnh lật & cắt khi nộp; và kiểm 4 bước Before/After + Moderation Queue', async () => {
    const { INITIAL_STAFF_PASSWORD } = await import('../src/data/seedStore');
    const cIp = nextIp();
    const citizenEmail = 'forensics.citizen@dongnai.vn';
    expect((await call('/api/auth/otp/request', { body: { identifier: citizenEmail }, ip: cIp })).status).toBe(200);
    const citizenRes = await call<any>('/api/auth/otp/verify', {
      ip: cIp,
      body: {
        identifier: citizenEmail,
        code: transport.lastCodeFor(citizenEmail),
        name: 'Lê Thị Hiện Trường',
        password: 'FieldReporter@2026!',
      },
    });
    const cToken = citizenRes.data.token as string;
    const citizenId = citizenRes.data.user.id as string;

    const adminLogin = await call<any>('/api/auth/staff/login', {
      ip: nextIp(),
      body: { staffCode: 'TP-01', password: INITIAL_STAFF_PASSWORD, unit: 'city' },
    });
    expect(adminLogin.status).toBe(200);
    const adminToken = adminLogin.data.token as string;

    // 3A-1: Ảnh AI / C2PA (`Software: Midjourney v6.1`) -> HTTP 422 AI_IMAGE_DETECTED
    const aiFake = await makeStreetScene({ defect: 'full', exifSoftware: 'Midjourney v6.1' });
    const aiResp = await call<any>('/api/reports', {
      token: cToken,
      body: {
        idempotencyKey: `e2e-ai-${Date.now()}`,
        category: 'rac_thai',
        title: 'Ảnh AI tạo sinh rác giả mạo',
        description: 'Đống rác gần khu dân cư',
        lat: 10.9465,
        lng: 106.8235,
        wardCode: 'DN-TB',
        photo: { dataUrl: aiFake.dataUrl, dHash: aiFake.dHash },
      },
    });
    expect(aiResp.status).toBe(422);
    expect(aiResp.data.error.code).toBe('AI_IMAGE_DETECTED');

    // 3A-2: Ảnh Chụp Màn Hình -> HTTP 422 SCREENSHOT_DETECTED
    const screenFake = await makeMobileScreenshot();
    const screenResp = await call<any>('/api/reports', {
      token: cToken,
      body: {
        idempotencyKey: `e2e-screen-${Date.now()}`,
        category: 'den_duong',
        title: 'Ảnh chụp màn hình điện thoại',
        description: 'Gửi ảnh chụp màn hình lên bản đồ',
        lat: 10.948,
        lng: 106.824,
        wardCode: 'DN-TB',
        photo: { dataUrl: screenFake.dataUrl, dHash: screenFake.dHash },
      },
    });
    expect(screenResp.status).toBe(422);
    expect(screenResp.data.error.code).toBe('SCREENSHOT_DETECTED');

    // 3A-3: Ảnh ghép giả ELA (`makeElaTamperedJpeg`) -> HTTP 422 EDITED_IMAGE_DETECTED
    const elaFake = await makeElaTamperedJpeg();
    const elaResp = await call<any>('/api/reports', {
      token: cToken,
      body: {
        idempotencyKey: `e2e-ela-${Date.now()}`,
        category: 'mat_duong',
        title: 'Ảnh đã chỉnh sửa ghép vá ELA',
        description: 'Ổ gà trên mặt đường nhựa',
        lat: 10.949,
        lng: 106.825,
        wardCode: 'DN-TB',
        photo: { dataUrl: elaFake.dataUrl, dHash: elaFake.dHash },
      },
    });
    expect(elaResp.status).toBe(422);
    expect(elaResp.data.error.code).toBe('EDITED_IMAGE_DETECTED');

    // Kiểm tra User Violations & Audit Log đã tự động ghi nhận cả 3 lần chặn Gatekeeper
    const vio = await call<any>(`/api/admin/users/${citizenId}/violations`, { token: adminToken });
    expect(vio.status).toBe(200);
    expect(vio.data.user.violationCount).toBeGreaterThanOrEqual(3);
    expect(vio.data.violations.some((v: any) => v.action === 'report.rejected_gatekeeper')).toBe(true);

    // Tạo 1 công dân uy tín sạch (`honestCitizen`) gửi ảnh hiện trường thật hợp lệ
    const honestIp = nextIp();
    const honestEmail = 'honest.reporter@dongnai.vn';
    expect((await call('/api/auth/otp/request', { body: { identifier: honestEmail }, ip: honestIp })).status).toBe(200);
    const honestRes = await call<any>('/api/auth/otp/verify', {
      ip: honestIp,
      body: {
        identifier: honestEmail,
        code: transport.lastCodeFor(honestEmail),
        name: 'Trần Hữu Chân Thực',
        password: 'HonestReporter@2026!',
      },
    });
    const honestToken = honestRes.data.token as string;
    const honestId = honestRes.data.user.id as string;

    // 3A-4: Ảnh thật hợp lệ -> Tạo thành công Master Report; sau đó Lật ngang (Flop) hoặc Cắt góc -> bị chặn 422 DUPLICATE_IMAGE_DETECTED
    const realBefore = await makeStreetScene({ defect: 'full' });
    const masterRes = await call<any>('/api/reports', {
      token: honestToken,
      body: {
        idempotencyKey: `e2e-real-${Date.now()}`,
        category: 'rac_thai',
        title: 'Bãi rác tự phát chân cột điện Trấn Biên',
        description: 'Rác thải chất đống giữa đường gây mùi hôi thối và cản trở lưu thông.',
        lat: 10.9468,
        lng: 106.8232,
        wardCode: 'DN-TB',
        photo: {
          dataUrl: realBefore.dataUrl,
          dHash: realBefore.dHash,
          exif: { capturedAt: new Date(Date.now() - 30_000).toISOString(), cameraMake: 'Samsung', cameraModel: 'Galaxy S24', gps: { lat: 10.9468, lng: 106.8232 } },
        },
      },
    });
    expect(masterRes.status).toBe(201);
    expect(masterRes.data.outcome).toBe('created');
    const masterId = masterRes.data.report.id as string;

    const flopped = await transformBufferWithHash(realBefore.buffer, 'flop');
    const flopRes = await call<any>('/api/reports', {
      token: honestToken,
      body: {
        idempotencyKey: `e2e-flop-${Date.now()}`,
        category: 'rac_thai',
        title: 'Ảnh lật ngang gửi lại sự cố cũ',
        description: 'Thử qua mặt hash bằng cách lật ngang ảnh',
        lat: 10.96,
        lng: 106.83,
        wardCode: 'DN-TB',
        photo: { dataUrl: flopped.dataUrl, dHash: flopped.dHash },
      },
    });
    expect(flopRes.status).toBe(422);
    expect(flopRes.data.error.code).toBe('DUPLICATE_IMAGE_DETECTED');

    const cropped = await transformBufferWithHash(realBefore.buffer, 'crop');
    const cropRes = await call<any>('/api/reports', {
      token: honestToken,
      body: {
        idempotencyKey: `e2e-crop-${Date.now()}`,
        category: 'rac_thai',
        title: 'Ảnh cắt 25% góc trên gửi lại sự cố cũ',
        description: 'Thử crop một góc ảnh có sẵn',
        lat: 10.962,
        lng: 106.832,
        wardCode: 'DN-TB',
        photo: { dataUrl: cropped.dataUrl, dHash: cropped.dHash },
      },
    });
    expect(cropRes.status).toBe(422);
    expect(cropRes.data.error.code).toBe('DUPLICATE_IMAGE_DETECTED');

    // Bảo đảm ảnh giả / trùng KHÔNG lọt ra bản đồ công khai
    const pubList = await call<any[]>('/api/reports?scope=city');
    expect(pubList.data.some((r) => r.id === masterId)).toBe(true);
    expect(pubList.data.some((r) => String(r.title).includes('Ảnh ') || String(r.title).includes('giả mạo'))).toBe(false);
    void honestId;

    // 3B: Duyệt ảnh Sau Khi Hoàn Thành (4 bước Before/After nghiêm ngặt)
    // 1) Ảnh Sau trùng y hệt ảnh Trước -> NO_CHANGE_DETECTED
    const resSame = await call<any>(`/api/admin/reports/${masterId}/resolve`, {
      token: adminToken,
      body: { afterPhoto: { dataUrl: realBefore.dataUrl, dHash: realBefore.dHash }, note: 'Nộp lại ảnh cũ' },
    });
    expect(resSame.status).toBe(200);
    expect(resSame.data.accepted).toBe(false);
    expect(resSame.data.report.resolution.rejectedReasonCode).toBe('NO_CHANGE_DETECTED');

    // 2) Ảnh Sau chụp ở địa điểm khác hoàn toàn -> SCENE_MISMATCH
    const wrongScene = await makeDifferentScene();
    const resMismatch = await call<any>(`/api/admin/reports/${masterId}/resolve`, {
      token: adminToken,
      body: { afterPhoto: { dataUrl: wrongScene.dataUrl, dHash: wrongScene.dHash }, note: 'Chụp sai chỗ' },
    });
    expect(resMismatch.status).toBe(200);
    expect(resMismatch.data.accepted).toBe(false);
    expect(resMismatch.data.report.resolution.rejectedReasonCode).toBe('SCENE_MISMATCH');

    // 3) Ảnh Sau gắn chữ ký AI/chỉnh sửa -> Tầng 1 chặn ngay (forensicPassed === false)
    const afterAiEdit = await makeStreetScene({ defect: 'none', exifSoftware: 'Adobe Firefly' });
    const resAi = await call<any>(`/api/admin/reports/${masterId}/resolve`, {
      token: adminToken,
      body: {
        afterPhoto: { dataUrl: afterAiEdit.dataUrl, dHash: afterAiEdit.dHash },
        lat: 10.9468,
        lng: 106.8232,
        exif: { capturedAt: new Date(Date.now() + 120_000).toISOString(), software: 'Adobe Firefly' },
        note: 'Dùng AI xóa rác',
      },
    });
    expect(resAi.status).toBe(200);
    expect(resAi.data.accepted).toBe(false);
    expect(resAi.data.report.resolution.forensicPassed).toBe(false);

    // 4) Ảnh Sau vượt bán kính > 150m -> GPS_OUT_OF_RANGE
    const realAfter = await makeStreetScene({ defect: 'none', bright: 0.65 });
    const resFarGps = await call<any>(`/api/admin/reports/${masterId}/resolve`, {
      token: adminToken,
      body: {
        afterPhoto: { dataUrl: realAfter.dataUrl, dHash: realAfter.dHash },
        lat: 10.955,
        lng: 106.835,
        exif: { capturedAt: new Date(Date.now() + 120_000).toISOString() },
        note: 'GPS cách hiện trường > 1km',
      },
    });
    expect(resFarGps.status).toBe(200);
    expect(resFarGps.data.accepted).toBe(false);
    expect(resFarGps.data.report.resolution.rejectedReasonCode).toBe('GPS_OUT_OF_RANGE');

    // 5) Ảnh Sau EXIF thời gian chụp TRƯỚC thời điểm tạo báo cáo -> EXIF_BEFORE_REPORT
    const resStaleExif = await call<any>(`/api/admin/reports/${masterId}/resolve`, {
      token: adminToken,
      body: {
        afterPhoto: { dataUrl: realAfter.dataUrl, dHash: realAfter.dHash },
        lat: 10.9468,
        lng: 106.8232,
        exif: { capturedAt: new Date(Date.now() - 86_400_000).toISOString() },
        note: 'Ảnh cũ chụp từ hôm qua',
      },
    });
    expect(resStaleExif.status).toBe(200);
    expect(resStaleExif.data.accepted).toBe(false);
    expect(resStaleExif.data.report.resolution.rejectedReasonCode).toBe('EXIF_BEFORE_REPORT');

    // 6) Đưa 1 báo cáo nghi vấn (EXIF cũ >90 ngày & lệch GPS >500m & user bị giám sát -> quarantined) vào Hàng đợi Kiểm duyệt (Moderation Queue) -> Admin APPROVE
    const cleanReviewScene = await makeStreetScene({ defect: 'full', water: true, bright: 0.78 });
    const flagCitizenRes = await call<any>('/api/reports', {
      token: cToken,
      body: {
        idempotencyKey: `e2e-borderline-${Date.now()}`,
        category: 'rac_thai',
        title: 'Điểm tập kết rác tồn đọng khu phố 4 Trấn Biên',
        description: 'Bãi rác lâu ngày chưa được thu gom sạch tại ngã tư đường.',
        lat: 10.951,
        lng: 106.826,
        wardCode: 'DN-TB',
        photo: {
          dataUrl: cleanReviewScene.dataUrl,
          dHash: cleanReviewScene.dHash,
          exif: {
            capturedAt: new Date(Date.now() - 120 * 86_400_000).toISOString(),
            cameraMake: 'Canon',
            cameraModel: 'EOS',
            gps: { lat: 10.96, lng: 106.835 },
          },
        },
      },
    });
    expect(flagCitizenRes.status).toBe(201);
    const modQueue = await call<any[]>('/api/admin/moderation-queue?scope=city', { token: adminToken });
    expect(modQueue.status).toBe(200);
    expect(modQueue.data.some((m) => m.report.id === flagCitizenRes.data.report.id)).toBe(true);

    const modDecide = await call<any>(`/api/admin/moderation-queue/${flagCitizenRes.data.report.id}/decide`, {
      token: adminToken,
      body: { decision: 'APPROVE', note: 'Đã xác minh hiện trường thực tế qua camera khu vực' },
    });
    expect(modDecide.status).toBe(200);
    expect(modDecide.data.status).not.toBe('quarantined');

    // 7) Ảnh Sau hợp lệ (cùng bối cảnh cột điện/cây xanh, hết rác, đúng GPS <=150m, thời gian sau report.createdAt) -> AUTO_VERIFIED
    const resOk = await call<any>(`/api/admin/reports/${masterId}/resolve`, {
      token: adminToken,
      body: {
        afterPhoto: { dataUrl: realAfter.dataUrl, dHash: realAfter.dHash },
        lat: 10.94682,
        lng: 106.82322,
        exif: { capturedAt: new Date(Date.now() + 180_000).toISOString(), cameraMake: 'Samsung', cameraModel: 'Galaxy S24' },
        note: 'Đã thu gom rác sạch sẽ và khử trùng khu vực',
      },
    });
    expect(resOk.status).toBe(200);
    expect(resOk.data.accepted).toBe(true);
    expect(resOk.data.report.resolutionStatus).toBe('AUTO_VERIFIED');
    expect(resOk.data.report.status).toBe('resolved');
  });

  it('4. Zero-Trust RBAC (chặn leo thang/IDOR ngoài địa bàn), Command Center (Force Logout, Trust Flag), Re-auth & Immutable Audit Log Export', async () => {
    const { INITIAL_STAFF_PASSWORD } = await import('../src/data/seedStore');

    // Đăng nhập Super Admin & Cán bộ Phường Trấn Biên (`DN-TB`)
    const adminLogin = await call<any>('/api/auth/staff/login', {
      ip: nextIp(),
      headers: { 'X-Device-Fp': 'admin-cmd-fp' },
      body: { staffCode: 'TP-01', password: INITIAL_STAFF_PASSWORD, unit: 'city' },
    });
    expect(adminLogin.status).toBe(200);
    const adminToken = adminLogin.data.token as string;

    const officerLogin = await call<any>('/api/auth/staff/login', {
      ip: nextIp(),
      headers: { 'X-Device-Fp': 'officer-tb-fp' },
      body: { staffCode: 'CB-TB-01', password: INITIAL_STAFF_PASSWORD, unit: 'DN-TB' },
    });
    expect(officerLogin.status).toBe(200);
    const officerToken = officerLogin.data.token as string;

    // Công dân nộp báo cáo thuộc Phường Long Thành (`DN-LTH` - ngoài địa bàn của `CB-TB-01`)
    const cIp = nextIp();
    const lthEmail = 'lth.citizen@dongnai.vn';
    expect((await call('/api/auth/otp/request', { body: { identifier: lthEmail }, ip: cIp })).status).toBe(200);
    const cLogin = await call<any>('/api/auth/otp/verify', {
      ip: cIp,
      headers: { 'X-Device-Fp': 'citizen-lth-fp' },
      body: { identifier: lthEmail, code: transport.lastCodeFor(lthEmail), name: 'Phạm Long Thành', defaultWardCode: 'DN-LTH' },
    });
    const lthCitizenToken = cLogin.data.token as string;
    const lthCitizenId = cLogin.data.user.id as string;

    const lthScene = await makeStreetScene({ defect: 'none', water: true });
    const lthReportRes = await call<any>('/api/reports', {
      token: lthCitizenToken,
      body: {
        idempotencyKey: `lth-rep-${Date.now()}`,
        category: 'ngap_nuoc',
        title: 'Ngập cục bộ ngã tư Long Thành',
        description: 'Nước dâng cao sau cơn mưa lớn gây kẹt xe cục bộ.',
        lat: 10.7785,
        lng: 106.9522,
        wardCode: 'DN-LTH',
        photo: { dataUrl: lthScene.dataUrl, dHash: lthScene.dHash },
      },
    });
    expect(lthReportRes.status).toBe(201);
    const lthReportId = lthReportRes.data.report.id as string;

    // Chặn IDOR: Cán bộ Trấn Biên (`DN-TB`) cố truy cập / thao tác đơn ở Long Thành (`DN-LTH`) hoặc xem Users/Sessions hệ thống -> 403
    expect((await call(`/api/admin/reports/${lthReportId}/assign`, { token: officerToken, body: { department: 'dien_luc', slaHours: 12 } })).status).toBe(403);
    expect((await call('/api/admin/users', { token: officerToken })).status).toBe(403);
    expect((await call('/api/admin/sessions', { token: officerToken })).status).toBe(403);

    // Command Center: Admin xem phiên hoạt động -> thấy phiên của Officer & Citizen -> Force Logout Officer
    const sessionsRes = await call<any[]>('/api/admin/sessions', { token: adminToken });
    expect(sessionsRes.status).toBe(200);
    expect(sessionsRes.data.length).toBeGreaterThanOrEqual(2);
    expect(sessionsRes.data.some((s) => s.userId === officerLogin.data.user.id)).toBe(true);

    const kickOfficer = await call<any>(`/api/admin/users/${officerLogin.data.user.id}/force-logout`, {
      token: adminToken,
      body: {},
    });
    expect(kickOfficer.status).toBe(200);
    expect(kickOfficer.data.revokedCount).toBeGreaterThanOrEqual(1);

    // Token Officer bị đá ngay lập tức -> 401 SESSION_REVOKED
    const afterKick = await call<any>('/api/admin/overview?scope=ward:DN-TB', { token: officerToken });
    expect(afterKick.status).toBe(401);
    expect(afterKick.data.error.code).toBe('SESSION_REVOKED');

    // Gắn cờ Spam (`trustLevel: 'flagged'`) cho Citizen
    const flagged = await call<any>(`/api/admin/users/${lthCitizenId}/trust-flag`, {
      method: 'PATCH',
      token: adminToken,
      body: { trustLevel: 'flagged', reason: 'Gửi thông tin sai lệch nhiều lần', trustScore: 25 },
    });
    expect(flagged.status).toBe(200);
    expect(flagged.data.trustLevel).toBe('flagged');
    expect(flagged.data.trustScore).toBe(25);

    // Force Logout toàn hệ thống yêu cầu Re-auth: không Re-auth -> 403 REAUTH_REQUIRED, có Re-auth -> 200 & giữ phiên Admin hiện tại
    const kickAllNoReauth = await call<any>('/api/admin/sessions/force-logout-all', {
      token: adminToken,
      body: {},
    });
    expect(kickAllNoReauth.status).toBe(403);
    expect(kickAllNoReauth.data.error.code).toBe('REAUTH_REQUIRED');

    const reauth = await call<any>('/api/auth/reauth', {
      token: adminToken,
      body: { currentPassword: INITIAL_STAFF_PASSWORD },
    });
    expect(reauth.status).toBe(200);
    const kickAllOk = await call<any>('/api/admin/sessions/force-logout-all', {
      token: adminToken,
      headers: { 'X-Reauth-Token': reauth.data.reauthToken },
      body: {},
    });
    expect(kickAllOk.status).toBe(200);
    expect((await call('/api/me', { token: adminToken })).status).toBe(200);
    expect((await call('/api/me', { token: lthCitizenToken })).status).toBe(401);

    // Audit Log Bất biến: xác minh chuỗi hash, lọc theo action, xuất CSV & JSON, và không có API sửa/xóa Audit Log
    const verifyRes = await call<any>('/api/admin/audit/verify', { token: adminToken });
    expect(verifyRes.status).toBe(200);
    expect(verifyRes.data.valid).toBe(true);
    expect(verifyRes.data.total).toBeGreaterThan(5);

    const filteredLogs = await call<any[]>('/api/admin/audit?action=force_logout', { token: adminToken });
    expect(filteredLogs.status).toBe(200);
    expect(filteredLogs.data.length).toBeGreaterThanOrEqual(2);
    expect(filteredLogs.data.every((e) => String(e.action).includes('force_logout'))).toBe(true);

    const csvExport = await call('/api/admin/audit/export?format=csv', { token: adminToken });
    expect(csvExport.status).toBe(200);
    expect(csvExport.rawText).toContain('Seq,Thời gian,Actor ID,Người thao tác,Vai trò,Hành động,Mục tiêu,IP,Trước,Sau,Hash');

    const jsonExport = await call<any>('/api/admin/audit/export?format=json', { token: adminToken });
    expect(jsonExport.status).toBe(200);
    expect(Array.isArray(jsonExport.data.entries)).toBe(true);

    // Tuyệt đối không có endpoint sửa hoặc xóa Nhật ký Kiểm toán
    expect((await call('/api/admin/audit', { method: 'DELETE', token: adminToken })).status).toBe(404);
    expect((await call('/api/admin/audit/1', { method: 'PATCH', token: adminToken, body: { action: 'tamper' } })).status).toBe(404);
  });
});
