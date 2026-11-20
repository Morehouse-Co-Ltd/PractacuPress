import type { Dictionary } from '../../plural';

/** 来源：`web/src/components/EditorToolbar.tsx` */
const fragment: Dictionary = {
  // ---- 工具栏按钮 ----
  写作工具: 'Writing tools',
  标题: 'Title',
  二级标题: 'Heading 2',
  三级标题: 'Heading 3',
  四级标题: 'Heading 4',
  正文段落: 'Paragraph',
  文字样式: 'Text style',
  '粗体（⌘/Ctrl+B）': 'Bold (⌘/Ctrl+B)',
  '斜体（⌘/Ctrl+I）': 'Italic (⌘/Ctrl+I)',
  删除线: 'Strikethrough',
  行内代码: 'Inline code',
  '链接（⌘/Ctrl+K）': 'Link (⌘/Ctrl+K)',
  清除格式: 'Clear formatting',
  列表与引用: 'Lists and quotes',
  无序列表: 'Bulleted list',
  有序列表: 'Numbered list',
  引用: 'Quote',
  分割线: 'Divider',
  代码块: 'Code block',
  插入区块: 'Insert block',
  图片: 'Image',
  视频: 'Video',
  嵌入网址: 'Embed a URL',
  表格: 'Table',
  分栏: 'Columns',
  图标: 'Icon',
  图集: 'Gallery',
  提示框: 'Callout',
  提示卡片: 'Tip card',
  警告卡片: 'Warning card',
  折叠文本: 'Collapsible text',
  数学公式: 'Math formula',
  '图表（思维导图 / 逻辑图 / 统计图 / 鱼骨图）':
    'Diagram (mind map / logic chart / statistical chart / fishbone)',
  撤销: 'Undo',
  '撤销（⌘/Ctrl+Z）': 'Undo (⌘/Ctrl+Z)',
  重做: 'Redo',
  '选中文字后再点格式按钮；也可以直接输入 Markdown（`# ` 标题、`- ` 列表、`> ` 引用、`**粗体**`）， 或在新段落输入 / 打开指令面板。':
    'Select text first, then click a format button. You can also type Markdown directly (`# ` heading, `- ` list, `> ` quote, `**bold**`), or type / in a new paragraph to open the command palette.',

  // ---- 链接弹窗 ----
  插入链接卡片: 'Insert link card',
  插入链接: 'Insert link',
  '卡片链接会显示封面、标题与说明，适合推荐站外文章。':
    'Link cards show a cover, title and description — handy for recommending external articles.',
  '有选中文字时直接包住它们；没有选中就用下面的文字。':
    'If text is selected it gets wrapped directly; otherwise the text below is used.',
  插入卡片: 'Insert card',
  链接形态: 'Link style',
  文字链接: 'Text link',
  卡片链接: 'Link card',
  网址: 'URL',
  '只接受 http / https。': 'Only http / https is accepted.',
  '留空时显示网址域名。': 'Shows the URL domain when left empty.',
  说明: 'Description',
  '可选，显示在域名后面。': 'Optional, shown after the domain.',
  文章标题: 'Article title',
  一句话说明: 'One-line description',
  '封面地址（可选）': 'Cover URL (optional)',
  '留空时用域名占位图。': 'Uses a domain placeholder image when left empty.',
  '填写网址后会在这里显示卡片预览。':
    'The card preview appears here once the URL is filled in.',
  显示文字: 'Display text',
  '没有选中文字时使用；留空则显示网址。':
    'Used when no text is selected; the URL shows if left empty.',
  链接文字: 'Link text',

  // ---- 公式弹窗 ----
  插入数学公式: 'Insert math formula',
  '使用纯文本输入公式；保存时会保留为 $...$ 或 $$...$$ Markdown 语法。':
    'Type the formula as plain text; it is saved as $...$ or $$...$$ Markdown syntax.',
  插入公式: 'Insert formula',
  公式类型: 'Formula type',
  '行内公式（$...$）': 'Inline formula ($...$)',
  '块级公式（$$...$$）': 'Block formula ($$...$$)',
  公式内容: 'Formula source',
  '当前版本保留公式原文，不加载额外公式渲染库。':
    'This version keeps the formula source as-is and loads no extra formula renderer.',
  '公式：': 'Formula:',
  '输入公式后会在这里显示安全文本预览。':
    'A safe text preview appears here once a formula is entered.',

  // ---- 素材选择 ----
  '上传失败。': 'Upload failed.',
  素材列表没能载入: 'Could not load the media library',
  '仍然可以直接填写图片地址。': 'You can still enter the image URL directly.',
  '还没有上传过素材。': 'No media uploaded yet.',
  上传图片: 'Upload image',
  '上传中 {percent}%': 'Uploading {percent}%',
  '支持 PNG / JPEG / WebP / GIF，单张不超过 10 MB。':
    'Supports PNG / JPEG / WebP / GIF, up to 10 MB per file.',

  // ---- 图片弹窗 ----
  插入图片: 'Insert image',
  '从素材库选一张，或者直接填写图片地址。':
    'Pick one from the media library, or enter an image URL directly.',
  图片地址: 'Image URL',
  '也可以粘贴外链。': 'You can also paste an external link.',
  替代文字: 'Alt text',
  '读屏软件与图片加载失败时显示。':
    'Shown by screen readers and when the image fails to load.',
  图注: 'Caption',
  可选: 'Optional',
  '点击跳转（可选）': 'Link target (optional)',

  // ---- 图集弹窗 ----
  插入图集: 'Insert gallery',
  '按顺序选择三张图片，插成一行三列。':
    'Pick three images in order; they are inserted as one row of three.',
  '插入 {count} 张': { one: 'Insert 1 image', other: 'Insert {count} images' },

  // ---- 视频弹窗 ----
  插入视频: 'Insert video',
  '视频以封面卡片呈现，点击到原站播放。正文不允许 iframe，这是有意的安全取舍。':
    'Videos appear as a cover card that opens the original site for playback. iframes are not allowed in the body — an intentional security trade-off.',
  视频地址: 'Video URL',
  'YouTube / Bilibili / Vimeo 或任意页面。': 'YouTube / Bilibili / Vimeo or any page.',
  'YouTube 会自动推导。': 'YouTube is detected automatically.',
  '平台名称（可选）': 'Platform name (optional)',

  // ---- 嵌入网址弹窗 ----
  '生成一张链接卡片：标题 + 来源域名，点击跳转。':
    'Creates a link card: title plus source domain, click through to open.',
  '留空时显示域名。': 'Shows the domain when left empty.',

  // ---- 表格弹窗 ----
  插入表格: 'Insert table',
  '插入后可以直接点单元格改文字，Tab 跳到下一格。':
    'After inserting, click any cell to edit its text; Tab moves to the next cell.',
  列数: 'Columns',
  行数: 'Rows',
  第一行作为表头: 'Use the first row as a header',

  // ---- 分栏弹窗 ----
  插入分栏: 'Insert columns',
  '两栏或三栏并排，每栏可以继续写标题、图片与列表。':
    'Two or three columns side by side; each can hold headings, images and lists.',
  栏数: 'Column count',
  两栏: 'Two columns',
  三栏: 'Three columns',
  '第 {index} 栏': 'Column {index}',
  '第 {index} 栏的内容': 'Content for column {index}',

  // ---- 图标弹窗 ----
  插入图标: 'Insert icon',
  '图标用字符 + CSS 呈现，不额外加载图标字体。':
    'Icons are rendered with characters plus CSS, so no icon font is loaded.',
  '图标后的文字（可选）': 'Text after the icon (optional)',
  '例如：每周更新': 'e.g. Updated weekly',

  // ---- 斜杠面板新增指令的说明（斜杠面板与工具栏共用同一批区块）----
  醒目的提醒块: 'Eye-catching warning block',
  标题与正文可折叠: 'Title with a collapsible body',
};

export default fragment;
