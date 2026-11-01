import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOADING,
  loadingEnabled,
  loadingPalette,
  readLoading,
} from './loading';

describe('readLoading', () => {
  it('returns defaults for legacy configs', () => {
    expect(readLoading({})).toEqual(DEFAULT_LOADING);
    expect(loadingEnabled(readLoading({}))).toBe(false);
  });

  it('clamps values and rejects unknown presets', () => {
    const settings = readLoading({
      loading: {
        enabled: true,
        preset: 'explode' as never,
        text: 'x'.repeat(100),
        accent_mode: 'custom',
        accent: 'not-a-color',
        background_mode: 'custom',
        background: '#123abc',
        size: 999,
        min_duration_ms: 99999,
        show_on_first_load: true,
        show_on_navigation: false,
        custom_css: 'body{}'.repeat(1000),
      },
    });
    expect(settings.preset).toBe('spinner');
    expect(settings.text).toHaveLength(80);
    expect(settings.accent).toBe(DEFAULT_LOADING.accent);
    expect(settings.background).toBe('#123abc');
    expect(settings.size).toBe(160);
    expect(settings.min_duration_ms).toBe(3000);
    expect(settings.custom_css).toHaveLength(4000);
  });
});

describe('loadingPalette', () => {
  it('follows the theme unless a custom colour is selected', () => {
    const theme = { background: '#fff', ink: '#111', accent: '#0a0' };
    expect(loadingPalette(DEFAULT_LOADING, theme)).toEqual(theme);
    const custom = { ...DEFAULT_LOADING, accent_mode: 'custom' as const, accent: '#abcdef' };
    expect(loadingPalette(custom, theme)).toEqual({ ...theme, accent: '#abcdef' });
  });
});

describe('loadingEnabled', () => {
  it('requires both the master switch and at least one display moment', () => {
    expect(loadingEnabled({ ...DEFAULT_LOADING, enabled: true })).toBe(true);
    expect(
      loadingEnabled({
        ...DEFAULT_LOADING,
        enabled: true,
        show_on_first_load: false,
        show_on_navigation: false,
      }),
    ).toBe(false);
    expect(loadingEnabled({ ...DEFAULT_LOADING, enabled: false })).toBe(false);
  });
});
