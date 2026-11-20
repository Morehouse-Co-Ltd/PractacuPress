import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * “访问洞察”并入仪表盘“访问记录”后的交互：
 * - 默认不弹；
 * - “更多”按钮打开弹窗，并把 ?insights=1 写进地址（命令面板与旧链接靠它进入）；
 * - 关闭按钮/遮罩关闭后清掉参数，其他 query 保留。
 */

vi.mock('../lib/session', () => ({
  useAuth: () => ({ me: { site_id: 'site-1' } }),
}));

// 稳定的后端桩：每次渲染返回同一个对象，否则 useAsync 的依赖每次都是新引用，
// effect 会不断重跑（表现为弹窗打开后测试超时）。
const backendStub = vi.hoisted(() => ({
  analytics: async () => null,
  popularContent: async () => ({ items: [] }),
}));

vi.mock('../lib/backend', () => ({
  isDemo: () => false,
  useBackend: () => backendStub,
}));

vi.mock('../lib/useAnalytics', () => ({
  useRangeAnalytics: () => ({
    stats: {
      views: 0,
      sessions: 0,
      online: 0,
      series: [],
      topPages: [],
      recent: [],
    },
    source: 'backend',
    loading: false,
  }),
}));

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { DashboardAnalytics } from './DashboardInsights';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement;

function LocationProbe() {
  const location = useLocation();
  return createElement('div', { id: 'location-probe' }, `${location.pathname}${location.search}`);
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
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
            { path: '/admin', element: createElement(DashboardAnalytics) },
            createElement(Route, { index: true, element: null }),
          ),
        ),
        createElement(LocationProbe),
      ),
    );
  });
}

function locationText(): string {
  return document.querySelector('#location-probe')?.textContent ?? '';
}

function moreButton(): HTMLButtonElement {
  const button = [...container.querySelectorAll<HTMLButtonElement>('button')].find((node) =>
    node.textContent?.includes('更多'),
  );
  if (!button) throw new Error('more button not found');
  return button;
}

describe('访问记录里的访问洞察弹窗', () => {
  it('默认不弹窗，右上角有“更多”按钮', async () => {
    await renderAt('/admin');
    expect(document.querySelector('.modal-layer')).toBeNull();
    expect(moreButton()).toBeTruthy();
  });

  it('点“更多”打开弹窗并写入 insights=1，关闭后清掉参数', async () => {
    await renderAt('/admin');
    await act(async () => {
      moreButton().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.querySelector('.modal-layer')).not.toBeNull();
    expect(locationText()).toBe('/admin?insights=1');

    const close = document.querySelector<HTMLButtonElement>('.modal-head .icon-btn');
    expect(close).not.toBeNull();
    await act(async () => {
      close?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.querySelector('.modal-layer')).toBeNull();
    expect(locationText()).toBe('/admin');
  });

  it('带 insights=1 进入时自动打开，遮罩关闭后保留其他 query', async () => {
    await renderAt('/admin?insights=1&tab=content');
    expect(document.querySelector('.modal-layer')).not.toBeNull();

    const backdrop = document.querySelector<HTMLButtonElement>('.modal-backdrop');
    expect(backdrop).not.toBeNull();
    await act(async () => {
      backdrop?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(document.querySelector('.modal-layer')).toBeNull();
    expect(locationText()).toBe('/admin?tab=content');
  });
});
