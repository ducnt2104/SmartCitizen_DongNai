import { describe, expect, it } from 'vitest';
import { hammingDistance } from '../../shared/dhash';
import { DONG_NAI_WARDS, QUICK_JUMP_REGIONS, UPGRADED_2026_WARDS, WARD_BY_CODE } from '../../shared/dongNaiWards';
import { haversineMeters, inDongNaiBBox, matchArterial } from '../../shared/geo';
import { buildSeedReports } from '../../shared/seed';

const seed = buildSeedReports();

describe('Danh mục chính thức 95 ĐVHC Thành phố Đồng Nai (30/04/2026)', () => {
  it('có đúng 95 đơn vị (33 Phường + 62 Xã), mã duy nhất, tọa độ trong Bounding Box toàn TP', () => {
    expect(DONG_NAI_WARDS).toHaveLength(95);
    expect(DONG_NAI_WARDS.filter((w) => w.kind === 'Phường')).toHaveLength(33);
    expect(DONG_NAI_WARDS.filter((w) => w.kind === 'Xã')).toHaveLength(62);
    expect(UPGRADED_2026_WARDS).toHaveLength(10);
    expect(QUICK_JUMP_REGIONS).toHaveLength(5);
    expect(new Set(DONG_NAI_WARDS.map((w) => w.wardCode)).size).toBe(95);
    expect(new Set(DONG_NAI_WARDS.map((w) => w.name)).size).toBe(95);

    for (const w of DONG_NAI_WARDS) {
      expect(w.wardCode).toMatch(/^DN-[A-Z]{2,4}$/);
      expect(inDongNaiBBox(w.centerLat, w.centerLng)).toBe(true);
      expect(w.adjacentWardCodes).toHaveLength(3);
      expect(w.arterialRoads.length).toBeGreaterThan(0);
    }
    expect(WARD_BY_CODE['DN-TB'].centerLat).toBe(10.9465);
    expect(WARD_BY_CODE['DN-BGM'].centerLat).toBeGreaterThan(12.0);
  });
});

describe('Dữ liệu mẫu phủ đều toàn Thành phố Đồng Nai (không tập trung 1 phường)', () => {
  it('tổng 80 hồ sơ, phủ đủ cả 5 vùng và >= 35 Phường/Xã khác nhau, không dồn về Trấn Biên', () => {
    expect(seed).toHaveLength(80);
    expect(new Set(seed.map((r) => r.id)).size).toBe(80);
    expect(new Set(seed.map((r) => r.code)).size).toBe(80);
    expect(seed.every((r) => inDongNaiBBox(r.lat, r.lng))).toBe(true);

    const uniqueWards = new Set(seed.map((r) => r.wardCode));
    expect(uniqueWards.size).toBeGreaterThanOrEqual(35);

    const coveredRegions = new Set(seed.map((r) => WARD_BY_CODE[r.wardCode]?.region));
    expect(coveredRegions.size).toBe(5);

    const tranBienCount = seed.filter((r) => r.wardCode === 'DN-TB').length;
    expect(tranBienCount).toBeLessThan(15); // Chấm dứt tập trung 64/80 ở Trấn Biên
  });

  it('02 vụ Khẩn cấp cấp 1 trên trục huyết mạch (Trung tâm & Bắc Đồng Nai)', () => {
    const em1 = seed.find((r) => r.id === 'rp_tb_em')!;
    const em2 = seed.find((r) => r.id === 'rp_bp_em')!;
    for (const em of [em1, em2]) {
      expect(em.emergencyLevel).toBe(1);
      expect(matchArterial(em.lat, em.lng)?.name).toBeTruthy();
      expect(em.dispatches[0].toWardCodes).toHaveLength(2);
    }
    expect(em1.dispatches[0].units).toEqual(['dien_luc', 'csgt']);
    expect(em2.wardCode).toBe('DN-BP');
  });

  it('02 Hồ sơ Mẹ (Trấn Biên & Long Thành): đa SĐT, đa góc ảnh dHash > 12', () => {
    const m1 = seed.find((r) => r.id === 'rp_tb_mother')!;
    const m2 = seed.find((r) => r.id === 'rp_lth_mother')!;
    expect(m1.clusterCount).toBe(4);
    expect(new Set(m1.contributors.map((c) => c.phoneMasked)).size).toBe(4);
    expect(m1.priority).toBe('high');
    for (let i = 0; i < 4; i++) {
      for (let j = i + 1; j < 4; j++) {
        expect(hammingDistance(m1.photos[i].dHash, m1.photos[j].dHash)).toBeGreaterThan(12);
      }
    }
    expect(m2.wardCode).toBe('DN-LTH');
    expect(m2.clusterCount).toBe(3);
    expect(haversineMeters(m1.lat, m1.lng, m1.lat, m1.lng)).toBe(0);
  });

  it('03 đơn Cách ly đúng 3 lý do rải trên 3 địa bàn', () => {
    const q = seed.filter((r) => r.status === 'quarantined');
    expect(q.map((r) => r.quarantine!.reason).sort()).toEqual(['duplicate_image', 'gps_anomaly', 'low_authenticity']);
    const dup = seed.find((r) => r.id === 'rp_tb_q_dup')!;
    const src = seed.find((r) => r.id === dup.quarantine!.relatedReportId)!;
    expect(hammingDistance(dup.photos[0].dHash, src.photos[0].dHash)).toBeLessThanOrEqual(5);
    expect(seed.find((r) => r.id === 'rp_tb_q_screen')!.ai.authenticityScore).toBeLessThan(45);
    expect(seed.find((r) => r.id === 'rp_tb_q_gps')!.gpsDistanceKm).toBeGreaterThan(5);
  });

  it('06 hồ sơ Before/After rải 5 vùng + 03 nhiệm vụ người cao tuổi (gồm Tà Lài & Bù Gia Mập)', () => {
    const ba = seed.filter((r) => r.afterPhoto);
    expect(ba).toHaveLength(6);
    expect(ba.every((r) => r.resolution?.resolutionVerified && r.rating?.stars === 5)).toBe(true);
    const seniors = seed.filter((r) => r.needsFieldVerification && r.seniorSubmitted);
    expect(seniors).toHaveLength(3);
    expect(seniors.map((s) => s.wardCode)).toEqual(['DN-TB', 'DN-TLA', 'DN-BGM']);
  });

  it('seed deterministic 100%', () => {
    expect(JSON.stringify(buildSeedReports())).toBe(JSON.stringify(seed));
  });
});
