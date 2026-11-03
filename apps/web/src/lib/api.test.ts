import { afterEach, describe, expect, it, vi } from 'vitest';
import { HttpBackend } from './api';
import { configurePerformance, DEFAULT_PERFORMANCE } from './performance';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
  configurePerformance(DEFAULT_PERFORMANCE);
});

describe('HttpBackend request cache', () => {
  it('collapses identical GETs when the setting is enabled', async () => {
    configurePerformance({
      ...DEFAULT_PERFORMANCE,
      request_cache: true,
      cache_ttl: 15,
    });
    const fetchMock = vi.fn(async () =>
      jsonResponse({ items: [], next_cursor: '', has_more: false }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const backend = new HttpBackend({ base: 'http://api.test', onExpired: () => undefined });

    await backend.listContent('article', { limit: 3 });
    await backend.listContent('article', { limit: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('invalidates the cache after a write', async () => {
    configurePerformance({
      ...DEFAULT_PERFORMANCE,
      request_cache: true,
      cache_ttl: 15,
    });
    const fetchMock = vi.fn(async () =>
      jsonResponse({ items: [], next_cursor: '', has_more: false }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const backend = new HttpBackend({ base: 'http://api.test', onExpired: () => undefined });

    await backend.listContent('article', { limit: 3 });
    await backend.listContent('article', { limit: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await backend.createDraft('article', { title: 'x', source_body: 'body' });
    await backend.listContent('article', { limit: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not cache when the setting is off', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ items: [], next_cursor: '', has_more: false }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const backend = new HttpBackend({ base: 'http://api.test', onExpired: () => undefined });

    await backend.listContent('article', { limit: 3 });
    await backend.listContent('article', { limit: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// V-12 / O-3 契约：域名验证端点与站点设置里的注册开关。
describe('HttpBackend domain verification and registration settings', () => {
  it('uses the documented endpoints and payloads', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, init: init ?? {} });
      if (url.endsWith('/domain/verify')) {
        return jsonResponse({ verified: true, domain: 'press.example.com' });
      }
      if (url.endsWith('/domain')) {
        return jsonResponse({
          domain: 'press.example.com',
          verified: false,
          verification_token: 'pp_verify_token',
          record_name: '_practacu-verify.press.example.com',
          record_type: 'TXT',
        });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
    const backend = new HttpBackend({ base: 'http://api.test', onExpired: () => undefined });

    await backend.updateSite('site_1', { registration_open: false });
    expect(calls[0].url).toBe('http://api.test/api/v1/sites/site_1/settings');
    expect((calls[0].init.method ?? 'GET').toUpperCase()).toBe('PATCH');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ registration_open: false });

    const check = await backend.siteDomain('site_1');
    expect(check.record_type).toBe('TXT');
    expect(check.verified).toBe(false);
    expect(calls[1].url).toBe('http://api.test/api/v1/sites/site_1/domain');
    expect((calls[1].init.method ?? 'GET').toUpperCase()).toBe('GET');

    const result = await backend.verifySiteDomain('site_1');
    expect(result).toEqual({ verified: true, domain: 'press.example.com' });
    expect(calls[2].url).toBe('http://api.test/api/v1/sites/site_1/domain/verify');
    expect((calls[2].init.method ?? 'GET').toUpperCase()).toBe('POST');
  });
});

// V-27：登出也必须带 CSRF 双提交令牌，否则服务端 403、HttpOnly refresh cookie
// 不会被清掉，下一次挂载 refresh() 会把用户静默登回来。
describe('HttpBackend logout CSRF', () => {
  const session = {
    user: {
      id: 'usr_1',
      display_name: '站长',
      locale: 'zh-CN',
      status: 'active' as const,
      created_at: '2026-11-01T00:00:00Z',
    },
    token_type: 'Bearer' as const,
    access_token: 'access-token',
    access_expires_at: '2026-11-02T01:00:00Z',
    refresh_expires_at: '2026-12-02T00:00:00Z',
    csrf_token: 'csrf-from-session',
  };

  function unauthorizedProblem() {
    return {
      ok: false,
      status: 403,
      headers: new Headers({ 'Content-Type': 'application/problem+json' }),
      json: async () => ({ status: 403, code: 'permission_denied', title: 'csrf token invalid' }),
    } as unknown as Response;
  }

  it('sends X-CSRF-Token on logout and clears the local session even when the request fails', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, init: init ?? {} });
      if (url.endsWith('/auth/logout')) return unauthorizedProblem();
      return jsonResponse({ user: session.user, role: 'site_admin', site_id: 'site_1' });
    });
    vi.stubGlobal('fetch', fetchMock);
    const backend = new HttpBackend({ base: 'http://api.test', onExpired: () => undefined });
    backend.applySession(session);

    await backend.logout();

    const logoutCall = calls.find((call) => call.url.endsWith('/auth/logout'));
    expect(logoutCall).toBeTruthy();
    expect((logoutCall!.init.method ?? 'GET').toUpperCase()).toBe('POST');
    const logoutHeaders = new Headers(logoutCall!.init.headers);
    expect(logoutHeaders.get('X-CSRF-Token')).toBe('csrf-from-session');

    // 登出请求失败后本地 token 也必须清掉：后续请求不应再带 Authorization。
    await backend.me();
    const meCall = calls.find((call) => call.url.endsWith('/me'));
    expect(meCall).toBeTruthy();
    expect(new Headers(meCall!.init.headers).get('Authorization')).toBeNull();
  });

  it('falls back to the pp_csrf cookie when the in-memory token is gone', async () => {
    document.cookie = 'pp_csrf=cookie-token';
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => unauthorizedProblem());
    vi.stubGlobal('fetch', fetchMock);
    const backend = new HttpBackend({ base: 'http://api.test', onExpired: () => undefined });

    await backend.logout();

    const headers = new Headers((fetchMock.mock.calls[0][1] ?? {}).headers);
    expect(headers.get('X-CSRF-Token')).toBe('cookie-token');
    document.cookie = 'pp_csrf=; max-age=0';
  });
});
