import { useSyncExternalStore } from 'react';
import type { ThemeMode } from '../types';

/**
 * 浏览者自己的明暗偏好。
 *
 * 站点的主题模式（`customization.theme.mode`）是「新访客看到的默认值」；
 * 页头的太阳 / 月亮按钮只改这台浏览器的一次选择，写进 Cookie，既不会把
 * 站长的全局设置改掉，也能在刷新和下次访问时保持。Cookie 而不是
 * localStorage：首屏脚本可以在 React 启动前就读到它，避免深色站点闪白。
 */

export const THEME_COOKIE = 'pp_theme';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365;
const CHANGE_EVENT = 'pp:theme-preference';

export type ThemePreference = ThemeMode | null;

function readCookie(name: string): string {
  if (typeof document === 'undefined') return '';
  const prefix = `${name}=`;
  for (const part of document.cookie.split(';')) {
    const item = part.trim();
    if (item.startsWith(prefix)) return decodeURIComponent(item.slice(prefix.length));
  }
  return '';
}

function writeCookie(name: string, value: string, maxAge: number): void {
  if (typeof document === 'undefined') return;
  const secure = window.location.protocol === 'https:' ? '; Secure' : '';
  document.cookie = `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; SameSite=Lax${secure}`;
}

/** 读取浏览器里的明暗偏好；没有或值不合法时返回 null（跟随站点默认）。 */
export function readThemePreference(): ThemePreference {
  const value = readCookie(THEME_COOKIE);
  return value === 'dark' || value === 'light' ? value : null;
}

/** 写入偏好，并通知页面上所有主题按钮与主题层同步。 */
export function setThemePreference(mode: ThemeMode | null): void {
  if (typeof document === 'undefined') return;
  if (mode) writeCookie(THEME_COOKIE, mode, COOKIE_MAX_AGE);
  else writeCookie(THEME_COOKIE, '', 0);
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { mode } }));
}

/** 首屏：把偏好写到 <html>，供 CSS 与浏览器原生控件（滚动条、表单）使用。 */
export function applyBootThemePreference(fallback: ThemeMode): ThemeMode {
  const mode = readThemePreference() ?? fallback;
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.mode = mode;
    document.documentElement.style.colorScheme = mode;
  }
  return mode;
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const onCustom = () => onChange();
  const onStorage = (event: StorageEvent) => {
    if (event.key === THEME_COOKIE) onChange();
  };
  window.addEventListener(CHANGE_EVENT, onCustom);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(CHANGE_EVENT, onCustom);
    window.removeEventListener('storage', onStorage);
  };
}

let snapshot: ThemePreference | undefined;
let snapshotRaw = '';

function getSnapshot(): ThemePreference {
  // Cookie 是不可观察的字符串；缓存解析结果，避免 useSyncExternalStore 每次
  // 读取都返回新对象/新值导致无限重渲染。
  const raw = typeof document === 'undefined' ? '' : document.cookie;
  if (snapshot === undefined || raw !== snapshotRaw) {
    snapshotRaw = raw;
    snapshot = readThemePreference();
  }
  return snapshot;
}

/** React 里读取浏览者偏好；null 表示跟随站点默认。 */
export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(subscribe, getSnapshot, () => null);
}
