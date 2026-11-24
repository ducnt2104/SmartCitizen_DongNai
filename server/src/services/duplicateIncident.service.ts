import type { Types } from 'mongoose';
import { hammingDistance } from '../../../shared/dhash';
import { haversineMeters } from '../../../shared/geo';
import {
  computePriorityScore,
  Incident,
  isWithinDongNaiBounds,
  type IIncident,
  type IncidentCategory,
  type IncidentDocument,
  type IncidentMediaItem,
} from '../models';

export const DEFAULT_DUPLICATE_RADIUS_M = 50;
export const MAX_DUPLICATE_RADIUS_M = 200;
export const DEFAULT_DUPLICATE_WINDOW_HOURS = 24;
/** Ngưỡng Hamming distance trên 64-bit dHash: <= 8 bit khác biệt được xem là ảnh tương đồng/trùng lặp */
export const DEFAULT_DHASH_SIMILAR_MAX = 8;

export interface FindDuplicateOptions {
  /** Bán kính quét không gian (mét), mặc định 50m (cho phép cấu hình 50m–200m) */
  radiusMeters?: number;
  /** Cửa sổ thời gian quét trùng (giờ), mặc định 24h */
  windowHours?: number;
  /** Ngưỡng khoảng cách Hamming cho dHash 64-bit, mặc định 8 */
  dHashThreshold?: number;
  /** Bỏ qua một incidentId (ví dụ khi đang kiểm tra lại chính hồ sơ đó) */
  excludeIncidentId?: Types.ObjectId | string;
}

export type DuplicateMatchReason = 'dhash_and_geo' | 'same_category_geo';

export interface DuplicateCandidateLike {
  _id: Types.ObjectId | string;
  incidentCode: string;
  category: IncidentCategory;
  status: string;
  location: { coordinates: [number, number] };
  media: Array<{ dHash: string }>;
  duplicateControl: { isDuplicate: boolean; duplicateCount: number };
  aiAnalysis?: { severityLevel?: number };
  createdAt?: Date;
}

export interface DuplicateMatchResult<T extends DuplicateCandidateLike = IncidentDocument> {
  isDuplicate: true;
  reason: DuplicateMatchReason;
  masterIncident: T;
  distanceMeters: number;
  minHammingDistance: number | null;
}

/**
 * Thuật toán thuần túy chọn phản ánh gốc trùng khớp tốt nhất từ danh sách ứng viên đã lọc theo không gian ($nearSphere).
 * Thứ tự ưu tiên:
 *  1) Trùng dHash (Hamming <= dHashThreshold) trong bán kính quét → ưu tiên khoảng cách Hamming nhỏ nhất, rồi gần nhất.
 *  2) Cùng danh mục sự cố (category) trong bán kính quét & 24h → ưu tiên gần nhất.
 */
export function selectBestDuplicateCandidate<T extends DuplicateCandidateLike>(
  candidates: readonly T[],
  coordinates: [number, number],
  category: IncidentCategory,
  dHash: string | null | undefined,
  dHashThreshold = DEFAULT_DHASH_SIMILAR_MAX,
): DuplicateMatchResult<T> | null {
  const [lng, lat] = coordinates;
  const normalizedHash = dHash?.trim().toLowerCase() ?? '';
  const hasHash = /^[0-9a-f]{16}$/.test(normalizedHash);

  let bestByHash: DuplicateMatchResult<T> | null = null;
  let bestByCategory: DuplicateMatchResult<T> | null = null;

  for (const candidate of candidates) {
    if (candidate.duplicateControl?.isDuplicate) continue;
    if (candidate.status === 'resolved' || candidate.status === 'rejected_spam') continue;

    const [cLng, cLat] = candidate.location.coordinates;
    const distanceMeters = Math.round(haversineMeters(lat, lng, cLat, cLng) * 10) / 10;

    let minHamming: number | null = null;
    if (hasHash && candidate.media?.length) {
      minHamming = candidate.media.reduce(
        (min, item) => Math.min(min, hammingDistance(normalizedHash, item.dHash)),
        64,
      );
    }

    if (minHamming !== null && minHamming <= dHashThreshold) {
      if (
        !bestByHash ||
        minHamming < (bestByHash.minHammingDistance ?? 64) ||
        (minHamming === bestByHash.minHammingDistance && distanceMeters < bestByHash.distanceMeters)
      ) {
        bestByHash = {
          isDuplicate: true,
          reason: 'dhash_and_geo',
          masterIncident: candidate,
          distanceMeters,
          minHammingDistance: minHamming,
        };
      }
    }

    if (candidate.category === category) {
      if (!bestByCategory || distanceMeters < bestByCategory.distanceMeters) {
        bestByCategory = {
          isDuplicate: true,
          reason: 'same_category_geo',
          masterIncident: candidate,
          distanceMeters,
          minHammingDistance: minHamming,
        };
      }
    }
  }

  return bestByHash ?? bestByCategory;
}

/**
 * Tìm phản ánh trùng lặp trong bán kính 50m–200m bằng truy vấn GeoJSON `$nearSphere` trên 2dsphere index
 * kết hợp tính khoảng cách Hamming trên `dHash` 64-bit và lọc cửa sổ 24 giờ.
 *
 * @param coordinates [longitude, latitude] — Kinh độ trước, Vĩ độ sau (chuẩn GeoJSON MongoDB)
 * @param category Danh mục sự cố (`giao_thong`, `moi_truong`, ...)
 * @param dHash Chuỗi 64-bit dHash (16 ký tự hex) do Web Worker tính từ ảnh hiện trường
 */
export async function findDuplicateIncident(
  coordinates: [number, number],
  category: IncidentCategory,
  dHash?: string | null,
  options: FindDuplicateOptions = {},
): Promise<DuplicateMatchResult<IncidentDocument> | null> {
  const [lng, lat] = coordinates;
  if (!isWithinDongNaiBounds(lng, lat)) {
    throw new Error(`Tọa độ [${lng}, ${lat}] nằm ngoài khung bao địa lý tỉnh Đồng Nai.`);
  }

  const radiusMeters = Math.max(
    10,
    Math.min(MAX_DUPLICATE_RADIUS_M, options.radiusMeters ?? DEFAULT_DUPLICATE_RADIUS_M),
  );
  const windowHours = Math.max(1, options.windowHours ?? DEFAULT_DUPLICATE_WINDOW_HOURS);
  const dHashThreshold = options.dHashThreshold ?? DEFAULT_DHASH_SIMILAR_MAX;
  const windowStart = new Date(Date.now() - windowHours * 3600 * 1000);

  const query: Record<string, unknown> = {
    'duplicateControl.isDuplicate': false,
    status: { $nin: ['resolved', 'rejected_spam'] },
    createdAt: { $gte: windowStart },
    location: {
      $nearSphere: {
        $geometry: {
          type: 'Point',
          coordinates: [lng, lat],
        },
        $maxDistance: radiusMeters,
      },
    },
  };

  if (options.excludeIncidentId) {
    query._id = { $ne: options.excludeIncidentId };
  }

  const candidates = await Incident.find(query).limit(30).exec();
  return selectBestDuplicateCandidate(candidates, coordinates, category, dHash, dHashThreshold);
}

/**
 * Tự động phát hiện và gộp phản ánh trùng lặp vào phản ánh gốc (masterIncident):
 * - Tăng `duplicateControl.duplicateCount` của tin gốc
 * - Bổ sung ảnh góc chụp mới (nếu khác góc dHash > 5 và tổng media < 10)
 * - Tính lại `priorityScore` của tin gốc theo công thức mới (AI severity + duplicateCount + trustScore)
 * - Trả về payload đã gắn `duplicateControl.isDuplicate = true` và `masterIncidentId` cho tin trùng
 */
export async function detectAndMergeDuplicateIncident(params: {
  coordinates: [number, number];
  category: IncidentCategory;
  media?: IncidentMediaItem[];
  reporterTrustScore?: number;
  updatedBy?: Types.ObjectId | null;
  options?: FindDuplicateOptions;
}): Promise<{
  match: DuplicateMatchResult<IncidentDocument> | null;
  duplicateControl: IIncident['duplicateControl'];
}> {
  const primaryHash = params.media?.[0]?.dHash ?? null;
  const match = await findDuplicateIncident(params.coordinates, params.category, primaryHash, params.options);

  if (!match) {
    return {
      match: null,
      duplicateControl: {
        isDuplicate: false,
        masterIncidentId: null,
        duplicateCount: 0,
      },
    };
  }

  const master = match.masterIncident;
  const nextDuplicateCount = (master.duplicateControl?.duplicateCount ?? 0) + 1;
  const nextPriority = computePriorityScore({
    severityLevel: master.aiAnalysis?.severityLevel ?? 3,
    duplicateCount: nextDuplicateCount,
    reporterTrustScore: params.reporterTrustScore ?? 100,
  });

  master.duplicateControl.duplicateCount = nextDuplicateCount;
  master.priorityScore = Math.max(master.priorityScore, nextPriority);

  // Nếu ảnh gửi kèm là góc chụp khác (dHash distance > 5) thì gắn bổ sung vào hồ sơ gốc (giới hạn <= 10 ảnh)
  const incomingPhoto = params.media?.[0];
  if (incomingPhoto && master.media.length < 10 && (match.minHammingDistance === null || match.minHammingDistance > 5)) {
    master.media.push(incomingPhoto);
  }

  const reasonNote =
    match.reason === 'dhash_and_geo'
      ? `Tự động gộp phản ánh trùng ảnh (dHash distance = ${match.minHammingDistance}, cách ${match.distanceMeters}m) — tổng ${nextDuplicateCount} tin gộp.`
      : `Tự động gộp phản ánh cùng loại trong bán kính ${match.distanceMeters}m — tổng ${nextDuplicateCount} tin gộp, nâng ưu tiên lên ${master.priorityScore}.`;

  if (master.timeline.length < 50) {
    master.timeline.push({
      status: master.status,
      note: reasonNote,
      updatedBy: params.updatedBy ?? null,
      proofImageUrl: null,
      timestamp: new Date(),
    });
  }

  await master.save();

  return {
    match,
    duplicateControl: {
      isDuplicate: true,
      masterIncidentId: master._id,
      duplicateCount: 0,
    },
  };
}
