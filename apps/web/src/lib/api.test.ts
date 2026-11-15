import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, HttpBackend, fallbackProblem, isBackendOffline } from './api';
import { configurePerformance, DEFAULT_PERFORMANCE } from './performance';

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as unknown as Response;
}

function textJsonResponse(body: string): Response {
  return {
    ok: true,
    status: 200,
    text: async () => body,
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

  it('sends site media quota bytes without changing the documented payload', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: typeof input === 'string' ? input : input.toString(), init: init ?? {} });
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
    const backend = new HttpBackend({ base: 'http://api.test', onExpired: () => undefined });

    await backend.updateSite('site_1', { media_quota_bytes: 0 });

    expect(calls[0].url).toBe('http://api.test/api/v1/sites/site_1/settings');
    expect((calls[0].init.method ?? 'GET').toUpperCase()).toBe('PATCH');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ media_quota_bytes: 0 });
  });

  it('sets a member media quota and returns the updated member', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const updated = {
      user_id: 'usr_1',
      display_name: '作者',
      role: 'member',
      status: 'active',
      media_quota_bytes: null,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: typeof input === 'string' ? input : input.toString(), init: init ?? {} });
      return jsonResponse(updated);
    });
    vi.stubGlobal('fetch', fetchMock);
    const backend = new HttpBackend({ base: 'http://api.test', onExpired: () => undefined });

    const result = await backend.setMemberQuota('site_1', 'usr_1', null);

    expect(calls[0].url).toBe('http://api.test/api/v1/sites/site_1/members/usr_1/quota');
    expect((calls[0].init.method ?? 'GET').toUpperCase()).toBe('PATCH');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ media_quota_bytes: null });
    expect(result).toEqual(updated);
  });

  it('preserves large int64 quota values in request and response JSON', async () => {
    const largeQuota = '9007199254740993';
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: typeof input === 'string' ? input : input.toString(), init: init ?? {} });
      if (calls[calls.length - 1].url.endsWith('/settings')) return jsonResponse({});
      return textJsonResponse(
        `{"user_id":"usr_1","display_name":"作者","role":"member","status":"active","media_quota_bytes":${largeQuota}}`,
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const backend = new HttpBackend({ base: 'http://api.test', onExpired: () => undefined });

    await backend.updateSite('site_1', { media_quota_bytes: largeQuota });
    const member = await backend.setMemberQuota('site_1', 'usr_1', largeQuota);

    expect(String(calls[0].init.body)).toBe(`{"media_quota_bytes":${largeQuota}}`);
    expect(String(calls[1].init.body)).toBe(`{"media_quota_bytes":${largeQuota}}`);
    expect(member.media_quota_bytes).toBe(largeQuota);
  });

  it('rejects oversized quota strings before integer conversion or sending a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const backend = new HttpBackend({ base: 'http://api.test', onExpired: () => undefined });
    const bigInt = vi.spyOn(globalThis, 'BigInt');

    try {
      await expect(
        backend.updateSite('site_1', { media_quota_bytes: '9'.repeat(64) }),
      ).rejects.toThrow(RangeError);
      expect(bigInt).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      bigInt.mockRestore();
    }
  });

  it('preserves large site quota response values exactly', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => textJsonResponse(
        '{"id":"site_1","slug":"press","name":"Press","domain":"","description":"literal \\"media_quota_bytes\\":9007199254740993","visibility_mode":"public","publish_mode":"review","disabled":false,"media_quota_bytes":9223372036854775807}',
      )),
    );
    const backend = new HttpBackend({ base: 'http://api.test', onExpired: () => undefined });

    const site = await backend.site('site_1');

    expect(site.media_quota_bytes).toBe('9223372036854775807');
    expect(site.description).toBe('literal "media_quota_bytes":9007199254740993');
  });

  it('preserves unusually long quota response digits without integer conversion', async () => {
    const digits = '9'.repeat(64);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => textJsonResponse(
        `{"id":"site_1","slug":"press","name":"Press","domain":"","visibility_mode":"public","publish_mode":"review","disabled":false,"media_quota_bytes":${digits}}`,
      )),
    );
    const backend = new HttpBackend({ base: 'http://api.test', onExpired: () => undefined });
    const bigInt = vi.spyOn(globalThis, 'BigInt');

    try {
      const site = await backend.site('site_1');
      expect(site.media_quota_bytes).toBe(digits);
      expect(bigInt).not.toHaveBeenCalled();
    } finally {
      bigInt.mockRestore();
    }
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

// FSD F-04: a password login for a TOTP protected account answers with a challenge
// instead of a Session, and the challenge is redeemed by a separate endpoint.
describe('HttpBackend two-factor login', () => {
  const session = {
    user: {
      id: 'usr_1',
      display_name: 'Alice',
      locale: 'zh-CN',
      status: 'active',
      created_at: '2026-11-16T00:00:00Z',
    },
    token_type: 'Bearer',
    access_token: 'access-1',
    access_expires_at: '2026-11-16T00:15:00Z',
    refresh_expires_at: '2026-12-16T00:00:00Z',
    csrf_token: 'csrf-1',
  };

  it('returns the challenge and does not apply a session', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse({
        two_factor_required: true,
        challenge_token: 'challenge-1',
        expires_in: 300,
        expires_at: '2026-11-16T00:05:00Z',
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const backend = new HttpBackend({ base: 'http://api.test', onExpired: () => undefined });

    const result = await backend.login({ identifier: 'alice@example.com', password: 'x' });

    expect(result.status).toBe('two_factor_required');
    if (result.status === 'two_factor_required') {
      expect(result.challenge.challenge_token).toBe('challenge-1');
    }
    // No bearer token was stored: the next request must not carry Authorization.
    await backend.me();
    const meCall = calls.find((call) => call.url.endsWith('/me'));
    expect(new Headers(meCall!.init.headers).get('Authorization')).toBeNull();
  });

  it('redeems the challenge and applies the session', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return jsonResponse(session);
    });
    vi.stubGlobal('fetch', fetchMock);
    const backend = new HttpBackend({ base: 'http://api.test', onExpired: () => undefined });

    const result = await backend.loginTwoFactor('challenge-1', '123456');

    expect(result.access_token).toBe('access-1');
    const call = calls.find((entry) => entry.url.endsWith('/auth/login/2fa'));
    expect(call).toBeTruthy();
    expect(JSON.parse(String(call!.init.body))).toEqual({
      challenge_token: 'challenge-1',
      code: '123456',
    });
  });
});

describe('isBackendOffline', () => {
  it('recognises the status-0 wrapper used when fetch itself fails', () => {
    expect(isBackendOffline(new ApiError(fallbackProblem(0)))).toBe(true);
  });

  it('does not treat a real HTTP error as a connection failure', () => {
    expect(isBackendOffline(new ApiError(fallbackProblem(500)))).toBe(false);
    expect(isBackendOffline(new Error('boom'))).toBe(false);
    expect(isBackendOffline(null)).toBe(false);
  });
});
