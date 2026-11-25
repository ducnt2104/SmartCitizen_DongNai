import type { AuditEntry, Report, Role } from '../shared/types';
import { connectDatabase, disconnectDatabase, getDatabaseHealth } from '../config/database';
import {
  AuditLogModel,
  computePriorityScore,
  normalizeSparseString,
  OtpModel,
  ReportModel,
  SessionModel,
  UserModel,
} from '../models';
import type {
  AuditRepository,
  NearbyQuery,
  OtpRecord,
  OtpRepository,
  ReportQuery,
  ReportRepository,
  Repositories,
  SessionRecord,
  SessionRepository,
  UserRecord,
  UserRepository,
} from './types';

type Doc = Record<string, unknown>;

function strip<T>(doc: Doc | null): T | null {
  if (!doc) return null;
  const { _id, expiresAtDate, ...rest } = doc;
  void _id;
  void expiresAtDate;
  return rest as T;
}

function reportFromDoc(doc: Doc | null): Report | null {
  if (!doc) return null;
  const { location, imageHash, syncId, priorityScore, customCategoryLabel, ...rest } = doc;
  void location;
  void imageHash;
  void syncId;
  void priorityScore;
  void customCategoryLabel;
  return strip<Report>(rest);
}

function reportToDoc(r: Report): Doc {
  const syncId = normalizeSparseString(r.id.startsWith('rp_') ? r.id.slice(3) : r.id);
  const priorityScore = computePriorityScore({
    severityLevel: r.severity,
    duplicateCount: Math.max(0, (r.clusterCount ?? 1) - 1),
    reporterTrustScore: 100,
  });
  return {
    ...r,
    ...(syncId ? { syncId } : {}),
    priorityScore,
    imageHash: r.photos[0]?.dHash ?? '',
    location: { type: 'Point', coordinates: [r.lng, r.lat] },
  };
}

class MongoReportRepo implements ReportRepository {
  async list(q: ReportQuery = {}): Promise<Report[]> {
    const filter: Record<string, unknown> = {};
    if (q.wardCodes?.length) {
      filter.wardCode = q.wardCodes.length === 1 ? q.wardCodes[0] : { $in: q.wardCodes };
    }
    if (q.statuses?.length) {
      filter.status = q.statuses.length === 1 ? q.statuses[0] : { $in: q.statuses };
    }
    if (q.category) filter.category = String(q.category);
    if (q.reporterId) {
      filter.$or = [{ reporterId: String(q.reporterId) }, { 'contributors.userId': String(q.reporterId) }];
    }
    if (q.bbox) {
      // Tận dụng GeoJSON 2dsphere index trên location thay vì quét tuần tự lat/lng rời rạc
      filter.location = {
        $geoWithin: {
          $box: [
            [q.bbox.minLng, q.bbox.minLat],
            [q.bbox.maxLng, q.bbox.maxLat],
          ],
        },
      };
    }
    if (q.cursor) {
      filter.createdAt = { $lt: String(q.cursor) };
    }

    let cursor = ReportModel.find(filter).sort({ createdAt: -1 });
    if (q.limit) cursor = cursor.limit(q.limit);
    const docs = (await cursor.lean()) as Doc[];
    return docs.map((d) => reportFromDoc(d)!);
  }

  async get(id: string): Promise<Report | null> {
    return reportFromDoc((await ReportModel.findOne({ id: String(id) }).lean()) as Doc | null);
  }

  async getByCode(code: string): Promise<Report | null> {
    const escaped = String(code).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return reportFromDoc((await ReportModel.findOne({ code: new RegExp(`^${escaped}$`, 'i') }).lean()) as Doc | null);
  }

  /** Ghi Idempotent chống trùng lặp khi Client Outbox Queue retry cùng id / syncId. */
  async insert(report: Report): Promise<void> {
    const doc = reportToDoc(report);
    await ReportModel.updateOne(
      { id: report.id },
      { $setOnInsert: doc },
      { upsert: true },
    );
  }

  async update(report: Report): Promise<void> {
    const res = await ReportModel.replaceOne({ id: report.id }, reportToDoc(report));
    if (res.matchedCount === 0) throw new Error(`Không tìm thấy hồ sơ ${report.id} để cập nhật`);
  }

  async findNearby(q: NearbyQuery): Promise<Report[]> {
    const filter: Record<string, unknown> = {
      location: {
        $nearSphere: {
          $geometry: { type: 'Point', coordinates: [q.lng, q.lat] },
          $maxDistance: Math.max(1, q.radiusM),
        },
      },
    };
    if (q.category) filter.category = String(q.category);
    const docs = (await ReportModel.find(filter).limit(100).lean()) as Doc[];
    return docs.map((d) => reportFromDoc(d)!);
  }

  async findSince(sinceIso: string): Promise<Report[]> {
    const docs = (await ReportModel.find({ createdAt: { $gte: sinceIso } }).sort({ createdAt: -1 }).lean()) as Doc[];
    return docs.map((d) => reportFromDoc(d)!);
  }

  async countByReporterSince(reporterId: string, sinceIso: string): Promise<number> {
    return ReportModel.countDocuments({
      reporterId: String(reporterId),
      createdAt: { $gte: sinceIso },
      source: 'user',
    });
  }

  async count(): Promise<number> {
    return ReportModel.estimatedDocumentCount();
  }
}

class MongoUserRepo implements UserRepository {
  async get(id: string): Promise<UserRecord | null> {
    return strip<UserRecord>((await UserModel.findOne({ id: String(id) }).lean()) as Doc | null);
  }

  async getByPhone(phone: string): Promise<UserRecord | null> {
    return strip<UserRecord>((await UserModel.findOne({ phone: String(phone) }).lean()) as Doc | null);
  }

  async getByEmail(email: string): Promise<UserRecord | null> {
    const escaped = String(email).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return strip<UserRecord>((await UserModel.findOne({ email: new RegExp(`^${escaped}$`, 'i') }).lean()) as Doc | null);
  }

  async getByStaffCode(code: string): Promise<UserRecord | null> {
    const escaped = String(code).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return strip<UserRecord>(
      (await UserModel.findOne({ staffCode: new RegExp(`^${escaped}$`, 'i') }).lean()) as Doc | null,
    );
  }

  async save(user: UserRecord): Promise<void> {
    await UserModel.replaceOne({ id: user.id }, user, { upsert: true });
  }

  async list(role?: Role): Promise<UserRecord[]> {
    const docs = (await UserModel.find(role ? { role } : {}).lean()) as Doc[];
    return docs.map((d) => strip<UserRecord>(d)!);
  }

  async count(): Promise<number> {
    return UserModel.estimatedDocumentCount();
  }
}

class MongoAuditRepo implements AuditRepository {
  async last(): Promise<AuditEntry | null> {
    return strip<AuditEntry>((await AuditLogModel.findOne().sort({ seq: -1 }).lean()) as Doc | null);
  }

  async append(entry: AuditEntry): Promise<void> {
    await AuditLogModel.create(entry);
  }

  async list(limit: number): Promise<AuditEntry[]> {
    const docs = (await AuditLogModel.find().sort({ seq: -1 }).limit(limit).lean()) as Doc[];
    return docs.map((d) => strip<AuditEntry>(d)!);
  }

  async all(): Promise<AuditEntry[]> {
    const docs = (await AuditLogModel.find().sort({ seq: 1 }).lean()) as Doc[];
    return docs.map((d) => strip<AuditEntry>(d)!);
  }
}

class MongoOtpRepo implements OtpRepository {
  async get(identifier: string): Promise<OtpRecord | null> {
    return strip<OtpRecord>((await OtpModel.findOne({ identifier: String(identifier) }).lean()) as Doc | null);
  }

  async save(rec: OtpRecord): Promise<void> {
    await OtpModel.replaceOne(
      { identifier: rec.identifier },
      { ...rec, expiresAtDate: new Date(rec.expiresAt) },
      { upsert: true },
    );
  }

  async delete(identifier: string): Promise<void> {
    await OtpModel.deleteOne({ identifier: String(identifier) });
  }
}

class MongoSessionRepo implements SessionRepository {
  async getByRefreshHash(refreshHash: string): Promise<SessionRecord | null> {
    return strip<SessionRecord>(
      (await SessionModel.findOne({ refreshHash: String(refreshHash) }).lean()) as Doc | null,
    );
  }

  async save(rec: SessionRecord): Promise<void> {
    await SessionModel.replaceOne(
      { id: rec.id },
      { ...rec, expiresAtDate: new Date(rec.expiresAt) },
      { upsert: true },
    );
  }

  async revoke(id: string, replacedBySessionId: string | null = null): Promise<void> {
    await SessionModel.updateOne(
      { id: String(id) },
      { $set: { revokedAt: Date.now(), ...(replacedBySessionId ? { replacedBySessionId } : {}) } },
    );
  }

  async revokeAllForUser(userId: string): Promise<void> {
    await SessionModel.updateMany(
      { userId: String(userId), revokedAt: null },
      { $set: { revokedAt: Date.now() } },
    );
  }
}

export async function createMongoRepositories(uri: string): Promise<Repositories> {
  await connectDatabase({ uri, ensureIndexes: true });
  return {
    mode: 'mongodb',
    reports: new MongoReportRepo(),
    users: new MongoUserRepo(),
    audit: new MongoAuditRepo(),
    otps: new MongoOtpRepo(),
    sessions: new MongoSessionRepo(),
    ping: async () => {
      const health = await getDatabaseHealth();
      return health.ok;
    },
    close: async () => {
      await disconnectDatabase();
    },
  };
}
