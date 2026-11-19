import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * 「选择主题」页的正在使用主题：暗色兼容之外，还要能预览。
 *
 * 这里不渲染整个 App，只把页面依赖的站点设计 / 切换器 / 权限门换成稳定桩，
 * 然后断言：
 * - 正在使用的卡片有「预览主题」按钮（不是只有「编辑」）；
 * - 点它只打开预览弹窗，不会再套用一次主题。
 */

const applyBundle = vi.hoisted(() => vi.fn());

vi.mock('../../lib/customize', () => ({
  useCustomization: () => ({
    customization: {
      theme: {
        preset: 'paper',
        mode: 'light',
        background: '#ffffff',
        ink: '#14140f',
        accent: '#1f5c4a',
        heading_font: 'serif',
        body_size: 17.5,
        content_width: 880,
        radius: 6,
      },
      layout: { variant: 'classic' },
      active_theme: 'default',
      themes: [],
    },
    update: () => undefined,
  }),
}));

vi.mock('../../lib/themeSwitch', () => ({
  cloneTheme: (theme: unknown) => theme,
  sameLayout: () => true,
  useThemeSwitch: () => ({ applyBundle }),
}));

vi.mock('../../lib/toast', () => ({
  useToast: () => () => undefined,
}));

vi.mock('../../lib/hooks', () => ({
  useTitle: () => undefined,
}));

vi.mock('../../components/Guards', () => ({
  RoleGate: (props: { children: unknown }) => props.children,
}));

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { ChooseThemePage } from './ChooseTheme';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  applyBundle.mockClear();
});

async function renderPage(): Promise<HTMLDivElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(MemoryRouter, null, createElement(ChooseThemePage)));
  });
  return container;
}

describe('选择主题 · 正在使用的主题', () => {
  it('悬停操作里有「预览主题」，点击只打开预览弹窗', async () => {
    const view = await renderPage();
    const applied = view.querySelector('.theme-tile.is-applied');
    expect(applied).not.toBeNull();

    const actions = [...applied!.querySelectorAll<HTMLButtonElement>('.theme-tile-action')];
    const preview = actions.find((node) => node.textContent?.includes('预览主题'));
    expect(preview).toBeTruthy();
    expect(actions.some((node) => node.textContent?.includes('编辑'))).toBe(true);

    await act(async () => {
      preview!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
    });

    const modalTitle = document.querySelector('.modal .modal-head h2')?.textContent?.trim();
    expect(modalTitle).toBe('原版');
    expect(applyBundle).not.toHaveBeenCalled();
  });
});
