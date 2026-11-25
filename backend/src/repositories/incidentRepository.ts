import { Types } from 'mongoose';
import { withMongoTransaction } from '../config/database';
import {
  AiCache,
  AI_CACHE_TTL_SECONDS,
  AuditLog,
  computePriorityScore,
  Incident,
  isWithinDongNaiBounds,
  normalizeSparseString,
  Ward,
  type AiCacheKind,
  type IIncident,
  type IncidentCategory,
  type IncidentMediaItem,
  type IncidentStatus,
  type IWard,
} from '../models';

export type LeanIncident = IIncident & { _id: Types.ObjectId };
export type LeanWard = IWard & { _id: Types.ObjectId };

export interface CreateIncidentInput {
  incidentCode?: string;
  syncId?: string;
  clientOfflineId?: string;
  reporterId: Types.ObjectId | string;
  wardCode?: string;
  category: IncidentCategory;
  customCategoryLabel?: string | null;
  title: string;
  description: string;
  district?: string;
  location: {
    type?: 'Point';
    coordinates: [number, number];
    addressText?: string;
    ward?: string;
    district?: string;
  };
  media?: IncidentMediaItem[];
  imageFingerprints?: IIncident['imageFingerprints'];
  aiAnalysis?: Partial<IIncident['aiAnalysis']>;
  aiEvaluation?: Partial<IIncident['aiEvaluation']>;
  priorityScore?: number;
  status?: IncidentStatus;
  timeline?: IIncident['timeline'];
  clientCreatedAt?: Date;
}

export interface UpsertIncidentResult {
  /** true nếu tạo bản ghi mới, false nếu đã tồn tại cùng syncId (Idempotent Write) */
  created: boolean;
  incident: LeanIncident;
}

export interface SpatialRadiusQuery {
  lng: number;
  lat: number;
  radiusMeters: number;
  category?: IncidentCategory;
  statuses?: IncidentStatus[];
  excludeDuplicateChildren?: boolean;
  limit?: number;
}

export interface SpatialBoxQuery {
  minLng: number;
  minLat: number;
  maxLng: number;
  maxLat: number;
  wardCode?: string;
  status?: IncidentStatus;
  category?: IncidentCategory;
  limit?: number;
}

export interface IocDashboardQuery {
  wardCode?: string;
  status?: IncidentStatus;
  category?: IncidentCategory;
  reporterId?: Types.ObjectId | string;
  cursorDate?: Date;
  sortByPriority?: boolean;
  limit?: number;
}

export interface IocAggregatedStats {
  total: number;
  byStatus: Record<string, number>;
  byCategory: Record<string, number>;
  highPriorityCount: number;
  avgAuthenticityScore: number;
  avgResolutionScore: number | null;
}

function isDuplicateKeyError(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && 'code' in err && (err as { code?: number }).code === 11000);
}

/**
 * Tầng Repository chuẩn Production cho collection `incidents`, `wards`, `ai_cache`, `audit_logs`:
 * - Mọi truy vấn đọc đều sử dụng `.lean()` để giảm 3x–5x chi phí cấp phát bộ nhớ và hydration của Mongoose.
 * - Mọi thao tác ghi đều `await` đầy đủ và hỗ trợ Idempotent Write qua `syncId` (Unique Sparse Index).
 * - Hỗ trợ Multi-Document Transaction (ACID) khi gộp sự cố trùng lặp kèm ghi nhật ký vận hành.
 */
export class IncidentRepository {
  /**
   * Ghi sự cố Idempotent theo `syncId` (hoặc `clientOfflineId`):
   * Dù Client Local-First Outbox gửi trùng request nhiều lần khi mạng 4G chập chờn,
   * MongoDB chỉ tạo đúng 1 bản ghi duy nhất và trả lại bản ghi đó mà không sinh lỗi.
   */
  async upsertBySyncId(input: CreateIncidentInput): Promise<UpsertIncidentResult> {
    const syncKey = normalizeSparseString(input.syncId ?? input.clientOfflineId);
    const reporterObjectId =
      typeof input.reporterId === 'string' ? new Types.ObjectId(input.reporterId) : input.reporterId;

    if (syncKey) {
      const existing = (await Incident.findOne({
        $or: [{ syncId: syncKey }, { clientOfflineId: syncKey }],
      }).lean()) as LeanIncident | null;
      if (existing) {
        return { created: false, incident: existing };
      }
    }

    const candidate = new Incident({
      ...input,
      reporterId: reporterObjectId,
      syncId: syncKey,
      clientOfflineId: syncKey,
      location: {
        type: 'Point',
        coordinates: input.location.coordinates,
        addressText: input.location.addressText ?? '',
        ward: input.location.ward ?? '',
        district: input.location.district ?? input.district ?? 'TP. Đồng Nai',
      },
    });
    await candidate.validate();

    try {
      const saved = await candidate.save();
      return { created: true, incident: saved.toObject() as LeanIncident };
    } catch (err) {
      if (syncKey && isDuplicateKeyError(err)) {
        const winner = (await Incident.findOne({
          $or: [{ syncId: syncKey }, { clientOfflineId: syncKey }],
        }).lean()) as LeanIncident | null;
        if (winner) {
          return { created: false, incident: winner };
        }
      }
      throw err;
    }
  }

  /** Truy vấn không gian bán kính bằng `$nearSphere` trên `2dsphere` index (mục tiêu <10ms). */
  async findNearbySphere(q: SpatialRadiusQuery): Promise<LeanIncident[]> {
    if (!isWithinDongNaiBounds(q.lng, q.lat)) {
      throw new Error(`Tọa độ [${q.lng}, ${q.lat}] nằm ngoài khung bao địa lý TP. Đồng Nai.`);
    }
    const filter: Record<string, unknown> = {
      location: {
        $nearSphere: {
          $geometry: { type: 'Point', coordinates: [q.lng, q.lat] },
          $maxDistance: Math.max(1, q.radiusMeters),
        },
      },
    };
    if (q.category) filter.category = q.category;
    if (q.statuses?.length) filter.status = { $in: q.statuses };
    if (q.excludeDuplicateChildren !== false) {
      filter['duplicateControl.isDuplicate'] = false;
    }

    const limit = Math.min(Math.max(1, q.limit ?? 50), 500);
    return (await Incident.find(filter).limit(limit).lean()) as LeanIncident[];
  }

  /** Truy vấn khung nhìn bản đồ bằng `$geoWithin` (`$box`) trên `2dsphere` index. */
  async findWithinBox(q: SpatialBoxQuery): Promise<LeanIncident[]> {
    const filter: Record<string, unknown> = {
      location: {
        $geoWithin: {
          $box: [
            [q.minLng, q.minLat],
            [q.maxLng, q.maxLat],
          ],
        },
      },
    };
    if (q.wardCode) filter.wardCode = q.wardCode.toUpperCase();
    if (q.status) filter.status = q.status;
    if (q.category) filter.category = q.category;

    const limit = Math.min(Math.max(1, q.limit ?? 1000), 5000);
    return (await Incident.find(filter).sort({ createdAt: -1 }).limit(limit).lean()) as LeanIncident[];
  }

  /**
   * Truy vấn danh sách cho IOC Dashboard — khớp chính xác với 3 Compound Indexes:
   * - `{ wardCode: 1, status: 1, createdAt: -1 }`
   * - `{ category: 1, priorityScore: -1, createdAt: -1 }`
   * - `{ reporterId: 1, createdAt: -1 }`
   */
  async listForIocDashboard(q: IocDashboardQuery = {}): Promise<LeanIncident[]> {
    const filter: Record<string, unknown> = {};
    if (q.wardCode) filter.wardCode = q.wardCode.toUpperCase();
    if (q.status) filter.status = q.status;
    if (q.category) filter.category = q.category;
    if (q.reporterId) {
      filter.reporterId = typeof q.reporterId === 'string' ? new Types.ObjectId(q.reporterId) : q.reporterId;
    }
    if (q.cursorDate) {
      filter.createdAt = { $lt: q.cursorDate };
    }

    const sortSpec: Record<string, 1 | -1> =
      q.sortByPriority || (q.category && !q.wardCode)
        ? { priorityScore: -1, createdAt: -1 }
        : { createdAt: -1 };
    const limit = Math.min(Math.max(1, q.limit ?? 50), 500);

    return (await Incident.find(filter).sort(sortSpec).limit(limit).lean()) as LeanIncident[];
  }

  /** Gộp sự cố trùng lặp vào hồ sơ gốc kèm ghi AuditLog trong cùng một MongoDB Transaction. */
  async mergeIntoMasterTransactional(params: {
    masterId: Types.ObjectId | string;
    reporterId: Types.ObjectId | string;
    syncId?: string;
    newMedia?: IncidentMediaItem;
    sceneMatchScore?: number;
    actorRole?: string;
  }): Promise<LeanIncident> {
    return withMongoTransaction(async (session) => {
      const masterDoc = await Incident.findById(params.masterId).session(session);
      if (!masterDoc) {
        throw new Error(`Không tìm thấy sự cố gốc (${String(params.masterId)}) để gộp.`);
      }

      const nextDuplicates = (masterDoc.duplicateControl?.duplicateCount ?? 0) + 1;
      masterDoc.duplicateControl.duplicateCount = nextDuplicates;
      masterDoc.priorityScore = Math.max(
        masterDoc.priorityScore,
        computePriorityScore({
          severityLevel: masterDoc.aiAnalysis?.severityLevel ?? 3,
          duplicateCount: nextDuplicates,
          reporterTrustScore: 100,
        }),
      );

      if (params.newMedia && masterDoc.media.length < 10) {
        masterDoc.media.push(params.newMedia);
      }
      if (params.sceneMatchScore !== undefined && masterDoc.aiEvaluation) {
        masterDoc.aiEvaluation.sceneMatchScore = params.sceneMatchScore;
      }
      if (masterDoc.timeline.length < 50) {
        masterDoc.timeline.push({
          status: masterDoc.status,
          note: `Gộp phản ánh cùng hiện trường (tổng ${nextDuplicates} tin gộp, syncId=${params.syncId ?? 'n/a'}).`,
          updatedBy: typeof params.reporterId === 'string' ? new Types.ObjectId(params.reporterId) : params.reporterId,
          proofImageUrl: null,
          timestamp: new Date(),
        });
      }

      await masterDoc.save({ session: session ?? undefined });
      await AuditLog.create(
        [
          {
            actorId: String(params.reporterId),
            actorRole: params.actorRole ?? 'citizen',
            action: 'incident.merge_duplicate',
            targetCollection: 'incidents',
            targetId: String(masterDoc._id),
            wardCode: masterDoc.wardCode,
            metadata: { syncId: params.syncId ?? null, duplicateCount: nextDuplicates },
          },
        ],
        session ? { session } : undefined,
      );

      return masterDoc.toObject() as LeanIncident;
    });
  }

  /** Thống kê cực nhanh cho IOC Dashboard bằng 1 pipeline `$facet` duy nhất. */
  async getIocStats(wardCode?: string): Promise<IocAggregatedStats> {
    const matchStage = wardCode ? { wardCode: wardCode.toUpperCase() } : {};
    const [agg] = await Incident.aggregate<{
      byStatus: Array<{ _id: string; count: number }>;
      byCategory: Array<{ _id: string; count: number }>;
      summary: Array<{
        total: number;
        highPriorityCount: number;
        avgAuthenticityScore: number | null;
        avgResolutionScore: number | null;
      }>;
    }>([
      { $match: matchStage },
      {
        $facet: {
          byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
          byCategory: [{ $group: { _id: '$category', count: { $sum: 1 } } }],
          summary: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                highPriorityCount: { $sum: { $cond: [{ $gte: ['$priorityScore', 70] }, 1, 0] } },
                avgAuthenticityScore: { $avg: '$aiEvaluation.authenticityScore' },
                avgResolutionScore: { $avg: '$aiEvaluation.resolutionScore' },
              },
            },
          ],
        },
      },
    ]);

    const s = agg?.summary?.[0];
    return {
      total: s?.total ?? 0,
      byStatus: Object.fromEntries((agg?.byStatus ?? []).map((r) => [r._id, r.count])),
      byCategory: Object.fromEntries((agg?.byCategory ?? []).map((r) => [r._id, r.count])),
      highPriorityCount: s?.highPriorityCount ?? 0,
      avgAuthenticityScore: Math.round((s?.avgAuthenticityScore ?? 100) * 10) / 10,
      avgResolutionScore:
        s?.avgResolutionScore === null || s?.avgResolutionScore === undefined
          ? null
          : Math.round(s.avgResolutionScore * 10) / 10,
    };
  }

  /** Đọc danh sách 95 Phường/Xã từ MongoDB với `.lean()`. */
  async listWards(kindNq1662?: 'Phường' | 'Xã'): Promise<LeanWard[]> {
    const filter = kindNq1662 ? { kindNq1662 } : {};
    return (await Ward.find(filter).sort({ wardCode: 1 }).lean()) as LeanWard[];
  }

  /** Đọc/ghi cache đánh giá AI có TTL tự dọn rác sau 7 ngày. */
  async getAiCache<T = Record<string, unknown>>(cacheKey: string): Promise<T | null> {
    const doc = await AiCache.findOneAndUpdate(
      { cacheKey, expiresAt: { $gt: new Date() } },
      { $inc: { hitCount: 1 } },
      { new: true },
    ).lean();
    return doc ? (doc.payload as T) : null;
  }

  async setAiCache(params: {
    cacheKey: string;
    kind: AiCacheKind;
    pHash?: string | null;
    modelName?: string;
    payload: Record<string, unknown>;
    ttlSeconds?: number;
  }): Promise<void> {
    const ttl = params.ttlSeconds ?? AI_CACHE_TTL_SECONDS;
    const expiresAt = new Date(Date.now() + ttl * 1000);
    await AiCache.findOneAndUpdate(
      { cacheKey: params.cacheKey },
      {
        $set: {
          kind: params.kind,
          pHash: params.pHash ?? null,
          modelName: params.modelName ?? 'gemini-3.8-flash',
          payload: params.payload,
          expiresAt,
        },
        $setOnInsert: { hitCount: 0 },
      },
      { upsert: true, new: true },
    );
  }
}

export const incidentRepository = new IncidentRepository();
