import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { THEME_PREVIEW_PARAM, documentPreviewToken } from '../lib/themePreviewLive';

/**
 * 把主题预览的参数钉在地址上。
 *
 * 站内跳转是 pushState，不会带上开头的 `?pp_theme_preview=`；参数一旦丢失，
 * 在这个 iframe 里刷新就会退回未套用主题的站点。这里在每次路由变化后把令牌补回
 * 查询串——只改浏览器地址，不触发额外渲染，也不影响后台窗口（那里没有令牌）。
 */
export function ThemePreviewParamKeeper() {
  const location = useLocation();

  useEffect(() => {
    const token = documentPreviewToken();
    if (!token) return;
    const params = new URLSearchParams(location.search);
    if (params.get(THEME_PREVIEW_PARAM) === token) return;
    params.set(THEME_PREVIEW_PARAM, token);
    const search = params.toString();
    window.history.replaceState(
      window.history.state,
      '',
      `${location.pathname}${search ? `?${search}` : ''}${location.hash}`,
    );
  }, [location.pathname, location.search, location.hash]);

  return null;
}
