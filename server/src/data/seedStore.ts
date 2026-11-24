import { buildSeedReports } from '../../../shared/seed';
import { userIdFromPhone } from '../utils/crypto';
import { hashPassword } from '../utils/crypto';
import type { Repositories, UserRecord } from '../repositories/types';
import { SYSTEM_ACTOR, type AuditService } from '../services/audit.service';

export const DEMO_PASSWORD = 'Demo@2026';

function user(p: Partial<UserRecord> & Pick<UserRecord, 'id' | 'role' | 'name'>): UserRecord {
  return {
    phone: null, email: null, staffCode: null, passwordHash: null, wardCode: null, unitCode: null,
    trustScore: 70, badges: [], volunteerHours: 0, points: 0, notifications: [], createdAt: '2026-11-01T01:00:00.000Z', ...p,
  };
}

/** Tài khoản demo + dữ liệu tình nguyện mẫu (nhãn "dữ liệu mẫu" được nêu rõ trong README). */
export function buildSeedUsers(): UserRecord[] {
  const pw = hashPassword(DEMO_PASSWORD);
  return [
    user({ id: userIdFromPhone('0900000001'), role: 'citizen', name: 'Nguyễn Văn An', phone: '0900000001', trustScore: 82, badges: ['Công dân Văn minh Đồng Nai'] }),
    user({ id: userIdFromPhone('0900000002'), role: 'volunteer', name: 'Trần Minh Khoa', phone: '0900000002', wardCode: 'DN-TB', unitCode: 'DN-TB-01', trustScore: 90, volunteerHours: 38, points: 420, badges: ['Hỗ trợ Cộng đồng'] }),
    user({ id: 'u_seed_vol1', role: 'volunteer', name: 'Lê Thu Hà', phone: '0900000011', wardCode: 'DN-TB', unitCode: 'DN-TB-02', volunteerHours: 52, points: 610, badges: ['Hỗ trợ Cộng đồng'] }),
    user({ id: 'u_seed_vol2', role: 'volunteer', name: 'Phạm Quốc Việt', phone: '0900000012', wardCode: 'DN-BH', unitCode: 'DN-BH-01', volunteerHours: 31, points: 355 }),
    user({ id: 'u_seed_vol3', role: 'volunteer', name: 'Võ Ngọc Mai', phone: '0900000013', wardCode: 'DN-TDA', unitCode: 'DN-TDA-01', volunteerHours: 24, points: 270 }),
    user({ id: 'u_seed_vol4', role: 'volunteer', name: 'Đặng Hoài Nam', phone: '0900000014', wardCode: 'DN-LKH', unitCode: 'DN-LKH-01', volunteerHours: 19, points: 210 }),
    user({ id: 'u_staff_tb1', role: 'ward_officer', name: 'Lê Thị Hạnh', staffCode: 'CB-TB-01', passwordHash: pw, wardCode: 'DN-TB', trustScore: 100 }),
    user({ id: 'u_staff_tb2', role: 'ward_officer', name: 'Ngô Thanh Tùng', staffCode: 'CB-TB-02', passwordHash: pw, wardCode: 'DN-TB', trustScore: 100 }),
    user({ id: 'u_staff_bh1', role: 'ward_officer', name: 'Huỳnh Bảo Châu', staffCode: 'CB-BH-01', passwordHash: pw, wardCode: 'DN-BH', trustScore: 100 }),
    user({ id: 'u_staff_city1', role: 'city_admin', name: 'Phạm Quốc Bảo', staffCode: 'TP-01', passwordHash: pw, trustScore: 100 }),
  ];
}

/** Seed lần đầu: 80 hồ sơ (64 Trấn Biên + 16 liên phường) + tài khoản demo. Idempotent. */
export async function seedIfEmpty(repos: Repositories, audit: AuditService): Promise<{ reports: number; users: number }> {
  let reports = 0;
  let users = 0;
  if ((await repos.users.count()) === 0) {
    for (const u of buildSeedUsers()) {
      await repos.users.save(u);
      users += 1;
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
