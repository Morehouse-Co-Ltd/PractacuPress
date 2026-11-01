import { Link } from 'react-router-dom';
import type { CSSProperties, ReactElement } from 'react';
import type { BlockInstance, Content } from '../../types';
import { useFeed } from './FeedContext';
import { useTaxonomy } from '../../lib/useTaxonomy';
import { useRangeAnalytics } from '../../lib/useAnalytics';
import { blockProp } from '../../lib/blocks';
import { readingTime, timeAgo } from '../../lib/format';
import { EmptyState, Skeleton } from '../ui';
import { Icon } from '../Icon';

/**
 * 可放入首页 / 自定义页面的内容组件：
 * - 热门文章：优先按真实后端 30 天统计排序，无统计端点时回退到本机访问记录；
 * - 最近文章：按发布时间倒序。
 *
 * 两个组件都注册在页面编排的「添加组件」里，经典与夜航布局都能使用。
 */

function contentUrl(item: Content): string {
  return `/${item.kind === 'article' ? 'a' : 'p'}/${item.id}`;
}

function ContentModule({
  block,
  mode,
}: {
  block: BlockInstance;
  mode: 'popular' | 'recent';
}) {
  const { all, loading } = useFeed();
  const { taxonomy } = useTaxonomy();
  const { stats } = useRangeAnalytics('30d', false);
  const counts = new Map(stats.topContent.map((entry) => [entry.id, entry.count]));
  const heading =
    blockProp(block, 'heading', mode === 'popular' ? '热门文章' : '最近文章').trim() ||
    (mode === 'popular' ? '热门文章' : '最近文章');
  const limit = Math.min(12, Math.max(1, blockProp(block, 'limit', 5)));
  const showSummary = blockProp(block, 'show_summary', true);
  const showMeta = blockProp(block, 'show_meta', true);
  const showViews = mode === 'popular' && blockProp(block, 'show_views', true);
  const showTags = blockProp(block, 'show_tags', true);

  const items =
    mode === 'popular'
      ? [...all].sort((a, b) => {
          const delta = (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0);
          if (delta !== 0) return delta;
          return (b.published_at ?? b.created_at).localeCompare(a.published_at ?? a.created_at);
        })
      : [...all].sort((a, b) =>
          (b.published_at ?? b.created_at).localeCompare(a.published_at ?? a.created_at),
        );

  if (loading) {
    return (
      <section className="pp-content-module">
        <div className="pp-content-head">
          <h2>{heading}</h2>
        </div>
        <Skeleton lines={4} />
      </section>
    );
  }

  if (!items.length) {
    return (
      <section className="pp-content-module">
        <div className="pp-content-head">
          <h2>{heading}</h2>
        </div>
        <EmptyState compact icon="file" title="还没有内容" body="发布文章或帖子后，这里会自动更新。" />
      </section>
    );
  }

  return (
    <section className="pp-content-module" aria-label={heading}>
      <div className="pp-content-head">
        <h2>{heading}</h2>
        <Link to="/articles" className="pp-content-more">
          全部 <Icon name="arrow-right" size={13} />
        </Link>
      </div>
      <div className="pp-content-list">
        {items.slice(0, limit).map((item, index) => {
          const category = taxonomy.categories.find((term) => term.id === item.category_id);
          return (
            <article className="pp-content-row" key={item.id}>
              <span className="pp-content-rank" aria-hidden>
                {String(index + 1).padStart(2, '0')}
              </span>
              <div className="pp-content-body">
                <div className="pp-content-kicker">
                  <span>{item.kind === 'article' ? '文章' : '帖子'}</span>
                  {category ? (
                    <span className="pp-content-cat" style={{ '--pp-cat-color': category.color } as CSSProperties}>
                      {category.name}
                    </span>
                  ) : null}
                  {showMeta ? <span>{timeAgo(item.published_at ?? item.created_at)}</span> : null}
                  {showViews ? (
                    <span className="pp-content-views">
                      <Icon name="chart" size={11} /> {counts.get(item.id) ?? 0} 次阅读
                    </span>
                  ) : null}
                </div>
                <h3>
                  <Link to={contentUrl(item)}>{item.title}</Link>
                </h3>
                {showSummary && item.summary ? <p>{item.summary}</p> : null}
                {showTags && item.tags?.length ? (
                  <div className="pp-content-tags">
                    {item.tags.slice(0, 4).map((tag) => (
                      <span key={tag}>#{tag}</span>
                    ))}
                  </div>
                ) : null}
              </div>
              <span className="pp-content-time" aria-hidden>
                {readingTime(item.rendered_html)} 分钟
              </span>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function PopularContent({ block }: { block: BlockInstance }) {
  return <ContentModule block={block} mode="popular" />;
}

function RecentContent({ block }: { block: BlockInstance }) {
  return <ContentModule block={block} mode="recent" />;
}

export const CONTENT_RENDERERS: Record<string, (props: { block: BlockInstance }) => ReactElement> = {
  'popular-content': PopularContent,
  'recent-content': RecentContent,
};
