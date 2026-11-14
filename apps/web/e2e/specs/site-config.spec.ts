import { expect, test, ADMIN } from '../fixtures';

const BASE_URL = process.env.PP_E2E_BASE || 'http://127.0.0.1:18100';

/**
 * 站点级配置（访问限制 / 域名 / 性能 / 加载动画 / 登录方式 / 后台入口）必须存在服务端，
 * 换一台设备、换一个浏览器（不同的 localStorage 与会话）也要拿到同一份配置。
 *
 * 覆盖两件过去做不到的事：
 * 1. 自定义后台入口真的生效：保存 `/manage` 之后地址栏跟着改，`/admin` 再也进不去后台；
 * 2. 匿名访客（另一个浏览器上下文、localStorage 为空）读到的是站长保存的设置，
 *    而不是内置默认值。
 *
 * 两个上下文都由本用例自己创建：world 里的上下文可能带着别的用例的登录态，
 * 而这里要的正是「另一台设备」。
 */

/** 站长浏览器里的安装配置，形状与安装向导写入的一致。 */
function liveConfig(siteId: string) {
  return {
    version: 1,
    setup_complete: true,
    mode: 'live',
    api_base: '',
    site_id: siteId,
    database: 'sqlite',
    created_at: new Date().toISOString(),
    docs_url: `${BASE_URL}/api/v1/docs`,
  };
}

interface SetupStatus {
  installed?: boolean;
  has_admin?: boolean;
  site_id?: string;
}

test('站点级配置：后台入口真实生效，换设备的访客拿到服务端配置', async ({ world }) => {
  const probe = await world.admin.page.request.get(`${BASE_URL}/api/v1/setup/status`);
  const status = (await probe.json()) as SetupStatus;
  test.skip(!status.installed || !status.has_admin, '站点尚未完成安装，跳过站点配置检查');
  const siteId = status.site_id || '';
  expect(siteId.length).toBeGreaterThan(0);

  const adminContext = await world.browser.newContext({
    baseURL: BASE_URL,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1440, height: 1000 },
  });
  const visitorContext = await world.browser.newContext({
    baseURL: BASE_URL,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1440, height: 1000 },
  });

  try {
    // 站长自己的浏览器：有安装配置、登录过。配置只在第一次落盘，之后沿用应用自己
    // 保存的版本（真实浏览器就是这样）。
    await adminContext.addInitScript((config) => {
      if (!localStorage.getItem('pp.web.config.v1')) {
        localStorage.setItem('pp.web.config.v1', JSON.stringify(config));
      }
    }, liveConfig(siteId));

    const page = await adminContext.newPage();
    await page.goto('/login');
    await expect(page.locator('#auth-email')).toBeVisible({ timeout: 30_000 });
    await page.locator('#auth-email').fill(ADMIN.email);
    await page.locator('#auth-password').fill(ADMIN.password);
    await page.locator('.auth-form').getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });

    // 这个站点还没有保存过站点配置：登录后会话恢复会再拉一次，管理员本机已有的设置
    // 会被整体搬到服务端（否则访客永远只会读到内置默认值）。匿名 GET 从 404 变成
    // 200 就是搬迁发生的证据。
    await expect
      .poll(
        async () =>
          (await page.request.get(`${BASE_URL}/api/v1/sites/${siteId}/site-config`)).status(),
        { timeout: 20_000 },
      )
      .toBe(200);

    /* ---------- 1. 后台入口：保存 /manage 之后 /admin 进不去 ---------- */
    await page.goto('/admin/settings');
    await expect(page.getByRole('heading', { name: '站点设置' }).first()).toBeVisible({
      timeout: 30_000,
    });

    await page.locator('#setting-admin-path').fill('/manage');
    // 站点设置改成自动保存：停止输入后写入服务端，成功时状态条变成「已自动保存」。
    await expect(page.locator('.autosave-status')).toContainText('已自动保存', {
      timeout: 30_000,
    });
    // 保存成功后地址栏立刻改到新入口，站长不会被踢出后台。
    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 20_000 })
      .toBe('/manage/settings');
    await expect(page.getByRole('heading', { name: '站点设置' }).first()).toBeVisible();

    // 直接打开旧入口：不再是后台（落到站点自己的 404）。
    await page.goto('/admin');
    await expect(page.locator('.eyebrow').filter({ hasText: '404' }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator('.admin-shell')).toHaveCount(0);

    // 配置入口照常进后台。
    await page.goto('/manage');
    await expect(page.locator('.admin-shell')).toBeVisible({ timeout: 30_000 });

    /* ---------- 2. 匿名访客：另一个 localStorage，读到的是服务端配置 ---------- */
    const visitorPage = await visitorContext.newPage();
    await visitorPage.goto('/');
    await expect(visitorPage.locator('.site').first()).toBeVisible({ timeout: 30_000 });
    // 这个浏览器从来没有保存过安装配置：它看到的只能是服务端下发的公开子集。
    expect(await visitorPage.evaluate(() => localStorage.getItem('pp.web.config.v1'))).toBeNull();

    const publicConfig = await visitorPage.request.get(
      `${BASE_URL}/api/v1/sites/${siteId}/site-config`,
    );
    expect(publicConfig.status()).toBe(200);
    const publicBody = (await publicConfig.json()) as {
      scope?: string;
      config?: { admin_path?: string; domains?: { tls?: unknown } };
    };
    expect(publicBody.scope).toBe('public');
    expect(publicBody.config?.admin_path).toBe('/manage');
    expect(publicBody.config?.domains?.tls).toBeUndefined();

    // 站长改一条只影响浏览器的设置：域名白名单。访客刷新后立刻受影响。
    // API 用 Bearer 认证（cookie 只承载 refresh），所以先从页面拿 CSRF、换一枚 access token。
    const csrf = await page.evaluate(() => {
      const match = document.cookie.match(/(?:^|;\s*)pp_csrf=([^;]+)/);
      return match ? decodeURIComponent(match[1]) : '';
    });
    expect(csrf.length).toBeGreaterThan(0);
    const sessionResponse = await page.request.post(
      `${BASE_URL}/api/v1/auth/token/refresh`,
      { headers: { 'X-CSRF-Token': csrf } },
    );
    expect(sessionResponse.status()).toBe(200);
    const session = (await sessionResponse.json()) as { access_token?: string };
    const authHeaders = { Authorization: `Bearer ${session.access_token ?? ''}` };

    const adminConfigResponse = await page.request.get(
      `${BASE_URL}/api/v1/sites/${siteId}/site-config`,
      { headers: authHeaders },
    );
    const adminConfig = (await adminConfigResponse.json()) as {
      revision: number;
      scope: string;
      config: Record<string, unknown>;
    };
    expect(adminConfig.scope).toBe('admin');
    const put = await page.request.put(`${BASE_URL}/api/v1/sites/${siteId}/site-config`, {
      headers: authHeaders,
      data: {
        config: {
          ...adminConfig.config,
          domains: {
            enabled: true,
            primary: 'example.com',
            aliases: [],
            allow_www: false,
            allow_localhost: false,
            allow_ip: false,
          },
        },
        revision: adminConfig.revision,
      },
    });
    expect(put.status()).toBe(200);

    await visitorPage.reload();
    await expect(visitorPage.locator('.domain-block-screen')).toBeVisible({ timeout: 30_000 });
    await expect(visitorPage.getByText('这个域名还没有绑定到本站').first()).toBeVisible();
    // 站长自己不受白名单影响：后台入口永远豁免。
    await page.goto('/manage/access');
    await expect(page.locator('.domain-block-screen')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '访问与域名' }).first()).toBeVisible({
      timeout: 30_000,
    });

    /* ---------- 3. 复原，别把后面的用例留在白名单里 ---------- */
    const current = (await (
      await page.request.get(`${BASE_URL}/api/v1/sites/${siteId}/site-config`, {
        headers: authHeaders,
      })
    ).json()) as { revision: number; config: Record<string, unknown> };
    const restored = await page.request.put(`${BASE_URL}/api/v1/sites/${siteId}/site-config`, {
      headers: authHeaders,
      data: {
        config: {
          ...current.config,
          admin_path: '/admin',
          domains: { ...(current.config.domains as Record<string, unknown>), enabled: false },
        },
        revision: current.revision,
      },
    });
    expect(restored.status()).toBe(200);

    await visitorPage.goto('/');
    await expect(visitorPage.locator('.domain-block-screen')).toHaveCount(0, { timeout: 30_000 });
    await expect(visitorPage.locator('.site').first()).toBeVisible({ timeout: 30_000 });
  } finally {
    await adminContext.close();
    await visitorContext.close();
  }
});
