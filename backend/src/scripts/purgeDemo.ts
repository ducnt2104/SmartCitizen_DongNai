import fs from 'node:fs';
import path from 'node:path';
import { env } from '../config/env';
import { migrateLegacyRoles, purgeDemoData } from '../data/seedStore';
import { createRepositories } from '../repositories';
import { createLocalPersistentRepositories } from '../repositories/sqliteRepositories';
import { AuditService } from '../services/audit.service';

async function main(): Promise<void> {
  console.log('[db:purge-demo] Đang kết nối cơ sở dữ liệu và dọn sạch hồ sơ mẫu/seed...');
  const boot = await createRepositories(undefined, { allowJsonFallback: true });
  try {
    const audit = new AuditService(boot.repos.audit);
    const migrated = await migrateLegacyRoles(boot.repos);
    const summary = await purgeDemoData(boot.repos, audit);

    // Đồng thời dọn sạch bộ đệm SQLite cục bộ nếu đang chạy song song với MongoDB Atlas
    if (boot.repos.mode === 'mongodb' && fs.existsSync(env.dataDir)) {
      const localRepos = createLocalPersistentRepositories(path.resolve(env.dataDir), {
        markWritesDirtyByDefault: false,
      });
      try {
        await migrateLegacyRoles(localRepos);
        await purgeDemoData(localRepos);
      } finally {
        await localRepos.close();
      }
    }

    console.log(
      `[db:purge-demo] Hoàn tất làm sạch dữ liệu:\n` +
        `  - Đã xóa hồ sơ phản ánh mẫu (reports): ${summary.deletedReports}\n` +
        `  - Đã xóa sự cố thí điểm (incidents): ${summary.deletedIncidents}\n` +
        `  - Đã xóa tài khoản mẫu: ${summary.deletedDemoUsers}\n` +
        `  - Đã chuẩn hóa vai trò cũ (4 roles): ${migrated}\n` +
        `  - Còn lại hồ sơ vận hành thật: ${summary.remainingReports} reports, ${summary.remainingUsers} users\n` +
        `  - Giữ nguyên danh mục hành chính: ${summary.wardsPreserved}/95 Phường/Xã TP. Đồng Nai`,
    );
  } finally {
    await boot.repos.close();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[db:purge-demo] Lỗi khi dọn dữ liệu mẫu:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
