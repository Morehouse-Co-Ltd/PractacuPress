import { useEffect, useLayoutEffect, useMemo, type ReactNode } from 'react';
import { useAuth } from '../lib/session';
import { applyMotionPreference, readPerformance } from '../lib/performance';

/**
 * 把性能设置写进文档：动效降级标记与外部来源 preconnect。
 *
 * 这些是纯浏览器侧动作，不重新创建后端实例；服务器缓存、压缩与连接池参数
 * 在「性能优化」页生成，需部署方应用。
 */
export function SiteSettingsLayer({ children }: { children: ReactNode }) {
  const { config } = useAuth();
  const performance = useMemo(() => readPerformance(config), [config]);

  useLayoutEffect(() => {
    applyMotionPreference(performance);
  }, [performance]);

  useEffect(() => {
    const head = document.head;
    const existing = head.querySelectorAll('link[data-pp-preconnect]');
    existing.forEach((node) => node.remove());

    const ownOrigin = window.location.origin;
    const seen = new Set<string>();
    for (const origin of performance.preconnect) {
      if (seen.has(origin) || origin === ownOrigin) continue;
      seen.add(origin);
      const preconnect = document.createElement('link');
      preconnect.rel = 'preconnect';
      preconnect.href = origin;
      preconnect.dataset.ppPreconnect = '1';
      head.appendChild(preconnect);

      const dns = document.createElement('link');
      dns.rel = 'dns-prefetch';
      dns.href = origin;
      dns.dataset.ppPreconnect = '1';
      head.appendChild(dns);
    }

    return () => {
      head.querySelectorAll('link[data-pp-preconnect]').forEach((node) => node.remove());
    };
  }, [performance]);

  return <>{children}</>;
}
