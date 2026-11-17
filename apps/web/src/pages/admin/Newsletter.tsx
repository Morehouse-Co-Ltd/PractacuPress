import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { EmailLog, EmailTemplate, Subscriber, SubscriberStatus } from '../../types';
import { useAuth } from '../../lib/session';
import { useBackend } from '../../lib/backend';
import { useAsync, useTitle } from '../../lib/hooks';
import { formatDateTime } from '../../lib/format';
import { errorText, useT } from '../../lib/i18n';
import { useToast } from '../../lib/toast';
import { RoleGate } from '../../components/Guards';
import { Icon } from '../../components/Icon';
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  Field,
  Input,
  Modal,
  Select,
  Skeleton,
  Tabs,
  Textarea,
  Toggle,
} from '../../components/ui';

/**
 * 邮件订阅后台（契约 N 节）。
 *
 * 四个分区分别对应四类工作：看名单、改模板、查发送记录、发一封刊物。它们各自
 * 独立取数（`useAsync`），一个分区失败不会把整页变成错误页；切换分区也不重新
 * 拉取已经加载过的分区，站长可以在模板与日志之间来回看。
 */

type TabKey = 'list' | 'templates' | 'logs' | 'send';

type Tone = 'ok' | 'warn' | 'muted' | 'danger' | 'neutral';

/** 订阅名单每页条数；与契约默认的 50 相比略小，首屏更快。 */
const PAGE_SIZE = 20;

const SUBSCRIBER_STATUSES: SubscriberStatus[] = [
  'pending',
  'confirmed',
  'unsubscribed',
  'bounced',
];

/** 发送日志的状态与类型筛选：值是服务端原样返回的枚举。 */
const LOG_STATUSES = ['queued', 'sent', 'failed', 'skipped'] as const;

const LOG_KINDS = ['newsletter', 'confirm', 'welcome', 'password_reset', 'email_verify'] as const;

interface TemplateDraft {
  name: string;
  subject: string;
  body_html: string;
  body_text: string;
  enabled: boolean;
}

/** 没有纯文本时，从 HTML 里剥一个粗粒度的正文，保证 `body_text` 不为空。 */
function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .trim();
}

export function NewsletterPage() {
  const t = useT();
  const backend = useBackend();
  const { site } = useAuth();
  const toast = useToast();
  const siteId = site?.id ?? '';
  const [tab, setTab] = useState<TabKey>('list');
  useTitle(t('邮件订阅'));

  /** 状态文案与徽标色调：`bounced` 是服务端硬退信，不能当成未知状态。 */
  const statusLabel = (status: string): string =>
    status === 'confirmed'
      ? t('已确认')
      : status === 'pending'
        ? t('待确认')
        : status === 'unsubscribed'
          ? t('已退订')
          : status === 'bounced'
            ? t('投递失败')
            : status;

  const statusTone = (status: string): Tone =>
    status === 'confirmed'
      ? 'ok'
      : status === 'pending'
        ? 'warn'
        : status === 'unsubscribed'
          ? 'muted'
          : status === 'bounced'
            ? 'danger'
            : 'neutral';

  const sourceLabel = (source: string): string =>
    source === 'site' ? t('站点表单') : source === 'account' ? t('登录账户') : source || '—';

  const logStatusLabel = (status: string): string =>
    status === 'queued'
      ? t('排队中')
      : status === 'sent'
        ? t('已发送')
        : status === 'failed'
          ? t('未送达')
          : status === 'skipped'
            ? t('已跳过')
            : status;

  const logStatusTone = (status: string): Tone =>
    status === 'queued'
      ? 'warn'
      : status === 'sent'
        ? 'ok'
        : status === 'failed'
          ? 'danger'
          : status === 'skipped'
            ? 'muted'
            : 'neutral';

  const kindLabel = (kind: string): string =>
    kind === 'newsletter'
      ? t('刊物')
      : kind === 'confirm'
        ? t('订阅确认')
        : kind === 'welcome'
          ? t('欢迎邮件')
          : kind === 'password_reset'
            ? t('重置密码')
            : kind === 'email_verify'
              ? t('验证邮件')
              : kind;

  const [busy, setBusy] = useState(false);

  /* --------------------------- 统计 --------------------------- */
  const stats = useAsync(async () => {
    if (!siteId) return null;
    return backend.newsletterStats(siteId);
  }, [backend, siteId]);

  /* --------------------------- 名单 --------------------------- */
  const [statusFilter, setStatusFilter] = useState('');
  const [term, setTerm] = useState('');
  const [appliedTerm, setAppliedTerm] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Subscriber | null>(null);

  const subscriberQuery = useMemo(
    () => ({
      status: statusFilter || undefined,
      q: appliedTerm || undefined,
      limit: PAGE_SIZE,
    }),
    [statusFilter, appliedTerm],
  );

  const subscribers = useAsync(async () => {
    if (!siteId) return { items: [] as Subscriber[], next_cursor: '', has_more: false };
    return backend.listSubscribers(siteId, subscriberQuery);
  }, [backend, siteId, subscriberQuery]);

  const [moreSubscribers, setMoreSubscribers] = useState<{
    items: Subscriber[];
    cursor: string;
    loaded: boolean;
  }>({ items: [], cursor: '', loaded: false });

  // 换筛选条件就是新的一条分页链：已加载的下一页必须丢掉。
  useEffect(() => {
    setMoreSubscribers({ items: [], cursor: '', loaded: false });
  }, [subscribers.data]);

  const subscriberRows = useMemo(
    () => [...(subscribers.data?.items ?? []), ...moreSubscribers.items],
    [subscribers.data, moreSubscribers.items],
  );

  // 「加载更多」跑过之后，它拿到的游标（可能是空串）才是权威值。
  const nextSubscriberCursor = moreSubscribers.loaded
    ? moreSubscribers.cursor
    : (subscribers.data?.next_cursor ?? '');

  const loadMoreSubscribers = async () => {
    if (!siteId || !nextSubscriberCursor) return;
    setBusy(true);
    try {
      const page = await backend.listSubscribers(siteId, {
        ...subscriberQuery,
        cursor: nextSubscriberCursor,
      });
      setMoreSubscribers((prev) => ({
        items: [...prev.items, ...page.items],
        cursor: page.next_cursor,
        loaded: true,
      }));
    } catch (err) {
      toast.push('error', t('加载更多订阅者失败'), errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget || !siteId) return;
    setBusy(true);
    try {
      await backend.deleteSubscriber(siteId, deleteTarget.id);
      toast.push('ok', t('订阅者已删除'), deleteTarget.email);
      setDeleteTarget(null);
      subscribers.reload();
      stats.reload();
    } catch (err) {
      toast.push('error', t('无法删除订阅者'), errorText(err));
    } finally {
      setBusy(false);
    }
  };

  /* --------------------------- 模板 --------------------------- */
  const templates = useAsync(async () => {
    if (!siteId) return [] as EmailTemplate[];
    return backend.listEmailTemplates(siteId);
  }, [backend, siteId]);

  const [editKey, setEditKey] = useState('');
  const [draft, setDraft] = useState<TemplateDraft | null>(null);
  const [draftError, setDraftError] = useState('');
  const [confirmReset, setConfirmReset] = useState(false);

  const openTemplate = (template: EmailTemplate) => {
    setEditKey(template.key);
    setDraft({
      name: template.name,
      subject: template.subject,
      body_html: template.body_html,
      body_text: template.body_text,
      enabled: template.enabled,
    });
    setDraftError('');
    setConfirmReset(false);
  };

  const closeTemplate = () => {
    setEditKey('');
    setDraft(null);
    setDraftError('');
    setConfirmReset(false);
  };

  const saveTemplate = async () => {
    if (!draft || !editKey || !siteId) return;
    if (!draft.subject.trim()) {
      setDraftError(t('主题不能为空。'));
      return;
    }
    setDraftError('');
    setBusy(true);
    try {
      await backend.saveEmailTemplate(siteId, editKey, {
        name: draft.name.trim(),
        subject: draft.subject.trim(),
        body_html: draft.body_html,
        body_text: draft.body_text,
        enabled: draft.enabled,
      });
      toast.push('ok', t('模板已保存'), draft.name.trim() || editKey);
      templates.reload();
      closeTemplate();
    } catch (err) {
      setDraftError(errorText(err) || t('保存失败。'));
    } finally {
      setBusy(false);
    }
  };

  const resetTemplate = async () => {
    if (!editKey || !siteId) return;
    setDraftError('');
    setBusy(true);
    try {
      await backend.resetEmailTemplate(siteId, editKey);
      toast.push('ok', t('已恢复内置默认模板'), editKey);
      templates.reload();
      closeTemplate();
    } catch (err) {
      setDraftError(errorText(err) || t('恢复默认失败。'));
    } finally {
      setBusy(false);
    }
  };

  /* --------------------------- 日志 --------------------------- */
  const [logStatus, setLogStatus] = useState('');
  const [logKind, setLogKind] = useState('');
  // 游标分页：cursors[i] 是第 i 页的起始游标，空串代表第一页。
  const [logCursors, setLogCursors] = useState<string[]>(['']);
  const [logPage, setLogPage] = useState(0);
  const logCursor = logCursors[logPage] ?? '';

  const logs = useAsync(async () => {
    if (!siteId) return { items: [] as EmailLog[], next_cursor: '', has_more: false };
    return backend.listEmailLogs(siteId, {
      status: logStatus || undefined,
      kind: logKind || undefined,
      limit: PAGE_SIZE,
      cursor: logCursor || undefined,
    });
  }, [backend, siteId, logStatus, logKind, logCursor]);

  const resetLogPage = () => {
    setLogCursors(['']);
    setLogPage(0);
  };

  const nextLogPage = () => {
    const cursor = logs.data?.next_cursor ?? '';
    if (!cursor) return;
    setLogCursors((prev) => {
      const next = prev.slice(0, logPage + 1);
      next[logPage + 1] = cursor;
      return next;
    });
    setLogPage(logPage + 1);
  };

  const prevLogPage = () => setLogPage(Math.max(0, logPage - 1));

  /* --------------------------- 发送 --------------------------- */
  const [sendSubject, setSendSubject] = useState('');
  const [sendHtml, setSendHtml] = useState('');
  const [sendText, setSendText] = useState('');
  const [contentId, setContentId] = useState('');
  const [sendError, setSendError] = useState('');
  const [confirmSend, setConfirmSend] = useState(false);

  const reach = stats.data?.confirmed ?? 0;

  const requestSend = () => {
    setSendError('');
    if (!sendSubject.trim()) {
      setSendError(t('请填写邮件主题。'));
      return;
    }
    if (!sendHtml.trim() && !sendText.trim()) {
      setSendError(t('请填写正文（HTML 或纯文本至少一项）。'));
      return;
    }
    setConfirmSend(true);
  };

  const sendNow = async () => {
    if (!siteId) return;
    setBusy(true);
    try {
      const subject = sendSubject.trim();
      const result = await backend.sendNewsletter(siteId, {
        subject,
        body_html: sendHtml,
        body_text: sendText.trim() || htmlToText(sendHtml),
        ...(contentId.trim() ? { content_id: contentId.trim() } : {}),
      });
      toast.push('ok', t('已入队 {count} 封', { count: result.queued }));
      setConfirmSend(false);
      setSendSubject('');
      setSendHtml('');
      setSendText('');
      setContentId('');
      stats.reload();
      subscribers.reload();
      logs.reload();
    } catch (err) {
      setConfirmSend(false);
      setSendError(errorText(err) || t('发送失败。'));
      toast.push('error', t('无法发送刊物'), errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const refreshAll = () => {
    stats.reload();
    subscribers.reload();
    templates.reload();
    logs.reload();
  };

  const tabs: { key: TabKey; label: string }[] = [
    { key: 'list', label: t('订阅名单') },
    { key: 'templates', label: t('邮件模板') },
    { key: 'logs', label: t('发送日志') },
    { key: 'send', label: t('发送') },
  ];

  const statValue = (value: number | undefined) =>
    stats.loading ? '—' : String(value ?? 0);

  return (
    <RoleGate capability="manage_site" need={t('站点管理员权限')}>
      <div className="admin-page-head">
        <div>
          <h1>{t('邮件订阅')}</h1>
          <p>{t('管理订阅名单、确认与退订邮件模板、发送记录，并向已确认订阅者发送刊物。')}</p>
        </div>
        <div className="admin-page-actions">
          <Button variant="ghost" size="sm" icon="refresh" onClick={refreshAll}>
            {t('刷新')}
          </Button>
        </div>
      </div>

      <Callout tone="info" icon="mail" title={t('邮件订阅的工作方式')}>
        {t(
          '读者提交邮箱后会收到一封确认邮件，只有点过确认链接的地址才算「已确认」，也才会收到刊物。',
        )}
      </Callout>

      <div className="toolbar mt-20">
        <Tabs value={tab} onChange={setTab} items={tabs} />
      </div>

      {/* ------------------------------ 名单 ------------------------------ */}
      {tab === 'list' ? (
        <div className="mt-20">
          {stats.error ? (
            <Callout tone="danger" icon="alert" title={t('无法读取订阅统计')}>
              <p>{errorText(stats.error) || t('读取失败，请重试。')}</p>
              <div className="mt-12">
                <Button variant="secondary" size="sm" onClick={stats.reload}>
                  {t('重试')}
                </Button>
              </div>
            </Callout>
          ) : (
            <div className="stat-grid">
              <div className="stat is-accent">
                <span>{t('已确认订阅')}</span>
                <b>{statValue(stats.data?.confirmed)}</b>
                <small>{t('会收到刊物')}</small>
              </div>
              <div className="stat is-warn">
                <span>{t('待确认')}</span>
                <b>{statValue(stats.data?.pending)}</b>
                <small>{t('等待点确认链接')}</small>
              </div>
              <div className="stat">
                <span>{t('已退订')}</span>
                <b>{statValue(stats.data?.unsubscribed)}</b>
                <small>{t('不再接收邮件')}</small>
              </div>
              <div className="stat">
                <span>{t('近 7 天发送')}</span>
                <b>{statValue(stats.data?.sent_7d)}</b>
                <small>{t('失败 {count} 封', { count: stats.data?.failed_7d ?? 0 })}</small>
              </div>
            </div>
          )}

          <div className="toolbar mt-16" style={{ flexWrap: 'wrap', gap: 8 }}>
            <Select
              value={statusFilter}
              aria-label={t('订阅状态')}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="">{t('全部状态')}</option>
              {SUBSCRIBER_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {statusLabel(status)}
                </option>
              ))}
            </Select>
            <div className="inline-search" style={{ width: 240 }}>
              <Icon name="search" size={14} />
              <Input
                value={term}
                onChange={(event) => setTerm(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') setAppliedTerm(term.trim());
                }}
                placeholder={t('搜索邮箱，回车确认')}
                aria-label={t('搜索订阅者邮箱')}
              />
            </div>
            {appliedTerm ? (
              <Button
                variant="quiet"
                size="sm"
                icon="close"
                onClick={() => {
                  setTerm('');
                  setAppliedTerm('');
                }}
              >
                {t('清除搜索')}
              </Button>
            ) : null}
            <span className="toolbar-spacer" />
            <span className="tiny faint">
              {t('共 {count} 位订阅者', { count: subscriberRows.length })}
            </span>
          </div>

          {subscribers.error ? (
            <Callout tone="danger" icon="alert" title={t('无法读取订阅名单')}>
              <p>{errorText(subscribers.error) || t('读取失败，请重试。')}</p>
              <div className="mt-12">
                <Button variant="secondary" size="sm" onClick={subscribers.reload}>
                  {t('重试')}
                </Button>
              </div>
            </Callout>
          ) : subscribers.loading ? (
            <div className="panel mt-16">
              <div className="panel-body">
                <Skeleton lines={6} />
              </div>
            </div>
          ) : subscriberRows.length === 0 ? (
            <div className="panel mt-16">
              <div className="panel-body">
                <EmptyState
                  icon="users"
                  title={
                    appliedTerm || statusFilter ? t('没有匹配的订阅者') : t('还没有订阅者')
                  }
                  body={
                    appliedTerm || statusFilter
                      ? t('换一个关键词或筛选条件，或清除筛选。')
                      : t('读者在页脚或登录页订阅后，邮箱会出现在这里。')
                  }
                />
              </div>
            </div>
          ) : (
            <div className="panel mt-16">
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('邮箱')}</th>
                      <th>{t('状态')}</th>
                      <th>{t('来源')}</th>
                      <th>{t('确认时间')}</th>
                      <th>{t('最近发送')}</th>
                      <th style={{ width: 110 }}>{t('操作')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {subscriberRows.map((subscriber) => (
                      <tr key={subscriber.id}>
                        <td className="tiny mono">{subscriber.email}</td>
                        <td>
                          <Badge tone={statusTone(subscriber.status)} dot>
                            {statusLabel(subscriber.status)}
                          </Badge>
                        </td>
                        <td className="tiny muted">{sourceLabel(subscriber.source)}</td>
                        <td className="tiny muted">
                          {subscriber.confirmed_at ? formatDateTime(subscriber.confirmed_at) : '—'}
                        </td>
                        <td className="tiny muted">
                          {subscriber.last_sent_at ? formatDateTime(subscriber.last_sent_at) : '—'}
                        </td>
                        <td>
                          <div className="table-actions">
                            <button
                              type="button"
                              className="link-btn is-danger"
                              disabled={busy}
                              onClick={() => setDeleteTarget(subscriber)}
                            >
                              {t('删除订阅者')}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {nextSubscriberCursor ? (
            <div className="mt-16" style={{ textAlign: 'center' }}>
              <Button
                variant="secondary"
                size="sm"
                loading={busy}
                onClick={() => void loadMoreSubscribers()}
              >
                {t('加载更多')}
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* ------------------------------ 模板 ------------------------------ */}
      {tab === 'templates' ? (
        <div className="mt-20">
          {templates.error ? (
            <Callout tone="danger" icon="alert" title={t('无法读取邮件模板')}>
              <p>{errorText(templates.error) || t('读取失败，请重试。')}</p>
              <div className="mt-12">
                <Button variant="secondary" size="sm" onClick={templates.reload}>
                  {t('重试')}
                </Button>
              </div>
            </Callout>
          ) : templates.loading ? (
            <div className="panel">
              <div className="panel-body">
                <Skeleton lines={5} />
              </div>
            </div>
          ) : (templates.data ?? []).length === 0 ? (
            <div className="panel">
              <div className="panel-body">
                <EmptyState
                  icon="mail"
                  title={t('还没有邮件模板')}
                  body={t('服务端会提供内置模板；如果这里为空，请先确认后端版本。')}
                />
              </div>
            </div>
          ) : (
            <div className="panel">
              <div className="panel-body">
                {(templates.data ?? []).map((template) => (
                  <div className="mini-row" key={template.key}>
                    <div style={{ minWidth: 0 }}>
                      <div className="row gap-8" style={{ alignItems: 'center' }}>
                        <span className="cell-title">{template.name}</span>
                        {template.builtin ? <Badge tone="neutral">{t('内置')}</Badge> : null}
                        {template.enabled ? null : (
                          <Badge tone="muted">{t('模板已停用')}</Badge>
                        )}
                      </div>
                      <div className="tiny faint mono">{template.key}</div>
                      <div className="tiny muted">{template.subject}</div>
                      {template.updated_at ? (
                        <div className="tiny faint">
                          {t('上次修改：{time}', { time: formatDateTime(template.updated_at) })}
                        </div>
                      ) : null}
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      icon="edit"
                      onClick={() => openTemplate(template)}
                    >
                      {t('编辑模板')}
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      ) : null}

      {/* ------------------------------ 日志 ------------------------------ */}
      {tab === 'logs' ? (
        <div className="mt-20">
          <div className="toolbar" style={{ flexWrap: 'wrap', gap: 8 }}>
            <Select
              value={logStatus}
              aria-label={t('发送状态')}
              onChange={(event) => {
                setLogStatus(event.target.value);
                resetLogPage();
              }}
            >
              <option value="">{t('全部发送状态')}</option>
              {LOG_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {logStatusLabel(status)}
                </option>
              ))}
            </Select>
            <Select
              value={logKind}
              aria-label={t('邮件类型')}
              onChange={(event) => {
                setLogKind(event.target.value);
                resetLogPage();
              }}
            >
              <option value="">{t('全部邮件类型')}</option>
              {LOG_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kindLabel(kind)}
                </option>
              ))}
            </Select>
            <span className="toolbar-spacer" />
            <span className="tiny faint">{t('第 {page} 页', { page: logPage + 1 })}</span>
          </div>

          {logs.error ? (
            <Callout tone="danger" icon="alert" title={t('无法读取发送日志')}>
              <p>{errorText(logs.error) || t('读取失败，请重试。')}</p>
              <div className="mt-12">
                <Button variant="secondary" size="sm" onClick={logs.reload}>
                  {t('重试')}
                </Button>
              </div>
            </Callout>
          ) : logs.loading ? (
            <div className="panel mt-16">
              <div className="panel-body">
                <Skeleton lines={6} />
              </div>
            </div>
          ) : (logs.data?.items ?? []).length === 0 ? (
            <div className="panel mt-16">
              <div className="panel-body">
                <EmptyState
                  icon="mail"
                  title={t('还没有发送记录')}
                  body={t('确认邮件、刊物与找回密码邮件发出后都会留下记录。')}
                />
              </div>
            </div>
          ) : (
            <div className="panel mt-16">
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>{t('收件人')}</th>
                      <th>{t('类型')}</th>
                      <th>{t('邮件主题')}</th>
                      <th>{t('状态')}</th>
                      <th>{t('错误')}</th>
                      <th>{t('时间')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(logs.data?.items ?? []).map((log) => (
                      <tr key={log.id}>
                        <td className="tiny mono">{log.to_email}</td>
                        <td className="tiny muted">{kindLabel(log.kind)}</td>
                        <td className="tiny">{log.subject || '—'}</td>
                        <td>
                          <Badge tone={logStatusTone(log.status)} dot>
                            {logStatusLabel(log.status)}
                          </Badge>
                        </td>
                        <td className="tiny muted" style={{ maxWidth: 220 }}>
                          {log.error ? log.error : '—'}
                        </td>
                        <td className="tiny muted">
                          {formatDateTime(log.sent_at ?? log.created_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="row gap-8 mt-16" style={{ justifyContent: 'center' }}>
            <Button
              variant="ghost"
              size="sm"
              icon="chevron-left"
              disabled={logPage === 0 || logs.loading}
              onClick={prevLogPage}
            >
              {t('上一页')}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              iconRight="chevron-right"
              disabled={!logs.data?.has_more || logs.loading}
              onClick={nextLogPage}
            >
              {t('下一页')}
            </Button>
          </div>
        </div>
      ) : null}

      {/* ------------------------------ 发送 ------------------------------ */}
      {tab === 'send' ? (
        <div className="mt-20">
          <Callout tone="warn" icon="alert" title={t('发送前请确认')}>
            {t(
              '刊物只发给「已确认」的订阅者；未配置 SMTP 时，入队的邮件不会真正发出，会在发送日志里被记为 skipped。',
            )}
            <span style={{ display: 'block', marginTop: 8 }}>
              <Link to="/admin/login-settings" className="text-link">
                {t('配置 SMTP')}
              </Link>
            </span>
          </Callout>

          <div className="panel mt-16">
            <div className="panel-body form-stack">
              {sendError ? (
                <Callout tone="danger" icon="alert">
                  {sendError}
                </Callout>
              ) : null}
              <Field label={t('邮件主题')} htmlFor="newsletter-subject">
                <Input
                  id="newsletter-subject"
                  value={sendSubject}
                  maxLength={200}
                  placeholder={t('例如：本周新文章')}
                  onChange={(event) => setSendSubject(event.target.value)}
                />
              </Field>
              <Field
                label={t('HTML 正文')}
                htmlFor="newsletter-body-html"
                hint={t('可以用富文本编辑器写好后粘贴 HTML；留空时只发纯文本。')}
              >
                <Textarea
                  id="newsletter-body-html"
                  rows={8}
                  value={sendHtml}
                  onChange={(event) => setSendHtml(event.target.value)}
                />
              </Field>
              <Field
                label={t('纯文本正文')}
                htmlFor="newsletter-body-text"
                hint={t('纯文本用于不支持 HTML 的邮件客户端；留空时由 HTML 自动生成。')}
              >
                <Textarea
                  id="newsletter-body-text"
                  rows={5}
                  value={sendText}
                  onChange={(event) => setSendText(event.target.value)}
                />
              </Field>
              <Field
                label={t('关联内容 ID（可选）')}
                htmlFor="newsletter-content-id"
                hint={t('填写内容 ID 后，服务端会把该内容渲染进邮件模板。')}
              >
                <Input
                  id="newsletter-content-id"
                  value={contentId}
                  placeholder="cnt_…"
                  onChange={(event) => setContentId(event.target.value)}
                />
              </Field>
              <p className="small muted">
                {t('预计触达 {count} 封（已确认订阅者）', { count: reach })}
              </p>
              <div className="row gap-8" style={{ alignItems: 'center' }}>
                <Button icon="send" onClick={requestSend}>
                  {t('发送刊物')}
                </Button>
                <span className="tiny faint">{t('发送前会再确认一次。')}</span>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {/* ------------------------------ 模板编辑弹窗 ------------------------------ */}
      <Modal
        open={!!draft}
        title={draft ? t('编辑模板：{name}', { name: draft.name || editKey }) : ''}
        description={t(
          '支持的占位符由模板决定，例如 {link}、{title}、{url}；请保留原样。',
        )}
        onClose={closeTemplate}
        width={720}
        footer={
          <>
            <Button variant="ghost" onClick={closeTemplate}>
              {t('取消')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => setConfirmReset(true)}
              disabled={busy || confirmReset}
            >
              {t('恢复默认')}
            </Button>
            <Button loading={busy} onClick={() => void saveTemplate()} icon="check">
              {t('保存模板')}
            </Button>
          </>
        }
      >
        {draft ? (
          <div className="form-stack">
            {draftError ? (
              <Callout tone="danger" icon="alert">
                {draftError}
              </Callout>
            ) : null}
            <Field label={t('模板名称')} htmlFor="newsletter-template-name">
              <Input
                id="newsletter-template-name"
                value={draft.name}
                maxLength={120}
                onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              />
            </Field>
            <Field
              label={t('邮件主题')}
              htmlFor="newsletter-template-subject"
              hint={t('可以包含占位符，例如「新文章：{title}」。')}
            >
              <Input
                id="newsletter-template-subject"
                value={draft.subject}
                maxLength={200}
                onChange={(event) => setDraft({ ...draft, subject: event.target.value })}
              />
            </Field>
            <Field label={t('HTML 正文')} htmlFor="newsletter-template-html">
              <Textarea
                id="newsletter-template-html"
                rows={6}
                value={draft.body_html}
                onChange={(event) => setDraft({ ...draft, body_html: event.target.value })}
              />
            </Field>
            <Field
              label={t('纯文本正文')}
              htmlFor="newsletter-template-text"
              hint={t('纯文本用于不支持 HTML 的邮件客户端。')}
            >
              <Textarea
                id="newsletter-template-text"
                rows={5}
                value={draft.body_text}
                onChange={(event) => setDraft({ ...draft, body_text: event.target.value })}
              />
            </Field>
            <Toggle
              checked={draft.enabled}
              onChange={(next) => setDraft({ ...draft, enabled: next })}
              label={t('启用这个模板')}
              description={t('停用后服务端不会用它发信，但模板内容会保留。')}
            />
            {confirmReset ? (
              <Callout tone="warn" icon="alert" title={t('恢复内置默认？')}>
                {t('当前保存的主题与正文会被丢弃，无法撤销。')}
                <div className="row gap-8 mt-12">
                  <Button
                    variant="danger"
                    size="sm"
                    loading={busy}
                    onClick={() => void resetTemplate()}
                  >
                    {t('确认恢复默认')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setConfirmReset(false)}>
                    {t('取消')}
                  </Button>
                </div>
              </Callout>
            ) : null}
          </div>
        ) : null}
      </Modal>

      {/* ------------------------------ 发送确认弹窗 ------------------------------ */}
      <Modal
        open={confirmSend}
        title={t('确认发送这封刊物？')}
        description={t('预计触达 {count} 封（已确认订阅者）', { count: reach })}
        onClose={() => setConfirmSend(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmSend(false)}>
              {t('取消')}
            </Button>
            <Button loading={busy} icon="send" onClick={() => void sendNow()}>
              {t('确认发送')}
            </Button>
          </>
        }
      >
        <Callout tone="warn" icon="alert">
          {t('发送后无法撤回；每一封的入队记录都会出现在「发送日志」里。')}
        </Callout>
        <p className="small muted mt-10">
          {t('邮件主题：{subject}', { subject: sendSubject.trim() || '—' })}
        </p>
      </Modal>

      {/* ------------------------------ 删除确认弹窗 ------------------------------ */}
      <Modal
        open={!!deleteTarget}
        title={deleteTarget ? t('删除订阅者 {email}？', { email: deleteTarget.email }) : ''}
        description={t(
          '删除后这个邮箱不会出现在名单里，也不会再收到刊物；对方之后可以重新订阅。',
        )}
        onClose={() => setDeleteTarget(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              {t('取消')}
            </Button>
            <Button variant="danger" loading={busy} icon="trash" onClick={() => void confirmDelete()}>
              {t('删除订阅者')}
            </Button>
          </>
        }
      >
        <Callout tone="warn" icon="alert" title={t('这个操作无法撤销')}>
          {t('如果只是想暂停发信，可以把状态筛选到「已退订」查看对方是否自己退订了。')}
        </Callout>
      </Modal>
    </RoleGate>
  );
}
