import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { Me, Session, Site, User, WebConfig } from '../../types';
import type { Backend } from '../../lib/backend';
import { BackendProvider } from '../../lib/backend';
import { AuthProvider } from '../../lib/session';
import { ToastProvider } from '../../lib/toast';
import { SettingsPage } from './Settings';

/**
 * 站点设置页的自动保存，以及 O-3 注册开关的语义。
 *
 * 页面已经没有「保存修改」按钮：改动在停手约 700ms 后自动写到设置 PATCH。
 * 这里用真实计时器等防抖窗口过去（`waitFor` / `waitPastAutoSave`），不再点按钮。
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const USER: User = {
  id: 'usr_owner',
  display_name: '站长',
  locale: 'zh-CN',
  status: 'active',
  created_at: '2026-11-01T00:00:00Z',
};

const SESSION: Session = {
  user: USER,
  token_type: 'Bearer',
  access_token: 'access',
  access_expires_at: '2026-11-02T01:00:00Z',
  refresh_expires_at: '2026-12-02T00:00:00Z',
  csrf_token: 'csrf',
};

const ME: Me = { user: USER, role: 'platform_admin', site_id: 'site_1' };

function siteOf(registrationOpen: boolean): Site {
  return {
    id: 'site_1',
    slug: 'practacu',
    name: 'Practacu Press',
    domain: '',
    created_at: '2026-10-01T00:00:00Z',
    visibility_mode: 'public',
    publish_mode: 'review',
    disabled: false,
    description: '',
    registration_open: registrationOpen,
  };
}

function configOf(): WebConfig {
  return {
    version: 1,
    setup_complete: true,
    mode: 'live',
    api_base: 'http://api.test',
    site_id: 'site_1',
    database: 'sqlite',
    created_at: '2026-11-01T00:00:00Z',
    docs_url: 'http://api.test/api/v1/docs',
  };
}

interface FakeBackend {
  backend: Backend;
  updateSite: ReturnType<typeof vi.fn>;
}

function fakeBackend(site: Site): FakeBackend {
  const updateSite = vi.fn(async () => undefined);
  const backend = {
    mode: 'live' as const,
    origin: 'http://api.test',
    refresh: async () => SESSION,
    me: async () => ME,
    site: async () => site,
    updateSite,
    setSiteDomain: vi.fn(async () => undefined),
  } as unknown as Backend;
  return { backend, updateSite };
}

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container.remove();
  localStorage.clear();
});

async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw new Error('等待界面进入预期状态超时');
}

/**
 * 等过自动保存的防抖窗口。
 *
 * 用来断言「什么都没有发生」：水合 / 只渲染不应触发任何写入。
 */
async function waitPastAutoSave(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 900));
  });
}

async function renderSettings(backend: Backend): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(
      createElement(ToastProvider, null,
        createElement(BackendProvider, {
          backend,
          children: createElement(AuthProvider, {
            config: configOf(),
            backend,
            onConfigChange: () => undefined,
            children: createElement(MemoryRouter, {
              children: createElement(SettingsPage),
            }),
          }),
        }),
      ),
    );
  });
}

describe('站点设置页的注册开关', () => {
  it('autosaves registration_open=false in the settings PATCH when turned off', async () => {
    const { backend, updateSite } = fakeBackend(siteOf(true));

    await renderSettings(backend);

    await waitFor(() => !!container.querySelector('button[aria-label="开放注册"]'));
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="开放注册"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    await act(async () => {
      toggle.click();
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    // 没有「保存修改」按钮：等防抖窗口过去，设置 PATCH 应该自己发出去。
    await waitFor(() => updateSite.mock.calls.length > 0);
    expect(updateSite).toHaveBeenCalledWith(
      'site_1',
      expect.objectContaining({ registration_open: false }),
    );
    // 保存成功后状态角标会显示「已自动保存」（同时有 toast）。
    await waitFor(() => (container.textContent ?? '').includes('已自动保存'));
    // 自动保存不能因为 applySite / 水合重算又发一次重复请求。
    await waitPastAutoSave();
    expect(updateSite).toHaveBeenCalledTimes(1);
  });

  it('shows the switch as on for an open site and leaves it untouched without edits', async () => {
    const { backend, updateSite } = fakeBackend(siteOf(true));

    await renderSettings(backend);

    await waitFor(() => !!container.querySelector('button[aria-label="开放注册"]'));
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="开放注册"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    // 挂载 / 水合只建立基线：等过防抖窗口也不该发出保存请求。
    await waitPastAutoSave();
    expect(updateSite).not.toHaveBeenCalled();
  });
});

describe('站点设置页不再包含媒体额度', () => {
  it('does not render the media quota field after the move', async () => {
    const { backend } = fakeBackend(siteOf(true));

    await renderSettings(backend);
    await waitFor(() => !!container.querySelector('button[aria-label="开放注册"]'));

    expect(container.querySelector('input[aria-label="本站媒体额度（MB）"]')).toBeNull();
    expect(container.textContent ?? '').not.toContain('媒体额度');
  });
});
