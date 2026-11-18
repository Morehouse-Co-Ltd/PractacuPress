import { afterEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  AdminPageRegistry,
  adminPageGroup,
  adminPageIcon,
  adminPageRegistry,
  useAdminPages,
} from './adminRegistry';
import type { AdminPageDefinition } from './types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function page(overrides: Partial<AdminPageDefinition> = {}): AdminPageDefinition {
  return {
    id: 'reports',
    path: 'reports',
    label: '报表',
    icon: 'chart',
    render: () => null,
    ...overrides,
  };
}

let root: Root | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
    root = null;
  }
  document.body.innerHTML = '';
  adminPageRegistry.clearPlugin('test.hook');
});

describe('AdminPageRegistry 注册', () => {
  it('注册后按 order 再按注册顺序列出', () => {
    const registry = new AdminPageRegistry();
    registry.register('com.example.one', page({ id: 'b', path: 'b', order: 20 }));
    registry.register('com.example.one', page({ id: 'a', path: 'a', order: 10 }));
    registry.register('com.example.two', page({ id: 'c', path: 'c' }));

    expect(registry.list().map((entry) => entry.page.path)).toEqual(['c', 'a', 'b']);
    expect(registry.list()[0]).toMatchObject({
      pluginID: 'com.example.two',
      order: 0,
    });
    expect(registry.resolve('b')?.pluginID).toBe('com.example.one');
    expect(registry.resolve('nope')).toBeUndefined();
  });

  it('没有 order 时排在最后并按注册先后稳定排序', () => {
    const registry = new AdminPageRegistry();
    registry.register('p.one', page({ id: 'first', path: 'first' }));
    registry.register('p.one', page({ id: 'second', path: 'second' }));
    registry.register('p.two', page({ id: 'pinned', path: 'pinned', order: -1 }));

    expect(registry.list().map((entry) => entry.page.path)).toEqual([
      'pinned',
      'first',
      'second',
    ]);
  });

  it('path 与 plugin/id 重复注册会抛错，且不破坏已有条目', () => {
    const registry = new AdminPageRegistry();
    registry.register('p.one', page({ id: 'a', path: 'same' }));
    expect(() => registry.register('p.two', page({ id: 'b', path: 'same' }))).toThrow(
      'already registered',
    );
    expect(() => registry.register('p.one', page({ id: 'a', path: 'other' }))).toThrow(
      'already registered',
    );
    expect(registry.list()).toHaveLength(1);
  });

  it('拒绝非法定义（缺 id / path slug 非法 / 缺 label / 缺 render）', () => {
    const registry = new AdminPageRegistry();
    expect(() => registry.register('', page())).toThrow('plugin id');
    expect(() => registry.register('p.one', page({ id: '' }))).toThrow('page id');
    expect(() => registry.register('p.one', page({ path: 'Has Space' }))).toThrow('path');
    expect(() => registry.register('p.one', page({ path: '' }))).toThrow('path');
    expect(() => registry.register('p.one', page({ label: '' }))).toThrow('label');
    expect(() =>
      registry.register('p.one', page({ render: undefined as unknown as () => null })),
    ).toThrow('render');
    expect(registry.list()).toEqual([]);
  });

  it('list() 在无变化时返回同一个快照（useSyncExternalStore 不抖动）', () => {
    const registry = new AdminPageRegistry();
    registry.register('p.one', page());
    expect(registry.list()).toBe(registry.list());
  });
});

describe('AdminPageRegistry 清理', () => {
  it('disposer 只移除自己注册的页面，重复调用是空操作', () => {
    const registry = new AdminPageRegistry();
    const disposeA = registry.register('p.one', page({ id: 'a', path: 'a' }));
    registry.register('p.one', page({ id: 'b', path: 'b' }));

    disposeA();
    expect(registry.list().map((entry) => entry.page.id)).toEqual(['b']);
    disposeA();
    expect(registry.list().map((entry) => entry.page.id)).toEqual(['b']);
  });

  it('clearPlugin 只清理该插件的页面（停用/激活失败时的路径）', () => {
    const registry = new AdminPageRegistry();
    registry.register('p.one', page({ id: 'a', path: 'a' }));
    registry.register('p.one', page({ id: 'b', path: 'b' }));
    registry.register('p.two', page({ id: 'c', path: 'c' }));

    registry.clearPlugin('p.one');
    expect(registry.list().map((entry) => entry.pluginID)).toEqual(['p.two']);
    expect(registry.resolve('a')).toBeUndefined();

    registry.clearPlugin('p.one');
    expect(registry.list()).toHaveLength(1);
  });
});

describe('AdminPageRegistry 订阅', () => {
  it('注册 / 注销 / clearPlugin 都通知订阅者并推进 revision', () => {
    const registry = new AdminPageRegistry();
    let notified = 0;
    const unsubscribe = registry.subscribe(() => {
      notified += 1;
    });
    const before = registry.getVersion();

    const dispose = registry.register('p.one', page());
    expect(notified).toBe(1);
    expect(registry.getVersion()).toBeGreaterThan(before);

    dispose();
    expect(notified).toBe(2);

    registry.register('p.one', page());
    registry.clearPlugin('p.one');
    expect(notified).toBe(4);

    unsubscribe();
    registry.register('p.one', page({ id: 'z', path: 'z' }));
    expect(notified).toBe(4);
  });

  it('useAdminPages 随注册表实时更新（AdminShell 用的就是这条订阅）', async () => {
    function Probe() {
      const entries = useAdminPages();
      return createElement(
        'ul',
        null,
        entries.map((entry) =>
          createElement('li', { key: entry.page.path }, entry.page.label),
        ),
      );
    }

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(Probe));
    });
    expect(container.textContent).toBe('');

    await act(async () => {
      adminPageRegistry.register(
        'test.hook',
        page({ id: 'hooked', path: 'hooked', label: '挂钩页面' }),
      );
    });
    expect(container.textContent).toBe('挂钩页面');

    await act(async () => {
      adminPageRegistry.clearPlugin('test.hook');
    });
    expect(container.textContent).toBe('');
  });
});

describe('adminPageGroup / adminPageIcon', () => {
  it('group 缺省与未知值都归入 extensions，overview 原样保留', () => {
    expect(adminPageGroup({})).toBe('extensions');
    expect(adminPageGroup({ group: 'extensions' })).toBe('extensions');
    expect(adminPageGroup({ group: 'overview' })).toBe('overview');
    expect(adminPageGroup({ group: 'nope' as never })).toBe('extensions');
  });

  it('合法图标原样返回，未知 / 缺失回退 grid', () => {
    expect(adminPageIcon({ icon: 'activity' })).toBe('activity');
    expect(adminPageIcon({ icon: 'nope' as never })).toBe('grid');
    expect(adminPageIcon({})).toBe('grid');
  });
});
