import { beforeEach, describe, expect, it } from 'vitest';
import type { Content } from '../../types';
import {
  clearSearchHistory,
  clampReadFontLevel,
  groupArchiveByMonth,
  highlightParts,
  pickNeighbors,
  pickRelated,
  pushSearchHistory,
  readSearchHistory,
  READ_FONT_SCALES,
  removeSearchHistory,
  tagCloudSize,
} from './readExperience';

function entry(overrides: Partial<Content> & { id: string }): Content {
  const { id, ...rest } = overrides;
  return {
    id,
    kind: 'article',
    status: 'published',
    title: id,
    slug: id,
    source_format: 'markdown',
    rendered_html: '',
    policy_version: 'v1',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    actions: [],
    ...rest,
  };
}

describe('pickRelated', () => {
  it('标签重合优先、同分类补足、排除自身且最多 3 篇', () => {
    const current = entry({
      id: 'current',
      category_id: 'cat_a',
      tags: ['排版', '阅读'],
    });
    const overlap2 = entry({ id: 'overlap2', category_id: 'cat_z', tags: ['排版', '阅读'] });
    const overlap1 = entry({ id: 'overlap1', category_id: 'cat_z', tags: ['排版'] });
    const sameCategory = entry({ id: 'same-cat', category_id: 'cat_a', tags: [] });
    const unrelated = entry({ id: 'unrelated', category_id: 'cat_z', tags: [] });

    const picked = pickRelated(current, [current, sameCategory, overlap1, overlap2, unrelated]);
    expect(picked.map((item) => item.id)).toEqual(['overlap2', 'overlap1', 'same-cat']);
  });

  it('只从同一种类里补足，草稿不参与', () => {
    const current = entry({ id: 'current' });
    const draft = entry({ id: 'draft', status: 'draft' });
    const post = entry({ id: 'post', kind: 'post' });
    const article = entry({ id: 'article' });
    expect(pickRelated(current, [draft, post, article]).map((item) => item.id)).toEqual(['article']);
  });

  it('当前内容为空时返回空数组', () => {
    expect(pickRelated(undefined, [entry({ id: 'a' })])).toEqual([]);
  });
});

describe('pickNeighbors', () => {
  const first = entry({ id: 'first', published_at: '2026-01-01T00:00:00.000Z' });
  const middle = entry({ id: 'middle', published_at: '2026-02-01T00:00:00.000Z' });
  const last = entry({ id: 'last', published_at: '2026-03-01T00:00:00.000Z' });

  it('首篇没有上一篇，末篇没有下一篇', () => {
    expect(pickNeighbors([last, middle, first], 'first')).toEqual({ previous: undefined, next: middle });
    expect(pickNeighbors([last, middle, first], 'last')).toEqual({ previous: middle, next: undefined });
  });

  it('中间一篇同时有上下篇', () => {
    expect(pickNeighbors([last, middle, first], 'middle')).toEqual({ previous: first, next: last });
  });

  it('找不到当前内容时返回空对象', () => {
    expect(pickNeighbors([first, middle], 'missing')).toEqual({});
  });
});

describe('groupArchiveByMonth', () => {
  it('按年倒序、月倒序分组并统计篇数', () => {
    const items = [
      entry({ id: 'a', published_at: '2026-03-02T00:00:00.000Z' }),
      entry({ id: 'b', published_at: '2026-03-08T00:00:00.000Z' }),
      entry({ id: 'c', published_at: '2026-01-10T00:00:00.000Z' }),
      entry({ id: 'd', published_at: '2025-12-31T00:00:00.000Z' }),
      entry({ id: 'draft', status: 'draft', published_at: '2026-03-02T00:00:00.000Z' }),
    ];

    const groups = groupArchiveByMonth(items);
    expect(groups.map((group) => group.year)).toEqual([2026, 2025]);
    expect(groups[0].count).toBe(3);
    expect(groups[0].months.map((month) => month.month)).toEqual([3, 1]);
    expect(groups[0].months[0].count).toBe(2);
    expect(groups[0].months[0].items.map((item) => item.id)).toEqual(['b', 'a']);
  });
});

describe('highlightParts', () => {
  it('保留原文大小写并切出命中片段', () => {
    expect(highlightParts('排版与 Typesetting', '排版 typesetting')).toEqual([
      { text: '排版', hit: true },
      { text: '与 ', hit: false },
      { text: 'Typesetting', hit: true },
    ]);
  });

  it('没有关键词时整段返回', () => {
    expect(highlightParts('全文', '')).toEqual([{ text: '全文', hit: false }]);
  });
});

describe('tagCloudSize', () => {
  it('按篇数线性映射到 14–22px', () => {
    expect(tagCloudSize(1, 1, 5)).toBe(14);
    expect(tagCloudSize(5, 1, 5)).toBe(22);
    expect(tagCloudSize(3, 1, 5)).toBe(18);
    expect(tagCloudSize(1, 1, 1)).toBe(16);
  });
});

describe('搜索历史与字号偏好', () => {
  beforeEach(() => {
    clearSearchHistory();
  });

  it('最新在前、忽略大小写去重、最多 10 条', () => {
    pushSearchHistory('排版');
    pushSearchHistory('Typesetting');
    pushSearchHistory('排版');
    expect(readSearchHistory()).toEqual(['排版', 'Typesetting']);

    for (let index = 0; index < 12; index += 1) pushSearchHistory(`词 ${index}`);
    expect(readSearchHistory()).toHaveLength(10);
    expect(readSearchHistory()[0]).toBe('词 11');
  });

  it('可以删除单条与清空', () => {
    pushSearchHistory('甲');
    pushSearchHistory('乙');
    expect(removeSearchHistory('甲')).toEqual(['乙']);
    expect(clearSearchHistory()).toEqual([]);
    expect(readSearchHistory()).toEqual([]);
  });

  it('字号档位被限制在合法范围内', () => {
    expect(clampReadFontLevel(-3)).toBe(0);
    expect(clampReadFontLevel(99)).toBe(READ_FONT_SCALES.length - 1);
    expect(clampReadFontLevel(Number.NaN)).toBe(1);
  });
});
