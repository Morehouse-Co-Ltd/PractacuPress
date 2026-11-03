import { describe, expect, it } from 'vitest';
import { defaultHomeLayout } from './blocks';
import { readCustomization } from './customize';
import { DEFAULT_THEME } from './theme';
import { builtinThemeBundle } from './themes';
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
    expect(sameLayout(patch.home, defaultHomeLayout('bento'))).toBe(true);
  });

  it('keeps a hand-built home layout when the variant changes', () => {
    const custom = {
      ...base,
      home: { blocks: [{ id: 'custom-block', type: 'text', props: {} }] },
    } as never;
    const night = builtinThemeBundle('night')!;
    const { patch, homeWasDefault } = themeApplyPatch(custom, night);
    expect(homeWasDefault).toBe(false);
    expect(patch.home).toBeUndefined();
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
    expect(copied.tokens).toEqual({ muted: '#6b6b6b' });
    expect(copied.tokens).not.toBe(theme.tokens);
    copied.tokens!.muted = '#111111';
    expect(theme.tokens.muted).toBe('#6b6b6b');
  });
});
