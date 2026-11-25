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
  await seedIfEmpty(boot.repos, s.audit);
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

  it('vận hành trọn luồng Đội Cứu Hộ (RESCUE_TEAM login -> $nearSphere missions -> Tactical Briefing -> 4 bước hoàn thành) và Diagnostics Self-Test', async () => {
    // 1. Đăng nhập cổng Đội Cứu Hộ riêng (/api/auth/rescue/login)
    const loginRes = await call<{ token: string; user: { role: string; roleCode: string; staffCode: string } }>(
      '/api/auth/rescue/login',
      {
        body: { identifier: 'CUUHO-01', password: staffPassword },
        headers: { 'X-Forwarded-For': '10.9.0.11' },
      },
    );
    expect(loginRes.status).toBe(200);
    expect(loginRes.data.user.role).toBe('rescue_team');
    expect(loginRes.data.user.roleCode).toBe('RESCUE_TEAM');
    const rescueToken = loginRes.data.token;

    // 2. Lấy danh sách nhiệm vụ ưu tiên SOS + khoảng cách tới vị trí hiện tại
    const missionsRes = await call<Array<any>>(
      `/api/rescue/missions?lat=${TRAN_BIEN_FALLBACK_COORDS.lat}&lng=${TRAN_BIEN_FALLBACK_COORDS.lng}&radiusKm=50`,
      { token: rescueToken },
    );
    expect(missionsRes.status).toBe(200);
    expect(Array.isArray(missionsRes.data)).toBe(true);
    expect(missionsRes.data.length).toBeGreaterThan(0);

    const targetMission = missionsRes.data[0];
    expect(typeof targetMission.priorityScore).toBe('number');
    expect(typeof targetMission.distanceKm).toBe('number');
    expect(typeof targetMission.etaMinutes).toBe('number');

    // 3. Yêu cầu AI Tactical Briefing 3 dòng cho nhiệm vụ đang mở
    const briefRes = await call<{ riskSummary: string; equipmentAndCrew: string; safetyWarning: string }>(
      '/api/ai/tactical-briefing',
      {
        token: rescueToken,
        body: { reportId: targetMission.id },
      },
    );
    expect(briefRes.status).toBe(200);
    expect(briefRes.data.riskSummary.length).toBeGreaterThan(5);
    expect(briefRes.data.equipmentAndCrew.length).toBeGreaterThan(5);
    expect(briefRes.data.safetyWarning.length).toBeGreaterThan(5);

    // 4. Quy trình 1 chạm 4 bước tại hiện trường: accepted -> en_route -> on_site -> complete
    for (const step of ['accepted', 'en_route', 'on_site'] as const) {
      const stRes = await call<{ rescueMission: { status: string } }>(
        `/api/rescue/missions/${targetMission.id}/status`,
        {
          token: rescueToken,
          body: {
            step,
            note: `Cập nhật bước ${step}`,
            lat: targetMission.lat,
            lng: targetMission.lng,
          },
        },
      );
      expect(stRes.status).toBe(200);
      expect(stRes.data.rescueMission.status).toBe(step);
    }

    const completeRes = await call<{ report: { status: string; rescueMission: { status: string } }; accepted: boolean }>(
      `/api/rescue/missions/${targetMission.id}/complete`,
      {
        token: rescueToken,
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
    expect(completeRes.data.report.rescueMission.status).toBe('completed');

    // 5. System Diagnostics & Self-Test Plugin
    const diagRes = await call<any>('/api/system/diagnostics', { token: rescueToken });
    expect(diagRes.status).toBe(200);
    expect(diagRes.data.ai.zeroCrashFallbackReady).toBe(true);
    expect(diagRes.data.geo.wardsTotal).toBe(95);
    expect(diagRes.data.security.mongoSanitize).toBe(true);

    const dbTestRes = await call<any>('/api/system/diagnostics/test-db', { method: 'POST', token: rescueToken, body: {} });
    expect(dbTestRes.status).toBe(200);
    expect(dbTestRes.data.ok).toBe(true);
    expect(dbTestRes.data.nearSphereMatched).toBe(true);

    const aiTestRes = await call<any>('/api/system/diagnostics/test-ai', { method: 'POST', token: rescueToken, body: {} });
    expect(aiTestRes.status).toBe(200);
    expect(aiTestRes.data.ok).toBe(true);
    expect(aiTestRes.data.sampleBriefing.riskSummary.length).toBeGreaterThan(5);
  });
});
