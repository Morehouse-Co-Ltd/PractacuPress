import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { Me, Session, Site, SiteDomainVerification, User, WebConfig } from '../../types';
import type { Backend } from '../../lib/backend';
import { BackendProvider } from '../../lib/backend';
import { AuthProvider } from '../../lib/session';
import { ToastProvider } from '../../lib/toast';
import { DomainsPage } from './Domains';

/**
 * V-12：域名保存后进入「待验证」，后台要展示可复制的 TXT 记录，并能一键验证。
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

function siteOf(): Site {
  return {
    id: 'site_1',
    slug: 'practacu',
    name: 'Practacu Press',
    domain: 'press.example.com',
    created_at: '2026-10-01T00:00:00Z',
    visibility_mode: 'public',
    publish_mode: 'review',
    disabled: false,
    description: '',
    registration_open: true,
  };
}

const PENDING: SiteDomainVerification = {
  domain: 'press.example.com',
  verified: false,
  verification_token: 'pp_verify_pending_token',
  record_name: '_practacu-verify.press.example.com',
  record_type: 'TXT',
};

const VERIFIED: SiteDomainVerification = { ...PENDING, verified: true };

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

function fakeBackend(): {
  backend: Backend;
  verifySiteDomain: ReturnType<typeof vi.fn>;
  siteDomain: ReturnType<typeof vi.fn>;
} {
  const siteDomain = vi
    .fn()
    .mockResolvedValueOnce(PENDING)
    .mockResolvedValue(VERIFIED);
  const verifySiteDomain = vi.fn(async () => ({ verified: true, domain: PENDING.domain }));
  const backend = {
    mode: 'live' as const,
    origin: 'http://api.test',
    refresh: async () => SESSION,
    me: async () => ME,
    site: async () => siteOf(),
    siteDomain,
    verifySiteDomain,
    updateSite: vi.fn(async () => undefined),
    setSiteDomain: vi.fn(async () => undefined),
  } as unknown as Backend;
  return { backend, verifySiteDomain, siteDomain };
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

async function renderDomains(backend: Backend): Promise<void> {
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
              children: createElement(DomainsPage),
            }),
          }),
        }),
      ),
    );
  });
}

describe('访问与域名页的 TXT 验证引导', () => {
  it('shows the pending record and verifies it on demand', async () => {
    const { backend, verifySiteDomain } = fakeBackend();
    await renderDomains(backend);

    // 待验证状态 + 可复制的 TXT 记录（记录名与记录值都来自 GET /domain）。
    await waitFor(() => container.textContent?.includes('域名待验证') === true);
    expect(container.textContent).toContain('域名待验证');
    expect(container.textContent).toContain('验证完成前，公网域名暂不生效');
    const inputValues = Array.from(container.querySelectorAll<HTMLInputElement>('input')).map(
      (input) => input.value,
    );
    expect(inputValues).toContain('TXT');
    expect(inputValues).toContain('_practacu-verify.press.example.com');
    expect(inputValues).toContain('pp_verify_pending_token');

    const verifyButton = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('我已添加，立即验证'),
    );
    expect(verifyButton).toBeTruthy();
    await act(async () => {
      verifyButton!.click();
    });

    await waitFor(() => verifySiteDomain.mock.calls.length > 0);
    expect(verifySiteDomain).toHaveBeenCalledWith('site_1');
    // 验证成功后状态刷新为已验证。
    await waitFor(() => container.textContent?.includes('主域名已验证') === true);
    expect(container.textContent).toContain('主域名已验证');
  });
});
