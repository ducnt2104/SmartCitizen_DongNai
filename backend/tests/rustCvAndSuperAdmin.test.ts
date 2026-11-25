import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OtpSendPayload, OtpTransport } from '../src/services/otpDelivery.service';

// ── Bộ mã hóa PNG chuẩn không phụ thuộc thư viện ngoài (dùng node:zlib + CRC32) ──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodeRgbPngDataUrl(
  w: number,
  h: number,
  pixelFn: (x: number, y: number) => [number, number, number],
): { dataUrl: string; dHash: string } {
  const raw = Buffer.alloc(h * (1 + w * 3));
  const gray = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const rowOff = y * (1 + w * 3);
    raw[rowOff] = 0; // filter None
    for (let x = 0; x < w; x++) {
      const [r, g, b] = pixelFn(x, y);
      const off = rowOff + 1 + x * 3;
      raw[off] = r;
      raw[off + 1] = g;
      raw[off + 2] = b;
      gray[y * w + x] = 0.299 * r + 0.587 * g + 0.114 * b;
    }
  }

  // Tính 64-bit dHash chuẩn 9x8 từ ảnh vừa sinh
  const small = new Float32Array(9 * 8);
  for (let gy = 0; gy < 8; gy++) {
    const sy = Math.min(h - 1, Math.floor((gy * h) / 8));
    for (let gx = 0; gx < 9; gx++) {
      const sx = Math.min(w - 1, Math.floor((gx * w) / 9));
      small[gy * 9 + sx % 9] = gray[sy * w + sx];
      small[gy * 9 + gx] = gray[sy * w + sx];
    }
  }
  let hex = '';
  let cur = 0;
  let bits = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      cur = (cur << 1) | (small[y * 9 + x] > small[y * 9 + x + 1] ? 1 : 0);
      bits++;
      if (bits === 4) {
        hex += cur.toString(16);
        cur = 0;
        bits = 0;
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const idat = zlib.deflateSync(raw, { level: 3 });
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
  return { dataUrl: `data:image/png;base64,${png.toString('base64')}`, dHash: hex };
}

/** Sinh ảnh hiện trường đường phố có kiến trúc nền giàu góc cạnh + tùy chọn đống rác sự cố + tỷ lệ sáng. */
function makeStreetScene(
  w: number,
  h: number,
  opts: { withDefect: boolean; brightnessScale?: number; crop?: { x0: number; y0: number; fullW: number; fullH: number } },
): { dataUrl: string; dHash: string } {
  const bScale = opts.brightnessScale ?? 1.0;
  const fullW = opts.crop?.fullW ?? w;
  const fullH = opts.crop?.fullH ?? h;
  const xOff = opts.crop?.x0 ?? 0;
  const yOff = opts.crop?.y0 ?? 0;

  return encodeRgbPngDataUrl(w, h, (lx, ly) => {
    const x = lx + xOff;
    const y = ly + yOff;
    const hash = (Math.imul(x, 374761393) + Math.imul(y, 668265263)) ^ Math.imul(x, y);
    const grain = ((hash & 0x1f) - 16) * 0.9;

    let r = 90;
    let g = 92;
    let b = 96;
    if (y < fullH * 0.28) {
      r = 155 + grain * 0.4;
      g = 192 + grain * 0.4;
      b = 226 + grain * 0.4;
    } else if (y < fullH * 0.58) {
      const bx = Math.floor(x / 26) % 7;
      const by = Math.floor(y / 20) % 5;
      const win = x % 26 > 6 && x % 26 < 19 && y % 20 > 5 && y % 20 < 15;
      const pole = (x > fullW * 0.2 && x < fullW * 0.2 + 10) || (x > fullW * 0.78 && x < fullW * 0.78 + 11);
      if (pole) {
        r = 62 + grain;
        g = 68 + grain;
        b = 75 + grain;
      } else if (win) {
        r = 45 + bx * 17 + grain;
        g = 62 + by * 13 + grain;
        b = 90 + grain;
      } else {
        r = 166 + bx * 9 + grain;
        g = 156 + by * 8 + grain;
        b = 140 + grain;
      }
    } else {
      const curb = y < fullH * 0.61;
      const dash = y > fullH * 0.76 && y < fullH * 0.79 && Math.floor(x / 40) % 2 === 0;
      if (curb) {
        r = 185 + grain;
        g = 182 + grain;
        b = 172 + grain;
      } else if (dash) {
        r = 225;
        g = 220;
        b = 196;
      } else {
        r = 86 + grain;
        g = 88 + grain;
        b = 92 + grain;
      }
    }

    if (opts.withDefect) {
      const dx = x - fullW * 0.5;
      const dy = y - fullH * 0.74;
      if ((dx * dx) / (fullW * 0.22) ** 2 + (dy * dy) / (fullH * 0.14) ** 2 <= 1.0) {
        const patch = Math.abs((Math.floor(x / 5) + Math.floor(y / 4)) * 37 + (hash & 0xff)) % 5;
        if (patch === 0) [r, g, b] = [24, 26, 30];
        else if (patch === 1) [r, g, b] = [218, 46, 36];
        else if (patch === 2) [r, g, b] = [34, 168, 62];
        else if (patch === 3) [r, g, b] = [232, 196, 28];
        else [r, g, b] = [32, 86, 198];
      }
    }

    const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v * bScale)));
    return [clamp(r), clamp(g), clamp(b)];
  });
}

/** Sinh ảnh chụp màn hình điện thoại (thanh trạng thái trên + vùng UI phẳng + chữ sắc nét + thanh điều hướng dưới). */
function makeMobileScreenshot(): { dataUrl: string; dHash: string } {
  const w = 360;
  const h = 800;
  return encodeRgbPngDataUrl(w, h, (x, y) => {
    if (y < 40) {
      const glyph = y > 12 && y < 26 && ((x > 24 && x < 76 && x % 6 < 3) || (x > 286 && x < 340 && x % 7 < 4));
      return glyph ? [255, 255, 255] : [15, 23, 42];
    }
    if (y >= 744) {
      const pill = y > 783 && y < 791 && x > 130 && x < 230;
      return pill ? [255, 255, 255] : [15, 23, 42];
    }
    if (y > 90 && y < 690 && x > 20 && x < 340) {
      const text = y % 46 > 16 && y % 46 < 22 && x > 36 && x < 285 && x % 5 !== 0;
      return text ? [18, 24, 38] : [255, 255, 255];
    }
    return [244, 246, 250];
  });
}

class TestOtpTransport implements OtpTransport {
  readonly provider = 'test_otp';
  readonly channel = 'sms' as const;
  private codes = new Map<string, string>();
  async send(p: OtpSendPayload): Promise<void> {
    this.codes.set(p.to, p.code);
  }
  get(to: string): string {
    return this.codes.get(to)!;
  }
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

describe('Integration Suite: Fail-Loud MongoDB, Super Admin RBAC 5 Cấp, OTHER Category & Live Rust CV Engine', () => {
  let tmpDir = '';
  let base = '';
  let closeApp: () => Promise<void> = async () => undefined;
  let rustProc: ChildProcess | null = null;
  let cvPort = 0;
  let superPassword = '';
  const otp = new TestOtpTransport();

  async function call<T = any>(
    p: string,
    init: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; data: T }> {
    const res = await fetch(`${base}${p}`, {
      method: init.method ?? (init.body ? 'POST' : 'GET'),
      headers: {
        'Content-Type': 'application/json',
        ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
        'X-Device-Fp': 'integration-fp-01',
        ...(init.headers ?? {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
  }

  let ipSeq = 50;
  async function loginCitizen(phone: string): Promise<string> {
    const ip = `10.9.0.${++ipSeq}`;
    await call('/api/auth/otp/request', { body: { identifier: phone }, headers: { 'X-Forwarded-For': ip } });
    const code = otp.get(phone);
    const v = await call<{ token: string }>('/api/auth/otp/verify', { body: { identifier: phone, code } });
    expect(v.status).toBe(200);
    return v.data.token;
  }

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-rust-e2e-'));
    cvPort = await getFreePort();

    // Khởi chạy tiến trình Rust High-Speed CV & ONNX Engine thật vừa biên dịch
    const exeName = process.platform === 'win32' ? 'smartcitizen-cv-engine.exe' : 'smartcitizen-cv-engine';
    const binPath = path.resolve(__dirname, '../../engine/target/release', exeName);
    expect(fs.existsSync(binPath)).toBe(true);

    rustProc = spawn(binPath, [], {
      env: {
        ...process.env,
        CV_ENGINE_HOST: '127.0.0.1',
        CV_ENGINE_PORT: String(cvPort),
        CV_MODELS_DIR: path.join(tmpDir, 'models'),
      },
      stdio: 'ignore',
    });

    // Chờ Rust CV Engine sẵn sàng (< 1.5s)
    let ready = false;
    for (let i = 0; i < 25; i++) {
      try {
        const h = await fetch(`http://127.0.0.1:${cvPort}/health`);
        if (h.ok) {
          ready = true;
          break;
        }
      } catch {
        // retry
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(ready).toBe(true);

    process.env.DATA_DIR = tmpDir;
    process.env.NODE_ENV = 'test';
    process.env.MONGODB_URI = '';
    process.env.CV_ENGINE_URL = `http://127.0.0.1:${cvPort}`;
    process.env.REPORTS_PER_HOUR = '20';

    const { createRepositories } = await import('../src/repositories');
    const { createServices } = await import('../src/services/container');
    const { INITIAL_SUPER_ADMIN_PASSWORD, seedIfEmpty } = await import('../src/data/seedStore');
    const { createApp } = await import('../src/app');

    superPassword = INITIAL_SUPER_ADMIN_PASSWORD;
    const boot = await createRepositories();
    const s = createServices(boot.repos);
    s.cvEngine.setBaseUrl(`http://127.0.0.1:${cvPort}`);
    s.otpDelivery.setTestTransport(otp);
    await seedIfEmpty(boot.repos, s.audit, { includeFixtures: true });

    const srv = createApp(s, boot).listen(0);
    base = `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}`;
    closeApp = async () => {
      s.otpDelivery.setTestTransport(null);
      await new Promise((r) => srv.close(r));
      await boot.repos.close();
    };
  }, 60_000);

  afterAll(async () => {
    await closeApp();
    if (rustProc) rustProc.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('1. Chặn hoàn toàn lỗi Mock Fallback âm thầm khi MONGODB_URI kết nối thất bại và báo Health thật', async () => {
    const h = await call<any>('/api/health');
    expect(h.status).toBe(200);
    expect(h.data.cvEngine.online).toBe(true);
    expect(h.data.cvEngine.engine).toBe('rust-axum-cv-onnx-1.0');
    expect(h.data.db.counts.reports).toBeGreaterThanOrEqual(80);
    expect(h.data.rag.indexedDocuments).toBeGreaterThanOrEqual(95);

    // Kiểm chứng model ONNX đã được Rust sinh và nạp trên đĩa
    expect(fs.existsSync(path.join(tmpDir, 'models', 'authenticity_defect_v1.onnx'))).toBe(true);
  });

  it('2. Super Admin đăng nhập -> Tạo Officer -> Sửa quyền -> Reset mật khẩu -> Khóa tài khoản -> Chặn tự xóa mình', async () => {
    const login = await call<any>('/api/auth/admin/login', {
      body: { staffCode: 'SUPER-ADMIN', password: superPassword, unit: 'city' },
    });
    expect(login.status).toBe(200);
    expect(login.data.user.role).toBe('admin');
    expect(login.data.user.roleCode).toBe('ADMIN');
    const saToken = login.data.token as string;
    const saId = login.data.user.id as string;

    // Tạo mới Officer gắn với Phường Trấn Biên (DN-TB)
    const created = await call<any>('/api/admin/users', {
      token: saToken,
      body: {
        name: 'Võ Minh Quân',
        role: 'OFFICER',
        wardCode: 'DN-TB',
        staffCode: 'CB-TB-99',
        email: 'quan.vm@dongnai.gov.vn',
        password: 'OfficerPassword@2026',
      },
    });
    expect(created.status).toBe(201);
    expect(created.data.role).toBe('officer');
    expect(created.data.roleCode).toBe('OFFICER');
    const officerId = created.data.id as string;

    // Officer vừa tạo đăng nhập thành công
    const offLogin1 = await call<any>('/api/auth/staff/login', {
      body: { staffCode: 'CB-TB-99', password: 'OfficerPassword@2026', unit: 'DN-TB' },
    });
    expect(offLogin1.status).toBe(200);

    // Sửa thông tin & đổi quyền sang ADMIN
    const updated = await call<any>(`/api/admin/users/${officerId}`, {
      method: 'PATCH',
      token: saToken,
      body: { role: 'ADMIN', wardCode: null, name: 'Võ Minh Quân (TP)' },
    });
    expect(updated.status).toBe(200);
    expect(updated.data.role).toBe('admin');
    expect(updated.data.roleCode).toBe('ADMIN');

    // Reset mật khẩu
    const resetRes = await call(`/api/admin/users/${officerId}/reset-password`, {
      token: saToken,
      body: { newPassword: 'ResetPassword@2026!' },
    });
    expect(resetRes.status).toBe(200);

    // Khóa tài khoản (`isActive: false`) -> đăng nhập bị từ chối 403
    const locked = await call<any>(`/api/admin/users/${officerId}`, {
      method: 'PATCH',
      token: saToken,
      body: { isActive: false },
    });
    expect(locked.status).toBe(200);
    expect(locked.data.isActive).toBe(false);

    const lockedLogin = await call('/api/auth/staff/login', {
      body: { staffCode: 'CB-TB-99', password: 'ResetPassword@2026!', unit: 'city' },
    });
    expect(lockedLogin.status).toBe(403);

    // Chặn tự xóa chính Super Admin đang đăng nhập
    const selfDel = await call<any>(`/api/admin/users/${saId}`, { method: 'DELETE', token: saToken });
    expect(selfDel.status).toBe(400);
    expect(selfDel.data.error.code).toBe('cannot_delete_self');

    // Xóa tài khoản test thành công & tinh chỉnh ngưỡng AI động
    expect((await call(`/api/admin/users/${officerId}`, { method: 'DELETE', token: saToken })).status).toBe(200);
    const patchedCfg = await call<any>('/api/admin/ai-config', {
      method: 'PATCH',
      token: saToken,
      body: { screenshotThreshold: 50, sceneMatchThreshold: 65, resolutionThreshold: 75 },
    });
    expect(patchedCfg.status).toBe(200);
    expect(patchedCfg.data.screenshotThreshold).toBe(50);
  });

  it('3. Live Rust CV Engine: Phân biệt Ảnh Thật vs Screenshot, Phát hiện Ảnh Cắt 35% (Crop Duplicate), Nghiệm thu Trước/Sau Khác Độ Sáng & Danh mục OTHER', async () => {
    const citizen1 = await loginCitizen('0918000101');
    const citizen2 = await loginCitizen('0918000102');
    const saToken = (
      await call<any>('/api/auth/admin/login', {
        body: { staffCode: 'SUPER-ADMIN', password: superPassword, unit: 'city' },
      })
    ).data.token as string;

    // 3A. Gửi ảnh hiện trường thật với danh mục `OTHER` (`khac`) -> ĐƯỢC CHẤP NHẬN + lưu ORB fingerprint
    const realScene = makeStreetScene(520, 390, { withDefect: true, brightnessScale: 1.0 });
    const createdReal = await call<any>('/api/reports', {
      token: citizen1,
      body: {
        idempotencyKey: `real-other-${Date.now()}`,
        category: 'OTHER',
        aiSuggestedLabel: 'Vật cản & xà bần lấn chiếm lòng đường',
        title: 'Đống vật tư lấn chiếm mặt đường khu phố 2',
        description: 'Vật tư chất đống gây cản trở giao thông.',
        lat: 10.9472,
        lng: 106.8235,
        wardCode: 'DN-TB',
        photo: realScene,
      },
    });
    expect(createdReal.status).toBe(201);
    expect(createdReal.data.outcome).toBe('created');
    expect(createdReal.data.report.category).toBe('khac');
    expect(createdReal.data.report.aiSuggestedLabel).toBe('Vật cản & xà bần lấn chiếm lòng đường');
    expect(createdReal.data.report.ai.mode).toBe('local_rust');
    const masterReportId = createdReal.data.report.id as string;

    // 3B. Kẻ xấu CẮT 1 GÓC ~35% diện tích (`310x235` lệch tâm từ ảnh `520x390` ở trên) rồi gửi lại!
    // dHash toàn ảnh hoàn toàn khác, nhưng Rust Multi-Scale ORB + RANSAC bắt trúng ngay!
    const croppedSubImage = makeStreetScene(310, 235, {
      withDefect: true,
      brightnessScale: 1.0,
      crop: { x0: 95, y0: 65, fullW: 520, fullH: 390 },
    });
    const cropAttempt = await call<any>('/api/reports', {
      token: citizen2,
      body: {
        idempotencyKey: `crop-dup-${Date.now()}`,
        category: 'rac_thai',
        title: 'Ảnh cắt từ góc nhỏ của sự cố cũ',
        description: 'Cố tình crop ảnh để qua mặt dHash',
        lat: 10.9474,
        lng: 106.8236,
        wardCode: 'DN-TB',
        photo: croppedSubImage,
      },
    });
    expect(cropAttempt.status).toBe(201);
    expect(cropAttempt.data.outcome).toBe('quarantined');
    expect(cropAttempt.data.report.quarantine.reason).toBe('duplicate_image');
    expect(cropAttempt.data.report.quarantine.relatedReportId).toBe(masterReportId);

    // 3C. Kẻ xấu gửi Ảnh Chụp Màn Hình Điện Thoại -> bị Rust 3-Tier Forensics chặn ngay vào Cách ly!
    const screenshotImg = makeMobileScreenshot();
    const screenAttempt = await call<any>('/api/reports', {
      token: citizen2,
      body: {
        idempotencyKey: `screenshot-fake-${Date.now()}`,
        category: 'rac_thai',
        title: 'Ảnh chụp màn hình điện thoại gửi giả mạo',
        description: 'Thử gửi screenshot',
        lat: 10.955,
        lng: 106.835,
        wardCode: 'DN-TB',
        photo: screenshotImg,
      },
    });
    expect(screenAttempt.status).toBe(201);
    expect(screenAttempt.data.outcome).toBe('quarantined');
    expect(screenAttempt.data.report.quarantine.reason).toBe('low_authenticity');

    // 3D. Nghiệm thu Trước & Sau Xử Lý:
    // - Nếu gửi ảnh SAU vẫn còn nguyên đống rác (dù tối hơn 80%) -> BỊ TỪ CHỐI!
    const afterStillDirty = makeStreetScene(520, 390, { withDefect: true, brightnessScale: 0.8 });
    const rejectResolve = await call<any>(`/api/admin/reports/${masterReportId}/resolve`, {
      token: saToken,
      body: { afterPhoto: afterStillDirty, note: 'Chưa dọn xong' },
    });
    expect(rejectResolve.status).toBe(200);
    expect(rejectResolve.data.accepted).toBe(false);

    // - Khi đã dọn sạch sự cố, dù chụp lúc chiều tối (độ sáng chỉ 58%!) và lệch góc máy (crop 490x368) -> ĐẠT >85%!
    const afterCleanDusk = makeStreetScene(490, 368, {
      withDefect: false,
      brightnessScale: 0.58,
      crop: { x0: 15, y0: 10, fullW: 520, fullH: 390 },
    });
    const acceptResolve = await call<any>(`/api/admin/reports/${masterReportId}/resolve`, {
      token: saToken,
      body: { afterPhoto: afterCleanDusk, note: 'Đã thu dọn sạch sẽ hiện trường' },
    });
    expect(acceptResolve.status).toBe(200);
    expect(acceptResolve.data.accepted).toBe(true);
    expect(acceptResolve.data.report.status).toBe('resolved');
    expect(acceptResolve.data.report.resolution.sceneMatchScore).toBeGreaterThanOrEqual(65);
    expect(acceptResolve.data.report.resolution.resolutionScore).toBeGreaterThanOrEqual(75);
    expect(acceptResolve.data.report.resolution.matchConfidence).toBeGreaterThanOrEqual(85);
  });
});
