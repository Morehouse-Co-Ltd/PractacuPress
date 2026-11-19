import type { Dictionary } from '../../plural';

/** 来源：`web/src/lib/extensions.ts` */
const fragment: Dictionary = {
  // ---- 导入 / 导出的报错（管理页直接展示给站长） ----
  '扩展文件的顶层必须是对象或数组。': 'The extension file must have an object or an array at the top level.',
  '这不是 Practacu 扩展文件：format 应为 practacu-extension。':
    'This is not a Practacu extension file: format should be practacu-extension.',
  '不支持的扩展文件版本：{version}，当前只支持 1。':
    'Unsupported extension file version: {version}; only version 1 is supported.',
  '这不是 Practacu 扩展合集文件：format 应为 practacu-extensions。':
    'This is not a Practacu extension bundle: format should be practacu-extensions.',
  '文件里没有扩展清单：需要 extension 字段、extensions 数组或 name 字段。':
    'The file has no extension manifest: it needs an extension field, an extensions array, or a name field.',
  '请先选择扩展文件，或粘贴扩展清单 JSON。':
    'Choose an extension file first, or paste the manifest JSON.',
  '文件不是有效的 JSON，请检查是否复制完整（包括首尾大括号）。':
    'The file is not valid JSON; check that you copied all of it, including the outer braces.',
  '一次最多导入 {count} 个扩展，请拆分文件后再试。':
    'You can import at most {count} extensions at a time; split the file and try again.',
  '没有可导入的扩展：每个清单都需要非空的 name（扩展名称），一次最多 {count} 个。':
    'No importable extensions: every manifest needs a non-empty name, and at most {count} can be imported at a time.',
  '扩展清单没有通过校验：请检查 name、slots、pages 与 permissions 字段。':
    'The extension manifest did not pass validation: check the name, slots, pages, and permissions fields.',

  // ---- 新建清单时的兜底标签 ----
  '未命名扩展': 'Untitled extension',
  '未署名': 'Unattributed',

  // ---- 挂载位置 ----
  '站点页头': 'Site header',
  '站点页脚': 'Site footer',
  '首页顶部': 'Home top',
  '首页底部': 'Home bottom',
  '文章顶部': 'Article top',
  '文章底部': 'Article bottom',
  '文章侧栏': 'Article sidebar',
  '悬浮窗': 'Floating window',

  // ---- 适用页面 ----
  '全部页面': 'All pages',
  '首页': 'Home',
  '文章页': 'Article page',
  '列表页': 'List page',
  '搜索页': 'Search page',

  // ---- 权限名称 ----
  '通知': 'Notifications',
  '打开链接': 'Open links',
  '站内跳转': 'In-site navigation',
  '剪贴板': 'Clipboard',
  '主题信息': 'Theme info',
  '本地存储': 'Local storage',

  // ---- 权限说明 ----
  '在宿主页面右下角弹出一条提示。': 'Shows a toast at the bottom right of the host page.',
  '在新标签页打开 http(s) 链接。': 'Opens http(s) links in a new tab.',
  '跳转到站内路径（以 / 开头）。': 'Navigates to an in-site path (starting with /).',
  '把一段文字写入访客剪贴板。': 'Writes a piece of text to the visitor clipboard.',
  '读取并使用站点的颜色与字体令牌。': 'Reads and uses the site color and font tokens.',
  '按扩展 id 隔离的本地键值存储。': 'Local key-value storage isolated per extension id.',
};

export default fragment;
