import mongoose from 'mongoose';
import { computeSosPriorityScore, legacyRolesFor, normalizeRole, toSeverityLabel } from '../shared/constants';
import { fromGeoJsonPoint, normalizeCoordinates, toGeoJsonPoint } from '../shared/coordinates';
import type {
  AuditEntry,
  DynamicAiConfig,
  Report,
  ReportStatus,
  RescueMissionState,
  RescueStageCode,
  Role,
  TimelineEvent,
} from '../shared/types';
import { connectDatabase, disconnectDatabase } from '../config/database';
import {
  AiConfigModel,
  AiEvaluationModel,
  AuditLogModel,
  computePriorityScore,
  ImageFingerprintModel,
  Incident,
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
  AtomicRescueClaimInput,
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

const MONGO_TO_REPORT_STATUS: Record<string, ReportStatus> = {
  received: 'received',
  verifying: 'verifying',
  processing: 'processing',
  resolved: 'resolved',
  quarantined: 'quarantined',
  rejected: 'rejected',
  PENDING: 'received',
  VERIFIED: 'verifying',
  DISPATCHED: 'processing',
  EN_ROUTE: 'processing',
  ARRIVED: 'processing',
  IN_PROGRESS: 'processing',
  RESOLVED: 'resolved',
};

function expandMongoStatuses(statuses: ReportStatus[]): string[] {
  const out = new Set<string>();
  for (const s of statuses) {
    out.add(s);
    if (s === 'received') out.add('PENDING');
    if (s === 'verifying') out.add('VERIFIED');
    if (s === 'processing') {
      out.add('DISPATCHED');
      out.add('EN_ROUTE');
      out.add('ARRIVED');
      out.add('IN_PROGRESS');
    }
    if (s === 'resolved') out.add('RESOLVED');
  }
  return [...out];
}

function reportFromDoc(doc: Doc | null): Report | null {
  if (!doc) return null;
  const { location, imageHash, syncId, customCategoryLabel, ...rest } = doc;
  void imageHash;
  void syncId;
  void customCategoryLabel;
  const parsedGeo = fromGeoJsonPoint(location as { type?: string; coordinates?: readonly number[] } | undefined);
  const base = strip<Report>(rest);
  if (!base) return null;
  const rawStatus = String(doc.status ?? 'received');
  base.status = MONGO_TO_REPORT_STATUS[rawStatus] ?? 'received';
  if (!base.rescueStatus && ['PENDING', 'VERIFIED', 'DISPATCHED', 'EN_ROUTE', 'ARRIVED', 'IN_PROGRESS', 'RESOLVED'].includes(rawStatus)) {
    base.rescueStatus = rawStatus as RescueStageCode;
  }
  if (doc.acceptedAt instanceof Date) {
    base.acceptedAt = doc.acceptedAt.toISOString();
  } else if (typeof doc.acceptedAt === 'string') {
    base.acceptedAt = doc.acceptedAt;
  }
  if (parsedGeo && (!Number.isFinite(base.lat) || !Number.isFinite(base.lng))) {
    base.lat = parsedGeo.lat;
    base.lng = parsedGeo.lng;
  }
  return base;
}

function reportToDoc(r: Report): Doc {
  const syncId = normalizeSparseString(r.id.startsWith('rp_') ? r.id.slice(3) : r.id);
  const norm = normalizeCoordinates({ lat: r.lat, lng: r.lng });
  const safeLat = norm.ok ? norm.lat : r.lat;
  const safeLng = norm.ok ? norm.lng : r.lng;
  const geoPoint = norm.ok ? norm.geoJson : { type: 'Point' as const, coordinates: [safeLng, safeLat] as [number, number] };
  const priorityScore =
    r.priorityScore ??
    r.ai?.priorityScore ??
    computeSosPriorityScore({
      severity: r.severity,
      isEmergency: r.isEmergency || r.emergencyLevel === 1,
      onArterial: r.onArterial,
      clusterCount: r.clusterCount,
      confirmCount: r.confirmations.length,
    }) ??
    computePriorityScore({
      severityLevel: r.severity,
      duplicateCount: Math.max(0, (r.clusterCount ?? 1) - 1),
      reporterTrustScore: 100,
    });
  const severityLabel =
    r.severityLabel ?? r.ai?.severityLabel ?? toSeverityLabel(r.severity, r.isEmergency || r.emergencyLevel === 1);

  const mongoStatus =
    r.status === 'processing' && r.rescueStatus && ['EN_ROUTE', 'ARRIVED', 'IN_PROGRESS'].includes(r.rescueStatus)
      ? r.rescueStatus
      : r.status;

  return {
    ...r,
    status: mongoStatus,
    rescueStatus: r.rescueStatus ?? null,
    assignedRescueId: r.assignedRescueId ?? r.rescueMission?.assignedTeamId ?? null,
    assignedRescueName: r.assignedRescueName ?? r.rescueMission?.assignedTeamName ?? null,
    acceptedAt: r.acceptedAt ? new Date(r.acceptedAt) : null,
    lat: safeLat,
    lng: safeLng,
    ...(syncId ? { syncId } : {}),
    priorityScore,
    severityLabel,
    imageHash: r.photos[0]?.dHash ?? '',
    location: geoPoint,
  };
}

class MongoReportRepo implements ReportRepository {
  async list(q: ReportQuery = {}): Promise<Report[]> {
    const filter: Record<string, unknown> = {};
    if (q.wardCodes?.length) {
      filter.wardCode = q.wardCodes.length === 1 ? q.wardCodes[0] : { $in: q.wardCodes };
    }
    if (q.statuses?.length) {
      const expanded = expandMongoStatuses(q.statuses);
      filter.status = expanded.length === 1 ? expanded[0] : { $in: expanded };
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

  async delete(id: string): Promise<boolean> {
    const res = await ReportModel.deleteOne({ id: String(id) });
    return (res.deletedCount ?? 0) > 0;
  }

  async claimRescueMission(id: string, claim: AtomicRescueClaimInput): Promise<Report | null> {
    const idCondition = mongoose.Types.ObjectId.isValid(id)
      ? { $or: [{ id: String(id) }, { _id: new mongoose.Types.ObjectId(id) }] }
      : { id: String(id) };

    const acceptedDate = new Date(claim.nowIso);
    const hasCoords = typeof claim.lat === 'number' && typeof claim.lng === 'number';
    const nextMission: RescueMissionState = {
      status: 'en_route',
      stageCode: 'EN_ROUTE',
      assignedTeamId: claim.teamId,
      assignedTeamName: claim.teamName,
      assignedTeamCode: claim.teamCode,
      acceptedAt: claim.nowIso,
      enRouteAt: claim.nowIso,
      arrivedAt: null,
      inProgressAt: null,
      onSiteAt: null,
      completedAt: null,
      lastLat: hasCoords ? claim.lat! : null,
      lastLng: hasCoords ? claim.lng! : null,
      lastHeading: null,
      lastSpeedKmh: null,
      lastLocationUpdatedAt: hasCoords ? claim.nowIso : null,
      note: '',
    };
    const timelineEntry: TimelineEvent = {
      stage: 'processing',
      at: claim.nowIso,
      note: `[Đội Cứu Hộ ${claim.teamCode ?? claim.teamName}] Đã tiếp nhận đơn & xuất phát tới hiện trường.`,
    };

    const claimedDoc = (await ReportModel.findOneAndUpdate(
      {
        $and: [
          idCondition,
          { status: { $in: ['received', 'verifying', 'processing', 'PENDING', 'VERIFIED', 'DISPATCHED'] } },
          { $or: [{ assignedRescueId: null }, { assignedRescueId: { $exists: false } }] },
          {
            $or: [
              { rescueMission: null },
              { rescueMission: { $exists: false } },
              { 'rescueMission.assignedTeamId': null },
              { 'rescueMission.status': 'unassigned' },
            ],
          },
        ],
      },
      {
        $set: {
          status: 'EN_ROUTE',
          rescueStatus: 'EN_ROUTE',
          assignedRescueId: claim.teamId,
          assignedRescueName: claim.teamName,
          acceptedAt: acceptedDate,
          rescueMission: nextMission,
          ...(hasCoords
            ? {
                rescueLiveLocation: {
                  lat: claim.lat!,
                  lng: claim.lng!,
                  heading: null,
                  speedKmh: null,
                  updatedAt: claim.nowIso,
                },
              }
            : {}),
          updatedAt: claim.nowIso,
        },
        $push: {
          timeline: timelineEntry,
        },
      },
      { new: true, lean: true },
    )) as Doc | null;

    // Đồng bộ song song sang bảng incidents nếu hồ sơ có bản ghi tương ứng
    if (claimedDoc) {
      const code = typeof claimedDoc.code === 'string' ? claimedDoc.code : undefined;
      if (code) {
        await Incident.findOneAndUpdate(
          { incidentCode: code.toUpperCase(), assignedRescueId: null },
          {
            $set: {
              assignedRescueId: claim.teamId,
              assignedRescueName: claim.teamName,
              rescueStatus: 'EN_ROUTE',
              acceptedAt: acceptedDate,
              status: 'in_progress',
            },
          },
        ).catch(() => undefined);
      }
    }

    return reportFromDoc(claimedDoc);
  }

  async findNearby(q: NearbyQuery): Promise<Report[]> {
    const geoPoint = toGeoJsonPoint(q.lat, q.lng);
    const filter: Record<string, unknown> = {
      location: {
        $nearSphere: {
          $geometry: geoPoint,
          $maxDistance: Math.max(1, q.radiusM),
        },
      },
    };
    if (q.category) filter.category = String(q.category);
    const docs = (await ReportModel.find(filter).limit(150).lean()) as Doc[];
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

function userFromDoc(doc: Doc | null): UserRecord | null {
  const base = strip<UserRecord>(doc);
  if (!base) return null;
  base.role = normalizeRole(base.role);
  return base;
}

class MongoUserRepo implements UserRepository {
  async get(id: string): Promise<UserRecord | null> {
    return userFromDoc((await UserModel.findOne({ id: String(id) }).lean()) as Doc | null);
  }

  async getByPhone(phone: string): Promise<UserRecord | null> {
    return userFromDoc((await UserModel.findOne({ phone: String(phone) }).lean()) as Doc | null);
  }

  async getByEmail(email: string): Promise<UserRecord | null> {
    const escaped = String(email).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return userFromDoc((await UserModel.findOne({ email: new RegExp(`^${escaped}$`, 'i') }).lean()) as Doc | null);
  }

  async getByStaffCode(code: string): Promise<UserRecord | null> {
    const escaped = String(code).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return userFromDoc(
      (await UserModel.findOne({ staffCode: new RegExp(`^${escaped}$`, 'i') }).lean()) as Doc | null,
    );
  }

  async save(user: UserRecord): Promise<void> {
    const normalized: UserRecord = { ...user, role: normalizeRole(user.role) };
    await UserModel.replaceOne({ id: normalized.id }, normalized, { upsert: true });
  }

  async delete(id: string): Promise<boolean> {
    const res = await UserModel.deleteOne({ id: String(id) });
    return (res.deletedCount ?? 0) > 0;
  }

  async list(role?: Role): Promise<UserRecord[]> {
    const filter = role ? { role: { $in: [...legacyRolesFor(normalizeRole(role))] } } : {};
    const docs = (await UserModel.find(filter).sort({ createdAt: -1 }).lean()) as Doc[];
    return docs.map((d) => userFromDoc(d)!);
  }

  async query(filter: UserFilterQuery = {}): Promise<UserRecord[]> {
    const f: Record<string, unknown> = {};
    if (filter.role) f.role = { $in: [...legacyRolesFor(normalizeRole(filter.role))] };
    if (filter.wardCode) f.wardCode = filter.wardCode;
    if (filter.isActive !== undefined) f.revoked = filter.isActive ? { $ne: true } : true;
    if (filter.q && filter.q.trim()) {
      const escaped = filter.q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const re = new RegExp(escaped, 'i');
      f.$or = [{ name: re }, { email: re }, { phone: re }, { staffCode: re }, { id: re }];
    }
    const docs = (await UserModel.find(f).sort({ createdAt: -1 }).lean()) as Doc[];
    return docs.map((d) => userFromDoc(d)!);
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

export async function createMongoRepositories(
  uri: string,
  options?: { bootRetries?: number; retryBaseDelayMs?: number },
): Promise<Repositories> {
  await connectDatabase({
    uri,
    ensureIndexes: true,
    bootRetries: options?.bootRetries,
    retryBaseDelayMs: options?.retryBaseDelayMs,
  });

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
