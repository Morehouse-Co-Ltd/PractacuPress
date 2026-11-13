import { useCallback, useMemo } from 'react';
import type {
  ArticleCardStyle,
  ArticleCover,
  BlockAnimation,
  BlockDisplayOverride,
  BlockInstance,
  BlockPropRecord,
  BlockProps,
  BlockSpan,
  BlockVisibility,
  BuilderDevice,
  CommentSettings,
  CustomExtension,
  ExtensionId,
  ExtensionPageScope,
  ExtensionPermission,
  ExtensionSlot,
  FeedSettings,
  HeaderStyle,
  HeroSettings,
  HumanVerificationProvider,
  HumanVerificationSettings,
  LayoutSettings,
  LogicChain,
  LogicStep,
  ScreenLayout,
  SeoSettings,
  SiteCustomization,
  SitePage,
  SiteTheme,
  TaxonomySettings,
  TaxonomyTerm,
  ThemeMode,
  WebConfig,
} from '../types';
import { useAuth } from './session';
import { normalizePins } from './homeTiles';
import {
  DEFAULT_THEME,
  THEME_PRESETS,
  normalizeThemeSettings,
  themeCss,
  type ThemePreset,
} from './theme';
import {
  BUILTIN_THEME_IDS,
  builtinThemeBundle,
  inferActiveTheme,
  normalizeCustomTheme,
  normalizeVariant,
} from './themes';
import {
  BLOCK_TYPES,
  blockDef,
  createBlock,
  defaultHomeLayout,
  isLegacyDaylightHome,
  migrateWidthsToSpan,
  nextBlockId,
} from './blocks';
import type { PropSchema } from './blocks';
import { normalizeBlockAppearance } from './blockAppearance';
import { MAX_BLOCKS, MAX_BLOCK_DEPTH, MAX_CHILDREN_PER_CONTAINER, clampColumn, countBlocks } from './blockTree';
import {
  defaultFooterColumns,
  normalizeFooterColumns,
  normalizeNavTabs,
  normalizeSocialLinks,
} from './navigation';
import { DEFAULT_PERMISSIONS, normalizePermissions } from './permissions';
import {
  DEFAULT_PERMISSION_GROUPS,
  normalizePermissionGroupConfigs,
} from './permissions';
import { t } from './i18n';
import { liveCatalog } from './i18n/live';
import { normalizeLocale, type Locale } from './i18n/locales';
import { CURRENT_SCHEMA_VERSION, migrateCustomization } from './migrate';
import { publishMigrationReport } from './migrationNotice';
import { setThemePreference, useThemePreference } from './themePreference';
import { runThemeTransition } from './themeTransition';

/**
 * 站点外观、页面与扩展。
 *
 * 这些是纯前端能力：契约 v0.1.0 没有主题、页面或插件端点，所以配置保存在
 * `pp.web.config.v1` 的 `customization` 字段里。外观页与主题工坊提供导出 / 导入，
 * 用于在浏览器之间迁移；真实后端接入后应改为服务端存储。
 */

export { DEFAULT_THEME, THEME_PRESETS, themeCss };
export type { ThemePreset };

export const DEFAULT_HERO: HeroSettings = {
  kicker: '',
  // 换行即换行；*文字* 用斜体强调色显示。
  title: t('精彩内容\n*就此展开*。'),
  lede: '',
};

export const DEFAULT_LAYOUT: LayoutSettings = {
  brand_sub: 'Independent publishing',
  show_articles: true,
  show_posts: true,
  show_search: true,
  header_style: 'classic',
  header_blur: true,
  header_blur_amount: 12,
  header_threshold: 8,
  // 夜航首页文章卡默认保持原来的「封面在上、文字在下」。
  article_card_style: 'cover',
  footer_text: '',
  // 页脚品牌区与底部说明：留空时回退到站点名称/简介与默认英文副标题。
  footer_brand_name: '',
  footer_brand_sub: '',
  footer_brand_desc: '',
  footer_show_tags: true,
  footer_tags: '',
  footer_note: t('前端 v0.1 · React'),
  // undefined = 自动导航：内置入口 + 勾选“加入站点导航”的页面。
  nav_tabs: undefined,
  /** 顶部导航整体对齐与图标默认位置；单个 Tab 可以覆盖图标位置。 */
  nav_align: 'left',
  nav_icon_position: 'left',
  /** 有二级入口时默认展示成胶囊栏；可改成下拉菜单。 */
  nav_sub_style: 'bar',
  nav_sub_show_icons: true,
  /** 夜航页头左上角与页脚底栏上方的快捷链接。 */
  social_links: [],
  footer_columns: defaultFooterColumns(),
  icp: '',
  police: '',
  police_icon: '',
  show_filing: false,
  site_icon: '',
  announcement: '',
  announcement_link: '',
  hero: DEFAULT_HERO,
  variant: 'classic',
};

export const DEFAULT_COMMENT_SETTINGS: CommentSettings = {
  enabled: true,
  require_review: false,
  notice: '',
};

export const DEFAULT_VERIFICATION: HumanVerificationSettings = {
  enabled: false,
  provider: 'turnstile',
  site_key: '',
  recaptcha_version: 'v2',
  on_login: true,
  on_register: true,
  on_comment: false,
  on_password_reset: true,
};

export const DEFAULT_TAXONOMY: TaxonomySettings = {
  categories: [
    { id: 'cat_writing', name: '写作', slug: 'writing', color: '#2f6b4f', description: '关于写作方法、编辑与出版。' },
    { id: 'cat_design', name: '设计', slug: 'design', color: '#5b6f8c', description: '排版、界面与阅读体验。' },
    { id: 'cat_community', name: '社区', slug: 'community', color: '#8a6a1f', description: '成员、评论与社区规则。' },
    { id: 'cat_product', name: '产品', slug: 'product', color: '#7a5b8c', description: '更新日志与产品说明。' },
  ],
  tags: [
    // 默认词条与 normalizeTerm 的输出保持同一形状（空说明也显式写出来），
    // 否则第一次读入补上 description、第二次读入才稳定，读取路径就不可幂等。
    { id: 'tag_independent', name: '独立出版', slug: 'independent', description: '' },
    { id: 'tag_typesetting', name: '排版', slug: 'typesetting', description: '' },
    { id: 'tag_community', name: '社区', slug: 'community-life', description: '' },
    { id: 'tag_workflow', name: '工作流', slug: 'workflow', description: '' },
    { id: 'tag_reading', name: '阅读', slug: 'reading', description: '' },
  ],
};

export const DEFAULT_EXTENSIONS: Record<ExtensionId, boolean> = {
  reading_progress: true,
  toc: true,
  code_copy: true,
  share: false,
  announcement: false,
  back_to_top: true,
};

/* ------------------------------------------------------------------ *
 * 文章自定义封面
 * ------------------------------------------------------------------ */

export const MAX_COVERS = 200;

const COVER_POSITIONS: NonNullable<ArticleCover['position']>[] = ['center', 'top', 'bottom'];

/**
 * 校验封面地址。
 *
 * 只接受 http(s)、站内绝对路径与 base64 图片：`javascript:` / `data:text/html` 一律丢弃。
 * 这里不做截断——data URL 截断会变成坏图，宁可整条拒绝。内联图的长度上限是
 * `COVER_DATA_URL_MAX`：封面跟着设计文档一起下发，每张 64 KB 已经是首屏负担。
 */
export function normalizeCoverUrl(value: unknown): string {
  const url = typeof value === 'string' ? value.trim() : '';
  // 整条长度先过一遍：超长的 http(s) 地址本来也没有意义，data URL 更不能进设计文档。
  if (!url || url.length > COVER_DATA_URL_MAX) return '';
  if (/^https?:\/\/\S+$/i.test(url)) return url.slice(0, 2000);
  // 长度已在上限内，base64 图片原样保留（截断会变成坏图）。
  if (/^data:image\/(png|jpe?g|webp|gif|avif);base64,[a-z0-9+/=\s]+$/i.test(url)) return url;
  // SVG 只作为 <img> 渲染，不进入 DOM，允许 base64 与 percent-encode 两种写法。
  if (/^data:image\/svg\+xml(;[a-z0-9=.+-]+)*(;base64)?,[^"'<>]*$/i.test(url)) return url;
  if (/^\/(?!\/)\S*$/.test(url)) return url.slice(0, 2000);
  return '';
}

export function coverUrlError(value: string): string {
  const url = value.trim();
  if (!url) return '';
  // 先判长度：超长 data URL 会在 normalizeCoverUrl 里被整条拒绝，不能只给「格式不对」。
  if (url.startsWith('data:') && url.length > COVER_DATA_URL_MAX) {
    return t('图片太大：内联封面图上限 64 KB，请换一张更小的图片。');
  }
  if (normalizeCoverUrl(url)) return '';
  if (url.startsWith('data:')) return t('只支持 png / jpg / webp / gif / svg 图片。');
  return t('请填写 http(s) 图片地址、以 / 开头的站内路径，或直接上传图片。');
}

function normalizeCovers(value: unknown): ArticleCover[] {
  const raw = Array.isArray(value) ? value : [];
  const covers: ArticleCover[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    if (covers.length >= MAX_COVERS) break;
    const entry = item as Partial<ArticleCover>;
    const id = typeof entry.id === 'string' ? entry.id.slice(0, 80) : '';
    if (!id || seen.has(id)) continue;
    const hidden = bool(entry.hidden, false);
    const url = normalizeCoverUrl(entry.url);
    if (!url && !hidden) continue;
    seen.add(id);
    const position = COVER_POSITIONS.find((item2) => item2 === entry.position);
    covers.push({
      id,
      url,
      ...(text(entry.alt, '', 160) ? { alt: text(entry.alt, '', 160) } : {}),
      ...(position ? { position } : {}),
      ...(hidden ? { hidden: true } : {}),
    });
  }
  return covers;
}

/* ------------------------------------------------------------------ *
 * 自定义 CSS 的内容校验
 * ------------------------------------------------------------------ */

/** 自定义 CSS 长度上限（服务端同名字段按「高危串 + 长度」再做一次校验）。 */
export const MAX_CUSTOM_CSS_CHARS = 20_000;

/**
 * 自定义 CSS 里不能出现的高危构造。
 *
 * H-1 之后这份样式会被服务端分发给每个访客（`SiteChrome` 原样放进 `<style>`），
 * 所以它必须只是样式：`@import` 与 `url()` 里的脚本/HTML 协议会把样式变成外联或
 * 执行面。匹配前按 CSS 解析器的顺序规范化（去注释 → 解转义 → 去空白 → 小写），
 * 否则在 `@im` 与 `port` 中间夹一段注释、或用 `\40 import` 这类转义写法，
 * 都能绕过按字面量匹配的检查。
 *
 * 只拦高危串：`url(https://…)`、`position: fixed`、`@media` 等合法样式必须保留，
 * 所以这里不做整体白名单。
 */
const HIGH_RISK_CSS_PATTERNS: [string, RegExp][] = [
  ['@import', /@import/],
  ['expression(', /expression\(/],
  ['behavior:', /behavior:/],
  ['-moz-binding', /-moz-binding/],
  ['url(javascript:', /url\(["']?javascript:/],
  ['url(data:text/', /url\(["']?data:text\//],
];

const CSS_COMMENT = /\/\*[\s\S]*?\*\//g;
const CSS_ESCAPE = /\\([0-9a-fA-F]{1,6}\s?|.)/g;

/** 解析 CSS 转义：`\2f` 这样的十六进制转义与 `\x` 单字符转义。 */
function decodeCssEscapes(value: string): string {
  return value.replace(CSS_ESCAPE, (_match: string, body: string) => {
    const trimmed = body.trim();
    if (!trimmed) return body;
    const code = Number.parseInt(trimmed, 16);
    if (!Number.isFinite(code)) return body;
    if (code < 0 || code > 0x10ffff) return '\ufffd';
    return String.fromCodePoint(code);
  });
}

function normalizeCssForScan(value: string): string {
  return decodeCssEscapes(value.replace(CSS_COMMENT, ''))
    .toLowerCase()
    .replace(/[\s\u0000-\u001f\u007f]/g, '');
}

/** 命中的高危构造文案；没有命中返回空串（测试与导入提示共用）。 */
export function highRiskCustomCssMarker(value: unknown): string {
  if (typeof value !== 'string' || !value) return '';
  const normalized = normalizeCssForScan(value);
  for (const [marker, pattern] of HIGH_RISK_CSS_PATTERNS) {
    if (pattern.test(normalized)) return marker;
  }
  return '';
}

/**
 * 把样式表切成顶层规则：到顶层的 `;`（@import 这类语句）或配平的 `{...}`（普通规则
 * 与 @media 等块）为止。引号、注释里的符号不参与配平。
 */
function splitTopLevelCssRules(source: string): string[] {
  const rules: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = '';
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (quote) {
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === quote) quote = '';
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      index += 1;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth = Math.max(0, depth - 1);
      if (depth === 0) {
        rules.push(source.slice(start, index + 1));
        start = index + 1;
      }
    } else if (char === ';' && depth === 0) {
      rules.push(source.slice(start, index + 1));
      start = index + 1;
    }
    index += 1;
  }
  if (start < source.length) rules.push(source.slice(start));
  return rules.map((rule) => rule.trim()).filter(Boolean);
}

/**
 * 读入 / 导出时使用的自定义 CSS 规范化：含高危构造的顶层规则整条丢弃，其余原样保留。
 *
 * 服务端还有一层同样的检查；两层是有意的：前端保证渲染与导出不会带毒，服务端保证
 * 绕过前端直接 PUT（或旧客户端）也不会把毒文档分发给访客。
 */
export function sanitizeCustomCss(value: unknown, max = MAX_CUSTOM_CSS_CHARS): string {
  if (typeof value !== 'string' || !value) return '';
  const source = value.slice(0, max);
  if (!source.trim()) return '';
  // 干净样式原样返回，避免无意义地重排操作者手写的格式。
  if (!highRiskCustomCssMarker(source)) return source;
  const kept = splitTopLevelCssRules(source).filter((rule) => !highRiskCustomCssMarker(rule));
  const result = kept.join('\n').trim();
  if (!result || highRiskCustomCssMarker(result)) return '';
  return result.slice(0, max);
}

/* ------------------------------------------------------------------ *
 * 创作者扩展（沙箱）
 * ------------------------------------------------------------------ */

export const MAX_CUSTOM_EXTENSIONS = 20;
export const EXTENSION_LIMITS = {
  html: 80_000,
  css: 40_000,
  js: 80_000,
  name: 60,
  description: 400,
  author: 60,
  version: 24,
} as const;

export const EXTENSION_SLOTS: ExtensionSlot[] = [
  'site_header',
  'site_footer',
  'home_top',
  'home_bottom',
  'article_top',
  'article_bottom',
  'article_side',
  'floating',
];

export const EXTENSION_PAGE_SCOPES: ExtensionPageScope[] = [
  'all',
  'home',
  'article',
  'list',
  'search',
];

export const EXTENSION_PERMISSIONS: ExtensionPermission[] = [
  'notify',
  'open_link',
  'navigate',
  'clipboard',
  'theme',
  'storage',
];

const EXTENSION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,60}$/;

function stringList<T extends string>(value: unknown, allowed: readonly T[], fallback: T[]): T[] {
  const raw = Array.isArray(value) ? value : [];
  const out: T[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const match = allowed.find((candidate) => candidate === item);
    if (match && !out.includes(match)) out.push(match);
  }
  return out.length ? out : fallback;
}

function normalizeExtension(value: unknown): CustomExtension | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<CustomExtension>;
  const name = text(raw.name, '', EXTENSION_LIMITS.name).trim();
  if (!name) return null;
  const id = typeof raw.id === 'string' && EXTENSION_ID_PATTERN.test(raw.id)
    ? raw.id
    : `ext_${Math.random().toString(36).slice(2, 10)}`;
  const slots = stringList(raw.slots, EXTENSION_SLOTS, ['article_bottom']);
  const now = new Date().toISOString();
  return {
    id,
    name,
    version: text(raw.version, '1.0.0', EXTENSION_LIMITS.version).trim() || '1.0.0',
    author: text(raw.author, '', EXTENSION_LIMITS.author).trim() || t('未署名'),
    description: text(raw.description, '', EXTENSION_LIMITS.description),
    ...(text(raw.icon, '', 4) ? { icon: text(raw.icon, '', 4) } : {}),
    enabled: bool(raw.enabled, true),
    slots,
    pages: stringList(raw.pages, EXTENSION_PAGE_SCOPES, ['all']),
    permissions: stringList(raw.permissions, EXTENSION_PERMISSIONS, []),
    html: text(raw.html, '', EXTENSION_LIMITS.html),
    css: text(raw.css, '', EXTENSION_LIMITS.css),
    js: text(raw.js, '', EXTENSION_LIMITS.js),
    created_at: text(raw.created_at, now, 40),
    updated_at: text(raw.updated_at, now, 40),
  };
}

function normalizeCustomExtensions(value: unknown): CustomExtension[] {
  const raw = Array.isArray(value) ? value : [];
  const out: CustomExtension[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (out.length >= MAX_CUSTOM_EXTENSIONS) break;
    const extension = normalizeExtension(item);
    if (!extension || seen.has(extension.id)) continue;
    seen.add(extension.id);
    out.push(extension);
  }
  return out;
}


export const DEFAULT_SEO: SeoSettings = {
  // 标题模板保持克制：搜索引擎更愿意展示「文章名 · 站点名」而不是一串关键词。
  title_template: '{title} · {site}',
  default_description: '',
  keywords: '',
  share_image: '',
  twitter: '',
  indexable: true,
  canonical_base: '',
  publisher: '',
  verification: { google: '', baidu: '', bing: '' },
};

export const DEFAULT_FEED: FeedSettings = {
  // 主题作者卡默认带 /rss.xml 链接，所以新站点默认打开订阅源，避免出现死链。
  enabled: true,
  // 摘要比全文更省流量，也避免把只该在站内阅读的正文整段带出去。
  full_text: false,
  limit: 20,
  include_taxonomy: true,
};

export const DEFAULT_CUSTOMIZATION: SiteCustomization = {
  language: 'zh-CN',
  theme: DEFAULT_THEME,
  layout: DEFAULT_LAYOUT,
  active_theme: 'default',
  themes: [],
  home: defaultHomeLayout('classic'),
  article: { blocks: [] },
  pages: [],
  pins: [],
  covers: [],
  extensions: DEFAULT_EXTENSIONS,
  custom_extensions: [],
  logic: { chains: [] },
  comments: DEFAULT_COMMENT_SETTINGS,
  verification: DEFAULT_VERIFICATION,
  permissions: DEFAULT_PERMISSIONS,
  permission_groups: DEFAULT_PERMISSION_GROUPS,
  seo: DEFAULT_SEO,
  feed: DEFAULT_FEED,
  taxonomy: DEFAULT_TAXONOMY,
  custom_css: '',
};

const RAW_EXTENSIONS: {
  id: ExtensionId;
  name: string;
  description: string;
  detail: string;
}[] = [
  {
    id: 'reading_progress',
    name: t('阅读进度条'),
    description: t('在文章页顶部显示一条细进度线。'),
    detail: t('随滚动更新，不写入任何数据。'),
  },
  {
    id: 'toc',
    name: t('文章目录'),
    description: t('从文章的二、三级标题自动生成目录。'),
    detail: t('至少两个标题时才出现，点击跳到对应段落。'),
  },
  {
    id: 'code_copy',
    name: t('代码块复制'),
    description: t('给正文里的每个代码块加一个复制按钮。'),
    detail: t('只处理前端渲染出的代码块，不改变正文内容。'),
  },
  {
    id: 'share',
    name: t('原生分享'),
    description: t('在文章底部提供“分享”按钮。'),
    detail: t('支持 Web Share API 时调用系统分享，否则复制链接。'),
  },
  {
    id: 'announcement',
    name: t('站点公告条'),
    description: t('在页头下方显示一条可关闭的公告。'),
    detail: t('公告内容在“外观 → 导航与品牌”里填写。'),
  },
  {
    id: 'back_to_top',
    name: t('回到顶部'),
    description: t('页面滚动较深时出现回到顶部按钮。'),
    detail: t('只在站点前台出现，不影响管理后台。'),
  },
];

/** 内置扩展的名称与说明是界面文案，读取时翻译；开关状态用 id 存，不受影响。 */
export const EXTENSIONS = liveCatalog(RAW_EXTENSIONS);

function text(value: unknown, fallback: string, max = 400): string {
  return typeof value === 'string' ? value.slice(0, max) : fallback;
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

const ANIMATIONS: BlockAnimation[] = ['none', 'fade', 'fade-up', 'slide-left', 'slide-right', 'zoom'];

function animation(value: unknown, fallback: BlockAnimation = 'fade-up'): BlockAnimation {
  return typeof value === 'string' && (ANIMATIONS as string[]).includes(value)
    ? (value as BlockAnimation)
    : fallback;
}

/** 区块 props 的逐值清洗：字符串截断、数字夹到 ±1e6，其余标量原样保留。 */
function scalarValue(item: unknown): string | number | boolean | undefined {
  if (typeof item === 'number') return Math.min(1e6, Math.max(-1e6, item));
  if (typeof item === 'boolean') return item;
  if (typeof item === 'string') return item.slice(0, 4000);
  return undefined;
}

/**
 * `richtext` 值的长度上限：8000。
 *
 * 单位是「写进 JSON 之后的字节」，不是字符。两个原因：
 * - 单块 props 的预算是 {@link PROPS_MAX_BYTES}（8 KB），超出的键会被 `capPropBytes`
 *   **整条丢弃**。一段 8000 字（汉字 3 字节）的正文是 24 KB，按字符收的话它不会变成
 *   8000 字节的长文，而是整个 body 消失——用户在刷新后丢内容，比截断坏得多；
 * - JSON 还会把换行、引号、反斜杠转义成 2 字节，多行 Markdown 的转义开销不小。
 *   按转义后的宽度计数，才能保证截断过的值一定过得了单块预算。
 *
 * 一个区块里有多条 richtext 字段时，加起来的体积仍受 `PROPS_MAX_BYTES` 约束（§4.5 的
 * 既有规则）；单条字段在上面这个上限内一定留得下。
 */
export const RICHTEXT_MAX_BYTES = 8000;

/** 一个字符写进 JSON 字符串之后占几个字节（UTF-8 + 必要的转义）。 */
function jsonCharWidth(char: string): number {
  const code = char.codePointAt(0) ?? 0;
  if (code === 0x22 || code === 0x5c || code === 0x0a || code === 0x09) return 2;
  if (code < 0x20) return 6;
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code < 0x10000) return 3;
  return 4;
}

/**
 * `richtext` 值：只接受字符串，超出上限时按字符边界截断（不会切出半个汉字）。
 *
 * 与 `textarea` 同一条路径（都只是文本），但上限更宽、且非字符串一律丢弃：
 * 富文本正文一旦被写成数字或数组，渲染链路拿到的就不是 Markdown 了。
 */
export function richtextValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let used = 0;
  let out = '';
  for (const char of value) {
    const width = jsonCharWidth(char);
    if (used + width > RICHTEXT_MAX_BYTES) break;
    used += width;
    out += char;
  }
  return out;
}

/* ---------- v2 展示层字段（at / visible / anchor / span / offset） ---------- */

/** 12 列栅格的取值范围。 */
const SPAN_MIN = 1;
const SPAN_MAX = 12;

function plainRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function clampSpan(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(SPAN_MAX, Math.max(SPAN_MIN, Math.round(value)));
}

function normalizeBlockSpan(value: unknown): BlockSpan | undefined {
  const record = plainRecord(value);
  if (!record) return undefined;
  const base = clampSpan(record.base);
  if (base === undefined) return undefined;
  const span: BlockSpan = { base };
  for (const key of ['md', 'sm'] as const) {
    const item = clampSpan(record[key]);
    if (item !== undefined) span[key] = item;
  }
  return span;
}

/**
 * 起始列偏移是栅格里的「从第几栏开始」，不是宽度：0 完全合法（第一栏起），
 * 上限是 11（第 12 栏起）。所以它不能借 `span` 的 1–12 夹取——那会把
 * 合法的 `offset: 0` 抬成 1。
 */
const OFFSET_MIN = 0;
const OFFSET_MAX = 11;

function clampOffset(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  return Math.min(OFFSET_MAX, Math.max(OFFSET_MIN, value));
}

function normalizeBlockOffset(value: unknown): BlockSpan | undefined {
  const record = plainRecord(value);
  if (!record) return undefined;
  const base = clampOffset(record.base);
  if (base === undefined) return undefined;
  const offset: BlockSpan = { base };
  for (const key of ['md', 'sm'] as const) {
    const item = clampOffset(record[key]);
    if (item !== undefined) offset[key] = item;
  }
  return offset;
}

function normalizeDisplayOverride(value: unknown): BlockDisplayOverride | undefined {
  const record = plainRecord(value);
  if (!record) return undefined;
  const patch: BlockDisplayOverride = {};
  const span = normalizeBlockSpan(record.span);
  if (span) patch.span = span;
  const offset = normalizeBlockOffset(record.offset);
  if (offset) patch.offset = offset;
  const appearance = normalizeBlockAppearance(record.appearance);
  if (appearance) patch.appearance = appearance;
  if (typeof record.animation === 'string' && (ANIMATIONS as string[]).includes(record.animation)) {
    patch.animation = record.animation as BlockAnimation;
  }
  if (typeof record.hidden === 'boolean') patch.hidden = record.hidden;
  if (typeof record.custom_css === 'string' && record.custom_css) {
    patch.custom_css = record.custom_css.slice(0, 4000);
  }
  if (typeof record.width === 'number' && record.width > 0) patch.width = Math.min(1600, Math.round(record.width));
  if (typeof record.height === 'number' && record.height > 0) {
    patch.height = Math.min(2400, Math.round(record.height));
  }
  if (record.align === 'left' || record.align === 'center' || record.align === 'right') {
    patch.align = record.align;
  }
  for (const key of ['gap_scale', 'mt', 'mb'] as const) {
    const item = record[key];
    if (typeof item === 'number' && Number.isFinite(item)) patch[key] = item;
  }
  return Object.keys(patch).length ? patch : undefined;
}

function normalizeBlockAt(value: unknown): BlockInstance['at'] {
  const record = plainRecord(value);
  if (!record) return undefined;
  const at: NonNullable<BlockInstance['at']> = {};
  for (const device of ['tablet', 'mobile'] as const) {
    const patch = normalizeDisplayOverride(record[device]);
    if (patch) at[device] = patch;
  }
  return Object.keys(at).length ? at : undefined;
}

function normalizeBlockVisibility(value: unknown): BlockVisibility | undefined {
  const record = plainRecord(value);
  if (!record) return undefined;
  const visibility: BlockVisibility = {};
  if (Array.isArray(record.devices)) {
    const devices = record.devices.filter(
      (item): item is BuilderDevice => item === 'desktop' || item === 'tablet' || item === 'mobile',
    );
    if (devices.length) visibility.devices = devices;
  }
  if (Array.isArray(record.roles)) {
    const roles = record.roles.filter(
      (item): item is 'guest' | 'member' | 'admin' =>
        item === 'guest' || item === 'member' || item === 'admin',
    );
    if (roles.length) visibility.roles = roles;
  }
  if (typeof record.from === 'string' && record.from) visibility.from = record.from.slice(0, 40);
  if (typeof record.to === 'string' && record.to) visibility.to = record.to.slice(0, 40);
  return Object.keys(visibility).length ? visibility : undefined;
}

/**
 * v2 展示层字段的读入清洗。
 *
 * 迁移把各设备不同的展示设置折算进 `at`；归一化如果把它们丢掉，用户读一次再
 * 保存就永久失去了手机 / 平板上的外观差异。渲染在 P0 还不用这些字段，但必须留住。
 */
function blockDisplayFields(raw: Partial<BlockInstance>): Partial<BlockInstance> {
  const at = normalizeBlockAt(raw.at);
  const visible = normalizeBlockVisibility(raw.visible);
  const span = normalizeBlockSpan(raw.span);
  // offset 是「从第几栏起」，0 合法、上限 11，不能借用 span 的 1–12 夹取。
  const offset = normalizeBlockOffset(raw.offset);
  const anchor = typeof raw.anchor === 'string' && raw.anchor ? raw.anchor.slice(0, 120) : undefined;
  return {
    ...(at ? { at } : {}),
    ...(visible ? { visible } : {}),
    ...(anchor ? { anchor } : {}),
    ...(span ? { span } : {}),
    ...(offset ? { offset } : {}),
  };
}

/**
 * 一个 repeater 条目：按 itemSchema 逐字段白名单清洗，返回 null 表示这一条是坏数据。
 *
 * 条目里缺的字段补成该类型的空值（文本 / 选项 → `''`，开关 → `false`）：旧 itemlist
 * 的 JSON 往往只写了填过的那几个字段，不补齐的话同一个条目在两次读入后形状不同，
 * 表单与导出都会抖动。数字缺省时保持缺省——0 是个有意义的数值，不该替用户编出来。
 */
function normalizePropRecord(value: unknown, schema: PropSchema[]): BlockPropRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  const out: BlockPropRecord = {};
  for (const field of schema) {
    if (field.type === 'repeater') continue; // 只允许一层
    const scalar = scalarValue(source[field.key]);
    if (scalar !== undefined) {
      out[field.key] = scalar;
    } else if (field.type === 'toggle') {
      out[field.key] = false;
    } else if (field.type !== 'number') {
      out[field.key] = '';
    }
  }
  return out;
}

/**
 * 读一个 repeater 值。
 *
 * 兼容两种来源：新配置（真正的数组）与旧 itemlist 配置（JSON 字符串）。
 * 数组（含空数组）原样返回：新配置里 `[]` 是「新建区块的默认内容」，
 * 归一化把它删掉会让同一份 props 读一次就少一个键，读写不再幂等。
 * 只有「根本不是列表」的坏数据（非数组、JSON 解析失败）才返回 undefined。
 */
function normalizeRepeaterValue(
  value: unknown,
  schema: PropSchema,
): BlockPropRecord[] | undefined {
  const fields = schema.itemSchema ?? [];
  const max = schema.maxItems ?? 30;
  let list: unknown[] | null = null;
  if (Array.isArray(value)) {
    list = value;
  } else if (typeof value === 'string' && value) {
    // 旧配置：itemlist 存的就是 JSON 字符串。
    try {
      const parsed = JSON.parse(value) as unknown;
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      list = null;
    }
  }
  if (!list) return undefined;
  return list
    .slice(0, max)
    .map((item) => normalizePropRecord(item, fields))
    .filter((item): item is BlockPropRecord => !!item);
}

/**
 * 文字绑定键（`bind:title`）的保留。
 *
 * 「显示什么数据」把绑定关系直接存在 `props['bind:' + key]` 里（见 lib/blocksData.ts），
 * 而这些键不是任何 schema 字段。纯按 schema 清洗会把它们整批丢掉——用户选一次数据源、
 * 保存、再读一次，绑定就没了。所以这里按前缀单独收一遍，值仍然过同一套标量清洗。
 */
const BIND_KEY_PREFIX = 'bind:';
/** 写进 props 的绑定键不能污染原型；与 blocksData.ts 的 UNSAFE_KEYS 同一份名单。 */
const UNSAFE_BIND_TARGETS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * 一个 `bind:` 键的保留值；null 表示这个键不是可保留的绑定。
 *
 * 值仍然过同一套标量清洗与长度限制，避免绑定键成为绕过清洗的入口。
 */
function boundScalar(key: string, value: unknown): string | null {
  if (!key.startsWith(BIND_KEY_PREFIX) || key.length > 120) return null;
  const target = key.slice(BIND_KEY_PREFIX.length);
  if (!target || UNSAFE_BIND_TARGETS.has(target)) return null;
  const scalar = scalarValue(value);
  return typeof scalar === 'string' && scalar ? scalar.slice(0, 80) : null;
}

/** 站内路径与 http(s) 地址的长度上限。 */
const MAX_MEDIA_URL_CHARS = 2048;
/**
 * 内联图片（base64 data URL）的长度上限。
 *
 * 演示后端的上传把文件读成 data URL（`lib/demo.ts`），所以这类值必须放行，否则
 * 演示模式的媒体库选择器挑完图就等于没挑。但整份设计只有 1 MiB 预算，所以只收
 * base64 的 `data:image/*`，且单张限制在 64 K 字符（约 48 KB 图片），超出一律拒绝。
 */
export const MAX_INLINE_MEDIA_CHARS = 65_536;

/**
 * 媒体地址白名单。
 *
 * 只接受站内媒体端点、http(s) 绝对地址、/ 开头的站内路径，以及限长的内联图片：
 * - `//host/x.png` 是协议相对地址，`/` 开头的判断会漏掉它，但它指向别的站点，
 *   必须挡掉（与 `lib/safeUrl.ts` 同一条规则，两层的判定要收敛）。
 * - `data:` 只放行 `data:image/…;base64,…` 且总长受限；`data:text/…`、非 base64
 *   的 SVG、超大图片与 `javascript:` 一律拒绝。
 */
export function normalizeMediaUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const url = value.trim();
  if (!url) return undefined;
  if (url.startsWith('data:')) {
    if (!url.startsWith('data:image/') || !url.includes(';base64,')) return undefined;
    return url.length <= MAX_INLINE_MEDIA_CHARS ? url : undefined;
  }
  if (url.length > MAX_MEDIA_URL_CHARS) return undefined;
  if (/^https?:\/\//i.test(url)) return url.slice(0, MAX_MEDIA_URL_CHARS);
  // 站内绝对路径：`//` 开头的是协议相对地址，会跳出当前站点。
  if (url.startsWith('/') && !url.startsWith('//')) return url.slice(0, MAX_MEDIA_URL_CHARS);
  return undefined;
}

/* ---------- 体积预算（规格 §4.5） ---------- */

/** 单个区块 props 的序列化上限。 */
export const PROPS_MAX_BYTES = 8192;
/** 整份设计的软警告线（硬上限是服务端的 1 MiB）。 */
export const DESIGN_SOFT_LIMIT_BYTES = 524288;
/** 封面内联图上限；再大就是首屏负担。 */
export const COVER_DATA_URL_MAX = 65536;

function byteLength(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? '').length;
  } catch {
    return 0;
  }
}

/** 估算一份设计的体积，并判断是否越过软警告线。 */
export function designVolumeReport(customization: unknown): { bytes: number; soft: boolean } {
  const bytes = byteLength(customization);
  return { bytes, soft: bytes > DESIGN_SOFT_LIMIT_BYTES };
}

/**
 * 单个区块 props 的体积裁剪：超过 `PROPS_MAX_BYTES` 的键整条丢弃。
 *
 * 服务端的硬上限是整份文档 1 MiB，单块撑爆预算会让后面所有区块都存不进去；这里的
 * 归一点是编辑器，归一化丢一个超大的键比丢掉整份设计可接受。不做值截断：半个 JSON、
 * 半张图都是坏数据，宁可让用户重填。
 */
function capPropBytes(out: BlockProps): BlockProps {
  const capped: BlockProps = {};
  for (const [key, item] of Object.entries(out)) {
    if (byteLength({ [key]: item }) > PROPS_MAX_BYTES) continue;
    capped[key] = item;
  }
  return capped;
}

/**
 * 按注册表 schema 递归白名单清洗属性。
 *
 * 未在 schema 里声明的键一律丢弃——服务端只存不解释，白名单只能在前端这一层做。
 * 不认识的区块类型退化成「只保留标量」，保证从更新版本导入的配置不会丢内容。
 *
 * 输出按「写入时的键顺序」排列，而不是 schema 顺序：blocks.ts 里 defaults 的字面量
 * 顺序与 schema 顺序并不总是一致（bento-hero、spotlight、stats 都是如此），按 schema
 * 重排会让新建区块在读完一次后形状变化。归一化只该删键、清洗值，不该搬动键位。
 */
export function normalizeBlockProps(type: string, value: unknown): BlockProps {
  const def = blockDef(type);
  const source = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  if (!def) {
    const out: BlockProps = {};
    for (const [key, item] of Object.entries(source)) {
      const scalar = scalarValue(item);
      if (scalar !== undefined) out[key] = scalar;
    }
    return capPropBytes(out);
  }
  const fields = new Map(def.schema.map((field) => [field.key, field]));
  const out: BlockProps = {};
  for (const [key, item] of Object.entries(source)) {
    const field = fields.get(key);
    if (!field) {
      const bound = boundScalar(key, item);
      if (bound !== null) out[key] = bound;
      continue;
    }
    if (field.type === 'repeater') {
      const list = normalizeRepeaterValue(item, field);
      if (list) out[key] = list;
      continue;
    }
    if (field.type === 'media') {
      // 空值是新建区块的默认状态：保留成空串，否则读一次就少一个键。
      if (typeof item === 'string' && !item.trim()) {
        out[key] = '';
        continue;
      }
      const media = normalizeMediaUrl(item);
      if (media) out[key] = media;
      continue;
    }
    if (field.type === 'richtext') {
      // Markdown 原文原样存：清洗发生在渲染时（renderMarkdown + sanitizeHtml），
      // 归一化只要截断，不该改写内容。
      const rich = richtextValue(item);
      if (rich !== undefined) out[key] = rich;
      continue;
    }
    const scalar = scalarValue(item);
    if (scalar !== undefined) out[key] = scalar;
  }
  return capPropBytes(out);
}

/** 读 repeater 值；坏数据一律返回空数组，渲染器不需要防御。 */
export function blockPropRecord(block: Pick<BlockInstance, 'props'>, key: string): BlockPropRecord[] {
  const value = block.props[key];
  return Array.isArray(value) ? value : [];
}

function normalizeBlock(
  value: unknown,
  depth = 0,
  seen: Set<string> = new Set(),
  budget: { count: number } = { count: 0 },
): BlockInstance | null {
  if (!value || typeof value !== 'object' || depth > MAX_BLOCK_DEPTH) return null;
  if (budget.count >= MAX_BLOCKS) return null;
  const raw = value as Partial<BlockInstance>;
  if (typeof raw.type !== 'string' || !raw.type) return null;
  budget.count += 1;
  const known = BLOCK_TYPES.has(raw.type);

  const props = normalizeBlockProps(raw.type, raw.props);

  let id = typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 80) : nextBlockId();
  if (seen.has(id)) id = nextBlockId();
  seen.add(id);

  const children = Array.isArray(raw.children)
    ? raw.children
        .slice(0, MAX_CHILDREN_PER_CONTAINER)
        .map((child) => normalizeBlock(child, depth + 1, seen, budget))
        .filter((child): child is BlockInstance => !!child)
    : [];

  const area = raw.area === 'full' || raw.area === 'main' || raw.area === 'side' ? raw.area : undefined;
  const appearance = normalizeBlockAppearance(raw.appearance);
  if (!known) {
    // 不认识的类型：保留形状，不解释 props，渲染器会跳过它。props 走和已知类型
    // 同一套清洗，位置与样式也一并保留，这样新版本的设计存回去不会丢东西。
    const unsupportedProps: Record<string, string | number | boolean> = {};
    for (const [key, item] of Object.entries(raw.props ?? {})) {
      const value = scalarValue(item);
      if (value !== undefined) unsupportedProps[key] = value;
    }
    return {
      id,
      type: raw.type.slice(0, 64),
      title: text(raw.title, '', 80) || raw.type.slice(0, 64),
      // 未知类型同样过单块体积预算：否则一条陌生类型的区块就是绕过上限的走私通道。
      props: capPropBytes(unsupportedProps),
      animation: animation(raw.animation),
      hidden: bool(raw.hidden, false),
      unsupported: true,
      ...(area ? { area } : {}),
      ...(children.length ? { children } : {}),
      ...(typeof raw.column === 'number' ? { column: clampColumn(raw.column) } : {}),
      ...(typeof raw.width === 'number' && raw.width > 0
        ? { width: Math.min(1600, Math.round(raw.width)) }
        : {}),
      ...(typeof raw.height === 'number' && raw.height > 0
        ? { height: Math.min(2400, Math.round(raw.height)) }
        : {}),
      ...(typeof raw.custom_css === 'string' && raw.custom_css
        ? { custom_css: raw.custom_css.slice(0, 4000) }
        : {}),
      ...(appearance ? { appearance } : {}),
      // 不认识类型的区块同样保留 v2 展示层字段：新版本存下来的覆盖不能被旧版本吃掉。
      ...blockDisplayFields(raw),
    };
  }
  return {
    id,
    type: raw.type,
    title: text(raw.title, '', 80) || blockDef(raw.type)?.name || raw.type,
    props,
    animation: animation(raw.animation),
    hidden: bool(raw.hidden, false),
    ...(area ? { area } : {}),
    ...(children.length ? { children } : {}),
    ...(typeof raw.column === 'number' ? { column: clampColumn(raw.column) } : {}),
    ...(typeof raw.width === 'number' && raw.width > 0
      ? { width: Math.min(1600, Math.round(raw.width)) }
      : {}),
    ...(typeof raw.height === 'number' && raw.height > 0
      ? { height: Math.min(2400, Math.round(raw.height)) }
      : {}),
    ...(typeof raw.custom_css === 'string' && raw.custom_css
      ? { custom_css: raw.custom_css.slice(0, 4000) }
      : {}),
    ...(appearance ? { appearance } : {}),
    ...blockDisplayFields(raw),
  };
}

/**
 * 读取路径的区块上限：只用来给恶意/损坏文档兜住内存，不是产品上限。
 *
 * 产品上限 `MAX_BLOCKS` 由 `blockBudgetStatus` 在保存前挡住——读的时候就截断，
 * 会让超限设计被悄悄削掉尾巴，编辑器的「删几个再存」提示也永远不会出现。
 */
export const MAX_READ_BLOCKS = 2000;

function normalizeBlockList(value: unknown): BlockInstance[] {
  const raw = Array.isArray(value) ? value : [];
  const blocks = raw
    .map((block) => normalizeBlock(block))
    .filter((block): block is BlockInstance => !!block);
  if (countBlocks(blocks) <= MAX_READ_BLOCKS) return blocks;

  // 极端配置里根级区块本身很少，但子树可能超限；从尾部逐棵剔除到预算内。
  const trimmed: BlockInstance[] = [];
  let total = 0;
  for (const block of blocks) {
    const size = countBlocks([block]);
    if (total + size > MAX_READ_BLOCKS) continue;
    trimmed.push(block);
    total += size;
  }
  return trimmed;
}

/**
 * 读取路径上的一次性折算：像素宽（`width`）→ 栅格占位（`span`）。
 *
 * 这是 P1 §5.1 定下的「一次性迁移」：只在读入时折，不在保存时折，两套宽度语义
 * 不会长期并存。折算一律在 `normalizeBlockList` 之后、`at` 分档覆盖之外进行：
 * 归一化看到的是原始树，`at.tablet` / `at.mobile` 里的大小覆盖是用户按设备分档
 * 定的，不能被一次折算吃掉（否则手机上的差异读一次就永久丢失）。
 *
 * 容器宽按 1200 估算（常规内容宽），只影响折算出的档位，不影响渲染的真实宽度。
 */
const MIGRATE_CONTAINER_WIDTH = 1200;

export function normalizeScreenLayout(value: unknown): ScreenLayout {
  const raw = value as ScreenLayout | undefined;
  const blocks = migrateWidthsToSpan(normalizeBlockList(raw?.blocks), MIGRATE_CONTAINER_WIDTH);
  if (!raw?.device_split || !raw.devices || typeof raw.devices !== 'object') {
    return { blocks };
  }
  const devices: NonNullable<ScreenLayout['devices']> = {};
  for (const device of ['desktop', 'tablet', 'mobile'] as const) {
    const entry = raw.devices[device];
    if (!entry || !Array.isArray(entry.blocks)) continue;
    devices[device] = {
      blocks: migrateWidthsToSpan(normalizeBlockList(entry.blocks), MIGRATE_CONTAINER_WIDTH),
    };
  }
  return { blocks, device_split: true, devices };
}

/** 编排的区块总量；编辑器保存前用它挡住超限，而不是让归一化静默截断。 */
export function blockBudgetStatus(layout: ScreenLayout): {
  total: number;
  limit: number;
  over: boolean;
} {
  const perDevice = Object.values(layout.devices ?? {}).map((entry) =>
    countBlocks((entry as { blocks: BlockInstance[] }).blocks),
  );
  const total = Math.max(countBlocks(layout.blocks), 0, ...perDevice);
  return { total, limit: MAX_BLOCKS, over: total > MAX_BLOCKS };
}

const STEP_KINDS = new Set(['trigger', 'condition', 'action']);

function normalizeStep(value: unknown): LogicStep | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<LogicStep>;
  if (!raw.kind || !STEP_KINDS.has(raw.kind) || typeof raw.type !== 'string') return null;
  const config: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(raw.config ?? {})) {
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      config[key] =
        typeof item === 'number'
          ? Math.min(1e6, Math.max(-1e6, item))
          : typeof item === 'boolean'
            ? item
            : String(item).slice(0, 4000);
    }
  }
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 80) : nextBlockId('stp'),
    kind: raw.kind,
    type: raw.type.slice(0, 60),
    config,
  };
}

function normalizeChain(value: unknown): LogicChain | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<LogicChain>;
  if (typeof raw.name !== 'string') return null;
  const steps = Array.isArray(raw.steps)
    ? raw.steps.map(normalizeStep).filter((s): s is LogicStep => !!s)
    : [];
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 80) : nextBlockId('chn'),
    name: raw.name.slice(0, 80),
    enabled: bool(raw.enabled, true),
    steps: steps.slice(0, 12),
  };
}

function normalizeTerm(value: unknown, fallbackIdPrefix: string): TaxonomyTerm | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<TaxonomyTerm>;
  const name = text(raw.name, '', 40).trim();
  if (!name) return null;
  return {
    id: typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 80) : `${fallbackIdPrefix}_${Date.now().toString(36)}`,
    name,
    slug: normalizePageSlug(text(raw.slug, name, 60)) || normalizePageSlug(name) || `term-${Date.now().toString(36)}`,
    description: text(raw.description, '', 160),
    ...(raw.color && /^#[0-9a-fA-F]{3,8}$/.test(raw.color) ? { color: raw.color } : {}),
  };
}

function normalizeTaxonomy(value: unknown): TaxonomySettings {
  const raw = (value ?? {}) as Partial<TaxonomySettings>;
  const categories = Array.isArray(raw.categories)
    ? raw.categories.map((item) => normalizeTerm(item, 'cat')).filter((item): item is TaxonomyTerm => !!item).slice(0, 40)
    : DEFAULT_TAXONOMY.categories;
  const tags = Array.isArray(raw.tags)
    ? raw.tags.map((item) => normalizeTerm(item, 'tag')).filter((item): item is TaxonomyTerm => !!item).slice(0, 80)
    : DEFAULT_TAXONOMY.tags;
  return { categories, tags };
}

const VERIFICATION_PROVIDERS: HumanVerificationProvider[] = ['turnstile', 'hcaptcha', 'recaptcha'];

/** 页头样式枚举；未知值回退经典吸顶。 */
const HEADER_STYLES: HeaderStyle[] = ['classic', 'transparent', 'float'];

function normalizeHeaderStyle(value: unknown): HeaderStyle {
  return HEADER_STYLES.find((style) => style === value) ?? 'classic';
}

/** 夜航文章卡外观枚举；未知值回退到原有外观。 */
const ARTICLE_CARD_STYLES: ArticleCardStyle[] = ['cover', 'blur'];

function normalizeArticleCardStyle(value: unknown): ArticleCardStyle {
  return ARTICLE_CARD_STYLES.find((style) => style === value) ?? 'cover';
}

/** 数字字段收敛：非法值回退默认，小数取整，超出范围夹紧。 */
function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function normalizeVerificationProvider(value: unknown): HumanVerificationProvider {
  return typeof value === 'string' && (VERIFICATION_PROVIDERS as string[]).includes(value)
    ? (value as HumanVerificationProvider)
    : DEFAULT_VERIFICATION.provider;
}

/** 把任意（可能是旧版本或导入的）配置收敛成可用的结构。 */
export function readCustomization(config: Pick<WebConfig, 'customization'>): SiteCustomization {
  if (!config.customization) return DEFAULT_CUSTOMIZATION;
  // 只改读取路径：v1 的三棵树在这里折算成 v2 的展示层覆盖，保存路径仍然写原始对象，
  // 迁移结果在下一次保存（或 customizationSync 的本地缓存写回）时自然落盘。
  // 折算现在安全了：渲染层已经求值 at（见 ScreenRenderer 的 applyDisplayOverrides），
  // 折叠掉的手机/平板布局会以 at 覆盖的形式继续生效。
  const migrated = migrateCustomization(config.customization, { foldDevices: true });
  // 规格 §5.1：折算改写了作者的版面，得让作者知道。报告只交给模块内存（见
  // lib/migrationNotice.ts），由后台界面取走做一次性提示。访客的引导流程也会走到
  // 这里，所以这里绝不能碰 localStorage——「已读」只由后台界面记录。
  publishMigrationReport(migrated.report);
  const raw = migrated.value as Partial<SiteCustomization>;
  const rawTheme = normalizeThemeSettings(raw.theme);
  // 白昼主题在 2026-11 被合并进夜航：旧配置里的 daylight 预设按同一模式
  // 折算成夜航的冷白 / 冷石墨令牌，避免已选过白昼的站点读到不存在的预设。
  const theme =
    rawTheme.preset === 'daylight'
      ? { ...rawTheme, preset: 'night' }
      : rawTheme;
  const layout = raw.layout ?? DEFAULT_LAYOUT;
  const variant = normalizeVariant(layout.variant);
  const extensions = raw.extensions ?? DEFAULT_EXTENSIONS;
  let home = normalizeScreenLayout(raw.home);
  /**
   * 显式保存的首页编排（包括 `blocks: []`）必须原样尊重。
   *
   * 旧逻辑把「空编排」当成「从没配置过」而回退默认首页：站长在编排台里删光区块、
   * 保存，下一次读取又会把默认区块长回来，看起来像「真正的编排内容改不掉」。只有
   * 从没写过 `home` 的旧配置才用默认版面兜底。
   */
  const homeProvided =
    !!raw.home &&
    typeof raw.home === 'object' &&
    Array.isArray((raw.home as ScreenLayout).blocks);
  // 旧版白昼默认首页复用了夜航区块；升级后只在拓扑和属性都没被改过时
  // 自动换成新的白昼头版，站长自己的编排保持原样。
  if (variant === 'daylight' && isLegacyDaylightHome(home)) {
    home = defaultHomeLayout('daylight');
  }
  const article = normalizeScreenLayout(raw.article);
  // 旧配置没有备案开关时按“已填写就显示”处理，避免已有备案信息突然消失。
  const icp = text(layout.icp, '', 80);
  const police = text(layout.police, '', 80);
  const filingFilled = !!(icp.trim() || police.trim());
  const chains = Array.isArray(raw.logic?.chains)
    ? raw.logic.chains.map(normalizeChain).filter((c): c is LogicChain => !!c)
    : [];
  const themes: SiteTheme[] = [];
  if (Array.isArray(raw.themes)) {
    for (const item of raw.themes) {
      const normalized = normalizeCustomTheme(item);
      if (!normalized || themes.some((entry) => entry.id === normalized.id)) continue;
      themes.push(normalized);
      if (themes.length >= 20) break;
    }
  }
  const requestedTheme = text(raw.active_theme, '', 80);
  const activeTheme =
    requestedTheme &&
    (BUILTIN_THEME_IDS.has(requestedTheme) || themes.some((item) => item.id === requestedTheme))
      ? requestedTheme
      : inferActiveTheme(theme, variant, themes);
  return {
    // 结构版本随读入结果一起返回：它就是让迁移器下次读取直接返回、不再重跑的印记。
    schema_version: CURRENT_SCHEMA_VERSION,
    // 站点语言：未知值（旧配置、手改 JSON、导入的主题包）一律回退简体中文。
    language: normalizeLocale(raw.language),
    theme,
    active_theme: activeTheme,
    themes,
    layout: {
      brand_sub: text(layout.brand_sub, DEFAULT_LAYOUT.brand_sub, 60),
      show_articles: bool(layout.show_articles, true),
      show_posts: bool(layout.show_posts, true),
      show_search: bool(layout.show_search, true),
      header_style: normalizeHeaderStyle(layout.header_style),
      header_blur: bool(layout.header_blur, true),
      header_blur_amount: clampNumber(layout.header_blur_amount, 4, 24, 10),
      header_threshold: clampNumber(layout.header_threshold, 0, 240, 8),
      article_card_style: normalizeArticleCardStyle(layout.article_card_style),
      footer_text: text(layout.footer_text, '', 200),
      footer_brand_name: text(layout.footer_brand_name, '', 60),
      footer_brand_sub: text(layout.footer_brand_sub, '', 60),
      footer_brand_desc: text(layout.footer_brand_desc, '', 300),
      footer_show_tags: bool(layout.footer_show_tags, true),
      footer_tags: text(layout.footer_tags, '', 120),
      footer_note: text(layout.footer_note, DEFAULT_LAYOUT.footer_note, 80),
      nav_tabs: normalizeNavTabs(layout.nav_tabs),
      nav_align:
        layout.nav_align === 'center' || layout.nav_align === 'right'
          ? layout.nav_align
          : 'left',
      nav_icon_position:
        layout.nav_icon_position === 'right' || layout.nav_icon_position === 'none'
          ? layout.nav_icon_position
          : 'left',
      nav_sub_style: layout.nav_sub_style === 'dropdown' ? 'dropdown' : 'bar',
      nav_sub_show_icons: bool(layout.nav_sub_show_icons, true),
      social_links: normalizeSocialLinks(layout.social_links),
      footer_columns: normalizeFooterColumns(layout.footer_columns),
      icp,
      police,
      police_icon: text(layout.police_icon, '', 500),
      show_filing: bool(layout.show_filing, filingFilled),
      site_icon: text(layout.site_icon, '', 500),
      announcement: text(layout.announcement, '', 240),
      announcement_link: text(layout.announcement_link, '', 300),
      hero: {
        kicker: text(layout.hero?.kicker, '', 80),
        title: text(layout.hero?.title, DEFAULT_HERO.title, 200),
        lede: text(layout.hero?.lede, '', 300),
      },
      variant,
    },
    home: homeProvided ? home : defaultHomeLayout(variant),
    article,
    pages: Array.isArray(raw.pages) ? raw.pages.filter(isPageLike).map(normalizePage) : [],
    pins: normalizePins(raw.pins),
    covers: normalizeCovers(raw.covers),
    extensions: {
      reading_progress: bool(extensions.reading_progress, true),
      toc: bool(extensions.toc, true),
      code_copy: bool(extensions.code_copy, true),
      share: bool(extensions.share, false),
      announcement: bool(extensions.announcement, false),
      back_to_top: bool(extensions.back_to_top, true),
    },
    custom_extensions: normalizeCustomExtensions(raw.custom_extensions),
    logic: { chains: chains.slice(0, 20) },
    comments: {
      enabled: bool(raw.comments?.enabled, DEFAULT_COMMENT_SETTINGS.enabled),
      require_review: bool(raw.comments?.require_review, DEFAULT_COMMENT_SETTINGS.require_review),
      notice: text(raw.comments?.notice, '', 400),
    },
    verification: {
      enabled: bool(raw.verification?.enabled, DEFAULT_VERIFICATION.enabled),
      provider: normalizeVerificationProvider(raw.verification?.provider),
      site_key: text(raw.verification?.site_key, '', 200),
      recaptcha_version: raw.verification?.recaptcha_version === 'v3' ? 'v3' : 'v2',
      on_login: bool(raw.verification?.on_login, DEFAULT_VERIFICATION.on_login),
      on_register: bool(raw.verification?.on_register, DEFAULT_VERIFICATION.on_register),
      on_comment: bool(raw.verification?.on_comment, DEFAULT_VERIFICATION.on_comment),
      on_password_reset: bool(
        raw.verification?.on_password_reset,
        DEFAULT_VERIFICATION.on_password_reset,
      ),
    },
    taxonomy: normalizeTaxonomy(raw.taxonomy),
    permissions: normalizePermissions(raw.permissions),
    // The capability groups are the source of truth when the server exposes them;
    // this mirror keeps names and the matrix available offline and in demo mode.
    permission_groups: normalizePermissionGroupConfigs(
      raw.permission_groups ?? raw.permissions,
    ),
    seo: {
      title_template: text(raw.seo?.title_template, DEFAULT_SEO.title_template, 120) || DEFAULT_SEO.title_template,
      default_description: text(raw.seo?.default_description, '', 300),
      keywords: text(raw.seo?.keywords, '', 300),
      share_image: text(raw.seo?.share_image, '', 500),
      twitter: text(raw.seo?.twitter, '', 60),
      indexable: bool(raw.seo?.indexable, DEFAULT_SEO.indexable),
      canonical_base: text(raw.seo?.canonical_base, '', 300).replace(/\/+$/, ''),
      publisher: text(raw.seo?.publisher, '', 120),
      verification: {
        google: text(raw.seo?.verification?.google, '', 120),
        baidu: text(raw.seo?.verification?.baidu, '', 120),
        bing: text(raw.seo?.verification?.bing, '', 120),
      },
    },
    feed: {
      enabled: bool(raw.feed?.enabled, DEFAULT_FEED.enabled),
      full_text: bool(raw.feed?.full_text, DEFAULT_FEED.full_text),
      limit: clampNumber(raw.feed?.limit, 1, 100, DEFAULT_FEED.limit),
      include_taxonomy: bool(raw.feed?.include_taxonomy, DEFAULT_FEED.include_taxonomy),
    },
    // 自定义 CSS 是唯一会原样进入全站 <style> 的字段：读入时就把高危规则剔掉，
    // 保证随后写回服务端的副本、导出文件与渲染都走同一份干净内容。
    custom_css: sanitizeCustomCss(raw.custom_css),
  };
}

function isPageLike(value: unknown): value is SitePage {
  if (!value || typeof value !== 'object') return false;
  const page = value as Partial<SitePage>;
  return typeof page.id === 'string' && typeof page.title === 'string' && typeof page.slug === 'string';
}

/** 把一段 Markdown 包成页面编排里的「文本」区块（旧正文迁移与新站点示例页共用）。 */
function pageTextBlock(markdown: string, title = '') {
  const block = createBlock('text');
  block.title = title || '正文';
  block.props = { ...block.props, eyebrow: '', title: '', body: markdown };
  return block;
}

function normalizePage(page: SitePage): SitePage {
  const layout = page.layout ? normalizeScreenLayout(page.layout) : undefined;
  const legacyBody = text(page.body, '', 50000).trim();
  // 页面内容现在统一由「页面编排」的区块承载。旧版页面只有 Markdown 正文，
  // 首次读取时把它搬进一个「文本」区块，之后前台不再单独渲染 body。
  const migrated =
    layout && layout.blocks.length
      ? layout
      : legacyBody
        ? { blocks: [pageTextBlock(legacyBody)] }
        : layout;
  return {
    id: page.id,
    title: text(page.title, t('未命名页面'), 160),
    slug: normalizePageSlug(page.slug),
    summary: text(page.summary, '', 400),
    body: '',
    status: page.status === 'draft' ? 'draft' : 'published',
    show_in_nav: bool(page.show_in_nav, false),
    created_at: text(page.created_at, new Date().toISOString(), 40),
    updated_at: text(page.updated_at, new Date().toISOString(), 40),
    template: typeof page.template === 'string' ? page.template.slice(0, 60) : undefined,
    layout: migrated,
  };
}

/** 生成站点主题的 CSS 变量（见 lib/theme.ts）。 */
export function useCustomization(): {
  customization: SiteCustomization;
  update: (patch: Partial<SiteCustomization>) => void;
} {
  const { config, updateConfig } = useAuth();
  const customization = useMemo(() => readCustomization(config), [config]);
  const update = useCallback(
    (patch: Partial<SiteCustomization>) => {
      updateConfig({ customization: { ...readCustomization(config), ...patch } });
    },
    [config, updateConfig],
  );
  return { customization, update };
}

export const RESERVED_SLUGS = new Set([
  'admin',
  'setup',
  'articles',
  'posts',
  'search',
  'login',
  'register',
  'messages',
  'notifications',
  'a',
  'p',
  'u',
  'api',
  'healthz',
  'readyz',
  'openapi.json',
  'favicon.ico',
]);

export function normalizePageSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

export function pageSlugError(slug: string, pages: SitePage[], currentId?: string): string {
  if (!slug) return t('页面路径不能为空。');
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return t('路径只能包含小写字母、数字与连字符。');
  if (RESERVED_SLUGS.has(slug)) return t('这个路径被系统路由占用，请换一个。');
  if (pages.some((page) => page.slug === slug && page.id !== currentId)) return t('已经有页面使用这个路径。');
  return '';
}

/**
 * 当前明暗模式与切换函数。页头按钮、Shift+D、阅读工具栏与思维链动作共用。
 *
 * 返回值是「这台浏览器实际看到的模式」：Cookie 里有偏好就用偏好，否则跟随
 * 站点默认。切换只写 Cookie，不写站点配置，访客不会改掉站长的主题。
 */
export function useThemeMode(): { mode: ThemeMode; toggle: () => void } {
  const { customization } = useCustomization();
  const preference = useThemePreference();
  const mode = preference ?? customization.theme.mode;
  const toggle = useCallback(() => {
    const next: ThemeMode = mode === 'dark' ? 'light' : 'dark';
    runThemeTransition(() => setThemePreference(next));
  }, [mode]);
  return { mode, toggle };
}

/** 把首屏标题拆成“行 → 片段”，*文字* 作为强调片段（实现见 lib/heroText.ts）。 */
export { heroLines, type HeroSegment } from './heroText';

export function navPages(customization: SiteCustomization): SitePage[] {
  return customization.pages
    .filter((page) => page.status === 'published' && page.show_in_nav)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .slice(0, 3);
}

/**
 * 页面的可搜索文本。
 *
 * 页面正文现在只存在于编排区块里，所以搜索要把区块的标题与文字属性一起收进来，
 * 不能只读旧的 `body` 字段。
 */
export function pageSearchText(page: SitePage): string {
  const parts: string[] = [page.title, page.summary ?? ''];
  const walk = (blocks: NonNullable<SitePage['layout']>['blocks']) => {
    for (const block of blocks) {
      parts.push(block.title);
      for (const value of Object.values(block.props)) {
        if (typeof value === 'string') parts.push(value);
      }
      if (block.children?.length) walk(block.children);
    }
  };
  if (page.layout?.blocks.length) walk(page.layout.blocks);
  return parts.join(' ');
}

export function starterPages(): SitePage[] {
  const now = new Date().toISOString();
  return [
    {
      id: 'page_about',
      title: '关于本站',
      slug: 'about',
      summary: '这间房子是谁的，为什么在这里写作。',
      body: '',
      status: 'published',
      show_in_nav: true,
      created_at: now,
      updated_at: now,
      template: 'about',
      layout: {
        blocks: [
          pageTextBlock(
            [
              '## 关于这间房子',
              '',
              '这是一个独立站点：内容自己保存，稿子属于作者，读者被当作邻居。',
              '',
              '这段文字是安装时生成的示例页面，可以在「管理后台 → 页面编排」里改写、换路径，或者删除。',
              '',
              '## 你可以在这里放什么',
              '',
              '- 关于你或编辑部的介绍',
              '- 投稿说明与版权声明',
              '- 订阅方式、联系方式与友情链接',
            ].join('\n'),
            '关于这间房子',
          ),
          createBlock('author-card'),
          createBlock('timeline'),
          createBlock('tag-cloud'),
        ],
      },
    },
    {
      id: 'page_contact',
      title: '订阅与联络',
      slug: 'contact',
      summary: '怎样收到新文章，怎样找到我们。',
      body: '',
      status: 'published',
      show_in_nav: false,
      created_at: now,
      updated_at: now,
      template: 'links',
      layout: {
        blocks: [
          pageTextBlock(
            [
              '## 订阅',
              '',
              '把本站加入阅读器，或者关注站点公布的其他订阅方式。',
              '',
              '## 联络',
              '',
              '合作、投稿与纠错，请写信到站点域名下的邮箱。',
            ].join('\n'),
            '订阅与联络',
          ),
          createBlock('search-launcher'),
        ],
      },
    },
  ];
}

export function createCustomizationWithPages(): SiteCustomization {
  return { ...DEFAULT_CUSTOMIZATION, pages: starterPages() };
}

/**
 * 安装完成后的默认大主题：夜航。
 *
 * 2026-11 起安装向导不再让用户挑主题，新站点统一以「夜航」交付（深色 + 双栏）。
 * 站长之后仍可在后台「主题设置」里换成原版或自定义主题。
 */
export const INSTALL_DEFAULT_THEME_ID = 'night';

/** 首次安装完成时写进站点设计的完整配置：默认大主题 + 安装时选择的语言。 */
export function installCustomization(language: Locale): SiteCustomization {
  const base = createCustomizationWithPages();
  // 取内置主题的完整排版默认值，而不是只套配色：否则安装完成后会被判成自定义主题。
  const bundle = builtinThemeBundle(INSTALL_DEFAULT_THEME_ID);
  if (!bundle) throw new Error(`Built-in theme "${INSTALL_DEFAULT_THEME_ID}" is missing.`);
  return {
    ...base,
    language,
    theme: bundle.theme,
    layout: { ...base.layout, variant: bundle.variant },
    active_theme: bundle.id,
    home: defaultHomeLayout(bundle.variant),
  };
}

/** 导出为 JSON 文件：外观、页面与扩展一并带走。 */
export function downloadCustomization(customization: SiteCustomization, siteName: string): void {
  const payload = {
    version: 1,
    exported_at: new Date().toISOString(),
    site: siteName,
    // 导出也走一遍规范化：手改过的本地配置可能带着还没被读入清洗的样式。
    customization: { ...customization, custom_css: sanitizeCustomCss(customization.custom_css) },
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `practacu-customization-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

/** 读取导入文件；结构不合法时抛出可读的错误。 */
export function parseCustomizationFile(raw: string): SiteCustomization {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(t('文件不是有效的 JSON。'));
  }
  if (!data || typeof data !== 'object') throw new Error(t('文件内容不是一个配置对象。'));
  const record = data as Record<string, unknown>;
  const source = (record.customization ?? record) as Record<string, unknown>;
  if (!source || typeof source !== 'object') throw new Error(t('缺少 customization 字段。'));
  if (
    !source.theme &&
    !source.layout &&
    !source.pages &&
    !source.extensions &&
    !source.covers &&
    !source.custom_extensions
  ) {
    throw new Error(t('文件里没有可识别的外观、页面、封面或扩展配置。'));
  }
  return readCustomization({ customization: source as unknown as SiteCustomization });
}
