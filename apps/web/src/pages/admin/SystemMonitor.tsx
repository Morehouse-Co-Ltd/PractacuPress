import { useCallback, useEffect, useRef, useState } from 'react';
import type { SystemMetrics } from '../../types';
import { useAuth } from '../../lib/session';
import { isDemo, useBackend } from '../../lib/backend';
import { useTitle } from '../../lib/hooks';
import { useT } from '../../lib/i18n';
import { formatBytes } from '../../lib/format';
import {
  SYSTEM_RING_CIRCUMFERENCE,
  SYSTEM_RING_RADIUS,
  SYSTEM_SAMPLE_INTERVAL_MS,
  clampPercent,
  percentOf,
  ringDashOffset,
  uptimeParts,
} from '../../lib/systemMonitor';
import { Badge, Button, Callout, PageLoading } from '../../components/ui';
import { Icon } from '../../components/Icon';

/**
 * 性能面板（可选模块）。
 *
 * 后端 `GET /api/v1/system/metrics` 每 2 秒采样一次主机与进程；这里每 4 秒拉一份缓存
 * 快照，用三个圆环仪表盘展示 CPU / 内存 / 磁盘占用。页面只读，不做任何配置写入。
 *
 * 本页不是写死在路由里的核心页面，而是内置扩展 `pp.performance` 通过
 * `adminPageRegistry` 注册的扩展页（见 lib/extensions/builtin.tsx），地址为
 * `/admin/ext/system`；旧地址 `/admin/system` 会重定向过来。
 *
 * 模块可关：部署设置 `PP_SYSTEM_METRICS=off` 后后端不再提供指标，页面会显示
 * 「模块未启用」。
 */
export function SystemMonitorPage() {
  const t = useT();
  useTitle(t('性能面板'));
  const { me } = useAuth();
  const backend = useBackend();
  const demo = isDemo(backend);
  const isPlatformAdmin = me?.role === 'platform_admin';

  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [visible, setVisible] = useState(true);
  const aliveRef = useRef(true);

  const load = useCallback(async () => {
    if (!isPlatformAdmin || demo) {
      setLoading(false);
      return;
    }
    setRefreshing(true);
    try {
      const next = await backend.systemMetrics();
      if (!aliveRef.current) return;
      setMetrics(next);
      setError('');
    } catch (err) {
      if (!aliveRef.current) return;
      setError(err instanceof Error ? err.message : t('无法读取服务器指标。'));
    } finally {
      if (!aliveRef.current) return;
      setLoading(false);
      setRefreshing(false);
    }
  }, [backend, demo, isPlatformAdmin, t]);

  useEffect(() => {
    aliveRef.current = true;
    void load();
    return () => {
      aliveRef.current = false;
    };
  }, [load]);

  // 页面不可见时暂停轮询：后台标签页不该继续消耗请求。
  useEffect(() => {
    const onVisibility = () => setVisible(document.visibilityState !== 'hidden');
    onVisibility();
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  useEffect(() => {
    if (!visible || !isPlatformAdmin || demo || error) return;
    const timer = window.setInterval(() => {
      void load();
    }, SYSTEM_SAMPLE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [demo, error, isPlatformAdmin, load, visible]);

  const roleLabel = (role: string): string => {
    switch (role) {
      case 'api':
        return t('服务器 API');
      case 'security':
        return t('安全服务');
      case 'launcher':
        return t('启动器');
      case 'web':
        return t('前端（开发服务器）');
      case 'app':
        return t('附加进程');
      default:
        return t('未知角色');
    }
  };

  const uptime = metrics ? uptimeParts(metrics.platform.uptime_seconds) : null;
  const uptimeText = uptime
    ? uptime.days > 0
      ? t('{days} 天 {hours} 小时', { days: uptime.days, hours: uptime.hours })
      : uptime.hours > 0
        ? t('{hours} 小时 {minutes} 分钟', { hours: uptime.hours, minutes: uptime.minutes })
        : t('{minutes} 分钟', { minutes: uptime.minutes })
    : '';

  const head = (
    <div className="admin-page-head">
      <div>
        <h1>{t('性能面板')}</h1>
        <p>
          {t(
            '本软件与其他软件在这台服务器上的 CPU、内存与磁盘占用。数据由服务端每 2 秒采样，页面每 4 秒刷新。',
          )}
        </p>
      </div>
      <div className="admin-page-actions">
        <Badge tone="accent">{t('由内置扩展注册')}</Badge>
        {metrics ? (
          <Badge tone="muted">
            {t('采样于 {time}', { time: clockText(metrics.sampled_at) })}
          </Badge>
        ) : null}
        <Badge tone={visible ? 'ok' : 'muted'} dot={visible}>
          {visible ? t('自动刷新中') : t('已暂停（页面不可见）')}
        </Badge>
        <Button
          variant="ghost"
          size="sm"
          icon="refresh"
          loading={refreshing}
          onClick={() => void load()}
        >
          {t('刷新')}
        </Button>
      </div>
    </div>
  );

  if (!isPlatformAdmin) {
    return (
      <>
        {head}
        <Callout tone="warn" icon="shield" title={t('仅平台管理员可查看')}>
          {t('服务器指标包含主机名、路径与进程信息，只对平台管理员开放。')}
        </Callout>
      </>
    );
  }

  if (demo) {
    return (
      <>
        {head}
        <Callout tone="info" icon="database" title={t('演示模式没有服务器指标')}>
          {t(
            '演示数据只存在浏览器里，没有可采样的服务端；连接真实后端（启动.bat 或部署实例）后，这里会显示本机进程与磁盘占用。',
          )}
        </Callout>
      </>
    );
  }

  if (loading && !metrics) {
    return (
      <>
        {head}
        <PageLoading label={t('正在读取服务器指标')} />
      </>
    );
  }

  if (error && !metrics) {
    return (
      <>
        {head}
        <Callout tone="danger" icon="alert" title={t('无法读取服务器指标')}>
          <p>{error}</p>
          <p className="tiny faint mt-8">
            {t('部署可以通过 PP_SYSTEM_METRICS=off 关闭这个可选模块；关闭后本页不可用。')}
          </p>
          <div className="mt-12">
            <Button size="sm" variant="secondary" icon="refresh" onClick={() => void load()}>
              {t('重试')}
            </Button>
          </div>
        </Callout>
      </>
    );
  }

  if (!metrics) return <>{head}</>;

  const storage = metrics.app.storage;
  const appCpuShare = percentOf(metrics.app.cpu_percent, 100);
  const otherCpuShare = percentOf(metrics.others.cpu_percent, 100);
  const appMemoryShare = percentOf(metrics.app.memory_bytes, metrics.memory.used_bytes || metrics.app.memory_bytes);
  const otherMemoryShare = 100 - appMemoryShare;
  const appDiskShare = percentOf(storage.total_bytes, metrics.disk.used_bytes || storage.total_bytes);

  return (
    <>
      {head}

      {error ? (
        <div className="mb-16">
          <Callout tone="warn" icon="alert" title={t('本次刷新失败，显示的是上一份采样')}>
            {error}
          </Callout>
        </div>
      ) : null}

      <div className="sysmon-cards">
        <RingMetricCard
          tone="cpu"
          label={t('CPU 使用率')}
          percent={metrics.cpu.usage_percent}
          sub={t('{cores} 个逻辑核心', { cores: metrics.cpu.cores })}
          extra={metrics.cpu.model ? <span className="sysmon-model">{metrics.cpu.model}</span> : null}
        />

        <RingMetricCard
          tone="memory"
          label={t('内存使用')}
          percent={metrics.memory.usage_percent}
          sub={t('{used} / {total}', {
            used: formatBytes(metrics.memory.used_bytes),
            total: formatBytes(metrics.memory.total_bytes),
          })}
        />

        <RingMetricCard
          tone="disk"
          label={t('磁盘使用')}
          percent={metrics.disk.usage_percent}
          sub={t('{used} / {total}', {
            used: formatBytes(metrics.disk.used_bytes),
            total: formatBytes(metrics.disk.total_bytes),
          })}
          extra={<span className="sysmon-path mono">{metrics.disk.path}</span>}
        />

        <MetricCard
          tone="uptime"
          label={t('运行时长')}
          value={uptimeText || '—'}
          sub={t('{count} 个进程 · {os}/{arch}', {
            count: metrics.others.process_count,
            os: metrics.platform.os,
            arch: metrics.platform.arch,
          })}
          extra={<span className="sysmon-path mono">{metrics.platform.hostname}</span>}
        >
          <div className="sysmon-legend">
            <span>
              <i className="sysmon-dot is-app" /> {t('本软件')}
            </span>
            <span>
              <i className="sysmon-dot is-other" /> {t('其他软件')}
            </span>
          </div>
        </MetricCard>
      </div>

      <section className="panel mt-20">
        <div className="panel-head">
          <div>
            <h3>{t('本软件 vs 其他软件')}</h3>
            <p>{t('“本软件”按进程名与安装目录识别；其余占用归入“其他软件”。')}</p>
          </div>
          <Badge tone="accent">
            {t('{app} 个本软件进程 · Top {top}', {
              app: metrics.app.processes.length,
              top: metrics.others.top_processes.length,
            })}
          </Badge>
        </div>
        <div className="panel-body">
          <div className="sysmon-split">
            <SplitBar
              label={t('CPU 占用')}
              appLabel={t('本软件 {percent}%', { percent: metrics.app.cpu_percent.toFixed(1) })}
              otherLabel={t('其他软件 {percent}%', { percent: metrics.others.cpu_percent.toFixed(1) })}
              app={appCpuShare}
              other={otherCpuShare}
            />
            <SplitBar
              label={t('内存占用')}
              appLabel={t('本软件 {size}', { size: formatBytes(metrics.app.memory_bytes) })}
              otherLabel={t('其他软件 {size}', { size: formatBytes(metrics.others.memory_bytes) })}
              app={appMemoryShare}
              other={otherMemoryShare}
            />
            <SplitBar
              label={t('磁盘数据')}
              appLabel={t('本软件数据 {size}', { size: formatBytes(storage.total_bytes) })}
              otherLabel={t('同卷其他数据 {size}', {
                size: formatBytes(Math.max(0, metrics.disk.used_bytes - storage.total_bytes)),
              })}
              app={appDiskShare}
              other={100 - appDiskShare}
            />
          </div>

          <div className="sysmon-columns mt-20">
            <div className="sysmon-panel">
              <div className="panel-head compact">
                <div>
                  <h3>{t('本软件进程')}</h3>
                  <p>
                    {t('CPU 占整机算力比例；内存为进程常驻内存（RSS）。')}
                  </p>
                </div>
              </div>
              {metrics.app.processes.length ? (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{t('进程')}</th>
                        <th>{t('角色')}</th>
                        <th style={{ textAlign: 'right' }}>{t('CPU')}</th>
                        <th style={{ textAlign: 'right' }}>{t('内存')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {metrics.app.processes.map((process) => (
                        <tr key={process.pid}>
                          <td className="cell-title">
                            <span className="mono">{process.name}</span>
                            <span className="tiny faint"> #{process.pid}</span>
                          </td>
                          <td>
                            <Badge tone="accent">{roleLabel(process.role)}</Badge>
                          </td>
                          <td className="cell-num">{process.cpu_percent.toFixed(2)}%</td>
                          <td className="cell-num">{formatBytes(process.memory_bytes)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="tiny faint">{t('没有识别到本软件进程（可能运行在容器或远端主机上）。')}</p>
              )}

              <div className="sysmon-storage">
                <div className="sysmon-storage-head">
                  <span>{t('本软件磁盘占用')}</span>
                  <strong>{formatBytes(storage.total_bytes)}</strong>
                </div>
                <StorageBar storage={storage} />
                <div className="sysmon-storage-list">
                  <StorageRow label={t('数据库')} value={storage.database_bytes} total={storage.total_bytes} tone="is-database" />
                  <StorageRow label={t('媒体')} value={storage.media_bytes} total={storage.total_bytes} tone="is-media" />
                  <StorageRow label={t('备份')} value={storage.backup_bytes} total={storage.total_bytes} tone="is-backup" />
                  <StorageRow label={t('其他文件')} value={storage.other_bytes} total={storage.total_bytes} tone="is-other" />
                </div>
                <p className="tiny faint">data: <span className="mono">{storage.data_dir || '—'}</span></p>
              </div>
            </div>

            <div className="sysmon-panel">
              <div className="panel-head compact">
                <div>
                  <h3>{t('其他软件（按名称聚合）')}</h3>
                  <p>{t('只列出占用最高的若干项，其余计入上方总量。')}</p>
                </div>
              </div>
              {metrics.others.top_processes.length ? (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>{t('进程')}</th>
                        <th style={{ textAlign: 'right' }}>{t('数量')}</th>
                        <th style={{ textAlign: 'right' }}>{t('CPU')}</th>
                        <th style={{ textAlign: 'right' }}>{t('内存')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {metrics.others.top_processes.map((process) => (
                        <tr key={process.name}>
                          <td className="cell-title">
                            <span className="mono">{process.name}</span>
                          </td>
                          <td className="cell-num">{process.processes}</td>
                          <td className="cell-num">{process.cpu_percent.toFixed(2)}%</td>
                          <td className="cell-num">{formatBytes(process.memory_bytes)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="tiny faint">{t('没有其他进程数据。')}</p>
              )}
              <p className="sysmon-note">
                {t(
                  '口径：进程 CPU 为占整机算力的比例（多核合计 100%）；内存为 RSS；磁盘为本软件数据目录所在卷的整体用量。',
                )}
              </p>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

/** 采样时间显示到秒：面板每几秒刷新一次，分钟精度看不出「还活着」。 */
function clockText(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * 圆环仪表盘：底环（轨道）+ 进度环（dashoffset），中心显示百分比。
 *
 * dashoffset 由纯函数 `ringDashOffset` 计算（lib/systemMonitor.test.ts 覆盖 0 / 50 /
 * 100 / 越界 / NaN），这里只负责把结果接到 SVG 与主题色上。颜色由 CSS 变量
 * `--ring-color` 决定：CPU 跟随主题 accent，内存 / 磁盘用各自语义色，深色后台里
 * 在 systemMonitor.css 中单独提亮。
 */
function RingMetricCard({
  tone,
  label,
  percent,
  sub,
  extra,
}: {
  tone: 'cpu' | 'memory' | 'disk';
  label: string;
  percent: number;
  sub: string;
  extra?: React.ReactNode;
}) {
  const value = clampPercent(percent);
  const text = `${value.toFixed(1)}%`;
  return (
    <section className={`sysmon-card sysmon-ring-card is-${tone}`}>
      <div className="sysmon-ring-wrap">
        <svg className="sysmon-ring" viewBox="0 0 120 120" role="img" aria-label={`${label} ${text}`}>
          <circle className="sysmon-ring-track" cx="60" cy="60" r={SYSTEM_RING_RADIUS} />
          <circle
            className="sysmon-ring-value"
            cx="60"
            cy="60"
            r={SYSTEM_RING_RADIUS}
            strokeDasharray={`${SYSTEM_RING_CIRCUMFERENCE} ${SYSTEM_RING_CIRCUMFERENCE}`}
            strokeDashoffset={ringDashOffset(value)}
            transform="rotate(-90 60 60)"
          />
        </svg>
        <span className="sysmon-ring-center" aria-hidden="true">
          {text}
        </span>
      </div>
      <span className="sysmon-card-label">
        <Icon
          name={tone === 'disk' ? 'database' : tone === 'memory' ? 'chart' : 'activity'}
          size={14}
        />
        {label}
      </span>
      <span className="sysmon-card-sub">{sub}</span>
      {extra ? <span className="sysmon-card-extra">{extra}</span> : null}
    </section>
  );
}

function MetricCard({
  tone,
  label,
  value,
  sub,
  extra,
  children,
}: {
  tone: 'cpu' | 'memory' | 'disk' | 'uptime';
  label: string;
  value: string;
  sub: string;
  extra?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <section className={`sysmon-card is-${tone}`}>
      <span className="sysmon-card-label">
        <Icon name={tone === 'uptime' ? 'clock' : tone === 'disk' ? 'database' : 'activity'} size={14} />
        {label}
      </span>
      <strong className="sysmon-card-value">{value}</strong>
      <span className="sysmon-card-sub">{sub}</span>
      {extra ? <span className="sysmon-card-extra">{extra}</span> : null}
      {children}
    </section>
  );
}

function SplitBar({
  label,
  appLabel,
  otherLabel,
  app,
  other,
}: {
  label: string;
  appLabel: string;
  otherLabel: string;
  app: number;
  other: number;
}) {
  return (
    <div className="sysmon-split-row">
      <div className="sysmon-split-labels">
        <span>{label}</span>
        <span>
          <b>{appLabel}</b>
          <i className="sysmon-sep">·</i>
          {otherLabel}
        </span>
      </div>
      <div className="sysmon-split-bar" role="presentation">
        <span className="sysmon-split-app" style={{ width: `${Math.max(0, Math.min(100, app))}%` }} />
        <span className="sysmon-split-other" style={{ width: `${Math.max(0, Math.min(100, other))}%` }} />
      </div>
    </div>
  );
}

function StorageBar({ storage }: { storage: SystemMetrics['app']['storage'] }) {
  const total = storage.total_bytes || 1;
  const segments: { key: string; value: number; className: string }[] = [
    { key: 'database', value: storage.database_bytes, className: 'is-database' },
    { key: 'media', value: storage.media_bytes, className: 'is-media' },
    { key: 'backup', value: storage.backup_bytes, className: 'is-backup' },
    { key: 'other', value: storage.other_bytes, className: 'is-other' },
  ];
  return (
    <div className="sysmon-storage-bar" role="presentation">
      {segments.map((segment) => (
        <span
          key={segment.key}
          className={`sysmon-storage-seg ${segment.className}`}
          style={{ width: `${Math.max(0, (segment.value / total) * 100)}%` }}
        />
      ))}
    </div>
  );
}

function StorageRow({
  label,
  value,
  total,
  tone,
}: {
  label: string;
  value: number;
  total: number;
  tone: string;
}) {
  return (
    <div className="sysmon-storage-row">
      <span>
        <i className={`sysmon-dot ${tone}`} />
        {label}
      </span>
      <span>
        {formatBytes(value)}
        <em>{total > 0 ? ` · ${percentOf(value, total).toFixed(0)}%` : ''}</em>
      </span>
    </div>
  );
}
