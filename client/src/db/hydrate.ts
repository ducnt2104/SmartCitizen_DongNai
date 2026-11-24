import { buildSeedReports } from '@shared/seed';
import { toClientReport, computeStats } from '@shared/report';
import { DONG_NAI_WARDS } from '@shared/dongNaiWards';
import { PILOT_WARD_CODE } from '@shared/constants';
import { db, getSetting, putSetting } from './localDb';

const SEED_VERSION = '2026-11-v1';

/**
 * Instant Hydration: nạp bộ seed chuẩn (64 hồ sơ Trấn Biên + 16 liên phường) và danh mục 95 xã/phường
 * vào IndexedDB ở lần chạy đầu để UI đọc ngay (<30ms) mà không chờ mạng / Render cold-start.
 * Seed dùng CHUNG generator với server (shared/seed.ts) nên số liệu khớp tuyệt đối.
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
    await putSetting(`stats:ward:${PILOT_WARD_CODE}`, computeStats(seed.filter((r) => r.wardCode === PILOT_WARD_CODE), `ward:${PILOT_WARD_CODE}`));
    await putSetting('seedVersion', SEED_VERSION);
  });
  return { seeded: true, ms: performance.now() - t0 };
}
