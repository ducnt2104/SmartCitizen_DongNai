import type { Report, Role } from '../shared/types';
import type { UserRecord } from '../repositories/types';
import { badRequest, forbidden } from '../utils/errors';

export const STAFF_ROLES: readonly Role[] = ['ward_officer', 'city_admin', 'super_admin'];
export const RESCUE_CAPABLE_ROLES: readonly Role[] = ['rescue_team', 'ward_officer', 'city_admin', 'super_admin'];
export const ADMIN_ROLES: readonly Role[] = ['city_admin', 'super_admin'];

export function isStaff(u: Pick<UserRecord, 'role'> | null | undefined): boolean {
  return !!u && STAFF_ROLES.includes(u.role);
}

export function isRescueCapable(u: Pick<UserRecord, 'role'> | null | undefined): boolean {
  return !!u && RESCUE_CAPABLE_ROLES.includes(u.role);
}

export function isAdminRole(u: Pick<UserRecord, 'role'> | null | undefined): boolean {
  return !!u && ADMIN_ROLES.includes(u.role);
}

/** Cán bộ phường chỉ thao tác trong wardCode của mình; Đội cứu hộ SOS, cấp Thành phố & Super Admin cơ động liên phường. */
export function inScope(u: Pick<UserRecord, 'role' | 'wardCode'>, wardCode: string): boolean {
  if (u.role === 'super_admin' || u.role === 'city_admin' || u.role === 'rescue_team') return true;
  if (u.role === 'ward_officer') return u.wardCode === wardCode;
  return false;
}

export function assertScope(u: UserRecord, r: Pick<Report, 'wardCode'>): void {
  if (!inScope(u, r.wardCode)) throw forbidden('Hồ sơ nằm ngoài phạm vi phường/xã được phân quyền.');
}

export function isOwner(u: Pick<UserRecord, 'id'>, r: Pick<Report, 'reporterId' | 'contributors'>): boolean {
  return r.reporterId === u.id || r.contributors.some((c) => c.userId === u.id);
}

export function canSee(u: UserRecord | null, r: Report): boolean {
  if (r.status !== 'quarantined' && r.status !== 'rejected') return true;
  if (!u) return false;
  if (isOwner(u, r)) return true;
  if (isRescueCapable(u)) return inScope(u, r.wardCode);
  if (u.role === 'volunteer') return r.needsFieldVerification && (u.wardCode === r.wardCode || r.assignedVolunteerId === u.id);
  return false;
}

export interface PhotoInput {
  dataUrl: string;
  dHash: string;
}

const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;
export const MAX_PHOTO_BASE64 = 1_800_000;

export function parsePhotoDataUrl(dataUrl: string): { mime: string; base64: string } {
  const m = DATA_URL_RE.exec(dataUrl);
  if (!m) throw badRequest('Ảnh phải là JPEG/PNG/WebP dạng data URL base64.', 'invalid_photo');
  if (m[2].length > MAX_PHOTO_BASE64) throw badRequest('Ảnh quá lớn (tối đa ~1.3MB sau nén).', 'photo_too_large');
  return { mime: m[1], base64: m[2] };
}
