import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Me, Session, Site, WebConfig } from '../types';
import type { Backend } from './backend';
import { ApiError, fallbackProblem } from './api';
import { AuthProvider, useAuth } from './session';

/**
 * 访客配置转正。
 *
 * 全新浏览器打开已安装的站点时，App 先构造一份只读访客配置（`visitor: true`）：
 * 不写 localStorage、不装设计写回。站长登录后如果这面旗不翻，
 * - 编辑器写的设计永远进不了 localStorage，预览 iframe（独立文档）读不到任何变化；
 * - 设计水合与写回句柄也不会安装，服务端与访客都看不到修改。
 * 这个文件钉住「会话建立的那一刻必须通知上层 visitor:false，且只通知一次」。
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
  name: '安静的编辑部',
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

function fakeBackend(initiallySignedIn: boolean): { backend: Backend; signIn(value: boolean): void } {
  let signedIn = initiallySignedIn;
  const backend = {
    mode: 'live' as const,
    origin: 'http://api.test',
    refresh: async () => {
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
  return {
    backend,
    signIn(value: boolean) {
      signedIn = value;
    },
  };
}

let container: HTMLDivElement;
let root: Root | null = null;
let status = '';
let auth: ReturnType<typeof useAuth> | null = null;

function Probe() {
  const value = useAuth();
  auth = value;
  useEffect(() => {
    status = value.status;
  }, [value]);
  return createElement('div', null, value.status);
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.cookie = 'pp_csrf=; max-age=0; path=/';
  container = document.createElement('div');
  document.body.appendChild(container);
  status = '';
  auth = null;
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container.remove();
});

async function render(config: WebConfig, backend: Backend, patches: Partial<WebConfig>[]) {
  const onConfigChange = (patch: Partial<WebConfig>) => {
    patches.push(patch);
  };
  await act(async () => {
    root = createRoot(container);
    root.render(
      createElement(AuthProvider, {
        config,
        backend,
        onConfigChange,
        children: createElement(Probe),
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

const visitorPatches = (patches: Partial<WebConfig>[]) =>
  patches.filter((patch) => patch.visitor === false);

describe('访客配置转正', () => {
  it('已有会话的站长刷新时把 visitor 翻成 false，只通知一次', async () => {
    const patches: Partial<WebConfig>[] = [];
    await render(configOf({ visitor: true }), fakeBackend(true).backend, patches);
    await waitFor(() => status === 'ready');
    expect(visitorPatches(patches)).toEqual([{ visitor: false }]);
  });

  it('登录成功后把 visitor 翻成 false', async () => {
    const patches: Partial<WebConfig>[] = [];
    const fake = fakeBackend(false);
    await render(configOf({ visitor: true }), fake.backend, patches);
    await waitFor(() => status === 'anonymous');

    await act(async () => {
      await auth?.login('owner@example.com', 'long-password-1');
    });

    await waitFor(() => status === 'ready');
    expect(visitorPatches(patches)).toEqual([{ visitor: false }]);
  });

  it('本来就是站长配置时不重复通知', async () => {
    const patches: Partial<WebConfig>[] = [];
    await render(configOf(), fakeBackend(true).backend, patches);
    await waitFor(() => status === 'ready');
    expect(visitorPatches(patches)).toEqual([]);
  });
});
