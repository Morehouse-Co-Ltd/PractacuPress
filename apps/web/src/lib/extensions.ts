import type {
  CustomExtension,
  ExtensionManifestFile,
  ExtensionPageScope,
  ExtensionPermission,
  ExtensionSlot,
  SiteCustomization,
} from '../types';
import {
  EXTENSION_LIMITS,
  EXTENSION_PAGE_SCOPES,
  EXTENSION_PERMISSIONS,
  EXTENSION_SLOTS,
  MAX_CUSTOM_EXTENSIONS,
  readCustomization,
} from './customize';
import { t } from './i18n';

/**
 * 创作者扩展：清单校验、编辑器默认值、导入导出与沙箱文档拼装。
 *
 * 这里全部是纯函数（除 downloadJson 之外没有 DOM 副作用），方便单测。
 * 扩展的 HTML / CSS / JS 只在 sandbox iframe 里执行：宿主用 `buildExtensionDocument`
 * 拼出 srcdoc，并通过 `window.PP` 桥把少量受限能力交还给扩展。
 */

/* ------------------------------------------------------------------ *
 * 清单与默认值
 * ------------------------------------------------------------------ */

/** 扩展导出文件的扩展名与 format 标记。 */
export const EXTENSION_FILE_FORMAT = 'practacu-extension' as const;
export const EXTENSION_BUNDLE_FORMAT = 'practacu-extensions' as const;
export const EXTENSION_FILE_VERSION = 1 as const;

/** 单次导入的上限；与共享层的 MAX_CUSTOM_EXTENSIONS 保持一致。 */
export const MAX_IMPORTED_EXTENSIONS = MAX_CUSTOM_EXTENSIONS;

const EXTENSION_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,60}$/;
const EXTENSION_ICON_MAX = 4;

/** 扩展文件的完整结构（全部导出时数组有多份）。 */
export interface ExtensionBundleFile {
  format: typeof EXTENSION_BUNDLE_FORMAT;
  version: typeof EXTENSION_FILE_VERSION;
  exported_at: string;
  extensions: CustomExtension[];
}

/** 生成新的扩展 id；只使用小写字母、数字、点、下划线与连字符。 */
export function newExtensionId(): string {
  return `ext_${Math.random().toString(36).slice(2, 10)}`;
}

/** 收敛单个字段：非字符串按默认值处理，字符串按上限截断。 */
function clampText(value: unknown, max: number, fallback = ''): string {
  return typeof value === 'string' ? value.slice(0, max) : fallback;
}

/** 收敛枚举数组：过滤非法值并去重；结果为空时使用 fallback。 */
function clampList<T extends string>(value: unknown, allowed: readonly T[], fallback: readonly T[]): T[] {
  const out: T[] = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const hit = allowed.find((candidate) => candidate === item);
      if (hit && !out.includes(hit)) out.push(hit);
    }
  }
  return out.length ? out : [...fallback];
}

/**
 * 创建一个扩展清单（导入、复制与导出共用）。
 *
 * 默认值：id 随机、版本 1.0.0、默认关闭、挂在文章底部、适用全部页面、不申请权限。
 * 传入的 created_at 会被保留，updated_at 始终是当前时间——编辑保存靠它触发 iframe 重载。
 */
export function createExtension(partial: Partial<CustomExtension> = {}): CustomExtension {
  const now = new Date().toISOString();
  const id =
    typeof partial.id === 'string' && EXTENSION_ID_PATTERN.test(partial.id) ? partial.id : newExtensionId();
  const icon = clampText(partial.icon, EXTENSION_ICON_MAX).trim();
  return {
    id,
    name: clampText(partial.name, EXTENSION_LIMITS.name).trim() || t('未命名扩展'),
    version: clampText(partial.version, EXTENSION_LIMITS.version).trim() || '1.0.0',
    author: clampText(partial.author, EXTENSION_LIMITS.author).trim() || t('未署名'),
    description: clampText(partial.description, EXTENSION_LIMITS.description),
    ...(icon ? { icon } : {}),
    enabled: partial.enabled === true,
    slots: clampList(partial.slots, EXTENSION_SLOTS, ['article_bottom']),
    pages: clampList(partial.pages, EXTENSION_PAGE_SCOPES, ['all']),
    permissions: clampList(partial.permissions, EXTENSION_PERMISSIONS, []),
    html: clampText(partial.html, EXTENSION_LIMITS.html),
    css: clampText(partial.css, EXTENSION_LIMITS.css),
    js: clampText(partial.js, EXTENSION_LIMITS.js),
    created_at:
      typeof partial.created_at === 'string' && partial.created_at ? partial.created_at : now,
    updated_at: now,
  };
}

/* ------------------------------------------------------------------ *
 * 导入 / 导出
 * ------------------------------------------------------------------ */

/**
 * 交给共享层收敛扩展数组。
 *
 * `normalizeCustomExtensions` 目前没有从 lib/customize.ts 导出，但已经接在
 * readCustomization 里；这里借同一条路径做校验与截断，保证导入、外观导入与
 * 读取本地配置三处行为完全一致。
 */
function normalizeExtensionList(value: unknown): CustomExtension[] {
  return readCustomization({
    customization: { custom_extensions: value } as unknown as SiteCustomization,
  }).custom_extensions;
}

/** 从任意 JSON 值里收集候选清单：导出文件、裸清单、清单数组、全部导出文件都接受。 */
function collectManifests(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== 'object') {
    throw new Error(t('扩展文件的顶层必须是对象或数组。'));
  }
  const record = data as Record<string, unknown>;
  if (record.extension !== undefined) {
    if (record.format !== undefined && record.format !== EXTENSION_FILE_FORMAT) {
      throw new Error(t('这不是 Practacu 扩展文件：format 应为 practacu-extension。'));
    }
    if (record.version !== undefined && record.version !== EXTENSION_FILE_VERSION) {
      throw new Error(
        t('不支持的扩展文件版本：{version}，当前只支持 1。', { version: String(record.version) }),
      );
    }
    return [record.extension];
  }
  if (Array.isArray(record.extensions)) {
    if (record.format !== undefined && record.format !== EXTENSION_BUNDLE_FORMAT) {
      throw new Error(t('这不是 Practacu 扩展合集文件：format 应为 practacu-extensions。'));
    }
    return record.extensions;
  }
  // 裸清单：没有外层包装，直接就是一个 CustomExtension。
  if (typeof record.name === 'string' || typeof record.id === 'string') return [record];
  throw new Error(t('文件里没有扩展清单：需要 extension 字段、extensions 数组或 name 字段。'));
}

/**
 * 解析扩展文件（`.ppext.json` 或手工粘贴的 JSON），返回收敛后的清单数组。
 *
 * 容错规则：数组里个别坏清单会被跳过，只要还有一个能用的就返回；
 * 完全无法识别时抛出带中文原因的 Error，由管理页展示给站长。
 */
export function parseExtensionFile(text: string): CustomExtension[] {
  const raw = typeof text === 'string' ? text.trim() : '';
  if (!raw) throw new Error(t('请先选择扩展文件，或粘贴扩展清单 JSON。'));
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error(t('文件不是有效的 JSON，请检查是否复制完整（包括首尾大括号）。'));
  }
  const candidates = collectManifests(data);
  if (candidates.length > MAX_IMPORTED_EXTENSIONS) {
    throw new Error(
      t('一次最多导入 {count} 个扩展，请拆分文件后再试。', { count: MAX_IMPORTED_EXTENSIONS }),
    );
  }
  const valid: unknown[] = [];
  for (const item of candidates) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const name = (item as Record<string, unknown>).name;
    if (typeof name !== 'string' || !name.trim()) continue;
    valid.push(item);
  }
  if (!valid.length) {
    throw new Error(
      t('没有可导入的扩展：每个清单都需要非空的 name（扩展名称），一次最多 {count} 个。', {
        count: MAX_IMPORTED_EXTENSIONS,
      }),
    );
  }
  const normalized = normalizeExtensionList(valid);
  if (!normalized.length) {
    throw new Error(t('扩展清单没有通过校验：请检查 name、slots、pages 与 permissions 字段。'));
  }
  return normalized;
}

/** 单个扩展的导出文件结构。 */
export function buildExtensionFile(extension: CustomExtension): ExtensionManifestFile {
  return {
    format: EXTENSION_FILE_FORMAT,
    version: EXTENSION_FILE_VERSION,
    exported_at: new Date().toISOString(),
    extension,
  };
}

/** 全部扩展的导出文件结构（可再导入，parseExtensionFile 认这个格式）。 */
export function buildExtensionBundle(extensions: CustomExtension[]): ExtensionBundleFile {
  return {
    format: EXTENSION_BUNDLE_FORMAT,
    version: EXTENSION_FILE_VERSION,
    exported_at: new Date().toISOString(),
    extensions,
  };
}

/** 下载用的文件名：`<名称>.ppext.json`，名称不可用时退回扩展 id。 */
export function extensionFileName(extension: Pick<CustomExtension, 'id' | 'name'>): string {
  const base = (extension.name ?? '')
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `${base || extension.id}.ppext.json`;
}

/** 触发浏览器下载一个 JSON 文件（管理页的导出按钮共用）。 */
export function downloadJson(fileName: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------ *
 * 展示文案
 * ------------------------------------------------------------------ */

/*
 * 下面几张展示文案表用 getter 提供：它们在模块加载期就被页面取用，
 * 若在加载期求值，切换语言后标签会一直停在加载时的语言上。
 */

export const SLOT_LABELS: Record<ExtensionSlot, string> = {
  get site_header() { return t('站点页头'); },
  get site_footer() { return t('站点页脚'); },
  get home_top() { return t('首页顶部'); },
  get home_bottom() { return t('首页底部'); },
  get article_top() { return t('文章顶部'); },
  get article_bottom() { return t('文章底部'); },
  get article_side() { return t('文章侧栏'); },
  get floating() { return t('悬浮窗'); },
};

export const PAGE_SCOPE_LABELS: Record<ExtensionPageScope, string> = {
  get all() { return t('全部页面'); },
  get home() { return t('首页'); },
  get article() { return t('文章页'); },
  get list() { return t('列表页'); },
  get search() { return t('搜索页'); },
};

export const PERMISSION_LABELS: Record<ExtensionPermission, string> = {
  get notify() { return t('通知'); },
  get open_link() { return t('打开链接'); },
  get navigate() { return t('站内跳转'); },
  get clipboard() { return t('剪贴板'); },
  get theme() { return t('主题信息'); },
  get storage() { return t('本地存储'); },
};

export const PERMISSION_HINTS: Record<ExtensionPermission, string> = {
  get notify() { return t('在宿主页面右下角弹出一条提示。'); },
  get open_link() { return t('在新标签页打开 http(s) 链接。'); },
  get navigate() { return t('跳转到站内路径（以 / 开头）。'); },
  get clipboard() { return t('把一段文字写入访客剪贴板。'); },
  get theme() { return t('读取并使用站点的颜色与字体令牌。'); },
  get storage() { return t('按扩展 id 隔离的本地键值存储。'); },
};

/** 挂载位置的中文名。 */
export function slotLabel(slot: ExtensionSlot): string {
  return SLOT_LABELS[slot] ?? slot;
}

/** 页面范围的中文名。 */
export function pageScopeLabel(scope: ExtensionPageScope): string {
  return PAGE_SCOPE_LABELS[scope] ?? scope;
}

/** 权限的中文名。 */
export function permissionLabel(permission: ExtensionPermission): string {
  return PERMISSION_LABELS[permission] ?? permission;
}

/* ------------------------------------------------------------------ *
 * 页面类型与槽位匹配
 * ------------------------------------------------------------------ */

/** 站点前台的页面类型；other 指登录页、自定义页面等。 */
export type ExtensionPageKind = 'home' | 'article' | 'list' | 'search' | 'other';

/** 由 location.pathname 判断页面类型（与 App.tsx 的路由表保持一致）。 */
export function pageKindForPath(pathname: string): ExtensionPageKind {
  const path = (pathname || '/').split('?')[0].split('#')[0] || '/';
  if (path === '/') return 'home';
  if (path === '/a' || path.startsWith('/a/') || path === '/p' || path.startsWith('/p/')) {
    return 'article';
  }
  if (
    path === '/articles' ||
    path.startsWith('/articles/') ||
    path === '/posts' ||
    path.startsWith('/posts/')
  ) {
    return 'list';
  }
  if (path === '/search' || path.startsWith('/search/')) return 'search';
  return 'other';
}

/**
 * 扩展是否适用于当前页面。
 *
 * 声明 all 表示全部页面；other（登录、自定义页）只命中 all。
 * 空 pages 的手写清单按 all 处理，避免导入后完全不可见。
 */
export function matchPageScope(
  extension: Pick<CustomExtension, 'pages'>,
  pageKind: ExtensionPageKind,
): boolean {
  const pages = Array.isArray(extension.pages) ? extension.pages : [];
  if (!pages.length || pages.includes('all')) return true;
  return pages.includes(pageKind as ExtensionPageScope);
}

/**
 * 槽位本身对页面类型的要求：首页 / 文章槽位只在自己的页面出现。
 *
 * 这样「首页顶部」这类位置不会在文章页跑到 main 最前面；`pages` 仍然管
 * 更细的适用页面（例如只在搜索页显示悬浮窗）。
 */
export function slotMatchesPage(slot: ExtensionSlot, pageKind: ExtensionPageKind): boolean {
  if (slot === 'home_top' || slot === 'home_bottom') return pageKind === 'home';
  if (slot === 'article_top' || slot === 'article_bottom' || slot === 'article_side') {
    return pageKind === 'article';
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * 沙箱文档（srcdoc）
 * ------------------------------------------------------------------ */

/** iframe 的 CSP：默认全禁，只放开内联样式/脚本、https 图片与 data 字体。 */
export const EXTENSION_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src https: data:; font-src data:";

/** 扩展 id 与存储键的命名空间；宿主写入 localStorage 时用同一前缀。 */
export function extensionStorageKey(extensionId: string, key: string): string {
  return `pp.ext.${extensionId}.${key}`;
}

export interface ExtensionThemeContext {
  background: string;
  ink: string;
  accent: string;
  /** 标题字体：serif 衬线 / sans 无衬线。 */
  font: 'serif' | 'sans';
}

export interface ExtensionDocumentContext {
  theme: ExtensionThemeContext;
  page: ExtensionPageKind;
  /** 文章标题；非文章页为空字符串。 */
  title?: string;
  extensionId: string;
  /** 宿主预先读出的存储快照，供沙箱内 PP.storage.get 同步读取。 */
  storage?: Record<string, string>;
}

/** 把文本塞进 HTML 属性/标题：只保留转义后的显示内容。 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 安全地内联 JSON：把 `<` 与行分隔符转义，避免提前闭合 script 标签。 */
function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** 内联脚本里出现 `</script>` 时防截断（浏览器在 script 里只认这个字面量）。 */
function scriptSafe(source: string): string {
  return source.replace(/<\/script/gi, '<\\/script');
}

/** CSS 里出现 `</style>` 同样会提前闭合标签；这里做最小修补。 */
function styleSafe(source: string): string {
  return source.replace(/<\/style/gi, '<\\/style');
}

/** 只接受十六进制或 rgb/hsl 颜色，避免把任意字符串拼进 CSS。 */
function safeCssColor(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(trimmed)) return trimmed;
  if (/^(rgb|rgba|hsl|hsla)\([0-9.,%\s/+-]+\)$/.test(trimmed)) return trimmed;
  return fallback;
}

/** 粗略判断背景亮度，让沙箱内表单控件跟随深色 / 浅色。 */
function isDarkColor(value: string): boolean {
  const match = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(value);
  if (!match) return false;
  const hex = match[1].length === 3
    ? match[1].split('').map((char) => char + char).join('')
    : match[1];
  const r = Number.parseInt(hex.slice(0, 2), 16);
  const g = Number.parseInt(hex.slice(2, 4), 16);
  const b = Number.parseInt(hex.slice(4, 6), 16);
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance < 0.45;
}

const FONT_STACKS: Record<ExtensionThemeContext['font'], string> = {
  serif: `Georgia, "Noto Serif SC", "Songti SC", "SimSun", serif`,
  sans: `system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif`,
};

/** 沙箱内的基础 reset 与主题变量：扩展只写自己的样式即可融入站点。 */
function sandboxResetCss(theme: ExtensionThemeContext): string {
  const background = safeCssColor(theme.background, '#ffffff');
  const ink = safeCssColor(theme.ink, '#14140f');
  const accent = safeCssColor(theme.accent, '#1f5c4a');
  const font = FONT_STACKS[theme.font] ?? FONT_STACKS.serif;
  const scheme = isDarkColor(background) ? 'dark' : 'light';
  return [
    `:root{--pp-bg:${background};--pp-ink:${ink};--pp-accent:${accent};--pp-font:${font};}`,
    '*,*::before,*::after{box-sizing:border-box;}',
    `html{color-scheme:${scheme};-webkit-text-size-adjust:100%;}`,
    'html,body{margin:0;padding:0;background:transparent;}',
    'body{font-family:var(--pp-font);font-size:14px;line-height:1.65;color:var(--pp-ink);overflow-wrap:break-word;}',
    'a{color:var(--pp-accent);text-decoration:none;}',
    'a:hover{text-decoration:underline;}',
    'img,svg,video{max-width:100%;height:auto;}',
    'button,input,select,textarea{font:inherit;color:inherit;}',
    ':focus-visible{outline:2px solid var(--pp-accent);outline-offset:2px;}',
  ].join('');
}

/**
 * 沙箱桥：暴露 window.PP，所有能力都通过 postMessage 交给宿主执行。
 *
 * 只用 ES5 语法与单引号字符串，避免与扩展自己的脚本互相影响。
 * - getContext()：同步拿到主题 / 页面类型 / 标题；
 * - getTheme()：额外向宿主请求一次最新主题（需要 theme 权限）；
 * - notify / open / navigate / copy：受限能力；
 * - storage.get / set：同步读宿主注入的快照，写入交给宿主持久化；
 * - setHeight：把内容高度报给宿主，由宿主调整 iframe 高度。
 */
const BRIDGE_SCRIPT = String.raw`(function () {
  'use strict';
  var CTX = window.__PP_CONTEXT__ || {};
  var ID = CTX.extensionId || '';
  var cache = {};
  var initial = CTX.storage || {};
  for (var seed in initial) {
    if (Object.prototype.hasOwnProperty.call(initial, seed)) cache[seed] = String(initial[seed]);
  }
  function clean(value, max) {
    return String(value == null ? '' : value).slice(0, max);
  }
  function post(type, payload) {
    try {
      window.parent.postMessage({ pp: true, id: ID, type: type, payload: payload || {} }, '*');
    } catch (error) {}
  }
  function measureHeight() {
    var doc = document.documentElement;
    var body = document.body;
    return Math.ceil(Math.max(
      doc ? doc.scrollHeight : 0,
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0
    ));
  }
  var lastHeight = -1;
  function setHeight(value) {
    var height = typeof value === 'number' && isFinite(value) && value >= 0
      ? Math.round(value)
      : measureHeight();
    if (height === lastHeight) return;
    lastHeight = height;
    post('setHeight', { height: height });
  }
  function applyTheme(theme) {
    if (!theme || typeof theme !== 'object') return;
    var root = document.documentElement;
    var vars = { '--pp-bg': 'background', '--pp-ink': 'ink', '--pp-accent': 'accent' };
    for (var name in vars) {
      var value = theme[vars[name]];
      if (typeof value === 'string' && value) root.style.setProperty(name, value);
    }
    if (typeof theme.font === 'string') {
      root.style.setProperty('--pp-font', theme.font === 'sans'
        ? 'system-ui, -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
        : 'Georgia, "Noto Serif SC", "Songti SC", "SimSun", serif');
    }
  }
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (!data || data.pp !== true || data.id !== ID) return;
    if (data.type === 'theme') applyTheme(data.payload);
    if (data.type === 'ping') report();
  });
  window.PP = {
    context: CTX,
    getContext: function () { return CTX; },
    getTheme: function () { post('theme'); return CTX.theme || {}; },
    notify: function (message) { post('notify', { message: clean(message, 200) }); },
    open: function (href) { post('open', { href: clean(href, 1000) }); },
    navigate: function (path) { post('navigate', { path: clean(path, 500) }); },
    copy: function (text) { post('clipboard', { text: clean(text, 2000) }); },
    setHeight: setHeight,
    storage: {
      get: function (key) {
        var safe = clean(key, 64);
        return Object.prototype.hasOwnProperty.call(cache, safe) ? cache[safe] : null;
      },
      set: function (key, value) {
        var safe = clean(key, 64);
        var text = clean(value, 2000);
        cache[safe] = text;
        post('storage.set', { key: safe, value: text });
      }
    }
  };
  function report() { setHeight(); }
  if (document.readyState === 'complete') report();
  window.addEventListener('load', report);
  if (typeof ResizeObserver !== 'undefined') {
    try {
      var resize = new ResizeObserver(report);
      resize.observe(document.documentElement);
      if (document.body) resize.observe(document.body);
    } catch (error) {}
  }
  if (typeof MutationObserver !== 'undefined') {
    try {
      var mo = new MutationObserver(report);
      mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    } catch (error) {}
  }
  setTimeout(report, 0);
  setTimeout(report, 120);
  setTimeout(report, 500);
})();`;

/**
 * 拼出扩展 iframe 的 srcdoc。
 *
 * 顺序：CSP + reset + 扩展 CSS → 扩展 HTML → 上下文/桥 → 扩展 JS。
 * 扩展 JS 里出现 `</script>` 会被替换成 `<\/script>`，否则它会提前截断内联脚本。
 */
export function buildExtensionDocument(
  extension: CustomExtension,
  context: ExtensionDocumentContext,
): string {
  const html = clampText(extension.html, EXTENSION_LIMITS.html);
  const css = clampText(extension.css, EXTENSION_LIMITS.css);
  const js = clampText(extension.js, EXTENSION_LIMITS.js);
  const bridgeContext = {
    ...context,
    extensionId: extension.id,
    storage: context.storage ?? {},
  };
  const reset = sandboxResetCss(context.theme);
  const extensionCss = css.trim() ? styleSafe(css) : '';
  const extensionJs = js.trim() ? `<script>${scriptSafe(js)}</script>\n` : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${EXTENSION_CSP}">
<title>${escapeHtml(extension.name)}</title>
<style>${reset}${extensionCss}</style>
</head>
<body>
${html}
<script>window.__PP_CONTEXT__ = ${safeJson(bridgeContext)};</script>
<script>${BRIDGE_SCRIPT}</script>
${extensionJs}</body>
</html>`;
}
