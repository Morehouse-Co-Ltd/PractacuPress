import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { Me, Member, Session, Site, User, WebConfig } from '../../types';
import type { Backend } from '../../lib/backend';
import { BackendProvider } from '../../lib/backend';
import { AuthProvider } from '../../lib/session';
import { ToastProvider } from '../../lib/toast';
import { MembersPage } from './Members';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const USER: User = {
  id: 'usr_admin',
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
const SITE: Site = {
  id: 'site_1',
  slug: 'press',
  name: 'Practacu Press',
  domain: '',
  visibility_mode: 'public',
  publish_mode: 'review',
  disabled: false,
};
const MEMBER: Member = {
  user_id: 'usr_writer',
  display_name: '作者',
  role: 'member',
  status: 'active',
  email: 'writer@example.test',
  media_quota_bytes: 8192,
};

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

function fakeBackend() {
  const setMemberQuota = vi.fn(async () => ({ ...MEMBER, media_quota_bytes: null }));
  const backend = {
    mode: 'live' as const,
    origin: 'http://api.test',
    refresh: async () => SESSION,
    me: async () => ME,
    site: async () => SITE,
    members: vi.fn(async () => [MEMBER]),
    setMemberQuota,
  } as unknown as Backend;
  return { backend, setMemberQuota };
}

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  localStorage.clear();
});

async function renderMembers(backend: Backend): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(
      createElement(
        ToastProvider,
        null,
        createElement(
          BackendProvider,
          {
            backend,
            children: createElement(AuthProvider, {
              config: configOf(),
              backend,
              onConfigChange: () => undefined,
              children: createElement(MemoryRouter, { children: createElement(MembersPage) }),
            }),
          },
        ),
      ),
    );
  });
}

async function waitForInput(): Promise<HTMLInputElement> {
  const start = Date.now();
  while (Date.now() - start < 3000) {
    const input = container.querySelector<HTMLInputElement>('input[aria-label="作者 的媒体额度（字节）"]');
    if (input) return input;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  }
  throw new Error('等待成员媒体额度输入框超时');
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('成员列表的媒体额度', () => {
  it('clears a member override by saving null to that member', async () => {
    const { backend, setMemberQuota } = fakeBackend();
    await renderMembers(backend);

    const input = await waitForInput();
    expect(input.value).toBe('8192');
    await act(async () => setInputValue(input, ''));

    const save = container.querySelector<HTMLButtonElement>(
      'button[aria-label="保存作者的媒体额度"]',
    );
    expect(save).toBeTruthy();
    await act(async () => save!.click());

    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(setMemberQuota).toHaveBeenCalledWith('site_1', 'usr_writer', null);
  });
});
