interface SwrRecord<T> {
  data: T;
  fetchedAt: number;
  staleAfterMs: number;
}

const MAX_SWR_ENTRIES = 80;
const swrStore = new Map<string, SwrRecord<unknown>>();

export function getSwrEntry<T>(key: string): { data: T; isStale: boolean } | undefined {
  const hit = swrStore.get(key);
  if (!hit) return undefined;
  // Refresh insertion order for LRU behavior
  swrStore.delete(key);
  swrStore.set(key, hit);
  return {
    data: hit.data as T,
    isStale: Date.now() - hit.fetchedAt > hit.staleAfterMs,
  };
}

export function setSwrEntry<T>(key: string, data: T, staleAfterMs = 20_000): void {
  if (swrStore.has(key)) {
    swrStore.delete(key);
  } else if (swrStore.size >= MAX_SWR_ENTRIES) {
    const oldestKey = swrStore.keys().next().value;
    if (oldestKey !== undefined) swrStore.delete(oldestKey);
  }
  swrStore.set(key, {
    data,
    fetchedAt: Date.now(),
    staleAfterMs,
  });
}

export function invalidateSwrPrefix(prefix: string): void {
  for (const key of swrStore.keys()) {
    if (key.startsWith(prefix)) {
      swrStore.delete(key);
    }
  }
}

export function clearSwrCache(): void {
  swrStore.clear();
}
