import type { Category, Department, Role, RoleCode, SeverityLabel } from './types';

export const DHASH_DUPLICATE_MAX = 5;
export const DHASH_ANGLE_MIN = 12;
/** Bán kính gom cụm Hồ sơ Mẹ nghiêm ngặt (m) */
export const CLUSTER_RADIUS_M = 50;
/** Bán kính phát hiện trùng lặp thông minh gợi ý "Cùng phản ánh / Ủng hộ (+1)" (m) */
export const DUPLICATE_SCAN_RADIUS_M = 100;
export const GPS_WARN_M = 2000;
export const GPS_QUARANTINE_M = 5000;
export const AUTHENTICITY_MIN = 45;
export const TRUST_START = 50;
export const TRUST_SUPERVISED_BELOW = 25;
export const TRUST_VERIFIED_BONUS = 5;
export const TRUST_AUTO_APPROVE_BONUS = 3;
export const TRUST_SPAM_PENALTY = 20;
export const DUPLICATE_WINDOW_MS = 24 * 3600 * 1000;

export const DONG_NAI_CITY_BOUNDS = {
  latMin: 10.5,
  latMax: 12.28,
  lngMin: 106.42,
  lngMax: 107.68,
} as const;

export const DONG_NAI_BBOX = DONG_NAI_CITY_BOUNDS;
export const DONG_NAI_CITY_CENTER: readonly [lat: number, lng: number] = [11.35, 107.02];

export const DONG_NAI_MAP_BOUNDS: readonly [readonly [number, number], readonly [number, number]] = [
  [DONG_NAI_CITY_BOUNDS.latMin, DONG_NAI_CITY_BOUNDS.lngMin],
  [DONG_NAI_CITY_BOUNDS.latMax, DONG_NAI_CITY_BOUNDS.lngMax],
];

export const DEPARTMENT_BY_CATEGORY: Record<Category, Department> = {
  rac_thai: 'moi_truong',
  den_duong: 'dien_chieu_sang',
  ngap_nuoc: 'ubnd_khu_pho',
  mat_duong: 'giao_thong',
  khac: 'ubnd_khu_pho',
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

export function normalizeRoleInput(raw: string): Role | null {
  switch (raw.trim().toLowerCase()) {
    case 'super_admin':
    case 'superadmin':
    case 'city_admin':
    case 'admin':
      return 'admin';
    case 'ward_officer':
    case 'officer':
    case 'volunteer':
    case 'youth_union':
      return 'officer';
    case 'rescue_team':
    case 'rescue':
    case 'cuu_ho':
      return 'rescue';
    case 'citizen':
      return 'citizen';
    default:
      return null;
  }
}

/** Chuẩn hóa tương thích ngược mọi vai trò cũ từ MongoDB / localStorage về đúng 4 vai trò chuẩn. */
export function normalizeRole(raw: unknown, fallback: Role = 'citizen'): Role {
  if (typeof raw !== 'string') return fallback;
  return normalizeRoleInput(raw) ?? fallback;
}

export function toRoleCode(role: Role | string): RoleCode {
  switch (normalizeRole(role)) {
    case 'admin':
      return 'ADMIN';
    case 'officer':
      return 'OFFICER';
    case 'rescue':
      return 'RESCUE';
    case 'citizen':
      return 'CITIZEN';
  }
}

export function legacyRolesFor(role: Role): readonly string[] {
  switch (role) {
    case 'admin':
      return ['admin', 'super_admin', 'city_admin', 'SUPER_ADMIN', 'ADMIN'];
    case 'officer':
      return ['officer', 'ward_officer', 'volunteer', 'OFFICER', 'YOUTH_UNION'];
    case 'rescue':
      return ['rescue', 'rescue_team', 'RESCUE', 'RESCUE_TEAM'];
    case 'citizen':
      return ['citizen', 'CITIZEN'];
  }
}

/** Chuyển mức độ 1–5 + cờ khẩn cấp thành nhãn SOS chuẩn quốc tế (`CRITICAL | HIGH | MEDIUM | LOW`). */
export function toSeverityLabel(severity: number, isEmergency = false): SeverityLabel {
  if (isEmergency || severity >= 5) return 'CRITICAL';
  if (severity >= 4) return 'HIGH';
  if (severity >= 3) return 'MEDIUM';
  return 'LOW';
}

/** Chấm điểm ưu tiên SOS thông minh (thang 1–100) phục vụ sắp xếp hàng đợi Đội Cứu Hộ & IOC. */
export function computeSosPriorityScore(params: {
  severity: number;
  isEmergency?: boolean;
  onArterial?: boolean;
  clusterCount?: number;
  confirmCount?: number;
}): number {
  const sev = Math.max(1, Math.min(5, Math.round(params.severity || 3)));
  let score = sev * 14; // 14..70
  if (params.isEmergency) score += 18;
  if (params.onArterial) score += 8;
  const clusterBonus = Math.min(12, Math.max(0, (params.clusterCount ?? 1) - 1) * 4);
  const confirmBonus = Math.min(8, Math.max(0, params.confirmCount ?? 0) * 2);
  score += clusterBonus + confirmBonus;
  return Math.max(1, Math.min(100, Math.round(score)));
}

export function normalizeCategoryInput(raw: string): Category | null {
  switch (raw.trim().toLowerCase()) {
    case 'rac_thai':
    case 'moi_truong':
      return 'rac_thai';
    case 'den_duong':
      return 'den_duong';
    case 'ngap_nuoc':
      return 'ngap_nuoc';
    case 'mat_duong':
    case 'giao_thong':
      return 'mat_duong';
    case 'khac':
    case 'other':
      return 'khac';
    default:
      return null;
  }
}
