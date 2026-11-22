import type { SiteCustomization, SiteTheme } from '../types';
import { resolveThemeSettings, resolveThemeVariant } from './themes';

/**
 * 套用「大主题」的纯计算部分。
 *
 * 单独放在这里，是为了让 `readCustomization`（预览覆盖）与页面里的切换按钮
 * 共用同一份补丁逻辑，同时不把 `useCustomization` 拉进纯函数模块里——
 * 否则 `customize.ts → themeSwitch.ts → customize.ts` 会绕成循环依赖。
 */

/** 复制主题配置，避免把 tokens 的引用写回配置。空白主题原样返回 undefined。 */
export function cloneTheme(theme: SiteTheme['theme']): SiteTheme['theme'] {
  if (!theme) return theme;
  return {
    ...theme,
    tokens: theme.tokens ? { ...theme.tokens } : undefined,
  };
}

/** 比较编排时忽略随机 id，避免默认首页因为新建区块 id 不同而被判成自定义。 */
export function sameLayout(a: unknown, b: unknown): boolean {
  return JSON.stringify(withoutBlockIds(a)) === JSON.stringify(withoutBlockIds(b));
}

function withoutBlockIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutBlockIds);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'id') continue;
    out[key] = withoutBlockIds(item);
  }
  return out;
}

export interface ThemeApplyResult {
  patch: Partial<SiteCustomization>;
}

/**
 * 套用一套主题时的配置补丁。
 *
 * 配色/版式取解析后的值（空白主题回落到内置「原版」）；首页/文章页编排在读取时
 * 由 `theme_layouts` 投影：有用户覆盖用覆盖，否则用主题自带的原始编排。这里只负责
 * 切主题，并把 `theme_layouts` 标记为已启用（旧站点第一次切换后进入按主题模式）。
 */
export function themeApplyPatch(
  customization: SiteCustomization,
  bundle: SiteTheme,
): ThemeApplyResult {
  return {
    patch: {
      theme: cloneTheme(resolveThemeSettings(bundle)),
      layout: { ...customization.layout, variant: resolveThemeVariant(bundle) },
      active_theme: bundle.id,
      theme_layouts: customization.theme_layouts ?? {},
    },
  };
}
