import { describe, expect, it } from 'vitest';
import type { WebConfig } from '../types';
import { DEFAULT_ACCESS } from './access';
import { DEFAULT_DOMAINS } from './domains';
import { DEFAULT_LOADING } from './loading';
import { DEFAULT_PERFORMANCE } from './performance';
import { adminPathError, adminPathOf, buildSiteConfigDocument, readSiteConfig } from './siteConfig';

function makeConfig(overrides: Partial<WebConfig> = {}): WebConfig {
  return {
    version: 1,
    setup_complete: true,
    mode: 'live',
    api_base: 'http://api.test',
    site_id: 'site_1',
    database: 'sqlite',
    created_at: '2026-01-01T00:00:00.000Z',
    docs_url: 'http://api.test/api/v1/docs',
    ...overrides,
  };
}

const ADMIN_DOCUMENT = {
  admin_path: '/manage',
  access: {
    enabled: true,
    page_switch: { enabled: true, limit: 40, window_seconds: 60, block_seconds: 30 },
    requests: { enabled: true, limit: 180, window_seconds: 60, block_seconds: 30 },
    tabs: { enabled: true, limit: 8 },
    message: '访问过于频繁，请稍后再试。',
  },
  domains: {
    enabled: true,
    primary: 'example.com',
    aliases: ['www.example.com'],
    allow_www: true,
    allow_localhost: true,
    allow_ip: false,
    redirect_primary: true,
    https_only: true,
    tls: { mode: 'manual', email: '', cert_path: '/etc/ssl/site.pem', key_path: '/etc/ssl/site.key', hsts: false },
    cors_origins: ['https://example.com'],
    cookie_domain: '.example.com',
    trusted_proxies: ['10.0.0.0/8'],
  },
  performance: {
    feed_limit: 12,
    archive_limit: 24,
    request_cache: true,
    cache_ttl: 30,
    lazy_media: true,
    disable_animations: true,
    preconnect: ['https://fonts.example.com'],
    gzip: true,
    db_max_open_conns: 10,
  },
  loading: { enabled: true, preset: 'dots', text: '正在打开', min_duration_ms: 400 },
  auth: {
    google: { enabled: true, client_id: 'client-123', redirect_uri: 'https://example.com/cb' },
  },
};

describe('readSiteConfig', () => {
  it('管理员范围拿到完整文档（含登录方式的参数与网关参数）', () => {
    const patch = readSiteConfig(ADMIN_DOCUMENT, 'admin', makeConfig());

    expect(patch.admin_path).toBe('/manage');
    expect(patch.access!.enabled).toBe(true);
    expect(patch.access!.requests.limit).toBe(180);
    expect(patch.performance!.feed_limit).toBe(12);
    expect(patch.performance!.db_max_open_conns).toBe(10);
    expect(patch.domains!.tls.key_path).toBe('/etc/ssl/site.key');
    expect(patch.domains!.cors_origins).toEqual(['https://example.com']);
    expect(patch.auth!.google.client_id).toBe('client-123');
    expect(patch.auth!.google.enabled).toBe(true);
    expect(patch.loading!.preset).toBe('dots');
  });

  it('公开子集只改浏览器会执行的字段，部署参数沿用本地值', () => {
    const local = makeConfig({
      domains: { ...DEFAULT_DOMAINS, tls: { ...DEFAULT_DOMAINS.tls, key_path: '/local/site.key' } },
      performance: { ...DEFAULT_PERFORMANCE, db_max_open_conns: 7 },
      auth: {
        ...{ phone: { enabled: false, client_id: '', redirect_uri: '', extra: '', note: '' } },
        google: { enabled: false, client_id: 'local-client', redirect_uri: '', extra: '', note: '' },
        github: { enabled: false, client_id: '', redirect_uri: '', extra: '', note: '' },
        wechat: { enabled: false, client_id: '', redirect_uri: '', extra: '', note: '' },
      },
    });

    const patch = readSiteConfig(
      {
        admin_path: '/manage',
        access: ADMIN_DOCUMENT.access,
        // 服务端公开子集里没有 tls / cors_origins / db_*，也没有 client_id。
        domains: { enabled: true, primary: 'example.com', aliases: ['www.example.com'], allow_ip: false },
        performance: { feed_limit: 6, request_cache: true, cache_ttl: 20 },
        auth: { google: { enabled: true } },
      },
      'public',
      local,
    );

    expect(patch.admin_path).toBe('/manage');
    expect(patch.access!.enabled).toBe(true);
    expect(patch.performance!.feed_limit).toBe(6);
    // 公开子集覆盖浏览器字段……
    expect(patch.performance!.request_cache).toBe(true);
    // ……但不抹掉本机的部署参数。
    expect(patch.performance!.db_max_open_conns).toBe(7);
    expect(patch.domains!.tls.key_path).toBe('/local/site.key');
    // 登录方式：开关来自服务端，参数保留本机值。
    expect(patch.auth!.google.enabled).toBe(true);
    expect(patch.auth!.google.client_id).toBe('local-client');
  });

  it('公开子集没有 admin_path 时不清掉本机入口', () => {
    const patch = readSiteConfig({ access: { enabled: false } }, 'public', makeConfig({ admin_path: '/manage' }));
    expect(patch.admin_path).toBeUndefined();
    expect('admin_path' in patch).toBe(false);
  });

  it('管理员范围里缺 admin_path 表示服务端确实用默认入口', () => {
    const patch = readSiteConfig({ access: { enabled: false } }, 'admin', makeConfig({ admin_path: '/manage' }));
    expect('admin_path' in patch).toBe(true);
    expect(patch.admin_path).toBeUndefined();
  });

  it('无法识别的文档按默认值归一化，不抛错', () => {
    const patch = readSiteConfig(null, 'public', null);
    expect(patch.access).toEqual(DEFAULT_ACCESS);
    expect(patch.loading).toEqual(DEFAULT_LOADING);
    expect(patch.domains).toEqual(DEFAULT_DOMAINS);
  });
});

describe('buildSiteConfigDocument', () => {
  it('总是写完整文档：第一次保存就把本机已有的段落整体搬到服务端', () => {
    const config = makeConfig({
      admin_path: '/manage',
      access: { ...DEFAULT_ACCESS, enabled: true },
      performance: { ...DEFAULT_PERFORMANCE, feed_limit: 9 },
      loading: { ...DEFAULT_LOADING, enabled: true, preset: 'bar' },
    });

    const document = buildSiteConfigDocument(config);

    expect(document.admin_path).toBe('/manage');
    expect((document.access as { enabled: boolean }).enabled).toBe(true);
    expect((document.performance as { feed_limit: number }).feed_limit).toBe(9);
    expect((document.loading as { preset: string }).preset).toBe('bar');
    expect(document.domains).toEqual(DEFAULT_DOMAINS);
    expect(document.auth).toBeDefined();
  });

  it('默认入口写成 /admin，读回来等价于未配置', () => {
    const document = buildSiteConfigDocument(makeConfig());
    expect(document.admin_path).toBe('/admin');
    expect(adminPathOf(readSiteConfig(document, 'admin', null))).toBe('/admin');
  });
});

describe('adminPathOf / adminPathError', () => {
  it('未配置或非法值回退 /admin', () => {
    expect(adminPathOf({})).toBe('/admin');
    expect(adminPathOf({ admin_path: '' })).toBe('/admin');
    expect(adminPathOf({ admin_path: '/' })).toBe('/admin');
    expect(adminPathOf({ admin_path: 'manage' })).toBe('/admin');
    expect(adminPathOf({ admin_path: '/manage/' })).toBe('/manage');
  });

  it('与服务端同一套规则：占用站点路径、带查询参数、超长都拒绝', () => {
    expect(adminPathError('/manage')).toBe('');
    expect(adminPathError('/ops/console')).toBe('');
    expect(adminPathError('manage')).not.toBe('');
    expect(adminPathError('/login')).not.toBe('');
    expect(adminPathError('/api/v1')).not.toBe('');
    expect(adminPathError('/admin?x=1')).not.toBe('');
    expect(adminPathError('//evil')).not.toBe('');
    expect(adminPathError(`/${'a'.repeat(90)}`)).not.toBe('');
  });
});
