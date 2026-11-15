import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/admin/Comments.tsx` */
const fragment: Dictionary = {
  // ---- 页头 ----
  '评论与审核': 'Comments & review',
  '处理待审评论、隐藏不合适的发言，并决定本站的评论策略。':
    'Work through pending comments, hide what does not belong, and decide this site’s comment policy.',
  '审核员': 'Reviewer',

  // ---- 评论设置 ----
  '评论设置': 'Comment settings',
  '立即生效，保存在本地安装配置。':
    'Applied immediately and stored in the local install configuration.',
  '已开启': 'On',
  '已关闭': 'Off',
  '允许评论': 'Allow comments',
  '关闭后文章与帖子底部不再显示评论框，已有评论仍然保留。':
    'When off, articles and posts no longer show a comment box; existing comments are kept.',
  '先审后发': 'Review before publishing',
  '新评论进入待审核队列，通过后才会公开显示。':
    'New comments wait in the review queue and only appear publicly once approved.',
  '评论须知': 'Comment notice',
  '显示在评论框上方，留空则不显示。': 'Shown above the comment box; leave it empty to hide it.',
  '例如：请就事论事，尊重其他读者；广告与人身攻击会被删除。':
    'For example: stick to the point and respect other readers; ads and personal attacks will be removed.',
  '先审后发需要服务端策略': 'Review before publishing needs a server-side policy',
  '当前连接真实后端：新评论默认直接发布，这个开关只影响演示数据。':
    'You are connected to a real backend: new comments are published straight away, so this switch only affects demo data.',
  '服务端接入站点级评论审核策略后才会真正拦下评论。':
    'Comments are only really held back once the server enforces a site-level moderation policy.',

  // ---- 审核规则 ----
  '审核规则': 'Moderation rules',
  '评论状态与内容状态是两条独立的流水线。':
    'Comment status and content status are two separate pipelines.',
  '所有人可见': 'Visible to everyone',
  '作者与审核员可见': 'Visible to the author and reviewers',
  '已隐藏': 'Hidden',
  '仅审核员可见': 'Visible to reviewers only',
  '已删除': 'Deleted',
  '保留占位，回复仍在': 'Placeholder kept; replies stay in place',
  '审核员与管理员可以隐藏任何评论；作者可以删除自己的评论。删除是软删除，不会抹掉上下文。':
    'Reviewers and admins can hide any comment; authors can delete their own. Deleting is a soft delete that never erases the thread.',

  // ---- 搜索与列表 ----
  '作者': 'Author',
  '所在内容': 'Content',
  '评论': 'Comment',
  '搜索作者或评论内容，回车确认': 'Search authors or comment text, then press Enter',
  '搜索评论': 'Search comments',
  '清除': 'Clear',
  '通过': 'Approve',
  '隐藏': 'Hide',
  '加载更多': 'Load more',
  '回复 · {id}': 'Reply · {id}',
  '回复评论': 'Reply to a comment',

  // ---- 加载状态与空状态 ----
  '评论加载失败。': 'Could not load comments.',
  '正在载入评论': 'Loading comments',
  '没有匹配的评论': 'No matching comments',
  '这个分组里还没有评论': 'No comments in this group yet',
  '换一个关键词，或清除搜索条件。': 'Try another keyword, or clear the search.',
  '读者在文章下方留言后，评论会出现在这里。':
    'Comments show up here once readers write them under your articles.',
  '评论当前处于关闭状态，已有评论不会丢失。':
    'Comments are currently turned off; existing comments are not lost.',

  // ---- 操作反馈 ----
  '评论已通过': 'Comment approved',
  '评论已驳回': 'Comment rejected',
  '评论已隐藏': 'Comment hidden',
  '评论已删除': 'Comment deleted',
  '驳回': 'Reject',
  '评论策略已保存': 'Comment policy saved',
  '评论策略由服务端执行': 'The server enforces the comment policy',
  '关闭评论后，即使直接调用接口也会被拒绝；先审后发时新评论进入待审核队列。':
    'With comments off, even direct API calls are refused; in review mode new comments wait in the queue.',
  '立即生效，由服务端强制执行。':
    'Applied immediately and enforced by the server.',
  '删除这条评论？': 'Delete this comment?',
  '评论会被标记为已删除，作者与审核员仍能看到占位，回复保持完整。':
    'The comment is marked as deleted; the author and reviewers still see a placeholder, and replies stay intact.',
  '删除评论': 'Delete comment',

  // ---- 页脚说明（含 <code> 分段） ----
  '演示模式的评论保存在浏览器；连接真实后端时，评论列表与审核动作走':
    'In demo mode comments are stored in the browser; with a real backend, listing and moderating comments go through',
  '与': 'and',
  '。': '.',

  // ---- 内容安全 ----
  '内容安全': 'Content safety',
  '敏感词、评论频率与 IP 黑白名单均由服务端执行，命中会写入站点日志。':
    'Sensitive words, comment frequency limits and IP allow/deny lists are enforced by the server; matches are written to the site audit log.',
  '服务端执行': 'Server enforced',
  '敏感词': 'Sensitive word',
  '评论频率': 'Comment frequency',
  'IP 名单': 'IP lists',
  '正在载入内容安全策略': 'Loading content safety policy',
  '内容安全策略加载失败。': 'Could not load the content safety policy.',
  '至少 2 个字符；英文匹配不区分大小写。':
    'At least 2 characters; English matching is case-insensitive.',
  '例如：违禁词': 'For example: banned phrase',
  '命中动作': 'When matched',
  '拒绝提交': 'Reject submission',
  '替换为占位符': 'Replace with placeholder',
  '标记待审': 'Hold for review',
  '占位符': 'Placeholder',
  '添加敏感词': 'Add sensitive word',
  '还没有敏感词': 'No sensitive words yet',
  '添加后，评论与内容提交会在服务端执行这里配置的动作。':
    'Once added, comment and content submissions run the configured action on the server.',
  '敏感词至少需要 2 个字符': 'A sensitive word needs at least 2 characters',
  '敏感词已添加': 'Sensitive word added',
  '添加失败': 'Could not add',
  '敏感词规则已更新': 'Sensitive word rule updated',
  '更新失败': 'Could not update',
  '敏感词已删除': 'Sensitive word deleted',
  '删除失败': 'Could not delete',
  '每位用户 / 窗口': 'Per member / window',
  '登录用户在该窗口内最多发表的评论数，0 表示停用。':
    'Comments a signed-in member may write in one window; 0 disables the counter.',
  '每个 IP / 窗口': 'Per IP / window',
  '匿名与登录评论都按来源地址计数，0 表示停用。':
    'Anonymous and signed-in comments are both counted by source address; 0 disables the counter.',
  '窗口秒数': 'Window seconds',
  '保存频率限制': 'Save frequency limits',
  '评论频率已保存': 'Comment frequency saved',
  '超限会返回 429': 'Over the limit answers 429',
  '超过窗口阈值时，评论接口返回 problem+json 429，并带 Retry-After 与 details.retry_after_seconds。':
    'Beyond the window threshold the comment endpoint answers problem+json 429 with Retry-After and details.retry_after_seconds.',
  '类型': 'Type',
  '黑名单（拒绝）': 'Deny list',
  '白名单（放行）': 'Allow list',
  '地址或网段': 'Address or network',
  '支持单个 IPv4 / IPv6 地址或 CIDR，例如 203.0.113.0/24。':
    'Accepts a single IPv4/IPv6 address or a CIDR block, for example 203.0.113.0/24.',
  '例如：203.0.113.0/24': 'For example: 203.0.113.0/24',
  '请填写 IP 地址或 CIDR 网段': 'Enter an IP address or CIDR block',
  '备注（可选）': 'Note (optional)',
  '备注': 'Note',
  '添加 IP 规则': 'Add IP rule',
  'IP 规则已添加': 'IP rule added',
  'IP 规则已删除': 'IP rule deleted',
  '黑名单优先': 'Deny rules win',
  '只要存在白名单，站点就只放行名单内的地址；黑名单始终优先。本机回环地址始终放行，避免把自己锁在管理页之外。':
    'As soon as an allow rule exists the site only accepts listed addresses; deny rules always win. Loopback is always allowed so you cannot lock yourself out of the admin screen.',
  '白名单': 'Allow',
  '黑名单': 'Deny',
  '还没有 IP 规则': 'No IP rules yet',
  '添加黑名单可拒绝特定来源；添加白名单后仅放行名单内地址。':
    'Add a deny rule to refuse a source, or an allow rule to serve only listed addresses.',
  'AI 审核': 'AI moderation',
  '本地风险评分，不把评论正文发送到外部服务。':
    'Local risk scoring; comment text is never sent to an external service.',
  '启用 AI 审核辅助': 'Enable AI moderation assist',
  '在评论列表里标出高风险评论，并给审核员处理建议；不会自动删除评论。':
    'Flags risky comments in the list and suggests an action; comments are never deleted automatically.',
  敏感度: 'Sensitivity',
  '低（只报明显风险）': 'Low (only obvious risks)',
  '中（默认）': 'Medium (default)',
  '高（宁可多报）': 'High (report more)',
  处理方式: 'Response',
  '「自动标记」会把高风险评论在列表中标红，并在打开时提示先处理。':
    '“Auto flag” highlights high-risk comments in the list and reminds you to handle them first.',
  只给建议: 'Suggest only',
  自动标记高风险: 'Auto flag high risk',
  自定义风险词: 'Custom risk terms',
  '用逗号分隔；命中一次加 5 分。':
    'Separate with commas; each hit adds 5 points.',
  '例如：竞品名、引流词': 'e.g. a competitor name or a spam term',
  'AI：高风险': 'AI: high risk',
  'AI：需留意': 'AI: needs a look',

  // ---- 拆分评论审核 / 审核设置后的队列页 ----
  评论审核: 'Comment review',
  '处理待审评论、隐藏不合适的发言；评论策略与 AI 权限在「审核设置」中调整。':
    'Approve pending comments, hide what does not belong, and adjust comment policy and AI permissions under Moderation settings.',
  'AI 审核已开启': 'AI moderation is on',
  'AI 只打风险分，不会代替审核员处理。':
    'AI only scores risk; it does not act on your behalf.',
  '先审后发已开启：AI 会自动通过低风险的待审评论，中高风险留给人工。':
    'Review before publishing is on: AI approves low-risk pending comments and leaves medium and high risk to a person.',
  '先审后发未开启：AI 会自动删除高风险的公开评论，其余保持不变。':
    'Review before publishing is off: AI deletes high-risk public comments and leaves the rest untouched.',
  立即运行: 'Run now',
  '最近一轮：通过 {approved} 条，删除 {deleted} 条，失败 {failed} 条。':
    'Last pass: {approved} approved, {deleted} deleted, {failed} failed.',
  'AI 审核已完成': 'AI moderation finished',
  '自动通过 {approved} 条，自动删除 {deleted} 条。':
    'Automatically approved {approved} and deleted {deleted}.',
  'AI 审核运行失败': 'AI moderation could not run',
};

export default fragment;
