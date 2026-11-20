import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useBackend } from '../../lib/backend';
import { useAuth } from '../../lib/session';
import { errorText, useAsync, useTitle } from '../../lib/hooks';
import { activityCsv, activityTone, formatDateTime, requestCsv } from '../../lib/format';
import { activityActionLabel } from '../../lib/activityLabels';
import { REQUEST_LOG_LIMIT, logSourceFromSearch, type LogSource } from '../../lib/requestLogs';
import { ApiError } from '../../lib/api';
import type { ActivityEntry, AuditLog, SystemLogEntry } from '../../types';
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  Input,
  PageLoading,
  Select,
  Skeleton,
  Tabs,
} from '../../components/ui';
import { useToast } from '../../lib/toast';
import { useT } from '../../lib/i18n';

/** 与后端 audit_logs.action 对齐的常用动作；也可以直接输在筛选里。 */
const ACTION_OPTIONS = [
  'auth.registered',
  'auth.login',
  'auth.logout',
  'auth.password_changed',
  'auth.profile_updated',
  'auth.email_verification_requested',
  'auth.email_verified',
  'content.created',
  'content.updated',
  'content.submitted',
  'content.published',
  'content.rejected',
  'content.archived',
  'content.restored',
  'content.rollback',
  'site.settings.updated',
  'site.domain.updated',
  'site.domain.verified',
  'site.customization.updated',
  'site.member.created',
  'site.member.role_changed',
  'site.member.profile_updated',
  'site.member.status_changed',
  'site.member.media_quota_updated',
  'site.member.removed',
  'site.member.group_changed',
  'site.permission_group.saved',
  'system.storage.updated',
  'community.comment.created',
  'community.comment.edited',
  'community.comment.moderated',
  'community.comment.deleted',
  'moderation.report.created',
  'moderation.report.assigned',
  'moderation.report.resolved',
  'moderation.report.ignored',
  'moderation.report.takedown',
  'moderation.report.ban',
  'platform.site.created',
  'platform.site.entered',
];

const TARGET_OPTIONS = [
  'article',
  'post',
  'comment',
  'site_member',
  'permission_group',
  'site',
  'site_customization',
  'moderation_report',
  'user',
  'deployment',
];

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;

type Range = '24h' | '7d' | '30d' | 'all';
type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'muted' | 'accent';

function rangeStart(range: Range): string | undefined {
  if (range === 'all') return undefined;
  const hours = range === '24h' ? 24 : range === '7d' ? 24 * 7 : 24 * 30;
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

/** detail 里只承载内部标识的技术键：值对读者没有意义，展示时直接跳过。 */
const DETAIL_TECHNICAL_KEY = /^(?:id|.*_ids?|.*_token|.*_hash|.*_path|.*_url|.*_ip|request_id|ip)$/i;

/** 单个 detail 值 → 一行可读文字；对象等结构值可能是内部数据，直接略过。 */
function detailValueText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    const text = value.trim();
    return text || undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const parts = value.map(detailValueText).filter((part): part is string => !!part);
    return parts.length ? parts.join(' / ') : undefined;
  }
  return undefined;
}

/**
 * detail 详情行：省掉技术键，只展示可读的值。
 *
 * 审计 detail 的字段名是给服务端和调试用的（article_id、request_id 之类），
 * 直接 `key: value` 印出来对站长没有帮助；这里最多取三个可读值，用「·」分隔。
 */
function detailText(entry: AuditLog): string {
  if (!entry.detail) return '';
  const values: string[] = [];
  for (const [key, value] of Object.entries(entry.detail)) {
    if (DETAIL_TECHNICAL_KEY.test(key)) continue;
    const text = detailValueText(value);
    if (text) values.push(text);
    if (values.length >= 3) break;
  }
  return values.join(' · ');
}

function toActivityEntry(entry: AuditLog, actionLabel: string): ActivityEntry {
  return {
    id: entry.id,
    at: entry.created_at,
    actor: entry.actor_name || entry.actor_id || '—',
    action: actionLabel,
    target: entry.target_name || entry.target_id || entry.target_type || '—',
    detail: entry.detail ? JSON.stringify(entry.detail) : undefined,
  };
}

/** 状态码 → Badge 语气；5xx 最重，4xx 次之，3xx 用强调色，2xx 正常。 */
function statusTone(status: number): Tone {
  if (status >= 500) return 'danger';
  if (status >= 400) return 'warn';
  if (status >= 300) return 'accent';
  if (status >= 100) return 'ok';
  return 'neutral';
}

/** 统一导出口径：BOM + UTF-8，Excel 打开中文表头不会乱码。 */
function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * 网站日志：审计记录与请求日志合并成一张表，来源用标签页切换。
 *
 * 两个来源的数据形状、筛选条件、分页方式都不同，所以各自持有查询状态，只在展示层合并：
 * 同一个 panel、同一个 table、同一套 CSV 导出，切换来源时不会丢掉另一个来源的筛选。
 * 来源写在地址栏（`?source=request`），刷新和分享都能回到同一视图。
 */
export function ActivityPage() {
  const t = useT();
  const backend = useBackend();
  const { me, site } = useAuth();
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const [range, setRange] = useState<Range>('7d');
  const [action, setAction] = useState('');
  const [targetType, setTargetType] = useState('');
  const [actorId, setActorId] = useState('');
  useTitle(t('网站日志'));

  const canViewRequestLogs = me?.role === 'site_admin' || me?.role === 'platform_admin';
  // 地址栏是事实来源；没有权限时即使手写 ?source=request 也停在网站日志。
  const source: LogSource = canViewRequestLogs ? logSourceFromSearch(searchParams) : 'audit';

  const selectSource = (next: LogSource) => {
    const params = new URLSearchParams(searchParams);
    // 两个值都显式写入（包括 audit），这样刷新后不会因为缺省值又跳回网站日志。
    params.set('source', next);
    setSearchParams(params, { replace: true });
  };

  const members = useAsync(async () => {
    if (!site) return [];
    try {
      return await backend.members(site.id);
    } catch {
      // A non-admin should not reach this page, but degrading to "no actor filter"
      // is safer than blocking the log itself.
      return [];
    }
  }, [backend, site?.id]);

  const query = useMemo(
    () => ({
      from: rangeStart(range),
      action: action || undefined,
      target_type: targetType || undefined,
      actor_id: actorId || undefined,
      limit: 50,
    }),
    [range, action, targetType, actorId],
  );

  const data = useAsync(async () => {
    if (!site) return { items: [] as AuditLog[], next_cursor: undefined };
    return backend.auditLogs(site.id, query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, site?.id, query]);

  const [more, setMore] = useState<{ items: AuditLog[]; cursor?: string; loaded: boolean }>({
    items: [],
    cursor: undefined,
    loaded: false,
  });

  // A new filter set starts a new pagination chain.
  useEffect(() => {
    setMore({ items: [], cursor: undefined, loaded: false });
  }, [data.data]);

  const items = useMemo(
    () => [...(data.data?.items ?? []), ...more.items],
    [data.data, more.items],
  );

  // Once "load more" ran, its cursor (possibly empty) is authoritative: falling back
  // to the first page cursor would re-fetch page two forever.
  const nextCursor = more.loaded ? more.cursor : data.data?.next_cursor;

  const loadMore = async () => {
    if (!site || !nextCursor) return;
    try {
      const next = await backend.auditLogs(site.id, { ...query, cursor: nextCursor });
      setMore((prev) => ({
        items: [...prev.items, ...next.items],
        cursor: next.next_cursor,
        loaded: true,
      }));
    } catch (err) {
      toast.push('error', t('加载更多失败'), err instanceof Error ? err.message : undefined);
    }
  };

  /* ------------------------------ 请求日志来源 ------------------------------ */

  const [requestStatusText, setRequestStatusText] = useState('');
  const [requestPathText, setRequestPathText] = useState('');
  const [requestMethod, setRequestMethod] = useState('');
  const [requestFormError, setRequestFormError] = useState('');
  const [requestFilters, setRequestFilters] = useState<{
    status?: number;
    path?: string;
    method?: string;
  }>({});

  // 服务端只接受 1–100 的 limit，超出会返回 400；上限集中在 REQUEST_LOG_LIMIT 里。
  const requestData = useAsync(async () => {
    if (!canViewRequestLogs) return [] as SystemLogEntry[];
    return backend.systemLogs({ limit: REQUEST_LOG_LIMIT, ...requestFilters });
  }, [backend, canViewRequestLogs, requestFilters]);
  const requestEntries: SystemLogEntry[] = requestData.data ?? [];

  // 旧后端没有这个端点：404/405 是版本差异，不是临时故障，所以给升级提示而不是重试。
  const requestUnavailable =
    requestData.error instanceof ApiError &&
    (requestData.error.problem.status === 404 || requestData.error.problem.status === 405);

  const submitRequestFilters = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = requestStatusText.trim();
    const parsed = Number(trimmed);
    if (trimmed && (!Number.isInteger(parsed) || parsed < 100 || parsed > 599)) {
      setRequestFormError(t('状态码需要是 100–599 的整数。'));
      return;
    }
    setRequestFormError('');
    setRequestFilters({
      status: trimmed ? parsed : undefined,
      path: requestPathText.trim() || undefined,
      method: requestMethod || undefined,
    });
  };

  /* --------------------------------- 导出与刷新 --------------------------------- */

  const activeCount = source === 'request' ? requestEntries.length : items.length;

  const refresh = () => {
    data.reload();
    if (canViewRequestLogs) requestData.reload();
  };

  const exportCsv = () => {
    const day = new Date().toISOString().slice(0, 10);
    if (source === 'request') {
      downloadCsv(`practacu-requests-${day}.csv`, requestCsv(requestEntries));
    } else {
      // CSV 与表格口径保持一致：导出人话动作名，而不是后端动作码。
      downloadCsv(
        `practacu-activity-${day}.csv`,
        activityCsv(items.map((entry) => toActivityEntry(entry, activityActionLabel(entry.action, t)))),
      );
    }
    toast.push('ok', t('已导出 CSV'));
  };

  /* ---------------------------------- 渲染 ---------------------------------- */

  const auditBlock = (
    <>
      <Callout tone="info" icon="info" title={t('服务端审计日志')}>
        {t(
          '登录、发布、删除、角色变更与站点设置修改都会写入 audit_logs。只有站点管理员可以查询本页；记录按时间倒序，可用时间、操作人、动作与目标筛选。',
        )}
      </Callout>

      <div className="toolbar mt-20" style={{ flexWrap: 'wrap', gap: 8 }}>
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
          value={actorId}
          aria-label={t('操作人')}
          onChange={(event) => setActorId(event.target.value)}
        >
          <option value="">{t('全部操作人')}</option>
          {(members.data ?? []).map((member) => (
            <option key={member.user_id} value={member.user_id}>
              {member.display_name}
            </option>
          ))}
        </Select>
        <Select
          value={action}
          aria-label={t('动作')}
          onChange={(event) => setAction(event.target.value)}
        >
          <option value="">{t('全部动作')}</option>
          {ACTION_OPTIONS.map((code) => (
            <option key={code} value={code}>
              {activityActionLabel(code, t)}
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
        <span className="toolbar-spacer" />
        <span className="tiny faint">{t('{count} 条', { count: items.length })}</span>
      </div>

      <div className="mt-20">
        {data.loading ? (
          <PageLoading label={t('正在载入操作日志')} />
        ) : items.length === 0 ? (
          <EmptyState
            icon="clock"
            title={t('还没有操作日志')}
            body={t('发布内容、修改站点设置或调整用户组后，记录会出现在这里。')}
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('时间')}</th>
                  <th>{t('操作人')}</th>
                  <th>{t('动作')}</th>
                  <th>{t('目标')}</th>
                  <th>{t('详情')}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((entry) => (
                  <tr key={entry.id}>
                    <td className="cell-title">{formatDateTime(entry.created_at)}</td>
                    <td>{entry.actor_name || entry.actor_id || t('系统')}</td>
                    {/* title 保留原始动作码，排障时仍能对到服务端 audit_logs。 */}
                    <td title={entry.action}>
                      <Badge tone={activityTone(entry.action)}>
                        {activityActionLabel(entry.action, t)}
                      </Badge>
                    </td>
                    <td title={entry.target_id}>
                      {entry.target_name || entry.target_id || entry.target_type || '—'}
                    </td>
                    <td className="tiny faint">{detailText(entry)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {nextCursor ? (
        <div className="mt-16" style={{ textAlign: 'center' }}>
          <Button variant="secondary" size="sm" onClick={loadMore}>
            {t('加载更多')}
          </Button>
        </div>
      ) : null}

      <p className="tiny faint mt-16">
        {t('记录保存在服务端 audit_logs 表中，按站点隔离；导出 CSV 只包含当前筛选已加载的记录。')}
      </p>
    </>
  );

  const requestBlock = (
    <>
      <form className="toolbar" style={{ flexWrap: 'wrap', gap: 8 }} onSubmit={submitRequestFilters}>
        <Input
          type="number"
          min={100}
          max={599}
          inputMode="numeric"
          value={requestStatusText}
          onChange={(event) => setRequestStatusText(event.target.value)}
          placeholder={t('状态码，例如 404')}
          aria-label={t('状态码')}
          style={{ width: 150 }}
        />
        <Input
          value={requestPathText}
          onChange={(event) => setRequestPathText(event.target.value)}
          placeholder={t('路径片段，例如 /api/v1')}
          aria-label={t('路径片段')}
          style={{ minWidth: 220, flex: '1 1 220px' }}
        />
        <Select
          value={requestMethod}
          onChange={(event) => setRequestMethod(event.target.value)}
          aria-label={t('方法')}
        >
          <option value="">{t('全部方法')}</option>
          {METHODS.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="secondary" size="sm" icon="filter">
          {t('筛选')}
        </Button>
        <span className="toolbar-spacer" />
        <span className="tiny faint">{t('{count} 条请求', { count: requestEntries.length })}</span>
      </form>
      {requestFormError ? (
        <p className="field-error tiny" role="alert">
          {requestFormError}
        </p>
      ) : null}

      <div className="mt-16">
        {requestData.loading ? (
          <Skeleton lines={5} />
        ) : requestUnavailable ? (
          <Callout tone="info" icon="info" title={t('当前后端没有请求日志接口')}>
            {t('当前后端没有请求日志接口，升级 API 后可用')}
          </Callout>
        ) : requestData.error ? (
          <Callout tone="danger" icon="alert" title={t('无法读取请求日志')}>
            <p>{errorText(requestData.error) || t('请求失败。')}</p>
            <div className="mt-12">
              <Button variant="secondary" size="sm" icon="refresh" onClick={requestData.reload}>
                {t('重试')}
              </Button>
            </div>
          </Callout>
        ) : requestEntries.length === 0 ? (
          <EmptyState
            icon="activity"
            title={t('没有匹配的请求日志')}
            body={t('调整筛选条件后再试；服务端只保留最近的请求元数据。')}
          />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('时间')}</th>
                  <th>{t('方法')}</th>
                  <th>{t('路径')}</th>
                  <th>{t('状态码')}</th>
                  <th style={{ textAlign: 'right' }}>{t('耗时')}</th>
                  <th>{t('请求号')}</th>
                </tr>
              </thead>
              <tbody>
                {requestEntries.map((entry) => (
                  <tr key={`${entry.request_id}-${entry.time}`}>
                    <td className="cell-title">{formatDateTime(entry.time)}</td>
                    <td>
                      <Badge tone="muted">{entry.method}</Badge>
                    </td>
                    <td className="mono tiny" title={entry.path}>
                      {entry.path}
                    </td>
                    <td>
                      <Badge tone={statusTone(entry.status)} dot>
                        {entry.status}
                      </Badge>
                    </td>
                    <td className="cell-num">{entry.duration_ms} ms</td>
                    <td className="mono tiny faint" title={entry.request_id}>
                      {entry.request_id}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="tiny faint mt-16">
        {t('请求日志只保留最近的 {count} 条元数据。', { count: REQUEST_LOG_LIMIT })}
      </p>
    </>
  );

  return (
    <>
      <div className="admin-page-head">
        <div>
          <h1>{t('网站日志')}</h1>
          <p>{t('审计记录与请求元数据都在这里，按来源切换查看；导出只包含当前来源。')}</p>
        </div>
        <div className="admin-page-actions">
          <Button
            variant="secondary"
            size="sm"
            icon="download"
            onClick={exportCsv}
            disabled={activeCount === 0}
          >
            {t('导出 CSV')}
          </Button>
          <Button variant="ghost" size="sm" icon="refresh" onClick={refresh}>
            {t('刷新')}
          </Button>
        </div>
      </div>

      <div className="panel mt-20">
        <div className="panel-head">
          <div>
            <h3>{t('操作与请求日志')}</h3>
            <p>{t('用右上角的标签页切换来源；两个来源的筛选与翻页各自独立。')}</p>
          </div>
          <div className="admin-page-actions">
            <Tabs<LogSource>
              value={source}
              onChange={selectSource}
              items={[
                { key: 'audit', label: t('网站日志'), count: items.length },
                { key: 'request', label: t('请求日志'), count: requestEntries.length },
              ]}
            />
          </div>
        </div>
        <div className="panel-body">{source === 'audit' ? auditBlock : requestBlock}</div>
      </div>
    </>
  );
}
