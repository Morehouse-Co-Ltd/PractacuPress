import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ADMIN_FEATURE_INDEX } from './adminFeatureIndex';
import { setLocale, t } from './i18n';

const CJK = /[\u3400-\u9fff]/;

/**
 * 后台路由覆盖检查。
 *
 * 搜索索引是手工维护的，最怕“新加了一个后台页面但忘了加索引”。这里直接读 App.tsx
 * 的 /admin 子路由，要求每个静态路由要么在 ADMIN_FEATURE_INDEX 里有条目，要么在
 * 下面的白名单里（详情页、别名、纯重定向）。新增页面时忘了加索引，测试会直接报出
 * 缺哪条路由，而不是等用户搜不到才发现。
 *
 * 路径按 vitest 的工作目录解析：`npm test` 在 web/ 下运行；从仓库根跑时回退到
 * `web/src/App.tsx`。
 */
const APP_PATH = [
  resolve(process.cwd(), 'src/App.tsx'),
  resolve(process.cwd(), 'web/src/App.tsx'),
].find((candidate) => existsSync(candidate));
const APP_SOURCE = APP_PATH ? readFileSync(APP_PATH, 'utf8') : '';

/** 这些路由不需要索引条目：重定向、同一页面的别名、或只能从列表进入的详情页。 */
const ROUTE_ALLOWLIST = new Set([
  '/admin/system', // 重定向到扩展页
  '/admin/review',
  '/admin/comments',
  '/admin/reports',
  '/admin/appearance',
  '/admin/domains',
  '/admin/insights', // 访问洞察并入仪表盘“访问记录”后只剩重定向
  '/admin/members', // 与 /admin/users 同一页
]);

function staticAdminChildRoutes(): string[] {
  const start = APP_SOURCE.indexOf('path="/admin"');
  expect(start, 'App.tsx 里找不到 /admin 路由').toBeGreaterThanOrEqual(0);
  const end = APP_SOURCE.indexOf('</Routes>', start);
  const block = APP_SOURCE.slice(start, end);
  const paths = [...block.matchAll(/<Route\s+path="([^"]+)"/g)].map((match) => match[1]);
  return paths
    .filter((path) => !path.startsWith('/') && !path.includes(':') && !path.includes('*'))
    .map((path) => `/admin/${path}`);
}

afterEach(() => {
  setLocale('zh-CN');
});

describe('后台功能索引', () => {
  it('id 唯一，路由都在后台命名空间下', () => {
    const ids = ADMIN_FEATURE_INDEX.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);

    const badRoutes = ADMIN_FEATURE_INDEX.filter((entry) => !entry.to.startsWith('/admin')).map(
      (entry) => entry.to,
    );
    expect(badRoutes).toEqual([]);
  });

  it('每条功能都有英文翻译（英文界面下不能回退中文）', () => {
    setLocale('en');
    const missing = ADMIN_FEATURE_INDEX.filter(
      (entry) => CJK.test(entry.label) && t(entry.label) === entry.label,
    ).map((entry) => entry.label);
    expect([...new Set(missing)]).toEqual([]);
  });

  it('英文标签里不含中文，占位符与原文一致', () => {
    setLocale('en');
    const dirty = ADMIN_FEATURE_INDEX.filter((entry) => {
      const translated = t(entry.label);
      return CJK.test(translated);
    }).map((entry) => entry.label);
    expect([...new Set(dirty)]).toEqual([]);
  });

  it('覆盖后台的每一类细节功能（抽样断言关键入口）', () => {
    const labels = new Set(ADMIN_FEATURE_INDEX.map((entry) => entry.label));
    for (const expected of [
      '回收站',
      '能力矩阵',
      'sitemap.xml',
      'robots.txt',
      'CORS 来源',
      'S3 兼容存储',
      '整库备份',
      '第三方登录',
      '订阅者',
      '操作日志',
      '平台总览',
    ]) {
      expect(labels.has(expected), expected).toBe(true);
    }
  });

  it('每个后台静态路由都有索引条目，新增页面不会漏搜', () => {
    const routes = staticAdminChildRoutes();
    // 防呆：正则失效时不能让这条测试空转通过。
    expect(routes.length).toBeGreaterThan(20);
    expect(routes).toContain('/admin/content');
    expect(routes).toContain('/admin/settings');

    const indexed = new Set(ADMIN_FEATURE_INDEX.map((entry) => entry.to.split('?')[0]));
    const missing = routes.filter(
      (route) => !indexed.has(route) && !ROUTE_ALLOWLIST.has(route),
    );
    expect(
      missing,
      '新增后台页面时请在 ADMIN_FEATURE_INDEX 补一条索引；纯重定向/别名页可加入 ROUTE_ALLOWLIST 并写明原因',
    ).toEqual([]);
  });
});
