import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/admin/Activity.tsx` */
const fragment: Dictionary = {
  网站日志: 'Site log',
  '这里展示服务端 audit_logs 中属于当前站点的审计记录。':
    "Server-side audit_logs entries that belong to this site.",
  服务端审计日志: 'Server-side audit log',
  '登录、发布、删除、角色变更与站点设置修改都会写入 audit_logs。只有站点管理员可以查询本页；记录按时间倒序，可用时间、操作人、动作与目标筛选。':
    'Sign-ins, publishing, deletion, role changes and site setting changes are written to audit_logs. Only site administrators can query this page; entries are newest first and can be filtered by time, actor, action and target.',
  '导出 CSV': 'Export CSV',
  刷新: 'Refresh',
  时间范围: 'Time range',
  '最近 24 小时': 'Last 24 hours',
  '最近 7 天': 'Last 7 days',
  '最近 30 天': 'Last 30 days',
  全部时间: 'All time',
  操作人: 'Actor',
  全部操作人: 'All actors',
  动作: 'Action',
  全部动作: 'All actions',
  目标类型: 'Target type',
  全部目标: 'All targets',
  系统: 'System',
  正在载入操作日志: 'Loading activity log',
  还没有操作日志: 'No activity log yet',
  '发布内容、修改站点设置或调整用户组后，记录会出现在这里。':
    'Records appear here after you publish content, change site settings, or adjust user groups.',
  '加载更多失败': 'Could not load more',
  '加载更多': 'Load more',
  '记录保存在服务端 audit_logs 表中，按站点隔离；导出 CSV 只包含当前筛选已加载的记录。':
    'Records live in the server-side audit_logs table, scoped per site; the CSV export contains only the records loaded by the current filter.',
  '{count} 条': { one: '1 entry', other: '{count} entries' },
  '已导出 CSV': 'CSV exported',
};

export default fragment;
