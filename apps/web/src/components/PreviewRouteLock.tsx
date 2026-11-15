import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { isPreviewFrame } from '../lib/access';
import { documentPreviewToken } from '../lib/themePreviewLive';

/**
 * 页面编排预览的「路由锁」。
 *
 * 站内链接由 `PreviewBridge` 在点击时拦下，但命令面板、按钮与区块里的脚本会直接调
 * `navigate()`——那类跳转不经过点击事件，需要按路由变化兜底：一旦预览 iframe 离开
 * 打开它时的那一页，就 replace 回去，并通知父窗口提示站长。
 *
 * 挂在 `<HistoryRouter>` 里、`<Routes>` 外：跳到后台页面时 `SiteChrome` 会整个卸载
 * （`PreviewBridge` 也跟着没了），只有这一层还能把它拉回来。
 *
 * 普通前台页面不在 iframe 里，这里什么都不做。
 */
export function PreviewRouteLock() {
  const location = useLocation();
  const navigate = useNavigate();
  const lockedPath = useRef<string | null>(null);
  const pathname = location.pathname;

  useEffect(() => {
    if (!isPreviewFrame()) return;
    // 主题「真实前台预览」不是页面编排器：它需要能离开初始页面。
    if (documentPreviewToken()) return;
    // 第一次拿到的是预览刚打开时的那一页，作为锁定的目标。
    if (lockedPath.current === null) {
      lockedPath.current = pathname;
      return;
    }
    if (pathname === lockedPath.current) return;
    navigate(lockedPath.current, { replace: true });
    window.parent.postMessage({ type: 'pp:preview-nav-blocked' }, window.location.origin);
  }, [pathname, navigate]);

  return null;
}
