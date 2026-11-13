import { beforeEach, describe, expect, it } from 'vitest';
import { readCustomization } from './customize';
import { DEFAULT_THEME, normalizeThemeSettings, readableInk, themeCss } from './theme';
import {
  applyBootThemePreference,
  readThemePreference,
  setThemePreference,
} from './themePreference';

function clearThemeCookie() {
  document.cookie = 'pp_theme=; Max-Age=0; Path=/';
}

beforeEach(() => {
  clearThemeCookie();
});

describe('theme preference cookie', () => {
  it('reads and writes a browser-local mode', () => {
    expect(readThemePreference()).toBeNull();
    setThemePreference('dark');
    expect(readThemePreference()).toBe('dark');
    setThemePreference('light');
    expect(readThemePreference()).toBe('light');
    setThemePreference(null);
    expect(readThemePreference()).toBeNull();
  });

  it('applies the cookie before React boots and falls back to the site mode', () => {
    expect(applyBootThemePreference('light')).toBe('light');
    setThemePreference('dark');
    expect(applyBootThemePreference('light')).toBe('dark');
    expect(document.documentElement.dataset.mode).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });
});

describe('theme css mode override', () => {
  const customization = readCustomization({
    customization: {
      theme: { ...DEFAULT_THEME, preset: 'night', mode: 'dark' },
      layout: { variant: 'bento' },
    },
  } as never);

  it('emits the light token set when the reader prefers light', () => {
    const dark = themeCss(customization);
    const light = themeCss(customization, 'light');
    expect(dark).toContain('--bg: #0b0d11;');
    expect(light).toContain('--bg: #f7f8fa;');
    expect(dark).not.toBe(light);
  });

  it('keeps the installer on paper tokens regardless of the selected mode', () => {
    const css = themeCss(customization, 'dark');
    expect(css).toContain('html[data-surface="setup"]');
    expect(css).toContain('html[data-surface="admin"] body');
    expect(css).toContain('--bg: #ffffff;');
  });

  it('falls back to black or white when a preview pair has no contrast', () => {
    expect(readableInk('#ffffff', '#f7f7f7')).toBe('#101318');
    expect(readableInk('#000000', '#111111')).toBe('#f7f8fa');
    expect(readableInk('#ffffff', '#111111')).toBe('#111111');
  });

  it('keeps unknown token values from leaking into the preview helper', () => {
    expect(readableInk('color-mix(in srgb, #fff 50%, #000)', '#ffffff')).toBe('#ffffff');
    expect(normalizeThemeSettings({ preset: 'night', mode: 'dark' }).preset).toBe('night');
  });
});
