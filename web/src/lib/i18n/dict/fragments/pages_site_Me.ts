import type { Dictionary } from '../../plural';

/** 来源：`web/src/pages/site/Me.tsx`（个人中心：收藏 / 点赞 / 阅读历史 / 关注 / 粉丝 / 成员目录） */
const fragment: Dictionary = {
  // ---- 页头与标签 ----
  我的互动: 'My activity',
  我的收藏: 'My bookmarks',
  我的点赞: 'My likes',
  阅读历史: 'Reading history',
  关注: 'Following',
  粉丝: 'Followers',
  成员目录: 'Member directory',
  '收藏、点赞、阅读历史，以及你关注的人和关注你的人。只有本人能看到这些列表。':
    'Bookmarks, likes, reading history, and the people you follow or who follow you. Only you can see these lists.',
  私信: 'Messages',

  // ---- 列表与空态 ----
  正在载入: 'Loading',
  无法载入: 'Could not load',
  '请稍后重试。': 'Please try again shortly.',
  还没有阅读记录: 'No reading history yet',
  还没有点赞: 'No likes yet',
  还没有收藏: 'No bookmarks yet',
  '浏览内容时产生的记录会出现在这里。':
    'Items you open, like or bookmark will show up here.',
  去看看文章: 'Browse articles',
  已不可见: 'No longer available',
  '读过 {count} 次': 'Read {count} times',
  取消收藏: 'Remove bookmark',
  取消点赞: 'Unlike',
  已取消收藏: 'Removed from bookmarks',
  已取消点赞: 'Like removed',
  操作失败: 'Action failed',
  还没有关注任何人: 'Not following anyone yet',
  还没有粉丝: 'No followers yet',
  '在作者主页点“关注”，这里会列出来。':
    'Follow an author from their profile and they will appear here.',
  '当其他成员关注你时，他们会出现在这里。':
    'Members who follow you will appear here.',
  发现成员: 'Find members',
  '自 {date}': 'Since {date}',
  取消关注: 'Unfollow',
  已取消关注: 'Unfollowed',

  // ---- 成员目录 ----
  搜索成员昵称: 'Search member names',
  没有找到成员: 'No members found',
  '换个关键词再试一次。': 'Try a different keyword.',
  查看主页: 'View profile',
};

export default fragment;
