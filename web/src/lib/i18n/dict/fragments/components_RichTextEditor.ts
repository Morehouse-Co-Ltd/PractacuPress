import type { Dictionary } from '../../plural';

/** 来源：`web/src/components/RichTextEditor.tsx` */
const fragment: Dictionary = {
  // ---- 编辑区 ----
  正文: 'Body',
  '从这里开始写。选中文字可以加粗、加链接，工具栏能插入图片、表格与分栏。':
    'Start writing here. Select text to make it bold or add a link; the toolbar inserts images, tables and columns.',
  '只读：当前状态不允许修改正文。':
    'Read-only: the current state does not allow editing the body.',
  '所见即所得编辑；保存时序列化为 Markdown，公开页由服务端渲染并清洗。':
    'WYSIWYG editing; content is serialized to Markdown when saved, and public pages are rendered and sanitized on the server.',

  // ---- 输入转换提示：行内格式 ----
  粗体: 'Bold',
  斜体: 'Italic',
  行内代码: 'Inline code',
  删除线: 'Strikethrough',
  链接: 'Link',

  // ---- 输入转换提示：块级格式 ----
  二级标题: 'Heading 2',
  三级标题: 'Heading 3',
  四级标题: 'Heading 4',
  无序列表: 'Bulleted list',
  有序列表: 'Numbered list',
  引用: 'Quote',
  代码块: 'Code block',
  任务列表: 'Task list',
  分割线: 'Divider',
  富文本: 'Rich text',

  // ---- 输入转换提示：整句 ----
  '已转成{target}': 'Converted to {target}',
  '已转成二级标题': 'Converted to Heading 2',
  '已转成三级标题': 'Converted to Heading 3',
  '已转成四级标题': 'Converted to Heading 4',
  '已转成无序列表': 'Converted to bulleted list',
  '已转成有序列表': 'Converted to numbered list',
  '已转成引用': 'Converted to quote',
  '已转成任务列表': 'Converted to task list',
  '已插入分割线': 'Divider inserted',
  '已插入代码块': 'Code block inserted',
  '已插入提示框': 'Callout inserted',
  '已插入提示卡片': 'Tip card inserted',
  '已插入警告卡片': 'Warning card inserted',
  '已插入折叠文本': 'Collapsible text inserted',

  // ---- 粘贴 / 拖拽上传 ----
  '正在上传图片… {percent}%': 'Uploading images… {percent}%',
  '正在上传图片，请稍候…': 'Uploading an image; please wait…',
  '上传结果里没有可用的图片地址。': 'The upload result has no usable image URL.',
  粘贴的图片: 'Pasted image',
  '图片已插入正文': 'Image inserted into the body',
  '已插入 {count} 张图片': {
    one: 'Inserted 1 image',
    other: 'Inserted {count} images',
  },
  图片上传失败: 'Image upload failed',
  '图片上传失败，请重试。': 'The image upload failed. Please try again.',
  '只能上传 PNG / JPEG / WebP / GIF 图片。':
    'Only PNG / JPEG / WebP / GIF images can be uploaded.',
  '也可以直接粘贴或拖入图片，上传后插入正文。':
    'You can also paste or drop an image; it is uploaded and inserted into the body.',

  // ---- 表格上下文工具条 ----
  表格工具: 'Table tools',
  上方插入行: 'Insert row above',
  下方插入行: 'Insert row below',
  左侧插入列: 'Insert column left',
  右侧插入列: 'Insert column right',
  删除当前行: 'Delete row',
  删除当前列: 'Delete column',
  切换表头: 'Toggle header row',
  左对齐: 'Align left',
  居中对齐: 'Align center',
  右对齐: 'Align right',
  删除表格: 'Delete table',
  '表格含合并单元格，暂不支持增删行列。':
    'This table has merged cells; rows and columns cannot be added or removed.',
};

export default fragment;
