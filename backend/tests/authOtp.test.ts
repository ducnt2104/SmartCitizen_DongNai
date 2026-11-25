import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OtpSendPayload, OtpTransport } from '../src/services/otpDelivery.service';
import type { Services } from '../src/services/container';

interface CapturedOtp {
  to: string;
  code: string;
  channel: string;
  purpose: string;
}

class MemoryOtpTransport implements OtpTransport {
  readonly provider = 'test_memory';
  readonly channel = 'email' as const;
  readonly sent: CapturedOtp[] = [];

  async send(payload: OtpSendPayload): Promise<void> {
    this.sent.push({
      to: payload.to,
      code: payload.code,
      channel: payload.channel,
      purpose: payload.purpose,
    });
  }

  lastCodeFor(target: string): string {
    const found = [...this.sent].reverse().find((x) => x.to === target.toLowerCase() || x.to === target);
    if (!found) throw new Error(`Không tìm thấy OTP đã gửi cho ${target}`);
    return found.code;
  }
}

let base = '';
let dir = '';
let services: Services;
let close: () => Promise<void> = async () => undefined;
const transport = new MemoryOtpTransport();

function extractCookies(res: Response): Record<string, string> {
  const map: Record<string, string> = {};
  const headers = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  for (const h of headers) {
    const first = h.split(';')[0] ?? '';
    const eq = first.indexOf('=');
    if (eq > 0) map[first.slice(0, eq).trim()] = first.slice(eq + 1).trim();
  }
  return map;
}

function cookieHeader(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .filter(([, v]) => v !== '')
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

async function req<T = any>(
  p: string,
  opts: { method?: string; body?: unknown; token?: string; cookies?: Record<string, string>; ip?: string } = {},
): Promise<{ status: number; data: T; setCookies: Record<string, string>; rawSetCookie: string[] }> {
  const res = await fetch(`${base}${p}`, {
    method: opts.method ?? (opts.body ? 'POST' : 'GET'),
    headers: {
      'Content-Type': 'application/json',
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.cookies ? { Cookie: cookieHeader(opts.cookies) } : {}),
      ...(opts.ip ? { 'X-Forwarded-For': opts.ip } : {}),
      'X-Device-Fp': 'auth-test-fp-01',
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const rawSetCookie = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  return {
    status: res.status,
    data: (text ? JSON.parse(text) : null) as T,
    setCookies: extractCookies(res),
    rawSetCookie,
  };
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-auth-test-'));
  process.env.DATA_DIR = dir;
  process.env.NODE_ENV = 'test';
  process.env.GEMINI_API_KEY = '';
  process.env.MONGODB_URI = '';
  process.env.RESEND_API_KEY = '';
  process.env.SMTP_HOST = '';
  process.env.SMTP_USER = '';
  process.env.SMTP_PASS = '';
  process.env.TWILIO_ACCOUNT_SID = '';
  process.env.ESMS_API_KEY = '';

  const { createRepositories } = await import('../src/repositories');
  const { createServices } = await import('../src/services/container');
  const { seedIfEmpty } = await import('../src/data/seedStore');
  const { createApp } = await import('../src/app');

  const boot = await createRepositories();
  services = createServices(boot.repos);
  await seedIfEmpty(boot.repos, services.audit);
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

describe('Zero Mock Auth & Real OTP Lifecycle', () => {
  it('đã gỡ bỏ hoàn toàn /api/auth/demo và /api/auth/google-mock', async () => {
    expect((await req('/api/auth/demo', { body: { kind: 'citizen' } })).status).toBe(404);
    expect((await req('/api/auth/google-mock', { body: { email: 'fake@gmail.com' } })).status).toBe(404);
  });

  it('báo lỗi 503 tường minh khi chưa cấu hình nhà cung cấp gửi OTP thật (không sinh mã ảo)', async () => {
    services.otpDelivery.setTestTransport(null);
    const statusRes = await req<any>('/api/auth/otp/status');
    expect(statusRes.status).toBe(200);
    expect(statusRes.data.emailConfigured).toBe(false);
    expect(statusRes.data.smsConfigured).toBe(false);

    const res = await req<any>('/api/auth/otp/request', {
      body: { identifier: 'congdan.unconfigured@dongnai.vn' },
      ip: '10.0.0.1',
    });
    expect(res.status).toBe(503);
    expect(res.data.error.code).toBe('otp_provider_not_configured');
    expect(JSON.stringify(res.data)).not.toMatch(/demoOtp/);
  });

  it('gửi OTP qua transport thật không lộ mã trong HTTP response, xác thực thành công, chặn replay (consumedAt) và cấp HTTP-only Cookies', async () => {
    services.otpDelivery.setTestTransport(transport);
    const email = 'nguyen.minh@dongnai.vn';

    const r1 = await req<any>('/api/auth/otp/request', { body: { identifier: email }, ip: '10.0.0.2' });
    expect(r1.status).toBe(200);
    expect(r1.data.channel).toBe('email');
    expect(r1.data.resendInSec).toBe(60);
    expect(r1.data.expiresInSec).toBe(300);
    // Tuyệt đối không lộ mã OTP trong response
    const code = transport.lastCodeFor(email);
    expect(code).toMatch(/^\d{6}$/);
    expect(JSON.stringify(r1.data)).not.toContain(code);
    expect(r1.data.demoOtp).toBeUndefined();

    // Cooldown 60s chặn yêu cầu gửi lại ngay lập tức
    const rCooldown = await req<any>('/api/auth/otp/request', { body: { identifier: email }, ip: '10.0.0.2' });
    expect(rCooldown.status).toBe(429);
    expect(rCooldown.data.error.code).toBe('otp_cooldown');

    // Xác thực thành công kèm mật khẩu + Phường/Xã mặc định
    const v1 = await req<any>('/api/auth/otp/verify', {
      body: { identifier: email, code, name: 'Nguyễn Minh', password: 'StrongPassword@2026', defaultWardCode: 'DN-LTH' },
    });
    expect(v1.status).toBe(200);
    expect(v1.data.user.name).toBe('Nguyễn Minh');
    expect(v1.data.user.defaultWardCode).toBe('DN-LTH');
    expect(v1.setCookies.sc_access).toBeTruthy();
    expect(v1.setCookies.sc_refresh).toBeTruthy();
    expect(v1.rawSetCookie.some((c) => c.startsWith('sc_access=') && c.includes('HttpOnly') && c.includes('SameSite=Lax'))).toBe(true);
    expect(v1.rawSetCookie.some((c) => c.startsWith('sc_refresh=') && c.includes('HttpOnly') && c.includes('SameSite=Lax'))).toBe(true);

    // Chống replay: dùng lại đúng mã OTP vừa xác thực phải bị từ chối
    const replay = await req<any>('/api/auth/otp/verify', { body: { identifier: email, code } });
    expect(replay.status).toBe(400);
    expect(replay.data.error.code).toBe('otp_consumed');

    // Xác thực bằng HTTP-only Cookie (không cần Authorization header)
    const meByCookie = await req<any>('/api/me', { cookies: v1.setCookies });
    expect(meByCookie.status).toBe(200);
    expect(meByCookie.data.user.email).toBe(email);

    // Cập nhật hồ sơ công dân
    const prof = await req<any>('/api/me/profile', {
      method: 'PATCH',
      cookies: v1.setCookies,
      body: { name: 'Nguyễn Minh Long Thành', defaultWardCode: 'DN-NTR', notificationsEnabled: false },
    });
    expect(prof.status).toBe(200);
    expect(prof.data.user.name).toBe('Nguyễn Minh Long Thành');
    expect(prof.data.user.defaultWardCode).toBe('DN-NTR');
    expect(prof.data.user.notificationsEnabled).toBe(false);
  });

  it('xoay vòng Refresh Token & phát hiện dùng lại token cũ (thu hồi toàn bộ phiên)', async () => {
    services.otpDelivery.setTestTransport(transport);
    const email = 'rotation.test@dongnai.vn';
    await req('/api/auth/otp/request', { body: { identifier: email }, ip: '10.0.0.3' });
    const code = transport.lastCodeFor(email);
    const loginRes = await req<any>('/api/auth/otp/verify', { body: { identifier: email, code } });
    expect(loginRes.status).toBe(200);
    const oldRefresh = loginRes.setCookies.sc_refresh;

    // Rotation lần 1: cấp cặp cookie mới
    const ref1 = await req<any>('/api/auth/refresh', { method: 'POST', cookies: { sc_refresh: oldRefresh } });
    expect(ref1.status).toBe(200);
    const newRefresh = ref1.setCookies.sc_refresh;
    expect(newRefresh).toBeTruthy();
    expect(newRefresh).not.toBe(oldRefresh);

    // Kẻ tấn công dùng lại oldRefresh -> kích hoạt Reuse Detection, trả 401 và thu hồi cả newRefresh
    const reuse = await req<any>('/api/auth/refresh', { method: 'POST', cookies: { sc_refresh: oldRefresh } });
    expect(reuse.status).toBe(401);

    const refAfterReuse = await req<any>('/api/auth/refresh', { method: 'POST', cookies: { sc_refresh: newRefresh } });
    expect(refAfterReuse.status).toBe(401);
  });

  it('đăng nhập mật khẩu, quên mật khẩu qua OTP thật, logout & logout-all', async () => {
    services.otpDelivery.setTestTransport(transport);
    const email = 'nguyen.minh@dongnai.vn';

    // Đăng nhập bằng mật khẩu đã đặt
    const pwOk = await req<any>('/api/auth/password/login', {
      body: { identifier: email, password: 'StrongPassword@2026' },
    });
    expect(pwOk.status).toBe(200);

    // Sai mật khẩu bị từ chối
    const pwBad = await req<any>('/api/auth/password/login', {
      body: { identifier: email, password: 'WrongPassword!' },
    });
    expect(pwBad.status).toBe(401);

    // Logout thiết bị này vô hiệu refresh token đó
    const out = await req<any>('/api/auth/logout', { method: 'POST', cookies: pwOk.setCookies });
    expect(out.status).toBe(200);
    const afterOut = await req<any>('/api/auth/refresh', { method: 'POST', cookies: pwOk.setCookies });
    expect(afterOut.status).toBe(401);

    // Reset password qua OTP thật (dùng email mới để không vướng cooldown 60s)
    const email2 = 'reset.user@dongnai.vn';
    await req('/api/auth/otp/request', { body: { identifier: email2, purpose: 'login' }, ip: '10.0.0.4' });
    await req('/api/auth/otp/verify', { body: { identifier: email2, code: transport.lastCodeFor(email2) } });

    // Mở cooldown trong repo test cho mục đích reset_password
    const existing = await services.repos.otps.get(email2);
    if (existing) await services.repos.otps.save({ ...existing, resendAt: 0 });

    const rRst = await req<any>('/api/auth/otp/request', { body: { identifier: email2, purpose: 'reset_password' }, ip: '10.0.0.4' });
    expect(rRst.status).toBe(200);
    const rstCode = transport.lastCodeFor(email2);
    const doRst = await req<any>('/api/auth/password/reset', {
      body: { identifier: email2, code: rstCode, newPassword: 'BrandNewPass@2026' },
    });
    expect(doRst.status).toBe(200);

    // Đăng nhập bằng mật khẩu mới thành công
    const loginNew = await req<any>('/api/auth/password/login', {
      body: { identifier: email2, password: 'BrandNewPass@2026' },
    });
    expect(loginNew.status).toBe(200);

    // Logout all thu hồi toàn bộ phiên
    const outAll = await req<any>('/api/auth/logout-all', { method: 'POST', cookies: loginNew.setCookies });
    expect(outAll.status).toBe(200);
    expect((await req('/api/auth/refresh', { method: 'POST', cookies: loginNew.setCookies })).status).toBe(401);
    expect((await req('/api/auth/refresh', { method: 'POST', cookies: doRst.setCookies })).status).toBe(401);
  });

  it('nhập sai OTP 5 lần -> khóa 15 phút (429 otp_locked)', async () => {
    services.otpDelivery.setTestTransport(transport);
    const email = 'bruteforce.test@dongnai.vn';
    expect((await req('/api/auth/otp/request', { body: { identifier: email }, ip: '10.0.0.5' })).status).toBe(200);
    let lastStatus = 0;
    for (let i = 0; i < 5; i++) {
      lastStatus = (await req('/api/auth/otp/verify', { body: { identifier: email, code: '000000' } })).status;
    }
    expect(lastStatus).toBe(429);
  });

  it('RBAC 2 cấp: city_admin tạo & thu hồi ward_officer (khóa ngay lập tức)', async () => {
    const { INITIAL_STAFF_PASSWORD } = await import('../src/data/seedStore');
    const city = await req<any>('/api/auth/staff/login', {
      body: { staffCode: 'TP-01', password: INITIAL_STAFF_PASSWORD, unit: 'city' },
    });
    expect(city.status).toBe(200);

    // Tạo cán bộ Phường Xuân Lộc (1 trong 10 phường mới 30/04/2026)
    const created = await req<any>('/api/admin/staff', {
      token: city.data.token,
      body: {
        staffCode: 'CB-XLO-99',
        name: 'Lê Hoàng Xuân Lộc',
        password: 'OfficerPass@2026',
        wardCode: 'DN-XLO',
        email: 'xuanloc.officer@dongnai.gov.vn',
      },
    });
    expect(created.status).toBe(201);
    expect(created.data.wardCode).toBe('DN-XLO');

    // Cán bộ mới đăng nhập thành công
    const officerLogin = await req<any>('/api/auth/staff/login', {
      body: { staffCode: 'CB-XLO-99', password: 'OfficerPass@2026', unit: 'DN-XLO' },
    });
    expect(officerLogin.status).toBe(200);
    expect((await req('/api/admin/overview', { token: officerLogin.data.token })).status).toBe(200);

    // City Admin thu hồi quyền
    const revoked = await req<any>(`/api/admin/staff/${created.data.id}/revoke`, {
      method: 'PATCH',
      token: city.data.token,
      body: { revoked: true },
    });
    expect(revoked.status).toBe(200);
    expect(revoked.data.revoked).toBe(true);

    // Token đang cầm bị chặn ngay lập tức + đăng nhập lại bị 403
    expect((await req('/api/admin/overview', { token: officerLogin.data.token })).status).toBe(403);
    expect(
      (await req('/api/auth/staff/login', {
        body: { staffCode: 'CB-XLO-99', password: 'OfficerPass@2026', unit: 'DN-XLO' },
      })).status,
    ).toBe(403);
  });
});
