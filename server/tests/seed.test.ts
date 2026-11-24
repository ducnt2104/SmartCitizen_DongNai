import { describe, expect, it } from 'vitest';
import { buildSeedReports } from '../../shared/seed';
import { DONG_NAI_WARDS, WARD_BY_CODE } from '../../shared/dongNaiWards';
import { computeStats, toClientReport } from '../../shared/report';
import { hammingDistance } from '../../shared/dhash';
import { haversineMeters, inDongNaiBBox, matchArterial } from '../../shared/geo';

const seed = buildSeedReports();
const tb = seed.filter((r) => r.wardCode === 'DN-TB');

describe('Danh mục 95 xã, phường', () => {
  it('có đúng 95 đơn vị, mã duy nhất, tọa độ trong Bounding Box', () => {
    expect(DONG_NAI_WARDS).toHaveLength(95);
    expect(new Set(DONG_NAI_WARDS.map((w) => w.wardCode)).size).toBe(95);
    for (const w of DONG_NAI_WARDS) {
      expect(inDongNaiBBox(w.centerLat, w.centerLng)).toBe(true);
      expect(w.adjacentWardCodes).toHaveLength(3);
      expect(w.arterialRoads.length).toBeGreaterThan(0);
    }
    expect(WARD_BY_CODE['DN-TB'].centerLat).toBe(10.9465);
  });
});

describe('Seed Phường Trấn Biên', () => {
  const stats = computeStats(tb.map(toClientReport), 'DN-TB');
  it('64 hồ sơ: 21/18/15/10', () => {
    expect(tb).toHaveLength(64);
    expect(stats.byCategory).toEqual({ rac_thai: 21, den_duong: 18, ngap_nuoc: 15, mat_duong: 10 });
  });
  it('47 hoàn thành (73.4%), 17 chưa, TB 3.2 ngày', () => {
    expect(stats.resolved).toBe(47);
    expect(stats.open).toBe(17);
    expect(stats.resolvedPct).toBe(73.4);
    expect(stats.avgDays).toBe(3.2);
  });
  it('tổng toàn TP = 80 hồ sơ, id/code duy nhất, mọi tọa độ hợp lệ', () => {
    expect(seed).toHaveLength(80);
    expect(new Set(seed.map((r) => r.id)).size).toBe(80);
    expect(new Set(seed.map((r) => r.code)).size).toBe(80);
    expect(seed.every((r) => inDongNaiBBox(r.lat, r.lng))).toBe(true);
  });
});

describe('Kịch bản demo', () => {
  it('khẩn cấp cấp 1 trên trục huyết mạch, đã chi viện 2 phường + Điện lực + CSGT', () => {
    const em = seed.find((r) => r.id === 'rp_tb_em')!;
    expect(em.emergencyLevel).toBe(1);
    expect(matchArterial(em.lat, em.lng)?.name).toBeTruthy();
    expect(em.dispatches[0].toWardCodes).toHaveLength(2);
    expect(em.dispatches[0].units).toEqual(['dien_luc', 'csgt']);
  });
  it('Hồ sơ Mẹ: 4 SĐT, 4 ảnh, mọi cặp dHash > 12', () => {
    const m = seed.find((r) => r.id === 'rp_tb_mother')!;
    expect(m.clusterCount).toBe(4);
    expect(new Set(m.contributors.map((c) => c.phoneMasked)).size).toBe(4);
    expect(m.priority).toBe('high');
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) expect(hammingDistance(m.photos[i].dHash, m.photos[j].dHash)).toBeGreaterThan(12);
    expect(haversineMeters(m.lat, m.lng, m.lat, m.lng)).toBe(0);
  });
  it('3 đơn Cách ly đúng lý do', () => {
    const q = seed.filter((r) => r.status === 'quarantined');
    expect(q.map((r) => r.quarantine!.reason).sort()).toEqual(['duplicate_image', 'gps_anomaly', 'low_authenticity']);
    const dup = seed.find((r) => r.id === 'rp_tb_q_dup')!;
    const src = seed.find((r) => r.id === dup.quarantine!.relatedReportId)!;
    expect(hammingDistance(dup.photos[0].dHash, src.photos[0].dHash)).toBeLessThanOrEqual(5);
    expect(seed.find((r) => r.id === 'rp_tb_q_screen')!.ai.authenticityScore).toBeLessThan(45);
    expect(seed.find((r) => r.id === 'rp_tb_q_gps')!.gpsDistanceKm).toBeGreaterThan(5);
  });
  it('4 hồ sơ Before/After có điểm AI và 5 sao; 3 nhiệm vụ người cao tuổi', () => {
    const ba = seed.filter((r) => r.afterPhoto);
    expect(ba).toHaveLength(4);
    expect(ba.every((r) => r.resolution?.resolutionVerified && r.rating?.stars === 5)).toBe(true);
    expect(seed.filter((r) => r.needsFieldVerification && r.seniorSubmitted)).toHaveLength(3);
  });
  it('seed deterministic', () => {
    expect(JSON.stringify(buildSeedReports())).toBe(JSON.stringify(seed));
  });
});
