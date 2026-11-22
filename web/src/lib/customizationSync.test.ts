import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SiteCustomization, WebConfig } from '../types';
import type { SiteCustomizationSnapshot } from './api';
import { DEFAULT_CUSTOMIZATION, readCustomization } from './customize';
import {
  SAVE_DEBOUNCE_MS,
  createRevisionStore,
  hydrateCustomization,
  scheduleCustomizationSave,
  type CustomizationApi,
  type CustomizationSyncLogger,
} from './customizationSync';

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
    customization: { ...DEFAULT_CUSTOMIZATION },
    ...overrides,
  };
}

/** 假存储：等价于 localStorage 的那份 `pp.web.config.v1`。 */
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
  const logger: CustomizationSyncLogger = { warn };
  return { logger, warn };
}

function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), {
    name: 'ApiError',
    problem: { status, code: status === 409 ? 'conflict' : 'permission_denied', message: 'x' },
  });
}

function fakeApi(overrides: Partial<CustomizationApi> = {}): CustomizationApi {
  return {
    siteCustomization: overrides.siteCustomization ?? (async () => null),
    saveSiteCustomization:
      overrides.saveSiteCustomization ?? (async () => ({ revision: 1, updated_at: 'now' })),
  };
}

/** 只关心断言的服务端答案。 */
type Put = CustomizationApi['saveSiteCustomization'];
type Get = CustomizationApi['siteCustomization'];

describe('hydrateCustomization', () => {
  it('远端有设计时替换本地配置、记住 revision，并走既有归一化器', async () => {
    const remote: SiteCustomizationSnapshot = {
      customization: {
        // 故意留一个越界枚举与缺失字段，确认经过 readCustomization 归一化。
        layout: { brand_sub: '远端品牌', header_style: 'weird' },
        custom_css: 'body { background: #000; }',
      },
      revision: 7,
      updated_at: '2026-10-01T00:00:00.000Z',
    };
    const storage = makeStorage(
      makeConfig({ customization: { ...DEFAULT_CUSTOMIZATION, custom_css: '本地设计' } }),
    );
    const revisions = createRevisionStore();
    const get = vi.fn<Get>(async () => remote);

    const result = await hydrateCustomization({
      read: storage.read,
      write: storage.write,
      api: fakeApi({ siteCustomization: get }),
      siteId: 'site_1',
      revisions,
      logger: makeLogger().logger,
    });

    expect(result.status).toBe('applied');
    expect(result.revision).toBe(7);
    expect(revisions.get()).toBe(7);
    expect(get).toHaveBeenCalledWith('site_1');

    const applied = storage.current()!.customization!;
    expect(applied.custom_css).toBe('body { background: #000; }');
    expect(applied.layout.brand_sub).toBe('远端品牌');
    // 归一化器把未知枚举收敛成默认值、把缺失的开关补成默认值。
    expect(applied.layout.header_style).toBe('classic');
    expect(applied.extensions.reading_progress).toBe(true);
  });

  it('水合不会把当前主题的编排投影到站点级 home/article', async () => {
    const legacy = (id: string) => ({
      id,
      type: 'text',
      title: id,
      props: {},
      animation: 'none',
      hidden: false,
    });
    const remote: SiteCustomizationSnapshot = {
      customization: {
        theme: { ...DEFAULT_CUSTOMIZATION.theme },
        layout: { variant: 'classic' },
        active_theme: 'theme_blank',
        themes: [{ id: 'theme_blank', name: '空白', note: '' }],
        theme_layouts: {
          theme_blank: { home: { blocks: [] }, article: { blocks: [] } },
        },
        home: { blocks: [legacy('legacy-home')] },
        article: { blocks: [legacy('legacy-article')] },
      } as unknown as SiteCustomization,
      revision: 8,
      updated_at: '2026-11-22T00:00:00.000Z',
    };
    const storage = makeStorage(makeConfig());

    const result = await hydrateCustomization({
      read: storage.read,
      write: storage.write,
      api: fakeApi({ siteCustomization: async () => remote }),
      siteId: 'site_1',
      revisions: createRevisionStore(),
      logger: makeLogger().logger,
    });

    expect(result.status).toBe('applied');
    const applied = storage.current()!.customization!;
    // 站点级兜底保留远端原值，不被当前空白主题的空白编排覆盖。
    expect(applied.home.blocks.map((block) => block.id)).toEqual(['legacy-home']);
    expect(applied.article?.blocks.map((block) => block.id)).toEqual(['legacy-article']);
    expect(applied.theme_layouts?.theme_blank?.home?.blocks).toHaveLength(0);

    // 渲染视图仍然投影当前主题自己的空白编排；切到没有条目的内置主题时，
    // 使用内置主题自己的默认编排，而不是站点级兜底。
    const effective = readCustomization({ customization: applied });
    expect(effective.home.blocks).toHaveLength(0);
    const defaultView = readCustomization({
      customization: { ...applied, active_theme: 'default' },
    });
    expect(defaultView.home.blocks.length).toBeGreaterThan(0);
    expect(defaultView.home.blocks.map((block) => block.id)).not.toEqual(['legacy-home']);
  });

  it('404 时保留本地设计：不写入、不抛错', async () => {
    const storage = makeStorage(
      makeConfig({ customization: { ...DEFAULT_CUSTOMIZATION, custom_css: '本地设计' } }),
    );
    const write = vi.fn(storage.write);

    const result = await hydrateCustomization({
      read: storage.read,
      write,
      api: fakeApi({ siteCustomization: async () => null }),
      siteId: 'site_1',
      logger: makeLogger().logger,
    });

    expect(result.status).toBe('absent');
    expect(result.revision).toBeNull();
    expect(write).not.toHaveBeenCalled();
    expect(storage.current()!.customization!.custom_css).toBe('本地设计');
  });

  it('断网时保留本地设计、不抛错', async () => {
    const storage = makeStorage(
      makeConfig({ customization: { ...DEFAULT_CUSTOMIZATION, custom_css: '本地设计' } }),
    );
    const write = vi.fn(storage.write);
    const { logger, warn } = makeLogger();

    const result = await hydrateCustomization({
      read: storage.read,
      write,
      api: fakeApi({
        siteCustomization: async () => {
          throw new Error('Failed to fetch');
        },
      }),
      siteId: 'site_1',
      logger,
    });

    expect(result.status).toBe('unavailable');
    expect(write).not.toHaveBeenCalled();
    expect(storage.current()!.customization!.custom_css).toBe('本地设计');
    expect(warn).toHaveBeenCalled();
  });

  it('401 / 403 静默吞掉：既不写入也不抛错', async () => {
    for (const status of [401, 403]) {
      const storage = makeStorage(
        makeConfig({ customization: { ...DEFAULT_CUSTOMIZATION, custom_css: '本地设计' } }),
      );
      const write = vi.fn(storage.write);

      const result = await hydrateCustomization({
        read: storage.read,
        write,
        api: fakeApi({
          siteCustomization: async () => {
            throw httpError(status);
          },
        }),
        siteId: 'site_1',
        logger: makeLogger().logger,
      });

      expect(result.status).toBe(status === 401 ? 'unauthorized' : 'forbidden');
      expect(write).not.toHaveBeenCalled();
      expect(storage.current()!.customization!.custom_css).toBe('本地设计');
    }
  });

  it('远端存了非对象时不覆盖本地设计', async () => {
    const storage = makeStorage(
      makeConfig({ customization: { ...DEFAULT_CUSTOMIZATION, custom_css: '本地设计' } }),
    );
    const write = vi.fn(storage.write);

    const result = await hydrateCustomization({
      read: storage.read,
      write,
      api: fakeApi({
        siteCustomization: async () => ({
          customization: 'not-an-object',
          revision: 4,
          updated_at: 'now',
        }),
      }),
      siteId: 'site_1',
      logger: makeLogger().logger,
    });

    expect(result.status).toBe('unavailable');
    expect(write).not.toHaveBeenCalled();
    expect(storage.current()!.customization!.custom_css).toBe('本地设计');
  });
});

describe('scheduleCustomizationSave', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('连续三次调用只产生一次 PUT，载荷是原始对象', async () => {
    const raw = {
      layout: { brand_sub: '原始' },
      custom_css: 'a { color: red; }',
      // 归一化器不认识这个字段：如果提交的是归一化副本，它会被悄悄丢掉。
      future_field: { keep: true },
    };
    const storage = makeStorage(
      makeConfig({ customization: raw as unknown as SiteCustomization }),
    );
    const put = vi.fn<Put>(async () => ({ revision: 3, updated_at: 't' }));
    const get = vi.fn<Get>(async () => null);
    const handle = scheduleCustomizationSave({
      read: storage.read,
      api: fakeApi({ siteCustomization: get, saveSiteCustomization: put }),
      siteId: 'site_1',
      revisions: createRevisionStore(),
      logger: makeLogger().logger,
      window: null,
      document: null,
    });

    handle();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS / 4);
    handle();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS / 4);
    handle();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS / 4);

    expect(put).not.toHaveBeenCalled();
    expect(handle.pending()).toBe(true);

    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    await handle.flush();

    expect(put).toHaveBeenCalledTimes(1);
    const [siteId, payload, revision] = put.mock.calls[0];
    expect(siteId).toBe('site_1');
    expect(payload).toBe(raw);
    expect(revision).toBeUndefined();
    expect(handle.pending()).toBe(false);
    handle.dispose();
  });

  it('写回前剔掉旧缓存里的高危自定义 CSS，其余字段保持原样', async () => {
    const raw = {
      layout: { brand_sub: '原始' },
      custom_css: 'body { color: #222; }\n@import url("https://evil.example/x.css");',
      future_field: { keep: true },
    };
    const storage = makeStorage(
      makeConfig({ customization: raw as unknown as SiteCustomization }),
    );
    const put = vi.fn<Put>(async () => ({ revision: 3, updated_at: 't' }));
    const handle = scheduleCustomizationSave({
      read: storage.read,
      api: fakeApi({ siteCustomization: vi.fn<Get>(async () => null), saveSiteCustomization: put }),
      siteId: 'site_1',
      revisions: createRevisionStore(),
      logger: makeLogger().logger,
      window: null,
      document: null,
    });

    handle();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    await handle.flush();

    const payload = put.mock.calls[0][1] as Record<string, unknown>;
    expect(payload).not.toBe(raw);
    expect(String(payload.custom_css)).toContain('color: #222');
    expect(String(payload.custom_css)).not.toContain('@import');
    expect(payload.future_field).toEqual({ keep: true });
    handle.dispose();
  });

  it('409 后采用服务端 revision 重试一次', async () => {
    const raw = { custom_css: '冲突前的内容' };
    const storage = makeStorage(
      makeConfig({ customization: raw as unknown as SiteCustomization }),
    );
    const revisions = createRevisionStore(2);
    const get = vi.fn<Get>(async () => ({
      customization: { custom_css: '别人写的' },
      revision: 9,
      updated_at: 't',
    }));
    const put = vi
      .fn<Put>()
      .mockRejectedValueOnce(httpError(409))
      .mockResolvedValueOnce({ revision: 10, updated_at: 't' });
    const handle = scheduleCustomizationSave({
      read: storage.read,
      api: fakeApi({ siteCustomization: get, saveSiteCustomization: put }),
      siteId: 'site_1',
      revisions,
      logger: makeLogger().logger,
      window: null,
      document: null,
    });

    handle();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    await handle.flush();

    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[0][2]).toBe(2);
    expect(put.mock.calls[1][2]).toBe(9);
    expect(put.mock.calls[1][1]).toBe(raw);
    expect(revisions.get()).toBe(10);
    expect(get).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it('第二次 409 时保留本地并停止，不抛错', async () => {
    const raw = { custom_css: '一直冲突' };
    const storage = makeStorage(
      makeConfig({ customization: raw as unknown as SiteCustomization }),
    );
    const revisions = createRevisionStore(2);
    const put = vi.fn<Put>().mockRejectedValue(httpError(409));
    const get = vi.fn<Get>(async () => ({
      customization: { custom_css: '别人写的' },
      revision: 9,
      updated_at: 't',
    }));
    const { logger, warn } = makeLogger();
    const handle = scheduleCustomizationSave({
      read: storage.read,
      api: fakeApi({ siteCustomization: get, saveSiteCustomization: put }),
      siteId: 'site_1',
      revisions,
      logger,
      window: null,
      document: null,
    });

    handle();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    await expect(handle.flush()).resolves.toBeUndefined();

    expect(put).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenCalledTimes(1);
    expect(revisions.get()).toBe(9);
    expect(storage.current()!.customization).toBe(raw);
    expect(warn).toHaveBeenCalled();
    handle.dispose();
  });

  it('403 只尝试一次，之后不再重试', async () => {
    const raw = { custom_css: '越权' };
    const storage = makeStorage(
      makeConfig({ customization: raw as unknown as SiteCustomization }),
    );
    const put = vi.fn<Put>().mockRejectedValue(httpError(403));
    const { logger, warn } = makeLogger();
    const handle = scheduleCustomizationSave({
      read: storage.read,
      api: fakeApi({ saveSiteCustomization: put }),
      siteId: 'site_1',
      logger,
      window: null,
      document: null,
    });

    handle();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS);
    await handle.flush();

    expect(put).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);

    // 再编辑一次：已经判定为越权，不再发请求，也不再刷日志。
    handle();
    await vi.advanceTimersByTimeAsync(SAVE_DEBOUNCE_MS * 3);
    await handle.flush();

    expect(put).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it('pagehide 时立刻发送等待中的保存，dispose 会摘掉监听', async () => {
    const raw = { custom_css: '离页前' };
    const storage = makeStorage(
      makeConfig({ customization: raw as unknown as SiteCustomization }),
    );
    const put = vi.fn<Put>(async () => ({ revision: 2, updated_at: 't' }));
    const listeners = new Map<string, () => void>();
    const fakeWindow = {
      addEventListener: (type: string, listener: () => void) => {
        listeners.set(type, listener);
      },
      removeEventListener: (type: string) => {
        listeners.delete(type);
      },
    };
    const handle = scheduleCustomizationSave({
      read: storage.read,
      api: fakeApi({ saveSiteCustomization: put }),
      siteId: 'site_1',
      logger: makeLogger().logger,
      window: fakeWindow,
      document: null,
    });

    handle();
    expect(put).not.toHaveBeenCalled();
    listeners.get('pagehide')?.();
    await handle.flush();

    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0][1]).toBe(raw);

    handle.dispose();
    expect(listeners.has('pagehide')).toBe(false);
  });
});
