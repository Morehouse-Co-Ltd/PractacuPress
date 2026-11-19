import { describe, expect, it } from 'vitest';
import type { Content } from '../types';
import {
  contentPermalink,
  DEFAULT_PERMALINKS,
  isValidPermalinkTemplate,
  matchContentPermalinks,
} from './permalinks';

const article = {
  id: 'art_42',
  kind: 'article',
  slug: 'quiet-yard',
  created_at: '2026-11-19T08:30:00Z',
  published_at: '2026-11-19T08:30:00Z',
} as Content;

describe('permalinks', () => {
  it('preserves the current route defaults', () => {
    expect(contentPermalink(article, DEFAULT_PERMALINKS)).toBe('/a/quiet-yard');
  });

  it('renders and matches date, numeric and custom formats', () => {
    expect(contentPermalink(article, { ...DEFAULT_PERMALINKS, article_structure: 'date_name' })).toBe(
      '/2026/11/19/quiet-yard',
    );
    expect(contentPermalink(article, { ...DEFAULT_PERMALINKS, article_structure: 'numeric' })).toBe(
      '/archives/art_42',
    );
    expect(
      contentPermalink(article, {
        ...DEFAULT_PERMALINKS,
        article_structure: 'custom',
        article_custom: '/story/%year%/%postname%-%post_id%',
      }),
    ).toBe('/story/2026/quiet-yard-art_42');
    expect(matchContentPermalinks('/2026/11/19/quiet-yard', {
      ...DEFAULT_PERMALINKS,
      article_structure: 'date_name',
    })).toContainEqual({ kind: 'article', key: 'quiet-yard' });
  });

  it('matches saved legacy aliases and validates custom patterns', () => {
    expect(matchContentPermalinks('/a/quiet-yard', {
      ...DEFAULT_PERMALINKS,
      article_structure: 'post_name',
      article_aliases: [{ structure: 'legacy' }],
    })).toContainEqual({ kind: 'article', key: 'quiet-yard' });
    expect(isValidPermalinkTemplate('/%year%/%postname%')).toBe(true);
    expect(isValidPermalinkTemplate('/%year%')).toBe(false);
    expect(isValidPermalinkTemplate('/%postname%?preview=1')).toBe(false);
  });
});
