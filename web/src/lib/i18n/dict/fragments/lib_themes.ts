import type { Dictionary } from '../../plural';

/** 来源：`web/src/lib/themes.ts` */
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
  沉思: 'Contemplation',
  '暖纸与朱砂，年轻的中文编辑排版；大字、留白与无边框内容流。':
    'Warm paper and cinnabar · young Chinese editorial typography with large type, open space and a borderless content flow.',
  '暖纸与朱砂 · 年轻的中文编辑排版；大字、留白与无边框内容流。':
    'Warm paper and cinnabar · young Chinese editorial typography with large type, open space and a borderless content flow.',
  夜航: 'Night flight',
  白昼: 'Daylight',
  '暖黑暗色 · 双栏杂志布局，适合社区与图片较多的站点。':
    'Warm dark · two-column magazine layout, suited to communities and image-heavy sites.',
  '白底与电光蓝 · 卡片化现代编辑主题，文章页沿用夜航的封面式阅读体验。':
    'White ground and electric blue · a card-based modern editorial theme that keeps Night flight’s cover-led reading experience on article pages.',
  '冷石墨与电光蓝 · 深色杂志布局；切到浅色会得到同一套设计的冷白重配。':
    'Cold graphite and electric blue · a dark magazine layout; switching to light gives a cool-white remix of the same design.',
  '白底日报 · 单行胶囊 Tab、分栏头版与单栏文章，适合每日更新的站点。':
    'A white daily front page · single-row pill tabs, a split lead and a single-column article, made for sites that publish every day.',

  // ---- 内置主题自带的预览画面（docs/themes/06-preview.md） ----
  文章: 'Articles',
  专题: 'Features',
  关于: 'About',
  '独立出版 · 纸白单栏': 'Independent publishing · paper white, single column',
  把注意力留给文字: 'Leave the attention to the words',
  '长文、随笔与专题，安静克制的阅读版面。':
    'Long reads, essays and features in a quiet, restrained reading layout.',
  '版面安静下来，文字才有回声。': 'When the page quiets down, the words begin to echo.',
  开始阅读: 'Start reading',
  '沉思 · 暖纸与朱砂': 'Contemplation · warm paper and cinnabar',
  '让版面退后，让表达靠前': 'Let the layout recede; let expression come forward',
  '暖纸白、炭黑与朱砂；更大的中文标题、更松的留白，去掉卡片与描边。':
    'Warm paper, charcoal and cinnabar; larger Chinese headlines, looser whitespace, no cards or outlines.',
  '版面的克制，是为了让文字拥有自己的声音。':
    'The restraint of the page exists so the words can have their own voice.',
  '夜航 · 冷石墨双栏': 'Night flight · cold graphite, two columns',
  在冷石墨上读长夜: 'Read through the night on cold graphite',
  '电光蓝强调与杂志网格，适合图片、专题与社区。':
    'Electric-blue accents and a magazine grid for imagery, features and community.',

  // ---- 版式标签 ----
  双栏: 'Two-column',
  单栏: 'Single column',
  卡片: 'Cards',

  // ---- 主题文件导入 ----
  '文件不是有效的 JSON。': 'This file is not valid JSON.',
  '文件内容不是一个主题对象。': 'The file contents are not a theme object.',
  '文件里没有可识别的主题配置。': 'No recognizable theme settings were found in this file.',
  导入的主题: 'Imported theme',
};

export default fragment;
