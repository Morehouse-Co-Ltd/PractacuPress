/**
 * GET 请求去重 + 短缓存。
 *
 * 同一时刻的重复请求共享同一个 Promise；成功后按 TTL 缓存。写入、登录态变化
 * 和手动刷新都会清空缓存，避免把旧数据当成新数据。
 */

interface CacheEntry {
  value: unknown;
  expires: number;
}

export class RequestCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly maxEntries: number;
  private readonly now: () => number;
  /** 清空后，旧请求即使晚到也不能再写回缓存。 */
  private generation = 0;

  constructor(options: { maxEntries?: number; now?: () => number } = {}) {
    this.maxEntries = options.maxEntries ?? 60;
    this.now = options.now ?? Date.now;
  }

  async load<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    if (ttlMs <= 0) return loader();

    const cached = this.entries.get(key);
    if (cached && cached.expires > this.now()) return cached.value as T;
    if (cached) this.entries.delete(key);

    const pending = this.inflight.get(key);
    if (pending) return pending as Promise<T>;

    const generation = this.generation;
    const promise = loader()
      .then((value) => {
        if (generation === this.generation) this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => {
        if (generation === this.generation) this.inflight.delete(key);
      });
    this.inflight.set(key, promise);
    return promise;
  }

  private set(key: string, value: unknown, ttlMs: number): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expires: this.now() + ttlMs });
  }

  clear(): void {
    this.generation += 1;
    this.entries.clear();
    this.inflight.clear();
  }

  /** 仅供测试与调试。 */
  get size(): number {
    return this.entries.size;
  }
}
