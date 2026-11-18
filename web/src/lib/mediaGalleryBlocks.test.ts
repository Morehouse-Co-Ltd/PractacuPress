import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BlockInstance, BlockProps } from '../types';
import galleryCss from '../styles.css?raw';
import { blockDef, createBlock } from './blocks';
import { normalizeBlockProps } from './customize';

/**
 * P2 媒体组件三件套：团队 / Logo 墙 / 图集。
 *
 * 数据侧依旧只在 `blocks.ts` 里多三条定义，渲染侧只在 `MEDIA_GALLERY_RENDERERS`
 * 里多三个渲染器。图集比前两件多一个状态机（缩略图 / 大图 / 前后切换），为了能
 * 单测，下标计算抽成纯函数 `lightboxStep`，DOM 那边只负责把状态喂给它。
 *
 * 这个测试钉住五件事：
 * 1. 三条定义存在，且 `defaults` 的每个键都声明在 `schema` 里（否则保存一次就丢内容）；
 * 2. `defaults` 原样过得了归一化（读→写幂等）；
 * 3. 渲染器注册进了生产用的 `RENDERERS`，不是只活在测试里；
 * 4. 「所有图片都有 alt」「src 都过白名单」「缺图不出现破图图标」这三条硬规则；
 * 5. 灯箱：打开 / 关闭 / 前后切换 / 关闭后焦点回到被点的缩略图。
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
import { MEDIA_GALLERY_RENDERERS, lightboxStep } from '../components/blocks/MediaGalleryBlocks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TYPES = ['team', 'logo-wall', 'gallery'] as const;

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
  const Renderer = MEDIA_GALLERY_RENDERERS[type];
  act(() => {
    root?.render(createElement(Renderer, { block: mk(type, props) }));
  });
  return host;
}

/** 重挂载前先拆掉上一个根，避免两个渲染器抢同一份 activeElement。 */
function remount(type: string, props: BlockProps): HTMLDivElement {
  act(() => root?.unmount());
  host?.remove();
  return mount(type, props);
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
    expect(blockDef('team')?.defaults).toEqual({ heading: '', columns: 3, items: [] });
    expect(blockDef('logo-wall')?.defaults).toEqual({ heading: '', columns: 4, items: [] });
    expect(blockDef('gallery')?.defaults).toEqual({
      heading: '',
      columns: 3,
      ratio: '4:3',
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

  it('图集的比例只给 1:1 / 4:3 / 16:9 三档', () => {
    const ratio = field('gallery', 'ratio');
    expect(ratio?.type).toBe('select');
    expect(ratio?.options?.map((option) => option.value)).toEqual(['1:1', '4:3', '16:9']);
    expect(ratio?.options?.every((option) => option.label.trim() !== '')).toBe(true);
  });

  it('条目是 repeater，子字段里头像 / Logo / 图片都是 media，条数上限按规格', () => {
    const expected = {
      team: { max: 12, keys: ['avatar', 'name', 'role', 'link'], types: ['media', 'text', 'text', 'text'] },
      'logo-wall': { max: 12, keys: ['image', 'link', 'alt'], types: ['media', 'text', 'text'] },
      gallery: { max: 20, keys: ['image', 'caption'], types: ['media', 'text'] },
    } as const;

    for (const type of TYPES) {
      const items = field(type, 'items');
      expect(items?.type, type).toBe('repeater');
      expect(items?.maxItems).toBe(expected[type].max);
      expect(items?.itemSchema?.map((item) => item.key)).toEqual(expected[type].keys);
      expect(items?.itemSchema?.map((item) => item.type)).toEqual(expected[type].types);
    }
  });

  it('repeater 值按 itemSchema 清洗：多余键丢掉、超出上限截掉', () => {
    const items = Array.from({ length: 20 }, (_, index) => ({
      image: '/api/v1/media/a.png',
      caption: `说明 ${index}`,
      evil: '<script>',
    }));
    const props = normalizeBlockProps('gallery', { items });
    const kept = props.items as Record<string, unknown>[];
    expect(kept.length).toBe(20);
    expect(kept[0]).toEqual({ image: '/api/v1/media/a.png', caption: '说明 0' });

    const team = normalizeBlockProps('team', {
      items: Array.from({ length: 15 }, (_, index) => ({ name: `成员 ${index}` })),
    });
    expect((team.items as Record<string, unknown>[]).length).toBe(12);
  });
});

describe('渲染器注册', () => {
  it('三个 type 都能在生产 RENDERERS 里找到', () => {
    for (const type of TYPES) {
      expect(typeof BLOCK_RENDERERS[type], type).toBe('function');
    }
  });

  it('MEDIA_GALLERY_RENDERERS 只有这三条', () => {
    expect(Object.keys(MEDIA_GALLERY_RENDERERS).sort()).toEqual([...TYPES].sort());
  });
});

describe('lightboxStep（灯箱下标状态机）', () => {
  it('单张与空集都停在 0，不越界', () => {
    expect(lightboxStep(0, 1, 0)).toBe(0);
    expect(lightboxStep(0, -1, 0)).toBe(0);
    expect(lightboxStep(0, 1, 1)).toBe(0);
    expect(lightboxStep(0, -1, 1)).toBe(0);
    expect(lightboxStep(0, 7, 1)).toBe(0);
  });

  it('中间前后移动就是加减', () => {
    expect(lightboxStep(0, 1, 4)).toBe(1);
    expect(lightboxStep(2, 1, 4)).toBe(3);
    expect(lightboxStep(2, -1, 4)).toBe(1);
    expect(lightboxStep(2, 0, 4)).toBe(2);
  });

  it('两端都回绕：最后一张下一张是第一张，第一张上一张是最后一张', () => {
    expect(lightboxStep(2, 1, 3)).toBe(0);
    expect(lightboxStep(0, -1, 3)).toBe(2);
    expect(lightboxStep(19, 1, 20)).toBe(0);
    expect(lightboxStep(0, -1, 20)).toBe(19);
  });

  it('一步跨过多张也不跳号', () => {
    expect(lightboxStep(0, 4, 3)).toBe(1);
    expect(lightboxStep(0, -4, 3)).toBe(2);
    expect(lightboxStep(1, -5, 3)).toBe(2);
    expect(lightboxStep(1, 7, 3)).toBe(2);
  });

  it('坏输入收敛回合法下标', () => {
    expect(lightboxStep(5, 0, 3)).toBe(2);
    expect(lightboxStep(-1, 0, 3)).toBe(2);
    expect(lightboxStep(Number.NaN, 1, 3)).toBe(1);
    expect(lightboxStep(0, Number.NaN, 3)).toBe(0);
    expect(lightboxStep(0, 1, Number.NaN)).toBe(0);
    expect(lightboxStep(0, 1, -3)).toBe(0);
  });
});

describe('团队区块', () => {
  it('缺图时用姓名首字母占位，不生成 <img>（不会出现破图图标）', () => {
    const el = mount('team', {
      items: [
        { name: 'Ada Lovelace', role: '主编' },
        { name: '李雷', role: '记者' },
      ],
    });
    const initials = [...el.querySelectorAll('.pp-team-initial')].map((node) => node.textContent);
    expect(initials).toEqual(['A', '李']);
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('主编');
  });

  it('有头像时画图片，alt 为空串（姓名就在旁边，头像只是装饰）', () => {
    const el = mount('team', {
      items: [{ avatar: '/api/v1/media/abc', name: 'Ada', role: '主编', link: 'https://example.com/a' }],
    });
    const img = el.querySelector('img');
    expect(img?.getAttribute('src')).toBe('/api/v1/media/abc');
    // 属性必须存在且为空：缺 alt 会被读屏念出文件名。
    expect(img?.hasAttribute('alt')).toBe(true);
    expect(img?.getAttribute('alt')).toBe('');
    expect(el.querySelector('.pp-team-initial')).toBeNull();
    const link = el.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com/a');
    expect(link?.getAttribute('rel')).toContain('noreferrer');
  });

  it('未过白名单的头像与链接都不落到 src / href 上', () => {
    const el = mount('team', {
      items: [{ avatar: 'javascript:alert(1)', name: 'Eve', link: 'javascript:alert(2)' }],
    });
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('a')).toBeNull();
    expect(el.querySelector('.pp-team-initial')?.textContent).toBe('E');
  });

  it('超过 12 位时只画前 12 位', () => {
    const el = mount('team', {
      items: Array.from({ length: 15 }, (_, index) => ({ name: `成员 ${index}` })),
    });
    expect(el.querySelectorAll('.pp-team-member').length).toBe(12);
  });
});

describe('Logo 墙区块', () => {
  it('alt 取条目的 alt，缺省是空串（装饰图）', () => {
    const el = mount('logo-wall', {
      items: [
        { image: '/img/a.svg', alt: 'Acme' },
        { image: '/img/b.svg' },
      ],
    });
    const images = [...el.querySelectorAll('img')];
    expect(images.length).toBe(2);
    expect(images[0].getAttribute('alt')).toBe('Acme');
    expect(images[1].hasAttribute('alt')).toBe(true);
    expect(images[1].getAttribute('alt')).toBe('');
  });

  it('填了链接就包一层外链（不把访客的当前页带走）', () => {
    const el = mount('logo-wall', {
      items: [{ image: '/img/a.svg', link: 'https://acme.example', alt: 'Acme' }],
    });
    const link = el.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://acme.example');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noreferrer noopener');
  });

  it('没有图片的条目直接跳过，不留空框', () => {
    const el = mount('logo-wall', {
      items: [{ image: '', link: '/a' }, { image: 'javascript:alert(1)' }],
    });
    expect(el.querySelectorAll('img').length).toBe(0);
    expect(el.querySelectorAll('.pp-logo-wall-item').length).toBe(0);
  });
});

describe('图集区块', () => {
  const items = [
    { image: '/img/a.png', caption: '第一张' },
    { image: '/img/b.png', caption: '第二张' },
    { image: '/img/c.png', caption: '' },
  ];

  it('每张图都是带 alt 的缩略图，alt 取说明文字', () => {
    const el = mount('gallery', { items });
    const images = [...el.querySelectorAll<HTMLImageElement>('.pp-gallery-thumb img')];
    expect(images.map((img) => img.getAttribute('src'))).toEqual([
      '/img/a.png',
      '/img/b.png',
      '/img/c.png',
    ]);
    expect(images.map((img) => img.getAttribute('alt'))).toEqual(['第一张', '第二张', '']);
  });

  it('比例作为 CSS 变量下发到栅格，列数同理', () => {
    const el = mount('gallery', { items, ratio: '16:9', columns: 2 });
    const grid = el.querySelector<HTMLElement>('.pp-gallery-grid');
    expect(grid?.getAttribute('style')).toContain('--pp-gallery-ratio: 16 / 9');
    expect(grid?.getAttribute('style')).toContain('--pp-media-columns: 2');
  });

  it('点缩略图打开原生 dialog 大图，Esc 关闭后焦点回到被点的缩略图', () => {
    const el = mount('gallery', { items });
    const dialog = el.querySelector('dialog');
    expect(dialog).not.toBeNull();
    expect(dialog?.open).toBe(false);

    const thumbs = [...el.querySelectorAll<HTMLButtonElement>('.pp-gallery-thumb')];
    act(() => thumbs[1].click());
    expect(dialog?.open).toBe(true);
    expect(dialog?.querySelector('.pp-gallery-large')?.getAttribute('src')).toBe('/img/b.png');
    expect(dialog?.textContent).toContain('第二张');

    act(() => {
      dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(dialog?.open).toBe(false);
    expect(document.activeElement).toBe(thumbs[1]);
  });

  it('下一张 / 上一张按钮与左右方向键都在灯箱里切换', () => {
    const el = mount('gallery', { items });
    const dialog = el.querySelector('dialog');
    const thumbs = [...el.querySelectorAll<HTMLButtonElement>('.pp-gallery-thumb')];
    act(() => thumbs[0].click());

    const src = () => dialog?.querySelector('.pp-gallery-large')?.getAttribute('src');
    act(() => dialog?.querySelector<HTMLButtonElement>('.pp-gallery-next')?.click());
    expect(src()).toBe('/img/b.png');

    act(() => {
      dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(src()).toBe('/img/c.png');

    // 最后一张再往后是第一张（回绕）。
    act(() => {
      dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(src()).toBe('/img/a.png');

    act(() => {
      dialog?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    });
    expect(src()).toBe('/img/c.png');

    act(() => dialog?.querySelector<HTMLButtonElement>('.pp-gallery-prev')?.click());
    expect(src()).toBe('/img/b.png');
  });

  it('只有一张时不显示前后切换按钮', () => {
    const el = mount('gallery', { items: [items[0]] });
    const dialog = el.querySelector('dialog');
    act(() => el.querySelector<HTMLButtonElement>('.pp-gallery-thumb')?.click());
    expect(dialog?.open).toBe(true);
    expect(dialog?.querySelector('.pp-gallery-prev')).toBeNull();
    expect(dialog?.querySelector('.pp-gallery-next')).toBeNull();
  });

  it('关闭按钮同样关闭灯箱', () => {
    const el = mount('gallery', { items });
    const dialog = el.querySelector('dialog');
    const thumbs = [...el.querySelectorAll<HTMLButtonElement>('.pp-gallery-thumb')];
    act(() => thumbs[2].click());
    act(() => dialog?.querySelector<HTMLButtonElement>('.pp-gallery-close')?.click());
    expect(dialog?.open).toBe(false);
    expect(document.activeElement).toBe(thumbs[2]);
  });

  it('没有图片的条目不会变成空格子', () => {
    const el = remount('gallery', { items: [{ image: '', caption: '只有说明' }, items[1]] });
    expect(el.querySelectorAll('.pp-gallery-thumb').length).toBe(1);
  });
});

describe('空状态', () => {
  it('没有条目时给作者一句引导文案，而不是空白', () => {
    for (const type of TYPES) {
      const el = remount(type, { items: [] });
      expect(el.textContent, type).toContain('在右侧添加条目。');
    }
  });
});

describe('样式', () => {
  it('团队头像是正圆', () => {
    const rule = /\.pp-team-avatar\s*\{([^}]*)\}/.exec(galleryCss);
    expect(rule).not.toBeNull();
    expect(rule?.[1]).toMatch(/border-radius:\s*50%/);
  });

  it('Logo 墙默认灰度、hover 恢复彩色', () => {
    const base = /\.pp-logo-wall img\s*\{([^}]*)\}/.exec(galleryCss);
    expect(base?.[1]).toMatch(/filter:\s*grayscale\(1\)/);
    const hover = /\.pp-logo-wall a:hover img[^{]*\{([^}]*)\}/.exec(galleryCss);
    expect(hover?.[1]).toMatch(/grayscale\(0\)/);
  });

  it('减少动效时 Logo 墙不做过渡', () => {
    expect(galleryCss).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.pp-logo-wall img\s*\{[^}]*transition:\s*none/,
    );
  });

  it('缩略图按 --pp-gallery-ratio 定比例，灯箱是 dialog 的样式', () => {
    expect(galleryCss).toMatch(/\.pp-gallery-thumb\s*\{[^}]*aspect-ratio:\s*var\(--pp-gallery-ratio/);
    expect(galleryCss).toMatch(/\.pp-gallery-dialog\s*\{/);
    expect(galleryCss).toMatch(/\.pp-gallery-dialog::backdrop\s*\{/);
  });
});
