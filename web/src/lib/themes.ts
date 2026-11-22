import type {
  AppearanceSectionId,
  LayoutVariant,
  ScreenLayout,
  SiteTheme,
  ThemeLayoutEntry,
  ThemePreviewSpec,
  ThemeSettings,
} from '../types';
import { t } from './i18n';
import { applyPreset, DEFAULT_THEME, normalizeThemeSettings } from './theme';
import { normalizeThemeSettingsSchema } from './themeSettings';
import { cloneThemePreview, normalizeThemePreview } from './themePreview';
import { liveCatalog } from './i18n/live';

/**
 * “大主题”：一次切换配色、排版与布局变体（原版 / 夜航）。
 *
 * 2026-11 起「白昼」作为独立主题下架，它的明亮观感并入夜航的浅色重配。
 * 旧配置里的 `daylight` 版式仍被 `normalizeVariant` 接受，已有站点不会塌版。
 *
 * 内置主题写在代码里，不可删除；导入、创建或另存的主题存在 `customization.themes`。
 * 主题可以声明自己需要哪些外观分区（`appearance`）：外观页只渲染这些分区，
 * 主题制作者因此能给主题加一块设置、或者把用不上的设置藏起来。
 *
 * 主题仍然不带文章、页面编排或自定义 CSS，避免导入一份主题就把站点内容改掉。
 */

export interface BuiltinThemeDefinition {
  id: string;
  name: string;
  note: string;
  preset: string;
  variant: LayoutVariant;
  /**
   * 版式自带、但与配色预设无关的排版默认值。
   *
   * 纸白与夜航沿用主题默认的衬线标题和圆角；需要更现代的版式时在这里加字重、
   * 圆角与正文栏宽。这些值在套用主题时一起写入，站长仍可在外观页微调。
   */
  style?: Partial<ThemeSettings>;
  /**
   * 主题自带的预览。内置主题示范「主题自己写预览」：没有这段时，渲染器会按版式
   * 画一张通用结构图。字段与限制见 `docs/themes/06-preview.md`。
   */
  preview?: ThemePreviewSpec;
}

/** 外观分区清单：id、名称与用途说明。顺序即外观页的显示顺序。 */
const RAW_APPEARANCE_SECTIONS: {
  id: AppearanceSectionId;
  name: string;
  note: string;
}[] = [
  { id: 'hero', name: t('首页首屏'), note: t('眉题、主标题与副标题；单栏与双栏都会读取。') },
  { id: 'branding', name: t('品牌副标题'), note: t('品牌名下方那行小字。') },
  { id: 'announcement', name: t('公告条'), note: t('页头下方的可关闭公告。') },
  { id: 'custom_css', name: t('自定义 CSS'), note: t('只在前台生效的补充样式。') },
];

/** 目录中文在读取时翻译，切换语言后立即生效（见 i18n/live.ts）。 */
export const APPEARANCE_SECTIONS = liveCatalog(RAW_APPEARANCE_SECTIONS);

export const DEFAULT_APPEARANCE_SECTIONS: AppearanceSectionId[] = APPEARANCE_SECTIONS.map(
  (item) => item.id,
);

const APPEARANCE_IDS = new Set<string>(DEFAULT_APPEARANCE_SECTIONS);

const RAW_BUILTIN_THEMES: BuiltinThemeDefinition[] = [
  {
    id: 'default',
    name: t('原版'),
    note: t('纸白浅色 · 经典单栏，适合安静的长文阅读。'),
    preset: 'paper',
    variant: 'classic',
    preview: {
      brand: 'PRACTACU PRESS',
      nav: [t('文章'), t('专题'), t('关于')],
      kicker: t('独立出版 · 纸白单栏'),
      title: t('把注意力留给文字'),
      subtitle: t('长文、随笔与专题，安静克制的阅读版面。'),
      blocks: [
        { type: 'media', weight: 2 },
        { type: 'text' },
        { type: 'quote', text: t('版面安静下来，文字才有回声。') },
      ],
    },
  },
  {
    id: 'night',
    name: t('夜航'),
    note: t('冷石墨与电光蓝 · 深色杂志布局；切到浅色会得到同一套设计的冷白重配。'),
    preset: 'night',
    variant: 'bento',
    preview: {
      brand: 'NIGHTFLIGHT',
      nav: [t('首页'), t('文章'), t('社区')],
      kicker: t('夜航 · 冷石墨双栏'),
      title: t('在冷石墨上读长夜'),
      subtitle: t('电光蓝强调与杂志网格，适合图片、专题与社区。'),
      blocks: [
        { type: 'grid', weight: 2 },
        { type: 'text' },
        { type: 'button', text: t('开始阅读') },
      ],
    },
  },
];

/** 目录中文在读取时翻译，切换语言后立即生效（见 i18n/live.ts）。 */
export const BUILTIN_THEMES = liveCatalog(RAW_BUILTIN_THEMES);

export const BUILTIN_THEME_IDS = new Set(BUILTIN_THEMES.map((item) => item.id));

/**
 * 主题市场地址。当前留空：「获取主题」弹窗只展示入口与接口约定，不写入任何外链。
 * 接入时在这里填地址并实现列表拉取即可；约定见
 * docs/superpowers/specs/2026-10-25-theme-marketplace-integration.md。
 */
export const THEME_MARKETPLACE_URL = '';

export function variantLabel(variant: LayoutVariant): string {
  if (variant === 'bento') return t('双栏');
  if (variant === 'daylight') return t('卡片');
  return t('单栏');
}

/**
 * 读取布局变体：只接受三个内置值，其余（旧配置、手改文件）一律回退单栏。
 *
 * 导入主题和读取站内配置都走这里，避免每处各写一份 `variant === 'bento'`
 * 让新变体在某个角落悄悄丢失。
 */
export function normalizeVariant(value: unknown): LayoutVariant {
  return value === 'bento' || value === 'daylight' ? value : 'classic';
}

export function builtinThemeBundle(id: string): SiteTheme | null {
  const definition = BUILTIN_THEMES.find((item) => item.id === id);
  if (!definition) return null;
  return {
    id: definition.id,
    name: definition.name,
    note: definition.note,
    variant: definition.variant,
    theme: { ...applyPreset(DEFAULT_THEME, definition.preset), ...definition.style },
    appearance: { sections: [...DEFAULT_APPEARANCE_SECTIONS] },
    ...(definition.preview ? { preview: cloneThemePreview(definition.preview) } : {}),
  };
}

/** 内置主题在前，自定义主题按保存顺序在后。 */
export function themeLibrary(customThemes: SiteTheme[] = []): SiteTheme[] {
  const builtins = BUILTIN_THEMES.map((item) => builtinThemeBundle(item.id)).filter(
    (item): item is SiteTheme => !!item,
  );
  return [...builtins, ...customThemes];
}

export function themeById(id: string | undefined, customThemes: SiteTheme[] = []): SiteTheme | null {
  if (!id) return null;
  return themeLibrary(customThemes).find((item) => item.id === id) ?? null;
}

export function activeTheme(
  activeId: string | undefined,
  customThemes: SiteTheme[] = [],
): SiteTheme | null {
  return themeById(activeId, customThemes);
}

function themeSignature(theme: ThemeSettings, variant: LayoutVariant): string {
  return JSON.stringify({ theme, variant });
}

/**
 * 空白主题回落的默认版式：内置「原版」的单栏。
 *
 * 主题不写版式时，组件库与站点版式都按这一档解析；这也是「组件走默认主题的组件
 * 样式」里“默认主题”的定义。
 */
export const DEFAULT_THEME_VARIANT: LayoutVariant = 'classic';

/** 内置「原版」的完整令牌；空白主题的组件样式都回落到这里。 */
function defaultThemeSettings(): ThemeSettings {
  const bundle = builtinThemeBundle('default');
  return bundle?.theme ? { ...bundle.theme } : { ...DEFAULT_THEME };
}

/**
 * 解析一套主题最终生效的令牌。
 *
 * 空白主题没有 `theme` 字段：返回内置「原版」的完整令牌，而不是把默认值写回主题
 * 记录。显式保存过令牌的主题仍走归一化，坏数据不会漏进渲染层。
 */
export function resolveThemeSettings(bundle: SiteTheme): ThemeSettings {
  return bundle.theme ? normalizeThemeSettings(bundle.theme) : defaultThemeSettings();
}

/** 解析一套主题最终生效的版式；空白主题回落到 `DEFAULT_THEME_VARIANT`。 */
export function resolveThemeVariant(bundle: SiteTheme): LayoutVariant {
  return bundle.variant ?? DEFAULT_THEME_VARIANT;
}

/** 这套主题是否显式保存过令牌（用于详情页显示「未设置」）。 */
export function themeHasSettings(bundle: SiteTheme): boolean {
  return !!bundle.theme;
}

/** 这套主题是否显式保存过版式（用于详情页显示「未设置」）。 */
export function themeHasVariant(bundle: SiteTheme): boolean {
  return !!bundle.variant;
}

/** 当前配色/字体/变体是否仍然等于某套主题的原始定义。 */
export function themeMatches(
  theme: ThemeSettings,
  variant: LayoutVariant,
  bundle: SiteTheme,
): boolean {
  return (
    themeSignature(theme, variant) ===
    themeSignature(resolveThemeSettings(bundle), resolveThemeVariant(bundle))
  );
}

/**
 * 旧配置没有 active_theme：先按完整值匹配自定义主题，再匹配内置主题；
 * 都不匹配就标记为 custom，主题页会显示“自定义 / 已微调”。
 */
export function inferActiveTheme(
  theme: ThemeSettings,
  variant: LayoutVariant,
  customThemes: SiteTheme[] = [],
): string {
  const matched = themeLibrary(customThemes).find((item) => themeMatches(theme, variant, item));
  return matched?.id ?? 'custom';
}

export function newThemeId(): string {
  return `theme_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 一套真正的空白主题：只有名字与备注。
 *
 * 不写 `theme` / `variant` / `appearance` / `preview`：渲染时令牌与版式分别回落到
 * 内置「原版」主题与单栏版式；详情页据此显示「未设置」。原始编排是空白画布，
 * 之后用户的编辑才写进 `theme_layouts`。
 */
export function blankTheme(name: string, note = ''): SiteTheme {
  return {
    id: newThemeId(),
    name,
    note,
    layout: { home: { blocks: [] }, article: { blocks: [] } },
  };
}

/**
 * 读取主题绑定的外观分区。
 *
 * 返回 undefined 表示这个主题没有声明（按内置全集处理）；
 * 返回 `{ sections: [] }` 表示主题作者明确关掉了全部外观设置。
 */
export function normalizeAppearance(value: unknown): SiteTheme['appearance'] {
  if (!value || typeof value !== 'object') return undefined;
  const raw = (value as { sections?: unknown }).sections;
  if (!Array.isArray(raw)) return undefined;
  const sections: AppearanceSectionId[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !APPEARANCE_IDS.has(item)) continue;
    if (!sections.includes(item as AppearanceSectionId)) {
      sections.push(item as AppearanceSectionId);
    }
  }
  return { sections };
}

/** 主题声明的外观分区；未声明时按内置全集处理。 */
export function themeSections(bundle: SiteTheme | null | undefined): AppearanceSectionId[] {
  if (!bundle?.appearance) return [...DEFAULT_APPEARANCE_SECTIONS];
  return bundle.appearance.sections;
}

export function themeHasSection(
  bundle: SiteTheme | null | undefined,
  id: AppearanceSectionId,
): boolean {
  return themeSections(bundle).includes(id);
}

function themeText(value: unknown, fallback: string, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : fallback;
}

/** 主题原始编排的结构收敛；深层的区块归一化由 `customize.ts` 完成。 */
function themeLayoutValue(value: unknown): ThemeLayoutEntry | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const entry: ThemeLayoutEntry = {};
  if (raw.home && typeof raw.home === 'object' && !Array.isArray(raw.home)) {
    entry.home = raw.home as ScreenLayout;
  }
  if (raw.article && typeof raw.article === 'object' && !Array.isArray(raw.article)) {
    entry.article = raw.article as ScreenLayout;
  }
  return entry.home || entry.article ? entry : undefined;
}

/**
 * 把配置里读到的自定义主题收敛成合法结构。
 *
 * 旧配置、手工改坏的 id、与内置主题重名都会被丢弃或改写成安全 id；
 * 返回 null 表示这条主题不可用。
 */
export function normalizeCustomTheme(value: unknown): SiteTheme | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<SiteTheme>;
  const name = themeText(raw.name, '', 40).trim();
  if (!name) return null;
  let id = themeText(raw.id, '', 80).trim();
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id)) {
    id = newThemeId();
  }
  if (BUILTIN_THEME_IDS.has(id)) id = `custom_${id}`;
  const appearance = normalizeAppearance(raw.appearance);
  const settings = normalizeThemeSettingsSchema(raw.settings);
  const preview = normalizeThemePreview(raw.preview);
  const layout = themeLayoutValue(raw.layout);
  // 空白主题的关键：字段缺失就保持缺失，不能在读取路径上补成一套默认令牌，
  // 否则「未设置」会被伪装成显式配置，导出时也会写成一份默认主题的副本。
  const theme =
    raw.theme && typeof raw.theme === 'object' ? normalizeThemeSettings(raw.theme) : undefined;
  const variant =
    raw.variant === undefined || raw.variant === null ? undefined : normalizeVariant(raw.variant);
  return {
    id,
    name,
    note: themeText(raw.note, '', 160),
    ...(variant ? { variant } : {}),
    ...(theme ? { theme } : {}),
    ...(layout ? { layout } : {}),
    ...(appearance ? { appearance } : {}),
    ...(settings ? { settings } : {}),
    ...(preview ? { preview } : {}),
  };
}

/**
 * 解析主题文件。
 *
 * 同时接受主题导出文件（kind=pp-theme）和外观页导出的完整配置：后者会从
 * `customization.theme` / `customization.layout.variant` 里取主题部分，不导入
 * 页面、文章或自定义 CSS。
 */
export function parseThemeFile(raw: string): SiteTheme {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(t('文件不是有效的 JSON。'));
  }
  if (!data || typeof data !== 'object') throw new Error(t('文件内容不是一个主题对象。'));
  const record = data as Record<string, unknown>;
  const customization =
    record.customization && typeof record.customization === 'object'
      ? (record.customization as Record<string, unknown>)
      : null;
  const themeSource = record.theme ?? customization?.theme;
  if (!themeSource || typeof themeSource !== 'object') {
    throw new Error(t('文件里没有可识别的主题配置。'));
  }
  const layoutSource =
    record.layout && typeof record.layout === 'object'
      ? (record.layout as Record<string, unknown>)
      : customization?.layout && typeof customization.layout === 'object'
        ? (customization.layout as Record<string, unknown>)
        : null;
  const rawVariant = record.variant ?? record.layout_variant ?? layoutSource?.variant;
  const variant = normalizeVariant(rawVariant);
  const name = themeText(record.name ?? record.site, t('导入的主题'), 40).trim() || t('导入的主题');
  const note = themeText(record.note ?? record.summary, '', 160);
  const appearance = normalizeAppearance(record.appearance);
  const settings = normalizeThemeSettingsSchema(record.settings);
  const preview = normalizeThemePreview(record.preview);
  return {
    id: newThemeId(),
    name,
    note,
    variant,
    theme: normalizeThemeSettings(themeSource),
    ...(appearance ? { appearance } : {}),
    ...(settings ? { settings } : {}),
    ...(preview ? { preview } : {}),
  };
}

/** 下载一套主题；只包含主题、版式与外观绑定。 */
export function downloadThemeFile(theme: SiteTheme): void {
  const payload = {
    kind: 'pp-theme',
    version: 1,
    exported_at: new Date().toISOString(),
    name: theme.name,
    note: theme.note,
    ...(theme.variant ? { variant: theme.variant } : {}),
    ...(theme.theme ? { theme: theme.theme } : {}),
    ...(theme.appearance ? { appearance: theme.appearance } : {}),
    ...(theme.settings ? { settings: theme.settings } : {}),
    ...(theme.preview ? { preview: theme.preview } : {}),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `practacu-theme-${theme.name.replace(/[\\/:*?"<>|\s]+/g, '-') || 'theme'}.json`;
  link.click();
  URL.revokeObjectURL(url);
}
