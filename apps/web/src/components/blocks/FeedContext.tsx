import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { Content } from '../../types';
import { useBackend } from '../../lib/backend';
import { useAuth } from '../../lib/session';
import { useAsync } from '../../lib/hooks';
import { readPerformance } from '../../lib/performance';

/**
 * 首页 / 模板页共享的内容数据。
 *
 * 多个区块（精选、网格、统计）都需要文章列表，这里只请求一次，
 * 避免“每组件一次请求”。自定义页与首页都通过 Provider 取数。
 */

interface FeedValue {
  articles: Content[];
  posts: Content[];
  all: Content[];
  loading: boolean;
  error: unknown;
  reload: () => void;
}

const FeedContext = createContext<FeedValue | null>(null);

export function FeedProvider({ children, limit }: { children: ReactNode; limit?: number }) {
  const backend = useBackend();
  const { config } = useAuth();
  const performance = useMemo(() => readPerformance(config), [config]);
  const feedLimit = limit ?? performance.feed_limit;
  const feed = useAsync(async () => {
    const [articles, posts] = await Promise.all([
      backend.listContent('article', { limit: feedLimit }),
      backend.listContent('post', { limit: feedLimit }),
    ]);
    return {
      articles: articles.items.filter((item) => item.status === 'published'),
      posts: posts.items.filter((item) => item.status === 'published'),
    };
  }, [backend, feedLimit]);

  const value = useMemo<FeedValue>(() => {
    const articles = feed.data?.articles ?? [];
    const posts = feed.data?.posts ?? [];
    const all = [...articles, ...posts].sort((a, b) =>
      (b.published_at ?? b.created_at).localeCompare(a.published_at ?? a.created_at),
    );
    return { articles, posts, all, loading: feed.loading, error: feed.error, reload: feed.reload };
  }, [feed.data, feed.loading, feed.error, feed.reload]);

  return <FeedContext.Provider value={value}>{children}</FeedContext.Provider>;
}

/** 没有 Provider 时（例如后台预览）返回空数据，区块显示空态。 */
export function useFeed(): FeedValue {
  return (
    useContext(FeedContext) ?? {
      articles: [],
      posts: [],
      all: [],
      loading: false,
      error: null,
      reload: () => undefined,
    }
  );
}

/** 纯文本字数：去掉 HTML 标签后的字符数，用于统计卡。 */
export function countWords(html: string): number {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, '').length;
}
