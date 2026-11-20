import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { Content } from '../types';
import { useBackend } from '../lib/backend';
import { useAsync } from '../lib/hooks';
import { useTaxonomy } from '../lib/useTaxonomy';
import { useRangeAnalytics } from '../lib/useAnalytics';
import type { AnalyticsRange } from '../lib/analytics';
import { formatDateTime, timeAgo } from '../lib/format';
import { useT } from '../lib/i18n';
import { Badge, Button, EmptyState, Modal, Skeleton } from './ui';
import { Icon } from './Icon';
import { InsightsPanel } from '../pages/admin/Insights';

function contentUrl(item: Content): string {
  return `/${item.kind === 'article' ? 'a' : 'p'}/${item.id}`;
}

/**
 * 仪表盘内的访问统计。访问记录不再有独立页面：
 * 时间范围切换在卡片右上角，图表、来源页面与最近记录都在这里阅读。
 */
export function DashboardAnalytics() {
  const t = useT();
  const [range, setRange] = useState<AnalyticsRange>('7d');
  const { stats, source, loading } = useRangeAnalytics(range);
  const [searchParams, setSearchParams] = useSearchParams();
  // /admin?insights=1 是命令面板与旧 /admin/insights 链接的入口：进入仪表盘即展开弹窗。
  const [insightsOpen, setInsightsOpen] = useState(searchParams.get('insights') === '1');

  useEffect(() => {
    if (searchParams.get('insights') === '1') setInsightsOpen(true);
  }, [searchParams]);

  const openInsights = () => {
    setInsightsOpen(true);
    if (searchParams.get('insights') !== '1') {
      const next = new URLSearchParams(searchParams);
      next.set('insights', '1');
      setSearchParams(next, { replace: true });
    }
  };

  const closeInsights = () => {
    setInsightsOpen(false);
    if (searchParams.has('insights')) {
      const next = new URLSearchParams(searchParams);
      next.delete('insights');
      setSearchParams(next, { replace: true });
    }
  };

  const ranges: { value: AnalyticsRange; label: string }[] = [
    { value: '24h', label: '24h' },
    { value: '7d', label: t('7 天') },
    { value: '30d', label: t('30 天') },
  ];
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
          <h2>{t('访问记录')}</h2>
          <p>
            {t('站点前台的访问趋势、来源页面与最近记录。')}
            <span className="tiny faint"> · {loading ? t('更新中') : source === 'backend' ? t('服务端统计') : t('本机统计')}</span>
          </p>
        </div>
        <div className="row gap-8" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
          <div className="range-switch" role="group" aria-label={t('统计时间范围')}>
            {ranges.map((item) => (
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
          <Button
            variant="ghost"
            size="sm"
            iconRight="arrow-right"
            onClick={openInsights}
            title={t('打开完整的访问洞察')}
          >
            {t('更多')}
          </Button>
        </div>
      </div>

      <div className="dash-analytics-metrics">
        <div>
          <span>{t('浏览量')}</span>
          <b>{stats.views}</b>
          <em>{ranges.find((item) => item.value === range)?.label}</em>
        </div>
        <div>
          <span>{t('独立会话')}</span>
          <b>{stats.sessions}</b>
          <em>{t('同一浏览器会话去重')}</em>
        </div>
        <div>
          <span>{t('实时在线')}</span>
          <b>{stats.online}</b>
          <em>{t('最近 5 分钟')}</em>
        </div>
      </div>

      <div
        className="analytics-chart analytics-line-chart"
        aria-label={t('{range} 访问量', { range })}
      >
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
            <svg
              viewBox={`0 0 ${width} ${height}`}
              role="img"
              aria-label={t('{range} 访问量折线图', { range })}
            >
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
                  <title>{t('{label} · {count} 次', { label: point.label, count: point.count })}</title>
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
            <strong>{t('热门页面')}</strong>
            <span>{t('{count} 个', { count: stats.topPages.length })}</span>
          </div>
          {stats.topPages.length === 0 ? (
            <p className="tiny faint">{t('这个时间范围内还没有访问。')}</p>
          ) : (
            <div className="dash-rank-list">
              {stats.topPages.slice(0, 5).map((page, index) => (
                <div key={page.path}>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <strong className="mono">{page.path}</strong>
                  <em>{t('{count} 次', { count: page.count })}</em>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <div className="dash-mini-head">
            <strong>{t('最近访问')}</strong>
            <span>{t('最新 6 条')}</span>
          </div>
          {recent.length === 0 ? (
            <p className="tiny faint">{t('打开站点前台后，这里会出现访问记录。')}</p>
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

      <Modal
        open={insightsOpen}
        onClose={closeInsights}
        title={t('访问洞察')}
        width={960}
      >
        <InsightsPanel />
      </Modal>
    </section>
  );
}

/** 仪表盘的热门文章卡片：按服务端的单篇阅读量 + 时间衰减排序（FSD A-16）。 */
export function DashboardPopular({ items: pool, loading }: { items: Content[]; loading: boolean }) {
  const t = useT();
  const backend = useBackend();
  const { taxonomy } = useTaxonomy();
  // 排序发生在服务端：前端拿不到全站阅读量，本地访问记录只覆盖当前浏览器，
  // 用它排序会把「我看过的」当成「大家看过的」。
  const popular = useAsync(() => backend.popularContent({ limit: 5, window: '30d' }), [backend]);
  const items = useMemo(() => {
    const remote = popular.data?.items ?? [];
    if (remote.length) return remote;
    // 热门榜为空时退回内容池，按阅读量再按发布时间排，避免整卡空着。
    return [...pool]
      .filter((item) => item.status === 'published')
      .sort((a, b) => {
        const delta = (b.view_count ?? 0) - (a.view_count ?? 0);
        if (delta !== 0) return delta;
        return (b.published_at ?? b.created_at).localeCompare(a.published_at ?? a.created_at);
      })
      .slice(0, 5);
  }, [pool, popular.data]);
  const busy = loading || (popular.loading && !popular.data);

  return (
    <section className="panel dashboard-popular">
      <div className="panel-head">
        <div>
          <h3>{t('热门文章')}</h3>
          <p>{t('按近 30 天阅读量排序，越新越占优。')}</p>
        </div>
        <Link to="/articles" className="btn btn-ghost btn-sm">
          {t('全部')} <Icon name="arrow-right" size={13} />
        </Link>
      </div>
      <div className="panel-body" style={{ paddingTop: 4 }}>
        {busy ? (
          <Skeleton lines={5} />
        ) : items.length === 0 ? (
          <EmptyState
            compact
            icon="file"
            title={t('还没有文章')}
            body={t('发布内容后，这里会出现热门文章。')}
          />
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
                  <Badge tone={index < 3 ? 'accent' : 'muted'}>
                    {t('{count} 次', { count: item.view_count ?? 0 })}
                  </Badge>
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
  const t = useT();
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
          <h3>{t('最近文章')}</h3>
          <p>{t('按发布时间倒序。')}</p>
        </div>
        <Link to="/admin/content" className="btn btn-ghost btn-sm">
          {t('全部')} <Icon name="arrow-right" size={13} />
        </Link>
      </div>
      <div className="panel-body" style={{ paddingTop: 4 }}>
        {loading ? (
          <Skeleton lines={4} />
        ) : items.length === 0 ? (
          <EmptyState
            compact
            icon="file"
            title={t('还没有文章')}
            body={t('发布内容后，这里会出现最近文章。')}
          />
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
