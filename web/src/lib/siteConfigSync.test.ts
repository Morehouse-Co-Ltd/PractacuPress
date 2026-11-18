import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebConfig } from '../types';
import { DEFAULT_ACCESS } from './access';
import { createRevisionStore } from './customizationSync';
import {
  SITE_CONFIG_SAVE_DEBOUNCE_MS,
  hydrateSiteConfig,
  scheduleSiteConfigSave,
  setActiveSiteConfigSaver,
  type SiteConfigApi,
  type SiteConfigSyncLogger,
} from './siteConfigSync';

function makeConfig(overrides: Partial<WebConfig> = {}): WebConfig {
  return {
    version: 1,
    setup_complete: true,
    mode: 'live',
    api_base: 'http://api.test',
    site_id: 'site_1',
    database: 'sqlite',
    created_at: '2026-01-01T00:00:00.000Z',
    docs_url: 'http://api.test/api/v1/docs',
    access: { ...DEFAULT_ACCESS, enabled: false },
    ...overrides,
  };
}

function makeStorage(initial: WebConfig) {
  let current: WebConfig | null = initial;
  return {
    read: () => current,
    write: (patch: Partial<WebConfig>) => {
      if (!current) return;
      current = { ...current, ...patch };
    },
    current: () => current,
  };
}

function makeLogger() {
  const warn = vi.fn();
  const logger: SiteConfigSyncLogger = { warn };
  return { logger, warn };
}

function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), {
    name: 'ApiError',
    problem: { status, code: 'x', message: 'x' },
  });
}

type Get = SiteConfigApi['siteConfig'];
type Put = SiteConfigApi['saveSiteConfig'];

function fakeApi(overrides: Partial<SiteConfigApi> = {}): SiteConfigApi {
  return {
    siteConfig: overrides.siteConfig ?? (async () => null),
    saveSiteConfig: overrides.saveSiteConfig ?? (async () => ({ revision: 1, updated_at: 'now' })),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  setActiveSiteConfigSaver(null);
});

describe('hydrateSiteConfig', () => {
  it('公开子集：开关写进本地配置，并记住 revision', async () => {
    const storage = makeStorage(makeConfig());
    const revisions = createRevisionStore();
    const get = vi.fn<Get>(async () => ({
      config: { access: { enabled: true, requests: { limit: 40 } }, admin_path: '/manage' },
      revision: 4,
      updated_at: 't',
      scope: 'public' as const,
    }));

    const result = await hydrateSiteConfig({
      read: storage.read,
      write: storage.write,
      api: fakeApi({ siteConfig: get }),
      siteId: 'site_1',
      revisions,
      logger: makeLogger().logger,
    });

    expect(result).toEqual({ status: 'applied', revision: 4, scope: 'public' });
    expect(revisions.get()).toBe(4);
    expect(storage.current()!.access!.enabled).toBe(true);
    expect(storage.current()!.access!.requests.limit).toBe(40);
    expect(storage.current()!.admin_path).toBe('/manage');
  });

  it('404 表示站点从未保存过配置：保留本地，revision 为 null', async () => {
    const storage = makeStorage(makeConfig({ admin_path: '/local-entry' }));
    const write = vi.fn(storage.write);

    const result = await hydrateSiteConfig({
      read: storage.read,
      write,
      api: fakeApi({ siteConfig: async () => null }),
      siteId: 'site_1',
      logger: makeLogger().logger,
    });

    expect(result.status).toBe('absent');
    expect(result.revision).toBeNull();
    expect(write).not.toHaveBeenCalled();
  });

  it('401 / 403 / 断网都降级成本地缓存，不抛错', async () => {
    for (const [error, expected] of [
      [httpError(401), 'unauthorized'],
      [httpError(403), 'forbidden'],
      [new Error('offline'), 'unavailable'],
    ] as const) {
      const storage = makeStorage(makeConfig());
      const result = await hydrateSiteConfig({
        read: storage.read,
        write: storage.write,
        api: fakeApi({ siteConfig: async () => Promise.reject(error) }),
        siteId: 'site_1',
        logger: makeLogger().logger,
      });
      expect(result.status).toBe(expected);
      expect(result.scope).toBeNull();
    }
  });

  it('没有本地配置（应该不会发生）时不发请求', async () => {
    const get = vi.fn<Get>(async () => null);
    const result = await hydrateSiteConfig({
      read: () => null,
      write: () => undefined,
      api: fakeApi({ siteConfig: get }),
      siteId: 'site_1',
      logger: makeLogger().logger,
    });
    expect(result.status).toBe('unavailable');
    expect(get).not.toHaveBeenCalled();
  });

  it('远端内容不是对象时保留本地', async () => {
    const storage = makeStorage(makeConfig());
    const write = vi.fn(storage.write);
    const result = await hydrateSiteConfig({
      read: storage.read,
      write,
      api: fakeApi({
        siteConfig: async () => ({ config: [1, 2], revision: 3, updated_at: 't', scope: 'public' }),
      }),
      siteId: 'site_1',
      logger: makeLogger().logger,
    });
    expect(result.status).toBe('unavailable');
    expect(write).not.toHaveBeenCalled();
  });
});

describe('scheduleSiteConfigSave', () => {
  it('防抖后写完整文档，带上最近读到的 revision', async () => {
    const storage = makeStorage(makeConfig({ access: { ...DEFAULT_ACCESS, enabled: true } }));
    const revisions = createRevisionStore(2);
    const put = vi.fn<Put>(async () => ({ revision: 3, updated_at: 't' }));
    const handle = scheduleSiteConfigSave({
      read: storage.read,
      api: fakeApi({ saveSiteConfig: put }),
      siteId: 'site_1',
      revisions,
      logger: makeLogger().logger,
      window: null,
      document: null,
    });

    handle();
    expect(put).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(SITE_CONFIG_SAVE_DEBOUNCE_MS);
    await handle.flush();

    expect(put).toHaveBeenCalledTimes(1);
    const [siteId, document, revision] = put.mock.calls[0];
    expect(siteId).toBe('site_1');
    expect(revision).toBe(2);
    expect((document as { access: { enabled: boolean } }).access.enabled).toBe(true);
    expect(revisions.get()).toBe(3);
    handle.dispose();
  });

  it('save() 在没有排队写入时也会立刻写一次（首次搬迁）', async () => {
    const storage = makeStorage(makeConfig());
    const revisions = createRevisionStore();
    const put = vi.fn<Put>(async () => ({ revision: 1, updated_at: 't' }));
    const handle = scheduleSiteConfigSave({
      read: storage.read,
      api: fakeApi({ saveSiteConfig: put }),
      siteId: 'site_1',
      revisions,
      logger: makeLogger().logger,
      window: null,
      document: null,
    });

    await handle.save();

    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][2]).toBeUndefined();
    expect(revisions.get()).toBe(1);
    handle.dispose();
  });

  it('409 时取回服务端 revision 重试一次', async () => {
    const storage = makeStorage(makeConfig());
    const revisions = createRevisionStore(2);
    const get = vi.fn<Get>(async () => ({
      config: { access: { enabled: true } },
      revision: 9,
      updated_at: 't',
      scope: 'admin' as const,
    }));
    const put = vi
      .fn<Put>()
      .mockRejectedValueOnce(httpError(409))
      .mockResolvedValueOnce({ revision: 10, updated_at: 't' });
    const handle = scheduleSiteConfigSave({
      read: storage.read,
      api: fakeApi({ siteConfig: get, saveSiteConfig: put }),
      siteId: 'site_1',
      revisions,
      logger: makeLogger().logger,
      window: null,
      document: null,
    });

    await handle.save();

    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[0][2]).toBe(2);
    expect(put.mock.calls[1][2]).toBe(9);
    expect(revisions.get()).toBe(10);
    handle.dispose();
  });

  it('403 之后停止自动保存并抛错给页面提示', async () => {
    const storage = makeStorage(makeConfig());
    const put = vi.fn<Put>().mockRejectedValue(httpError(403));
    const { logger, warn } = makeLogger();
    const handle = scheduleSiteConfigSave({
      read: storage.read,
      api: fakeApi({ saveSiteConfig: put }),
      siteId: 'site_1',
      revisions: createRevisionStore(),
      logger,
      window: null,
      document: null,
    });

    await expect(handle.save()).rejects.toBeDefined();
    expect(warn).toHaveBeenCalled();

    // 之后的编辑不再发请求：结论不会变，只会刷日志。
    handle();
    await vi.advanceTimersByTimeAsync(SITE_CONFIG_SAVE_DEBOUNCE_MS * 3);
    expect(put).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it('dispose 之后不再写回', async () => {
    const storage = makeStorage(makeConfig());
    const put = vi.fn<Put>(async () => ({ revision: 1, updated_at: 't' }));
    const handle = scheduleSiteConfigSave({
      read: storage.read,
      api: fakeApi({ saveSiteConfig: put }),
      siteId: 'site_1',
      revisions: createRevisionStore(),
      logger: makeLogger().logger,
      window: null,
      document: null,
    });

    handle();
    handle.dispose();
    await vi.advanceTimersByTimeAsync(SITE_CONFIG_SAVE_DEBOUNCE_MS * 3);
    expect(put).not.toHaveBeenCalled();
  });
});
