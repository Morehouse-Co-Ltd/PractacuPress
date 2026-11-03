import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { Content, ContentKind } from '../../types';
import { useAuth } from '../../lib/session';
import { useCustomization } from '../../lib/customize';
import { useVisits, viewCounts } from '../../lib/analytics';
import { formatDateTime, readingTime } from '../../lib/format';
import { useLocale } from '../../lib/i18n';
import type { BlockDataContext } from '../../lib/blocksData';

/**
 * 文章页的数据上下文。
 *
 * 「文章内容」占位符和组件文字的「显示什么数据」都从这里取当前文章：区块本身
 * 不知道自己在哪篇文章里，编排也就能在任意文章上复用。首页与自定义页没有文章，
 * 因此不套 Provider，`useArticleSurface()` 返回 null，区块退化成占位提示。
 */

export interface ArticleSurface extends BlockDataContext {
  article: Content;
  kind: ContentKind;
  /** 站内路径，例如 `/a/abc123`。 */
  url: string;
  authorName: string;
  /** 已本地化的发布时间 / 更新时间文案；没有就是空串。 */
  publishedLabel: string;
  updatedLabel: string;
  categoryName: string;
  tags: string[];
  readingMinutes: number;
  siteName: string;
  currentYear: number;
}

const ArticleContext = createContext<ArticleSurface | null>(null);

/** `formatDateTime` 用「—」表示缺失；数据绑定要的是空串（触发回退文字）。 */
function dateLabel(iso?: string): string {
  const text = formatDateTime(iso);
  return text === '—' ? '' : text;
}

export function ArticleProvider({
  article,
  kind,
  url,
  categoryName,
  children,
}: {
  article: Content;
  kind?: ContentKind;
  /** 缺省按内容类型拼出 `/a/{id}` 或 `/p/{id}`。 */
  url?: string;
  /**
   * 分类名。详情页已经把服务端的分类表读进来了，直接传进来最准；
   * 不传则回退到安装配置里的本地分类表（演示模式完全够用）。
   */
  categoryName?: string;
  children: ReactNode;
}) {
  const { site } = useAuth();
  const { customization } = useCustomization();
  const { visits } = useVisits();
  const locale = useLocale();
  const localCategories = customization.taxonomy.categories;
  // 访问记录每 15 秒刷新一次；这里先收敛成一个数字，Provider 的值才不会跟着抖动，
  // 文章页里的区块也就不会因为统计刷新而整体重渲染。
  const views = useMemo(
    () => viewCounts(visits).get(article.id) ?? 0,
    [visits, article.id],
  );

  const value = useMemo<ArticleSurface>(() => {
    const contentKind = kind ?? article.kind;
    const category = article.category_id
      ? localCategories.find((term) => term.id === article.category_id)
      : undefined;
    return {
      article,
      kind: contentKind,
      url: url ?? `/${contentKind === 'article' ? 'a' : 'p'}/${article.id}`,
      authorName: article.author_name?.trim() ?? '',
      publishedLabel: dateLabel(article.published_at ?? article.created_at),
      updatedLabel: dateLabel(article.updated_at),
      categoryName: categoryName?.trim() || category?.name || '',
      tags: article.tags ?? [],
      readingMinutes: readingTime(article.rendered_html ?? ''),
      views: views > 0 ? views : undefined,
      siteName: site?.name?.trim() ?? '',
      currentYear: new Date().getFullYear(),
    };
    // locale 进入依赖：切换语言后日期文案要跟着重算。
  }, [article, kind, url, categoryName, site?.name, localCategories, views, locale]);

  return <ArticleContext.Provider value={value}>{children}</ArticleContext.Provider>;
}

/** 文章页之外（首页、自定义页、后台）返回 null。 */
export function useArticleSurface(): ArticleSurface | null {
  return useContext(ArticleContext);
}

/**
 * 渲染层统一取数据的入口。
 *
 * 文章页拿到完整上下文；其它页面至少还有站点级数据（站点名、当前年份），
 * 所以把文字绑到「站点名」在首页也能显示。文章类 token 在非文章页解析为空，
 * 自动回退到站长手写的文字。
 */
export function useBlockDataContext(): BlockDataContext {
  const surface = useArticleSurface();
  const { site } = useAuth();
  const fallback = useMemo<BlockDataContext>(
    () => ({ siteName: site?.name ?? '', currentYear: new Date().getFullYear() }),
    [site?.name],
  );
  return surface ?? fallback;
}
