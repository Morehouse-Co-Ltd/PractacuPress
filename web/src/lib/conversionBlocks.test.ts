import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BlockInstance, BlockProps } from '../types';
import conversionCss from '../styles.css?raw';
import { blockDef, createBlock } from './blocks';
import { normalizeBlockProps } from './customize';

/**
 * P2 说服组件四件套：定价 / FAQ / 证言 / 图文交替。
 *
 * 数据侧依旧只在 `blocks.ts` 里多四条定义，渲染侧只在 `CONVERSION_RENDERERS`
 * 里多四个渲染器。定价档位的功能清单是「一行一条」的自由文本，拆行规则抽成纯函数
 * `splitFeatures`，DOM 那边只负责把结果画成列表。
 *
 * 这个测试钉住五件事：
 * 1. 四条定义存在，且 `defaults` 的每个键都声明在 `schema` 里（否则保存一次就丢内容）；
 * 2. `defaults` 原样过得了归一化（读→写幂等）；
 * 3. 渲染器注册进了生产用的 `RENDERERS`，不是只活在测试里；
 * 4. `splitFeatures` 的拆行 / 去标记 / 去重 / 坏行收敛；
 * 5. 四条硬规则：链接一律过 `safeUrl`、外链补 `rel`、`media-text.body` 走 Markdown
 *    渲染链路、`open_first` 只影响第一条。
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
import { CONVERSION_RENDERERS, splitFeatures } from '../components/blocks/ConversionBlocks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TYPES = ['pricing', 'faq', 'testimonial', 'media-text'] as const;

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
  const Renderer = CONVERSION_RENDERERS[type];
  act(() => {
    root?.render(createElement(Renderer, { block: mk(type, props) }));
  });
  return host;
}

/** 重挂载前先拆掉上一个根，避免两个渲染器抢同一份 DOM。 */
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

describe('四条注册表定义', () => {
  it('四个 type 都在区块目录里，且是内容组、经典与夜航都能用', () => {
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
    expect(blockDef('pricing')?.defaults).toEqual({ heading: '', items: [] });
    expect(blockDef('faq')?.defaults).toEqual({ heading: '', open_first: false, items: [] });
    expect(blockDef('testimonial')?.defaults).toEqual({ heading: '', layout: 'grid', items: [] });
    expect(blockDef('media-text')?.defaults).toEqual({
      image: '',
      alt: '',
      title: '',
      body: '',
      side: 'left',
      cta_label: '',
      cta_link: '',
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

  it('条目是 repeater，子字段、类型与条数上限按规格', () => {
    const expected = {
      pricing: {
        max: 4,
        keys: ['name', 'price', 'period', 'features', 'cta_label', 'cta_link', 'featured'],
        types: ['text', 'text', 'text', 'textarea', 'text', 'text', 'toggle'],
      },
      faq: { max: 20, keys: ['question', 'answer'], types: ['text', 'textarea'] },
      testimonial: {
        max: 9,
        keys: ['quote', 'name', 'role', 'avatar'],
        types: ['textarea', 'text', 'text', 'media'],
      },
    } as const;

    for (const type of Object.keys(expected) as (keyof typeof expected)[]) {
      const items = field(type, 'items');
      expect(items?.type, type).toBe('repeater');
      expect(items?.maxItems).toBe(expected[type].max);
      expect(items?.itemSchema?.map((item) => item.key)).toEqual(expected[type].keys);
      expect(items?.itemSchema?.map((item) => item.type)).toEqual(expected[type].types);
    }
  });

  it('图文交替：图片是 media、正文是 richtext、方向是左 / 右两档', () => {
    expect(field('media-text', 'image')?.type).toBe('media');
    expect(field('media-text', 'alt')?.type).toBe('text');
    expect(field('media-text', 'title')?.type).toBe('text');
    // 正文必须是 Task 1 的 richtext，渲染走 text 区块同一条 Markdown 链路。
    expect(field('media-text', 'body')?.type).toBe('richtext');
    const side = field('media-text', 'side');
    expect(side?.type).toBe('select');
    expect(side?.options?.map((option) => option.value)).toEqual(['left', 'right']);
    expect(field('media-text', 'cta_label')?.type).toBe('text');
    expect(field('media-text', 'cta_link')?.type).toBe('text');
  });

  it('证言的布局只给栅格 / 横向滑动两档，FAQ 有「展开第一条」开关', () => {
    const layout = field('testimonial', 'layout');
    expect(layout?.type).toBe('select');
    expect(layout?.options?.map((option) => option.value)).toEqual(['grid', 'carousel']);
    expect(layout?.options?.every((option) => option.label.trim() !== '')).toBe(true);
    expect(field('faq', 'open_first')?.type).toBe('toggle');
  });

  it('三件套有区块级标题，图文交替的标题属于「文」的那一半', () => {
    for (const type of ['pricing', 'faq', 'testimonial'] as const) {
      expect(field(type, 'heading')?.type, type).toBe('text');
    }
    expect(field('media-text', 'heading')).toBeUndefined();
    expect(field('media-text', 'title')?.type).toBe('text');
  });

  it('repeater 值按 itemSchema 清洗：超出上限截掉、多余键丢掉', () => {
    const plans = Array.from({ length: 7 }, (_, index) => ({
      name: `档位 ${index}`,
      price: '¥9',
      features: '快',
      featured: true,
      evil: '<script>',
    }));
    const props = normalizeBlockProps('pricing', { items: plans });
    const kept = props.items as Record<string, unknown>[];
    expect(kept.length).toBe(4);
    // 缺的字段补空值：开关补 false，文本补空串。
    expect(kept[0]).toEqual({
      name: '档位 0',
      price: '¥9',
      period: '',
      features: '快',
      cta_label: '',
      cta_link: '',
      featured: true,
    });

    const faq = normalizeBlockProps('faq', {
      items: Array.from({ length: 24 }, (_, index) => ({ question: `问 ${index}` })),
    });
    expect((faq.items as Record<string, unknown>[]).length).toBe(20);
  });
});

describe('渲染器注册', () => {
  it('四个 type 都能在生产 RENDERERS 里找到', () => {
    for (const type of TYPES) {
      expect(typeof BLOCK_RENDERERS[type], type).toBe('function');
    }
  });

  it('CONVERSION_RENDERERS 只有这四条', () => {
    expect(Object.keys(CONVERSION_RENDERERS).sort()).toEqual([...TYPES].sort());
  });
});

describe('splitFeatures（功能清单拆行）', () => {
  it('空值与空行都得到空列表，不产生空条目', () => {
    expect(splitFeatures('')).toEqual([]);
    expect(splitFeatures('   ')).toEqual([]);
    expect(splitFeatures('\n')).toEqual([]);
    expect(splitFeatures('\r\n \r\n')).toEqual([]);
  });

  it('一行一条，顺序保持不变', () => {
    expect(splitFeatures('快\n稳\n省心')).toEqual([
      { label: '快', included: true },
      { label: '稳', included: true },
      { label: '省心', included: true },
    ]);
  });

  it('行首的 - 表示不含，标记本身不进标签', () => {
    expect(splitFeatures('快\n- 深度报告\n-无限席位')).toEqual([
      { label: '快', included: true },
      { label: '深度报告', included: false },
      { label: '无限席位', included: false },
    ]);
  });

  it('行内缩进与行尾空格都去掉', () => {
    expect(splitFeatures('   快   \n\t- 深度报告 \t')).toEqual([
      { label: '快', included: true },
      { label: '深度报告', included: false },
    ]);
  });

  it('空行与只有空白字符的行被跳过', () => {
    expect(splitFeatures('快\n\n   \n稳')).toEqual([
      { label: '快', included: true },
      { label: '稳', included: true },
    ]);
  });

  it('重复项只保留第一次出现的那条（含「含 / 不含」冲突时）', () => {
    expect(splitFeatures('快\n快\n - 快 ')).toEqual([{ label: '快', included: true }]);
    expect(splitFeatures('- 深度报告\n深度报告')).toEqual([
      { label: '深度报告', included: false },
    ]);
  });

  it('孤零零一个 - 不产生条目', () => {
    expect(splitFeatures('-\n-  \n-\t')).toEqual([]);
    expect(splitFeatures('快\n-')).toEqual([{ label: '快', included: true }]);
  });

  it('只有一个字的功能也保留，不做最短长度过滤', () => {
    expect(splitFeatures('快')).toEqual([{ label: '快', included: true }]);
  });
});

describe('定价表', () => {
  const plan = {
    name: '专业版',
    price: '¥29',
    period: '/月',
    features: '无限发布\n- 深度报告',
    cta_label: '开始使用',
    cta_link: '/signup',
  };

  it('价格与周期分两层，推荐档加类名与「推荐」角标', () => {
    const el = mount('pricing', {
      heading: '价格',
      items: [plan, { ...plan, name: '团队版', featured: true }],
    });
    expect(el.querySelector('.pp-conversion-heading')?.textContent).toBe('价格');
    const plans = [...el.querySelectorAll('.pp-pricing-plan')];
    expect(plans.length).toBe(2);
    expect(plans[0].className).not.toContain('is-featured');
    expect(plans[1].className).toContain('is-featured');
    // 角标只出现在推荐档。
    expect(plans[0].querySelector('.pp-pricing-badge')).toBeNull();
    expect(plans[1].querySelector('.pp-pricing-badge')?.textContent).toBe('推荐');
    expect(el.querySelector('.pp-pricing-price')?.textContent).toBe('¥29');
    expect(el.querySelector('.pp-pricing-period')?.textContent).toBe('/月');
  });

  it('功能清单按行拆分，以 - 开头的标为「不含」', () => {
    const el = mount('pricing', { items: [plan] });
    const rows = [...el.querySelectorAll<HTMLElement>('.pp-pricing-feature')];
    expect(rows.map((row) => row.textContent)).toEqual(['无限发布', '深度报告']);
    expect(rows[0].className).not.toContain('is-excluded');
    expect(rows[1].className).toContain('is-excluded');
  });

  it('按钮链接过白名单；外链另开窗口并带 rel，没过白名单的不生成链接', () => {
    const site = mount('pricing', { items: [plan] });
    expect(site.querySelector('.pp-pricing-cta')?.getAttribute('href')).toBe('/signup');
    expect(site.querySelector('.pp-pricing-cta')?.getAttribute('rel')).toBeNull();

    const external = remount('pricing', {
      items: [{ ...plan, cta_link: 'https://example.com/buy' }],
    });
    const link = external.querySelector('.pp-pricing-cta');
    expect(link?.getAttribute('href')).toBe('https://example.com/buy');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noreferrer noopener');

    const unsafe = remount('pricing', {
      items: [{ ...plan, cta_link: 'javascript:alert(1)' }],
    });
    // 按钮文字还在，但不可点击：不留一个点了会跑脚本的假链接。
    const placeholder = unsafe.querySelector('.pp-pricing-cta');
    expect(placeholder?.getAttribute('aria-disabled')).toBe('true');
    expect(placeholder?.hasAttribute('href')).toBe(false);
    expect(placeholder?.textContent).toBe('开始使用');
  });

  it('没填按钮文字就不画按钮，空清单不画列表', () => {
    const el = mount('pricing', {
      items: [{ name: '免费版', price: '¥0', features: '' }],
    });
    expect(el.querySelector('.pp-pricing-cta')).toBeNull();
    expect(el.querySelector('.pp-pricing-features')).toBeNull();
  });

  it('超过 4 档时只画前 4 档', () => {
    const items = Array.from({ length: 6 }, (_, index) => ({ ...plan, name: `档位 ${index}` }));
    const el = mount('pricing', { items });
    expect(el.querySelectorAll('.pp-pricing-plan').length).toBe(4);
  });
});

describe('常见问题', () => {
  const items = [
    { question: '能退款吗？', answer: '七天内可以。' },
    { question: '能开票吗？', answer: '可以。' },
  ];

  it('每条是一组原生 details / summary，问题在 summary 里', () => {
    const el = mount('faq', { items });
    const details = [...el.querySelectorAll('details.pp-faq-item')];
    expect(details.length).toBe(2);
    expect(details[0].querySelector('summary.pp-faq-question')?.textContent).toBe('能退款吗？');
    expect(details[0].querySelector('.pp-faq-answer')?.textContent).toBe('七天内可以。');
  });

  it('open_first 只让第一条展开', () => {
    const open = mount('faq', { open_first: true, items });
    const details = [...open.querySelectorAll<HTMLDetailsElement>('details.pp-faq-item')];
    expect(details[0].open).toBe(true);
    expect(details[1].open).toBe(false);

    const closed = remount('faq', { open_first: false, items });
    expect(
      [...closed.querySelectorAll<HTMLDetailsElement>('details.pp-faq-item')].every(
        (item) => !item.open,
      ),
    ).toBe(true);
  });

  it('没有问题时跳过这条，答案里的换行原样留在文本里', () => {
    const el = mount('faq', {
      items: [{ question: '', answer: '孤儿答案' }, { question: '问', answer: '第一行\n第二行' }],
    });
    const details = [...el.querySelectorAll('details.pp-faq-item')];
    expect(details.length).toBe(1);
    expect(details[0].textContent).toContain('第一行\n第二行');
  });
});

describe('用户评价', () => {
  const items: Record<string, string>[] = [
    { quote: '上线快了一倍', name: 'Ada', role: '主编', avatar: '/img/ada.png' },
    { quote: '省下很多时间', name: '李雷', role: '记者' },
  ];

  it('评价内容、姓名与头衔都画出来，头像 alt 为空串（姓名就在旁边）', () => {
    const el = mount('testimonial', { items });
    expect(el.querySelectorAll('.pp-testimonial-card').length).toBe(2);
    expect(el.querySelector('.pp-testimonial-quote')?.textContent).toBe('上线快了一倍');
    const avatar = el.querySelector<HTMLImageElement>('.pp-testimonial-avatar');
    expect(avatar?.getAttribute('src')).toBe('/img/ada.png');
    expect(avatar?.hasAttribute('alt')).toBe(true);
    expect(avatar?.getAttribute('alt')).toBe('');
    expect(el.textContent).toContain('主编');
  });

  it('没填头像的那条不画 <img>，不留破图', () => {
    const el = mount('testimonial', { items: [items[1]] });
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('省下很多时间');
  });

  it('没过白名单的头像不到 src 上', () => {
    const el = mount('testimonial', {
      items: [{ quote: 'x', name: 'Eve', avatar: 'javascript:alert(1)' }],
    });
    expect(el.querySelector('img')).toBeNull();
  });

  it('栅格与横向滑动只差一个类名，滑动版对键盘可聚焦', () => {
    const grid = mount('testimonial', { layout: 'grid', items });
    expect(grid.querySelector('.pp-testimonial')?.className).toContain('is-grid');
    expect(grid.querySelector('.pp-testimonial')?.getAttribute('tabindex')).toBeNull();

    const carousel = remount('testimonial', { layout: 'carousel', items });
    const track = carousel.querySelector('.pp-testimonial');
    expect(track?.className).toContain('is-carousel');
    // 原生滚动容器要能聚焦，键盘用户才能用方向键翻。
    expect(track?.getAttribute('tabindex')).toBe('0');
    expect(track?.getAttribute('aria-label')).toBeTruthy();
  });

  it('坏布局值退回栅格；超过 9 条时只画前 9 条', () => {
    const items12 = Array.from({ length: 12 }, (_, index) => ({ quote: `q${index}`, name: 'N' }));
    const el = mount('testimonial', { layout: 'mosaic', items: items12 });
    expect(el.querySelector('.pp-testimonial')?.className).toContain('is-grid');
    expect(el.querySelectorAll('.pp-testimonial-card').length).toBe(9);
  });
});

describe('图文交替', () => {
  it('side 控制图在哪一侧：right 加 is-right，left 不加', () => {
    const right = mount('media-text', { image: '/img/a.png', title: '更快', side: 'right' });
    expect(right.querySelector('.pp-media-text')?.className).toContain('is-right');

    const left = remount('media-text', { image: '/img/a.png', title: '更快', side: 'left' });
    expect(left.querySelector('.pp-media-text')?.className).not.toContain('is-right');
  });

  it('图片过白名单，alt 取填写的替代文字', () => {
    const el = mount('media-text', { image: '/img/a.png', alt: '编辑部封面' });
    const img = el.querySelector<HTMLImageElement>('.pp-media-text img');
    expect(img?.getAttribute('src')).toBe('/img/a.png');
    expect(img?.getAttribute('alt')).toBe('编辑部封面');

    const unsafe = remount('media-text', { image: 'javascript:alert(1)', alt: 'x' });
    expect(unsafe.querySelector('img')).toBeNull();
  });

  it('正文走 Markdown 渲染链路，不是把原文当纯文本', () => {
    const el = mount('media-text', {
      title: '一块图文',
      body: '**粗体** 与 [链接](https://example.com/a)\n\n- 一\n- 二',
    });
    const body = el.querySelector('.pp-media-text-body');
    expect(body?.querySelector('strong')?.textContent).toBe('粗体');
    // 链接的 target / rel 由 Markdown 渲染器自己补（与 text 区块同一条链路）。
    const link = body?.querySelector('a');
    expect(link?.getAttribute('href')).toBe('https://example.com/a');
    expect(link?.getAttribute('rel')).toContain('noreferrer');
    expect(body?.querySelectorAll('li').length).toBe(2);
    // 原文里的 Markdown 记号不该以字面量出现在输出里。
    expect(body?.textContent).not.toContain('**');
  });

  it('按钮走白名单，外链补 rel；没填链接时只有不可点的占位', () => {
    const external = mount('media-text', {
      title: 't',
      cta_label: '了解详情',
      cta_link: 'https://example.com/x',
    });
    const link = external.querySelector('.pp-media-text-cta');
    expect(link?.getAttribute('href')).toBe('https://example.com/x');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noreferrer noopener');

    const unsafe = remount('media-text', { title: 't', cta_label: '了解详情', cta_link: 'javascript:x' });
    const placeholder = unsafe.querySelector('.pp-media-text-cta');
    expect(placeholder?.getAttribute('aria-disabled')).toBe('true');
    expect(placeholder?.hasAttribute('href')).toBe(false);
  });

  it('什么都没有时不画一个空壳', () => {
    const el = mount('media-text', {});
    expect(el.innerHTML).toBe('');
  });

  it('只有文字没有图时照样成块，不留空图位', () => {
    const el = mount('media-text', { title: '纯文字', body: '正文' });
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('纯文字');
  });
});

describe('空状态', () => {
  it('三条带条目的区块在没有条目时给作者一句引导文案', () => {
    for (const type of ['pricing', 'faq', 'testimonial'] as const) {
      const el = remount(type, { items: [] });
      expect(el.textContent, type).toContain('在右侧添加条目。');
    }
  });
});

describe('样式', () => {
  it('「不含」的功能项是灰色删除线', () => {
    const rule = /\.pp-pricing-feature\.is-excluded\s*\{([^}]*)\}/.exec(conversionCss);
    expect(rule).not.toBeNull();
    expect(rule?.[1]).toMatch(/line-through/);
    expect(rule?.[1]).toMatch(/color:\s*var\(--muted\)/);
  });

  it('推荐档有主题色描边与角标定位', () => {
    expect(conversionCss).toMatch(/\.pp-pricing-plan\.is-featured\s*\{[^}]*border-color:\s*var\(--accent\)/);
    expect(conversionCss).toMatch(/\.pp-pricing-badge\s*\{[^}]*position:\s*absolute/);
  });

  it('横滑评价用 CSS scroll-snap，不用 JavaScript', () => {
    const rule = /\.pp-testimonial\.is-carousel\s*\{([^}]*)\}/.exec(conversionCss);
    expect(rule).not.toBeNull();
    expect(rule?.[1]).toMatch(/scroll-snap-type:\s*x/);
    expect(conversionCss).toMatch(/\.pp-testimonial\.is-carousel \.pp-testimonial-card\s*\{[^}]*scroll-snap-align:\s*start/);
  });

  it('窄屏图文交替退成一栏：图在上、文在下（断点与 P1 一致）', () => {
    expect(conversionCss).toMatch(
      /@media\s*\(max-width:\s*767px\)\s*\{[^}]*\.pp-media-text\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    );
  });

  it('按钮与折叠标题都有可见的键盘焦点环', () => {
    expect(conversionCss).toMatch(
      /\.pp-pricing-cta:focus-visible[^{]*\{[^}]*outline:\s*2px solid var\(--accent\)/,
    );
    expect(conversionCss).toMatch(
      /\.pp-faq-question:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/,
    );
  });
});
