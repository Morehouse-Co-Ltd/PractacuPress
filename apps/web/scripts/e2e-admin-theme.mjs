/**
 * 后台明暗模式冒烟测试（Playwright，复用仓库已有的 @playwright/test）。
 *
 * 前提：apps/web 开发服务器在运行。默认 http://127.0.0.1:5199。
 * 运行：node scripts/e2e-admin-theme.mjs
 *
 * 覆盖：
 * 1. 后台默认亮色，顶栏有「亮色 / 暗色」两个明确入口；
 * 2. 切换到暗色后外壳、侧栏、卡片真的变暗（取计算样式）；
 * 3. 刷新后保持，localStorage 写的是后台自己的键；
 * 4. Shift+D 在后台也能切换；
 * 5. 回到站点前台，主题外观不受后台偏好影响。
 */
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const BASE = process.env.PP_E2E_BASE ?? 'http://127.0.0.1:5199';
const OUT = fileURLToPath(new URL('../../../.tmp/admin-theme/', import.meta.url));
mkdirSync(OUT, { recursive: true });

const CONFIG = {
  version: 1,
  setup_complete: true,
  mode: 'demo',
  api_base: '',
  site_id: 'demo-site',
  database: 'sqlite',
  created_at: new Date().toISOString(),
  docs_url: '/admin/docs',
  site_kind: 'community',
  customization: {
    theme: {
      preset: 'paper',
      mode: 'light',
      background: '#ffffff',
      ink: '#14140f',
      accent: '#1f5c4a',
      heading_font: 'serif',
      body_size: 17.5,
      content_width: 720,
      radius: 6,
    },
    layout: {
      variant: 'classic',
      header_style: 'classic',
      show_search: true,
      show_articles: true,
      show_posts: true,
      brand_sub: 'Independent publishing',
    },
    active_theme: 'default',
  },
};

const checks = [];
function check(name, ok, detail = '') {
  checks.push({ name, ok, detail });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
}

function rgb(value) {
  return String(value).replace(/\s+/g, ' ');
}

async function inspect(page) {
  return page.evaluate(() => {
    const style = (selector) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const css = getComputedStyle(el);
      return {
        background: css.backgroundColor,
        color: css.color,
        border: css.borderTopColor,
      };
    };
    return {
      surface: document.documentElement.dataset.surface ?? '',
      adminTheme: document.documentElement.dataset.adminTheme ?? '',
      siteMode: document.documentElement.dataset.mode ?? '',
      colorScheme: document.documentElement.style.colorScheme,
      body: {
        background: getComputedStyle(document.body).backgroundColor,
        color: getComputedStyle(document.body).color,
      },
      shell: style('.admin-shell'),
      side: style('.admin-side'),
      topbar: style('.admin-topbar'),
      panel: style('.admin-shell .panel'),
      switchCount: document.querySelectorAll('.admin-theme-switch button').length,
      switchLabels: [...document.querySelectorAll('.admin-theme-switch button')].map((node) =>
        (node.textContent ?? '').trim(),
      ),
      stored: localStorage.getItem('pp.admin.theme'),
      cookie: document.cookie,
    };
  });
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
});
await context.addInitScript(
  ({ config }) => {
    if (!localStorage.getItem('pp.web.config.v1')) {
      localStorage.setItem('pp.web.config.v1', JSON.stringify(config));
    }
    if (!localStorage.getItem('pp.demo.current.v1')) {
      localStorage.setItem('pp.demo.current.v1', 'usr_admin');
    }
  },
  { config: CONFIG },
);

try {
  const page = await context.newPage();
  await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.admin-shell', { timeout: 30_000 });
  await page.waitForTimeout(600);

  const light = await inspect(page);
  check('后台外壳出现', !!light.shell, JSON.stringify(light.shell));
  check(
    '默认亮色：data-surface=admin，data-admin-theme=light',
    light.surface === 'admin' && light.adminTheme === 'light',
    `surface=${light.surface} theme=${light.adminTheme}`,
  );
  check('顶栏有亮色/暗色两个入口', light.switchCount === 2, JSON.stringify(light.switchLabels));
  check(
    '亮色下外壳与侧栏是浅色',
    rgb(light.shell?.background) === 'rgb(255, 255, 255)' &&
      rgb(light.side?.background) === 'rgb(255, 255, 255)',
    `shell=${light.shell?.background} side=${light.side?.background}`,
  );
  check('亮色下正文是深色字', rgb(light.body.color) === 'rgb(20, 20, 15)', light.body.color);
  await page.screenshot({ path: `${OUT}admin-light.png` });

  await page.getByRole('button', { name: '暗色模式', exact: true }).click();
  await page.waitForTimeout(400);
  const dark = await inspect(page);
  check('点击暗色入口后 data-admin-theme=dark', dark.adminTheme === 'dark', dark.adminTheme);
  check('顶栏按钮状态同步为暗色', dark.stored === 'dark', dark.stored ?? 'null');
  check(
    '外壳与侧栏真的变暗',
    rgb(dark.shell?.background) === 'rgb(11, 13, 17)' &&
      rgb(dark.side?.background) === 'rgb(18, 21, 27)',
    `shell=${dark.shell?.background} side=${dark.side?.background}`,
  );
  check(
    '正文与顶栏跟随暗色令牌',
    rgb(dark.body.background) === 'rgb(11, 13, 17)' && rgb(dark.body.color) === 'rgb(242, 244, 248)',
    `body=${dark.body.background} ${dark.body.color}`,
  );
  check('原生控件 color-scheme 跟随后台', dark.colorScheme === 'dark', dark.colorScheme);
  await page.screenshot({ path: `${OUT}admin-dark.png` });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.admin-shell', { timeout: 30_000 });
  await page.waitForTimeout(600);
  const reloaded = await inspect(page);
  check(
    '刷新后仍保持暗色',
    reloaded.adminTheme === 'dark' && rgb(reloaded.body.background) === 'rgb(11, 13, 17)',
    `theme=${reloaded.adminTheme} body=${reloaded.body.background}`,
  );

  // 站内路由离开后台时，也要把 data-surface / data-admin-theme 摘掉。
  await page.click('.admin-side-foot a[href="/"]');
  await page.waitForSelector('.site-header', { timeout: 30_000 });
  await page.waitForTimeout(500);
  const spaSite = await page.evaluate(() => ({
    surface: document.documentElement.dataset.surface ?? '',
    adminTheme: document.documentElement.dataset.adminTheme ?? '',
  }));
  check(
    '站内跳回前台时后台属性已撤销',
    spaSite.surface === 'site' && spaSite.adminTheme === '',
    `surface=${spaSite.surface} adminTheme=${spaSite.adminTheme}`,
  );

  // 后台的其他页面（侧栏、二级导航、卡片）也要变暗。
  await page.goto(`${BASE}/admin/settings`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.admin-shell', { timeout: 30_000 });
  await page.waitForTimeout(600);
  const settings = await inspect(page);
  check(
    '设置页卡片是深色面板',
    settings.adminTheme === 'dark' && rgb(settings.panel?.background) === 'rgb(18, 21, 27)',
    `panel=${settings.panel?.background}`,
  );
  await page.screenshot({ path: `${OUT}admin-dark-settings.png` });

  // Shift+D：后台不在 CommandLayer 里，确认单独挂的快捷键可用。
  await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.admin-shell', { timeout: 30_000 });
  await page.waitForTimeout(500);
  await page.keyboard.press('Shift+D');
  await page.waitForTimeout(400);
  const toggled = await inspect(page);
  check('Shift+D 在后台切换到亮色', toggled.adminTheme === 'light', toggled.adminTheme);

  // 前台不受后台偏好影响：后台切回暗色，再回站点看。
  await page.getByRole('button', { name: '暗色模式', exact: true }).click();
  await page.waitForTimeout(300);
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.site-header', { timeout: 30_000 });
  await page.waitForTimeout(800);
  const site = await page.evaluate(() => ({
    surface: document.documentElement.dataset.surface ?? '',
    adminTheme: document.documentElement.dataset.adminTheme ?? '',
    mode: document.documentElement.dataset.mode ?? '',
    body: getComputedStyle(document.body).backgroundColor,
    color: getComputedStyle(document.body).color,
    cookie: document.cookie,
  }));
  check(
    '回到前台后后台属性已撤销',
    site.surface !== 'admin' && site.adminTheme === '',
    `surface=${site.surface} adminTheme=${site.adminTheme}`,
  );
  check(
    '前台仍是站点自己的浅色主题',
    rgb(site.body) === 'rgb(255, 255, 255)' && site.mode === 'light',
    `body=${site.body} mode=${site.mode}`,
  );
  check('后台切换没有写前台的 pp_theme Cookie', !site.cookie.includes('pp_theme=dark'), site.cookie);
  await page.screenshot({ path: `${OUT}site-light-after-admin-dark.png` });

  // 反过来：站点前台是深色主题 / 访客选了深色，后台默认仍应是亮色。
  await page.evaluate(() => {
    const config = JSON.parse(localStorage.getItem('pp.web.config.v1'));
    config.customization.theme = {
      ...config.customization.theme,
      preset: 'night',
      mode: 'dark',
      background: '#0b0d11',
      ink: '#f2f4f8',
      accent: '#6e9bff',
    };
    config.customization.active_theme = 'night';
    config.customization.layout.variant = 'bento';
    localStorage.setItem('pp.web.config.v1', JSON.stringify(config));
    localStorage.removeItem('pp.admin.theme');
    document.cookie = 'pp_theme=dark; Path=/; Max-Age=3600';
  });
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.site-header', { timeout: 30_000 });
  await page.waitForTimeout(700);
  const darkSite = await page.evaluate(() => ({
    body: getComputedStyle(document.body).backgroundColor,
    mode: document.documentElement.dataset.mode ?? '',
  }));
  check(
    '前台深色主题确实变暗（测试前提）',
    rgb(darkSite.body) === 'rgb(11, 13, 17)' && darkSite.mode === 'dark',
    `body=${darkSite.body} mode=${darkSite.mode}`,
  );

  await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.admin-shell', { timeout: 30_000 });
  await page.waitForTimeout(600);
  const adminOnDarkSite = await inspect(page);
  check(
    '前台深色时后台默认仍是亮色',
    adminOnDarkSite.adminTheme === 'light' && rgb(adminOnDarkSite.body.background) === 'rgb(255, 255, 255)',
    `theme=${adminOnDarkSite.adminTheme} body=${adminOnDarkSite.body.background}`,
  );
  check(
    '前台深色没有把后台 color-scheme 带跑',
    adminOnDarkSite.colorScheme === 'light',
    adminOnDarkSite.colorScheme,
  );

  await page.getByRole('button', { name: '暗色模式', exact: true }).click();
  await page.waitForTimeout(300);
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.site-header', { timeout: 30_000 });
  await page.waitForTimeout(600);
  const darkSiteAfterAdmin = await page.evaluate(() => ({
    body: getComputedStyle(document.body).backgroundColor,
    adminTheme: document.documentElement.dataset.adminTheme ?? '',
  }));
  check(
    '后台切深色后前台仍是它自己的深色主题',
    rgb(darkSiteAfterAdmin.body) === 'rgb(11, 13, 17)' && darkSiteAfterAdmin.adminTheme === '',
    `body=${darkSiteAfterAdmin.body} adminTheme=${darkSiteAfterAdmin.adminTheme}`,
  );

  // 回归：从深色站点点进后台。站内导航会在同一轮提交里卸载站点外壳，外壳的被动
  // effect 清理不能把后台刚写上的 data-surface 删掉——删掉就会掉回站点深色令牌，
  // 表现为白底浅字、搜索框与空状态整块变黑（后台显示错乱的主因）。
  // 先把后台偏好重置成亮色，避免沿用上一节点过的暗色。
  await page.evaluate(() => localStorage.setItem('pp.admin.theme', 'light'));
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.site-header', { timeout: 30_000 });
  await page.waitForTimeout(700);
  const adminLink = await page.$('a[href^="/admin"]');
  if (adminLink) {
    await adminLink.click();
    await page.waitForSelector('.admin-shell', { timeout: 30_000 });
    await page.waitForTimeout(700);
    const fromDarkSite = await page.evaluate(() => {
      const heading =
        document.querySelector('.admin-page-head h1') ?? document.querySelector('.admin-topbar h1');
      return {
        surface: document.documentElement.dataset.surface ?? '',
        adminTheme: document.documentElement.dataset.adminTheme ?? '',
        headingColor: heading ? getComputedStyle(heading).color : '',
      };
    });
    check(
      '从深色前台站内跳进后台：data-surface 仍是 admin',
      fromDarkSite.surface === 'admin',
      `surface=${fromDarkSite.surface}`,
    );
    check(
      '从深色前台站内跳进后台：后台仍是亮色，标题是深色字',
      fromDarkSite.adminTheme === 'light' && rgb(fromDarkSite.headingColor) === 'rgb(20, 20, 15)',
      `theme=${fromDarkSite.adminTheme} heading=${fromDarkSite.headingColor}`,
    );
  } else {
    check('从深色前台站内跳进后台：找到后台入口', false, '页面上没有 /admin 链接');
  }

  // 个人博客没有审核队列：侧栏不出现入口，直接访问地址回到内容库。
  await page.evaluate(() => {
    const config = JSON.parse(localStorage.getItem('pp.web.config.v1'));
    config.site_kind = 'personal';
    localStorage.setItem('pp.web.config.v1', JSON.stringify(config));
    localStorage.setItem('pp.admin.theme', 'light');
  });
  await page.goto(`${BASE}/admin/content`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.admin-shell', { timeout: 30_000 });
  await page.waitForTimeout(700);
  const personalNav = await page.evaluate(() =>
    [...document.querySelectorAll('.admin-nav-link')].map((node) => (node.textContent ?? '').trim()),
  );
  check(
    '个人博客侧栏没有审核队列（合并进信息安全）',
    !personalNav.some((label) => label.startsWith('审核队列')) &&
      !personalNav.some((label) => label.startsWith('举报队列')),
    personalNav.join('|'),
  );
  await page.goto(`${BASE}/admin/review`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.admin-shell', { timeout: 30_000 });
  await page.waitForTimeout(700);
  check(
    '个人博客访问 /admin/review 落到信息安全（审核 tab 不出现）',
    new URL(page.url()).pathname === '/admin/security',
    page.url(),
  );

  const failed = checks.filter((entry) => !entry.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  console.log(`screenshots: ${OUT}`);
  if (failed.length) process.exitCode = 1;
} finally {
  await browser.close();
}
