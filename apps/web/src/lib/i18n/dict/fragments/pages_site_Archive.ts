import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/site/Archive.tsx` */
const fragment: Dictionary = {
  // ---- SEO 与页头 ----
  '全部已发布文章，按时间倒序。': 'All published articles, newest first.',
  '全部已发布帖子，按时间倒序。': 'All published posts, newest first.',
  全部已发布文章: 'All published articles',
  全部已发布帖子: 'All published posts',
  '较长的稿子，允许修订与审核。已发布内容冻结，修改需要重新走流程。':
    'Longer manuscripts, open to revision and review. Published content is frozen; edits have to go through the workflow again.',
  '短内容与讨论帖。适合一句话、一个链接，或者一次编辑部周会。':
    'Short notes and discussion posts. Good for a single sentence, a link, or one editorial stand-up.',

  // ---- 筛选与计数 ----
  '在当前列表中筛选标题': 'Filter titles in the current list',
  文章显示方式: 'Article display mode',
  筛选: 'Filter',
  '公开阅读 · 已载入 {count} 篇': {
    one: 'Public reading · 1 loaded',
    other: 'Public reading · {count} loaded',
  },

  // ---- 读取失败 ----
  '无法读取列表': 'Could not load the list',
  '这个站点设置为「登录后浏览」，请先登录。':
    'This site is set to members only. Please sign in first.',
  '请求失败。': 'Request failed.',
  去登录: 'Go to sign in',

  // ---- 空状态 ----
  '没有匹配的内容': 'Nothing matches',
  还没有文章: 'No articles yet',
  还没有帖子: 'No posts yet',
  '换一个关键词试试。': 'Try a different keyword.',
  '发布后会出现在这里。': 'Published work shows up here.',

  // ---- 条目元信息 ----
  '{count} 分钟': { one: '1 min read', other: '{count} min read' },
  编辑部: 'Editorial team',

  // ---- 分页 ----
  '加载更多': 'Load more',
  '已经到底了。共 {count} 篇。': {
    one: 'That is the end. 1 in total.',
    other: 'That is the end. {count} in total.',
  },

  // ---- 页脚提示（句子被 <Link> 拆成三段） ----
  '公开列表只展示已发布内容。草稿、待审核与已归档的稿件在':
    'Public lists show published content only. Drafts, pending review and archived manuscripts live in',
  ' 内容库 ': ' the Content library',
  '里。': '.',

  // ---- 仅成员可见 ----
  '这是一个仅成员可见的站点': 'This site is visible to members only',
  '匿名访客会收到 401。登录后可以继续阅读。':
    'Anonymous visitors get a 401. Sign in to keep reading.',

  // ---- 分类 / 标签入口与年/月分组 ----
  分类: 'Categories',
  标签: 'Tags',
  年份快速跳转: 'Jump to a year',
  '{count} 篇': { one: '1 item', other: '{count} items' },
  '{month} 月': 'Month {month}',
};

export default fragment;
