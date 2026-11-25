import { DONG_NAI_WARDS } from '../shared/dongNaiWards';
import { env } from '../config/env';
import { Ward } from '../models';
import { buildSeedReports } from '../shared/seed';
import { hashPassword, userIdFromPhone } from '../utils/crypto';
import type { Repositories, UserRecord } from '../repositories/types';
import { SYSTEM_ACTOR, type AuditService } from '../services/audit.service';

export const INITIAL_STAFF_PASSWORD = process.env.INITIAL_STAFF_PASSWORD || 'DongNai@2026!';
export const INITIAL_SUPER_ADMIN_PASSWORD =
  env.superAdminPassword || process.env.SUPER_ADMIN_PASSWORD || INITIAL_STAFF_PASSWORD;

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

/** Tài khoản quản trị cao nhất (Super Admin) + IOC 2 cấp phủ đều 5 vùng Thành phố Đồng Nai + đội tình nguyện mẫu. */
export function buildSeedUsers(): UserRecord[] {
  const staffPw = hashPassword(INITIAL_STAFF_PASSWORD);
  const superPw = hashPassword(INITIAL_SUPER_ADMIN_PASSWORD);
  return [
    // Tài khoản SUPER_ADMIN quyền lực cao nhất (cấu hình qua SUPER_ADMIN_CODE, SUPER_ADMIN_EMAIL, SUPER_ADMIN_PASSWORD)
    user({
      id: 'u_super_admin',
      role: 'super_admin',
      name: 'Quản trị viên Tối cao (Super Admin)',
      email: env.superAdminEmail.toLowerCase(),
      staffCode: env.superAdminCode.toUpperCase(),
      passwordHash: superPw,
      trustScore: 100,
      badges: ['Super Admin Hệ thống'],
    }),
    user({ id: userIdFromPhone('0900000001'), role: 'citizen', name: 'Nguyễn Văn An', phone: '0900000001', email: 'an.nguyen@dongnai.example', defaultWardCode: 'DN-TB', trustScore: 82, badges: ['Công dân Văn minh Đồng Nai'] }),
    user({ id: userIdFromPhone('0900000002'), role: 'volunteer', name: 'Trần Minh Khoa', phone: '0900000002', email: 'khoa.tran@dongnai.example', wardCode: 'DN-TB', unitCode: 'DN-TB-01', trustScore: 90, volunteerHours: 38, points: 420, badges: ['Hỗ trợ Cộng đồng'] }),
    user({ id: 'u_seed_vol1', role: 'volunteer', name: 'Lê Thu Hà', phone: '0900000011', wardCode: 'DN-LTH', unitCode: 'DN-LTH-01', volunteerHours: 52, points: 610, badges: ['Hỗ trợ Cộng đồng'] }),
    user({ id: 'u_seed_vol2', role: 'volunteer', name: 'Phạm Quốc Việt', phone: '0900000012', wardCode: 'DN-BP', unitCode: 'DN-BP-01', volunteerHours: 34, points: 390 }),
    user({ id: 'u_seed_vol3', role: 'volunteer', name: 'Điểu Thị Hoa', phone: '0900000013', wardCode: 'DN-TLA', unitCode: 'DN-TLA-01', volunteerHours: 29, points: 315 }),
    user({ id: 'u_seed_vol4', role: 'volunteer', name: 'Đặng Hoài Nam', phone: '0900000014', wardCode: 'DN-LKH', unitCode: 'DN-LKH-01', volunteerHours: 22, points: 250 }),
    // Cán bộ 2 cấp: Phường/Xã đại diện 5 vùng + Ban Điều hành TP. Đồng Nai
    user({ id: 'u_staff_tb1', role: 'ward_officer', name: 'Lê Thị Hạnh', staffCode: 'CB-TB-01', passwordHash: staffPw, wardCode: 'DN-TB', trustScore: 100 }),
    user({ id: 'u_staff_lth1', role: 'ward_officer', name: 'Nguyễn Hữu Phước', staffCode: 'CB-LTH-01', passwordHash: staffPw, wardCode: 'DN-LTH', trustScore: 100 }),
    user({ id: 'u_staff_lkh1', role: 'ward_officer', name: 'Huỳnh Bảo Châu', staffCode: 'CB-LKH-01', passwordHash: staffPw, wardCode: 'DN-LKH', trustScore: 100 }),
    user({ id: 'u_staff_tla1', role: 'ward_officer', name: 'Điểu Văn Sơn', staffCode: 'CB-TLA-01', passwordHash: staffPw, wardCode: 'DN-TLA', trustScore: 100 }),
    user({ id: 'u_staff_bp1', role: 'ward_officer', name: 'Trần Hoàng Dũng', staffCode: 'CB-BP-01', passwordHash: staffPw, wardCode: 'DN-BP', trustScore: 100 }),
    user({ id: 'u_staff_city1', role: 'city_admin', name: 'Phạm Quốc Bảo', staffCode: 'TP-01', passwordHash: staffPw, trustScore: 100 }),
    // Đội Cứu Hộ & Ứng cứu Hiện trường chuyên trách (RESCUE_TEAM: theo phường/xã & cơ động toàn thành phố)
    user({
      id: 'u_rescue_01',
      role: 'rescue_team',
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
      role: 'rescue_team',
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
      role: 'rescue_team',
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
      role: 'rescue_team',
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

/** Seed idempotent: Super Admin + tài khoản IOC 2 cấp + 80 hồ sơ phủ đều toàn TP. Đồng Nai (chỉ nạp khi DB trống). */
export async function seedIfEmpty(repos: Repositories, audit: AuditService): Promise<{ reports: number; users: number }> {
  let reports = 0;
  let users = 0;
  if (repos.mode === 'mongodb') {
    await ensureMongoWardsSeeded().catch((err) => {
      console.warn('[seed] Không thể đồng bộ bảng wards:', err instanceof Error ? err.message : String(err));
    });
  }
  const seedUsers = buildSeedUsers();
  if ((await repos.users.count()) === 0) {
    for (const u of seedUsers) {
      await repos.users.save(u);
      users += 1;
    }
  } else {
    // Đảm bảo Super Admin & 6 tài khoản cán bộ IOC luôn tồn tại và đồng bộ mật khẩu từ biến môi trường
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
  return { reports, users };
}
