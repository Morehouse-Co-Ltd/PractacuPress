import type { Dictionary } from '../../plural';

/**
 * 来源：`apps/web/src/components/blocks/QueryBlocks.tsx` 与
 * `apps/web/src/lib/blocks.ts` 里的 P3 查询块（`content-query`）。
 *
 * 查询块的注册表定义与渲染器是同一次改动，译文放同一个片段里，读取顺序与按源文件
 * 拆的片段一致（具体文案优先于通用词）。已存在于其它片段的共用词（分类、标签、
 * 全部、显示摘要……）不重复收录。
 */
const fragment: Dictionary = {
  '按分类、标签、时间与排序实时取内容；卡片样式与「文章组件」共用。':
    'Pulls content live by category, tag, time range and sort; the cards reuse the “Articles” block styles.',
  '按发布时间筛选。演示模式不按时间筛选。':
    'Filters by publish date. Demo mode does not filter by date.',
  按作者: 'By author',
  '分类 / 标签 / 作者': 'Category / tag / author',
  '单列列表': 'Single column list',
  '填 id 或名称，留空就是不筛选。演示模式不按它筛选。':
    'An id or a name; leave it empty to skip this filter. Demo mode does not filter.',
  '选「分类」「标签」「作者」时，下面的条件才带上服务端筛选。':
    'Only “Category”, “Tag” and “Author” send a filter to the server; pick one to make the field below count.',
  '演示模式不按它排序。': 'Demo mode does not re-sort.',
  '最新内容': 'Latest content',
  '最新优先': 'Newest first',
  '最旧优先': 'Oldest first',
  '最近 30 天': 'Last 30 days',
  '最近 7 天': 'Last 7 days',
  '正在读取内容…': 'Loading content…',
  '内容查询': 'Content query',
  '时间范围': 'Time range',
  '筛选来源': 'Filter source',
  '显示条数': 'Items to show',
  '这里还没有内容。': 'No content here yet.',
  '双列卡片': 'Two-column cards',
  '排序': 'Sort order',
};

export default fragment;
