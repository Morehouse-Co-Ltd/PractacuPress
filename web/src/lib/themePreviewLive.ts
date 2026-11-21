import type { SiteTheme } from '../types';

/**
 * 「真实前台」主题预览的交接。
 *
 * 预览弹窗把要试的主题写进 sessionStorage，再用 `?pp_theme_preview=<token>` 打开
 * 一个同源 iframe；iframe 启动时（`readCustomization` 第一次读取配置之前）认领这份
 * 主题，并把它叠加到站点设计上。认领结果只存在这个文档的内存里：
 *
 * - 不写服务端、不写 `pp.web.config.v1`，关掉弹窗不会留下任何改动；
 * - 后台窗口没有这个查询参数，因此不会跟着变；
 * - iframe 内站内跳转会丢掉查询参数，但内存里的认领结果仍在，预览不会中途失效。
 */

export const THEME_PREVIEW_PARAM = 'pp_theme_preview';
export const THEME_PREVIEW_STORAGE_KEY = 'pp.theme.preview.v1';

/** 预览交接数据的形状；token 防止同一浏览器里的旧预览被误用。 */
interface ThemePreviewHandoff {
  token: string;
  bundle: SiteTheme;
}

/** 每个文档只解析一次：第一次调用之后，结果（含 null）就是这份文档的结论。 */
let claimed: { token: string; bundle: SiteTheme } | null | undefined;

function sessionStore(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage;
  } catch {
    // 无痕模式或站点数据被禁：预览退化为「打不开」，但不影响主题库本身。
    return null;
  }
}

/** 生成一次预览令牌，并把主题交给即将打开的预览文档。 */
export function publishThemePreview(bundle: SiteTheme): string | null {
  const store = sessionStore();
  if (!store) return null;
  const token = `tp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const handoff: ThemePreviewHandoff = { token, bundle };
  try {
    store.setItem(THEME_PREVIEW_STORAGE_KEY, JSON.stringify(handoff));
  } catch {
    return null;
  }
  return token;
}

/** 擦掉交接数据：弹窗关闭、换主题或组件卸载时都调用。 */
export function clearThemePreview(): void {
  try {
    sessionStore()?.removeItem(THEME_PREVIEW_STORAGE_KEY);
  } catch {
    /* 存储不可用时没有可清理的数据 */
  }
}

/** 预览地址：路径 + 令牌；`token` 为空时退回普通地址。 */
export function themePreviewUrl(token: string | null, path = '/'): string {
  if (!token) return path;
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}${THEME_PREVIEW_PARAM}=${encodeURIComponent(token)}`;
}

function isThemeBundle(value: unknown): value is SiteTheme {
  if (!value || typeof value !== 'object') return false;
  const bundle = value as Partial<SiteTheme>;
  return (
    typeof bundle.id === 'string' &&
    typeof bundle.name === 'string' &&
    // 空白主题没有 theme 字段：允许预览，渲染时回落到默认主题。
    (bundle.theme === undefined || (typeof bundle.theme === 'object' && !!bundle.theme))
  );
}

/**
 * 当前文档要预览的主题。
 *
 * 只在「查询参数里的令牌 == sessionStorage 里的交接令牌」时成立，所以后台窗口、
 * 页面编排的预览 iframe 都不会误用。
 */
export function documentPreviewTheme(): SiteTheme | null {
  if (claimed !== undefined) return claimed?.bundle ?? null;
  claimed = null;
  if (typeof window === 'undefined') return null;
  try {
    const token = new URLSearchParams(window.location.search).get(THEME_PREVIEW_PARAM);
    if (!token) return null;
    const raw = sessionStore()?.getItem(THEME_PREVIEW_STORAGE_KEY);
    if (!raw) return null;
    const handoff = JSON.parse(raw) as Partial<ThemePreviewHandoff>;
    if (handoff?.token !== token || !isThemeBundle(handoff.bundle)) return null;
    claimed = { token, bundle: handoff.bundle };
  } catch {
    claimed = null;
  }
  return claimed?.bundle ?? null;
}

/**
 * 当前文档认领的预览令牌；没有预览时为 null。
 *
 * 站内跳转会丢掉 `?pp_theme_preview=`，路由变化时用这个令牌把它写回去，
 * 这样在预览 iframe 里刷新页面仍然停在「带主题」的状态。
 */
export function documentPreviewToken(): string | null {
  documentPreviewTheme();
  return claimed?.token ?? null;
}

/** 仅测试使用：清空文档级缓存，模拟一次新的页面加载。 */
export function resetThemePreviewDocumentCache(): void {
  claimed = undefined;
}
