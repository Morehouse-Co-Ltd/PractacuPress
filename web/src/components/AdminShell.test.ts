import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * AdminShell 的导航必须真的消费 adminPageRegistry，而不是继续写死性能面板那一行。
 *
 * 这里不渲染整个 App（那会牵扯安装配置与后端），只把 AdminShell 依赖的登录态 /
 * 权限 / 后端 / 后台明暗模式换成稳定的假实现，然后断言：
 * - 内置扩展 pp.performance 注册的页面出现在「概览」分组、紧贴仪表盘；
 * - 非平台管理员看不到 overview 组的扩展页；
 * - extensions 组的页面进入「扩展页面」新分组；
 * - 标题取注册页 label（旧的 /admin/system 标题映射已移除）；
 * - 旧地址 /admin/system 的 nav 项已不存在。
 */

const state = vi.hoisted(() => ({
  role: 'platform_admin' as string,
  permission: true,
}));

/** 稳定的后端桩：每个组件渲染都返回同一个对象，避免 useMediaSrc 的 effect 依赖抖动。 */
const backendStub = vi.hoisted(() => ({
  origin: 'http://api.test',
  listContent: async () => ({ items: [] }),
  allComments: async () => ({ items: [], counts: {} }),
  reports: async () => [],
}));

vi.mock('../lib/session', () => ({
  useAuth: () => ({
    me: {
      role: state.role,
      user: { id: 'u1', display_name: 'Admin', email: 'admin@example.com' },
    },
    site: { name: 'Practacu', domain: 'press.local' },
    logout: async () => undefined,
    config: { mode: 'demo' },
  }),
}));

vi.mock('../lib/backend', () => ({
  isDemo: () => true,
  useBackend: () => backendStub,
}));

vi.mock('../lib/usePermissions', () => ({
  usePermissions: () => ({ can: () => state.permission, personal: false }),
}));

vi.mock('../lib/adminTheme', () => ({
  useAdminTheme: () => ({ mode: 'light', setMode: () => undefined, toggle: () => undefined }),
}));

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AdminShell } from './AdminShell';
import { adminPageRegistry } from '../lib/plugins/adminRegistry';
// 副作用导入：内置扩展（性能面板）在导入时注册到 adminPageRegistry。
import '../lib/extensions/builtin';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement;

const TEST_PLUGIN = 'test.adminshell';

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  adminPageRegistry.clearPlugin(TEST_PLUGIN);
  state.role = 'platform_admin';
  state.permission = true;
});

async function renderAt(path: string): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(
          Routes,
          null,
          createElement(
            Route,
            { path: '/admin', element: createElement(AdminShell) },
            createElement(Route, { index: true, element: createElement('div', null, 'dashboard') }),
            createElement(Route, {
              path: 'ext/:pageId',
              element: createElement('div', { id: 'ext-outlet' }, 'extension page'),
            }),
          ),
        ),
      ),
    );
  });
}

function navHrefs(): string[] {
  return [...container.querySelectorAll<HTMLAnchorElement>('.admin-nav a')].map(
    (link) => link.getAttribute('href') ?? '',
  );
}

function navLabels(): string[] {
  return [...container.querySelectorAll<HTMLAnchorElement>('.admin-nav a')].map(
    (link) => link.textContent?.trim() ?? '',
  );
}

describe('AdminShell 的扩展导航', () => {
  it('左上角显示管理员身份卡，而不是站点域名', async () => {
    await renderAt('/admin');

    const card = container.querySelector('.admin-identity');
    expect(card).not.toBeNull();
    expect(card?.getAttribute('href')).toBe('/me');
    expect(card?.querySelector('.admin-identity-name')?.textContent).toBe('Admin');
    expect(card?.querySelector('.admin-identity-email')?.textContent).toBe('admin@example.com');
    expect(card?.querySelector('.admin-identity-online')).not.toBeNull();
    expect(container.textContent).not.toContain('press.local');
  });

  it('「站点更新」排在「登录设置」之后', async () => {
    await renderAt('/admin');

    const hrefs = navHrefs();
    const loginIndex = hrefs.indexOf('/admin/login-settings');
    const updateIndex = hrefs.indexOf('/admin/update');
    expect(loginIndex).toBeGreaterThanOrEqual(0);
    expect(updateIndex).toBeGreaterThan(loginIndex);
  });

  it('性能面板（内置扩展注册）出现在仪表盘之后，旧写死入口已移除', async () => {
    await renderAt('/admin');

    const hrefs = navHrefs();
    expect(hrefs[0]).toBe('/admin');
    expect(hrefs).toContain('/admin/ext/system');
    expect(hrefs.indexOf('/admin/ext/system')).toBe(1);
    expect(navLabels()).toContain('性能面板');
    expect(hrefs).not.toContain('/admin/system');
  });

  it('非平台管理员看不到 overview 组扩展页', async () => {
    state.role = 'admin';
    await renderAt('/admin');

    expect(navHrefs()).not.toContain('/admin/ext/system');
  });

  it('extensions 组的页面单独成「扩展页面」分组', async () => {
    adminPageRegistry.register(TEST_PLUGIN, {
      id: 'reports',
      path: 'reports',
      label: '扩展报表',
      icon: 'chart',
      group: 'extensions',
      render: () => null,
    });

    await renderAt('/admin');

    const groupLabels = [...container.querySelectorAll('.admin-nav-label')].map(
      (node) => node.textContent?.trim(),
    );
    expect(groupLabels).toContain('扩展页面');
    expect(navHrefs()).toContain('/admin/ext/reports');
    expect(navLabels()).toContain('扩展报表');
  });

  it('未知图标回退 grid（仍然画出图标），标题取注册页 label', async () => {
    adminPageRegistry.register(TEST_PLUGIN, {
      id: 'fallback',
      path: 'fallback',
      label: '无图标页面',
      icon: 'not-an-icon' as never,
      group: 'overview',
      render: () => null,
    });

    await renderAt('/admin/ext/fallback');

    const link = container.querySelector<HTMLAnchorElement>('a[href="/admin/ext/fallback"]');
    expect(link).not.toBeNull();
    const icon = link?.querySelector('svg');
    expect(icon).not.toBeNull();
    // 未知图标回退到 grid：grid 图标有子节点，空图标没有。
    expect((icon?.childElementCount ?? 0)).toBeGreaterThan(0);
    expect(container.querySelector('.admin-topbar h1')?.textContent).toBe('无图标页面');
    expect(container.querySelector('#ext-outlet')).not.toBeNull();
  });

  it('进入后台时命令面板保持关闭，Ctrl+K 才打开', async () => {
    await renderAt('/admin');

    // 回归：面板曾经被无条件挂载，进入后台就弹出遮罩。
    expect(document.querySelector('.admin-cmd-overlay')).toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    });
    expect(document.querySelector('.admin-cmd-overlay')).not.toBeNull();

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    });
    expect(document.querySelector('.admin-cmd-overlay')).toBeNull();
  });

  it('命令面板按权限过滤细节功能', async () => {
    state.permission = false;
    await renderAt('/admin');
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    });
    const input = document.querySelector<HTMLInputElement>('.admin-cmd-input');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(input, 'sitemap');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const labels = [...document.querySelectorAll<HTMLElement>('.admin-cmd-option')].map(
      (node) => node.textContent ?? '',
    );
    expect(labels.some((label) => label.includes('sitemap.xml'))).toBe(false);
  });

  it('非平台管理员搜不到平台专属的细节功能', async () => {
    state.role = 'admin';
    state.permission = true;
    await renderAt('/admin');
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    });
    const input = document.querySelector<HTMLInputElement>('.admin-cmd-input');
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(input, 'cpu');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const labels = [...document.querySelectorAll<HTMLElement>('.admin-cmd-option')].map(
      (node) => node.textContent ?? '',
    );
    expect(labels.some((label) => label.includes('CPU 占用'))).toBe(false);
  });

  it('命令面板能搜到页面里的细节功能并导航', async () => {
    await renderAt('/admin');
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
    });

    const input = document.querySelector<HTMLInputElement>('.admin-cmd-input');
    expect(input).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(input, 'cpu');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const options = [...document.querySelectorAll<HTMLElement>('.admin-cmd-option')];
    expect(options.length).toBeGreaterThan(0);
    expect(options[0].textContent).toContain('CPU');

    await act(async () => {
      options[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.querySelector('.admin-cmd-overlay')).toBeNull();
    // CPU 占用属于内置性能面板扩展页，测试路由里渲染 #ext-outlet。
    expect(container.querySelector('#ext-outlet')).not.toBeNull();
  });
});
