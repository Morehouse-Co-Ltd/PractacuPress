import type {
  FooterColumn,
  FooterLink,
  LayoutSettings,
  NavChild,
  NavIconPosition,
  NavSubStyle,
  NavTab,
  SitePage,
  SocialLink,
  SocialPlatform,
} from '../types';
import type { IconName } from '../components/Icon';
import { t } from './i18n';
import { liveCatalog } from './i18n/live';

/**
 * 顶部导航 Tab 与页脚栏目。
 *
 * 这一块现在支持完整自定义：每个 Tab 可以带内置图标（左/右/不显示）、任意排序，
 * 还可以挂最多 8 个二级入口；二级入口可以渲染成页头下方的胶囊栏，也可以收进下拉菜单。
 * 数据仍保存在安装配置的 `layout` 里，随外观配置一起导入导出。
 */

export const MAX_NAV_TABS = 8;
/** 每个顶部 Tab 最多挂多少个二级入口。 */
export const MAX_NAV_CHILDREN = 8;
/** 软件 / 社交快捷链接最多多少条。 */
export const MAX_SOCIAL_LINKS = 8;
export const MAX_FOOTER_COLUMNS = 4;
export const MAX_FOOTER_LINKS = 8;

const RAW_SOCIAL_PLATFORM_CHOICES: { value: SocialPlatform; label: string }[] = [
  { value: 'github', label: 'GitHub' },
  { value: 'x', label: 'X / Twitter' },
  { value: 'mastodon', label: 'Mastodon' },
  { value: 'rss', label: t('RSS / 订阅') },
  { value: 'email', label: t('邮箱') },
  { value: 'website', label: t('网站') },
  { value: 'custom', label: t('自定义链接') },
];

/** 目录中文在读取时翻译，切换语言后立即生效（见 i18n/live.ts）。 */
export const SOCIAL_PLATFORM_CHOICES = liveCatalog(RAW_SOCIAL_PLATFORM_CHOICES);

export function socialPlatformLabel(platform: SocialPlatform): string {
  return SOCIAL_PLATFORM_CHOICES.find((item) => item.value === platform)?.label ?? t('链接');
}

/** 平台 → 内置图标。 */
export function socialIconName(platform: SocialPlatform): IconName {
  switch (platform) {
    case 'github':
      return 'github';
    case 'x':
      return 'x';
    case 'mastodon':
      return 'mastodon';
    case 'rss':
      return 'rss';
    case 'email':
      return 'mail';
    case 'website':
      return 'globe';
    default:
      return 'link';
  }
}

const SOCIAL_PLATFORMS = new Set<string>(SOCIAL_PLATFORM_CHOICES.map((item) => item.value));

/** 导航图标候选；只允许内置图标名，避免配置里塞进任意字符串。 */
const RAW_NAV_ICON_CHOICES: { name: IconName; label: string }[] = [
  { name: 'home', label: t('首页') },
  { name: 'file', label: t('文章') },
  { name: 'message', label: t('帖子 / 讨论') },
  { name: 'search', label: t('搜索') },
  { name: 'layers', label: t('页面 / 分组') },
  { name: 'grid', label: t('分类 / 网格') },
  { name: 'tag', label: t('标签') },
  { name: 'bookmark', label: t('收藏') },
  { name: 'heart', label: t('喜欢') },
  { name: 'sparkle', label: t('精选') },
  { name: 'eye', label: t('浏览') },
  { name: 'users', label: t('成员') },
  { name: 'user', label: t('个人') },
  { name: 'mail', label: t('联系') },
  { name: 'bell', label: t('通知') },
  { name: 'info', label: t('关于') },
  { name: 'globe', label: t('站点 / 地球') },
  { name: 'link', label: t('链接') },
  { name: 'image', label: t('图片') },
  { name: 'video', label: t('视频') },
  { name: 'bulb', label: t('灵感') },
  { name: 'settings', label: t('设置') },
  { name: 'shield', label: t('安全') },
  { name: 'chart', label: t('数据') },
];

/** 目录中文在读取时翻译，切换语言后立即生效（见 i18n/live.ts）。 */
export const NAV_ICON_CHOICES = liveCatalog(RAW_NAV_ICON_CHOICES);

const NAV_ICON_NAMES = new Set<string>(NAV_ICON_CHOICES.map((item) => item.name));

/** 把配置里的图标名收拢成合法内置图标；未知值返回 undefined。 */
export function navIconName(value: unknown): IconName | undefined {
  if (typeof value !== 'string') return undefined;
  return NAV_ICON_NAMES.has(value) ? (value as IconName) : undefined;
}

export function navIconPositionOf(
  tab: NavTab,
  layout: Pick<LayoutSettings, 'nav_icon_position'>,
): NavIconPosition {
  return tab.icon_position ?? layout.nav_icon_position ?? 'none';
}

export function navSubStyleOf(
  tab: NavTab,
  layout: Pick<LayoutSettings, 'nav_sub_style'>,
): NavSubStyle {
  return tab.sub_style ?? layout.nav_sub_style ?? 'bar';
}

export function navAlignOf(
  layout: Pick<LayoutSettings, 'nav_align'>,
): 'left' | 'center' | 'right' {
  return layout.nav_align ?? 'left';
}

let seq = 0;

/** 生成 Tab / 栏目 / 条目的 id。同一份配置里唯一即可。 */
export function newNavId(prefix: 'tab' | 'fcol' | 'flink'): string {
  seq += 1;
  return `${prefix}_${Date.now().toString(36)}${seq.toString(36)}`;
}

/** 允许出现在 href 里的协议；其余（javascript:、data: 等）一律丢弃。 */
const SAFE_PROTOCOLS = ['http:', 'https:', 'mailto:'];

/**
 * 把用户填的地址收敛成安全值。
 *
 * 站内路径必须以 `/` 开头；http(s) 与 mailto 原样保留；其他协议或
 * `javascript:` 这类伪协议返回空串，由调用方渲染成纯文字。
 */
export function safeHref(input: string): string {
  const value = input.trim().slice(0, 300);
  if (!value) return '';
  if (value.startsWith('/')) {
    // 协议相对地址（//evil.com）会被浏览器当成外链，这里拒绝。
    return value.startsWith('//') ? '' : value;
  }
  if (value.startsWith('#')) return value;
  try {
    const url = new URL(value);
    return SAFE_PROTOCOLS.includes(url.protocol) ? value : '';
  } catch {
    return '';
  }
}

export type NavHrefKind = 'internal' | 'external' | 'plain';

export function navHrefKind(href: string): NavHrefKind {
  const value = safeHref(href);
  if (!value) return 'plain';
  if (value.startsWith('/') || value.startsWith('#')) return 'internal';
  return 'external';
}

/**
 * 判断某个导航地址当前是否处于选中状态。
 *
 * 文章与帖子要连带详情页一起高亮（`/a/xxx`、`/p/xxx`）；其他站内路径按
 * 前缀匹配，`/about` 不会把 `/about-us` 点亮。
 */
export function navTabActive(pathname: string, href: string): boolean {
  const value = safeHref(href);
  if (!value || !value.startsWith('/')) return false;
  if (value === '/') return pathname === '/';
  if (value === '/articles') return pathname === '/articles' || pathname.startsWith('/a/');
  if (value === '/posts') return pathname === '/posts' || pathname.startsWith('/p/');
  return pathname === value || pathname.startsWith(`${value}/`);
}

/** 导航项自身是否选中；二级入口选中时父 Tab 也随之高亮。 */
export function navTabGroupActive(pathname: string, tab: NavTab): boolean {
  if (navTabActive(pathname, tab.href)) return true;
  return (tab.children ?? []).some((child) => navTabActive(pathname, child.href));
}

/** 生成一个二级入口；编辑器与配置归一化共用。 */
export function newNavChild(label = t('新入口'), href = '/'): NavChild {
  return { id: newNavId('tab'), label, href };
}

/** 当前路径命中的二级入口（用于二级栏高亮）。 */
export function activeNavChild(
  pathname: string,
  tab: NavTab | undefined,
): NavChild | undefined {
  return (tab?.children ?? []).find((child) => navTabActive(pathname, child.href));
}

/** 自动模式的导航：内置入口 + 勾选「加入站点导航」的页面（最多 3 个）。 */
export function autoNavTabs(
  layout: Pick<LayoutSettings, 'show_articles' | 'show_posts' | 'show_search'>,
  pages: SitePage[],
): NavTab[] {
  const tabs: NavTab[] = [{ id: 'tab_home', label: t('首页'), href: '/' }];
  if (layout.show_articles) tabs.push({ id: 'tab_articles', label: t('文章'), href: '/articles' });
  if (layout.show_posts) tabs.push({ id: 'tab_posts', label: t('帖子'), href: '/posts' });
  if (layout.show_search) tabs.push({ id: 'tab_search', label: t('搜索'), href: '/search' });
  for (const page of pages) {
    // 调用方可能已经用 navPages() 过滤过；这里再兜一层，避免草稿混进导航。
    if (page.status !== 'published' || !page.show_in_nav) continue;
    tabs.push({ id: `tab_page_${page.id}`, label: page.title, href: `/${page.slug}` });
  }
  return tabs.slice(0, MAX_NAV_TABS);
}

/**
 * 当前实际渲染的导航。
 *
 * `layout.nav_tabs` 为 undefined 时是自动模式；一旦保存过就完全按条目渲染，
 * 这样站长删掉「帖子」不会被 show_posts 重新加回来。
 */
export function siteNavTabs(
  layout: LayoutSettings,
  pages: SitePage[],
): { tabs: NavTab[]; auto: boolean } {
  if (Array.isArray(layout.nav_tabs)) {
    return { tabs: layout.nav_tabs, auto: false };
  }
  return { tabs: autoNavTabs(layout, pages), auto: true };
}

function clip(value: unknown, fallback: string, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : fallback;
}

function normalizeNavChild(value: unknown): NavChild | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<NavChild>;
  const label = clip(raw.label, '', 20).trim();
  if (!label) return null;
  return {
    id: clip(raw.id, '', 80).trim() || newNavId('tab'),
    label,
    href: clip(raw.href, '', 300),
    icon: navIconName(raw.icon),
  };
}

function normalizeNavIconPosition(value: unknown): NavIconPosition | undefined {
  return value === 'left' || value === 'right' || value === 'none' ? value : undefined;
}

function normalizeNavSubStyle(value: unknown): NavSubStyle | undefined {
  return value === 'bar' || value === 'dropdown' ? value : undefined;
}

/** 读取导航 Tab；返回 undefined 表示「没有配置过，继续用自动模式」。 */
export function normalizeNavTabs(value: unknown): NavTab[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) return undefined;
  const tabs: NavTab[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Partial<NavTab>;
    const label = clip(raw.label, '', 20).trim();
    if (!label) continue;
    let id = clip(raw.id, '', 80).trim() || newNavId('tab');
    if (seen.has(id)) id = newNavId('tab');
    seen.add(id);
    // 这里只做长度收敛，不做协议过滤：编辑器里正在输入的 "https://" 不应该被清空。
    // 真正渲染前由 SiteChrome 调用 safeHref 过滤。
    const children: NavChild[] = [];
    if (Array.isArray(raw.children)) {
      for (const entry of raw.children) {
        const child = normalizeNavChild(entry);
        if (!child) continue;
        children.push(child);
        if (children.length >= MAX_NAV_CHILDREN) break;
      }
    }
    tabs.push({
      id,
      label,
      href: clip(raw.href, '', 300),
      icon: navIconName(raw.icon),
      icon_position: normalizeNavIconPosition(raw.icon_position),
      children: children.length ? children : undefined,
      sub_style: normalizeNavSubStyle(raw.sub_style),
    });
    if (tabs.length >= MAX_NAV_TABS) break;
  }
  return tabs;
}

function normalizeFooterLink(value: unknown): FooterLink | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<FooterLink>;
  const label = clip(raw.label, '', 40).trim();
  if (!label) return null;
  return {
    id: clip(raw.id, '', 80).trim() || newNavId('flink'),
    label,
    href: clip(raw.href, '', 300),
  };
}

/** 读取页脚栏目。坏条目直接丢弃，数量超限时截断。 */
/** 读取软件 / 社交快捷链接；坏条目丢弃，最多 8 条。 */
export function normalizeSocialLinks(value: unknown): SocialLink[] {
  if (!Array.isArray(value)) return [];
  const links: SocialLink[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Partial<SocialLink>;
    const platform = SOCIAL_PLATFORMS.has(String(raw.platform))
      ? (raw.platform as SocialPlatform)
      : 'custom';
    const label = clip(raw.label, '', 40).trim() || socialPlatformLabel(platform);
    const url = clip(raw.url, '', 300).trim();
    if (!url) continue;
    links.push({
      id: clip(raw.id, '', 80).trim() || newNavId('tab'),
      platform,
      label,
      url,
    });
    if (links.length >= MAX_SOCIAL_LINKS) break;
  }
  return links;
}

/** 生成一条快捷链接（编辑器用）。 */
export function newSocialLink(): SocialLink {
  return { id: newNavId('tab'), platform: 'github', label: 'GitHub', url: 'https://github.com/' };
}

export function normalizeFooterColumns(value: unknown): FooterColumn[] {
  if (!Array.isArray(value)) return defaultFooterColumns();
  const columns: FooterColumn[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Partial<FooterColumn>;
    const title = clip(raw.title, '', 20).trim();
    if (!title) continue;
    const links: FooterLink[] = [];
    if (Array.isArray(raw.links)) {
      for (const entry of raw.links) {
        const link = normalizeFooterLink(entry);
        if (!link) continue;
        links.push(link);
        if (links.length >= MAX_FOOTER_LINKS) break;
      }
    }
    columns.push({
      id: clip(raw.id, '', 80).trim() || newNavId('fcol'),
      title,
      links,
    });
    if (columns.length >= MAX_FOOTER_COLUMNS) break;
  }
  return columns;
}

/** 出厂页脚：两栏，够用又不喧闹。 */
export function defaultFooterColumns(): FooterColumn[] {
  return [
    {
      id: 'fcol_read',
      title: t('阅读'),
      links: [
        { id: 'flink_articles', label: t('全部文章'), href: '/articles' },
        { id: 'flink_posts', label: t('全部帖子'), href: '/posts' },
        { id: 'flink_search', label: t('搜索'), href: '/search' },
      ],
    },
    {
      id: 'fcol_site',
      title: t('站点'),
      links: [
        { id: 'flink_about', label: t('关于本站'), href: '/about' },
        { id: 'flink_admin', label: t('管理后台'), href: '/admin' },
      ],
    },
  ];
}

export interface FooterBrand {
  /** 页脚显示的站点名（可被 footer_brand_name 覆盖）。 */
  name: string;
  /** 品牌下方那行小字（可被 footer_brand_sub 覆盖）。 */
  sub: string;
  /** 品牌简介（可被 footer_brand_desc 覆盖）。 */
  description: string;
  /** 是否显示状态标签行。 */
  showTags: boolean;
  /** 自定义标签；空数组表示显示站点真实状态。 */
  tags: string[];
}

const DEFAULT_BRAND_SUB = 'Independent publishing';

/**
 * 把页脚品牌区配置收敛成实际渲染值。
 *
 * 每一项都遵循「留空回退」：标题回退站点名称、副标题回退品牌副标题、简介回退站点简介，
 * 这样旧配置与新建站点都不需要额外迁移。
 */
export function footerBrand(
  layout: Pick<
    LayoutSettings,
    'brand_sub' | 'footer_brand_name' | 'footer_brand_sub' | 'footer_brand_desc' | 'footer_show_tags' | 'footer_tags'
  >,
  siteName: string,
  siteDescription: string,
): FooterBrand {
  const name = layout.footer_brand_name.trim() || siteName.trim() || 'Practacu Press';
  const sub = layout.footer_brand_sub.trim() || layout.brand_sub.trim() || DEFAULT_BRAND_SUB;
  const description =
    layout.footer_brand_desc.trim() ||
    siteDescription.trim() ||
    t('一间小而安静的编辑部。写作者拥有自己的稿子，读者被当作邻居。');
  return {
    name,
    sub,
    description,
    showTags: layout.footer_show_tags,
    tags: parseFooterTags(layout.footer_tags),
  };
}

/** 解析站长填写的自定义标签：支持中英文逗号与「、」，去重后最多 4 个。 */
export function parseFooterTags(value: string): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const part of value.split(/[,，、]/)) {
    const label = part.trim().slice(0, 16);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    tags.push(label);
    if (tags.length >= 4) break;
  }
  return tags;
}
