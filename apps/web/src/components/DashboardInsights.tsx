import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Content } from '../types';
import { useTaxonomy } from '../lib/useTaxonomy';
import { useRangeAnalytics } from '../lib/useAnalytics';
import type { AnalyticsRange } from '../lib/analytics';
import { formatDateTime, timeAgo } from '../lib/format';
import { Badge, EmptyState, Skeleton } from './ui';
import { Icon } from './Icon';

const RANGES: { value: AnalyticsRange; label: string }[] = [
  { value: '24h', label: '24h' },
  { value: '7d', label: '7 天' },
  { value: '30d', label: '30 天' },
];

function contentUrl(item: Content): string {
  return `/${item.kind === 'article' ? 'a' : 'p'}/${item.id}`;
}

/**
 * 仪表盘内的访问统计。访问记录不再有独立页面：
 * 时间范围切换在卡片右上角，图表、来源页面与最近记录都在这里阅读。
 */
export function DashboardAnalytics() {
  const [range, setRange] = useState<AnalyticsRange>('7d');
  const { stats, source, loading } = useRangeAnalytics(range);
  const max = Math.max(...stats.series.map((point) => point.count), 1);
  const recent = stats.recent.slice(0, 6);

  const showLabel = (index: number) => {
    if (range === '24h') return index % 3 === 0 || index === stats.series.length - 1;
    if (range === '30d') return index % 5 === 0 || index === stats.series.length - 1;
    return true;
  };

  return (
    <section className="dash-analytics">
      <div className="dash-analytics-head">
        <div>
          <span className="eyebrow">Traffic</span>
          <h2>访问记录</h2>
          <p>
            站点前台的访问趋势、来源页面与最近记录。
            <span className="tiny faint"> · {loading ? '更新中' : source === 'backend' ? '服务端统计' : '本机统计'}</span>
          </p>
        </div>
        <div className="range-switch" role="group" aria-label="统计时间范围">
          {RANGES.map((item) => (
            <button
              key={item.value}
              type="button"
              className={range === item.value ? 'is-on' : ''}
              aria-pressed={range === item.value}
              onClick={() => setRange(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="dash-analytics-metrics">
        <div>
          <span>浏览量</span>
          <b>{stats.views}</b>
          <em>{RANGES.find((item) => item.value === range)?.label}</em>
        </div>
        <div>
          <span>独立会话</span>
          <b>{stats.sessions}</b>
          <em>同一浏览器会话去重</em>
        </div>
        <div>
          <span>实时在线</span>
          <b>{stats.online}</b>
          <em>最近 5 分钟</em>
        </div>
      </div>

      <div className="analytics-chart analytics-line-chart" aria-label={`${range} 访问量`}>
        {(() => {
          const width = 640;
          const height = 190;
          const pad = 16;
          const step = stats.series.length > 1 ? (width - pad * 2) / (stats.series.length - 1) : 0;
          const points = stats.series.map((point, index) => {
            const x = pad + index * step;
            const y = height - pad - (point.count / max) * (height - pad * 2);
            return { ...point, x, y };
          });
          const line = points.map((point) => `${point.x},${point.y}`).join(' ');
          const area = `M ${pad} ${height - pad} L ${points.map((point) => `${point.x} ${point.y}`).join(' L ')} L ${width - pad} ${height - pad} Z`;
          return (
            <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${range} 访问量折线图`}>
              {[0.25, 0.5, 0.75].map((ratio) => (
                <line
                  key={ratio}
                  x1={pad}
                  x2={width - pad}
                  y1={height - pad - ratio * (height - pad * 2)}
                  y2={height - pad - ratio * (height - pad * 2)}
                  className="analytics-grid-line"
                />
              ))}
              <path d={area} className="analytics-line-area" />
              <polyline points={line} className="analytics-line" />
              {points.map((point, index) => (
                <circle
                  key={`${point.label}-${index}`}
                  cx={point.x}
                  cy={point.y}
                  r={point.count ? 3 : 2}
                  className="analytics-dot"
                >
                  <title>{`${point.label} · ${point.count} 次`}</title>
                </circle>
              ))}
              {points.map((point, index) =>
                showLabel(index) ? (
                  <text
                    key={`label-${point.label}-${index}`}
                    x={point.x}
                    y={height - 1}
                    textAnchor="middle"
                    className="analytics-axis-label"
                  >
                    {point.label}
                  </text>
                ) : null,
              )}
            </svg>
          );
        })()}
      </div>

      <div className="dash-analytics-bottom">
        <div>
          <div className="dash-mini-head">
            <strong>热门页面</strong>
            <span>{stats.topPages.length} 个</span>
          </div>
          {stats.topPages.length === 0 ? (
            <p className="tiny faint">这个时间范围内还没有访问。</p>
          ) : (
            <div className="dash-rank-list">
              {stats.topPages.slice(0, 5).map((page, index) => (
                <div key={page.path}>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <strong className="mono">{page.path}</strong>
                  <em>{page.count} 次</em>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="dash-mini-head">
            <strong>最近访问</strong>
            <span>最新 6 条</span>
          </div>
          {recent.length === 0 ? (
            <p className="tiny faint">打开站点前台后，这里会出现访问记录。</p>
          ) : (
            <div className="dash-visit-list">
              {recent.map((visit) => (
                <div key={`${visit.session}-${visit.created_at}-${visit.path}`}>
                  <span className="mono">{visit.path}</span>
                  <em>{formatDateTime(visit.created_at)}</em>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/** 仪表盘的热门文章卡片：按详情页阅读次数排序。 */
export function DashboardPopular({ items: pool, loading }: { items: Content[]; loading: boolean }) {
  const { taxonomy } = useTaxonomy();
  const { stats } = useRangeAnalytics('30d');
  const counts = useMemo(
    () => new Map(stats.topContent.map((entry) => [entry.id, entry.count])),
    [stats.topContent],
  );
  const items = useMemo(
    () =>
      [...pool]
        .filter((item) => item.status === 'published')
        .sort((a, b) => {
          const delta = (counts.get(b.id) ?? 0) - (counts.get(a.id) ?? 0);
          if (delta !== 0) return delta;
          return (b.published_at ?? b.created_at).localeCompare(a.published_at ?? a.created_at);
        })
        .slice(0, 5),
    [pool, counts],
  );

  return (
    <section className="panel dashboard-popular">
      <div className="panel-head">
        <div>
          <h3>热门文章</h3>
          <p>按文章详情页阅读次数排序。</p>
        </div>
        <Link to="/articles" className="btn btn-ghost btn-sm">
          全部 <Icon name="arrow-right" size={13} />
        </Link>
      </div>
      <div className="panel-body" style={{ paddingTop: 4 }}>
        {loading ? (
          <Skeleton lines={5} />
        ) : items.length === 0 ? (
          <EmptyState compact icon="file" title="还没有文章" body="发布内容后，这里会出现热门文章。" />
        ) : (
          <div className="dash-popular-list">
            {items.map((item, index) => {
              const category = taxonomy.categories.find((term) => term.id === item.category_id);
              return (
                <Link key={item.id} to={contentUrl(item)} className="dash-popular-row">
                  <span className="dash-popular-rank">{String(index + 1).padStart(2, '0')}</span>
                  <span className="dash-popular-body">
                    <strong>{item.title}</strong>
                    <em>
                      {category ? `${category.name} · ` : ''}
                      {timeAgo(item.published_at ?? item.created_at)}
                    </em>
                  </span>
                  <Badge tone={index < 3 ? 'accent' : 'muted'}>{counts.get(item.id) ?? 0} 次</Badge>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

/** 仪表盘的最近文章卡片，放在热门文章下方同一列。 */
export function DashboardRecent({ items: pool, loading }: { items: Content[]; loading: boolean }) {
  const items = useMemo(
    () =>
      [...pool]
        .filter((item) => item.status === 'published')
        .sort((a, b) => (b.published_at ?? b.created_at).localeCompare(a.published_at ?? a.created_at))
        .slice(0, 5),
    [pool],
  );

  return (
    <section className="panel dashboard-recent">
      <div className="panel-head">
        <div>
          <h3>最近文章</h3>
          <p>按发布时间倒序。</p>
        </div>
        <Link to="/admin/content" className="btn btn-ghost btn-sm">
          全部 <Icon name="arrow-right" size={13} />
        </Link>
      </div>
      <div className="panel-body" style={{ paddingTop: 4 }}>
        {loading ? (
          <Skeleton lines={4} />
        ) : items.length === 0 ? (
          <EmptyState compact icon="file" title="还没有文章" body="发布内容后，这里会出现最近文章。" />
        ) : (
          <div className="dash-recent-list">
            {items.map((item) => (
              <Link key={item.id} to={contentUrl(item)} className="dash-recent-row">
                <strong>{item.title}</strong>
                <em>{timeAgo(item.published_at ?? item.created_at)}</em>
              </Link>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
