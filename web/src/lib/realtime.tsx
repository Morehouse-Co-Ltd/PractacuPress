import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { AppEvent } from '../types';
import { isDemo, useBackend } from './backend';
import { useAuth } from './session';
import {
  REALTIME_FALLBACK_POLL_MS,
  RealtimeClient,
  isInboxEvent,
  isMissingRealtimeEndpoint,
  pollEvent,
  readRealtimeStatus,
  writeRealtimeStatus,
  type RealtimeStatus,
} from './realtimeCore';
import { useT } from './i18n';

export { REALTIME_POLL, isInboxEvent } from './realtimeCore';

/** 断线游标按标签页保存：另一个标签页推进游标不该让本标签页跳过事件。 */
const CURSOR_PREFIX = 'pp.realtime.cursor.v1';

function readStoredCursor(key: string): string {
  try {
    return typeof sessionStorage === 'undefined' ? '' : (sessionStorage.getItem(key) ?? '');
  } catch {
    return '';
  }
}

function storeCursor(key: string, id: string): void {
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(key, id);
  } catch {
    /* 无痕模式或存储被禁用：游标只留在内存里，下一次刷新会重新从空游标开始 */
  }
}

export interface RealtimeValue {
  /** `off` 表示演示模式或后端不支持；`polling` 表示实时通道不可用，正在轮询。 */
  status: RealtimeStatus;
  live: boolean;
  /** 订阅一条推送事件；返回取消订阅函数。 */
  subscribe(listener: (event: AppEvent) => void): () => void;
}

const RealtimeContext = createContext<RealtimeValue | null>(null);

/**
 * 全站唯一的实时连接。
 *
 * - 只有 `live` 后端 + 已登录会话才连接；演示模式保持原样（`off`）。
 * - 票据、补偿地址都通过 `HttpBackend` 已有的 `wsTicket()` / `events()` 调用，
 *   不新增网络方法。
 * - 连接不可用时每 45 秒向订阅者发一条 `realtime.poll`，页面据此回退轮询；
 *   连接可用时不发，避免实时与轮询双写。
 * - 铃铛未读由这里在收到通知类事件后触发 `refreshUnread()`（400ms 防抖），
 *   所以通知入口不需要自己轮询。
 */
export function RealtimeProvider({ children }: { children: ReactNode }) {
  const backend = useBackend();
  const auth = useAuth();
  const { status: authStatus, me } = auth;
  const [status, setStatus] = useState<RealtimeStatus>('off');
  const listenersRef = useRef(new Set<(event: AppEvent) => void>());
  const refreshUnreadRef = useRef(auth.refreshUnread);
  refreshUnreadRef.current = auth.refreshUnread;

  const siteId = me?.site_id ?? '';
  const userId = me?.user.id ?? '';
  const supported =
    !isDemo(backend) &&
    typeof backend.wsTicket === 'function' &&
    typeof backend.events === 'function';
  const active = authStatus === 'ready' && !!me && supported;
  const identityKey = active ? `${backend.mode}|${siteId}|${userId}` : '';

  const subscribe = useCallback((listener: (event: AppEvent) => void) => {
    listenersRef.current.add(listener);
    return () => {
      listenersRef.current.delete(listener);
    };
  }, []);

  useEffect(() => {
    if (!active) {
      writeRealtimeStatus('off');
      setStatus('off');
      return;
    }

    const cursorKey = `${CURSOR_PREFIX}.${siteId}.${userId}`;
    let disposed = false;
    let unreadTimer: ReturnType<typeof setTimeout> | null = null;
    const emit = (event: AppEvent) => {
      for (const listener of [...listenersRef.current]) {
        try {
          listener(event);
        } catch {
          /* 页面订阅者的异常不能中断其他订阅者 */
        }
      }
    };

    const ticket = backend.wsTicket;
    const replay = backend.events;
    if (typeof WebSocket === 'undefined' || !ticket || !replay) {
      // 浏览器没有 WebSocket，或后端是旧版本：不连接，只保留轮询。
      writeRealtimeStatus('polling');
      setStatus('polling');
    } else {
      writeRealtimeStatus('connecting');
      setStatus('connecting');
    }

    const client =
      typeof WebSocket === 'undefined' || !ticket || !replay
        ? null
        : new RealtimeClient({
            ticket: async () => {
              /**
               * 票据端点在 `/auth/` 下，HttpBackend 不会为它自动刷新 access token。
               * 长连接存活时间可能超过 15 分钟的令牌寿命：断线后直接拿过期令牌换
               * 票据会 401，并把用户登出。先打一次普通鉴权请求，让请求层按常规路径
               * 用 refresh cookie 换新令牌，再换票据。
               */
              try {
                await backend.me();
              } catch {
                /* 真正的失败交给票据请求：它会给出准确的错误并触发登出 */
              }
              return ticket.call(backend);
            },
            replay: (afterId, limit) => replay.call(backend, afterId, limit),
            origin: () => backend.origin,
            cursor: {
              get: () => readStoredCursor(cursorKey),
              set: (id) => storeCursor(cursorKey, id),
            },
            shouldGiveUp: isMissingRealtimeEndpoint,
            onStatus: (next) => {
              writeRealtimeStatus(next);
              if (!disposed) setStatus(next);
              /**
               * 通知推送不进 `/events` 补偿（它不是 outbox 行），所以断线期间的新通知
               * 只能靠权威的收件箱接口补回来。每次（重新）连上都刷新一次未读，
               * 让铃铛在重连后立刻对齐，而不是等用户打开通知页才发现。
               */
              if (next === 'live') void refreshUnreadRef.current();
            },
            onEvent: (event) => {
              if (isInboxEvent(event.type)) {
                if (unreadTimer !== null) clearTimeout(unreadTimer);
                unreadTimer = setTimeout(() => {
                  unreadTimer = null;
                  void refreshUnreadRef.current();
                }, 400);
              }
              emit(event);
            },
          });
    client?.start();

    // 实时连接可用时由推送驱动；不可用（连接中 / 轮询 / 旧后端）时每 45 秒
    // 发一条合成事件，让消息页、通知页沿用同一套刷新逻辑。
    const pollTimer = setInterval(() => {
      if (readRealtimeStatus() === 'live') return;
      emit(pollEvent(siteId));
    }, REALTIME_FALLBACK_POLL_MS);

    const onOnline = () => client?.notifyOnline();
    const onOffline = () => client?.notifyOffline();
    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        return;
      }
      // 后台待久了浏览器可能留下半开连接：回前台主动换一条新连接，补偿随后补齐。
      if (hiddenAt && Date.now() - hiddenAt > 60_000) client?.notifyResume();
      hiddenAt = 0;
    };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      disposed = true;
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisibility);
      clearInterval(pollTimer);
      if (unreadTimer !== null) clearTimeout(unreadTimer);
      client?.stop();
      writeRealtimeStatus('off');
    };
    // backend 与登录身份决定连接；refreshUnread 通过 ref 取最新实现，不重建连接。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, identityKey, backend, siteId, userId]);

  const value = useMemo<RealtimeValue>(
    () => ({ status, live: status === 'live', subscribe }),
    [status, subscribe],
  );

  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime(): RealtimeValue {
  const t = useT();
  const value = useContext(RealtimeContext);
  if (!value) throw new Error(t('useRealtime 必须在 RealtimeProvider 内使用'));
  return value;
}
