import { describe, expect, it } from 'vitest';
import { RequestCache } from './requestCache';

describe('RequestCache', () => {
  it('deduplicates concurrent loads and caches the result', async () => {
    let calls = 0;
    const cache = new RequestCache({ now: () => 1000 });
    const loader = async () => {
      calls += 1;
      return { value: calls };
    };
    const [first, second] = await Promise.all([
      cache.load('same', 5000, loader),
      cache.load('same', 5000, loader),
    ]);
    expect(first).toEqual({ value: 1 });
    expect(second).toEqual({ value: 1 });
    expect(calls).toBe(1);

    const third = await cache.load('same', 5000, loader);
    expect(third).toEqual({ value: 1 });
    expect(calls).toBe(1);
  });

  it('expires entries after the TTL', async () => {
    let now = 0;
    let calls = 0;
    const cache = new RequestCache({ now: () => now });
    const loader = async () => ++calls;
    expect(await cache.load('key', 100, loader)).toBe(1);
    now = 100;
    expect(await cache.load('key', 100, loader)).toBe(2);
  });

  it('clears entries and bounds the number kept', async () => {
    const cache = new RequestCache({ maxEntries: 2 });
    let calls = 0;
    const loader = async () => ++calls;
    await cache.load('a', 1000, loader);
    await cache.load('b', 1000, loader);
    await cache.load('c', 1000, loader);
    expect(cache.size).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(await cache.load('a', 1000, loader)).toBe(4);
  });

  it('does not let a request resolve into the cache after clear', async () => {
    const cache = new RequestCache();
    let resolveOld!: (value: string) => void;
    const old = cache.load(
      'key',
      1000,
      () =>
        new Promise<string>((resolve) => {
          resolveOld = resolve;
        }),
    );
    cache.clear();
    resolveOld('old');
    await expect(old).resolves.toBe('old');
    expect(cache.size).toBe(0);

    let calls = 0;
    const fresh = await cache.load('key', 1000, async () => {
      calls += 1;
      return 'fresh';
    });
    expect(fresh).toBe('fresh');
    expect(calls).toBe(1);
  });

  it('does not cache when the TTL is zero', async () => {
    let calls = 0;
    const cache = new RequestCache();
    const loader = async () => ++calls;
    expect(await cache.load('key', 0, loader)).toBe(1);
    expect(await cache.load('key', 0, loader)).toBe(2);
    expect(cache.size).toBe(0);
  });
});
