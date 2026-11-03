import type {
  BlockAnimation,
  BlockArea,
  BlockInstance,
  BlockProps,
  BuilderDevice,
  LayoutVariant,
  ScreenLayout,
} from '../types';
import { t } from './i18n';
import { liveCatalog } from './i18n/live';
import { IMAGE_RADIUS_OPTIONS } from './imageRadius';
import { BREAKPOINT_LG, BREAKPOINT_MD, SPACING_SCALE, spacingPx } from './layout';

/**
 * 无代码区块注册表（数据侧）。
 *
 * 每个区块 = 一个默认组件 + 属性模式（schema）+ 默认值。渲染器在
 * `components/blocks/`，后台编辑器的表单由 schema 驱动，因此新增组件
 * 不需要改编辑器代码。属性值只允许标量或 repeater（条目数组），
 * 保证整份配置可以导入导出。
 */

export type PropType =
  | 'text'
  | 'textarea'
  /**
   * 富文本正文：值是 Markdown 字符串，渲染前必须过 `sanitizeHtml(renderMarkdown(...))`。
   *
   * 与 `textarea` 的差别只在两处：长度上限是 8000 字节（见 `customize.ts` 的
   * `richtextValue`），编辑器里多一个清洗后的预览折叠区。存储形状与 `textarea`
   * 一样是纯字符串，所以把既有字段升级成它不会改动已保存的配置。
   */
  | 'richtext'
  | 'number'
  | 'select'
  | 'toggle'
  | 'color'
  /** 旧的结构化列表：JSON 字符串。只为读取既有配置保留。 */
  | 'itemlist'
  /** 结构化列表：值是条目数组，子字段由 itemSchema 递归声明。 */
  | 'repeater'
  /** 媒体库选择器：值只接受站内媒体地址、http(s) 或 / 开头的站内路径。 */
  | 'media';

export interface PropSchema {
  key: string;
  label: string;
  type: PropType;
  hint?: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  /** itemlist：条目字段，例如 [{ key: 'label', label: '名称' }] */
  itemFields?: {
    key: string;
    label: string;
    /** select 用于「每个条目的样式/类型」这类有限选项。 */
    type?: 'text' | 'color' | 'select';
    /** type === 'select' 时的选项。 */
    options?: { value: string; label: string }[];
  }[];
  itemLabel?: string;
  maxItems?: number;
  /** repeater：每个条目的字段，复用同一套 PropSchema（不允许再嵌 repeater）。 */
  itemSchema?: PropSchema[];
  minItems?: number;
  /**
   * 这个字段能不能绑定成「显示什么数据」（只对 text / textarea / richtext 生效）。
   * 代码类字段（CSS、HTML、JS）默认关掉：把文章标题塞进样式表没有意义。
   */
  bindable?: boolean;
}

export interface BlockDefinition {
  type: string;
  name: string;
  description: string;
  /**
   * 目录分组（`content` 是 P2 起的内容型组件）。
   *
   * 「添加组件」面板的分组按 type 推导（见 `BlockTreeEditor` 的 `groupOf`），
   * 这个字段只描述区块的来源批次，不参与渲染。
   */
  group: 'classic' | 'nightflight' | 'shared' | 'content';
  /** 出现在哪些布局变体的“添加组件”菜单里。 */
  variants: LayoutVariant[];
  defaults: BlockProps;
  schema: PropSchema[];
}

/**
 * 夜航双栏布局里的默认落位。
 * 用户可以在工坊里逐个区块改（BlockInstance.area），这里只是出厂值。
 */
const AREA_BY_TYPE: Record<string, BlockArea> = {
  'bento-hero': 'full',
  'banner': 'full',
  'category-pills': 'full',
  'feature-post': 'main',
  'post-list': 'main',
  'post-grid': 'main',
  spotlight: 'main',
  'spotlight-hot': 'main',
  'quote-card': 'main',
  timeline: 'main',
  'author-card': 'side',
  'tag-cloud': 'side',
  'stat-list': 'side',
  archive: 'side',
  'search-launcher': 'side',
  'command-hints': 'side',
};

export function defaultArea(type: string): BlockArea {
  return AREA_BY_TYPE[type] ?? 'main';
}

/** 区块实际落位：用户显式设置优先，否则用类型默认值。 */
export function resolveArea(block: BlockInstance): BlockArea {
  return block.area ?? defaultArea(block.type);
}

const RAW_BLOCK_DEFS: BlockDefinition[] = [
  /* ---------------- 经典（纸白） ---------------- */
  {
    type: 'classic-hero',
    name: t('经典首屏'),
    description: t('眉题 + 大标题 + 副标题 + 行动按钮，编辑排版风。'),
    group: 'classic',
    variants: ['classic'],
    defaults: { title: '', lede: '' },
    schema: [
      { key: 'title', label: t('主标题'), type: 'textarea', hint: t('留空使用「外观 → 首页首屏」的设置；*文字* 为斜体强调。') },
      { key: 'lede', label: t('副标题'), type: 'textarea', hint: t('留空使用「外观 → 首页首屏」的副标题。') },
    ],
  },
  {
    type: 'feed',
    name: t('内容流'),
    description: t('最新文章 / 帖子列表 + 右侧栏，带分类切换。'),
    group: 'classic',
    variants: ['classic'],
    defaults: { limit: 12, show_tabs: true, show_sidebar: true },
    schema: [
      { key: 'limit', label: t('加载条数'), type: 'number', min: 4, max: 24, step: 1 },
      { key: 'show_tabs', label: t('显示全部 / 文章 / 帖子切换'), type: 'toggle' },
      { key: 'show_sidebar', label: t('显示右侧栏'), type: 'toggle' },
    ],
  },
  {
    type: 'join-band',
    name: t('订阅横幅'),
    description: t('页面底部的一条号召横幅，可改文案与按钮。'),
    group: 'classic',
    variants: ['classic'],
    defaults: { title: '', body: '', primary: '', secondary: '' },
    schema: [
      { key: 'title', label: t('标题'), type: 'text', hint: t('留空使用默认文案。') },
      { key: 'body', label: t('说明'), type: 'textarea' },
      { key: 'primary', label: t('主按钮'), type: 'text', hint: t('留空按登录状态自动选择。') },
      { key: 'secondary', label: t('次按钮'), type: 'text' },
    ],
  },
  /* ---------------- 夜航 ---------------- */
  {
    type: 'bento-hero',
    name: t('夜航首屏'),
    description: t('双卡首屏：左侧大黑卡（可换背景图 + 大标题 + 搜索框）/ 右侧是紧凑的热门榜单，也可以换回彩虹渐变卡。'),
    group: 'nightflight',
    variants: ['bento'],
    defaults: {
      title: '',
      welcome: 'hello',
      eyebrow: '我们的团队',
      name: '',
      cta: '更多推荐',
      show_domain: true,
      show_search: true,
      search_placeholder: '搜索文章、笔记或标签',
      bg_color: '#000000',
      bg_image: '',
      bg_dim: 55,
      hero_ratio: 'wide',
      right_mode: 'popular',
      popular_heading: '热门文章',
      popular_limit: 6,
      popular_cover: false,
    },
    schema: [
      { key: 'title', label: t('黑卡大标题'), type: 'textarea', hint: t('留空使用「外观 → 首页首屏」的标题；支持换行与 *斜体强调*，最多两行。') },
      { key: 'show_domain', label: t('黑卡显示域名'), type: 'toggle' },
      { key: 'show_search', label: t('黑卡底部搜索框'), type: 'toggle' },
      { key: 'search_placeholder', label: t('搜索框占位文字'), type: 'text', hint: t('留空使用「搜索文章」。') },
      { key: 'bg_color', label: t('黑卡底色'), type: 'color', hint: t('没有背景图时使用，默认纯黑。') },
      {
        key: 'bg_image',
        label: t('黑卡背景图'),
        type: 'text',
        hint: t('可选，填图片地址（http(s) 或 /media/...）。留空就是上面的纯色底。'),
      },
      { key: 'bg_dim', label: t('背景图压暗'), type: 'number', min: 0, max: 90, step: 5, hint: t('百分比遮罩，保证白字可读；0 表示不压暗。') },
      {
        key: 'hero_ratio',
        label: t('左右比例'),
        type: 'select',
        options: [
          { value: 'wide', label: t('左宽 · 3 : 2（默认）') },
          { value: 'wider', label: t('左更宽 · 2 : 1') },
          { value: 'even', label: t('左右等宽') },
        ],
        hint: t('左边是标题卡，右边是热门榜。'),
      },
      {
        key: 'right_mode',
        label: t('右侧卡片'),
        type: 'select',
        options: [
          { value: 'popular', label: t('热门文章') },
          { value: 'hello', label: t('彩虹渐变卡') },
        ],
        hint: t('热门文章按站内阅读次数排序，无统计数据时回退到最新发布。'),
      },
      { key: 'popular_heading', label: t('热门文章标题'), type: 'text', hint: t('留空隐藏标题行。') },
      {
        key: 'popular_limit',
        label: t('热门文章篇数'),
        type: 'number',
        min: 1,
        max: 10,
        step: 1,
        hint: t('与下方文章列表合计建议控制在 10–30 篇。'),
      },
      { key: 'popular_cover', label: t('热门条目显示缩略图'), type: 'toggle', hint: t('关闭时是纯文字的紧凑榜单。') },
      { key: 'welcome', label: t('渐变卡手写字'), type: 'text', hint: t('仅「彩虹渐变卡」模式使用，例如 hello。') },
      { key: 'eyebrow', label: t('渐变卡眉题'), type: 'text', hint: t('团队名上方的小字，留空隐藏。') },
      { key: 'name', label: t('渐变卡主名'), type: 'text', hint: t('留空使用站点名。') },
      { key: 'cta', label: t('渐变卡按钮'), type: 'text', hint: t('留空隐藏按钮。') },
    ],
  },
  {
    type: 'category-pills',
    name: t('分类胶囊'),
    description: t('高饱和渐变胶囊，用颜色建立分类记忆。'),
    group: 'nightflight',
    variants: ['bento'],
    defaults: {
      source: 'manual',
      items: JSON.stringify([
        { label: '学习', color: '#5b8cff', link: '/articles' },
        { label: '日常', color: '#ff9a5a', link: '/posts' },
        { label: '随笔', color: '#c4b5fd', link: '/articles' },
      ]),
    },
    schema: [
      {
        key: 'source',
        label: t('分类来源'),
        type: 'select',
        options: [
          { value: 'manual', label: t('手动胶囊') },
          { value: 'auto', label: t('自动读取分类') },
        ],
      },
      {
        key: 'items',
        label: t('胶囊列表'),
        type: 'itemlist',
        itemLabel: t('胶囊'),
        maxItems: 8,
        itemFields: [
          { key: 'label', label: t('显示文字') },
          { key: 'category', label: t('绑定分类 slug') },
          { key: 'color', label: t('颜色'), type: 'color' },
          { key: 'link', label: t('链接') },
        ],
        hint: t('自动模式会读取「分类与标签」里的全部分类；手动模式可绑定分类并覆盖显示文字。'),
      },
    ],
  },
  {
    type: 'feature-post',
    name: t('精选文章'),
    description: t('一张大封面卡，把最新或最想推荐的一篇放在聚光灯下。'),
    group: 'nightflight',
    variants: ['bento'],
    defaults: { show_summary: true },
    schema: [{ key: 'show_summary', label: t('显示摘要'), type: 'toggle' }],
  },
  {
    type: 'post-list',
    name: t('文章列表'),
    description: t('横向大卡：左侧封面、右侧标题摘要与 meta，是双栏布局的主内容流。'),
    group: 'nightflight',
    variants: ['bento'],
    defaults: { heading: '最新文章', limit: 18, show_summary: true, show_meta: true, show_number: true, show_more: true, more_label: '查看更多' },
    schema: [
      { key: 'heading', label: t('小节标题'), type: 'text', hint: t('留空隐藏标题行。') },
      { key: 'limit', label: t('展示篇数'), type: 'number', min: 2, max: 30, step: 1, hint: t('与首屏热门篇数合计建议 10–30 篇。') },
      { key: 'show_summary', label: t('显示摘要'), type: 'toggle' },
      { key: 'show_meta', label: t('显示日期与阅读时长'), type: 'toggle' },
      { key: 'show_number', label: t('显示序号'), type: 'toggle' },
      { key: 'show_more', label: t('底部「查看更多」'), type: 'toggle' },
      { key: 'more_label', label: t('更多链接文字'), type: 'text', hint: t('留空使用「查看更多」。') },
    ],
  },
  {
    type: 'post-grid',
    name: t('文章卡网格'),
    description: t('16:10 封面卡双列排布；可带小节标题栏与「全部 / 文章 / 帖子」切换。'),
    group: 'nightflight',
    variants: ['bento'],
    defaults: { heading: '最新文章', tabs: true, limit: 18, show_summary: true, show_meta: true, show_more: true, more_label: '查看更多' },
    schema: [
      { key: 'heading', label: t('小节标题'), type: 'text', hint: t('留空隐藏标题栏。') },
      { key: 'tabs', label: t('显示内容类型切换'), type: 'toggle' },
      { key: 'limit', label: t('展示篇数'), type: 'number', min: 2, max: 30, step: 1, hint: t('与首屏热门篇数合计建议 10–30 篇。') },
      { key: 'show_summary', label: t('显示摘要'), type: 'toggle' },
      { key: 'show_meta', label: t('显示时间与阅读时长'), type: 'toggle' },
      { key: 'show_more', label: t('底部「查看更多」'), type: 'toggle' },
      { key: 'more_label', label: t('更多链接文字'), type: 'text', hint: t('留空使用「查看更多」。') },
    ],
  },
  {
    type: 'spotlight',
    name: t('置顶文章'),
    description: t(
      '封面网格：把「内容库 → 首页精选」里置顶的文章铺成格子，每篇占几格在内容库里选。格子越大，标题、阅读量与摘要越完整。',
    ),
    group: 'nightflight',
    variants: ['bento'],
    defaults: {
      source: 'pinned',
      heading: '置顶文章',
      limit: 7,
      show_cover: true,
      show_meta: true,
      show_summary: true,
    },
    schema: [
      { key: 'heading', label: t('小节标题'), type: 'text', hint: t('留空隐藏标题行。') },
      {
        key: 'source',
        label: t('内容来源'),
        type: 'select',
        options: [
          { value: 'pinned', label: t('置顶文章（手动占格）') },
          { value: 'popular', label: t('热门文章（按热度排布）') },
        ],
        hint: t('置顶名单在「内容库 → 首页精选」里勾选。'),
      },
      {
        key: 'limit',
        label: t('最多几篇'),
        type: 'number',
        min: 3,
        max: 12,
        step: 1,
        hint: t('热门模式按名次自动排：2×2 → 2×1 → 2×1 → 四个 1×1，七篇一循环。'),
      },
      { key: 'show_cover', label: t('显示封面'), type: 'toggle' },
      { key: 'show_meta', label: t('显示类型与阅读量'), type: 'toggle' },
      { key: 'show_summary', label: t('大格子显示摘要'), type: 'toggle' },
    ],
  },
  {
    type: 'spotlight-hot',
    name: t('热门文章'),
    description: t(
      '同一个精选网格的热门预设：按 30 天阅读量排序，最热的占最大格，往下依次是横条与小方块，名次一变排布跟着变。',
    ),
    group: 'nightflight',
    variants: ['bento'],
    defaults: {
      source: 'popular',
      heading: '热门文章',
      limit: 7,
      show_cover: true,
      show_meta: true,
      show_summary: true,
    },
    schema: [
      { key: 'heading', label: t('小节标题'), type: 'text', hint: t('留空隐藏标题行。') },
      {
        key: 'source',
        label: t('内容来源'),
        type: 'select',
        options: [
          { value: 'pinned', label: t('置顶文章（手动占格）') },
          { value: 'popular', label: t('热门文章（按热度排布）') },
        ],
        hint: t('切到置顶后，名字里的「热门」就只是标题了，记得改一下小节标题。'),
      },
      { key: 'limit', label: t('最多几篇'), type: 'number', min: 3, max: 12, step: 1 },
      { key: 'show_cover', label: t('显示封面'), type: 'toggle' },
      { key: 'show_meta', label: t('显示类型与阅读量'), type: 'toggle' },
      { key: 'show_summary', label: t('大格子显示摘要'), type: 'toggle' },
    ],
  },
  {
    type: 'author-card',
    name: t('作者卡'),
    description: t('主色渐变底 + 头像 + 一句话 + 社交链接。'),
    group: 'nightflight',
    variants: ['bento'],
    defaults: {
      name: '',
      bio: '',
      gradient: true,
      links: JSON.stringify([
        { label: '邮箱', link: '' },
        { label: 'RSS', link: '/rss.xml' },
      ]),
    },
    schema: [
      { key: 'name', label: t('昵称'), type: 'text', hint: t('留空使用站点名。') },
      { key: 'bio', label: t('一句话'), type: 'textarea' },
      { key: 'gradient', label: t('使用主色渐变底'), type: 'toggle' },
      {
        key: 'links',
        label: t('链接'),
        type: 'itemlist',
        itemLabel: t('链接'),
        maxItems: 6,
        itemFields: [
          { key: 'label', label: t('名称') },
          { key: 'link', label: t('地址') },
        ],
      },
    ],
  },
  {
    type: 'tag-cloud',
    name: t('标签云'),
    description: t('字号随条目数线性映射，hover 变强调色。'),
    group: 'nightflight',
    variants: ['bento'],
    defaults: { items: JSON.stringify([{ label: '写作' }, { label: '夜航' }, { label: '设计' }]) },
    schema: [
      {
        key: 'items',
        label: t('标签'),
        type: 'itemlist',
        itemLabel: t('标签'),
        maxItems: 30,
        itemFields: [{ key: 'label', label: t('名称') }],
        hint: t('契约没有标签端点，这里手动维护。'),
      },
    ],
  },
  {
    type: 'archive',
    name: t('按月归档'),
    description: t('从已发布内容统计每个月发了多少篇，参考站的「八月 2026 · 1 篇」。'),
    group: 'nightflight',
    variants: ['bento'],
    defaults: { heading: '归档', limit: 3 },
    schema: [
      { key: 'heading', label: t('标题'), type: 'text' },
      { key: 'limit', label: t('显示月份数'), type: 'number', min: 1, max: 12, step: 1 },
    ],
  },
  {
    type: 'stat-list',
    name: t('站点统计'),
    description: t('文章数、建站天数、总字数，数字右对齐。'),
    group: 'nightflight',
    variants: ['bento'],
    defaults: { show_count: true, show_days: true, show_words: true },
    schema: [
      { key: 'show_count', label: t('显示文章数'), type: 'toggle' },
      { key: 'show_days', label: t('显示建站天数'), type: 'toggle' },
      { key: 'show_words', label: t('显示总字数'), type: 'toggle' },
    ],
  },
  /* ---------------- 共用 ---------------- */
  {
    type: 'article-content',
    name: t('文章内容'),
    description: t('文章正文的占位符：在文章页渲染真实正文，其它页面只显示占位提示。'),
    group: 'shared',
    variants: ['classic', 'bento'],
    // 只有开关，没有正文：正文由当前文章提供，编排可以复用到每一篇文章。
    defaults: { show_toc: false },
    schema: [
      {
        key: 'show_toc',
        label: t('显示目录'),
        type: 'toggle',
        hint: t('目录来自正文里的二级 / 三级标题；「外观 → 目录」已经打开时不会再重复一遍。'),
      },
    ],
  },
  {
    type: 'popular-content',
    name: t('热门文章'),
    description: t('按站内阅读次数排序，适合放在首页或页面侧栏。'),
    group: 'shared',
    variants: ['classic', 'bento'],
    defaults: { heading: '热门文章', limit: 5, show_summary: true, show_meta: true, show_views: true, show_tags: true },
    schema: [
      { key: 'heading', label: t('标题'), type: 'text', hint: t('留空隐藏标题行。') },
      { key: 'limit', label: t('展示篇数'), type: 'number', min: 1, max: 12, step: 1 },
      { key: 'show_summary', label: t('显示摘要'), type: 'toggle' },
      { key: 'show_meta', label: t('显示时间'), type: 'toggle' },
      { key: 'show_views', label: t('显示阅读次数'), type: 'toggle' },
      { key: 'show_tags', label: t('显示标签'), type: 'toggle' },
    ],
  },
  {
    type: 'recent-content',
    name: t('最近文章'),
    description: t('按发布时间倒序，只展示已发布内容。'),
    group: 'shared',
    variants: ['classic', 'bento'],
    defaults: { heading: '最近文章', limit: 5, show_summary: true, show_meta: true, show_tags: true },
    schema: [
      { key: 'heading', label: t('标题'), type: 'text', hint: t('留空隐藏标题行。') },
      { key: 'limit', label: t('展示篇数'), type: 'number', min: 1, max: 12, step: 1 },
      { key: 'show_summary', label: t('显示摘要'), type: 'toggle' },
      { key: 'show_meta', label: t('显示时间'), type: 'toggle' },
      { key: 'show_tags', label: t('显示标签'), type: 'toggle' },
    ],
  },
  /* ---------------- 共用（原有） ---------------- */
  {
    type: 'quote-card',
    name: t('引言卡'),
    description: t('一段可编辑的引言，适合发刊词与摘句。'),
    group: 'shared',
    variants: ['classic', 'bento'],
    defaults: { quote: '房子不必大。能遮雨，能招待几个朋友，能让写作者在夜里安静地改一段话，就够了。', source: '发刊词' },
    schema: [
      { key: 'quote', label: t('引言'), type: 'textarea' },
      { key: 'source', label: t('出处'), type: 'text' },
    ],
  },
  {
    type: 'timeline',
    name: t('时间线'),
    description: t('左侧竖线 + 圆点的节点列表，适合站点大事记。'),
    group: 'shared',
    variants: ['classic', 'bento'],
    defaults: {
      items: JSON.stringify([
        { year: '2024', text: '写下第一篇文章，站点有了第一条记录。' },
        { year: '2025', text: '主题工坊开放，排版可以不写代码。' },
        { year: '2026', text: '搬进自己的域名，读者开始留下留言。' },
      ]),
    },
    schema: [
      {
        key: 'items',
        label: t('节点'),
        type: 'itemlist',
        itemLabel: t('节点'),
        maxItems: 12,
        itemFields: [
          { key: 'year', label: t('年份 / 时间') },
          { key: 'text', label: t('事件') },
        ],
      },
    ],
  },
  {
    type: 'search-launcher',
    name: t('搜索入口'),
    description: t('一个打开全屏搜索浮层的按钮（Shift+S）。'),
    group: 'shared',
    variants: ['classic', 'bento'],
    defaults: { label: '搜索文章', hint: '输入关键词，防抖 300 毫秒' },
    schema: [
      { key: 'label', label: t('按钮文字'), type: 'text' },
      { key: 'hint', label: t('副标题'), type: 'text', hint: t('留空隐藏。') },
    ],
  },
  {
    type: 'command-hints',
    name: t('快捷键提示'),
    description: t('一排 kbd 芯片，告诉读者键盘能做什么。'),
    group: 'shared',
    variants: ['classic', 'bento'],
    defaults: {},
    schema: [],
  },
  {
    type: 'columns',
    name: t('分栏容器'),
    description: t('2–4 栏，可继续嵌套任何区块。'),
    group: 'shared',
    variants: ['classic', 'bento'],
    defaults: { columns: 2, gap: 'normal' },
    schema: [
      {
        key: 'columns',
        label: t('栏数'),
        type: 'select',
        options: [2, 3, 4].map((n) => ({ value: String(n), label: t('{count} 栏', { count: n }) })),
      },
      {
        key: 'gap',
        label: t('间距'),
        type: 'select',
        options: [
          { value: 'compact', label: t('紧凑') },
          { value: 'normal', label: t('标准') },
          { value: 'wide', label: t('宽松') },
        ],
      },
    ],
  },
  {
    type: 'container',
    name: t('容器组'),
    description: t('纵向容器，把任意区块组合成一个可整体移动的组件。'),
    group: 'shared',
    variants: ['classic', 'bento'],
    defaults: {},
    schema: [],
  },
  {
    type: 'grid',
    name: t('栅格'),
    description: t('12 栏栅格容器：子区块可以占 1–12 栏、左右偏移，栏距走间距标尺。'),
    group: 'shared',
    variants: ['classic', 'bento'],
    defaults: { columns: 12, gap: 4 },
    schema: [
      { key: 'columns', label: t('栏数'), type: 'number', min: 1, max: 12, step: 1 },
      {
        key: 'gap',
        label: t('栏距'),
        type: 'number',
        min: 0,
        max: 9,
        step: 1,
        hint: t('0–9，对应 0–96px 的间距标尺。'),
      },
    ],
  },
  {
    type: 'section',
    name: t('分节'),
    description: t('一整段版面：可限宽、可设上下留白、可加底色与分割线。'),
    group: 'shared',
    variants: ['classic', 'bento'],
    defaults: { max_width: 'normal', padding_y: 6, background: '', divider: false },
    schema: [
      {
        key: 'max_width',
        label: t('内容宽度'),
        type: 'select',
        options: [
          { value: 'narrow', label: t('窄（640）') },
          { value: 'normal', label: t('常规（860）') },
          { value: 'wide', label: t('宽（1200）') },
          { value: 'full', label: t('满宽') },
        ],
      },
      {
        key: 'padding_y',
        label: t('上下留白'),
        type: 'number',
        min: 0,
        max: 9,
        step: 1,
        hint: t('0–9，对应 0–96px 的间距标尺。'),
      },
      { key: 'background', label: t('底色'), type: 'color' },
      { key: 'divider', label: t('上下分割线'), type: 'toggle' },
    ],
  },
  {
    type: 'text',
    name: t('文本'),
    description: t('眉题、标题、正文与局部 CSS。'),
    group: 'shared',
    variants: ['classic', 'bento'],
    defaults: {
      eyebrow: '',
      title: '新的文本区块',
      body: '在这里写正文。',
      align: 'left',
      max_width: 680,
      style_css: '',
    },
    schema: [
      { key: 'eyebrow', label: t('眉题'), type: 'text' },
      { key: 'title', label: t('标题'), type: 'textarea' },
      {
        key: 'body',
        label: t('正文'),
        type: 'richtext',
        hint: t('Markdown 正文：段落、列表、引用、链接与强调都支持；保存的是这段原文。'),
      },
      {
        key: 'align',
        label: t('对齐'),
        type: 'select',
        options: [
          { value: 'left', label: t('左对齐') },
          { value: 'center', label: t('居中') },
          { value: 'right', label: t('右对齐') },
        ],
      },
      { key: 'max_width', label: t('最大宽度'), type: 'number', min: 320, max: 1100, step: 10 },
      {
        key: 'style_css',
        label: t('作用域 CSS'),
        type: 'textarea',
        bindable: false,
        hint: t('只写声明，例如 font-size: 18px; letter-spacing: .02em; 不会影响其他区块。'),
      },
    ],
  },
  {
    type: 'image',
    name: t('图片'),
    description: t('图片、说明与链接，可单独设置圆角。'),
    group: 'shared',
    variants: ['classic', 'bento'],
    defaults: {
      source: 'url',
      src: '',
      color: '#e8e4d9',
      alt: '',
      caption: '',
      link: '',
      ratio: '16:9',
      fit: 'cover',
      radius: 'theme',
    },
    schema: [
      {
        key: 'source',
        label: t('图片来源'),
        type: 'select',
        options: [
          { value: 'url', label: t('图片地址') },
          { value: 'color', label: t('纯色块') },
        ],
      },
      {
        key: 'src',
        label: t('图片地址'),
        type: 'media',
        hint: t('可以从媒体库选，也可以填外部图片地址。'),
      },
      { key: 'color', label: t('纯色'), type: 'color', hint: t('纯色模式下作为界面背景或占位块。') },
      { key: 'alt', label: t('替代文字'), type: 'text' },
      { key: 'caption', label: t('说明'), type: 'text' },
      { key: 'link', label: t('点击链接'), type: 'text' },
      {
        key: 'ratio',
        label: t('比例'),
        type: 'select',
        options: ['16:9', '4:3', '1:1', '3:2'].map((value) => ({ value, label: value })),
      },
      {
        key: 'fit',
        label: t('裁剪'),
        type: 'select',
        options: [
          { value: 'cover', label: t('填充') },
          { value: 'contain', label: t('完整显示') },
        ],
      },
      {
        key: 'radius',
        label: t('圆角'),
        type: 'select',
        options: IMAGE_RADIUS_OPTIONS.map(({ value, label }) => ({ value, label })),
        hint: t('「跟随主题」：经典单栏沿用主题圆角，夜航双栏与首屏两张 16px 大卡保持一致。'),
      },
    ],
  },
  {
    type: 'video',
    name: t('视频'),
    description: t('MP4/WebM 视频与封面。'),
    group: 'shared',
    variants: ['classic', 'bento'],
    defaults: { src: '', poster: '', caption: '', show_controls: true, show_pause_button: true },
    schema: [
      { key: 'src', label: t('视频地址'), type: 'text' },
      { key: 'poster', label: t('封面地址'), type: 'text' },
      { key: 'caption', label: t('说明'), type: 'text' },
      { key: 'show_controls', label: t('显示原生播放条'), type: 'toggle' },
      { key: 'show_pause_button', label: t('显示播放/暂停按钮'), type: 'toggle' },
    ],
  },
  {
    type: 'website',
    name: t('网站'),
    description: t('网站卡片或 iframe 嵌入。'),
    group: 'shared',
    variants: ['classic', 'bento'],
    defaults: { url: '', title: '', description: '', image: '', mode: 'card', height: 420 },
    schema: [
      { key: 'url', label: t('网址'), type: 'text' },
      { key: 'title', label: t('标题'), type: 'text' },
      { key: 'description', label: t('描述'), type: 'textarea' },
      { key: 'image', label: t('封面地址'), type: 'text' },
      {
        key: 'mode',
        label: t('展示方式'),
        type: 'select',
        options: [
          { value: 'card', label: t('网站卡片') },
          { value: 'iframe', label: t('iframe 嵌入') },
        ],
      },
      { key: 'height', label: t('iframe 高度'), type: 'number', min: 240, max: 900, step: 20 },
    ],
  },
  {
    type: 'slideshow',
    name: t('幻灯片'),
    description: t('手动幻灯片，自动轮播、箭头与圆点。'),
    group: 'shared',
    variants: ['classic', 'bento'],
    defaults: { slides: '[]', interval: 5, autoplay: true, height: 440 },
    schema: [
      {
        key: 'slides',
        label: t('幻灯片'),
        type: 'itemlist',
        itemLabel: t('张'),
        maxItems: 10,
        itemFields: [
          { key: 'image', label: t('图片地址') },
          { key: 'title', label: t('标题') },
          { key: 'text', label: t('说明') },
          { key: 'link', label: t('链接') },
        ],
      },
      { key: 'interval', label: t('轮播间隔（秒）'), type: 'number', min: 2, max: 20, step: 1 },
      { key: 'autoplay', label: t('自动轮播'), type: 'toggle' },
      { key: 'height', label: t('高度'), type: 'number', min: 240, max: 800, step: 20 },
    ],
  },
  {
    type: 'stats',
    name: t('统计卡片'),
    description: t('一组数字指标，适合成果、年度总结。'),
    group: 'shared',
    variants: ['classic', 'bento'],
    defaults: { title: '一些数字', items: '[]', columns: 3 },
    schema: [
      { key: 'title', label: t('标题'), type: 'text', hint: t('留空隐藏标题。') },
      { key: 'columns', label: t('列数'), type: 'select', options: [2, 3, 4].map((n) => ({ value: String(n), label: t('{count} 列', { count: n }) })) },
      {
        key: 'items',
        label: t('指标'),
        type: 'itemlist',
        itemLabel: t('项'),
        maxItems: 8,
        itemFields: [
          { key: 'value', label: t('数值') },
          { key: 'suffix', label: t('单位') },
          { key: 'label', label: t('说明') },
          { key: 'color', label: t('颜色'), type: 'color' },
        ],
      },
    ],
  },
  {
    type: 'chart',
    name: t('图表'),
    description: t('柱状、折线或环形图，可手填或读本机访问统计。'),
    group: 'shared',
    variants: ['classic', 'bento'],
    defaults: { title: '访问趋势', kind: 'bar', source: 'manual', items: '[]', height: 320, show_legend: true },
    schema: [
      { key: 'title', label: t('标题'), type: 'text' },
      {
        key: 'kind',
        label: t('图表类型'),
        type: 'select',
        options: [
          { value: 'bar', label: t('柱状图') },
          { value: 'line', label: t('折线图') },
          { value: 'donut', label: t('环形图') },
        ],
      },
      {
        key: 'source',
        label: t('数据来源'),
        type: 'select',
        options: [
          { value: 'manual', label: t('手动填写') },
          { value: 'local_visits', label: t('本机访问统计') },
        ],
      },
      {
        key: 'items',
        label: t('数据'),
        type: 'itemlist',
        itemLabel: t('项'),
        maxItems: 12,
        itemFields: [
          { key: 'label', label: t('标签') },
          { key: 'value', label: t('数值') },
          { key: 'color', label: t('颜色'), type: 'color' },
        ],
      },
      { key: 'height', label: t('高度'), type: 'number', min: 220, max: 620, step: 20 },
      { key: 'show_legend', label: t('显示图例'), type: 'toggle' },
    ],
  },
  {
    type: 'list',
    name: t('列表'),
    description: t('带标题、说明和链接的条目列表。'),
    group: 'shared',
    variants: ['classic', 'bento'],
    defaults: { title: '清单', style: 'plain', items: '[]' },
    schema: [
      { key: 'title', label: t('标题'), type: 'text' },
      {
        key: 'style',
        label: t('样式'),
        type: 'select',
        options: [
          { value: 'plain', label: t('简洁') },
          { value: 'ordered', label: t('编号') },
          { value: 'icon', label: t('图标') },
        ],
      },
      {
        key: 'items',
        label: t('条目'),
        type: 'itemlist',
        itemLabel: t('条'),
        maxItems: 20,
        itemFields: [
          { key: 'title', label: t('标题') },
          { key: 'text', label: t('说明') },
          { key: 'link', label: t('链接') },
        ],
      },
    ],
  },
  {
    type: 'articles',
    name: t('文章组件'),
    description: t('最新或热门文章，支持列表、分栏和悬浮卡片。'),
    group: 'shared',
    variants: ['classic', 'bento'],
    defaults: {
      title: '最新文章',
      source: 'latest',
      layout: 'list',
      columns: 2,
      limit: 6,
      show_excerpt: true,
      show_meta: true,
      show_tags: true,
    },
    schema: [
      { key: 'title', label: t('标题'), type: 'text', hint: t('留空隐藏标题。') },
      {
        key: 'source',
        label: t('内容来源'),
        type: 'select',
        options: [
          { value: 'latest', label: t('最新发布') },
          { value: 'popular', label: t('热门文章') },
        ],
      },
      {
        key: 'layout',
        label: t('布局'),
        type: 'select',
        options: [
          { value: 'list', label: t('单行列表（无分栏）') },
          { value: 'grid', label: t('分栏卡片') },
          { value: 'floating', label: t('悬浮卡片') },
        ],
      },
      { key: 'columns', label: t('分栏列数'), type: 'select', options: [2, 3, 4].map((n) => ({ value: String(n), label: t('{count} 列', { count: n }) })) },
      { key: 'limit', label: t('显示篇数'), type: 'number', min: 1, max: 24, step: 1 },
      { key: 'show_excerpt', label: t('显示摘要'), type: 'toggle' },
      { key: 'show_meta', label: t('显示日期'), type: 'toggle' },
      { key: 'show_tags', label: t('显示标签'), type: 'toggle' },
    ],
  },
  {
    type: 'guestbook',
    name: t('留言箱'),
    description: t('一张留言表单 + 最新留言列表，适合「留言板 / 树洞」这样的页面。'),
    group: 'shared',
    variants: ['classic', 'bento'],
    defaults: {
      heading: '留言箱',
      intro: '想说点什么就写在这里：一句问候、一段近况，或者只是路过。',
      placeholder: '写句话吧…',
      limit: 20,
    },
    schema: [
      { key: 'heading', label: t('标题'), type: 'text', hint: t('留空显示「留言箱」。') },
      { key: 'intro', label: t('引导语'), type: 'textarea', hint: t('留空隐藏。') },
      { key: 'placeholder', label: t('输入框占位文字'), type: 'text' },
      { key: 'limit', label: t('最多显示留言数'), type: 'number', min: 3, max: 50, step: 1 },
    ],
  },
  {
    type: 'code',
    name: t('自定义代码'),
    description: t('HTML + CSS + JS，在独立 sandbox iframe 中运行。'),
    group: 'shared',
    variants: ['classic', 'bento'],
    defaults: { html: '<div class="box">Hello</div>', css: '.box { font-family: sans-serif; padding: 24px; }', js: '', height: 320 },
    schema: [
      { key: 'html', label: 'HTML', type: 'textarea', bindable: false, hint: t('只能访问这个 iframe 内部，不能读取后台。') },
      { key: 'css', label: 'CSS', type: 'textarea', bindable: false },
      { key: 'js', label: 'JavaScript', type: 'textarea', bindable: false, hint: t('在 sandbox 中执行，不加载外部脚本。') },
      { key: 'height', label: t('高度'), type: 'number', min: 120, max: 900, step: 20 },
    ],
  },
  {
    type: 'button',
    name: t('按钮'),
    description: t('一组带样式的行动按钮：站内跳转、外部链接、对齐与尺寸都能改。'),
    group: 'shared',
    variants: ['classic', 'bento'],
    defaults: { buttons: [], align: 'left', size: 'md', new_tab: false },
    schema: [
      {
        key: 'buttons',
        label: t('按钮'),
        type: 'repeater',
        itemLabel: t('按钮'),
        minItems: 1,
        maxItems: 4,
        hint: t(
          '最多 4 个。链接可填 http(s) 地址或以 / 开头的站内路径；留空则只显示样式、不可点击。',
        ),
        itemSchema: [
          { key: 'label', label: t('文字'), type: 'text' },
          { key: 'link', label: t('链接'), type: 'text' },
          {
            key: 'style',
            label: t('样式'),
            type: 'select',
            options: [
              { value: 'solid', label: t('实心') },
              { value: 'outline', label: t('描边') },
              { value: 'ghost', label: t('幽灵') },
              { value: 'link', label: t('文字链接') },
            ],
          },
        ],
      },
      {
        key: 'align',
        label: t('对齐'),
        type: 'select',
        options: [
          { value: 'left', label: t('左对齐') },
          { value: 'center', label: t('居中') },
          { value: 'right', label: t('右对齐') },
        ],
      },
      {
        key: 'size',
        label: t('尺寸'),
        type: 'select',
        options: [
          { value: 'sm', label: t('小') },
          { value: 'md', label: t('中') },
          { value: 'lg', label: t('大') },
        ],
      },
      { key: 'new_tab', label: t('外部链接在新窗口打开'), type: 'toggle' },
    ],
  },

  /* ---------------- 内容型（P2 无媒体组件三件套） ---------------- */
  {
    type: 'feature-grid',
    name: t('功能网格'),
    description: t('图标 + 标题 + 说明，2–4 列排开，适合把功能点一次讲清。'),
    group: 'content',
    variants: ['classic', 'bento'],
    defaults: { heading: '', columns: 3, items: [] },
    schema: [
      { key: 'heading', label: t('标题'), type: 'text', hint: t('留空隐藏标题。') },
      {
        key: 'columns',
        label: t('列数'),
        type: 'select',
        options: [2, 3, 4].map((n) => ({ value: String(n), label: t('{count} 列', { count: n }) })),
      },
      {
        key: 'items',
        label: t('条目'),
        type: 'repeater',
        itemLabel: t('条目'),
        maxItems: 8,
        hint: t('最多 8 条。图标可填内置图标名，留空则不显示图标。'),
        itemSchema: [
          { key: 'icon', label: t('图标'), type: 'text' },
          { key: 'title', label: t('标题'), type: 'text' },
          { key: 'text', label: t('说明'), type: 'textarea' },
        ],
      },
    ],
  },
  {
    type: 'card-grid',
    name: t('卡片组'),
    description: t('一组可点击的卡片，比功能网格更自由，适合导航与推荐。'),
    group: 'content',
    variants: ['classic', 'bento'],
    defaults: { heading: '', columns: 3, items: [] },
    schema: [
      { key: 'heading', label: t('标题'), type: 'text', hint: t('留空隐藏标题。') },
      {
        key: 'columns',
        label: t('列数'),
        type: 'select',
        options: [2, 3, 4].map((n) => ({ value: String(n), label: t('{count} 列', { count: n }) })),
      },
      {
        key: 'items',
        label: t('条目'),
        type: 'repeater',
        itemLabel: t('条目'),
        maxItems: 9,
        hint: t(
          '最多 9 条。链接可填 http(s) 地址或以 / 开头的站内路径；留空则卡片不可点击。',
        ),
        itemSchema: [
          { key: 'title', label: t('标题'), type: 'text' },
          { key: 'text', label: t('说明'), type: 'textarea' },
          { key: 'link', label: t('链接'), type: 'text' },
        ],
      },
    ],
  },
  {
    type: 'steps',
    name: t('步骤'),
    description: t('按顺序排列的步骤 / 流程，可纵向也可横向排开。'),
    group: 'content',
    variants: ['classic', 'bento'],
    defaults: { heading: '', orientation: 'vertical', items: [] },
    schema: [
      { key: 'heading', label: t('标题'), type: 'text', hint: t('留空隐藏标题。') },
      {
        key: 'orientation',
        label: t('方向'),
        type: 'select',
        options: [
          { value: 'vertical', label: t('纵向') },
          { value: 'horizontal', label: t('横向') },
        ],
        hint: t('横向在窄屏自动退回纵向。'),
      },
      {
        key: 'items',
        label: t('条目'),
        type: 'repeater',
        itemLabel: t('条目'),
        maxItems: 8,
        hint: t('最多 8 条，序号按顺序自动生成。'),
        itemSchema: [
          { key: 'title', label: t('标题'), type: 'text' },
          { key: 'text', label: t('说明'), type: 'textarea' },
        ],
      },
    ],
  },
];

/**
 * 区块目录对外的视图。
 *
 * 目录是模块级常量，`t()` 在 import 时就求值了；用 `liveCatalog` 把中文换成
 * 读取时翻译的 getter，切换语言后调色板与属性面板才会跟着变。
 * `defaults` 是新建区块时写进页面 JSON 的初始内容，属于持久化数据，不参与翻译。
 */
export const BLOCK_DEFS = liveCatalog(RAW_BLOCK_DEFS, { skip: ['defaults'] });

export const BLOCK_TYPES = new Set(BLOCK_DEFS.map((item) => item.type));

export function blockDef(type: string): BlockDefinition | undefined {
  return BLOCK_DEFS.find((item) => item.type === type);
}

/** 默认动画：新加入的区块用它，可在每个区块上单独改。 */
export const DEFAULT_ANIMATION: BlockAnimation = 'fade-up';

let seq = 0;

/** 生成区块 id。同一份配置里唯一即可，导入时按前缀去重。 */
export function nextBlockId(prefix = 'blk'): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}`;
}

export function createBlock(type: string, patch?: Partial<BlockInstance>): BlockInstance {
  const def = blockDef(type);
  return {
    id: nextBlockId(),
    type,
    title: def?.name ?? type,
    props: { ...(def?.defaults ?? {}) },
    animation: DEFAULT_ANIMATION,
    hidden: false,
    ...patch,
  };
}

/** 按窗口宽度判断当前设备；阈值来自 lib/layout.ts 的唯一断点表。 */
export function builderDeviceForWidth(width: number): BuilderDevice {
  if (width < BREAKPOINT_MD) return 'mobile';
  if (width < BREAKPOINT_LG) return 'tablet';
  return 'desktop';
}

/** 取某份编排在指定设备下实际渲染的区块。 */
export function screenBlocksForDevice(
  layout: ScreenLayout,
  device: BuilderDevice,
): BlockInstance[] {
  if (!layout.device_split || !layout.devices) return layout.blocks;
  return (
    layout.devices[device]?.blocks ??
    layout.devices.desktop?.blocks ??
    layout.blocks
  );
}

/** 判断一份编排是否在任意设备下还有可渲染的区块。 */
export function screenHasBlocks(layout: ScreenLayout): boolean {
  if (layout.blocks.length) return true;
  return Object.values(layout.devices ?? {}).some(
    (entry) => (entry?.blocks.length ?? 0) > 0,
  );
}

/** 「文章内容」占位符的类型名。 */
export const ARTICLE_CONTENT_TYPE = 'article-content';

/** 一棵区块树里有没有「文章内容」占位符（含分栏 / 容器里的嵌套区块）。 */
function treeHasArticleContent(blocks: BlockInstance[]): boolean {
  return blocks.some(
    (block) =>
      !block.hidden &&
      (block.type === ARTICLE_CONTENT_TYPE || treeHasArticleContent(block.children ?? [])),
  );
}

/**
 * 这份编排里有没有「文章内容」占位符。
 *
 * 文章页据此决定正文画在哪：有占位符就把整份编排放在正文的位置，由占位符
 * 渲染正文；没有就保持旧行为（正文照旧，编排区块排在评论区之后）。
 * 分设备编排也要查一遍——手机版里可能只有它。
 */
export function hasArticleContent(layout: ScreenLayout): boolean {
  if (treeHasArticleContent(layout.blocks)) return true;
  return Object.values(layout.devices ?? {}).some((entry) =>
    treeHasArticleContent(entry?.blocks ?? []),
  );
}

/** 深拷贝一份区块编排，供开启分设备时初始化其它设备。 */
export function cloneBlocks(blocks: BlockInstance[]): BlockInstance[] {
  return JSON.parse(JSON.stringify(blocks)) as BlockInstance[];
}

/** 按布局变体生成默认首页编排。 */
export function defaultHomeLayout(variant: LayoutVariant): ScreenLayout {  if (variant === 'bento') {
    return {
      blocks: [
        createBlock('bento-hero'),
        createBlock('category-pills'),
        createBlock('spotlight'),
        createBlock('post-grid'),
        createBlock('author-card'),
        createBlock('stat-list'),
        createBlock('tag-cloud'),
        createBlock('archive'),
      ],
    };
  }
  return {
    blocks: [createBlock('classic-hero'), createBlock('feed'), createBlock('join-band')],
  };
}

/** 读取区块的一个属性，类型不符时回退到默认值。 */
export function blockProp<T extends string | number | boolean>(
  block: BlockInstance,
  key: string,
  fallback: T,
): T {
  const value = block.props[key];
  if (typeof value === typeof fallback) return value as T;
  return fallback;
}

/** 解析 itemlist 属性（JSON 字符串 → 条目数组）。坏数据返回空数组。 */
export function blockItems(block: BlockInstance, key: string): Record<string, string>[] {
  const raw = block.props[key];
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: Record<string, string>[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object') continue;
      const entry: Record<string, string> = {};
      for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
        if (typeof v === 'string' || typeof v === 'number') entry[k] = String(v).slice(0, 200);
      }
      out.push(entry);
    }
    return out.slice(0, 30);
  } catch {
    return [];
  }
}

/** 当前变体下可添加的区块。 */
export function availableBlocks(variant: LayoutVariant): BlockDefinition[] {
  return BLOCK_DEFS.filter((item) => item.variants.includes(variant));
}

/* ---------------- 12 栏栅格（grid） ---------------- */

/** 栅格容器的栏数上限；与 `BlockSpan` 的 1–12 是同一套数。 */
export const GRID_MAX_COLUMNS = 12;

/** 栏距的默认档位下标（4 → 16px），与 grid 的 `defaults.gap` 一致。 */
const GRID_DEFAULT_GAP_INDEX = 4;

/** 取一个整数并夹到区间内；非数字回落到 fallback。 */
function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? Math.round(value) : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/**
 * grid 容器的栏数与间距（px）。
 *
 * 纯函数：渲染器和测试共用一份，栏数与档位的夹取规则不会两处各写一遍。
 *
 * 栏数是「夹」：0 → 1、99 → 12，用户输入一个离谱的栏数仍然能得到一个合法容器。
 * 间距档位是「回落」：越界（99）或非整数档位一律当作没设，回到默认档 4 → 16px。
 * 两者不同是因为把 99 夹到 9 会静默变成 96px 的巨缝，比回到默认更不像用户的本意。
 */
export function gridTemplate(block: BlockInstance): { columns: number; gap: number } {
  const columns = clampInt(block.props.columns, 1, GRID_MAX_COLUMNS, GRID_MAX_COLUMNS);
  const gap = spacingPx(block.props.gap) ?? SPACING_SCALE[GRID_DEFAULT_GAP_INDEX];
  return { columns, gap };
}

/**
 * 子区块在某一档下**作者写了什么**；缺省满宽、无偏移。
 *
 * 这里只做取值：给定档位，读出作者为这一档写的 span/offset（没写就继承 base）。
 * 它**不**判断此刻是哪一档——"哪个档位生效"在 `styles.css` 的媒体查询里，
 * 和 `at` 覆盖层看的是同一个视口宽度。所以这个函数对三档各调一次，三个值都写进
 * 变量，谁赢由浏览器按视口决定，JS 里没有第二处阈值判断。
 *
 * 也不管容器有几栏——与栏数的关系交给 `gridPlacements`，因为同一个区块在不同
 * 栏数的容器里落位不同，"夹到栏数内"是容器的事。
 */
export function spanFor(
  block: BlockInstance,
  device: BuilderDevice,
): { span: number; offset: number } {
  const pick = (
    value: { base?: number; md?: number; sm?: number } | undefined,
    fallback: number,
  ) => {
    if (!value) return fallback;
    if (device === 'tablet' && value.md !== undefined) return value.md;
    if (device === 'mobile' && value.sm !== undefined) return value.sm;
    return value.base ?? fallback;
  };
  return {
    span: clampInt(pick(block.span, GRID_MAX_COLUMNS), 1, GRID_MAX_COLUMNS, GRID_MAX_COLUMNS),
    offset: clampInt(pick(block.offset, 0), 0, GRID_MAX_COLUMNS - 1, 0),
  };
}

/** 一格的三档落位；键名与 `BlockSpan` 的字段、CSS 变量的后缀一致。 */
export interface GridPlacements {
  base: { span: number; offset: number };
  md: { span: number; offset: number };
  sm: { span: number; offset: number };
}

/**
 * 一格在 `columns` 栏容器里的三档落位（桌面 / 平板 / 手机）。
 *
 * 偏移必须夹到「最后一栏放得下」的位置：`grid-column: 9 / span 12` 在 12 栏
 * 容器里会顶出第 13 条隐式栏，整行宽度被撑破、后面的兄弟格全被挤下去。
 * 所以这里逐档算 `offset ≤ columns - span`，尺寸档也一起按栏数收窄。
 *
 * 三档一次算完，是因为响应式那一半在 CSS 里：渲染器把三档全写进自定义属性，
 * 由 `styles.css` 的媒体查询决定谁生效（阈值 768 / 1024，与 `builderDeviceForWidth`
 * 同一张断点表）。改宽度不需要 JS 重算，也不会出现"栅格以为自己是手机、覆盖层
 * 以为自己是桌面"的两种设备定义。
 */
export function gridPlacements(block: BlockInstance, columns: number): GridPlacements {
  const cols = clampInt(columns, 1, GRID_MAX_COLUMNS, GRID_MAX_COLUMNS);
  const fit = (span: number, offset: number) => {
    const width = Math.min(cols, span);
    return { span: width, offset: Math.min(offset, cols - width) };
  };
  const base = spanFor(block, 'desktop');
  const md = spanFor(block, 'tablet');
  const sm = spanFor(block, 'mobile');
  return {
    base: fit(base.span, base.offset),
    md: fit(md.span, md.offset),
    sm: fit(sm.span, sm.offset),
  };
}

/**
 * 一格的 CSS 自定义属性。
 *
 * 只写变量、不写 `grid-column`：三档规则在 `styles.css` 里，用媒体查询按视口宽度
 * 切换 `--pp-col-start` / `--pp-col-span` 指向哪一档。预览 iframe 的宽度就是它自己的
 * 视口，所以作者切设备档时媒体查询会跟着重排；"哪一档生效"因此只有 CSS 一个来源，
 * 与 `at` 覆盖层取的判据一致。
 */
export function gridCellVars(block: BlockInstance, columns: number): Record<string, string> {
  const tiers = gridPlacements(block, columns);
  const vars: Record<string, string> = {};
  for (const tier of ['base', 'md', 'sm'] as const) {
    vars[`--pp-span-${tier}`] = String(tiers[tier].span);
    vars[`--pp-offset-${tier}`] = String(tiers[tier].offset);
  }
  return vars;
}

/* ---------------- 分节（section） ---------------- */

/** 取宽带的三档宽度；`full` 不设上限（返回 undefined 即"不限"）。 */
const SECTION_WIDTHS: Record<string, number | undefined> = {
  narrow: 640,
  normal: 860,
  wide: 1200,
  full: undefined,
};

/**
 * 缺省留白档：6 → 32px。
 *
 * 存的是 `SPACING_SCALE` 的下标而不是像素；32px 是分节默认的上下留白
 * （与 `padding_y` 坏值时的回落值同一个数，渲染才不会因为"有没有这个字段"
 * 而跳一下）。
 */
const SECTION_DEFAULT_PADDING_INDEX = 6;

/**
 * section 的取宽带与留白；颜色只接受 #rgb / #rrggbb / #rrggbbaa。
 *
 * 宽度是「回落」：认不出的档位（旧数据、手写的字符串）一律按常规 860 处理，
 * 因为一个 0 宽的版面比常规宽度更像故障。留白档同理：非整数或越界（99）
 * 当作没设，回到缺省的 32px，而不是夹到 96px 的巨缝。
 * 颜色只有十六进制能原样落进 style，其余（主题令牌、拼错的名字）丢弃——
 * 让底色退回主题，别把一个无效值写进 CSS。
 */
export function sectionLayout(block: BlockInstance): {
  maxWidth?: number;
  paddingY: number;
  background?: string;
  divider: boolean;
} {
  const raw = block.props;
  const width = typeof raw.max_width === 'string' ? raw.max_width : 'normal';
  const paddingIndex =
    typeof raw.padding_y === 'number' ? raw.padding_y : SECTION_DEFAULT_PADDING_INDEX;
  const paddingY = spacingPx(paddingIndex) ?? 32;
  const color = typeof raw.background === 'string' ? raw.background.trim() : '';
  // 用 `in` 而不是 `?? 860`：`full` 的合法值就是 undefined（不限宽），
  // 空值合并会把"满宽"错当成"没认出这个档位"再补回 860。
  const maxWidth = width in SECTION_WIDTHS ? SECTION_WIDTHS[width] : 860;
  return {
    maxWidth,
    paddingY,
    background: /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(color) ? color : undefined,
    divider: raw.divider === true,
  };
}

/* ---------------- 像素宽 → 栅格占位（一次性折算） ---------------- */

/**
 * 像素宽折算成栅格列数；向上取整，坏输入按满栏处理。
 */
export function widthToSpan(width: number, containerWidth: number, columns = 12): number {
  if (!Number.isFinite(width) || !Number.isFinite(containerWidth) || containerWidth <= 0) {
    return columns;
  }
  const raw = Math.ceil((width / containerWidth) * columns);
  return Math.min(columns, Math.max(1, raw));
}

/**
 * 一次性把「像素宽」折算成「栅格占位」。
 *
 * 只折算**直接位于 grid 容器内**的区块：`span` 只有 `GridBlock` 会消费，而
 * `BlockView` 仍然用 `width` 画外层区块的宽度。把 grid 之外的 width 折成 span
 * 并删掉 width，等于让 v1 里设过像素宽的区块在第一次读取后悄悄变成满宽——
 * P1 的底线是「v1 配置读出来仍然渲染成原来的样子」。
 *
 * 「是不是栅格里的格子」由 `inGrid` 一路传下去，不回头去查父节点：父节点信息在
 * 递归里本来就有，事后再找一遍既慢又容易和真实嵌套走散。
 *
 * 只处理没有 span 的区块——已经有 span 的说明用户已经按格子排过，不再二次折算。
 */
export function migrateWidthsToSpan(
  blocks: BlockInstance[],
  containerWidth: number,
  columns = 12,
  inGrid = false,
): BlockInstance[] {
  return blocks.map((block) => {
    // 只有 grid 的直接子区块才是「格子」；grid 里再套 container / columns，
    // 更深的区块已经不是栅格项，宽度语义照旧。
    const childInGrid = block.type === 'grid';
    const children = block.children?.length
      ? migrateWidthsToSpan(block.children, containerWidth, columns, childInGrid)
      : block.children;
    const next: BlockInstance = children !== block.children ? { ...block, children } : block;
    if (!inGrid || typeof block.width !== 'number' || block.width <= 0 || block.span) return next;
    const { width: _dropWidth, ...rest } = next;
    return { ...rest, span: { base: widthToSpan(block.width, containerWidth, columns) } };
  });
}
