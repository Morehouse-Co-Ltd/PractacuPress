import type { Dictionary } from '../../plural';

/** 来源：`web/src/pages/admin/Security.tsx` */
const fragment: Dictionary = {
  信息安全: 'Trust and safety',
  审核: 'Review',
  举报: 'Reports',
  评论审核: 'Comment review',
  审核设置: 'Moderation settings',
  '没有可用的信息安全权限': 'No trust-and-safety permissions',
  '这个账户不能审核内容、处理举报或管理评论。':
    'This account cannot review content, handle reports, or moderate comments.',
  '审核待发布内容、处理读者举报、管理评论。队列与策略分开：处理动作写入网站日志，策略开关集中在「审核设置」。':
    'Review content before it goes live, handle reader reports, and moderate comments. Queues and policy are separate: actions are written to the site log, while policy switches live under Moderation settings.',
};

export default fragment;
