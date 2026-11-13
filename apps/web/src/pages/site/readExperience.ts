import type { Content, ContentKind } from '../../types';

/**
 * 阅读端体验的纯函数与本地偏好存储。
 *
 * 相关推荐 / 上下篇 / 时间归档 / 搜索高亮 / 标签云字号都放在这里，页面只负责
 * 取数与渲染。数据源保持「内容列表 + 分类标签」两样东西，不新增后端契约。
 */

export const SEARCH_HISTORY_KEY = 'pp.search.history.v1';
export const READ_FONT_KEY = 'pp.read.font.v1';
export const MAX_SEARCH_HISTORY = 10;

/** 正文字号档位相对主题默认值的比例；默认第 2 档（100%）。 */
export const READ_FONT_SCALES = [0.9, 1, 1.1, 1.2, 1.3] as const;
export const DEFAULT_READ_FONT_LEVEL = 1;

export function contentTime(item: Content): string {
  return item.published_at ?? item.created_at;
}

export function contentPath(item: Content): string {
  return `/${item.kind === 'article' ? 'a' : 'p'}/${item.id}`;
}

export function isPublished(item: Content): boolean {
  return item.status === 'published';
}

export function sortNewest(items: Content[]): Content[] {
  return [...items].sort((a, b) => contentTime(b).localeCompare(contentTime(a)));
}

export function sortOldest(items: Content[]): Content[] {
  return [...items].sort((a, b) => contentTime(a).localeCompare(contentTime(b)));
}

/* ------------------------------ 时间归档 ------------------------------ */

export interface ArchiveMonth {
  /** 1–12。 */
  month: number;
  count: number;
  items: Content[];
}

export interface ArchiveYear {
  year: number;
  count: number;
  months: ArchiveMonth[];
}

/**
 * 按年倒序、月倒序分组已发布内容。
 *
 * 月份用数字而不是本地化字符串：页面渲染时再用 `t('{month} 月')` 翻译，
 * 切换语言不需要重算分组。
 */
export function groupArchiveByMonth(items: Content[]): ArchiveYear[] {
  const years = new Map<number, Map<number, Content[]>>();
  for (const item of items) {
    if (!isPublished(item)) continue;
    const date = new Date(contentTime(item));
    if (Number.isNaN(date.getTime())) continue;
    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    if (!years.has(year)) years.set(year, new Map());
    const months = years.get(year)!;
    if (!months.has(month)) months.set(month, []);
    months.get(month)!.push(item);
  }

  return [...years.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, months]) => {
      const grouped = [...months.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([month, entries]) => ({
          month,
          count: entries.length,
          items: sortNewest(entries),
        }));
      return {
        year,
        count: grouped.reduce((sum, entry) => sum + entry.count, 0),
        months: grouped,
      };
    });
}

/* ------------------------------ 相关推荐 ------------------------------ */

function normalizeTag(value: string): string {
  return value.trim().toLowerCase();
}

export function tagOverlap(a: Content, b: Content): number {
  const left = new Set((a.tags ?? []).map(normalizeTag).filter(Boolean));
  if (!left.size) return 0;
  const right = new Set((b.tags ?? []).map(normalizeTag).filter(Boolean));
  let count = 0;
  for (const tag of right) if (left.has(tag)) count += 1;
  return count;
}

/** 标签重合度优先，其次同分类；同分时新的在前。 */
export function relatedScore(current: Content, candidate: Content): number {
  const overlap = tagOverlap(current, candidate);
  const sameCategory =
    current.kind === candidate.kind &&
    !!current.category_id &&
    current.category_id === candidate.category_id
      ? 1
      : 0;
  return overlap * 10 + sameCategory * 3;
}

/**
 * 相关推荐：标签重合优先、同类补足、排除自身、最多 `limit` 篇。
 *
 * 服务端没有 related 端点，这里用同一类别的已发布内容池打分；池子由页面用
 * `listContent` 拉取，因此真实后端与演示后端的行为一致。
 */
export function pickRelated(current: Content | undefined, pool: Content[], limit = 3): Content[] {
  if (!current || limit <= 0) return [];
  const seen = new Set<string>([current.id]);
  const unique: Content[] = [];
  for (const item of pool) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    if (item.kind === current.kind && isPublished(item)) unique.push(item);
  }
  return unique
    .map((item) => ({ item, score: relatedScore(current, item) }))
    .sort((a, b) => b.score - a.score || contentTime(b.item).localeCompare(contentTime(a.item)))
    .slice(0, limit)
    .map((entry) => entry.item);
}

/* ------------------------------ 上下篇 ------------------------------ */

export interface NeighborNav {
  previous?: Content;
  next?: Content;
}

/**
 * 同一类别里的上一篇 / 下一篇。
 *
 * 按发布时间升序：`previous` 是更早的一篇，`next` 是更晚的一篇。最早的一篇
 * 没有「上一篇」，最新的一篇没有「下一篇」，与 FSD A-19 一致。
 */
export function pickNeighbors(items: Content[], currentId: string): NeighborNav {
  const ordered = sortOldest(items.filter((item) => isPublished(item) && item.kind === items[0]?.kind));
  const index = ordered.findIndex((item) => item.id === currentId);
  if (index < 0) return {};
  return {
    previous: index > 0 ? ordered[index - 1] : undefined,
    next: index < ordered.length - 1 ? ordered[index + 1] : undefined,
  };
}

/* ------------------------------ 分类 / 标签 ------------------------------ */

export function matchesCategory(item: Content, categoryId: string): boolean {
  return !!categoryId && item.category_id === categoryId;
}

export function matchesTag(item: Content, tagName: string): boolean {
  const wanted = normalizeTag(tagName);
  if (!wanted) return false;
  return (item.tags ?? []).some((tag) => normalizeTag(tag) === wanted);
}

/** 分类 id → 已发布篇数；分类页与侧栏导航共用。 */
export function categoryCounts(items: Content[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    if (!isPublished(item) || !item.category_id) continue;
    counts[item.category_id] = (counts[item.category_id] ?? 0) + 1;
  }
  return counts;
}

/** 标签名（原样）→ 已发布篇数。 */
export function tagCounts(items: Content[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    if (!isPublished(item)) continue;
    // 同一篇里重复的标签只算一次。
    const seen = new Set<string>();
    for (const tag of item.tags ?? []) {
      const name = tag.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      counts[name] = (counts[name] ?? 0) + 1;
    }
  }
  return counts;
}

/** 标签云字号：按篇数线性映射到 14–22px（FSD A-23）。 */
export function tagCloudSize(count: number, minCount: number, maxCount: number): number {
  if (maxCount <= minCount) return 16;
  const ratio = (count - minCount) / (maxCount - minCount);
  return Math.round(14 + Math.max(0, Math.min(1, ratio)) * 8);
}

export function clipTitle(title: string, max = 15): string {
  const chars = Array.from(title.trim());
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : chars.join('');
}

/* ------------------------------ 搜索高亮 ------------------------------ */

export interface HighlightPart {
  text: string;
  hit: boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把一段文本按搜索词切成「命中 / 未命中」片段。
 *
 * 多关键词用空白分隔；命中片段保留原文大小写，渲染时由调用方包 `<mark>`。
 */
export function highlightParts(text: string, query: string): HighlightPart[] {
  if (!text) return [];
  const tokens = [...new Set(query.trim().split(/\s+/).filter((token) => token.length > 0))];
  if (!tokens.length) return [{ text, hit: false }];
  tokens.sort((a, b) => b.length - a.length);
  const pattern = new RegExp(`(${tokens.map(escapeRegExp).join('|')})`, 'gi');
  const parts: HighlightPart[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > last) parts.push({ text: text.slice(last, index), hit: false });
    parts.push({ text: match[0], hit: true });
    last = index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), hit: false });
  return parts;
}

/* ------------------------------ 本地偏好 ------------------------------ */

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readSearchHistory(): string[] {
  const store = storage();
  if (!store) return [];
  try {
    const parsed: unknown = JSON.parse(store.getItem(SEARCH_HISTORY_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => item.trim())
      .slice(0, MAX_SEARCH_HISTORY);
  } catch {
    return [];
  }
}

/**
 * 记入一条搜索历史（最新在前、忽略大小写去重、最多 10 条）。
 * 返回写入后的完整列表，调用方可以直接 setState。
 */
export function pushSearchHistory(query: string, existing?: string[]): string[] {
  const value = query.trim();
  if (!value) return existing ?? readSearchHistory();
  const current = existing ?? readSearchHistory();
  const next = [value, ...current.filter((item) => item.toLowerCase() !== value.toLowerCase())].slice(
    0,
    MAX_SEARCH_HISTORY,
  );
  storage()?.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next));
  return next;
}

export function removeSearchHistory(query: string, existing?: string[]): string[] {
  const current = existing ?? readSearchHistory();
  const next = current.filter((item) => item !== query);
  storage()?.setItem(SEARCH_HISTORY_KEY, JSON.stringify(next));
  return next;
}

export function clearSearchHistory(): string[] {
  storage()?.removeItem(SEARCH_HISTORY_KEY);
  return [];
}

export function clampReadFontLevel(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_READ_FONT_LEVEL;
  return Math.max(0, Math.min(READ_FONT_SCALES.length - 1, Math.round(value)));
}

export function readReadFontLevel(): number {
  const store = storage();
  if (!store) return DEFAULT_READ_FONT_LEVEL;
  const raw = store.getItem(READ_FONT_KEY);
  return clampReadFontLevel(raw ? Number(raw) : DEFAULT_READ_FONT_LEVEL);
}

export function saveReadFontLevel(level: number): number {
  const next = clampReadFontLevel(level);
  storage()?.setItem(READ_FONT_KEY, String(next));
  return next;
}

export function readFontScale(level: number): number {
  return READ_FONT_SCALES[clampReadFontLevel(level)];
}

/** 供页面按种类筛选时使用；空字符串表示全部。 */
export type KindFilter = ContentKind | '';
