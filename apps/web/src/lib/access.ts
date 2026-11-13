import { useEffect, useState } from 'react';
import type {
  AccessReason,
  AccessSettings,
  RateRule,
  WebConfig,
} from '../types';
import { t } from './i18n';
import { settingBool, settingInt, settingText } from './settings';

/**
 * 访问限制。
 *
 * 浏览器端只能约束使用本站脚本的访问者：页面切换、页面脚本发出的后端请求，
 * 以及同一浏览器打开的标签页。它挡不住直接打 API 或静态资源的机器人——
 * 真正的 DDoS / CC 防护仍由反向代理（Nginx limit_req / limit_conn）或
 * Cloudflare 之类的边缘完成，后台「访问限制」页会按这里的数值生成配置。
 *
 * 管理后台、安装向导和页面编排的预览 iframe 永远豁免，保证站长不会把自己
 * 锁在门外。
 */

export const DEFAULT_ACCESS: AccessSettings = {
  enabled: false,
  page_switch: {
    enabled: true,
    limit: 40,
    window_seconds: 60,
    block_seconds: 30,
  },
  requests: {
    enabled: true,
    limit: 180,
    window_seconds: 60,
    block_seconds: 30,
  },
  tabs: { enabled: true, limit: 8 },
  /** 持久化的默认配置值（「恢复默认」会整份写进 config），保持中文；显示时见 `message()`。 */
  message: '访问过于频繁，请稍后再试。',
};

function readRule(value: unknown, fallback: RateRule): RateRule {
  const raw = value as Partial<RateRule> | undefined;
  return {
    enabled: settingBool(raw?.enabled, fallback.enabled),
    limit: settingInt(raw?.limit, fallback.limit, 1, 10000),
    window_seconds: settingInt(raw?.window_seconds, fallback.window_seconds, 1, 3600),
    block_seconds: settingInt(raw?.block_seconds, fallback.block_seconds, 1, 86400),
  };
}

/** 旧配置 / 导入字段收敛成完整结构。 */
export function readAccess(config: Pick<WebConfig, 'access'>): AccessSettings {
  const raw = config.access;
  return {
    enabled: settingBool(raw?.enabled, DEFAULT_ACCESS.enabled),
    page_switch: readRule(raw?.page_switch, DEFAULT_ACCESS.page_switch),
    requests: readRule(raw?.requests, DEFAULT_ACCESS.requests),
    tabs: {
      enabled: settingBool(raw?.tabs?.enabled, DEFAULT_ACCESS.tabs.enabled),
      limit: settingInt(raw?.tabs?.limit, DEFAULT_ACCESS.tabs.limit, 1, 64),
    },
    message: settingText(raw?.message, DEFAULT_ACCESS.message, 200),
  };
}

export interface AccessDecision {
  allowed: boolean;
  reason: AccessReason | null;
  retryAfterMs: number;
  message: string;
}

export interface AccessSnapshot {
  pageSwitches: number;
  requests: number;
  blockedUntil: number;
  reason: AccessReason | null;
  retryAfterMs: number;
  message: string;
}

export interface AccessBlockState {
  until: number;
  reason: AccessReason;
}

/** block 状态持久化只用一个键；存储不可用时退化为内存。 */
export interface AccessBlockStore {
  read(): AccessBlockState | null;
  write(state: AccessBlockState): void;
  clear(): void;
}

const BLOCK_KEY = 'pp.access.block.v1';

function sessionBlockStore(): AccessBlockStore {
  let memory: AccessBlockState | null = null;
  let storage: Storage | null = null;
  try {
    storage = window.sessionStorage;
  } catch {
    storage = null;
  }
  const readRaw = (): string | null => {
    if (!storage) return null;
    try {
      return storage.getItem(BLOCK_KEY);
    } catch {
      return null;
    }
  };
  const writeRaw = (value: string): void => {
    if (!storage) return;
    try {
      storage.setItem(BLOCK_KEY, value);
    } catch {
      /* 隐私模式或配额满了就只保留内存状态 */
    }
  };
  const removeRaw = (): void => {
    if (!storage) return;
    try {
      storage.removeItem(BLOCK_KEY);
    } catch {
      /* 忽略 */
    }
  };
  return {
    read() {
      if (memory) return memory;
      const raw = readRaw();
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as Partial<AccessBlockState>;
        if (
          typeof parsed.until !== 'number' ||
          !Number.isFinite(parsed.until) ||
          (parsed.reason !== 'page_switch' &&
            parsed.reason !== 'request' &&
            parsed.reason !== 'tabs')
        ) {
          return null;
        }
        memory = { until: parsed.until, reason: parsed.reason };
        return memory;
      } catch {
        return null;
      }
    },
    write(state) {
      memory = state;
      writeRaw(JSON.stringify(state));
    },
    clear() {
      memory = null;
      removeRaw();
    },
  };
}

function inWindow(events: number[], windowMs: number, now: number): number[] {
  return events.filter((at) => now - at < windowMs);
}

function allowedDecision(): AccessDecision {
  return { allowed: true, reason: null, retryAfterMs: 0, message: '' };
}

export interface AccessControllerOptions {
  now?: () => number;
  store?: AccessBlockStore;
}

export class AccessController {
  private settings: AccessSettings = DEFAULT_ACCESS;
  private adminPaths = new Set<string>(['/admin', '/setup']);
  private pageEvents: number[] = [];
  private requestEvents: number[] = [];
  private blocked: AccessBlockState | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;
  private readonly store: AccessBlockStore;

  constructor(options: AccessControllerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.store = options.store ?? sessionBlockStore();
    this.blocked = this.store.read();
    if (this.blocked && this.blocked.until <= this.now()) {
      this.blocked = null;
      this.store.clear();
    }
  }

  configure(settings: AccessSettings, adminPath?: string): void {
    this.settings = settings;
    // 后台入口是站点级配置：改了入口之后，旧的 /admin 就是一个普通的站点路径，
    // 不该再享受「后台永远豁免」。安装向导始终豁免。
    const entry = (adminPath ?? '').trim().replace(/\/+$/, '') || '/admin';
    this.adminPaths = new Set<string>(['/setup', entry]);

    if (!settings.enabled) {
      this.pageEvents = [];
      this.requestEvents = [];
      this.clearBlock();
      return;
    }

    if (this.blocked) {
      const stillEnabled =
        this.blocked.reason === 'page_switch'
          ? settings.page_switch.enabled
          : this.blocked.reason === 'request'
            ? settings.requests.enabled
            : settings.tabs.enabled;
      if (!stillEnabled) this.clearBlock();
    }
    this.emit();
  }

  isAdminPath(pathname: string): boolean {
    if (pathname === '/setup' || pathname.startsWith('/setup/')) return true;
    if (isAuthPath(pathname)) return true;
    for (const adminPath of this.adminPaths) {
      if (pathname === adminPath || pathname.startsWith(`${adminPath}/`)) return true;
    }
    return false;
  }

  /** 记录一次页面切换；仅在实际发生导航时调用。 */
  checkPageSwitch(pathname: string, now = this.now()): AccessDecision {
    if (!this.settings.enabled || !this.settings.page_switch.enabled) return allowedDecision();
    if (this.isAdminPath(pathname)) return allowedDecision();
    const active = this.activeBlock(now);
    if (active) return this.blockedDecision(active, now);

    const rule = this.settings.page_switch;
    const windowMs = rule.window_seconds * 1000;
    this.pageEvents = inWindow(this.pageEvents, windowMs, now);
    this.pageEvents.push(now);
    if (this.pageEvents.length > rule.limit) {
      return this.trigger('page_switch', rule.block_seconds, now);
    }
    return allowedDecision();
  }

  /** 在真正发出请求前调用；返回不允许时调用方必须拒绝请求。 */
  beforeRequest(pathname: string, now = this.now()): AccessDecision {
    if (!this.settings.enabled || !this.settings.requests.enabled) return allowedDecision();
    if (this.isAdminPath(pathname)) return allowedDecision();
    const active = this.activeBlock(now);
    if (active) return this.blockedDecision(active, now);

    const rule = this.settings.requests;
    const windowMs = rule.window_seconds * 1000;
    this.requestEvents = inWindow(this.requestEvents, windowMs, now);
    this.requestEvents.push(now);
    if (this.requestEvents.length > rule.limit) {
      return this.trigger('request', rule.block_seconds, now);
    }
    return allowedDecision();
  }

  snapshot(): AccessSnapshot {
    const now = this.now();
    const active = this.activeBlock(now);
    if (active) {
      return {
        pageSwitches: 0,
        requests: 0,
        blockedUntil: active.until,
        reason: active.reason,
        retryAfterMs: Math.max(0, active.until - now),
        message: this.message(),
      };
    }
    const pageRule = this.settings.page_switch;
    const requestRule = this.settings.requests;
    this.pageEvents = inWindow(this.pageEvents, pageRule.window_seconds * 1000, now);
    this.requestEvents = inWindow(this.requestEvents, requestRule.window_seconds * 1000, now);
    return {
      pageSwitches: this.pageEvents.length,
      requests: this.requestEvents.length,
      blockedUntil: 0,
      reason: null,
      retryAfterMs: 0,
      message: this.message(),
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 站长手动解除当前浏览器的限制。 */
  clear(): void {
    this.pageEvents = [];
    this.requestEvents = [];
    this.clearBlock();
  }

  private activeBlock(now: number): AccessBlockState | null {
    if (!this.blocked) return null;
    if (this.blocked.until <= now) {
      this.clearBlock();
      return null;
    }
    return this.blocked;
  }

  private trigger(reason: AccessReason, blockSeconds: number, now: number): AccessDecision {
    const until = now + blockSeconds * 1000;
    this.blocked = { until, reason };
    this.store.write(this.blocked);
    // 解除后不应立刻被同一批旧事件再次触发。
    if (reason === 'page_switch') this.pageEvents = [];
    if (reason === 'request') this.requestEvents = [];
    this.emit();
    return this.blockedDecision(this.blocked, now);
  }

  private blockedDecision(state: AccessBlockState, now: number): AccessDecision {
    return {
      allowed: false,
      reason: state.reason,
      retryAfterMs: Math.max(0, state.until - now),
      message: this.message(),
    };
  }

  private clearBlock(): void {
    this.blocked = null;
    this.store.clear();
    this.emit();
  }

  /**
   * 拦住访客时显示的那句话。
   *
   * 站长自己写的提示原样显示（那是他的内容）；空着、或者还是读取配置时补上的
   * 出厂默认值，就按当前语言给默认提示——默认值本身存在 config 里保持中文，
   * 只在这一处临时翻译。
   */
  private message(): string {
    const custom = this.settings.message.trim();
    if (!custom || custom === DEFAULT_ACCESS.message) return t(DEFAULT_ACCESS.message);
    return custom;
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/** 登录、注册与找回密码必须始终可达，否则被限制的站长无法回后台解除。 */
const AUTH_PATHS = ['/login', '/register', '/forgot-password', '/reset-password'];

export function isAuthPath(pathname: string): boolean {
  return AUTH_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

export const accessController = new AccessController();

/** React 组件里订阅访问限制状态；倒计时需要每秒刷新。 */
export function useAccessSnapshot(intervalMs = 1000): AccessSnapshot {
  const [snapshot, setSnapshot] = useState<AccessSnapshot>(() => accessController.snapshot());
  useEffect(() => {
    const update = () => setSnapshot(accessController.snapshot());
    update();
    const unsubscribe = accessController.subscribe(update);
    // 只在被限制时每秒刷新倒计时；正常浏览时不做无意义的重渲染。
    const timer = window.setInterval(() => {
      if (accessController.snapshot().blockedUntil) update();
    }, intervalMs);
    return () => {
      unsubscribe();
      window.clearInterval(timer);
    };
  }, [intervalMs]);
  return snapshot;
}

export class AccessBlockedError extends Error {
  readonly code = 'access_blocked';
  readonly reason: AccessReason;
  readonly retryAfterMs: number;

  constructor(decision: AccessDecision) {
    super(decision.message || DEFAULT_ACCESS.message);
    this.name = 'AccessBlockedError';
    this.reason = decision.reason ?? 'request';
    this.retryAfterMs = decision.retryAfterMs;
  }
}

/** 页面编排的预览 iframe 不启用任何站点级限制，避免编辑时反复被拦。 */
export function isPreviewFrame(): boolean {
  try {
    return window.parent !== window;
  } catch {
    return true;
  }
}

export function isSiteSurface(pathname: string): boolean {
  if (isPreviewFrame()) return false;
  if (pathname === '/setup' || pathname.startsWith('/setup/')) return false;
  return !accessController.isAdminPath(pathname);
}
