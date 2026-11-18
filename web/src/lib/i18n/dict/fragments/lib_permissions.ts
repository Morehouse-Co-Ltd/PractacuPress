import type { Dictionary } from '../../plural';

/** 来源：`web/src/lib/permissions.ts` */
const fragment: Dictionary = {
  // ---- 能力 ----
  阅读内容: 'Read content',
  '查看已发布的文章与帖子。': 'View published articles and posts.',
  发表评论: 'Comment',
  '在文章与帖子下参与讨论、回复他人。': 'Join the discussion under articles and posts, and reply to others.',
  创建内容: 'Create content',
  '写文章、发帖子，进入内容库。': 'Write articles and posts, and add them to the content library.',
  审核内容: 'Review content',
  '处理审核队列，发布、退回与归档。': 'Work the review queue: publish, reject, and archive.',
  管理评论: 'Manage comments',
  '通过、隐藏与删除评论。': 'Approve, hide, and delete comments.',
  管理成员: 'Manage members',
  '创建账户、调整角色。': 'Create accounts and change roles.',
  管理站点: 'Manage site',
  '站点设置、外观、主题、页面与扩展。': 'Site settings, appearance, themes, pages, and extensions.',
  查看操作日志: 'View activity log',
  '阅读后台的操作记录。': 'Read the dashboard activity record.',
  配置权限组: 'Configure permission groups',
  '修改这份能力矩阵。': 'Edit this capability matrix.',

  // ---- 权限组 ----
  游客: 'Guest',
  '未登录访客，只能阅读公开内容。': 'Signed-out visitors; they can only read public content.',
  成员: 'Member',
  '自助注册或由管理员创建，可以评论与投稿。': 'Self sign-up or created by an admin; they can comment and submit.',
  审核员: 'Reviewer',
  '处理内容与评论审核，可以直接发布。': 'Handle content and comment review, and can publish directly.',
  管理员: 'Administrator',
  '管理成员、站点设置与外观。': 'Manage members, site settings, and appearance.',
  最高管理员: 'Super admin',
  '拥有全部权限，包括配置权限组。': 'Has every capability, including configuring permission groups.',
};

export default fragment;
