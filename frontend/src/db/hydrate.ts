import { computeStats } from '@shared/report';
import { DONG_NAI_WARDS } from '@shared/dongNaiWards';
import { db, getSetting, putSetting } from './localDb';

const SEED_VERSION = '2026-11-prod-v3';

function isLegacySeedRecord(r: { id: string; source?: string; ai?: { mode?: string } }): boolean {
  return r.source === 'seed' || r.ai?.mode === 'seed' || r.id.startsWith('rp_seed_') || r.id.startsWith('rp_selftest_');
}

/** Xóa sạch mọi bản ghi khởi tạo cũ còn lưu trong IndexedDB trình duyệt, giữ nguyên đơn của người dùng. */
export async function purgeLocalSeedReports(): Promise<number> {
  let removed = 0;
  await db.transaction('rw', db.reports, db.settings, async () => {
    const all = await db.reports.toArray();
    const toDelete = all.filter((r) => isLegacySeedRecord(r) && r.syncState !== 'pending').map((r) => r.id);
    if (toDelete.length > 0) {
      await db.reports.bulkDelete(toDelete);
      removed = toDelete.length;
    }
    const remaining = await db.reports.toArray();
    await putSetting('stats:city', computeStats(remaining, 'city'));
  });
  return removed;
}

/**
 * Khởi tạo IndexedDB cục bộ: chỉ nạp danh mục chính thức 95 Phường/Xã (33 Phường, 62 Xã)
 * và tự động dọn sạch các bản ghi khởi tạo cũ nếu nâng cấp từ phiên bản trước.
 */
export async function hydrate(): Promise<{ seeded: boolean; ms: number }> {
  const t0 = performance.now();
  const version = await getSetting<string>('seedVersion', '');
  const wardsCount = await db.wards.count();
  if (version === SEED_VERSION && wardsCount >= DONG_NAI_WARDS.length) {
    return { seeded: false, ms: performance.now() - t0 };
  }

  await db.transaction('rw', db.reports, db.wards, db.settings, async () => {
    const allReports = await db.reports.toArray();
    const obsoleteIds = allReports
      .filter((r) => isLegacySeedRecord(r) && r.syncState !== 'pending')
      .map((r) => r.id);
    if (obsoleteIds.length > 0) {
      await db.reports.bulkDelete(obsoleteIds);
    }
    await db.wards.clear();
    await db.wards.bulkPut([...DONG_NAI_WARDS]);
    const remaining = await db.reports.toArray();
    await putSetting('stats:city', computeStats(remaining, 'city'));
    await putSetting('seedVersion', SEED_VERSION);
  });
  return { seeded: true, ms: performance.now() - t0 };
}
