import { describe, expect, it } from 'vitest';
import { INSTALL_DEFAULT_THEME_ID, installCustomization } from './customize';
import { builtinThemeBundle } from './themes';

describe('安装完成后的默认站点设计', () => {
  it('默认使用夜航主题（深色 + 双栏），不再依赖向导里的主题选择', () => {
    const customization = installCustomization('zh-CN');
    const night = builtinThemeBundle(INSTALL_DEFAULT_THEME_ID);

    expect(INSTALL_DEFAULT_THEME_ID).toBe('night');
    expect(night).not.toBeNull();
    expect(customization.active_theme).toBe('night');
    expect(customization.theme).toEqual(night!.theme);
    expect(customization.theme.preset).toBe('night');
    expect(customization.theme.mode).toBe('dark');
    expect(customization.layout.variant).toBe('bento');
    expect(customization.home.blocks[0]?.type).toBe('bento-hero');
    expect(customization.home.blocks).toHaveLength(8);
  });

  it('安装时选择的语言继续写进站点设计', () => {
    expect(installCustomization('en').language).toBe('en');
    expect(installCustomization('zh-CN').language).toBe('zh-CN');
  });
});
