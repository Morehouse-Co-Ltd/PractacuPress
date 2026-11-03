import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { BlockInstance, BlockProps, Content } from '../types';
import queryCss from '../styles.css?raw';

/**
 * P3 查询块（`content-query`）。
 *
 * 这个测试钉住五件事：
 * 1. 两个纯函数：窗口 → RFC3339、props → 请求参数（空值不出现，而不是空串）；
 * 2. 注册表定义：分组、变体、defaults 与 schema 一致、归一化幂等；
 * 3. 渲染器真的注册进了生产用的 `RENDERERS`，骨架形状也登记了；
 * 4. 两条取数路径：真实后端走 `listContent` 且带上筛选参数，演示模式不发请求、
 *    直接渲染现有演示数据（不伪造服务端筛选）；
 * 5. 编辑器提示：演示模式下不生效的条件在 schema 里写明。
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

/**
 * 演示 / 真实两种后端的替身：只实现查询块用到的 `listContent`。
 *
 * 两个约束：
 * - 后端对象必须**稳定**（每次渲染返回同一个引用），渲染器把它放进 `useAsync`
 *   的依赖里，每次新建对象会让 effect 一直重跑；
 * - 测试读写的是同一个 `state`，替身每次调用都从 `state` 现读，重置才不需要重建
 *   替身（重建等于换掉了闭包里那份数据）。
 */
const fake = vi.hoisted(() => {
  const state = {
    demo: true as boolean,
    calls: [] as { kind: string; options: Record<string, unknown> }[],
    pages: {} as Record<string, Content[]>,
  };
  const backend = {
    listContent: async (kind: string, options: Record<string, unknown> = {}) => {
      state.calls.push({ kind, options });
      return { items: state.pages[kind] ?? [], next_cursor: '', has_more: false };
    },
  };
  return { state, backend };
});

vi.mock('./backend', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./backend')>();
  return {
    ...actual,
    useBackend: () => fake.backend,
    isDemo: () => fake.state.demo,
  };
});

import { blockDef, createBlock, queryRequest, sinceFromWindow } from './blocks';
import { normalizeBlockProps } from './customize';
import { BLOCK_SKELETON_SHAPES } from './loading';
import { BLOCK_RENDERERS } from '../components/blocks/index';
import { QUERY_RENDERERS } from '../components/blocks/QueryBlocks';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/* ---------------- 纯函数 ---------------- */

describe('sinceFromWindow', () => {
  const now = new Date('2026-11-03T00:00:00Z');
  it('all 不带时间条件', () => {
    expect(sinceFromWindow('all', now)).toBeUndefined();
  });
  it('7d / 30d 换算成 RFC3339', () => {
    expect(sinceFromWindow('7d', now)).toBe('2026-10-27T00:00:00.000Z');
    expect(sinceFromWindow('30d', now)).toBe('2026-10-04T00:00:00.000Z');
  });
  it('坏值回落到不带条件', () => {
    expect(sinceFromWindow('nope', now)).toBeUndefined();
  });
});

describe('queryRequest', () => {
  it('latest 不带分类与标签', () => {
    const req = queryRequest({ source: 'latest', limit: 6, sort: 'newest' } as never);
    expect(req.categoryId).toBeUndefined();
    expect(req.tag).toBeUndefined();
    expect(req.limit).toBe(6);
  });
  it('category 源带上 term_id', () => {
    const req = queryRequest({ source: 'category', term_id: 'cat-1', limit: 3 } as never);
    expect(req.categoryId).toBe('cat-1');
  });
  it('空 term_id 不产生空串条件', () => {
    const req = queryRequest({ source: 'category', term_id: '', limit: 3 } as never);
    expect(req.categoryId).toBeUndefined();
  });

  it('tag / author 源各自只带一个条件，且值会去掉首尾空格', () => {
    const tag = queryRequest({ source: 'tag', term_id: '  夜航  ' } as never);
    expect(tag.tag).toBe('夜航');
    expect(tag.categoryId).toBeUndefined();

    const author = queryRequest({ source: 'author', term_id: 'u_1' } as never);
    expect(author.authorId).toBe('u_1');
    expect(author.tag).toBeUndefined();
  });

  it('最新 / 最旧与排序字段原样透传；坏值回落到最新', () => {
    expect(queryRequest({ sort: 'oldest' } as never).sort).toBe('oldest');
    expect(queryRequest({ sort: 'sideways' } as never).sort).toBe('newest');
  });

  it('limit 夹到 1–24，缺省 6；layout 只认 list / grid', () => {
    expect(queryRequest({ limit: 99 } as never).limit).toBe(24);
    expect(queryRequest({ limit: 0 } as never).limit).toBe(1);
    expect(queryRequest({} as never).limit).toBe(6);
    expect(queryRequest({ layout: 'list' } as never).layout).toBe('list');
    expect(queryRequest({ layout: 'masonry' } as never).layout).toBe('grid');
  });

  it('window 换成 since，all 不带条件', () => {
    const now = new Date('2026-11-03T00:00:00Z');
    expect(queryRequest({ window: '7d' } as never, now).since).toBe('2026-10-27T00:00:00.000Z');
    expect(queryRequest({ window: 'all' } as never, now).since).toBeUndefined();
  });
});

/* ---------------- 注册表 ---------------- */

const TYPE = 'content-query';

function field(key: string) {
  return blockDef(TYPE)?.schema.find((item) => item.key === key);
}

describe('注册表定义', () => {
  it('注册在内容组，经典与夜航都能用', () => {
    const def = blockDef(TYPE);
    expect(def).toBeTruthy();
    expect(def?.group).toBe('content');
    expect(def?.variants).toEqual(['classic', 'bento']);
    expect(def?.name.trim()).not.toBe('');
    expect(def?.description.trim()).not.toBe('');
  });

  it('defaults 是约定的初始内容，且每个键都声明在 schema 里', () => {
    const defaults = blockDef(TYPE)?.defaults ?? {};
    expect(defaults).toEqual({
      source: 'latest',
      term_id: '',
      window: 'all',
      sort: 'newest',
      layout: 'grid',
      limit: 6,
      show_excerpt: true,
      show_meta: true,
    });
    const declared = new Set((blockDef(TYPE)?.schema ?? []).map((item) => item.key));
    expect(Object.keys(defaults).filter((key) => !declared.has(key))).toEqual([]);
  });

  it('defaults 经过归一化后原样保留', () => {
    const created = createBlock(TYPE).props;
    expect(normalizeBlockProps(TYPE, created)).toEqual(created);
  });

  it('source 四档、window 三档、sort 两档、layout 两档', () => {
    expect(field('source')?.options?.map((option) => option.value)).toEqual([
      'latest',
      'category',
      'tag',
      'author',
    ]);
    expect(field('window')?.options?.map((option) => option.value)).toEqual(['all', '7d', '30d']);
    expect(field('sort')?.options?.map((option) => option.value)).toEqual(['newest', 'oldest']);
    expect(field('layout')?.options?.map((option) => option.value)).toEqual(['list', 'grid']);
  });

  it('limit 是 1–24 的数字，两个开关都是 toggle', () => {
    const limit = field('limit');
    expect(limit?.type).toBe('number');
    expect(limit?.min).toBe(1);
    expect(limit?.max).toBe(24);
    expect(field('show_excerpt')?.type).toBe('toggle');
    expect(field('show_meta')?.type).toBe('toggle');
  });

  it('演示模式不生效的条件在编辑器提示里写明', () => {
    for (const key of ['term_id', 'window', 'sort'] as const) {
      expect(field(key)?.hint ?? '', key).toMatch(/演示模式/);
    }
  });
});

/* ---------------- 渲染器与骨架 ---------------- */

describe('渲染器注册', () => {
  it('生产 RENDERERS 里能找到，且 QUERY_RENDERERS 只有这一条', () => {
    expect(typeof BLOCK_RENDERERS[TYPE]).toBe('function');
    expect(Object.keys(QUERY_RENDERERS)).toEqual([TYPE]);
  });

  it('骨架形状已登记（它依赖 feed 数据）', () => {
    expect(BLOCK_SKELETON_SHAPES[TYPE]).toBe('grid');
  });
});

/* ---------------- 渲染 ---------------- */

function content(id: string, patch: Partial<Content> = {}): Content {
  return {
    id,
    kind: 'article',
    status: 'published',
    title: `标题 ${id}`,
    slug: id,
    summary: `摘要 ${id}`,
    source_format: 'markdown',
    rendered_html: '<p>正文</p>',
    policy_version: 'policy-2026.10',
    published_at: '2026-11-01T00:00:00Z',
    created_at: '2026-10-30T00:00:00Z',
    updated_at: '2026-11-01T00:00:00Z',
    actions: [],
    ...patch,
  };
}

function mk(props: BlockProps): BlockInstance {
  return { id: TYPE, type: TYPE, title: TYPE, props, animation: 'none', hidden: false };
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function mount(props: BlockProps): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  const Renderer = QUERY_RENDERERS[TYPE];
  await act(async () => {
    root?.render(
      createElement(MemoryRouter, null, createElement(Renderer, { block: mk(props) })),
    );
  });
  await act(async () => {
    await Promise.resolve();
  });
  return host;
}

beforeEach(() => {
  fake.state.demo = true;
  fake.state.calls = [];
  fake.state.pages = {};
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('演示模式', () => {
  it('不发请求，也不拿筛选条件去假装筛选', async () => {
    const el = await mount({ source: 'tag', term_id: '夜航', window: '7d', sort: 'oldest', limit: 4 });
    expect(fake.state.calls).toEqual([]);
    // 没有演示数据时只说一句话，不渲染空容器。
    expect(el.querySelector('.pp-query-empty')?.textContent).toBe('这里还没有内容。');
    expect(el.querySelector('.pp-article-grid')).toBeNull();
  });
});

describe('真实后端', () => {
  it('文章与帖子各取一次，带上分类、时间与排序参数', async () => {
    fake.state.demo = false;
    fake.state.pages = {
      article: [content('a1')],
      post: [content('p1', { kind: 'post' })],
    };
    const el = await mount({
      source: 'category',
      term_id: 'cat-1',
      window: 'all',
      sort: 'oldest',
      layout: 'grid',
      limit: 6,
    });

    expect(fake.state.calls.map((call) => call.kind).sort()).toEqual(['article', 'post']);
    for (const call of fake.state.calls) {
      expect(call.options).toMatchObject({ categoryId: 'cat-1', sort: 'oldest', limit: 6 });
      expect(call.options.since).toBeUndefined();
    }
    expect(el.querySelectorAll('.pp-article-card').length).toBe(2);
    expect(el.querySelector('.pp-article-grid')?.className).toContain('is-grid');
  });

  it('合并两个端点后按 sort 重排，并按 limit 截断', async () => {
    fake.state.demo = false;
    fake.state.pages = {
      article: [
        content('new', { published_at: '2026-11-02T00:00:00Z' }),
        content('old', { published_at: '2026-09-01T00:00:00Z' }),
      ],
      post: [content('mid', { kind: 'post', published_at: '2026-10-01T00:00:00Z' })],
    };
    const el = await mount({ source: 'latest', window: 'all', sort: 'newest', limit: 2 });
    const titles = [...el.querySelectorAll('.pp-article-copy strong')].map((node) => node.textContent);
    expect(titles).toEqual(['标题 new', '标题 mid']);
  });

  it('列表布局用单列，并复用「文章组件」的卡片类名', async () => {
    fake.state.demo = false;
    fake.state.pages = { article: [content('a1')], post: [] };
    const el = await mount({ layout: 'list', limit: 3 });
    expect(el.querySelector('.pp-article-grid')?.className).toContain('is-list');
    expect(el.querySelector('.pp-article-card')?.className).toContain('is-list');
  });
});

/* ---------------- 样式 ---------------- */

describe('样式', () => {
  it('空态是一句灰字，不是一块卡片', () => {
    expect(queryCss).toMatch(/\.pp-query-empty\s*\{[^}]*color:\s*var\(--muted\)/);
  });

  it('查询块容器与卡片网格之间的间距走同一个类名', () => {
    expect(queryCss).toMatch(/\.pp-query-block\s*\{[^}]*gap:\s*14px/);
  });
});
