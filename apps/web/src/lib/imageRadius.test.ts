import { describe, expect, it } from 'vitest';
import { IMAGE_RADIUS_OPTIONS, imageRadiusCss, normalizeImageRadius } from './imageRadius';

describe('imageRadius', () => {
  it('keeps known presets', () => {
    expect(normalizeImageRadius('none')).toBe('none');
    expect(normalizeImageRadius('lg')).toBe('lg');
    expect(normalizeImageRadius('theme')).toBe('theme');
  });

  it('falls back to theme for missing or forged values', () => {
    expect(normalizeImageRadius(undefined)).toBe('theme');
    expect(normalizeImageRadius('')).toBe('theme');
    expect(normalizeImageRadius('48')).toBe('theme');
    expect(normalizeImageRadius('999px')).toBe('theme');
    expect(normalizeImageRadius(12)).toBe('theme');
  });

  it('maps explicit presets to pixels and leaves theme to CSS', () => {
    expect(imageRadiusCss('theme')).toBeUndefined();
    expect(imageRadiusCss('none')).toBe('0px');
    expect(imageRadiusCss('sm')).toBe('8px');
    expect(imageRadiusCss('md')).toBe('12px');
    expect(imageRadiusCss('lg')).toBe('16px');
    expect(imageRadiusCss('xl')).toBe('24px');
    expect(imageRadiusCss('unknown')).toBeUndefined();
  });

  it('offers theme as the default option and keeps unique values', () => {
    expect(IMAGE_RADIUS_OPTIONS[0]).toEqual({ value: 'theme', label: '跟随主题' });
    const values = IMAGE_RADIUS_OPTIONS.map((option) => option.value);
    expect(new Set(values).size).toBe(values.length);
  });
});
