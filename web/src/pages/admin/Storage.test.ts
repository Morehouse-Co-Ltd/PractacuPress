import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type {
  Me,
  Session,
  Site,
  StorageStatus,
  User,
  WebConfig,
} from '../../types';
import type { Backend } from '../../lib/backend';
import { BackendProvider } from '../../lib/backend';
import { AuthProvider } from '../../lib/session';
import { ToastProvider } from '../../lib/toast';
import { StoragePage } from './Storage';

/**
 * 「储存与媒体」页的结构与媒体额度接线。
 *
 * 页面本体依赖登录态、后端和路由；这里用和站点设置页相同的真实 Provider 脚手架，
 * 只把网络替换成 fake backend。媒体额度的输入细节由 `MediaQuotaField.test.tsx`
 * 覆盖，这里验证它确实接到了站点设置 PATCH。
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
    domain: '',
    created_at: '2026-10-01T00:00:00Z',
    visibility_mode: 'public',
    publish_mode: 'review',
    disabled: false,
    description: '',
    registration_open: true,
    media_quota_bytes: null,
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

/** 服务端已经生效的一套本地策略；用于渲染页头的生效徽标与操作按钮。 */
const STATUS: StorageStatus = {
  live: true,
  source: 'saved',
  updated_at: null,
  max_content_chars: 1_000_000,
  global_strategy_id: 'local',
  strategies: [
    {
      id: 'local',
      name: '本地储存',
      driver: 'local',
      local_dir: './data/media',
      s3_bucket: '',
      s3_prefix: '',
      s3_endpoint: '',
      s3_region: '',
      has_access_key: false,
      has_secret: false,
    },
  ],
  scopes: { content: 'local', site: 'local', avatar: 'local', attachment: 'local' },
  allocations: {},
  effective: [],
};

interface FakeBackend {
  backend: Backend;
  updateSite: ReturnType<typeof vi.fn>;
  updateConfig: (patch: Partial<WebConfig>) => void;
  applyStorage: ReturnType<typeof vi.fn>;
}

function fakeBackend(): FakeBackend {
  const updateSite = vi.fn(async () => undefined);
  const updateConfig = vi.fn<(patch: Partial<WebConfig>) => void>();
  const applyStorage = vi.fn(async () => STATUS);
  const backend = {
    mode: 'live' as const,
    origin: 'http://api.test',
    refresh: async () => SESSION,
    me: async () => ME,
    site: async () => siteOf(),
    storageStatus: async () => STATUS,
    applyStorage,
    updateSite,
  } as unknown as Backend;
  return { backend, updateSite, updateConfig, applyStorage };
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

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

async function renderStorage(fake: FakeBackend): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(
      createElement(ToastProvider, null,
        createElement(BackendProvider, {
          backend: fake.backend,
          children: createElement(AuthProvider, {
            config: configOf(),
            backend: fake.backend,
            onConfigChange: fake.updateConfig,
            children: createElement(MemoryRouter, {
              children: createElement(StoragePage),
            }),
          }),
        }),
      ),
    );
  });
  await waitFor(() => !!container.querySelector('h1'));
}

function headings(): string[] {
  return [...container.querySelectorAll('h1, h3, h4')].map((node) => node.textContent ?? '');
}

function scopeCard(name: string): HTMLElement {
  const card = [...container.querySelectorAll<HTMLElement>('.storage-scope')].find((node) =>
    (node.textContent ?? '').includes(name),
  );
  if (!card) throw new Error(`找不到用途卡片 ${name}`);
  return card;
}

async function openAllocationDialog(name: string): Promise<HTMLElement> {
  const trigger = scopeCard(name).querySelector<HTMLButtonElement>('.storage-current');
  if (!trigger) throw new Error('找不到分配弹窗入口');
  await act(async () => {
    trigger.click();
  });
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!dialog) throw new Error('找不到分配弹窗');
  return dialog;
}

async function clickAllocationTab(dialog: HTMLElement, label: string): Promise<void> {
  const tab = [...dialog.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((node) =>
    (node.textContent ?? '').includes(label),
  );
  if (!tab) throw new Error(`找不到分配方式 ${label}`);
  await act(async () => {
    tab.click();
  });
}

/** 等过页面自动保存的 700ms 防抖窗口。 */
async function waitPastAutoSave(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 900));
  });
}

describe('储存与媒体页', () => {
  it('renders the renamed sections without the runtime status panel', async () => {
    const fake = fakeBackend();
    await renderStorage(fake);

    expect(container.querySelector('h1')?.textContent).toBe('储存与媒体');
    expect(headings()).toContain('储存策略');
    expect(headings()).toContain('储存设置');
    expect(headings()).toContain('各用途使用哪套策略');
    expect(headings()).not.toContain('用途分配');
    expect(headings()).not.toContain('当前生效与运行状态');

    // 储存设置：正文长度、上传提示、站点媒体额度都在同一块里。
    expect(container.textContent).toContain('正文长度上限');
    expect(container.textContent).toContain('上传体积提示');
    expect(container.textContent).toContain('本站媒体额度（MB）');
    expect(container.querySelector('#storage-max-content-chars')).not.toBeNull();
    expect(container.querySelector('#storage-max-upload')).not.toBeNull();

    // 四个用途卡片都还在。
    expect(container.querySelectorAll('.storage-scope')).toHaveLength(4);

    // 生效徽标与手动操作移到页头，不再占一整块面板。
    const head = container.querySelector('.admin-page-head');
    expect(head?.textContent).toContain('已生效');
    expect(head?.textContent).toContain('立即应用');
    expect(head?.textContent).toContain('刷新');
  });

  it('saves the media quota through the site settings patch', async () => {
    const fake = fakeBackend();
    await renderStorage(fake);

    const input = container.querySelector<HTMLInputElement>(
      'input[aria-label="本站媒体额度（MB）"]',
    );
    expect(input).not.toBeNull();

    await act(async () => {
      setInputValue(input!, '1.5');
    });
    await waitFor(() => fake.updateSite.mock.calls.length > 0);

    expect(fake.updateSite).toHaveBeenCalledWith('site_1', { media_quota_bytes: 1572864 });
    // 保存成功后进度提示落在字段下方，页面头的储存自动保存状态不受影响。
    await waitFor(() => (container.textContent ?? '').includes('已自动保存'));
  });

  it('keeps allocation edits local until 完成 is clicked', async () => {
    const fake = fakeBackend();
    await renderStorage(fake);
    expect(fake.applyStorage).not.toHaveBeenCalled();

    const dialog = await openAllocationDialog('文章媒体');
    await clickAllocationTab(dialog, '多策略');

    // 弹窗里切换分配方式后等过防抖窗口：页面不应保存，也不应弹「已自动保存」。
    await waitPastAutoSave();
    expect(fake.applyStorage).not.toHaveBeenCalled();
    expect(container.querySelector('.toast')).toBeNull();
    expect(scopeCard('文章媒体').textContent).toContain('单策略');

    const done = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === '完成',
    );
    expect(done).toBeTruthy();
    await act(async () => {
      done!.click();
    });

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(scopeCard('文章媒体').textContent).toContain('多策略');

    // 点完成才写回页面草稿，并按手动保存立即写盘 / 应用。
    await waitFor(() => fake.applyStorage.mock.calls.length > 0);
    expect(container.querySelector('.toast strong')?.textContent).toBe('已保存');
    // 页面头的保存状态保持在已保存，不因随后到达的防抖轮询退回「修改会自动保存」。
    expect(container.querySelector('.autosave-status')?.textContent).toContain('已自动保存');
  });

  it('discards allocation edits when the dialog is closed without 完成', async () => {
    const fake = fakeBackend();
    await renderStorage(fake);

    const dialog = await openAllocationDialog('文章媒体');
    await clickAllocationTab(dialog, '多策略');

    const close = dialog.querySelector<HTMLButtonElement>('.icon-btn');
    expect(close).not.toBeNull();
    await act(async () => {
      close!.click();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await waitPastAutoSave();
    expect(fake.applyStorage).not.toHaveBeenCalled();
    expect(container.querySelector('.toast')).toBeNull();
    expect(scopeCard('文章媒体').textContent).toContain('单策略');
  });
});
