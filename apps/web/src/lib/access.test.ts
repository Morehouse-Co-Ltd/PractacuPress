import { describe, expect, it } from 'vitest';
import type { AccessSettings } from '../types';
import {
  AccessController,
  DEFAULT_ACCESS,
  readAccess,
  type AccessBlockState,
  type AccessBlockStore,
} from './access';

function memoryStore(): AccessBlockStore {
  let state: AccessBlockState | null = null;
  return {
    read: () => state,
    write: (next) => {
      state = next;
    },
    clear: () => {
      state = null;
    },
  };
}

function settings(over: Partial<AccessSettings> = {}): AccessSettings {
  return {
    ...DEFAULT_ACCESS,
    enabled: true,
    page_switch: { enabled: true, limit: 2, window_seconds: 10, block_seconds: 5 },
    requests: { enabled: true, limit: 3, window_seconds: 10, block_seconds: 5 },
    tabs: { enabled: false, limit: 4 },
    ...over,
  };
}

describe('readAccess', () => {
  it('clamps malformed rules back into safe ranges', () => {
    const parsed = readAccess({
      access: {
        enabled: true,
        page_switch: { enabled: true, limit: 0, window_seconds: 99999, block_seconds: -1 },
        requests: { enabled: false, limit: 999999, window_seconds: 0, block_seconds: 1 },
        tabs: { enabled: true, limit: 999 },
        message: 'x'.repeat(300),
      },
    });
    expect(parsed.page_switch.limit).toBe(1);
    expect(parsed.page_switch.window_seconds).toBe(3600);
    expect(parsed.page_switch.block_seconds).toBe(1);
    expect(parsed.requests.limit).toBe(10000);
    expect(parsed.requests.window_seconds).toBe(1);
    expect(parsed.tabs.limit).toBe(64);
    expect(parsed.message).toHaveLength(200);
  });

  it('keeps protection off for legacy configs', () => {
    expect(readAccess({}).enabled).toBe(false);
  });
});

describe('AccessController', () => {
  it('allows everything while disabled', () => {
    let now = 0;
    const controller = new AccessController({
      now: () => now,
      store: memoryStore(),
    });
    controller.configure({ ...settings(), enabled: false });
    for (let index = 0; index < 20; index += 1) {
      expect(controller.checkPageSwitch('/').allowed).toBe(true);
      expect(controller.beforeRequest('/').allowed).toBe(true);
    }
    expect(controller.snapshot().reason).toBeNull();
  });

  it('blocks after the page-switch budget and recovers when the block expires', () => {
    let now = 1000;
    const controller = new AccessController({ now: () => now, store: memoryStore() });
    controller.configure(settings(), '/manage');

    expect(controller.checkPageSwitch('/').allowed).toBe(true);
    expect(controller.checkPageSwitch('/articles').allowed).toBe(true);
    const blocked = controller.checkPageSwitch('/posts');
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('page_switch');
    expect(blocked.retryAfterMs).toBe(5000);
    expect(controller.snapshot().reason).toBe('page_switch');

    // 后台与登录路径不应被拦，否则站长无法回后台解除限制。
    expect(controller.checkPageSwitch('/manage/settings').allowed).toBe(true);
    expect(controller.checkPageSwitch('/login').allowed).toBe(true);

    now += 5000;
    expect(controller.checkPageSwitch('/posts').allowed).toBe(true);
    expect(controller.snapshot().reason).toBeNull();
  });

  it('blocks requests independently of page switches', () => {
    let now = 0;
    const controller = new AccessController({ now: () => now, store: memoryStore() });
    controller.configure(
      settings({
        page_switch: { enabled: false, limit: 2, window_seconds: 10, block_seconds: 5 },
        requests: { enabled: true, limit: 2, window_seconds: 10, block_seconds: 5 },
      }),
    );
    expect(controller.beforeRequest('/').allowed).toBe(true);
    expect(controller.beforeRequest('/').allowed).toBe(true);
    const blocked = controller.beforeRequest('/');
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toBe('request');
    expect(controller.snapshot().requests).toBe(0);
    now += 5000;
    expect(controller.beforeRequest('/').allowed).toBe(true);
  });

  it('persists an active block across controllers sharing the same store', () => {
    const store = memoryStore();
    const now = 5000;
    const first = new AccessController({ now: () => now, store });
    first.configure(settings());
    first.checkPageSwitch('/');
    first.checkPageSwitch('/a');
    expect(first.checkPageSwitch('/b').allowed).toBe(false);

    const second = new AccessController({ now: () => now, store });
    second.configure(settings());
    expect(second.snapshot().reason).toBe('page_switch');
    expect(second.snapshot().retryAfterMs).toBe(5000);
    second.clear();
    expect(second.snapshot().reason).toBeNull();
  });

  it('clears the block when protection is disabled by a new config', () => {
    const controller = new AccessController({ now: () => 0, store: memoryStore() });
    controller.configure(settings());
    controller.checkPageSwitch('/');
    controller.checkPageSwitch('/a');
    controller.checkPageSwitch('/b');
    expect(controller.snapshot().reason).toBe('page_switch');
    controller.configure({ ...settings(), enabled: false });
    expect(controller.snapshot().reason).toBeNull();
  });
});
