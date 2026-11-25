import { describe, expect, it } from 'vitest';
import { hammingDistance } from '@shared/dhash';
import { computeStats, toClientReport } from '@shared/report';
import { buildSeedReports } from '@shared/seed';
import { DONG_NAI_WARDS, QUICK_JUMP_REGIONS, searchWards, UPGRADED_2026_WARDS, WARD_BY_CODE } from '../data/dongNaiWards';
import { backoffMs } from '../db/sync';
import { en } from '../i18n/en';
import { vi } from '../i18n/vi';
import { haversineMeters, inDongNaiBBox, matchArterial, nearestWard, resolveAdminUnit } from '../lib/dongNaiGeo';
import { localVision } from '../lib/localVision';
import { isChunkLoadError } from '../utils/lazyWithRetry';
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
    expect(emergency.suggestedDepartment).toBe('dien_luc');
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
    const dark = buildMapLibreStyle('dark');
    expect(roadmap.layers.length).toBe(1);
    expect(hybrid.layers.length).toBe(3); // Vệ tinh + Mạng lưới đường + Nhãn tên đường
    expect(dark.layers.length).toBe(1);
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
});
