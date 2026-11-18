import type { Dictionary } from '../../plural';

/** 来源：`web/src/pages/admin/Observability.tsx` */
const fragment: Dictionary = {
  // ---- 页头 / 分区 ----
  运行观察: 'Observability',
  '服务端请求日志、任务队列与自动备份状态。日志只保留元数据，整页只读；唯一的写操作是重投失败事件。':
    'Server request logs, the job queue, and automatic backup status. Logs keep metadata only and this page is read-only, except for retrying failed events.',
  请求日志: 'Request logs',
  队列: 'Queue',
  自动备份: 'Automatic backup',

  // ---- 请求日志 ----
  状态码: 'Status code',
  '状态码，例如 404': 'Status code, e.g. 404',
  路径片段: 'Path fragment',
  '路径片段，例如 /api/v1': 'Path fragment, e.g. /api/v1',
  方法: 'Method',
  路径: 'Path',
  全部方法: 'All methods',
  耗时: 'Duration',
  请求号: 'Request ID',
  '{count} 条请求': { one: '1 request', other: '{count} requests' },
  '只记录元数据，不含请求体、请求头与 cookie。':
    'Metadata only: request bodies, headers, and cookies are never recorded.',
  '状态码需要是 100–599 的整数。': 'The status code must be an integer between 100 and 599.',
  无法读取请求日志: 'Could not load request logs',
  没有匹配的请求日志: 'No request logs match the filters',
  '调整筛选条件后再试；服务端只保留最近的请求元数据。':
    'Adjust the filters and try again; the server keeps only recent request metadata.',
  '请求失败。': 'The request failed.',

  // ---- 队列 ----
  待投递: 'Pending',
  已投递: 'Delivered',
  失败: 'Failure',
  成功: 'Success',
  邮件队列: 'Mail queue',
  排队中: 'Queued',
  最老待投递时长: 'Oldest pending age',
  'outbox 中等待投递的事件': 'Events waiting in the outbox',
  需要人工重投: 'Needs a manual retry',
  积压越久越可能丢事件: 'The longer an event waits, the more likely it is lost',
  '事务邮件的发送队列；失败项会保留在服务端，等待重试或清理。':
    'Outgoing transactional mail queue; failed messages stay on the server until retried or cleaned up.',
  '{count} 秒': '{count} sec',
  '约 {count} 分钟': 'about {count} min',
  '约 {count} 小时': 'about {count} h',
  '约 {count} 天': 'about {count} days',
  最近事件: 'Recent events',
  'outbox 最近处理的事件；失败的事件可以重投。':
    'Recently processed outbox events; failed events can be retried.',
  事件类型: 'Event type',
  尝试次数: 'Attempts',
  最后错误: 'Last error',
  '还没有队列事件。': 'No queue events yet.',
  重投失败事件: 'Retry failed events',
  '重新投递最近 50 条失败的 outbox 事件。':
    'Re-deliver the 50 most recent failed outbox events.',
  这会改变队列状态: 'This changes the queue state',
  '重投会把失败事件重新排入投递队列；如果根因未修复，它们可能再次失败。':
    'Retrying puts failed events back into the delivery queue; if the root cause is not fixed they may fail again.',
  确认重投: 'Retry now',
  重投失败: 'Retry failed',
  '已重投 {count} 条事件': {
    one: '1 event queued for retry',
    other: '{count} events queued for retry',
  },
  无法读取队列状态: 'Could not load queue status',

  // ---- 自动备份 ----
  自动备份计划: 'Automatic backup schedule',
  '计划来自部署环境变量，页面只读。':
    'The schedule comes from deployment environment variables; this page is read-only.',
  已启用: 'Enabled',
  未启用: 'Not enabled',
  自动备份未启用: 'Automatic backups are not enabled',
  '未启用，需在部署环境变量中开启。':
    'Not enabled. Turn it on with the deployment environment variables.',
  每天运行: 'Runs daily',
  服务器本地时间: "Server's local time",
  保留份数: 'Copies kept',
  '超出后删除最旧的备份': 'The oldest copies are removed first',
  上次运行: 'Last run',
  下次运行: 'Next run',
  从未运行过: 'Never run yet',
  '按每日计划自动执行': 'Runs automatically on the daily schedule',
  计划未启用: 'Schedule is off',
  上次运行失败: 'The last run failed',
  备份产物: 'Backup artifacts',
  '保留最近 {count} 份自动备份。': {
    one: 'Keeping the most recent automatic backup.',
    other: 'Keeping the most recent {count} automatic backups.',
  },
  文件名: 'File name',
  大小: 'Size',
  创建时间: 'Created',
  '还没有自动备份产物。': 'No automatic backup artifacts yet.',
  无法读取备份计划: 'Could not load the backup schedule',
  需要平台管理员权限: 'Platform admin required',
  '自动备份计划只对平台管理员开放。':
    'The automatic backup schedule is available to platform admins only.',
};

export default fragment;
