import { useCallback, useEffect, useRef, useState } from 'react';
import type { SystemMetrics } from '../../types';
import { useAuth } from '../../lib/session';
import { isDemo, useBackend } from '../../lib/backend';
import { useTitle } from '../../lib/hooks';
import { useT } from '../../lib/i18n';
import { formatBytes } from '../../lib/format';
import {
  SYSTEM_HISTORY_WINDOW_MS,
  SYSTEM_RING_CIRCUMFERENCE,
  SYSTEM_RING_RADIUS,
  SYSTEM_SAMPLE_INTERVAL_MS,
  appendSample,
  clampPercent,
  isSampleStale,
  percentOf,
  resourceSplit,
  ringDashOffset,
  sampleAgeMs,
  sparklinePath,
  uptimeParts,
} from '../../lib/systemMonitor';
import type { SystemSamplePoint } from '../../lib/systemMonitor';
import { Badge, Button, Callout, PageLoading } from '../../components/ui';
import { Icon } from '../../components/Icon';

/**
 * 性能面板（可选模块）。
 *
 * 后端 `GET /api/v1/system/metrics` 每 2 秒采样一次主机与进程；这里以同样的节奏
 * （`SYSTEM_SAMPLE_INTERVAL_MS`）轮询缓存快照，并保留最近约 2 分钟的历史画成曲线。
 * CPU / 内存 / 磁盘的占比条统一按「整机容量 = 本软件 + 其他软件 + 空闲（100%）」拆分，
 * 上方同时显示最近采样时间与数据年龄；超过 8 秒没有新样本时明确标记「数据已过期」，
 * 不再把陈旧数字伪装成实时数据。页面不可见时暂停轮询。
 *
 * 本页不是写死在路由里的核心页面，而是内置扩展 `pp.performance` 通过
 * `adminPageRegistry` 注册的扩展页（见 lib/extensions/builtin.tsx），地址为
 * `/admin/ext/system`；旧地址 `/admin/system` 会重定向过来。
 *
 * 模块可关：部署设置 `PP_SYSTEM_METRICS=off` 后后端不再提供指标，页面会显示
 * 「模块未启用」。演示模式没有服务端可采样，页面明确提示而不是编造数据。
 */
export function SystemMonitorPage() {
  const t = useT();
  useTitle(t('性能面板'));
  const { me } = useAuth();
  const backend = useBackend();
  const demo = isDemo(backend);
  const isPlatformAdmin = me?.role === 'platform_admin';

  const [metrics, setMetrics] = useState<SystemMetrics | null>(null);
  const [history, setHistory] = useState<SystemSamplePoint[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [visible, setVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  );
  // 数据年龄与过期徽标需要每秒重算，否则两次轮询之间看不到「变旧」。
  const [now, setNow] = useState(() => Date.now());
  const aliveRef = useRef(true);
  const inFlightRef = useRef(false);
  const wasVisibleRef = useRef(visible);

  const load = useCallback(async () => {
    if (!isPlatformAdmin || demo) {
      setLoading(false);
      return;
    }
    // 2 秒轮询偶尔会在上一次请求还没返回时触发：跳过本轮，避免请求堆叠。
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setRefreshing(true);
    try {
      const next = await backend.systemMetrics();
      if (!aliveRef.current) return;
      setMetrics(next);
      setHistory((previous) => appendSample(previous, next));
      setNow(Date.now());
      setError('');
    } catch (err) {
      if (!aliveRef.current) return;
      setError(err instanceof Error ? err.message : t('无法读取服务器指标。'));
    } finally {
      inFlightRef.current = false;
      if (aliveRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
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

  // 从后台标签页切回来时立刻补一次采样，不用等下一个轮询周期。
  useEffect(() => {
    if (visible && !wasVisibleRef.current) void load();
    wasVisibleRef.current = visible;
  }, [load, visible]);

  useEffect(() => {
    if (!visible || !isPlatformAdmin || demo) return;
    const timer = window.setInterval(() => void load(), SYSTEM_SAMPLE_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [demo, isPlatformAdmin, load, visible]);

  // 每秒刷新一次「现在」，让数据年龄与过期徽标持续可信。
  useEffect(() => {
    if (!visible) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [visible]);

  const ageMs = metrics ? sampleAgeMs(metrics.sampled_at, now) : null;
  const ageSeconds = ageMs === null ? null : Math.floor(ageMs / 1000);
  const stale = metrics ? isSampleStale(metrics.sampled_at, now) : false;

  const roleLabel = (role: string): string => {
    switch (role) {
      case 'api':
        return t('服务器 API');
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
            '本软件与其他软件在这台服务器上的 CPU、内存与磁盘占用。服务端每 2 秒采样，页面跟随采样节奏刷新；页面不可见时暂停。',
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
        {metrics && ageSeconds !== null ? (
          <Badge tone={stale ? 'warn' : 'ok'} dot>
            {t('数据年龄 {age} 秒', { age: ageSeconds })}
          </Badge>
        ) : null}
        {stale ? <Badge tone="danger">{t('数据已过期')}</Badge> : null}
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

  const cpuUsed = clampPercent(metrics.cpu.usage_percent);
  const cpuApp = Math.min(clampPercent(metrics.app.cpu_percent), cpuUsed);
  const cpuOther = Math.max(0, cpuUsed - cpuApp);
  const cpuSplit = resourceSplit(cpuApp, cpuOther, 100);

  const memTotal = safeBytes(metrics.memory.total_bytes);
  const memUsed = Math.min(safeBytes(metrics.memory.used_bytes), memTotal);
  const memApp = Math.min(safeBytes(metrics.app.memory_bytes), memUsed);
  const memOther = Math.max(0, memUsed - memApp);
  const memSplit = resourceSplit(memApp, memOther, memTotal);

  const storage = metrics.app.storage;
  const diskTotal = safeBytes(metrics.disk.total_bytes);
  const diskUsed = Math.min(safeBytes(metrics.disk.used_bytes), diskTotal);
  const diskApp = Math.min(safeBytes(storage.total_bytes), diskUsed);
  const diskOther = Math.max(0, diskUsed - diskApp);
  const diskSplit = resourceSplit(diskApp, diskOther, diskTotal);

  const cpuHistory = history.map((point) => point.cpu);
  const memoryHistory = history.map((point) => point.memory);
  const historyWindowSeconds = Math.round(SYSTEM_HISTORY_WINDOW_MS / 1000);

  return (
    <>
      {head}

      {stale ? (
        <div className="mb-16">
          <Callout tone="warn" icon="alert" title={t('数据已过期')}>
            {t(
              '上次采样在 {time}，已经过去 {age} 秒。页面不会把旧数据当成实时数据展示；恢复连接后会自动继续刷新。',
              {
                time: clockText(metrics.sampled_at),
                age: ageSeconds ?? 0,
              },
            )}
          </Callout>
        </div>
      ) : null}

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
          chart={
            <Sparkline
              values={cpuHistory}
              tone="cpu"
              label={t('CPU 使用率曲线')}
              caption={t('最近 {seconds} 秒 · {count} 个采样点', {
                seconds: historyWindowSeconds,
                count: cpuHistory.length,
              })}
            />
          }
        />

        <RingMetricCard
          tone="memory"
          label={t('内存使用')}
          percent={metrics.memory.usage_percent}
          sub={t('{used} / {total}', {
            used: formatBytes(metrics.memory.used_bytes),
            total: formatBytes(metrics.memory.total_bytes),
          })}
          chart={
            <Sparkline
              values={memoryHistory}
              tone="memory"
              label={t('内存使用率曲线')}
              caption={t('最近 {seconds} 秒 · {count} 个采样点', {
                seconds: historyWindowSeconds,
                count: memoryHistory.length,
              })}
            />
          }
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
          sub={t('{count} 个其他进程 · {os}/{arch}', {
            count: metrics.others.process_count,
            os: metrics.platform.os,
            arch: metrics.platform.arch,
          })}
          extra={<span className="sysmon-path mono">{metrics.platform.hostname}</span>}
        />
      </div>

      <section className="panel mt-20">
        <div className="panel-head">
          <div>
            <h3>{t('本软件 vs 其他软件')}</h3>
            <p>
              {t(
                '三段都按整机容量计算，合计 100%：本软件 + 其他软件 + 空闲。空闲段让「已用多少」一眼可见，不会出现两条宽度相加不足 100 的错觉。',
              )}
            </p>
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
              appLabel={t('本软件 {percent}%', { percent: cpuSplit.app.toFixed(1) })}
              otherLabel={t('其他软件 {percent}%', { percent: cpuSplit.other.toFixed(1) })}
              idleLabel={t('空闲 {percent}%', { percent: cpuSplit.idle.toFixed(1) })}
              app={cpuSplit.app}
              other={cpuSplit.other}
              idle={cpuSplit.idle}
            />
            <SplitBar
              label={t('内存占用')}
              appLabel={t('本软件 {size} · {percent}%', {
                size: formatBytes(memApp),
                percent: memSplit.app.toFixed(1),
              })}
              otherLabel={t('其他软件 {size} · {percent}%', {
                size: formatBytes(memOther),
                percent: memSplit.other.toFixed(1),
              })}
              idleLabel={t('空闲 {size} · {percent}%', {
                size: formatBytes(Math.max(0, memTotal - memUsed)),
                percent: memSplit.idle.toFixed(1),
              })}
              app={memSplit.app}
              other={memSplit.other}
              idle={memSplit.idle}
            />
            <SplitBar
              label={t('磁盘数据')}
              appLabel={t('本软件数据 {size} · {percent}%', {
                size: formatBytes(diskApp),
                percent: diskSplit.app.toFixed(1),
              })}
              otherLabel={t('同卷其他数据 {size} · {percent}%', {
                size: formatBytes(diskOther),
                percent: diskSplit.other.toFixed(1),
              })}
              idleLabel={t('空闲 {size} · {percent}%', {
                size: formatBytes(Math.max(0, diskTotal - diskUsed)),
                percent: diskSplit.idle.toFixed(1),
              })}
              app={diskSplit.app}
              other={diskSplit.other}
              idle={diskSplit.idle}
            />
          </div>
          <div className="sysmon-legend mt-12">
            <span>
              <i className="sysmon-dot is-app" /> {t('本软件')}
            </span>
            <span>
              <i className="sysmon-dot is-other" /> {t('其他软件')}
            </span>
            <span>
              <i className="sysmon-dot is-idle" /> {t('空闲')}
            </span>
          </div>

          <div className="sysmon-columns mt-20">
            <div className="sysmon-panel">
              <div className="panel-head compact">
                <div>
                  <h3>{t('本软件进程')}</h3>
                  <p>{t('CPU 占整机算力比例；内存为进程常驻内存（RSS）。')}</p>
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
                  '口径：进程 CPU 为占整机算力的比例（多核合计 100%）；内存为 RSS，聚合值按主机已用内存夹紧；磁盘为本软件数据目录所在卷的整体用量。',
                )}
              </p>
            </div>
          </div>
        </div>
      </section>
    </>
  );
}

/** 采样时间显示到秒：面板每 2 秒刷新一次，分钟精度看不出「还活着」。 */
function clockText(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '—';
  return parsed.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** 非负有限数，避免 Math.min / formatBytes 收到 NaN 或负数。 */
function safeBytes(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** 占比条的一段宽度；百分比夹紧到 0–100，非法值按 0。 */
function widthPercent(value: number): string {
  return `${Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0))}%`;
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
  chart,
}: {
  tone: 'cpu' | 'memory' | 'disk';
  label: string;
  percent: number;
  sub: string;
  extra?: React.ReactNode;
  chart?: React.ReactNode;
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
      {chart ? <div className="sysmon-card-chart">{chart}</div> : null}
    </section>
  );
}

function MetricCard({
  tone,
  label,
  value,
  sub,
  extra,
}: {
  tone: 'cpu' | 'memory' | 'disk' | 'uptime';
  label: string;
  value: string;
  sub: string;
  extra?: React.ReactNode;
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
    </section>
  );
}

/**
 * 最近约 2 分钟的真实采样曲线（纯 SVG，无第三方依赖）。
 *
 * 只有 0–1 个点时 `sparklinePath` 返回空串，这里画一条底部平线占位并显示
 * 「正在采集曲线…」；有足够点后画折线。数值本身来自服务端快照，不做平滑或插值。
 */
function Sparkline({
  values,
  tone,
  label,
  caption,
}: {
  values: number[];
  tone: 'cpu' | 'memory';
  label: string;
  caption: string;
}) {
  const t = useT();
  const width = 260;
  const height = 54;
  const padding = 3;
  const path = sparklinePath(values, width, height, padding);
  const latest = values.length ? clampPercent(values[values.length - 1]) : 0;
  return (
    <div className={`sysmon-spark is-${tone}`}>
      <svg
        className="sysmon-spark-svg"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`${label} ${latest.toFixed(1)}%`}
        preserveAspectRatio="none"
      >
        <line
          className="sysmon-spark-mid"
          x1={padding}
          y1={height / 2}
          x2={width - padding}
          y2={height / 2}
        />
        {path ? (
          <path className="sysmon-spark-line" d={path} vectorEffect="non-scaling-stroke" />
        ) : (
          <line
            className="sysmon-spark-placeholder"
            x1={padding}
            y1={height - padding}
            x2={width - padding}
            y2={height - padding}
          />
        )}
      </svg>
      <span className="sysmon-spark-caption">
        {values.length >= 2 ? caption : t('正在采集曲线…')}
      </span>
    </div>
  );
}

/**
 * 三段占比条：本软件 / 其他软件 / 空闲。
 *
 * 页面先用主机总量夹紧再传入，因此三段宽度合计恰好 100%；这里仍对每段做
 * 0–100 的防御性夹紧，保证旧后端或异常数据也不会画出「宽度相加不足」的条。
 */
function SplitBar({
  label,
  appLabel,
  otherLabel,
  idleLabel,
  app,
  other,
  idle,
}: {
  label: string;
  appLabel: string;
  otherLabel: string;
  idleLabel: string;
  app: number;
  other: number;
  idle: number;
}) {
  return (
    <div className="sysmon-split-row">
      <div className="sysmon-split-labels">
        <span>{label}</span>
        <span className="sysmon-split-values">
          <b>{appLabel}</b>
          <i className="sysmon-sep">·</i>
          {otherLabel}
          <i className="sysmon-sep">·</i>
          <em className="sysmon-idle-label">{idleLabel}</em>
        </span>
      </div>
      <div className="sysmon-split-bar" role="presentation">
        <span className="sysmon-split-app" style={{ width: widthPercent(app) }} />
        <span className="sysmon-split-other" style={{ width: widthPercent(other) }} />
        <span className="sysmon-split-idle" style={{ width: widthPercent(idle) }} />
      </div>
    </div>
  );
}

function StorageBar({ storage }: { storage: SystemMetrics['app']['storage'] }) {
  const segments: { key: string; value: number; className: string }[] = [
    { key: 'database', value: safeBytes(storage.database_bytes), className: 'is-database' },
    { key: 'media', value: safeBytes(storage.media_bytes), className: 'is-media' },
    { key: 'backup', value: safeBytes(storage.backup_bytes), className: 'is-backup' },
    { key: 'other', value: safeBytes(storage.other_bytes), className: 'is-other' },
  ];
  // 后端保证四段之和等于 total；仍以四段之和为分母，条宽永远自洽。
  const sum = segments.reduce((total, segment) => total + segment.value, 0);
  const base = sum > 0 ? sum : safeBytes(storage.total_bytes) || 1;
  return (
    <div className="sysmon-storage-bar" role="presentation">
      {segments.map((segment) => (
        <span
          key={segment.key}
          className={`sysmon-storage-seg ${segment.className}`}
          style={{ width: widthPercent((segment.value / base) * 100) }}
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
