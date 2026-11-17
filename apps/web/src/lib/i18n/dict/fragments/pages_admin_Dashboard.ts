import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/admin/Dashboard.tsx` */
const fragment: Dictionary = {
  // ---- 页头 ----
  仪表盘: 'Dashboard',
  夜里好: 'Good evening',
  早上好: 'Good morning',
  下午好: 'Good afternoon',
  晚上好: 'Good evening',
  '{greeting}，{name}': '{greeting}, {name}',
  站点: 'Site',
  '{site} · 今天是 {date}': '{site} · Today is {date}',
  新建帖子: 'New post',
  新建文章: 'New article',

  // ---- 读取失败 ----
  无法读取后台数据: 'Cannot load admin data',
  '请求失败。': 'The request failed.',

  // ---- 统计卡片 ----
  已发布: 'Published',
  读者可见的内容: 'Content readers can see',
  待审核: 'Pending review',
  需要编辑处理: 'Needs an editor',
  队列已清空: 'Queue is clear',
  草稿与退回: 'Drafts and rejected',
  尚未进入公开列表: 'Not in the public list yet',
  站点用户: 'Site users',
  含邀请中与停用: 'Includes invited and disabled',
  需要站点管理员权限: 'Requires site admin rights',

  // ---- 审核队列 ----
  审核队列: 'Review queue',
  '{count} 篇等待处理': { one: '1 item waiting for review', other: '{count} items waiting for review' },
  暂时没有待审内容: 'Nothing is waiting for review',
  打开队列: 'Open the queue',
  '队列是空的。新的提交会出现在这里，并触发一条通知。':
    'The queue is empty. New submissions show up here and trigger a notification.',
  作者: 'Author',

  // ---- 最近操作（服务端 audit_logs） ----
  最近操作: 'Recent activity',
  '来自服务端 audit_logs 的审计记录': 'Audit records from the server audit_logs table',
  '只有站点管理员可以查看服务端审计记录。': 'Only site admins can view server audit records.',
  无法读取最近操作: 'Could not load recent activity',
  '还没有操作日志。': 'No activity recorded yet.',
  成功: 'Success',
  失败: 'Failure',
  系统: 'System',
};

export default fragment;
