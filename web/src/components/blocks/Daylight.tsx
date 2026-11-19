import { Link } from 'react-router-dom';
import type { ReactElement } from 'react';
import type { BlockInstance, Content } from '../../types';
import { useAuth } from '../../lib/session';
import { useFeed } from './FeedContext';
import { useTaxonomy } from '../../lib/useTaxonomy';
import { useCustomization, heroLines } from '../../lib/customize';
import { blockProp } from '../../lib/blocks';
import { formatDate, readingTime, timeAgo } from '../../lib/format';
import { EmptyState, Skeleton } from '../ui';
import { ContentCover } from '../Cover';
import { useT } from '../../lib/i18n';

/**
 * 白昼（daylight）的专用区块。
 *
 * 这套渲染器只服务白昼，类名统一用 `dl-`，不借用夜航的 `nf-` 组件与样式。
 * 首页是「日报头版」而不是双卡 bento：分栏头版、栏目导轨、三列故事、双列文字简报。
 * 文章页不使用这里的组件，文章页的差异由 daylightTheme.css 单独完成。
 */

function contentUrl(item: Content): string {
  return `/${item.kind === 'article' ? 'a' : 'p'}/${item.id}`;
}

/** 把内容流按 offset/limit 切一段，越界时返回空数组而不是报错。 */
function sliceFeed(all: Content[], offset: number, limit: number): Content[] {
  const start = Math.max(0, offset);
  return all.slice(start, start + Math.max(1, limit));
}

function DaylightFront({ block }: { block: BlockInstance }) {
  const t = useT();
  const { site } = useAuth();
  const { all, loading } = useFeed();
  const { customization } = useCustomization();
  const hero = customization.layout.hero;
  const title = blockProp(block, 'title', '').trim() || hero.title.trim() || site?.name || 'Practacu Press';
  const kicker =
    blockProp(block, 'kicker', '').trim() ||
    hero.kicker.trim() ||
    t('{name} · 今日刊', { name: site?.name ?? 'Practacu Press' });
  const lede =
    blockProp(block, 'lede', '').trim() ||
    hero.lede.trim() ||
    site?.description ||
    t('一间小而安静的编辑部。写作者拥有自己的稿子，读者被当作邻居。');
  const primary = blockProp(block, 'cta', '').trim() || t('开始阅读');
  const secondary = blockProp(block, 'secondary', '').trim() || t('全部文章');
  const feature = all[0];
  const lines = heroLines(title);

  return (
    <section className="dl-front">
      <div className="dl-front-copy">
        <p className="dl-kicker">{kicker}</p>
        <h1>
          {lines.map((line, lineIndex) => (
            <span key={lineIndex}>
              {lineIndex > 0 ? <br /> : null}
              {line.map((segment, index) =>
                segment.em ? <em key={index}>{segment.text}</em> : <span key={index}>{segment.text}</span>,
              )}
            </span>
          ))}
        </h1>
        <p className="dl-lede">{lede}</p>
        <div className="dl-front-actions">
          <Link to={feature ? contentUrl(feature) : '/articles'} className="btn btn-primary btn-lg">
            {primary}
          </Link>
          <Link to="/articles" className="btn btn-ghost btn-lg">
            {secondary}
          </Link>
        </div>
        <div className="dl-front-meta">
          <span>{t('独立出版')}</span>
          <span>{t('本页收录 {count} 篇', { count: all.length })}</span>
          {feature ? <span>{t('更新于 {date}', { date: formatDate(feature.published_at ?? feature.created_at) })}</span> : null}
        </div>
      </div>

      {loading ? (
        <div className="dl-front-feature is-loading">
          <Skeleton lines={6} />
        </div>
      ) : feature ? (
        <Link to={contentUrl(feature)} className="dl-front-feature" aria-label={feature.title}>
          <div className="dl-front-cover">
            <ContentCover id={feature.id} label={feature.title} ratio="4 / 5" accent />
          </div>
          <div className="dl-front-feature-copy">
            <span className="dl-kind">
              {t('封面故事')} · {feature.kind === 'article' ? t('文章') : t('帖子')}
            </span>
            <h2>{feature.title}</h2>
            {feature.summary ? <p>{feature.summary}</p> : null}
            <div className="dl-meta">
              {feature.author_name ? <span>{feature.author_name}</span> : null}
              <span>{t('{count} 分钟阅读', { count: readingTime(feature.rendered_html) })}</span>
            </div>
          </div>
        </Link>
      ) : (
        <div className="dl-front-feature is-empty">
          <EmptyState
            compact
            icon="file"
            title={t('还没有封面故事')}
            body={t('发布第一篇文章后，这里会出现白昼的头版封面。')}
          />
        </div>
      )}
    </section>
  );
}

function DaylightTopics({ block }: { block: BlockInstance }) {
  const t = useT();
  const { taxonomy } = useTaxonomy();
  const { all } = useFeed();
  const heading = blockProp(block, 'heading', '栏目').trim() || t('栏目');
  const limit = Math.min(12, Math.max(1, Number(blockProp(block, 'limit', 6)) || 6));
  const counts = new Map<string, number>();
  for (const item of all) {
    if (!item.category_id) continue;
    counts.set(item.category_id, (counts.get(item.category_id) ?? 0) + 1);
  }
  const items = taxonomy.categories.slice(0, limit);
  if (!items.length) return <></>;

  return (
    <nav className="dl-topics" aria-label={t('栏目')}>
      <span className="dl-topics-label">{heading}</span>
      <div className="dl-topics-list">
        {items.map((term) => (
          <Link key={term.id} to={`/category/${encodeURIComponent(term.slug)}`} className="dl-topic">
            <span className="dl-topic-name">{term.name}</span>
            <span className="dl-topic-count">{counts.get(term.id) ?? 0}</span>
          </Link>
        ))}
      </div>
      <Link to="/categories" className="dl-topics-more">
        {t('全部栏目')} <span aria-hidden>→</span>
      </Link>
    </nav>
  );
}

function DaylightStories({ block }: { block: BlockInstance }) {
  const t = useT();
  const { all, loading } = useFeed();
  const heading = blockProp(block, 'heading', '最新文章').trim() || t('最新文章');
  const offsetValue = Number(blockProp(block, 'offset', 1));
  const offset = Number.isFinite(offsetValue) ? Math.max(0, Math.round(offsetValue)) : 1;
  const limit = Math.min(12, Math.max(3, Number(blockProp(block, 'limit', 6)) || 6));
  const showSummary = blockProp(block, 'show_summary', true);
  const showMeta = blockProp(block, 'show_meta', true);
  const items = sliceFeed(all, offset, limit);

  return (
    <section className="dl-stories">
      <div className="dl-section-head">
        <div>
          <span className="dl-section-kicker">{t('最新')}</span>
          <h2>{heading}</h2>
        </div>
        <Link to="/articles" className="dl-section-more">
          {t('全部文章')} <span aria-hidden>→</span>
        </Link>
      </div>

      {loading ? (
        <div className="dl-story-grid">
          <Skeleton lines={4} />
          <Skeleton lines={4} />
          <Skeleton lines={4} />
        </div>
      ) : items.length ? (
        <div className="dl-story-grid">
          {items.map((item) => (
            <article className="dl-story" key={item.id}>
              <Link to={contentUrl(item)} className="dl-story-cover" aria-label={item.title} tabIndex={-1}>
                <ContentCover id={item.id} label={item.title} ratio="4 / 3" accent />
              </Link>
              <div className="dl-story-body">
                <span className="dl-kind">{item.kind === 'article' ? t('文章') : t('帖子')}</span>
                <h3>
                  <Link to={contentUrl(item)}>{item.title}</Link>
                </h3>
                {showSummary && item.summary ? <p>{item.summary}</p> : null}
                {showMeta ? (
                  <div className="dl-meta">
                    <span>{timeAgo(item.published_at ?? item.created_at)}</span>
                    <span>{t('{count} 分钟阅读', { count: readingTime(item.rendered_html) })}</span>
                  </div>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          compact
          icon="file"
          title={t('还没有文章')}
          body={t('写下第一篇，白昼的首页就会开始有内容。')}
        />
      )}
    </section>
  );
}

function DaylightBriefs({ block }: { block: BlockInstance }) {
  const t = useT();
  const { all, loading } = useFeed();
  const heading = blockProp(block, 'heading', '继续阅读').trim() || t('继续阅读');
  const offsetValue = Number(blockProp(block, 'offset', 7));
  const offset = Number.isFinite(offsetValue) ? Math.max(0, Math.round(offsetValue)) : 7;
  const limit = Math.min(12, Math.max(2, Number(blockProp(block, 'limit', 4)) || 4));
  const showSummary = blockProp(block, 'show_summary', true);
  const items = sliceFeed(all, offset, limit);

  if (!loading && !items.length) return <></>;

  return (
    <section className="dl-briefs">
      <div className="dl-section-head">
        <div>
          <span className="dl-section-kicker">{t('继续')}</span>
          <h2>{heading}</h2>
        </div>
        <Link to="/articles" className="dl-section-more">
          {t('更多文章')} <span aria-hidden>→</span>
        </Link>
      </div>
      {loading ? (
        <Skeleton lines={4} />
      ) : (
        <div className="dl-brief-grid">
          {items.map((item) => (
            <Link to={contentUrl(item)} className="dl-brief" key={item.id}>
              <div className="dl-brief-head">
                <span className="dl-kind">{item.kind === 'article' ? t('文章') : t('帖子')}</span>
                <span className="dl-meta">{formatDate(item.published_at ?? item.created_at)}</span>
              </div>
              <h3>{item.title}</h3>
              {showSummary && item.summary ? <p>{item.summary}</p> : null}
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}

export const DAYLIGHT_RENDERERS: Record<string, (props: { block: BlockInstance }) => ReactElement> = {
  'daylight-front': DaylightFront,
  'daylight-topics': DaylightTopics,
  'daylight-stories': DaylightStories,
  'daylight-briefs': DaylightBriefs,
};
