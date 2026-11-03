import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Content, ContentKind } from '../../types';
import { useAuth } from '../../lib/session';
import { useBackend } from '../../lib/backend';
import { readPerformance } from '../../lib/performance';
import { ApiError } from '../../lib/api';
import { KIND_LABEL, formatDate, readingTime } from '../../lib/format';
import { Badge, Button, Callout, EmptyState, Input, SkeletonRow } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { useSeo } from '../../lib/seo';
import { useT } from '../../lib/i18n';

export function ArchivePage({ kind }: { kind: ContentKind }) {
  const t = useT();
  const { site, status, config } = useAuth();
  const backend = useBackend();
  const pageSize = readPerformance(config).archive_limit;
  const [items, setItems] = useState<Content[]>([]);
  const [cursor, setCursor] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [query, setQuery] = useState('');

  useSeo({
    title: KIND_LABEL[kind],
    path: kind === 'article' ? '/articles' : '/posts',
    description:
      kind === 'article'
        ? t('全部已发布文章，按时间倒序。')
        : t('全部已发布帖子，按时间倒序。'),
    jsonLd: [
      {
        '@type': 'CollectionPage',
        name: KIND_LABEL[kind],
        description: kind === 'article' ? t('全部已发布文章') : t('全部已发布帖子'),
      },
    ],
  });

  const load = useCallback(
    async (next?: string) => {
      if (next) setLoadingMore(true);
      else setLoading(true);
      setError(null);
      try {
        const page = await backend.listContent(kind, { limit: pageSize, cursor: next });
        setItems((prev) => (next ? [...prev, ...page.items] : page.items));
        setCursor(page.next_cursor);
        setHasMore(page.has_more);
      } catch (err) {
        setError(err);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [backend, kind, pageSize],
  );

  useEffect(() => {
    setItems([]);
    setCursor('');
    setHasMore(false);
    void load();
  }, [load]);

  const published = items.filter((item) => item.status === 'published');
  const filtered = query.trim()
    ? published.filter((item) => `${item.title} ${item.summary ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()))
    : published;

  const description =
    kind === 'article'
      ? t('较长的稿子，允许修订与审核。已发布内容冻结，修改需要重新走流程。')
      : t('短内容与讨论帖。适合一句话、一个链接，或者一次编辑部周会。');

  return (
    <div className="shell">
      <header className="page-head">
        <p className="eyebrow">{kind === 'article' ? 'Articles' : 'Posts'}</p>
        <h1>{KIND_LABEL[kind]}</h1>
        <p>{description}</p>
        <div className="page-head-row">
          <div className="inline-search" style={{ width: 'min(340px, 100%)' }}>
            <Icon name="search" size={15} />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('在当前列表中筛选标题')}
              aria-label={t('筛选')}
            />
          </div>
          <span className="tiny muted">
            {t('公开阅读 · 已载入 {count} 篇', { count: published.length })}
          </span>
        </div>
      </header>

      {error ? (
        <div className="mt-24">
          <Callout tone="danger" icon="alert" title={t('无法读取列表')}>
            {error instanceof ApiError && error.code === 'unauthenticated'
              ? t('这个站点设置为「登录后浏览」，请先登录。')
              : error instanceof Error
                ? error.message
                : t('请求失败。')}
            <div className="mt-12">
              <Link to="/login" className="btn btn-secondary btn-sm">
                {t('去登录')}
              </Link>
            </div>
          </Callout>
        </div>
      ) : null}

      <div className="archive-list">
        {loading ? (
          <div className="mt-24">
            {Array.from({ length: 4 }, (_, i) => (
              <SkeletonRow key={i} />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="mt-24">
            <EmptyState
              icon={kind === 'article' ? 'file' : 'message'}
              title={query ? t('没有匹配的内容') : kind === 'article' ? t('还没有文章') : t('还没有帖子')}
              body={query ? t('换一个关键词试试。') : t('发布后会出现在这里。')}
            />
          </div>
        ) : (
          filtered.map((item) => (
            <article className="archive-item" key={item.id}>
              <span className="archive-date">{formatDate(item.published_at ?? item.created_at)}</span>
              <div>
                <div className="row gap-8 mb-8">
                  <Badge tone="muted">{KIND_LABEL[item.kind]}</Badge>
                  {item.status !== 'published' ? <Badge tone="warn">{item.status}</Badge> : null}
                  <span className="tiny faint">
                    {t('{count} 分钟', { count: readingTime(item.rendered_html) })}
                  </span>
                </div>
                <h2>
                  <Link to={`/${item.kind === 'article' ? 'a' : 'p'}/${item.id}`}>{item.title}</Link>
                </h2>
                <p>{item.summary ?? ''}</p>
              </div>
              <span className="archive-author">{item.author_name ?? t('编辑部')}</span>
            </article>
          ))
        )}
      </div>

      {hasMore ? (
        <div className="feed-more">
          <Button variant="secondary" loading={loadingMore} onClick={() => void load(cursor)}>
            {t('加载更多')}
          </Button>
        </div>
      ) : items.length > 0 ? (
        <p className="center tiny faint" style={{ padding: '28px 0' }}>
          {t('已经到底了。共 {count} 篇。', { count: items.length })}
        </p>
      ) : null}

      {status !== 'anonymous' ? (
        <p className="tiny faint mt-16">
          {t('公开列表只展示已发布内容。草稿、待审核与已归档的稿件在')}
          <Link to="/admin/content" className="text-link">
            {t(' 内容库 ')}
          </Link>
          {t('里。')}
        </p>
      ) : null}

      {site?.visibility_mode === 'members_only' ? (
        <div className="mt-24">
          <Callout tone="info" icon="lock" title={t('这是一个仅成员可见的站点')}>
            {t('匿名访客会收到 401。登录后可以继续阅读。')}
          </Callout>
        </div>
      ) : null}
    </div>
  );
}
