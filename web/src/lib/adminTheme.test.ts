import { beforeEach, describe, expect, it } from 'vitest';
import { readCustomization } from './customize';
import { DEFAULT_THEME, themeCss } from './theme';
import { ADMIN_THEME_KEY, readAdminTheme, setAdminTheme } from './adminTheme';

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.adminTheme;
  document.cookie = 'pp_theme=; Max-Age=0; Path=/';
});

describe('admin theme preference', () => {
  it('defaults to light and persists the choice', () => {
    expect(readAdminTheme()).toBe('light');
    setAdminTheme('dark');
    expect(localStorage.getItem(ADMIN_THEME_KEY)).toBe('dark');
    expect(readAdminTheme()).toBe('dark');
    expect(document.cookie).not.toContain('pp_theme=dark');
  });

  it('treats unknown or unavailable storage as light', () => {
    localStorage.setItem(ADMIN_THEME_KEY, 'sepia');
    expect(readAdminTheme()).toBe('light');
  });
});

describe('admin dark tokens in theme css', () => {
  const customization = readCustomization({
    customization: {
      theme: { ...DEFAULT_THEME, preset: 'night', mode: 'dark' },
      layout: { variant: 'bento' },
    },
  } as never);

  it('emits a separate dark admin block without touching the site root', () => {
    const output = themeCss(customization, 'light');
    const root = output.slice(output.indexOf(':root {'), output.indexOf('html[data-surface="admin"]'));

    expect(root).not.toContain('--admin-panel');
    expect(output).toContain('html[data-surface="admin"][data-admin-theme="dark"]');
    expect(output).toContain('--admin-panel: #ffffff;');
    expect(output).toContain('--admin-panel: #12151b;');
    expect(output).toContain('--admin-glow: #0f141d;');
  });
});
