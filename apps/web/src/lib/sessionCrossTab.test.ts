import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Me, Session, Site, WebConfig } from '../types';
import type { Backend } from './backend';
import { ApiError, fallbackProblem } from './api';
import { SESSION_SIGNAL_KEY, type SessionSignal } from './sessionSync';
import { AuthProvider, useAuth } from './session';

/**
 * 跨标签页 + 保存设置时的登录态回归。
 *
 * 用户的原话是「登录设置之后，点击新的页面不需要刷新才能进入」。两个具体的
 * 失败场景在这里钉住：
 * - 在另一个标签页里登录 / 退出，本标签页要立刻跟着变（以前要等下一次 401）；
 * - 保存登录设置会重写站点配置对象，但已经建立的会话不能被重新判断一次——那会
 *   把页面打回加载态，运气不好（刷新失败）还会掉回登录页。
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION: Session = {
  user: {
    id: 'usr_1',
    display_name: '站长',
    locale: 'zh-CN',
    status: 'active',
    created_at: '2026-11-01T00:00:00Z',
  },
  token_type: 'Bearer',
  access_token: 'access-1',
  access_expires_at: '2026-11-02T01:00:00Z',
  refresh_expires_at: '2026-12-02T00:00:00Z',
  csrf_token: 'csrf-1',
};

const ME: Me = { user: SESSION.user, role: 'site_admin', site_id: 'site_1' };

const SITE: Site = {
  id: 'site_1',
  slug: 'quiet',
  name: '安静编辑部',
  domain: '',
  visibility_mode: 'public',
  publish_mode: 'review',
  disabled: false,
};

function configOf(patch: Partial<WebConfig> = {}): WebConfig {
  return {
    version: 1,
    setup_complete: true,
    mode: 'live',
    api_base: 'http://api.test',
    site_id: 'site_1',
    database: 'sqlite',
    created_at: '2026-11-02T00:00:00Z',
    docs_url: 'http://api.test/api/v1/docs',
    ...patch,
  };
}

function signedOut(): ApiError {
  return new ApiError({ ...fallbackProblem(401), code: 'unauthenticated' });
}

interface FakeBackend {
  backend: Backend;
  refreshes: number;
  setSignedIn(value: boolean): void;
}

function fakeBackend(initiallySignedIn = false): FakeBackend {
  let signedIn = initiallySignedIn;
  const state = {
    refreshes: 0,
    setSignedIn(value: boolean) {
      signedIn = value;
    },
  };
  const backend = {
    mode: 'live' as const,
    origin: 'http://api.test',
    refresh: async () => {
      state.refreshes += 1;
      if (!signedIn) throw signedOut();
      return SESSION;
    },
    me: async () => {
      if (!signedIn) throw signedOut();
      return ME;
    },
    site: async () => SITE,
    login: async () => {
      signedIn = true;
      return { status: 'session' as const, session: SESSION };
    },
    logout: async () => {
      signedIn = false;
    },
    notifications: async () => ({ items: [], unread: 0 }),
  } as unknown as Backend;
  return { backend, get refreshes() { return state.refreshes; }, setSignedIn: state.setSignedIn };
}

interface Probe {
  status: string;
  name: string;
  auth: ReturnType<typeof useAuth> | null;
  statuses: string[];
}

function ProbeView({ probe }: { probe: Probe }) {
  const auth = useAuth();
  probe.auth = auth;
  useEffect(() => {
    probe.status = auth.status;
    probe.name = auth.me?.user.display_name ?? '';
    probe.statuses.push(auth.status);
  }, [auth, probe]);
  return createElement('div', null, `${auth.status}:${auth.me?.user.display_name ?? ''}`);
}

let container: HTMLDivElement;
let root: Root | null = null;
let probe: Probe;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.cookie = 'pp_csrf=; max-age=0; path=/';
  container = document.createElement('div');
  document.body.appendChild(container);
  probe = { status: '', name: '', auth: null, statuses: [] };
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container.remove();
  localStorage.clear();
  sessionStorage.clear();
});

/** App 里传进来的是 useCallback 稳定引用，这里也必须稳定，否则会误触发重水合。 */
function noopConfigChange(): void {
  /* 测试里不需要写回配置 */
}

async function render(
  config: WebConfig,
  backend: Backend,
  onConfigChange: (patch: Partial<WebConfig>) => void = noopConfigChange,
): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(
      createElement(AuthProvider, {
        config,
        backend,
        onConfigChange,
        children: createElement(ProbeView, { probe }),
      }),
    );
  });
}

async function rerender(
  config: WebConfig,
  backend: Backend,
  onConfigChange: (patch: Partial<WebConfig>) => void = noopConfigChange,
): Promise<void> {
  await act(async () => {
    root?.render(
      createElement(AuthProvider, {
        config,
        backend,
        onConfigChange,
        children: createElement(ProbeView, { probe }),
      }),
    );
  });
}

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw new Error('等待登录态进入预期状态超时');
}

/** 模拟另一个标签页广播出去的登录态信号。 */
function deliverSignal(signal: Partial<SessionSignal> & Pick<SessionSignal, 'kind'>): void {
  const payload: SessionSignal = {
    at: Date.now(),
    source: 'another-tab',
    ...signal,
  };
  window.dispatchEvent(
    new StorageEvent('storage', { key: SESSION_SIGNAL_KEY, newValue: JSON.stringify(payload) }),
  );
}

describe('跨标签页登录态', () => {
  it('follows a login that happened in another tab without a page reload', async () => {
    const fake = fakeBackend(false);
    await render(configOf(), fake.backend);
    await waitFor(() => probe.status === 'anonymous');

    fake.setSignedIn(true);
    await act(async () => {
      deliverSignal({ kind: 'login', userId: SESSION.user.id });
    });

    await waitFor(() => probe.status === 'ready');
    expect(probe.name).toBe('站长');
  });

  it('follows a logout from another tab immediately', async () => {
    const fake = fakeBackend(true);
    await render(configOf(), fake.backend);
    await waitFor(() => probe.status === 'ready');

    fake.setSignedIn(false);
    await act(async () => {
      deliverSignal({ kind: 'logout' });
    });

    await waitFor(() => probe.status === 'anonymous');
    expect(probe.name).toBe('');
  });

  it('does not burn another refresh token when the same account is already signed in', async () => {
    const fake = fakeBackend(true);
    await render(configOf(), fake.backend);
    await waitFor(() => probe.status === 'ready');
    const refreshes = fake.refreshes;

    await act(async () => {
      deliverSignal({ kind: 'login', userId: SESSION.user.id });
    });

    expect(fake.refreshes).toBe(refreshes);
    expect(probe.status).toBe('ready');
  });

  it('announces its own login so the other tabs can follow', async () => {
    const fake = fakeBackend(false);
    await render(configOf(), fake.backend);
    await waitFor(() => probe.status === 'anonymous');

    await act(async () => {
      await probe.auth?.login('owner@example.com', 'long-password-1');
    });

    await waitFor(() => probe.status === 'ready');
    const signal = JSON.parse(localStorage.getItem(SESSION_SIGNAL_KEY) ?? '{}') as SessionSignal;
    expect(signal.kind).toBe('login');
    expect(signal.userId).toBe(SESSION.user.id);
  });

  it('announces its own logout so a tab that stays open drops the session too', async () => {
    const fake = fakeBackend(true);
    await render(configOf(), fake.backend);
    await waitFor(() => probe.status === 'ready');

    await act(async () => {
      await probe.auth?.logout();
    });

    await waitFor(() => probe.status === 'anonymous');
    const signal = JSON.parse(localStorage.getItem(SESSION_SIGNAL_KEY) ?? '{}') as SessionSignal;
    expect(signal.kind).toBe('logout');
  });
});

describe('保存登录设置不会重判登录态', () => {
  it('keeps a ready session when another site setting rewrites the config', async () => {
    // 访客引导出来的配置（visitor: true）最容易被重写：保存登录设置就是一次
    // updateConfig({ auth })，它以前会让 AuthProvider 重新跑一遍开屏水合。
    const base = configOf({
      visitor: true,
      visitor_site_name: '安静编辑部',
      visitor_registration_open: true,
    });
    const fake = fakeBackend(true);
    await render(base, fake.backend);
    await waitFor(() => probe.status === 'ready');
    expect(fake.refreshes).toBe(1);
    // 开屏那一次水合本来就会把状态设成 loading（挂载 effect 会再置一次），
    // 这里只要求「保存设置之后不再多出一次」。
    const settleLoadings = probe.statuses.filter((status) => status === 'loading').length;

    const saved = {
      ...base,
      auth: {
        phone: { enabled: true, client_id: 'Practacu', redirect_uri: '', extra: 'SMS_1', note: '' },
        google: { enabled: false, client_id: '', redirect_uri: '', extra: '', note: '' },
        github: { enabled: false, client_id: '', redirect_uri: '', extra: '', note: '' },
        wechat: { enabled: false, client_id: '', redirect_uri: '', extra: '', note: '' },
        qq: { enabled: false, client_id: '', redirect_uri: '', extra: '', note: '' },
        authenticator: { enabled: false, client_id: '', redirect_uri: '', extra: '', note: '' },
      },
    } satisfies WebConfig;
    await rerender(saved, fake.backend);

    // 页面不该被打回「正在确认登录状态」，也不该再消耗一次刷新令牌。
    expect(probe.statuses.filter((status) => status === 'loading')).toHaveLength(settleLoadings);
    expect(probe.status).toBe('ready');
    expect(fake.refreshes).toBe(1);
  });
});
