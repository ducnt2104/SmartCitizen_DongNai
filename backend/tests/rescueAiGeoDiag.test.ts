import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromGeoJsonPoint, normalizeCoordinates, toGeoJsonPoint, TRAN_BIEN_FALLBACK_COORDS } from '../src/shared/coordinates';
import {
  buildGoogleGenAiClientOptions,
  extractJsonObject,
  GeminiService,
  resolveGeminiModelChain,
} from '../src/services/gemini.service';

const TINY_JPEG =
  'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

let base = '';
let close: () => Promise<void> = async () => undefined;
let dir = '';
let staffPassword = '';

async function call<T = any>(
  p: string,
  init: { method?: string; body?: unknown; token?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; data: T }> {
  const res = await fetch(`${base}${p}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: {
      'Content-Type': 'application/json',
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      'X-Device-Fp': 'rescue-test-device-01',
      ...(init.headers ?? {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-rescue-diag-'));
  process.env.DATA_DIR = dir;
  process.env.NODE_ENV = 'test';
  process.env.GEMINI_API_KEY = '';
  process.env.GEMINI_API_KEYS = '';
  process.env.MONGODB_URI = '';

  const { createRepositories } = await import('../src/repositories');
  const { createServices } = await import('../src/services/container');
  const { INITIAL_STAFF_PASSWORD, seedIfEmpty } = await import('../src/data/seedStore');
  const { createApp } = await import('../src/app');

  staffPassword = INITIAL_STAFF_PASSWORD;
  const boot = await createRepositories();
  const s = createServices(boot.repos);
  await seedIfEmpty(boot.repos, s.audit, { includeFixtures: true });
  const server = createApp(s, boot).listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = async () => {
    await new Promise<void>((r) => server.close(() => r()));
    await boot.repos.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
});

afterAll(async () => {
  await close();
});

describe('Zero-Crash AI Brain, Chuẩn hóa GPS, Diagnostics Plugin & Cổng Đội Cứu Hộ (/rescue)', () => {
  it('chuẩn hóa model Gemini hợp lệ, nhận diện Vertex Express Key (AQ.*) và bóc sạch JSON từ markdown', () => {
    expect(resolveGeminiModelChain('gemini-3.5-flash')).toEqual([
      'gemini-2.5-flash',
      'gemini-2.0-flash',
      'gemini-1.5-flash',
    ]);
    expect(resolveGeminiModelChain('')).toEqual([
      'gemini-2.5-flash',
      'gemini-2.0-flash',
      'gemini-1.5-flash',
    ]);

    expect(buildGoogleGenAiClientOptions('AQ.Ab8RN6J2zkHaPWh_test')).toEqual({
      apiKey: 'AQ.Ab8RN6J2zkHaPWh_test',
      vertexai: true,
    });
    expect(buildGoogleGenAiClientOptions('AIzaSyTestStandardKey')).toEqual({
      apiKey: 'AIzaSyTestStandardKey',
    });

    const rawFenced = 'Đây là kết quả:\n```json\n{"riskSummary":"A","equipmentAndCrew":"B","safetyWarning":"C"}\n```';
    expect(JSON.parse(extractJsonObject(rawFenced))).toEqual({
      riskSummary: 'A',
      equipmentAndCrew: 'B',
      safetyWarning: 'C',
    });
  });

  it('Deterministic AI Brain chấm điểm SOS (priorityScore/severityLabel), sinh Tactical Briefing 3 dòng và tách điểm Trước/Sau', async () => {
    const ai = new GeminiService();
    const sos = ai.fallbackVision({
      imageBase64: '',
      mimeType: 'image/jpeg',
      dHash: '0123456789abcdef',
      hintCategory: 'den_duong',
      hintText: 'Đứt dây điện cao thế và cây đổ chắn ngang Quốc lộ 1A',
      onArterial: true,
      wardCode: 'DN-TB',
    });

    expect(sos.isEmergency).toBe(true);
    expect(sos.severity).toBe(5);
    expect(sos.severityLabel).toBe('CRITICAL');
    expect(sos.priorityScore).toBeGreaterThanOrEqual(90);
    expect(sos.tacticalBriefing).toBeDefined();
    expect(sos.tacticalBriefing?.riskSummary.length).toBeGreaterThan(10);
    expect(sos.tacticalBriefing?.equipmentAndCrew.length).toBeGreaterThan(10);
    expect(sos.tacticalBriefing?.safetyWarning.length).toBeGreaterThan(10);

    // Chặn ảnh SAU trùng hệt ảnh TRƯỚC (dHash Δ <= 5)
    const dup = await ai.verifyResolution({
      beforeBase64: '',
      beforeMime: 'image/jpeg',
      beforeHash: '0123456789abcdef',
      afterBase64: '',
      afterMime: 'image/jpeg',
      afterHash: '0123456789abcdee',
      category: 'rac_thai',
      title: 'Rác thải tồn đọng',
    });
    expect(dup.resolutionVerified).toBe(false);
    expect(dup.fraudFlags).toContain('duplicate_before_after_photo');
    expect(dup.sceneMatchScore).toBeGreaterThan(80);
    expect(dup.resolutionScore).toBeLessThan(20);

    // Nghiệm thu hợp lệ khi ảnh SAU khác biệt rõ rệt tại đúng vị trí GPS
    const validAfter = await ai.verifyResolution({
      beforeBase64: '',
      beforeMime: 'image/jpeg',
      beforeHash: '0000000000000000',
      afterBase64: '',
      afterMime: 'image/jpeg',
      afterHash: '00ff00ff00ff00ff',
      category: 'mat_duong',
      title: 'Ổ gà trên đường Võ Thị Sáu',
      beforeLat: 10.9465,
      beforeLng: 106.8235,
      afterLat: 10.94652,
      afterLng: 106.82351,
    });
    expect(validAfter.resolutionVerified).toBe(true);
    expect(validAfter.sceneMatchScore).toBeGreaterThanOrEqual(70);
    expect(validAfter.resolutionScore).toBeGreaterThanOrEqual(70);
  });

  it('chuẩn hóa tọa độ GPS nghiêm ngặt: chặn [0,0], tự sửa [lng,lat] bị đảo ngược và xuất đúng GeoJSON [lng,lat]', () => {
    expect(normalizeCoordinates({ lat: 0, lng: 0 }).ok).toBe(false);
    expect(normalizeCoordinates({ lat: Number.NaN, lng: 106.8235 }).ok).toBe(false);

    const swapped = normalizeCoordinates({ lat: 106.8235, lng: 10.9465 });
    expect(swapped.ok).toBe(true);
    if (swapped.ok) {
      expect(swapped.swapped).toBe(true);
      expect(swapped.lat).toBeCloseTo(10.9465, 4);
      expect(swapped.lng).toBeCloseTo(106.8235, 4);
    }

    const pt = toGeoJsonPoint(TRAN_BIEN_FALLBACK_COORDS.lat, TRAN_BIEN_FALLBACK_COORDS.lng);
    expect(pt).toEqual({ type: 'Point', coordinates: [106.8235, 10.9465] });
    expect(fromGeoJsonPoint(pt)).toEqual({ lat: 10.9465, lng: 106.8235 });
  });

  it('vận hành trọn luồng Đội Cứu Hộ chuẩn đặt xe (Atomic Claim chống trùng 409, trả đơn release, cập nhật GPS, 4 bước EN_ROUTE -> ARRIVED -> IN_PROGRESS -> RESOLVED) và Diagnostics', async () => {
    // 1. Hai đội cứu hộ cùng đăng nhập (/api/auth/staff/login tại /auth & /api/auth/rescue/login)
    const [loginTeam1, loginTeam2] = await Promise.all([
      call<{ token: string; user: { id: string; role: string; roleCode: string; staffCode: string } }>(
        '/api/auth/staff/login',
        {
          body: { staffCode: 'CUUHO-01', password: staffPassword, unit: 'city' },
          headers: { 'X-Forwarded-For': '10.9.0.11' },
        },
      ),
      call<{ token: string; user: { id: string; role: string; roleCode: string; staffCode: string } }>(
        '/api/auth/rescue/login',
        {
          body: { identifier: 'CUUHO-CD-01', password: staffPassword },
          headers: { 'X-Forwarded-For': '10.9.0.12' },
        },
      ),
    ]);
    expect(loginTeam1.status).toBe(200);
    expect(loginTeam1.data.user.role).toBe('rescue');
    expect(loginTeam1.data.user.roleCode).toBe('RESCUE');
    expect(loginTeam2.status).toBe(200);
    const token1 = loginTeam1.data.token;
    const token2 = loginTeam2.data.token;

    // 2. Lấy danh sách nhiệm vụ 2 nhóm rõ ràng: activeMission + availableMissions
    const missionsRes = await call<{
      activeMission: any;
      availableMissions: Array<any>;
      resolvedMissions: Array<any>;
    }>(
      `/api/rescue/missions?lat=${TRAN_BIEN_FALLBACK_COORDS.lat}&lng=${TRAN_BIEN_FALLBACK_COORDS.lng}&radiusKm=50`,
      { token: token1 },
    );
    expect(missionsRes.status).toBe(200);
    expect(missionsRes.data.activeMission).toBeNull();
    expect(Array.isArray(missionsRes.data.availableMissions)).toBe(true);
    expect(missionsRes.data.availableMissions.length).toBeGreaterThan(1);

    const targetMission = missionsRes.data.availableMissions[0];
    expect(typeof targetMission.priorityScore).toBe('number');
    expect(typeof targetMission.distanceKm).toBe('number');
    expect(typeof targetMission.etaMinutes).toBe('number');

    // 3. Đua nhận cùng 1 đơn đồng thời (Atomic Claim): chỉ đúng 1 đội nhận 200 EN_ROUTE, đội còn lại nhận 409 Conflict
    const [claimA, claimB] = await Promise.all([
      call<any>(`/api/rescue/missions/${targetMission.id}/accept`, {
        token: token1,
        body: { lat: TRAN_BIEN_FALLBACK_COORDS.lat, lng: TRAN_BIEN_FALLBACK_COORDS.lng },
      }),
      call<any>(`/api/rescue/missions/${targetMission.id}/accept`, {
        token: token2,
        body: { lat: TRAN_BIEN_FALLBACK_COORDS.lat, lng: TRAN_BIEN_FALLBACK_COORDS.lng },
      }),
    ]);

    const statuses = [claimA.status, claimB.status].sort();
    expect(statuses).toEqual([200, 409]);

    const winnerToken = claimA.status === 200 ? token1 : token2;
    const loserClaim = claimA.status === 409 ? claimA : claimB;
    const winnerClaim = claimA.status === 200 ? claimA : claimB;
    expect(loserClaim.data.error.message).toContain('Đơn sự cố này đã được đội khác tiếp nhận');
    expect(winnerClaim.data.rescueStatus).toBe('EN_ROUTE');
    expect(winnerClaim.data.assignedRescueId).toBeTruthy();

    // Thử bấm nhận lại cùng đơn lần nữa -> vẫn trả về 409 Conflict chống nhận trùng tuyệt đối
    const repeatAccept = await call<any>(`/api/rescue/missions/${targetMission.id}/accept`, {
      token: winnerToken,
      body: {},
    });
    expect(repeatAccept.status).toBe(409);

    // 4. Trả đơn về hàng chờ khi gặp sự cố bất khả kháng (POST /release) -> nhận lại bình thường bởi đội 1
    const releaseRes = await call<any>(`/api/rescue/missions/${targetMission.id}/release`, {
      token: winnerToken,
      body: { reason: 'Xe chuyên dụng thủng lốp trên Quốc lộ 1A, cần đội gần nhất tiếp ứng' },
    });
    expect(releaseRes.status).toBe(200);
    expect(releaseRes.data.assignedRescueId).toBeNull();
    expect(releaseRes.data.rescueReleaseHistory.length).toBe(1);

    const reAcceptRes = await call<any>(`/api/rescue/missions/${targetMission.id}/accept`, {
      token: token1,
      body: { lat: TRAN_BIEN_FALLBACK_COORDS.lat, lng: TRAN_BIEN_FALLBACK_COORDS.lng },
    });
    expect(reAcceptRes.status).toBe(200);
    expect(reAcceptRes.data.rescueStatus).toBe('EN_ROUTE');
    expect(reAcceptRes.data.assignedRescueId).toBe(loginTeam1.data.user.id);

    // Khôi phục activeMission ngay khi F5 / mở lại ứng dụng
    const reloadRes = await call<{ activeMission: any; availableMissions: any[] }>(
      `/api/rescue/missions?lat=${TRAN_BIEN_FALLBACK_COORDS.lat}&lng=${TRAN_BIEN_FALLBACK_COORDS.lng}`,
      { token: token1 },
    );
    expect(reloadRes.status).toBe(200);
    expect(reloadRes.data.activeMission?.id).toBe(targetMission.id);
    expect(reloadRes.data.availableMissions.some((m) => m.id === targetMission.id)).toBe(false);

    // 5. Cập nhật tọa độ di chuyển thực tế (PATCH /location) & từ chối tọa độ nhiễu [0,0]
    const badLocRes = await call<any>(`/api/rescue/missions/${targetMission.id}/location`, {
      method: 'PATCH',
      token: token1,
      body: { lat: 0, lng: 0, heading: 90, speed: 35 },
    });
    expect(badLocRes.status).toBe(400);

    const goodLocRes = await call<{ ok: boolean; distanceKm: number; etaMinutes: number; location: any }>(
      `/api/rescue/missions/${targetMission.id}/location`,
      {
        method: 'PATCH',
        token: token1,
        body: {
          lat: (TRAN_BIEN_FALLBACK_COORDS.lat + targetMission.lat) / 2,
          lng: (TRAN_BIEN_FALLBACK_COORDS.lng + targetMission.lng) / 2,
          heading: 135,
          speed: 42,
        },
      },
    );
    expect(goodLocRes.status).toBe(200);
    expect(goodLocRes.data.ok).toBe(true);
    expect(goodLocRes.data.location.heading).toBe(135);
    expect(typeof goodLocRes.data.etaMinutes).toBe('number');

    // 6. AI Tactical Briefing + Chuyển trạng thái chuẩn 4 bước: EN_ROUTE -> ARRIVED -> IN_PROGRESS -> RESOLVED
    const briefRes = await call<{ riskSummary: string; equipmentAndCrew: string; safetyWarning: string }>(
      '/api/ai/tactical-briefing',
      {
        token: token1,
        body: { reportId: targetMission.id },
      },
    );
    expect(briefRes.status).toBe(200);
    expect(briefRes.data.riskSummary.length).toBeGreaterThan(5);

    const arrivedRes = await call<any>(`/api/rescue/missions/${targetMission.id}/status`, {
      method: 'PATCH',
      token: token1,
      body: { status: 'ARRIVED', lat: targetMission.lat, lng: targetMission.lng },
    });
    expect(arrivedRes.status).toBe(200);
    expect(arrivedRes.data.rescueStatus).toBe('ARRIVED');

    const inProgRes = await call<any>(`/api/rescue/missions/${targetMission.id}/status`, {
      method: 'PATCH',
      token: token1,
      body: { status: 'IN_PROGRESS', lat: targetMission.lat, lng: targetMission.lng },
    });
    expect(inProgRes.status).toBe(200);
    expect(inProgRes.data.rescueStatus).toBe('IN_PROGRESS');

    const completeRes = await call<{ report: { status: string; rescueStatus: string; rescueMission: { status: string } }; accepted: boolean }>(
      `/api/rescue/missions/${targetMission.id}/complete`,
      {
        token: token1,
        body: {
          afterPhoto: { dataUrl: TINY_JPEG, dHash: 'fedcba9876543210' },
          note: 'Đã dọn dẹp hiện trường và đảm bảo an toàn giao thông.',
          override: true,
          lat: targetMission.lat,
          lng: targetMission.lng,
        },
      },
    );
    expect(completeRes.status).toBe(200);
    expect(completeRes.data.accepted).toBe(true);
    expect(completeRes.data.report.status).toBe('resolved');
    expect(completeRes.data.report.rescueStatus).toBe('RESOLVED');
    expect(completeRes.data.report.rescueMission.status).toBe('completed');

    // Sau khi hoàn thành, activeMission về null để sẵn sàng nhận đơn mới
    const afterDoneRes = await call<{ activeMission: any }>(
      `/api/rescue/missions?lat=${TRAN_BIEN_FALLBACK_COORDS.lat}&lng=${TRAN_BIEN_FALLBACK_COORDS.lng}`,
      { token: token1 },
    );
    expect(afterDoneRes.status).toBe(200);
    expect(afterDoneRes.data.activeMission).toBeNull();
  });
});
