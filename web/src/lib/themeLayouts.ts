import type { ScreenLayout, SiteCustomization, ThemeLayoutEntry } from '../types';

/**
 * 按主题保存的首页 / 文章页编排。
 *
 * 数据形状是 `customization.theme_layouts[themeId]`，不放进 `SiteTheme` 本身：内置
 * 主题（原版、夜航）也要各自拥有一份可编辑的编排，而它们不在 `themes[]` 里。
 *
 * 三条约定：
 * - 字段缺失 = 这套主题没有自己的编排，沿用站点级旧值（旧设计文档无需迁移）；
 * - 显式的 `{ blocks: [] }` = 空白画布；
 * - 只有首页与文章页跟着主题走，自定义页面、导航与页脚仍是站点级。
 *
 * 这里只做纯计算，不引入 `customize.ts`：配置的归一化在主模块里完成，避免
 * `customize → themeLayouts → customize` 的循环依赖。
 */

/** 没有自定义主题 id 时，按档位兜底用的主题键。 */
export const FALLBACK_THEME_ID = 'custom';

/** 当前生效主题的 id；旧配置没有 active_theme 时按「自定义」处理。 */
export function themeScopeId(customization: Pick<SiteCustomization, 'active_theme'>): string {
  return customization.active_theme || FALLBACK_THEME_ID;
}

/** 读取一套主题自己的编排；没有条目时返回 undefined。 */
export function themeLayoutFor(
  customization: Pick<SiteCustomization, 'active_theme' | 'theme_layouts'>,
  themeId: string | undefined = customization.active_theme,
): ThemeLayoutEntry | undefined {
  const id = themeId || FALLBACK_THEME_ID;
  return customization.theme_layouts?.[id];
}

/** 写入一套主题的一类编排，返回新的映射（不修改入参）。 */
export function withThemeLayout(
  current: Record<string, ThemeLayoutEntry> | undefined,
  themeId: string,
  kind: 'home' | 'article',
  layout: ScreenLayout,
): Record<string, ThemeLayoutEntry> {
  const id = themeId || FALLBACK_THEME_ID;
  return {
    ...current,
    [id]: { ...(current?.[id] ?? {}), [kind]: layout },
  };
}

/** 删除一套主题的编排（删除主题时一并清掉）。 */
export function withoutThemeLayout(
  current: Record<string, ThemeLayoutEntry> | undefined,
  themeId: string,
): Record<string, ThemeLayoutEntry> {
  if (!current || !(themeId in current)) return current ?? {};
  const next = { ...current };
  delete next[themeId];
  return next;
}

/**
 * 把当前主题的编排投影到 `home` / `article`。
 *
 * 只覆盖有条目的那一类；没有条目时保留站点级旧值。调用方拿到的是新对象，不改
 * 原始配置，所以读取路径可以放心地反复投影。
 */
export function projectThemeLayouts(customization: SiteCustomization): SiteCustomization {
  const entry = themeLayoutFor(customization);
  if (!entry) return customization;
  return {
    ...customization,
    home: entry.home ?? customization.home,
    article: entry.article ?? customization.article,
  };
}
