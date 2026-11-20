import { useBackend } from '../../lib/backend';
import { errorText, useAsync } from '../../lib/hooks';
import { formatBytes, formatDateTime } from '../../lib/format';
import { useT } from '../../lib/i18n';
import { Badge, Button, Callout, Skeleton } from '../../components/ui';

type Tone = 'neutral' | 'ok' | 'warn' | 'danger' | 'muted' | 'accent';

/**
 * 自动备份计划（只读）。
 *
 * 计划来自部署环境的 `BACKUP_AUTO_*` 变量，页面没有可写入口；这里只把「什么时候跑、
 * 保留几份、上次结果、下次时间、已有产物」摊开给平台管理员看。数据与备份页在实例备份
 * 之后渲染它，所以和实例备份放在同一处，不必再回网站日志页找。
 */
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
    <section className="panel">
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

/** 计划小时 →「09:00」；非法值原样显示，避免页面假装数据正常。 */
function formatHour(hour: number): string {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return String(hour);
  return `${String(hour).padStart(2, '0')}:00`;
}
