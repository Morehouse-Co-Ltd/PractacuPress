import type { Dictionary } from '../plural';

/**
 * 非页面模块里的文案：标签表、权限、演示数据、扩展模板、API 错误码。
 *
 * 负责文件：`lib/format.ts`、`lib/permissions.ts`、`lib/site.ts`、`lib/demo.ts`、
 * `lib/demoSeed.ts`、`lib/logic.ts`、`lib/extensions.ts`、`lib/api.ts`。
 *
 * 说明：`lib/format.ts` 里的标签表已改成"取值时翻译"（见 `i18n/labels.ts`），
 * 所以这里放的就是那些标签的中文原文作键。
 */
const lib: Dictionary = {
  // ---- 角色 ----
  平台管理员: 'Platform admin',
  站点管理员: 'Site admin',
  '编辑 / 审核员': 'Editor',
  成员: 'Member',
  '管理平台账户、站点与全局安全策略': 'Manage platform accounts, sites and global security policy',
  '管理本站点成员、内容规则、主题与存储': 'Manage this site’s members, content rules, theme and storage',
  '审核文章、帖子、评论与举报，可直接发布': 'Review articles, posts, comments and reports; can publish directly',
  '发布文章与帖子、评论、互动': 'Publish articles and posts, comment and react',

  // ---- 内容状态 ----
  草稿: 'Draft',
  待审核: 'Pending review',
  已发布: 'Published',
  已退回: 'Rejected',
  已归档: 'Archived',
  安全检查中: 'Security check',

  // ---- 内容类型 ----
  文章: 'Article',
  帖子: 'Post',

  // ---- 阅读与发布范围 ----
  公开浏览: 'Public',
  登录后浏览: 'Members only',
  开放发布: 'Open publishing',
  审核发布: 'Review required',
  按角色发布: 'Role based',

  // ---- 内容动作 ----
  提交审核: 'Submit for review',
  发布: 'Publish',
  退回: 'Reject',
  归档: 'Archive',
  恢复: 'Restore',
  重试安全检查: 'Retry security check',
  从回收站恢复: 'Restore from trash',
  彻底删除: 'Delete permanently',
  撤销发布: 'Unpublish',

  // ---- 相对时间 ----
  刚刚: 'just now',
  '{count} 分钟前': { one: '1 minute ago', other: '{count} minutes ago' },
  '{count} 小时前': { one: '1 hour ago', other: '{count} hours ago' },
  '{count} 天前': { one: '1 day ago', other: '{count} days ago' },
  '{count} 个月前': { one: '1 month ago', other: '{count} months ago' },
  '{count} 年前': { one: '1 year ago', other: '{count} years ago' },
};

export default lib;
