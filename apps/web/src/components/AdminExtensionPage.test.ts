import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AdminExtensionPage } from './AdminExtensionPage';
import { adminPageRegistry } from '../lib/plugins/adminRegistry';
import type { AdminPageDefinition } from '../lib/plugins/types';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PLUGIN_ID = 'test.page';

function page(overrides: Partial<AdminPageDefinition> = {}): AdminPageDefinition {
  return {
    id: 'demo',
    path: 'demo',
    label: '演示扩展页',
    render: () => createElement('p', { id: 'demo-body' }, '扩展页面内容'),
    ...overrides,
  };
}

let root: Root | null = null;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  adminPageRegistry.clearPlugin(PLUGIN_ID);
  document.title = '';
  vi.restoreAllMocks();
});

async function renderAt(path: string): Promise<void> {
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(
        MemoryRouter,
        { initialEntries: [path] },
        createElement(
          Routes,
          null,
          createElement(Route, {
            path: '/admin/ext/:pageId',
            element: createElement(AdminExtensionPage),
          }),
          createElement(Route, {
            path: '/admin',
            element: createElement('div', { id: 'dashboard' }, '仪表盘'),
          }),
        ),
      ),
    );
  });
}

describe('AdminExtensionPage（/admin/ext/:pageId）', () => {
  it('渲染注册表里的页面，并带上扩展 id 的标记', async () => {
    adminPageRegistry.register(PLUGIN_ID, page());

    await renderAt('/admin/ext/demo');

    expect(container.querySelector('#demo-body')?.textContent).toBe('扩展页面内容');
    expect(container.querySelector('[data-pp-admin-plugin="test.page"]')).not.toBeNull();
    expect(document.title).toBe('演示扩展页 · Practacu Press');
  });

  it('未注册的 slug 显示 404 提示，而不是白屏', async () => {
    await renderAt('/admin/ext/missing');

    expect(container.textContent).toContain('扩展页面不存在');
    expect(container.textContent).toContain('/admin/ext/missing');
    const back = container.querySelector<HTMLAnchorElement>('a[href="/admin"]');
    expect(back?.textContent).toContain('返回管理后台');
  });

  it('页面抛错时只显示本页错误，后台外壳仍在', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    adminPageRegistry.register(
      PLUGIN_ID,
      page({
        render: () => {
          throw new Error('boom');
        },
      }),
    );

    await renderAt('/admin/ext/demo');

    expect(container.textContent).toContain('扩展页面渲染失败');
    expect(container.textContent).toContain('test.page');
    expect(container.textContent).not.toContain('扩展页面内容');
    expect(consoleError).toHaveBeenCalled();
  });

  it('页面被清理后，同一个地址立即变成 404', async () => {
    adminPageRegistry.register(PLUGIN_ID, page());
    await renderAt('/admin/ext/demo');
    expect(container.querySelector('#demo-body')).not.toBeNull();

    await act(async () => {
      adminPageRegistry.clearPlugin(PLUGIN_ID);
    });
    expect(container.querySelector('#demo-body')).toBeNull();
    expect(container.textContent).toContain('扩展页面不存在');
  });
});
