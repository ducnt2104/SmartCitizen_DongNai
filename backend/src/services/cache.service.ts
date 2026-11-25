import crypto from 'node:crypto';
import { LRUCache } from 'lru-cache';

interface CachedResponseEntry {
  body: unknown;
  etag: string;
  cachedAt: number;
}

/**
 * Bộ nhớ đệm LRU giới hạn chặt (tối đa 200 mục/nhóm, TTL 30s–5 phút) chống tràn RAM 512MB trên Render:
 * - `store`: `/api/incidents/map`, `/api/reports`, `/api/stats` (TTL 20–30s, xóa ngay khi có mutation)
 * - `alertsStore`: `/api/wards/:wardId/overview`, `/api/alerts`, `/api/weather`, `/api/bulletins`, `/api/ai/daily-digest`
 * - `wardsCache`: `/api/wards` (TTL 24h + ETag bất biến)
 */
export class CacheService {
  private readonly store = new LRUCache<string, CachedResponseEntry>({
    max: 200,
    ttl: 30_000,
  });

  private readonly alertsStore = new LRUCache<string, CachedResponseEntry>({
    max: 200,
    ttl: 60_000,
  });

  private readonly wardsCache = new LRUCache<string, CachedResponseEntry>({
    max: 10,
    ttl: 24 * 60 * 60 * 1000,
  });

  private buildEntry(body: unknown): CachedResponseEntry {
    const json = JSON.stringify(body);
    const etag = `"sc-${crypto.createHash('sha1').update(json).digest('hex').slice(0, 16)}"`;
    return { body, etag, cachedAt: Date.now() };
  }

  getReportCached(key: string): CachedResponseEntry | undefined {
    return this.store.get(key);
  }

  setReportCached(key: string, body: unknown, ttlMs?: number): CachedResponseEntry {
    const entry = this.buildEntry(body);
    this.store.set(key, entry, ttlMs ? { ttl: ttlMs } : undefined);
    return entry;
  }

  getAlertCached(key: string): CachedResponseEntry | undefined {
    return this.alertsStore.get(key);
  }

  setAlertCached(key: string, body: unknown, ttlMs?: number): CachedResponseEntry {
    const entry = this.buildEntry(body);
    this.alertsStore.set(key, entry, ttlMs ? { ttl: ttlMs } : undefined);
    return entry;
  }

  getWardsCached(key: string): CachedResponseEntry | undefined {
    return this.wardsCache.get(key);
  }

  setWardsCached(key: string, body: unknown, etag: string): CachedResponseEntry {
    const entry: CachedResponseEntry = { body, etag, cachedAt: Date.now() };
    this.wardsCache.set(key, entry);
    return entry;
  }

  /** Vô hiệu hóa tức thì cache hồ sơ Xã/Phường & kiểm tra tuyến đường khi danh sách sự cố thay đổi. */
  invalidateWardOverviews(): void {
    for (const key of this.alertsStore.keys()) {
      if (key.startsWith('ward_overview:') || key.startsWith('route_check:')) {
        this.alertsStore.delete(key);
      }
    }
  }

  /** Vô hiệu hóa tức thì toàn bộ cache map/summary/stats/wardOverview khi tạo mới, duyệt, cách ly hoặc giải quyết sự cố. */
  invalidateReports(): void {
    this.store.clear();
    this.invalidateWardOverviews();
  }

  /** Vô hiệu hóa tức thì cache cảnh báo, thời tiết, bản tin và tóm tắt AI khi có thay đổi mới. */
  invalidateAlerts(): void {
    this.alertsStore.clear();
  }

  get size(): number {
    return this.store.size + this.alertsStore.size + this.wardsCache.size;
  }
}

export const cacheService = new CacheService();
