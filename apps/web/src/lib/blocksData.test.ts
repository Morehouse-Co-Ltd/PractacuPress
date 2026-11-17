import { describe, expect, it } from 'vitest';
import type { BlockInstance, Content } from '../types';
import { blockDef, createBlock, hasArticleContent } from './blocks';
import {
  BLOCK_DATA_SOURCES,
  bindKeyOf,
  boundToken,
  hasBoundProps,
  resolveBoundProps,
  resolveDataToken,
  type BlockDataContext,
} from './blocksData';

function article(patch: Partial<Content> = {}): Content {
  return {
    id: 'art_1',
    kind: 'article',
    status: 'published',
    title: '一个安静的院子',
    slug: 'quiet-yard',
    summary: '关于写作与房子的短文。',
    source_format: 'markdown',
    rendered_html: '<h2>开头</h2><p>正文</p>',
    policy_version: 'v1',
    created_at: '2026-10-01T08:00:00Z',
    published_at: '2026-10-02T09:30:00Z',
    updated_at: '2026-10-03T10:00:00Z',
    actions: [],
    author_id: 'u_1',
    author_name: '林晚',
    category_id: 'cat_1',
    tags: ['写作', '房子'],
    ...patch,
  };
}

function block(props: Record<string, string | number | boolean>): BlockInstance {
  return {
    id: 'blk_1',
    type: 'text',
    title: '文本',
    props,
    animation: 'fade-up',
    hidden: false,
  };
}

function context(patch: Partial<BlockDataContext> = {}): BlockDataContext {
  return {
    article: article(),
    kind: 'article',
    url: '/a/art_1',
    authorName: '林晚',
    publishedLabel: '2026.10.02 09:30',
    updatedLabel: '2026.10.03 10:00',
    categoryName: '随笔',
    tags: ['写作', '房子'],
    readingMinutes: 6,
    views: 128,
    siteName: '一间接待所',
    currentYear: 2026,
    ...patch,
  };
}

describe('数据源目录', () => {
  it('覆盖文章与站点需要的 token', () => {
    const tokens = BLOCK_DATA_SOURCES.map((source) => source.token);
    for (const token of [
      'article.title',
      'article.summary',
      'article.author',
      'article.published_at',
      'article.updated_at',
      'article.category',
      'article.tags',
      'article.reading_time',
      'article.views',
      'article.url',
      'site.name',
      'site.year',
    ]) {
      expect(tokens).toContain(token);
    }
  });

  it('每个 token 都有中文标签', () => {
    for (const source of BLOCK_DATA_SOURCES) {
      expect(source.label.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('resolveBoundProps', () => {
  it('没有绑定时原样返回，且不共享引用', () => {
    const source = block({ title: '手写标题', eyebrow: '眉题' });
    const props = resolveBoundProps(source, context());
    expect(props).toEqual({ title: '手写标题', eyebrow: '眉题' });
    expect(props).not.toBe(source.props);
    expect(source.props.title).toBe('手写标题');
  });

  it('绑定命中时用数据替换文字，回退文字保留在 bind 键旁边', () => {
    const source = block({
      title: '手写标题',
      eyebrow: '眉题',
      'bind:title': 'article.title',
    });
    const props = resolveBoundProps(source, context());
    expect(props.title).toBe('一个安静的院子');
    expect(props.eyebrow).toBe('眉题');
    expect(props['bind:title']).toBe('article.title');
    // 入参不被修改
    expect(source.props.title).toBe('手写标题');
  });

  it('上下文缺失（首页 / 加载中 / 404）时回退到手写文字', () => {
    const source = block({ title: '手写标题', 'bind:title': 'article.title' });
    expect(resolveBoundProps(source, null).title).toBe('手写标题');
    expect(resolveBoundProps(source, undefined).title).toBe('手写标题');
    expect(resolveBoundProps(source, { article: null }).title).toBe('手写标题');
    expect(resolveBoundProps(source, {}).title).toBe('手写标题');
  });

  it('数据字段为空时也回退，不会渲染空串', () => {
    const source = block({ title: '手写标题', 'bind:title': 'article.title' });
    const props = resolveBoundProps(source, context({ article: article({ title: '' }) }));
    expect(props.title).toBe('手写标题');
  });

  it('认不出的 token 与脏数据都安静回退', () => {
    const source = block({
      title: '手写标题',
      'bind:title': 'article.title',
      'bind:body': 'legacy.removed_token',
      'bind:caption': '__proto__',
      'bind:link': 42,
    });
    expect(() => resolveBoundProps(source, context())).not.toThrow();
    const props = resolveBoundProps(source, context());
    expect(props.title).toBe('一个安静的院子');
    expect(props.body).toBeUndefined();
    expect(props.caption).toBeUndefined();
    expect(props.link).toBeUndefined();
    // 原型没有被污染
    expect(({} as Record<string, unknown>).article).toBeUndefined();
  });

  it('不认识的键名不会写进结果', () => {
    const source = block({ 'bind:__proto__': 'article.title' });
    const props = resolveBoundProps(source, context());
    expect(Object.keys(props)).toEqual(['bind:__proto__']);
  });
});

describe('resolveDataToken', () => {
  const ctx = context();

  it('逐步解析每个数据源', () => {
    expect(resolveDataToken('article.title', ctx)).toBe('一个安静的院子');
    expect(resolveDataToken('article.summary', ctx)).toBe('关于写作与房子的短文。');
    expect(resolveDataToken('article.author', ctx)).toBe('林晚');
    expect(resolveDataToken('article.published_at', ctx)).toBe('2026.10.02 09:30');
    expect(resolveDataToken('article.updated_at', ctx)).toBe('2026.10.03 10:00');
    expect(resolveDataToken('article.category', ctx)).toBe('随笔');
    expect(resolveDataToken('article.tags', ctx)).toBe('写作 · 房子');
    expect(resolveDataToken('article.reading_time', ctx)).toBe('6 分钟阅读');
    expect(resolveDataToken('article.views', ctx)).toBe('128');
    expect(resolveDataToken('article.url', ctx)).toBe('/a/art_1');
    expect(resolveDataToken('site.name', ctx)).toBe('一间接待所');
    expect(resolveDataToken('site.year', ctx)).toBe('2026');
  });

  it('文章地址优先用 slug，缺 slug 时回退 id', () => {
    expect(resolveDataToken('article.url', { article: article() })).toBe('/a/quiet-yard');
    expect(
      resolveDataToken('article.url', {
        article: article({ kind: 'post', id: 'p_9', slug: 'nesting' }),
      }),
    ).toBe('/p/nesting');
    expect(resolveDataToken('article.url', { article: article({ slug: '' }) })).toBe('/a/art_1');
  });

  it('没有文章、没有数据时返回 undefined', () => {
    expect(resolveDataToken('article.title', null)).toBeUndefined();
    expect(resolveDataToken('article.title', {})).toBeUndefined();
    expect(resolveDataToken('article.views', context({ views: 0 }))).toBeUndefined();
    expect(resolveDataToken('site.year', context({ currentYear: undefined }))).toBeUndefined();
  });
});

describe('绑定键工具', () => {
  it('bindKeyOf / boundToken / hasBoundProps 一致', () => {
    expect(bindKeyOf('title')).toBe('bind:title');
    expect(boundToken({ 'bind:title': 'article.title' }, 'title')).toBe('article.title');
    expect(boundToken({ title: '手写' }, 'title')).toBe('');
    expect(hasBoundProps({ title: '手写' })).toBe(false);
    expect(hasBoundProps({ title: '手写', 'bind:title': 'article.title' })).toBe(true);
  });
});

// 「文章内容」占位符决定了文章页把正文画在哪里，放在这里一起守住。
describe('hasArticleContent', () => {
  it('article-content 注册为两种布局都能用的共用组件', () => {
    const def = blockDef('article-content');
    expect(def?.name).toBe('文章内容');
    expect(def?.group).toBe('shared');
    expect(def?.variants).toEqual(['classic', 'bento']);
    // props 只有标量开关，正文来自当前文章而不是配置
    expect(def?.defaults).toEqual({ show_toc: false });
    expect(def?.schema.map((item) => item.key)).toEqual(['show_toc']);
    expect(def?.schema.every((item) => item.type === 'toggle')).toBe(true);
  });

  it('识别根级、分栏与容器里的占位符', () => {
    expect(hasArticleContent({ blocks: [] })).toBe(false);
    expect(hasArticleContent({ blocks: [createBlock('text')] })).toBe(false);
    expect(hasArticleContent({ blocks: [createBlock('article-content')] })).toBe(true);

    const columns = createBlock('columns');
    columns.children = [createBlock('text'), createBlock('article-content')];
    expect(hasArticleContent({ blocks: [columns] })).toBe(true);

    const container = createBlock('container');
    const inner = createBlock('container');
    inner.children = [createBlock('article-content')];
    container.children = [inner];
    expect(hasArticleContent({ blocks: [container] })).toBe(true);
  });

  it('分设备编排里任意设备有占位符都算', () => {
    const layout = {
      blocks: [createBlock('text')],
      device_split: true as const,
      devices: { mobile: { blocks: [createBlock('article-content')] } },
    };
    expect(hasArticleContent(layout)).toBe(true);
  });

  it('隐藏的占位符不参与判断', () => {
    const hidden = { ...createBlock('article-content'), hidden: true };
    expect(hasArticleContent({ blocks: [hidden] })).toBe(false);
  });
});
