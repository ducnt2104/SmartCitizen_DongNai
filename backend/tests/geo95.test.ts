import { describe, expect, it } from 'vitest';
import {
  DONG_NAI_WARDS,
  matchWardByAddressText,
  normalizeVi,
  searchWards,
  UPGRADED_2026_WARDS,
  WARD_BY_CODE,
} from '../src/shared/dongNaiWards';
import { inDongNaiBBox, resolveAdminUnit } from '../src/shared/geo';

describe('Hệ thống 95 ĐVHC Chính thức Thành phố Đồng Nai (33 Phường, 62 Xã)', () => {
  it('khẳng định cứng total === 95, phuong === 33, xa === 62 và đủ 10 phường mới ngày 30/04/2026', () => {
    expect(DONG_NAI_WARDS).toHaveLength(95);
    expect(DONG_NAI_WARDS.filter((w) => w.kind === 'Phường')).toHaveLength(33);
    expect(DONG_NAI_WARDS.filter((w) => w.kind === 'Xã')).toHaveLength(62);

    const expected10 = [
      'Phường Trảng Bom',
      'Phường Long Thành',
      'Phường Trị An',
      'Phường Nhơn Trạch',
      'Phường Tân Khai',
      'Phường Xuân Lộc',
      'Phường Tân Phú',
      'Phường Lộc Ninh',
      'Phường Dầu Giây',
      'Phường Đồng Phú',
    ];
    expect(UPGRADED_2026_WARDS.map((w) => w.name).sort()).toEqual([...expected10].sort());
    for (const w of UPGRADED_2026_WARDS) {
      expect(w.kind).toBe('Phường');
      expect(w.upgradedOn2026).toBe(true);
    }
  });

  it('tìm kiếm 95 Phường/Xã không phân biệt dấu tiếng Việt và khớp bí danh cũ', () => {
    expect(normalizeVi('Phường Trấn Biên')).toBe('phuong tran bien');
    expect(searchWards('tran bien').some((w) => w.wardCode === 'DN-TB')).toBe(true);
    expect(searchWards('bu gia map').some((w) => w.wardCode === 'DN-BGM')).toBe(true);
    expect(searchWards('ta lai').some((w) => w.wardCode === 'DN-TLA')).toBe(true);
    expect(searchWards('long thanh').some((w) => w.wardCode === 'DN-LTH')).toBe(true);
    expect(searchWards('quyet thang').some((w) => w.wardCode === 'DN-TB')).toBe(true);
  });

  it('chuẩn hóa địa chỉ 2 thế hệ (3 cấp cũ Đồng Nai & Bình Phước cũ -> 95 Phường/Xã mới)', () => {
    const cases: Array<[string, string]> = [
      ['Đường 30/4, Phường Quyết Thắng, TP. Biên Hòa, Tỉnh Đồng Nai', 'DN-TB'],
      ['Thị trấn Long Thành, Huyện Long Thành, Tỉnh Đồng Nai', 'DN-LTH'],
      ['Thị trấn Gia Ray, Huyện Xuân Lộc, Tỉnh Đồng Nai', 'DN-XLO'],
      ['Thị trấn Tân Phú, Huyện Tân Phú, Tỉnh Đồng Nai', 'DN-TPU'],
      ['Thị trấn Vĩnh An, Huyện Vĩnh Cửu, Tỉnh Đồng Nai', 'DN-TRA'],
      ['Thị trấn Lộc Ninh, Huyện Lộc Ninh, Tỉnh Bình Phước', 'DN-LNI'],
      ['Thị trấn Tân Phú, Huyện Đồng Phú, Tỉnh Bình Phước', 'DN-DPU'],
      ['Phường Tân Phú, Thành phố Đồng Xoài, Tỉnh Bình Phước', 'DN-BP'],
      ['Thị xã Phước Long, Tỉnh Bình Phước', 'DN-PLO'],
      ['Ấp 3, Xã Tà Lài, Huyện Tân Phú, Đồng Nai', 'DN-TLA'],
    ];

    for (const [legacyAddr, expectedCode] of cases) {
      const m = matchWardByAddressText(legacyAddr);
      expect(m?.ward.wardCode, `Sai khi chuẩn hóa: ${legacyAddr}`).toBe(expectedCode);
    }
  });

  it('resolveAdminUnit phân giải đúng Trấn Biên, Tà Lài, 10 phường mới và chặn tọa độ ngoài địa bàn', () => {
    expect(resolveAdminUnit({ lat: 10.9465, lng: 106.8243 }).wardCode).toBe('DN-TB');
    expect(resolveAdminUnit({ lat: 11.385, lng: 107.362 }).wardCode).toBe('DN-TLA');
    for (const w of UPGRADED_2026_WARDS) {
      const res = resolveAdminUnit({ lat: w.centerLat, lng: w.centerLng });
      expect(res.inBounds).toBe(true);
      expect(res.wardCode).toBe(w.wardCode);
    }

    // Ngoài ranh giới Thành phố Đồng Nai (Hà Nội & TP.HCM Q1)
    expect(inDongNaiBBox(21.0285, 105.8542)).toBe(false);
    expect(inDongNaiBBox(10.8231, 106.6297)).toBe(false);
    const hanoi = resolveAdminUnit({ lat: 21.0285, lng: 105.8542 });
    expect(hanoi.inBounds).toBe(false);
    expect(hanoi.wardCode).toBeNull();

    // Tọa độ + tên địa danh cũ Nominatim -> chọn đúng phường mới và không cần fallback mù
    const wNtr = WARD_BY_CODE['DN-NTR'];
    const normalized = resolveAdminUnit({
      lat: wNtr.centerLat,
      lng: wNtr.centerLng,
      rawAddressText: 'Đường Lý Thái Tổ, Xã Phú Hội, Huyện Nhơn Trạch',
    });
    expect(normalized.inBounds).toBe(true);
    expect(normalized.wardCode).toBe('DN-NTR');
    expect(normalized.needsConfirmation).toBe(false);
  });
});
