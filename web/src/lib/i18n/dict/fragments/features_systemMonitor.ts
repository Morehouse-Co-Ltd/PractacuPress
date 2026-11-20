import type { Dictionary } from '../../plural';

/**
 * 性能面板（可选模块）的英文文案。
 * 来源：`pages/admin/SystemMonitor.tsx`、`components/AdminShell.tsx`（导航与标题）。
 */
const fragment: Dictionary = {
  // ---- 页面与导航 ----
  '性能面板': 'Performance panel',
  '本软件与其他软件在这台服务器上的 CPU、内存与磁盘占用。服务端每 2 秒采样，页面跟随采样节奏刷新；页面不可见时暂停。':
    'CPU, memory and disk usage of this software and of other software on this server. The API samples every 2 seconds and the page refreshes at the same pace; polling pauses while the page is hidden.',
  '采样于 {time}': 'Sampled at {time}',
  '数据年龄 {age} 秒': 'Data age {age}s',
  '数据已过期': 'Data is stale',
  '上次采样在 {time}，已经过去 {age} 秒。页面不会把旧数据当成实时数据展示；恢复连接后会自动继续刷新。':
    'The last sample was at {time}, {age}s ago. The panel will not present old data as live; refreshing resumes automatically when the connection recovers.',
  '自动刷新中': 'Auto-refreshing',
  '已暂停（页面不可见）': 'Paused (page hidden)',
  '刷新': 'Refresh',
  '仅平台管理员可查看': 'Platform administrators only',
  '服务器指标包含主机名、路径与进程信息，只对平台管理员开放。':
    'Server metrics include the hostname, filesystem paths and process names, so only platform administrators can read them.',
  '演示模式没有服务器指标': 'Demo mode has no server metrics',
  '演示数据只存在浏览器里，没有可采样的服务端；连接真实后端（启动.bat 或部署实例）后，这里会显示本机进程与磁盘占用。':
    'Demo data lives only in the browser, so there is no server to sample. Connect a real backend (the portable package or a deployed instance) and this page will show local processes and disk usage.',
  '正在读取服务器指标': 'Reading server metrics',
  '无法读取服务器指标': 'Could not read server metrics',
  '无法读取服务器指标。': 'Could not read server metrics.',
  '部署可以通过 PP_SYSTEM_METRICS=off 关闭这个可选模块；关闭后本页不可用。':
    'A deployment can disable this optional module with PP_SYSTEM_METRICS=off; the page is then unavailable.',
  '重试': 'Retry',
  '本次刷新失败，显示的是上一份采样': 'This refresh failed; showing the previous sample',

  // ---- 指标卡 ----
  'CPU 使用率': 'CPU usage',
  'CPU 使用率曲线': 'CPU usage trend',
  '内存使用率曲线': 'Memory usage trend',
  '{cores} 个逻辑核心': '{cores} logical cores',
  '内存使用': 'Memory usage',
  '{used} / {total}': '{used} / {total}',
  '磁盘使用': 'Disk usage',
  '运行时长': 'Uptime',
  本站运行时长: 'Site uptime',
  '{count} 个其他进程 · {os}/{arch}': '{count} other processes · {os}/{arch}',
  '本软件': 'This software',
  '其他软件': 'Other software',
  '空闲': 'Idle',
  '{days} 天 {hours} 小时': '{days}d {hours}h',
  '{hours} 小时 {minutes} 分钟': '{hours}h {minutes}m',
  '{minutes} 分钟': '{minutes}m',
  '最近 {seconds} 秒 · {count} 个采样点': 'Last {seconds}s · {count} samples',
  '正在采集曲线…': 'Collecting the trend…',

  // ---- 对比 ----
  '本软件 vs 其他软件': 'This software vs other software',
  '{app} 个本软件进程 · Top {top}': '{app} app processes · Top {top}',
  '三段都按整机容量计算，合计 100%：本软件 + 其他软件 + 空闲。空闲段让「已用多少」一眼可见，不会出现两条宽度相加不足 100 的错觉。':
    'All three segments are shares of total machine capacity and add up to 100%: this software + other software + idle. The idle segment makes "how much is actually used" obvious instead of leaving a misleading gap.',
  'CPU 占用': 'CPU usage',
  '本软件 {percent}%': 'This software {percent}%',
  '其他软件 {percent}%': 'Other software {percent}%',
  '空闲 {percent}%': 'Idle {percent}%',
  '内存占用': 'Memory usage',
  '本软件 {size} · {percent}%': 'This software {size} · {percent}%',
  '其他软件 {size} · {percent}%': 'Other software {size} · {percent}%',
  '空闲 {size} · {percent}%': 'Idle {size} · {percent}%',
  '磁盘数据': 'Disk data',
  '本软件数据 {size} · {percent}%': 'This software data {size} · {percent}%',
  '同卷其他数据 {size} · {percent}%': 'Other data on this volume {size} · {percent}%',

  // ---- 进程表 ----
  '本软件进程': 'Processes of this software',
  'CPU 占整机算力比例；内存为进程常驻内存（RSS）。':
    'CPU is a share of total machine capacity; memory is resident set size (RSS).',
  '进程': 'Process',
  '角色': 'Role',
  'CPU': 'CPU',
  '内存': 'Memory',
  '没有识别到本软件进程（可能运行在容器或远端主机上）。':
    'No process of this software was identified (it may run in a container or on a remote host).',
  '本软件磁盘占用': 'Disk used by this software',
  '数据库': 'Database',
  '媒体': 'Media',
  '备份': 'Backups',
  '其他文件': 'Other files',
  '其他软件（按名称聚合）': 'Other software (grouped by name)',
  '只列出占用最高的若干项，其余计入上方总量。':
    'Only the top consumers are listed; the rest is included in the totals above.',
  '数量': 'Count',
  '没有其他进程数据。': 'No other process data.',
  '口径：进程 CPU 为占整机算力的比例（多核合计 100%）；内存为 RSS，聚合值按主机已用内存夹紧；磁盘为本软件数据目录所在卷的整体用量。':
    'Method: process CPU is a share of total machine capacity (all cores sum to 100%); memory is RSS with aggregates clamped to host used memory; disk is the usage of the volume that holds this software data directory.',

  // ---- 角色 ----
  '服务器 API': 'Server API',
  '前端（开发服务器）': 'Frontend (dev server)',
  '附加进程': 'Attached process',
  '未知角色': 'Unknown role',
};

export default fragment;
