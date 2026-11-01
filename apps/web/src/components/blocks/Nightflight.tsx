import { Link, useNavigate } from 'react-router-dom';
import { useState, useMemo, type CSSProperties, type ReactElement } from 'react';
import type { BlockInstance, Content, TileSpan } from '../../types';
import { useAuth } from '../../lib/session';
import { useFeed, countWords } from './FeedContext';
import { readingTime, timeAgo } from '../../lib/format';
import { Avatar, EmptyState, Skeleton } from '../ui';
import { Icon } from '../Icon';
import { ContentCover } from '../Cover';
import { blockItems, blockProp } from '../../lib/blocks';
import { useTaxonomy } from '../../lib/useTaxonomy';
import { dispatchInterfaceCommand } from '../../lib/interfaceCommands';
import { useRangeAnalytics } from '../../lib/useAnalytics';
import { useCustomization, heroLines } from '../../lib/customize';
import { autoSpanForRank, normalizeTileSpan } from '../../lib/homeTiles';
import type { RangeStats } from '../../lib/analytics';
import { useT } from '../../lib/i18n';

/**
 * 夜航区块（第二套主题）。
 *
 * 版式参考 hidesg.ink：双卡首屏 → 三个大色块分类 → 封面卡双列 + 右侧粘性侧栏
 * （站点数据 / 作者 / 标签 / 归档）。
 *
 * 首屏经过两轮调整：左侧黑卡放到更大（约 3:2），彩色瓷砖装饰已经整体移除，
 * 改用可自定义的背景图 / 底色（默认纯黑）；右侧换成紧凑的热门榜单，
 * 默认 6 条、不占缩略图，整体比左边明显更小。
 * 卡片语言：12–16px 圆角、1px 描边、悬停上浮；彩色只出现在分类按钮与
 * 封面占位，正文仍然克制。样式限定在 [data-variant='bento'] 下。
 */

function contentUrl(item: Content): string {
  return `/${item.kind === 'article' ? 'a' : 'p'}/${item.id}`;
}

/** 把地址塞进 CSS url() 前先收紧：去掉引号、反斜杠与括号，避免破坏声明。 */
function cssUrl(input: string): string {
  return input.replace(/["'\\()\s]/g, '');
}

/* ---------------------------------------------------------------- 首屏 */

/** 三种左右比例；默认左宽 3:2，右边只放热门榜。 */
const HERO_RATIO_CLASS: Record<string, string> = {
  wide: 'is-wide',
  wider: 'is-wider',
  even: 'is-even',
};

/** 首屏搜索框：回车跳到搜索结果页，和头部搜索同一个落点。 */
function HeroSearch({ placeholder }: { placeholder: string }) {
  const t = useT();
  const navigate = useNavigate();
  const [keyword, setKeyword] = useState('');
  return (
    <form
      className="nf-hero-search"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        const query = keyword.trim();
        if (!query) return;
        navigate(`/search?q=${encodeURIComponent(query)}`);
        setKeyword('');
      }}
    >
      <Icon name="search" size={15} />
      <input
        value={keyword}
        onChange={(event) => setKeyword(event.target.value)}
        placeholder={placeholder}
        aria-label={t('搜索站内内容')}
      />
      <button type="submit">{t('搜索')}</button>
    </form>
  );
}

/** 热门排序：有 30 天阅读统计时按次数，否则回退到发布时间。 */
function rankPopular(all: Content[], stats: RangeStats, limit: number) {
  const counts = new Map(stats.topContent.map((entry) => [entry.id, entry.count]));
  return [...all]
    .map((item) => ({ item, views: counts.get(item.id) ?? 0 }))
    .sort((a, b) => {
      if (b.views !== a.views) return b.views - a.views;
      const aTime = a.item.published_at ?? a.item.created_at;
      const bTime = b.item.published_at ?? b.item.created_at;
      return bTime.localeCompare(aTime);
    })
    .slice(0, limit);
}

/** 首屏右卡：紧凑的热门榜单（默认纯文字，可开缩略图）。 */
function HeroPopular({ heading, limit, cover }: { heading: string; limit: number; cover: boolean }) {
  const t = useT();
  const { all, loading } = useFeed();
  const { stats } = useRangeAnalytics('30d', false);
  const rows = rankPopular(all, stats, Math.min(10, Math.max(1, limit)));

  return (
    <div className="nf-hero-right is-popular">
      {heading ? (
        <div className="nf-popular-head">
          <h2>{heading}</h2>
          <span className="nf-popular-badge">
            <Icon name="chart" size={12} />
            {t('30 天')}
          </span>
        </div>
      ) : null}

      {loading ? (
        <Skeleton lines={3} />
      ) : rows.length ? (
        <ol className="nf-popular-list">
          {rows.map(({ item, views }, index) => (
            <li key={item.id}>
              <Link to={contentUrl(item)} className="nf-popular-row">
                <span className="nf-popular-no" aria-hidden>
                  {String(index + 1).padStart(2, '0')}
                </span>
                {cover ? (
                  <span className="nf-popular-cover" aria-hidden>
                    <ContentCover id={item.id} label={item.title} ratio="1 / 1" accent />
                  </span>
                ) : null}
                <span className="nf-popular-body">
                  <strong>{item.title}</strong>
                  <span className="nf-popular-meta">
                    <span className="nf-kind">
                      {item.kind === 'article' ? t('文章') : t('帖子')}
                    </span>
                    <span className="dot" aria-hidden />
                    <Icon name="eye" size={11} />
                    {views > 0
                      ? t('{count} 次阅读', { count: views })
                      : t('{count} 分钟', { count: readingTime(item.rendered_html) })}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      ) : (
        <p className="nf-popular-empty">
          {t('还没有已发布内容，热门榜会在有阅读记录后出现。')}
        </p>
      )}

      <Link to="/articles" className="nf-popular-more">
        {t('全部文章')} <Icon name="arrow-right" size={13} />
      </Link>
    </div>
  );
}

function HeroCards({ block }: { block: BlockInstance }) {
  const t = useT();
  const { site } = useAuth();
  const { all } = useFeed();
  const { customization } = useCustomization();
  const hero = customization.layout.hero;
  // 区块自己的标题优先；留空时读「外观 → 首页首屏」，让外观设置对夜航同样生效。
  const title =
    blockProp(block, 'title', '').trim() || hero.title.trim() || site?.name || 'Practacu Press';
  const kicker = hero.kicker.trim();
  const lede = hero.lede.trim();
  const welcome = blockProp(block, 'welcome', 'hello').trim() || 'hello';
  const eyebrow = blockProp(block, 'eyebrow', '我们的团队').trim();
  const name = blockProp(block, 'name', '').trim() || site?.name || 'Practacu Press';
  const cta = blockProp(block, 'cta', '更多推荐').trim();
  const showDomain = blockProp(block, 'show_domain', true);
  const showSearch = blockProp(block, 'show_search', true);
  const placeholder = blockProp(block, 'search_placeholder', '').trim() || t('搜索文章');
  const rightMode = blockProp<string>(block, 'right_mode', 'popular');
  const popularHeading = blockProp(block, 'popular_heading', '热门文章').trim();
  const popularLimit = blockProp(block, 'popular_limit', 6);
  const popularCover = blockProp(block, 'popular_cover', false);
  const ratio = blockProp<string>(block, 'hero_ratio', 'wide');
  const bgColor = blockProp<string>(block, 'bg_color', '#000000').trim() || '#000000';
  const bgImage = cssUrl(blockProp(block, 'bg_image', '').trim());
  const bgDim = Math.min(90, Math.max(0, Number(blockProp(block, 'bg_dim', 55)) || 0));
  const domain = site?.domain || (typeof window === 'undefined' ? '' : window.location.host);
  const lines = heroLines(title).slice(0, 2);

  // 没有背景图时就是一块纯色（默认黑），有图时叠一层可调的黑色遮罩保证白字可读。
  const heroStyle: CSSProperties = { backgroundColor: bgColor };
  if (bgImage) {
    heroStyle.backgroundImage = `linear-gradient(0deg, rgb(0 0 0 / ${bgDim}%), rgb(0 0 0 / ${bgDim}%)), url("${bgImage}")`;
    heroStyle.backgroundSize = 'cover';
    heroStyle.backgroundPosition = 'center';
    heroStyle.backgroundRepeat = 'no-repeat';
  }

  return (
    <section className={`nf-hero ${HERO_RATIO_CLASS[ratio] ?? 'is-wide'}`}>
      <div className="nf-hero-left" style={heroStyle}>
        <div className="nf-hero-head">
          {kicker ? <p className="nf-hero-kicker">{kicker}</p> : null}
          <h1>
            {lines.map((line, index) => (
              <span key={index}>
                {index > 0 ? <br /> : null}
                {line.map((segment, i) =>
                  segment.em ? <em key={i}>{segment.text}</em> : <span key={i}>{segment.text}</span>,
                )}
              </span>
            ))}
          </h1>
          {lede ? <p className="nf-hero-lede">{lede}</p> : null}
          {showDomain && domain ? <p className="nf-hero-domain">{domain}</p> : null}
        </div>
        {showSearch ? <HeroSearch placeholder={placeholder} /> : null}
      </div>

      {rightMode === 'hello' ? (
        <div className="nf-hero-right">
          <p className="nf-hello" aria-hidden>
            {welcome}
          </p>
          <div className="nf-hero-foot">
            <div className="nf-hero-id">
              {eyebrow ? <span>{eyebrow}</span> : null}
              <strong>{name}</strong>
            </div>
            {cta ? (
              <Link to={all[0] ? contentUrl(all[0]) : '/articles'} className="nf-hero-pill">
                <Icon name="sparkle" size={13} />
                {cta}
              </Link>
            ) : null}
          </div>
        </div>
      ) : (
        <HeroPopular heading={popularHeading} limit={popularLimit} cover={popularCover} />
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- 分类 */

function CategoryPills({ block }: { block: BlockInstance }) {
  const t = useT();
  const { taxonomy } = useTaxonomy();
  const categories = taxonomy.categories;
  const source = blockProp<string>(block, 'source', 'manual');
  const manual = blockItems(block, 'items');
  const bySlug = new Map<string, (typeof categories)[number]>();
  for (const category of categories) {
    bySlug.set(category.slug, category);
    bySlug.set(category.id, category);
  }

  const items =
    source === 'auto'
      ? categories.map((category) => ({
          label: category.name,
          color: category.color || '#5b8cff',
          link: '/articles',
        }))
      : manual.map((item) => {
          const category = bySlug.get(item.category || '');
          return {
            label: item.label || category?.name || '',
            color: item.color || category?.color || '#5b8cff',
            link: item.link || '/articles',
          };
        });

  if (!items.length) {
    return (
      <div className="nf-cats">
        <p className="block-empty-hint">
          {t('还没有分类。可以在属性里切到「自动读取分类」，或手动添加胶囊。')}
        </p>
      </div>
    );
  }
  return (
    <nav className="nf-cats" aria-label={t('分类')}>
      {items.slice(0, 4).map((item, index) => {
        const color = item.color || '#5b8cff';
        const label = item.label || t('分类 {count}', { count: index + 1 });
        const style = { '--cat': color } as CSSProperties;
        const body = (
          <>
            <span className="nf-cat-ghost" aria-hidden>
              {label.slice(0, 1)}
            </span>
            <span className="nf-cat-label">{label}</span>
            <span className="nf-cat-dot" aria-hidden />
          </>
        );
        return item.link ? (
          <Link key={index} to={item.link} className="nf-cat" style={style}>
            {body}
          </Link>
        ) : (
          <span key={index} className="nf-cat" style={style}>
            {body}
          </span>
        );
      })}
    </nav>
  );
}

/* ---------------------------------------------------------------- 精选 */

function FeaturePost({ block }: { block: BlockInstance }) {
  const t = useT();
  const { all, loading } = useFeed();
  const showSummary = blockProp(block, 'show_summary', true);
  const feature = all[0];
  if (loading) return <Skeleton lines={4} />;
  if (!feature) {
    return (
      <EmptyState
        compact
        icon="file"
        title={t('还没有精选')}
        body={t('发布第一篇文章，这里会把它放在聚光灯下。')}
      />
    );
  }
  return (
    <article className="nf-feature nf-card">
      <Link to={contentUrl(feature)} className="nf-feature-cover" aria-label={feature.title}>
        <ContentCover id={feature.id} label={feature.title} ratio="21 / 9" accent />
      </Link>
      <div className="nf-feature-body">
        <div className="nf-meta">
          <span className="nf-kind">
            {feature.kind === 'article' ? t('文章') : t('帖子')}
          </span>
          <span>{timeAgo(feature.published_at ?? feature.created_at)}</span>
          <span className="dot" aria-hidden />
          <span>{t('{count} 分钟', { count: readingTime(feature.rendered_html) })}</span>
        </div>
        <h2>
          <Link to={contentUrl(feature)}>{feature.title}</Link>
        </h2>
        {showSummary && feature.summary ? <p>{feature.summary}</p> : null}
      </div>
    </article>
  );
}

/* ---------------------------------------------------------------- 列表 */

function SectionHeading({ title, count, to }: { title: string; count?: number; to?: string }) {
  const t = useT();
  if (!title) return null;
  return (
    <div className="nf-heading">
      <i aria-hidden />
      <h2>{title}</h2>
      {typeof count === 'number' ? <span className="nf-heading-count">{count}</span> : null}
      {to ? (
        <Link to={to} className="nf-heading-more">
          {t('全部')} <Icon name="arrow-right" size={13} />
        </Link>
      ) : null}
    </div>
  );
}

/** 所有文章最下面的「查看更多」：统一样式，列表与网格共用。 */
function MoreLink({ label }: { label: string }) {
  return (
    <div className="nf-more-row">
      <Link to="/articles" className="nf-more-link">
        {label}
        <Icon name="arrow-right" size={14} />
      </Link>
    </div>
  );
}

function PostList({ block }: { block: BlockInstance }) {
  const t = useT();
  const { all, loading } = useFeed();
  const heading = blockProp(block, 'heading', '最新文章').trim();
  const limit = blockProp(block, 'limit', 18);
  const showSummary = blockProp(block, 'show_summary', true);
  const showMeta = blockProp(block, 'show_meta', true);
  const showNumber = blockProp(block, 'show_number', true);
  const showMore = blockProp(block, 'show_more', true);
  const moreLabel = blockProp(block, 'more_label', '查看更多').trim() || t('查看更多');
  const items = all.slice(0, Math.min(30, Math.max(1, limit)));

  if (loading) {
    return (
      <div className="nf-list">
        <Skeleton lines={3} />
        <Skeleton lines={3} />
      </div>
    );
  }
  if (!items.length) {
    return (
      <EmptyState
        compact
        icon="file"
        title={t('还没有文章')}
        body={t('发布内容后，这里会出现文章卡片。')}
      />
    );
  }
  return (
    <section className="nf-list-wrap">
      <SectionHeading title={heading} count={items.length} to="/articles" />
      <div className="nf-list">
        {items.map((item, index) => (
          <article className="nf-row nf-card" key={item.id}>
            {showNumber ? (
              <span className="nf-row-index" aria-hidden>
                {String(index + 1).padStart(2, '0')}
              </span>
            ) : null}
            <Link to={contentUrl(item)} className="nf-row-cover" aria-label={item.title} tabIndex={-1}>
              <ContentCover id={item.id} label={item.title} ratio="4 / 3" accent />
            </Link>
            <div className="nf-row-body">
              <div className="nf-meta">
                <span className="nf-kind">{item.kind === 'article' ? t('文章') : t('帖子')}</span>
                {showMeta ? <span>{timeAgo(item.published_at ?? item.created_at)}</span> : null}
              </div>
              <h3>
                <Link to={contentUrl(item)}>{item.title}</Link>
              </h3>
              {showSummary && item.summary ? <p>{item.summary}</p> : null}
            </div>
            <span className="nf-row-arrow" aria-hidden>
              <Icon name="arrow-right" size={15} />
            </span>
          </article>
        ))}
      </div>
      {showMore ? <MoreLink label={moreLabel} /> : null}
    </section>
  );
}

/* ---------------------------------------------------------------- 网格 */

function PostGrid({ block }: { block: BlockInstance }) {
  const t = useT();
  const { all, loading } = useFeed();
  const [tab, setTab] = useState<'all' | 'article' | 'post'>('all');
  const tabs: { key: 'all' | 'article' | 'post'; label: string }[] = [
    { key: 'all', label: t('全部') },
    { key: 'article', label: t('文章') },
    { key: 'post', label: t('帖子') },
  ];
  const heading = blockProp(block, 'heading', '最新文章').trim();
  const showTabs = blockProp(block, 'tabs', true);
  const limit = blockProp(block, 'limit', 18);
  const showSummary = blockProp(block, 'show_summary', true);
  const showMeta = blockProp(block, 'show_meta', true);
  const showMore = blockProp(block, 'show_more', true);
  const moreLabel = blockProp(block, 'more_label', '查看更多').trim() || t('查看更多');
  const pool = tab === 'all' ? all : all.filter((item) => item.kind === tab);
  const items = pool.slice(0, Math.min(30, Math.max(1, limit)));

  const bar =
    heading || showTabs ? (
      <div className="nf-bar">
        <span className="nf-bar-chip">{t('{count} 篇', { count: all.length })}</span>
        {showTabs ? (
          <div className="nf-bar-tabs" role="tablist" aria-label={t('内容类型')}>
            {tabs.map((item) => (
              <button
                key={item.key}
                type="button"
                role="tab"
                aria-selected={tab === item.key}
                className={tab === item.key ? 'is-on' : ''}
                onClick={() => setTab(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
        ) : (
          <h2 className="nf-bar-title">{heading}</h2>
        )}
        {showMore ? null : (
          <Link to="/articles" className="nf-bar-more">
            {t('更多')} <Icon name="arrow-right" size={13} />
          </Link>
        )}
      </div>
    ) : null;

  if (loading) {
    return (
      <div className="nf-grid-wrap">
        {bar}
        <div className="nf-grid">
          <Skeleton lines={4} />
          <Skeleton lines={4} />
        </div>
      </div>
    );
  }
  if (!items.length) {
    return (
      <div className="nf-grid-wrap">
        {bar}
        <EmptyState
          compact
          icon="file"
          title={t('还没有内容')}
          body={t('发布内容后，这里会出现封面卡。')}
        />
      </div>
    );
  }
  return (
    <div className="nf-grid-wrap">
      {bar}
      <div className="nf-grid">
        {items.map((item) => (
          <article className="nf-card nf-tile" key={item.id}>
            <Link to={contentUrl(item)} className="nf-tile-cover" aria-label={item.title} tabIndex={-1}>
              <ContentCover id={item.id} label={item.title} ratio="16 / 10" accent />
            </Link>
            <div className="nf-tile-body">
              <div className="nf-tile-tags">
                <span className="nf-chip-kind">
                  {item.kind === 'article' ? t('文章') : t('帖子')}
                </span>
                <span>{t('{count} 分钟阅读', { count: readingTime(item.rendered_html) })}</span>
              </div>
              <h3>
                <Link to={contentUrl(item)}>{item.title}</Link>
              </h3>
              {showSummary && item.summary ? <p>{item.summary}</p> : null}
              {showMeta ? (
                <div className="nf-tile-meta">{timeAgo(item.published_at ?? item.created_at)}</div>
              ) : null}
            </div>
          </article>
        ))}
      </div>
      {showMore ? <MoreLink label={moreLabel} /> : null}
    </div>
  );
}

/* ---------------------------------------------------------------- 精选网格 */

/**
 * 置顶 / 热门文章的封面网格。
 *
 * - `pinned`：读 `customization.pins`（内容库里勾「首页精选」的文章），逐篇的占格由站长选；
 * - `popular`：按 30 天阅读量排序，名次决定占格（第一篇 2×2，依次变小），完全自适应；
 * 两种情况都只画已发布内容，找不到的 id 直接跳过，没有可画的内容就整块不渲染。
 * 格子越大显示的信息越多：1×1 只有标题，2×1 加类型与阅读量，2×2 再加摘要。
 */
function Spotlight({ block }: { block: BlockInstance }) {
  const t = useT();
  const { all, loading } = useFeed();
  const { stats } = useRangeAnalytics('30d', false);
  const { customization } = useCustomization();
  const source = blockProp<string>(block, 'source', 'pinned');
  const heading = blockProp(block, 'heading', '置顶文章').trim();
  const limit = Math.min(12, Math.max(1, Number(blockProp(block, 'limit', 7)) || 7));
  const showCover = blockProp(block, 'show_cover', true);
  const showMeta = blockProp(block, 'show_meta', true);
  const showSummary = blockProp(block, 'show_summary', true);

  const rows = useMemo(() => {
    const counts = new Map(stats.topContent.map((entry) => [entry.id, entry.count]));
    if (source === 'popular') {
      return rankPopular(all, stats, limit).map((row, index) => ({
        item: row.item,
        views: row.views,
        span: autoSpanForRank(index),
      }));
    }
    const byId = new Map(all.map((item) => [item.id, item]));
    const out: { item: Content; views: number; span: TileSpan }[] = [];
    for (const pin of customization.pins) {
      if (out.length >= limit) break;
      const item = byId.get(pin.id);
      if (!item) continue;
      out.push({ item, views: counts.get(item.id) ?? 0, span: normalizeTileSpan(pin.span) });
    }
    return out;
  }, [source, all, stats, customization.pins, limit]);

  if (loading) return <Skeleton lines={3} />;
  if (!rows.length) return <></>;

  return (
    <section className="nf-spot-wrap">
      {heading ? (
        <div className="nf-heading">
          <i aria-hidden />
          <h2>{heading}</h2>
          <span className="nf-heading-count">{rows.length}</span>
          <Link to="/articles" className="nf-heading-more">
            {t('全部')} <Icon name="arrow-right" size={13} />
          </Link>
        </div>
      ) : null}
      <div className="nf-spot">
        {rows.map(({ item, views, span }) => (
          <Link
            key={item.id}
            to={contentUrl(item)}
            className={`nf-spot-tile span-${span}${showCover ? ' has-cover' : ''}`}
          >
            {showCover ? (
              <span className="nf-spot-cover" aria-hidden>
                <ContentCover id={item.id} label={item.title} accent />
              </span>
            ) : null}
            {showCover ? <span className="nf-spot-scrim" aria-hidden /> : null}
            <span className="nf-spot-body">
              {showMeta ? (
                <span className="nf-spot-kicker">
                  <em>{item.kind === 'article' ? t('文章') : t('帖子')}</em>
                  <span className="dot" aria-hidden />
                  <Icon name="eye" size={10} />
                  {views > 0
                    ? t('{count} 次', { count: views })
                    : t('{count} 分钟', { count: readingTime(item.rendered_html) })}
                </span>
              ) : null}
              <strong>{item.title}</strong>
              {showSummary && item.summary ? <em className="nf-spot-summary">{item.summary}</em> : null}
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

/* ---------------------------------------------------------------- 侧栏 */

function AuthorCard({ block }: { block: BlockInstance }) {
  const t = useT();
  const { site, me } = useAuth();
  const name = blockProp(block, 'name', '').trim() || site?.name || t('编辑部');
  const bio =
    blockProp(block, 'bio', '').trim() ||
    site?.description ||
    t('写作者拥有自己的稿子，读者被当作邻居。');
  const links = blockItems(block, 'links').filter((item) => item.link);
  return (
    <aside className="nf-widget nf-author">
      <p className="nf-author-hi">{t('欢迎光临')}</p>
      <Avatar name={me?.user.display_name ?? name} size={58} />
      <strong>{name}</strong>
      <p>{bio}</p>
      {links.length ? (
        <div className="nf-author-links">
          {links.map((item, index) => (
            <a key={index} href={item.link} target="_blank" rel="noreferrer" aria-label={item.label}>
              <Icon name={/rss/i.test(item.label ?? '') ? 'globe' : 'mail'} size={14} />
              {item.label || item.link}
            </a>
          ))}
        </div>
      ) : null}
    </aside>
  );
}

function TagCloud({ block }: { block: BlockInstance }) {
  const t = useT();
  const items = blockItems(block, 'items');
  if (!items.length) {
    return <p className="block-empty-hint">{t('还没有标签。在「页面编排 → 编排」里添加。')}</p>;
  }
  const max = Math.max(...items.map((item) => Number(item.weight) || 1), 1);
  return (
    <section className="nf-widget">
      <h3 className="nf-widget-title">{t('标签')}</h3>
      <div className="nf-tags">
        {items.map((item, index) => {
          const weight = Math.min(max, Math.max(1, Number(item.weight) || 1));
          const label = item.label || t('标签 {count}', { count: index + 1 });
          const body = (
            <>
              #{label}
              {weight > 1 ? <sup>{weight}</sup> : null}
            </>
          );
          return item.link ? (
            <Link key={index} to={item.link} className="nf-tag">
              {body}
            </Link>
          ) : (
            <span key={index} className="nf-tag">
              {body}
            </span>
          );
        })}
      </div>
    </section>
  );
}

function StatList({ block }: { block: BlockInstance }) {
  const t = useT();
  const { config } = useAuth();
  const { all, loading } = useFeed();
  const showCount = blockProp(block, 'show_count', true);
  const showDays = blockProp(block, 'show_days', true);
  const showWords = blockProp(block, 'show_words', true);
  const words = all.reduce((sum, item) => sum + countWords(item.rendered_html), 0);
  const createdAt = config?.created_at ? new Date(config.created_at).getTime() : Date.now();
  const days = Math.max(1, Math.round((Date.now() - createdAt) / 86_400_000));

  const rows: { icon: 'file' | 'clock' | 'code'; label: string; value: string }[] = [];
  if (showCount) rows.push({ icon: 'file', label: t('文章总数'), value: String(all.length) });
  if (showDays)
    rows.push({ icon: 'clock', label: t('建站天数'), value: t('{count} 天', { count: days }) });
  if (showWords)
    rows.push({
      icon: 'code',
      label: t('全站字数'),
      value: words > 999 ? `${(words / 1000).toFixed(1)}k` : String(words),
    });

  if (loading) return <Skeleton lines={3} />;
  if (!rows.length) return <></>;
  return (
    <section className="nf-widget">
      <div className="nf-metrics">
        {rows.map((row) => (
          <div key={row.label}>
            <Icon name={row.icon} size={14} />
            <em>{row.label}</em>
            <b>{row.value}</b>
          </div>
        ))}
      </div>
    </section>
  );
}

function Archive({ block }: { block: BlockInstance }) {
  const t = useT();
  const { all, loading } = useFeed();
  const heading = blockProp(block, 'heading', '归档').trim();
  const limit = blockProp(block, 'limit', 3);
  const buckets = new Map<string, number>();
  for (const item of all) {
    const d = new Date(item.published_at ?? item.created_at);
    if (Number.isNaN(d.getTime())) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  const rows = [...buckets.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, limit);
  if (loading) return <Skeleton lines={3} />;
  if (!rows.length) {
    return <p className="block-empty-hint">{t('还没有已发布内容，归档会自动按月份统计。')}</p>;
  }
  return (
    <section className="nf-widget">
      {heading ? <h3 className="nf-widget-title">{heading}</h3> : null}
      <div className="nf-archive">
        {rows.map(([key, count]) => {
          const [year, month] = key.split('-');
          return (
            <div key={key}>
              <span>{t('{month} 月 {year}', { month: Number(month), year })}</span>
              <b>{t('{count} 篇', { count })}</b>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function QuoteCard({ block }: { block: BlockInstance }) {
  const quote = blockProp(block, 'quote', '').trim();
  const source = blockProp(block, 'source', '').trim();
  if (!quote) return <></>;
  return (
    <blockquote className="nf-quote">
      <p>{quote}</p>
      {source ? <footer>— {source}</footer> : null}
    </blockquote>
  );
}

function Timeline({ block }: { block: BlockInstance }) {
  const t = useT();
  const items = blockItems(block, 'items');
  if (!items.length) {
    return <p className="block-empty-hint">{t('还没有节点。在「页面编排 → 编排」里添加。')}</p>;
  }
  return (
    <ol className="nf-widget nf-timeline">
      {items.map((item, index) => (
        <li key={index}>
          <span className="nf-timeline-year">{item.year || '·'}</span>
          <span className="nf-timeline-text">{item.text || ''}</span>
        </li>
      ))}
    </ol>
  );
}

function SearchLauncher({ block }: { block: BlockInstance }) {
  const t = useT();
  const label = blockProp(block, 'label', '搜索文章').trim();
  const hint = blockProp(block, 'hint', '').trim();
  return (
    <button type="button" className="nf-search" onClick={() => dispatchInterfaceCommand('search')}>
      <Icon name="search" size={16} />
      <span>
        <strong>{label || t('搜索文章')}</strong>
        {hint ? <em>{hint}</em> : null}
      </span>
      <kbd>Shift</kbd>
      <kbd>S</kbd>
    </button>
  );
}

function CommandHints() {
  const t = useT();
  const hints: { keys: string[]; label: string }[] = [
    { keys: ['Shift', 'K'], label: t('命令面板') },
    { keys: ['Shift', 'S'], label: t('搜索') },
    { keys: ['Shift', 'D'], label: t('深浅切换') },
    { keys: ['Shift', 'H'], label: t('回首页') },
  ];
  return (
    <section className="nf-widget">
      <h3 className="nf-widget-title">
        <Icon name="command" size={13} /> {t('快捷键')}
      </h3>
      <div className="nf-hints">
        {hints.map((hint) => (
          <span className="nf-hint" key={hint.label}>
            <span>{hint.label}</span>
            <span className="nf-hint-keys">
              {hint.keys.map((key) => (
                <kbd key={key}>{key}</kbd>
              ))}
            </span>
          </span>
        ))}
      </div>
    </section>
  );
}

export const NIGHT_RENDERERS: Record<string, (props: { block: BlockInstance }) => ReactElement> = {
  'bento-hero': HeroCards,
  'category-pills': CategoryPills,
  'feature-post': FeaturePost,
  'post-list': PostList,
  'post-grid': PostGrid,
  spotlight: Spotlight,
  'spotlight-hot': Spotlight,
  'author-card': AuthorCard,
  'tag-cloud': TagCloud,
  'stat-list': StatList,
  archive: Archive,
  'quote-card': QuoteCard,
  timeline: Timeline,
  'search-launcher': SearchLauncher,
  'command-hints': CommandHints,
};
