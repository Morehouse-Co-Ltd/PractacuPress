import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/admin/PageEditor.tsx` */
const fragment: Dictionary = {
  // ---- 与其他页面共用的词（取值与既有译法一致） ----
  '新建页面': 'New page',
  '编辑页面': 'Edit page',
  '站点管理员': 'Site admin',
  '基本信息': 'Basic info',
  '关于本站': 'About this site',
  '摘要': 'Summary',
  '发布': 'Publish',
  '草稿': 'Draft',
  '已发布': 'Published',

  // ---- 页面不存在 ----
  '页面不存在': 'Page not found',
  '它可能已经被删除。回到页面列表重新选择。':
    'It may have been deleted. Go back to the page list and choose another one.',
  '返回页面列表': 'Back to the page list',

  // ---- 保存校验 ----
  '页面标题不能为空。': 'The page title cannot be empty.',
  '标题不能超过 160 个字符。': 'The title cannot be longer than 160 characters.',
  '摘要不能超过 400 个字符。': 'The summary cannot be longer than 400 characters.',
  '页面已创建': 'Page created',
  '页面已保存': 'Page saved',
  '路径 /{slug}': 'Path /{slug}',

  // ---- 页头 ----
  '页面是独立于文章的内容单元。保存后可以放进站点导航。':
    'Pages are content units separate from articles. Once saved, a page can be added to the site navigation.',
  '进入页面编排': 'Open the page builder',
  '保存页面': 'Save page',

  // ---- 模板提示 ----
  '已套用模板「{name}」': 'Applied the template “{name}”',
  '标题与路径还需要你自己填；区块顺序随时可以在页面编排里改。':
    'You still need to fill in the title and path yourself; the block order can be changed in the page builder at any time.',

  // ---- 区块概览 ----
  '页面区块': 'Page blocks',
  '这个页面用 {count} 个区块排版，保存后按顺序渲染；内容全部在页面编排里维护。': {
    one: 'This page is laid out with 1 block, rendered in order once saved; all of its content is maintained in the page builder.',
    other:
      'This page is laid out with {count} blocks, rendered in order once saved; all of its content is maintained in the page builder.',
  },
  '去编排': 'Go to the builder',
  '（隐藏）': '(hidden)',

  // ---- 基本信息 ----
  '标题显示在页面与导航里，路径决定访问地址。':
    'The title appears on the page and in navigation; the path determines the address.',
  '页面标题': 'Page title',
  '页面路径': 'Page path',
  '访问地址是 /路径。只能使用小写字母、数字与连字符；中文标题请手动填写英文路径。':
    'The address is /path. Only lowercase letters, digits, and hyphens are allowed; for a Chinese title, type an English path by hand.',
  '从标题生成': 'Generate from title',
  '可选。显示在标题下方，也会用于搜索描述。':
    'Optional. Shown below the title and used as the search description.',

  // ---- 页面内容 ----
  '页面内容': 'Page content',
  '正文、分栏、图片、图表等全部在页面编排里用组件完成，不再单独编辑正文。':
    'Body text, columns, images, charts, and more are all built from components in the page builder; the body is no longer edited on its own.',
  '拖拽组件、实时预览并调整这个页面的布局。':
    'Drag components, preview live, and adjust the layout of this page.',
  '先保存基本信息': 'Save the basic info first',
  '保存后会自动进入页面编排，为这个页面添加区块。正文和预览不再在基本信息页编辑。':
    'After saving you go straight to the page builder to add blocks for this page. The body and preview are no longer edited on the basic info page.',

  // ---- 发布 ----
  '草稿只有站点管理员能预览，不会出现在导航里。':
    'Only site admins can preview drafts; they never appear in navigation.',
  '可以继续修改，读者看不到。': 'You can keep editing; readers cannot see it.',
  '立即可以通过路径访问。': 'It is reachable at its path straight away.',
  '加入站点导航': 'Add to site navigation',
  '已发布的页面会出现在页头，最多显示 3 个。':
    'Published pages appear in the header, up to 3 of them.',
  '上次更新：{time}': 'Last updated: {time}',
};

export default fragment;
