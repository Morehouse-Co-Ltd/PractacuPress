import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import App from './App';

/**
 * O-1 验收：没有 localStorage 安装配置的浏览器打开站点时——
 * - 服务端已安装且已有管理员 → 直接渲染服务端站点，不再渲染 7 步安装引导；
 * - 服务端未安装 / 没有管理员 → 仍然渲染安装引导。
 *
 * 这里直接渲染真实的 `<App />`（happy-dom + 模拟 fetch），而不是只测探测函数，
 * 因为要保护的是"顶层分支选错"这个回归。
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONFIG_KEY = 'pp.web.config.v1';

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'Content-Type': 'application/json' }),
    json: async () => body,
  } as unknown as Response;
}

function problemResponse(status: number): Response {
  return {
    ok: false,
    status,
    headers: new Headers({ 'Content-Type': 'application/problem+json' }),
    json: async () => ({
      status,
      code: status === 401 ? 'unauthenticated' : 'not_found',
      title: 'not found',
    }),
  } as unknown as Response;
}

interface StubOptions {
  installed: boolean;
  hasAdmin: boolean;
  siteName?: string;
  siteId?: string;
  customization?: unknown;
  customizationStatus?: number;
}

function stubFetch(options: StubOptions): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    urls.push(url);
    if (url.endsWith('/api/v1/setup/status')) {
      return okResponse({
        installed: options.installed,
        has_admin: options.hasAdmin,
        ...(options.siteId ? { site_id: options.siteId } : {}),
        ...(options.siteName ? { site_name: options.siteName } : {}),
      });
    }
    if (url.includes('/api/v1/sites/') && url.endsWith('/customization')) {
      if (options.customizationStatus && options.customizationStatus !== 200) {
        return problemResponse(options.customizationStatus);
      }
      return okResponse({
        site_id: options.siteId ?? 'site_visitor',
        revision: 1,
        updated_at: '2026-11-02T04:40:00Z',
        customization: options.customization ?? {},
      });
    }
    return problemResponse(404);
  }) as typeof fetch;
  return { fetchImpl, urls };
}

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  document.title = '';
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container.remove();
  vi.unstubAllGlobals();
  localStorage.clear();
  sessionStorage.clear();
});

async function renderApp(): Promise<void> {
  await act(async () => {
    root = createRoot(container);
    root.render(createElement(App));
  });
}

async function waitFor(check: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (check()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw new Error('等待界面进入预期状态超时');
}

describe('匿名访客启动引导（O-1）', () => {
  it('renders the server site instead of the install wizard when installed with an admin', async () => {
    const { fetchImpl, urls } = stubFetch({
      installed: true,
      hasAdmin: true,
      siteId: 'site_visitor',
      siteName: '侧耳倾听',
      customization: { theme: { preset: 'night' }, custom_css: '.hero{color:#fff}' },
    });
    vi.stubGlobal('fetch', fetchImpl);

    await renderApp();
    await waitFor(() => document.title.includes('侧耳倾听') || container.textContent?.includes('侧耳倾听') === true);

    expect(document.title).not.toContain('安装引导');
    expect(container.textContent).not.toContain('安装引导');
    // 站点名来自 setup/status，说明用的是访客引导构造的配置。
    expect(container.textContent).toContain('侧耳倾听');
    // 渲染前已经拉过服务端设计（members_only / 未保存设计会回退默认值，但请求必须发生）。
    expect(urls.some((url) => url.endsWith('/api/v1/sites/site_visitor/customization'))).toBe(true);
    // 访客配置绝不写回安装状态。
    expect(localStorage.getItem(CONFIG_KEY)).toBeNull();
  });

  it('keeps the install wizard when the server is not installed', async () => {
    const { fetchImpl } = stubFetch({ installed: false, hasAdmin: false });
    vi.stubGlobal('fetch', fetchImpl);

    await renderApp();
    await waitFor(() => document.title.includes('安装引导'));

    expect(document.title).toContain('安装引导');
    expect(localStorage.getItem(CONFIG_KEY)).toBeNull();
  });

  it('keeps the install wizard when the site has no administrator yet', async () => {
    const { fetchImpl } = stubFetch({ installed: true, hasAdmin: false, siteId: 'site_visitor' });
    vi.stubGlobal('fetch', fetchImpl);

    await renderApp();
    await waitFor(() => document.title.includes('安装引导'));

    expect(document.title).toContain('安装引导');
  });

  it('falls back to the default design when the design request returns 404', async () => {
    const { fetchImpl } = stubFetch({
      installed: true,
      hasAdmin: true,
      siteId: 'site_visitor',
      siteName: 'members only',
      customizationStatus: 404,
    });
    vi.stubGlobal('fetch', fetchImpl);

    await renderApp();
    // members_only 站点的匿名设计请求也是 404：不能卡在 loading，要按默认设计渲染站点。
    await waitFor(() => document.title.includes('members only') || container.textContent?.includes('members only') === true);

    expect(document.title).not.toContain('安装引导');
  });
});
