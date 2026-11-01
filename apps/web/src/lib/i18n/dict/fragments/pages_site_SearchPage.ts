import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/site/SearchPage.tsx` */
const fragment: Dictionary = {
  // ---- 页面标题与 SEO ----
  '搜索：{query}': 'Search: {query}',
  '在已发布内容与自定义页面里搜索。': 'Search published content and custom pages.',

  // ---- 页头与搜索框 ----
  '在稿子里找一句话。': 'Find a sentence in the manuscripts.',
  '搜索已发布内容与自定义页面；草稿、被退回的稿子和未发布页面不会出现在结果里。搜索词里的通配符按字面处理。':
    'Searches published content and custom pages; drafts, rejected manuscripts and unpublished pages never appear in the results. Wildcards in the search term are treated literally.',
  '输入至少 2 个字符，例如：排版': 'Enter at least 2 characters, for example: typesetting',
  搜索词: 'Search term',
  排版: 'Typesetting',
  审核: 'Review',
  社区: 'Community',
  独立出版: 'Independent publishing',
  '搜索词至少 2 个字符。': 'The search term needs at least 2 characters.',

  // ---- 分类筛选与结果计数 ----
  范围: 'Scope',
  文章: 'Article',
  帖子: 'Post',
  '正在搜索…': 'Searching…',
  '找到 {count} 条': { one: 'Found 1 result', other: 'Found {count} results' },
  '{count} 个页面': { one: '1 page', other: '{count} pages' },
  等待关键词: 'Waiting for a keyword',

  // ---- 失败与空状态 ----
  搜索没有完成: 'The search did not finish',
  '请求失败。': 'Request failed.',
  输入一个词开始搜索: 'Enter a word to start searching',
  '标题、摘要与页面正文都会参与匹配。只覆盖已发布内容与页面。':
    'Titles, summaries and page bodies all take part in matching. Only published content and pages are covered.',
  '没有找到「{query}」': 'No results for "{query}"',
  '换一个更短的词，或者去掉分类筛选。': 'Try a shorter word, or drop the type filter.',
  搜索全部类型: 'Search all types',

  // ---- 结果条目 ----
  页: 'Page',
  自定义页面: 'Custom page',
  '更新于 {date}': 'Updated {date}',
  文: 'Art',
  帖: 'Post',
  编辑部: 'Editorial team',
  '{count} 分钟': { one: '1 min read', other: '{count} min read' },
};

export default fragment;
