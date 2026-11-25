import {
  AUTHENTICITY_MIN, DHASH_ANGLE_MIN, DHASH_DUPLICATE_MAX, GPS_QUARANTINE_M, TRUST_SUPERVISED_BELOW,
} from '../shared/constants';
import { hammingDistance } from '../shared/dhash';
import type { Category, QuarantineReason } from '../shared/types';

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
  isAuthenticOverride?: boolean;
  authenticityReason?: string;
  photoHash: string;
  recent: KnownReport[];
  nearby: KnownReport[];
  gpsDistanceM: number | null;
  gpsExempt: boolean;
  authenticityThreshold?: number;
  duplicateThreshold?: number;
  cropDuplicate?: {
    matchedIncidentId: string;
    matchType: string;
    inlierCount: number;
    similarityScore: number;
  } | null;
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
 * Thứ tự ưu tiên: trùng/cắt ảnh (dHash + ORB/RANSAC) → ảnh giả/screenshot → GPS bất thường → tài khoản bị giám sát → gộp đa góc → chấp nhận.
 */
export function decideTriage(f: TriageFacts): TriageDecision {
  const dupMax = f.duplicateThreshold ?? DHASH_DUPLICATE_MAX;
  const authMin = f.authenticityThreshold ?? AUTHENTICITY_MIN;

  if (f.cropDuplicate) {
    return {
      action: 'quarantine',
      reason: 'duplicate_image',
      relatedReportId: f.cropDuplicate.matchedIncidentId,
      needsFieldVerification: false,
      detail: `Phát hiện ảnh cắt/trùng lặp (${f.cropDuplicate.matchType}, độ khớp ${f.cropDuplicate.similarityScore}%, ${f.cropDuplicate.inlierCount} điểm đặc trưng ORB+RANSAC) với hồ sơ ${f.cropDuplicate.matchedIncidentId}.`,
    };
  }

  for (const r of f.recent) {
    const d = minDistance(f.photoHash, r.hashes);
    if (d <= dupMax) {
      return {
        action: 'quarantine',
        reason: 'duplicate_image',
        relatedReportId: r.id,
        needsFieldVerification: false,
        detail: `Ảnh trùng khớp (dHash distance = ${d} ≤ ${dupMax}) với hồ sơ đã gửi trong 24 giờ.`,
      };
    }
  }

  if (f.isAuthenticOverride === false || f.authenticityScore < authMin) {
    return {
      action: 'quarantine',
      reason: 'low_authenticity',
      relatedReportId: null,
      needsFieldVerification: true,
      detail:
        f.authenticityReason && f.isAuthenticOverride === false
          ? `${f.authenticityReason} (authenticityScore = ${f.authenticityScore}).`
          : `AI nghi ảnh không phải hiện trường thật (authenticityScore = ${f.authenticityScore} < ${authMin}).`,
    };
  }

  if (!f.gpsExempt && f.gpsDistanceM !== null && f.gpsDistanceM > GPS_QUARANTINE_M) {
    return {
      action: 'quarantine',
      reason: 'gps_anomaly',
      relatedReportId: null,
      needsFieldVerification: true,
      detail: `GPS thiết bị lệch ${(f.gpsDistanceM / 1000).toFixed(1)} km so với vị trí ghim (> ${GPS_QUARANTINE_M / 1000} km).`,
    };
  }

  if (f.trustSupervised) {
    return {
      action: 'quarantine',
      reason: 'low_trust',
      relatedReportId: null,
      needsFieldVerification: false,
      detail: `Tài khoản đang ở chế độ Giám sát (trustScore < ${TRUST_SUPERVISED_BELOW}): đơn mới cần kiểm duyệt trước.`,
    };
  }

  let ambiguous: string | null = null;
  for (const r of f.nearby) {
    if (r.status === 'quarantined' || r.status === 'rejected') continue;
    const d = minDistance(f.photoHash, r.hashes);
    const otherPerson = !r.contributorIds.includes(f.userId);
    if (otherPerson && d > DHASH_ANGLE_MIN) return { action: 'merge', motherId: r.id, minDistance: d };
    if (d > dupMax && d <= DHASH_ANGLE_MIN) ambiguous = r.id;
  }
  return { action: 'accept', possibleDuplicateOf: ambiguous };
}
