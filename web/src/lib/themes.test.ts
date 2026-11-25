import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, normalizeThemeSettings, presetTokens, themeCss } from './theme';
import { readCustomization } from './customize';
import {
  BUILTIN_THEMES,
  builtinThemeBundle,
  inferActiveTheme,
  parseThemeFile,
  themeMatches,
  variantLabel,
} from './themes';

describe('theme soften effects', () => {
  it('defaults old themes to soften off', () => {
    const theme = normalizeThemeSettings({ ...DEFAULT_THEME, soften: undefined });
    expect(theme.soften.enabled).toBe(false);
    expect(theme.soften.strength).toBe(45);
    expect(theme.soften.transition_ms).toBe(240);
  });

  it('clamps soften values and keeps boolean switches', () => {
    const theme = normalizeThemeSettings({
      ...DEFAULT_THEME,
      soften: {
        enabled: true,
        strength: 999,
        transition_ms: -20,
        gradient: false,
        blend_components: true,
        blur: 99,
      },
    });
    expect(theme.soften.enabled).toBe(true);
    expect(theme.soften.strength).toBe(100);
    expect(theme.soften.transition_ms).toBe(0);
    expect(theme.soften.blur).toBe(24);
    expect(theme.soften.gradient).toBe(false);
    expect(theme.soften.blend_components).toBe(true);
  });

  it('emits soften CSS variables and transition rules', () => {
    const css = themeCss(
      readCustomization({
        customization: {
          theme: {
            ...DEFAULT_THEME,
            soften: {
              enabled: true,
              strength: 70,
              transition_ms: 360,
              gradient: true,
              blend_components: true,
              blur: 12,
            },
          },
        },
      } as never),
    );
    expect(css).toContain('--soften-strength: 70');
    expect(css).toContain('--soften-ms: 360ms');
    expect(css).toContain('--soften-blur: 12px');
    expect(css).toContain('[data-soften="on"]');
    expect(css).toContain('[data-soften-blend="on"]');
    expect(css).toContain('prefers-reduced-motion');
  });
});

describe('built-in big themes', () => {
  it('bundles palette and layout variant together', () => {
    const original = builtinThemeBundle('default');
    const contemplation = builtinThemeBundle('contemplation');
    const night = builtinThemeBundle('night');
    expect(original?.name).toBe('原版');
    expect(original?.variant).toBe('classic');
    expect(builtinThemeBundle('daylight')).toBeNull();
    expect(contemplation?.name).toBe('沉思');
    expect(contemplation?.variant).toBe('classic');
    expect(contemplation?.theme.preset).toBe('contemplation');
    expect(contemplation?.theme.mode).toBe('light');
    expect(contemplation?.theme.heading_font).toBe('sans');
    expect(contemplation?.theme.body_size).toBe(18);
    expect(night?.name).toBe('夜航');
    expect(night?.variant).toBe('bento');
    expect(night?.theme.mode).toBe('dark');
    expect(variantLabel('bento')).toBe('双栏');
    expect(variantLabel('daylight')).toBe('卡片');
    expect(BUILTIN_THEMES).toHaveLength(3);
  });

  it('keeps both light and dark tokens for contemplation', () => {
    const light = presetTokens('contemplation', 'light');
    const dark = presetTokens('contemplation', 'dark');
    expect(light?.background).toBe('#faf9f6');
    expect(dark?.background).toBe('#111113');
    expect(light?.ink).not.toBe(dark?.ink);
    expect(light?.accent).not.toBe(dark?.accent);
  });

  it('matches only the full bundle, not just a colour', () => {
    const original = builtinThemeBundle('default');
    expect(original).not.toBeNull();
    expect(themeMatches(original!.theme, original!.variant, original!)).toBe(true);
    expect(
      themeMatches({ ...original!.theme, accent: '#ff0000' }, original!.variant, original!),
    ).toBe(false);
    expect(themeMatches(original!.theme, 'bento', original!)).toBe(false);
  });

  it('infers an active id for old configs', () => {
    const night = builtinThemeBundle('night')!;
    expect(inferActiveTheme(night.theme, night.variant)).toBe('night');
    expect(inferActiveTheme({ ...night.theme, accent: '#ff0000' }, night.variant)).toBe('custom');
  });
});

describe('theme file import', () => {
  it('parses a dedicated theme file', () => {
    const theme = parseThemeFile(
      JSON.stringify({
        kind: 'pp-theme',
        version: 1,
        name: '我的夜航',
        note: '暖色双栏',
        variant: 'bento',
        theme: { ...DEFAULT_THEME, accent: '#b45309' },
      }),
    );
    expect(theme.name).toBe('我的夜航');
    expect(theme.note).toBe('暖色双栏');
    expect(theme.variant).toBe('bento');
    expect(theme.theme.accent).toBe('#b45309');
    expect(theme.id).toMatch(/^theme_/);
  });

  it('accepts a full customization export and extracts only the theme', () => {
    const theme = parseThemeFile(
      JSON.stringify({
        version: 1,
        customization: {
          theme: { ...DEFAULT_THEME, background: '#101010', ink: '#ffffff' },
          layout: { variant: 'classic' },
          pages: [{ id: 'should-not-be-imported' }],
        },
      }),
    );
    expect(theme.name).toBe('导入的主题');
    expect(theme.variant).toBe('classic');
    expect(theme.theme.background).toBe('#101010');
    expect(theme.theme.ink).toBe('#ffffff');
  });

  it('rejects malformed files', () => {
    expect(() => parseThemeFile('not json')).toThrow(/JSON/);
    expect(() => parseThemeFile(JSON.stringify({ name: 'empty' }))).toThrow(/主题配置/);
  });
});

describe('readCustomization theme library', () => {
  it('keeps custom themes and the selected id', () => {
    const customization = readCustomization({
      customization: {
        theme: { ...DEFAULT_THEME },
        layout: { variant: 'classic' },
        active_theme: 'theme_custom',
        themes: [
          {
            id: 'theme_custom',
            name: '自定义',
            note: '测试',
            variant: 'bento',
            theme: { ...DEFAULT_THEME, accent: '#123456' },
          },
        ],
      },
    } as never);
    expect(customization.themes).toHaveLength(1);
    expect(customization.active_theme).toBe('theme_custom');
    expect(customization.themes?.[0].variant).toBe('bento');
  });

  it('infers the built-in theme for legacy customization', () => {
    const customization = readCustomization({
      customization: { theme: { ...DEFAULT_THEME }, layout: { variant: 'classic' } },
    } as never);
    expect(customization.active_theme).toBe('default');
  });

  it('folds a legacy daylight config into the night palette', () => {
    const customization = readCustomization({
      customization: {
        theme: {
          ...DEFAULT_THEME,
          preset: 'daylight',
          mode: 'light',
          background: '#fbfbfa',
          ink: '#111111',
          accent: '#2457f5',
        },
        layout: { variant: 'daylight' },
        active_theme: 'daylight',
      },
    } as never);
    // 版式仍然保留，旧文章页的卡片布局不会因为主题下架而塌掉。
    expect(customization.layout.variant).toBe('daylight');
    // 配色预设折算到夜航的冷白重配；旧 id 不再存在，按「自定义」处理。
    expect(customization.theme.preset).toBe('night');
    expect(customization.active_theme).toBe('custom');
  });
});
