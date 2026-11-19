import type { PerformanceSettings, WebConfig } from '../types';
import { normalizeOrigin } from './domains';
import { settingBool, settingInt, settingList } from './settings';

/**
 * 前端性能开关。
 *
 * 只做确实能落在运行时的优化：减少首屏读取条数、关闭入场动画、对 GET 请求
 * 去重并短缓存、提前连接外部资源。服务器压缩与静态资源缓存由部署方决定，
 * 后台会给出 Nginx 片段，而不会假装前端能改这些。
 */

export const DEFAULT_PERFORMANCE: PerformanceSettings = {
  feed_limit: 24,
  archive_limit: 30,
  request_cache: false,
  cache_ttl: 15,
  lazy_media: true,
  disable_animations: false,
  preconnect: [],
  gzip: true,
  static_cache_days: 365,
  keepalive_timeout: 65,
  // 略高于 API 的 25 MiB 单文件上限，避免网关先一步拒绝正常上传。
  client_max_body_size_mb: 32,
  proxy_read_timeout: 60,
  // 与 internal 现有的超时保持一致。
  api_read_timeout: 30,
  api_idle_timeout: 120,
  // 0 = 沿用驱动默认（SQLite 1，MySQL/Postgres 16）。
  db_max_open_conns: 0,
  db_max_idle_conns: 0,
  // 与 internal 现有的 30 分钟连接生命周期一致。
  db_conn_max_lifetime: 1800,
};

function readPreconnect(value: unknown): string[] {
  const out: string[] = [];
  for (const item of settingList(value, 12, 300)) {
    const origin = normalizeOrigin(item);
    if (origin && !out.includes(origin)) out.push(origin);
    if (out.length >= 8) break;
  }
  return out;
}

export function readPerformance(config: Pick<WebConfig, 'performance'>): PerformanceSettings {
  const raw = config.performance;
  return {
    feed_limit: settingInt(raw?.feed_limit, DEFAULT_PERFORMANCE.feed_limit, 1, 60),
    archive_limit: settingInt(raw?.archive_limit, DEFAULT_PERFORMANCE.archive_limit, 1, 60),
    request_cache: settingBool(raw?.request_cache, DEFAULT_PERFORMANCE.request_cache),
    cache_ttl: settingInt(raw?.cache_ttl, DEFAULT_PERFORMANCE.cache_ttl, 1, 120),
    lazy_media: settingBool(raw?.lazy_media, DEFAULT_PERFORMANCE.lazy_media),
    disable_animations: settingBool(
      raw?.disable_animations,
      DEFAULT_PERFORMANCE.disable_animations,
    ),
    preconnect: readPreconnect(raw?.preconnect),
    gzip: settingBool(raw?.gzip, DEFAULT_PERFORMANCE.gzip),
    static_cache_days: settingInt(
      raw?.static_cache_days,
      DEFAULT_PERFORMANCE.static_cache_days,
      1,
      3650,
    ),
    keepalive_timeout: settingInt(
      raw?.keepalive_timeout,
      DEFAULT_PERFORMANCE.keepalive_timeout,
      1,
      3600,
    ),
    client_max_body_size_mb: settingInt(
      raw?.client_max_body_size_mb,
      DEFAULT_PERFORMANCE.client_max_body_size_mb,
      1,
      2048,
    ),
    proxy_read_timeout: settingInt(
      raw?.proxy_read_timeout,
      DEFAULT_PERFORMANCE.proxy_read_timeout,
      1,
      3600,
    ),
    api_read_timeout: settingInt(
      raw?.api_read_timeout,
      DEFAULT_PERFORMANCE.api_read_timeout,
      1,
      600,
    ),
    api_idle_timeout: settingInt(
      raw?.api_idle_timeout,
      DEFAULT_PERFORMANCE.api_idle_timeout,
      1,
      3600,
    ),
    db_max_open_conns: settingInt(
      raw?.db_max_open_conns,
      DEFAULT_PERFORMANCE.db_max_open_conns,
      0,
      512,
    ),
    db_max_idle_conns: settingInt(
      raw?.db_max_idle_conns,
      DEFAULT_PERFORMANCE.db_max_idle_conns,
      0,
      512,
    ),
    db_conn_max_lifetime: settingInt(
      raw?.db_conn_max_lifetime,
      DEFAULT_PERFORMANCE.db_conn_max_lifetime,
      0,
      86400,
    ),
  };
}

let current: PerformanceSettings = DEFAULT_PERFORMANCE;

/** 在 App 启动或配置变更时同步给请求层（HttpBackend 不在 React 树里）。 */
export function configurePerformance(settings: PerformanceSettings): void {
  current = settings;
}

export function currentPerformance(): PerformanceSettings {
  return current;
}

/** 用户设置或系统偏好任一要求减少动效时，返回 true。 */
export function motionReduced(): boolean {
  if (typeof document !== 'undefined' && document.documentElement.dataset.motion === 'reduced') {
    return true;
  }
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    try {
      return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  }
  return false;
}

/** 写到 <html data-motion>，让 CSS 与 JS 动画同时降级。 */
export function applyMotionPreference(settings: PerformanceSettings): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.motion = settings.disable_animations ? 'reduced' : 'full';
}
