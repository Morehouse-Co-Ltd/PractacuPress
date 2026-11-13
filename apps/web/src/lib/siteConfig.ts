import type {
  AccessSettings,
  AuthSettings,
  DomainSettings,
  LoadingSettings,
  PerformanceSettings,
  WebConfig,
} from '../types';
import { readAccess } from './access';
import { readAuthSettings } from './authProviders';
import { readDomains } from './domains';
import { readLoading } from './loading';
import { readPerformance } from './performance';
import { t } from './i18n';

/**
 * 站点级配置：访问限制、域名绑定、性能、加载动画与登录方式。
 *
 * 这些设置原本只写在站长的 `localStorage` 里，所以「站长浏览器里看起来生效、真实访客
 * 拿到默认值」。现在它们由服务端持有：
 *
 * - `GET /sites/{id}/site-config` 对访客返回公开子集（浏览器真正执行的部分），
 *   对站点管理员返回完整文档；
 * - `PUT /sites/{id}/site-config` 由管理员保存，带 `revision` 做乐观并发；
 * - 本模块只负责「文档 ↔ WebConfig」的归一化与反向构造，网络与防抖在
 *   `siteConfigSync.ts`，不在这里做 I/O，方便单测。
 *
 * 公开子集的取舍：`auth`（第三方登录的 Client ID 等）与 `domains` 的证书路径、
 * CORS、可信代理、`performance` 的网关 / API / 数据库参数都属于部署意图，不是浏览器
 * 行为，只给管理员看。服务端是同一套规则的最后一道闸门。
 */

export type SiteConfigScope = 'admin' | 'public';

/** 服务端返回的站点配置快照。404 表示站点从未保存过配置。 */
export interface SiteConfigSnapshot {
  config: unknown;
  revision: number;
  updated_at: string;
  scope: SiteConfigScope;
}

/** 保存之后的版本号。下一次写入要带上它做乐观并发。 */
export interface SiteConfigSaved {
  revision: number;
  updated_at: string;
}

/** 站点配置文档的已知字段。未知字段由服务端忽略、由读入函数丢弃。 */
export interface SiteConfigDocument {
  admin_path?: string;
  access?: unknown;
  domains?: unknown;
  performance?: unknown;
  loading?: unknown;
  auth?: unknown;
}

/**
 * 会触发服务端保存的 `WebConfig` 字段。
 *
 * `App.applyConfig` 用它在一次本地更新之后叫一声保存句柄；其余字段（站点名、角色
 * 快照、站点形态）走各自的接口或只属于本机。
 */
export const SITE_CONFIG_PATCH_KEYS = [
  'admin_path',
  'access',
  'domains',
  'performance',
  'loading',
  'auth',
] as const;

export function hasSiteConfigPatch(patch: Partial<WebConfig>): boolean {
  return SITE_CONFIG_PATCH_KEYS.some((key) => key in patch);
}

export const DEFAULT_ADMIN_PATH = '/admin';

/**
 * 后台入口不能占用的路径。
 *
 * 后台路由挂在配置的入口下，选了 `/login` 会把登录页藏进需要登录的后台外壳里，
 * 选了 `/api` 会盖住反向代理的 API。服务端有一份同样的表：前端提前拦住只是为了
 * 不发出一次注定被拒绝的保存。
 */
const RESERVED_ADMIN_PATHS = [
  '/setup',
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
  '/verify-email',
  '/api',
  '/articles',
  '/posts',
  '/categories',
  '/category',
  '/tags',
  '/tag',
  '/search',
  '/u',
  '/me',
  '/messages',
  '/notifications',
  '/a',
  '/p',
  '/rss.xml',
  '/atom.xml',
  '/sitemap.xml',
  '/robots.txt',
];

/** 去掉首尾空白与结尾斜杠；空串表示「未配置」。 */
export function normalizeAdminPath(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed;
}

/** 当前生效的后台入口；未配置 / 非法时回退 `/admin`。 */
export function adminPathOf(config: Pick<WebConfig, 'admin_path'>): string {
  const normalized = normalizeAdminPath(config.admin_path);
  if (!normalized || normalized === '/' || !normalized.startsWith('/')) return DEFAULT_ADMIN_PATH;
  return normalized;
}

/** 校验后台入口；返回空串表示通过，否则是可直接展示的说明。 */
export function adminPathError(value: unknown): string {
  const normalized = normalizeAdminPath(value);
  if (!normalized || normalized === '/') return t('后台入口不能为空。');
  if (!normalized.startsWith('/')) return t('后台入口地址必须是以 / 开头且不含空格的路径。');
  if (normalized.includes('//') || /\s/.test(normalized)) {
    return t('后台入口地址必须是以 / 开头且不含空格的路径。');
  }
  if (/[?#]/.test(normalized)) return t('后台入口只能是路径，不能带查询参数。');
  if (normalized.length > 80) return t('后台入口最多 80 个字符。');
  const lowered = normalized.toLowerCase();
  for (const reserved of RESERVED_ADMIN_PATHS) {
    if (lowered === reserved || lowered.startsWith(`${reserved}/`)) {
      return t('{path} 是站点自己的路径，请换一个入口。', { path: reserved });
    }
  }
  return '';
}

/**
 * 把服务端文档归一化成可以写进 `WebConfig` 的补丁。
 *
 * `scope === 'public'` 时只覆盖公开字段，未公开的部署参数沿用本地值：访客引导前的
 * 匿名请求也会走到这里，不能让一份公开子集把站长本机的证书路径、CORS 与网关参数
 * 抹成默认值。`current` 是本地配置，缺省时按默认值处理（访客路径）。
 */
export function readSiteConfig(
  document: unknown,
  scope: SiteConfigScope,
  current?: WebConfig | null,
): Partial<WebConfig> {
  const raw = isPlainObject(document) ? document : {};
  const local = current ?? null;

  const patch: Partial<WebConfig> = {
    access: readAccess({ access: raw.access as AccessSettings | undefined }),
    loading: readLoading({ loading: raw.loading as LoadingSettings | undefined }),
  };

  const localDomains = readDomains({ domains: local?.domains });
  const localPerformance = readPerformance({ performance: local?.performance });
  const localAuth = readAuthSettings({ auth: local?.auth });

  if (scope === 'admin') {
    patch.domains = readDomains({ domains: raw.domains as DomainSettings | undefined });
    patch.performance = readPerformance({
      performance: raw.performance as PerformanceSettings | undefined,
    });
    patch.auth = readAuthSettings({ auth: raw.auth as AuthSettings | undefined });
  } else {
    // 公开子集是「部分字段」：先摊开本地完整对象，再用远端提供的字段覆盖。
    patch.domains = readDomains({
      domains: { ...localDomains, ...(isPlainObject(raw.domains) ? raw.domains : {}) } as DomainSettings,
    });
    patch.performance = readPerformance({
      performance: {
        ...localPerformance,
        ...(isPlainObject(raw.performance) ? raw.performance : {}),
      } as PerformanceSettings,
    });
    // 登录方式的公开字段只有开关：登录页据此决定画哪些按钮。Client ID 之类的
    // 参数只有管理员能读到，所以这里保留本地值，只覆盖 enabled。
    patch.auth = readAuthSettings({
      auth: mergeAuthSwitches(localAuth, raw.auth) as AuthSettings,
    });
  }

  const adminPath = normalizeAdminPath(raw.admin_path);
  if (adminPath) {
    patch.admin_path = adminPath === DEFAULT_ADMIN_PATH ? undefined : adminPath;
  } else if (scope === 'admin') {
    // 管理员读到的就是完整文档：没有 admin_path 表示服务端确实用默认入口，
    // 本机残留的自定义入口必须被清掉，否则只有这台电脑能进后台。
    patch.admin_path = undefined;
  }

  return patch;
}

/**
 * 只把公开投影里的 `auth.<id>.enabled` 合并进本地设置。
 *
 * 公开文档里没有 client_id 等参数；直接把整个 `auth` 拿去归一化会把本机的参数抹成
 * 空串，下一次保存就会把它们覆盖掉。
 */
function mergeAuthSwitches(
  local: AuthSettings,
  remote: unknown,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...local };
  if (!isPlainObject(remote)) return merged;
  for (const [id, value] of Object.entries(remote)) {
    if (!isPlainObject(value) || typeof value.enabled !== 'boolean') continue;
    const previous = isPlainObject(merged[id]) ? (merged[id] as Record<string, unknown>) : {};
    merged[id] = { ...previous, enabled: value.enabled };
  }
  return merged;
}

/**
 * 把当前配置反向构造成保存用的文档。
 *
 * 每次都写完整文档（包括没改的段落），这样第一次保存就把本机已有的设置整体搬到
 * 服务端；否则一次只保存 `access` 的写入会让其他段落继续保持「只有这台电脑知道」。
 */
export function buildSiteConfigDocument(config: Pick<
  WebConfig,
  'admin_path' | 'access' | 'domains' | 'performance' | 'loading' | 'auth'
>): SiteConfigDocument {
  return {
    admin_path: adminPathOf(config),
    access: readAccess({ access: config.access }),
    domains: readDomains({ domains: config.domains }),
    performance: readPerformance({ performance: config.performance }),
    loading: readLoading({ loading: config.loading }),
    auth: readAuthSettings({ auth: config.auth }),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
