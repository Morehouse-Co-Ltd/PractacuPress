import type { Dictionary } from '../../plural';

/** 来源：`web/src/pages/admin/Taxonomy.tsx` */
const fragment: Dictionary = {
  '分类与标签已保存到真实后端。': 'Categories and tags are saved to the real backend.',
  '当前使用本地安装配置；连接带分类端点的真实后端后会自动切换为服务端存储。':
    'Currently using the local installation configuration; once a real backend with taxonomy endpoints is connected, storage switches to the server automatically.',
  '分类用于归档文章，标签用于跨分类关联主题。两者会出现在文章编辑器的侧栏里。':
    'Categories archive articles, and tags connect topics across categories. Both appear in the sidebar of the article editor.',
  新增分类: 'New category',
  新增标签: 'New tag',
  编辑分类: 'Edit category',
  编辑标签: 'Edit tag',
  '共 {count} 项': { one: '1 item', other: '{count} items' },
  文章数: 'Articles',
  使用次数: 'Uses',
  '名称不能为空。': 'The name cannot be empty.',
  '这个名称已经存在。': 'This name already exists.',
  '这个路径已经被使用。': 'That path is already taken.',
  已更新: 'Updated',
  已新增: 'Added',
  '{kind}「{name}」': '{kind} “{name}”',
  '内容中的引用会保留为纯文本。': 'References in content are kept as plain text.',
  '列表最多载入每种内容类型 100 条；文章数与使用次数在浏览器内统计。':
    'The list loads at most 100 items of each content type; article and usage counts are computed in the browser.',
  '最后更新：{time}': 'Last updated: {time}',
  '名称显示在前台；英文路径用于筛选链接与导出。':
    'The name is shown on the public site; the English path is used in filter links and exports.',
  英文路径: 'English path',
  '小写字母、数字与连字符。': 'Lowercase letters, digits, and hyphens.',
  '例如：写作': 'For example: Writing',
  '例如：独立出版': 'For example: Independent publishing',
  '用于分类标记与内容卡片。': 'Used for the category marker and content cards.',
  '可选：这个分类收录什么内容。': 'Optional: what this category collects.',
  还没有分类: 'No categories yet',
  还没有标签: 'No tags yet',
  '创建后可以在文章编辑器里选择，也会出现在前台内容卡片上。':
    'Once created, it can be picked in the article editor and also appears on public content cards.',
  '删除{kind}「{name}」？': 'Delete {kind} “{name}”?',
  '内容不会删除，已有引用会保留为纯文本。这个操作不能撤销。':
    'Content is not deleted; existing references are kept as plain text. This action cannot be undone.',
  '有 {count} 篇内容使用这个分类。': {
    one: '1 item uses this category.',
    other: '{count} items use this category.',
  },
  '有 {count} 篇内容使用这个标签。': {
    one: '1 item uses this tag.',
    other: '{count} items use this tag.',
  },
};

export default fragment;
