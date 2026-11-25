import type { Request } from 'express';
import { normalizeRole } from '../shared/constants';
import { isValidHash } from '../shared/dhash';
import type { Photo, Report, Role } from '../shared/types';
import type { UserRecord } from '../repositories/types';
import { badRequest, forbidden } from '../utils/errors';
import { mediaService } from './media.service';

export const STAFF_ROLES: readonly Role[] = ['officer', 'admin'];
export const RESCUE_CAPABLE_ROLES: readonly Role[] = ['rescue', 'officer', 'admin'];
export const ADMIN_ROLES: readonly Role[] = ['admin'];

export function isStaff(u: Pick<UserRecord, 'role'> | null | undefined): boolean {
  return !!u && STAFF_ROLES.includes(normalizeRole(u.role));
}

export function isRescueCapable(u: Pick<UserRecord, 'role'> | null | undefined): boolean {
  return !!u && RESCUE_CAPABLE_ROLES.includes(normalizeRole(u.role));
}

export function isAdminRole(u: Pick<UserRecord, 'role'> | null | undefined): boolean {
  return !!u && ADMIN_ROLES.includes(normalizeRole(u.role));
}

/** Cán bộ gắn phường chỉ thao tác trong wardCode của mình; Cán bộ toàn TP (`wardCode = null`), Đội cứu hộ & Admin cơ động liên phường. */
export function inScope(u: Pick<UserRecord, 'role' | 'wardCode'>, wardCode: string): boolean {
  const role = normalizeRole(u.role);
  if (role === 'admin' || role === 'rescue') return true;
  if (role === 'officer') return !u.wardCode || u.wardCode === wardCode;
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
  return false;
}

export interface PhotoInput {
  dataUrl?: string;
  buffer?: Buffer;
  aiBuffer?: Buffer;
  dHash: string;
}

const DATA_URL_RE = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/;
export const MAX_PHOTO_BASE64 = 1_800_000;

export function parsePhotoDataUrl(dataUrl: string): { mime: string; base64: string; buffer: Buffer } {
  const m = DATA_URL_RE.exec(dataUrl);
  if (!m) throw badRequest('Ảnh phải là JPEG/PNG/WebP dạng data URL base64.', 'invalid_photo');
  if (m[2].length > MAX_PHOTO_BASE64) throw badRequest('Ảnh quá lớn (tối đa ~1.3MB sau nén).', 'photo_too_large');
  return { mime: m[1], base64: m[2], buffer: Buffer.from(m[2], 'base64') };
}

export async function resolvePhotoInputFromRequest(
  req: Request,
  bodyPhoto?: { dataUrl?: string; dHash?: string },
  fallbackDHash?: string,
): Promise<PhotoInput> {
  const up = req.uploadedImages;
  if (up?.displayBuffer) {
    const candidateHash = bodyPhoto?.dHash ?? fallbackDHash;
    const dHash =
      candidateHash && isValidHash(candidateHash)
        ? candidateHash.toLowerCase()
        : await mediaService.computeDHashFromBuffer(up.aiBuffer ?? up.displayBuffer);
    return {
      buffer: up.displayBuffer,
      aiBuffer: up.aiBuffer ?? up.displayBuffer,
      dHash,
    };
  }
  if (bodyPhoto?.dataUrl) {
    const parsed = parsePhotoDataUrl(bodyPhoto.dataUrl);
    const candidateHash = bodyPhoto.dHash ?? fallbackDHash;
    const dHash =
      candidateHash && isValidHash(candidateHash)
        ? candidateHash.toLowerCase()
        : await mediaService.computeDHashFromBuffer(parsed.buffer);
    return {
      dataUrl: bodyPhoto.dataUrl,
      buffer: parsed.buffer,
      dHash,
    };
  }
  throw badRequest('Thiếu tệp ảnh hiện trường (multipart binary hoặc dataUrl).', 'invalid_photo');
}

export async function loadStoredPhotoForVerification(
  photo: Photo,
): Promise<{ isSvg: boolean; mime: string; base64: string }> {
  if (photo.url.startsWith('data:image/svg')) {
    return { isSvg: true, mime: 'image/svg+xml', base64: '' };
  }
  const mediaId =
    photo.mediaId ??
    (photo.url.startsWith('/api/media/') ? photo.url.slice('/api/media/'.length).split('?')[0] : null);
  if (mediaId) {
    const bin = await mediaService.getMediaBinary(mediaId, 'display');
    if (bin) {
      return { isSvg: false, mime: bin.mimeType, base64: bin.buffer.toString('base64') };
    }
  }
  const parsed = parsePhotoDataUrl(photo.url);
  return { isSvg: false, mime: parsed.mime, base64: parsed.base64 };
}
