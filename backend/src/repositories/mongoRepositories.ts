import mongoose from 'mongoose';
import type { AuditEntry, DynamicAiConfig, Report, Role } from '../shared/types';
import { buildMongoConnectOptions } from '../config/db';
import {
  AiConfigModel,
  AiEvaluationModel,
  AuditLogModel,
  ImageFingerprintModel,
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
  const { _id, ...rest } = doc;
  void _id;
  return rest as T;
}

function reportFromDoc(doc: Doc | null): Report | null {
  if (!doc) return null;
  const { location, imageHash, ...rest } = doc;
  void location;
  void imageHash;
  return strip<Report>(rest);
}

function reportToDoc(r: Report): Doc {
  return {
    ...r,
    imageHash: r.photos[0]?.dHash ?? '',
    location: { type: 'Point', coordinates: [r.lng, r.lat] },
  };
}

class MongoReportRepo implements ReportRepository {
  async list(q: ReportQuery = {}): Promise<Report[]> {
    const filter: Record<string, unknown> = {};
    if (q.wardCodes) filter.wardCode = { $in: q.wardCodes };
    if (q.statuses) filter.status = { $in: q.statuses };
    if (q.category) filter.category = String(q.category);
    if (q.reporterId) filter.$or = [{ reporterId: String(q.reporterId) }, { 'contributors.userId': String(q.reporterId) }];
    if (q.bbox) {
      filter.lat = { $gte: q.bbox.minLat, $lte: q.bbox.maxLat };
      filter.lng = { $gte: q.bbox.minLng, $lte: q.bbox.maxLng };
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
    await ReportModel.create(reportToDoc(report));
  }
  async update(report: Report): Promise<void> {
    const res = await ReportModel.replaceOne({ id: report.id }, reportToDoc(report));
    if (res.matchedCount === 0) throw new Error(`Không tìm thấy hồ sơ ${report.id} để cập nhật`);
  }
  async findNearby(q: NearbyQuery): Promise<Report[]> {
    const filter: Record<string, unknown> = {
      location: { $geoWithin: { $centerSphere: [[q.lng, q.lat], q.radiusM / 6378100] } },
    };
    if (q.category) filter.category = String(q.category);
    const docs = (await ReportModel.find(filter).lean()) as Doc[];
    return docs.map((d) => reportFromDoc(d)!);
  }
  async findSince(sinceIso: string): Promise<Report[]> {
    const docs = (await ReportModel.find({ createdAt: { $gte: sinceIso } }).lean()) as Doc[];
    return docs.map((d) => reportFromDoc(d)!);
  }
  async countByReporterSince(reporterId: string, sinceIso: string): Promise<number> {
    return ReportModel.countDocuments({ reporterId: String(reporterId), createdAt: { $gte: sinceIso }, source: 'user' });
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
    return strip<UserRecord>((await UserModel.findOne({ staffCode: new RegExp(`^${escaped}$`, 'i') }).lean()) as Doc | null);
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
    await OtpModel.replaceOne({ identifier: rec.identifier }, rec, { upsert: true });
  }
  async delete(identifier: string): Promise<void> {
    await OtpModel.deleteOne({ identifier: String(identifier) });
  }
}

class MongoSessionRepo implements SessionRepository {
  async getByRefreshHash(refreshHash: string): Promise<SessionRecord | null> {
    return strip<SessionRecord>((await SessionModel.findOne({ refreshHash: String(refreshHash) }).lean()) as Doc | null);
  }
  async save(rec: SessionRecord): Promise<void> {
    await SessionModel.replaceOne({ id: rec.id }, rec, { upsert: true });
  }
  async revoke(id: string, replacedBySessionId: string | null = null): Promise<void> {
    await SessionModel.updateOne(
      { id: String(id) },
      { $set: { revokedAt: Date.now(), ...(replacedBySessionId ? { replacedBySessionId } : {}) } },
    );
  }
  async revokeAllForUser(userId: string): Promise<void> {
    await SessionModel.updateMany({ userId: String(userId), revokedAt: null }, { $set: { revokedAt: Date.now() } });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function createMongoRepositories(uri: string): Promise<Repositories> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await mongoose.connect(uri, buildMongoConnectOptions());
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      console.error(`[mongodb] Lần kết nối ${attempt}/3 thất bại:`, err instanceof Error ? err.message : err);
      if (attempt < 3) await sleep(1000 * attempt);
    }
  }
  if (lastErr) throw lastErr;

  // Dùng createIndexes() thay cho syncIndexes() để không drop index cũ gây xung đột trên MongoDB Atlas
  await Promise.allSettled([
    ReportModel.createIndexes(),
    UserModel.createIndexes(),
    ImageFingerprintModel.createIndexes(),
    AiEvaluationModel.createIndexes(),
    AiConfigModel.createIndexes(),
    AuditLogModel.createIndexes(),
    OtpModel.createIndexes(),
    SessionModel.createIndexes(),
  ]);

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
      await mongoose.disconnect();
    },
  };
}
