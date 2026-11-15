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
  id: 'usr_root',
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

const ROOT_MEMBER: Member = {
  user_id: 'usr_root',
  display_name: '站长',
  role: 'platform_admin',
  status: 'active',
  email: 'root@example.test',
};

const WRITER: Member = {
  user_id: 'usr_writer',
  display_name: '作者',
  role: 'member',
  status: 'active',
  email: 'writer@example.test',
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

function fakeBackend(): Backend {
  return {
    mode: 'live' as const,
    origin: 'http://api.test',
    refresh: async () => SESSION,
    me: async () => ME,
    site: async () => SITE,
    members: vi.fn(async () => [ROOT_MEMBER, WRITER]),
  } as unknown as Backend;
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

/** 等到两行成员都渲染出来。 */
async function waitForRows(): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < 3000) {
    const rows = container.querySelectorAll('tbody tr');
    if (rows.length === 2) return;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  }
  throw new Error('等待成员列表超时');
}

describe('用户管理中的最高管理员', () => {
  it('renders the registered super admin group as locked', async () => {
    await renderMembers(fakeBackend());
    await waitForRows();

    const rows = Array.from(container.querySelectorAll('tbody tr'));
    const rootRow = rows.find((row) => row.textContent?.includes('站长'));
    expect(rootRow).toBeTruthy();

    // The owner row has no group selector at all; it shows the fixed-group note.
    expect(rootRow!.querySelector('select')).toBeNull();
    expect(rootRow!.textContent).toContain('最高管理员');
    expect(rootRow!.textContent).toContain('注册该站的账号，用户组固定');
  });

  it('never offers the super admin group to another member', async () => {
    await renderMembers(fakeBackend());
    await waitForRows();

    const select = container.querySelector<HTMLSelectElement>(
      'select[aria-label="作者 的用户组"]',
    );
    expect(select).toBeTruthy();

    const options = Array.from(select!.querySelectorAll('option'));
    expect(options.length).toBeGreaterThan(0);
    expect(options.some((option) => option.textContent === '最高管理员')).toBe(false);
    expect(options.map((option) => option.value)).not.toContain('owner');
  });
});
