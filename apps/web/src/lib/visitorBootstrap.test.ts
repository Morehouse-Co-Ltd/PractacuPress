import { describe, expect, it } from 'vitest';
import { bootstrapVisitorConfig, probeServerInstall } from './visitorBootstrap';

const ORIGIN = 'http://localhost:18083';
const STATUS_URL = `${ORIGIN}/api/v1/setup/status`;
const CUSTOMIZATION_URL = `${ORIGIN}/api/v1/sites/site_visitor/customization`;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

interface FetchPlan {
  status?: unknown;
  statusHttpStatus?: number;
  customization?: unknown;
  customizationStatus?: number;
  /** 让设计请求直接抛网络错误。 */
  customizationNetworkError?: boolean;
  /** 让探测请求直接抛网络错误。 */
  statusNetworkError?: boolean;
}

function stubFetch(plan: FetchPlan): { fetchImpl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    urls.push(url);
    if (url === STATUS_URL) {
      if (plan.statusNetworkError) throw new TypeError('network down');
      const body = plan.status ?? { installed: true, has_admin: true, site_id: 'site_visitor' };
      return jsonResponse(body, plan.statusHttpStatus ?? 200);
    }
    if (url === CUSTOMIZATION_URL) {
      if (plan.customizationNetworkError) throw new TypeError('network down');
      if (plan.customizationStatus && plan.customizationStatus !== 200) {
        return jsonResponse({ code: 'not_found', status: plan.customizationStatus }, plan.customizationStatus);
      }
      return jsonResponse(
        plan.customization ?? {
          site_id: 'site_visitor',
          revision: 3,
          updated_at: '2026-11-02T04:40:00Z',
          customization: { theme: { preset: 'night' }, custom_css: '.hero{color:#fff}' },
        },
      );
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return { fetchImpl, urls };
}

describe('probeServerInstall', () => {
  it('returns the public setup status', async () => {
    const { fetchImpl, urls } = stubFetch({ status: { installed: true, has_admin: true } });

    await expect(probeServerInstall({ origin: ORIGIN, fetchImpl })).resolves.toEqual({
      installed: true,
      has_admin: true,
    });
    expect(urls).toEqual([STATUS_URL]);
  });

  it('returns null on HTTP errors and network failures', async () => {
    await expect(
      probeServerInstall({ origin: ORIGIN, fetchImpl: stubFetch({ statusHttpStatus: 503 }).fetchImpl }),
    ).resolves.toBeNull();
    await expect(
      probeServerInstall({ origin: ORIGIN, fetchImpl: stubFetch({ statusNetworkError: true }).fetchImpl }),
    ).resolves.toBeNull();
  });
});

describe('bootstrapVisitorConfig', () => {
  it('builds a read-only live config when the site is installed and has an admin', async () => {
    const { fetchImpl, urls } = stubFetch({
      status: { installed: true, has_admin: true, site_id: 'site_visitor', site_name: '侧耳倾听' },
    });

    const boot = await bootstrapVisitorConfig({ origin: ORIGIN, fetchImpl });

    expect(boot).not.toBeNull();
    expect(boot?.customization).toBe('applied');
    expect(boot?.config).toMatchObject({
      version: 1,
      setup_complete: true,
      mode: 'live',
      api_base: ORIGIN,
      site_id: 'site_visitor',
      visitor: true,
      visitor_site_name: '侧耳倾听',
    });
    // 设计在渲染前就已经拉取并归一化完成。
    expect(boot?.config.customization?.theme.preset).toBe('night');
    // 探测 → 设计，顺序与地址都正确。
    expect(urls).toEqual([STATUS_URL, CUSTOMIZATION_URL]);
    // 绝不能把访客状态写成"已安装"：那是站长浏览器的安装配置。
    expect(localStorage.getItem('pp.web.config.v1')).toBeNull();
  });

  it('returns null while the server is not installed, so the wizard still opens', async () => {
    const { fetchImpl, urls } = stubFetch({
      status: { installed: false, has_admin: false },
    });

    await expect(bootstrapVisitorConfig({ origin: ORIGIN, fetchImpl })).resolves.toBeNull();
    expect(urls, '未安装时不需要再多拉一次设计').toEqual([STATUS_URL]);
  });

  it('returns null when the site has no administrator yet', async () => {
    const { fetchImpl } = stubFetch({
      status: { installed: true, has_admin: false, site_id: 'site_visitor' },
    });

    await expect(bootstrapVisitorConfig({ origin: ORIGIN, fetchImpl })).resolves.toBeNull();
  });

  it('returns null when the status omits the site id', async () => {
    const { fetchImpl } = stubFetch({ status: { installed: true, has_admin: true } });

    await expect(bootstrapVisitorConfig({ origin: ORIGIN, fetchImpl })).resolves.toBeNull();
  });

  it('falls back to the default design when the design was never saved (or is members-only)', async () => {
    const { fetchImpl } = stubFetch({
      status: { installed: true, has_admin: true, site_id: 'site_visitor' },
      customizationStatus: 404,
    });

    const boot = await bootstrapVisitorConfig({ origin: ORIGIN, fetchImpl });

    expect(boot?.customization).toBe('absent');
    // 没有设计字段时读取路径会落到 DEFAULT_CUSTOMIZATION，不会卡在加载态。
    expect(boot?.config.customization).toBeUndefined();
  });

  it('still renders the site when the design request fails', async () => {
    const { fetchImpl } = stubFetch({
      status: { installed: true, has_admin: true, site_id: 'site_visitor' },
      customizationNetworkError: true,
    });

    const boot = await bootstrapVisitorConfig({ origin: ORIGIN, fetchImpl });

    expect(boot).not.toBeNull();
    expect(boot?.customization).toBe('unavailable');
  });

  it('normalises the fetched design with the same rules as local configuration', async () => {
    const { fetchImpl } = stubFetch({
      status: { installed: true, has_admin: true, site_id: 'site_visitor' },
      customization: {
        customization: {
          custom_css: 'html{outline:2px solid red}\n@import url("https://evil.example/x.css");',
          theme: { preset: 'night', tokens: { background: 'javascript:alert(1)' } },
        },
      },
    });

    const boot = await bootstrapVisitorConfig({ origin: ORIGIN, fetchImpl });

    expect(boot?.config.customization?.custom_css).toContain('outline:2px solid red');
    expect(boot?.config.customization?.custom_css).not.toContain('@import');
    expect(boot?.config.customization?.theme.tokens?.background ?? '').not.toContain('javascript');
  });

  it('carries the registration switch from setup/status so visitors see no sign-up entry when closed', async () => {
    const closed = stubFetch({
      status: {
        installed: true,
        has_admin: true,
        site_id: 'site_visitor',
        registration_open: false,
      },
    });
    const closedBoot = await bootstrapVisitorConfig({ origin: ORIGIN, fetchImpl: closed.fetchImpl });
    expect(closedBoot?.config.visitor_registration_open).toBe(false);

    const open = stubFetch({
      status: {
        installed: true,
        has_admin: true,
        site_id: 'site_visitor',
        registration_open: true,
      },
    });
    const openBoot = await bootstrapVisitorConfig({ origin: ORIGIN, fetchImpl: open.fetchImpl });
    expect(openBoot?.config.visitor_registration_open).toBe(true);

    // 旧后端不返回该字段：配置里也不写，读取时按「开放」处理。
    const legacy = stubFetch({ status: { installed: true, has_admin: true, site_id: 'site_visitor' } });
    const legacyBoot = await bootstrapVisitorConfig({ origin: ORIGIN, fetchImpl: legacy.fetchImpl });
    expect(legacyBoot?.config.visitor_registration_open).toBeUndefined();
  });
});
