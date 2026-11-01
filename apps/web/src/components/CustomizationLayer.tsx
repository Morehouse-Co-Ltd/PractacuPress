import { useLayoutEffect, type ReactNode } from 'react';
import { themeCss, useCustomization } from '../lib/customize';
import { applySoftenAttributes, applyThemeMode } from '../lib/theme';

const STYLE_ID = 'pp-theme';
const ICON_SELECTOR = 'link[rel="icon"]';

/** 把外观设置写成 CSS 变量，并把明暗模式写到 <html data-mode>。 */
export function CustomizationLayer({ children }: { children: ReactNode }) {
  const { customization } = useCustomization();

  useLayoutEffect(() => {
    let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!el) {
      el = document.createElement('style');
      el.id = STYLE_ID;
      document.head.appendChild(el);
    }
    el.textContent = themeCss(customization);
    applyThemeMode(customization.theme.mode);
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
  }, [customization]);

  return <>{children}</>;
}
