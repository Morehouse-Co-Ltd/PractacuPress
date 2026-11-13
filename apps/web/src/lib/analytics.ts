import { useEffect, useMemo, useState } from 'react';

/**
 * 站点访问分析（浏览器本地）。
 *
 * 契约 v0.1.0 没有统计端点，所以访问记录保存在当前浏览器，作为服务端统计
 * 不可用时的回退。它足以支撑：
 * - 仪表盘「访问记录」卡片的 24h / 7天 / 30天图表；
 * - 热门文章排序；
 * - 真实后端统计端点可用前的本地预览。
 *
 * 记录只保存路径、页面标题、来源与时间，不保存正文、表单或账户凭据。
 */

export type VisitSurface = 'site' | 'admin';

export interface VisitRecord {
  id: string;
  at: string;
  path: string;
  title: string;
  referrer: string;
  session: string;
  surface: VisitSurface;
}

export interface VisitStats {
  total: number;
  today: number;
  week: number;
  online: number;
  sessions: number;
  todayPaths: number;
  hourly: number[];
  daily: { date: string; count: number }[];
  topPages: { path: string; count: number }[];
  topContent: { id: string; count: number }[];
}

export type AnalyticsRange = '24h' | '7d' | '30d';

export interface RangePoint {
  label: string;
  count: number;
}

export interface RecentVisit {
  path: string;
  title: string;
  referrer: string;
  session: string;
  created_at: string;
}

export interface RangeStats {
  range: AnalyticsRange;
  views: number;
  sessions: number;
  online: number;
  series: RangePoint[];
  topPages: { path: string; count: number }[];
  topContent: { id: string; count: number }[];
  recent: RecentVisit[];
}

/** 真实后端 GET /sites/{id}/analytics 的响应。 */
export interface BackendAnalytics {
  range: AnalyticsRange;
  totals: { views: number; sessions: number; online: number };
  series: RangePoint[];
  top_pages: { path: string; count: number }[];
  top_content: { id: string; count: number }[];
  recent: RecentVisit[];
}

const VISITS_KEY = 'pp.web.visits.v1';
const SESSION_KEY = 'pp.web.session.v1';
const LAST_PATH_KEY = 'pp.web.lastpath.v1';
const SEED_KEY = 'pp.web.visits.seeded.v1';
const EVENT = 'pp:visits-changed';
const MAX_RECORDS = 4000;

function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

function readList(): VisitRecord[] {
  try {
    const raw = localStorage.getItem(VISITS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is VisitRecord => {
      if (!item || typeof item !== 'object') return false;
      const row = item as Partial<VisitRecord>;
      return typeof row.at === 'string' && typeof row.path === 'string';
    });
  } catch {
    return [];
  }
}

function writeList(items: VisitRecord[]) {
  try {
    localStorage.setItem(VISITS_KEY, JSON.stringify(items.slice(0, MAX_RECORDS)));
  } catch {
    /* 存储满了就放弃这一条，不影响页面阅读 */
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

function sessionId(): string {
  try {
    const saved = localStorage.getItem(SESSION_KEY);
    if (saved) return saved;
    const created = `vs_${uuid().slice(0, 12)}`;
    localStorage.setItem(SESSION_KEY, created);
    return created;
  } catch {
    return `vs_${uuid().slice(0, 12)}`;
  }
}

/**
 * 匿名会话标识，供访问统计与阅读量去重共用。
 *
 * 阅读量在服务端累加（FSD A-16），同一个值既写进访问记录，也作为
 * `X-Visit-Session` 头随详情读取发出，于是「一次访问」和「一次阅读」指的是同一次
 * 浏览器会话。它只是去重提示，不是身份凭证。
 */
export function clientSessionId(): string {
  return sessionId();
}

/** 记录一次页面访问；相同路径 5 秒内重复触发（React StrictMode）会被忽略。 */
export function recordVisit(input: {
  path: string;
  title?: string;
  surface: VisitSurface;
}): VisitRecord | null {
  if (typeof window === 'undefined') return null;
  const path = input.path || '/';
  const now = new Date().toISOString();
  const previous = localStorage.getItem(LAST_PATH_KEY) ?? '';
  try {
    localStorage.setItem(LAST_PATH_KEY, path);
  } catch {
    /* 忽略 */
  }

  const items = readList();
  const latest = items[0];
  if (latest && latest.path === path && Date.now() - new Date(latest.at).getTime() < 5000) return null;

  const record: VisitRecord = {
    id: `vis_${uuid().slice(0, 10)}`,
    at: now,
    path,
    title: (input.title || path).slice(0, 160),
    referrer: previous && previous !== path ? previous : document.referrer || '直接访问',
    session: sessionId(),
    surface: input.surface,
  };
  writeList([record, ...items]);
  return record;
}

export function clearVisits(): void {
  try {
    localStorage.removeItem(VISITS_KEY);
  } catch {
    /* 忽略 */
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function subscribeVisits(listener: () => void): () => void {
  const handler = () => listener();
  window.addEventListener(EVENT, handler);
  window.addEventListener('storage', handler);
  return () => {
    window.removeEventListener(EVENT, handler);
    window.removeEventListener('storage', handler);
  };
}

const DEMO_PATHS: { path: string; title: string; weight: number }[] = [
  { path: '/', title: '首页', weight: 8 },
  { path: '/articles', title: '文章归档', weight: 5 },
  { path: '/posts', title: '帖子归档', weight: 3 },
  { path: '/a/cnt_house', title: '为小型刊物建一座自己的房子', weight: 14 },
  { path: '/a/cnt_whitespace', title: '排版的克制：留白不是空', weight: 12 },
  { path: '/a/cnt_community', title: '社区不是评论区', weight: 11 },
  { path: '/a/cnt_workflow', title: '从草稿到发布：一条内容要经过什么', weight: 9 },
  { path: '/a/cnt_white', title: '本站为什么默认白色', weight: 7 },
  { path: '/a/cnt_ledger', title: '独立出版的账本', weight: 6 },
  { path: '/p/pst_nesting', title: '评论嵌套收窄到三层', weight: 4 },
  { path: '/p/pst_rss', title: '还有人用 RSS 读我们吗？', weight: 3 },
  { path: '/search', title: '搜索', weight: 2 },
];

/** 演示模式第一次打开时生成一段可读的访问历史；真实模式不伪造数据。 */
export function ensureDemoVisits(): void {
  try {
    if (localStorage.getItem(SEED_KEY)) return;
    if (readList().length > 0) {
      localStorage.setItem(SEED_KEY, '1');
      return;
    }
  } catch {
    return;
  }

  const now = Date.now();
  const records: VisitRecord[] = [];
  let serial = 0;
  for (let day = 13; day >= 0; day -= 1) {
    const volume = 16 + ((day * 7) % 11);
    for (let index = 0; index < volume; index += 1) {
      const pool: { path: string; title: string }[] = [];
      for (const entry of DEMO_PATHS) {
        for (let n = 0; n < entry.weight; n += 1) pool.push(entry);
      }
      const picked = pool[(serial * 37 + day * 11 + index * 13) % pool.length];
      const at = new Date(now - day * 86_400_000 - (index % 12) * 3_600_000 - (serial % 59) * 60_000);
      records.push({
        id: `vis_seed_${day}_${serial}`,
        at: at.toISOString(),
        path: picked.path,
        title: picked.title,
        referrer: index % 3 === 0 ? '直接访问' : index % 3 === 1 ? '/' : '/articles',
        session: `vs_seed_${day}_${index % 7}`,
        surface: 'site',
      });
      serial += 1;
    }
  }

  // 最近 5 分钟几条记录，让「实时在线」不是零。
  ['/', '/a/cnt_house', '/a/cnt_whitespace'].forEach((path, index) => {
    const entry = DEMO_PATHS.find((row) => row.path === path)!;
    records.push({
      id: `vis_live_${index}`,
      at: new Date(now - (index + 1) * 60_000).toISOString(),
      path,
      title: entry.title,
      referrer: '直接访问',
      session: `vs_live_${index}`,
      surface: 'site',
    });
  });

  records.sort((a, b) => b.at.localeCompare(a.at));
  writeList(records);
  try {
    localStorage.setItem(SEED_KEY, '1');
  } catch {
    /* 忽略 */
  }
}

function dayKey(value: Date): string {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
}

export function contentIdFromPath(path: string): { kind: 'article' | 'post'; id: string } | null {
  const match = path.match(/^\/([ap])\/([^/?#]+)/);
  if (!match) return null;
  return { kind: match[1] === 'a' ? 'article' : 'post', id: match[2] };
}

export function computeVisitStats(visits: VisitRecord[], now = Date.now()): VisitStats {
  const today = dayKey(new Date(now));
  const weekStart = now - 7 * 86_400_000;
  const fiveMinutes = now - 5 * 60_000;
  const sessions = new Set<string>();
  const online = new Set<string>();
  const pageMap = new Map<string, number>();
  const contentMap = new Map<string, number>();
  const dailyMap = new Map<string, number>();
  const hourly = Array.from({ length: 12 }, () => 0);
  let todayCount = 0;
  let weekCount = 0;

  for (const visit of visits) {
    const time = new Date(visit.at).getTime();
    if (Number.isNaN(time)) continue;
    sessions.add(visit.session);
    if (time >= fiveMinutes) online.add(visit.session);
    if (dayKey(new Date(time)) === today) todayCount += 1;
    if (time >= weekStart) weekCount += 1;
    pageMap.set(visit.path, (pageMap.get(visit.path) ?? 0) + 1);
    const content = contentIdFromPath(visit.path);
    if (content) contentMap.set(content.id, (contentMap.get(content.id) ?? 0) + 1);
    const key = dayKey(new Date(time));
    if (time >= now - 7 * 86_400_000) dailyMap.set(key, (dailyMap.get(key) ?? 0) + 1);
    const hoursAgo = Math.floor((now - time) / 3_600_000);
    if (hoursAgo >= 0 && hoursAgo < 12) hourly[11 - hoursAgo] += 1;
  }

  const daily = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(now - (6 - index) * 86_400_000);
    const key = dayKey(date);
    return { date: key.slice(5), count: dailyMap.get(key) ?? 0 };
  });

  return {
    total: visits.length,
    today: todayCount,
    week: weekCount,
    online: online.size,
    sessions: sessions.size,
    todayPaths: new Set(visits.filter((visit) => dayKey(new Date(visit.at)) === today).map((visit) => visit.path)).size,
    hourly,
    daily,
    topPages: [...pageMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([path, count]) => ({ path, count })),
    topContent: [...contentMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([id, count]) => ({ id, count })),
  };
}

/**
 * 仪表盘范围统计：24 小时按小时、7 天/30 天按天分桶。
 * 传入的访问记录应已经按前台/后台筛选。
 */
export function computeRangeStats(
  visits: VisitRecord[],
  range: AnalyticsRange,
  now = Date.now(),
): RangeStats {
  const online = new Set<string>();
  const sessions = new Set<string>();
  const pageMap = new Map<string, number>();
  const contentMap = new Map<string, number>();
  let views = 0;
  let series: RangePoint[] = [];
  let startTime = 0;

  if (range === '24h') {
    const currentHour = new Date(now);
    currentHour.setMinutes(0, 0, 0);
    const start = currentHour.getTime() - 23 * 3_600_000;
    startTime = start;
    series = Array.from({ length: 24 }, (_, index) => {
      const point = new Date(start + index * 3_600_000);
      return {
        label: `${String(point.getHours()).padStart(2, '0')}:00`,
        count: 0,
      };
    });
    for (const visit of visits) {
      const time = new Date(visit.at).getTime();
      if (Number.isNaN(time) || time < start) continue;
      const index = Math.min(23, Math.max(0, Math.floor((time - start) / 3_600_000)));
      series[index].count += 1;
      views += 1;
      sessions.add(visit.session);
      if (time >= now - 5 * 60_000) online.add(visit.session);
      pageMap.set(visit.path, (pageMap.get(visit.path) ?? 0) + 1);
      const content = contentIdFromPath(visit.path);
      if (content) contentMap.set(content.id, (contentMap.get(content.id) ?? 0) + 1);
    }
  } else {
    const days = range === '7d' ? 7 : 30;
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    const start = today.getTime() - (days - 1) * 86_400_000;
    startTime = start;
    series = Array.from({ length: days }, (_, index) => {
      const point = new Date(start + index * 86_400_000);
      return {
        label: `${point.getMonth() + 1}/${point.getDate()}`,
        count: 0,
      };
    });
    for (const visit of visits) {
      const time = new Date(visit.at).getTime();
      if (Number.isNaN(time) || time < start) continue;
      const index = Math.min(days - 1, Math.max(0, Math.floor((time - start) / 86_400_000)));
      series[index].count += 1;
      views += 1;
      sessions.add(visit.session);
      if (time >= now - 5 * 60_000) online.add(visit.session);
      pageMap.set(visit.path, (pageMap.get(visit.path) ?? 0) + 1);
      const content = contentIdFromPath(visit.path);
      if (content) contentMap.set(content.id, (contentMap.get(content.id) ?? 0) + 1);
    }
  }

  return {
    range,
    views,
    sessions: sessions.size,
    online: online.size,
    series,
    topPages: [...pageMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([path, count]) => ({ path, count })),
    topContent: [...contentMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([id, count]) => ({ id, count })),
    recent: visits
      .filter((visit) => {
        const time = new Date(visit.at).getTime();
        return !Number.isNaN(time) && time >= startTime;
      })
      .slice()
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, 10)
      .map((visit) => ({
        path: visit.path,
        title: visit.title,
        referrer: visit.referrer,
        session: visit.session,
        created_at: visit.at,
      })),
  };
}

/** 组件用的访问数据：跨标签页同步，每 15 秒刷新「在线」。 */
export function useVisits(): { visits: VisitRecord[]; stats: VisitStats } {
  const [visits, setVisits] = useState<VisitRecord[]>(() =>
    typeof window === 'undefined' ? [] : readList(),
  );
  const [, setTick] = useState(0);

  useEffect(() => {
    const refresh = () => setVisits(readList());
    refresh();
    const unsubscribe = subscribeVisits(refresh);
    const timer = window.setInterval(() => {
      setTick((value) => value + 1);
      refresh();
    }, 15_000);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, []);

  const stats = useMemo(() => computeVisitStats(visits), [visits]);
  return { visits, stats };
}

/** 内容 ID → 阅读次数（只统计站内文章/帖子详情页）。 */
export function viewCounts(visits: VisitRecord[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const visit of visits) {
    const content = contentIdFromPath(visit.path);
    if (!content) continue;
    map.set(content.id, (map.get(content.id) ?? 0) + 1);
  }
  return map;
}
