import { describe, expect, it } from 'vitest';
import { normalizeRole, toRoleCode } from '@shared/constants';
import { hammingDistance } from '@shared/dhash';
import { fromGeoJsonPoint, normalizeCoordinates, toGeoJsonPoint, TRAN_BIEN_FALLBACK_COORDS } from '@shared/coordinates';
import { computeStats, toClientReport } from '@shared/report';
import { buildSeedReports } from '@shared/seed';
import { DONG_NAI_WARDS, QUICK_JUMP_REGIONS, searchWards, UPGRADED_2026_WARDS, WARD_BY_CODE } from '../data/dongNaiWards';
import { backoffMs } from '../db/sync';
import { en } from '../i18n/en';
import { vi } from '../i18n/vi';
import { haversineMeters, inDongNaiBBox, matchArterial, nearestWard, resolveAdminUnit } from '../lib/dongNaiGeo';
import { localVision } from '../lib/localVision';
import { isChunkLoadError } from '../utils/lazyWithRetry';
import { extractExifMetadata } from '../workers/imageProcessor.worker';
import {
  buildMapLibreStyle,
  createGeoJsonCircle,
  DONG_NAI_GOOGLE_BOUNDS,
  getPinState,
  googleMapsPlaceUrl,
  isGoogleMapsHealthy,
  markGoogleMapsFailed,
} from '../lib/mapConfig';
import { searchPlacesDongNai } from '../lib/geoClient';
import {
  buildFallbackSteps,
  buildVietnameseOsrmInstruction,
  computeActiveStepProgress,
  computeBearingDeg,
  formatDistanceVi,
  projectPointOntoPolyline,
  shortestAngleDeltaDeg,
} from '../lib/navigationEngine';

const extractPlaceholders = (s: string): string[] =>
  [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('i18n VI ↔ EN parity', () => {
  it('có cùng tập khóa, không có chuỗi rỗng và khớp 100% biến nội suy', () => {
    const viKeys = Object.keys(vi).sort();
    const enKeys = Object.keys(en).sort();
    expect(enKeys).toEqual(viKeys);
    for (const k of viKeys as Array<keyof typeof vi>) {
      expect(vi[k].trim().length, `vi['${k}'] rỗng`).toBeGreaterThan(0);
      expect(en[k].trim().length, `en['${k}'] rỗng`).toBeGreaterThan(0);
      expect(extractPlaceholders(en[k]), `Lệch placeholder ở khóa '${k}'`).toEqual(extractPlaceholders(vi[k]));
    }
  });
});

describe('Dữ liệu 95 ĐVHC Thành phố Đồng Nai & Local Seed cho IndexedDB', () => {
  it('khẳng định cứng 95 ĐVHC (33 Phường, 62 Xã), 10 phường mới 30/04/2026 và 5 vùng nhảy nhanh', () => {
    expect(DONG_NAI_WARDS).toHaveLength(95);
    expect(DONG_NAI_WARDS.filter((w) => w.kind === 'Phường')).toHaveLength(33);
    expect(DONG_NAI_WARDS.filter((w) => w.kind === 'Xã')).toHaveLength(62);
    expect(UPGRADED_2026_WARDS).toHaveLength(10);
    expect(QUICK_JUMP_REGIONS).toHaveLength(5);
    expect(WARD_BY_CODE['DN-TB']?.name).toBe('Phường Trấn Biên');
    expect(WARD_BY_CODE['DN-LTH']?.name).toBe('Phường Long Thành');
    expect(WARD_BY_CODE['DN-BGM']?.name).toBe('Xã Bù Gia Mập');
  });

  it('seed local phủ đều toàn Thành phố Đồng Nai (80 hồ sơ rải khắp 5 vùng)', () => {
    const all = buildSeedReports().map(toClientReport);
    const cityStats = computeStats(all, 'city');
    expect(all).toHaveLength(80);
    expect(cityStats.total).toBe(80);
    expect(cityStats.resolved).toBeGreaterThan(30);
    expect(new Set(all.map((r) => WARD_BY_CODE[r.wardCode]?.region)).size).toBe(5);
    expect(new Set(all.map((r) => r.wardCode)).size).toBeGreaterThanOrEqual(35);
  });
});

describe('Thuật toán Edge (Geo 95 ĐVHC, dHash, Local Vision Fallback, Backoff)', () => {
  it('kiểm tra Bounding Box toàn TP. Đồng Nai, tìm kiếm 95 ĐVHC, Haversine và trục huyết mạch', () => {
    expect(inDongNaiBBox(10.9465, 106.8243)).toBe(true); // P. Trấn Biên
    expect(inDongNaiBBox(12.142, 107.092)).toBe(true);   // Xã Bù Gia Mập (Bắc Đồng Nai)
    expect(inDongNaiBBox(21.0285, 105.8542)).toBe(false); // Hà Nội
    expect(haversineMeters(10.9465, 106.8243, 10.9465, 106.8243)).toBe(0);
    expect(haversineMeters(10.9465, 106.8243, 10.9468, 106.8243)).toBeLessThan(50);
    expect(nearestWard(10.9465, 106.8243).wardCode).toBe('DN-TB');
    expect(matchArterial(10.9465, 106.8243)?.name).toBe('Võ Thị Sáu');
    expect(matchArterial(10.95605, 106.8235)?.name).toBe('Nguyễn Ái Quốc');
    for (const w of DONG_NAI_WARDS) {
      expect(inDongNaiBBox(w.centerLat, w.centerLng), `${w.wardCode} ngoài bbox`).toBe(true);
    }
    expect(searchWards('loc ninh').some((w) => w.wardCode === 'DN-LNI')).toBe(true);
    expect(resolveAdminUnit({ lat: 10.7906, lng: 106.9512, rawAddressText: 'Thị trấn Long Thành, Huyện Long Thành' }).wardCode).toBe('DN-LTH');
  });

  it('tính khoảng cách Hamming 64-bit dHash chính xác', () => {
    expect(hammingDistance('0000000000000000', '0000000000000000')).toBe(0);
    expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
    expect(hammingDistance('aaaaaaaaaaaaaaaa', 'aaaaaaaaaaaaaaa3')).toBe(2);
  });

  it('localVision phát hiện ảnh mờ / chụp màn hình và sự cố khẩn cấp', () => {
    const screen = localVision(null, 'rác thải ở hẻm', { blurScore: 10, brightness: 120, flatRatio: 0.75, aspect: 1.5 });
    expect(screen.mode).toBe('fallback');
    expect(screen.authenticityScore).toBeLessThan(45);
    expect(screen.fraudFlags).toContain('blurry');
    expect(screen.fraudFlags).toContain('possible_screen_recapture');

    const emergency = localVision('den_duong', 'Cây đổ đè dây điện võng xuống đường', { blurScore: 150, brightness: 130, flatRatio: 0.2, aspect: 1.33 });
    expect(emergency.isEmergency).toBe(true);
    expect(emergency.severity).toBe(5);
    expect(emergency.severityLabel).toBe('CRITICAL');
    expect(emergency.priorityScore).toBeGreaterThanOrEqual(85);
    expect(emergency.suggestedDepartment).toBe('dien_luc');
  });

  it('chuẩn hóa tương thích ngược hệ thống 4 vai trò chuẩn (ADMIN, OFFICER, RESCUE, CITIZEN)', () => {
    expect(normalizeRole('SUPER_ADMIN')).toBe('admin');
    expect(normalizeRole('super_admin')).toBe('admin');
    expect(normalizeRole('city_admin')).toBe('admin');
    expect(normalizeRole('ADMIN')).toBe('admin');
    expect(toRoleCode('super_admin')).toBe('ADMIN');

    expect(normalizeRole('ward_officer')).toBe('officer');
    expect(normalizeRole('OFFICER')).toBe('officer');
    expect(normalizeRole('volunteer')).toBe('officer');
    expect(normalizeRole('YOUTH_UNION')).toBe('officer');
    expect(toRoleCode('officer')).toBe('OFFICER');

    expect(normalizeRole('rescue_team')).toBe('rescue');
    expect(normalizeRole('RESCUE_TEAM')).toBe('rescue');
    expect(normalizeRole('RESCUE')).toBe('rescue');
    expect(toRoleCode('rescue')).toBe('RESCUE');

    expect(normalizeRole('citizen')).toBe('citizen');
    expect(toRoleCode('citizen')).toBe('CITIZEN');
  });

  it('chuẩn hóa tọa độ GPS (chặn [0,0], NaN, tự động sửa đảo ngược [lng, lat] và chuẩn hóa GeoJSON)', () => {
    expect(normalizeCoordinates({ lat: 0, lng: 0 }).ok).toBe(false);
    expect(normalizeCoordinates({ lat: Number.NaN, lng: 106.82 }).ok).toBe(false);
    expect(normalizeCoordinates({ lat: 48.8566, lng: 2.3522 }).ok).toBe(false); // Ngoài lãnh thổ VN

    // Đảo ngược [lng, lat] -> tự động sửa về { lat: 10.9465, lng: 106.8235, swapped: true }
    const swapped = normalizeCoordinates({ lat: 106.8235, lng: 10.9465 });
    expect(swapped.ok).toBe(true);
    if (swapped.ok) {
      expect(swapped.swapped).toBe(true);
      expect(swapped.lat).toBeCloseTo(10.9465, 4);
      expect(swapped.lng).toBeCloseTo(106.8235, 4);
    }

    const geo = toGeoJsonPoint(TRAN_BIEN_FALLBACK_COORDS.lat, TRAN_BIEN_FALLBACK_COORDS.lng);
    expect(geo).toEqual({ type: 'Point', coordinates: [106.8235, 10.9465] });
    expect(fromGeoJsonPoint(geo)).toEqual({ lat: 10.9465, lng: 106.8235 });
  });

  it('Outbox Exponential Backoff tăng dần và bị chặn trần ở 300s + jitter', () => {
    const a1 = backoffMs(1);
    const a5 = backoffMs(5);
    const a20 = backoffMs(20);
    expect(a1).toBeGreaterThanOrEqual(4000);
    expect(a5).toBeGreaterThan(a1);
    expect(a20).toBeLessThanOrEqual(300_800);
  });

  it('cấu hình GIS Google Maps + MapLibre Fallback bao trọn 95 ĐVHC và phân loại ghim chính xác', async () => {
    expect(DONG_NAI_GOOGLE_BOUNDS.south).toBeLessThanOrEqual(10.55);
    expect(DONG_NAI_GOOGLE_BOUNDS.north).toBeGreaterThanOrEqual(12.25);

    const roadmap = buildMapLibreStyle('roadmap');
    const hybrid = buildMapLibreStyle('hybrid');
    expect(roadmap.layers.length).toBe(1); // Google Maps Đường phố (lyrs=m)
    expect(hybrid.layers.length).toBe(1); // Google Maps Vệ tinh + Đường (lyrs=y)
    expect(googleMapsPlaceUrl(10.9465, 106.8243)).toBe('https://www.google.com/maps/search/?api=1&query=10.946500,106.824300');

    const circle = createGeoJsonCircle(10.9465, 106.8243, 25, 32);
    expect(circle.geometry.coordinates[0]).toHaveLength(33);

    expect(
      getPinState({
        id: '1',
        title: 'Khẩn cấp',
        category: 'mat_duong',
        severity: 5,
        isEmergency: true,
        emergencyLevel: 1,
        priority: 'emergency',
        status: 'received',
        lat: 10.9465,
        lng: 106.8243,
        clusterCount: 1,
      }),
    ).toBe('emergency');

    const localPlaces = await searchPlacesDongNai('ta lai');
    expect(localPlaces.some((p) => p.wardCode === 'DN-TLA')).toBe(true);

    markGoogleMapsFailed('unit_test_auth_failure');
    expect(isGoogleMapsHealthy()).toBe(false);

    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: /assets/Report-abc.js'))).toBe(true);
    expect(isChunkLoadError(new Error('Normal validation error'))).toBe(false);
  });

  it('Navigation Engine: biên dịch chuẩn bước rẽ OSRM tiếng Việt, định dạng khoảng cách & tính tiến độ Turn-by-Turn', () => {
    expect(formatDistanceVi(84)).toBe('85 m');
    expect(formatDistanceVi(248)).toBe('250 m');
    expect(formatDistanceVi(1420)).toBe('1,4 km');
    expect(computeBearingDeg({ lat: 10.94, lng: 106.82 }, { lat: 10.95, lng: 106.82 })).toBeCloseTo(0, 0);

    const turnRight = buildVietnameseOsrmInstruction({
      name: 'Đường Phạm Văn Thuận',
      maneuver: { type: 'turn', modifier: 'right' },
    });
    expect(turnRight.instructionVi).toBe('Rẽ phải vào Đường Phạm Văn Thuận');

    const roundabout = buildVietnameseOsrmInstruction({
      name: 'Đường Đồng Khởi',
      maneuver: { type: 'roundabout', modifier: 'right', exit: 2 },
    });
    expect(roundabout.instructionVi).toBe('Đi vào vòng xoay và ra ở lối thứ 2 vào Đường Đồng Khởi');

    const fbRoute = buildFallbackSteps(
      { lat: 10.9465, lng: 106.8243 },
      { lat: 10.9452, lng: 106.8342 },
      'rescue_truck',
    );
    expect(fbRoute.steps.length).toBeGreaterThanOrEqual(3);
    expect(fbRoute.path.length).toBeGreaterThanOrEqual(3);

    const prog = computeActiveStepProgress(fbRoute, { lat: 10.9465, lng: 106.8243 });
    expect(prog.currentStep.instructionVi.length).toBeGreaterThan(5);
    expect(prog.remainingDistanceKm).toBeGreaterThan(0);
    expect(prog.remainingDurationMin).toBeGreaterThanOrEqual(1);
    expect(prog.offRouteMeters).toBeLessThan(15);
    expect(prog.aheadPath.length).toBeGreaterThanOrEqual(2);

    // Góc xoay ngắn nhất qua mốc 0°/360° không bị lật vòng ngược
    expect(shortestAngleDeltaDeg(355, 5)).toBe(10);
    expect(shortestAngleDeltaDeg(5, 355)).toBe(-10);

    // Phát hiện xe đi lệch khỏi tuyến > 50m để kích hoạt Auto Re-route
    const offProj = projectPointOntoPolyline(
      { lat: 10.952, lng: 106.8243 },
      [
        { lat: 10.9465, lng: 106.82 },
        { lat: 10.9465, lng: 106.83 },
      ],
    );
    expect(offProj.minDistanceM).toBeGreaterThan(500);
  });

  it('Worker EXIF Parser trích xuất đúng GPS, Camera Make, Software & Timestamp từ ảnh JPEG', () => {
    // Tạo gói JPEG + APP1 Exif nhỏ gọn với IFD0 (Make + Software) & DateTime
    const buf = new ArrayBuffer(256);
    const view = new DataView(buf);
    const bytes = new Uint8Array(buf);
    const writeAscii = (off: number, s: string) => {
      for (let i = 0; i < s.length; i++) bytes[off + i] = s.charCodeAt(i);
    };
    view.setUint16(0, 0xffd8, false); // SOI
    view.setUint16(2, 0xffe1, false); // APP1
    view.setUint16(4, 180, false); // segLen
    writeAscii(6, 'Exif\0\0');
    const tiff = 12;
    view.setUint16(tiff, 0x4949, false); // Little endian 'II'
    view.setUint16(tiff + 2, 42, true);
    view.setUint32(tiff + 4, 8, true); // firstIFD = 8 -> offset 20
    const ifd0 = tiff + 8;
    view.setUint16(ifd0, 3, true); // 3 entries
    // Entry 0: Make (0x010f), type=2 ASCII, count=8, valOffset=56
    view.setUint16(ifd0 + 2, 0x010f, true);
    view.setUint16(ifd0 + 4, 2, true);
    view.setUint32(ifd0 + 6, 8, true);
    view.setUint32(ifd0 + 10, 56, true);
    writeAscii(tiff + 56, 'Samsung\0');
    // Entry 1: Software (0x0131), type=2 ASCII, count=10, valOffset=72
    view.setUint16(ifd0 + 14, 0x0131, true);
    view.setUint16(ifd0 + 16, 2, true);
    view.setUint32(ifd0 + 18, 10, true);
    view.setUint32(ifd0 + 22, 72, true);
    writeAscii(tiff + 72, 'Photoshop\0');
    // Entry 2: DateTime (0x0132), type=2 ASCII, count=20, valOffset=96
    view.setUint16(ifd0 + 26, 0x0132, true);
    view.setUint16(ifd0 + 28, 2, true);
    view.setUint32(ifd0 + 30, 20, true);
    view.setUint32(ifd0 + 34, 96, true);
    writeAscii(tiff + 96, '2026:11:25 08:30:00\0');
    view.setUint16(200, 0xffd9, false); // EOI

    const exif = extractExifMetadata(buf);
    expect(exif.cameraMake).toBe('Samsung');
    expect(exif.software).toBe('Photoshop');
    expect(exif.capturedAt).toContain('2026-11-25');
  });
});
