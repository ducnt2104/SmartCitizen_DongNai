import {
  AUTHENTICITY_MIN, DHASH_ANGLE_MIN, DHASH_DUPLICATE_MAX, GPS_QUARANTINE_M,
} from '../shared/constants';
import { hammingDistance } from '../shared/dhash';
import type { Category, QuarantineReason } from '../shared/types';

/** Dữ kiện tối thiểu của một hồ sơ đã có để so sánh. */
export interface KnownReport {
  id: string;
  category: Category;
  status: string;
  hashes: string[];
  contributorIds: string[];
}

export interface TriageFacts {
  userId: string;
  trustSupervised: boolean;
  authenticityScore: number;
  photoHash: string;
  /** Các hồ sơ trong 24h gần nhất (mọi địa điểm) */
  recent: KnownReport[];
  /** Hồ sơ cùng danh mục, ≤ 50m, chưa xử lý xong */
  nearby: KnownReport[];
  /** Khoảng cách GPS thiết bị ↔ vị trí ghim (m); null nếu không có GPS */
  gpsDistanceM: number | null;
  gpsExempt: boolean;
}

export type TriageDecision =
  | { action: 'quarantine'; reason: QuarantineReason; detail: string; relatedReportId: string | null; needsFieldVerification: boolean }
  | { action: 'merge'; motherId: string; minDistance: number }
  | { action: 'accept'; possibleDuplicateOf: string | null };

function minDistance(hash: string, hashes: string[]): number {
  return hashes.reduce((m, h) => Math.min(m, hammingDistance(hash, h)), 64);
}

/**
 * Lớp 4–6: quyết định triage thuần túy (không I/O) để dễ kiểm thử.
 * Thứ tự ưu tiên: trùng ảnh → ảnh giả → GPS bất thường → tài khoản bị giám sát → gộp đa góc → chấp nhận.
 */
export function decideTriage(f: TriageFacts): TriageDecision {
  for (const r of f.recent) {
    const d = minDistance(f.photoHash, r.hashes);
    if (d <= DHASH_DUPLICATE_MAX) {
      return {
        action: 'quarantine', reason: 'duplicate_image', relatedReportId: r.id, needsFieldVerification: false,
        detail: `Ảnh trùng khớp (dHash distance = ${d} ≤ ${DHASH_DUPLICATE_MAX}) với hồ sơ đã gửi trong 24 giờ.`,
      };
    }
  }
  if (f.authenticityScore < AUTHENTICITY_MIN) {
    return {
      action: 'quarantine', reason: 'low_authenticity', relatedReportId: null, needsFieldVerification: true,
      detail: `AI nghi ảnh không phải hiện trường thật (authenticityScore = ${f.authenticityScore} < ${AUTHENTICITY_MIN}).`,
    };
  }
  if (!f.gpsExempt && f.gpsDistanceM !== null && f.gpsDistanceM > GPS_QUARANTINE_M) {
    return {
      action: 'quarantine', reason: 'gps_anomaly', relatedReportId: null, needsFieldVerification: true,
      detail: `GPS thiết bị lệch ${(f.gpsDistanceM / 1000).toFixed(1)} km so với vị trí ghim (> ${GPS_QUARANTINE_M / 1000} km).`,
    };
  }
  if (f.trustSupervised) {
    return {
      action: 'quarantine', reason: 'low_trust', relatedReportId: null, needsFieldVerification: false,
      detail: 'Tài khoản đang ở chế độ Giám sát (trustScore < 30): đơn mới cần kiểm duyệt trước.',
    };
  }
  let ambiguous: string | null = null;
  for (const r of f.nearby) {
    if (r.status === 'quarantined' || r.status === 'rejected') continue;
    const d = minDistance(f.photoHash, r.hashes);
    const otherPerson = !r.contributorIds.includes(f.userId);
    if (otherPerson && d > DHASH_ANGLE_MIN) return { action: 'merge', motherId: r.id, minDistance: d };
    if (d > DHASH_DUPLICATE_MAX && d <= DHASH_ANGLE_MIN) ambiguous = r.id;
  }
  return { action: 'accept', possibleDuplicateOf: ambiguous };
}
