import { useEffect, useMemo, useState } from 'react';
import { accessController, isPreviewFrame } from './access';

/**
 * 同浏览器标签页计数。
 *
 * 用 BroadcastChannel 实时广播，localStorage 作为关闭窗口后的兜底。浏览器无法
 * 看到“同一 IP 的其他设备”，所以这里只负责同浏览器并发；按 IP 的并发连接由
 * 网关的 `limit_conn` 执行（配置片段在访问限制页）。
 *
 * 只统计前台标签页：后台和预览 iframe 不占名额，也不会被这条规则拦住。
 */

const CHANNEL = 'pp-tabs-v1';
const STORE_KEY = 'pp.tabs.v1';
const TAB_ID_KEY = 'pp.tab.id.v1';
const TAB_JOINED_KEY = 'pp.tab.joined.v1';
const HEARTBEAT_MS = 4000;
const STALE_MS = 15000;

type Surface = 'site' | 'admin';

interface TabInfo {
  id: string;
  at: number;
  joined: number;
  surface: Surface;
}

interface TabPresence {
  count: number;
  /** 当前标签在站点标签里的年龄排名，0 表示最早打开。 */
  rank: number;
  over: boolean;
  limit: number;
}

function safeSession(key: string): string {
  try {
    return window.sessionStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function safeSessionSet(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    /* 隐私模式忽略 */
  }
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function readStore(): Record<string, TabInfo> {
  try {
    const raw = window.localStorage.getItem(STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, TabInfo>;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, TabInfo> = {};
    for (const [id, info] of Object.entries(parsed)) {
      if (
        info &&
        typeof info.at === 'number' &&
        typeof info.joined === 'number' &&
        (info.surface === 'site' || info.surface === 'admin')
      ) {
        out[id] = { ...info, id };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function writeStore(tabs: Record<string, TabInfo>): void {
  try {
    window.localStorage.setItem(STORE_KEY, JSON.stringify(tabs));
  } catch {
    /* 存储不可用时退化为 BroadcastChannel */
  }
}

function removeFromStore(id: string): void {
  const tabs = readStore();
  if (!(id in tabs)) return;
  delete tabs[id];
  writeStore(tabs);
}

function reportTab(info: TabInfo): void {
  const tabs = readStore();
  tabs[info.id] = info;
  const now = Date.now();
  for (const [id, item] of Object.entries(tabs)) {
    if (now - item.at > STALE_MS) delete tabs[id];
  }
  writeStore(tabs);
}

function siteTabs(tabs: Record<string, TabInfo>): TabInfo[] {
  const now = Date.now();
  return Object.values(tabs)
    .filter((item) => item.surface === 'site' && now - item.at <= STALE_MS)
    .sort((a, b) => a.joined - b.joined || a.id.localeCompare(b.id));
}

export function useSiteTabPresence(enabled: boolean, limit: number): TabPresence {
  const [tabs, setTabs] = useState<Record<string, TabInfo>>({});
  const selfId = useMemo(() => {
    const existing = safeSession(TAB_ID_KEY);
    if (existing) return existing;
    const id = makeId();
    safeSessionSet(TAB_ID_KEY, id);
    return id;
  }, []);
  const joined = useMemo(() => {
    const existing = Number(safeSession(TAB_JOINED_KEY));
    if (Number.isFinite(existing) && existing > 0) return existing;
    const value = Date.now();
    safeSessionSet(TAB_JOINED_KEY, String(value));
    return value;
  }, []);

  useEffect(() => {
    if (!enabled || isPreviewFrame()) return;

    let channel: BroadcastChannel | null = null;
    try {
      channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(CHANNEL) : null;
    } catch {
      channel = null;
    }

    const surface = (): Surface =>
      accessController.isAdminPath(window.location.pathname) ||
      document.documentElement.dataset.surface === 'admin'
        ? 'admin'
        : 'site';

    const info = (): TabInfo => ({
      id: selfId,
      at: Date.now(),
      joined,
      surface: surface(),
    });

    const beat = () => {
      const next = info();
      reportTab(next);
      channel?.postMessage({ type: 'ping', tab: next });
      setTabs(readStore());
    };

    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; tab?: TabInfo } | null;
      if (!data) return;
      if (data.type === 'bye' && data.tab?.id) {
        removeFromStore(data.tab.id);
        setTabs(readStore());
        return;
      }
      if (data.type === 'ping' && data.tab?.id) {
        const tabsNow = readStore();
        tabsNow[data.tab.id] = data.tab;
        writeStore(tabsNow);
        setTabs(tabsNow);
      }
    };

    const onPageHide = () => {
      try {
        channel?.postMessage({ type: 'bye', tab: info() });
      } catch {
        /* 关闭过程中允许失败 */
      }
      removeFromStore(selfId);
    };

    channel?.addEventListener('message', onMessage);
    beat();
    const timer = window.setInterval(beat, HEARTBEAT_MS);
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORE_KEY) setTabs(readStore());
    };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onPageHide);
    window.addEventListener('storage', onStorage);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onPageHide);
      window.removeEventListener('storage', onStorage);
      channel?.removeEventListener('message', onMessage);
      try {
        channel?.postMessage({ type: 'bye', tab: info() });
      } catch {
        /* 忽略 */
      }
      channel?.close();
      removeFromStore(selfId);
    };
  }, [enabled, joined, selfId]);

  const ordered = siteTabs(tabs);
  const rank = ordered.findIndex((item) => item.id === selfId);
  const isAdmin = accessController.isAdminPath(window.location.pathname);
  return {
    count: ordered.length || 1,
    rank: rank >= 0 ? rank : 0,
    over: enabled && !isAdmin && ordered.length > limit && rank >= limit,
    limit,
  };
}
