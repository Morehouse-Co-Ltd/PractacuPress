import { useState } from 'react';
import type { SiteAnalytics } from '../../lib/backend';
import { useBackend } from '../../lib/backend';
import { useAsync, useTitle } from '../../lib/hooks';
import { useAuth } from '../../lib/session';
import { useT, type Vars } from '../../lib/i18n';
import type { AnalyticsRange } from '../../lib/analytics';
import { Badge, Button, Callout, EmptyState, PageLoading } from '../../components/ui';

/**
 * 访问洞察：来源 / 设备 / 外部引荐 / 留存四个维度。
 *
 * 数据只来自服务端 `GET /sites/{id}/analytics`（`backend.analytics`）：来源、设备、
 * 引荐主机与留存都由服务端从请求体 referrer 与 User-Agent 派生，本机访问记录不具备
 * 这些维度，也不代表全站访客，所以这里不做本地回退。旧后端不返回这四个数组时
 * `HttpBackend.analytics` 会补成空数组；统计端点整体不可用（404 / 503）时返回
 * `null`，页面如实显示「当前后端不支持统计」，而不是拿本机数据冒充全站。
 */

/** 一条横向分布数据：来源或设备分类 + 访问数 / 会话数。 */
interface DistributionRow {
  key: string;
  label: string;
  visits: number;
  sessions: number;
}

/** 留存堆叠柱的最大高度（px）：与既有 `.analytics-chart` 的 148px 高度配套。 */
const RETENTION_BAR_HEIGHT = 96;

/** 没有来源 / 设备数组时按空数组渲染，避免旧后端缺字段导致整页崩掉。 */
function safeList<T>(items: T[] | undefined): T[] {
  return Array.isArray(items) ? items : [];
}

/** 日期取 `MM/DD` 作为柱状图标签；异常值原样显示。 */
function shortDate(value: string): string {
  return value.length >= 10 ? value.slice(5).replace('-', '/') : value;
}

/**
 * 横向条形图：纯 CSS div 宽度，不引图表库，与既有统计卡片的克制风格一致。
 * 数字列同时给出访问数与会话数，条形长度只表示访问数。
 */
function DistributionBars({ rows, t }: { rows: DistributionRow[]; t: (text: string, vars?: Vars) => string }) {
  const max = Math.max(1, ...rows.map((row) => row.visits));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {rows.map((row) => (
        <div
          key={row.key}
          style={{
            display: 'grid',
            gridTemplateColumns: '72px minmax(0, 1fr) auto',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <span className="tiny" style={{ color: 'var(--ink)' }}>
            {row.label}
          </span>
          <span
            aria-hidden
            style={{
              display: 'block',
              height: 8,
              borderRadius: 999,
              background: 'var(--bg-subtle)',
              overflow: 'hidden',
            }}
          >
            <span
              style={{
                display: 'block',
                height: '100%',
                width: `${row.visits > 0 ? Math.max(2, Math.round((row.visits / max) * 100)) : 0}%`,
                borderRadius: 999,
                background: 'var(--accent)',
              }}
            />
          </span>
          <span
            className="tiny muted"
            style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
          >
            {t('{visits} 次 · {sessions} 个会话', { visits: row.visits, sessions: row.sessions })}
          </span>
        </div>
      ))}
    </div>
  );
}

/** 按天的留存堆叠柱：下方实色是新会话，上方浅色是回访会话。 */
function RetentionChart({
  rows,
  t,
}: {
  rows: SiteAnalytics['retention'];
  t: (text: string, vars?: Vars) => string;
}) {
  const max = Math.max(1, ...rows.map((row) => row.new_sessions + row.returning_sessions));
  return (
    <div className="analytics-chart" role="img" aria-label={t('每日新会话与回访会话')}>
      {rows.map((row) => {
        const returningHeight = Math.round((row.returning_sessions / max) * RETENTION_BAR_HEIGHT);
        const newHeight = Math.round((row.new_sessions / max) * RETENTION_BAR_HEIGHT);
        return (
          <div
            className="analytics-bar"
            key={row.date}
            title={t('{date}：新会话 {newSessions}，回访会话 {returningSessions}', {
              date: row.date,
              newSessions: row.new_sessions,
              returningSessions: row.returning_sessions,
            })}
          >
            <span
              style={{
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'flex-end',
                width: '100%',
                maxWidth: 30,
                height: RETENTION_BAR_HEIGHT,
                background: 'transparent',
                borderRadius: 0,
                opacity: 1,
              }}
            >
              <span
                style={{
                  height: returningHeight,
                  borderRadius: '2px 2px 0 0',
                  background: 'color-mix(in srgb, var(--accent) 34%, #fff)',
                  opacity: 1,
                }}
              />
              <span
                style={{
                  height: newHeight,
                  borderRadius: returningHeight > 0 ? 0 : '2px 2px 0 0',
                  background: 'var(--accent)',
                  opacity: 1,
                }}
              />
            </span>
            <em>{shortDate(row.date)}</em>
          </div>
        );
      })}
    </div>
  );
}

/**
 * 可嵌入的访问洞察面板。
 *
 * 独立页面 `/admin/insights` 已经并入仪表盘的“访问记录”卡片：面板不再带页面标题，
 * 只保留时间范围切换与全部统计内容，因此既能给独立页面用，也能放进“更多”弹窗。
 */
export function InsightsPanel() {
  const t = useT();
  const { me } = useAuth();
  const backend = useBackend();
  const siteId = me?.site_id ?? '';
  const [range, setRange] = useState<AnalyticsRange>('7d');

  const data = useAsync(
    async () => (siteId ? await backend.analytics(siteId, range) : null),
    [backend, range, siteId],
  );

  const ranges: { value: AnalyticsRange; label: string }[] = [
    { value: '24h', label: '24h' },
    { value: '7d', label: t('7 天') },
    { value: '30d', label: t('30 天') },
  ];

  /** 服务端来源分类 → 文案；未知值（旧数据 / 新分类）给兜底而不是空白。 */
  const sourceLabel = (kind: string): string => {
    switch (kind) {
      case 'direct':
        return t('直接访问');
      case 'internal':
        return t('站内');
      case 'search':
        return t('搜索引擎');
      case 'social':
        return t('社交媒体');
      case 'referral':
        return t('外部链接');
      default:
        return t('未知来源');
    }
  };

  const deviceLabel = (kind: string): string => {
    switch (kind) {
      case 'desktop':
        return t('桌面');
      case 'mobile':
        return t('手机');
      case 'tablet':
        return t('平板');
      case 'bot':
        return t('机器人');
      default:
        return t('未知设备');
    }
  };

  const analytics = data.data;
  const sourceRows: DistributionRow[] = safeList(analytics?.sources)
    .filter((row) => row.visits > 0 || row.sessions > 0)
    .map((row) => ({
      key: row.source,
      label: sourceLabel(row.source),
      visits: row.visits,
      sessions: row.sessions,
    }));
  const deviceRows: DistributionRow[] = safeList(analytics?.devices)
    .filter((row) => row.visits > 0 || row.sessions > 0)
    .map((row) => ({
      key: row.device,
      label: deviceLabel(row.device),
      visits: row.visits,
      sessions: row.sessions,
    }));
  const referrerRows = safeList(analytics?.top_referrers);
  const retentionRows = safeList(analytics?.retention);
  const retentionHasData = retentionRows.some(
    (row) => row.new_sessions + row.returning_sessions > 0,
  );
  const totalViews = analytics?.totals.views ?? 0;
  const totalSessions = analytics?.totals.sessions ?? 0;

  const distributionPanel = (
    title: string,
    description: string,
    rows: DistributionRow[],
    emptyTitle: string,
    icon: 'globe' | 'users',
    badge: string,
  ) => (
    <section className="panel">
      <div className="panel-head">
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        <Badge tone="muted">{badge}</Badge>
      </div>
      <div className="panel-body">
        {rows.length === 0 ? (
          <EmptyState
            compact
            icon={icon}
            title={emptyTitle}
            body={t('这个时间范围内还没有访问数据。')}
          />
        ) : (
          <DistributionBars rows={rows} t={t} />
        )}
      </div>
    </section>
  );

  return (
    <div className="insights-panel">
      <div
        className="row gap-12"
        style={{ justifyContent: 'space-between', flexWrap: 'wrap', marginBottom: 12 }}
      >
        <p className="tiny faint" style={{ margin: 0 }}>
          {t('访客从哪里来、用什么设备、会不会再回来。')}
          <span className="tiny faint">
            {' · '}
            {data.loading ? t('更新中') : t('服务端统计')}
          </span>
        </p>
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
      </div>

      {data.error ? (
        <Callout tone="danger" icon="alert" title={t('无法读取访问统计')}>
          {data.error instanceof Error ? data.error.message : t('请求失败。')}
          <div className="mt-12">
            <Button variant="secondary" size="sm" onClick={data.reload}>
              {t('重试')}
            </Button>
          </div>
        </Callout>
      ) : !analytics && (data.loading || !siteId) ? (
        <PageLoading label={t('正在读取访问统计')} />
      ) : !analytics ? (
        <section className="panel mt-20">
          <div className="panel-body">
            <EmptyState
              icon="chart"
              title={t('当前后端不支持统计')}
              body={t('统计端点未部署或版本过旧；升级后端后，这里会显示来源、设备与留存。')}
            />
          </div>
        </section>
      ) : (
        <div className="visit-charts">
          {distributionPanel(
            t('来源分布'),
            t('访客从哪里来：直接访问、站内跳转、搜索引擎与外部链接。'),
            sourceRows,
            t('暂无来源数据'),
            'globe',
            t('{count} 次', { count: totalViews }),
          )}

          {distributionPanel(
            t('设备分布'),
            t('访客用什么设备打开站点；机器人单独计数。'),
            deviceRows,
            t('暂无设备数据'),
            'users',
            t('{count} 个会话', { count: totalSessions }),
          )}

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('来源主机 Top')}</h3>
                <p>{t('从其他站点链接进来的访问，按主机名排序。')}</p>
              </div>
              <Badge tone="muted">{t('{count} 个主机', { count: referrerRows.length })}</Badge>
            </div>
            <div className="panel-body">
              {referrerRows.length === 0 ? (
                <EmptyState
                  compact
                  icon="link"
                  title={t('暂无外部来源')}
                  body={t('还没有从其他站点链接进来的访问。')}
                />
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{t('来源主机')}</th>
                        <th className="cell-num" style={{ textAlign: 'right' }}>
                          {t('访问数')}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {referrerRows.map((row) => (
                        <tr key={row.host}>
                          <td className="mono tiny">{row.host}</td>
                          <td className="cell-num" style={{ textAlign: 'right' }}>
                            {row.visits}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('留存')}</h3>
                <p>{t('按天拆分新访客会话与回访会话；数字来自服务端会话去重。')}</p>
              </div>
              <Badge tone="muted">{t('{count} 天', { count: retentionRows.length })}</Badge>
            </div>
            <div className="panel-body">
              {retentionRows.length === 0 || !retentionHasData ? (
                <EmptyState
                  compact
                  icon="clock"
                  title={t('暂无留存数据')}
                  body={t('这个时间范围内的数据还不足以计算留存。')}
                />
              ) : (
                <>
                  <div className="row gap-16 tiny muted" style={{ marginBottom: 4 }}>
                    <span className="row gap-6">
                      <span
                        aria-hidden
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: 2,
                          background: 'var(--accent)',
                        }}
                      />
                      {t('新会话数')}
                    </span>
                    <span className="row gap-6">
                      <span
                        aria-hidden
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: 2,
                          background: 'color-mix(in srgb, var(--accent) 34%, #fff)',
                        }}
                      />
                      {t('回访会话数')}
                    </span>
                  </div>
                  <RetentionChart rows={retentionRows} t={t} />
                  <div className="table-wrap mt-12">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>{t('日期')}</th>
                          <th className="cell-num" style={{ textAlign: 'right' }}>
                            {t('新会话数')}
                          </th>
                          <th className="cell-num" style={{ textAlign: 'right' }}>
                            {t('回访会话数')}
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {retentionRows.map((row) => (
                          <tr key={row.date}>
                            <td className="mono tiny">{row.date}</td>
                            <td className="cell-num" style={{ textAlign: 'right' }}>
                              {row.new_sessions}
                            </td>
                            <td className="cell-num" style={{ textAlign: 'right' }}>
                              {row.returning_sessions}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

/** 独立页面保留给旧链接与直接访问；内容与“更多”弹窗共用 InsightsPanel。 */
export function InsightsPage() {
  const t = useT();
  useTitle(t('访问洞察'));
  return (
    <>
      <div className="admin-page-head">
        <div>
          <h1>{t('访问洞察')}</h1>
          <p>{t('访客从哪里来、用什么设备、会不会再回来。')}</p>
        </div>
      </div>
      <InsightsPanel />
    </>
  );
}

export default InsightsPage;
