import {
  expect,
  test,
  ensureReader,
  ensureAdminSession,
  shot,
  expectToast,
  ADMIN,
  READER,
  SITE_NAME,
  ARTICLE_TITLE,
} from '../fixtures';

const BASE_URL = process.env.PP_E2E_BASE || 'http://127.0.0.1:18100';

/**
 * 交付主路径冒烟。
 *
 * 这些用例共用一个 worker 上下文：安装是一次性的，后续用例都建立在“站点已装好、
 * 管理员已登录”的状态上。状态缺失时用 test.skip 明确跳过，而不是抛出一串误导性的
 * 次生失败；站点文件与后台登录检查会自行恢复会话，减少对执行顺序的依赖。
 *
 * 覆盖：安装/登录 → 草稿/修订/发布 → 前台阅读/评论/举报 → 点赞收藏刷新保持 →
 * /me 个人中心 → sitemap/robots/openapi/docs → 后台设置持久化。
 */

test('1. 安装引导完成，管理员退出后可以重新登录', async ({ world }) => {
  const page = world.admin.page;

  // 真实环境安装：连接阶段自动探测同源 API，成功后进入数据库设置。
  await page.goto('/?mode=live');
  await expect(
    page.getByRole('heading', { name: '选一个装得下稿子的柜子。' }),
  ).toBeVisible({ timeout: 60_000 });
  await shot(world, page, '01-setup-database');

  await page.locator('.wiz-actions').getByRole('button', { name: '继续', exact: true }).click();

  await expect(page.locator('#admin-email')).toBeVisible({ timeout: 20_000 });
  await page.locator('#admin-name').fill(ADMIN.name);
  await page.locator('#admin-email').fill(ADMIN.email);
  await page.locator('#admin-pass').fill(ADMIN.password);
  await page.locator('#admin-confirm').fill(ADMIN.password);
  await shot(world, page, '02-setup-admin');

  // 「创建管理员」直接创建并自动进入下一步，不再需要额外的「并继续」按钮。
  await page
    .locator('.wiz-actions')
    .getByRole('button', { name: '创建管理员', exact: true })
    .click();

  // 创建管理员后的下一步是可选的高威胁操作保护（第 5 步），默认开启并可直接继续。
  await expect(page.getByRole('heading', { name: '给高危操作加一道门。' })).toBeVisible({
    timeout: 40_000,
  });
  await page.locator('.wiz-actions').getByRole('button', { name: '继续', exact: true }).click();
  await expect(page.locator('#site-name')).toBeVisible({ timeout: 40_000 });

  await page.locator('#site-name').fill(SITE_NAME);
  // 真实环境留空 = 单站点自动匹配本机地址；预填值可能来自旧草稿，显式清空。
  if ((await page.locator('#site-domain').inputValue()) !== '') {
    await page.locator('#site-domain').fill('');
  }
  await page.locator('.wiz-actions').getByRole('button', { name: '继续', exact: true }).click();

  // 第 7 步是前后台字号；默认值即可，直接继续到检查页。
  await expect(page.getByRole('heading', { name: '把字号调到看着舒服。' })).toBeVisible({
    timeout: 30_000,
  });
  await page.locator('.wiz-actions').getByRole('button', { name: '继续', exact: true }).click();

  await expect(page.getByRole('heading', { name: /在开门之前/ })).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.check-item').first()).toBeVisible({ timeout: 20_000 });
  const finish = page.locator('.wiz-actions').getByRole('button', { name: '完成安装', exact: true });
  await expect(finish).toBeEnabled({ timeout: 40_000 });
  await finish.click();

  await expect(page.locator('.wiz-finish h1')).toContainText(SITE_NAME, { timeout: 20_000 });
  await shot(world, page, '03-install-done');
  world.installed = true;

  await page.getByRole('link', { name: '进入管理后台' }).click();
  await page.waitForURL(/\/admin$/, { timeout: 30_000 });
  await expect(page.locator('.admin-shell')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.admin-page-head h1').first()).toBeVisible({
    timeout: 20_000,
  });
  await shot(world, page, '04-admin-dashboard');

  // 退出后从 /login 重新走一次真实登录，确认会话恢复不是安装流程的副作用。
  // 退出会同时触发 navigate('/') 和 RequireAuth 的登录跳转，落点取决于渲染顺序
  // （/ 或 /login?next=/admin），所以只等后台外壳消失，再显式打开登录页。
  await page.locator('.admin-side-foot').getByRole('button', { name: '退出登录' }).click();
  await expect(page.locator('.admin-shell')).toBeHidden({ timeout: 30_000 });
  await page.goto('/login');
  await expect(page.locator('#auth-email')).toBeVisible({ timeout: 20_000 });
  await page.locator('#auth-email').fill(ADMIN.email);
  await page.locator('#auth-password').fill(ADMIN.password);
  await page.locator('.auth-form').getByRole('button', { name: '登录', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });

  await page.goto('/admin');
  await expect(page.locator('.admin-shell')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.admin-page-head h1').first()).toBeVisible({
    timeout: 20_000,
  });
  await shot(world, page, '05-admin-relogin');
});

test('2. 新建草稿、保存修订并发布', async ({ world }) => {
  test.skip(!world.installed, '安装用例没有完成，跳过内容路径');

  const page = world.admin.page;
  await page.goto('/admin/content/new/article');
  await expect(page.locator('.editor-title-input')).toBeVisible({ timeout: 30_000 });
  await page.locator('.editor-title-input').fill(ARTICLE_TITLE);
  await page.locator('#editor-summary').fill('浏览器 E2E 冒烟：草稿、修订、发布、前台互动。');

  const body = page.locator('.rich-surface[role="textbox"]');
  await body.click();
  await body.fill('第一版正文：这是由浏览器 E2E 创建的草稿。\n\n它会在保存后进入版本历史。');
  await page
    .locator('.admin-page-actions')
    .getByRole('button', { name: '保存草稿', exact: true })
    .click();

  await page.waitForURL(/\/admin\/content\/article\/[0-9a-f-]+$/, { timeout: 30_000 });
  world.articleId = page.url().split('/').pop() || '';
  expect(world.articleId.length).toBeGreaterThan(10);
  await expectToast(page, '内容已保存');
  await expect(
    page.locator('.admin-page-head .badge').filter({ hasText: '草稿' }).first(),
  ).toBeVisible({ timeout: 20_000 });
  await shot(world, page, '06-editor-draft');

  // 第二次保存草稿：确认版本历史会追加，而不是覆盖成一份。
  await body.click();
  await body.fill('第二版正文：补上发布前的一次修订。\n\n版本历史里应能看到多次保存。');
  await page
    .locator('.admin-page-actions')
    .getByRole('button', { name: '保存草稿', exact: true })
    .click();
  await expectToast(page, '已保存');

  await page
    .locator('.admin-page-actions')
    .getByRole('button', { name: '发布', exact: true })
    .click();
  await expect(
    page.locator('.admin-page-head .badge').filter({ hasText: '已发布' }).first(),
  ).toBeVisible({ timeout: 40_000 });

  // 已发布内容再保存一次：按钮文案变为「保存修订」，状态必须保持已发布。
  const revise = page
    .locator('.admin-page-actions')
    .getByRole('button', { name: '保存修订', exact: true });
  await expect(revise).toBeVisible({ timeout: 20_000 });
  await body.click();
  await body.fill('第三版正文（发布后修订）：公开页面应显示这一版，版本历史保留前两版。');
  await revise.click();
  await expectToast(page, '已保存');
  await expect(
    page.locator('.admin-page-head .badge').filter({ hasText: '已发布' }).first(),
  ).toBeVisible();

  const historyRows = page
    .locator('.panel')
    .filter({ has: page.getByRole('heading', { name: '版本历史' }) })
    .locator('.mini-row');
  await expect
    .poll(async () => historyRows.count(), { timeout: 20_000 })
    .toBeGreaterThanOrEqual(3);
  await shot(world, page, '07-editor-published');
});

test('3. 读者注册后阅读、评论、举报并点赞收藏', async ({ world }) => {
  test.skip(!world.articleId, '内容用例没有产出文章，跳过读者路径');

  const reader = await ensureReader(world);
  const page = reader.page;

  await page.goto('/register');
  await expect(page.locator('#auth-name')).toBeVisible({ timeout: 30_000 });
  await page.locator('#auth-name').fill(READER.name);
  await page.locator('#auth-email').fill(READER.email);
  await page.locator('#auth-password').fill(READER.password);
  await page.locator('#auth-confirm').fill(READER.password);
  await page.locator('.auth-form').getByRole('button', { name: '创建账户', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.startsWith('/register'), { timeout: 30_000 });
  await expect(page.locator('.user-trigger')).toBeVisible({ timeout: 30_000 });

  await page.goto(`/a/${world.articleId}`);
  await expect(page.locator('h1').first()).toContainText(ARTICLE_TITLE, { timeout: 30_000 });
  await expect(page.locator('.article-body')).toContainText('第三版正文（发布后修订）', {
    timeout: 20_000,
  });
  await shot(world, page, '08-article-public');

  // 评论：默认站点不先审后发，发布后应立刻出现在讨论区。
  const commentBox = page.locator('.comment-form textarea').first();
  await expect(commentBox).toBeVisible({ timeout: 20_000 });
  await commentBox.fill('E2E 读者评论：排版清楚，感谢分享。');
  await page.getByRole('button', { name: '发表评论', exact: true }).click();
  await expectToast(page, '评论已发布');
  await expect(page.locator('.comment-body').filter({ hasText: 'E2E 读者评论' })).toBeVisible({
    timeout: 20_000,
  });

  // 举报入口：填写原因与说明并提交，管理员是文章作者，读者举报不会触发自举报限制。
  await page.getByRole('button', { name: '举报这篇内容' }).click();
  const reportDialog = page.getByRole('dialog', { name: '举报这篇内容' });
  await expect(reportDialog).toBeVisible();
  await expect(page.locator('#report-reason option')).toHaveCount(4);
  await shot(world, page, '09-report-dialog');
  await page.locator('#report-reason').selectOption('abuse');
  await page.locator('#report-note').fill('E2E 举报入口冒烟：验证原因与说明字段可提交。');
  await reportDialog.getByRole('button', { name: '提交举报', exact: true }).click();
  await expectToast(page, '举报已提交');

  // 点赞 / 收藏：先确认交互成功，再刷新页面确认状态从服务端恢复。
  const like = page.locator('.reaction-row').getByRole('button', { name: '点赞', exact: true });
  await like.click();
  await expect(
    page.locator('.reaction-row').getByRole('button', { name: '已点赞', exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  const bookmark = page.locator('.reaction-row').getByRole('button', { name: '收藏', exact: true });
  await bookmark.click();
  await expect(
    page.locator('.reaction-row').getByRole('button', { name: '已收藏', exact: true }),
  ).toBeVisible({ timeout: 20_000 });

  await page.reload();
  await expect(page.locator('.article-body')).toContainText('第三版正文（发布后修订）', {
    timeout: 30_000,
  });
  await expect(
    page.locator('.reaction-row').getByRole('button', { name: '已点赞', exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  await expect(
    page.locator('.reaction-row').getByRole('button', { name: '已收藏', exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  await shot(world, page, '10-interactions-persisted');
});

test('4. /me 个人中心列出收藏与点赞', async ({ world }) => {
  test.skip(!world.reader, '读者用例没有完成，跳过个人中心');

  const page = world.reader!.page;
  await page.goto('/me/bookmarks');
  await expect(page.getByRole('heading', { name: '我的互动' }).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.locator('.archive-item').filter({ hasText: ARTICLE_TITLE }).first(),
  ).toBeVisible({ timeout: 20_000 });
  await shot(world, page, '11-me-bookmarks');

  await page.goto('/me/likes');
  await expect(
    page.locator('.archive-item').filter({ hasText: ARTICLE_TITLE }).first(),
  ).toBeVisible({ timeout: 20_000 });
  await shot(world, page, '12-me-likes');
});

test('5. sitemap / robots / openapi / docs 可达', async ({ world }) => {
  const page = world.admin.page;

  const setup = (await (
    await page.request.get(`${BASE_URL}/api/v1/setup/status`)
  ).json()) as { installed?: boolean; has_admin?: boolean };
  test.skip(!setup.installed || !setup.has_admin, '站点尚未完成安装，跳过站点文件检查');

  // 该用例允许在 worker 重启后单独运行：文章 id 从公开列表补取。
  let articleId = world.articleId;
  if (!articleId) {
    const listResponse = await page.request.get(`${BASE_URL}/api/v1/articles?limit=50`);
    expect(listResponse.status()).toBe(200);
    const list = (await listResponse.json()) as {
      items?: { id?: string; title?: string }[];
    };
    articleId =
      list.items?.find((item) => item.title === ARTICLE_TITLE)?.id || list.items?.[0]?.id || '';
  }

  const sitemap = await page.request.get(`${BASE_URL}/sitemap.xml`);
  expect(sitemap.status()).toBe(200);
  expect(sitemap.headers()['content-type'] || '').toContain('xml');
  const sitemapBody = await sitemap.text();
  expect(sitemapBody).toContain('<urlset');
  // Permalinks use the article slug, not its database id; the article route from
  // the reader test already proves /a/<id> resolves to the slug canonical URL.
  if (articleId) expect(sitemapBody).toContain('/a/');

  const robots = await page.request.get(`${BASE_URL}/robots.txt`);
  expect(robots.status()).toBe(200);
  const robotsBody = await robots.text();
  expect(robotsBody).toContain('User-agent:');
  expect(robotsBody).toContain('Sitemap:');

  const openapi = await page.request.get(`${BASE_URL}/api/v1/openapi.json`);
  expect(openapi.status()).toBe(200);
  const document = (await openapi.json()) as { openapi?: string; paths?: Record<string, unknown> };
  expect(document.openapi).toBe('3.1.0');
  expect(Object.keys(document.paths || {}).length).toBeGreaterThan(50);

  const docs = await page.request.get(`${BASE_URL}/api/v1/docs`);
  expect(docs.status()).toBe(200);
  expect(docs.headers()['content-type'] || '').toContain('text/html');
  expect(await docs.text()).toContain('openapi');

  // 后台文档页需要登录；掉登录时自行恢复一次，避免依赖前一个用例的执行顺序。
  await ensureAdminSession(page);
  await page.goto('/admin/docs');
  await expect(page.getByRole('heading', { name: '调用接口' }).first()).toBeVisible({
    timeout: 30_000,
  });
  // 链接由 config.api_base 生成，可能是同源绝对地址，也可能是相对路径。
  await expect(page.locator('a[href$="/api/v1/openapi.json"]')).toBeVisible();
  await expect(page.getByText('sitemap.xml', { exact: false }).first()).toBeVisible();
  await shot(world, page, '13-docs-page');
});

test('6. 后台设置：储存多策略、性能效果卡、人机验证保存并持久化', async ({ world }) => {
  test.skip(!world.installed, '安装用例没有完成，跳过后台设置');

  const page = world.admin.page;

  /* ---------- 储存策略：新增第二套 + 文章媒体改为多策略 ---------- */
  await page.goto('/admin/storage');
  await expect(page.getByRole('heading', { name: '储存策略' }).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator('.storage-strategy')).toHaveCount(1);

  await page.getByRole('button', { name: '新建储存策略', exact: true }).click();
  const strategyDialog = page.getByRole('dialog', { name: '新建储存策略' });
  await expect(strategyDialog).toBeVisible();
  await strategyDialog.locator('#storage-strategy-name').fill('E2E 归档备份');
  await strategyDialog.getByRole('button', { name: '添加这套策略', exact: true }).click();
  await expect(page.locator('.storage-strategy').filter({ hasText: 'E2E 归档备份' })).toBeVisible();

  const contentScope = page
    .locator('.storage-scope')
    .filter({ has: page.locator('strong', { hasText: '文章媒体' }) })
    .first();
  await contentScope.locator('.storage-current').click();
  const allocationDialog = page.getByRole('dialog', { name: '「文章媒体」的储存策略' });
  await expect(allocationDialog).toBeVisible();
  await allocationDialog.getByRole('tab', { name: '多策略 · 容量切换' }).click();
  await allocationDialog.getByRole('button', { name: '添加一套策略', exact: true }).click();
  await expect(allocationDialog.locator('.storage-allocation-row')).toHaveCount(2);
  await allocationDialog.getByRole('button', { name: '完成', exact: true }).click();
  await expect(contentScope.locator('.storage-current')).toContainText('2 套策略');
  await shot(world, page, '14-storage-multi-before-save');

  // 储存策略改成自动保存：最后一次改动停止后，防抖写回本机配置。
  await page.waitForTimeout(1500);
  await expect(page.locator('.autosave-status')).toContainText('已自动保存', {
    timeout: 30_000,
  });

  await page.reload();
  await expect(page.getByRole('heading', { name: '储存策略' }).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator('.storage-strategy').filter({ hasText: 'E2E 归档备份' })).toBeVisible({
    timeout: 20_000,
  });
  const reloadedScope = page
    .locator('.storage-scope')
    .filter({ has: page.locator('strong', { hasText: '文章媒体' }) })
    .first();
  await expect(reloadedScope.locator('.badge').filter({ hasText: '多策略' })).toBeVisible();
  await expect(reloadedScope.locator('.storage-current')).toContainText('2 套策略');
  await reloadedScope.locator('.storage-current').click();
  const reloadedDialog = page.getByRole('dialog', { name: '「文章媒体」的储存策略' });
  await expect(reloadedDialog.locator('.storage-allocation-row')).toHaveCount(2);
  await reloadedDialog.getByRole('button', { name: '完成', exact: true }).click();
  await expect(reloadedDialog).toBeHidden();
  await shot(world, page, '15-storage-multi-persisted');

  /* ---------- 性能优化：效果卡渲染 + 修改后刷新保持 ---------- */
  await page.goto('/admin/performance');
  await expect(page.getByRole('heading', { name: '性能优化' }).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator('.effect-card')).toHaveCount(8);
  await expect(page.getByText('当前效果', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('首页读取', { exact: true }).first()).toBeVisible();
  await shot(world, page, '16-performance-effect-cards');

  await page.locator('#performance-feed').fill('12');
  // 性能设置改成自动保存：停止输入后写入服务端。
  await expect(page.locator('.autosave-status')).toContainText('已自动保存', {
    timeout: 30_000,
  });

  await page.reload();
  await expect(page.locator('#performance-feed')).toHaveValue('12', { timeout: 20_000 });
  await expect(page.locator('.effect-card-value').filter({ hasText: '12 条 × 2' })).toBeVisible({
    timeout: 20_000,
  });
  await shot(world, page, '17-performance-persisted');

  /* ---------- 人机验证：状态卡 + 开关/密钥保存后刷新保持 ---------- */
  await page.goto('/admin/verification');
  await expect(page.getByRole('heading', { name: '人机验证' }).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.locator('.effect-card')).toHaveCount(5);
  await expect(page.getByText('当前状态', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('服务商', { exact: true }).first()).toBeVisible();
  await shot(world, page, '18-verification-status-cards');

  const toggle = page.getByRole('switch', { name: '启用站点人机验证' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.locator('#verification-site-key').fill('e2e-site-key-2026');
  // 人机验证设置改成自动保存：停止输入后写入站点文档。
  await expect(page.locator('.autosave-status')).toContainText('已自动保存', {
    timeout: 30_000,
  });

  await page.reload();
  await expect(page.getByRole('heading', { name: '人机验证' }).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('switch', { name: '启用站点人机验证' })).toHaveAttribute(
    'aria-checked',
    'true',
    { timeout: 30_000 },
  );
  await expect(page.locator('#verification-site-key')).toHaveValue('e2e-site-key-2026', {
    timeout: 30_000,
  });
  await shot(world, page, '19-verification-persisted');
});
