import { expect, test as base, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const BASE_URL = process.env.PP_E2E_BASE || 'http://127.0.0.1:18100';
const ARTIFACTS = process.env.PP_E2E_ARTIFACTS
  ? path.resolve(process.env.PP_E2E_ARTIFACTS)
  : path.resolve(process.cwd(), '..', '..', '.tmp', 'e2e', 'artifacts');

export const ADMIN = {
  email: 'admin@practacu-e2e.example',
  name: 'E2E 站长',
  password: 'E2e-Password-2026',
};

export const READER = {
  email: 'reader@practacu-e2e.example',
  name: 'E2E 读者',
  password: 'Reader-Password-2026',
};

export const SITE_NAME = 'E2E 编辑部';
export const ARTICLE_TITLE = 'E2E 冒烟文章：交付主路径';

export interface Actor {
  context: BrowserContext;
  page: Page;
}

export interface World {
  browser: Browser;
  admin: Actor;
  reader?: Actor;
  installed: boolean;
  articleId: string;
  screensDir: string;
}

async function newActor(browser: Browser): Promise<Actor> {
  const context = await browser.newContext({
    baseURL: BASE_URL,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  return { context, page };
}

/** 懒创建读者上下文：安装与后台用例不需要它。 */
export async function ensureReader(world: World): Promise<Actor> {
  if (!world.reader) world.reader = await newActor(world.browser);
  return world.reader;
}

export async function shot(world: World, page: Page, name: string): Promise<void> {
  mkdirSync(world.screensDir, { recursive: true });
  await page.screenshot({
    path: path.join(world.screensDir, `${name}.png`),
    animations: 'disabled',
    fullPage: false,
  });
}

/** 等一条 toast；页面上可能同时存在旧 toast，取最后一个匹配项。 */
export async function expectToast(page: Page, text: string): Promise<void> {
  await expect(page.locator('.toast').filter({ hasText: text }).last()).toBeVisible({
    timeout: 20_000,
  });
}

/**
 * 直接访问后台时，如果当前上下文已经掉登录（或上一个用例失败后 worker 被重建），
 * 用管理员账户重新登录。只用于不依赖站长本地安装配置的检查（例如打开文档页）。
 */
export async function ensureAdminSession(page: Page): Promise<void> {
  await page.goto('/admin');
  await expect(page.locator('.admin-shell').or(page.locator('#auth-email')).first()).toBeVisible({
    timeout: 30_000,
  });
  if (await page.locator('#auth-email').isVisible()) {
    await page.locator('#auth-email').fill(ADMIN.email);
    await page.locator('#auth-password').fill(ADMIN.password);
    await page.locator('.auth-form').getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
    await page.goto('/admin');
  }
  await expect(page.locator('.admin-shell')).toBeVisible({ timeout: 30_000 });
}

export const test = base.extend<Record<string, never>, { world: World }>({
  world: [
    async ({ browser }, use) => {
      const admin = await newActor(browser);
      const world: World = {
        browser,
        admin,
        installed: false,
        articleId: '',
        screensDir: path.join(ARTIFACTS, 'screens'),
      };
      try {
        await use(world);
      } finally {
        await admin.context.close();
        if (world.reader) await world.reader.context.close();
      }
    },
    { scope: 'worker' },
  ],
});

export { expect };
