import type { ScreenLayout, SiteCustomization, SiteTheme, ThemeAppearance } from '../types';
import { normalizeScreenLayout } from './customize';
import { normalizeThemeSettings } from './theme';
import { normalizeAppearance, normalizeVariant } from './themes';
import type { LayoutVariant, ThemeSettings } from '../types';
import { createZip, readZip, safeZipName, type ZipEntry } from './zip';

/**
 * 主题包 v2：清单 + 组件 + 页面编排（+ 后台页 / Go 后端）。
 *
 * 页面编排是「组件 + JSON」模型里真正被页面编排器编辑的那份数据：`pages/*.json`
 * 与 `customization.home` / `customization.article` / `customization.pages[].blocks`
 * 完全同构。导入时走与站点设计相同的 `normalizeScreenLayout`，所以坏数据不会进站点。
 *
 * 读取是纯函数（除了 zip 解压需要浏览器 API），可以单独测试；UI 只负责把结果
 * 写回站点设计。
 */

export const THEME_PACKAGE_VERSION = 2;
export const THEME_PACKAGE_MAX_BYTES = 32 * 1024 * 1024;
export const THEME_PACKAGE_MAX_UNPACKED = 64 * 1024 * 1024;
export const THEME_PACKAGE_MAX_FILES = 300;
export const THEME_PACKAGE_MAX_PAGES = 24;
export const THEME_PACKAGE_MAX_PAGE_BYTES = 512 * 1024;
export const THEME_PACKAGE_MAX_MANIFEST_BYTES = 256 * 1024;

const THEME_ID = /^[a-z0-9][a-z0-9_-]{1,63}$/;

export type ThemePackagePageKind = 'home' | 'article' | 'page';

export interface ThemePackagePage {
  kind: ThemePackagePageKind;
  /** 路由，只用于展示与匹配；导入不据此建路由。 */
  path: string;
  /** 相对 zip 根目录的 JSON 文件，例如 `pages/home.json`。 */
  file: string;
  title?: string;
  /** `kind: "page"` 时必填：匹配已有自定义页面的 slug。 */
  slug?: string;
}

export interface ThemePackageManifest {
  kind: 'pp-theme';
  version: number;
  id: string;
  name: string;
  note?: string;
  author?: string;
  homepage?: string;
  exported_at?: string;
  variant: LayoutVariant;
  theme: ThemeSettings;
  appearance?: ThemeAppearance;
  pages?: ThemePackagePage[];
  components?: { entry: string; id: string };
  backend?: {
    entry: string;
    id: string;
    routes?: { method: string; path: string; auth?: string }[];
  };
  admin?: { tabs?: string };
  assets?: string[];
}

/** 一个被识别出来的页面：清单里的索引 + 归一化后的编排。 */
export interface ThemePackageLayout {
  page: ThemePackagePage;
  layout: ScreenLayout;
}

export interface ThemePackageComponents {
  /** `components/plugin.json` 解析后的对象。 */
  manifest: Record<string, unknown>;
  /** 目录内的全部文件（相对 zip 根目录）。 */
  files: Map<string, Uint8Array>;
}

export interface ThemePackageBackend {
  manifest: Record<string, unknown>;
  files: Map<string, Uint8Array>;
}

export interface ParsedThemePackage {
  manifest: ThemePackageManifest;
  layouts: ThemePackageLayout[];
  components?: ThemePackageComponents;
  backend?: ThemePackageBackend;
  /** `admin/tabs.json` 解析后的对象；没有则 undefined。 */
  adminTabs?: unknown;
}

export interface ThemePackageBuildInput {
  manifest: ThemePackageManifest;
  /** 相对 zip 根目录的文件；`theme.json` 与 README 会自动补上。 */
  files: { name: string; data: Uint8Array | string }[];
  /** README 里的文档地址前缀，默认 `docs/themes`。 */
  docsBase?: string;
}

function fail(message: string): never {
  throw new Error(message);
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function decode(data: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(data);
}

function parseJSON(data: Uint8Array, label: string): unknown {
  try {
    return JSON.parse(decode(data));
  } catch {
    fail(`${label} 不是有效的 JSON。`);
  }
}

function fileOf(files: Map<string, Uint8Array>, path: string, label: string): Uint8Array {
  let name: string;
  try {
    name = safeZipName(path);
  } catch {
    fail(`${label} 的路径不合法：${path}`);
  }
  const found = files.get(name);
  if (!found) fail(`主题包缺少 ${label}：${path}`);
  return found;
}

/** 文件名：保留可读名称，替换文件系统保留字符。 */
export function themePackageFileName(name: string): string {
  const safe = name.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return `practacu-theme-${safe || 'theme'}.zip`;
}

/** 把 zip 里的 `theme.json` 收敛成合法清单；任何不合法都抛出带原因的错误。 */
export function normalizeThemePackageManifest(value: unknown): ThemePackageManifest {
  const raw = object(value);
  if (!raw) fail('theme.json 必须是一个 JSON 对象。');
  if (String(raw.kind ?? '').toLowerCase() !== 'pp-theme') {
    fail('theme.json 的 kind 必须是 "pp-theme"。');
  }
  const version = Number(raw.version ?? 1);
  if (!Number.isFinite(version) || version < 1) fail('theme.json 的 version 不合法。');
  if (version > THEME_PACKAGE_VERSION) {
    fail(`主题包版本 ${version} 高于当前支持的 ${THEME_PACKAGE_VERSION}，请先升级程序。`);
  }
  const id = text(raw.id, 64);
  if (!THEME_ID.test(id)) {
    fail('theme.json 的 id 不合法：只允许小写字母、数字、- 与 _，并以字母或数字开头。');
  }
  const name = text(raw.name, 40);
  if (!name) fail('theme.json 缺少主题名称 name。');
  const theme = object(raw.theme);
  if (!theme) fail('theme.json 缺少主题令牌 theme。');

  const pages: ThemePackagePage[] = [];
  if (Array.isArray(raw.pages)) {
    if (raw.pages.length > THEME_PACKAGE_MAX_PAGES) {
      fail(`主题包最多 ${THEME_PACKAGE_MAX_PAGES} 个页面。`);
    }
    if (!raw.pages.length) fail('theme.json 的 pages 不能是空数组；只带令牌请省略该字段。');
    for (const entry of raw.pages) {
      const page = object(entry);
      if (!page) fail('pages[] 的每一项必须是对象。');
      const kind = page.kind;
      if (kind !== 'home' && kind !== 'article' && kind !== 'page') {
        fail('pages[].kind 只能是 home / article / page。');
      }
      const path = text(page.path, 200);
      if (!path.startsWith('/')) fail('pages[].path 必须以 / 开头。');
      const file = text(page.file, 300);
      if (!file.endsWith('.json')) fail('pages[].file 必须是 .json 文件。');
      const slug = text(page.slug, 80);
      if (kind === 'page' && !slug) fail('pages[] 里 kind=page 的条目必须写 slug。');
      pages.push({
        kind,
        path,
        file,
        ...(text(page.title, 80) ? { title: text(page.title, 80) } : {}),
        ...(kind === 'page' ? { slug } : {}),
      });
    }
    const homes = pages.filter((page) => page.kind === 'home').length;
    const articles = pages.filter((page) => page.kind === 'article').length;
    if (homes > 1) fail('pages[] 里 home 只能出现一次。');
    if (articles > 1) fail('pages[] 里 article 只能出现一次。');
  }

  const components = object(raw.components);
  const backend = object(raw.backend);
  const admin = object(raw.admin);
  const appearance = normalizeAppearance(raw.appearance);

  return {
    kind: 'pp-theme',
    version,
    id,
    name,
    ...(text(raw.note, 160) ? { note: text(raw.note, 160) } : {}),
    ...(text(raw.author, 80) ? { author: text(raw.author, 80) } : {}),
    ...(text(raw.homepage, 300) ? { homepage: text(raw.homepage, 300) } : {}),
    ...(text(raw.exported_at, 40) ? { exported_at: text(raw.exported_at, 40) } : {}),
    variant: normalizeVariant(raw.variant),
    theme: normalizeThemeSettings(theme),
    ...(appearance ? { appearance } : {}),
    ...(pages.length ? { pages } : {}),
    ...(components
      ? {
          components: {
            entry: text(components.entry, 300) || 'components/plugin.json',
            id: text(components.id, 80),
          },
        }
      : {}),
    ...(backend
      ? {
          backend: {
            entry: text(backend.entry, 300) || 'backend/plugin.json',
            id: text(backend.id, 80),
            ...(Array.isArray(backend.routes)
              ? {
                  routes: backend.routes
                    .map((route) => object(route))
                    .filter((route): route is Record<string, unknown> => !!route)
                    .map((route) => ({
                      method: text(route.method, 8),
                      path: text(route.path, 200),
                      auth: text(route.auth, 16) || 'public',
                    })),
                }
              : {}),
          },
        }
      : {}),
    ...(admin && text(admin.tabs, 300) ? { admin: { tabs: text(admin.tabs, 300) } } : {}),
  };
}

/** 读取一个主题包；校验并返回清单、页面编排、组件与后端文件。 */
export async function readThemePackage(input: Blob | ArrayBuffer | Uint8Array): Promise<ParsedThemePackage> {
  const bytes =
    input instanceof Uint8Array
      ? input
      : input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(await input.arrayBuffer());
  if (bytes.length > THEME_PACKAGE_MAX_BYTES) {
    fail(`主题包超过 ${Math.round(THEME_PACKAGE_MAX_BYTES / 1024 / 1024)} MiB 上限。`);
  }
  const entries = await readZip(bytes, {
    maxEntries: THEME_PACKAGE_MAX_FILES,
    maxBytes: THEME_PACKAGE_MAX_UNPACKED,
  });
  const files = new Map<string, Uint8Array>();
  for (const entry of entries) files.set(entry.name, entry.data);

  const manifestBytes = fileOf(files, 'theme.json', '主题清单');
  if (manifestBytes.length > THEME_PACKAGE_MAX_MANIFEST_BYTES) fail('theme.json 超过 256 KiB。');
  const manifest = normalizeThemePackageManifest(parseJSON(manifestBytes, 'theme.json'));

  const layouts: ThemePackageLayout[] = [];
  for (const page of manifest.pages ?? []) {
    const data = fileOf(files, page.file, '页面编排');
    if (data.length > THEME_PACKAGE_MAX_PAGE_BYTES) {
      fail(`页面编排文件超过 512 KiB：${page.file}`);
    }
    const layout = parseJSON(data, page.file);
    const record = object(layout);
    if (!record || !Array.isArray(record.blocks)) {
      fail(`${page.file} 必须是 { "blocks": [...] } 结构。`);
    }
    layouts.push({ page, layout: normalizeScreenLayout(record) });
  }

  let components: ThemePackageComponents | undefined;
  if (manifest.components) {
    const entry = manifest.components.entry;
    const data = fileOf(files, entry, '组件清单');
    const parsed = parseJSON(data, entry);
    const record = object(parsed);
    if (!record) fail(`${entry} 必须是一个 JSON 对象。`);
    const pluginID = text(record.id, 80);
    if (manifest.components.id && pluginID !== manifest.components.id) {
      fail('theme.json 的 components.id 与组件包 plugin.json 的 id 不一致。');
    }
    const dir = entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/') + 1) : '';
    const componentFiles = new Map<string, Uint8Array>();
    for (const [name, bytes] of files) {
      if (dir && name.startsWith(dir)) componentFiles.set(name.slice(dir.length), bytes);
    }
    if (!componentFiles.size) fail('组件包目录里没有任何文件。');
    components = { manifest: record, files: componentFiles };
  }

  let backend: ThemePackageBackend | undefined;
  if (manifest.backend) {
    const entry = manifest.backend.entry;
    const data = fileOf(files, entry, '后端清单');
    const parsed = parseJSON(data, entry);
    const record = object(parsed);
    if (!record) fail(`${entry} 必须是一个 JSON 对象。`);
    const pluginID = text(record.id, 80);
    if (manifest.backend.id && pluginID !== manifest.backend.id) {
      fail('theme.json 的 backend.id 与后端包 plugin.json 的 id 不一致。');
    }
    const dir = entry.includes('/') ? entry.slice(0, entry.lastIndexOf('/') + 1) : '';
    const backendFiles = new Map<string, Uint8Array>();
    for (const [name, bytes] of files) {
      if (dir && name.startsWith(dir)) backendFiles.set(name.slice(dir.length), bytes);
    }
    backend = { manifest: record, files: backendFiles };
  }

  let adminTabs: unknown;
  if (manifest.admin?.tabs) {
    const data = fileOf(files, manifest.admin.tabs, '后台页数据');
    adminTabs = parseJSON(data, manifest.admin.tabs);
  }

  return {
    manifest,
    layouts,
    ...(components ? { components } : {}),
    ...(backend ? { backend } : {}),
    ...(adminTabs !== undefined ? { adminTabs } : {}),
  };
}

/** 组装主题包 zip。会自动补 `theme.json` 与 README。 */
export function buildThemePackage(input: ThemePackageBuildInput): Blob {
  const manifest = normalizeThemePackageManifest(input.manifest);
  const seen = new Set<string>();
  const files: { name: string; data: Uint8Array | string }[] = [];
  const push = (name: string, data: Uint8Array | string) => {
    const safe = safeZipName(name);
    if (seen.has(safe)) throw new Error(`主题包里有重复文件：${safe}`);
    seen.add(safe);
    files.push({ name: safe, data });
  };

  push('theme.json', `${JSON.stringify(manifest, null, 2)}\n`);
  push('README.md', themePackageReadme(manifest, input.docsBase ?? 'docs/themes'));
  for (const file of input.files) push(file.name, file.data);
  return createZip(files);
}

/** 主题包 README：安装步骤 + 回链本套开发文档。 */
export function themePackageReadme(manifest: ThemePackageManifest, docsBase = 'docs/themes'): string {
  const lines = [
    `# ${manifest.name}`,
    '',
    manifest.note || 'Practacu Press 主题包（v2）。',
    '',
    '## 安装',
    '',
    '1. 平台管理员：在「扩展」页导入 `components/` 与 `backend/`（如果有）。',
    '2. 站点管理员：在「选择主题 → 导入主题」选择本 zip。',
    '',
    '## 开发文档',
    '',
    `- 主题开发文档：${docsBase}/README.md`,
    `- 主题包格式：${docsBase}/04-package.md`,
    `- 后台侧栏与 Go 后端：${docsBase}/05-admin-and-backend.md`,
    '- 扩展与后端 ABI：docs/extensions/README.md',
    '',
    '## 版本',
    '',
    `- 主题包版本：${manifest.version}`,
    `- 主题 id：${manifest.id}`,
    `- 版式：${manifest.variant}`,
    `- 页面：${manifest.pages?.length ?? 0}`,
    ...(manifest.components ? [`- 组件包：${manifest.components.id}`] : []),
    ...(manifest.backend ? [`- 后端包：${manifest.backend.id}`] : []),
    '',
  ];
  return lines.join('\n');
}

/** 把当前站点设计投影成一份可导出的主题包清单（页面文件由调用方补齐）。 */
export function themeManifestFromCustomization(
  customization: SiteCustomization,
  options: {
    id: string;
    name: string;
    note?: string;
    author?: string;
    homepage?: string;
    appearance?: ThemeAppearance;
    components?: ThemePackageManifest['components'];
    backend?: ThemePackageManifest['backend'];
    admin?: ThemePackageManifest['admin'];
    includeArticles?: boolean;
  },
): { manifest: ThemePackageManifest; pages: { file: string; data: string }[] } {
  const id = text(options.id, 64) || `theme_${Date.now().toString(36)}`;
  if (!THEME_ID.test(id)) fail('导出主题的 id 不合法。');
  const pages: ThemePackagePage[] = [];
  const files: { file: string; data: string }[] = [];

  if (customization.home.blocks.length) {
    pages.push({ kind: 'home', path: '/', file: 'pages/home.json', title: '首页' });
    files.push({
      file: 'pages/home.json',
      data: `${JSON.stringify({ blocks: customization.home.blocks }, null, 2)}\n`,
    });
  }
  if (options.includeArticles && customization.article?.blocks.length) {
    pages.push({ kind: 'article', path: '/a/:id', file: 'pages/article.json', title: '文章页' });
    files.push({
      file: 'pages/article.json',
      data: `${JSON.stringify({ blocks: customization.article.blocks }, null, 2)}\n`,
    });
  }
  for (const page of customization.pages) {
    if (!page.slug) continue;
    const blocks = page.layout?.blocks ?? [];
    if (!blocks.length) continue;
    const file = `pages/page-${page.slug}.json`;
    pages.push({
      kind: 'page',
      path: `/${page.slug}`,
      file,
      title: page.title,
      slug: page.slug,
    });
    files.push({ file, data: `${JSON.stringify({ blocks }, null, 2)}\n` });
  }

  const manifest: ThemePackageManifest = {
    kind: 'pp-theme',
    version: THEME_PACKAGE_VERSION,
    id,
    name: text(options.name, 40) || '导出的主题',
    ...(options.note ? { note: text(options.note, 160) } : {}),
    ...(options.author ? { author: text(options.author, 80) } : {}),
    ...(options.homepage ? { homepage: text(options.homepage, 300) } : {}),
    exported_at: new Date().toISOString(),
    variant: customization.layout.variant,
    theme: customization.theme,
    ...(options.appearance ? { appearance: options.appearance } : {}),
    ...(pages.length ? { pages } : {}),
    ...(options.components ? { components: options.components } : {}),
    ...(options.backend ? { backend: options.backend } : {}),
    ...(options.admin ? { admin: options.admin } : {}),
  };
  return { manifest: normalizeThemePackageManifest(manifest), pages: files };
}

/** 页面清单按 kind 取：导入 UI 用来预览「会写哪些编排」。 */
export function layoutsByKind(parsed: ParsedThemePackage): {
  home?: ThemePackageLayout;
  article?: ThemePackageLayout;
  pages: ThemePackageLayout[];
} {
  return {
    home: parsed.layouts.find((item) => item.page.kind === 'home'),
    article: parsed.layouts.find((item) => item.page.kind === 'article'),
    pages: parsed.layouts.filter((item) => item.page.kind === 'page'),
  };
}

/** 导入后要写回站点设计的一小组字段；UI 负责按 slug 合并到已有页面。 */
export function layoutPatches(parsed: ParsedThemePackage): {
  home?: ScreenLayout;
  article?: ScreenLayout;
  pages: { slug: string; title: string; layout: ScreenLayout }[];
} {
  const byKind = layoutsByKind(parsed);
  return {
    ...(byKind.home ? { home: byKind.home.layout } : {}),
    ...(byKind.article ? { article: byKind.article.layout } : {}),
    pages: parsed.layouts
      .filter((item) => item.page.kind === 'page' && item.page.slug)
      .map((item) => ({
        slug: item.page.slug!,
        title: item.page.title || item.page.slug!,
        layout: item.layout,
      })),
  };
}

/** 主题库条目：导入的包在站点设计里长这样（package 字段保留来源与页面索引）。 */
export interface ThemePackageReference {
  id: string;
  version: number;
  pages: ThemePackagePage[];
  hasComponents: boolean;
  hasBackend: boolean;
}

export function themeReferenceOf(manifest: ThemePackageManifest): ThemePackageReference {
  return {
    id: manifest.id,
    version: manifest.version,
    pages: manifest.pages ?? [],
    hasComponents: !!manifest.components,
    hasBackend: !!manifest.backend,
  };
}

export function siteThemeFromPackage(
  parsed: ParsedThemePackage,
  themeId: string,
): SiteTheme {
  return {
    id: themeId,
    name: parsed.manifest.name,
    note: parsed.manifest.note ?? '',
    variant: parsed.manifest.variant,
    theme: parsed.manifest.theme,
    ...(parsed.manifest.appearance ? { appearance: parsed.manifest.appearance } : {}),
  };
}

export type { ZipEntry };
