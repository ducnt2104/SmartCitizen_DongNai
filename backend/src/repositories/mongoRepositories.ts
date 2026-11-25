import mongoose from 'mongoose';
import type { AuditEntry, DynamicAiConfig, Report, Role } from '../shared/types';
import { connectDatabase, disconnectDatabase } from '../config/database';
import {
  AiConfigModel,
  AiEvaluationModel,
  AuditLogModel,
  computePriorityScore,
  ImageFingerprintModel,
  normalizeSparseString,
  OtpModel,
  ReportModel,
  SessionModel,
  UserModel,
} from '../models';
import type {
  AiConfigRepository,
  AiEvaluationRecord,
  AiEvaluationRepository,
  AuditRepository,
  DbHealthStats,
  FingerprintRepository,
  ImageFingerprintRecord,
  NearbyQuery,
  OtpRecord,
  OtpRepository,
  ReportQuery,
  ReportRepository,
  Repositories,
  SessionRecord,
  SessionRepository,
  UserFilterQuery,
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
    return ReportModel.countDocuments();
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

  async delete(id: string): Promise<boolean> {
    const res = await UserModel.deleteOne({ id: String(id) });
    return (res.deletedCount ?? 0) > 0;
  }

  async list(role?: Role): Promise<UserRecord[]> {
    const docs = (await UserModel.find(role ? { role } : {}).sort({ createdAt: -1 }).lean()) as Doc[];
    return docs.map((d) => strip<UserRecord>(d)!);
  }

  async query(filter: UserFilterQuery = {}): Promise<UserRecord[]> {
    const f: Record<string, unknown> = {};
    if (filter.role) f.role = filter.role;
    if (filter.wardCode) f.wardCode = filter.wardCode;
    if (filter.isActive !== undefined) f.revoked = filter.isActive ? { $ne: true } : true;
    if (filter.q && filter.q.trim()) {
      const escaped = filter.q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(escaped, 'i');
      f.$or = [{ name: re }, { email: re }, { phone: re }, { staffCode: re }, { id: re }];
    }
    const docs = (await UserModel.find(f).sort({ createdAt: -1 }).lean()) as Doc[];
    return docs.map((d) => strip<UserRecord>(d)!);
  }

  async count(): Promise<number> {
    return UserModel.countDocuments();
  }
}

class MongoFingerprintRepo implements FingerprintRepository {
  async save(fp: ImageFingerprintRecord): Promise<void> {
    await ImageFingerprintModel.replaceOne(
      { id: fp.id },
      { ...fp, location: { type: 'Point', coordinates: [fp.lng, fp.lat] } },
      { upsert: true },
    );
  }
  async findNearbyRecent(lat: number, lng: number, radiusM: number, sinceIso: string): Promise<ImageFingerprintRecord[]> {
    const docs = (await ImageFingerprintModel.find({
      createdAt: { $gte: sinceIso },
      location: { $geoWithin: { $centerSphere: [[lng, lat], radiusM / 6378100] } },
    })
      .sort({ createdAt: -1 })
      .limit(120)
      .lean()) as Doc[];
    return docs.map((d) => {
      const { location, ...rest } = d;
      void location;
      return strip<ImageFingerprintRecord>(rest)!;
    });
  }
  async listByReport(reportId: string): Promise<ImageFingerprintRecord[]> {
    const docs = (await ImageFingerprintModel.find({ reportId: String(reportId) }).lean()) as Doc[];
    return docs.map((d) => {
      const { location, ...rest } = d;
      void location;
      return strip<ImageFingerprintRecord>(rest)!;
    });
  }
  async count(): Promise<number> {
    return ImageFingerprintModel.countDocuments();
  }
}

class MongoEvaluationRepo implements AiEvaluationRepository {
  async append(rec: AiEvaluationRecord): Promise<void> {
    await AiEvaluationModel.create(rec);
  }
  async listByReport(reportId: string): Promise<AiEvaluationRecord[]> {
    const docs = (await AiEvaluationModel.find({ reportId: String(reportId) }).sort({ createdAt: -1 }).lean()) as Doc[];
    return docs.map((d) => strip<AiEvaluationRecord>(d)!);
  }
  async recent(limit = 100): Promise<AiEvaluationRecord[]> {
    const docs = (await AiEvaluationModel.find().sort({ createdAt: -1 }).limit(limit).lean()) as Doc[];
    return docs.map((d) => strip<AiEvaluationRecord>(d)!);
  }
  async count(): Promise<number> {
    return AiEvaluationModel.countDocuments();
  }
}

class MongoAiConfigRepo implements AiConfigRepository {
  async get(): Promise<DynamicAiConfig | null> {
    const doc = (await AiConfigModel.findOne({ key: 'global' }).lean()) as Doc | null;
    if (!doc) return null;
    const { key, ...rest } = doc;
    void key;
    return strip<DynamicAiConfig>(rest);
  }
  async save(cfg: DynamicAiConfig): Promise<void> {
    await AiConfigModel.replaceOne({ key: 'global' }, { key: 'global', ...cfg }, { upsert: true });
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

  const reports = new MongoReportRepo();
  const users = new MongoUserRepo();
  const fingerprints = new MongoFingerprintRepo();
  const evaluations = new MongoEvaluationRepo();
  const aiConfig = new MongoAiConfigRepo();
  const audit = new MongoAuditRepo();
  const otps = new MongoOtpRepo();
  const sessions = new MongoSessionRepo();

  const ping = async (): Promise<boolean> => {
    if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) return false;
    await mongoose.connection.db.admin().ping();
    return true;
  };

  const healthStats = async (): Promise<DbHealthStats> => {
    const t0 = performance.now();
    const ok = await ping().catch(() => false);
    const latencyMs = Math.round((performance.now() - t0) * 10) / 10;
    if (!ok) {
      return { ok: false, latencyMs, counts: { reports: 0, users: 0, fingerprints: 0, evaluations: 0, auditLogs: 0 } };
    }
    const [rCnt, uCnt, fCnt, eCnt, aCnt] = await Promise.all([
      reports.count(),
      users.count(),
      fingerprints.count(),
      evaluations.count(),
      AuditLogModel.countDocuments(),
    ]);
    return {
      ok: true,
      latencyMs,
      counts: { reports: rCnt, users: uCnt, fingerprints: fCnt, evaluations: eCnt, auditLogs: aCnt },
    };
  };

  return {
    mode: 'mongodb',
    reports,
    users,
    fingerprints,
    evaluations,
    aiConfig,
    audit,
    otps,
    sessions,
    ping,
    healthStats,
    close: async () => {
      await disconnectDatabase();
    },
  };
}
