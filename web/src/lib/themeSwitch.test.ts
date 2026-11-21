import { describe, expect, it } from 'vitest';
import { defaultHomeLayout } from './blocks';
import { readCustomization } from './customize';
import { DEFAULT_THEME } from './theme';
import { builtinThemeBundle, blankTheme } from './themes';
import { cloneTheme, sameLayout, themeApplyPatch } from './themeSwitch';

const base = readCustomization({
  customization: { theme: { ...DEFAULT_THEME }, layout: { variant: 'classic' } },
} as never);

describe('theme switching', () => {
  it('applies palette, variant and active id in one patch', () => {
    const night = builtinThemeBundle('night')!;
    const { patch, homeWasDefault } = themeApplyPatch(base, night);
    expect(homeWasDefault).toBe(true);
    expect(patch.active_theme).toBe('night');
    expect(patch.layout?.variant).toBe('bento');
    expect(patch.theme?.mode).toBe('dark');
    // 默认首页跟着版式换，但编排归到目标主题名下，而不是改写站点级 home。
    expect(patch.home).toBeUndefined();
    expect(sameLayout(patch.theme_layouts?.night?.home, defaultHomeLayout('bento'))).toBe(true);
  });

  it('applies a blank theme as the default theme with the classic layout', () => {
    const blank = blankTheme('空白主题');
    const { patch, homeWasDefault } = themeApplyPatch(base, blank);
    expect(homeWasDefault).toBe(false);
    expect(patch.active_theme).toBe(blank.id);
    expect(patch.layout?.variant).toBe('classic');
    expect(patch.theme?.preset).toBe(DEFAULT_THEME.preset);
    expect(patch.theme?.mode).toBe(DEFAULT_THEME.mode);
  });

  it('does not seed a default home when the theme already has its own blank layout', () => {
    const blank = blankTheme('空白主题');
    const customization = {
      ...base,
      theme_layouts: { [blank.id]: { home: { blocks: [] } } },
    };
    const { patch, homeWasDefault } = themeApplyPatch(customization, blank);
    expect(homeWasDefault).toBe(false);
    expect(patch.theme_layouts).toBeUndefined();
  });

  it('no longer offers the retired daylight theme', () => {
    expect(builtinThemeBundle('daylight')).toBeNull();
    const night = builtinThemeBundle('night')!;
    expect(night.variant).toBe('bento');
    expect(night.theme!.preset).toBe('night');
  });

  it('keeps a hand-built home layout when the variant changes', () => {
    const custom = {
      ...base,
      home: { blocks: [{ id: 'custom-block', type: 'text', props: {} }] },
    } as never;
    const night = builtinThemeBundle('night')!;
    const { patch, homeWasDefault } = themeApplyPatch(custom, night);
    expect(homeWasDefault).toBe(false);
    expect(patch.theme_layouts).toBeUndefined();
    expect(patch.layout?.variant).toBe('bento');
  });

  it('ignores generated block ids when comparing layouts', () => {
    const layout = defaultHomeLayout('classic');
    const clone = {
      ...layout,
      blocks: layout.blocks.map((block, index) => ({ ...block, id: `generated-${index}` })),
    };
    expect(sameLayout(layout, clone)).toBe(true);
    expect(sameLayout(layout, { blocks: [] })).toBe(false);
  });

  it('clones theme tokens instead of sharing them', () => {
    const theme = { ...DEFAULT_THEME, tokens: { muted: '#6b6b6b' } };
    const copied = cloneTheme(theme);
    expect(copied).toBeDefined();
    expect(copied!.tokens).toEqual({ muted: '#6b6b6b' });
    expect(copied!.tokens).not.toBe(theme.tokens);
    copied!.tokens!.muted = '#111111';
    expect(theme.tokens.muted).toBe('#6b6b6b');
  });
});
