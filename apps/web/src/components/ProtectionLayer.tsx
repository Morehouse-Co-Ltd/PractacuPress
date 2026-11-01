import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/session';
import {
  accessController,
  isPreviewFrame,
  readAccess,
  useAccessSnapshot,
} from '../lib/access';
import { useSiteTabPresence } from '../lib/tabPresence';
import { Icon } from './Icon';

/**
 * 访问限制的浏览器端执行层。
 *
 * - 页面切换：路由变化时计数，超限后显示倒计时拦截；
 * - 请求：Backend 代理在发请求前调用同一个控制器；
 * - 并发页面：同浏览器标签心跳超过上限时拦住最新打开的站点标签。
 *
 * 管理后台、安装向导和编排预览一律豁免；拦截页始终提供后台入口，避免站长
 * 把自己锁在门外。
 */

const COPY: Record<
  'page_switch' | 'request' | 'tabs',
  { title: string; body: string }
> = {
  page_switch: {
    title: '切换页面过于频繁',
    body: '短时间内打开或切换了太多页面。这通常是脚本或自动化访问的特征。',
  },
  request: {
    title: '请求过于频繁',
    body: '站点脚本在短时间内发起了太多请求。为了保护服务器，已暂时停止响应。',
  },
  tabs: {
    title: '同时打开的页面过多',
    body: '同一浏览器同时打开了太多站点页面。关闭其他页面后会自动恢复。',
  },
};

function AccessBlocked({
  reason,
  message,
  retryAfterMs,
  tabCount,
  tabLimit,
  adminPath,
}: {
  reason: 'page_switch' | 'request' | 'tabs';
  message: string;
  retryAfterMs: number;
  tabCount: number;
  tabLimit: number;
  adminPath: string;
}) {
  const copy = COPY[reason];
  const seconds = Math.max(0, Math.ceil(retryAfterMs / 1000));
  return (
    <div className="access-block-screen" role="alertdialog" aria-modal="true" aria-label={copy.title}>
      <div className="access-block-card">
        <span className="access-block-icon">
          <Icon name="shield" size={22} />
        </span>
        <p className="eyebrow">Access limited</p>
        <h1>{copy.title}</h1>
        <p className="access-block-message">{message || copy.body}</p>
        {reason === 'tabs' ? (
          <div className="access-block-counter">
            <strong>{tabCount}</strong>
            <span>/ {tabLimit} 个页面</span>
          </div>
        ) : (
          <div className="access-block-counter">
            <strong>{seconds}</strong>
            <span>秒后可继续访问</span>
          </div>
        )}
        <div className="access-block-bar" aria-hidden>
          <span />
        </div>
        <p className="small faint access-block-hint">
          {reason === 'tabs'
            ? '关闭其他站点标签页后，本页会自动恢复。'
            : '倒计时结束后会自动恢复；如果页面数据没有加载出来，请重新载入。'}
        </p>
        <div className="row gap-8 access-block-actions">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={() => window.location.reload()}
          >
            <Icon name="refresh" size={14} /> 重新载入
          </button>
          <Link to={adminPath} className="btn btn-ghost btn-sm">
            <Icon name="lock" size={14} /> 进入管理后台
          </Link>
        </div>
        <p className="tiny faint">
          这是浏览器端保护。服务器与网关仍会按 IP 执行请求与并发限制。
        </p>
      </div>
    </div>
  );
}

export function ProtectionLayer({ children }: { children: ReactNode }) {
  const { config } = useAuth();
  const location = useLocation();
  const settings = useMemo(() => readAccess(config), [config]);
  const snapshot = useAccessSnapshot(1000);
  const tabs = useSiteTabPresence(settings.enabled && settings.tabs.enabled, settings.tabs.limit);
  const first = useRef(true);
  const counted = useRef('');

  useLayoutEffect(() => {
    accessController.configure(settings, config.admin_path);
  }, [settings, config.admin_path]);

  // 页面切换计数：只在真实路径变化时记一次，初始渲染与后台不记。
  useEffect(() => {
    const key = `${location.pathname}${location.search}`;
    if (first.current) {
      first.current = false;
      counted.current = key;
      return;
    }
    if (counted.current === key) return;
    counted.current = key;
    if (isPreviewFrame()) return;
    if (!accessController.isAdminPath(location.pathname)) {
      accessController.checkPageSwitch(location.pathname);
    }
  }, [location.pathname, location.search]);

  const adminPath = (config.admin_path?.trim() || '/admin').replace(/\/+$/, '') || '/admin';
  const siteSurface =
    !isPreviewFrame() &&
    !accessController.isAdminPath(location.pathname) &&
    location.pathname !== '/setup' &&
    !location.pathname.startsWith('/setup/');

  const tabBlocked =
    siteSurface && settings.enabled && settings.tabs.enabled && tabs.over;
  const reason = tabBlocked ? 'tabs' : siteSurface ? snapshot.reason : null;

  useEffect(() => {
    if (!reason) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [reason]);

  const overlay =
    reason && typeof document !== 'undefined'
      ? createPortal(
          <AccessBlocked
            reason={reason}
            message={snapshot.message}
            retryAfterMs={snapshot.retryAfterMs}
            tabCount={tabs.count}
            tabLimit={settings.tabs.limit}
            adminPath={adminPath}
          />,
          document.body,
        )
      : null;

  return (
    <>
      {children}
      {overlay}
    </>
  );
}
