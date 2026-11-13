import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppEvent, Page } from '../types';
import {
  DEFAULT_REALTIME_TIMING,
  RealtimeClient,
  absoluteWebSocketUrl,
  isInboxEvent,
  isMissingRealtimeEndpoint,
  nextRetryDelay,
  parseRealtimeEvent,
  type RealtimeStatus,
  type RealtimeTicket,
} from './realtimeCore';

function event(id: string, type = 'message.created', payload: Record<string, unknown> = {}): AppEvent {
  return { id, type, occurred_at: '2026-11-07T00:00:00Z', site_id: 'site_1', payload };
}

function page(items: AppEvent[], next = ''): Page<AppEvent> {
  return { items, next_cursor: next, has_more: !!next };
}

/** 可手动驱动的 WebSocket 替身：测试决定何时 open / message / close。 */
class FakeSocket {
  static instances: FakeSocket[] = [];

  readyState = 0;
  sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }

  message(data: string): void {
    this.onmessage?.({ data } as MessageEvent);
  }

  close(): void {
    this.readyState = 3;
    this.onclose?.(new Event('close') as CloseEvent);
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('socket is not open');
    this.sent.push(data);
  }
}

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

interface Harness {
  client: RealtimeClient;
  ticket: ReturnType<typeof vi.fn>;
  replay: ReturnType<typeof vi.fn>;
  statuses: RealtimeStatus[];
  events: AppEvent[];
  cursors: string[];
}

function makeClient(options: {
  cursor?: string;
  ticket?: (count: number) => Promise<RealtimeTicket>;
  replay?: (afterId: string) => Promise<Page<AppEvent>>;
  timing?: Partial<typeof DEFAULT_REALTIME_TIMING>;
}): Harness {
  const statuses: RealtimeStatus[] = [];
  const events: AppEvent[] = [];
  const cursors: string[] = [];
  let stored = options.cursor ?? '';
  let ticketCalls = 0;
  const ticket = vi.fn(async () => {
    ticketCalls += 1;
    return (
      options.ticket?.(ticketCalls) ??
      Promise.resolve({
        ticket: 'ticket',
        expires_at: new Date(Date.now() + 60_000).toISOString(),
        url: '/api/v1/ws?ticket=ticket',
      })
    );
  });
  const replay = vi.fn(async (afterId: string) =>
    options.replay?.(afterId) ?? page([], ''),
  );
  const client = new RealtimeClient({
    ticket,
    replay,
    origin: () => 'http://api.test',
    cursor: {
      get: () => stored,
      set: (id) => {
        stored = id;
        cursors.push(id);
      },
    },
    WebSocketImpl: FakeSocket as unknown as typeof WebSocket,
    shouldGiveUp: isMissingRealtimeEndpoint,
    timing: options.timing,
    now: () => Date.now(),
    random: () => 0.5,
    onStatus: (status) => statuses.push(status),
    onEvent: (item) => events.push(item),
  });
  return { client, ticket, replay, statuses, events, cursors };
}

beforeEach(() => {
  FakeSocket.instances = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('absoluteWebSocketUrl', () => {
  it('把同源相对地址补成 ws 地址', () => {
    expect(absoluteWebSocketUrl('/api/v1/ws?ticket=t', 'http://127.0.0.1:8080')).toBe(
      'ws://127.0.0.1:8080/api/v1/ws?ticket=t',
    );
    expect(absoluteWebSocketUrl('/api/v1/ws?ticket=t', 'https://press.example')).toBe(
      'wss://press.example/api/v1/ws?ticket=t',
    );
  });

  it('按 http/https 跳协议，已是的 ws 地址原样返回', () => {
    expect(absoluteWebSocketUrl('http://api.test/ws', '')).toBe('ws://api.test/ws');
    expect(absoluteWebSocketUrl('https://api.test/ws', '')).toBe('wss://api.test/ws');
    expect(absoluteWebSocketUrl('wss://api.test/ws?ticket=x', '')).toBe(
      'wss://api.test/ws?ticket=x',
    );
  });

  it('origin 为空时退回当前页面源站，空地址返回空串', () => {
    expect(absoluteWebSocketUrl('/api/v1/ws?ticket=t', '')).toMatch(/^ws:\/\//);
    expect(absoluteWebSocketUrl('', 'http://api.test')).toBe('');
  });
});

describe('nextRetryDelay', () => {
  const timing = { baseDelayMs: 1_000, maxDelayMs: 30_000 };

  it('指数增长并封顶', () => {
    const middle = () => 0.5;
    expect(nextRetryDelay(0, timing, middle)).toBe(1_000);
    expect(nextRetryDelay(1, timing, middle)).toBe(2_000);
    expect(nextRetryDelay(2, timing, middle)).toBe(4_000);
    expect(nextRetryDelay(8, timing, middle)).toBe(30_000);
  });

  it('带 ±20% 抖动', () => {
    expect(nextRetryDelay(0, timing, () => 0)).toBe(800);
    expect(nextRetryDelay(0, timing, () => 1)).toBe(1_200);
  });
});

describe('parseRealtimeEvent / isInboxEvent', () => {
  it('解析合法事件并忽略心跳与坏帧', () => {
    expect(parseRealtimeEvent('{"type":"ping"}')).toBeNull();
    expect(parseRealtimeEvent('not json')).toBeNull();
    expect(parseRealtimeEvent('{"id":"e1"}')).toBeNull();
    const parsed = parseRealtimeEvent(
      '{"id":"e1","type":"message.created","site_id":"s1","payload":{"conversation_id":"c1"}}',
    );
    expect(parsed).toMatchObject({
      id: 'e1',
      type: 'message.created',
      site_id: 's1',
      payload: { conversation_id: 'c1' },
    });
  });

  it('只把通知类事件算作铃铛未读的刷新信号', () => {
    expect(isInboxEvent('notification.created')).toBe(true);
    expect(isInboxEvent('message.created')).toBe(true);
    expect(isInboxEvent('presence.changed')).toBe(false);
    expect(isInboxEvent('realtime.poll')).toBe(false);
  });
});

describe('RealtimeClient', () => {
  it('取票据、建立连接、派发事件并按 id 去重', async () => {
    const harness = makeClient({});
    harness.client.start();
    await flush();

    expect(harness.ticket).toHaveBeenCalledTimes(1);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.instances[0].url).toBe('ws://api.test/api/v1/ws?ticket=ticket');

    const socket = FakeSocket.instances[0];
    socket.open();
    expect(harness.statuses.at(-1)).toBe('live');

    socket.message(JSON.stringify(event('e1')));
    socket.message(JSON.stringify(event('e1')));
    socket.message(JSON.stringify(event('e2')));
    socket.message('{"type":"ping"}');
    socket.message('broken');

    expect(harness.events.map((item) => item.id)).toEqual(['e1', 'e2']);
    expect(harness.cursors).toEqual(['e1', 'e2']);

    harness.client.stop();
    expect(harness.statuses.at(-1)).toBe('off');
    expect(socket.readyState).toBe(3);
  });

  it('连接建立后从游标处补偿，再派发实时事件', async () => {
    const harness = makeClient({
      cursor: 'e1',
      replay: async (afterId) => {
        expect(afterId).toBe('e1');
        return page([event('e2'), event('e3')], 'e3');
      },
    });
    harness.client.start();
    await flush();
    FakeSocket.instances[0].open();
    await flush();

    expect(harness.replay).toHaveBeenCalledWith('e1', 100);
    expect(harness.events.map((item) => item.id)).toEqual(['e2', 'e3']);

    FakeSocket.instances[0].message(JSON.stringify(event('e3')));
    FakeSocket.instances[0].message(JSON.stringify(event('e4')));
    await flush();
    expect(harness.events.map((item) => item.id)).toEqual(['e2', 'e3', 'e4']);
    harness.client.stop();
  });

  it('补偿期间到达的实时事件等补偿结束后再去重派发', async () => {
    let releaseReplay = (_value: Page<AppEvent>) => {};
    const pendingReplay = new Promise<Page<AppEvent>>((resolve) => {
      releaseReplay = (value) => resolve(value);
    });
    const harness = makeClient({
      cursor: 'e1',
      replay: async () => pendingReplay,
    });
    harness.client.start();
    await flush();
    FakeSocket.instances[0].open();
    await flush();

    const socket = FakeSocket.instances[0];
    socket.message(JSON.stringify(event('e2')));
    socket.message(JSON.stringify(event('e3')));
    expect(harness.events).toHaveLength(0);

    releaseReplay(page([event('e2')], ''));
    await flush();
    expect(harness.events.map((item) => item.id)).toEqual(['e2', 'e3']);
    harness.client.stop();
  });

  it('断线后退避重连，并用最新游标补偿', async () => {
    const harness = makeClient({
      cursor: 'e1',
      timing: { baseDelayMs: 1_000, maxDelayMs: 8_000 },
      replay: async (afterId) =>
        afterId === 'e1' ? page([event('e2')], 'e2') : page([], ''),
    });
    harness.client.start();
    await flush();
    FakeSocket.instances[0].open();
    await flush();
    expect(harness.events.map((item) => item.id)).toEqual(['e2']);

    FakeSocket.instances[0].close();
    expect(harness.statuses.at(-1)).toBe('polling');

    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.ticket).toHaveBeenCalledTimes(2);
    expect(FakeSocket.instances).toHaveLength(2);

    FakeSocket.instances[1].open();
    await flush();
    expect(harness.replay).toHaveBeenLastCalledWith('e2', 100);
    harness.client.stop();
  });

  it('票据已过期时重新取票而不是拿过期票据握手', async () => {
    const harness = makeClient({
      ticket: async (count) =>
        count === 1
          ? {
              ticket: 'old',
              expires_at: new Date(Date.now() - 1_000).toISOString(),
              url: '/api/v1/ws?ticket=old',
            }
          : {
              ticket: 'new',
              expires_at: new Date(Date.now() + 60_000).toISOString(),
              url: '/api/v1/ws?ticket=new',
            },
    });
    harness.client.start();
    await flush();
    expect(FakeSocket.instances).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.ticket).toHaveBeenCalledTimes(2);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.instances[0].url).toContain('ticket=new');
    harness.client.stop();
  });

  it('心跳只负责保活并发现已关闭的 socket', async () => {
    const harness = makeClient({ timing: { heartbeatMs: 25_000 } });
    harness.client.start();
    await flush();
    const socket = FakeSocket.instances[0];
    socket.open();

    await vi.advanceTimersByTimeAsync(25_000);
    expect(socket.sent).toEqual(['{"type":"ping"}']);

    const next = makeClient({ timing: { heartbeatMs: 25_000 } });
    next.client.start();
    await flush();
    const dead = FakeSocket.instances[1];
    dead.open();
    dead.readyState = 3;
    await vi.advanceTimersByTimeAsync(25_000);
    expect(next.statuses.at(-1)).toBe('polling');
    next.client.stop();
    harness.client.stop();
  });

  it('票据端点不存在时停止重试并交给轮询', async () => {
    const harness = makeClient({
      ticket: async () => {
        throw { problem: { status: 404 } };
      },
    });
    harness.client.start();
    await flush();
    expect(harness.statuses.at(-1)).toBe('polling');
    expect(isMissingRealtimeEndpoint({ problem: { status: 404 } })).toBe(true);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.ticket).toHaveBeenCalledTimes(1);
  });

  it('普通票据失败按退避重试', async () => {
    let calls = 0;
    const harness = makeClient({
      ticket: async () => {
        calls += 1;
        if (calls === 1) throw new Error('network');
        return {
          ticket: 'ok',
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          url: '/api/v1/ws?ticket=ok',
        };
      },
    });
    harness.client.start();
    await flush();
    expect(harness.statuses.at(-1)).toBe('polling');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.ticket).toHaveBeenCalledTimes(2);
    expect(FakeSocket.instances).toHaveLength(1);
    harness.client.stop();
  });

  it('离线时取消进行中的握手，且不再重试', async () => {
    let release: (ticket: RealtimeTicket) => void = () => {};
    const pending = new Promise<RealtimeTicket>((resolve) => {
      release = resolve;
    });
    const harness = makeClient({
      ticket: async (count) =>
        count === 1
          ? pending
          : {
              ticket: 'second',
              expires_at: new Date(Date.now() + 60_000).toISOString(),
              url: '/api/v1/ws?ticket=second',
            },
    });
    harness.client.start();
    await flush();

    harness.client.notifyOffline();
    expect(harness.statuses.at(-1)).toBe('polling');

    release({
      ticket: 'late',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      url: '/api/v1/ws?ticket=late',
    });
    await flush();
    expect(FakeSocket.instances).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.ticket).toHaveBeenCalledTimes(1);

    harness.client.notifyOnline();
    await flush();
    expect(FakeSocket.instances).toHaveLength(1);
    expect(FakeSocket.instances[0].url).toContain('ticket=second');
    harness.client.stop();
  });

  it('stop 之后不再重连', async () => {
    const harness = makeClient({});
    harness.client.start();
    await flush();
    FakeSocket.instances[0].open();
    harness.client.stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(harness.ticket).toHaveBeenCalledTimes(1);
    expect(FakeSocket.instances).toHaveLength(1);
  });
});
