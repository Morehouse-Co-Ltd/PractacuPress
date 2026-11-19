/**
 * 高威胁操作二次验证（step-up）的纯逻辑层。
 *
 * 这里只放不依赖 React 渲染的东西：
 * - 浏览器会话级令牌仓库（验证成功后缓存，关闭浏览器后失效，`expires_in` 之前复用）；
 * - 受保护动作清单，供调用方与单测共用；
 * - 演示模式的高威胁操作保护设置（存在浏览器本地，不伪造任何密码校验）。
 *
 * Provider 与弹窗在 `components/StepUpModal.tsx`；HTTP 实现在 `lib/api.ts`。
 *
 * 验证的有效范围是「一次浏览器会话」：令牌放在 `sessionStorage` 里，刷新页面、
 * 页内跳转都不会再询问；关闭浏览器（标签页会话结束）后 storage 自动清空，下一次
 * 打开浏览器做高危操作时必须重新输入一次密码。服务端 `expires_in` 仍是一个硬上限
 * （见 `site.StepUpTokenTTL`），客户端不会把过期的令牌发出去。
 * 令牌带上账户与站点 id，换账户 / 换站点后立即作废；不写 localStorage。
 */
import { createContext, useContext } from 'react';
import type { StepUpSettings, StepUpSettingsUpdate } from '../types';

/** 受保护请求携带的请求头；值是一次验证后拿到的会话级令牌。 */
export const STEP_UP_HEADER = 'X-PP-Step-Up';

/** 浏览器会话级令牌的存储键；sessionStorage 关闭浏览器即清空。 */
export const STEP_UP_SESSION_KEY = 'pp.web.stepup.grant.v1';

/** 演示模式把保护开关存在这个键下；专用密码不会出现在这里。 */
export const DEMO_STEP_UP_KEY = 'pp.web.stepup.demo.v1';

/**
 * 后端契约的默认窗口（秒）；旧后端不返回时按它展示。
 *
 * 与 `internal/site/stepup.go` 的 `StepUpTokenTTL` 对齐：一次验证的
 * 服务端硬上限是 7 天，真正的「一次浏览器会话」由 sessionStorage 负责收窄。
 */
export const DEFAULT_STEP_UP_WINDOW_SECONDS = 7 * 24 * 60 * 60;

/**
 * 需要二次验证的动作。
 *
 * 与服务端 step-up 守卫保护的路由一一对应，集中列出来是为了让「哪些操作算高危」
 * 有唯一答案：新增受保护路由时先改这里，再在页面里 `ensureStepUp()`。
 */
export type StepUpAction =
  | 'member.create'
  | 'member.update'
  | 'member.group'
  | 'member.role'
  | 'member.status'
  | 'member.quota'
  | 'member.two_factor_reset'
  | 'member.delete'
  | 'site.import'
  | 'site.safety_word_delete'
  | 'site.ip_rule_delete';

const STEP_UP_ACTIONS: readonly StepUpAction[] = [
  'member.create',
  'member.update',
  'member.group',
  'member.role',
  'member.status',
  'member.quota',
  'member.two_factor_reset',
  'member.delete',
  'site.import',
  'site.safety_word_delete',
  'site.ip_rule_delete',
];

/** 这个动作是否属于「高威胁操作」；未知动作一律返回 false。 */
export function isProtectedAction(action: string): action is StepUpAction {
  return (STEP_UP_ACTIONS as readonly string[]).includes(action);
}

/* ---------- 浏览器会话级令牌仓库（sessionStorage） ---------- */

/** 令牌绑定的账户与站点；缺省项表示旧令牌没有记录（只能靠服务端拒绝兜底）。 */
export interface StepUpGrantIdentity {
  userId?: string | null;
  siteId?: string | null;
}

export interface StepUpStoreOptions extends StepUpGrantIdentity {
  now?: number;
}

interface StoredGrant {
  token: string;
  expires_at: number;
  user_id?: string;
  site_id?: string;
}

/** sessionStorage 不可用时的页面内兜底：仍然不会落到 localStorage。 */
let memoryGrant: StoredGrant | null = null;

function sessionStorageOrNull(): StepUpStorage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

function parseGrant(raw: string | null): StoredGrant | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredGrant>;
    if (typeof parsed?.token !== 'string' || !parsed.token) return null;
    if (typeof parsed.expires_at !== 'number' || !Number.isFinite(parsed.expires_at)) return null;
    const grant: StoredGrant = { token: parsed.token, expires_at: parsed.expires_at };
    if (typeof parsed.user_id === 'string' && parsed.user_id) grant.user_id = parsed.user_id;
    if (typeof parsed.site_id === 'string' && parsed.site_id) grant.site_id = parsed.site_id;
    return grant;
  } catch {
    return null;
  }
}

function readGrant(): StoredGrant | null {
  const storage = sessionStorageOrNull();
  if (storage) {
    try {
      const parsed = parseGrant(storage.getItem(STEP_UP_SESSION_KEY));
      if (parsed) {
        memoryGrant = parsed;
        return parsed;
      }
    } catch {
      /* 存储读不出来：继续用内存副本 */
    }
  }
  return memoryGrant;
}

function writeGrant(grant: StoredGrant): void {
  memoryGrant = grant;
  const storage = sessionStorageOrNull();
  if (!storage) return;
  try {
    storage.setItem(STEP_UP_SESSION_KEY, JSON.stringify(grant));
  } catch {
    /* 无痕模式或配额满：本次页面内仍复用内存副本，不因为缓存失败而报错。 */
  }
}

/** 令牌是否属于这次请求的账户 / 站点；没记录的字段不做限制。 */
function grantMatches(grant: StoredGrant, identity?: StepUpGrantIdentity): boolean {
  if (!identity) return true;
  if (grant.user_id && identity.userId && grant.user_id !== identity.userId) return false;
  if (grant.site_id && identity.siteId && grant.site_id !== identity.siteId) return false;
  return true;
}

/**
 * 保存一次验证成功的令牌。
 *
 * `expiresIn` 非正数表示服务端没有给出可用窗口：令牌立即作废（等价于验证失败，
 * 下次操作要重新验证），而不是「永不过期」。
 */
export function storeStepUpToken(
  token: string,
  expiresIn: number,
  options: StepUpStoreOptions = {},
): void {
  const seconds = Number.isFinite(expiresIn) && expiresIn > 0 ? Math.floor(expiresIn) : 0;
  if (!token || seconds <= 0) {
    clearStepUpToken();
    return;
  }
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const grant: StoredGrant = {
    token,
    expires_at: now + seconds * 1000,
  };
  if (options.userId) grant.user_id = options.userId;
  if (options.siteId) grant.site_id = options.siteId;
  writeGrant(grant);
}

/**
 * 取仍然有效、且属于当前账户 / 站点的令牌；过期或换身份后顺手清掉，
 * 避免把废令牌发给服务端。
 */
export function getStepUpToken(now = Date.now(), identity?: StepUpGrantIdentity): string | null {
  const grant = readGrant();
  if (!grant) return null;
  if (!grantMatches(grant, identity) || now >= grant.expires_at) {
    clearStepUpToken();
    return null;
  }
  return grant.token;
}

export function isStepUpTokenValid(now = Date.now(), identity?: StepUpGrantIdentity): boolean {
  return getStepUpToken(now, identity) !== null;
}

/** 令牌过期时刻（毫秒时间戳）；0 表示当前没有令牌。 */
export function stepUpTokenExpiresAt(): number {
  return readGrant()?.expires_at ?? 0;
}

export function clearStepUpToken(): void {
  memoryGrant = null;
  const storage = sessionStorageOrNull();
  if (!storage) return;
  try {
    storage.removeItem(STEP_UP_SESSION_KEY);
  } catch {
    /* 存储不可用时内存副本已经清掉 */
  }
}

/* ---------- 演示模式：保护设置只保存在本地 ---------- */

/** 只依赖 Storage 的三个方法，测试可以注入假的存储。 */
export interface StepUpStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const DEFAULT_DEMO_STEP_UP: StepUpSettings = {
  enabled: true,
  password_set: false,
  window_seconds: DEFAULT_STEP_UP_WINDOW_SECONDS,
};

function defaultStorage(): StepUpStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** 把任意来源（本地 JSON、旧版本、手改值）收敛成合法设置，绝不信任字段类型。 */
export function normalizeStepUpSettings(input: unknown): StepUpSettings {
  const record =
    input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const rawWindow = record.window_seconds;
  const windowSeconds =
    typeof rawWindow === 'number' && Number.isFinite(rawWindow) && rawWindow > 0
      ? Math.floor(rawWindow)
      : DEFAULT_STEP_UP_WINDOW_SECONDS;
  return {
    enabled: record.enabled !== false,
    password_set: record.password_set === true,
    window_seconds: windowSeconds,
  };
}

/** 读取演示模式的保护设置；没有存过、或存储不可用时回退默认值。 */
export function readDemoStepUpSettings(storage = defaultStorage()): StepUpSettings {
  if (!storage) return { ...DEFAULT_DEMO_STEP_UP };
  try {
    const raw = storage.getItem(DEMO_STEP_UP_KEY);
    if (!raw) return { ...DEFAULT_DEMO_STEP_UP };
    return normalizeStepUpSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_DEMO_STEP_UP };
  }
}

/**
 * 写入演示模式的保护设置。
 *
 * 只落盘开关与「是否设置过专用密码」这个布尔值；演示模式不保存密码本体，也从不
 * 校验密码——`DemoStepUpBackend.verifyStepUp` 会明确报错，不伪造安全校验。
 */
export function saveDemoStepUpSettings(
  patch: StepUpSettingsUpdate,
  storage = defaultStorage(),
): StepUpSettings {
  const current = readDemoStepUpSettings(storage);
  const next: StepUpSettings = {
    ...current,
    enabled: typeof patch.enabled === 'boolean' ? patch.enabled : current.enabled,
  };
  if (patch.clear_password) next.password_set = false;
  if (storage) {
    try {
      storage.setItem(DEMO_STEP_UP_KEY, JSON.stringify(next));
    } catch {
      /* 无痕模式写不进去：设置只对本次会话有效，界面不因此报错。 */
    }
  }
  return next;
}

/* ---------- React 上下文 ---------- */

export interface StepUpContextValue {
  /**
   * 执行高危操作之前调用。
   *
   * - 令牌还在有效期内：直接放行，不弹窗；
   * - 保护已关闭（且没有专用密码）：直接放行；
   * - 其它情况：弹密码框，验证成功返回 true，取消或失败返回 false。
   *
   * `action` 是可选的动作文案（如「删除账户」），弹窗会原样展示，帮助用户确认自己
   * 正在做什么；不传时只显示通用说明。
   */
  ensureStepUp(action?: string): Promise<boolean>;
  /** 最近一次读到 / 写入的保护设置；null 表示尚未读取（按开启处理）。 */
  settings: StepUpSettings | null;
  /** 设置页保存成功后同步给 Provider，省掉下一次操作前的一次读取请求。 */
  applySettings(next: StepUpSettings | null): void;
  /** 当前是否为演示模式（演示模式不校验二次密码）。 */
  demo: boolean;
}

export const StepUpContext = createContext<StepUpContextValue | null>(null);

/**
 * Provider 之外的兜底值。
 *
 * 页面单独渲染（组件测试、局部预览）时没有 Provider：此时直接放行、不弹窗。真正的
 * 安全边界在服务端守卫，前端弹窗只是交互层；生产入口 `App.tsx` 一定会挂 Provider。
 */
const FALLBACK_CONTEXT: StepUpContextValue = {
  ensureStepUp: () => Promise.resolve(true),
  settings: null,
  applySettings: () => undefined,
  demo: false,
};

export function useStepUp(): StepUpContextValue {
  return useContext(StepUpContext) ?? FALLBACK_CONTEXT;
}
