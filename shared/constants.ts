import type { Category, Department } from './types';

export const DHASH_DUPLICATE_MAX = 5;
export const DHASH_ANGLE_MIN = 12;
export const CLUSTER_RADIUS_M = 50;
export const GPS_WARN_M = 2000;
export const GPS_QUARANTINE_M = 5000;
export const AUTHENTICITY_MIN = 45;
export const TRUST_START = 70;
export const TRUST_SUPERVISED_BELOW = 30;
export const TRUST_VERIFIED_BONUS = 5;
export const TRUST_SPAM_PENALTY = 20;
export const DUPLICATE_WINDOW_MS = 24 * 3600 * 1000;
export const PILOT_WARD_CODE = 'DN-TB';

export const DONG_NAI_BBOX = { latMin: 10.6, latMax: 11.55, lngMin: 106.7, lngMax: 107.6 } as const;

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
