import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/admin/Security.tsx` */
const fragment: Dictionary = {
  信息安全: 'Trust and safety',
  审核: 'Review',
  举报: 'Reports',
  '没有可用的信息安全权限': 'No trust-and-safety permissions',
  '这个账户不能审核内容、处理举报或管理评论。':
    'This account cannot review content, handle reports, or moderate comments.',
  '审核待发布内容、处理读者举报、管理评论。三种队列在这里汇合，处理动作都会写入网站日志。':
    'Review content before it goes live, handle reader reports, and moderate comments. The three queues live here together, and every action is written to the site log.',
};

export default fragment;
