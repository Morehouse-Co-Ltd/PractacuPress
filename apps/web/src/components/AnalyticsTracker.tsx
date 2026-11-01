import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { ensureDemoVisits, recordVisit } from '../lib/analytics';
import { useAuth } from '../lib/session';
import { useBackend } from '../lib/backend';

/**
 * 记录页面访问。放在 Router 内部，路径变化时写入一条访问记录。
 * 标题由页面自己的 useTitle 写入，所以延迟一拍再读取，避免记录成上一个页面。
 *
 * 本地记录始终保留（仪表盘在离线或旧后端时回退使用）；连接真实后端时
 * 还会异步写入服务端统计端点，失败不阻塞页面。
 */
export function AnalyticsTracker({ demo }: { demo: boolean }) {
  const location = useLocation();
  const backend = useBackend();
  const { me } = useAuth();
  const siteId = me?.site_id ?? '';

  useEffect(() => {
    if (demo) ensureDemoVisits();
  }, [demo]);

  useEffect(() => {
    const path = `${location.pathname}${location.search}`;
    if (path.startsWith('/setup')) return;
    const surface = location.pathname.startsWith('/admin') ? 'admin' : 'site';
    const timer = window.setTimeout(() => {
      const record = recordVisit({
        path,
        title: document.title.replace(/\s*·\s*Practacu Press\s*$/, ''),
        surface,
      });
      if (!demo && record && siteId) {
        void backend
          .recordVisit({
            path: record.path,
            title: record.title,
            referrer: record.referrer,
            session: record.session,
            surface: record.surface,
          })
          .catch(() => {
            /* 统计端点不可用时不打断浏览 */
          });
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [backend, demo, location.pathname, location.search, siteId]);

  return null;
}
