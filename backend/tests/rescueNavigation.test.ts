import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let base = '';
let close: () => Promise<void> = async () => undefined;
let dir = '';
let staffPassword = '';
let superPassword = '';

async function call<T = any>(
  p: string,
  init: { method?: string; body?: unknown; token?: string } = {},
): Promise<{ status: number; data: T }> {
  const res = await fetch(`${base}${p}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: {
      'Content-Type': 'application/json',
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      'X-Device-Fp': 'rescue-test-fp-01',
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-rescue-test-'));
  process.env.DATA_DIR = dir;
  process.env.NODE_ENV = 'test';
  process.env.GEMINI_API_KEY = '';
  process.env.MONGODB_URI = '';

  const { createRepositories } = await import('../src/repositories');
  const { createServices } = await import('../src/services/container');
  const { INITIAL_STAFF_PASSWORD, INITIAL_SUPER_ADMIN_PASSWORD, seedIfEmpty } = await import('../src/data/seedStore');
  const { createApp } = await import('../src/app');

  staffPassword = INITIAL_STAFF_PASSWORD;
  superPassword = INITIAL_SUPER_ADMIN_PASSWORD;

  const boot = await createRepositories();
  const s = createServices(boot.repos);
  await seedIfEmpty(boot.repos, s.audit);
  const server = createApp(s, boot).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = async () => {
    await new Promise((r) => server.close(r));
    await boot.repos.close();
  };
});

afterAll(async () => {
  await close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('Vai trò Đội Cứu Hộ (RESCUE_TEAM) & API Điều phối Cứu hộ', () => {
  it('tài khoản mẫu CUUHO-01 đăng nhập được qua cả /api/auth/rescue/login và /api/auth/staff/login', async () => {
    const r1 = await call<any>('/api/auth/rescue/login', {
      body: { identifier: 'CUUHO-01', password: staffPassword },
    });
    expect(r1.status).toBe(200);
    expect(r1.data.user.role).toBe('rescue_team');
    expect(r1.data.user.roleCode).toBe('RESCUE_TEAM');
    expect(r1.data.user.wardCode).toBe('DN-TB');

    const r2 = await call<any>('/api/auth/staff/login', {
      body: { staffCode: 'CUUHO-01', password: staffPassword, unit: 'DN-TB' },
    });
    expect(r2.status).toBe(200);
    expect(r2.data.user.role).toBe('rescue_team');

    const rMobile = await call<any>('/api/auth/rescue/login', {
      body: { identifier: 'CUUHO-CD-01', password: staffPassword },
    });
    expect(rMobile.status).toBe(200);
    expect(rMobile.data.user.roleCode).toBe('RESCUE_TEAM');
    expect(rMobile.data.user.wardCode).toBeNull();
  });

  it('Admin tạo mới tài khoản RESCUE_TEAM (gắn phường/xã hoặc cơ động toàn TP) thành công', async () => {
    const adminLogin = await call<any>('/api/auth/admin/login', {
      body: { staffCode: 'SUPER-ADMIN', password: superPassword, unit: 'city' },
    });
    expect(adminLogin.status).toBe(200);
    const adminToken = adminLogin.data.token as string;

    const created = await call<any>('/api/admin/users', {
      token: adminToken,
      body: {
        name: 'Đội Cứu Hộ Cơ Động Số 2',
        role: 'RESCUE_TEAM',
        wardCode: null,
        staffCode: 'CUUHO-CD-02',
        email: 'cuuho.cd02@dongnai.gov.vn',
        password: 'RescuePassword@2026',
      },
    });
    expect(created.status).toBe(201);
    expect(created.data.role).toBe('rescue_team');
    expect(created.data.roleCode).toBe('RESCUE_TEAM');
    expect(created.data.wardCode).toBeNull();
  });

  it('GET /api/rescue/missions ưu tiên SOS/Khẩn cấp lên đầu + khoảng cách gần nhất, và PATCH /api/rescue/missions/:id/status chuyển đủ ACCEPTED -> EN_ROUTE -> ON_SITE -> RESOLVED', async () => {
    const loginRes = await call<any>('/api/auth/rescue/login', {
      body: { identifier: 'CUUHO-01', password: staffPassword },
    });
    const token = loginRes.data.token as string;

    // Truy vấn từ tọa độ trung tâm Phường Trấn Biên
    const missionsRes = await call<any[]>('/api/rescue/missions?lat=10.9465&lng=106.8243', {
      token,
    });
    expect(missionsRes.status).toBe(200);
    expect(missionsRes.data.length).toBeGreaterThan(5);

    // Đứng đầu phải là sự cố SOS / Khẩn cấp (emergencyLevel = 1 hoặc CRITICAL)
    const first = missionsRes.data[0];
    expect(first.isEmergency || first.emergencyLevel === 1 || first.severityLabel === 'CRITICAL').toBe(true);
    expect(typeof first.distanceKm).toBe('number');
    expect(typeof first.etaMinutes).toBe('number');

    // Chọn 1 sự cố đang mở ở Phường Trấn Biên (DN-TB) để chạy trọn vòng đời PATCH status
    const tranBienTarget = missionsRes.data.find((m) => m.wardCode === 'DN-TB' && m.status !== 'resolved');
    expect(tranBienTarget).toBeTruthy();
    const targetId = tranBienTarget.id as string;

    const s1 = await call<any>(`/api/rescue/missions/${targetId}/status`, {
      method: 'PATCH',
      token,
      body: { status: 'ACCEPTED', lat: 10.9465, lng: 106.8243 },
    });
    expect(s1.status).toBe(200);
    expect(s1.data.rescueMission.status).toBe('accepted');

    const s2 = await call<any>(`/api/rescue/missions/${targetId}/status`, {
      method: 'PATCH',
      token,
      body: { status: 'EN_ROUTE', lat: 10.9472, lng: 106.8251 },
    });
    expect(s2.status).toBe(200);
    expect(s2.data.rescueMission.status).toBe('en_route');

    const s3 = await call<any>(`/api/rescue/missions/${targetId}/status`, {
      method: 'PATCH',
      token,
      body: { status: 'ON_SITE', lat: tranBienTarget.lat, lng: tranBienTarget.lng },
    });
    expect(s3.status).toBe(200);
    expect(s3.data.rescueMission.status).toBe('on_site');

    const s4 = await call<any>(`/api/rescue/missions/${targetId}/status`, {
      method: 'PATCH',
      token,
      body: { status: 'RESOLVED', note: 'Đã xử lý an toàn hiện trường tại Trấn Biên' },
    });
    expect(s4.status).toBe(200);
    expect(s4.data.status).toBe('resolved');
    expect(s4.data.rescueMission.status).toBe('completed');
  });
});
