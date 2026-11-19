/**
 * Which links belong to the client-side/PJAX path.
 *
 * The SPA already handles React Router links; this helper extends the same
 * behaviour to raw `<a href>` elements in rendered article HTML, theme footers
 * and plugin output. API routes, plugin assets and crawler files stay on the
 * normal browser path because they are downloads or non-page responses.
 */

const NON_PAGE_PREFIXES = [
  '/api',
  '/plugins',
  '/__pp',
  '/assets',
  '/metrics',
] as const;

const NON_PAGE_FILES = new Set([
  '/sitemap.xml',
  '/robots.txt',
  '/rss.xml',
  '/atom.xml',
  '/feed.xml',
]);

function isNonPage(pathname: string): boolean {
  if (NON_PAGE_FILES.has(pathname)) return true;
  return NON_PAGE_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/** Return the destination URL when the link should be handled as a page swap. */
export function resolvePjaxTarget(
  anchor: HTMLAnchorElement,
  currentHref: string,
): URL | null {
  if (anchor.hasAttribute('download')) return null;
  if (anchor.dataset.pjax === 'off') return null;
  if (anchor.closest('[data-pjax-ignore]')) return null;

  const target = (anchor.getAttribute('target') || '').trim().toLowerCase();
  if (target && target !== '_self') return null;

  const rel = (anchor.getAttribute('rel') || '').toLowerCase().split(/\s+/);
  if (rel.includes('external') || rel.includes('download')) return null;

  const rawHref = anchor.getAttribute('href');
  if (!rawHref || rawHref.startsWith('#') || /^(mailto|tel|javascript):/i.test(rawHref)) {
    return null;
  }

  let url: URL;
  let current: URL;
  try {
    current = new URL(currentHref);
    url = new URL(rawHref, current);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.origin !== current.origin) return null;
  if (isNonPage(url.pathname)) return null;

  // A fragment on the current page is a native in-page jump, not a page swap.
  if (url.pathname === current.pathname && url.search === current.search) return null;

  return url;
}
