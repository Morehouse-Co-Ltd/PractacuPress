import { useEffect, useMemo, useState } from 'react';
import { useBackend } from '../../lib/backend';
import { useAuth } from '../../lib/session';
import { useAsync, useTitle } from '../../lib/hooks';
import { activityCsv, activityTone, formatDateTime } from '../../lib/format';
import { activityActionLabel } from '../../lib/activityLabels';
import type { ActivityEntry } from '../../types';
import type { AuditLog } from '../../types';
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  PageLoading,
  Select,
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
];

type Range = '24h' | '7d' | '30d' | 'all';

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

export function ActivityPage() {
  const t = useT();
  const backend = useBackend();
  const { site } = useAuth();
  const toast = useToast();
  const [range, setRange] = useState<Range>('7d');
  const [action, setAction] = useState('');
  const [targetType, setTargetType] = useState('');
  const [actorId, setActorId] = useState('');
  useTitle(t('网站日志'));

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

  const exportCsv = () => {
    // CSV 与表格口径保持一致：导出人话动作名，而不是后端动作码。
    const csv = activityCsv(
      items.map((entry) => toActivityEntry(entry, activityActionLabel(entry.action, t))),
    );
    const blob = new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `practacu-activity-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast.push('ok', t('已导出 CSV'));
  };

  return (
    <>
      <div className="admin-page-head">
        <div>
          <h1>{t('网站日志')}</h1>
          <p>{t('这里展示服务端 audit_logs 中属于当前站点的审计记录。')}</p>
        </div>
        <div className="admin-page-actions">
          <Button variant="secondary" size="sm" icon="download" onClick={exportCsv} disabled={!items.length}>
            {t('导出 CSV')}
          </Button>
          <Button variant="ghost" size="sm" icon="refresh" onClick={data.reload}>
            {t('刷新')}
          </Button>
        </div>
      </div>

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

      {data.loading ? (
        <PageLoading label={t('正在载入操作日志')} />
      ) : items.length === 0 ? (
        <div className="mt-20">
          <EmptyState
            icon="clock"
            title={t('还没有操作日志')}
            body={t('发布内容、修改站点设置或调整用户组后，记录会出现在这里。')}
          />
        </div>
      ) : (
        <div className="panel mt-20">
          <div className="panel-body">
            {items.map((entry) => (
              <div className="activity-row" key={entry.id}>
                <time>{formatDateTime(entry.created_at)}</time>
                <span className="act-actor">
                  {entry.actor_name || entry.actor_id || t('系统')}
                </span>
                {/* title 保留原始动作码，排障时仍能对到服务端 audit_logs。 */}
                <span className="act-action" title={entry.action}>
                  <Badge tone={activityTone(entry.action)}>
                    {activityActionLabel(entry.action, t)}
                  </Badge>
                </span>
                <span className="act-target" title={entry.target_id}>
                  {entry.target_name || entry.target_id || entry.target_type || '—'}
                </span>
                {detailText(entry) ? <span className="act-detail">{detailText(entry)}</span> : null}
              </div>
            ))}
          </div>
        </div>
      )}

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
}
