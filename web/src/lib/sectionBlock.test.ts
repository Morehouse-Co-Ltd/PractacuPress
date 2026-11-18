import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BlockInstance, BlockProps, ScreenLayout } from '../types';
import sectionCss from '../styles.css?raw';
import { createBlock, sectionLayout } from './blocks';

/**
 * `section` 是子区块宿主：它自己画 children，不能再被 `hasNestedLayer` 的嵌套层
 * 兜底画一遍。所以除了纯函数，这里还渲染一次真实编排，钉住三件事：
 * 子区块各出现一次、没有 `.pp-nested-layer`、限宽与分隔线真的落到 DOM 上。
 */

let mountedHost: HTMLDivElement | null = null;
let mountedRoot: Root | null = null;

vi.mock('./session', () => ({
  useAuth: () => ({
    me: null,
    config: {},
    status: 'anonymous',
    session: null,
    site: null,
    unread: 0,
  }),
}));

import { ScreenRenderer } from '../components/blocks/index';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mk(props: BlockProps = {}): BlockInstance {
  return { id: 's', type: 'section', title: 's', props, animation: 'none', hidden: false };
}

function mount(layout: ScreenLayout): HTMLElement {
  mountedHost = document.createElement('div');
  document.body.append(mountedHost);
  mountedRoot = createRoot(mountedHost);
  act(() => {
    mountedRoot?.render(createElement(ScreenRenderer, { layout }));
  });
  return mountedHost;
}

function renderedIds(el: HTMLElement) {
  return [...el.querySelectorAll('[data-pp-block]')].map((node) => node.getAttribute('data-pp-block'));
}

afterEach(() => {
  act(() => mountedRoot?.unmount());
  mountedHost?.remove();
  mountedHost = null;
  mountedRoot = null;
  window.innerWidth = 1280;
});

describe('sectionLayout', () => {
  it('默认常规宽度、留白档 5（32px）、无底色、无分隔线', () => {
    expect(sectionLayout(mk())).toEqual({ maxWidth: 860, paddingY: 32, background: undefined, divider: false });
  });
  it('满宽不设 maxWidth', () => {
    expect(sectionLayout(mk({ max_width: 'full' })).maxWidth).toBeUndefined();
  });
  it('坏档位回落 32px，坏颜色被丢弃', () => {
    expect(sectionLayout(mk({ padding_y: 99 })).paddingY).toBe(32);
    expect(sectionLayout(mk({ background: 'not-a-color' })).background).toBeUndefined();
  });
  it('分隔线开关', () => {
    expect(sectionLayout(mk({ divider: true })).divider).toBe(true);
  });
});

describe('分节的渲染接线', () => {
  it('子区块由分节这一支画一次，嵌套层不再补画一遍', () => {
    const host = mount({
      blocks: [
        createBlock('section', {
          id: 'sec',
          props: { max_width: 'normal', padding_y: 5 },
          children: [createBlock('text', { id: 'kid' })],
        }),
      ],
    });

    expect(renderedIds(host)).toEqual(['sec', 'kid']);
    expect(host.querySelector('.pp-nested-layer')).toBeNull();
    // 子区块必须落在限宽的内层里：外层铺底色，内层才收内容。
    expect(host.querySelector('.pp-section > .pp-section-inner [data-pp-block="kid"]')).not.toBeNull();
  });

  it('限宽、留白、底色与分隔线落到 DOM 上', () => {
    const host = mount({
      blocks: [
        createBlock('section', {
          id: 'sec',
          props: { max_width: 'narrow', padding_y: 9, background: '#123456', divider: true },
        }),
      ],
    });

    const shell = host.querySelector<HTMLElement>('.pp-section');
    expect(shell).not.toBeNull();
    expect(shell?.classList.contains('pp-section-divided')).toBe(true);
    expect(shell?.style.paddingTop).toBe('96px');
    expect(shell?.style.paddingBottom).toBe('96px');
    expect(shell?.style.background).toContain('#123456');

    const inner = host.querySelector<HTMLElement>('.pp-section-inner');
    expect(inner?.style.maxWidth).toBe('640px');
  });

  it('满宽时不给内层写 max-width', () => {
    const host = mount({
      blocks: [createBlock('section', { id: 'sec', props: { max_width: 'full' } })],
    });

    expect(host.querySelector<HTMLElement>('.pp-section-inner')?.style.maxWidth).toBe('');
  });
});

describe('分节的样式表接线', () => {
  it('内层居中限宽、分隔线画在上下边框上', () => {
    expect(sectionCss).toMatch(/\.pp-section-inner\s*\{[^}]*margin-inline:\s*auto/);
    expect(sectionCss).toMatch(/\.pp-section-inner\s*\{[^}]*width:\s*100%/);
    expect(sectionCss).toMatch(/\.pp-section-divided\s*\{[^}]*border-block:\s*1px solid var\(--line\)/);
  });
});
