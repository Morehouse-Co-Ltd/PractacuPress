import { describe, expect, it, vi } from 'vitest';
import {
  applyHotUpdate,
  autoCheckInterval,
  canSwapNow,
  captureSwapState,
  currentBuild,
  HOT_SWAP_STATE_KEY,
  isEditingElement,
  prefetchUpdateAssets,
  rememberBuild,
  restoreAfterSwap,
  shouldAnnounce,
  takeSwapState,
} from './hotUpdate';
import type { UpdateCheck } from './updateClient';

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function htmlResponse(status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      throw new Error('not json');
    },
  } as unknown as Response;
}

class MemoryStorage {
  private data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.has(key) ? (this.data.get(key) as string) : null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }
}

describe('no-downtime hot update', () => {
  it('recognises an element the user is typing into', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const block = document.createElement('p');
    expect(isEditingElement(input)).toBe(true);
    expect(isEditingElement(textarea)).toBe(true);
    expect(isEditingElement(editable)).toBe(true);
    expect(isEditingElement(block)).toBe(false);
    expect(isEditingElement(null)).toBe(false);
  });

  it('blocks the swap while busy, hidden or editing', () => {
    const makeDoc = (active: Element | null, visibility: DocumentVisibilityState) =>
      ({ activeElement: active, visibilityState: visibility, defaultView: null }) as unknown as Document;
    expect(canSwapNow({ busy: true })).toBe(false);
    expect(canSwapNow({ doc: makeDoc(null, 'hidden') })).toBe(false);
    expect(canSwapNow({ doc: makeDoc(document.createElement('input'), 'visible') })).toBe(false);
    expect(canSwapNow({ doc: makeDoc(document.createElement('p'), 'visible') })).toBe(true);
  });

  it('round-trips the scroll position through the swap', () => {
    const storage = new MemoryStorage();
    const state = captureSwapState('0.2.0', { storage, scrollY: 412.6, now: () => 1000 });
    expect(state).toEqual({ version: '0.2.0', scrollY: 413, at: 1000 });
    expect(takeSwapState(storage)).toEqual(state);
    // 读一次就清掉，避免下一次加载误用旧数据。
    expect(takeSwapState(storage)).toBeNull();
  });

  it('ignores a corrupted swap state', () => {
    const storage = new MemoryStorage();
    storage.setItem(HOT_SWAP_STATE_KEY, '{not json');
    expect(takeSwapState(storage)).toBeNull();
    storage.setItem(HOT_SWAP_STATE_KEY, JSON.stringify({ version: 42 }));
    expect(takeSwapState(storage)).toBeNull();
  });

  it('restores the scroll only for the version that was swapped in', () => {
    const storage = new MemoryStorage();
    captureSwapState('0.2.0', { storage, scrollY: 900 });
    const scrollTo = vi.fn();
    const other = restoreAfterSwap({
      currentVersion: '0.1.0',
      storage,
      win: { scrollTo } as unknown as Window,
    });
    expect(other).toBeNull();
    expect(scrollTo).not.toHaveBeenCalled();

    captureSwapState('0.2.0', { storage, scrollY: 900 });
    const restored = restoreAfterSwap({
      currentVersion: '0.2.0',
      storage,
      win: { scrollTo } as unknown as Window,
    });
    expect(restored?.scrollY).toBe(900);
    expect(scrollTo).toHaveBeenCalledWith({ top: 900, behavior: 'auto' });
  });

  it('remembers the build that is actually running', () => {
    const storage = new MemoryStorage();
    expect(currentBuild(storage)).toBe('');
    rememberBuild('0.2.0', storage);
    expect(currentBuild(storage)).toBe('0.2.0');
  });

  it('falls back to the browser storage when none is injected', () => {
    // 换版交接状态必须跨一次刷新存活，所以默认写 localStorage。
    rememberBuild('9.9.9');
    expect(currentBuild()).toBe('9.9.9');
    captureSwapState('9.9.9', { scrollY: 12 });
    expect(takeSwapState()?.scrollY).toBe(12);
    // 显式传 null 表示这次不要碰存储。
    rememberBuild('1.1.1', null);
    expect(currentBuild()).toBe('9.9.9');
  });

  it('prefetches same-origin assets only, once each', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      return value.includes('/broken') ? jsonResponse({}, 500) : jsonResponse({});
    });
    const result = await prefetchUpdateAssets(
      ['/assets/app-2.js', '/assets/app-2.js', '/assets/broken.js', 'https://cdn.example.com/x.js', '//cdn/x.js', ''],
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(result.ok).toEqual(['/assets/app-2.js']);
    expect(result.failed).toEqual(['/assets/broken.js']);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('never reloads while the user is typing', async () => {
    const reload = vi.fn();
    const result = await applyHotUpdate('0.2.0', {
      doc: {
        activeElement: document.createElement('textarea'),
        visibilityState: 'visible',
      } as unknown as Document,
      reload,
    });
    expect(result.status).toBe('blocked');
    expect(reload).not.toHaveBeenCalled();
  });

  it('keeps the old build running when an asset cannot be fetched', async () => {
    const reload = vi.fn();
    const storage = new MemoryStorage();
    const result = await applyHotUpdate('0.2.0', {
      assets: ['/assets/new.js'],
      doc: { activeElement: null, visibilityState: 'visible' } as unknown as Document,
      storage,
      fetchImpl: (async () => htmlResponse(404)) as unknown as typeof fetch,
      reload,
    });
    expect(result.status).toBe('failed');
    expect(result.failed).toEqual(['/assets/new.js']);
    expect(reload).not.toHaveBeenCalled();
    expect(takeSwapState(storage)).toBeNull();
  });

  it('swaps after the assets are warm and records the scroll position', async () => {
    const reload = vi.fn();
    const storage = new MemoryStorage();
    const result = await applyHotUpdate('0.2.0', {
      assets: ['/assets/new.js'],
      doc: { activeElement: null, visibilityState: 'visible' } as unknown as Document,
      storage,
      fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
      reload,
    });
    expect(result.status).toBe('swapped');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(currentBuild(storage)).toBe('0.2.0');
    expect(takeSwapState(storage)?.version).toBe('0.2.0');
  });

  it('only schedules a background check in automatic mode', () => {
    const interval = () => 86400000;
    expect(autoCheckInterval({ mode: 'manual', frequency: 'daily', channel: 'stable' }, interval)).toBe(0);
    expect(autoCheckInterval({ mode: 'auto', frequency: 'daily', channel: 'stable' }, interval)).toBe(86400000);
  });

  it('announces a version once', () => {
    const check: UpdateCheck = {
      local: { title: 'P', describe: 'd', version: '0.1.0', style: 'stable' },
      remote: { title: 'P', describe: 'd', version: '0.2.0', style: 'stable' },
      source: '/version.json',
      checked_at: '2026-11-15T00:00:00Z',
      server_side: true,
    };
    expect(shouldAnnounce(check, '0.1.0')).toBe(true);
    expect(shouldAnnounce(check, '0.1.0', '0.2.0')).toBe(false);
    expect(shouldAnnounce(check, '0.2.0')).toBe(false);
  });
});
