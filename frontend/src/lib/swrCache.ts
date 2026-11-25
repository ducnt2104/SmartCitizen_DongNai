/**
 * Bộ nhớ đệm Stale-While-Revalidate (RAM LRU + localStorage) giúp:
 * - Hiển thị tức thì (0ms) dữ liệu đã lưu khi chuyển trang / quay lại / mở drawer.
 * - Giới hạn số mục & dung lượng để không làm đầy bộ nhớ trình duyệt hoặc quota localStorage.
 * - Tự động cập nhật dữ liệu mới âm thầm ở nền (dedupe request trùng khóa).
 */
export interface SwrEntry<T> {
  data: T;
  fetchedAt: number;
  staleAt: number;
}

interface StoredSwrEntry<T> extends SwrEntry<T> {
  v: 1;
}

const MAX_SWR_ENTRIES = 120;
const MAX_LOCAL_ENTRIES = 36;
const MAX_LOCAL_PAYLOAD_CHARS = 120_000;
const DEFAULT_MAX_AGE_MS = 10 * 60_000;
const LS_PREFIX = 'sc_swr_v1:';
const LS_INDEX_KEY = 'sc_swr_v1_index';

const cache = new Map<string, SwrEntry<unknown>>();
const inFlight = new Map<string, Promise<unknown>>();

function canUseLocalStorage(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
  } catch {
    return false;
  }
}

function readLsIndex(): string[] {
  if (!canUseLocalStorage()) return [];
  try {
    const raw = window.localStorage.getItem(LS_INDEX_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function writeLsIndex(keys: string[]): void {
  if (!canUseLocalStorage()) return;
  try {
    window.localStorage.setItem(LS_INDEX_KEY, JSON.stringify(keys));
  } catch {
    // Bỏ qua lỗi quota
  }
}

function readLocalEntry<T>(key: string, maxAgeMs: number): SwrEntry<T> | undefined {
  if (!canUseLocalStorage()) return undefined;
  try {
    const raw = window.localStorage.getItem(`${LS_PREFIX}${key}`);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<StoredSwrEntry<T>>;
    if (!parsed || typeof parsed.fetchedAt !== 'number' || typeof parsed.staleAt !== 'number' || !('data' in parsed)) {
      return undefined;
    }
    if (Date.now() - parsed.fetchedAt > maxAgeMs) {
      window.localStorage.removeItem(`${LS_PREFIX}${key}`);
      return undefined;
    }
    return {
      data: parsed.data as T,
      fetchedAt: parsed.fetchedAt,
      staleAt: parsed.staleAt,
    };
  } catch {
    return undefined;
  }
}

function writeLocalEntry<T>(key: string, entry: SwrEntry<T>): void {
  if (!canUseLocalStorage()) return;
  try {
    const payload = JSON.stringify({ v: 1, ...entry } satisfies StoredSwrEntry<T>);
    if (payload.length > MAX_LOCAL_PAYLOAD_CHARS) return;

    const index = readLsIndex().filter((k) => k !== key);
    while (index.length >= MAX_LOCAL_ENTRIES) {
      const oldest = index.shift();
      if (oldest) window.localStorage.removeItem(`${LS_PREFIX}${oldest}`);
    }
    try {
      window.localStorage.setItem(`${LS_PREFIX}${key}`, payload);
    } catch {
      // Nếu quota đầy, xóa bớt 1/2 cache cũ rồi thử lại 1 lần
      const drop = index.splice(0, Math.max(1, Math.floor(index.length / 2)));
      for (const k of drop) window.localStorage.removeItem(`${LS_PREFIX}${k}`);
      try {
        window.localStorage.setItem(`${LS_PREFIX}${key}`, payload);
      } catch {
        return;
      }
    }
    index.push(key);
    writeLsIndex(index);
  } catch {
    // Bỏ qua nếu serialization thất bại
  }
}

export function getSwrEntry<T>(key: string): { data: T; isStale: boolean } | undefined {
  const ramHit = cache.get(key);
  if (ramHit) {
    // LRU touch
    cache.delete(key);
    cache.set(key, ramHit);
    return {
      data: ramHit.data as T,
      isStale: Date.now() > ramHit.staleAt,
    };
  }

  const lsHit = readLocalEntry<T>(key, DEFAULT_MAX_AGE_MS);
  if (!lsHit) return undefined;
  if (cache.size >= MAX_SWR_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(key, lsHit);
  return {
    data: lsHit.data,
    isStale: Date.now() > lsHit.staleAt,
  };
}

export function setSwrEntry<T>(
  key: string,
  data: T,
  staleAfterMs = 20_000,
  options?: { persist?: boolean },
): void {
  const now = Date.now();
  const entry: SwrEntry<T> = {
    data,
    fetchedAt: now,
    staleAt: now + staleAfterMs,
  };
  if (cache.has(key)) {
    cache.delete(key);
  } else if (cache.size >= MAX_SWR_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) cache.delete(oldestKey);
  }
  cache.set(key, entry);
  if (options?.persist !== false) {
    writeLocalEntry(key, entry);
  }
}

export function invalidateSwrPrefix(prefix: string): void {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
  if (!canUseLocalStorage()) return;
  try {
    const index = readLsIndex();
    const kept: string[] = [];
    for (const k of index) {
      if (k.startsWith(prefix)) {
        window.localStorage.removeItem(`${LS_PREFIX}${k}`);
      } else {
        kept.push(k);
      }
    }
    writeLsIndex(kept);
  } catch {
    // Bỏ qua
  }
}

export function clearSwrCache(): void {
  cache.clear();
  if (!canUseLocalStorage()) return;
  try {
    for (const k of readLsIndex()) {
      window.localStorage.removeItem(`${LS_PREFIX}${k}`);
    }
    window.localStorage.removeItem(LS_INDEX_KEY);
  } catch {
    // Bỏ qua
  }
}

export interface FastFetchOptions<T> {
  /** Khoảng thời gian (ms) coi dữ liệu còn tươi; hết hạn vẫn trả ngay dữ liệu cũ và revalidate ở nền */
  staleMs?: number;
  /** Tuổi tối đa (ms) của cache localStorage trước khi bỏ qua */
  maxAgeMs?: number;
  /** Lưu bền vào localStorage để mở tab/trang sau hiện ngay 0ms (mặc định true) */
  persist?: boolean;
  /** Bắt buộc bỏ qua cache và tải lại mạng */
  forceRefresh?: boolean;
  /** Callback nhận bản cập nhật mới từ mạng sau khi đã trả về bản cache 0ms */
  onUpdate?: (fresh: T) => void;
}

/**
 * Trình tải SWR ưu tiên phản hồi 0ms:
 * - Nếu có cache (RAM hoặc localStorage còn hạn `maxAgeMs`), trả về ngay lập tức.
 * - Khi dữ liệu đã quá `staleMs` (hoặc truyền `onUpdate`), tự động tải ngầm (dedupe request trùng) và gọi `onUpdate(fresh)`.
 */
export async function fastFetch<T>(
  key: string,
  fetcher: () => Promise<T>,
  options: FastFetchOptions<T> = {},
): Promise<T> {
  const { staleMs = 20_000, maxAgeMs = DEFAULT_MAX_AGE_MS, persist = true, forceRefresh = false, onUpdate } = options;

  const runNetwork = (): Promise<T> => {
    const active = inFlight.get(key) as Promise<T> | undefined;
    if (active) return active;
    const p = fetcher()
      .then((fresh) => {
        setSwrEntry(key, fresh, staleMs, { persist });
        return fresh;
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, p);
    return p;
  };

  if (!forceRefresh) {
    let hit = getSwrEntry<T>(key);
    if (!hit && persist) {
      const ls = readLocalEntry<T>(key, maxAgeMs);
      if (ls) {
        cache.set(key, ls);
        hit = { data: ls.data, isStale: Date.now() > ls.staleAt };
      }
    }
    if (hit) {
      if (hit.isStale) {
        void runNetwork()
          .then((fresh) => {
            onUpdate?.(fresh);
          })
          .catch(() => {
            /* Giữ nguyên bản cache nếu mạng tạm gián đoạn */
          });
      }
      return hit.data;
    }
  }

  return runNetwork();
}
