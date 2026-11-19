import type { CapabilityId, ContentKind, PermissionGroupId, PermissionSettings } from '../types';
import { DEFAULT_ADMIN_PATH } from './siteConfig';

/**
 * 「后台身份」依赖的能力。
 *
 * 与 `AdminGate` 一直以来的判据保持一致：审核内容、管理成员、管理站点、查看日志。
 * `write_content` 不在这里：写稿是前台成员的能力，不是后台权限；能写稿的普通成员
 * 应该使用写作台（`/write/...`），而不是整套管理后台。
 */
export const ADMIN_CAPABILITIES: CapabilityId[] = [
  'moderate_content',
  'manage_member',
  'manage_site',
  'view_log',
];

/** 当前账户是否具备任一后台能力（不代表被允许进入后台）。 */
export function hasAdminCapability(can: (capability: CapabilityId) => boolean): boolean {
  return ADMIN_CAPABILITIES.some((capability) => can(capability));
}

/**
 * 能否进入管理后台。
 *
 * 两个条件缺一不可：
 * 1. 权限组具备任一后台能力 —— 否则进去也只是一间空屋子；
 * 2. 站长在「用户组」页面为该组打开了「进入管理后台」（`admin_access`）。
 *
 * 默认的成员组只有 `write_content`，`admin_access` 也是 false，所以普通成员只能
 * 打开写作台。界面判据与服务端授权是两回事：服务端仍按角色拒绝越权请求。
 */
export function adminEntryAllowed(input: {
  settings: PermissionSettings;
  group: PermissionGroupId;
  can: (capability: CapabilityId) => boolean;
}): boolean {
  if (!input.settings?.[input.group]?.admin_access) return false;
  return hasAdminCapability(input.can);
}

/** 写作台在地址栏里的入口。后台入口是 `/admin`，两者刻意分开。 */
export const WRITE_ROUTE = '/write';

function normalizePath(value: string): string {
  let path = value.trim();
  if (!path.startsWith('/')) return '';
  // 只比较路径本身：`/admin?tab=1`、`/admin#top` 仍然是后台入口。
  path = path.split(/[?#]/, 1)[0];
  path = path.replace(/\/+$/, '');
  return path.toLowerCase();
}

/**
 * 地址是否指向管理后台。
 *
 * 站点导航与页脚是站长自由编辑的内容：默认页脚曾带一条「管理后台」，普通成员
 * 也会看到它。把这条地址识别出来，交给调用方按 `adminEntry` 决定是否渲染。
 * 自定义后台入口（`admin_path`）也要一并识别，否则改过入口的站点仍会漏。
 */
export function isAdminHref(href: string, adminPath: string = DEFAULT_ADMIN_PATH): boolean {
  const base = normalizePath(adminPath) || DEFAULT_ADMIN_PATH;
  const target = normalizePath(href);
  if (!target) return false;
  return target === base || target.startsWith(`${base}/`);
}

function kindOf(value: string | undefined): ContentKind | null {
  if (value === 'article') return 'article';
  if (value === 'post') return 'post';
  return null;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** 写作台地址：新建 `/write/new/article`，编辑 `/write/article/:id`。 */
export function writingPath(kind: ContentKind = 'article', id?: string): string {
  const safe = kind === 'post' ? 'post' : 'article';
  return id ? `${WRITE_ROUTE}/${safe}/${encodeURIComponent(id)}` : `${WRITE_ROUTE}/new/${safe}`;
}

/** 后台编辑器地址；管理员继续留在后台导航里。 */
export function adminEditorPath(kind: ContentKind = 'article', id?: string): string {
  const safe = kind === 'post' ? 'post' : 'article';
  return id ? `/admin/content/${safe}/${encodeURIComponent(id)}` : `/admin/content/new/${safe}`;
}

/** 站点里的「写文章」链接：管理员回后台，普通成员去写作台。 */
export function writingEntryPath(kind: ContentKind = 'article', adminEntry = false): string {
  return adminEntry ? adminEditorPath(kind) : writingPath(kind);
}

/** 解析 `<base>/new/<kind>` 与 `<base>/<kind>/<id>`；其它形态一律返回 null。 */
function editorParts(
  pathname: string,
  base: string,
): { kind: ContentKind; id?: string } | null {
  if (!pathname.startsWith(`${base}/`)) return null;
  const segments = pathname.slice(base.length + 1).split('/');
  if (segments.length !== 2 || !segments[0] || !segments[1]) return null;
  const [first, second] = segments;
  if (first === 'new') {
    const kind = kindOf(second);
    return kind ? { kind } : null;
  }
  const kind = kindOf(first);
  return kind ? { kind, id: safeDecode(second) } : null;
}

/**
 * 把后台编辑器地址翻译成写作台地址；不是编辑器地址时返回 null。
 *
 * 用来兜住旧链接与书签：普通成员打开 `/admin/content/new/article` 时直接落到
 * 写作台，而不是先看到一句「没有权限」。
 */
export function writeTargetForAdminPath(pathname: string): string | null {
  const parts = editorParts(pathname, '/admin/content');
  return parts ? writingPath(parts.kind, parts.id) : null;
}

/** 写作台地址 → 后台编辑器地址；管理员误入写作台时送回后台。 */
export function adminTargetForWritePath(pathname: string): string | null {
  const parts = editorParts(pathname, WRITE_ROUTE);
  return parts ? adminEditorPath(parts.kind, parts.id) : null;
}
