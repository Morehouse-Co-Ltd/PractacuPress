import { useLayoutEffect, type ReactNode } from 'react';
import { themeCss, useCustomization } from '../lib/customize';
import { applySoftenAttributes, applyThemeMode } from '../lib/theme';
import { useThemePreference } from '../lib/themePreference';

const STYLE_ID = 'pp-theme';
const ICON_SELECTOR = 'link[rel="icon"]';

/** 把外观设置写成 CSS 变量，并把明暗模式写到 <html data-mode>。 */
export function CustomizationLayer({ children }: { children: ReactNode }) {
  const { customization } = useCustomization();
  // Cookie 里的个人偏好优先于站点主题的默认模式；两者都写进同一份 CSS 变量，
  // 所以切主题时不需要替换样式表，也不会出现半秒的「灰底黑字」。
  const preference = useThemePreference();
  const mode = preference ?? customization.theme.mode;

  useLayoutEffect(() => {
    let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      document.head.appendChild(el);
    }
    el.textContent = themeCss(customization, mode);
    applyThemeMode(mode);
    // 后台自己管明暗：data-mode 仍是站点偏好，但原生控件（滚动条、表单）要用后台
    // 当前模式的 color-scheme，否则深色后台里会冒出浅色滚动条。
    const surface = document.documentElement.dataset.surface;
    const adminTheme = document.documentElement.dataset.adminTheme;
    document.documentElement.style.colorScheme =
      surface === 'admin' ? (adminTheme === 'dark' ? 'dark' : 'light') : mode;
    applySoftenAttributes(customization.theme);
    // 版式变体也写到 <html>：页头、浮层这些在首页容器之外的元素需要跟着变。
    document.documentElement.dataset.variant = customization.layout.variant;

    // 站点图标：留空时回到 index.html 里的默认图标。
    const icon = (customization.layout.site_icon ?? '').trim();
    let link = document.querySelector<HTMLLinkElement>(ICON_SELECTOR);
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    if (!link.dataset.ppDefaultIcon) {
      link.dataset.ppDefaultIcon = link.getAttribute('href') ?? '';
    }
    link.href = /^https?:\/\//i.test(icon) || icon.startsWith('/') ? icon : link.dataset.ppDefaultIcon;
  }, [customization, mode]);

  return <>{children}</>;
}
