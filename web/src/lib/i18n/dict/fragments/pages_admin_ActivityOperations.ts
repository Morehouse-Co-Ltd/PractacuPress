import type { Dictionary } from '../../plural';

/** 来源：`web/src/pages/admin/ActivityOperations.tsx` */
const fragment: Dictionary = {
  请求日志: 'Request logs',
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
  筛选: 'Filter',
  成功: 'Success',
  失败: 'Failure',
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
};

export default fragment;
