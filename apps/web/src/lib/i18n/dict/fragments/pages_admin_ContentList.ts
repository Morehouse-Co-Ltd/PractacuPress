import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/admin/ContentList.tsx` */
const fragment: Dictionary = {
  // ---- 页面标题与说明 ----
  '内容库': 'Content library',
  '文章与帖子的统一视图。状态由服务端状态机决定，前端只展示允许的动作。':
    'A single view of articles and posts. The server-side state machine decides each status; the interface only offers the actions it allows.',
  '新建帖子': 'New post',
  '新建文章': 'New article',

  // ---- 工具栏 ----
  '搜索标题、摘要或作者': 'Search titles, summaries, or authors',
  '搜索内容': 'Search content',
  '全部类型': 'All types',
  '{count} 条': { one: '1 item', other: '{count} items' },

  // ---- 载入失败与空状态 ----
  '无法读取内容': 'Could not load content',
  '请求失败。': 'Request failed.',
  '没有符合条件的内容': 'No content matches these filters',
  '内容库还是空的': 'The content library is empty',
  '换一个状态或关键词。列表只包含当前账户可见的内容。':
    'Try another status or keyword. The list only shows content this account can see.',
  '创建第一篇草稿，或者等待成员提交审核。':
    'Create the first draft, or wait for a member to submit one for review.',
  '新建草稿': 'New draft',

  // ---- 表格表头 ----
  '标题': 'Title',
  '封面': 'Cover',
  '首页精选': 'Homepage picks',
  '作者': 'Author',
  '更新时间': 'Updated',

  // ---- 封面单元格 ----
  '编辑《{title}》的封面': 'Edit the cover for “{title}”',
  '自定义封面 · 点击编辑': 'Custom cover · click to edit',
  '封面已隐藏': 'Cover hidden',
  '自动生成封面 · 点击编辑': 'Generated cover · click to edit',
  '隐藏': 'Hide',
  '自定义': 'Custom',

  // ---- 首页精选 ----
  '已取消置顶': 'Unpinned',
  '《{title}》不再出现在首页精选。': '“{title}” no longer appears in the homepage picks.',
  '最多置顶 {count} 篇': {
    one: 'Only 1 article can be pinned',
    other: 'At most {count} articles can be pinned',
  },
  '先在列表里取消一篇再试。': 'Unpin one in the list first, then try again.',
  '已置顶到首页': 'Pinned to the homepage',
  '《{title}》排在首页精选第 {position} 位。':
    '“{title}” sits at position {position} in the homepage picks.',
  '{title} 置顶到首页': 'Pin {title} to the homepage',
  '置顶到首页精选': 'Pin to homepage picks',
  '草稿不会出现在首页': 'Drafts never appear on the homepage',
  '占格大小': 'Tile size',

  // ---- 内容动作 ----
  '{action}成功': '{action} succeeded',
  '{action}失败': '{action} failed',
  '《{title}》现在是「{status}」': '“{title}” is now “{status}”',
  '去审核': 'Go to review',

  // ---- 底部状态说明 ----
  '列表最多载入每种类型 100 条，状态筛选在浏览器内完成。站点管理员权限：{status}。':
    'Up to 100 items of each type are loaded, and status filtering happens in the browser. Site admin permission: {status}.',
  '已具备': 'Granted',
  '不具备（不影响内容操作）': 'Not granted (content actions are unaffected)',

  // ---- 归档 / 恢复确认 ----
  '{action}《{title}》？': '{action} “{title}”?',
  '归档后内容会从公开列表移出，但已有链接仍然有效。':
    'Archiving removes the content from public lists, but existing links keep working.',
  '恢复后内容会重新进入公开列表。': 'Restoring puts the content back into public lists.',
  '确认{action}': 'Confirm {action}',

  // ---- 预约与访问状态 ----
  '预约 {time}': 'Scheduled {time}',
  密码访问: 'Password',
  仅登录读者: 'Members only',
};

export default fragment;
