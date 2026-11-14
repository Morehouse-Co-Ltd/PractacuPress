import { describe, expect, it } from 'vitest';
import type { SiteCustomization, ThemeSettings } from '../types';
import {
  THEME_PACKAGE_VERSION,
  buildThemePackage,
  layoutPatches,
  normalizeThemePackageManifest,
  readThemePackage,
  themeManifestFromCustomization,
  themePackageFileName,
  themePackageReadme,
} from './themePackage';
import { createZip, readZip } from './zip';

const theme: ThemeSettings = {
  preset: 'custom',
  mode: 'light',
  background: '#faf7f2',
  ink: '#1b1a17',
  accent: '#b4552d',
  heading_font: 'serif',
  body_size: 17.5,
  content_width: 720,
  radius: 6,
  soften: {
    enabled: false,
    strength: 45,
    transition_ms: 240,
    gradient: true,
    blend_components: true,
    blur: 8,
  },
};

function baseManifest() {
  return {
    kind: 'pp-theme' as const,
    version: THEME_PACKAGE_VERSION,
    id: 'aurora',
    name: 'Aurora',
    note: '极光主题。',
    variant: 'bento' as const,
    theme,
    pages: [
      { kind: 'home' as const, path: '/', file: 'pages/home.json', title: '首页' },
      { kind: 'page' as const, path: '/about', file: 'pages/page-about.json', slug: 'about' },
    ],
  };
}

describe('zip 读写', () => {
  it('STORE 往返保留文件名与字节', async () => {
    const blob = createZip([
      { name: 'theme.json', data: '{"a":1}' },
      { name: 'pages/home.json', data: '{"blocks":[]}' },
    ]);
    const entries = await readZip(blob);
    expect(entries.map((entry) => entry.name)).toEqual(['theme.json', 'pages/home.json']);
    expect(new TextDecoder().decode(entries[0].data)).toBe('{"a":1}');
  });

  it('拒绝绝对路径与穿越路径', () => {
    expect(() => createZip([{ name: '../evil.js', data: 'x' }])).toThrow();
    expect(() => createZip([{ name: '/etc/passwd', data: 'x' }])).toThrow();
  });
});

describe('主题包清单', () => {
  it('归一化 id、名称、版式并保留页面索引', () => {
    const manifest = normalizeThemePackageManifest(baseManifest());
    expect(manifest.id).toBe('aurora');
    expect(manifest.name).toBe('Aurora');
    expect(manifest.variant).toBe('bento');
    expect(manifest.pages).toHaveLength(2);
  });

  it('拒绝非法 id 与高版本包', () => {
    expect(() => normalizeThemePackageManifest({ ...baseManifest(), id: 'Aurora!' })).toThrow();
    expect(() =>
      normalizeThemePackageManifest({ ...baseManifest(), version: THEME_PACKAGE_VERSION + 1 }),
    ).toThrow(/高于当前支持/);
  });

  it('kind=page 必须写 slug', () => {
    const manifest = baseManifest();
    manifest.pages = [
      { kind: 'page', path: '/about', file: 'pages/a.json', title: '关于' },
    ] as unknown as typeof manifest.pages;
    expect(() => normalizeThemePackageManifest(manifest)).toThrow(/slug/);
  });
});

describe('主题包读取', () => {
  it('读取页面编排、组件与后端文件', async () => {
    const blob = buildThemePackage({
      manifest: {
        ...baseManifest(),
        components: { entry: 'components/plugin.json', id: 'com.acme.aurora' },
        backend: { entry: 'backend/plugin.json', id: 'com.acme.aurora.backend' },
        admin: { tabs: 'admin/tabs.json' },
      },
      files: [
        { name: 'pages/home.json', data: JSON.stringify({ blocks: [] }) },
        { name: 'pages/page-about.json', data: JSON.stringify({ blocks: [] }) },
        {
          name: 'components/plugin.json',
          data: JSON.stringify({ id: 'com.acme.aurora', manifest_version: 1 }),
        },
        { name: 'components/client.js', data: '// bundle' },
        {
          name: 'backend/plugin.json',
          data: JSON.stringify({ id: 'com.acme.aurora.backend', manifest_version: 1 }),
        },
        { name: 'backend/theme.wasm', data: new Uint8Array([0, 97, 115, 109]) },
        { name: 'admin/tabs.json', data: JSON.stringify({ version: 1, tabs: [] }) },
      ],
    });
    const parsed = await readThemePackage(blob);
    expect(parsed.manifest.components?.id).toBe('com.acme.aurora');
    expect(parsed.layouts).toHaveLength(2);
    expect(parsed.components?.files.get('client.js')).toBeTruthy();
    expect(parsed.backend?.files.has('theme.wasm')).toBe(true);
    expect(parsed.adminTabs).toMatchObject({ version: 1 });
  });

  it('组件 id 与清单不一致时拒绝', async () => {
    const blob = buildThemePackage({
      manifest: { ...baseManifest(), components: { entry: 'components/plugin.json', id: 'a.b' } },
      files: [
        { name: 'pages/home.json', data: JSON.stringify({ blocks: [] }) },
        { name: 'pages/page-about.json', data: JSON.stringify({ blocks: [] }) },
        { name: 'components/plugin.json', data: JSON.stringify({ id: 'other.id' }) },
      ],
    });
    await expect(readThemePackage(blob)).rejects.toThrow(/不一致/);
  });

  it('缺少 theme.json 时拒绝', async () => {
    const blob = createZip([{ name: 'pages/home.json', data: '{}' }]);
    await expect(readThemePackage(blob)).rejects.toThrow(/主题清单/);
  });
});

describe('从站点设计导出', () => {
  const customization = {
    theme,
    layout: { variant: 'classic' },
    home: {
      blocks: [{ id: 'b1', type: 'text', title: '文字', props: { body: 'hi' }, animation: 'none', hidden: false }],
    },
    article: { blocks: [] },
    pages: [
      {
        id: 'p1',
        title: '关于',
        slug: 'about',
        body: '',
        status: 'published',
        show_in_nav: true,
        created_at: '',
        updated_at: '',
        layout: {
          blocks: [
            { id: 'b2', type: 'text', title: '文字', props: { body: 'about' }, animation: 'none', hidden: false },
          ],
        },
      },
    ],
  } as unknown as SiteCustomization;

  it('页面编排取自 page.layout.blocks，并生成 pages/*.json', () => {
    const { manifest, pages } = themeManifestFromCustomization(customization, {
      id: 'aurora',
      name: 'Aurora',
    });
    expect(manifest.pages?.map((page) => page.kind)).toEqual(['home', 'page']);
    expect(pages.map((file) => file.file)).toEqual(['pages/home.json', 'pages/page-about.json']);
    expect(JSON.parse(pages[1].data).blocks).toHaveLength(1);
  });

  it('导入补丁只包含 home / article / 页面编排，不直接造 SitePage', () => {
    const patch = layoutPatches({
      manifest: normalizeThemePackageManifest({
        ...baseManifest(),
        pages: [{ kind: 'page', path: '/about', file: 'pages/page-about.json', slug: 'about' }],
      }),
      layouts: [
        {
          page: { kind: 'page', path: '/about', file: 'pages/page-about.json', slug: 'about' },
          layout: { blocks: [] },
        },
      ],
    });
    expect(patch.home).toBeUndefined();
    expect(patch.pages[0].slug).toBe('about');
  });
});

describe('README 与文件名', () => {
  it('README 回链主题开发文档', () => {
    const manifest = normalizeThemePackageManifest(baseManifest());
    const readme = themePackageReadme(manifest, 'docs/themes');
    expect(readme).toContain('docs/themes/README.md');
    expect(readme).toContain('docs/themes/04-package.md');
  });

  it('文件名替换保留字符', () => {
    expect(themePackageFileName('Aurora / 夜航')).toBe('practacu-theme-Aurora-夜航.zip');
  });
});
