import fs from 'node:fs';
import path from 'node:path';
import type { AuditEntry, Report, Role } from '../../../shared/types';
import { haversineMeters } from '../../../shared/geo';
import type {
  AuditRepository, NearbyQuery, OtpRecord, OtpRepository, ReportQuery, ReportRepository, Repositories,
  UserRecord, UserRepository,
} from './types';

interface StoreShape {
  reports: Report[];
  users: UserRecord[];
  audit: AuditEntry[];
  otps: OtpRecord[];
}

/** Local Persistent JSON Store: ghi nguyên tử (tmp + rename), gộp nhiều lần ghi liên tiếp (debounce). */
class JsonStore {
  data: StoreShape = { reports: [], users: [], audit: [], otps: [] };
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
        audit: parsed.audit ?? [],
        otps: parsed.otps ?? [],
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
    this.writing = this.writing.then(async () => {
      const tmp = `${this.file}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify(this.data), 'utf8');
      await fs.promises.rename(tmp, this.file);
    }).catch((err) => {
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
    if (q.reporterId) rows = rows.filter((r) => r.reporterId === q.reporterId || r.contributors.some((c) => c.userId === q.reporterId));
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
  async list(role?: Role): Promise<UserRecord[]> {
    return structuredClone(role ? this.s.data.users.filter((u) => u.role === role) : this.s.data.users);
  }
  async count(): Promise<number> {
    return this.s.data.users.length;
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
  async get(phone: string): Promise<OtpRecord | null> {
    const o = this.s.data.otps.find((x) => x.phone === phone);
    return o ? { ...o } : null;
  }
  async save(rec: OtpRecord): Promise<void> {
    const i = this.s.data.otps.findIndex((x) => x.phone === rec.phone);
    if (i >= 0) this.s.data.otps[i] = { ...rec };
    else this.s.data.otps.push({ ...rec });
    this.s.touch();
  }
  async delete(phone: string): Promise<void> {
    this.s.data.otps = this.s.data.otps.filter((x) => x.phone !== phone);
    this.s.touch();
  }
}

export function createJsonRepositories(dataDir: string): Repositories {
  const store = new JsonStore(path.join(dataDir, 'store.json'));
  store.load();
  return {
    mode: 'json',
    reports: new JsonReportRepo(store),
    users: new JsonUserRepo(store),
    audit: new JsonAuditRepo(store),
    otps: new JsonOtpRepo(store),
    ping: async () => true,
    close: () => store.flush(),
  };
}
