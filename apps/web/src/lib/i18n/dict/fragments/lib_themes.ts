import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/lib/themes.ts` */
const fragment: Dictionary = {
  // ---- 外观分区：名称 ----
  首页首屏: 'Home hero',
  品牌副标题: 'Brand subtitle',
  公告条: 'Announcement bar',
  '自定义 CSS': 'Custom CSS',

  // ---- 外观分区：用途说明 ----
  '眉题、主标题与副标题；单栏与双栏都会读取。':
    'Kicker, headline and subtitle; read by both single- and two-column layouts.',
  '品牌名下方那行小字。': 'The small line of text under the brand name.',
  '页头下方的可关闭公告。': 'A dismissible announcement below the header.',
  '只在前台生效的补充样式。': 'Extra styles that apply to the public site only.',

  // ---- 内置大主题 ----
  原版: 'Default',
  '纸白浅色 · 经典单栏，适合安静的长文阅读。':
    'Paper white · classic single column, made for quiet long-form reading.',
  夜航: 'Night flight',
  '暖黑暗色 · 双栏杂志布局，适合社区与图片较多的站点。':
    'Warm dark · two-column magazine layout, suited to communities and image-heavy sites.',

  // ---- 版式标签 ----
  双栏: 'Two-column',
  单栏: 'Single column',

  // ---- 主题文件导入 ----
  '文件不是有效的 JSON。': 'This file is not valid JSON.',
  '文件内容不是一个主题对象。': 'The file contents are not a theme object.',
  '文件里没有可识别的主题配置。': 'No recognizable theme settings were found in this file.',
  导入的主题: 'Imported theme',
};

export default fragment;
