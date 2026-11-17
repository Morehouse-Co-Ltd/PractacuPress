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

  // ---- 服务端规则评分（Beta 1.2）：评分在服务端算，界面只读 ----
  '服务端规则评分': 'Server rule score',
  '风险分由服务端按规则算好：外链、篇幅、重复字符、大小写与标点，权重固定、可复核。这是规则评分，不是模型推理；页面只读结果，不在浏览器重算。':
    'The server scores each draft with fixed, checkable rules: outbound links, length, repeated characters, letter case and punctuation. These are rule scores, not model inference; this page only reads them and never recomputes them in the browser.',
  '演示模式没有服务端评分，待审稿件按 0 分显示，自动发布不会运行。':
    'The demo has no server scores, so drafts show 0 and automatic publishing does not run.',
  '风险分 {score}': 'Risk score {score}',
  高风险: 'High risk',
  '规则评分未发现明显风险信号。': 'The rule score found no obvious risk signal.',

  // 风险标识：与服务端 platform/textrisk 的常量一一对应，写法与评论审核页一致。
  含多个链接: 'Multiple links',
  内容过短: 'Too short',
  内容过长: 'Too long',
  重复字符过多: 'Run of repeated characters',
  大量大写字母: 'Mostly upper case',
  几乎没有文字: 'Almost no words',
  重复文本堆砌: 'Repeated text',

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

  // ---- 按服务端分数自动发布 ----
  '自动发布权限已开启：风险分不高于 {threshold} 的待审稿件会自动发布，中高风险留在队列里。':
    'Automatic publishing is on: pending drafts scoring {threshold} or less are published automatically; medium and high risk stay in the queue.',
  '立即运行一轮自动发布': 'Run one automatic publish pass now',
  '最近一轮：自动发布 {published} 篇，留待人工 {skipped} 篇，失败 {failed} 篇。':
    'Last pass: {published} published, {skipped} left for a person, {failed} failed.',
  '自动发布 {published} 篇，留待人工 {skipped} 篇，失败 {failed} 篇。':
    'Published {published}, left {skipped} for a person, {failed} failed.',
  '自动发布已完成': 'Automatic publishing finished',
  '自动发布运行失败': 'Automatic publishing could not run',

  // ---- 退回弹窗 ----
  '退回《{title}》': 'Send back “{title}”',
  '理由会写入状态记录并通知作者。请写清楚需要修改的地方。':
    'The reason goes into the status record and is sent to the author. Be specific about what needs to change.',
  确认退回: 'Send it back',
  退回理由: 'Reason for sending back',
  '例如：第二段的统计口径与来源不一致，请补充说明。':
    'For example: the figures in the second paragraph disagree with their source; please explain.',
};

export default fragment;
