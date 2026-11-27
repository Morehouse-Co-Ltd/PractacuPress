import type { Dictionary } from '../../plural';

/** 来源：`web/src/lib/theme.ts` */
const fragment: Dictionary = {
  // ---- 主题预设：名称 ----
  纸白: 'Paper',
  暖砂: 'Warm sand',
  雾蓝: 'Mist blue',
  灰绿: 'Sage',
  陶土: 'Clay',
  夜航: 'Night flight',
  白昼: 'Daylight',
  '夜航 · 浅色': 'Night flight · Light',
  沉思: 'Contemplation',

  // ---- 主题预设：说明 ----
  '白底墨字，克制的绿。原版主题。': 'Ink on white with a restrained green. The original theme.',
  '米色纸张与赭石强调色，适合长文。': 'Cream paper with an ochre accent; suited to long reads.',
  '偏冷的灰蓝底，安静的技术刊物。': 'A cool grey-blue ground for a quiet technical journal.',
  '带一点草色的纸面，温和的读感。': 'Paper with a touch of grass green and a gentle reading feel.',
  '暖红强调色，适合随笔与摄影。': 'A warm red accent; made for essays and photography.',
  '暖纸、信号红与编号网格：把站点当成一册可以翻阅的索引。':
    'Warm paper, signal red and a numbered grid: the site as an index you can leaf through.',
  '白底与电光蓝：卡片化现代编辑主题，文章页沿用夜航的封面式阅读体验。':
    'White ground and electric blue: a card-based modern editorial theme that keeps Night flight’s cover-led reading experience on article pages.',
  '白底日报：分栏头版、三列故事与单栏文章；电光蓝强调。':
    'A white daily front page: split lead, three-column stories and a single-column article, with an electric-blue accent.',
  '深色杂志风：暖黑底、薰衣草主色、封面图组织内容。':
    'Dark magazine style: warm black ground, lavender accent, cover images organising the content.',
  '冷石墨与电光蓝：深色为主、浅色为同一套设计的明亮重配。':
    'Cold graphite and electric blue: dark by default, with a bright light-mode remix of the same design.',
  '石白纸面与青灰强调，留白多，适合长文和笔记；深色是同一套版面的夜读配色。':
    'Stone-white paper and slate accents with generous whitespace for long reads and notes; dark mode is the same layout tuned for night reading.',
  '夜航的浅色重配：冷白纸与电光蓝，结构不变。':
    'Night flight in light mode: cold white paper and electric blue, same structure.',

  // ---- 令牌标签 ----
  页面底色: 'Page background',
  主文字: 'Primary text',
  强调色: 'Accent color',
  卡片底: 'Card surface',
  下沉底: 'Sunken surface',
  正文色: 'Body text',
  次要文字: 'Secondary text',
  弱化文字: 'Muted text',
  分隔线: 'Divider',
  卡片描边: 'Card outline',
  强调浅底: 'Soft accent surface',
  强调色上的文字: 'Text on accent',
  阅读正文: 'Reading text',

  // ---- 令牌说明 ----
  '全站背景。': 'Site-wide background.',
  '标题与强调文字。': 'Headings and emphasized text.',
  '链接、当前状态与焦点环。': 'Links, current state and focus rings.',
  '卡片与浮层，深色下必须能与底色区分。':
    'Cards and popovers; must stand out from the page background in dark mode.',
  '输入框、代码块与次级块。': 'Inputs, code blocks and secondary panels.',
  '文章正文使用。': 'Used for article body copy.',
  '说明与 meta 信息。': 'Captions and meta information.',
  '时间、计数等非关键信息。': 'Timestamps, counts and other non-critical information.',
  '区块之间的细线。': 'Hairlines between sections.',
  '深色下的分层手段，1px。': 'How layers separate in dark mode, 1px.',
  '强调色的低透明度底色。': 'A low-opacity wash of the accent color.',
  '主色按钮与胶囊的文字色。': 'Text color for primary buttons and pills.',
  '文章页正文颜色，对比度要求最高。':
    'Article body color on article pages; the highest contrast requirement.',
};

export default fragment;
