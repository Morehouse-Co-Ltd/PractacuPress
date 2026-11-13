/**
 * 实时通道的框架无关内核：票据换连、心跳、退避重连与 `/events` 补偿都在这里。
 *
 * 三条约束来自后端现状：
 *
 * 1. **凭据是票据，不是 access token。** 每次连接（含每次重连）都重新调用
 *    `POST /auth/ws-ticket`；票据 60 秒、单次消费，所以绝不缓存复用。
 * 2. **推送是尽力而为，补偿才是权威。** 连接建立后（有游标时）先拉
 *    `GET /events?after_id=`，把断线期间漏掉的事件按顺序补上；推送与补偿都用
 *    事件 id 去重，避免同一条消息出现两次。
 * 3. **浏览器不能发 WebSocket 协议层 ping。** 服务端也不回应用层 ping，因此
 *    心跳只用于保活与发现已关闭的 socket；“半开连接”由页面重新可见 / 恢复联网
 *    时主动重连来兜底（见 `notifyResume` / `notifyOnline`）。
 *
 * 这个文件不依赖 React，也不直接读 window：宿主（`realtime.tsx`）负责注入票据、
 * 补偿、游标、地址与 WebSocket 实现，测试可以用假计时器与假 socket 精确驱动。
 */
import type { AppEvent, Page } from '../types';

export type RealtimeStatus = 'off' | 'connecting' | 'live' | 'polling';

export interface RealtimeTicket {
  ticket: string;
  expires_at: string;
  url: string;
}

/** 每个标签页独立的断线游标。 */
export interface RealtimeCursorStore {
  get(): string;
  set(id: string): void;
}

export interface RealtimeTiming {
  /** 重连退避的起点。 */
  baseDelayMs: number;
  /** 重连退避的上限。 */
  maxDelayMs: number;
  /** 单次握手（含票据请求后的连接）允许的最长时间；同时不超过票据寿命。 */
  connectTimeoutMs: number;
  /** 保活心跳间隔。 */
  heartbeatMs: number;
  /** 一页补偿事件数。 */
  replayLimit: number;
  /** 单次补偿最多翻几页，避免旧游标把历史事件全部拉回来。 */
  replayPages: number;
}

export const DEFAULT_REALTIME_TIMING: RealtimeTiming = {
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  connectTimeoutMs: 10_000,
  heartbeatMs: 25_000,
  replayLimit: 100,
  replayPages: 5,
};

/** 没有 WebSocket 时回退轮询的周期，与 `session.tsx` 既有的未读轮询一致。 */
export const REALTIME_FALLBACK_POLL_MS = 45_000;

/** 订阅者收到的“轮询到了，去刷新一次”合成事件；没有真实事件 id。 */
export const REALTIME_POLL = 'realtime.poll';

export interface RealtimeDeps {
  /** 申请一张一次性连接票据。每次成功或失败后的重试都会重新调用。 */
  ticket(): Promise<RealtimeTicket>;
  /** 断线补偿。`afterId` 为空表示还没有游标，此时不应调用（见 `replayMissed`）。 */
  replay(afterId: string, limit: number): Promise<Page<AppEvent>>;
  cursor: RealtimeCursorStore;
  /** 后端源站（`http(s)://host`）；空串表示同源。 */
  origin(): string;
  onStatus?(status: RealtimeStatus): void;
  onEvent?(event: AppEvent): void;
  /** 端点不存在等不可恢复失败：停止重试，交给宿主退回轮询。 */
  shouldGiveUp?(error: unknown): boolean;
  /** 测试注入；默认用全局 WebSocket。 */
  WebSocketImpl?: typeof WebSocket;
  now?(): number;
  /** 测试注入的抖动随机源；默认 `Math.random`。 */
  random?(): number;
  timing?: Partial<RealtimeTiming>;
}

/** 全局连接状态：`session.tsx` 的轮询据此决定是否让位给实时推送。 */
let currentStatus: RealtimeStatus = 'off';

export function readRealtimeStatus(): RealtimeStatus {
  return currentStatus;
}

export function writeRealtimeStatus(status: RealtimeStatus): void {
  currentStatus = status;
}

/**
 * 把票据响应里的 `url` 变成浏览器可连接的绝对地址。
 *
 * 票据端点返回的是 `/api/v1/ws?ticket=...`（同源相对），但 API 也可能部署在
 * 另一个源上；两种都要支持。已经是 `ws(s)://` 的原样返回，`http(s)://` 的只换
 * 协议，相对地址用后端源站（没有则用当前页面）解析。
 */
export function absoluteWebSocketUrl(raw: string, origin: string): string {
  const value = (raw ?? '').trim();
  if (!value) return '';
  if (/^wss?:\/\//i.test(value)) return value;
  try {
    if (/^https?:\/\//i.test(value)) {
      const url = new URL(value);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return url.toString();
    }
    const base =
      (origin ?? '').trim() ||
      (typeof window !== 'undefined' && window.location ? window.location.origin : '');
    if (!base) return '';
    const url = new URL(value, `${base.replace(/\/+$/, '')}/`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : url.protocol === 'http:' ? 'ws:' : url.protocol;
    return url.toString();
  } catch {
    return '';
  }
}

/**
 * 指数退避 + 抖动。
 *
 * 抖动是为了避免同一站点的多个标签页在服务重启后同一毫秒重连；`attempt` 从 0
 * 开始，第一次失败后等 baseDelay 左右。
 */
export function nextRetryDelay(
  attempt: number,
  timing: Pick<RealtimeTiming, 'baseDelayMs' | 'maxDelayMs'> = DEFAULT_REALTIME_TIMING,
  random: () => number = Math.random,
): number {
  const safe = Math.min(Math.max(0, Math.floor(attempt)), 8);
  const raw = Math.min(timing.maxDelayMs, timing.baseDelayMs * 2 ** safe);
  const jitter = 0.8 + random() * 0.4;
  return Math.max(0, Math.round(raw * jitter));
}

/** 把一帧文本解析成事件；心跳、坏 JSON、缺类型的帧一律忽略。 */
export function parseRealtimeEvent(raw: unknown): AppEvent | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type.trim() : '';
  if (!type || type === 'ping' || type === 'pong') return null;
  const payload =
    record.payload && typeof record.payload === 'object' && !Array.isArray(record.payload)
      ? (record.payload as Record<string, unknown>)
      : {};
  return {
    id: typeof record.id === 'string' ? record.id : '',
    type,
    ...(typeof record.occurred_at === 'string' ? { occurred_at: record.occurred_at } : {}),
    site_id: typeof record.site_id === 'string' ? record.site_id : '',
    payload,
  };
}

/** 需要刷新通知入口（铃铛未读）的事件类型。 */
const INBOX_TYPES = new Set([
  'comment.created',
  'reaction.created',
  'follow.created',
  'moderation.updated',
  'message.created',
  'contact.created',
]);

export function isInboxEvent(type: string): boolean {
  return type.startsWith('notification.') || INBOX_TYPES.has(type);
}

/** 从 API 错误里取 HTTP 状态码；拿不到返回 0。 */
export function errorStatus(error: unknown): number {
  if (!error || typeof error !== 'object') return 0;
  const direct = (error as { status?: unknown }).status;
  if (typeof direct === 'number') return direct;
  const problem = (error as { problem?: unknown }).problem;
  if (problem && typeof problem === 'object') {
    const status = (problem as { status?: unknown }).status;
    if (typeof status === 'number') return status;
  }
  return 0;
}

/** 旧后端没有实时端点时不要无限重试。 */
export function isMissingRealtimeEndpoint(error: unknown): boolean {
  const status = errorStatus(error);
  return status === 404 || status === 405 || status === 501;
}

/** 构造一条轮询合成事件。 */
export function pollEvent(siteId: string): AppEvent {
  return { id: '', type: REALTIME_POLL, site_id: siteId, payload: {} };
}

const WS_OPEN = 1;
const SEEN_LIMIT = 512;

/**
 * 一条实时连接的生命周期。
 *
 * 状态机：off → connecting → live；连接失败 / 断开后进入 polling（宿主同时用
 * 45 秒轮询兜底），退避到点再回 connecting。`stop()` 之后不再产生任何回调。
 */
export class RealtimeClient {
  private readonly deps: RealtimeDeps;
  private readonly timing: RealtimeTiming;
  private readonly listeners = new Set<(event: AppEvent) => void>();
  private socket: WebSocket | null = null;
  private started = false;
  private status: RealtimeStatus = 'off';
  private attempt = 0;
  private online = true;
  private generation = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private replaying = false;
  private replayBuffer: AppEvent[] = [];
  private cursor = '';
  private readonly seen = new Set<string>();
  private readonly seenOrder: string[] = [];

  constructor(deps: RealtimeDeps) {
    this.deps = deps;
    this.timing = { ...DEFAULT_REALTIME_TIMING, ...deps.timing };
    this.cursor = deps.cursor.get() || '';
  }

  getStatus(): RealtimeStatus {
    return this.status;
  }

  subscribe(listener: (event: AppEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.cursor = this.deps.cursor.get() || this.cursor;
    this.setStatus('connecting');
    void this.openSocket();
  }

  stop(): void {
    this.started = false;
    this.generation += 1;
    this.cancelRetry();
    this.teardownSocket();
    this.replaying = false;
    this.replayBuffer = [];
    this.setStatus('off');
  }

  /** 在线恢复：立刻重连，不必等退避计时。 */
  notifyOnline(): void {
    this.online = true;
    if (!this.started) return;
    if (this.socket && this.socket.readyState === WS_OPEN) return;
    this.attempt = 0;
    this.reconnectNow();
  }

  /** 离线：主动断开并停止重试，等 `notifyOnline`。 */
  notifyOffline(): void {
    this.online = false;
    // 让还在等票据 / 握手的旧尝试作废，别在离线期间又建出一条连接。
    this.generation += 1;
    this.cancelRetry();
    this.teardownSocket();
    if (this.started) this.setStatus('polling');
  }

  /**
   * 页面从后台回到前台：长时间隐藏后浏览器可能留下半开连接，主动换一条新连接；
   * 新连接会重放游标之后的事件，所以不会丢消息。
   */
  notifyResume(): void {
    if (!this.started || !this.online) return;
    this.attempt = 0;
    this.reconnectNow();
  }

  reconnectNow(): void {
    if (!this.started || !this.online) return;
    this.cancelRetry();
    this.teardownSocket();
    this.setStatus('connecting');
    void this.openSocket();
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  private setStatus(status: RealtimeStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.deps.onStatus?.(status);
  }

  private async openSocket(): Promise<void> {
    if (!this.online) return;
    const generation = ++this.generation;
    this.cancelRetry();
    this.teardownSocket();

    let ticket: RealtimeTicket;
    try {
      ticket = await this.deps.ticket();
    } catch (error) {
      if (generation !== this.generation || !this.started) return;
      if (this.deps.shouldGiveUp?.(error)) {
        this.giveUp();
        return;
      }
      this.retryLater();
      return;
    }
    if (generation !== this.generation || !this.started || !this.online) return;

    const url = absoluteWebSocketUrl(ticket?.url ?? '', this.deps.origin());
    if (!url) {
      this.retryLater();
      return;
    }

    // 票据可能在请求途中过期；不要用一个已知过期的票据去握手。
    const expiresAt = Date.parse(ticket?.expires_at ?? '');
    const now = this.now();
    if (Number.isFinite(expiresAt) && expiresAt <= now) {
      this.retryLater();
      return;
    }

    const Impl =
      this.deps.WebSocketImpl ??
      (typeof WebSocket !== 'undefined' ? WebSocket : undefined);
    if (!Impl) {
      this.giveUp();
      return;
    }

    let socket: WebSocket;
    try {
      socket = new Impl(url);
    } catch {
      this.retryLater();
      return;
    }
    this.socket = socket;

    const expiresIn = Number.isFinite(expiresAt) ? expiresAt - now : this.timing.connectTimeoutMs;
    const connectTimeout = Math.max(
      250,
      Math.min(this.timing.connectTimeoutMs, Number.isFinite(expiresIn) ? expiresIn : this.timing.connectTimeoutMs),
    );
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (generation !== this.generation || this.socket !== socket) return;
      if (socket.readyState !== WS_OPEN) this.dropSocket(socket);
    }, connectTimeout);

    socket.onopen = () => {
      if (generation !== this.generation || this.socket !== socket) return;
      this.clearConnectTimer();
      this.attempt = 0;
      this.setStatus('live');
      this.startHeartbeat();
      void this.replayMissed(socket);
    };
    socket.onmessage = (event) => {
      if (generation !== this.generation || this.socket !== socket) return;
      this.receive(event.data);
    };
    socket.onerror = () => {
      if (generation !== this.generation || this.socket !== socket) return;
      this.dropSocket(socket);
    };
    socket.onclose = () => {
      if (generation !== this.generation || this.socket !== socket) return;
      this.dropSocket(socket);
    };
  }

  /** 当前连接失败：断开、进入轮询状态并安排退避重连。 */
  private dropSocket(socket: WebSocket): void {
    if (this.socket !== socket) return;
    this.teardownSocket();
    if (!this.started) {
      this.setStatus('off');
      return;
    }
    this.setStatus('polling');
    this.retryLater();
  }

  /** 明知不可重试（端点不存在）：停止连接，交给宿主轮询。 */
  private giveUp(): void {
    this.started = false;
    this.generation += 1;
    this.cancelRetry();
    this.teardownSocket();
    this.setStatus('polling');
  }

  private retryLater(): void {
    if (!this.started || !this.online) return;
    this.cancelRetry();
    // 连接不可用期间宿主靠 45 秒轮询兜底，状态要如实反映，别停在 connecting。
    this.setStatus('polling');
    const delay = nextRetryDelay(
      this.attempt,
      this.timing,
      this.deps.random ?? Math.random,
    );
    this.attempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.started || !this.online) return;
      void this.openSocket();
    }, delay);
  }

  private cancelRetry(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private clearConnectTimer(): void {
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.started || !this.socket) return;
      if (this.socket.readyState !== WS_OPEN) {
        this.dropSocket(this.socket);
        return;
      }
      try {
        // 应用层保活帧：服务端只读不响应，别把它当成心跳应答。
        this.socket.send('{"type":"ping"}');
      } catch {
        this.dropSocket(this.socket);
      }
    }, this.timing.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private teardownSocket(): void {
    this.clearConnectTimer();
    this.stopHeartbeat();
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    try {
      socket.close(1000, 'client');
    } catch {
      /* 已经关闭的 socket 再关一次没有影响 */
    }
  }

  private receive(data: unknown): void {
    const event = parseRealtimeEvent(data);
    if (!event) return;
    // 补偿期间到达的实时帧先入队：等补偿结束再按到达顺序去重派发，避免顺序倒挂。
    if (this.replaying) {
      this.replayBuffer.push(event);
      return;
    }
    this.deliver(event);
  }

  /**
   * 断线补偿。
   *
   * 没有游标时跳过：`GET /events` 不带 `after_id` 返回的是**最早**一页，不是最新
   * 一页，拿它补齐会把很久以前的事件重新刷一遍。首次连接没有缺口需要补，页面
   * 自己的加载请求已经是最新状态。
   */
  private async replayMissed(socket: WebSocket): Promise<void> {
    if (!this.cursor) return;
    this.replaying = true;
    this.replayBuffer = [];
    let aborted = false;
    try {
      let cursor = this.cursor;
      for (let page = 0; page < this.timing.replayPages; page += 1) {
        const result = await this.deps.replay(cursor, this.timing.replayLimit);
        if (!this.started || this.socket !== socket) {
          aborted = true;
          break;
        }
        const items = Array.isArray(result?.items) ? result.items : [];
        for (const event of items) {
          if (!this.started || this.socket !== socket) {
            aborted = true;
            break;
          }
          this.deliver(event);
        }
        if (aborted) break;
        const next = result?.next_cursor || items[items.length - 1]?.id || '';
        if (!result?.has_more || !next || next === cursor) break;
        cursor = next;
      }
    } catch {
      /* 补偿失败不阻塞长连接；下一次重连会从同一个游标再试 */
    } finally {
      this.replaying = false;
      const buffered = this.replayBuffer;
      this.replayBuffer = [];
      if (!aborted && this.socket === socket) {
        for (const event of buffered) this.deliver(event);
      }
    }
  }

  private deliver(event: AppEvent): void {
    // REST 补偿的 payload 可能是 null（服务端没有附件时）；统一成对象，页面订阅者
    // 就不必对每条事件再做一次空值判断。
    const payload =
      event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload)
        ? event.payload
        : {};
    const normalized: AppEvent = { ...event, payload };
    if (normalized.id) {
      if (this.seen.has(normalized.id)) return;
      this.seen.add(normalized.id);
      this.seenOrder.push(normalized.id);
      if (this.seenOrder.length > SEEN_LIMIT) {
        const oldest = this.seenOrder.shift();
        if (oldest) this.seen.delete(oldest);
      }
      if (!this.cursor || normalized.id > this.cursor) {
        this.cursor = normalized.id;
        try {
          this.deps.cursor.set(normalized.id);
        } catch {
          /* 存不下游标只影响下次刷新后的补偿范围，不影响本次推送 */
        }
      }
    }
    this.deps.onEvent?.(normalized);
    for (const listener of [...this.listeners]) {
      try {
        listener(normalized);
      } catch {
        /* 单个订阅者出错不能中断整条连接 */
      }
    }
  }
}
