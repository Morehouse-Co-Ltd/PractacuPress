import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpBackend } from './api';
import { configurePerformance, DEFAULT_PERFORMANCE } from './performance';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  configurePerformance(DEFAULT_PERFORMANCE);
});

describe('HttpBackend request cache', () => {
  it('collapses identical GETs when the setting is enabled', async () => {
    configurePerformance({
      ...DEFAULT_PERFORMANCE,
      request_cache: true,
      cache_ttl: 15,
    });
    const fetchMock = vi.fn(async () =>
      jsonResponse({ items: [], next_cursor: '', has_more: false }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const backend = new HttpBackend({ base: 'http://api.test', onExpired: () => undefined });

    await backend.listContent('article', { limit: 3 });
    await backend.listContent('article', { limit: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('invalidates the cache after a write', async () => {
    configurePerformance({
      ...DEFAULT_PERFORMANCE,
      request_cache: true,
      cache_ttl: 15,
    });
    const fetchMock = vi.fn(async () =>
      jsonResponse({ items: [], next_cursor: '', has_more: false }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const backend = new HttpBackend({ base: 'http://api.test', onExpired: () => undefined });

    await backend.listContent('article', { limit: 3 });
    await backend.listContent('article', { limit: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await backend.createDraft('article', { title: 'x', source_body: 'body' });
    await backend.listContent('article', { limit: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not cache when the setting is off', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ items: [], next_cursor: '', has_more: false }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const backend = new HttpBackend({ base: 'http://api.test', onExpired: () => undefined });

    await backend.listContent('article', { limit: 3 });
    await backend.listContent('article', { limit: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
