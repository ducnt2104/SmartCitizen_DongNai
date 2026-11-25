import { DONG_NAI_WARDS } from '../shared/dongNaiWards';
import { env } from '../config/env';
import { seedIfEmpty } from '../data/seedStore';
import { createRepositories } from '../repositories';
import { AuditService } from '../services/audit.service';

async function runSeed(): Promise<void> {
  console.log('[seed] Bắt đầu nạp dữ liệu chuẩn SmartCitizen Đồng Nai (Idempotent)...');
  const boot = await createRepositories();
  try {
    const audit = new AuditService(boot.repos.audit);
    const res = await seedIfEmpty(boot.repos, audit);
    const stats = await boot.repos.healthStats();
    console.log(`[seed] Chế độ lưu trữ: ${boot.repos.mode}`);
    console.log(`[seed] Đơn vị hành chính TP. Đồng Nai: ${DONG_NAI_WARDS.length} (33 Phường, 62 Xã)`);
    console.log(`[seed] Tài khoản Super Admin: ${env.superAdminCode} / ${env.superAdminEmail}`);
    console.log(`[seed] Mới nạp thêm: ${res.users} tài khoản, ${res.reports} phản ánh`);
    console.log(`[seed] Tổng hiện có trong DB: ${stats.counts.users} users, ${stats.counts.reports} reports, ${stats.counts.auditLogs} audit logs`);
  } finally {
    await boot.repos.close();
  }
}

runSeed()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[seed] Lỗi nạp dữ liệu:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
