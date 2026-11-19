/**
 * 跨标签页的登录态信号。
 *
 * 访问令牌只保存在内存里（这是刻意的：`localStorage` 对同域脚本可读，把令牌落盘
 * 等于给 XSS 一个长期凭证），刷新靠 HttpOnly Cookie。因此这里**不传令牌**，只传
 * 「哪个标签页刚刚登录 / 退出」：
 *
 * - 收到「登录」：用浏览器共享的刷新 Cookie 自己换一张新令牌，界面立刻变成已登录；
 * - 收到「退出」：直接清空本地会话，不用等下一次请求撞上 401。
 *
 * 传输优先 BroadcastChannel（即时、不落盘），localStorage 兜底（Channel 被禁用或
 * 老浏览器）。写入方不会收到自己的 storage 事件；BroadcastChannel 用来源 id 过滤。
 */

export type SessionSignalKind = 'login' | 'logout';

export interface SessionSignal {
  kind: SessionSignalKind;
  /** 登录成功时是这次的用户 id：同一个账户已经在线的标签页不必再换一次令牌。 */
  userId?: string;
  /** 发送时间，用于去重与调试。 */
  at: number;
  /** 发送方标签页 id；接收方据此忽略自己发出去（或本地回放）的信号。 */
  source: string;
}

/** `localStorage` 里的信号槽：storage 事件是兜底通道。 */
export const SESSION_SIGNAL_KEY = 'pp.session.signal.v1';
/** 跨标签页刷新互斥锁；同一浏览器的刷新必须排队，见 `acquireRefreshLock`。 */
export const REFRESH_LOCK_KEY = 'pp.session.refresh.v1';
const CHANNEL_NAME = 'pp-session-v1';
/** 一次刷新可能慢到十几秒（弱网），锁的 TTL 要盖住它，否则中途会被别的标签页抢走。 */
const LOCK_TTL_MS = 20000;
/** 等待上限：宁可放弃加锁直接刷新，也不能让登录一直转圈。 */
const LOCK_WAIT_MS = 2000;

function safeStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function makeId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 当前页面加载的标识。
 *
 * 刻意不落 sessionStorage：浏览器「复制标签页」会把 sessionStorage 一起复制过来，
 * 两个真实标签页拿到同一个 id 之后就会互相忽略对方的信号。这个 id 只用于调试与
 * 挡住本地回放（BroadcastChannel 本来就不会投递给发送者自己）。
 */
const pageId = makeId();

export function currentPageId(): string {
  return pageId;
}

interface ChannelLike {
  postMessage(value: unknown): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  close(): void;
}

let channel: ChannelLike | null | undefined;

function sessionChannel(): ChannelLike | null {
  if (channel !== undefined) return channel;
  channel = null;
  if (typeof window === 'undefined') return channel;
  const Ctor = (globalThis as { BroadcastChannel?: new (name: string) => ChannelLike })
    .BroadcastChannel;
  if (!Ctor) return channel;
  try {
    channel = new Ctor(CHANNEL_NAME);
  } catch {
    channel = null;
  }
  return channel;
}

function isSessionSignal(value: unknown): value is SessionSignal {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<SessionSignal>;
  if (candidate.kind !== 'login' && candidate.kind !== 'logout') return false;
  if (typeof candidate.at !== 'number' || typeof candidate.source !== 'string') return false;
  return candidate.userId === undefined || typeof candidate.userId === 'string';
}

/**
 * 广播一次登录态变化。
 *
 * 两条通道都发：storage 事件覆盖不支持 BroadcastChannel 的浏览器，Channel 让同一
 * 毫秒打开的新标签页也能立刻跟上。任何一步失败都不影响本标签页的状态。
 */
export function broadcastSessionSignal(kind: SessionSignalKind, userId?: string): void {
  if (typeof window === 'undefined') return;
  const signal: SessionSignal = { kind, at: Date.now(), source: currentPageId() };
  if (userId) signal.userId = userId;
  try {
    safeStorage()?.setItem(SESSION_SIGNAL_KEY, JSON.stringify(signal));
  } catch {
    /* 配额满 / 隐私模式：还有 BroadcastChannel */
  }
  try {
    sessionChannel()?.postMessage(signal);
  } catch {
    /* Channel 已关闭 */
  }
}

/** 订阅其它标签页的登录态变化；返回取消订阅函数。 */
export function subscribeSessionSignals(handler: (signal: SessionSignal) => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const own = currentPageId();
  const deliver = (signal: SessionSignal) => {
    if (signal.source === own) return;
    handler(signal);
  };

  const onStorage = (event: StorageEvent) => {
    if (event.key !== SESSION_SIGNAL_KEY || !event.newValue) return;
    try {
      const parsed: unknown = JSON.parse(event.newValue);
      if (isSessionSignal(parsed)) deliver(parsed);
    } catch {
      /* 别的代码写坏了这个键，忽略 */
    }
  };

  const bus = sessionChannel();
  const onMessage = (event: MessageEvent) => {
    if (isSessionSignal(event.data)) deliver(event.data);
  };

  window.addEventListener('storage', onStorage);
  bus?.addEventListener('message', onMessage);
  return () => {
    window.removeEventListener('storage', onStorage);
    bus?.removeEventListener('message', onMessage);
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function readLock(store: Storage): { id?: string; until?: number } | null {
  try {
    const raw = store.getItem(REFRESH_LOCK_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const { id, until } = parsed as { id?: unknown; until?: unknown };
    return {
      id: typeof id === 'string' ? id : undefined,
      until: typeof until === 'number' ? until : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * 抢占刷新锁。
 *
 * 刷新令牌是一次性的：服务端看到一枚已经被轮换过的令牌，会判定「重放」并撤销整个
 * 会话家族（`refresh_reuse`）。两个标签页同时拿同一张刷新 Cookie 去换令牌，就可能
 * 把用户整体登出——而用户看到的正是「要刷新一下页面」。
 *
 * localStorage 没有原子 CAS，所以用「写 → 等一下 → 读回验证」：最后一个写入者拿到
 * 锁，先写的一方看到别人的 id 继续等待。锁带 TTL，标签页被强杀也不会永久卡住；
 * 等待超时就放弃加锁直接执行——宁可冒一次并发风险，也不能让登录一直转圈。
 */
export async function acquireRefreshLock(
  waitMs = LOCK_WAIT_MS,
  ttlMs = LOCK_TTL_MS,
): Promise<() => void> {
  const store = safeStorage();
  if (!store) return () => undefined;
  const id = makeId();
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const holder = readLock(store);
    const free = !holder || !holder.id || typeof holder.until !== 'number' || holder.until <= Date.now();
    if (free) {
      try {
        store.setItem(REFRESH_LOCK_KEY, JSON.stringify({ id, until: Date.now() + ttlMs }));
      } catch {
        return () => undefined;
      }
      await sleep(15);
      if (readLock(store)?.id === id) {
        let released = false;
        return () => {
          if (released) return;
          released = true;
          try {
            if (readLock(store)?.id === id) store.removeItem(REFRESH_LOCK_KEY);
          } catch {
            /* 存储不可写：等 TTL 自然过期 */
          }
        };
      }
    }
    if (Date.now() >= deadline) return () => undefined;
    await sleep(40);
  }
}

/** 拿到锁再执行一次刷新；释放放在 finally，失败不会把其它标签页一起堵死。 */
export async function withRefreshLock<T>(run: () => Promise<T>): Promise<T> {
  const release = await acquireRefreshLock();
  try {
    return await run();
  } finally {
    release();
  }
}
