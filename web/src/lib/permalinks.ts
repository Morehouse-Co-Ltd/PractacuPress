import type { Content, ContentKind, PermalinkPattern, PermalinkSettings, PermalinkStructure } from '../types';

export const DEFAULT_PERMALINKS: PermalinkSettings = {
  article_structure: 'legacy',
  article_custom: '/%postname%',
  article_aliases: [],
  posts_follow_articles: false,
  post_structure: 'legacy',
  post_custom: '/%postname%',
  post_aliases: [],
};

export const PERMALINK_STRUCTURES: PermalinkStructure[] = [
  'date_name',
  'month_name',
  'numeric',
  'post_name',
  'custom',
  'legacy',
];

export function normalizePermalinks(value: unknown): PermalinkSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...DEFAULT_PERMALINKS };
  const raw = value as Partial<PermalinkSettings>;
  const article = structureOf(raw.article_structure);
  const post = structureOf(raw.post_structure);
  const articleCustom = typeof raw.article_custom === 'string' ? raw.article_custom.slice(0, 200) : '';
  const postCustom = typeof raw.post_custom === 'string' ? raw.post_custom.slice(0, 200) : '';
  const articleAliases = normalizeAliases(raw.article_aliases);
  const postAliases = normalizeAliases(raw.post_aliases);
  return {
    article_structure: article,
    article_custom: isValidPermalinkTemplate(articleCustom) ? articleCustom : DEFAULT_PERMALINKS.article_custom,
    article_aliases: articleAliases,
    posts_follow_articles: raw.posts_follow_articles === true,
    post_structure: post,
    post_custom: isValidPermalinkTemplate(postCustom) ? postCustom : DEFAULT_PERMALINKS.post_custom,
    post_aliases: postAliases,
  };
}

export function isValidPermalinkTemplate(template: string): boolean {
  const value = template.trim();
  if (!value || value.length > 200 || !value.startsWith('/') || /[?#\\\s<>]/.test(value) || value.includes('//')) {
    return false;
  }
  const tokens = value.replace(/%(?:year|monthnum|day|postname|post_id)%/g, 'x');
  if (tokens.includes('%') || (!value.includes('%postname%') && !value.includes('%post_id%'))) return false;
  return !value.split('/').some((segment) => segment === '.' || segment === '..');
}

export function permalinkStructureFor(
  kind: ContentKind,
  settings?: PermalinkSettings,
): { structure: PermalinkStructure; custom: string } {
  const normalized = normalizePermalinks(settings);
  if (kind === 'post') {
    return normalized.posts_follow_articles
      ? { structure: normalized.article_structure, custom: normalized.article_custom }
      : { structure: normalized.post_structure, custom: normalized.post_custom };
  }
  return { structure: normalized.article_structure, custom: normalized.article_custom };
}

export function contentPermalink(item: Content, settings?: PermalinkSettings): string {
  const { structure, custom } = permalinkStructureFor(item.kind, settings);
  const slug = item.slug?.trim() || item.id;
  const date = new Date(item.published_at || item.created_at);
  const year = Number.isNaN(date.valueOf()) ? '1970' : String(date.getUTCFullYear());
  const month = Number.isNaN(date.valueOf()) ? '01' : String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = Number.isNaN(date.valueOf()) ? '01' : String(date.getUTCDate()).padStart(2, '0');
  if (structure === 'legacy') return `/${item.kind === 'post' ? 'p' : 'a'}/${encodeURIComponent(slug)}`;
  if (structure === 'date_name') return `/${year}/${month}/${day}/${encodeURIComponent(slug)}`;
  if (structure === 'month_name') return `/${year}/${month}/${encodeURIComponent(slug)}`;
  if (structure === 'numeric') return `/archives/${encodeURIComponent(item.id)}`;
  if (structure === 'post_name') return `/${encodeURIComponent(slug)}`;
  return custom.replace(/%(year|monthnum|day|postname|post_id)%/g, (_token, name: string) => {
    const values: Record<string, string> = {
      year,
      monthnum: month,
      day,
      postname: encodeURIComponent(slug),
      post_id: encodeURIComponent(item.id),
    };
    return values[name] ?? '';
  }).replace(/\/+$/, '') || '/';
}

export function matchContentPermalink(pathname: string, settings?: PermalinkSettings): {
  kind: ContentKind;
  key: string;
} | null {
  return matchContentPermalinks(pathname, settings)[0] ?? null;
}

export function matchContentPermalinks(pathname: string, settings?: PermalinkSettings): {
  kind: ContentKind;
  key: string;
}[] {
  const path = decodePath(pathname);
  const normalized = normalizePermalinks(settings);
  const matches: { kind: ContentKind; key: string }[] = [];
  for (const kind of ['article', 'post'] as const) {
    const patterns = patternsFor(kind, normalized);
    for (const pattern of patterns) {
      const key = matchTemplate(path, templateFor(pattern.structure, pattern.custom ?? ''));
      if (key && !matches.some((match) => match.kind === kind && match.key === key)) {
        matches.push({ kind, key });
      }
    }
  }
  if (!matches.length) {
    const legacy = /^\/(a|p)\/([^/]+)$/.exec(path);
    if (!legacy) return [];
    try {
      matches.push({ kind: legacy[1] === 'p' ? 'post' : 'article', key: decodeURIComponent(legacy[2]) });
    } catch {
      return [];
    }
  }
  return matches;
}

function structureOf(value: unknown): PermalinkStructure {
  return PERMALINK_STRUCTURES.includes(value as PermalinkStructure)
    ? (value as PermalinkStructure)
    : DEFAULT_PERMALINKS.article_structure;
}

function templateFor(structure: PermalinkStructure, custom: string): string {
  if (structure === 'date_name') return '/%year%/%monthnum%/%day%/%postname%';
  if (structure === 'month_name') return '/%year%/%monthnum%/%postname%';
  if (structure === 'numeric') return '/archives/%post_id%';
  if (structure === 'post_name') return '/%postname%';
  if (structure === 'custom') return custom.replace(/\/+$/, '');
  return '';
}

function patternsFor(kind: ContentKind, settings: PermalinkSettings): PermalinkPattern[] {
  const active = permalinkStructureFor(kind, settings);
  const aliases = kind === 'article'
    ? settings.article_aliases ?? []
    : settings.posts_follow_articles
      ? [...(settings.article_aliases ?? []), ...(settings.post_aliases ?? [])]
      : settings.post_aliases ?? [];
  return [
    { structure: active.structure, custom: active.custom },
    ...aliases,
  ];
}

function normalizeAliases(value: unknown): PermalinkPattern[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is PermalinkPattern => {
      if (!item || typeof item !== 'object') return false;
      const pattern = item as Partial<PermalinkPattern>;
      return PERMALINK_STRUCTURES.includes(pattern.structure as PermalinkStructure) &&
        (pattern.structure !== 'custom' || (typeof pattern.custom === 'string' && isValidPermalinkTemplate(pattern.custom)));
    })
    .map((item) => ({ ...item }))
    .slice(-12);
}

function matchTemplate(path: string, template: string): string | null {
  if (!template) return null;
  const tokens = [...template.matchAll(/%(year|monthnum|day|postname|post_id)%/g)];
  let source = '^';
  let cursor = 0;
  for (const token of tokens) {
    source += escapeRegExp(template.slice(cursor, token.index));
    const name = token[1];
    source += name === 'postname' || name === 'post_id' ? '([^/]+)' : '(\\d+)';
    cursor = (token.index ?? 0) + token[0].length;
  }
  source += `${escapeRegExp(template.slice(cursor))}/?$`;
  const match = new RegExp(source).exec(path);
  if (!match) return null;
  const index = tokens.findIndex((token) => token[1] === 'postname' || token[1] === 'post_id');
  if (index < 0) return null;
  try {
    return decodeURIComponent(match[index + 1]);
  } catch {
    return null;
  }
}

function decodePath(path: string): string {
  try {
    return decodeURI(path).replace(/\/+$/, '') || '/';
  } catch {
    return path.replace(/\/+$/, '') || '/';
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
