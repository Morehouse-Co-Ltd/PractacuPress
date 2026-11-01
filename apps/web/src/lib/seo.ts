import { useEffect, useMemo } from 'react';
import type { Content, SeoSettings } from '../types';
import { useAuth } from './session';
import { useCustomization } from './customize';

/**
 * 单页应用的 SEO 层。
 *
 * 做法：每次路由渲染时把 title / description / canonical / Open Graph / Twitter /
 * JSON-LD 写进 <head>，并把上一页写入的标签清掉，避免叠加。
 *
 * 诚实的边界：搜索引擎（Google / Bing / 百度）会执行 JS，能看到这些标签；大多数
 * 社交平台的抓取器不执行 JS，分享卡片只能拿到 index.html 里的默认值。要做完整
 * 的预渲染，需要托管方支持 SSR 或构建期快照，这不在 v0.1 的范围内。
 */

const MARK = 'data-pp-seo';

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
  jsonLd: Record<string, unknown>[];
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

function setLink(rel: string, href: string): void {
  if (!href) return;
  const link = document.createElement('link');
  link.rel = rel;
  link.href = href;
  link.setAttribute(MARK, '1');
  document.head.appendChild(link);
}

export function applySeo(payload: SeoPayload): void {
  clearManaged();
  if (typeof document === 'undefined') return;

  document.title = payload.title;
  setMeta('name', 'description', payload.description);
  setMeta('name', 'keywords', payload.keywords);
  setMeta('name', 'robots', payload.robots);
  setLink('canonical', payload.canonical);

  setMeta('property', 'og:site_name', payload.siteName);
  setMeta('property', 'og:type', payload.type);
  setMeta('property', 'og:title', payload.title);
  setMeta('property', 'og:description', payload.description);
  setMeta('property', 'og:url', payload.canonical);
  setMeta('property', 'og:image', payload.image);
  setMeta('property', 'og:locale', 'zh_CN');

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
  },
): SeoPayload {
  const title = input.title?.trim()
    ? composeTitle(options.seo.title_template, input.title, options.siteName)
    : options.siteName;
  const description = (
    input.description ||
    options.seo.default_description ||
    options.siteDescription ||
    ''
  ).slice(0, 300);
  const canonical = input.path ? absoluteUrl(input.path, options.origin) : options.origin;
  const image = absoluteUrl(
    input.image || options.seo.share_image,
    options.origin,
  );
  const graph = [
    ...(options.siteLd ?? []),
    ...(input.jsonLd ?? []),
  ];
  return {
    title,
    description,
    canonical,
    image,
    robots: robotsFor(options.seo.indexable, input, options.membersOnly),
    keywords: (input.keywords ?? []).concat(
      options.seo.keywords ? options.seo.keywords.split(/[,，]\s*/).filter(Boolean) : [],
    ).join(', '),
    type: input.type ?? 'website',
    siteName: options.siteName,
    publishedAt: input.publishedAt,
    modifiedAt: input.modifiedAt,
    author: input.author,
    twitter: options.seo.twitter,
    verification: options.seo.verification,
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

  const payload = useMemo(
    () =>
      seoPayload(input, {
        seo,
        siteName,
        siteDescription: site?.description ?? '',
        origin,
        membersOnly,
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
    [JSON.stringify(input), seo, siteName, origin, membersOnly, site?.description, config.mode],
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
    description: content.summary || undefined,
    datePublished: content.published_at || content.created_at,
    dateModified: content.updated_at,
    author: { '@type': 'Person', name: options.author || content.author_name || '佚名' },
    publisher: { '@type': 'Organization', name: options.publisher || options.siteName },
    image: options.image || undefined,
    mainEntityOfPage: { '@type': 'WebPage', '@id': options.url },
    inLanguage: 'zh-CN',
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
    '# 后台与接口不参与收录',
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
