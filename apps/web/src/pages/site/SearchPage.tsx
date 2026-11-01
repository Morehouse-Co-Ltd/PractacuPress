import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { ContentKind } from '../../types';
import { useBackend } from '../../lib/backend';
import { useAsync } from '../../lib/hooks';
import { formatDate, readingTime } from '../../lib/format';
import { Button, Callout, EmptyState, Input, Skeleton } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { pageSearchText, useCustomization } from '../../lib/customize';
import { useSeo } from '../../lib/seo';

export function SearchPage() {
  const backend = useBackend();
  const { customization } = useCustomization();
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const kindParam = params.get('kind');
  const kind: ContentKind | '' = kindParam === 'article' || kindParam === 'post' ? kindParam : '';
  const [input, setInput] = useState(query);
  const [error, setError] = useState('');
  // 搜索结果页永远不进索引：同一个 URL 会随关键词产生无限多份内容。
  useSeo({
    title: query ? `搜索：${query}` : '搜索',
    description: '在已发布内容与自定义页面里搜索。',
    path: '/search',
    noindex: true,
  });

  useEffect(() => {
    setInput(query);
  }, [query]);

  const result = useAsync(
    async () => {
      if (query.trim().length < 2) {
        return { items: [], next_cursor: '', has_more: false };
      }
      return backend.search(query.trim(), kind || undefined, 30);
    },
    [backend, query, kind],
  );

  const pageHits =
    query.trim().length >= 2 && !kind
      ? customization.pages.filter((page) => {
          if (page.status !== 'published') return false;
          const haystack = pageSearchText(page).toLowerCase();
          return haystack.includes(query.trim().toLowerCase());
        })
      : [];

  const submit = (nextQuery: string, nextKind: ContentKind | '' = kind) => {
    if (nextQuery.trim().length < 2) {
      setError('搜索词至少 2 个字符。');
      return;
    }
    setError('');
    const next = new URLSearchParams();
    next.set('q', nextQuery.trim());
    if (nextKind) next.set('kind', nextKind);
    setParams(next, { replace: true });
  };

  return (
    <div className="shell">
      <header className="page-head">
        <p className="eyebrow">Search</p>
        <h1>在稿子里找一句话。</h1>
        <p>
          搜索已发布内容与自定义页面；草稿、被退回的稿子和未发布页面不会出现在结果里。搜索词里的通配符按字面处理。
        </p>
        <form
          className="search-box"
          onSubmit={(e) => {
            e.preventDefault();
            submit(input);
          }}
        >
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="输入至少 2 个字符，例如：排版"
            aria-label="搜索词"
            autoFocus
          />
          <Button type="submit" icon="search">
            搜索
          </Button>
        </form>
        <div className="row gap-8 mt-16" style={{ flexWrap: 'wrap' }}>
          {['排版', '审核', '社区', '独立出版'].map((term) => (
            <button
              key={term}
              type="button"
              className="chip"
              style={{ cursor: 'pointer' }}
              onClick={() => {
                setInput(term);
                submit(term);
              }}
            >
              {term}
            </button>
          ))}
        </div>
      </header>

      {error ? (
        <div className="mt-20">
          <Callout tone="danger" icon="alert">
            {error}
          </Callout>
        </div>
      ) : null}

      <div className="search-meta">
        <div className="row gap-8">
          <span>范围</span>
          {(
            [
              { key: '' as const, label: '全部' },
              { key: 'article' as const, label: '文章' },
              { key: 'post' as const, label: '帖子' },
            ]
          ).map((item) => (
            <button
              key={item.key || 'all'}
              type="button"
              className={`pill${kind === item.key ? ' is-on' : ''}`}
              onClick={() => submit(query || input, item.key)}
              disabled={query.trim().length < 2 && input.trim().length < 2}
            >
              {item.label}
            </button>
          ))}
        </div>
        <span>
          {query.trim().length >= 2
            ? result.loading
              ? '正在搜索…'
              : `找到 ${result.data?.items.length ?? 0} 条${
                  pageHits.length ? ` · ${pageHits.length} 个页面` : ''
                }`
            : '等待关键词'}
        </span>
      </div>

      {result.error ? (
        <div className="mt-20">
          <Callout tone="danger" icon="alert" title="搜索没有完成">
            {result.error instanceof Error ? result.error.message : '请求失败。'}
          </Callout>
        </div>
      ) : null}

      <div className="search-results">
        {result.loading && query ? (
          <div className="mt-24">
            <Skeleton lines={6} />
          </div>
        ) : query.trim().length < 2 ? (
          <div className="mt-24">
            <EmptyState
              icon="search"
              title="输入一个词开始搜索"
              body="标题、摘要与页面正文都会参与匹配。只覆盖已发布内容与页面。"
            />
          </div>
        ) : (result.data?.items.length ?? 0) === 0 && pageHits.length === 0 ? (
          <div className="mt-24">
            <EmptyState
              icon="search"
              title={`没有找到「${query}」`}
              body="换一个更短的词，或者去掉分类筛选。"
              action={
                kind ? (
                  <Button variant="secondary" size="sm" onClick={() => submit(query, '')}>
                    搜索全部类型
                  </Button>
                ) : null
              }
            />
          </div>
        ) : (
          <>
            {pageHits.map((page) => (
              <article className="story" key={page.id}>
                <span className="story-index">页</span>
                <div className="story-body">
                  <h3>
                    <Link to={`/${page.slug}`}>{page.title}</Link>
                  </h3>
                  <p>{page.summary ?? ''}</p>
                  <div className="story-meta">
                    <span>自定义页面</span>
                    <span>更新于 {formatDate(page.updated_at)}</span>
                  </div>
                </div>
                <div className="story-side" aria-hidden>
                  <Icon name="arrow-up-right" size={16} />
                </div>
              </article>
            ))}
            {result.data?.items.map((item) => (
              <article className="story" key={item.id}>
                <span className="story-index">{item.kind === 'article' ? '文' : '帖'}</span>
                <div className="story-body">
                  <h3>
                    <Link to={`/${item.kind === 'article' ? 'a' : 'p'}/${item.id}`}>{item.title}</Link>
                  </h3>
                  <p>{item.summary ?? ''}</p>
                  <div className="story-meta">
                    <span>{item.author_name ?? '编辑部'}</span>
                    <span>{formatDate(item.published_at ?? item.created_at)}</span>
                    <span>{readingTime(item.rendered_html)} 分钟</span>
                  </div>
                </div>
                <div className="story-side" aria-hidden>
                  <Icon name="arrow-up-right" size={16} />
                </div>
              </article>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
