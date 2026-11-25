import mongoose from 'mongoose';
import { normalizeRole } from '../shared/constants';
import { DONG_NAI_WARDS } from '../shared/dongNaiWards';
import type { Role } from '../shared/types';
import { env } from '../config/env';
import {
  AiEvaluationModel,
  ImageFingerprintModel,
  Incident,
  ReportModel,
  SpamLog,
  User,
  UserModel,
  Ward,
} from '../models';
import { buildSeedReports } from '../shared/seed';
import { hashPassword, userIdFromPhone } from '../utils/crypto';
import type { Repositories, UserRecord } from '../repositories/types';
import { SYSTEM_ACTOR, type AuditService } from '../services/audit.service';

export const INITIAL_STAFF_PASSWORD = process.env.INITIAL_STAFF_PASSWORD || 'DongNai@2026!';
export const INITIAL_SUPER_ADMIN_PASSWORD =
  env.superAdminPassword || process.env.SUPER_ADMIN_PASSWORD || INITIAL_STAFF_PASSWORD;
export const SUPER_ADMIN_PASSWORD = INITIAL_SUPER_ADMIN_PASSWORD;

function user(p: Partial<UserRecord> & Pick<UserRecord, 'id' | 'role' | 'name'>): UserRecord {
  return {
    phone: null,
    email: null,
    staffCode: null,
    passwordHash: null,
    wardCode: null,
    unitCode: null,
    defaultWardCode: p.wardCode ?? null,
    notificationsEnabled: true,
    revoked: false,
    trustScore: 70,
    badges: [],
    volunteerHours: 0,
    points: 0,
    notifications: [],
    createdAt: '2026-11-01T01:00:00.000Z',
    ...p,
  };
}

/** Tài khoản Quản trị viên (`ADMIN`) ban đầu duy nhất khi khởi tạo hệ thống sạch Production. */
export function buildInitialAdminUser(): UserRecord {
  return user({
    id: 'u_super_admin',
    role: 'admin',
    name: 'Quản trị viên Hệ thống IOC Đồng Nai',
    email: env.superAdminEmail.toLowerCase(),
    staffCode: env.superAdminCode.toUpperCase(),
    passwordHash: hashPassword(INITIAL_SUPER_ADMIN_PASSWORD),
    trustScore: 100,
    badges: ['Quản trị viên Hệ thống'],
  });
}

/** Bộ tài khoản chuẩn hóa theo 4 vai trò (`ADMIN`, `OFFICER`, `RESCUE`, `CITIZEN`) phục vụ kiểm thử tích hợp khi bật `includeFixtures`. */
export function buildSeedUsers(): UserRecord[] {
  const staffPw = hashPassword(INITIAL_STAFF_PASSWORD);
  return [
    buildInitialAdminUser(),
    user({
      id: userIdFromPhone('0900000001'),
      role: 'citizen',
      name: 'Nguyễn Văn An',
      phone: '0900000001',
      email: 'an.nguyen@dongnai.example',
      defaultWardCode: 'DN-TB',
      trustScore: 82,
      badges: ['Công dân Văn minh Đồng Nai'],
    }),
    user({
      id: userIdFromPhone('0900000002'),
      role: 'officer',
      name: 'Trần Minh Khoa',
      phone: '0900000002',
      email: 'khoa.tran@dongnai.example',
      wardCode: 'DN-TB',
      unitCode: 'DN-TB-01',
      trustScore: 90,
      volunteerHours: 38,
      points: 420,
      badges: ['Hỗ trợ Cộng đồng'],
    }),
    user({ id: 'u_seed_vol1', role: 'officer', name: 'Lê Thu Hà', phone: '0900000011', wardCode: 'DN-LTH', unitCode: 'DN-LTH-01', volunteerHours: 52, points: 610, badges: ['Hỗ trợ Cộng đồng'] }),
    user({ id: 'u_seed_vol2', role: 'officer', name: 'Phạm Quốc Việt', phone: '0900000012', wardCode: 'DN-BP', unitCode: 'DN-BP-01', volunteerHours: 34, points: 390 }),
    user({ id: 'u_seed_vol3', role: 'officer', name: 'Điểu Thị Hoa', phone: '0900000013', wardCode: 'DN-TLA', unitCode: 'DN-TLA-01', volunteerHours: 29, points: 315 }),
    user({ id: 'u_seed_vol4', role: 'officer', name: 'Đặng Hoài Nam', phone: '0900000014', wardCode: 'DN-LKH', unitCode: 'DN-LKH-01', volunteerHours: 22, points: 250 }),
    // Cán bộ xử lý (OFFICER: gắn 1 trong 95 Phường/Xã) + Quản trị viên cấp TP (ADMIN)
    user({ id: 'u_staff_tb1', role: 'officer', name: 'Lê Thị Hạnh', staffCode: 'CB-TB-01', passwordHash: staffPw, wardCode: 'DN-TB', trustScore: 100 }),
    user({ id: 'u_staff_lth1', role: 'officer', name: 'Nguyễn Hữu Phước', staffCode: 'CB-LTH-01', passwordHash: staffPw, wardCode: 'DN-LTH', trustScore: 100 }),
    user({ id: 'u_staff_lkh1', role: 'officer', name: 'Huỳnh Bảo Châu', staffCode: 'CB-LKH-01', passwordHash: staffPw, wardCode: 'DN-LKH', trustScore: 100 }),
    user({ id: 'u_staff_tla1', role: 'officer', name: 'Điểu Văn Sơn', staffCode: 'CB-TLA-01', passwordHash: staffPw, wardCode: 'DN-TLA', trustScore: 100 }),
    user({ id: 'u_staff_bp1', role: 'officer', name: 'Trần Hoàng Dũng', staffCode: 'CB-BP-01', passwordHash: staffPw, wardCode: 'DN-BP', trustScore: 100 }),
    user({ id: 'u_staff_city1', role: 'admin', name: 'Phạm Quốc Bảo', staffCode: 'TP-01', passwordHash: staffPw, trustScore: 100 }),
    // Đội cứu hộ (RESCUE: theo phường/xã & cơ động toàn thành phố)
    user({
      id: 'u_rescue_01',
      role: 'rescue',
      name: 'Đội Cứu Hộ Phản Ứng Nhanh Trung Tâm (Trấn Biên)',
      phone: '0900000114',
      staffCode: 'CUUHO-01',
      email: 'cuuho01@dongnai.gov.vn',
      passwordHash: staffPw,
      wardCode: 'DN-TB',
      unitCode: 'RESCUE-TB-01',
      trustScore: 100,
      badges: ['Đội Cứu Hộ SOS 24/7'],
    }),
    user({
      id: 'u_rescue_cd01',
      role: 'rescue',
      name: 'Đội Cứu Hộ Cơ Động Liên Khu Vực TP. Đồng Nai',
      phone: '0900000115',
      staffCode: 'CUUHO-CD-01',
      email: 'cuuho.codong@dongnai.gov.vn',
      passwordHash: staffPw,
      wardCode: null,
      unitCode: 'RESCUE-CITY-01',
      trustScore: 100,
      badges: ['Đội Cứu Hộ SOS 24/7', 'Cơ Động Toàn Thành Phố'],
    }),
    user({
      id: 'u_rescue_lt01',
      role: 'rescue',
      name: 'Đội Cứu Hộ Nam Đồng Nai (Long Thành - Cảng)',
      staffCode: 'CUUHO-LT-01',
      email: 'cuuho.longthanh@dongnai.gov.vn',
      passwordHash: staffPw,
      wardCode: 'DN-LTH',
      unitCode: 'RESCUE-LTH-01',
      trustScore: 100,
      badges: ['Đội Cứu Hộ SOS 24/7'],
    }),
    user({
      id: 'u_rescue_bp01',
      role: 'rescue',
      name: 'Đội Cứu Hộ Bắc Đồng Nai (Bình Phước - QL13/QL14)',
      staffCode: 'CUUHO-BP-01',
      email: 'cuuho.binhphuoc@dongnai.gov.vn',
      passwordHash: staffPw,
      wardCode: 'DN-BP',
      unitCode: 'RESCUE-BP-01',
      trustScore: 100,
      badges: ['Đội Cứu Hộ SOS 24/7'],
    }),
  ];
}

/** Đồng bộ đủ 95 Phường/Xã TP. Đồng Nai vào collection `wards` trên MongoDB Atlas (idempotent). */
async function ensureMongoWardsSeeded(): Promise<number> {
  const existingCount = await Ward.countDocuments().catch(() => 0);
  if (existingCount >= DONG_NAI_WARDS.length) return 0;
  const ops = DONG_NAI_WARDS.map((w) => ({
    updateOne: {
      filter: { wardCode: w.wardCode },
      update: {
        $set: {
          wardCode: w.wardCode,
          name: w.name,
          shortName: w.shortName,
          kind: w.kind,
          kindNq1662: w.upgradedOn2026 ? 'Xã' : w.kind,
          region: w.region,
          zone: w.zone,
          upgradedOn2026: w.upgradedOn2026,
          centerLat: w.centerLat,
          centerLng: w.centerLng,
          centerLocation: { type: 'Point' as const, coordinates: [w.centerLng, w.centerLat] as [number, number] },
          legacyAliases: [...w.legacyAliases],
          adjacentWardCodes: [...w.adjacentWardCodes],
          arterialRoads: [...w.arterialRoads],
        },
      },
      upsert: true,
    },
  }));
  const res = await Ward.bulkWrite(ops, { ordered: false });
  return res.upsertedCount ?? 0;
}

/**
 * Migration nhẹ tương thích ngược: chuyển toàn bộ role cũ (`super_admin`, `city_admin`, `ward_officer`,
 * `volunteer`, `rescue_team`) trong MongoDB (`app_users`, `users`) và Local Store về đúng 4 role chuẩn.
 */
export async function migrateLegacyRoles(repos: Repositories): Promise<number> {
  let migrated = 0;

  if (mongoose.connection.readyState === 1) {
    const roleMappings: ReadonlyArray<{ from: string[]; to: Role }> = [
      { from: ['super_admin', 'superadmin', 'city_admin', 'SUPER_ADMIN', 'ADMIN'], to: 'admin' },
      { from: ['ward_officer', 'volunteer', 'youth_union', 'OFFICER', 'YOUTH_UNION'], to: 'officer' },
      { from: ['rescue_team', 'cuu_ho', 'RESCUE_TEAM', 'RESCUE'], to: 'rescue' },
      { from: ['CITIZEN'], to: 'citizen' },
    ];
    for (const m of roleMappings) {
      const [r1, r2] = await Promise.all([
        UserModel.updateMany({ role: { $in: m.from } }, { $set: { role: m.to } }).catch(() => ({ modifiedCount: 0 })),
        User.updateMany({ role: { $in: m.from } }, { $set: { role: m.to } }).catch(() => ({ modifiedCount: 0 })),
      ]);
      migrated += (r1.modifiedCount ?? 0) + (r2.modifiedCount ?? 0);
    }
  }

  const allUsers = await repos.users.list().catch(() => [] as UserRecord[]);
  for (const u of allUsers) {
    const canonical = normalizeRole(u.role);
    if (u.role !== canonical) {
      await repos.users.save({ ...u, role: canonical });
      migrated += 1;
    }
  }
  return migrated;
}

export interface SeedOptions {
  /** Bật nạp dữ liệu mẫu kiểm thử (mặc định đọc từ `AUTO_SEED_DEMO_REPORTS`, chuẩn Production = `false`). */
  includeFixtures?: boolean;
}

/**
 * Khởi tạo nền tảng Idempotent:
 * - Mặc định Production (`AUTO_SEED_DEMO_REPORTS=false`):
 *   (1) Đồng bộ danh mục 95 Phường/Xã TP. Đồng Nai,
 *   (2) Chạy migration chuẩn hóa 4 vai trò (`ADMIN`, `OFFICER`, `RESCUE`, `CITIZEN`),
 *   (3) Đảm bảo duy nhất 1 tài khoản Quản trị viên (`ADMIN`) ban đầu nếu chưa có quản trị viên nào,
 *   (4) KHÔNG bơm bất kỳ hồ sơ sự cố mẫu/giả nào (`reports = 0`).
 */
export async function seedIfEmpty(
  repos: Repositories,
  audit: AuditService,
  options?: SeedOptions,
): Promise<{ reports: number; users: number; migratedRoles: number }> {
  let reports = 0;
  let users = 0;

  if (repos.mode === 'mongodb') {
    await ensureMongoWardsSeeded().catch((err) => {
      console.warn('[seed] Không thể đồng bộ bảng wards:', err instanceof Error ? err.message : String(err));
    });
  }

  const migratedRoles = await migrateLegacyRoles(repos).catch(() => 0);
  const includeFixtures = options?.includeFixtures ?? env.autoSeedDemoReports;

  if (!includeFixtures) {
    const initialAdmin = buildInitialAdminUser();
    const existingByCode =
      (await repos.users.getByStaffCode(initialAdmin.staffCode!)) ??
      (await repos.users.getByEmail(initialAdmin.email!)) ??
      (await repos.users.get(initialAdmin.id));

    if (!existingByCode) {
      const existingAdmins = await repos.users.list('admin');
      if ((await repos.users.count()) === 0 || existingAdmins.length === 0) {
        await repos.users.save(initialAdmin);
        users += 1;
      }
    } else if (env.superAdminPassword && initialAdmin.passwordHash) {
      // Nếu biến môi trường ADMIN_PASSWORD / SUPER_ADMIN_PASSWORD được khai báo tường minh thì đồng bộ lại mật khẩu
      await repos.users.save({
        ...existingByCode,
        role: 'admin',
        email: existingByCode.email ?? initialAdmin.email,
        staffCode: initialAdmin.staffCode,
        passwordHash: initialAdmin.passwordHash,
        revoked: false,
      });
    }
    return { reports, users, migratedRoles };
  }

  // Chế độ nạp đầy đủ fixture (chỉ khi AUTO_SEED_DEMO_REPORTS=true hoặc trong bộ unit/integration test)
  const seedUsers = buildSeedUsers();
  if ((await repos.users.count()) === 0) {
    for (const u of seedUsers) {
      await repos.users.save(u);
      users += 1;
    }
  } else {
    for (const staff of seedUsers.filter((u) => u.staffCode !== null)) {
      const existing = (await repos.users.getByStaffCode(staff.staffCode!)) ?? (await repos.users.get(staff.id));
      if (!existing) {
        await repos.users.save(staff);
        users += 1;
      } else if (staff.passwordHash) {
        await repos.users.save({
          ...existing,
          role: staff.role,
          email: existing.email ?? staff.email,
          staffCode: staff.staffCode,
          passwordHash: staff.passwordHash,
          revoked: false,
        });
      }
    }
  }

  if ((await repos.reports.count()) === 0) {
    for (const r of buildSeedReports()) {
      await repos.reports.insert(r);
      reports += 1;
    }
    await audit.log(SYSTEM_ACTOR, 'system.seed', 'seed', null, { reports, users });
  }
  return { reports, users, migratedRoles };
}

export interface PurgeDemoSummary {
  ok: true;
  deletedReports: number;
  deletedIncidents: number;
  deletedDemoUsers: number;
  deletedFingerprints: number;
  deletedEvaluations: number;
  remainingReports: number;
  remainingUsers: number;
  wardsPreserved: number;
}

function isSeededReport(r: { id: string; source?: string; ai?: { mode?: string }; title?: string }): boolean {
  return (
    r.source === 'seed' ||
    r.ai?.mode === 'seed' ||
    r.id.startsWith('rp_seed_') ||
    r.id.startsWith('rp_selftest_') ||
    Boolean(r.title && r.title.startsWith('[SELF-TEST]'))
  );
}

const DEMO_SEED_USER_IDS = new Set([
  'u_seed_vol1',
  'u_seed_vol2',
  'u_seed_vol3',
  'u_seed_vol4',
  userIdFromPhone('0900000001'),
  userIdFromPhone('0900000002'),
]);

/**
 * Xóa sạch toàn bộ hồ sơ sự cố giả/seed trước đó trên cả MongoDB Atlas lẫn Local Store,
 * giữ nguyên danh mục 95 Phường/Xã và các tài khoản vận hành thật.
 */
export async function purgeDemoData(
  repos: Repositories,
  audit?: AuditService,
  actor?: UserRecord,
): Promise<PurgeDemoSummary> {
  let deletedReports = 0;
  let deletedIncidents = 0;
  let deletedDemoUsers = 0;
  let deletedFingerprints = 0;
  let deletedEvaluations = 0;

  const currentReports = await repos.reports.list({});
  const seededIds = new Set<string>();
  for (const r of currentReports) {
    if (isSeededReport(r)) {
      seededIds.add(r.id);
      const removed = await repos.reports.delete(r.id);
      if (removed) deletedReports += 1;
    }
  }

  const currentUsers = await repos.users.list();
  for (const u of currentUsers) {
    if (actor && u.id === actor.id) continue;
    const isDemoUser =
      DEMO_SEED_USER_IDS.has(u.id) ||
      Boolean(u.email && u.email.endsWith('@dongnai.example'));
    if (isDemoUser) {
      const removed = await repos.users.delete(u.id);
      if (removed) deletedDemoUsers += 1;
    }
  }

  if (mongoose.connection.readyState === 1) {
    const mongoReportDel = await ReportModel.deleteMany({
      $or: [
        { source: 'seed' },
        { 'ai.mode': 'seed' },
        { id: /^rp_(?:seed|selftest)_/ },
        { syncId: /^seed_/ },
        { title: /^\[SELF-TEST\]/ },
      ],
    }).catch(() => ({ deletedCount: 0 }));
    deletedReports = Math.max(deletedReports, mongoReportDel.deletedCount ?? 0);

    const mongoIncDel = await Incident.deleteMany({
      $or: [
        { syncId: /^seed-/ },
        { clientOfflineId: /^seed-/ },
        { 'media.url': /smartcitizen-dongnai\.vn\/(?:pilot|seed)\// },
      ],
    }).catch(() => ({ deletedCount: 0 }));
    deletedIncidents = mongoIncDel.deletedCount ?? 0;

    if (seededIds.size > 0) {
      const ids = [...seededIds];
      const [fpDel, evDel] = await Promise.all([
        ImageFingerprintModel.deleteMany({ reportId: { $in: ids } }).catch(() => ({ deletedCount: 0 })),
        AiEvaluationModel.deleteMany({ reportId: { $in: ids } }).catch(() => ({ deletedCount: 0 })),
      ]);
      deletedFingerprints = fpDel.deletedCount ?? 0;
      deletedEvaluations = evDel.deletedCount ?? 0;
    }

    await SpamLog.deleteMany({ clientOfflineId: /^seed-/ }).catch(() => undefined);

    const mongoUserDel = await UserModel.deleteMany({
      ...(actor ? { id: { $ne: actor.id } } : {}),
      $or: [{ id: { $in: [...DEMO_SEED_USER_IDS] } }, { email: /@dongnai\.example$/i }],
    }).catch(() => ({ deletedCount: 0 }));
    deletedDemoUsers = Math.max(deletedDemoUsers, mongoUserDel.deletedCount ?? 0);

    await User.deleteMany({
      clientOfflineId: /^seed-user-(?:citizen|officer)-/,
    }).catch(() => undefined);

    await ensureMongoWardsSeeded().catch(() => 0);
  }

  // Đảm bảo vẫn còn tối thiểu 1 tài khoản ADMIN để quản trị hệ thống sau khi dọn dẹp
  const remainingAdmins = await repos.users.list('admin');
  if (remainingAdmins.length === 0) {
    await repos.users.save(buildInitialAdminUser());
  }

  const [remainingReports, remainingUsers] = await Promise.all([
    repos.reports.count(),
    repos.users.count(),
  ]);

  const summary: PurgeDemoSummary = {
    ok: true,
    deletedReports,
    deletedIncidents,
    deletedDemoUsers,
    deletedFingerprints,
    deletedEvaluations,
    remainingReports,
    remainingUsers,
    wardsPreserved: DONG_NAI_WARDS.length,
  };

  if (audit) {
    const auditActor = actor
      ? { id: actor.id, name: actor.name, role: normalizeRole(actor.role) }
      : SYSTEM_ACTOR;
    await audit.log(auditActor, 'admin.purge_seed_data', 'database', null, summary);
  }

  return summary;
}
