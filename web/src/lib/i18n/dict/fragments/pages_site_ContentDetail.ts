import type { Dictionary } from '../../plural';

/** 来源：`web/src/pages/site/ContentDetail.tsx` */
const fragment: Dictionary = {
  // ---- 评论条目 ----
  读者: 'Reader',
  已删除: 'Deleted',
  待审核: 'Pending review',
  回复: 'Reply',
  '该评论已删除。': 'This comment has been deleted.',
  '回复 {name}…': 'Reply to {name}…',
  这条评论: 'this comment',
  发送回复: 'Send reply',

  // ---- 面包屑与页面元信息 ----
  首页: 'Home',
  文章: 'Article',
  帖子: 'Post',
  '返回{kind}列表': 'Back to {kind}s',
  '安全策略 · {version}': 'Security policy · {version}',
  编辑部: 'Editorial team',
  '{count} 分钟阅读': { one: '1 min read', other: '{count} min read' },
  复制链接: 'Copy link',
  在后台编辑: 'Edit in the dashboard',

  // ---- 互动提示 ----
  已点赞: 'Liked',
  已取消点赞: 'Like removed',
  已加入收藏: 'Added to bookmarks',
  已取消收藏: 'Removed from bookmarks',
  已关注作者: 'Now following the author',
  已取消关注: 'Unfollowed',
  链接已复制: 'Link copied',
  无法复制链接: 'Could not copy the link',
  '请从地址栏手动复制。': 'Please copy it from the address bar manually.',
  点赞: 'Like',
  已收藏: 'Bookmarked',
  收藏: 'Bookmark',
  分享: 'Share',
  '最后更新 {date}': 'Last updated {date}',

  // ---- 举报 ----
  '举报': 'Report',
  '举报这篇内容': 'Report this content',
  '举报会进入站长与审核员的后台队列。恶意举报会被记录。':
    'Reports go to the site owner and reviewer queue. Abusive reports are recorded.',
  '提交举报': 'Submit report',
  '举报原因': 'Reason',
  '垃圾广告': 'Spam',
  '辱骂与骚扰': 'Abuse or harassment',
  '违法或侵权内容': 'Illegal or infringing content',
  '其他': 'Other',
  '补充说明': 'Additional details',
  '可选：告诉审核员问题出在哪里。':
    'Optional: tell the reviewer what is wrong.',
  '举报已提交': 'Report submitted',
  '站长会尽快处理，感谢你的反馈。':
    'The site owner will look into it. Thanks for your feedback.',
  '举报失败': 'Could not submit the report',

  // ---- 加载失败 ----
  '这篇内容不存在': 'This content does not exist',
  '暂时无法打开': 'Cannot open it right now',
  '请稍后重试。': 'Please try again later.',
  返回列表: 'Back to the list',

  // ---- 作者卡片 ----
  作者: 'Author',
  '写作者 · 已发布内容归作者所有': 'Writer · published work belongs to the author',
  已关注: 'Following',
  关注作者: 'Follow author',
  作者主页: 'Author profile',

  // ---- 评论区 ----
  讨论: 'Discussion',
  评论已关闭: 'Comments are closed',
  暂时无法读取评论: 'Comments are temporarily unavailable',
  '本站已经关闭评论。站长可以在「后台 → 评论与审核 → 评论设置」里重新开启。':
    'Comments are turned off on this site. The site owner can turn them back on under Dashboard → Comments & moderation → Comment settings.',
  '评论可以写入，但暂时读不回来': 'Comments can be saved, but cannot be read back yet',
  '当前后端还没有提供评论列表接口。评论已经保存，接口补齐后就会显示出来； 演示模式下评论是完整的。':
    'This backend does not provide a comments list endpoint yet. Comments are already saved and will appear once it does; comments are complete in demo mode.',
  以: 'Commenting as',
  '的身份评论': '',
  '本站开启先审后发：评论通过审核后才会公开显示。':
    'This site reviews comments before publishing: they become public only after approval.',
  '先审后发目前只在演示模式生效；真实后端需要接入站点级评论策略。':
    'Review-before-publish currently works only in demo mode; a real backend needs the site-level comment policy wired in.',
  '写下你的回应。请遵守站点的讨论规则。': 'Write your response. Please follow the site discussion rules.',
  发表评论: 'Post comment',
  '当前账户没有发表评论的权限。站长可以在「用户组」里开启。':
    'This account is not allowed to comment. The site owner can enable it under Groups.',
  '登录后可以参与讨论、回复其他读者。': 'Sign in to join the discussion and reply to other readers.',
  登录后评论: 'Sign in to comment',
  '评论列表不可用。': 'The comment list is unavailable.',
  '还没有人说话。你可以第一个。': 'No one has spoken yet. You can go first.',
  '还没有评论。': 'No comments yet.',

  // ---- 评论提交与删除 ----
  '没有评论权限': 'You are not allowed to comment',
  '站长可以在用户组里开启这项能力。': 'The site owner can enable this under user groups.',
  回复已提交: 'Reply submitted',
  评论已提交: 'Comment submitted',
  '通过审核后才会公开显示。': 'It becomes public after review.',
  回复已发送: 'Reply sent',
  评论已发布: 'Comment published',
  发送失败: 'Could not send',
  评论已更新: 'Comment updated',
  更新失败: 'Could not update',
  评论已删除: 'Comment deleted',
  删除失败: 'Could not delete',
  '删除这条评论？': 'Delete this comment?',
  '评论会被标记为已删除，回复仍然保留。这个操作无法在界面上撤销。':
    'The comment will be marked as deleted and its replies are kept. This cannot be undone from the interface.',
  删除评论: 'Delete comment',

  // ---- 继续阅读 ----
  继续阅读: 'Keep reading',
  '全部{kind}': 'All {kind}s',

  // ---- 分类 / 标签入口与上下篇 ----
  未分类: 'Uncategorized',
  上一篇与下一篇: 'Previous and next',
  上一篇: 'Previous',
  下一篇: 'Next',
  已经是第一篇: 'This is the first one',
  已经是最新一篇: 'This is the latest one',

  // ---- 密码访问与单篇评论策略 ----
  这篇内容受密码保护: 'This item is password protected',
  '输入作者设置的访问密码后即可阅读。密码只保存在当前浏览器会话中。':
    'Enter the access password to read it. The password is kept only in this browser session.',
  访问密码: 'Access password',
  解锁阅读: 'Unlock and read',
  这篇内容仅登录读者可读: 'This item is for signed-in readers',
  '请先登录账户，再回到这个链接继续阅读。':
    'Sign in, then return to this link to continue reading.',
  登录后阅读: 'Sign in to read',
  '这篇内容已关闭评论。': 'Comments are closed for this item.',
  '解锁失败。': 'Could not unlock this item.',
};

export default fragment;
