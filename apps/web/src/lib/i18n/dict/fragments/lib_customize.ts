import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/lib/customize.ts` */
const fragment: Dictionary = {
  // ---- 首屏与页脚的出厂文案 ----
  '精彩内容\n*就此展开*。': 'Great content\n*starts right here*.',
  '前端 v0.1 · React': 'Frontend v0.1 · React',

  // ---- 兜底标签 ----
  未署名: 'Unattributed',
  未命名页面: 'Untitled page',

  // ---- 封面地址校验 ----
  '图片太大：演示模式下请选择 600 KB 以内的图片。':
    'The image is too large: in demo mode, pick an image under 600 KB.',
  '只支持 png / jpg / webp / gif / svg 图片。':
    'Only png / jpg / webp / gif / svg images are supported.',
  '请填写 http(s) 图片地址、以 / 开头的站内路径，或直接上传图片。':
    'Enter an http(s) image URL, a site path starting with /, or upload an image directly.',

  // ---- 内置扩展目录 ----
  阅读进度条: 'Reading progress bar',
  '在文章页顶部显示一条细进度线。': 'Shows a thin progress line at the top of article pages.',
  '随滚动更新，不写入任何数据。': 'Updates as you scroll and writes no data.',
  文章目录: 'Article table of contents',
  '从文章的二、三级标题自动生成目录。':
    "Builds a table of contents from the article's second- and third-level headings.",
  '至少两个标题时才出现，点击跳到对应段落。':
    'Appears once there are at least two headings; click to jump to the section.',
  代码块复制: 'Copy code blocks',
  '给正文里的每个代码块加一个复制按钮。': 'Adds a copy button to every code block in the body.',
  '只处理前端渲染出的代码块，不改变正文内容。':
    'Only touches code blocks rendered in the browser and leaves the body text unchanged.',
  原生分享: 'Native sharing',
  '在文章底部提供“分享”按钮。': 'Adds a "Share" button at the bottom of the article.',
  '支持 Web Share API 时调用系统分享，否则复制链接。':
    'Calls the system share sheet when the Web Share API is available, otherwise copies the link.',
  站点公告条: 'Site announcement bar',
  '在页头下方显示一条可关闭的公告。': 'Shows a dismissible announcement below the header.',
  '公告内容在“外观 → 导航与品牌”里填写。':
    'Write the announcement text in Appearance → Navigation and brand.',
  回到顶部: 'Back to top',
  '页面滚动较深时出现回到顶部按钮。':
    'Shows a back-to-top button once the page is scrolled down far enough.',
  '只在站点前台出现，不影响管理后台。': 'Only appears on the public site, never in the admin.',

  // ---- 页面路径校验 ----
  '页面路径不能为空。': 'The page path cannot be empty.',
  '路径只能包含小写字母、数字与连字符。':
    'The path may only contain lowercase letters, numbers, and hyphens.',
  '这个路径被系统路由占用，请换一个。':
    'This path is taken by a system route; please choose another one.',
  '已经有页面使用这个路径。': 'Another page already uses this path.',

  // ---- 导入配置的错误 ----
  '文件不是有效的 JSON。': 'This file is not valid JSON.',
  '文件内容不是一个配置对象。': 'The file does not contain a configuration object.',
  '缺少 customization 字段。': 'The customization field is missing.',
  '文件里没有可识别的外观、页面、封面或扩展配置。':
    'The file contains no recognisable appearance, page, cover, or extension settings.',
};

export default fragment;
