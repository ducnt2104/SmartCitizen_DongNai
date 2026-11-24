import { buildSeedReports } from '../../../shared/seed';
import { hashPassword, userIdFromPhone } from '../utils/crypto';
import type { Repositories, UserRecord } from '../repositories/types';
import { SYSTEM_ACTOR, type AuditService } from '../services/audit.service';

export const INITIAL_STAFF_PASSWORD = process.env.INITIAL_STAFF_PASSWORD || 'DongNai@2026!';

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

/** Tài khoản quản trị 2 cấp khởi tạo phủ đều 5 vùng Thành phố Đồng Nai + đội tình nguyện mẫu. */
export function buildSeedUsers(): UserRecord[] {
  const pw = hashPassword(INITIAL_STAFF_PASSWORD);
  return [
    user({ id: userIdFromPhone('0900000001'), role: 'citizen', name: 'Nguyễn Văn An', phone: '0900000001', email: 'an.nguyen@dongnai.example', defaultWardCode: 'DN-TB', trustScore: 82, badges: ['Công dân Văn minh Đồng Nai'] }),
    user({ id: userIdFromPhone('0900000002'), role: 'volunteer', name: 'Trần Minh Khoa', phone: '0900000002', email: 'khoa.tran@dongnai.example', wardCode: 'DN-TB', unitCode: 'DN-TB-01', trustScore: 90, volunteerHours: 38, points: 420, badges: ['Hỗ trợ Cộng đồng'] }),
    user({ id: 'u_seed_vol1', role: 'volunteer', name: 'Lê Thu Hà', phone: '0900000011', wardCode: 'DN-LTH', unitCode: 'DN-LTH-01', volunteerHours: 52, points: 610, badges: ['Hỗ trợ Cộng đồng'] }),
    user({ id: 'u_seed_vol2', role: 'volunteer', name: 'Phạm Quốc Việt', phone: '0900000012', wardCode: 'DN-BP', unitCode: 'DN-BP-01', volunteerHours: 34, points: 390 }),
    user({ id: 'u_seed_vol3', role: 'volunteer', name: 'Điểu Thị Hoa', phone: '0900000013', wardCode: 'DN-TLA', unitCode: 'DN-TLA-01', volunteerHours: 29, points: 315 }),
    user({ id: 'u_seed_vol4', role: 'volunteer', name: 'Đặng Hoài Nam', phone: '0900000014', wardCode: 'DN-LKH', unitCode: 'DN-LKH-01', volunteerHours: 22, points: 250 }),
    // Cán bộ 2 cấp: Phường/Xã đại diện 5 vùng + Ban Điều hành TP. Đồng Nai
    user({ id: 'u_staff_tb1', role: 'ward_officer', name: 'Lê Thị Hạnh', staffCode: 'CB-TB-01', passwordHash: pw, wardCode: 'DN-TB', trustScore: 100 }),
    user({ id: 'u_staff_lth1', role: 'ward_officer', name: 'Nguyễn Hữu Phước', staffCode: 'CB-LTH-01', passwordHash: pw, wardCode: 'DN-LTH', trustScore: 100 }),
    user({ id: 'u_staff_lkh1', role: 'ward_officer', name: 'Huỳnh Bảo Châu', staffCode: 'CB-LKH-01', passwordHash: pw, wardCode: 'DN-LKH', trustScore: 100 }),
    user({ id: 'u_staff_tla1', role: 'ward_officer', name: 'Điểu Văn Sơn', staffCode: 'CB-TLA-01', passwordHash: pw, wardCode: 'DN-TLA', trustScore: 100 }),
    user({ id: 'u_staff_bp1', role: 'ward_officer', name: 'Trần Hoàng Dũng', staffCode: 'CB-BP-01', passwordHash: pw, wardCode: 'DN-BP', trustScore: 100 }),
    user({ id: 'u_staff_city1', role: 'city_admin', name: 'Phạm Quốc Bảo', staffCode: 'TP-01', passwordHash: pw, trustScore: 100 }),
  ];
}

/** Seed lần đầu: 80 hồ sơ phủ đều toàn TP. Đồng Nai + tài khoản khởi tạo. Idempotent & đồng bộ mật khẩu cán bộ theo INITIAL_STAFF_PASSWORD. */
export async function seedIfEmpty(repos: Repositories, audit: AuditService): Promise<{ reports: number; users: number }> {
  let reports = 0;
  let users = 0;
  const seedUsers = buildSeedUsers();
  if ((await repos.users.count()) === 0) {
    for (const u of seedUsers) {
      await repos.users.save(u);
      users += 1;
    }
  } else {
    // Đảm bảo 6 tài khoản cán bộ IOC 2 cấp luôn tồn tại trong MongoDB và đồng bộ đúng INITIAL_STAFF_PASSWORD hiện hành
    for (const staff of seedUsers.filter((u) => u.staffCode !== null)) {
      const existing = await repos.users.getByStaffCode(staff.staffCode!);
      if (!existing) {
        await repos.users.save(staff);
        users += 1;
      } else if (staff.passwordHash) {
        await repos.users.save({ ...existing, passwordHash: staff.passwordHash, revoked: false });
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
