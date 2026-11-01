import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/site/Notifications.tsx` */
const fragment: Dictionary = {
  // ---- 通知条目 ----
  有人: 'Someone',
  // 英文值末尾的空格用来和后面的《标题》拼接，中文侧由 JSX 里的空格负责。
  评论了: 'commented on ',
  赞了: 'liked ',
  '开始关注你。': 'started following you.',
  状态更新: 'status updated',
  发来一条私信: 'sent you a message',
  你的内容: 'your content',
  '：{excerpt}': ': {excerpt}',

  // ---- 页头 ----
  '评论、点赞、关注与审核结果。只有你自己的通知会被返回；未读数每 45 秒轮询一次。':
    'Comments, likes, follows and moderation results. Only your own notifications are returned; the unread count is polled every 45 seconds.',
  未读: 'Unread',
  全部标为已读: 'Mark all as read',
  '已标记 {count} 条为已读': { one: 'Marked 1 as read', other: 'Marked {count} as read' },

  // ---- 加载与空状态 ----
  正在载入通知: 'Loading notifications',
  没有未读通知: 'No unread notifications',
  通知箱是空的: 'Your inbox is empty',
  '所有消息都读过了。新的评论或审核结果会出现在这里。':
    'You have read everything. New comments and moderation results will show up here.',
  '当有人评论、点赞或关注你时，这里会收到一条通知。':
    'When someone comments on, likes or follows you, a notification arrives here.',
};

export default fragment;
