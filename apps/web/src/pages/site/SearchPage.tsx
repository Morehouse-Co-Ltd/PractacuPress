import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { ContentKind, SearchHit } from '../../types';
import { useBackend } from '../../lib/backend';
import { formatDate, readingTime } from '../../lib/format';
import { Button, Callout, EmptyState, Field, Input, Select, Skeleton } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { pageSearchText, useCustomization } from '../../lib/customize';
import { useSeo } from '../../lib/seo';
import { useT } from '../../lib/i18n';
import { useTaxonomy } from '../../lib/useTaxonomy';
import {
  clearSearchHistory,
  highlightParts,
  pushSearchHistory,
  readSearchHistory,
  removeSearchHistory,
  type HighlightPart,
} from './readExperience';

function Highlight({ text, query }: { text: string; query: string }) {
  const parts = highlightParts(text, query);
  return (
    <>
      {parts.map((part: HighlightPart, index) =>
        part.hit ? (
          <mark className="search-hit" key={index}>
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

/** 每页条数：与服务端的默认值一致，翻页用真实游标。 */
const PAGE_SIZE = 20;

/**
 * 把 `<input type="date">` 的 yyyy-mm-dd 变成 RFC 3339。
 *
 * 用读者本地时区的当天边界：读者选「10 月 1 日」时指的是自己那天的 00:00 与
 * 23:59:59，换算成 UTC 再交给服务端，避免跨时区少算或多算一天。
 */
function dayStartIso(day: string): string | undefined {
  if (!day) return undefined;
  const parsed = new Date(`${day}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function dayEndIso(day: string): string | undefined {
  if (!day) return undefined;
  const parsed = new Date(`${day}T23:59:59.999`);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export function SearchPage() {
  const t = useT();
  const backend = useBackend();
  const { customization } = useCustomization();
  const { taxonomy } = useTaxonomy();
  const [params, setParams] = useSearchParams();

  // URL 是搜索状态的唯一来源：关键词、范围与筛选都在地址栏里，刷新和分享都能复原。
  const query = params.get('q') ?? '';
  const kindParam = params.get('kind');
  const kind: ContentKind | '' = kindParam === 'article' || kindParam === 'post' ? kindParam : '';
  const category = params.get('category') ?? '';
  const tag = params.get('tag') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';

  const [input, setInput] = useState(query);
  const [tagDraft, setTagDraft] = useState(tag);
  const [error, setError] = useState('');
  const [requestError, setRequestError] = useState<unknown>(null);
  const [history, setHistory] = useState<string[]>(() => readSearchHistory());

  // 服务端返回的这一页、全量命中数与下一页游标。
  const [items, setItems] = useState<SearchHit[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [degraded, setDegraded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // 搜索结果页永远不进索引：同一个 URL 会随关键词产生无限多份内容。
  useSeo({
    title: query ? t('搜索：{query}', { query }) : t('搜索'),
    description: t('在已发布内容与自定义页面里搜索。'),
    path: '/search',
    noindex: true,
  });

  useEffect(() => {
    setInput(query);
  }, [query]);

  useEffect(() => {
    setTagDraft(tag);
  }, [tag]);

  // 真正提交过一次（URL 里出现 q）才记历史，避免把输入过程中的半截词存进去。
  useEffect(() => {
    const value = query.trim();
    if (value.length < 2) return;
    setHistory(pushSearchHistory(value));
  }, [query]);

  const term = query.trim();
  const active = term.length >= 2;

  /**
   * 取一页结果。`next` 为空表示第一页；否则是上一页返回的真实游标。
   *
   * 第一页会清空旧结果，翻页则追加，所以「加载更多」不会让列表跳动或重复。
   */
  const load = useCallback(
    async (next?: string) => {
      if (term.length < 2) {
        setItems([]);
        setTotal(0);
        setCursor('');
        setHasMore(false);
        setDegraded(false);
        setRequestError(null);
        setLoading(false);
        setLoadingMore(false);
        return;
      }

      if (next) setLoadingMore(true);
      else {
        setLoading(true);
        setItems([]);
      }
      setRequestError(null);

      try {
        const page = await backend.search(term, {
          kind: kind || undefined,
          category_id: category || undefined,
          tag: tag || undefined,
          since: dayStartIso(from),
          until: dayEndIso(to),
          cursor: next,
          limit: PAGE_SIZE,
        });
        setItems((prev) => (next ? [...prev, ...page.items] : page.items));
        setTotal(page.total);
        setCursor(page.next_cursor);
        setHasMore(page.has_more);
        setDegraded(Boolean(page.degraded));
      } catch (err) {
        setRequestError(err);
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [backend, term, kind, category, tag, from, to],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const pageHits =
    active && !kind && !category && !tag && !from && !to
      ? customization.pages.filter((page) => {
          if (page.status !== 'published') return false;
          const haystack = pageSearchText(page).toLowerCase();
          return haystack.includes(term.toLowerCase());
        })
      : [];

  const categories = useMemo(
    () =>
      [...taxonomy.categories].sort(
        (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'),
      ),
    [taxonomy.categories],
  );

  const filterCount = [kind, category, tag, from, to].filter(Boolean).length;

  const submit = (nextQuery: string, nextKind: ContentKind | '' = kind) => {
    if (nextQuery.trim().length < 2) {
      setError(t('搜索词至少 2 个字符。'));
      return;
    }
    setError('');
    const next = new URLSearchParams();
    next.set('q', nextQuery.trim());
    if (nextKind) next.set('kind', nextKind);
    // 换关键词时保留筛选条件：读者调过的范围不该被一次新搜索清空。
    if (category) next.set('category', category);
    if (tag) next.set('tag', tag);
    if (from) next.set('from', from);
    if (to) next.set('to', to);
    setParams(next, { replace: true });
  };

  /** 只改一个筛选条件；空值表示移除该条件。 */
  const updateFilter = (key: 'category' | 'tag' | 'from' | 'to', value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const clearFilters = () => {
    const next = new URLSearchParams();
    if (query) next.set('q', query);
    setError('');
    setParams(next, { replace: true });
  };

  return (
    <div className="shell">
      <header className="page-head">
        <p className="eyebrow">Search</p>
        <h1>{t('在稿子里找一句话。')}</h1>
        <p>
          {t(
            '搜索已发布内容与自定义页面；草稿、被退回的稿子和未发布页面不会出现在结果里。搜索词里的通配符按字面处理。',
          )}
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
            placeholder={t('输入至少 2 个字符，例如：排版')}
            aria-label={t('搜索词')}
            autoFocus
          />
          <Button type="submit" icon="search">
            {t('搜索')}
          </Button>
        </form>
        <div className="row gap-8 mt-16" style={{ flexWrap: 'wrap' }}>
          {[t('排版'), t('审核'), t('社区'), t('独立出版')].map((item) => (
            <button
              key={item}
              type="button"
              className="chip"
              style={{ cursor: 'pointer' }}
              onClick={() => {
                setInput(item);
                submit(item);
              }}
            >
              {item}
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
          <span>{t('范围')}</span>
          {(
            [
              { key: '' as const, label: t('全部') },
              { key: 'article' as const, label: t('文章') },
              { key: 'post' as const, label: t('帖子') },
            ]
          ).map((item) => (
            <button
              key={item.key || 'all'}
              type="button"
              className={`pill${kind === item.key ? ' is-on' : ''}`}
              onClick={() => submit(query || input, item.key)}
              disabled={term.length < 2 && input.trim().length < 2}
            >
              {item.label}
            </button>
          ))}
        </div>
        <span>
          {active
            ? loading
              ? t('正在搜索…')
              : `${t('找到 {count} 条', { count: total })}${
                  pageHits.length ? ` · ${t('{count} 个页面', { count: pageHits.length })}` : ''
                }`
            : t('等待关键词')}
        </span>
      </div>

      {/* 筛选全部在服务端执行，所以翻页时不会漏掉筛掉的条目。 */}
      <section className="search-filters" aria-label={t('筛选')}>
        <Field label={t('分类')}>
          <Select
            value={category}
            onChange={(e) => updateFilter('category', e.target.value)}
            disabled={categories.length === 0}
            aria-label={t('按分类筛选')}
          >
            <option value="">{t('全部分类')}</option>
            {categories.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('标签')}>
          <Input
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            onBlur={() => updateFilter('tag', tagDraft.trim())}
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              e.preventDefault();
              updateFilter('tag', tagDraft.trim());
            }}
            placeholder={t('完整标签名')}
            aria-label={t('按标签筛选')}
          />
        </Field>
        <Field label={t('发布于')}>
          <Input
            type="date"
            value={from}
            max={to || undefined}
            onChange={(e) => updateFilter('from', e.target.value)}
            aria-label={t('起始日期')}
          />
        </Field>
        <Field label={t('至')}>
          <Input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(e) => updateFilter('to', e.target.value)}
            aria-label={t('结束日期')}
          />
        </Field>
        {filterCount ? (
          <Button type="button" variant="ghost" size="sm" onClick={clearFilters} icon="close">
            {t('清除筛选')}
          </Button>
        ) : null}
      </section>

      {degraded ? (
        <div className="mt-16">
          <Callout tone="info" icon="alert">
            {t(
              '全文索引暂时不可用，这次结果按发布时间排序，不是相关度排序；稍后重试即可恢复。',
            )}
          </Callout>
        </div>
      ) : null}

      {term.length < 2 && history.length ? (
        <section className="search-history" aria-label={t('搜索历史')}>
          <div className="search-history-head">
            <h2>
              <Icon name="clock" size={14} /> {t('最近搜索')}
            </h2>
            <button
              type="button"
              className="link-btn"
              onClick={() => setHistory(clearSearchHistory())}
            >
              {t('清空历史')}
            </button>
          </div>
          <div className="search-history-list">
            {history.map((entry) => (
              <span className="search-history-chip" key={entry}>
                <button
                  type="button"
                  onClick={() => {
                    setInput(entry);
                    submit(entry);
                  }}
                >
                  {entry}
                </button>
                <button
                  type="button"
                  className="search-history-remove"
                  aria-label={t('移除「{term}」', { term: entry })}
                  onClick={() => setHistory(removeSearchHistory(entry, history))}
                >
                  <Icon name="close" size={11} />
                </button>
              </span>
            ))}
          </div>
        </section>
      ) : null}

      {requestError ? (
        <div className="mt-20">
          <Callout tone="danger" icon="alert" title={t('搜索没有完成')}>
            {requestError instanceof Error ? requestError.message : t('请求失败。')}
          </Callout>
        </div>
      ) : null}

      <div className="search-results">
        {loading && active ? (
          <div className="mt-24">
            <Skeleton lines={6} />
          </div>
        ) : !active ? (
          <div className="mt-24">
            <EmptyState
              icon="search"
              title={t('输入一个词开始搜索')}
              body={t('标题、摘要与正文都会参与匹配。只覆盖已发布内容与页面。')}
            />
          </div>
        ) : items.length === 0 && pageHits.length === 0 ? (
          <div className="mt-24">
            <EmptyState
              icon="search"
              title={t('没有找到「{query}」', { query })}
              body={t('换一个更短的词，或者去掉分类、标签与时间筛选。')}
              action={
                filterCount ? (
                  <Button variant="secondary" size="sm" onClick={clearFilters}>
                    {t('清除全部筛选')}
                  </Button>
                ) : null
              }
            />
          </div>
        ) : (
          <>
            {pageHits.map((page) => (
              <article className="story" key={page.id}>
                <span className="story-index">{t('页')}</span>
                <div className="story-body">
                  <h3>
                    <Link to={`/${page.slug}`}>
                      <Highlight text={page.title} query={query} />
                    </Link>
                  </h3>
                  <p>
                    <Highlight text={page.summary ?? ''} query={query} />
                  </p>
                  <div className="story-meta">
                    <span>{t('自定义页面')}</span>
                    <span>{t('更新于 {date}', { date: formatDate(page.updated_at) })}</span>
                  </div>
                </div>
                <div className="story-side" aria-hidden>
                  <Icon name="arrow-up-right" size={16} />
                </div>
              </article>
            ))}
            {items.map((item) => (
              <article className="story" key={item.id}>
                <span className="story-index">{item.kind === 'article' ? t('文') : t('帖')}</span>
                <div className="story-body">
                  <h3>
                    <Link to={`/${item.kind === 'article' ? 'a' : 'p'}/${item.id}`}>
                      <Highlight text={item.title} query={query} />
                    </Link>
                  </h3>
                  {/* 片段由服务端给出，是纯文本；没有片段时退回摘要。 */}
                  <p>
                    <Highlight text={item.snippet ?? item.summary ?? ''} query={query} />
                  </p>
                  <div className="story-meta">
                    <span>{item.author_name ?? t('编辑部')}</span>
                    <span>{formatDate(item.published_at ?? item.created_at)}</span>
                    <span>{t('{count} 分钟', { count: readingTime(item.rendered_html) })}</span>
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

      {active && hasMore ? (
        <div className="feed-more">
          <Button variant="secondary" loading={loadingMore} onClick={() => void load(cursor)}>
            {t('加载更多')}
          </Button>
          <p className="tiny faint">
            {t('已显示 {shown} / {count} 条', { shown: items.length, count: total })}
          </p>
        </div>
      ) : active && items.length > 0 ? (
        <p className="center tiny faint" style={{ padding: '28px 0' }}>
          {t('已经到底了。共 {count} 条。', { count: total })}
        </p>
      ) : null}
    </div>
  );
}
