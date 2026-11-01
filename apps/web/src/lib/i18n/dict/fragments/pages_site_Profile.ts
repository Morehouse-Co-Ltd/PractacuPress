import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/site/Profile.tsx` */
const fragment: Dictionary = {
  // ---- 主页元信息与标题 ----
  未知用户: 'Unknown member',
  '{name} 在 {site} 主页与已发布内容。': '{name}’s profile and published work on {site}.',
  '加入于 {date} · {site}': 'Joined {date} · {site}',

  // ---- 主页操作 ----
  我的通知: 'My notifications',
  关注: 'Follow',
  登录后关注: 'Sign in to follow',

  // ---- 资料统计 ----
  加入时间: 'Joined',
  本人: 'You',
  未关注: 'Not following',
  关注状态: 'Follow status',

  // ---- 已发布内容列表 ----
  我的文章与帖子: 'My articles and posts',
  'TA 的文章与帖子': 'Their articles and posts',
  '{count} 篇': { one: '1 entry', other: '{count} entries' },
  还没有已发布的内容: 'Nothing published yet',
  '草稿与被退回的稿子不会出现在公开主页。':
    'Drafts and rejected drafts never appear on the public profile.',

  // ---- 主页不可用 ----
  无法打开这个主页: 'Cannot open this profile',
  '这位成员不在当前站点里，或主页还没有公开。':
    'This member is not on this site, or the profile is not public yet.',
};

export default fragment;
