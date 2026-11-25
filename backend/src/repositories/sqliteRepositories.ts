import fs from 'node:fs';
import path from 'node:path';
import { normalizeRole } from '../shared/constants';
import type { AuditEntry, DynamicAiConfig, Report, Role } from '../shared/types';
import { haversineMeters } from '../shared/geo';
import { createJsonRepositories } from './jsonRepositories';
import type {
  AiConfigRepository,
  AiEvaluationRecord,
  AiEvaluationRepository,
  AtomicRescueClaimInput,
  AuditRepository,
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

export type SyncCollectionName =
  | 'reports'
  | 'users'
  | 'fingerprints'
  | 'evaluations'
  | 'aiConfig'
  | 'audit'
  | 'otps'
  | 'sessions';

export interface DirtyRecordEntry<T = unknown> {
  collection: SyncCollectionName;
  id: string;
  payload: T;
  deleted: boolean;
}

export interface LocalPersistentRepositories extends Repositories {
  readonly engine: 'sqlite_wal' | 'json_file';
  /** Ghi đè bản ghi từ MongoDB xuống bộ đệm nóng cục bộ mà không đánh dấu dirty. */
  hydrateClean<T>(collection: SyncCollectionName, id: string, payload: T): void;
  /** Lấy toàn bộ bản ghi phát sinh khi MongoDB tạm gián đoạn để đồng bộ ngược lên Atlas. */
  listDirtyEntries(): DirtyRecordEntry[];
  /** Xóa cờ dirty sau khi đã đồng bộ thành công lên MongoDB Atlas. */
  clearDirtyEntry(collection: SyncCollectionName, id: string): void;
}

interface SqliteStatementLike {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): Array<Record<string, unknown>>;
}

interface SqliteDatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatementLike;
  close(): void;
}

function tryOpenNodeSqlite(dbFilePath: string): SqliteDatabaseLike | null {
  try {
    // Node.js >= 22.5 cung cấp sẵn module tích hợp `node:sqlite` (không cần biên dịch C++ trên Render)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqliteMod = require('node:sqlite') as { DatabaseSync?: new (p: string) => SqliteDatabaseLike };
    if (!sqliteMod?.DatabaseSync) return null;
    fs.mkdirSync(path.dirname(dbFilePath), { recursive: true });
    const db = new sqliteMod.DatabaseSync(dbFilePath);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA temp_store = MEMORY;
      CREATE TABLE IF NOT EXISTS kv_entities (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        payload TEXT,
        dirty INTEGER NOT NULL DEFAULT 0,
        deleted INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (collection, id)
      );
      CREATE INDEX IF NOT EXISTS idx_kv_dirty ON kv_entities(dirty, updated_at);
    `);
    return db;
  } catch {
    return null;
  }
}

class SqliteHybridEngine {
  readonly reports = new Map<string, Report>();
  readonly users = new Map<string, UserRecord>();
  readonly fingerprints = new Map<string, ImageFingerprintRecord>();
  readonly evaluations = new Map<string, AiEvaluationRecord>();
  aiConfig: DynamicAiConfig | null = null;
  readonly audit = new Map<string, AuditEntry>();
  readonly otps = new Map<string, OtpRecord>();
  readonly sessions = new Map<string, SessionRecord>();

  private readonly upsertStmt: SqliteStatementLike;
  private readonly selectAllStmt: SqliteStatementLike;
  private readonly selectDirtyStmt: SqliteStatementLike;
  private readonly clearDirtyStmt: SqliteStatementLike;
  private readonly purgeDeletedStmt: SqliteStatementLike;

  constructor(private readonly db: SqliteDatabaseLike) {
    this.upsertStmt = db.prepare(`
      INSERT INTO kv_entities (collection, id, payload, dirty, deleted, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(collection, id) DO UPDATE SET
        payload = excluded.payload,
        dirty = excluded.dirty,
        deleted = excluded.deleted,
        updated_at = excluded.updated_at
    `);
    this.selectAllStmt = db.prepare(`
      SELECT collection, id, payload FROM kv_entities WHERE deleted = 0 ORDER BY updated_at ASC
    `);
    this.selectDirtyStmt = db.prepare(`
      SELECT collection, id, payload, deleted FROM kv_entities WHERE dirty = 1 ORDER BY updated_at ASC
    `);
    this.clearDirtyStmt = db.prepare(`
      UPDATE kv_entities SET dirty = 0 WHERE collection = ? AND id = ?
    `);
    this.purgeDeletedStmt = db.prepare(`
      DELETE FROM kv_entities WHERE collection = ? AND id = ? AND deleted = 1 AND dirty = 0
    `);
    this.loadIntoMemory();
  }

  private loadIntoMemory(): void {
    const rows = this.selectAllStmt.all();
    for (const row of rows) {
      const col = String(row.collection) as SyncCollectionName;
      const id = String(row.id);
      const raw = typeof row.payload === 'string' ? row.payload : '';
      if (!raw) continue;
      try {
        const parsed = JSON.parse(raw) as unknown;
        this.putInMemoryOnly(col, id, parsed);
      } catch {
        // Bỏ qua bản ghi lỗi JSON đơn lẻ
      }
    }
  }

  private putInMemoryOnly(col: SyncCollectionName, id: string, value: unknown): void {
    switch (col) {
      case 'reports':
        this.reports.set(id, value as Report);
        break;
      case 'users': {
        const u = value as UserRecord;
        u.role = normalizeRole(u.role);
        this.users.set(id, u);
        break;
      }
      case 'fingerprints':
        this.fingerprints.set(id, value as ImageFingerprintRecord);
        break;
      case 'evaluations':
        this.evaluations.set(id, value as AiEvaluationRecord);
        break;
      case 'aiConfig':
        this.aiConfig = value as DynamicAiConfig;
        break;
      case 'audit':
        this.audit.set(id, value as AuditEntry);
        break;
      case 'otps':
        this.otps.set(id, value as OtpRecord);
        break;
      case 'sessions':
        this.sessions.set(id, value as SessionRecord);
        break;
    }
  }

  put<T>(col: SyncCollectionName, id: string, value: T, dirty: boolean): void {
    const cloned = structuredClone(value);
    this.putInMemoryOnly(col, id, cloned);
    this.upsertStmt.run(col, id, JSON.stringify(cloned), dirty ? 1 : 0, 0, Date.now());
  }

  remove(col: SyncCollectionName, id: string, dirty: boolean): boolean {
    let existed = false;
    if (col === 'users') existed = this.users.delete(id);
    else if (col === 'otps') existed = this.otps.delete(id);
    else if (col === 'reports') existed = this.reports.delete(id);
    else if (col === 'sessions') existed = this.sessions.delete(id);

    if (dirty) {
      this.upsertStmt.run(col, id, null, 1, 1, Date.now());
    } else {
      this.upsertStmt.run(col, id, null, 0, 1, Date.now());
      this.purgeDeletedStmt.run(col, id);
    }
    return existed;
  }

  listDirty(): DirtyRecordEntry[] {
    const rows = this.selectDirtyStmt.all();
    const out: DirtyRecordEntry[] = [];
    for (const r of rows) {
      const collection = String(r.collection) as SyncCollectionName;
      const id = String(r.id);
      const deleted = Number(r.deleted) === 1;
      let payload: unknown = null;
      if (!deleted && typeof r.payload === 'string' && r.payload) {
        try {
          payload = JSON.parse(r.payload);
        } catch {
          continue;
        }
      }
      out.push({ collection, id, payload, deleted });
    }
    return out;
  }

  clearDirty(col: SyncCollectionName, id: string): void {
    this.clearDirtyStmt.run(col, id);
    this.purgeDeletedStmt.run(col, id);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // Đã đóng
    }
  }
}

export function createLocalPersistentRepositories(
  dataDir: string,
  options?: { markWritesDirtyByDefault?: boolean },
): LocalPersistentRepositories {
  const dirtyDefault = options?.markWritesDirtyByDefault ?? false;
  const sqliteFile = path.join(dataDir, 'resilient_local.sqlite');
  const sqliteDb = tryOpenNodeSqlite(sqliteFile);

  if (!sqliteDb) {
    // Fallback an toàn sang JSON Store nếu môi trường chạy bản Node cũ chưa bật node:sqlite
    const jsonRepos = createJsonRepositories(dataDir);
    const dirtyMap = new Map<string, DirtyRecordEntry>();
    const keyOf = (c: SyncCollectionName, id: string) => `${c}:${id}`;
    const recordDirty = <T>(collection: SyncCollectionName, id: string, payload: T, deleted = false) => {
      if (dirtyDefault) {
        dirtyMap.set(keyOf(collection, id), { collection, id, payload: structuredClone(payload), deleted });
      }
    };

    return {
      ...jsonRepos,
      engine: 'json_file',
      reports: {
        ...jsonRepos.reports,
        insert: async (r) => {
          await jsonRepos.reports.insert(r);
          recordDirty('reports', r.id, r);
        },
        update: async (r) => {
          await jsonRepos.reports.update(r);
          recordDirty('reports', r.id, r);
        },
        delete: async (id) => {
          const ok = await jsonRepos.reports.delete(id);
          if (ok) recordDirty('reports', id, null, true);
          return ok;
        },
        claimRescueMission: async (id, claim) => {
          const claimed = await jsonRepos.reports.claimRescueMission(id, claim);
          if (claimed) recordDirty('reports', claimed.id, claimed);
          return claimed;
        },
      },
      users: {
        ...jsonRepos.users,
        save: async (u) => {
          await jsonRepos.users.save(u);
          recordDirty('users', u.id, u);
        },
        delete: async (id) => {
          const ok = await jsonRepos.users.delete(id);
          if (ok) recordDirty('users', id, null, true);
          return ok;
        },
      },
      otps: {
        ...jsonRepos.otps,
        save: async (o) => {
          await jsonRepos.otps.save(o);
          recordDirty('otps', o.identifier, o);
        },
        delete: async (id) => {
          await jsonRepos.otps.delete(id);
          recordDirty('otps', id, null, true);
        },
      },
      sessions: {
        ...jsonRepos.sessions,
        save: async (s) => {
          await jsonRepos.sessions.save(s);
          recordDirty('sessions', s.id, s);
        },
      },
      hydrateClean: <T>(collection: SyncCollectionName, id: string, payload: T) => {
        dirtyMap.delete(keyOf(collection, id));
        if (collection === 'users') void jsonRepos.users.save(payload as UserRecord);
        else if (collection === 'reports') {
          void jsonRepos.reports.get(id).then((ex) => (ex ? jsonRepos.reports.update(payload as Report) : jsonRepos.reports.insert(payload as Report)));
        } else if (collection === 'aiConfig') void jsonRepos.aiConfig.save(payload as DynamicAiConfig);
      },
      listDirtyEntries: () => [...dirtyMap.values()],
      clearDirtyEntry: (collection, id) => {
        dirtyMap.delete(keyOf(collection, id));
      },
    };
  }

  const engine = new SqliteHybridEngine(sqliteDb);
  let writeDirtyFlag = dirtyDefault;

  const reports: ReportRepository = {
    async list(q: ReportQuery = {}): Promise<Report[]> {
      let rows = [...engine.reports.values()];
      if (q.wardCodes?.length) rows = rows.filter((r) => q.wardCodes!.includes(r.wardCode));
      if (q.statuses?.length) rows = rows.filter((r) => q.statuses!.includes(r.status));
      if (q.category) rows = rows.filter((r) => r.category === q.category);
      if (q.reporterId) {
        rows = rows.filter(
          (r) => r.reporterId === q.reporterId || r.contributors.some((c) => c.userId === q.reporterId),
        );
      }
      if (q.bbox) {
        const { minLng, minLat, maxLng, maxLat } = q.bbox;
        rows = rows.filter((r) => r.lat >= minLat && r.lat <= maxLat && r.lng >= minLng && r.lng <= maxLng);
      }
      if (q.cursor) {
        rows = rows.filter((r) => r.createdAt < q.cursor!);
      }
      rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return structuredClone(q.limit ? rows.slice(0, q.limit) : rows);
    },
    async get(id: string): Promise<Report | null> {
      const r = engine.reports.get(id);
      return r ? structuredClone(r) : null;
    },
    async getByCode(code: string): Promise<Report | null> {
      const low = code.toLowerCase();
      for (const r of engine.reports.values()) {
        if (r.code.toLowerCase() === low) return structuredClone(r);
      }
      return null;
    },
    async insert(report: Report): Promise<void> {
      engine.put('reports', report.id, report, writeDirtyFlag);
    },
    async update(report: Report): Promise<void> {
      engine.put('reports', report.id, report, writeDirtyFlag);
    },
    async delete(id: string): Promise<boolean> {
      return engine.remove('reports', id, writeDirtyFlag);
    },
    async claimRescueMission(id: string, claim: AtomicRescueClaimInput): Promise<Report | null> {
      const cur = engine.reports.get(id);
      if (!cur) return null;
      if (!['received', 'verifying', 'processing'].includes(cur.status)) return null;
      if (
        cur.assignedRescueId ||
        (cur.rescueMission?.assignedTeamId && cur.rescueMission.status !== 'unassigned')
      ) {
        return null;
      }
      const hasCoords = typeof claim.lat === 'number' && typeof claim.lng === 'number';
      const next = structuredClone(cur);
      next.status = 'processing';
      next.rescueStatus = 'EN_ROUTE';
      next.assignedRescueId = claim.teamId;
      next.assignedRescueName = claim.teamName;
      next.acceptedAt = claim.nowIso;
      next.rescueMission = {
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
        releaseHistory: cur.rescueReleaseHistory ?? cur.rescueMission?.releaseHistory ?? [],
      };
      if (hasCoords) {
        next.rescueLiveLocation = {
          lat: claim.lat!,
          lng: claim.lng!,
          heading: null,
          speedKmh: null,
          updatedAt: claim.nowIso,
        };
      }
      next.timeline.push({
        stage: 'processing',
        at: claim.nowIso,
        note: `[Đội Cứu Hộ ${claim.teamCode ?? claim.teamName}] Đã tiếp nhận đơn & xuất phát tới hiện trường.`,
      });
      next.updatedAt = claim.nowIso;
      engine.put('reports', next.id, next, writeDirtyFlag);
      return structuredClone(next);
    },
    async findNearby(q: NearbyQuery): Promise<Report[]> {
      const out: Report[] = [];
      for (const r of engine.reports.values()) {
        if (q.category && r.category !== q.category) continue;
        if (haversineMeters(q.lat, q.lng, r.lat, r.lng) <= q.radiusM) {
          out.push(structuredClone(r));
        }
      }
      return out;
    },
    async findSince(sinceIso: string): Promise<Report[]> {
      const out: Report[] = [];
      for (const r of engine.reports.values()) {
        if (r.createdAt >= sinceIso) out.push(structuredClone(r));
      }
      return out;
    },
    async countByReporterSince(reporterId: string, sinceIso: string): Promise<number> {
      let c = 0;
      for (const r of engine.reports.values()) {
        if (r.reporterId === reporterId && r.createdAt >= sinceIso && r.source === 'user') c += 1;
      }
      return c;
    },
    async count(): Promise<number> {
      return engine.reports.size;
    },
  };

  const users: UserRepository = {
    async get(id: string): Promise<UserRecord | null> {
      const u = engine.users.get(id);
      return u ? structuredClone(u) : null;
    },
    async getByPhone(phone: string): Promise<UserRecord | null> {
      for (const u of engine.users.values()) {
        if (u.phone === phone) return structuredClone(u);
      }
      return null;
    },
    async getByEmail(email: string): Promise<UserRecord | null> {
      const low = email.toLowerCase();
      for (const u of engine.users.values()) {
        if (u.email?.toLowerCase() === low) return structuredClone(u);
      }
      return null;
    },
    async getByStaffCode(code: string): Promise<UserRecord | null> {
      const low = code.toLowerCase();
      for (const u of engine.users.values()) {
        if (u.staffCode?.toLowerCase() === low) return structuredClone(u);
      }
      return null;
    },
    async save(user: UserRecord): Promise<void> {
      engine.put('users', user.id, { ...user, role: normalizeRole(user.role) }, writeDirtyFlag);
    },
    async delete(id: string): Promise<boolean> {
      return engine.remove('users', id, writeDirtyFlag);
    },
    async list(role?: Role): Promise<UserRecord[]> {
      const target = role ? normalizeRole(role) : undefined;
      const rows = [...engine.users.values()];
      return structuredClone(target ? rows.filter((u) => normalizeRole(u.role) === target) : rows);
    },
    async query(filter: UserFilterQuery = {}): Promise<UserRecord[]> {
      let rows = [...engine.users.values()];
      if (filter.role) {
        const target = normalizeRole(filter.role);
        rows = rows.filter((u) => normalizeRole(u.role) === target);
      }
      if (filter.wardCode) rows = rows.filter((u) => u.wardCode === filter.wardCode);
      if (filter.isActive !== undefined) rows = rows.filter((u) => Boolean(!u.revoked) === filter.isActive);
      if (filter.q && filter.q.trim()) {
        const low = filter.q.trim().toLowerCase();
        rows = rows.filter(
          (u) =>
            u.name.toLowerCase().includes(low) ||
            (u.email?.toLowerCase().includes(low) ?? false) ||
            (u.phone?.toLowerCase().includes(low) ?? false) ||
            (u.staffCode?.toLowerCase().includes(low) ?? false) ||
            u.id.toLowerCase().includes(low),
        );
      }
      rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return structuredClone(rows);
    },
    async count(): Promise<number> {
      return engine.users.size;
    },
  };

  const fingerprints: FingerprintRepository = {
    async save(fp: ImageFingerprintRecord): Promise<void> {
      engine.put('fingerprints', fp.id, fp, writeDirtyFlag);
    },
    async findNearbyRecent(lat: number, lng: number, radiusM: number, sinceIso: string): Promise<ImageFingerprintRecord[]> {
      const out: ImageFingerprintRecord[] = [];
      for (const f of engine.fingerprints.values()) {
        if (f.createdAt >= sinceIso && haversineMeters(lat, lng, f.lat, f.lng) <= radiusM) {
          out.push(structuredClone(f));
        }
      }
      return out.slice(-120);
    },
    async listByReport(reportId: string): Promise<ImageFingerprintRecord[]> {
      const out: ImageFingerprintRecord[] = [];
      for (const f of engine.fingerprints.values()) {
        if (f.reportId === reportId) out.push(structuredClone(f));
      }
      return out;
    },
    async count(): Promise<number> {
      return engine.fingerprints.size;
    },
  };

  const evaluations: AiEvaluationRepository = {
    async append(rec: AiEvaluationRecord): Promise<void> {
      engine.put('evaluations', rec.id, rec, writeDirtyFlag);
    },
    async listByReport(reportId: string): Promise<AiEvaluationRecord[]> {
      return structuredClone(
        [...engine.evaluations.values()].filter((e) => e.reportId === reportId).reverse(),
      );
    },
    async recent(limit = 100): Promise<AiEvaluationRecord[]> {
      return structuredClone([...engine.evaluations.values()].slice(-limit).reverse());
    },
    async count(): Promise<number> {
      return engine.evaluations.size;
    },
  };

  const aiConfig: AiConfigRepository = {
    async get(): Promise<DynamicAiConfig | null> {
      return engine.aiConfig ? structuredClone(engine.aiConfig) : null;
    },
    async save(cfg: DynamicAiConfig): Promise<void> {
      engine.put('aiConfig', 'global', cfg, writeDirtyFlag);
    },
  };

  const audit: AuditRepository = {
    async last(): Promise<AuditEntry | null> {
      let best: AuditEntry | null = null;
      for (const a of engine.audit.values()) {
        if (!best || a.seq > best.seq) best = a;
      }
      return best ? structuredClone(best) : null;
    },
    async append(entry: AuditEntry): Promise<void> {
      engine.put('audit', String(entry.seq), entry, writeDirtyFlag);
    },
    async list(limit: number): Promise<AuditEntry[]> {
      const sorted = [...engine.audit.values()].sort((a, b) => b.seq - a.seq);
      return structuredClone(sorted.slice(0, limit));
    },
    async all(): Promise<AuditEntry[]> {
      return structuredClone([...engine.audit.values()].sort((a, b) => a.seq - b.seq));
    },
  };

  const otps: OtpRepository = {
    async get(identifier: string): Promise<OtpRecord | null> {
      const o = engine.otps.get(identifier);
      return o ? { ...o } : null;
    },
    async save(rec: OtpRecord): Promise<void> {
      engine.put('otps', rec.identifier, rec, writeDirtyFlag);
    },
    async delete(identifier: string): Promise<void> {
      engine.remove('otps', identifier, writeDirtyFlag);
    },
  };

  const sessions: SessionRepository = {
    async getByRefreshHash(refreshHash: string): Promise<SessionRecord | null> {
      for (const s of engine.sessions.values()) {
        if (s.refreshHash === refreshHash) return { ...s };
      }
      return null;
    },
    async save(rec: SessionRecord): Promise<void> {
      engine.put('sessions', rec.id, rec, writeDirtyFlag);
    },
    async revoke(id: string, replacedBySessionId: string | null = null): Promise<void> {
      const found = engine.sessions.get(id);
      if (found) {
        const next: SessionRecord = {
          ...found,
          revokedAt: Date.now(),
          ...(replacedBySessionId ? { replacedBySessionId } : {}),
        };
        engine.put('sessions', id, next, writeDirtyFlag);
      }
    },
    async revokeAllForUser(userId: string): Promise<void> {
      const now = Date.now();
      for (const s of engine.sessions.values()) {
        if (s.userId === userId && !s.revokedAt) {
          engine.put('sessions', s.id, { ...s, revokedAt: now }, writeDirtyFlag);
        }
      }
    },
  };

  return {
    mode: 'json',
    engine: 'sqlite_wal',
    reports,
    users,
    fingerprints,
    evaluations,
    aiConfig,
    audit,
    otps,
    sessions,
    ping: async () => true,
    healthStats: async () => ({
      ok: true,
      latencyMs: 0.1,
      counts: {
        reports: engine.reports.size,
        users: engine.users.size,
        fingerprints: engine.fingerprints.size,
        evaluations: engine.evaluations.size,
        auditLogs: engine.audit.size,
      },
    }),
    hydrateClean: <T>(collection: SyncCollectionName, id: string, payload: T) => {
      const prev = writeDirtyFlag;
      writeDirtyFlag = false;
      try {
        engine.put(collection, id, payload, false);
      } finally {
        writeDirtyFlag = prev;
      }
    },
    listDirtyEntries: () => engine.listDirty(),
    clearDirtyEntry: (collection, id) => engine.clearDirty(collection, id),
    close: async () => {
      engine.close();
    },
  };
}
