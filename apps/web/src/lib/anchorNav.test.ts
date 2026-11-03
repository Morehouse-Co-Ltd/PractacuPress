import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { BlockInstance, ScreenLayout } from '../types';
import anchorCss from '../styles.css?raw';
import { blockDef, createBlock } from './blocks';
import { normalizeBlockProps } from './customize';
import { anchorIds, anchorTargets, normalizeAnchor } from './anchorNav';

/**
 * 锚点与本页目录（P3 Task 3）。
 *
 * 这里钉住四层：
 * 1. **纯函数**：`normalizeAnchor` 的归一化 / 截断，`anchorTargets` / `anchorIds`
 *    的递归收集、文档顺序与「第一次出现者胜」；
 * 2. **注册表**：`anchor-nav` 有定义、defaults ⊆ schema、归一化幂等、渲染器进了生产
 *    用的 `RENDERERS`；
 * 3. **接线**：锚点变成 `<section>` 的 `id`（不是包一层），重复与非法锚点不产生
 *    `id`，空串绝不写成 `id=""`；
 * 4. **目录**：`<nav aria-label="本页目录">` + 原生 `<a href="#anchor">`，
 *    滚动高亮走 `IntersectionObserver`（阈值 0.25，卸载 `disconnect()`），
 *    没有 `IntersectionObserver` 的环境退化成不高亮、不崩。
 *
 * 平滑滚动交给 CSS：`html { scroll-behavior: smooth }` 与 `prefers-reduced-motion`
 * 下的关闭都复用 `styles.css` 里已有的规则，不写第二份——所以这里断言的是**已有**
 * 的那条规则，而不是新加一条。
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

import { BLOCK_RENDERERS, ScreenRenderer } from '../components/blocks/index';
import { ANCHOR_RENDERERS } from '../components/blocks/AnchorNav';
import { AnchorScopeProvider } from '../components/blocks/AnchorScope';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ------------------------------ 夹具 ------------------------------ */

/** 手搓一个区块：不依赖 schema，纯函数测试要什么 props 就给什么。 */
function blk(id: string, patch: Partial<BlockInstance> = {}): BlockInstance {
  return { id, type: 'text', title: id, props: {}, animation: 'none', hidden: false, ...patch };
}

function toc(patch: Partial<BlockInstance> = {}): BlockInstance {
  // 入场动画关掉：没有任何 IntersectionObserver 时 `useInView` 会立刻判成「已进入视口」，
  // 在 happy-dom 里 `Element.animate` 不存在，动画与本任务无关，别让它干扰断言。
  return createBlock('anchor-nav', { id: 'toc', animation: 'none', ...patch });
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

/** 直接挂渲染器（带锚点上下文），不经过编排外壳。 */
function mountNav(blocks: BlockInstance[], nav: BlockInstance = toc()): HTMLDivElement {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const Renderer = ANCHOR_RENDERERS['anchor-nav'];
  act(() => {
    root?.render(
      createElement(AnchorScopeProvider, {
        blocks: [...blocks, nav],
        children: createElement(Renderer, { block: nav }),
      }),
    );
  });
  return host;
}

/** 挂整份编排：锚点要在真实的 `ScreenRenderer` 里落到 section 上。 */
function mountScreen(layout: ScreenLayout): HTMLDivElement {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => {
    root?.render(createElement(ScreenRenderer, { layout }));
  });
  return host;
}

function section(el: HTMLElement, id: string): HTMLElement {
  const node = el.querySelector<HTMLElement>(`[data-pp-block="${id}"]`);
  if (!node) throw new Error(`missing block ${id}`);
  return node;
}

/* ------------------- IntersectionObserver 替身 ------------------- */

class FakeObserver {
  static live: FakeObserver[] = [];
  elements: Element[] = [];
  disconnected = false;
  constructor(
    public callback: IntersectionObserverCallback,
    public options?: IntersectionObserverInit,
  ) {
    FakeObserver.live.push(this);
  }
  observe(target: Element) {
    this.elements.push(target);
  }
  unobserve() {}
  disconnect() {
    this.disconnected = true;
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  /** 手动喂一批条目，模拟「某一节滚进视口」。 */
  emit(entries: { target: Element; isIntersecting: boolean; top: number }[]) {
    this.callback(
      entries.map((entry) => ({
        target: entry.target,
        isIntersecting: entry.isIntersecting,
        boundingClientRect: { top: entry.top },
      })) as unknown as IntersectionObserverEntry[],
      this as unknown as IntersectionObserver,
    );
  }
}

const originalObserver = (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;

function installObserver() {
  FakeObserver.live = [];
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = FakeObserver;
}

/** 目录用的那个 observer：阈值 0.25（`useInView` 用的是 rootMargin，不会撞上）。 */
function navObserver(): FakeObserver {
  const found = FakeObserver.live.find((item) => item.options?.threshold === 0.25);
  if (!found) throw new Error('table of contents never observed anything');
  return found;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
  FakeObserver.live = [];
  (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = originalObserver;
  window.innerWidth = 1280;
});

// happy-dom 默认视口够宽，`useViewportDevice` 判成 desktop。
window.innerWidth = 1280;

/* ------------------------------ 纯函数 ------------------------------ */

describe('normalizeAnchor（锚点归一化）', () => {
  it('转小写、空白转连字符', () => {
    expect(normalizeAnchor('Hello World')).toBe('hello-world');
    expect(normalizeAnchor('  关于 我们  ')).toBe('');
    expect(normalizeAnchor('2026 Q1 报告')).toBe('2026-q1');
  });

  it('只留小写字母、数字与连字符', () => {
    expect(normalizeAnchor('FAQ')).toBe('faq');
    expect(normalizeAnchor('a__b!!c')).toBe('abc');
    expect(normalizeAnchor('中文拼音')).toBe('');
    expect(normalizeAnchor('émoji 🎉 ok')).toBe('moji-ok');
  });

  it('连续连字符并成一个，首尾连字符去掉', () => {
    expect(normalizeAnchor('  --a---b--  ')).toBe('a-b');
    expect(normalizeAnchor('-lead')).toBe('lead');
    expect(normalizeAnchor('trail-')).toBe('trail');
  });

  it('已经合法的锚点原样保留', () => {
    expect(normalizeAnchor('my-anchor-2')).toBe('my-anchor-2');
  });

  it('截断到 40 个字符，截断处不留结尾连字符', () => {
    expect(normalizeAnchor('c'.repeat(60))).toBe('c'.repeat(40));
    // 39 个 c + 空格 + b = 41 个字符，截断后正好停在连字符上，得再抹掉。
    expect(normalizeAnchor(`${'c'.repeat(39)} b`)).toBe('c'.repeat(39));
  });

  it('空值与非 ASCII 一律得到空串（绝不返回一个 id 会空掉的锚点）', () => {
    expect(normalizeAnchor('')).toBe('');
    expect(normalizeAnchor('   ')).toBe('');
    expect(normalizeAnchor('---')).toBe('');
    expect(normalizeAnchor('\n\t')).toBe('');
  });
});

describe('anchorTargets（目录目标）', () => {
  it('按文档顺序收集，父区块排在子区块前面', () => {
    const blocks = [
      blk('a', { anchor: 'intro', props: { title: '开场' } }),
      blk('box', {
        children: [
          blk('b', { anchor: 'details', props: { heading: '细节' } }),
          blk('c', { anchor: 'outro', props: { title: '结尾' } }),
        ],
      }),
    ];
    expect(anchorTargets(blocks)).toEqual([
      { anchor: 'intro', title: '开场' },
      { anchor: 'details', title: '细节' },
      { anchor: 'outro', title: '结尾' },
    ]);
  });

  it('标题按 props.title → props.heading → 后台显示名 → 锚点 的顺序取', () => {
    const blocks = [
      blk('a', { anchor: 'one', props: { title: '正文标题', heading: '小标题' } }),
      blk('b', { anchor: 'two', props: { heading: '小标题' } }),
      blk('c', { anchor: 'three', title: '后台显示名' }),
      blk('d', { anchor: 'four', title: '' }),
    ];
    expect(anchorTargets(blocks).map((item) => item.title)).toEqual([
      '正文标题',
      '小标题',
      '后台显示名',
      'four',
    ]);
  });

  it('锚点先归一化，重复时第一次出现者胜', () => {
    const blocks = [
      blk('a', { anchor: 'Intro', props: { title: '第一次' } }),
      blk('b', { anchor: ' intro ', props: { title: '第二次' } }),
    ];
    expect(anchorTargets(blocks)).toEqual([{ anchor: 'intro', title: '第一次' }]);
  });

  it('空锚点与归一化后为空的锚点都不进目录', () => {
    const blocks = [
      blk('a'),
      blk('b', { anchor: '' }),
      blk('c', { anchor: '   ' }),
      blk('d', { anchor: '中文' }),
    ];
    expect(anchorTargets(blocks)).toEqual([]);
  });

  it('隐藏与不支持的区块连同子树都不进目录', () => {
    const blocks = [
      blk('a', { anchor: 'shown' }),
      blk('b', {
        anchor: 'hidden',
        hidden: true,
        children: [blk('b1', { anchor: 'hidden-child' })],
      }),
      blk('c', {
        anchor: 'unsupported',
        unsupported: true,
        children: [blk('c1', { anchor: 'unsupported-child' })],
      }),
    ];
    expect(anchorTargets(blocks).map((item) => item.anchor)).toEqual(['shown']);
  });
});

describe('anchorIds（区块 id → 锚点）', () => {
  it('只给拿到锚点的那一个区块建映射（重复的后来者没有）', () => {
    const blocks = [
      blk('a', { anchor: 'Intro' }),
      blk('b', { anchor: 'intro' }),
      blk('c'),
    ];
    const ids = anchorIds(blocks);
    expect(ids.get('a')).toBe('intro');
    expect(ids.has('b')).toBe(false);
    expect(ids.has('c')).toBe(false);
    expect(ids.size).toBe(1);
  });

  it('子区块也拿到锚点', () => {
    const blocks = [blk('box', { children: [blk('kid', { anchor: 'kid-anchor' })] })];
    expect(anchorIds(blocks).get('kid')).toBe('kid-anchor');
  });
});

/* ------------------------------ 注册表 ------------------------------ */

describe('anchor-nav 的注册表定义', () => {
  it('在区块目录里，内容组、经典与夜航都能用', () => {
    const def = blockDef('anchor-nav');
    expect(def).toBeTruthy();
    expect(def?.name).toBe('本页目录');
    expect(def?.description.trim()).not.toBe('');
    expect(def?.group).toBe('content');
    expect(def?.variants).toEqual(['classic', 'bento']);
  });

  it('defaults 是约定的初始内容，且每个键都声明在 schema 里', () => {
    const def = blockDef('anchor-nav');
    expect(def?.defaults).toEqual({ heading: '' });
    const declared = new Set((def?.schema ?? []).map((item) => item.key));
    for (const key of Object.keys(def?.defaults ?? {})) expect(declared.has(key), key).toBe(true);
    expect(def?.schema.find((item) => item.key === 'heading')?.type).toBe('text');
  });

  it('defaults 经过归一化后原样保留', () => {
    const created = createBlock('anchor-nav').props;
    expect(normalizeBlockProps('anchor-nav', created)).toEqual(created);
  });

  it('渲染器注册进了生产用的 RENDERERS', () => {
    expect(typeof BLOCK_RENDERERS['anchor-nav']).toBe('function');
    expect(Object.keys(ANCHOR_RENDERERS)).toEqual(['anchor-nav']);
  });
});

/* ------------------------------ 目录渲染 ------------------------------ */

describe('本页目录的渲染', () => {
  it('画成 nav[aria-label=本页目录] + 一组原生锚点链接', () => {
    const el = mountNav([
      blk('a', { anchor: 'intro', props: { title: '开场' } }),
      blk('b', { anchor: 'details', props: { title: '细节' } }),
    ]);
    const nav = el.querySelector('nav.pp-anchor-nav');
    expect(nav).not.toBeNull();
    expect(nav?.getAttribute('aria-label')).toBe('本页目录');
    const links = [...el.querySelectorAll<HTMLAnchorElement>('.pp-anchor-nav-link')];
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['#intro', '#details']);
    expect(links.map((link) => link.textContent)).toEqual(['开场', '细节']);
    // 原生锚点：没有 click 处理器，不靠 scrollIntoView 抢跳转。
    expect(links.every((link) => !link.hasAttribute('onclick'))).toBe(true);
    expect(links.every((link) => link.tagName === 'A')).toBe(true);
  });

  it('标题按填写的显示；留空只画列表', () => {
    const withHeading = mountNav(
      [blk('a', { anchor: 'intro', props: { title: '开场' } })],
      toc({ props: { heading: '本页内容' } }),
    );
    expect(withHeading.querySelector('.pp-anchor-nav-heading')?.textContent).toBe('本页内容');
    act(() => root?.unmount());
    host?.remove();

    const plain = mountNav([blk('a', { anchor: 'intro', props: { title: '开场' } })]);
    expect(plain.querySelector('.pp-anchor-nav-heading')).toBeNull();
    expect(plain.querySelectorAll('.pp-anchor-nav-link').length).toBe(1);
  });

  it('一个锚点都没有时给作者一句引导，而不是一块空白', () => {
    const el = mountNav([]);
    expect(el.querySelector('nav.pp-anchor-nav')?.getAttribute('aria-label')).toBe('本页目录');
    expect(el.querySelectorAll('.pp-anchor-nav-link').length).toBe(0);
    expect(el.querySelector('.pp-anchor-nav-empty')?.textContent).toBe(
      '给其他区块填上锚点后，这里会出现本页目录。',
    );
  });

  it('重复锚点在目录里只出现一次（第一次出现者胜）', () => {
    const el = mountNav([
      blk('a', { anchor: 'Intro', props: { title: '第一次' } }),
      blk('b', { anchor: 'intro', props: { title: '第二次' } }),
    ]);
    const links = [...el.querySelectorAll('.pp-anchor-nav-link')];
    expect(links.map((link) => link.textContent)).toEqual(['第一次']);
  });

  it('没有 IntersectionObserver 的环境退化为不高亮，跳转照旧', () => {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = undefined;
    const el = mountNav([blk('a', { anchor: 'intro', props: { title: '开场' } })]);
    expect(el.querySelectorAll('.pp-anchor-nav-link').length).toBe(1);
    expect(el.querySelector('.pp-anchor-nav-link')?.hasAttribute('aria-current')).toBe(false);
  });
});

/* --------------------- 接线：锚点 → section 的 id --------------------- */

describe('锚点落到 section 上', () => {
  it('锚点成为 <section> 的 id（不是再包一层），归一化后写入', () => {
    const el = mountScreen({
      blocks: [blk('a', { anchor: 'Intro Section', props: { title: '开场' } })],
    });
    const node = section(el, 'a');
    expect(node.tagName).toBe('SECTION');
    expect(node.id).toBe('intro-section');
    expect(el.querySelector('[id="intro-section"]')).toBe(node);
  });

  it('重复锚点只有第一个拿到 id；后面的不写 id，更不写 id=""', () => {
    const el = mountScreen({
      blocks: [
        blk('a', { anchor: 'intro' }),
        blk('b', { anchor: 'intro' }),
        blk('c', { anchor: '中文' }),
        blk('d', { anchor: '   ' }),
        blk('e'),
      ],
    });
    expect(section(el, 'a').id).toBe('intro');
    for (const id of ['b', 'c', 'd', 'e']) {
      expect(section(el, id).hasAttribute('id'), id).toBe(false);
    }
    expect(el.querySelector('[id=""]')).toBeNull();
  });

  it('隐藏的区块不渲染，也就不抢锚点', () => {
    const el = mountScreen({
      blocks: [
        blk('hidden', { anchor: 'intro', hidden: true }),
        blk('shown', { anchor: 'intro' }),
      ],
    });
    expect(section(el, 'shown').id).toBe('intro');
  });

  it('子区块的锚点也生效', () => {
    const el = mountScreen({
      blocks: [blk('box', { type: 'container', children: [blk('kid', { anchor: 'kid-anchor' })] })],
    });
    expect(section(el, 'kid').id).toBe('kid-anchor');
    expect(section(el, 'box').hasAttribute('id')).toBe(false);
  });

  it('页面里的目录列出同一份锚点（区块侧与目录侧共用一套规则）', () => {
    const el = mountScreen({
      blocks: [
        blk('a', { anchor: 'Intro', props: { title: '开场' } }),
        blk('b', { anchor: 'intro', props: { title: '重复' } }),
        blk('c', { anchor: 'details', props: { title: '细节' } }),
        toc(),
      ],
    });
    const links = [...el.querySelectorAll<HTMLAnchorElement>('.pp-anchor-nav-link')];
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['#intro', '#details']);
    // 每一个目录链接都指向真的存在的区块 id。
    for (const link of links) {
      const target = link.getAttribute('href')?.slice(1) ?? '';
      expect(el.querySelector(`[id="${target}"]`), target).not.toBeNull();
    }
  });
});

/* ---------------------------- 滚动高亮 ---------------------------- */

describe('滚动高亮', () => {
  const layout = (): ScreenLayout => ({
    blocks: [
      blk('a', { anchor: 'intro', props: { title: '开场' } }),
      blk('b', { anchor: 'details', props: { title: '细节' } }),
      toc(),
    ],
  });

  it('用阈值 0.25 观察每一节，命中时给链接加 aria-current', () => {
    installObserver();
    const el = mountScreen(layout());
    const observer = navObserver();
    expect(observer.options?.threshold).toBe(0.25);
    expect(observer.elements.map((node) => node.id)).toEqual(['intro', 'details']);

    act(() => {
      observer.emit([
        { target: section(el, 'a'), isIntersecting: true, top: 120 },
        { target: section(el, 'b'), isIntersecting: false, top: 900 },
      ]);
    });
    const links = [...el.querySelectorAll<HTMLAnchorElement>('.pp-anchor-nav-link')];
    expect(links[0].getAttribute('aria-current')).toBe('location');
    expect(links[1].hasAttribute('aria-current')).toBe(false);
  });

  it('同时有两节在视口里时取最靠上的那一节', () => {
    installObserver();
    const el = mountScreen(layout());
    const observer = navObserver();
    act(() => {
      observer.emit([
        { target: section(el, 'b'), isIntersecting: true, top: 400 },
        { target: section(el, 'a'), isIntersecting: true, top: 40 },
      ]);
    });
    expect(
      el.querySelector('.pp-anchor-nav-link[aria-current="location"]')?.getAttribute('href'),
    ).toBe('#intro');
  });

  it('卸载时 disconnect()', () => {
    installObserver();
    mountScreen(layout());
    const observer = navObserver();
    expect(observer.disconnected).toBe(false);
    act(() => root?.unmount());
    expect(observer.disconnected).toBe(true);
  });

  it('没有 IntersectionObserver 时不崩、不高亮', () => {
    (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver = undefined;
    const el = mountScreen(layout());
    expect(el.querySelectorAll('.pp-anchor-nav-link').length).toBe(2);
    expect(el.querySelector('[aria-current]')).toBeNull();
  });
});

/* ------------------------------ 样式 ------------------------------ */

describe('样式', () => {
  it('平滑滚动复用 html 上已有的 scroll-behavior，不写第二份', () => {
    expect(anchorCss).toMatch(/html\s*\{[^}]*scroll-behavior:\s*smooth/);
    // prefers-reduced-motion 下关掉（同一条规则的另一半，同样已存在）。
    expect(anchorCss).toMatch(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{\s*html\s*\{\s*scroll-behavior:\s*auto/,
    );
    // 只有 rules 里 html 那一处是 smooth：再抄一份就说明重复了。
    expect(anchorCss.match(/html\s*\{[^}]*scroll-behavior:\s*smooth/g)?.length).toBe(1);
  });

  it('锚点落点留出吸顶栏的高度（scroll-margin-top）', () => {
    expect(anchorCss).toMatch(/\.pp-block\[id\]\s*\{[^}]*scroll-margin-top:\s*\d/);
  });

  it('当前一节用主题色标出', () => {
    expect(anchorCss).toMatch(
      /\.pp-anchor-nav-link\[aria-current="location"\]\s*\{[^}]*color:\s*var\(--accent\)/,
    );
  });

  it('链接的点击区够大，键盘焦点看得见', () => {
    expect(anchorCss).toMatch(/\.pp-anchor-nav-link\s*\{[^}]*padding:/);
    expect(anchorCss).toMatch(/\.pp-anchor-nav-link:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/);
  });
});
