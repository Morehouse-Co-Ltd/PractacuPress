import { describe, expect, it } from 'vitest';
import {
  BLOCK_SKELETON_SHAPES,
  DEFAULT_LOADING,
  SKELETON_PRESETS,
  loadingApproach,
  loadingEnabled,
  loadingPalette,
  readLoading,
  skeletonMotion,
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

describe('in-place skeleton presets', () => {
  it('reads back every new preset instead of falling back to spinner', () => {
    for (const preset of SKELETON_PRESETS) {
      const settings = readLoading({
        loading: { ...DEFAULT_LOADING, enabled: true, preset },
      });
      expect(settings.preset).toBe(preset);
    }
  });

  it('still rejects unknown presets', () => {
    const settings = readLoading({
      loading: { ...DEFAULT_LOADING, preset: 'skeleton-ghost' as never },
    });
    expect(settings.preset).toBe('spinner');
  });
});

describe('loadingApproach', () => {
  const enabled = { ...DEFAULT_LOADING, enabled: true };

  it('is off when loading is disabled', () => {
    expect(loadingApproach({ ...enabled, enabled: false, preset: 'skeleton' })).toBe('off');
  });

  it('uses skeleton mode regardless of the display-moment switches', () => {
    expect(
      loadingApproach({
        ...enabled,
        preset: 'skeleton-shimmer',
        show_on_first_load: false,
        show_on_navigation: false,
      }),
    ).toBe('skeleton');
  });

  it('keeps the overlay for the original presets', () => {
    expect(
      loadingApproach({
        ...enabled,
        preset: 'spinner',
        show_on_first_load: true,
        show_on_navigation: false,
      }),
    ).toBe('overlay');
    expect(
      loadingApproach({
        ...enabled,
        preset: 'spinner',
        show_on_first_load: false,
        show_on_navigation: false,
      }),
    ).toBe('off');
  });
});

describe('skeletonMotion', () => {
  it('maps each skeleton preset to its motion', () => {
    expect(skeletonMotion({ ...DEFAULT_LOADING, preset: 'skeleton' })).toBe('pulse');
    expect(skeletonMotion({ ...DEFAULT_LOADING, preset: 'shimmer' })).toBe('sweep');
    expect(skeletonMotion({ ...DEFAULT_LOADING, preset: 'skeleton-shimmer' })).toBe('both');
  });

  it('returns null for overlay presets', () => {
    expect(skeletonMotion({ ...DEFAULT_LOADING, preset: 'spinner' })).toBeNull();
    expect(skeletonMotion({ ...DEFAULT_LOADING, preset: 'orbit' })).toBeNull();
  });
});

describe('BLOCK_SKELETON_SHAPES', () => {
  it('registers feed-driven blocks only', () => {
    expect(BLOCK_SKELETON_SHAPES.feed).toBe('feed');
    expect(BLOCK_SKELETON_SHAPES['post-grid']).toBe('grid');
    expect(BLOCK_SKELETON_SHAPES['popular-content']).toBe('list');
    expect(BLOCK_SKELETON_SHAPES.text).toBeUndefined();
    expect(BLOCK_SKELETON_SHAPES.button).toBeUndefined();
    expect(BLOCK_SKELETON_SHAPES.image).toBeUndefined();
  });
});
