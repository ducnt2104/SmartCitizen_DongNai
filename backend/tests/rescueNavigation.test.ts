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
  await seedIfEmpty(boot.repos, s.audit, { includeFixtures: true });
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

describe('Vai trò Đội Cứu Hộ (RESCUE) & Cổng Đăng nhập Nội bộ Thống nhất (/auth)', () => {
  it('tài khoản CUUHO-01 đăng nhập chung qua /api/auth/staff/login (không cần chọn đơn vị) lẫn /api/auth/rescue/login', async () => {
    const r1 = await call<any>('/api/auth/rescue/login', {
      body: { identifier: 'CUUHO-01', password: staffPassword },
    });
    expect(r1.status).toBe(200);
    expect(r1.data.user.role).toBe('rescue');
    expect(r1.data.user.roleCode).toBe('RESCUE');
    expect(r1.data.user.wardCode).toBe('DN-TB');

    const r2 = await call<any>('/api/auth/staff/login', {
      body: { identifier: 'CUUHO-01', password: staffPassword },
    });
    expect(r2.status).toBe(200);
    expect(r2.data.user.role).toBe('rescue');
    expect(r2.data.user.roleCode).toBe('RESCUE');

    const rMobile = await call<any>('/api/auth/staff/login', {
      body: { identifier: 'CUUHO-CD-01', password: staffPassword },
    });
    expect(rMobile.status).toBe(200);
    expect(rMobile.data.user.roleCode).toBe('RESCUE');
    expect(rMobile.data.user.wardCode).toBeNull();
  });

  it('Admin tạo mới tài khoản RESCUE (gắn phường/xã hoặc cơ động toàn TP) thành công', async () => {
    const adminLogin = await call<any>('/api/auth/admin/login', {
      body: { identifier: 'SUPER-ADMIN', password: superPassword },
    });
    expect(adminLogin.status).toBe(200);
    const adminToken = adminLogin.data.token as string;

    const created = await call<any>('/api/admin/users', {
      token: adminToken,
      body: {
        name: 'Đội Cứu Hộ Cơ Động Số 2',
        role: 'RESCUE',
        wardCode: null,
        staffCode: 'CUUHO-CD-02',
        email: 'cuuho.cd02@dongnai.gov.vn',
        password: 'RescuePassword@2026',
      },
    });
    expect(created.status).toBe(201);
    expect(created.data.role).toBe('rescue');
    expect(created.data.roleCode).toBe('RESCUE');
    expect(created.data.wardCode).toBeNull();
  });

  it('GET /api/rescue/missions ưu tiên SOS/Khẩn cấp lên đầu + khoảng cách gần nhất, và PATCH /api/rescue/missions/:id/status chuyển đủ ACCEPTED -> EN_ROUTE -> ON_SITE -> RESOLVED', async () => {
    const loginRes = await call<any>('/api/auth/staff/login', {
      body: { identifier: 'CUUHO-01', password: staffPassword },
    });
    const token = loginRes.data.token as string;

    // Truy vấn từ tọa độ trung tâm Phường Trấn Biên
    const missionsRes = await call<{ activeMission: any; availableMissions: any[] }>('/api/rescue/missions?lat=10.9465&lng=106.8243', {
      token,
    });
    expect(missionsRes.status).toBe(200);
    const list = missionsRes.data.availableMissions;
    expect(list.length).toBeGreaterThan(5);

    // Đứng đầu phải là sự cố SOS / Khẩn cấp (emergencyLevel = 1 hoặc CRITICAL)
    const first = list[0];
    expect(first.isEmergency || first.emergencyLevel === 1 || first.severityLabel === 'CRITICAL').toBe(true);
    expect(typeof first.distanceKm).toBe('number');
    expect(typeof first.etaMinutes).toBe('number');

    // Chọn 1 sự cố đang mở ở Phường Trấn Biên (DN-TB) để chạy trọn vòng đời PATCH status
    const tranBienTarget = list.find((m) => m.wardCode === 'DN-TB' && m.status !== 'resolved');
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

  it('MongoDB thực tế (MongoMemoryServer): Atomic Claim chuyển đơn sang EN_ROUTE trên MongoDB, chặn nhận trùng 409 Conflict, cập nhật GPS live và hoàn tất ARRIVED -> IN_PROGRESS -> RESOLVED', async () => {
    const { MongoMemoryServer } = await import('mongodb-memory-server');
    const { createMongoRepositories } = await import('../src/repositories/mongoRepositories');
    const { createServices } = await import('../src/services/container');
    const { seedIfEmpty } = await import('../src/data/seedStore');
    const { createApp } = await import('../src/app');
    const { ReportModel } = await import('../src/models');

    const mongod = await MongoMemoryServer.create();
    const mongoUri = mongod.getUri('smartcitizen_rescue_e2e');
    const mongoRepos = await createMongoRepositories(mongoUri);
    const mongoServices = createServices(mongoRepos);
    await seedIfEmpty(mongoRepos, mongoServices.audit, { includeFixtures: true });

    const mongoServer = createApp(mongoServices, {
      repos: mongoRepos,
      dbLabel: 'mongodb',
      getDbMode: () => 'mongodb',
    }).listen(0);
    const mongoBase = `http://127.0.0.1:${(mongoServer.address() as AddressInfo).port}`;

    const mCall = async <T = any>(
      p: string,
      init: { method?: string; body?: unknown; token?: string } = {},
    ): Promise<{ status: number; data: T }> => {
      const res = await fetch(`${mongoBase}${p}`, {
        method: init.method ?? (init.body ? 'POST' : 'GET'),
        headers: {
          'Content-Type': 'application/json',
          ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
          'X-Device-Fp': 'rescue-mongo-e2e-fp',
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
      });
      const text = await res.text();
      return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
    };

    try {
      // 1. Hai đội cứu hộ đăng nhập qua cổng /auth (/api/auth/staff/login)
      const team1Login = await mCall<any>('/api/auth/staff/login', {
        body: { identifier: 'CUUHO-01', password: staffPassword },
      });
      const team2Login = await mCall<any>('/api/auth/staff/login', {
        body: { identifier: 'CUUHO-CD-01', password: staffPassword },
      });
      expect(team1Login.status).toBe(200);
      expect(team2Login.status).toBe(200);
      const token1 = team1Login.data.token as string;
      const token2 = team2Login.data.token as string;

      // 2. Lấy danh sách đơn chờ từ MongoDB
      const queueRes = await mCall<{ activeMission: any; availableMissions: any[] }>(
        '/api/rescue/missions?lat=10.9465&lng=106.8243',
        { token: token1 },
      );
      expect(queueRes.status).toBe(200);
      expect(queueRes.data.activeMission).toBeNull();
      const target = queueRes.data.availableMissions.find((m) => m.wardCode === 'DN-TB');
      expect(target).toBeTruthy();
      const missionId = target.id as string;

      // 3. Hai đội cùng bấm NHẬN ĐƠN đồng thời trên MongoDB -> đúng 1 đội 200 EN_ROUTE, đội kia 409 Conflict
      const [claim1, claim2] = await Promise.all([
        mCall<any>(`/api/rescue/missions/${missionId}/accept`, {
          method: 'POST',
          token: token1,
          body: { lat: 10.9465, lng: 106.8243 },
        }),
        mCall<any>(`/api/rescue/missions/${missionId}/accept`, {
          method: 'POST',
          token: token2,
          body: { lat: 10.947, lng: 106.825 },
        }),
      ]);

      const statuses = [claim1.status, claim2.status].sort((a, b) => a - b);
      expect(statuses).toEqual([200, 409]);

      const winnerToken = claim1.status === 200 ? token1 : token2;
      const loserRes = claim1.status === 409 ? claim1 : claim2;
      expect(loserRes.data.error.message).toContain('Đơn sự cố này đã được đội khác tiếp nhận');

      // Xác nhận trực tiếp trong collection `reports` trên MongoDB đã chuyển sang EN_ROUTE
      const rawMongoDoc = await ReportModel.findOne({ id: missionId }).lean();
      expect(rawMongoDoc).toBeTruthy();
      expect(rawMongoDoc?.status).toBe('EN_ROUTE');
      expect(rawMongoDoc?.rescueStatus).toBe('EN_ROUTE');
      expect(rawMongoDoc?.assignedRescueId).toBeTruthy();
      expect(rawMongoDoc?.acceptedAt).toBeInstanceOf(Date);

      // Thử nhận lại cùng đơn một lần nữa -> tiếp tục trả về 409 Conflict
      const retryDup = await mCall<any>(`/api/rescue/missions/${missionId}/accept`, {
        method: 'POST',
        token: winnerToken === token1 ? token2 : token1,
        body: { lat: 10.947, lng: 106.825 },
      });
      expect(retryDup.status).toBe(409);

      // 4. F5 / Mở lại ứng dụng -> khôi phục ngay activeMission
      const restored = await mCall<{ activeMission: any; availableMissions: any[] }>(
        '/api/rescue/missions?lat=10.9465&lng=106.8243',
        { token: winnerToken },
      );
      expect(restored.data.activeMission?.id).toBe(missionId);
      expect(restored.data.availableMissions.some((m) => m.id === missionId)).toBe(false);

      // 5. Cập nhật tọa độ di chuyển trực tiếp (PATCH /location)
      const locRes = await mCall<any>(`/api/rescue/missions/${missionId}/location`, {
        method: 'PATCH',
        token: winnerToken,
        body: { lat: 10.9482, lng: 106.8249, heading: 68, speed: 10.4 },
      });
      expect(locRes.status).toBe(200);
      expect(locRes.data.ok).toBe(true);
      expect(typeof locRes.data.distanceKm).toBe('number');
      expect(typeof locRes.data.etaMinutes).toBe('number');

      // 6. Chuyển trạng thái chuẩn 4 bước: ARRIVED -> IN_PROGRESS -> RESOLVED
      const stArrived = await mCall<any>(`/api/rescue/missions/${missionId}/status`, {
        method: 'PATCH',
        token: winnerToken,
        body: { status: 'ARRIVED', lat: target.lat, lng: target.lng },
      });
      expect(stArrived.status).toBe(200);
      expect(stArrived.data.rescueStatus).toBe('ARRIVED');

      const stProgress = await mCall<any>(`/api/rescue/missions/${missionId}/status`, {
        method: 'PATCH',
        token: winnerToken,
        body: { status: 'IN_PROGRESS', lat: target.lat, lng: target.lng },
      });
      expect(stProgress.status).toBe(200);
      expect(stProgress.data.rescueStatus).toBe('IN_PROGRESS');

      const stResolved = await mCall<any>(`/api/rescue/missions/${missionId}/status`, {
        method: 'PATCH',
        token: winnerToken,
        body: { status: 'RESOLVED', note: 'Đã xử lý dứt điểm và nghiệm thu an toàn trên MongoDB' },
      });
      expect(stResolved.status).toBe(200);
      expect(stResolved.data.status).toBe('resolved');
      expect(stResolved.data.rescueStatus).toBe('RESOLVED');

      // 7. Quay lại trạng thái chờ nhận đơn mới (activeMission === null)
      const afterDone = await mCall<{ activeMission: any; availableMissions: any[] }>(
        '/api/rescue/missions?lat=10.9465&lng=106.8243',
        { token: winnerToken },
      );
      expect(afterDone.data.activeMission).toBeNull();
    } finally {
      await new Promise((r) => mongoServer.close(r));
      await mongoRepos.close();
      await mongod.stop();
    }
  }, 45_000);
});
