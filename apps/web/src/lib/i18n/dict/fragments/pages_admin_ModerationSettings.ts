import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/admin/ModerationSettings.tsx` */
const fragment: Dictionary = {
  // ---- 页头 ----
  审核设置: 'Moderation settings',
  '评论策略、文章发布策略概览、AI 审核权限与内容安全规则集中在这里。':
    'Comment policy, an overview of article publishing, AI moderation permissions, and content-safety rules live here.',

  // ---- 评论设置补充 ----
  '只有站点管理员可以修改评论策略': 'Only site admins can change the comment policy',
  '当前值仍然生效；需要调整时请让站点管理员操作。':
    'The current values still apply; ask a site admin to change them.',

  // ---- 文章审核概览 ----
  文章审核: 'Article review',
  '成员投稿是否需要另一位编辑审核；AI 只处理进入待审队列的稿件。':
    'Whether member submissions need another editor’s review; AI only handles drafts that reach the queue.',
  '在站点设置中修改发布模式': 'Change the publish mode in site settings',

  // ---- AI 审核 ----
  '本地启发式打分，不把文章或评论正文发送到外部服务。':
    'Local heuristic scoring; article or comment text is never sent to an external service.',
  '启用 AI 审核': 'Enable AI moderation',
  '用本地规则给评论和/或文章打分；是否自动处置由下面的权限决定。':
    'Score comments and/or articles with local rules; the permission below decides whether AI also acts.',
  'AI 审核评论': 'AI moderates comments',
  '在评论列表标出风险分；开启自动权限后按当前评论策略处置。':
    'Shows a risk score in the comment list; with automatic permission it acts according to the current comment policy.',
  'AI 审核文章': 'AI moderates articles',
  '给待审稿件打分；开启自动权限后自动发布低风险稿件。':
    'Scores drafts in the queue; with automatic permission it publishes low-risk drafts.',
  自动审核并处置: 'Review and act automatically',
  '默认跟随先审后发：开启先审后发时自动通过低风险评论，关闭时自动删除高风险评论；文章只自动发布低风险稿件。':
    'Defaults to following review-before-publishing: with it on, low-risk comments are approved; with it off, high-risk comments are deleted. Articles are only auto-published when low risk.',
  '敏感度越高，同样的正文越容易被判为中高风险。':
    'The higher the sensitivity, the more easily the same text is rated medium or high risk.',
  '先启用 AI 审核。': 'Enable AI moderation first.',
  '低风险待审评论自动通过并公开，中高风险留给人工。':
    'Low-risk pending comments are approved and published; medium and high risk go to a person.',
  '高风险公开评论由 AI 直接删除，其余保持不变。':
    'High-risk public comments are deleted by AI; the rest stay as they are.',
  '低风险待审稿件自动发布，中高风险留给人工。':
    'Low-risk pending drafts are published; medium and high risk go to a person.',
  '先选择 AI 审核范围。': 'Choose what AI should moderate first.',

  // ---- 当前权限摘要 ----
  '当前 AI 权限': 'Current AI permissions',
  '保存后立即按这张表处理队列。': 'The queue is processed by this table as soon as it is saved.',
  评论策略: 'Comment policy',
  直接发布: 'Publish directly',
  文章策略: 'Article policy',
  不参与: 'Not involved',
  '自动通过低风险待审评论': 'Approves low-risk pending comments',
  '自动删除高风险公开评论': 'Deletes high-risk public comments',
  '只打风险分': 'Scores risk only',
  '个人博客没有待审稿件': 'A personal blog has no pending drafts',
  '自动发布低风险待审稿件': 'Publishes low-risk pending drafts',
  权限: 'Permission',
  未启用: 'Off',
  自动审核自动发送: 'Review and send automatically',
  只给建议: 'Suggest only',
  '自动处置只在打开队列页时执行一轮：评论最多扫描最近 100 条，文章最多扫描最近 100 篇待审稿件。':
    'Automatic handling runs one pass when a queue page opens: up to the latest 100 comments and 100 pending drafts.',
};

export default fragment;
