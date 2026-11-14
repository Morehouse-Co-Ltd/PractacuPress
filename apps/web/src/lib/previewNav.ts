/**
 * 页面编排预览的「页面锁」规则。
 *
 * 编排器中间那块 iframe 跑的是真实前台，站内导航 Tab、页脚、文章卡片、命令面板
 * 都能把它带到别的页面去。一旦离开，左侧结构树和右侧属性面板仍在编辑原来那一页，
 * 屏幕上却已经是文章列表 / 搜索 / 登录这类根本不在页面编排里的页面：既改不了，
 * 也回不来，只能手动刷新预览。
 *
 * 规则很简单：预览只允许停留在打开它时的那一页。
 * - 页内锚点（`#foo`）不动文档，放行；
 * - `target="_blank"` / 命名窗口、`download`、`mailto:` 之类不替换预览文档，放行
 *   （「新窗口」按钮本身就是这个语义：想认真看前台时用它）；
 * - 同一路径（锚点 / 查询串不同）算同一页，放行；
 * - 其余一律视为离开：点击在预览桥里被拦下，由编排器提示怎么切换页面。
 *
 * 这里只放纯规则，方便直接测；DOM 事件在 `components/PreviewBridge.tsx` 里接。
 */

export type PreviewNavVerdict = 'allow' | 'block';

/** 交给系统处理、不会替换预览文档的协议。`javascript:` / `data:` 不在其列。 */
const DETACHED_PROTOCOLS = new Set(['mailto:', 'tel:', 'sms:']);

export interface PreviewNavOptions {
  /** 预览 iframe 的当前地址，用来解析相对链接。 */
  baseUrl: string;
  /** `<a target>` 的值。 */
  target?: string | null;
  /** 是否带 `download` 属性。 */
  download?: boolean;
}

/**
 * 这个 `target` 会不会打开另一份文档（新标签页 / 新窗口）。
 *
 * `_self` 在当前文档里打开，`_parent` / `_top` 会动到编排器所在的祖先窗口——这两种
 * 都不算「分离」，必须按普通跳转处理；命名窗口（以及 `_blank`）由浏览器新开一份文档，
 * 预览本身不受影响。
 */
function opensDetachedDocument(target: string | null | undefined): boolean {
  if (!target) return false;
  const name = target.trim().toLowerCase();
  if (!name || name === '_self' || name === '_parent' || name === '_top') return false;
  return true;
}

/** 预览里点这个链接算不算「离开正在编排的页面」。 */
export function previewNavVerdict(href: string, options: PreviewNavOptions): PreviewNavVerdict {
  const text = href.trim();
  // 空链接与页内锚点都不会离开当前文档。
  if (!text || text.startsWith('#')) return 'allow';
  // 下载与新窗口不会替换预览里的文档。
  if (options.download || opensDetachedDocument(options.target)) return 'allow';

  let base: URL;
  let resolved: URL;
  try {
    base = new URL(options.baseUrl);
    resolved = new URL(text, base);
  } catch {
    // 解析不了的地址按「离开」处理：宁可拦下，也不要让预览莫名其妙地跳走。
    return 'block';
  }

  if (DETACHED_PROTOCOLS.has(resolved.protocol)) return 'allow';
  // 只放行真正的网页地址；`javascript:` / `data:` / `blob:` 一律拦下。
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return 'block';
  // 同一页（锚点 / 查询串不同）仍算留在预览里。
  if (resolved.origin === base.origin && resolved.pathname === base.pathname) return 'allow';
  return 'block';
}

/**
 * 预览 iframe 是否还停在 `expected` 指向的那一页。
 *
 * 只比较 origin 与 pathname：查询串、页内锚点都属于同一页。父窗口拿它做兜底——
 * 万一有不经过点击事件的整页跳转（表单、脚本改 location、外链），把 iframe 拉回来。
 * 跨源访问会抛错，调用方据此判断「已经离开」。
 */
export function staysOnPreviewPage(expected: string, current: string, baseUrl: string): boolean {
  try {
    const want = new URL(expected, baseUrl);
    const got = new URL(current, baseUrl);
    return want.origin === got.origin && want.pathname === got.pathname;
  } catch {
    return false;
  }
}
