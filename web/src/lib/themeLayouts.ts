import type {
  LayoutVariant,
  ScreenLayout,
  SiteCustomization,
  SiteTheme,
  ThemeLayoutEntry,
} from '../types';
import { defaultHomeLayout } from './blocks';
import { resolveThemeVariant, themeById } from './themes';

/**
 * 按主题保存的首页 / 文章页编排。
 *
 * 数据分两层：
 * - `SiteTheme.layout` 是主题自带的「原始编排」：内置主题的默认编排、空白主题的
 *   空白画布、导入主题包里的页面、另存主题时的快照；
 * - `customization.theme_layouts[themeId]` 是用户编辑后的覆盖。
 *
 * 投影时优先用覆盖，其次用原始编排；`theme_layouts` 字段缺失表示旧版站点级模式，
 * 此时完全沿用站点级 `home` / `article`，不做任何迁移。
 *
 * 字段缺失与显式空白必须区分：`{ blocks: [] }` 是“空白画布”，缺失才回退到
 * 主题原始编排或站点级兜底。只有首页与文章页跟着主题走，自定义页面、导航与页脚
 * 仍是站点级。
 *
 * 这里只做纯计算，不引入 `customize.ts`：配置的归一化在主模块里完成。
 */

/** 没有自定义主题 id 时，按档位兜底用的主题键。 */
export const FALLBACK_THEME_ID = 'custom';

/**
 * 版式默认首页的缓存。
 *
 * `defaultHomeLayout` 每次调用都会生成新的区块 id；主题没有原始编排时，投影会在
 * 每次配置读取时用到它。缓存住同一份默认编排（返回副本），区块 id 在会话内稳定，
 * 页面编排器不会因为一次普通配置保存就整棵树换 id。
 */
const defaultHomeLayoutCache = new Map<LayoutVariant, ScreenLayout>();

function defaultHomeFor(variant: LayoutVariant): ScreenLayout {
  let layout = defaultHomeLayoutCache.get(variant);
  if (!layout) {
    layout = defaultHomeLayout(variant);
    defaultHomeLayoutCache.set(variant, layout);
  }
  return JSON.parse(JSON.stringify(layout)) as ScreenLayout;
}

/** 当前生效主题的 id；旧配置没有 active_theme 时按「自定义」处理。 */
export function themeScopeId(customization: Pick<SiteCustomization, 'active_theme'>): string {
  return customization.active_theme || FALLBACK_THEME_ID;
}

/** 读取一套主题自己的覆盖编排；没有条目时返回 undefined。 */
export function themeLayoutFor(
  customization: Pick<SiteCustomization, 'active_theme' | 'theme_layouts'>,
  themeId: string | undefined = customization.active_theme,
): ThemeLayoutEntry | undefined {
  const id = themeId || FALLBACK_THEME_ID;
  return customization.theme_layouts?.[id];
}

/**
 * 主题自带的原始编排。
 *
 * - 主题声明了 `layout`：缺失的那一类用该主题的默认值补齐；
 * - 空白主题：首页与文章页都是空白画布；
 * - 其它主题（内置、旧导入数据）：首页用其版式的默认编排，文章页为空。
 */
export function themeOriginalLayout(
  bundle: SiteTheme | null | undefined,
): ThemeLayoutEntry | undefined {
  if (!bundle) return undefined;
  const declared = bundle.layout ?? {};
  const blank = !bundle.theme && !bundle.variant;
  return {
    home: declared.home ?? (blank ? { blocks: [] } : defaultHomeFor(resolveThemeVariant(bundle))),
    article: declared.article ?? { blocks: [] },
  };
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

/** 删除一套主题的编排覆盖（删除主题或恢复默认时一并清掉）。 */
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
 * - `theme_layouts` 字段缺失：旧版站点级模式，原样返回；
 * - 有覆盖：用覆盖；
 * - 没有覆盖：用主题原始编排（内置默认 / 导入包 / 空白 / 另存快照）；
 * - 连主题都找不到：回退站点级旧值。
 *
 * 调用方拿到的是新对象，不改原始配置，所以读取路径可以放心地反复投影。
 */
export function projectThemeLayouts(customization: SiteCustomization): SiteCustomization {
  if (customization.theme_layouts === undefined) return customization;
  const bundle = themeById(customization.active_theme, customization.themes ?? []);
  const entry = themeLayoutFor(customization);
  const original = themeOriginalLayout(bundle);
  return {
    ...customization,
    home: entry?.home ?? original?.home ?? customization.home,
    article: entry?.article ?? original?.article ?? customization.article,
  };
}
