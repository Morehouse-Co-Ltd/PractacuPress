import { useCallback, useSyncExternalStore } from 'react';
import type { ThemeMode } from '../types';

/**
 * 管理后台自己的明暗偏好。
 *
 * 后台是工作台，不属于站点设计：站长的前台主题（以及访客的 `pp_theme` Cookie）
 * 不应该决定后台长什么样，反之亦然。因此这里单独用 localStorage 记一份偏好，
 * 只写 `html[data-admin-theme]`，与站点主题的 `html[data-mode]` 互不覆盖。
 *
 * 默认亮色：升级前后台一直是纸白，没主动切过的人打开后台不应该突然变暗。
 */

export const ADMIN_THEME_KEY = 'pp.admin.theme';
const CHANGE_EVENT = 'pp:admin-theme';

/**
 * 本地存储被封禁（隐私模式、策略限制）时的兜底：至少本次会话里切换仍然有效。
 * 页面刷新后回到亮色，和「偏好没法保存」的预期一致。
 */
let memoryMode: ThemeMode = 'light';
let memoryOnly = false;

/** 读取后台偏好；不可用或值不合法时按亮色处理。 */
export function readAdminTheme(): ThemeMode {
  try {
    const stored = localStorage.getItem(ADMIN_THEME_KEY);
    if (!memoryOnly && (stored === 'dark' || stored === 'light')) return stored;
  } catch {
    memoryOnly = true;
  }
  return memoryOnly ? memoryMode : 'light';
}

/** 写入偏好并通知同页面的切换按钮；刷新后由 readAdminTheme 恢复。 */
export function setAdminTheme(mode: ThemeMode): void {
  memoryMode = mode;
  try {
    localStorage.setItem(ADMIN_THEME_KEY, mode);
  } catch {
    memoryOnly = true;
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { mode } }));
  }
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const onCustom = () => onChange();
  const onStorage = (event: StorageEvent) => {
    if (event.key === ADMIN_THEME_KEY) onChange();
  };
  window.addEventListener(CHANGE_EVENT, onCustom);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onCustom);
    window.removeEventListener('storage', onStorage);
  };
}

export interface AdminTheme {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
  toggle: () => void;
}

/** 组件里读取 / 切换后台明暗；same-tab 与跨标签页都会同步。 */
export function useAdminTheme(): AdminTheme {
  const mode = useSyncExternalStore<ThemeMode>(subscribe, readAdminTheme, () => 'light');
  const setMode = useCallback((next: ThemeMode) => setAdminTheme(next), []);
  const toggle = useCallback(
    () => setAdminTheme(readAdminTheme() === 'dark' ? 'light' : 'dark'),
    [],
  );
  return { mode, setMode, toggle };
}
