import { useEffect, useMemo } from 'react';
import type { Content, SeoSettings } from '../types';
import { useAuth } from './session';
import { useCustomization } from './customize';
import { getLocale, t } from './i18n';

/** Open Graph 用的是 `zh_CN` / `en_US` 这种下划线写法，和 BCP 47 不同。 */
const OG_LOCALE = { 'zh-CN': 'zh_CN', en: 'en_US' } as const;

/**
 * 单页应用的 SEO 层。
 *
 * 做法：每次路由渲染时把 title / description / canonical / Open Graph / Twitter /
 * JSON-LD 写进 <head>，并把上一页写入的标签清掉，避免叠加。
 *
 * 诚实的边界：搜索引擎（Google / Bing / 百度）会执行 JS，能看到这些标签；多数
 * 社交平台的抓取器不执行 JS。Beta 1.2 起这一层由静态服务补上：`scripts/serve.mjs`
 * 在返回 SPA 外壳前先读内容元数据，把 title / description / Open Graph / canonical
 * 注入 `dist/index.html`，抓取器于是能拿到真实卡片（`deploy/nginx/seo-meta.conf.example`
 * 是 nginx 部署下的等价方案）。这里仍然是「运行时的最后一道」：内容级覆盖与站点级
 * 配置合并的规则只有一份，就在下面的 `seoPayload` 里。
 *
 * 内容级覆盖（Beta 1.2）：`Content` 上的 `seo_title` / `seo_description` /
 * `seo_keywords` / `canonical_url` / `og_image` / `robots` 非空时优先于站点级配置；
 * 留空时与「只配置了站点级 SEO」的行为完全一致。
 */

const MARK = 'data-pp-seo';

/**
 * 内容级 SEO 覆盖（Beta 1.2）。
 *
 * 这是 `Content` 的结构子集：详情页可以把整个内容对象传进来，字段缺省时全部
 * 走站点级配置，所以旧的后端版本（不返回这些字段）行为不变。
 */
export interface SeoContentOverrides {
  seo_title?: string;
  seo_description?: string;
  seo_keywords?: string;
  /** 规范链接；为空时以本站该内容的地址为准。可以指向转载来源。 */
  canonical_url?: string;
  /** 社交分享图；优先于 `cover_url` 与站点默认分享图。 */
  og_image?: string;
  /** 内容封面；没有 `og_image` 时作为分享图。 */
  cover_url?: string;
  /** 空表示继承站点开关；`noindex` 把这一篇排除出索引。 */
  robots?: '' | 'index' | 'noindex';
}

export interface SeoInput {
  title?: string;
  description?: string;
  /** 站内路径或绝对地址；用于 canonical。 */
  path?: string;
  image?: string;
  type?: 'website' | 'article' | 'profile';
  publishedAt?: string;
  modifiedAt?: string;
  author?: string;
  keywords?: string[];
  noindex?: boolean;
  /** 详情页的内容对象；内容级覆盖优先于站点级配置。 */
  content?: SeoContentOverrides;
  /** 额外结构化数据，会与站点级实体一起输出。 */
  jsonLd?: Record<string, unknown>[];
}

export interface SeoPayload {
  title: string;
  description: string;
  canonical: string;
  image: string;
  robots: string;
  keywords: string;
  type: string;
  siteName: string;
  publishedAt?: string;
  modifiedAt?: string;
  author?: string;
  twitter?: string;
  verification: { google: string; baidu: string; bing: string };
  /** 站点订阅源；关闭、成员限定或禁止收录时为空。 */
  feeds: FeedLink[];
  jsonLd: Record<string, unknown>[];
}

/** 一条 feed autodiscovery 链接（`<link rel="alternate">`）。 */
export interface FeedLink {
  href: string;
  title: string;
  type: 'application/rss+xml' | 'application/atom+xml';
}

/** 站点根地址：优先站长配置，其次当前访问地址。 */
export function siteOrigin(seo: SeoSettings, fallback: string): string {
  const configured = seo.canonical_base.trim();
  if (configured) return configured.replace(/\/+$/, '');
  return (fallback || '').replace(/\/+$/, '');
}

export function absoluteUrl(pathOrUrl: string, origin: string): string {
  const value = (pathOrUrl || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (!origin) return value;
  return `${origin}${value.startsWith('/') ? '' : '/'}${value}`;
}

export function composeTitle(template: string, title: string, siteName: string): string {
  const pattern = template.trim() || '{title} · {site}';
  const rendered = pattern
    .replace(/\{title\}/g, title.trim())
    .replace(/\{site\}/g, siteName.trim())
    .replace(/^[\s·|—-]+|[\s·|—-]+$/g, '');
  return rendered || title || siteName;
}

/** 搜索结果页与后台不该进索引；成员限定站点同理。 */
export function robotsFor(indexable: boolean, input: SeoInput, membersOnly: boolean): string {
  if (!indexable || membersOnly || input.noindex) return 'noindex, nofollow';
  return 'index, follow, max-image-preview:large';
}

/**
 * 内容级 `robots` 覆盖。
 *
 * 只允许「把这一篇排除出索引」，不允许单篇绕开站点开关：站点已经 noindex 时，
 * 内容写 `index` 也不会重新进索引。站点级给出的是 `noindex, nofollow`（更严），
 * 内容级只写 `noindex`——和契约里「设为 noindex 即排除收录」的字面意思一致。
 */
export function robotsWithOverride(base: string, robots?: '' | 'index' | 'noindex'): string {
  if (robots !== 'noindex') return base;
  return base.startsWith('noindex') ? base : 'noindex';
}

/** 取第一个非空字符串：内容级覆盖 → 调用方传入 → 站点默认。 */
function firstText(...values: (string | undefined)[]): string {
  for (const value of values) {
    const text = (value ?? '').trim();
    if (text) return text;
  }
  return '';
}

/* ------------------------------ 写入 <head> ------------------------------ */

function clearManaged(): void {
  document.querySelectorAll(`[${MARK}]`).forEach((node) => node.remove());
}

function setMeta(attribute: 'name' | 'property', key: string, content?: string): void {
  if (!content) return;
  const meta = document.createElement('meta');
  meta.setAttribute(attribute, key);
  meta.setAttribute('content', content);
  meta.setAttribute(MARK, '1');
  document.head.appendChild(meta);
}

function setLink(rel: string, href: string, attributes: Record<string, string> = {}): void {
  if (!href) return;
  const link = document.createElement('link');
  link.rel = rel;
  link.href = href;
  for (const [key, value] of Object.entries(attributes)) {
    if (value) link.setAttribute(key, value);
  }
  link.setAttribute(MARK, '1');
  document.head.appendChild(link);
}

/**
 * 站点级订阅源 autodiscovery 链接。
 *
 * 关闭订阅、成员限定站点与关闭收录三者任一成立都返回空数组：服务端这时会
 * 对 /rss.xml 返回 404，head 里就不该再声明一个不存在的源。其余情况同时声明
 * RSS 与 Atom，读取器会挑自己支持的那个。
 */
export function feedLinks(options: {
  origin: string;
  siteName: string;
  enabled: boolean;
  indexable: boolean;
  membersOnly: boolean;
}): FeedLink[] {
  if (!options.enabled || !options.indexable || options.membersOnly) return [];
  const name = options.siteName.trim() || 'Practacu Press';
  return [
    {
      href: absoluteUrl('/rss.xml', options.origin),
      title: `${name} RSS`,
      type: 'application/rss+xml',
    },
    {
      href: absoluteUrl('/atom.xml', options.origin),
      title: `${name} Atom`,
      type: 'application/atom+xml',
    },
  ];
}

export function applySeo(payload: SeoPayload): void {
  clearManaged();
  if (typeof document === 'undefined') return;

  document.title = payload.title;
  setMeta('name', 'description', payload.description);
  setMeta('name', 'keywords', payload.keywords);
  setMeta('name', 'robots', payload.robots);
  setLink('canonical', payload.canonical);
  for (const feed of payload.feeds) {
    setLink('alternate', feed.href, { type: feed.type, title: feed.title });
  }

  setMeta('property', 'og:site_name', payload.siteName);
  setMeta('property', 'og:type', payload.type);
  setMeta('property', 'og:title', payload.title);
  setMeta('property', 'og:description', payload.description);
  setMeta('property', 'og:url', payload.canonical);
  setMeta('property', 'og:image', payload.image);
  setMeta('property', 'og:locale', OG_LOCALE[getLocale()]);

  setMeta('name', 'twitter:card', payload.image ? 'summary_large_image' : 'summary');
  setMeta('name', 'twitter:title', payload.title);
  setMeta('name', 'twitter:description', payload.description);
  setMeta('name', 'twitter:image', payload.image);
  if (payload.twitter) {
    setMeta('name', 'twitter:site', payload.twitter.startsWith('@') ? payload.twitter : `@${payload.twitter}`);
  }

  if (payload.type === 'article') {
    setMeta('property', 'article:published_time', payload.publishedAt);
    setMeta('property', 'article:modified_time', payload.modifiedAt);
    setMeta('property', 'article:author', payload.author);
  }

  if (payload.verification.google) setMeta('name', 'google-site-verification', payload.verification.google);
  if (payload.verification.baidu) setMeta('name', 'baidu-site-verification', payload.verification.baidu);
  if (payload.verification.bing) setMeta('name', 'msvalidate.01', payload.verification.bing);

  if (payload.jsonLd.length) {
    const script = document.createElement('script');
    script.type = 'application/ld+json';
    script.setAttribute(MARK, '1');
    script.textContent = JSON.stringify({ '@context': 'https://schema.org', '@graph': payload.jsonLd });
    document.head.appendChild(script);
  }
}

export function clearSeo(): void {
  clearManaged();
}

/* ------------------------------ React 接入 ------------------------------ */

export function seoPayload(
  input: SeoInput,
  options: {
    seo: SeoSettings;
    siteName: string;
    siteDescription: string;
    origin: string;
    membersOnly: boolean;
    siteLd?: Record<string, unknown>[];
    feeds?: FeedLink[];
  },
): SeoPayload {
  // 内容级覆盖（Beta 1.2）：非空优先，缺省时与只配置站点级 SEO 时逐字等价。
  // 注意 `seo_title` 替换的是模板里的 {title}，站点标题模板照旧生效——站长改模板
  // 时所有页面一起变，单篇只覆盖标题文字本身。
  const override = input.content;
  const ownTitle = firstText(override?.seo_title, input.title);
  const title = ownTitle
    ? composeTitle(options.seo.title_template, ownTitle, options.siteName)
    : options.siteName;
  const ownDescription = override?.seo_description?.trim();
  const description = (
    ownDescription ||
    input.description ||
    options.seo.default_description ||
    options.siteDescription ||
    ''
  ).slice(0, 300);
  // canonical：内容级 canonical_url 非空时用它（转载、跨站原始出处），否则用本站地址。
  const canonical = override?.canonical_url?.trim()
    ? absoluteUrl(override.canonical_url, options.origin)
    : input.path
      ? absoluteUrl(input.path, options.origin)
      : options.origin;
  // 分享图顺序：内容 og_image → 内容封面 → 调用方给的图（正文首图）→ 站点默认分享图。
  const image = absoluteUrl(
    firstText(override?.og_image, override?.cover_url, input.image, options.seo.share_image),
    options.origin,
  );
  // 关键字：内容级覆盖排在最前，然后是调用方给的与站点级默认值。
  const keywords = [
    ...(override?.seo_keywords ? override.seo_keywords.split(/[,，]\s*/).filter(Boolean) : []),
    ...(input.keywords ?? []),
    ...(options.seo.keywords ? options.seo.keywords.split(/[,，]\s*/).filter(Boolean) : []),
  ];
  const graph = [
    ...(options.siteLd ?? []),
    ...(input.jsonLd ?? []),
  ];
  return {
    title,
    description,
    canonical,
    image,
    robots: robotsWithOverride(
      robotsFor(options.seo.indexable, input, options.membersOnly),
      override?.robots,
    ),
    keywords: keywords.join(', '),
    type: input.type ?? 'website',
    siteName: options.siteName,
    publishedAt: input.publishedAt,
    modifiedAt: input.modifiedAt,
    author: input.author,
    twitter: options.seo.twitter,
    verification: options.seo.verification,
    feeds: options.feeds ?? [],
    jsonLd: graph.filter(Boolean),
  };
}

/** 在页面组件里调用：写入 head，离开时清掉自己写入的标签。 */
export function useSeo(input: SeoInput): void {
  const { site, config } = useAuth();
  const { customization } = useCustomization();
  const seo = customization.seo;
  const siteName = site?.name ?? 'Practacu Press';
  const origin = siteOrigin(seo, window.location.origin);
  const membersOnly = site?.visibility_mode === 'members_only';
  const feed = customization.feed;
  const feeds = useMemo(
    () =>
      feedLinks({
        origin,
        siteName,
        enabled: feed.enabled,
        indexable: seo.indexable,
        membersOnly,
      }),
    [origin, siteName, feed.enabled, seo.indexable, membersOnly],
  );

  const payload = useMemo(
    () =>
      seoPayload(input, {
        seo,
        siteName,
        siteDescription: site?.description ?? '',
        origin,
        membersOnly,
        feeds,
        siteLd: [
          {
            '@type': 'WebSite',
            name: siteName,
            url: origin,
            description: site?.description || seo.default_description || undefined,
            potentialAction: {
              '@type': 'SearchAction',
              target: `${origin}/search?q={search_term_string}`,
              'query-input': 'required name=search_term_string',
            },
          },
        ],
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(input), seo, siteName, origin, membersOnly, site?.description, config.mode, feeds],
  );

  useEffect(() => {
    applySeo(payload);
    return () => clearSeo();
  }, [payload]);
}

/* ------------------------------ 结构化数据 ------------------------------ */

export function articleJsonLd(options: {
  content: Content;
  url: string;
  siteName: string;
  publisher: string;
  image: string;
  author?: string;
}): Record<string, unknown> {
  const { content } = options;
  return {
    '@type': content.kind === 'article' ? 'Article' : 'BlogPosting',
    headline: content.title,
    // 结构化数据的描述与页面上的 description 保持一致：内容级覆盖优先。
    description: content.seo_description?.trim() || content.summary || undefined,
    datePublished: content.published_at || content.created_at,
    dateModified: content.updated_at,
    author: { '@type': 'Person', name: options.author || content.author_name || t('佚名') },
    publisher: { '@type': 'Organization', name: options.publisher || options.siteName },
    image: options.image || undefined,
    mainEntityOfPage: { '@type': 'WebPage', '@id': options.url },
    inLanguage: getLocale(),
  };
}

export function breadcrumbJsonLd(items: { name: string; url: string }[]): Record<string, unknown> {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({
      '@type': 'ListItem',
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

export function personJsonLd(options: {
  name: string;
  url: string;
  description?: string;
}): Record<string, unknown> {
  return {
    '@type': 'Person',
    name: options.name,
    url: options.url,
    description: options.description || undefined,
  };
}

/* ------------------------------ sitemap / robots ------------------------------ */

export interface SitemapEntry {
  loc: string;
  lastmod?: string;
  changefreq?: 'daily' | 'weekly' | 'monthly';
  priority?: number;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function sitemapXml(entries: SitemapEntry[]): string {
  const urls = entries
    .map(
      (entry) => `  <url>
    <loc>${escapeXml(entry.loc)}</loc>${entry.lastmod ? `\n    <lastmod>${escapeXml(entry.lastmod.slice(0, 10))}</lastmod>` : ''}${
        entry.changefreq ? `\n    <changefreq>${entry.changefreq}</changefreq>` : ''
      }${entry.priority !== undefined ? `\n    <priority>${entry.priority.toFixed(1)}</priority>` : ''}
  </url>`,
    )
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

export function robotsTxt(options: { origin: string; indexable: boolean }): string {
  if (!options.indexable) {
    return ['User-agent: *', 'Disallow: /', ''].join('\n');
  }
  return [
    'User-agent: *',
    'Allow: /',
    '',
    t('# 后台与接口不参与收录'),
    'Disallow: /admin',
    'Disallow: /api',
    'Disallow: /login',
    'Disallow: /register',
    'Disallow: /forgot-password',
    'Disallow: /reset-password',
    '',
    `Sitemap: ${options.origin}/sitemap.xml`,
    '',
  ].join('\n');
}

/** 从内容列表与自定义页面拼出 sitemap 条目。 */
export function buildSitemap(options: {
  origin: string;
  contents: Content[];
  pages: { slug: string; title: string; status: string; updated_at: string }[];
}): SitemapEntry[] {
  const entries: SitemapEntry[] = [
    { loc: `${options.origin}/`, changefreq: 'daily', priority: 1 },
    { loc: `${options.origin}/articles`, changefreq: 'daily', priority: 0.8 },
    { loc: `${options.origin}/posts`, changefreq: 'daily', priority: 0.8 },
  ];
  for (const content of options.contents) {
    if (content.status !== 'published') continue;
    entries.push({
      loc: `${options.origin}/${content.kind === 'article' ? 'a' : 'p'}/${content.id}`,
      lastmod: content.updated_at,
      changefreq: 'monthly',
      priority: 0.7,
    });
  }
  for (const page of options.pages) {
    if (page.status !== 'published') continue;
    entries.push({
      loc: `${options.origin}/${page.slug}`,
      lastmod: page.updated_at,
      changefreq: 'monthly',
      priority: 0.5,
    });
  }
  return entries;
}
