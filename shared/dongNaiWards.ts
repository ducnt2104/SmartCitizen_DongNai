import type { Ward, WardZone } from './types';

/**
 * Danh mục 95 xã, phường thuộc Thành phố Đồng Nai.
 * LƯU Ý TRUNG THỰC: tên đơn vị và tọa độ tâm là số liệu xấp xỉ phục vụ demo;
 * cần đối chiếu với danh mục hành chính chính thức trước khi vận hành thật.
 * `adjacentWardCodes` được tính tự động = 3 đơn vị gần nhất theo khoảng cách Haversine.
 */

type Row = readonly [code: string, name: string, kind: 'P' | 'X', lat: number, lng: number];

const TRUNG_TAM: Row[] = [
  ['TB', 'Trấn Biên', 'P', 10.9465, 106.8243],
  ['BH', 'Biên Hòa', 'P', 10.957, 106.843],
  ['TDG', 'Trung Dũng', 'P', 10.9525, 106.831],
  ['QVH', 'Quang Vinh', 'P', 10.96, 106.815],
  ['QTH', 'Quyết Thắng', 'P', 10.967, 106.819],
  ['TBN', 'Thanh Bình', 'P', 10.963, 106.829],
  ['TNH', 'Thống Nhất', 'P', 10.946, 106.835],
  ['TTI', 'Tân Tiến', 'P', 10.939, 106.833],
  ['TMA', 'Tân Mai', 'P', 10.94, 106.82],
  ['TPH', 'Tân Phong', 'P', 10.972, 106.835],
  ['THI', 'Tân Hiệp', 'P', 10.936, 106.844],
  ['TBI', 'Tân Biên', 'P', 10.93, 106.825],
  ['HBN', 'Hòa Bình', 'P', 10.935, 106.815],
  ['BDA', 'Bình Đa', 'P', 10.919, 106.848],
  ['BHO', 'Bửu Hòa', 'P', 10.933, 106.79],
  ['BLO', 'Bửu Long', 'P', 10.965, 106.795],
  ['HHO', 'Hiệp Hòa', 'P', 10.962, 106.845],
  ['HAN', 'Hóa An', 'P', 10.94, 106.8],
  ['ABI', 'An Bình', 'P', 10.915, 106.83],
  ['THP', 'Tam Hiệp', 'P', 10.95, 106.856],
];

const CONG_NGHIEP: Row[] = [
  ['HNI', 'Hố Nai', 'P', 10.957, 106.9],
  ['TDA', 'Trảng Dài', 'P', 10.983, 106.865],
  ['LBI', 'Long Bình', 'P', 10.91, 106.88],
  ['LBT', 'Long Bình Tân', 'P', 10.925, 106.865],
  ['TPC', 'Tam Phước', 'P', 10.87, 106.93],
  ['PTA', 'Phước Tân', 'P', 10.88, 106.9],
  ['LHU', 'Long Hưng', 'P', 10.89, 106.85],
  ['AHO', 'An Hòa', 'P', 10.9, 106.895],
  ['THO', 'Tam Hòa', 'P', 10.95, 106.88],
  ['TBO', 'Trảng Bom', 'P', 10.954, 107.01],
  ['HTH', 'Hưng Thịnh', 'X', 10.97, 106.98],
  ['STR', 'Sông Trầu', 'X', 10.93, 107.0],
  ['BSO', 'Bắc Sơn', 'X', 10.96, 107.03],
  ['BMI', 'Bình Minh', 'X', 10.95, 106.97],
  ['GDI', 'Giang Điền', 'X', 10.905, 106.985],
  ['AVI', 'An Viễn', 'X', 10.87, 107.0],
  ['LTH', 'Long Thành', 'P', 10.79, 106.95],
  ['APH', 'An Phước', 'X', 10.835, 106.97],
  ['LPH', 'Long Phước', 'X', 10.78, 107.01],
  ['TAN', 'Tam An', 'X', 10.82, 106.93],
  ['PTH', 'Phước Thái', 'X', 10.77, 107.05],
  ['BSN', 'Bình Sơn', 'X', 10.795, 106.985],
  ['LDU', 'Long Đức', 'X', 10.8, 106.94],
  ['NTR', 'Nhơn Trạch', 'P', 10.73, 106.94],
  ['PAN', 'Phước An', 'X', 10.69, 106.95],
  ['PHO', 'Phú Hội', 'X', 10.71, 106.9],
  ['VTH', 'Vĩnh Thanh', 'X', 10.68, 106.925],
  ['DPH', 'Đại Phước', 'X', 10.705, 106.84],
];

const LIEN_VUNG: Row[] = [
  ['LKH', 'Long Khánh', 'P', 10.93, 107.24],
  ['XLA', 'Xuân Lập', 'X', 10.96, 107.27],
  ['XTA', 'Xuân Tân', 'P', 10.915, 107.25],
  ['XBI', 'Xuân Bình', 'P', 10.945, 107.23],
  ['XTR', 'Xuân Trung', 'P', 10.935, 107.22],
  ['XTH', 'Xuân Thanh', 'P', 10.905, 107.215],
  ['BSE', 'Bàu Sen', 'P', 10.925, 107.255],
  ['BVI', 'Bảo Vinh', 'X', 10.945, 107.265],
  ['STE', 'Suối Tre', 'P', 10.94, 107.2],
  ['HGO', 'Hàng Gòn', 'X', 10.9, 107.28],
  ['BTR', 'Bàu Trâm', 'P', 10.915, 107.265],
  ['DGI', 'Dầu Giây', 'X', 10.938, 107.14],
  ['GKI', 'Gia Kiệm', 'X', 11.03, 107.17],
  ['QTR', 'Quang Trung', 'X', 10.965, 107.165],
  ['HLO', 'Hưng Lộc', 'X', 10.985, 107.12],
  ['XTN', 'Xuân Thạnh', 'X', 10.91, 107.165],
  ['LHA', 'Lộ 25', 'X', 10.98, 107.15],
  ['BLC', 'Bình Lộc', 'X', 10.97, 107.225],
  ['XHU', 'Xuân Hưng', 'X', 10.995, 107.36],
  ['XQU', 'Xuân Quế', 'X', 10.89, 107.2],
];

const NONG_THON: Row[] = [
  ['TTR', 'Tân Triều', 'X', 10.98, 106.805],
  ['TPU', 'Thạnh Phú', 'X', 11.0, 106.83],
  ['TAV', 'Tân An', 'X', 11.035, 106.915],
  ['TRA', 'Trị An', 'X', 11.09, 107.02],
  ['PLY', 'Phú Lý', 'X', 11.26, 107.05],
  ['MDA', 'Mã Đà', 'X', 11.36, 107.07],
  ['HLI', 'Hiếu Liêm', 'X', 11.17, 107.0],
  ['VTA', 'Vĩnh Tân', 'X', 11.07, 106.85],
  ['BHA', 'Bình Hòa', 'X', 11.015, 106.865],
  ['TTA', 'Thiện Tân', 'X', 11.05, 106.84],
  ['TLA', 'Tà Lài', 'X', 11.42, 107.36],
  ['NCT', 'Nam Cát Tiên', 'X', 11.49, 107.33],
  ['DLU', 'Đắc Lua', 'X', 11.4, 107.44],
  ['PBI', 'Phú Bình', 'X', 11.3, 107.43],
  ['PLA', 'Phú Lâm', 'X', 11.32, 107.49],
  ['PTR', 'Phú Trung', 'X', 11.3, 107.36],
  ['PTN', 'Phú Thanh', 'X', 11.25, 107.4],
  ['PSO', 'Phú Sơn', 'X', 11.35, 107.46],
  ['DQU', 'Định Quán', 'X', 11.2, 107.35],
  ['LNG', 'La Ngà', 'X', 11.15, 107.26],
  ['PNG', 'Phú Ngọc', 'X', 11.11, 107.23],
  ['GCA', 'Gia Canh', 'X', 11.22, 107.28],
  ['TSO', 'Thanh Sơn', 'X', 11.13, 107.33],
  ['CMY', 'Cẩm Mỹ', 'X', 10.8, 107.24],
  ['SRA', 'Sông Ray', 'X', 10.85, 107.3],
  ['XDU', 'Xuân Đường', 'X', 10.83, 107.2],
  ['XDO', 'Xuân Đông', 'X', 10.76, 107.3],
];

const ARTERIAL_NAMES = [
  'Nguyễn Ái Quốc',
  'Cách Mạng Tháng Tám',
  'Đồng Khởi',
  'Võ Thị Sáu',
  'Phạm Văn Thuận',
  'Quốc lộ 1A',
  'Quốc lộ 51',
  'Quốc lộ 20',
  'Bùi Văn Hòa',
] as const;

function arterialFor(zone: WardZone, code: string, idx: number): string[] {
  if (code === 'TB') return ['Nguyễn Ái Quốc', 'Quốc lộ 1A', 'Đồng Khởi', 'Cách Mạng Tháng Tám'];
  const A = ARTERIAL_NAMES;
  switch (zone) {
    case 'Trung tâm':
      return [A[idx % 5], A[(idx + 2) % 5], 'Quốc lộ 1A'];
    case 'Công nghiệp':
      return idx % 3 === 0 ? ['Quốc lộ 51', 'Bùi Văn Hòa'] : idx % 3 === 1 ? ['Quốc lộ 1A', 'Quốc lộ 51'] : ['Quốc lộ 51'];
    case 'Liên vùng':
      return idx % 2 === 0 ? ['Quốc lộ 1A', 'Quốc lộ 20'] : ['Quốc lộ 20'];
    default:
      return idx % 3 === 0 ? ['Quốc lộ 20'] : idx % 3 === 1 ? ['Quốc lộ 1A'] : ['Quốc lộ 20', 'Quốc lộ 1A'];
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
  const groups: Array<[WardZone, Row[]]> = [
    ['Trung tâm', TRUNG_TAM],
    ['Công nghiệp', CONG_NGHIEP],
    ['Liên vùng', LIEN_VUNG],
    ['Nông thôn - Sinh thái', NONG_THON],
  ];
  const base: Ward[] = [];
  for (const [zone, rows] of groups) {
    rows.forEach((r, idx) => {
      base.push({
        wardCode: `DN-${r[0]}`,
        name: `${r[2] === 'P' ? 'Phường' : 'Xã'} ${r[1]}`,
        kind: r[2] === 'P' ? 'Phường' : 'Xã',
        zone,
        centerLat: r[3],
        centerLng: r[4],
        adjacentWardCodes: [],
        arterialRoads: arterialFor(zone, r[0], idx),
      });
    });
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
export const ARTERIAL_ROAD_NAMES = ARTERIAL_NAMES;

export function getWard(code: string): Ward | undefined {
  return WARD_BY_CODE[code];
}
