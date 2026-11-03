import type { SiteCustomization, WebConfig } from '../types';
import { probeSetupStatus, type SetupStatus } from './backend';
import { readCustomization } from './customize';

/**
 * 匿名访客的站点引导（O-1）。
 *
 * 安装配置过去只存在站长浏览器的 `localStorage` 里，所以「全新访客」看到的不是站点，
 * 而是 7 步安装引导。H-1 已经把站点设计搬到服务端，这里补上启动探测：同源问一次
 * `/api/v1/setup/status`，只要站点已安装且已有管理员，就用服务端的站点 id 与设计
 * 构造一份**只读**的 live 配置，直接渲染站点。
 *
 * 约束：
 * - 只读：不向服务端写任何东西，也不把这份配置写回 `localStorage['pp.web.config.v1']`
 *   （否则浏览器会把访客误当成"已安装"的站长）；
 * - 不阻塞开屏：探测失败 / 未安装 / 无管理员都返回 null，由调用方回退 7 步引导；
 * - 设计拉取失败（含 members_only 站点的匿名 404）不是错误：回退默认站点设计。
 */

/** `/api/v1/setup/status` 的公开响应（与安装校验共用同一形状）。 */
export type SetupStatusProbe = SetupStatus;

export type VisitorCustomizationOutcome = 'applied' | 'absent' | 'unavailable';

export interface VisitorBootstrapResult {
  config: WebConfig;
  /** 服务端设计是否已并入配置；absent / unavailable 表示回退默认设计。 */
  customization: VisitorCustomizationOutcome;
}

export interface VisitorBootstrapOptions {
  /** 同源站点地址；默认 `window.location.origin`。 */
  origin?: string;
  /** 注入 fetch 便于测试；默认全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 探测超时（毫秒）。 */
  timeoutMs?: number;
  /** 设计拉取超时（毫秒）。 */
  customizationTimeoutMs?: number;
}

function resolveOrigin(origin?: string): string {
  const fallback = typeof window === 'undefined' ? '' : window.location.origin;
  return (origin ?? fallback).trim().replace(/\/+$/, '');
}

function requestSignal(timeoutMs: number): AbortSignal | undefined {
  if (typeof AbortSignal === 'undefined' || typeof AbortSignal.timeout !== 'function') {
    return undefined;
  }
  return AbortSignal.timeout(timeoutMs);
}

/**
 * 探测服务端是否已装好站点。
 *
 * 复用 `probeSetupStatus`：安装校验与访客引导读同一份公开状态，避免两处对
 * "什么算装好了"给出不同答案。任何失败都返回 null，匿名引导宁可回退安装引导，
 * 也不能因为一次探测失败就卡在加载态。
 */
export async function probeServerInstall(
  options: VisitorBootstrapOptions = {},
): Promise<SetupStatusProbe | null> {
  // `origin` 为空时 probeSetupStatus 用同源相对地址（Vite 代理与启动器都支持）。
  const origin = options.origin ? resolveOrigin(options.origin) : '';
  return probeSetupStatus(origin, {
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs,
  });
}

/**
 * 拉取服务端站点设计并归一化。
 *
 * 404 表示站点从未保存过设计（members_only 站点对匿名访客也回 404），两种情况都
 * 回退默认设计而不是报错；其它失败同样降级，不挡住渲染。
 */
async function loadVisitorCustomization(
  siteId: string,
  options: VisitorBootstrapOptions,
): Promise<{ outcome: VisitorCustomizationOutcome; customization: SiteCustomization | null }> {
  const { fetchImpl = fetch, customizationTimeoutMs = 3000 } = options;
  const origin = resolveOrigin(options.origin);
  try {
    const response = await fetchImpl(`${origin}/api/v1/sites/${encodeURIComponent(siteId)}/customization`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      credentials: 'include',
      signal: requestSignal(customizationTimeoutMs),
    });
    if (response.status === 404) return { outcome: 'absent', customization: null };
    if (!response.ok) return { outcome: 'unavailable', customization: null };
    const body = (await response.json()) as { customization?: unknown } | null;
    if (!body || !body.customization || typeof body.customization !== 'object') {
      return { outcome: 'unavailable', customization: null };
    }
    return {
      outcome: 'applied',
      customization: readCustomization({
        customization: body.customization as unknown as SiteCustomization,
      }),
    };
  } catch {
    return { outcome: 'unavailable', customization: null };
  }
}

/**
 * 为匿名访客构造只读 live 配置。
 *
 * 返回 null 表示"这里不是一台装好的站点"（未安装 / 没有管理员 / 探测失败），调用方
 * 应继续展示 7 步安装引导。构造出的配置只放在内存里：`visitor: true` 让上层跳过
 * 安装校验、设计水合与设计回写，并避免把访客状态持久化。
 */
export async function bootstrapVisitorConfig(
  options: VisitorBootstrapOptions = {},
): Promise<VisitorBootstrapResult | null> {
  const status = await probeServerInstall(options);
  if (!status) return null;
  if (status.installed !== true || status.has_admin !== true) return null;
  if (typeof status.site_id !== 'string' || !status.site_id) return null;

  const origin = resolveOrigin(options.origin);
  const { outcome, customization } = await loadVisitorCustomization(status.site_id, options);
  const config: WebConfig = {
    version: 1,
    setup_complete: true,
    mode: 'live',
    api_base: origin,
    site_id: status.site_id,
    // 访客拿不到服务端的数据库类型；这个字段只用于后台展示，访客不会进后台。
    database: 'sqlite',
    created_at: new Date().toISOString(),
    docs_url: `${origin}/api/v1/docs`,
    visitor: true,
    ...(status.site_name ? { visitor_site_name: status.site_name } : {}),
    // O-3：访客引导拿到注册开关后，前台据此隐藏注册入口、注册页显示关闭提示。
    ...(typeof status.registration_open === 'boolean'
      ? { visitor_registration_open: status.registration_open }
      : {}),
    ...(customization ? { customization } : {}),
  };
  return { config, customization: outcome };
}
