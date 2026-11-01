import { useEffect, useMemo, useState } from 'react';
import { useAuth } from './session';
import { isDemo, useBackend } from './backend';
import {
  computeRangeStats,
  useVisits,
  type AnalyticsRange,
  type RangeStats,
} from './analytics';

/**
 * 仪表盘统计：真实后端可用时使用服务端数据，否则回退到本地访问记录。
 * 本地记录仍会让演示模式、离线预览和未部署统计端点的旧后端保持可用。
 */
export function useRangeAnalytics(
  range: AnalyticsRange,
  useServer = true,
): {
  stats: RangeStats;
  source: 'backend' | 'local';
  loading: boolean;
} {
  const { me } = useAuth();
  const backend = useBackend();
  const { visits } = useVisits();
  const demo = isDemo(backend);
  const siteId = me?.site_id ?? '';
  const localVisits = useMemo(() => visits.filter((visit) => visit.surface === 'site'), [visits]);
  const local = useMemo(() => computeRangeStats(localVisits, range), [localVisits, range]);
  const [remote, setRemote] = useState<RangeStats | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (demo || !siteId || !useServer) {
      setRemote(null);
      setLoading(false);
      return;
    }
    let alive = true;
    setRemote(null);
    setLoading(true);
    backend
      .analytics(siteId, range)
      .then((data) => {
        if (!alive) return;
        if (!data) {
          setRemote(null);
          return;
        }
        setRemote({
          range: data.range,
          views: data.totals.views,
          sessions: data.totals.sessions,
          online: data.totals.online,
          series: data.series,
          topPages: data.top_pages,
          topContent: data.top_content,
          recent: data.recent ?? [],
        });
      })
      .catch(() => {
        if (alive) setRemote(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [backend, demo, range, siteId, useServer]);

  return { stats: remote ?? local, source: remote ? 'backend' : 'local', loading };
}
