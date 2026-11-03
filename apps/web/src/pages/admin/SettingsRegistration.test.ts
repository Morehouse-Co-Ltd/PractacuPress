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
 * O-3：站点设置页的「开放注册」开关必须走 settings PATCH，且把 registration_open
 * 明确带在请求体里（关闭 = false）。
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

function buttonsWithText(text: string): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll<HTMLButtonElement>('button')).filter((button) =>
    button.textContent?.includes(text),
  );
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
  it('sends registration_open=false in the settings PATCH when turned off', async () => {
    const { backend, updateSite } = fakeBackend(siteOf(true));

    await renderSettings(backend);

    await waitFor(() => !!container.querySelector('button[aria-label="开放注册"]'));
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="开放注册"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('true');

    await act(async () => {
      toggle.click();
    });
    expect(toggle.getAttribute('aria-checked')).toBe('false');

    const saveButtons = buttonsWithText('保存修改');
    expect(saveButtons.length).toBeGreaterThan(0);
    await act(async () => {
      saveButtons[0].click();
    });

    await waitFor(() => updateSite.mock.calls.length > 0);
    expect(updateSite).toHaveBeenCalledWith(
      'site_1',
      expect.objectContaining({ registration_open: false }),
    );
  });

  it('shows the switch as on for an open site and leaves it untouched without edits', async () => {
    const { backend, updateSite } = fakeBackend(siteOf(true));

    await renderSettings(backend);

    await waitFor(() => !!container.querySelector('button[aria-label="开放注册"]'));
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="开放注册"]')!;
    expect(toggle.getAttribute('aria-checked')).toBe('true');
    expect(updateSite).not.toHaveBeenCalled();
  });
});
