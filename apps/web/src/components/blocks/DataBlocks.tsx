import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { BlockInstance, Content } from '../../types';
import { blockItems, blockProp } from '../../lib/blocks';
import { excerpt, formatDate, readingTime } from '../../lib/format';
import { useRangeAnalytics } from '../../lib/useAnalytics';
import { useT } from '../../lib/i18n';
import { ContentCover } from '../Cover';
import { useFeed } from './FeedContext';

/**
 * 数据类区块：统计卡、图表、列表和文章组件。
 *
 * 图表/统计既支持用户手填数据，也支持“本机访问统计”。公开页面没有管理员
 * 统计接口，因此 local 模式只使用本机访问记录，并在没有数据时显示空态，
 * 不伪造服务端数字。
 */

function Grid({ columns, children }: { columns: number; children: ReactNode }) {
  return (
    <div className="pp-data-grid" style={{ '--pp-data-columns': columns } as CSSProperties}>
      {children}
    </div>
  );
}

function StatsBlock({ block }: { block: BlockInstance }) {
  const t = useT();
  const title = blockProp(block, 'title', '');
  const columns = Math.min(4, Math.max(2, Number(blockProp(block, 'columns', 3))));
  const items = blockItems(block, 'items');
  return (
    <section className="pp-data-block">
      {title ? <h2 className="pp-data-title">{title}</h2> : null}
      {items.length ? (
        <Grid columns={columns}>
          {items.map((item, index) => (
            <div className="pp-stat-card" key={index}>
              <strong style={{ color: item.color || 'var(--accent)' }}>
                {item.value || '—'}
                <span>{item.suffix || ''}</span>
              </strong>
              <span>{item.label || t('指标')}</span>
            </div>
          ))}
        </Grid>
      ) : (
        <div className="pp-media-empty">{t('在右侧添加指标后显示。')}</div>
      )}
    </section>
  );
}

function ChartSvg({
  points,
  kind,
}: {
  points: { label: string; value: number; color: string }[];
  kind: string;
}) {
  const t = useT();
  const max = Math.max(...points.map((point) => point.value), 1);
  const width = 640;
  const height = 240;
  const gap = 14;
  const barWidth = Math.max(6, (width - gap * (points.length + 1)) / Math.max(points.length, 1));

  if (kind === 'donut') {
    const total = points.reduce((sum, point) => sum + point.value, 0) || 1;
    let offset = 0;
    const radius = 74;
    const circumference = 2 * Math.PI * radius;
    return (
      <svg className="pp-chart-svg" viewBox="0 0 320 220" role="img" aria-label={t('环形图')}>
        {points.map((point, index) => {
          const length = (point.value / total) * circumference;
          const circle = (
            <circle
              key={index}
              cx="110"
              cy="110"
              r={radius}
              fill="none"
              stroke={point.color || 'var(--accent)'}
              strokeWidth="28"
              strokeDasharray={`${length} ${circumference - length}`}
              strokeDashoffset={-offset}
              transform="rotate(-90 110 110)"
            />
          );
          offset += length;
          return circle;
        })}
        {points.map((point, index) => (
          <g key={`legend-${index}`} transform={`translate(220 ${52 + index * 20})`}>
            <rect width="8" height="8" rx="2" fill={point.color || 'var(--accent)'} />
            <text x="14" y="8" className="pp-chart-label">{point.label}</text>
          </g>
        ))}
      </svg>
    );
  }

  if (kind === 'line') {
    const step = points.length > 1 ? (width - 40) / (points.length - 1) : 0;
    const coords = points.map((point, index) => {
      const x = 20 + index * step;
      const y = height - 20 - (point.value / max) * (height - 40);
      return { ...point, x, y };
    });
    const path = coords.map((point) => `${point.x},${point.y}`).join(' ');
    return (
      <svg className="pp-chart-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('折线图')}>
        <polyline points={path} fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinejoin="round" />
        {coords.map((point, index) => (
          <g key={index}>
            <circle cx={point.x} cy={point.y} r="4" fill="var(--accent)" />
            <text x={point.x} y={height - 2} textAnchor="middle" className="pp-chart-label">{point.label}</text>
          </g>
        ))}
      </svg>
    );
  }

  return (
    <svg className="pp-chart-svg" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('柱状图')}>
      {points.map((point, index) => {
        const barHeight = Math.max(2, (point.value / max) * (height - 42));
        const x = gap + index * (barWidth + gap);
        return (
          <g key={index}>
            <rect
              x={x}
              y={height - 20 - barHeight}
              width={barWidth}
              height={barHeight}
              rx="4"
              fill={point.color || 'var(--accent)'}
            />
            <text x={x + barWidth / 2} y={height - 2} textAnchor="middle" className="pp-chart-label">
              {point.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function ChartBlock({ block }: { block: BlockInstance }) {
  const t = useT();
  const title = blockProp(block, 'title', '');
  const kind = blockProp<string>(block, 'kind', 'bar');
  const source = blockProp<string>(block, 'source', 'manual');
  const height = Math.min(620, Math.max(220, Number(blockProp(block, 'height', 320))));
  const showLegend = blockProp(block, 'show_legend', true);
  const local = useRangeAnalytics('30d', false);

  const points =
    source === 'local_visits'
      ? local.stats.series.slice(-14).map((point, index) => ({
          label: point.label,
          value: point.count,
          color: index % 2 === 0 ? 'var(--accent)' : 'color-mix(in srgb, var(--accent) 60%, var(--ink))',
        }))
      : blockItems(block, 'items').map((item) => ({
          label: item.label || '',
          value: Number(item.value) || 0,
          color: item.color || 'var(--accent)',
        }));

  return (
    <section className="pp-data-block">
      {title ? <h2 className="pp-data-title">{title}</h2> : null}
      {points.length ? (
        <>
          <div className="pp-chart" style={{ height }}>
            <ChartSvg points={points} kind={kind} />
          </div>
          {showLegend && kind !== 'donut' ? (
            <div className="pp-chart-legend">
              {points.map((point, index) => (
                <span key={index}>
                  <i style={{ background: point.color }} />
                  {point.label}
                </span>
              ))}
            </div>
          ) : null}
          {source === 'local_visits' ? (
            <p className="pp-data-note">{t('数据来自这台浏览器的站点访问记录。')}</p>
          ) : null}
        </>
      ) : (
        <div className="pp-media-empty">
          {t('这个图表还没有数据。手动填写，或把数据来源切到“本机访问统计”。')}
        </div>
      )}
    </section>
  );
}

function ListBlock({ block }: { block: BlockInstance }) {
  const t = useT();
  const title = blockProp(block, 'title', '');
  const style = blockProp<string>(block, 'style', 'plain');
  const items = blockItems(block, 'items');
  return (
    <section className="pp-data-block">
      {title ? <h2 className="pp-data-title">{title}</h2> : null}
      {items.length ? (
        <ol className={`pp-feature-list is-${style}`}>
          {items.map((item, index) => {
            const inner = (
              <>
                {style === 'ordered' ? <span className="pp-list-index">{String(index + 1).padStart(2, '0')}</span> : null}
                {style === 'icon' ? <span className="pp-list-icon">•</span> : null}
                <span>
                  <strong>{item.title || t('条目')}</strong>
                  {item.text ? <span>{item.text}</span> : null}
                </span>
              </>
            );
            return (
              <li key={index}>
                {item.link ? (
                  <a href={item.link} target="_blank" rel="noreferrer noopener">
                    {inner}
                  </a>
                ) : (
                  inner
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="pp-media-empty">{t('在右侧添加列表条目后显示。')}</div>
      )}
    </section>
  );
}

function contentUrl(item: Content): string {
  return `/${item.kind === 'article' ? 'a' : 'p'}/${item.id}`;
}

/**
 * 内容卡片：封面 + 类型 + 标题 + 摘要 / 日期 / 标签。
 *
 * 导出给 P3 的查询块复用：它按分类 / 标签 / 时间在服务端取数，但卡片的样子必须
 * 与「文章组件」完全一致，所以样式（`.pp-article-card` / `.pp-article-grid`）与
 * 结构只留这一份。
 */
export function ArticleCard({
  item,
  layout,
  showExcerpt,
  showMeta,
  showTags,
  coverAccent = true,
}: {
  item: Content;
  layout: string;
  showExcerpt: boolean;
  showMeta: boolean;
  showTags: boolean;
  /**
   * 程序化封面是否跟随站点主色。白昼 / 夜航用主题色封面；纸白没有 accent 封面
   * 样式（只有默认深色封面），调用方可以关掉，避免深底深字。
   */
  coverAccent?: boolean;
}) {
  const t = useT();
  return (
    <Link className={`pp-article-card is-${layout}`} to={contentUrl(item)}>
      <ContentCover
        id={item.id}
        label={item.title}
        className="pp-article-cover"
        ratio="16 / 9"
        accent={coverAccent}
      />
      <span className="pp-article-copy">
        <span className="pp-article-kind">{item.kind === 'article' ? t('文章') : t('帖子')}</span>
        <strong>{item.title}</strong>
        {showExcerpt && item.summary ? <span className="pp-article-excerpt">{excerpt(item.summary, 90)}</span> : null}
        {showMeta ? (
          <span className="pp-article-meta">
            {formatDate(item.published_at ?? item.created_at)} · {t('{count} 分钟', { count: readingTime(item.rendered_html) })}
          </span>
        ) : null}
        {showTags && item.tags?.length ? (
          <span className="pp-article-tags">
            {item.tags.slice(0, 4).map((tag) => (
              <em key={tag}>{tag}</em>
            ))}
          </span>
        ) : null}
      </span>
    </Link>
  );
}

function ArticlesBlock({ block }: { block: BlockInstance }) {
  const t = useT();
  const feed = useFeed();
  const local = useRangeAnalytics('30d', false);
  const title = blockProp(block, 'title', '');
  const source = blockProp<string>(block, 'source', 'latest');
  const layout = blockProp<string>(block, 'layout', 'list');
  const columns = Math.min(4, Math.max(2, Number(blockProp(block, 'columns', 2))));
  const limit = Math.min(24, Math.max(1, Number(blockProp(block, 'limit', 6))));
  const showExcerpt = blockProp(block, 'show_excerpt', true);
  const showMeta = blockProp(block, 'show_meta', true);
  const showTags = blockProp(block, 'show_tags', true);
  const counts = new Map(local.stats.topContent.map((item) => [item.id, item.count]));

  const sorted = [...feed.all].sort((a, b) => {
    if (source === 'popular') {
      return (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0);
    }
    return (b.published_at ?? b.created_at).localeCompare(a.published_at ?? a.created_at);
  });
  const items = sorted.slice(0, limit);

  return (
    <section className="pp-data-block">
      {title ? <h2 className="pp-data-title">{title}</h2> : null}
      {feed.loading ? (
        <div className="pp-media-empty">{t('正在读取文章…')}</div>
      ) : items.length ? (
        <div
          className={`pp-article-grid is-${layout}`}
          style={{ '--pp-article-columns': layout === 'list' ? 1 : columns } as CSSProperties}
        >
          {items.map((item) => (
            <ArticleCard
              key={item.id}
              item={item}
              layout={layout}
              showExcerpt={showExcerpt}
              showMeta={showMeta}
              showTags={showTags}
            />
          ))}
        </div>
      ) : (
        <div className="pp-media-empty">{t('还没有已发布文章。')}</div>
      )}
      {source === 'popular' ? <p className="pp-data-note">{t('热门排序来自这台浏览器的访问记录。')}</p> : null}
    </section>
  );
}

function CodeBlock({ block }: { block: BlockInstance }) {
  const t = useT();
  const html = blockProp<string>(block, 'html', '');
  const css = blockProp<string>(block, 'css', '');
  const js = blockProp<string>(block, 'js', '');
  const height = Math.min(900, Math.max(120, Number(blockProp(block, 'height', 320))));
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;font-family:Inter,"Segoe UI","PingFang SC",sans-serif;color:#1c1c1a;background:#fff}
${css}
</style></head><body>${html}<script>${js.replace(/<\/script/gi, '<\\/script')}<\/script></body></html>`;
  return (
    <iframe
      className="pp-code-frame"
      title={t('自定义代码')}
      sandbox="allow-scripts"
      srcDoc={doc}
      style={{ height }}
    />
  );
}

export const DATA_RENDERERS = {
  stats: StatsBlock,
  chart: ChartBlock,
  list: ListBlock,
  articles: ArticlesBlock,
  code: CodeBlock,
};
