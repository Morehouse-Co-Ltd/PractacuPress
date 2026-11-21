import type { SiteTheme } from '../types';
import { useCustomization } from './customize';
import { t } from './i18n';
import { useToast } from './toast';
import { themeApplyPatch, type ThemeApplyResult } from './themeApply';
import { resolveThemeVariant, variantLabel } from './themes';

/**
 * 套用「大主题」的共享逻辑。
 *
 * 「选择主题」页负责挑选主题，「主题设置」页负责微调与恢复默认，两边都要把一套
 * 主题写回站点配置，因此把「主题 → 配置补丁」和「切换 + 提示」放在这里，避免
 * 两个页面各写一份、日后再各改一份。
 *
 * 纯计算部分在 `themeApply.ts`：真实前台预览也要用它，而预览的覆盖点
 * （`readCustomization`）不能反过来依赖这里。
 */

export {
  cloneTheme,
  sameLayout,
  themeApplyPatch,
  type ThemeApplyResult,
} from './themeApply';

/** 切换主题（含成功提示）；`announce=false` 时不弹提示，交给调用方说明结果。 */
export function useThemeSwitch(): { applyBundle: (bundle: SiteTheme, announce?: boolean) => void } {
  const { customization, update } = useCustomization();
  const toast = useToast();

  const applyBundle = (bundle: SiteTheme, announce = true) => {
    const { patch, homeWasDefault }: ThemeApplyResult = themeApplyPatch(customization, bundle);
    update(patch);
    if (!announce) return;
    toast.push(
      'ok',
      t('已切换到「{name}」', { name: bundle.name }),
      homeWasDefault
        ? t('配色、排版与{layout}版式已切换，这套主题的默认首页编排也一起写入。', {
            layout: variantLabel(resolveThemeVariant(bundle)),
          })
        : t('配色、排版与{layout}版式已切换；首页与文章页编排跟随主题，已有编排不会丢失。', {
            layout: variantLabel(resolveThemeVariant(bundle)),
          }),
    );
  };

  return { applyBundle };
}
