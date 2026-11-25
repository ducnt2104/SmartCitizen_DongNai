/** LRU Cache đơn giản dựa trên thứ tự chèn của Map, có TTL tùy chọn. */
export class LruCache<K, V> {
  private readonly map = new Map<K, { value: V; expires: number }>();

  constructor(
    private readonly max: number,
    private readonly ttlMs: number = 0,
  ) {}

  get(key: K): V | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires && hit.expires < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expires: this.ttlMs ? Date.now() + this.ttlMs : 0 });
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next();
      if (!oldest.done) this.map.delete(oldest.value);
    }
  }

  get size(): number {
    return this.map.size;
  }
}
