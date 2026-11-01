import { useCallback, useMemo } from 'react';
import type {
  ArticleCover,
  BlockAnimation,
  BlockInstance,
  CommentSettings,
  CustomExtension,
  ExtensionId,
  ExtensionPageScope,
  ExtensionPermission,
  ExtensionSlot,
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
  applyMode,
  normalizeThemeSettings,
  themeCss,
  type ThemePreset,
} from './theme';
import {
  BUILTIN_THEME_IDS,
  inferActiveTheme,
  normalizeCustomTheme,
} from './themes';
import { BLOCK_TYPES, blockDef, createBlock, defaultHomeLayout, nextBlockId } from './blocks';
import { MAX_BLOCKS, MAX_BLOCK_DEPTH, clampColumn, countBlocks } from './blockTree';
import {
  defaultFooterColumns,
  normalizeFooterColumns,
  normalizeNavTabs,
  normalizeSocialLinks,
} from './navigation';
import { DEFAULT_PERMISSIONS, normalizePermissions } from './permissions';
import { normalizeLocale } from './i18n/locales';

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
  title: '精彩内容\n*就此展开*。',
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
  footer_text: '',
  // 页脚品牌区与底部说明：留空时回退到站点名称/简介与默认英文副标题。
  footer_brand_name: '',
  footer_brand_sub: '',
  footer_brand_desc: '',
  footer_show_tags: true,
  footer_tags: '',
  footer_note: '前端 v0.1 · React',
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
  on_login: true,
  on_register: true,
  on_comment: false,
};

export const DEFAULT_TAXONOMY: TaxonomySettings = {
  categories: [
    { id: 'cat_writing', name: '写作', slug: 'writing', color: '#2f6b4f', description: '关于写作方法、编辑与出版。' },
    { id: 'cat_design', name: '设计', slug: 'design', color: '#5b6f8c', description: '排版、界面与阅读体验。' },
    { id: 'cat_community', name: '社区', slug: 'community', color: '#8a6a1f', description: '成员、评论与社区规则。' },
    { id: 'cat_product', name: '产品', slug: 'product', color: '#7a5b8c', description: '更新日志与产品说明。' },
  ],
  tags: [
    { id: 'tag_independent', name: '独立出版', slug: 'independent' },
    { id: 'tag_typesetting', name: '排版', slug: 'typesetting' },
    { id: 'tag_community', name: '社区', slug: 'community-life' },
    { id: 'tag_workflow', name: '工作流', slug: 'workflow' },
    { id: 'tag_reading', name: '阅读', slug: 'reading' },
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
/** 演示模式上传的图片以 data URL 存进 localStorage，超过这个长度就拒绝，避免撑爆配额。 */
export const MAX_COVER_DATA_URL_CHARS = 1_200_000;

const COVER_POSITIONS: NonNullable<ArticleCover['position']>[] = ['center', 'top', 'bottom'];

/**
 * 校验封面地址。
 *
 * 只接受 http(s)、站内绝对路径与 base64 图片：`javascript:` / `data:text/html` 一律丢弃。
 * 这里不做截断——data URL 截断会变成坏图，宁可整条拒绝。
 */
export function normalizeCoverUrl(value: unknown): string {
  const url = typeof value === 'string' ? value.trim() : '';
  if (!url || url.length > MAX_COVER_DATA_URL_CHARS + 200) return '';
  if (/^https?:\/\/\S+$/i.test(url)) return url.slice(0, 2000);
  if (/^data:image\/(png|jpe?g|webp|gif|avif);base64,[a-z0-9+/=\s]+$/i.test(url)) {
    return url.length <= MAX_COVER_DATA_URL_CHARS ? url : '';
  }
  // SVG 只作为 <img> 渲染，不进入 DOM，允许 base64 与 percent-encode 两种写法。
  if (/^data:image\/svg\+xml(;[a-z0-9=.+-]+)*(;base64)?,[^"'<>]*$/i.test(url)) {
    return url.length <= MAX_COVER_DATA_URL_CHARS ? url : '';
  }
  if (/^\/(?!\/)\S*$/.test(url)) return url.slice(0, 2000);
  return '';
}

export function coverUrlError(value: string): string {
  const url = value.trim();
  if (!url) return '';
  // 先判长度：超长 data URL 会在 normalizeCoverUrl 里被整条拒绝，不能只给「格式不对」。
  if (url.startsWith('data:') && url.length > MAX_COVER_DATA_URL_CHARS) {
    return '图片太大：演示模式下请选择 600 KB 以内的图片。';
  }
  if (normalizeCoverUrl(url)) return '';
  if (url.startsWith('data:')) return '只支持 png / jpg / webp / gif / svg 图片。';
  return '请填写 http(s) 图片地址、以 / 开头的站内路径，或直接上传图片。';
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
    author: text(raw.author, '', EXTENSION_LIMITS.author).trim() || '未署名',
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
  seo: DEFAULT_SEO,
  taxonomy: DEFAULT_TAXONOMY,
  custom_css: '',
};

export const EXTENSIONS: {
  id: ExtensionId;
  name: string;
  description: string;
  detail: string;
}[] = [
  {
    id: 'reading_progress',
    name: '阅读进度条',
    description: '在文章页顶部显示一条细进度线。',
    detail: '随滚动更新，不写入任何数据。',
  },
  {
    id: 'toc',
    name: '文章目录',
    description: '从文章的二、三级标题自动生成目录。',
    detail: '至少两个标题时才出现，点击跳到对应段落。',
  },
  {
    id: 'code_copy',
    name: '代码块复制',
    description: '给正文里的每个代码块加一个复制按钮。',
    detail: '只处理前端渲染出的代码块，不改变正文内容。',
  },
  {
    id: 'share',
    name: '原生分享',
    description: '在文章底部提供“分享”按钮。',
    detail: '支持 Web Share API 时调用系统分享，否则复制链接。',
  },
  {
    id: 'announcement',
    name: '站点公告条',
    description: '在页头下方显示一条可关闭的公告。',
    detail: '公告内容在“外观 → 导航与品牌”里填写。',
  },
  {
    id: 'back_to_top',
    name: '回到顶部',
    description: '页面滚动较深时出现回到顶部按钮。',
    detail: '只在站点前台出现，不影响管理后台。',
  },
];

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

function normalizeBlock(
  value: unknown,
  depth = 0,
  seen: Set<string> = new Set(),
  budget: { count: number } = { count: 0 },
): BlockInstance | null {
  if (!value || typeof value !== 'object' || depth > MAX_BLOCK_DEPTH) return null;
  if (budget.count >= MAX_BLOCKS) return null;
  const raw = value as Partial<BlockInstance>;
  if (typeof raw.type !== 'string' || !BLOCK_TYPES.has(raw.type)) return null;
  budget.count += 1;

  const props: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(raw.props ?? {})) {
    if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') {
      props[key] =
        typeof item === 'number'
          ? Math.min(1e6, Math.max(-1e6, item))
          : typeof item === 'boolean'
            ? item
            : String(item).slice(0, 4000);
    }
  }

  let id = typeof raw.id === 'string' && raw.id ? raw.id.slice(0, 80) : nextBlockId();
  if (seen.has(id)) id = nextBlockId();
  seen.add(id);

  const children = Array.isArray(raw.children)
    ? raw.children
        .slice(0, 80)
        .map((child) => normalizeBlock(child, depth + 1, seen, budget))
        .filter((child): child is BlockInstance => !!child)
    : [];

  const area = raw.area === 'full' || raw.area === 'main' || raw.area === 'side' ? raw.area : undefined;
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
  };
}

function normalizeBlockList(value: unknown): BlockInstance[] {
  const raw = Array.isArray(value) ? value : [];
  const blocks = raw
    .slice(0, 24)
    .map((block) => normalizeBlock(block))
    .filter((block): block is BlockInstance => !!block);
  if (countBlocks(blocks) <= MAX_BLOCKS) return blocks;

  // 极端配置里根级区块本身很少，但子树可能超限；从尾部逐棵剔除到预算内。
  const trimmed: BlockInstance[] = [];
  let total = 0;
  for (const block of blocks) {
    const size = countBlocks([block]);
    if (total + size > MAX_BLOCKS) continue;
    trimmed.push(block);
    total += size;
  }
  return trimmed;
}

function normalizeLayout(value: unknown): ScreenLayout {
  const raw = value as ScreenLayout | undefined;
  const blocks = normalizeBlockList(raw?.blocks);
  if (!raw?.device_split || !raw.devices || typeof raw.devices !== 'object') {
    return { blocks };
  }
  const devices: NonNullable<ScreenLayout['devices']> = {};
  for (const device of ['desktop', 'tablet', 'mobile'] as const) {
    const entry = raw.devices[device];
    if (!entry || !Array.isArray(entry.blocks)) continue;
    devices[device] = { blocks: normalizeBlockList(entry.blocks) };
  }
  return { blocks, device_split: true, devices };
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
  const raw = config.customization;
  if (!raw) return DEFAULT_CUSTOMIZATION;
  const theme = normalizeThemeSettings(raw.theme);
  const layout = raw.layout ?? DEFAULT_LAYOUT;
  const variant = layout.variant === 'bento' ? 'bento' : 'classic';
  const extensions = raw.extensions ?? DEFAULT_EXTENSIONS;
  const home = normalizeLayout(raw.home);
  const article = normalizeLayout(raw.article);
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
      variant: layout.variant === 'bento' ? 'bento' : 'classic',
    },
    home: home.blocks.length ? home : defaultHomeLayout(variant),
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
      on_login: bool(raw.verification?.on_login, DEFAULT_VERIFICATION.on_login),
      on_register: bool(raw.verification?.on_register, DEFAULT_VERIFICATION.on_register),
      on_comment: bool(raw.verification?.on_comment, DEFAULT_VERIFICATION.on_comment),
    },
    taxonomy: normalizeTaxonomy(raw.taxonomy),
    permissions: normalizePermissions(raw.permissions),
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
    custom_css: text(raw.custom_css, '', 20000),
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
  const layout = page.layout ? normalizeLayout(page.layout) : undefined;
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
    title: text(page.title, '未命名页面', 160),
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
  if (!slug) return '页面路径不能为空。';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) return '路径只能包含小写字母、数字与连字符。';
  if (RESERVED_SLUGS.has(slug)) return '这个路径被系统路由占用，请换一个。';
  if (pages.some((page) => page.slug === slug && page.id !== currentId)) return '已经有页面使用这个路径。';
  return '';
}

/** 当前明暗模式与切换函数。页头按钮、Shift+D 与思维链动作共用。 */
export function useThemeMode(): { mode: ThemeMode; toggle: () => void } {
  const { customization, update } = useCustomization();
  const mode = customization.theme.mode;
  const toggle = useCallback(() => {
    const next: ThemeMode = customization.theme.mode === 'dark' ? 'light' : 'dark';
    update({ theme: applyMode(customization.theme, next) });
  }, [customization.theme, update]);
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

/** 导出为 JSON 文件：外观、页面与扩展一并带走。 */
export function downloadCustomization(customization: SiteCustomization, siteName: string): void {
  const payload = {
    version: 1,
    exported_at: new Date().toISOString(),
    site: siteName,
    customization,
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
    throw new Error('文件不是有效的 JSON。');
  }
  if (!data || typeof data !== 'object') throw new Error('文件内容不是一个配置对象。');
  const record = data as Record<string, unknown>;
  const source = (record.customization ?? record) as Record<string, unknown>;
  if (!source || typeof source !== 'object') throw new Error('缺少 customization 字段。');
  if (
    !source.theme &&
    !source.layout &&
    !source.pages &&
    !source.extensions &&
    !source.covers &&
    !source.custom_extensions
  ) {
    throw new Error('文件里没有可识别的外观、页面、封面或扩展配置。');
  }
  return readCustomization({ customization: source as unknown as SiteCustomization });
}
