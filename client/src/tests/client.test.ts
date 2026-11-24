import { describe, expect, it } from 'vitest';
import { DONG_NAI_WARDS, WARD_BY_CODE } from '../data/dongNaiWards';
import { backoffMs } from '../db/sync';
import { en } from '../i18n/en';
import { vi } from '../i18n/vi';
import { haversineMeters, inDongNaiBBox, matchArterial, nearestWard } from '../lib/dongNaiGeo';
import { localVision } from '../lib/localVision';
import { hammingDistance } from '@shared/dhash';
import { computeStats, toClientReport } from '@shared/report';
import { buildSeedReports } from '@shared/seed';

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

describe('Dữ liệu Đồng Nai & Local Seed cho IndexedDB', () => {
  it('có đúng 95 xã/phường và Phường Trấn Biên khớp tọa độ tâm', () => {
    expect(DONG_NAI_WARDS).toHaveLength(95);
    expect(WARD_BY_CODE['DN-TB']?.name).toBe('Phường Trấn Biên');
    expect(WARD_BY_CODE['DN-TB']?.centerLat).toBe(10.9465);
    expect(WARD_BY_CODE['DN-TB']?.centerLng).toBe(106.8243);
  });

  it('seed local khớp tuyệt đối số liệu Trấn Biên (64: 21/18/15/10, 47 xong = 73.4%, TB 3.2 ngày)', () => {
    const all = buildSeedReports().map(toClientReport);
    const tb = all.filter((r) => r.wardCode === 'DN-TB');
    const stats = computeStats(tb, 'ward:DN-TB');
    expect(all).toHaveLength(80);
    expect(stats.total).toBe(64);
    expect(stats.byCategory).toEqual({ rac_thai: 21, den_duong: 18, ngap_nuoc: 15, mat_duong: 10 });
    expect(stats.resolved).toBe(47);
    expect(stats.open).toBe(17);
    expect(stats.resolvedPct).toBe(73.4);
    expect(stats.avgDays).toBe(3.2);
  });
});

describe('Thuật toán Edge (Geo, dHash, Local Vision Fallback, Backoff)', () => {
  it('kiểm tra Bounding Box Đồng Nai, Haversine và trục đường huyết mạch', () => {
    expect(inDongNaiBBox(10.9465, 106.8243)).toBe(true);
    expect(inDongNaiBBox(21.0285, 105.8542)).toBe(false); // Hà Nội
    expect(haversineMeters(10.9465, 106.8243, 10.9465, 106.8243)).toBe(0);
    expect(haversineMeters(10.9465, 106.8243, 10.9468, 106.8243)).toBeLessThan(50);
    expect(nearestWard(10.9465, 106.8243).wardCode).toBe('DN-TB');
    expect(matchArterial(10.9465, 106.8243)?.name).toBe('Nguyễn Ái Quốc');
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
});
