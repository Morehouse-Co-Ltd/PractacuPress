import { describe, expect, it } from 'vitest';
import {
  CONTENT_SLUG_MAX_LENGTH,
  contentSlugFromTitle,
  isValidContentSlug,
} from './contentSlug';

describe('contentSlug', () => {
  it('keeps Chinese and other Unicode letters in the title', () => {
    expect(contentSlugFromTitle('中文标题')).toBe('中文标题');
    expect(contentSlugFromTitle('你好，世界！')).toBe('你好-世界');
    expect(contentSlugFromTitle('Café déjà vu')).toBe('café-déjà-vu');
    expect(contentSlugFromTitle('  A   B   C  ')).toBe('a-b-c');
  });

  it('falls back to an empty slug when the title has no letters or digits', () => {
    expect(contentSlugFromTitle('🎉！')).toBe('');
    expect(isValidContentSlug('')).toBe(false);
  });

  it('bounds the slug by characters and trims a trailing separator', () => {
    const slug = contentSlugFromTitle('中'.repeat(CONTENT_SLUG_MAX_LENGTH + 20));
    expect([...slug]).toHaveLength(CONTENT_SLUG_MAX_LENGTH);
    expect(contentSlugFromTitle('中'.repeat(CONTENT_SLUG_MAX_LENGTH) + '，下一段')).toHaveLength(slug.length);
  });

  it('validates manual Unicode slugs and rejects separators in the wrong place', () => {
    expect(isValidContentSlug('中文-标题')).toBe(true);
    expect(isValidContentSlug('café-déjà-vu')).toBe(true);
    expect(isValidContentSlug('中文 标题')).toBe(false);
    expect(isValidContentSlug('-中文')).toBe(false);
    expect(isValidContentSlug('中文-')).toBe(false);
    expect(isValidContentSlug('中文--标题')).toBe(false);
    expect(isValidContentSlug('🎉')).toBe(false);
  });
});
