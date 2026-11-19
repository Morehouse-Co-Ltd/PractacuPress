import { useMemo } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { Content, TaxonomyTerm } from '../../types';
import { useBackend } from '../../lib/backend';
import { useAsync } from '../../lib/hooks';
import { useTaxonomy } from '../../lib/useTaxonomy';
import { useCustomization } from '../../lib/customize';
import { KIND_LABEL, formatDate, readingTime } from '../../lib/format';
import { useSeo } from '../../lib/seo';
import { useT } from '../../lib/i18n';
import { Badge, Callout, EmptyState, Skeleton } from '../../components/ui';
import { Cover } from '../../components/Cover';
import { Icon } from '../../components/Icon';
import {
  categoryCounts,
  contentPath,
  isPublished,
  matchesCategory,
  matchesTag,
  sortNewest,
  sortOldest,
  tagCloudSize,
  tagCounts,
  type KindFilter,
} from './readExperience';

/**
 * 分类与标签归档（FSD A-21 / A-22 / A-23 / A-24）。
 *
 * 契约只有内容列表，没有分类计数端点；页面一次取两类内容的已发布池，
 * 在前端按 `category_id` / 标签名过滤和计数。真实后端支持 `category_id` / `tag`
 * 参数，但演示后端会忽略它们，所以统一在客户端再筛一次，两种模式结果一致。
 */

function useContentPool() {
  const backend = useBackend();
  return useAsync(async () => {
    const [articles, posts] = await Promise.all([
      backend.listContent('article', { limit: 100 }),
      backend.listContent('post', { limit: 100 }),
    ]);
    return sortNewest([...articles.items, ...posts.items].filter(isPublished));
  }, [backend]);
}

function PoolError({ error }: { error: unknown }) {
  const t = useT();
  return (
    <div className="mt-24">
      <Callout tone="danger" icon="alert" title={t('无法读取内容')}>
        {error instanceof Error ? error.message : t('请求失败。')}
      </Callout>
    </div>
  );
}

function TaxonomyTabs() {
  const t = useT();
  return (
    <div className="row gap-8 mt-16" style={{ flexWrap: 'wrap' }}>
      <Link to="/articles" className="pill">
        {t('全部文章')}
      </Link>
      <Link to="/categories" className="pill">
        <Icon name="grid" size={13} /> {t('分类')}
      </Link>
      <Link to="/tags" className="pill">
        <Icon name="tag" size={13} /> {t('标签')}
      </Link>
    </div>
  );
}

/* ------------------------------ 分类列表 ------------------------------ */

export function CategoriesPage() {
  const t = useT();
  const { taxonomy } = useTaxonomy();
  const pool = useContentPool();
  const counts = useMemo(() => categoryCounts(pool.data ?? []), [pool.data]);
  const terms = useMemo(
    () =>
      [...taxonomy.categories].sort(
        (a, b) => (counts[b.id] ?? 0) - (counts[a.id] ?? 0) || a.name.localeCompare(b.name),
      ),
    [taxonomy.categories, counts],
  );

  useSeo({
    title: t('分类'),
    description: t('按分类浏览全部已发布内容。'),
    path: '/categories',
    jsonLd: [{ '@type': 'CollectionPage', name: t('分类') }],
  });

  return (
    <div className="shell">
      <header className="page-head">
        <p className="eyebrow">Categories</p>
        <h1>{t('分类')}</h1>
        <p>{t('按主题浏览已发布内容；卡片按篇数从多到少排列。')}</p>
        <TaxonomyTabs />
      </header>

      {pool.error ? <PoolError error={pool.error} /> : null}

      {pool.loading ? (
        <div className="mt-24">
          <Skeleton lines={6} />
        </div>
      ) : terms.length === 0 ? (
        <div className="mt-24">
          <EmptyState
            icon="grid"
            title={t('还没有分类')}
            body={t('站长可以在后台的分类与标签里创建分类。')}
            action={
              <Link to="/articles" className="btn btn-secondary btn-sm">
                {t('去读文章')}
              </Link>
            }
          />
        </div>
      ) : (
        <div className="taxonomy-grid">
          {terms.map((term) => {
            const count = counts[term.id] ?? 0;
            return (
              <Link className="taxonomy-card" to={`/category/${encodeURIComponent(term.slug)}`} key={term.id}>
                <div className="taxonomy-card-cover">
                  <Cover seed={term.id} label={term.name} ratio="16 / 9" />
                </div>
                <div className="taxonomy-card-body">
                  <div className="taxonomy-card-meta">
                    <span
                      className="taxonomy-dot"
                      style={{ background: term.color || 'var(--accent)' }}
                      aria-hidden
                    />
                    <span>{t('{count} 篇', { count })}</span>
                  </div>
                  <h2>{term.name}</h2>
                  <p>{term.description || t('这个分类还没有说明。')}</p>
                  <span className="taxonomy-card-more">
                    {t('浏览分类')} <Icon name="arrow-right" size={12} />
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ------------------------------ 标签云 ------------------------------ */

function mergedTagTerms(taxonomyTags: TaxonomyTerm[], counts: Record<string, number>): TaxonomyTerm[] {
  const known = new Set(taxonomyTags.map((term) => term.name));
  const extra = Object.keys(counts)
    .filter((name) => !known.has(name))
    .map<TaxonomyTerm>((name) => ({ id: `tag_${name}`, name, slug: name }));
  return [...taxonomyTags, ...extra];
}

export function TagsPage() {
  const t = useT();
  const { taxonomy } = useTaxonomy();
  const pool = useContentPool();
  const [params, setParams] = useSearchParams();
  const sort = params.get('sort') === 'name' ? 'name' : 'count';
  const counts = useMemo(() => tagCounts(pool.data ?? []), [pool.data]);
  const terms = useMemo(() => mergedTagTerms(taxonomy.tags, counts), [taxonomy.tags, counts]);
  const sorted = useMemo(
    () =>
      [...terms].sort((a, b) =>
        sort === 'count'
          ? (counts[b.name] ?? 0) - (counts[a.name] ?? 0) || a.name.localeCompare(b.name)
          : a.name.localeCompare(b.name),
      ),
    [terms, counts, sort],
  );
  const max = Math.max(0, ...terms.map((term) => counts[term.name] ?? 0));
  const min = Math.min(...terms.map((term) => counts[term.name] ?? 0), max);

  useSeo({
    title: t('标签'),
    description: t('按标签浏览全部已发布内容。'),
    path: '/tags',
    jsonLd: [{ '@type': 'CollectionPage', name: t('标签') }],
  });

  return (
    <div className="shell">
      <header className="page-head">
        <p className="eyebrow">Tags</p>
        <h1>{t('标签')}</h1>
        <p>{t('字号随篇数变化；标签越多，字号越大。')}</p>
        <TaxonomyTabs />
        <div className="row gap-8 mt-16" style={{ flexWrap: 'wrap' }}>
          <button
            type="button"
            className={`pill${sort === 'count' ? ' is-on' : ''}`}
            onClick={() => setParams({ sort: 'count' })}
          >
            {t('按篇数')}
          </button>
          <button
            type="button"
            className={`pill${sort === 'name' ? ' is-on' : ''}`}
            onClick={() => setParams({ sort: 'name' })}
          >
            {t('按名称')}
          </button>
        </div>
      </header>

      {pool.error ? <PoolError error={pool.error} /> : null}

      {pool.loading ? (
        <div className="mt-24">
          <Skeleton lines={6} />
        </div>
      ) : sorted.length === 0 ? (
        <div className="mt-24">
          <EmptyState
            icon="tag"
            title={t('还没有标签')}
            body={t('给内容加上标签后，它们会出现在这里。')}
            action={
              <Link to="/articles" className="btn btn-secondary btn-sm">
                {t('去读文章')}
              </Link>
            }
          />
        </div>
      ) : (
        <div className="tag-cloud" aria-label={t('标签云')}>
          {sorted.map((term) => {
            const count = counts[term.name] ?? 0;
            return (
              <Link
                key={term.id}
                to={`/tag/${encodeURIComponent(term.slug)}`}
                className="tag-cloud-item"
                style={{ fontSize: tagCloudSize(count, min, max) }}
              >
                {term.name}
                <span>{count}</span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ------------------------------ 分类 / 标签详情 ------------------------------ */

function kindFilterOf(raw: string | null): KindFilter {
  return raw === 'article' || raw === 'post' ? raw : '';
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function ArchiveRows({ items }: { items: Content[] }) {
  const t = useT();
  const { customization } = useCustomization();
  return (
    <div className="archive-list">
      {items.map((item) => (
        <article className="archive-item" key={item.id}>
          <span className="archive-date">{formatDate(item.published_at ?? item.created_at)}</span>
          <div>
            <div className="row gap-8 mb-8">
              <Badge tone="muted">{KIND_LABEL[item.kind]}</Badge>
              <span className="tiny faint">
                {t('{count} 分钟', { count: readingTime(item.rendered_html) })}
              </span>
            </div>
            <h2>
              <Link to={contentPath(item, customization.seo.permalinks)}>{item.title}</Link>
            </h2>
            <p>{item.summary ?? ''}</p>
          </div>
          <span className="archive-author">{item.author_name ?? t('编辑部')}</span>
        </article>
      ))}
    </div>
  );
}

function TermArchivePage({ mode }: { mode: 'category' | 'tag' }) {
  const t = useT();
  const { slug = '' } = useParams();
  const decoded = safeDecode(slug);
  const { taxonomy } = useTaxonomy();
  const pool = useContentPool();
  const [params, setParams] = useSearchParams();
  const kind = kindFilterOf(params.get('kind'));
  const sort = params.get('sort') === 'oldest' ? 'oldest' : 'newest';

  const term = useMemo(() => {
    const source = mode === 'category' ? taxonomy.categories : taxonomy.tags;
    return source.find(
      (entry) =>
        entry.slug === decoded ||
        entry.id === decoded ||
        (mode === 'tag' && entry.name === decoded),
    );
  }, [mode, taxonomy, decoded]);

  const name = term?.name ?? decoded;

  const items = useMemo(() => {
    const poolItems = (pool.data ?? []).filter((item) =>
      mode === 'category' ? matchesCategory(item, term?.id ?? decoded) : matchesTag(item, name),
    );
    const filtered = kind ? poolItems.filter((item) => item.kind === kind) : poolItems;
    return sort === 'oldest' ? sortOldest(filtered) : sortNewest(filtered);
  }, [pool.data, mode, term, decoded, name, kind, sort]);

  useSeo({
    title: name || (mode === 'category' ? t('分类') : t('标签')),
    description:
      mode === 'category'
        ? t('{name} 分类下的全部已发布内容。', { name })
        : t('带有「{name}」标签的全部已发布内容。', { name }),
    path: `/${mode}/${encodeURIComponent(slug)}`,
    jsonLd: [
      {
        '@type': 'CollectionPage',
        name,
        description: mode === 'category' ? t('{name} 分类归档', { name }) : t('{name} 标签归档', { name }),
      },
    ],
  });

  const setKind = (next: KindFilter) => {
    const nextParams = new URLSearchParams();
    if (next) nextParams.set('kind', next);
    if (sort !== 'newest') nextParams.set('sort', sort);
    setParams(nextParams);
  };

  const setSort = (next: 'newest' | 'oldest') => {
    const nextParams = new URLSearchParams();
    if (kind) nextParams.set('kind', kind);
    if (next !== 'newest') nextParams.set('sort', next);
    setParams(nextParams);
  };

  return (
    <div className="shell">
      <header className="page-head">
        <p className="eyebrow">{mode === 'category' ? 'Category' : 'Tag'}</p>
        <h1>
          {mode === 'category' ? <span className="term-swatch" style={{ background: term?.color || 'var(--accent)' }} aria-hidden /> : <span className="term-hash">#</span>}
          {name || t('未命名')}
        </h1>
        <p>
          {term?.description ||
            (mode === 'category' ? t('这个分类还没有说明。') : t('带有这个标签的内容会归在这里。'))}
        </p>
        <div className="row gap-8 mt-16" style={{ flexWrap: 'wrap' }}>
          <Link to={mode === 'category' ? '/categories' : '/tags'} className="pill">
            <Icon name="arrow-left" size={12} /> {mode === 'category' ? t('全部分类') : t('全部标签')}
          </Link>
          <Link to={mode === 'category' ? '/tags' : '/categories'} className="pill">
            <Icon name={mode === 'category' ? 'tag' : 'grid'} size={12} />{' '}
            {mode === 'category' ? t('标签') : t('分类')}
          </Link>
        </div>
      </header>

      <div className="search-meta">
        <div className="row gap-8" style={{ flexWrap: 'wrap' }}>
          <span>{t('范围')}</span>
          {(
            [
              { key: '' as KindFilter, label: t('全部') },
              { key: 'article' as KindFilter, label: KIND_LABEL.article },
              { key: 'post' as KindFilter, label: KIND_LABEL.post },
            ]
          ).map((entry) => (
            <button
              key={entry.key || 'all'}
              type="button"
              className={`pill${kind === entry.key ? ' is-on' : ''}`}
              onClick={() => setKind(entry.key)}
            >
              {entry.label}
            </button>
          ))}
          <span className="faint">·</span>
          <button
            type="button"
            className={`pill${sort === 'newest' ? ' is-on' : ''}`}
            onClick={() => setSort('newest')}
          >
            {t('最新')}
          </button>
          <button
            type="button"
            className={`pill${sort === 'oldest' ? ' is-on' : ''}`}
            onClick={() => setSort('oldest')}
          >
            {t('最早')}
          </button>
        </div>
        <span>{t('共 {count} 篇', { count: items.length })}</span>
      </div>

      {pool.error ? <PoolError error={pool.error} /> : null}

      {pool.loading ? (
        <div className="mt-24">
          <Skeleton lines={8} />
        </div>
      ) : items.length === 0 ? (
        <div className="mt-24">
          <EmptyState
            icon={mode === 'category' ? 'grid' : 'tag'}
            title={t('这个归档还没有内容')}
            body={t('换一个分类或标签，或者先发布几篇内容。')}
            action={
              <Link to="/articles" className="btn btn-secondary btn-sm">
                {t('去读文章')}
              </Link>
            }
          />
        </div>
      ) : (
        <ArchiveRows items={items} />
      )}
    </div>
  );
}

export function CategoryPage() {
  return <TermArchivePage mode="category" />;
}

export function TagPage() {
  return <TermArchivePage mode="tag" />;
}
