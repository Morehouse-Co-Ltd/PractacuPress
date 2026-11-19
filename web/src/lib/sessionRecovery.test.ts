import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, HttpBackend } from './api';
import { REFRESH_LOCK_KEY } from './sessionSync';

/**
 * 「登录之后点新页面又要刷新一下才能进入」的回归测试。
 *
 * 根因有三层，都在 HttpBackend 的会话恢复路径上：
 * 1. 双提交的 CSRF 令牌优先用内存副本——另一个标签页刷新过之后它就是旧值，刷新被
 *    服务端以 `csrf_mismatch` 拒绝，界面被误判成未登录；
 * 2. 刷新失败（CSRF 竞态 / 断网 / 5xx）一律当成会话过期，把刚登录的会话清掉；
 * 3. 一个在登录之前发出、登录之后才回来的 401 会把新会话打掉。
 *
 * 用真实的 HttpBackend + 假 fetch 复现，避免依赖服务端。
 */

const SESSION = {
  user: {
    id: 'usr_1',
    display_name: '站长',
    locale: 'zh-CN',
    status: 'active' as const,
    created_at: '2026-11-01T00:00:00Z',
  },
  token_type: 'Bearer' as const,
  access_token: 'access-1',
  access_expires_at: '2026-11-02T01:00:00Z',
  refresh_expires_at: '2026-12-02T00:00:00Z',
  csrf_token: 'csrf-1',
};

const ME = { user: SESSION.user, role: 'site_admin', site_id: 'site_1' };

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function problemResponse(
  status: number,
  problem: { code: string; reason?: string; message?: string },
): Response {
  return {
    ok: false,
    status,
    json: async () => ({
      type: `https://docs.practacu.press/errors/${problem.code}`,
      title: problem.message ?? problem.code,
      status,
      code: problem.code,
      message: problem.message ?? problem.code,
      details: problem.reason ? { reason: problem.reason } : {},
      request_id: '',
    }),
  } as unknown as Response;
}

function unauthenticated(): Response {
  return problemResponse(401, { code: 'unauthenticated', message: '登录状态已失效。' });
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
  return init ? new Headers(init.headers).get(name) : null;
}

function urlOf(input: RequestInfo | URL): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
}

beforeEach(() => {
  document.cookie = 'pp_csrf=; max-age=0; path=/';
  localStorage.clear();
  sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.cookie = 'pp_csrf=; max-age=0; path=/';
  localStorage.clear();
});

describe('会话恢复不再把已登录的标签页踢回登录页', () => {
  it('uses the shared pp_csrf cookie, so another tab rotating it does not log this one out', async () => {
    // 另一个标签页刚刷新过：Cookie 里已经是新令牌，内存里还是登录时那一枚。
    document.cookie = 'pp_csrf=csrf-new; path=/';
    const refreshTokens: (string | null)[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.endsWith('/auth/token/refresh')) {
        refreshTokens.push(headerOf(init, 'X-CSRF-Token'));
        return jsonResponse({ ...SESSION, access_token: 'access-2', csrf_token: 'csrf-new' });
      }
      const authorization = headerOf(init, 'Authorization');
      return authorization === 'Bearer access-2' ? jsonResponse(ME) : unauthenticated();
    });
    vi.stubGlobal('fetch', fetchMock);
    const onExpired = vi.fn();
    const backend = new HttpBackend({ base: 'http://api.test', onExpired });
    // applySession 记下的是登录那一刻的令牌（旧值）。
    backend.applySession({ ...SESSION, csrf_token: 'csrf-stale' });

    // 访问令牌过期 → 401 → 刷新。刷新必须用 Cookie 里的新令牌，否则 403。
    await expect(backend.me()).resolves.toMatchObject({ role: 'site_admin' });

    expect(refreshTokens).toEqual(['csrf-new']);
    expect(onExpired).not.toHaveBeenCalled();
  });

  it('retries the refresh once when the CSRF cookie rotates mid-flight', async () => {
    document.cookie = 'pp_csrf=csrf-old; path=/';
    const seen: (string | null)[] = [];
    let attempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(urlOf(input)).toContain('/auth/token/refresh');
      seen.push(headerOf(init, 'X-CSRF-Token'));
      attempts += 1;
      if (attempts === 1) {
        // 读到 Cookie 之后、请求到达服务端之前，另一个标签页又换了一枚。
        document.cookie = 'pp_csrf=csrf-new; path=/';
        return problemResponse(403, { code: 'permission_denied', reason: 'csrf_mismatch' });
      }
      return jsonResponse({ ...SESSION, access_token: 'access-2', csrf_token: 'csrf-new' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const backend = new HttpBackend({ base: 'http://api.test', onExpired: () => undefined });

    await backend.refresh();

    expect(seen).toEqual(['csrf-old', 'csrf-new']);
  });

  it('keeps the session when the refresh merely fails to reach the server', async () => {
    const onExpired = vi.fn();
    const authorizationHeaders: (string | null)[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.endsWith('/auth/token/refresh')) throw new TypeError('network down');
      authorizationHeaders.push(headerOf(init, 'Authorization'));
      return unauthenticated();
    });
    vi.stubGlobal('fetch', fetchMock);
    const backend = new HttpBackend({ base: 'http://api.test', onExpired });
    backend.applySession(SESSION);

    await expect(backend.me()).rejects.toBeInstanceOf(ApiError);
    await expect(backend.me()).rejects.toBeInstanceOf(ApiError);

    // 断网不等于退出登录：会话令牌必须留着（服务端仍然会校验它）。
    expect(onExpired).not.toHaveBeenCalled();
    expect(authorizationHeaders).toEqual(['Bearer access-1', 'Bearer access-1']);
  });

  it('still expires the session when the server says the refresh token is gone', async () => {
    const onExpired = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (urlOf(input).endsWith('/auth/token/refresh')) return unauthenticated();
      return unauthenticated();
    });
    vi.stubGlobal('fetch', fetchMock);
    const backend = new HttpBackend({ base: 'http://api.test', onExpired });
    backend.applySession(SESSION);

    await expect(backend.me()).rejects.toBeInstanceOf(ApiError);

    expect(onExpired).toHaveBeenCalledTimes(1);
  });

  it('does not refresh for a 401 that belongs to a request sent before the login', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let refreshCalls = 0;
    const meCalls: (string | null)[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = urlOf(input);
      if (url.endsWith('/auth/token/refresh')) {
        refreshCalls += 1;
        return jsonResponse({ ...SESSION, access_token: 'access-2' });
      }
      const authorization = headerOf(init, 'Authorization');
      meCalls.push(authorization);
      if (!authorization) {
        // 匿名期间发出的一枪：故意拖到登录成功之后才回 401。
        await gate;
        return unauthenticated();
      }
      return jsonResponse(ME);
    });
    vi.stubGlobal('fetch', fetchMock);
    const onExpired = vi.fn();
    const backend = new HttpBackend({ base: 'http://api.test', onExpired });

    const pending = backend.me();
    backend.applySession(SESSION);
    release();

    await expect(pending).resolves.toMatchObject({ site_id: 'site_1' });
    // 用新令牌重放就够了，不该再消耗一次一次性刷新令牌。
    expect(refreshCalls).toBe(0);
    expect(meCalls).toEqual([null, 'Bearer access-1']);
    expect(onExpired).not.toHaveBeenCalled();
  });
});

describe('跨标签页刷新互斥', () => {
  it('serializes refreshes so two tabs never burn the same one-shot refresh token', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      expect(urlOf(input)).toContain('/auth/token/refresh');
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 40));
      inFlight -= 1;
      return jsonResponse({ ...SESSION, access_token: `access-${Math.random()}` });
    });
    vi.stubGlobal('fetch', fetchMock);
    const first = new HttpBackend({ base: 'http://api.test', onExpired: () => undefined });
    const second = new HttpBackend({ base: 'http://api.test', onExpired: () => undefined });

    await Promise.all([first.refresh(), second.refresh()]);

    expect(peak).toBe(1);
    // 锁用完就释放，不会把下一次刷新堵住。
    expect(localStorage.getItem(REFRESH_LOCK_KEY)).toBeNull();
  });

  it('ignores a refresh lock left behind by a killed tab', async () => {
    localStorage.setItem(
      REFRESH_LOCK_KEY,
      JSON.stringify({ id: 'dead-tab', until: Date.now() - 1_000 }),
    );
    const fetchMock = vi.fn(async () => jsonResponse(SESSION));
    vi.stubGlobal('fetch', fetchMock);
    const backend = new HttpBackend({ base: 'http://api.test', onExpired: () => undefined });

    await expect(backend.refresh()).resolves.toMatchObject({ access_token: 'access-1' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
