import type { AppearanceSectionId, LayoutVariant, SiteTheme, ThemeSettings } from '../types';
import { applyPreset, DEFAULT_THEME, normalizeThemeSettings } from './theme';

/**
 * “大主题”：一次切换配色、排版与布局变体（原版单栏 / 夜航双栏）。
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
}

/** 外观分区清单：id、名称与用途说明。顺序即外观页的显示顺序。 */
export const APPEARANCE_SECTIONS: {
  id: AppearanceSectionId;
  name: string;
  note: string;
}[] = [
  { id: 'hero', name: '首页首屏', note: '眉题、主标题与副标题；单栏与双栏都会读取。' },
  { id: 'branding', name: '品牌副标题', note: '品牌名下方那行小字。' },
  { id: 'announcement', name: '公告条', note: '页头下方的可关闭公告。' },
  { id: 'custom_css', name: '自定义 CSS', note: '只在前台生效的补充样式。' },
];

export const DEFAULT_APPEARANCE_SECTIONS: AppearanceSectionId[] = APPEARANCE_SECTIONS.map(
  (item) => item.id,
);

const APPEARANCE_IDS = new Set<string>(DEFAULT_APPEARANCE_SECTIONS);

export const BUILTIN_THEMES: BuiltinThemeDefinition[] = [
  {
    id: 'default',
    name: '原版',
    note: '纸白浅色 · 经典单栏，适合安静的长文阅读。',
    preset: 'paper',
    variant: 'classic',
  },
  {
    id: 'night',
    name: '夜航',
    note: '暖黑暗色 · 双栏杂志布局，适合社区与图片较多的站点。',
    preset: 'night',
    variant: 'bento',
  },
];

export const BUILTIN_THEME_IDS = new Set(BUILTIN_THEMES.map((item) => item.id));

/**
 * 主题市场地址。当前留空：「获取主题」弹窗只展示入口与接口约定，不写入任何外链。
 * 接入时在这里填地址并实现列表拉取即可；约定见
 * docs/superpowers/specs/2026-10-25-theme-marketplace-integration.md。
 */
export const THEME_MARKETPLACE_URL = '';

export function variantLabel(variant: LayoutVariant): string {
  return variant === 'bento' ? '双栏' : '单栏';
}

export function builtinThemeBundle(id: string): SiteTheme | null {
  const definition = BUILTIN_THEMES.find((item) => item.id === id);
  if (!definition) return null;
  return {
    id: definition.id,
    name: definition.name,
    note: definition.note,
    variant: definition.variant,
    theme: applyPreset(DEFAULT_THEME, definition.preset),
    appearance: { sections: [...DEFAULT_APPEARANCE_SECTIONS] },
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

/** 当前配色/字体/变体是否仍然等于某套主题的原始定义。 */
export function themeMatches(
  theme: ThemeSettings,
  variant: LayoutVariant,
  bundle: SiteTheme,
): boolean {
  return themeSignature(theme, variant) === themeSignature(bundle.theme, bundle.variant);
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
  return {
    id,
    name,
    note: themeText(raw.note, '', 160),
    variant: raw.variant === 'bento' ? 'bento' : 'classic',
    theme: normalizeThemeSettings(raw.theme),
    ...(appearance ? { appearance } : {}),
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
    throw new Error('文件不是有效的 JSON。');
  }
  if (!data || typeof data !== 'object') throw new Error('文件内容不是一个主题对象。');
  const record = data as Record<string, unknown>;
  const customization =
    record.customization && typeof record.customization === 'object'
      ? (record.customization as Record<string, unknown>)
      : null;
  const themeSource = record.theme ?? customization?.theme;
  if (!themeSource || typeof themeSource !== 'object') {
    throw new Error('文件里没有可识别的主题配置。');
  }
  const layoutSource =
    record.layout && typeof record.layout === 'object'
      ? (record.layout as Record<string, unknown>)
      : customization?.layout && typeof customization.layout === 'object'
        ? (customization.layout as Record<string, unknown>)
        : null;
  const rawVariant = record.variant ?? record.layout_variant ?? layoutSource?.variant;
  const variant: LayoutVariant = rawVariant === 'bento' ? 'bento' : 'classic';
  const name = themeText(record.name ?? record.site, '导入的主题', 40).trim() || '导入的主题';
  const note = themeText(record.note ?? record.summary, '', 160);
  const appearance = normalizeAppearance(record.appearance);
  return {
    id: newThemeId(),
    name,
    note,
    variant,
    theme: normalizeThemeSettings(themeSource),
    ...(appearance ? { appearance } : {}),
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
    variant: theme.variant,
    theme: theme.theme,
    ...(theme.appearance ? { appearance: theme.appearance } : {}),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `practacu-theme-${theme.name.replace(/[\\/:*?"<>|\s]+/g, '-') || 'theme'}.json`;
  link.click();
  URL.revokeObjectURL(url);
}
