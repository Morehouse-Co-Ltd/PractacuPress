import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../lib/session';
import { useCustomization } from '../lib/customize';
import { accessController, isPreviewFrame } from '../lib/access';
import {
  loadingApproach,
  loadingPalette,
  readLoading,
  skeletonMotion,
} from '../lib/loading';
import { resolveTokens } from '../lib/theme';
import { LoadingScene } from './LoadingScene';
import { PageSkeletonProvider } from './SkeletonMode';

/**
 * 前台加载方式。
 *
 * 全屏预设：首次加载与站内切换页面可以分别开关，显示遮罩。
 * 骨架预设：不盖遮罩，页面结构立即出现；内容区由各页面/区块自己的 loading
 * 状态渲染原位骨架，数据到达后原地替换。
 * 管理后台、安装向导和编排预览不进入这两种模式。
 */
export function LoadingLayer({ children }: { children: ReactNode }) {
  const { config } = useAuth();
  const location = useLocation();
  const { customization } = useCustomization();
  const settings = useMemo(() => readLoading(config), [config]);
  const tokens = useMemo(() => resolveTokens(customization.theme), [customization.theme]);
  const palette = useMemo(
    () =>
      loadingPalette(settings, {
        background: tokens.background,
        ink: tokens.ink,
        accent: tokens.accent,
      }),
    [settings, tokens],
  );

  const suppressed =
    isPreviewFrame() ||
    location.pathname === '/setup' ||
    location.pathname.startsWith('/setup/') ||
    accessController.isAdminPath(location.pathname);

  const approach = suppressed ? 'off' : loadingApproach(settings);
  const motion = approach === 'skeleton' ? skeletonMotion(settings) : null;
  const overlayActive = approach === 'overlay';

  const initiallyVisible =
    !suppressed && overlayActive && settings.show_on_first_load;
  const [visible, setVisible] = useState(initiallyVisible);
  const timer = useRef<number | null>(null);
  const lastPath = useRef(`${location.pathname}${location.search}`);
  const firstLoadKey = `${approach}|${settings.show_on_first_load}|${settings.min_duration_ms}`;

  const clearTimer = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const show = () => {
    clearTimer();
    setVisible(true);
    timer.current = window.setTimeout(() => {
      setVisible(false);
      timer.current = null;
    }, Math.max(0, Math.min(3000, settings.min_duration_ms)));
  };

  // 首次加载：只在「加载方式 / 首次是否显示 / 最短时长」变化时重新触发。
  // 这样改域名或访问限制不会让正在展示的加载画面卡住，也不会让它重新弹出。
  useEffect(() => {
    if (suppressed || !overlayActive || !settings.show_on_first_load) {
      clearTimer();
      setVisible(false);
      return;
    }
    show();
    return clearTimer;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstLoadKey, suppressed]);

  // 离开页面时清掉可能由站内导航启动的计时器。
  useEffect(() => () => clearTimer(), []);

  // 站内导航：路径变化时才展示，避免无关重渲染反复触发。
  useEffect(() => {
    const key = `${location.pathname}${location.search}`;
    if (lastPath.current === key) return;
    lastPath.current = key;
    if (suppressed || !overlayActive || !settings.show_on_navigation) return;
    show();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname, location.search, settings, suppressed, overlayActive]);

  // 原位骨架：把动效写进 <html>，CSS 据此驱动所有占位块；强调色用作扫光高光。
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const root = document.documentElement;
    if (!motion) {
      delete root.dataset.ppSkeleton;
      root.style.removeProperty('--pp-skel-glint');
      return;
    }
    root.dataset.ppSkeleton = motion;
    if (settings.accent_mode === 'custom') {
      root.style.setProperty('--pp-skel-glint', settings.accent);
    } else {
      root.style.removeProperty('--pp-skel-glint');
    }
    return () => {
      delete root.dataset.ppSkeleton;
      root.style.removeProperty('--pp-skel-glint');
    };
  }, [motion, settings.accent_mode, settings.accent]);

  const showOverlay = visible && overlayActive && typeof document !== 'undefined';

  return (
    <PageSkeletonProvider motion={motion}>
      {children}
      {motion && settings.custom_css ? (
        <style data-pp-skeleton-css>{settings.custom_css}</style>
      ) : null}
      {showOverlay
        ? createPortal(
            <div
              className="pp-loading-overlay"
              role="status"
              aria-live="polite"
              style={
                {
                  '--pp-loading-bg': palette.background,
                  '--pp-loading-ink': palette.ink,
                  '--pp-loading-accent': palette.accent,
                } as CSSProperties
              }
            >
              <LoadingScene settings={settings} palette={palette} />
              {settings.custom_css ? (
                <style data-pp-loading-css>{settings.custom_css}</style>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </PageSkeletonProvider>
  );
}
