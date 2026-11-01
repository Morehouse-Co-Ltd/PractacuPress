import type { ActivityEntry } from '../types';
import type { Backend } from './backend';
import { isDemo } from './backend';

const KEY = 'pp.activity.v1';

export function readActivity(): ActivityEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as ActivityEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function recordActivity(entry: Omit<ActivityEntry, 'id' | 'at'>) {
  const next: ActivityEntry = {
    ...entry,
    id: `act_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`,
    at: new Date().toISOString(),
  };
  try {
    const all = [next, ...readActivity()].slice(0, 120);
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* 本地记录失败不影响主流程 */
  }
}

/** 演示后端自己维护活动日志；真实后端没有审计端点，因此记录在浏览器本地。 */
export function noteActivity(
  backend: Backend,
  actor: string,
  action: string,
  target: string,
  detail?: string,
) {
  if (isDemo(backend)) return;
  recordActivity({ actor, action, target, detail });
}

export function clearActivity() {
  localStorage.removeItem(KEY);
}
