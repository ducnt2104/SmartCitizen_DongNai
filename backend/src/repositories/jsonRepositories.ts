import fs from 'node:fs';
import path from 'node:path';
import type { AuditEntry, DynamicAiConfig, Report, Role } from '../shared/types';
import { haversineMeters } from '../shared/geo';
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

interface StoreShape {
  reports: Report[];
  users: UserRecord[];
  fingerprints: ImageFingerprintRecord[];
  evaluations: AiEvaluationRecord[];
  aiConfig: DynamicAiConfig | null;
  audit: AuditEntry[];
  otps: OtpRecord[];
  sessions: SessionRecord[];
}

class JsonStore {
  data: StoreShape = {
    reports: [],
    users: [],
    fingerprints: [],
    evaluations: [],
    aiConfig: null,
    audit: [],
    otps: [],
    sessions: [],
  };
  private timer: NodeJS.Timeout | null = null;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  load(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (!fs.existsSync(this.file)) return;
    const text = fs.readFileSync(this.file, 'utf8');
    if (!text.trim()) return;
    try {
      const parsed = JSON.parse(text) as Partial<StoreShape>;
      this.data = {
        reports: parsed.reports ?? [],
        users: parsed.users ?? [],
        fingerprints: parsed.fingerprints ?? [],
        evaluations: parsed.evaluations ?? [],
        aiConfig: parsed.aiConfig ?? null,
        audit: parsed.audit ?? [],
        otps: parsed.otps ?? [],
        sessions: parsed.sessions ?? [],
      };
    } catch (err) {
      const backup = `${this.file}.corrupt-${Date.now()}`;
      fs.copyFileSync(this.file, backup);
      console.error(`[json-store] store.json hỏng, đã sao lưu sang ${backup} và khởi tạo lại:`, err);
    }
  }

  touch(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, 150);
  }

  flush(): Promise<void> {
    this.writing = this.writing
      .then(async () => {
        const tmp = `${this.file}.tmp`;
        await fs.promises.writeFile(tmp, JSON.stringify(this.data), 'utf8');
        await fs.promises.rename(tmp, this.file);
      })
      .catch((err) => {
        console.error('[json-store] Ghi store.json thất bại:', err);
      });
    return this.writing;
  }
}

class JsonReportRepo implements ReportRepository {
  constructor(private readonly s: JsonStore) {}

  async list(q: ReportQuery = {}): Promise<Report[]> {
    let rows = this.s.data.reports;
    if (q.wardCodes) rows = rows.filter((r) => q.wardCodes!.includes(r.wardCode));
    if (q.statuses) rows = rows.filter((r) => q.statuses!.includes(r.status));
    if (q.category) rows = rows.filter((r) => r.category === q.category);
    if (q.reporterId) {
      rows = rows.filter((r) => r.reporterId === q.reporterId || r.contributors.some((c) => c.userId === q.reporterId));
    }
    if (q.bbox) {
      const { minLng, minLat, maxLng, maxLat } = q.bbox;
      rows = rows.filter((r) => r.lat >= minLat && r.lat <= maxLat && r.lng >= minLng && r.lng <= maxLng);
    }
    if (q.cursor) {
      rows = rows.filter((r) => r.createdAt < q.cursor!);
    }
    rows = [...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return structuredClone(q.limit ? rows.slice(0, q.limit) : rows);
  }
  async get(id: string): Promise<Report | null> {
    const r = this.s.data.reports.find((x) => x.id === id);
    return r ? structuredClone(r) : null;
  }
  async getByCode(code: string): Promise<Report | null> {
    const r = this.s.data.reports.find((x) => x.code.toLowerCase() === code.toLowerCase());
    return r ? structuredClone(r) : null;
  }
  async insert(report: Report): Promise<void> {
    this.s.data.reports.push(structuredClone(report));
    this.s.touch();
  }
  async update(report: Report): Promise<void> {
    const i = this.s.data.reports.findIndex((x) => x.id === report.id);
    if (i < 0) throw new Error(`Không tìm thấy hồ sơ ${report.id} để cập nhật`);
    this.s.data.reports[i] = structuredClone(report);
    this.s.touch();
  }
  async findNearby(q: NearbyQuery): Promise<Report[]> {
    return structuredClone(
      this.s.data.reports.filter(
        (r) => (!q.category || r.category === q.category) && haversineMeters(q.lat, q.lng, r.lat, r.lng) <= q.radiusM,
      ),
    );
  }
  async findSince(sinceIso: string): Promise<Report[]> {
    return structuredClone(this.s.data.reports.filter((r) => r.createdAt >= sinceIso));
  }
  async countByReporterSince(reporterId: string, sinceIso: string): Promise<number> {
    return this.s.data.reports.filter((r) => r.reporterId === reporterId && r.createdAt >= sinceIso && r.source === 'user').length;
  }
  async count(): Promise<number> {
    return this.s.data.reports.length;
  }
}

class JsonUserRepo implements UserRepository {
  constructor(private readonly s: JsonStore) {}
  async get(id: string): Promise<UserRecord | null> {
    const u = this.s.data.users.find((x) => x.id === id);
    return u ? structuredClone(u) : null;
  }
  async getByPhone(phone: string): Promise<UserRecord | null> {
    const u = this.s.data.users.find((x) => x.phone === phone);
    return u ? structuredClone(u) : null;
  }
  async getByEmail(email: string): Promise<UserRecord | null> {
    const low = email.toLowerCase();
    const u = this.s.data.users.find((x) => x.email?.toLowerCase() === low);
    return u ? structuredClone(u) : null;
  }
  async getByStaffCode(code: string): Promise<UserRecord | null> {
    const u = this.s.data.users.find((x) => x.staffCode?.toLowerCase() === code.toLowerCase());
    return u ? structuredClone(u) : null;
  }
  async save(user: UserRecord): Promise<void> {
    const i = this.s.data.users.findIndex((x) => x.id === user.id);
    if (i >= 0) this.s.data.users[i] = structuredClone(user);
    else this.s.data.users.push(structuredClone(user));
    this.s.touch();
  }
  async delete(id: string): Promise<boolean> {
    const before = this.s.data.users.length;
    this.s.data.users = this.s.data.users.filter((x) => x.id !== id);
    if (this.s.data.users.length !== before) {
      this.s.touch();
      return true;
    }
    return false;
  }
  async list(role?: Role): Promise<UserRecord[]> {
    return structuredClone(role ? this.s.data.users.filter((u) => u.role === role) : this.s.data.users);
  }
  async query(filter: UserFilterQuery = {}): Promise<UserRecord[]> {
    let rows = this.s.data.users;
    if (filter.role) rows = rows.filter((u) => u.role === filter.role);
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
    return structuredClone([...rows].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }
  async count(): Promise<number> {
    return this.s.data.users.length;
  }
}

class JsonFingerprintRepo implements FingerprintRepository {
  constructor(private readonly s: JsonStore) {}
  async save(fp: ImageFingerprintRecord): Promise<void> {
    const i = this.s.data.fingerprints.findIndex((x) => x.id === fp.id);
    if (i >= 0) this.s.data.fingerprints[i] = structuredClone(fp);
    else this.s.data.fingerprints.push(structuredClone(fp));
    this.s.touch();
  }
  async findNearbyRecent(lat: number, lng: number, radiusM: number, sinceIso: string): Promise<ImageFingerprintRecord[]> {
    return structuredClone(
      this.s.data.fingerprints
        .filter((f) => f.createdAt >= sinceIso && haversineMeters(lat, lng, f.lat, f.lng) <= radiusM)
        .slice(-120),
    );
  }
  async listByReport(reportId: string): Promise<ImageFingerprintRecord[]> {
    return structuredClone(this.s.data.fingerprints.filter((f) => f.reportId === reportId));
  }
  async count(): Promise<number> {
    return this.s.data.fingerprints.length;
  }
}

class JsonEvaluationRepo implements AiEvaluationRepository {
  constructor(private readonly s: JsonStore) {}
  async append(rec: AiEvaluationRecord): Promise<void> {
    this.s.data.evaluations.push(structuredClone(rec));
    this.s.touch();
  }
  async listByReport(reportId: string): Promise<AiEvaluationRecord[]> {
    return structuredClone(this.s.data.evaluations.filter((e) => e.reportId === reportId).reverse());
  }
  async recent(limit = 100): Promise<AiEvaluationRecord[]> {
    return structuredClone(this.s.data.evaluations.slice(-limit).reverse());
  }
  async count(): Promise<number> {
    return this.s.data.evaluations.length;
  }
}

class JsonAiConfigRepo implements AiConfigRepository {
  constructor(private readonly s: JsonStore) {}
  async get(): Promise<DynamicAiConfig | null> {
    return this.s.data.aiConfig ? structuredClone(this.s.data.aiConfig) : null;
  }
  async save(cfg: DynamicAiConfig): Promise<void> {
    this.s.data.aiConfig = structuredClone(cfg);
    this.s.touch();
  }
}

class JsonAuditRepo implements AuditRepository {
  constructor(private readonly s: JsonStore) {}
  async last(): Promise<AuditEntry | null> {
    const a = this.s.data.audit;
    return a.length ? structuredClone(a[a.length - 1]) : null;
  }
  async append(entry: AuditEntry): Promise<void> {
    this.s.data.audit.push(structuredClone(entry));
    this.s.touch();
  }
  async list(limit: number): Promise<AuditEntry[]> {
    return structuredClone(this.s.data.audit.slice(-limit).reverse());
  }
  async all(): Promise<AuditEntry[]> {
    return structuredClone(this.s.data.audit);
  }
}

class JsonOtpRepo implements OtpRepository {
  constructor(private readonly s: JsonStore) {}
  async get(identifier: string): Promise<OtpRecord | null> {
    const o = this.s.data.otps.find((x) => x.identifier === identifier);
    return o ? { ...o } : null;
  }
  async save(rec: OtpRecord): Promise<void> {
    const i = this.s.data.otps.findIndex((x) => x.identifier === rec.identifier);
    if (i >= 0) this.s.data.otps[i] = { ...rec };
    else this.s.data.otps.push({ ...rec });
    this.s.touch();
  }
  async delete(identifier: string): Promise<void> {
    this.s.data.otps = this.s.data.otps.filter((x) => x.identifier !== identifier);
    this.s.touch();
  }
}

class JsonSessionRepo implements SessionRepository {
  constructor(private readonly s: JsonStore) {}
  async getByRefreshHash(refreshHash: string): Promise<SessionRecord | null> {
    const found = this.s.data.sessions.find((x) => x.refreshHash === refreshHash);
    return found ? { ...found } : null;
  }
  async save(rec: SessionRecord): Promise<void> {
    const i = this.s.data.sessions.findIndex((x) => x.id === rec.id);
    if (i >= 0) this.s.data.sessions[i] = { ...rec };
    else this.s.data.sessions.push({ ...rec });
    this.s.touch();
  }
  async revoke(id: string, replacedBySessionId: string | null = null): Promise<void> {
    const found = this.s.data.sessions.find((x) => x.id === id);
    if (found) {
      found.revokedAt = Date.now();
      if (replacedBySessionId) found.replacedBySessionId = replacedBySessionId;
      this.s.touch();
    }
  }
  async revokeAllForUser(userId: string): Promise<void> {
    const now = Date.now();
    for (const s of this.s.data.sessions) {
      if (s.userId === userId && !s.revokedAt) s.revokedAt = now;
    }
    this.s.touch();
  }
}

export function createJsonRepositories(dataDir: string): Repositories {
  const store = new JsonStore(path.join(dataDir, 'store.json'));
  store.load();
  const reports = new JsonReportRepo(store);
  const users = new JsonUserRepo(store);
  const fingerprints = new JsonFingerprintRepo(store);
  const evaluations = new JsonEvaluationRepo(store);
  const aiConfig = new JsonAiConfigRepo(store);
  const audit = new JsonAuditRepo(store);
  const otps = new JsonOtpRepo(store);
  const sessions = new JsonSessionRepo(store);

  return {
    mode: 'json',
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
      latencyMs: 0.2,
      counts: {
        reports: store.data.reports.length,
        users: store.data.users.length,
        fingerprints: store.data.fingerprints.length,
        evaluations: store.data.evaluations.length,
        auditLogs: store.data.audit.length,
      },
    }),
    close: () => store.flush(),
  };
}
