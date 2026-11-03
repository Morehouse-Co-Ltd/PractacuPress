import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BlockInstance, BlockProps } from '../types';
import marketingCss from '../styles.css?raw';
import { blockDef, createBlock } from './blocks';
import { normalizeBlockProps } from './customize';

/**
 * P2 无媒体组件三件套：功能网格 / 卡片组 / 步骤。
 *
 * 三个区块都是 schema 驱动的：数据侧只在 `blocks.ts` 里多一条定义，渲染侧只在
 * `MARKETING_RENDERERS` 里多一个渲染器。这个测试钉住四件事：
 * 1. 三条定义存在，且 `defaults` 的每个键都声明在 `schema` 里（否则保存一次就丢内容）；
 * 2. `defaults` 原样过得了归一化（读→写幂等）；
 * 3. 渲染器注册进了生产用的 `RENDERERS`，不是只活在测试里；
 * 4. 空条目给作者一句话，而不是一块空白。
 */

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

import { BLOCK_RENDERERS } from '../components/blocks/index';
import { MARKETING_RENDERERS } from '../components/blocks/MarketingBlocks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TYPES = ['feature-grid', 'card-grid', 'steps'] as const;

function field(type: string, key: string) {
  return blockDef(type)?.schema.find((item) => item.key === key);
}

function mk(type: string, props: BlockProps): BlockInstance {
  return { id: type, type, title: type, props, animation: 'none', hidden: false };
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

/** 直接把渲染器挂到一个真实 DOM 上：只有渲染器自己，不经过编排外壳。 */
function mount(type: string, props: BlockProps): HTMLDivElement {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const Renderer = MARKETING_RENDERERS[type];
  act(() => {
    root?.render(createElement(Renderer, { block: mk(type, props) }));
  });
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('三条注册表定义', () => {
  it('三个 type 都在区块目录里，且是内容组、经典与夜航都能用', () => {
    for (const type of TYPES) {
      const def = blockDef(type);
      expect(def, type).toBeTruthy();
      expect(def?.name.trim()).not.toBe('');
      expect(def?.description.trim()).not.toBe('');
      expect(def?.group).toBe('content');
      expect(def?.variants).toEqual(['classic', 'bento']);
    }
  });

  it('defaults 是约定的初始内容', () => {
    expect(blockDef('feature-grid')?.defaults).toEqual({ heading: '', columns: 3, items: [] });
    expect(blockDef('card-grid')?.defaults).toEqual({ heading: '', columns: 3, items: [] });
    expect(blockDef('steps')?.defaults).toEqual({
      heading: '',
      orientation: 'vertical',
      items: [],
    });
  });

  it('defaults 的每个键都声明在 schema 里', () => {
    const missing: string[] = [];
    for (const type of TYPES) {
      const declared = new Set((blockDef(type)?.schema ?? []).map((item) => item.key));
      for (const key of Object.keys(blockDef(type)?.defaults ?? {})) {
        if (!declared.has(key)) missing.push(`${type}.${key}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('defaults 经过归一化后原样保留', () => {
    for (const type of TYPES) {
      const created = createBlock(type).props;
      expect(normalizeBlockProps(type, created), type).toEqual(created);
    }
  });

  it('两个网格的列数是 2 / 3 / 4，步骤的方向是纵向 / 横向', () => {
    for (const type of ['feature-grid', 'card-grid'] as const) {
      const columns = field(type, 'columns');
      expect(columns?.type).toBe('select');
      expect(columns?.options?.map((option) => option.value)).toEqual(['2', '3', '4']);
    }
    const orientation = field('steps', 'orientation');
    expect(orientation?.type).toBe('select');
    expect(orientation?.options?.map((option) => option.value)).toEqual(['vertical', 'horizontal']);
  });

  it('条目是 repeater，子字段与条数上限按规格', () => {
    const expected = {
      'feature-grid': { max: 8, keys: ['icon', 'title', 'text'] },
      'card-grid': { max: 9, keys: ['title', 'text', 'link'] },
      steps: { max: 8, keys: ['title', 'text'] },
    } as const;

    for (const type of TYPES) {
      const items = field(type, 'items');
      expect(items?.type).toBe('repeater');
      expect(items?.maxItems).toBe(expected[type].max);
      expect(items?.itemSchema?.map((item) => item.key)).toEqual(expected[type].keys);
    }

    expect(field('feature-grid', 'items')?.itemSchema?.map((item) => item.type)).toEqual([
      'text',
      'text',
      'textarea',
    ]);
    expect(field('card-grid', 'items')?.itemSchema?.map((item) => item.type)).toEqual([
      'text',
      'textarea',
      'text',
    ]);
  });

  it('repeater 值按 itemSchema 清洗：多余键丢掉、超出上限截掉', () => {
    const items = Array.from({ length: 12 }, (_, index) => ({
      title: `条目 ${index}`,
      text: '说明',
      link: '/a',
      evil: '<script>',
    }));
    const props = normalizeBlockProps('card-grid', { items });
    const kept = props.items as Record<string, unknown>[];
    expect(kept.length).toBe(9);
    expect(kept[0]).toEqual({ title: '条目 0', text: '说明', link: '/a' });
  });
});

describe('渲染器注册', () => {
  it('三个 type 都能在生产 RENDERERS 里找到', () => {
    for (const type of TYPES) {
      expect(typeof BLOCK_RENDERERS[type], type).toBe('function');
    }
  });

  it('MARKETING_RENDERERS 只有这三条', () => {
    expect(Object.keys(MARKETING_RENDERERS).sort()).toEqual([...TYPES].sort());
  });
});

describe('渲染', () => {
  it('没有条目时给作者一句引导文案，而不是空白', () => {
    for (const type of TYPES) {
      const el = mount(type, { items: [] });
      expect(el.textContent).toContain('在右侧添加条目。');
    }
  });

  it('填了条目就渲染标题与正文', () => {
    const el = mount('feature-grid', {
      heading: '为什么选我们',
      items: [{ icon: 'heart', title: '快', text: '三秒打开' }],
    });
    expect(el.querySelector('.pp-marketing-heading')?.textContent).toBe('为什么选我们');
    expect(el.textContent).toContain('快');
    expect(el.textContent).toContain('三秒打开');
  });

  it('内置图标名画图标，未知图标名静默不渲染', () => {
    const known = mount('feature-grid', { items: [{ icon: 'heart', title: 'A', text: '' }] });
    expect(known.querySelector('svg')).not.toBeNull();

    act(() => root?.unmount());
    host?.remove();

    const unknown = mount('feature-grid', { items: [{ icon: 'no-such-icon', title: 'A', text: '' }] });
    expect(unknown.querySelector('svg')).toBeNull();
    expect(unknown.textContent).toContain('A');
  });

  it('卡片链接过白名单：站内路径可点，javascript: 不生成链接', () => {
    const safe = mount('card-grid', {
      items: [{ title: '指南', text: '', link: '/guides' }],
    });
    expect(safe.querySelector('a')?.getAttribute('href')).toBe('/guides');

    act(() => root?.unmount());
    host?.remove();

    const unsafe = mount('card-grid', {
      items: [{ title: '指南', text: '', link: 'javascript:alert(1)' }],
    });
    expect(unsafe.querySelector('a')).toBeNull();
    expect(unsafe.textContent).toContain('指南');
  });

  it('步骤横向模式带 is-horizontal，纵向模式不带', () => {
    const horizontal = mount('steps', {
      orientation: 'horizontal',
      items: [{ title: '一', text: '' }],
    });
    expect(horizontal.querySelector('.pp-steps')?.className).toContain('is-horizontal');

    act(() => root?.unmount());
    host?.remove();

    const vertical = mount('steps', { orientation: 'vertical', items: [{ title: '一', text: '' }] });
    expect(vertical.querySelector('.pp-steps')?.className).not.toContain('is-horizontal');
  });
});

describe('样式', () => {
  it('横向步骤在 767px 以下退化为纵向', () => {
    expect(marketingCss).toMatch(
      /@media\s*\(max-width:\s*767px\)\s*\{[^}]*\.pp-steps\.is-horizontal/,
    );
  });

  it('卡片 hover 只改颜色，不做位移', () => {
    const rule = /\.pp-card-grid-card:hover\s*\{([^}]*)\}/.exec(marketingCss);
    expect(rule).not.toBeNull();
    expect(rule?.[1]).not.toMatch(/transform/);
    expect(rule?.[1]).toMatch(/border-color|color/);
  });

  it('减少动效时关掉过渡', () => {
    expect(marketingCss).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.pp-card-grid-card\s*\{[^}]*transition:\s*none/,
    );
  });
});
