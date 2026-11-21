import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * 「选择主题」页：正在使用主题的预览，以及「创建空白主题」的入口。
 *
 * 这里不渲染整个 App，只把页面依赖的站点设计 / 切换器 / 权限门换成稳定桩，
 * 然后断言：
 * - 正在使用的卡片有「预览主题」按钮（不是只有「编辑」）；
 * - 点它只打开预览弹窗，不会再套用一次主题；
 * - 创建弹窗没有单栏/双栏与外观功能选项，创建结果是一套没有令牌/版式的空白主题，
 *   并带上空白的首页/文章页编排。
 */

const applyBundle = vi.hoisted(() => vi.fn());
const state = vi.hoisted(() => ({
  customization: {} as never,
  update: vi.fn(),
}));

vi.mock('../../lib/customize', () => ({
  useCustomization: () => ({ customization: state.customization, update: state.update }),
}));

vi.mock('../../lib/themeSwitch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/themeSwitch')>();
  return {
    ...actual,
    useThemeSwitch: () => ({ applyBundle }),
  };
});

vi.mock('../../lib/toast', () => ({
  useToast: () => ({ push: () => undefined }),
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
import { DEFAULT_THEME } from '../../lib/theme';
import { ChooseThemePage } from './ChooseTheme';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement;

function baseCustomization(overrides: Record<string, unknown> = {}) {
  return {
    theme: { ...DEFAULT_THEME },
    layout: { variant: 'classic' },
    active_theme: 'default',
    themes: [],
    home: { blocks: [] },
    article: { blocks: [] },
    ...overrides,
  };
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  applyBundle.mockClear();
  state.update.mockClear();
});

beforeEach(() => {
  state.customization = baseCustomization() as never;
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

describe('选择主题 · 创建空白主题', () => {
  it('创建弹窗只问名称与备注，不提供单栏/双栏或外观功能', async () => {
    const view = await renderPage();
    const createTile = view.querySelector('.theme-tile.is-new') as HTMLButtonElement | null;
    expect(createTile).not.toBeNull();

    await act(async () => {
      createTile!.click();
    });

    const modal = document.querySelector('.modal') as HTMLElement;
    expect(modal.textContent).toContain('创建空白主题');
    expect(modal.querySelector('#theme-create-name')).not.toBeNull();
    expect(modal.querySelector('.option-grid')).toBeNull();
    expect(modal.querySelector('.appearance-bind-grid')).toBeNull();
    expect(modal.textContent).not.toContain('外观功能');
  });

  it('创建结果是一套没有令牌/版式、首页与文章页编排为空白的主题', async () => {
    const view = await renderPage();
    const createTile = view.querySelector('.theme-tile.is-new') as HTMLButtonElement;
    await act(async () => {
      createTile.click();
    });

    const modal = document.querySelector('.modal') as HTMLElement;
    const input = modal.querySelector('#theme-create-name') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, '空白测试');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const createButton = [...modal.querySelectorAll('button')].find(
      (node) => node.textContent?.trim() === '仅创建',
    );
    expect(createButton).toBeTruthy();
    await act(async () => {
      createButton!.click();
    });

    expect(state.update).toHaveBeenCalledTimes(1);
    const patch = state.update.mock.calls[0][0] as {
      themes: { id: string; name: string; theme?: unknown; variant?: unknown }[];
      theme_layouts: Record<
        string,
        { home?: { blocks: unknown[] }; article?: { blocks: unknown[] } }
      >;
      active_theme: string;
      layout: { variant: string };
      theme: { mode: string };
    };
    expect(patch.themes).toHaveLength(1);
    const created = patch.themes[0];
    expect(created.name).toBe('空白测试');
    expect(created.theme).toBeUndefined();
    expect(created.variant).toBeUndefined();
    expect(patch.theme_layouts[created.id].home?.blocks).toEqual([]);
    expect(patch.theme_layouts[created.id].article?.blocks).toEqual([]);
    expect(patch.active_theme).toBe(created.id);
    expect(patch.layout.variant).toBe('classic');
    expect(patch.theme.mode).toBe('light');
  });

  it('空白主题的详情显示「未设置」与空白编排', async () => {
    const blank = { id: 'theme_blank', name: '空白主题', note: '' };
    state.customization = baseCustomization({
      active_theme: blank.id,
      themes: [blank],
      theme_layouts: { [blank.id]: { home: { blocks: [] }, article: { blocks: [] } } },
    }) as never;

    const view = await renderPage();
    const detail = view.querySelector('.theme-detail') as HTMLElement;
    expect(detail.textContent).toContain('未设置');
    expect(detail.textContent).toContain('空白主题：未设置配色与版式');
    expect(detail.textContent).toContain('空白（还没有组件）');
  });
});
