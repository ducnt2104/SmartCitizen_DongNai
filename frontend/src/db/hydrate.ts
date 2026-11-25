import { buildSeedReports } from '@shared/seed';
import { toClientReport, computeStats } from '@shared/report';
import { DONG_NAI_WARDS } from '@shared/dongNaiWards';
import { db, getSetting, putSetting } from './localDb';

const SEED_VERSION = '2026-04-95v2';

/**
 * Instant Hydration: nạp danh mục chính thức 95 Phường/Xã (33 Phường, 62 Xã) và bộ hồ sơ phân bổ
 * toàn Thành phố Đồng Nai vào IndexedDB ở lần chạy đầu (<30ms, hoạt động kể cả khi ngoại tuyến).
 */
export async function hydrate(): Promise<{ seeded: boolean; ms: number }> {
  const t0 = performance.now();
  const version = await getSetting<string>('seedVersion', '');
  const count = await db.reports.count();
  if (version === SEED_VERSION && count > 0) return { seeded: false, ms: performance.now() - t0 };

  const seed = buildSeedReports().map((r) => ({ ...toClientReport(r), syncState: 'synced' as const }));
  await db.transaction('rw', db.reports, db.wards, db.settings, async () => {
    const pending = await db.reports.where('syncState').equals('pending').toArray();
    await db.reports.clear();
    await db.reports.bulkPut(seed);
    if (pending.length) await db.reports.bulkPut(pending);
    await db.wards.clear();
    await db.wards.bulkPut([...DONG_NAI_WARDS]);
    await putSetting('stats:city', computeStats(seed, 'city'));
    await putSetting('seedVersion', SEED_VERSION);
  });
  return { seeded: true, ms: performance.now() - t0 };
}
