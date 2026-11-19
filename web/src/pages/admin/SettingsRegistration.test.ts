import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import type { Me, Session, Site, User, WebConfig } from '../../types';
import type { Backend } from '../../lib/backend';
import { BackendProvider } from '../../lib/backend';
import { AuthProvider } from '../../lib/session';
import { ToastProvider } from '../../lib/toast';
import { bytesToMbString, parseMediaQuotaMbInput } from '../../lib/mediaQuota';
import { SettingsPage } from './Settings';

/**
 * 站点设置页的自动保存，以及 O-3 注册开关 / 媒体额度的语义。
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

function siteOf(registrationOpen: boolean, mediaQuotaBytes?: number | null): Site {
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
    media_quota_bytes: mediaQuotaBytes,
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

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
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

describe('站点设置页的媒体额度', () => {
  it('shows MB semantics and autosaves zero for unlimited quota', async () => {
    const { backend, updateSite } = fakeBackend(siteOf(true, null));

    await renderSettings(backend);

    const input = await waitForInput('本站媒体额度（MB）');
    expect(input.value).toBe('');
    expect(container.textContent).toContain(
      '媒体额度单位为 MB（1 MB = 1024 × 1024 字节）；留空继承部署默认，0 表示无限。',
    );
    await act(async () => {
      setInputValue(input, '0');
    });

    await waitFor(() => updateSite.mock.calls.length > 0);
    expect(updateSite).toHaveBeenCalledWith(
      'site_1',
      expect.objectContaining({ media_quota_bytes: 0 }),
    );
  });

  it('sends null when clearing an explicit quota to inherit the deployment default', async () => {
    const { backend, updateSite } = fakeBackend(siteOf(true, 1572864));

    await renderSettings(backend);

    // 字节存储的 1572864 在界面里显示成 1.5 MB。
    const input = await waitForInput('本站媒体额度（MB）');
    expect(input.value).toBe('1.5');
    await act(async () => {
      setInputValue(input, '');
    });

    await waitFor(() => updateSite.mock.calls.length > 0);
    expect(updateSite).toHaveBeenCalledWith(
      'site_1',
      expect.objectContaining({ media_quota_bytes: null }),
    );
  });

  it('converts a decimal MB input into whole bytes', async () => {
    const { backend, updateSite } = fakeBackend(siteOf(true, null));

    await renderSettings(backend);

    const input = await waitForInput('本站媒体额度（MB）');
    await act(async () => {
      setInputValue(input, '1.5');
    });

    await waitFor(() => updateSite.mock.calls.length > 0);
    expect(updateSite).toHaveBeenCalledWith(
      'site_1',
      expect.objectContaining({ media_quota_bytes: 1572864 }),
    );
  });

  it('rejects a negative MB value without sending a request', async () => {
    const { backend, updateSite } = fakeBackend(siteOf(true, null));

    await renderSettings(backend);

    const input = await waitForInput('本站媒体额度（MB）');
    await act(async () => {
      setInputValue(input, '-1');
    });

    // 非法值不落盘：等校验提示出现，确认没有发出任何请求，也没有冒充「已保存」。
    await waitFor(() =>
      (container.textContent ?? '').includes(
        '媒体额度必须是非负整数或小数（MB），且不能超过可存储上限。',
      ),
    );
    expect(updateSite).not.toHaveBeenCalled();
    expect((container.textContent ?? '').includes('已自动保存')).toBe(false);
  });
});

async function waitForInput(label: string): Promise<HTMLInputElement> {
  const start = Date.now();
  while (Date.now() - start < 3000) {
    const input = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    if (input) return input;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw new Error(`等待输入框 ${label} 超时`);
}

/** 界面单位是 MB，存储与接口始终是字节：这里钉住两边的换算规则。 */
describe('媒体额度的 MB 换算', () => {
  it('把字节值显示成去掉末尾零的 MB 字符串', () => {
    expect(bytesToMbString(null)).toBe('');
    expect(bytesToMbString(undefined)).toBe('');
    expect(bytesToMbString(0)).toBe('0');
    expect(bytesToMbString(1572864)).toBe('1.5');
    expect(bytesToMbString(1073741824)).toBe('1024');
    // 旧后端可能把 int64 当十进制字符串返回：换算同样精确，不丢位。
    expect(bytesToMbString('1073741824')).toBe('1024');
    expect(bytesToMbString('9223372036854775807')).toBe('8796093022207.999999');
  });

  it('把 MB 输入换算成四舍五入后的整数字节', () => {
    expect(parseMediaQuotaMbInput('')).toEqual({ valid: true, value: null });
    expect(parseMediaQuotaMbInput('0')).toEqual({ valid: true, value: 0 });
    expect(parseMediaQuotaMbInput('1.5')).toEqual({ valid: true, value: 1572864 });
    expect(parseMediaQuotaMbInput('0.5')).toEqual({ valid: true, value: 524288 });
  });

  it('拒绝负数、非数字与超出安全整数范围的字节数', () => {
    for (const raw of ['-1', '-0.5', 'abc', 'NaN', '1e3', '1,5', '1 024']) {
      expect(parseMediaQuotaMbInput(raw), raw).toEqual({ valid: false });
    }
    // 2^53 字节是安全整数的天花板（约 8589934591 MB）。
    expect(parseMediaQuotaMbInput('8589934591')).toEqual({
      valid: true,
      value: 9007199253692416,
    });
    expect(parseMediaQuotaMbInput('8589934592')).toEqual({ valid: false });
    expect(parseMediaQuotaMbInput('999999999999999999999')).toEqual({ valid: false });
  });
});
