import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  AuditLog,
  PlatformAccount,
  PlatformAccountQuery,
  PlatformAuditQuery,
  PlatformOverview,
  PlatformOverviewSite,
  PlatformSite,
} from '../../types';
import { useBackend, isDemo } from '../../lib/backend';
import { useAuth } from '../../lib/session';
import { useAsync, useTitle, errorText } from '../../lib/hooks';
import { activityTone, formatDate, formatDateTime, ROLE_LABEL } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { useToast } from '../../lib/toast';
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  Input,
  PageLoading,
  Select,
} from '../../components/ui';
import { Forbidden } from '../../components/Guards';
import { Icon } from '../../components/Icon';
import { PlatformTabs } from '../../components/PlatformTabs';

/**
 * 平台控制台的跨站运维页：总览、跨站审计与平台用户目录。
 *
 * 三页都是只读的部署级视图，共同点写在 `internal/platformadmin`：
 * 调用者必须是当前站点上的 platform_admin；响应只带计数、状态与布尔值，任何密码
 * 哈希、两步验证密钥或令牌都不会离开服务端。
 *
 * 交互沿用后台既有模式：路由页签、`useAsync` 装载、游标「加载更多」与 CSV 导出。
 */

/* ------------------------------------------------------------------ *
 * 共用小工具
 * ------------------------------------------------------------------ */

type Range = '24h' | '7d' | '30d' | 'all';

function rangeStart(range: Range): string | undefined {
  if (range === 'all') return undefined;
  const hours = range === '24h' ? 24 : range === '7d' ? 24 * 7 : 24 * 30;
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function csvCell(value: unknown): string {
  const text = value === undefined || value === null ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

/** 只导出前端已经载入的行；跨站导出不额外请求，避免一次点击翻完整条审计。 */
function downloadCsv(filename: string, header: string[], rows: unknown[][]): void {
  const body = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\n');
  const blob = new Blob([`\ufeff${body}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function detailText(entry: AuditLog): string {
  if (!entry.detail) return '';
  return Object.entries(entry.detail)
    .slice(0, 3)
    .map(([key, value]) => {
      if (value === null || value === undefined) return key;
      if (typeof value === 'object') return `${key}: …`;
      return `${key}: ${String(value)}`;
    })
    .join(' · ');
}

/** 审计结果徽标：成功 / 失败，其余按中性处理。 */
function outcomeBadge(outcome: string, t: (key: string) => string) {
  if (outcome === 'success') return <Badge tone="ok">{t('成功')}</Badge>;
  if (outcome === 'failure') return <Badge tone="danger">{t('失败')}</Badge>;
  return <Badge tone="muted">{outcome || '—'}</Badge>;
}

/** 站点状态下的一句话。 */
function siteStatusText(site: PlatformSite | PlatformOverviewSite, t: (key: string) => string) {
  if (site.disabled) return t('已停用');
  return t('运行中');
}

/* ------------------------------------------------------------------ *
 * 总览
 * ------------------------------------------------------------------ */

export function PlatformOverviewPage() {
  const t = useT();
  useTitle(t('平台总览'));
  const backend = useBackend();
  const { me } = useAuth();
  const [windowDays, setWindowDays] = useState(7);
  const demo = isDemo(backend);
  const isPlatformAdmin = me?.role === 'platform_admin';

  const { data, error, loading, reload } = useAsync<PlatformOverview | null>(
    () => (isPlatformAdmin ? backend.platformOverview(windowDays) : Promise.resolve(null)),
    [backend, isPlatformAdmin, windowDays],
  );

  if (!isPlatformAdmin) {
    return <Forbidden need={t('平台管理员')} />;
  }

  const overview = data;
  const totals = overview?.totals;
  const signals = overview?.signals;

  const signalRows: { key: string; label: string; value: number; hint: string }[] = signals
    ? [
        {
          key: 'open_reports',
          label: t('待处理举报'),
          value: signals.open_reports,
          hint: t('举报队列里仍待裁决的条目。'),
        },
        {
          key: 'pending_comments',
          label: t('待审核评论'),
          value: signals.pending_comments,
          hint: t('被先审后发或敏感词拦下的评论。'),
        },
        {
          key: 'failed_actions',
          label: t('窗口内失败动作'),
          value: signals.failed_actions,
          hint: t('例如人机验证失败；窗口内写入的拒绝记录。'),
        },
        {
          key: 'disabled_sites',
          label: t('已停用站点'),
          value: signals.disabled_sites,
          hint: t('停用站点对访客不可见。'),
        },
        {
          key: 'unverified_sites',
          label: t('未验证域名的站点'),
          value: signals.unverified_sites,
          hint: t('域名验证完成前无法通过主机名访问。'),
        },
        {
          key: 'unverified_emails',
          label: t('未验证邮箱的账户'),
          value: signals.unverified_emails,
          hint: t('这些账户无法通过邮件找回密码。'),
        },
        {
          key: 'quiet_sites',
          label: t('窗口内无活动的站点'),
          value: signals.quiet_sites,
          hint: t('运行中却没有任何审计记录，值得看一眼。'),
        },
      ]
    : [];

  return (
    <div className="stack">
      <PlatformTabs />
      <div className="admin-page-head">
        <div>
          <h1>{t('平台总览')}</h1>
          <p>{t('整个部署的运行快照：站点状态、内容与账户规模、需要处理的信号以及最近的跨站活动。')}</p>
        </div>
        <div className="admin-page-actions">
          <Select
            value={String(windowDays)}
            aria-label={t('活动窗口')}
            onChange={(event) => setWindowDays(Number(event.target.value))}
          >
            <option value="1">{t('最近 1 天')}</option>
            <option value="7">{t('最近 7 天')}</option>
            <option value="30">{t('最近 30 天')}</option>
          </Select>
          <Button variant="ghost" size="sm" icon="refresh" onClick={reload}>
            {t('刷新')}
          </Button>
        </div>
      </div>

      {demo ? (
        <Callout tone="info" title={t('演示模式')}>
          {t('演示模式只有当前站点，跨站数字只反映这一个站点的演示数据；连接真实后端后可用。')}
        </Callout>
      ) : null}

      {error ? (
        <Callout tone="danger" title={t('加载总览失败')}>
          {errorText(error)}
        </Callout>
      ) : null}

      {loading && !overview ? (
        <PageLoading label={t('正在汇总部署数据')} />
      ) : overview && totals && signals ? (
        <>
          <div className="stat-grid">
            <div className="stat is-accent">
              <span>{t('站点')}</span>
              <b>{totals.sites}</b>
              <small>
                {t('停用 {disabled} · 未验证域名 {unverified}', {
                  disabled: totals.disabled_sites,
                  unverified: totals.unverified_sites,
                })}
              </small>
            </div>
            <div className="stat">
              <span>{t('账户')}</span>
              <b>{totals.accounts}</b>
              <small>
                {t('已验证 {verified} · 两步验证 {twoFactor}', {
                  verified: totals.verified_accounts,
                  twoFactor: totals.two_factor_accounts,
                })}
              </small>
            </div>
            <div className="stat">
              <span>{t('成员')}</span>
              <b>{totals.members}</b>
              <small>
                {t('活跃 {active} · 管理员 {admins}', {
                  active: totals.active_members,
                  admins: totals.admins,
                })}
              </small>
            </div>
            <div className="stat">
              <span>{t('内容')}</span>
              <b>{totals.content}</b>
              <small>
                {t('已发布 {published} · 待审 {pending}', {
                  published: totals.published_content,
                  pending: totals.pending_content,
                })}
              </small>
            </div>
          </div>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('需要关注')}</h3>
                <p>
                  {t('每个信号都能在现有页面里处理掉；计数来自最近 {days} 天的窗口。', {
                    days: overview.window_days,
                  })}
                </p>
              </div>
            </div>
            <div className="panel-body">
              <div className="mini-list">
                {signalRows.map((row) => (
                  <div className="mini-row" key={row.key}>
                    <span className="mini-label">{row.label}</span>
                    <span className="mini-value">
                      <Badge tone={row.value > 0 ? 'warn' : 'ok'}>{row.value}</Badge>
                      <span className="tiny faint"> {row.hint}</span>
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('各站点快照')}</h3>
                <p>{t('库存计数是当前总量；活动与失败数只统计窗口内的审计记录。')}</p>
              </div>
            </div>
            {overview.sites.length === 0 ? (
              <EmptyState
                icon="server"
                title={t('还没有站点')}
                body={t('新建站点后，它会出现在这里。')}
                action={
                  <Link to="/admin/platform/new" className="btn btn-primary btn-sm">
                    {t('新建站点')}
                  </Link>
                }
              />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('站点')}</th>
                      <th>{t('状态')}</th>
                      <th className="cell-num">{t('成员')}</th>
                      <th className="cell-num">{t('管理员')}</th>
                      <th className="cell-num">{t('内容')}</th>
                      <th className="cell-num">{t('评论')}</th>
                      <th className="cell-num">{t('待处理举报')}</th>
                      <th className="cell-num">{t('窗口内活动')}</th>
                      <th className="cell-num">{t('失败')}</th>
                      <th className="cell-actions">{t('操作')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.sites.map((site) => (
                      <tr key={site.id}>
                        <td>
                          <div className="cell-title">
                            <Link to={`/admin/platform/${site.id}`}>{site.name}</Link>
                          </div>
                          <small className="muted">{site.slug}</small>
                        </td>
                        <td>
                          <Badge tone={site.disabled ? 'danger' : 'ok'}>
                            {siteStatusText(site, t)}
                          </Badge>
                          {site.domain ? (
                            <Badge tone={site.domain_verified ? 'neutral' : 'warn'}>
                              {site.domain_verified ? t('域名已验证') : t('域名待验证')}
                            </Badge>
                          ) : (
                            <Badge tone="muted">{t('未绑定域名')}</Badge>
                          )}
                        </td>
                        <td className="cell-num">
                          {site.active_member_count}/{site.member_count}
                        </td>
                        <td className="cell-num">{site.admin_count}</td>
                        <td className="cell-num">
                          {site.published_content_count}/{site.content_count}
                          {site.pending_content_count > 0 ? (
                            <small className="muted"> {t('待审 {count}', { count: site.pending_content_count })}</small>
                          ) : null}
                        </td>
                        <td className="cell-num">
                          {site.pending_comment_count}/{site.comment_count}
                        </td>
                        <td className="cell-num">{site.open_report_count}</td>
                        <td className="cell-num">{site.recent_activity_count}</td>
                        <td className="cell-num">{site.recent_failure_count}</td>
                        <td className="cell-actions">
                          <Link to={`/admin/platform/${site.id}`} className="btn btn-ghost btn-sm">
                            {t('详情')}
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="panel">
            <div className="panel-head">
              <div>
                <h3>{t('最近的跨站活动')}</h3>
                <p>{t('窗口内最新的一批审计记录；完整检索请到「跨站审计」。')}</p>
              </div>
              <Link to="/admin/platform/audit" className="btn btn-ghost btn-sm">
                {t('打开跨站审计')}
                <Icon name="arrow-right" size={14} />
              </Link>
            </div>
            {overview.recent_activity.length === 0 ? (
              <EmptyState
                icon="clock"
                title={t('窗口内没有活动')}
                body={t('把窗口放宽，或等待站点产生新的审计记录。')}
              />
            ) : (
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('时间')}</th>
                      <th>{t('站点')}</th>
                      <th>{t('操作人')}</th>
                      <th>{t('动作')}</th>
                      <th>{t('目标')}</th>
                      <th>{t('结果')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.recent_activity.map((row) => (
                      <tr key={row.id}>
                        <td>{formatDateTime(row.created_at)}</td>
                        <td>{row.site_name || '—'}</td>
                        <td>{row.actor_name || row.actor_id || t('系统')}</td>
                        <td>
                          <Badge tone={activityTone(row.action)}>{row.action}</Badge>
                        </td>
                        <td title={row.target_id}>
                          {row.target_name || row.target_id || row.target_type || '—'}
                        </td>
                        <td>{outcomeBadge(row.outcome, t)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <p className="tiny faint">
            {t('生成于 {time}，活动窗口自 {start} 起。总览只返回计数、状态与布尔值，不含任何密钥或令牌。', {
              time: formatDateTime(overview.generated_at),
              start: formatDateTime(overview.window_start),
            })}
          </p>
        </>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 跨站审计
 * ------------------------------------------------------------------ */

/** 与后端 audit_logs.action 对齐的常用动作；下拉是快捷方式，不是白名单。 */
const ACTION_OPTIONS = [
  'auth.login',
  'auth.logout',
  'auth.captcha.failed',
  'auth.password_changed',
  'auth.two_factor.enabled',
  'auth.two_factor.disabled',
  'content.created',
  'content.updated',
  'content.submitted',
  'content.published',
  'content.rejected',
  'content.archived',
  'site.settings.updated',
  'site.domain.updated',
  'site.domain.verified',
  'site.member.created',
  'site.member.role_changed',
  'site.member.status_changed',
  'site.member.removed',
  'site.member.group_changed',
  'site.permission_group.saved',
  'community.comment.created',
  'community.comment.moderated',
  'moderation.report.created',
  'moderation.report.resolved',
  'platform.site.created',
  'platform.site.entered',
  'platform.audit.queried',
];

const TARGET_OPTIONS = [
  'article',
  'post',
  'content',
  'comment',
  'site_member',
  'permission_group',
  'site',
  'site_customization',
  'moderation_report',
  'user',
];

export function PlatformAuditPage() {
  const t = useT();
  useTitle(t('跨站审计'));
  const backend = useBackend();
  const { me } = useAuth();
  const toast = useToast();
  const demo = isDemo(backend);
  const isPlatformAdmin = me?.role === 'platform_admin';

  const [siteId, setSiteId] = useState('');
  const [range, setRange] = useState<Range>('7d');
  const [action, setAction] = useState('');
  const [targetType, setTargetType] = useState('');
  const [outcome, setOutcome] = useState('');
  const [actorDraft, setActorDraft] = useState('');
  const [targetDraft, setTargetDraft] = useState('');
  const [actorId, setActorId] = useState('');
  const [targetId, setTargetId] = useState('');

  const sites = useAsync<PlatformSite[]>(
    () => (isPlatformAdmin ? backend.platformSites() : Promise.resolve([])),
    [backend, isPlatformAdmin],
  );
  const siteName = useMemo(() => {
    const names = new Map<string, string>();
    for (const site of sites.data ?? []) names.set(site.id, site.name);
    return names;
  }, [sites.data]);

  const query = useMemo<PlatformAuditQuery>(
    () => ({
      site_id: siteId || undefined,
      from: rangeStart(range),
      actor_id: actorId || undefined,
      action: action || undefined,
      target_type: targetType || undefined,
      target_id: targetId || undefined,
      outcome: outcome || undefined,
      limit: 50,
    }),
    [siteId, range, actorId, action, targetType, targetId, outcome],
  );

  const data = useAsync(async () => {
    if (!isPlatformAdmin) return { items: [] as AuditLog[], next_cursor: undefined };
    return backend.platformAuditLogs(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, isPlatformAdmin, query]);

  const [more, setMore] = useState<{ items: AuditLog[]; cursor?: string; loaded: boolean }>({
    items: [],
    cursor: undefined,
    loaded: false,
  });

  // 新的筛选条件开启一条新的分页链。
  useEffect(() => {
    setMore({ items: [], cursor: undefined, loaded: false });
  }, [data.data]);

  const items = useMemo(
    () => [...(data.data?.items ?? []), ...more.items],
    [data.data, more.items],
  );
  const nextCursor = more.loaded ? more.cursor : data.data?.next_cursor;

  const loadMore = async () => {
    if (!nextCursor) return;
    try {
      const next = await backend.platformAuditLogs({ ...query, cursor: nextCursor });
      setMore((prev) => ({
        items: [...prev.items, ...next.items],
        cursor: next.next_cursor,
        loaded: true,
      }));
    } catch (err) {
      toast.push('error', t('加载更多失败'), err instanceof Error ? err.message : undefined);
    }
  };

  const applyTextFilters = () => {
    setActorId(actorDraft.trim());
    setTargetId(targetDraft.trim());
  };

  const exportCsv = () => {
    downloadCsv(
      `practacu-platform-audit-${new Date().toISOString().slice(0, 10)}.csv`,
      ['time', 'site', 'actor', 'action', 'target_type', 'target', 'outcome', 'request_id', 'detail'],
      items.map((row) => [
        row.created_at,
        siteName.get(row.site_id ?? '') ?? row.site_id ?? '',
        row.actor_name || row.actor_id || '',
        row.action,
        row.target_type ?? '',
        row.target_name || row.target_id || '',
        row.outcome,
        row.request_id ?? '',
        row.detail ? JSON.stringify(row.detail) : '',
      ]),
    );
    toast.push('ok', t('已导出 CSV'));
  };

  if (!isPlatformAdmin) {
    return <Forbidden need={t('平台管理员')} />;
  }

  return (
    <div className="stack">
      <PlatformTabs />
      <div className="admin-page-head">
        <div>
          <h1>{t('跨站审计')}</h1>
          <p>{t('一次查询整个部署的审计记录：按站点、时间、操作人、动作、目标与结果筛选。')}</p>
        </div>
        <div className="admin-page-actions">
          <Button
            variant="secondary"
            size="sm"
            icon="download"
            onClick={exportCsv}
            disabled={!items.length}
          >
            {t('导出 CSV')}
          </Button>
          <Button variant="ghost" size="sm" icon="refresh" onClick={data.reload}>
            {t('刷新')}
          </Button>
        </div>
      </div>

      {demo ? (
        <Callout tone="info" title={t('演示模式')}>
          {t('演示模式只有当前站点，跨站审计里也只有这一个站点；连接真实后端后可用。')}
        </Callout>
      ) : null}

      <Callout tone="info" icon="info" title={t('这次读取本身会被审计')}>
        {t('每次跨站查询都会写入一条 platform.audit.queried 记录；写不进审计时查询会失败，不会留下未记录的披露。')}
      </Callout>

      <div className="toolbar mt-20" style={{ flexWrap: 'wrap', gap: 8 }}>
        <Select
          value={siteId}
          aria-label={t('站点')}
          onChange={(event) => setSiteId(event.target.value)}
        >
          <option value="">{t('全部站点')}</option>
          {(sites.data ?? []).map((site) => (
            <option key={site.id} value={site.id}>
              {site.name}
            </option>
          ))}
        </Select>
        <Select
          value={range}
          aria-label={t('时间范围')}
          onChange={(event) => setRange(event.target.value as Range)}
        >
          <option value="24h">{t('最近 24 小时')}</option>
          <option value="7d">{t('最近 7 天')}</option>
          <option value="30d">{t('最近 30 天')}</option>
          <option value="all">{t('全部时间')}</option>
        </Select>
        <Select
          value={action}
          aria-label={t('动作')}
          onChange={(event) => setAction(event.target.value)}
        >
          <option value="">{t('全部动作')}</option>
          {ACTION_OPTIONS.map((code) => (
            <option key={code} value={code}>
              {code}
            </option>
          ))}
        </Select>
        <Select
          value={targetType}
          aria-label={t('目标类型')}
          onChange={(event) => setTargetType(event.target.value)}
        >
          <option value="">{t('全部目标')}</option>
          {TARGET_OPTIONS.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </Select>
        <Select
          value={outcome}
          aria-label={t('结果')}
          onChange={(event) => setOutcome(event.target.value)}
        >
          <option value="">{t('全部结果')}</option>
          <option value="success">{t('成功')}</option>
          <option value="failure">{t('失败')}</option>
        </Select>
        <span className="toolbar-spacer" />
        <span className="tiny faint">{t('{count} 条', { count: items.length })}</span>
      </div>

      <form
        className="toolbar mt-16"
        style={{ flexWrap: 'wrap', gap: 8 }}
        onSubmit={(event) => {
          event.preventDefault();
          applyTextFilters();
        }}
      >
        <Input
          value={actorDraft}
          aria-label={t('操作人 ID')}
          placeholder={t('操作人 ID')}
          onChange={(event) => setActorDraft(event.target.value)}
        />
        <Input
          value={targetDraft}
          aria-label={t('目标 ID')}
          placeholder={t('目标 ID')}
          onChange={(event) => setTargetDraft(event.target.value)}
        />
        <Button type="submit" variant="secondary" size="sm">
          {t('应用筛选')}
        </Button>
      </form>

      {data.error ? (
        <Callout tone="danger" title={t('查询跨站审计失败')}>
          {errorText(data.error)}
        </Callout>
      ) : null}

      {data.loading && !data.data ? (
        <PageLoading label={t('正在查询跨站审计')} />
      ) : items.length === 0 ? (
        <div className="mt-20">
          <EmptyState
            icon="clock"
            title={t('没有匹配的审计记录')}
            body={t('放宽时间窗口或清空筛选后再试。')}
          />
        </div>
      ) : (
        <div className="panel mt-20">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('时间')}</th>
                  <th>{t('站点')}</th>
                  <th>{t('操作人')}</th>
                  <th>{t('动作')}</th>
                  <th>{t('目标')}</th>
                  <th>{t('结果')}</th>
                  <th>{t('详情')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr key={row.id}>
                    <td>{formatDateTime(row.created_at)}</td>
                    <td>{siteName.get(row.site_id ?? '') ?? row.site_id ?? '—'}</td>
                    <td>{row.actor_name || row.actor_id || t('系统')}</td>
                    <td>
                      <Badge tone={activityTone(row.action)}>{row.action}</Badge>
                    </td>
                    <td title={row.target_id}>
                      {row.target_name || row.target_id || row.target_type || '—'}
                    </td>
                    <td>{outcomeBadge(row.outcome, t)}</td>
                    <td className="muted">{detailText(row) || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {nextCursor ? (
        <div className="mt-16" style={{ textAlign: 'center' }}>
          <Button variant="secondary" size="sm" onClick={() => void loadMore()}>
            {t('加载更多')}
          </Button>
        </div>
      ) : null}

      <p className="tiny faint mt-16">
        {t('记录按时间倒序、游标分页；导出 CSV 只包含当前筛选已加载的记录。')}
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * 平台用户
 * ------------------------------------------------------------------ */

export function PlatformAccountsPage() {
  const t = useT();
  useTitle(t('平台用户'));
  const backend = useBackend();
  const { me } = useAuth();
  const toast = useToast();
  const demo = isDemo(backend);
  const isPlatformAdmin = me?.role === 'platform_admin';

  const [siteId, setSiteId] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [search, setSearch] = useState('');

  const sites = useAsync<PlatformSite[]>(
    () => (isPlatformAdmin ? backend.platformSites() : Promise.resolve([])),
    [backend, isPlatformAdmin],
  );

  const query = useMemo<PlatformAccountQuery>(
    () => ({
      site_id: siteId || undefined,
      q: search || undefined,
      limit: 50,
    }),
    [siteId, search],
  );

  const data = useAsync(async () => {
    if (!isPlatformAdmin) return { items: [] as PlatformAccount[], next_cursor: undefined };
    return backend.platformAccounts(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, isPlatformAdmin, query]);

  const [more, setMore] = useState<{ items: PlatformAccount[]; cursor?: string; loaded: boolean }>({
    items: [],
    cursor: undefined,
    loaded: false,
  });

  useEffect(() => {
    setMore({ items: [], cursor: undefined, loaded: false });
  }, [data.data]);

  const items = useMemo(
    () => [...(data.data?.items ?? []), ...more.items],
    [data.data, more.items],
  );
  const nextCursor = more.loaded ? more.cursor : data.data?.next_cursor;

  const loadMore = async () => {
    if (!nextCursor) return;
    try {
      const next = await backend.platformAccounts({ ...query, cursor: nextCursor });
      setMore((prev) => ({
        items: [...prev.items, ...next.items],
        cursor: next.next_cursor,
        loaded: true,
      }));
    } catch (err) {
      toast.push('error', t('加载更多失败'), err instanceof Error ? err.message : undefined);
    }
  };

  const exportCsv = () => {
    downloadCsv(
      `practacu-platform-users-${new Date().toISOString().slice(0, 10)}.csv`,
      ['display_name', 'email', 'email_verified', 'two_factor_enabled', 'status', 'created_at', 'sites'],
      items.map((account) => [
        account.display_name,
        account.email,
        account.email_verified ? 'yes' : 'no',
        account.two_factor_enabled ? 'yes' : 'no',
        account.status,
        account.created_at,
        account.memberships
          .map((membership) => `${membership.site_name} (${membership.role}/${membership.status})`)
          .join(' | '),
      ]),
    );
    toast.push('ok', t('已导出 CSV'));
  };

  if (!isPlatformAdmin) {
    return <Forbidden need={t('平台管理员')} />;
  }

  return (
    <div className="stack">
      <PlatformTabs />
      <div className="admin-page-head">
        <div>
          <h1>{t('平台用户')}</h1>
          <p>{t('部署内的账户与站点成员概览：邮箱验证状态、两步验证开关与所属站点。只读。')}</p>
        </div>
        <div className="admin-page-actions">
          <Button
            variant="secondary"
            size="sm"
            icon="download"
            onClick={exportCsv}
            disabled={!items.length}
          >
            {t('导出 CSV')}
          </Button>
          <Button variant="ghost" size="sm" icon="refresh" onClick={data.reload}>
            {t('刷新')}
          </Button>
        </div>
      </div>

      {demo ? (
        <Callout tone="info" title={t('演示模式')}>
          {t('演示模式只有当前站点与它的演示账户；连接真实后端后可用。')}
        </Callout>
      ) : null}

      <Callout tone="info" icon="shield" title={t('只读目录')}>
        {t('这里只用于查看：角色与状态变更仍在站点管理里完成。响应不会返回密码哈希、两步验证密钥或任何令牌。')}
      </Callout>

      <div className="toolbar mt-20" style={{ flexWrap: 'wrap', gap: 8 }}>
        <Select
          value={siteId}
          aria-label={t('站点')}
          onChange={(event) => setSiteId(event.target.value)}
        >
          <option value="">{t('全部账户')}</option>
          {(sites.data ?? []).map((site) => (
            <option key={site.id} value={site.id}>
              {t('站点成员：{name}', { name: site.name })}
            </option>
          ))}
        </Select>
        <form
          className="toolbar"
          style={{ gap: 8 }}
          onSubmit={(event) => {
            event.preventDefault();
            setSearch(searchDraft.trim());
          }}
        >
          <Input
            value={searchDraft}
            aria-label={t('搜索显示名或邮箱')}
            placeholder={t('搜索显示名或邮箱')}
            onChange={(event) => setSearchDraft(event.target.value)}
          />
          <Button type="submit" variant="secondary" size="sm">
            {t('搜索')}
          </Button>
        </form>
        <span className="toolbar-spacer" />
        <span className="tiny faint">{t('{count} 个账户', { count: items.length })}</span>
      </div>

      {data.error ? (
        <Callout tone="danger" title={t('加载平台用户失败')}>
          {errorText(data.error)}
        </Callout>
      ) : null}

      {data.loading && !data.data ? (
        <PageLoading label={t('正在加载平台用户')} />
      ) : items.length === 0 ? (
        <div className="mt-20">
          <EmptyState
            icon="users"
            title={t('没有匹配的账户')}
            body={t('清空搜索词或换一个站点再看。')}
          />
        </div>
      ) : (
        <div className="panel mt-20">
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('账户')}</th>
                  <th>{t('邮箱')}</th>
                  <th>{t('邮箱验证')}</th>
                  <th>{t('两步验证')}</th>
                  <th>{t('状态')}</th>
                  <th>{t('创建时间')}</th>
                  <th>{t('所属站点与角色')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((account) => (
                  <tr key={account.user_id}>
                    <td>
                      <div className="cell-title">{account.display_name}</div>
                      <small className="muted mono">{account.user_id}</small>
                    </td>
                    <td>{account.email || '—'}</td>
                    <td>
                      <Badge tone={account.email_verified ? 'ok' : 'warn'}>
                        {account.email_verified ? t('已验证') : t('未验证')}
                      </Badge>
                    </td>
                    <td>
                      <Badge tone={account.two_factor_enabled ? 'ok' : 'muted'}>
                        {account.two_factor_enabled ? t('已开启') : t('未开启')}
                      </Badge>
                    </td>
                    <td>
                      <Badge tone={account.status === 'active' ? 'ok' : 'danger'}>
                        {account.status === 'active' ? t('正常') : t('已停用')}
                      </Badge>
                    </td>
                    <td>{formatDate(account.created_at)}</td>
                    <td>
                      {account.memberships.length === 0 ? (
                        <span className="muted">{t('未加入任何站点')}</span>
                      ) : (
                        <span
                          style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 6 }}
                        >
                          {account.memberships.map((membership) => (
                            <Link
                              key={`${account.user_id}-${membership.site_id}`}
                              to={`/admin/platform/${membership.site_id}`}
                              className="chip"
                              title={t('查看站点详情')}
                            >
                              {membership.site_name || membership.site_slug} ·{' '}
                              {ROLE_LABEL[membership.role] ?? membership.role}
                            </Link>
                          ))}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {nextCursor ? (
        <div className="mt-16" style={{ textAlign: 'center' }}>
          <Button variant="secondary" size="sm" onClick={() => void loadMore()}>
            {t('加载更多')}
          </Button>
        </div>
      ) : null}

      <p className="tiny faint mt-16">
        {t('账户不带站点过滤时按创建时间倒序；选择站点后列出该站点的成员关系。导出 CSV 只包含已加载的行。')}
      </p>
    </div>
  );
}
