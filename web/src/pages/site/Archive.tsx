import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Content, ContentKind } from '../../types';
import { useAuth } from '../../lib/session';
import { useBackend } from '../../lib/backend';
import { readPerformance } from '../../lib/performance';
import { ApiError, isBackendOffline } from '../../lib/api';
import { KIND_LABEL, formatDate, readingTime } from '../../lib/format';
import { Badge, Button, Callout, EmptyState, Input, SkeletonRow } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { ContentCover } from '../../components/Cover';
import { useSeo } from '../../lib/seo';
import { useT } from '../../lib/i18n';
import { usePermissions } from '../../lib/usePermissions';
import { contentPath, groupArchiveByMonth } from './readExperience';

type ArchiveView = 'list' | 'cards';
const ARCHIVE_VIEW_KEY = 'pp.archive.view.v1';

function readArchiveView(): ArchiveView {
  try {
    return localStorage.getItem(ARCHIVE_VIEW_KEY) === 'cards' ? 'cards' : 'list';
  } catch {
    return 'list';
  }
}

function saveArchiveView(view: ArchiveView): void {
  try {
    localStorage.setItem(ARCHIVE_VIEW_KEY, view);
  } catch {
    /* 本地存储不可用时只影响偏好记忆 */
  }
}

export function ArchivePage({ kind }: { kind: ContentKind }) {
  const t = useT();
  const { site, status, config } = useAuth();
  const { adminEntry } = usePermissions();
  const backend = useBackend();
  const pageSize = readPerformance(config).archive_limit;
  const [items, setItems] = useState<Content[]>([]);
  const [cursor, setCursor] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [query, setQuery] = useState('');
  // 列表 / 卡片：读者自己选，存本地；不改变任何内容数据。
  const [view, setView] = useState<ArchiveView>(readArchiveView);

  const chooseView = (next: ArchiveView) => {
    setView(next);
    saveArchiveView(next);
  };

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
  const groups = useMemo(() => groupArchiveByMonth(filtered), [filtered]);

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
          <div className="archive-view-switch" role="group" aria-label={t('文章显示方式')}>
            <button
              type="button"
              className={view === 'list' ? 'is-active' : undefined}
              aria-pressed={view === 'list'}
              onClick={() => chooseView('list')}
            >
              <Icon name="list" size={14} /> {t('列表')}
            </button>
            <button
              type="button"
              className={view === 'cards' ? 'is-active' : undefined}
              aria-pressed={view === 'cards'}
              onClick={() => chooseView('cards')}
            >
              <Icon name="grid" size={14} /> {t('卡片')}
            </button>
          </div>
        </div>
        <div className="row gap-8 mt-16" style={{ flexWrap: 'wrap' }}>
          <Link to="/categories" className="pill">
            <Icon name="grid" size={13} /> {t('分类')}
          </Link>
          <Link to="/tags" className="pill">
            <Icon name="tag" size={13} /> {t('标签')}
          </Link>
          <Link to="/search" className="pill">
            <Icon name="search" size={13} /> {t('搜索')}
          </Link>
        </div>
      </header>

      {error ? (
        <div className="mt-24">
          <Callout
            tone="danger"
            icon="alert"
            title={isBackendOffline(error) ? t('无法连接 API') : t('无法读取列表')}
          >
            {error instanceof ApiError && error.code === 'unauthenticated'
              ? t('这个站点设置为「登录后浏览」，请先登录。')
              : error instanceof Error
                ? error.message
                : t('请求失败。')}
            <div className="mt-12 row gap-8">
              {error instanceof ApiError && error.code === 'unauthenticated' ? (
                <Link to="/login" className="btn btn-secondary btn-sm">
                  {t('去登录')}
                </Link>
              ) : null}
              {/* 后端连不上时登录页同样打不开，这里只留重试。 */}
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>
                {t('重试')}
              </button>
            </div>
          </Callout>
        </div>
      ) : null}

      {loading ? (
        <div className="archive-list mt-24">
          {Array.from({ length: 4 }, (_, i) => (
            <SkeletonRow key={i} />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="archive-list">
          <div className="mt-24">
            <EmptyState
              icon={kind === 'article' ? 'file' : 'message'}
              title={query ? t('没有匹配的内容') : kind === 'article' ? t('还没有文章') : t('还没有帖子')}
              body={query ? t('换一个关键词试试。') : t('发布后会出现在这里。')}
            />
          </div>
        </div>
      ) : (
        <>
          <nav className="year-jump" aria-label={t('年份快速跳转')}>
            {groups.map((group) => (
              <a key={group.year} href={`#year-${group.year}`} className="year-jump-item">
                <strong>{group.year}</strong>
                <span>{t('{count} 篇', { count: group.count })}</span>
              </a>
            ))}
          </nav>

          {view === 'cards' ? (
            <div className="archive-groups">
              {groups.map((group) => (
                <section className="archive-year" id={`year-${group.year}`} key={group.year}>
                  <header className="archive-year-head">
                    <h2>{group.year}</h2>
                    <span>{t('{count} 篇', { count: group.count })}</span>
                  </header>
                  <div className="archive-card-grid">
                    {group.months.flatMap((month) => month.items).map((item) => (
                      <article className="archive-card" key={item.id}>
                        <Link
                          to={contentPath(item)}
                          className="archive-card-cover"
                          aria-label={item.title}
                          tabIndex={-1}
                        >
                          <ContentCover id={item.id} label={item.title} ratio="16 / 10" accent />
                        </Link>
                        <div className="archive-card-body">
                          <div className="archive-card-meta">
                            <Badge tone="muted">{KIND_LABEL[item.kind]}</Badge>
                            <span>{formatDate(item.published_at ?? item.created_at)}</span>
                            {item.view_count ? (
                              <span>{t('{count} 次阅读', { count: item.view_count })}</span>
                            ) : null}
                          </div>
                          <h2>
                            <Link to={contentPath(item)}>{item.title}</Link>
                          </h2>
                          {item.summary ? <p>{item.summary}</p> : null}
                          <div className="archive-card-foot">
                            <span>{item.author_name ?? t('编辑部')}</span>
                            <span>{t('{count} 分钟', { count: readingTime(item.rendered_html) })}</span>
                          </div>
                        </div>
                      </article>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          ) : (
            <div className="archive-groups">
              {groups.map((group) => (
                <section className="archive-year" id={`year-${group.year}`} key={group.year}>
                  <header className="archive-year-head">
                    <h2>{group.year}</h2>
                    <span>{t('{count} 篇', { count: group.count })}</span>
                  </header>
                  {group.months.map((month) => (
                    <section className="archive-month" key={month.month}>
                      <h3>
                        <span>{t('{month} 月', { month: month.month })}</span>
                        <em>{t('{count} 篇', { count: month.count })}</em>
                      </h3>
                      <div className="archive-list">
                        {month.items.map((item) => (
                          <article className="archive-item" key={item.id}>
                            <span className="archive-date">{formatDate(item.published_at ?? item.created_at)}</span>
                            <div>
                              <div className="row gap-8 mb-8">
                                <Badge tone="muted">{KIND_LABEL[item.kind]}</Badge>
                                {item.status !== 'published' ? <Badge tone="warn">{item.status}</Badge> : null}
                                <span className="tiny faint">
                                  {t('{count} 分钟', { count: readingTime(item.rendered_html) })}
                                </span>
                                {/* 阅读量来自服务端计数（FSD A-16），列表一次返回，不必逐篇再查。 */}
                                {item.view_count ? (
                                  <span className="tiny faint">
                                    {t('{count} 次阅读', { count: item.view_count })}
                                  </span>
                                ) : null}
                              </div>
                              <h2>
                                <Link to={contentPath(item)}>{item.title}</Link>
                              </h2>
                              <p>{item.summary ?? ''}</p>
                            </div>
                            <span className="archive-author">{item.author_name ?? t('编辑部')}</span>
                          </article>
                        ))}
                      </div>
                    </section>
                  ))}
                </section>
              ))}
            </div>
          )}
        </>
      )}

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

      {status !== 'anonymous' && adminEntry ? (
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
