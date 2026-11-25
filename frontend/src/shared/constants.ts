import type { Category, Department } from './types';

export const DHASH_DUPLICATE_MAX = 5;
export const DHASH_ANGLE_MIN = 12;
/** Bán kính gom cụm Hồ sơ Mẹ nghiêm ngặt (m) */
export const CLUSTER_RADIUS_M = 50;
/** Bán kính phát hiện trùng lặp thông minh gợi ý "Cùng phản ánh / Ủng hộ (+1)" (m) */
export const DUPLICATE_SCAN_RADIUS_M = 100;
export const GPS_WARN_M = 2000;
export const GPS_QUARANTINE_M = 5000;
export const AUTHENTICITY_MIN = 45;
export const TRUST_START = 70;
export const TRUST_SUPERVISED_BELOW = 30;
export const TRUST_VERIFIED_BONUS = 5;
export const TRUST_SPAM_PENALTY = 20;
export const DUPLICATE_WINDOW_MS = 24 * 3600 * 1000;

/**
 * Khung bao địa lý toàn Thành phố Đồng Nai mới (95 Phường/Xã — gồm cả khu vực phía Bắc/Bình Phước cũ
 * và Đông Bắc/Cát Tiên, từ Nam Nhơn Trạch 10.50°N đến Bắc Bù Gia Mập/Lộc Thạnh 12.28°N).
 */
export const DONG_NAI_CITY_BOUNDS = {
  latMin: 10.5,
  latMax: 12.28,
  lngMin: 106.42,
  lngMax: 107.68,
} as const;

export const DONG_NAI_BBOX = DONG_NAI_CITY_BOUNDS;

/** Tâm địa lý toàn Thành phố Đồng Nai cho chế độ xem tổng thể (không khóa riêng 1 phường). */
export const DONG_NAI_CITY_CENTER: readonly [lat: number, lng: number] = [11.35, 107.02];

/** Khung fitBounds toàn Thành phố Đồng Nai [[south, west], [north, east]] */
export const DONG_NAI_MAP_BOUNDS: readonly [readonly [number, number], readonly [number, number]] = [
  [DONG_NAI_CITY_BOUNDS.latMin, DONG_NAI_CITY_BOUNDS.lngMin],
  [DONG_NAI_CITY_BOUNDS.latMax, DONG_NAI_CITY_BOUNDS.lngMax],
];

export const DEPARTMENT_BY_CATEGORY: Record<Category, Department> = {
  rac_thai: 'moi_truong',
  den_duong: 'dien_chieu_sang',
  ngap_nuoc: 'ubnd_khu_pho',
  mat_duong: 'giao_thong',
};

export const DEPARTMENTS: readonly Department[] = [
  'dien_chieu_sang',
  'moi_truong',
  'giao_thong',
  'ubnd_khu_pho',
  'dien_luc',
  'csgt',
] as const;

/** Mã chi đoàn hợp lệ: DN-TB-01, DN-BH-12 ... */
export const UNIT_CODE_REGEX = /^DN-[A-Z]{2,4}-\d{2}$/;
