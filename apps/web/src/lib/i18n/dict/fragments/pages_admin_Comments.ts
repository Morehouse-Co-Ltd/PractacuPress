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
  '立即生效，保存在本地安装配置；真实后端上线后应改为服务端站点策略。':
    'Applied immediately and stored in the local install configuration; once a real backend is live this should become a server-side site policy.',
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
  '评论已隐藏': 'Comment hidden',
  '评论已删除': 'Comment deleted',
  '删除这条评论？': 'Delete this comment?',
  '评论会被标记为已删除，作者与审核员仍能看到占位，回复保持完整。':
    'The comment is marked as deleted; the author and reviewers still see a placeholder, and replies stay intact.',
  '删除评论': 'Delete comment',

  // ---- 页脚说明（含 <code> 分段） ----
  '演示模式的评论保存在浏览器；连接真实后端时，评论列表与审核动作走':
    'In demo mode comments are stored in the browser; with a real backend, listing and moderating comments go through',
  '与': 'and',
  '。': '.',
};

export default fragment;
