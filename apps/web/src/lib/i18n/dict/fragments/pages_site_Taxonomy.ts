import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/site/Taxonomy.tsx` */
const fragment: Dictionary = {
  // ---- 共用导航 ----
  分类: 'Categories',
  标签: 'Tags',
  全部文章: 'All articles',
  全部标签: 'All tags',
  范围: 'Scope',
  最新: 'Newest',
  最早: 'Oldest',

  // ---- 分类列表 ----
  '按分类浏览全部已发布内容。': 'Browse all published content by category.',
  '按主题浏览已发布内容；卡片按篇数从多到少排列。':
    'Browse published work by theme. Cards are ordered from the most to the least work.',
  还没有分类: 'No categories yet',
  '站长可以在后台的分类与标签里创建分类。':
    'The site owner can create categories under Taxonomy in the dashboard.',
  去读文章: 'Read articles',
  '{count} 篇': { one: '1 item', other: '{count} items' },
  '这个分类还没有说明。': 'This category has no description yet.',
  浏览分类: 'Browse category',

  // ---- 标签云 ----
  '按标签浏览全部已发布内容。': 'Browse all published content by tag.',
  '字号随篇数变化；标签越多，字号越大。':
    'Text size follows the number of items: the more items, the larger the tag.',
  按篇数: 'By count',
  按名称: 'By name',
  还没有标签: 'No tags yet',
  '给内容加上标签后，它们会出现在这里。':
    'Tags appear here once content is tagged.',
  标签云: 'Tag cloud',

  // ---- 归档详情 ----
  '{name} 分类下的全部已发布内容。': 'All published content in the {name} category.',
  '带有「{name}」标签的全部已发布内容。': 'All published content tagged "{name}".',
  '{name} 分类归档': '{name} category archive',
  '{name} 标签归档': '{name} tag archive',
  未命名: 'Untitled',
  '带有这个标签的内容会归在这里。': 'Content with this tag is collected here.',
  '共 {count} 篇': { one: '1 item in total', other: '{count} items in total' },
  这个归档还没有内容: 'This archive is empty',
  '换一个分类或标签，或者先发布几篇内容。':
    'Try another category or tag, or publish a few pieces first.',
};

export default fragment;
