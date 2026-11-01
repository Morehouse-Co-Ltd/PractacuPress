import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/components/blocks/Nightflight.tsx` */
const fragment: Dictionary = {
  搜索站内内容: 'Search this site',
  '30 天': '30 days',
  '{count} 次阅读': { one: '1 view', other: '{count} views' },
  '{count} 次': { one: '1 view', other: '{count} views' },
  '还没有已发布内容，热门榜会在有阅读记录后出现。':
    'Nothing published yet; the popular list appears once there are reads.',
  '还没有分类。可以在属性里切到「自动读取分类」，或手动添加胶囊。':
    'No categories yet. Switch to “Read categories automatically” in the block settings, or add pills by hand.',
  '分类 {count}': 'Category {count}',
  还没有精选: 'Nothing featured yet',
  '发布第一篇文章，这里会把它放在聚光灯下。':
    'Publish your first article and it will be shown in the spotlight here.',
  '{count} 篇': { one: '1 entry', other: '{count} entries' },
  '发布内容后，这里会出现文章卡片。':
    'Article cards will appear here once you publish something.',
  内容类型: 'Content type',
  更多: 'More',
  查看更多: 'View more',
  '发布内容后，这里会出现封面卡。':
    'Cover cards will appear here once you publish something.',
  欢迎光临: 'Welcome',
  '写作者拥有自己的稿子，读者被当作邻居。':
    'Writers own their own drafts, and readers are treated as neighbours.',
  '还没有标签。在「页面编排 → 编排」里添加。':
    'No tags yet. Add them under “Page layout → Arrange”.',
  '标签 {count}': 'Tag {count}',
  文章总数: 'Articles',
  建站天数: 'Days online',
  全站字数: 'Words',
  '{count} 天': { one: '1 day', other: '{count} days' },
  '还没有已发布内容，归档会自动按月份统计。':
    'Nothing published yet; the archive groups by month automatically.',
  '{month} 月 {year}': '{month}/{year}',
  '还没有节点。在「页面编排 → 编排」里添加。':
    'No milestones yet. Add them under “Page layout → Arrange”.',
  命令面板: 'Command palette',
  深浅切换: 'Toggle light and dark',
  回首页: 'Back to home',
  快捷键: 'Shortcuts',
  // 与同目录其它区块片段重合的词，按本文件自己的渲染点补齐一份，避免依赖别人的片段。
  文章: 'Article',
  帖子: 'Post',
  全部文章: 'All articles',
  搜索文章: 'Search articles',
  分类: 'Category',
  还没有文章: 'No articles yet',
  还没有内容: 'No content yet',
  编辑部: 'Editorial team',
  '{count} 分钟': { one: '1 min read', other: '{count} min read' },
  '{count} 分钟阅读': { one: '1 min read', other: '{count} min read' },
};

export default fragment;
