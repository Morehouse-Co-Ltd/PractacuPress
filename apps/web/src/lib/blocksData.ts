import type { BlockInstance, BlockProps, Content, ContentKind } from '../types';
import { t } from './i18n';
import { liveCatalog } from './i18n/live';

/**
 * 组件文字「显示什么数据」。
 *
 * 组件属性里的文字默认是站长手写的；也可以绑定成当前文章的数据（标题、作者、
 * 发布时间……）。约定只有两条：
 *
 * - 绑定关系存在 `props['bind:' + key]`，值是一个稳定的数据 token（`article.title`）；
 * - 原来的 `props[key]` 保留为**回退文字**：拿不到数据时照常显示，不会出现空白。
 *
 * 因此整份配置仍然只有标量，能照常导入导出（见 `lib/customize.ts` 的归一化）。
 * 解析函数是纯函数，渲染层只需要在 `BlockView` 里算一次，所有组件都能用。
 */

export const BIND_PREFIX = 'bind:';

/**
 * 解析数据时需要的上下文。
 *
 * 时间之类的展示文案在 Provider 里预先格式化好，这里只做取值，不做格式化——
 * 这样纯函数不读全局状态，单测可以完全确定。
 */
export interface BlockDataContext {
  /** 当前文章；首页 / 自定义页没有文章。 */
  article?: Content | null;
  kind?: ContentKind;
  /** 文章地址（站内路径），例如 `/a/abc123`。 */
  url?: string;
  authorName?: string;
  /** 「2026.11.02 09:30」这种已经本地化的发布时间文案。 */
  publishedLabel?: string;
  updatedLabel?: string;
  categoryName?: string;
  tags?: string[];
  readingMinutes?: number;
  /** 阅读量；没有统计数据时缺省，界面上回退到手写文字。 */
  views?: number;
  siteName?: string;
  /** 当前年份，由 Provider 注入（不在这里读系统时间，保证纯函数可测）。 */
  currentYear?: number;
}

/** 一个可选的数据源。 */
export interface BlockDataSource {
  token: string;
  label: string;
}

/**
 * 数据源目录：token 稳定、只增不改，标签随语言变化。
 *
 * `liveCatalog` 把中文换成读取时翻译的 getter：切换语言后属性面板的下拉
 * 不用重新加载就会跟着变（和 `BLOCK_DEFS` 同一套机制）。
 */
const RAW_DATA_SOURCES: BlockDataSource[] = [
  { token: 'article.title', label: t('文章标题') },
  { token: 'article.summary', label: t('文章摘要') },
  { token: 'article.author', label: t('作者') },
  { token: 'article.published_at', label: t('发布时间') },
  { token: 'article.updated_at', label: t('更新时间') },
  { token: 'article.category', label: t('分类') },
  { token: 'article.tags', label: t('标签') },
  { token: 'article.reading_time', label: t('阅读时长') },
  { token: 'article.views', label: t('阅读量') },
  { token: 'article.url', label: t('文章地址') },
  { token: 'site.name', label: t('站点名') },
  { token: 'site.year', label: t('当前年份') },
];

export const BLOCK_DATA_SOURCES: BlockDataSource[] = liveCatalog(RAW_DATA_SOURCES);

/** `bind:` 前缀的键；组件的回退文字键是去掉前缀后的名字。 */
export function isBindKey(key: string): boolean {
  return key.startsWith(BIND_PREFIX);
}

/** 属性键对应的绑定键，例如 `title` → `bind:title`。 */
export function bindKeyOf(key: string): string {
  return `${BIND_PREFIX}${key}`;
}

/** 读取某个属性当前的绑定 token；没有绑定（或不是字符串）返回空串。 */
export function boundToken(props: BlockProps, key: string): string {
  const token = props[bindKeyOf(key)];
  return typeof token === 'string' ? token : '';
}

/** 能不能写进 props：防止 `bind:__proto__` 这类键污染原型。 */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function articleUrl(article: Content): string {
  return `/${article.kind === 'article' ? 'a' : 'p'}/${article.id}`;
}

/**
 * 把一个数据 token 解析成可显示的文字。
 *
 * 拿不到数据（没有文章、字段为空、token 不认识）一律返回 `undefined`，
 * 调用方据此回退到站长手写的文字；任何输入都不应该抛异常。
 */
export function resolveDataToken(
  token: string,
  context?: BlockDataContext | null,
): string | undefined {
  if (!token || !context) return undefined;
  const article = context.article ?? undefined;
  const tags = context.tags ?? article?.tags ?? [];

  switch (token) {
    case 'article.title':
      return text(article?.title);
    case 'article.summary':
      return text(article?.summary);
    case 'article.author':
      return text(context.authorName) ?? text(article?.author_name);
    case 'article.published_at':
      return text(context.publishedLabel);
    case 'article.updated_at':
      return text(context.updatedLabel);
    case 'article.category':
      return text(context.categoryName);
    case 'article.tags':
      return tags.length ? tags.join(' · ') : undefined;
    case 'article.reading_time':
      return typeof context.readingMinutes === 'number' && context.readingMinutes > 0
        ? t('{count} 分钟阅读', { count: context.readingMinutes })
        : undefined;
    case 'article.views':
      return typeof context.views === 'number' && context.views > 0
        ? String(context.views)
        : undefined;
    case 'article.url':
      return text(context.url) ?? (article ? articleUrl(article) : undefined);
    case 'site.name':
      return text(context.siteName);
    case 'site.year':
      return typeof context.currentYear === 'number'
        ? String(context.currentYear)
        : undefined;
    default:
      // 旧配置里可能留着已经下线的 token：安静回退，不要炸。
      return undefined;
  }
}

/**
 * 计算渲染用的属性：把绑定过的键替换成解析出来的数据。
 *
 * 纯函数：不修改入参，返回一份新的 props；绑定解析不到时保留原来的回退文字。
 * `bind:*` 键原样留在结果里，渲染器只读自己认识的键，不会受影响。
 */
export function resolveBoundProps(
  block: Pick<BlockInstance, 'props'>,
  context?: BlockDataContext | null,
): BlockProps {
  const props: BlockProps = { ...block.props };
  if (!context) return props;

  for (const [key, value] of Object.entries(block.props)) {
    if (!isBindKey(key)) continue;
    const target = key.slice(BIND_PREFIX.length);
    if (!target || UNSAFE_KEYS.has(target)) continue;
    if (typeof value !== 'string') continue;
    const resolved = resolveDataToken(value, context);
    if (resolved === undefined) continue;
    props[target] = resolved;
  }
  return props;
}

/** 这份属性里有没有任何绑定；渲染层用它避免无谓地复制 props。空 token 视为没绑定。 */
export function hasBoundProps(props: BlockProps): boolean {
  return Object.entries(props).some(
    ([key, value]) => isBindKey(key) && typeof value === 'string' && value !== '',
  );
}
