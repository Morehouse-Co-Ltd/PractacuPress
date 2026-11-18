import type { Dictionary } from '../../plural';

/** 来源：`web/src/pages/site/Notifications.tsx` */
const fragment: Dictionary = {
  // ---- 通知条目 ----
  有人: 'Someone',
  // 英文值末尾的空格用来和后面的《标题》拼接，中文侧由 JSX 里的空格负责。
  评论了: 'commented on ',
  回复了你: 'replied to you',
  赞了: 'liked ',
  '开始关注你。': 'started following you.',
  状态更新: 'status updated',
  发来一条私信: 'sent you a message',
  你的内容: 'your content',
  '：{excerpt}': ': {excerpt}',
  // 联系表单逐条通知：主题由服务端拼成「站点来信：<name>」，这里是没带名字时的兜底。
  站点来信: 'Message from the site',

  // ---- 页头 ----
  '评论、点赞、关注与审核结果。只有你自己的通知会被返回；新通知实时推送，断线时每 45 秒轮询一次。':
    'Comments, likes, follows and moderation results. Only your own notifications are returned; new notifications arrive live, with a 45-second poll while disconnected.',
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

  // ---- 通知设置 ----
  通知设置: 'Notification settings',
  '站内与邮件分别控制；分类开关只影响对应的事件。':
    'In-app and email are controlled separately; each category switch only affects its own events.',
  正在载入通知设置: 'Loading notification settings',
  载入通知设置失败: 'Could not load notification settings',
  保存通知设置失败: 'Could not save notification settings',
  通知设置已保存: 'Notification settings saved',
  站内通知: 'In-app notifications',
  接收站内通知: 'Receive in-app notifications',
  '关闭后铃铛不再新增未读消息。': 'When off, the bell stops collecting new unread messages.',
  评论与回复: 'Comments and replies',
  '有人评论你的内容或回复你的评论。': 'Someone commented on your content or replied to your comment.',
  赞与反应: 'Likes and reactions',
  '有人赞了你的内容。': 'Someone liked your content.',
  新增关注: 'New followers',
  '有人开始关注你。': 'Someone started following you.',
  审核与站点消息: 'Moderation and site messages',
  '审核结果、举报处理与站点来信。': 'Review decisions, report handling and contact form messages.',
  邮件通知: 'Email notifications',
  '当前部署未配置 SMTP，邮件通知暂时不会发送。':
    'This deployment has no SMTP relay configured, so notification email is not sent yet.',
  接收邮件通知: 'Receive email notifications',
  '开启后，符合下面分类的事件会同时发到你的账户邮箱。':
    'When on, events in the categories below are also sent to your account email.',
};

export default fragment;
