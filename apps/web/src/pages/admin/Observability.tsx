import { useState, type FormEvent } from 'react';
import type { QueueEventItem } from '../../types';
import { useAuth } from '../../lib/session';
import { useBackend } from '../../lib/backend';
import { errorText, useAsync, useTitle } from '../../lib/hooks';
import { useT } from '../../lib/i18n';
import { formatBytes, formatDateTime } from '../../lib/format';
import { activityActionLabel } from '../../lib/activityLabels';
import { useToast } from '../../lib/toast';
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  Input,
  Modal,
  Select,
  Skeleton,
  Tabs,
  Toggle,
} from '../../components/ui';

/**
 * 运行观察（`/admin/observability`）。
 *
 * 三块只读的服务端观测数据合在一页：
 * - 请求日志：进程内环形缓冲的请求元数据，可按状态码 / 路径片段 / 方法筛选；
 * - 队列：outbox 积压、邮件队列与最近事件，失败事件可以人工重投；
 * - 自动备份：`BACKUP_AUTO_*` 计划与产物，只对平台管理员开放。
 *
 * 每个分区独立请求、独立加载 / 空 / 错误态：一个接口失败不会把整页拖垮；
 * 写操作只有「重投失败事件」一个，并且带二次确认。
 */

type TabKey = 'logs' | 'queue' | 'backup';
type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'muted' | 'accent';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;

/** 状态码徽标：2xx 正常，3xx 跳转，4xx 客户端错误，5xx 服务端错误。 */
function statusTone(status: number): Tone {
  if (status >= 500) return 'danger';
  if (status >= 400) return 'warn';
  if (status >= 300) return 'accent';
  if (status >= 100) return 'ok';
  return 'neutral';
}

/** outbox 事件状态徽标。 */
function eventTone(status: QueueEventItem['status']): Tone {
  if (status === 'failed') return 'danger';
  if (status === 'published') return 'ok';
  return 'warn';
}

export function ObservabilityPage() {
  const t = useT();
  const [tab, setTab] = useState<TabKey>('logs');
  useTitle(t('运行观察'));

  return (
    <>
      <div className="admin-page-head">
        <div>
          <h1>{t('运行观察')}</h1>
          <p>
            {t(
              '服务端请求日志、任务队列与自动备份状态。日志只保留元数据，整页只读；唯一的写操作是重投失败事件。',
            )}
          </p>
        </div>
      </div>

      <Tabs<TabKey>
        value={tab}
        onChange={setTab}
        items={[
          { key: 'logs', label: t('请求日志') },
          { key: 'queue', label: t('队列') },
          { key: 'backup', label: t('自动备份') },
        ]}
      />

      <div className="mt-16">
        {tab === 'logs' ? <LogsTab /> : null}
        {tab === 'queue' ? <QueueTab /> : null}
        {tab === 'backup' ? <BackupTab /> : null}
      </div>
    </>
  );
}

/* ------------------------------ 请求日志 ------------------------------ */

function LogsTab() {
  const t = useT();
  const backend = useBackend();
  const [statusText, setStatusText] = useState('');
  const [pathText, setPathText] = useState('');
  const [method, setMethod] = useState('');
  const [formError, setFormError] = useState('');
  const [filters, setFilters] = useState<{ status?: number; path?: string; method?: string }>({});

  const data = useAsync(() => backend.systemLogs({ limit: 200, ...filters }), [backend, filters]);
  const entries = data.data ?? [];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = statusText.trim();
    const parsed = Number(trimmed);
    if (trimmed && (!Number.isInteger(parsed) || parsed < 100 || parsed > 599)) {
      setFormError(t('状态码需要是 100–599 的整数。'));
      return;
    }
    setFormError('');
    // 始终新建对象：筛选条件没变时点「刷新」也要重新请求一次。
    setFilters({
      status: trimmed ? parsed : undefined,
      path: pathText.trim() || undefined,
      method: method || undefined,
    });
  };

  return (
    <>
      <form className="toolbar" style={{ flexWrap: 'wrap', gap: 8 }} onSubmit={submit}>
        <Input
          type="number"
          min={100}
          max={599}
          inputMode="numeric"
          value={statusText}
          onChange={(event) => setStatusText(event.target.value)}
          placeholder={t('状态码，例如 404')}
          aria-label={t('状态码')}
          style={{ width: 150 }}
        />
        <Input
          value={pathText}
          onChange={(event) => setPathText(event.target.value)}
          placeholder={t('路径片段，例如 /api/v1')}
          aria-label={t('路径片段')}
          style={{ minWidth: 220, flex: '1 1 220px' }}
        />
        <Select
          value={method}
          onChange={(event) => setMethod(event.target.value)}
          aria-label={t('方法')}
        >
          <option value="">{t('全部方法')}</option>
          {METHODS.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="secondary" size="sm" icon="refresh" loading={data.loading}>
          {t('刷新')}
        </Button>
      </form>

      {formError ? (
        <p className="field-error tiny" role="alert">
          {formError}
        </p>
      ) : null}

      <section className="panel mt-16">
        <div className="panel-head">
          <div>
            <h3>{t('请求日志')}</h3>
            <p>{t('只记录元数据，不含请求体、请求头与 cookie。')}</p>
          </div>
          <span className="tiny faint">{t('{count} 条请求', { count: entries.length })}</span>
        </div>
        <div className="panel-body">
          {data.loading ? (
            <Skeleton lines={5} />
          ) : data.error ? (
            <Callout tone="danger" icon="alert" title={t('无法读取请求日志')}>
              <p>{errorText(data.error) || t('请求失败。')}</p>
              <div className="mt-12">
                <Button variant="secondary" size="sm" icon="refresh" onClick={data.reload}>
                  {t('重试')}
                </Button>
              </div>
            </Callout>
          ) : entries.length === 0 ? (
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
                  {entries.map((entry) => (
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
      </section>
    </>
  );
}

/* -------------------------------- 队列 -------------------------------- */

function QueueTab() {
  const t = useT();
  const backend = useBackend();
  const toast = useToast();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const data = useAsync(() => backend.systemQueue(), [backend]);
  const queue = data.data;

  /** 秒 → 可读时长；不足一分钟按秒，其余取整到单一单位。 */
  const durationText = (seconds: number): string => {
    const total = Math.max(0, Math.floor(seconds));
    if (total < 60) return t('{count} 秒', { count: total });
    if (total < 3600) return t('约 {count} 分钟', { count: Math.floor(total / 60) });
    if (total < 86_400) return t('约 {count} 小时', { count: Math.floor(total / 3600) });
    return t('约 {count} 天', { count: Math.floor(total / 86_400) });
  };

  const eventLabel = (status: QueueEventItem['status']): string =>
    status === 'published' ? t('已投递') : status === 'failed' ? t('失败') : t('待投递');

  const retry = async () => {
    setRetrying(true);
    try {
      // 空数组表示由服务端重投最近 50 条失败事件。
      const result = await backend.retryQueue();
      toast.push('ok', t('已重投 {count} 条事件', { count: result.retried }));
      setConfirmOpen(false);
      data.reload();
    } catch (err) {
      toast.push('error', t('重投失败'), errorText(err) || t('请求失败。'));
    } finally {
      setRetrying(false);
    }
  };

  return (
    <>
      {data.loading ? (
        <section className="panel">
          <div className="panel-body">
            <Skeleton lines={5} />
          </div>
        </section>
      ) : data.error ? (
        <Callout tone="danger" icon="alert" title={t('无法读取队列状态')}>
          <p>{errorText(data.error) || t('请求失败。')}</p>
          <div className="mt-12">
            <Button variant="secondary" size="sm" icon="refresh" onClick={data.reload}>
              {t('重试')}
            </Button>
          </div>
        </Callout>
      ) : queue ? (
        <>
          <div className="stat-grid is-three">
            <div className="stat">
              <span>{t('待投递')}</span>
              <b>{queue.outbox.pending}</b>
              <small>{t('outbox 中等待投递的事件')}</small>
            </div>
            <div className="stat is-warn">
              <span>{t('失败')}</span>
              <b>{queue.outbox.failed}</b>
              <small>{t('需要人工重投')}</small>
            </div>
            <div className="stat">
              <span>{t('最老待投递时长')}</span>
              <b>{durationText(queue.outbox.oldest_age_seconds)}</b>
              <small>{t('积压越久越可能丢事件')}</small>
            </div>
          </div>

          <section className="panel mt-20">
            <div className="panel-head">
              <div>
                <h3>{t('邮件队列')}</h3>
                <p>{t('事务邮件的发送队列；失败项会保留在服务端，等待重试或清理。')}</p>
              </div>
            </div>
            <div className="panel-body">
              <div className="mini-row">
                <span className="small">{t('排队中')}</span>
                <Badge tone={queue.mail.queued > 0 ? 'warn' : 'ok'} dot>
                  {queue.mail.queued}
                </Badge>
              </div>
              <div className="mini-row">
                <span className="small">{t('失败')}</span>
                <Badge tone={queue.mail.failed > 0 ? 'danger' : 'ok'} dot>
                  {queue.mail.failed}
                </Badge>
              </div>
            </div>
          </section>

          <section className="panel mt-20">
            <div className="panel-head">
              <div>
                <h3>{t('最近事件')}</h3>
                <p>{t('outbox 最近处理的事件；失败的事件可以重投。')}</p>
              </div>
              <Button
                variant="secondary"
                size="sm"
                icon="refresh"
                disabled={retrying}
                onClick={() => setConfirmOpen(true)}
              >
                {t('重投失败事件')}
              </Button>
            </div>
            <div className="panel-body">
              {queue.recent.length === 0 ? (
                <p className="small muted">{t('还没有队列事件。')}</p>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{t('事件类型')}</th>
                        <th>{t('状态')}</th>
                        <th style={{ textAlign: 'right' }}>{t('尝试次数')}</th>
                        <th>{t('最后错误')}</th>
                        <th>{t('时间')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {queue.recent.map((event) => (
                        <tr key={event.event_id}>
                          <td className="cell-title" title={event.event_type}>
                            {activityActionLabel(event.event_type, t)}
                          </td>
                          <td>
                            <Badge tone={eventTone(event.status)} dot>
                              {eventLabel(event.status)}
                            </Badge>
                          </td>
                          <td className="cell-num">{event.attempts}</td>
                          <td className="tiny faint">{event.last_error || '—'}</td>
                          <td>{formatDateTime(event.occurred_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </section>
        </>
      ) : null}

      {/* 重投是写操作：先确认再发出，避免误点把失败事件又推进队列。 */}
      <Modal
        open={confirmOpen}
        title={t('重投失败事件')}
        description={t('重新投递最近 50 条失败的 outbox 事件。')}
        onClose={() => (retrying ? undefined : setConfirmOpen(false))}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={retrying}>
              {t('取消')}
            </Button>
            <Button variant="secondary" icon="refresh" loading={retrying} onClick={() => void retry()}>
              {t('确认重投')}
            </Button>
          </>
        }
      >
        <Callout tone="warn" icon="alert" title={t('这会改变队列状态')}>
          {t(
            '重投会把失败事件重新排入投递队列；如果根因未修复，它们可能再次失败。',
          )}
        </Callout>
      </Modal>
    </>
  );
}

/* ------------------------------ 自动备份 ------------------------------ */

function BackupTab() {
  const t = useT();
  const { me } = useAuth();
  const backend = useBackend();
  const isPlatformAdmin = me?.role === 'platform_admin';

  const data = useAsync(async () => {
    if (!isPlatformAdmin) return null;
    return backend.backupSchedule();
  }, [backend, isPlatformAdmin]);

  const schedule = data.data;

  if (!isPlatformAdmin) {
    return (
      <Callout tone="info" icon="shield" title={t('需要平台管理员权限')}>
        {t('自动备份计划只对平台管理员开放。')}
      </Callout>
    );
  }

  if (data.loading) {
    return (
      <section className="panel">
        <div className="panel-body">
          <Skeleton lines={6} />
        </div>
      </section>
    );
  }

  if (data.error) {
    return (
      <Callout tone="danger" icon="alert" title={t('无法读取备份计划')}>
        <p>{errorText(data.error) || t('请求失败。')}</p>
        <div className="mt-12">
          <Button variant="secondary" size="sm" icon="refresh" onClick={data.reload}>
            {t('重试')}
          </Button>
        </div>
      </Callout>
    );
  }

  if (!schedule) return null;

  const lastStatus = schedule.last_status;
  const lastStatusLabel =
    lastStatus === 'success' ? t('成功') : lastStatus === 'failed' ? t('失败') : (lastStatus ?? '—');
  const lastStatusTone: Tone =
    lastStatus === 'success' ? 'ok' : lastStatus === 'failed' ? 'danger' : 'neutral';

  return (
    <>
      <section className="panel">
        <div className="panel-head">
          <div>
            <h3>{t('自动备份计划')}</h3>
            <p>{t('计划来自部署环境变量，页面只读。')}</p>
          </div>
          <Badge tone={schedule.enabled ? 'ok' : 'muted'} dot>
            {schedule.enabled ? t('已启用') : t('未启用')}
          </Badge>
        </div>
        <div className="panel-body">
          <Toggle
            checked={schedule.enabled}
            onChange={() => undefined}
            disabled
            label={t('自动备份')}
            description={t('计划来自部署环境变量，页面只读。')}
          />

          {schedule.enabled ? null : (
            <div className="mt-16">
              <Callout tone="warn" icon="alert" title={t('自动备份未启用')}>
                {t('未启用，需在部署环境变量中开启。')}
              </Callout>
            </div>
          )}

          <div className="stat-grid mt-20">
            <div className="stat">
              <span>{t('每天运行')}</span>
              <b>{formatHour(schedule.hour)}</b>
              <small>{t('服务器本地时间')}</small>
            </div>
            <div className="stat">
              <span>{t('保留份数')}</span>
              <b>{schedule.keep}</b>
              <small>{t('超出后删除最旧的备份')}</small>
            </div>
            <div className="stat">
              <span>{t('上次运行')}</span>
              <b>{formatDateTime(schedule.last_run_at)}</b>
              <small>
                {lastStatus ? (
                  <Badge tone={lastStatusTone} dot>
                    {lastStatusLabel}
                  </Badge>
                ) : (
                  t('从未运行过')
                )}
              </small>
            </div>
            <div className="stat">
              <span>{t('下次运行')}</span>
              <b>{formatDateTime(schedule.next_run_at)}</b>
              <small>{schedule.enabled ? t('按每日计划自动执行') : t('计划未启用')}</small>
            </div>
          </div>

          {schedule.last_error ? (
            <div className="mt-16">
              <Callout tone="danger" icon="alert" title={t('上次运行失败')}>
                {schedule.last_error}
              </Callout>
            </div>
          ) : null}
        </div>
      </section>

      <section className="panel mt-20">
        <div className="panel-head">
          <div>
            <h3>{t('备份产物')}</h3>
            <p>{t('保留最近 {count} 份自动备份。', { count: schedule.keep })}</p>
          </div>
        </div>
        <div className="panel-body">
          {schedule.artifacts.length === 0 ? (
            <p className="small muted">{t('还没有自动备份产物。')}</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('文件名')}</th>
                    <th style={{ textAlign: 'right' }}>{t('大小')}</th>
                    <th>{t('创建时间')}</th>
                  </tr>
                </thead>
                <tbody>
                  {schedule.artifacts.map((artifact) => (
                    <tr key={artifact.name}>
                      <td className="cell-title mono" title={artifact.name}>
                        {artifact.name}
                      </td>
                      <td className="cell-num">{formatBytes(artifact.size)}</td>
                      <td>{formatDateTime(artifact.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </>
  );
}

/** 0–23 的小时 → 两位时钟文本；非法值直接原样显示，避免页面崩在脏数据上。 */
function formatHour(hour: number): string {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return String(hour);
  return `${String(hour).padStart(2, '0')}:00`;
}
