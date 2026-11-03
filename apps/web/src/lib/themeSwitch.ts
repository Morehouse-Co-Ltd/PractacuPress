import type { SiteCustomization, SiteTheme } from '../types';
import { defaultHomeLayout } from './blocks';
import { useCustomization } from './customize';
import { t } from './i18n';
import { useToast } from './toast';

/**
 * 套用「大主题」的共享逻辑。
 *
 * 「选择主题」页负责挑选主题，「主题设置」页负责微调与恢复默认，两边都要把一套
 * 主题写回站点配置，因此把「主题 → 配置补丁」和「切换 + 提示」放在这里，避免
 * 两个页面各写一份、日后再各改一份。
 */

/** 复制主题配置，避免把 tokens 的引用写回配置。 */
export function cloneTheme(theme: SiteTheme['theme']): SiteTheme['theme'] {
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
  /** 首页是否跟着版式一起换成了该主题的默认编排。 */
  homeWasDefault: boolean;
}

/**
 * 套用一套主题时的配置补丁。
 *
 * 只有首页仍是最初的默认编排时才跟着版式换一套；站长自己排过的组件不动。
 */
export function themeApplyPatch(
  customization: SiteCustomization,
  bundle: SiteTheme,
): ThemeApplyResult {
  const homeWasDefault =
    bundle.variant !== customization.layout.variant &&
    sameLayout(customization.home, defaultHomeLayout(customization.layout.variant));
  return {
    homeWasDefault,
    patch: {
      theme: cloneTheme(bundle.theme),
      layout: { ...customization.layout, variant: bundle.variant },
      ...(homeWasDefault ? { home: defaultHomeLayout(bundle.variant) } : {}),
      active_theme: bundle.id,
    },
  };
}

/** 切换主题（含成功提示）；`announce=false` 时不弹提示，交给调用方说明结果。 */
export function useThemeSwitch(): { applyBundle: (bundle: SiteTheme, announce?: boolean) => void } {
  const { customization, update } = useCustomization();
  const toast = useToast();

  const applyBundle = (bundle: SiteTheme, announce = true) => {
    const { patch, homeWasDefault } = themeApplyPatch(customization, bundle);
    update(patch);
    if (!announce) return;
    toast.push(
      'ok',
      t('已切换到「{name}」', { name: bundle.name }),
      homeWasDefault
        ? t('配色、排版与{layout}版式已一起切换，首页也同步为该主题的默认编排。', {
            layout: bundle.variant === 'bento' ? t('双栏') : t('单栏'),
          })
        : bundle.variant === 'bento'
          ? t('配色、排版与双栏版式已一起切换；已有首页编排不会删除，可在页面编排里继续调整。')
          : t('配色、排版与单栏版式已一起切换；已有首页编排不会删除。'),
    );
  };

  return { applyBundle };
}
