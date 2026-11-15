import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/admin/Review.tsx` */
const fragment: Dictionary = {
  // ---- 页头与门禁 ----
  审核员: 'Reviewer',
  审核队列: 'Review queue',
  '{pending} 篇待审，{security} 篇等待安全检查。作者不能审核自己的稿件。':
    '{pending} awaiting review, {security} awaiting the security check. Authors cannot review their own drafts.',
  刷新队列: 'Refresh queue',

  // ---- 加载与错误 ----
  '无法读取队列': 'Could not load the queue',
  '请求失败。': 'Request failed.',
  '正在载入审核队列': 'Loading the review queue',

  // ---- 空状态 ----
  '队列已清空': 'The queue is clear',
  '没有等待审核的稿件。新的提交会出现一条通知，也会回到这个列表。':
    'Nothing is waiting for review. A new submission raises a notification and lands back in this list.',
  '查看内容库': 'Browse the content library',

  // ---- 待审卡片 ----
  文章: 'Article',
  帖子: 'Post',
  作者: 'Author',
  '提交于 {date}': 'Submitted {date}',
  '打开稿件': 'Open draft',
  发布: 'Publish',
  退回: 'Reject',
  '作者不能审核自己的内容。请让另一位编辑处理这份稿件。':
    'Authors cannot review their own content. Ask another editor to handle this draft.',

  // ---- 安全检查分组 ----
  '等待安全检查': 'Waiting for the security check',
  '安全检查通过前不会公开': 'Not public until the security check passes',
  重试安全检查: 'Retry security check',
  '内容已保留，但安全服务在写入时不可用。服务恢复后重试，或让作者重新提交。':
    'The content was saved, but the security service was unavailable when it was written. Retry once the service is back, or ask the author to submit again.',

  // ---- 操作反馈 ----
  '{action}成功': '{action} succeeded',
  '{action}失败': '{action} failed',
  '《{title}》': '“{title}”',

  // ---- 退回弹窗 ----
  '退回《{title}》': 'Send back “{title}”',
  '理由会写入状态记录并通知作者。请写清楚需要修改的地方。':
    'The reason goes into the status record and is sent to the author. Be specific about what needs to change.',
  确认退回: 'Send it back',
  退回理由: 'Reason for sending back',
  '例如：第二段的统计口径与来源不一致，请补充说明。':
    'For example: the figures in the second paragraph disagree with their source; please explain.',

  // ---- AI 自动审核 ----
  'AI 审核已开启': 'AI moderation is on',
  'AI 只给风险分，不会自动发布稿件。':
    'AI only scores risk; it does not publish drafts automatically.',
  '低风险待审稿件会自动发布，中高风险留在队列里。':
    'Low-risk pending drafts are published automatically; medium and high risk stay in the queue.',
  '立即运行 AI 审核': 'Run AI moderation now',
  '最近一轮：自动发布 {published} 篇，留待人工 {skipped} 篇，失败 {failed} 篇。':
    'Last pass: {published} published, {skipped} left for a person, {failed} failed.',
  '自动发布 {published} 篇，留待人工 {skipped} 篇，失败 {failed} 篇。':
    'Published {published}, left {skipped} for a person, {failed} failed.',
  'AI 审核已完成': 'AI moderation finished',
  'AI 审核运行失败': 'AI moderation could not run',
  'AI 风险分 {score}': 'AI risk score {score}',
  'AI：未发现明显风险': 'AI: no obvious risk',
};

export default fragment;
