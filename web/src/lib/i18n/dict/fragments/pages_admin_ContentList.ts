import type { Dictionary } from '../../plural';

/** 来源：`web/src/pages/admin/ContentList.tsx` */
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
  视图: 'View',
  回收站: 'Recycle bin',

  // ---- 载入失败与空状态 ----
  '无法读取内容': 'Could not load content',
  '请求失败。': 'Request failed.',
  '没有符合条件的内容': 'No content matches these filters',
  '内容库还是空的': 'The content library is empty',
  '换一个状态或关键词。列表只包含当前账户可见的内容。':
    'Try another status or keyword. The list only shows content this account can see.',
  '创建第一篇草稿，或者等待成员提交审核。':
    'Create the first draft, or wait for a member to submit one for review.',
  '创建第一篇草稿。': 'Create the first draft.',
  '新建草稿': 'New draft',
  '回收站是空的': 'The recycle bin is empty',
  '被删除的内容会保留在这里，直到你恢复或彻底删除它们。':
    'Deleted content stays here until you restore it or delete it permanently.',

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

  // ---- 回收站 ----
  '已删除于 {time}': 'Deleted {time}',
  只读: 'Read only',
  '已移入回收站': 'Moved to the recycle bin',
  '《{title}》可以在回收站里恢复。': '“{title}” can be restored from the recycle bin.',
  '删除失败': 'Delete failed',
  '已彻底删除': 'Permanently deleted',
  '《{title}》不会再出现在任何列表里。': '“{title}” will not appear in any list again.',
  '彻底删除失败': 'The permanent delete failed',

  // ---- 底部状态说明 ----
  '列表最多载入每种类型 100 条，状态筛选在浏览器内完成。站点管理员权限：{status}。':
    'Up to 100 items of each type are loaded, and status filtering happens in the browser. Site admin permission: {status}.',
  '已具备': 'Granted',
  '不具备（不影响内容操作）': 'Not granted (content actions are unaffected)',

  // ---- 归档 / 恢复 / 删除确认 ----
  '{action}《{title}》？': '{action} “{title}”?',
  '归档后内容会从公开列表移出，但已有链接仍然有效。':
    'Archiving removes the content from public lists, but existing links keep working.',
  '恢复后内容会重新进入公开列表。': 'Restoring puts the content back into public lists.',
  '内容会回到删除前的状态，可以继续编辑或发布。':
    'The content returns to the state it had before deletion and can be edited or published again.',
  '内容会移入回收站，之后仍然可以恢复。':
    'The content moves to the recycle bin and can still be restored later.',
  '彻底删除不可恢复：正文与版本历史都会一起删除。':
    'Permanent deletion cannot be undone: the body and version history are deleted with it.',
  '确认{action}': 'Confirm {action}',

  // ---- 预约与访问状态 ----
  '预约 {time}': 'Scheduled {time}',
  密码访问: 'Password',
  仅登录读者: 'Members only',

  // ---- 多选与批量操作（契约 G）----
  选择全部: 'Select all',
  '选择《{title}》': 'Select “{title}”',
  '已选择 {count} 项': 'Selected {count} items',
  清除选择: 'Clear selection',
  批量操作: 'Bulk actions',
  移入回收站: 'Move to recycle bin',
  批量操作完成: 'Bulk action finished',
  批量操作失败: 'Bulk action failed',
  '成功 {succeeded} 项，失败 {failed} 项。': '{succeeded} succeeded, {failed} failed.',
  '批量操作：{action}': 'Bulk action: {action}',
  '失败的条目（id · 错误码）：': 'Failed items (id · error code):',
  '{id} · {code}': '{id} · {code}',
  '对选中的 {count} 项执行「{action}」？': 'Run “{action}” on the {count} selected items?',
  '归档后选中的内容会从公开列表移出，但已有链接仍然有效。':
    'Archiving removes the selected content from public lists, but existing links keep working.',
  '撤销后选中的内容会回到草稿，公开链接将不再可访问。':
    'Unpublishing returns the selected content to draft and the public links stop working.',
  '选中的内容会移入回收站，之后仍然可以恢复。':
    'The selected content moves to the recycle bin and can still be restored later.',
  '选中的内容会从回收站恢复到删除前的状态。':
    'The selected content is restored from the recycle bin to the state it had before deletion.',

  // ---- 撤销发布（契约 I）----
  '撤销后内容会回到草稿，公开链接将不再可访问；之后可以再次发布。':
    'Unpublishing returns the content to draft and the public link stops working; you can publish it again later.',
};

export default fragment;
