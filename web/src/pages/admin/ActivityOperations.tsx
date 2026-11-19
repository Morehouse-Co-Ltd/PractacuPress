import { useState, type FormEvent } from 'react';
import { useBackend } from '../../lib/backend';
import { errorText, useAsync } from '../../lib/hooks';
import { formatBytes, formatDateTime } from '../../lib/format';
import { useT } from '../../lib/i18n';
import type { SystemLogEntry } from '../../types';
import {
  Badge,
  Button,
  Callout,
  EmptyState,
  Input,
  Select,
  Skeleton,
} from '../../components/ui';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;
type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'muted' | 'accent';

function statusTone(status: number): Tone {
  if (status >= 500) return 'danger';
  if (status >= 400) return 'warn';
  if (status >= 300) return 'accent';
  if (status >= 100) return 'ok';
  return 'neutral';
}

export function RequestLogsSection() {
  const t = useT();
  const backend = useBackend();
  const [statusText, setStatusText] = useState('');
  const [pathText, setPathText] = useState('');
  const [method, setMethod] = useState('');
  const [formError, setFormError] = useState('');
  const [filters, setFilters] = useState<{ status?: number; path?: string; method?: string }>({});
  const data = useAsync(() => backend.systemLogs({ limit: 200, ...filters }), [backend, filters]);
  const entries: SystemLogEntry[] = data.data ?? [];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = statusText.trim();
    const parsed = Number(trimmed);
    if (trimmed && (!Number.isInteger(parsed) || parsed < 100 || parsed > 599)) {
      setFormError(t('状态码需要是 100–599 的整数。'));
      return;
    }
    setFormError('');
    setFilters({
      status: trimmed ? parsed : undefined,
      path: pathText.trim() || undefined,
      method: method || undefined,
    });
  };

  return (
    <section className="panel mt-20">
      <div className="panel-head">
        <div>
          <h3>{t('请求日志')}</h3>
          <p>{t('只记录元数据，不含请求体、请求头与 cookie。')}</p>
        </div>
        <div className="admin-page-actions">
          <span className="tiny faint">{t('{count} 条请求', { count: entries.length })}</span>
          <Button variant="ghost" size="sm" icon="refresh" onClick={data.reload} loading={data.loading}>
            {t('刷新')}
          </Button>
        </div>
      </div>
      <div className="panel-body">
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
          <Select value={method} onChange={(event) => setMethod(event.target.value)} aria-label={t('方法')}>
            <option value="">{t('全部方法')}</option>
            {METHODS.map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </Select>
          <Button type="submit" variant="secondary" size="sm" icon="filter">
            {t('筛选')}
          </Button>
        </form>
        {formError ? <p className="field-error tiny" role="alert">{formError}</p> : null}

        <div className="mt-16">
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
                      <td><Badge tone="muted">{entry.method}</Badge></td>
                      <td className="mono tiny" title={entry.path}>{entry.path}</td>
                      <td><Badge tone={statusTone(entry.status)} dot>{entry.status}</Badge></td>
                      <td className="cell-num">{entry.duration_ms} ms</td>
                      <td className="mono tiny faint" title={entry.request_id}>{entry.request_id}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

export function BackupScheduleSection() {
  const t = useT();
  const backend = useBackend();
  const data = useAsync(() => backend.backupSchedule(), [backend]);
  const schedule = data.data;
  const lastStatus = schedule?.last_status;
  const lastStatusTone: Tone =
    lastStatus === 'success' ? 'ok' : lastStatus === 'failed' ? 'danger' : 'neutral';
  const lastStatusLabel =
    lastStatus === 'success' ? t('成功') : lastStatus === 'failed' ? t('失败') : (lastStatus ?? '—');

  return (
    <section className="panel mt-20">
      <div className="panel-head">
        <div>
          <h3>{t('自动备份计划')}</h3>
          <p>{t('计划来自部署环境变量，页面只读。')}</p>
        </div>
        <div className="admin-page-actions">
          {schedule ? (
            <Badge tone={schedule.enabled ? 'ok' : 'muted'} dot>
              {schedule.enabled ? t('已启用') : t('未启用')}
            </Badge>
          ) : null}
          <Button variant="ghost" size="sm" icon="refresh" onClick={data.reload} loading={data.loading}>
            {t('刷新')}
          </Button>
        </div>
      </div>
      <div className="panel-body">
        {data.loading ? (
          <Skeleton lines={6} />
        ) : data.error ? (
          <Callout tone="danger" icon="alert" title={t('无法读取备份计划')}>
            <p>{errorText(data.error) || t('请求失败。')}</p>
            <div className="mt-12">
              <Button variant="secondary" size="sm" icon="refresh" onClick={data.reload}>
                {t('重试')}
              </Button>
            </div>
          </Callout>
        ) : schedule ? (
          <>
            {schedule.enabled ? null : (
              <Callout tone="warn" icon="alert" title={t('自动备份未启用')}>
                {t('未启用，需在部署环境变量中开启。')}
              </Callout>
            )}
            <div className="stat-grid">
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
                  {lastStatus ? <Badge tone={lastStatusTone} dot>{lastStatusLabel}</Badge> : t('从未运行过')}
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
            <div className="mt-20">
              <h4>{t('备份产物')}</h4>
              <p className="tiny faint">{t('保留最近 {count} 份自动备份。', { count: schedule.keep })}</p>
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
                          <td className="cell-title mono" title={artifact.name}>{artifact.name}</td>
                          <td className="cell-num">{formatBytes(artifact.size)}</td>
                          <td>{formatDateTime(artifact.created_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        ) : null}
      </div>
    </section>
  );
}

function formatHour(hour: number): string {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return String(hour);
  return `${String(hour).padStart(2, '0')}:00`;
}
