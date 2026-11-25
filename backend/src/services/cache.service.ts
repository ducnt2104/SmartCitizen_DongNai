import crypto from 'node:crypto';
import { LRUCache } from 'lru-cache';

interface CachedResponseEntry {
  body: unknown;
  etag: string;
  cachedAt: number;
}

/**
 * Bộ nhớ đệm LRU giới hạn chặt (tối đa 150 mục) cho các endpoint đọc mật độ cao:
 * - `/api/incidents/map`, `/api/reports/summary` (TTL 20s, vô hiệu hóa tức thì khi có mutation)
 * - `/api/stats` (TTL 30s, vô hiệu hóa tức thì khi có mutation)
 * - `/api/wards` (TTL 24h + ETag bất biến)
 */
export class CacheService {
  private readonly store = new LRUCache<string, CachedResponseEntry>({
    max: 150,
    ttl: 30_000,
  });

  private readonly wardsCache = new LRUCache<string, CachedResponseEntry>({
    max: 10,
    ttl: 24 * 60 * 60 * 1000,
  });

  getReportCached(key: string): CachedResponseEntry | undefined {
    return this.store.get(key);
  }

  setReportCached(key: string, body: unknown, ttlMs?: number): CachedResponseEntry {
    const json = JSON.stringify(body);
    const etag = `"sc-${crypto.createHash('sha1').update(json).digest('hex').slice(0, 16)}"`;
    const entry: CachedResponseEntry = { body, etag, cachedAt: Date.now() };
    this.store.set(key, entry, ttlMs ? { ttl: ttlMs } : undefined);
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

  /** Vô hiệu hóa tức thì toàn bộ cache map/summary/stats khi tạo mới, duyệt, cách ly hoặc giải quyết sự cố. */
  invalidateReports(): void {
    this.store.clear();
  }

  get size(): number {
    return this.store.size + this.wardsCache.size;
  }
}

export const cacheService = new CacheService();
