import type { CityRegionId, QuickJumpRegion, Ward, WardZone } from './types';

/**
 * Danh mục chính thức 95 đơn vị hành chính cấp xã của Thành phố Đồng Nai
 * (mô hình chính quyền 2 cấp: Thành phố Đồng Nai -> 95 Phường/Xã):
 *  - Tổng số: 95 ĐVHC (33 Phường, 62 Xã)
 *  - Nguồn pháp lý: Nghị quyết 1662/NQ-UBTVQH15 (01/07/2025: 23 phường, 72 xã)
 *    + Nghị quyết 237/NQ-UBTVQH16 (hiệu lực 30/04/2026: nâng cấp 10 xã lên phường gồm
 *      Trảng Bom, Long Thành, Trị An, Nhơn Trạch, Tân Khai, Xuân Lộc, Tân Phú, Lộc Ninh, Dầu Giây, Đồng Phú).
 *  - Kèm `legacyAliases` hỗ trợ quy đổi ngược 2 thế hệ (trước 01/07/2025 và trước 30/04/2026).
 */

type Row = readonly [
  code: string,
  shortName: string,
  kind: 'P' | 'X',
  region: CityRegionId,
  zone: WardZone,
  lat: number,
  lng: number,
  upgradedOn2026: boolean,
  legacyAliases: readonly string[],
];

/** 33 PHƯỜNG (23 phường từ 01/07/2025 + 10 phường nâng cấp 30/04/2026) */
const PHUONG_ROWS: readonly Row[] = [
  // ── Đô thị Trung tâm (10 phường) ──
  ['TB', 'Trấn Biên', 'P', 'trung_tam', 'Trung tâm', 10.9492, 106.8225, false, ['Bửu Long', 'Quang Vinh', 'Trung Dũng', 'Quyết Thắng', 'Phường Quyết Thắng', 'Thống Nhất (Biên Hòa)', 'Hiệp Hòa', 'An Bình', 'TP. Biên Hòa']],
  ['BH', 'Biên Hòa', 'P', 'trung_tam', 'Trung tâm', 10.9355, 106.8035, false, ['Tân Hạnh', 'Hóa An', 'Bửu Hòa', 'Tân Vạn']],
  ['TDA', 'Trảng Dài', 'P', 'trung_tam', 'Công nghiệp', 10.9920, 106.8617, false, ['Thiện Tân', 'Phường Trảng Dài']],
  ['THP', 'Tam Hiệp', 'P', 'trung_tam', 'Trung tâm', 10.9472, 106.8553, false, ['Tân Hiệp (Biên Hòa)', 'Tân Mai', 'Bình Đa']],
  ['LBI', 'Long Bình', 'P', 'trung_tam', 'Công nghiệp', 10.9383, 106.9036, false, ['Hố Nai cũ', 'Tân Biên', 'Phường Long Bình']],
  ['HNI', 'Hố Nai', 'P', 'trung_tam', 'Công nghiệp', 10.9685, 106.8895, false, ['Tân Hòa', 'Hố Nai 3']],
  ['LHU', 'Long Hưng', 'P', 'trung_tam', 'Công nghiệp', 10.9035, 106.8565, false, ['An Hòa', 'Long Bình Tân', 'Xã Long Hưng']],
  ['PTA', 'Phước Tân', 'P', 'trung_tam', 'Công nghiệp', 10.8852, 106.9036, false, ['Phường Phước Tân']],
  ['TPC', 'Tam Phước', 'P', 'trung_tam', 'Công nghiệp', 10.8586, 106.9250, false, ['Phường Tam Phước']],
  ['TTR', 'Tân Triều', 'P', 'trung_tam', 'Trung tâm', 10.9980, 106.8185, false, ['Thạnh Phú', 'Tân Bình (Vĩnh Cửu)', 'Bình Lợi', 'Xã Tân Triều']],

  // ── Nam — Sân bay & Cảng (2 phường lên ngày 30/04/2026) ──
  ['LTH', 'Long Thành', 'P', 'nam_san_bay_cang', 'Công nghiệp', 10.7782, 106.9462, true, ['Xã Long Thành', 'Thị trấn Long Thành', 'Huyện Long Thành', 'Lộc An', 'Bình Sơn', 'Long An', 'Sân bay Long Thành']],
  ['NTR', 'Nhơn Trạch', 'P', 'nam_san_bay_cang', 'Công nghiệp', 10.7458, 106.9474, true, ['Xã Nhơn Trạch', 'Huyện Nhơn Trạch', 'Thị trấn Hiệp Phước', 'Long Tân', 'Phú Thạnh', 'Phú Hội', 'Phước Thiền']],

  // ── Đông — Trảng Bom, Long Khánh, Xuân Lộc (8 phường; 3 phường lên 30/04/2026) ──
  ['TBO', 'Trảng Bom', 'P', 'dong_xuan_loc', 'Công nghiệp', 10.9526, 107.0104, true, ['Xã Trảng Bom', 'Thị trấn Trảng Bom', 'Huyện Trảng Bom', 'Quảng Tiến', 'Sông Trầu', 'Giang Điền']],
  ['DGI', 'Dầu Giây', 'P', 'dong_xuan_loc', 'Liên vùng', 10.9483, 107.1579, true, ['Xã Dầu Giây', 'Thị trấn Dầu Giây', 'Hưng Lộc', 'Bàu Hàm 2', 'Lộ 25']],
  ['LKH', 'Long Khánh', 'P', 'dong_xuan_loc', 'Liên vùng', 10.9336, 107.2627, false, ['TP. Long Khánh', 'Xuân An', 'Xuân Bình', 'Xuân Hòa (LK)', 'Phú Bình (LK)', 'Bàu Trâm']],
  ['BLC', 'Bình Lộc', 'P', 'dong_xuan_loc', 'Liên vùng', 10.9720, 107.2250, false, ['Suối Tre', 'Xuân Thiện', 'Xã Bình Lộc']],
  ['BVI', 'Bảo Vinh', 'P', 'dong_xuan_loc', 'Liên vùng', 10.9480, 107.2680, false, ['Bảo Quang', 'Phường Bảo Vinh']],
  ['XLA', 'Xuân Lập', 'P', 'dong_xuan_loc', 'Liên vùng', 10.9580, 107.2120, false, ['Bàu Sen', 'Xuân Tân', 'Phường Xuân Lập']],
  ['HGO', 'Hàng Gòn', 'P', 'dong_xuan_loc', 'Liên vùng', 10.8960, 107.2720, false, ['Xuân Thanh', 'Xã Hàng Gòn']],
  ['XLO', 'Xuân Lộc', 'P', 'dong_xuan_loc', 'Liên vùng', 10.9336, 107.4074, true, ['Xã Xuân Lộc', 'Huyện Xuân Lộc', 'Thị trấn Gia Ray', 'Xuân Trường', 'Xuân Thọ', 'Suối Cát']],

  // ── Đông Bắc — Cát Tiên, Trị An, Tân Phú (2 phường lên ngày 30/04/2026) ──
  ['TRA', 'Trị An', 'P', 'dong_bac_cat_tien', 'Nông thôn - Sinh thái', 11.0964, 107.0391, true, ['Xã Trị An', 'Thị trấn Vĩnh An', 'Huyện Vĩnh Cửu', 'Mã Đà', 'Hiếu Liêm']],
  ['TPU', 'Tân Phú', 'P', 'dong_bac_cat_tien', 'Nông thôn - Sinh thái', 11.2695, 107.4277, true, ['Xã Tân Phú', 'Thị trấn Tân Phú, Huyện Tân Phú', 'Thị trấn Tân Phú', 'Huyện Tân Phú', 'Phú Lộc', 'Trà Cổ', 'Phú Thanh', 'Phú Xuân']],

  // ── Bắc Đồng Nai — Đồng Xoài, Bình Phước, Chơn Thành, Bình Long, Lộc Ninh, Phước Long (11 phường; 3 phường lên 30/04/2026) ──
  ['BP', 'Bình Phước', 'P', 'bac_dong_nai', 'Trung tâm', 11.5350, 106.8832, false, ['Tân Đồng', 'Tân Thiện', 'Tân Bình (Đồng Xoài)', 'Tân Xuân', 'Tiến Hưng', 'Phường Tân Phú, Thành phố Đồng Xoài', 'Tân Phú (Đồng Xoài)', 'Thành phố Đồng Xoài', 'TP. Đồng Xoài']],
  ['DX', 'Đồng Xoài', 'P', 'bac_dong_nai', 'Trung tâm', 11.5550, 106.8650, false, ['Tiến Thành', 'Tân Thành (Đồng Xoài)', 'Phường Đồng Xoài']],
  ['DPU', 'Đồng Phú', 'P', 'bac_dong_nai', 'Công nghiệp', 11.4544, 106.8546, true, ['Xã Đồng Phú', 'Thị trấn Tân Phú, Huyện Đồng Phú', 'Huyện Đồng Phú', 'Thị trấn Tân Phú (Đồng Phú)', 'Tân Lập', 'Tân Tiến (Đồng Phú)']],
  ['CTH', 'Chơn Thành', 'P', 'bac_dong_nai', 'Công nghiệp', 11.4282, 106.6354, false, ['Thị xã Chơn Thành', 'Hưng Long', 'Thành Tâm', 'Minh Thành']],
  ['MHU', 'Minh Hưng', 'P', 'bac_dong_nai', 'Công nghiệp', 11.4720, 106.5920, false, ['Minh Long', 'Phường Minh Hưng']],
  ['TKH', 'Tân Khai', 'P', 'bac_dong_nai', 'Công nghiệp', 11.5580, 106.6150, true, ['Xã Tân Khai', 'Thị trấn Tân Khai', 'Huyện Hớn Quản', 'Tân Hiệp (Hớn Quản)', 'Đồng Nơ']],
  ['BLO', 'Bình Long', 'P', 'bac_dong_nai', 'Liên vùng', 11.6471, 106.6059, false, ['Thị xã Bình Long', 'Hưng Chiến', 'Phú Đức']],
  ['ALO', 'An Lộc', 'P', 'bac_dong_nai', 'Liên vùng', 11.6620, 106.6250, false, ['Phú Thịnh', 'Thanh Phú', 'Thanh Lương']],
  ['LNI', 'Lộc Ninh', 'P', 'bac_dong_nai', 'Liên vùng', 11.8448, 106.5907, true, ['Xã Lộc Ninh', 'Thị trấn Lộc Ninh', 'Huyện Lộc Ninh', 'Lộc Thái', 'Lộc Thuận']],
  ['PLO', 'Phước Long', 'P', 'bac_dong_nai', 'Liên vùng', 11.8114, 106.9967, false, ['Thị xã Phước Long', 'Thác Mơ', 'Long Thủy', 'Sơn Giang', 'Phước Tín']],
  ['PBI', 'Phước Bình', 'P', 'bac_dong_nai', 'Liên vùng', 11.8160, 106.9680, false, ['Long Phước (Phước Long)', 'Bình Sơn (Phước Long)', 'Phường Phước Bình']],
];

/** 62 XÃ (72 xã theo NQ 1662 trừ 10 xã lên phường ngày 30/04/2026) */
const XA_ROWS: readonly Row[] = [
  // ── Nam — Sân bay & Cảng (7 xã) ──
  ['DPH', 'Đại Phước', 'X', 'nam_san_bay_cang', 'Công nghiệp', 10.708, 106.835, false, ['Phú Hữu', 'Phú Đông', 'Phước Khánh']],
  ['PAN', 'Phước An', 'X', 'nam_san_bay_cang', 'Công nghiệp', 10.678, 106.942, false, ['Vĩnh Thanh', 'Long Thọ']],
  ['PTH', 'Phước Thái', 'X', 'nam_san_bay_cang', 'Công nghiệp', 10.715, 107.035, false, ['Tân Hiệp (Long Thành)', 'Phước Bình (Long Thành)']],
  ['LPH', 'Long Phước', 'X', 'nam_san_bay_cang', 'Công nghiệp', 10.762, 107.015, false, ['Bàu Cạn']],
  ['BAN', 'Bình An', 'X', 'nam_san_bay_cang', 'Công nghiệp', 10.818, 106.985, false, ['Long Đức']],
  ['APH', 'An Phước', 'X', 'nam_san_bay_cang', 'Công nghiệp', 10.836, 106.952, false, ['Tam An']],
  ['AVI', 'An Viễn', 'X', 'nam_san_bay_cang', 'Công nghiệp', 10.875, 107.018, false, ['Đồi 61']],

  // ── Đông — Trảng Bom, Thống Nhất, Cẩm Mỹ, Xuân Lộc (15 xã) ──
  ['BMI', 'Bình Minh', 'X', 'dong_xuan_loc', 'Công nghiệp', 10.946, 106.972, false, ['Bắc Sơn']],
  ['BHA', 'Bàu Hàm', 'X', 'dong_xuan_loc', 'Nông thôn - Sinh thái', 10.992, 107.058, false, ['Thanh Bình (Trảng Bom)', 'Cây Gáo', 'Sông Thao']],
  ['HTH', 'Hưng Thịnh', 'X', 'dong_xuan_loc', 'Liên vùng', 10.968, 107.065, false, ['Đông Hòa', 'Tây Hòa', 'Trung Hòa']],
  ['GKI', 'Gia Kiệm', 'X', 'dong_xuan_loc', 'Liên vùng', 11.032, 107.175, false, ['Quang Trung (Thống Nhất)', 'Gia Tân 3']],
  ['TNH', 'Thống Nhất', 'X', 'dong_xuan_loc', 'Liên vùng', 11.055, 107.212, false, ['Huyện Thống Nhất', 'Gia Tân 1', 'Gia Tân 2', 'Phú Cường', 'Phú Túc']],
  ['XDI', 'Xuân Định', 'X', 'dong_xuan_loc', 'Nông thôn - Sinh thái', 10.892, 107.335, false, ['Xuân Bảo', 'Bảo Hòa']],
  ['XPH', 'Xuân Phú', 'X', 'dong_xuan_loc', 'Liên vùng', 10.918, 107.352, false, ['Lang Minh']],
  ['XHO', 'Xuân Hòa', 'X', 'dong_xuan_loc', 'Liên vùng', 10.885, 107.508, false, ['Xuân Hưng', 'Xuân Tâm']],
  ['XTH', 'Xuân Thành', 'X', 'dong_xuan_loc', 'Nông thôn - Sinh thái', 10.965, 107.465, false, ['Suối Cao']],
  ['XBA', 'Xuân Bắc', 'X', 'dong_xuan_loc', 'Nông thôn - Sinh thái', 10.992, 107.352, false, ['Suối Nho']],
  ['XQU', 'Xuân Quế', 'X', 'dong_xuan_loc', 'Nông thôn - Sinh thái', 10.882, 107.195, false, ['Sông Nhạn']],
  ['XDU', 'Xuân Đường', 'X', 'dong_xuan_loc', 'Nông thôn - Sinh thái', 10.835, 107.172, false, ['Cẩm Đường', 'Thừa Đức']],
  ['CMY', 'Cẩm Mỹ', 'X', 'dong_xuan_loc', 'Nông thôn - Sinh thái', 10.805, 107.235, false, ['Huyện Cẩm Mỹ', 'Thị trấn Long Giao', 'Nhân Nghĩa', 'Xuân Mỹ', 'Bảo Bình']],
  ['SRA', 'Sông Ray', 'X', 'dong_xuan_loc', 'Nông thôn - Sinh thái', 10.812, 107.332, false, ['Lâm San']],
  ['XDO', 'Xuân Đông', 'X', 'dong_xuan_loc', 'Nông thôn - Sinh thái', 10.768, 107.285, false, ['Xuân Tây']],

  // ── Đông Bắc — Cát Tiên, Định Quán, Tân Phú, Vĩnh Cửu (11 xã) ──
  ['LNG', 'La Ngà', 'X', 'dong_bac_cat_tien', 'Nông thôn - Sinh thái', 11.148, 107.252, false, ['Túc Trưng']],
  ['DQU', 'Định Quán', 'X', 'dong_bac_cat_tien', 'Liên vùng', 11.202, 107.352, false, ['Huyện Định Quán', 'Thị trấn Định Quán', 'Phú Ngọc', 'Gia Canh']],
  ['TSO', 'Thanh Sơn', 'X', 'dong_bac_cat_tien', 'Nông thôn - Sinh thái', 11.168, 107.295, false, ['Xã Thanh Sơn']],
  ['PVI', 'Phú Vinh', 'X', 'dong_bac_cat_tien', 'Nông thôn - Sinh thái', 11.238, 107.392, false, ['Phú Lợi', 'Phú Tân']],
  ['PHO', 'Phú Hòa', 'X', 'dong_bac_cat_tien', 'Nông thôn - Sinh thái', 11.178, 107.382, false, ['Phú Điền', 'Ngọc Định']],
  ['TLA', 'Tà Lài', 'X', 'dong_bac_cat_tien', 'Nông thôn - Sinh thái', 11.3626, 107.3655, false, ['Phú Thịnh (Tân Phú)', 'Phú Lập', 'Xã Tà Lài']],
  ['NCT', 'Nam Cát Tiên', 'X', 'dong_bac_cat_tien', 'Nông thôn - Sinh thái', 11.438, 107.352, false, ['Núi Tượng', 'VQG Cát Tiên']],
  ['PLA', 'Phú Lâm', 'X', 'dong_bac_cat_tien', 'Nông thôn - Sinh thái', 11.318, 107.482, false, ['Phú Bình (Tân Phú)', 'Thanh Sơn (Tân Phú)', 'Phú Sơn']],
  ['DLU', 'Đak Lua', 'X', 'dong_bac_cat_tien', 'Nông thôn - Sinh thái', 11.448, 107.425, false, ['Đắc Lua', 'Xã Đak Lua']],
  ['PLY', 'Phú Lý', 'X', 'dong_bac_cat_tien', 'Nông thôn - Sinh thái', 11.265, 107.048, false, ['Xã Phú Lý']],
  ['TAN', 'Tân An', 'X', 'dong_bac_cat_tien', 'Nông thôn - Sinh thái', 11.045, 106.915, false, ['Vĩnh Tân']],

  // ── Bắc Đồng Nai — Chơn Thành, Hớn Quản, Lộc Ninh, Bù Đốp, Bù Gia Mập, Phú Riềng, Đồng Phú, Bù Đăng (29 xã) ──
  ['NBI', 'Nha Bích', 'X', 'bac_dong_nai', 'Công nghiệp', 11.445, 106.715, false, ['Minh Thắng', 'Minh Lập']],
  ['TQU', 'Tân Quan', 'X', 'bac_dong_nai', 'Nông thôn - Sinh thái', 11.508, 106.665, false, ['Phước An (Hớn Quản)', 'Tân Lợi (Hớn Quản)', 'Quang Minh']],
  ['THU', 'Tân Hưng', 'X', 'bac_dong_nai', 'Nông thôn - Sinh thái', 11.582, 106.685, false, ['An Khương', 'Thanh An']],
  ['MDU', 'Minh Đức', 'X', 'bac_dong_nai', 'Nông thôn - Sinh thái', 11.615, 106.548, false, ['An Phú (Hớn Quản)', 'Minh Tâm']],
  ['LTA', 'Lộc Thành', 'X', 'bac_dong_nai', 'Nông thôn - Sinh thái', 11.792, 106.515, false, ['Lộc Thịnh']],
  ['LHG', 'Lộc Hưng', 'X', 'bac_dong_nai', 'Nông thôn - Sinh thái', 11.758, 106.615, false, ['Lộc Khánh', 'Lộc Điền']],
  ['LTN', 'Lộc Tấn', 'X', 'bac_dong_nai', 'Nông thôn - Sinh thái', 11.882, 106.555, false, ['Lộc Thiện']],
  ['LTT', 'Lộc Thạnh', 'X', 'bac_dong_nai', 'Nông thôn - Sinh thái', 11.965, 106.545, false, ['Lộc Hòa', 'Cửa khẩu Hoa Lư']],
  ['LQU', 'Lộc Quang', 'X', 'bac_dong_nai', 'Nông thôn - Sinh thái', 11.812, 106.682, false, ['Lộc Phú', 'Lộc Hiệp']],
  ['TTI', 'Tân Tiến', 'X', 'bac_dong_nai', 'Nông thôn - Sinh thái', 11.935, 106.712, false, ['Tân Thành (Bù Đốp)', 'Lộc An (Lộc Ninh)']],
  ['THG', 'Thiện Hưng', 'X', 'bac_dong_nai', 'Liên vùng', 11.988, 106.798, false, ['Huyện Bù Đốp', 'Thị trấn Thanh Bình (Bù Đốp)', 'Thanh Hòa']],
  ['HPH', 'Hưng Phước', 'X', 'bac_dong_nai', 'Nông thôn - Sinh thái', 12.062, 106.842, false, ['Phước Thiện']],
  ['PNG', 'Phú Nghĩa', 'X', 'bac_dong_nai', 'Nông thôn - Sinh thái', 11.915, 106.935, false, ['Đức Hạnh', 'Phú Văn']],
  ['DKI', 'Đa Kia', 'X', 'bac_dong_nai', 'Nông thôn - Sinh thái', 11.868, 106.905, false, ['Phước Minh', 'Bình Thắng']],
  ['BTA', 'Bình Tân', 'X', 'bac_dong_nai', 'Nông thôn - Sinh thái', 11.745, 106.892, false, ['Long Bình (Phú Riềng)', 'Bình Sơn (Phú Riềng)']],
  ['LHA', 'Long Hà', 'X', 'bac_dong_nai', 'Nông thôn - Sinh thái', 11.732, 106.815, false, ['Long Tân (Phú Riềng)', 'Long Hưng (Phú Riềng)']],
  ['PRI', 'Phú Riềng', 'X', 'bac_dong_nai', 'Liên vùng', 11.675, 106.885, false, ['Huyện Phú Riềng', 'Bù Nho']],
  ['PTR', 'Phú Trung', 'X', 'bac_dong_nai', 'Nông thôn - Sinh thái', 11.652, 106.952, false, ['Phước Tân (Phú Riềng)']],
  ['TLO', 'Thuận Lợi', 'X', 'bac_dong_nai', 'Nông thôn - Sinh thái', 11.588, 106.968, false, ['Thuận Phú']],
  ['DTA', 'Đồng Tâm', 'X', 'bac_dong_nai', 'Liên vùng', 11.568, 107.015, false, ['Đồng Tiến', 'Tân Phước']],
  ['TLY', 'Tân Lợi', 'X', 'bac_dong_nai', 'Nông thôn - Sinh thái', 11.402, 106.865, false, ['Tân Hòa (Đồng Phú)', 'Tân Hưng (Đồng Phú)']],
  ['PSO', 'Phước Sơn', 'X', 'bac_dong_nai', 'Nông thôn - Sinh thái', 11.695, 107.112, false, ['Thống Nhất (Bù Đăng)', 'Đăng Hà']],
  ['NTRG', 'Nghĩa Trung', 'X', 'bac_dong_nai', 'Nông thôn - Sinh thái', 11.678, 107.175, false, ['Nghĩa Bình', 'Đức Liễu']],
  ['BDA', 'Bù Đăng', 'X', 'bac_dong_nai', 'Liên vùng', 11.768, 107.235, false, ['Huyện Bù Đăng', 'Thị trấn Đức Phong', 'Minh Hưng (Bù Đăng)', 'Đoàn Kết']],
  ['TSN', 'Thọ Sơn', 'X', 'bac_dong_nai', 'Nông thôn - Sinh thái', 11.825, 107.305, false, ['Đồng Nai (Bù Đăng)', 'Phú Sơn (Bù Đăng)']],
  ['DNH', 'Đak Nhau', 'X', 'bac_dong_nai', 'Nông thôn - Sinh thái', 11.915, 107.185, false, ['Đăk Nhau', 'Đường 10']],
  ['BBO', 'Bom Bo', 'X', 'bac_dong_nai', 'Nông thôn - Sinh thái', 11.815, 107.118, false, ['Bình Minh (Bù Đăng)', 'Sóc Bom Bo']],
  ['BGM', 'Bù Gia Mập', 'X', 'bac_dong_nai', 'Nông thôn - Sinh thái', 12.1294, 107.1745, false, ['Huyện Bù Gia Mập', 'VQG Bù Gia Mập']],
  ['DKO', 'Đăk Ơ', 'X', 'bac_dong_nai', 'Nông thôn - Sinh thái', 12.065, 107.018, false, ['Đak Ơ', 'Xã Đăk Ơ']],
];

export const ARTERIAL_ROAD_NAMES = [
  'Nguyễn Ái Quốc',
  'Cách Mạng Tháng Tám',
  'Đồng Khởi',
  'Võ Thị Sáu',
  'Phạm Văn Thuận',
  'Quốc lộ 1A',
  'Quốc lộ 51',
  'Quốc lộ 20',
  'Quốc lộ 13',
  'Quốc lộ 14',
  'ĐT 741',
  'Bùi Văn Hòa',
] as const;

export const QUICK_JUMP_REGIONS: readonly QuickJumpRegion[] = [
  { id: 'trung_tam', labelVi: 'Đô thị Trung tâm', labelEn: 'Central Urban', center: [10.9492, 106.845], zoom: 13 },
  { id: 'nam_san_bay_cang', labelVi: 'Nam — Sân bay & Cảng', labelEn: 'South — Airport & Port', center: [10.7782, 106.947], zoom: 12 },
  { id: 'dong_xuan_loc', labelVi: 'Đông — Long Khánh & Xuân Lộc', labelEn: 'East — Long Khanh & Xuan Loc', center: [10.938, 107.22], zoom: 11 },
  { id: 'dong_bac_cat_tien', labelVi: 'Đông Bắc — Cát Tiên & Tân Phú', labelEn: 'NE — Cat Tien & Tan Phu', center: [11.24, 107.31], zoom: 10 },
  { id: 'bac_dong_nai', labelVi: 'Bắc Đồng Nai — Đồng Xoài & Lộc Ninh', labelEn: 'North — Dong Xoai & Loc Ninh', center: [11.68, 106.85], zoom: 10 },
];

function arterialFor(region: CityRegionId, code: string): string[] {
  if (code === 'TB') return ['Nguyễn Ái Quốc', 'Quốc lộ 1A', 'Đồng Khởi', 'Cách Mạng Tháng Tám'];
  switch (region) {
    case 'trung_tam':
      return ['Quốc lộ 1A', 'Nguyễn Ái Quốc', 'Đồng Khởi', 'Bùi Văn Hòa'];
    case 'nam_san_bay_cang':
      return ['Quốc lộ 51', 'Bùi Văn Hòa'];
    case 'dong_xuan_loc':
      return ['Quốc lộ 1A', 'Quốc lộ 20'];
    case 'dong_bac_cat_tien':
      return ['Quốc lộ 20', 'ĐT 762'];
    case 'bac_dong_nai':
      return ['Quốc lộ 13', 'Quốc lộ 14', 'ĐT 741'];
  }
}

function toRad(d: number): number {
  return (d * Math.PI) / 180;
}
function dist(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(x)));
}

function build(): Ward[] {
  const allRows: readonly Row[] = [...PHUONG_ROWS, ...XA_ROWS];
  const base: Ward[] = allRows.map((r) => {
    const kind = r[2] === 'P' ? 'Phường' : 'Xã';
    return {
      wardCode: `DN-${r[0]}`,
      name: `${kind} ${r[1]}`,
      shortName: r[1],
      kind,
      region: r[3],
      zone: r[4],
      centerLat: r[5],
      centerLng: r[6],
      upgradedOn2026: r[7],
      legacyAliases: r[8],
      adjacentWardCodes: [],
      arterialRoads: arterialFor(r[3], r[0]),
    };
  });

  // Assert cứng chuẩn 95 ĐVHC (33 Phường, 62 Xã) ngay lúc khởi tạo module
  const phuongCount = base.filter((w) => w.kind === 'Phường').length;
  const xaCount = base.filter((w) => w.kind === 'Xã').length;
  if (base.length !== 95 || phuongCount !== 33 || xaCount !== 62) {
    throw new Error(`Dữ liệu 95 ĐVHC TP. Đồng Nai sai cấu trúc: total=${base.length}, phuong=${phuongCount}, xa=${xaCount}`);
  }

  for (const w of base) {
    w.adjacentWardCodes = base
      .filter((o) => o.wardCode !== w.wardCode)
      .map((o) => ({ code: o.wardCode, d: dist(w.centerLat, w.centerLng, o.centerLat, o.centerLng) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 3)
      .map((o) => o.code);
  }
  return base;
}

export const DONG_NAI_WARDS: readonly Ward[] = build();
export const WARD_BY_CODE: Readonly<Record<string, Ward>> = Object.fromEntries(
  DONG_NAI_WARDS.map((w) => [w.wardCode, w]),
);

export const UPGRADED_2026_WARDS: readonly Ward[] = DONG_NAI_WARDS.filter((w) => w.upgradedOn2026);

export function getWard(code: string): Ward | undefined {
  return WARD_BY_CODE[code];
}

/** Chuẩn hóa chuỗi tiếng Việt không dấu, chữ thường để tìm kiếm & đối chiếu alias cực nhanh. */
export function normalizeVi(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const SEARCH_INDEX = DONG_NAI_WARDS.map((w) => ({
  ward: w,
  nameNorm: normalizeVi(w.name),
  shortNorm: normalizeVi(w.shortName),
  codeNorm: w.wardCode.toLowerCase(),
  aliasNorms: w.legacyAliases.map(normalizeVi),
}));

/** Tìm kiếm không dấu trên 95 Phường/Xã (tên mới, mã đơn vị và tên cũ 2 thế hệ). */
export function searchWards(query: string, limit = 15): Ward[] {
  const q = normalizeVi(query);
  if (!q) return DONG_NAI_WARDS.slice(0, limit);
  const scored: Array<{ ward: Ward; score: number }> = [];
  for (const entry of SEARCH_INDEX) {
    if (entry.codeNorm === q || entry.shortNorm === q || entry.nameNorm === q) {
      scored.push({ ward: entry.ward, score: 100 });
    } else if (entry.shortNorm.startsWith(q) || entry.nameNorm.startsWith(q)) {
      scored.push({ ward: entry.ward, score: 80 });
    } else if (entry.nameNorm.includes(q) || entry.codeNorm.includes(q)) {
      scored.push({ ward: entry.ward, score: 60 });
    } else if (entry.aliasNorms.some((a) => a.includes(q))) {
      scored.push({ ward: entry.ward, score: 40 });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score || a.ward.name.localeCompare(b.ward.name, 'vi'))
    .slice(0, limit)
    .map((x) => x.ward);
}

/**
 * Đối chiếu tên đơn vị hành chính từ chuỗi địa chỉ Nominatim/OSM (hỗ trợ cả địa chỉ 3 cấp cũ
 * trước 01/07/2025 lẫn 10 xã nâng cấp phường ngày 30/04/2026) về đúng 1 trong 95 Phường/Xã.
 */
export function matchWardByAddressText(addressText: string): { ward: Ward; matchedAlias: string } | null {
  const norm = normalizeVi(addressText);
  if (!norm) return null;

  const hasPhrase = (haystack: string, needle: string): boolean => {
    if (!needle || needle.length < 3) return false;
    return ` ${haystack} `.includes(` ${needle} `);
  };

  // Phân tầng độ đặc hiệu cho địa chỉ Việt Nam:
  //  - Tầng A (+200): Bí danh ghép cả cấp xã/phường/thị trấn + cấp huyện/TP cũ (vd: "Thị trấn Tân Phú, Huyện Đồng Phú", "Phường Tân Phú, Thành phố Đồng Xoài")
  //  - Tầng B (+100): Tên chính thức ("Xã Tà Lài", "Phường Trấn Biên") hoặc bí danh cấp xã/phường/thị trấn đơn lẻ
  //  - Tầng C (+0):   Bí danh cấp huyện/thị xã/thành phố cũ đơn lẻ ("Huyện Tân Phú", "Thị xã Phước Long") — chỉ dùng khi không khớp Tầng A/B
  const isBareDistrict = (aNorm: string): boolean =>
    /^(huyen|thi xa|tp|thanh pho)\s/.test(aNorm);
  const isCompositeAlias = (aNorm: string): boolean =>
    /^(phuong|xa|thi tran)\s.+\s(huyen|thi xa|tp|thanh pho)\s/.test(aNorm);

  let bestMatch: { ward: Ward; label: string; score: number } | null = null;
  for (const entry of SEARCH_INDEX) {
    if (hasPhrase(norm, entry.nameNorm)) {
      const score = 100 + entry.nameNorm.length + 4;
      if (!bestMatch || score > bestMatch.score) {
        bestMatch = { ward: entry.ward, label: entry.ward.name, score };
      }
    }
    entry.ward.legacyAliases.forEach((rawAlias, idx) => {
      const aNorm = entry.aliasNorms[idx];
      if (!hasPhrase(norm, aNorm)) return;
      const tierBonus = isCompositeAlias(aNorm) ? 200 : isBareDistrict(aNorm) ? 0 : 100;
      const score = tierBonus + aNorm.length;
      if (!bestMatch || score > bestMatch.score) {
        bestMatch = { ward: entry.ward, label: rawAlias, score };
      }
    });
  }
  if (bestMatch) {
    return { ward: bestMatch.ward, matchedAlias: bestMatch.label };
  }

  // Ưu tiên 3: khớp tên ngắn ("tran bien", "ta lai", "bu gia map"...) kèm tiền tố xã/phường/thị trấn
  for (const entry of SEARCH_INDEX) {
    if (
      hasPhrase(norm, `xa ${entry.shortNorm}`) ||
      hasPhrase(norm, `phuong ${entry.shortNorm}`) ||
      hasPhrase(norm, `thi tran ${entry.shortNorm}`) ||
      hasPhrase(norm, entry.shortNorm)
    ) {
      return { ward: entry.ward, matchedAlias: entry.ward.shortName };
    }
  }
  return null;
}
