import { useMemo, type CSSProperties, type ReactElement } from 'react';
import type { BlockInstance, Content, ContentKind } from '../../types';
import { blockProp, queryRequest } from '../../lib/blocks';
import { isDemo, useBackend } from '../../lib/backend';
import { useAsync } from '../../lib/hooks';
import { useT } from '../../lib/i18n';
import { ArticleCard } from './DataBlocks';
import { useFeed } from './FeedContext';

/**
 * 「内容查询」区块（P3）。
 *
 * 把落地页从静态版面变成能跑的页面：作者选来源（最新 / 分类 / 标签 / 作者）、
 * 时间窗与排序，区块按这些条件取内容。取数有两条既有路径，**不新增请求路径**：
 *
 * - 真实后端：`backend.listContent`（即 `GET /articles`、`GET /posts`），P3 Task 1
 *   给这两个端点加了 `category_id` / `tag` / `since` / `sort`，区块把
 *   `queryRequest()` 翻译出来的参数原样透传过去，筛选发生在服务端。
 * - 演示模式：演示后端没有服务端筛选，这里直接用 `FeedContext` 已经取回来的
 *   演示数据，按 `limit` 截断后展示。**不伪造筛选**：不按分类 / 标签 / 时间过滤，
 *   也不改写排序——本地数据源做不到的事就如实不做，编辑器里对应的提示也写明
 *   这一点（见 `blocks.ts` 的 schema hint）。
 *
 * 卡片结构复用 `DataBlocks` 的 `ArticleCard`：查询块和「文章组件」长得一样，样式
 * 与结构只留一份（`.pp-article-grid` / `.pp-article-card`）。
 */

/** 合并两个端点后的排序口径：各自排好序，合并后按同一份日期再排一次。 */
function byPublishedDate(a: Content, b: Content): number {
  return (a.published_at ?? a.created_at).localeCompare(b.published_at ?? b.created_at);
}

function QueryBlock({ block }: { block: BlockInstance }): ReactElement {
  const t = useT();
  const backend = useBackend();
  const feed = useFeed();
  const demo = isDemo(backend);
  const showExcerpt = blockProp(block, 'show_excerpt', true);
  const showMeta = blockProp(block, 'show_meta', true);
  // 「现在」只取一次：since 由它算出，若每次渲染都重新取时间，useAsync 的依赖会
  // 一直变，区块就会无限重取。
  const now = useMemo(() => new Date(), []);
  const request = useMemo(() => queryRequest(block.props, now), [block.props, now]);

  const remote = useAsync(
    async () => {
      // 演示模式没有服务端筛选：不请求，也不拿本地数据假装筛选。
      if (demo) return [];
      const list = (kind: ContentKind) =>
        backend.listContent(kind, {
          limit: request.limit,
          categoryId: request.categoryId,
          tag: request.tag,
          authorId: request.authorId,
          since: request.since,
          sort: request.sort,
        });
      const [articles, posts] = await Promise.all([list('article'), list('post')]);
      const merged = [...articles.items, ...posts.items];
      return merged.sort((a, b) =>
        request.sort === 'oldest' ? byPublishedDate(a, b) : byPublishedDate(b, a),
      );
    },
    [
      backend,
      demo,
      request.limit,
      request.categoryId,
      request.tag,
      request.authorId,
      request.since,
      request.sort,
    ],
  );

  const loading = demo ? feed.loading : remote.loading;
  // 演示模式直接用现成的演示数据：本地数据源没有服务端那一套筛选。
  const items = (demo ? feed.all : (remote.data ?? [])).slice(0, request.limit);

  if (loading) {
    return <div className="pp-media-empty">{t('正在读取内容…')}</div>;
  }

  // 空结果只说一句话：不渲染一个空容器占着版面。
  if (!items.length) {
    return <p className="pp-query-empty">{t('这里还没有内容。')}</p>;
  }

  return (
    <div className="pp-query-block">
      <div
        className={`pp-article-grid is-${request.layout}`}
        style={{ '--pp-article-columns': request.layout === 'list' ? 1 : 2 } as CSSProperties}
      >
        {items.map((item) => (
          <ArticleCard
            key={item.id}
            item={item}
            layout={request.layout}
            showExcerpt={showExcerpt}
            showMeta={showMeta}
            showTags={false}
          />
        ))}
      </div>
    </div>
  );
}

export const QUERY_RENDERERS: Record<string, (props: { block: BlockInstance }) => ReactElement> = {
  'content-query': QueryBlock,
};
