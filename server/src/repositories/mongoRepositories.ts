import mongoose from 'mongoose';
import type { AuditEntry, Report, Role } from '../../../shared/types';
import { AuditLogModel, OtpModel, ReportModel, UserModel } from '../models';
import type {
  AuditRepository, NearbyQuery, OtpRecord, OtpRepository, ReportQuery, ReportRepository, Repositories,
  UserRecord, UserRepository,
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
  async getByStaffCode(code: string): Promise<UserRecord | null> {
    const escaped = String(code).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return strip<UserRecord>((await UserModel.findOne({ staffCode: new RegExp(`^${escaped}$`, 'i') }).lean()) as Doc | null);
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
  async get(phone: string): Promise<OtpRecord | null> {
    return strip<OtpRecord>((await OtpModel.findOne({ phone: String(phone) }).lean()) as Doc | null);
  }
  async save(rec: OtpRecord): Promise<void> {
    await OtpModel.replaceOne({ phone: rec.phone }, rec, { upsert: true });
  }
  async delete(phone: string): Promise<void> {
    await OtpModel.deleteOne({ phone: String(phone) });
  }
}

export async function createMongoRepositories(uri: string): Promise<Repositories> {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  await Promise.all([ReportModel.syncIndexes(), UserModel.syncIndexes(), AuditLogModel.syncIndexes(), OtpModel.syncIndexes()]);
  return {
    mode: 'mongodb',
    reports: new MongoReportRepo(),
    users: new MongoUserRepo(),
    audit: new MongoAuditRepo(),
    otps: new MongoOtpRepo(),
    ping: async () => mongoose.connection.readyState === 1,
    close: async () => {
      await mongoose.disconnect();
    },
  };
}
