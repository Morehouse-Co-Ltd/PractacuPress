import { describe, expect, it } from 'vitest';
import { INSTALL_DEFAULT_THEME_ID, installCustomization } from './customize';
import { builtinThemeBundle } from './themes';
import { normalizeThemeSettings } from './theme';

describe('安装完成后的默认站点设计', () => {
  it('默认使用沉思主题（浅色 + 单栏），不再依赖向导里的主题选择', () => {
    const customization = installCustomization('zh-CN');
    const contemplation = builtinThemeBundle(INSTALL_DEFAULT_THEME_ID);

    expect(INSTALL_DEFAULT_THEME_ID).toBe('contemplation');
    expect(contemplation).not.toBeNull();
    expect(customization.active_theme).toBe('contemplation');
    expect(customization.theme).toEqual(contemplation!.theme);
    expect(customization.theme.preset).toBe('contemplation');
    expect(customization.theme.mode).toBe('light');
    expect(customization.layout.variant).toBe('classic');
    expect(customization.home.blocks[0]?.type).toBe('classic-hero');
    expect(customization.home.blocks).toHaveLength(3);
  });

  it('安装时选择的语言继续写进站点设计', () => {
    expect(installCustomization('en').language).toBe('en');
    expect(installCustomization('zh-CN').language).toBe('zh-CN');
  });

  it('安装向导选的前台正文字号写进主题，越界值按主题规则收敛', () => {
    const larger = installCustomization('zh-CN', 19.5);
    expect(larger.theme.body_size).toBe(19.5);
    expect(larger.active_theme).toBe(INSTALL_DEFAULT_THEME_ID);
    // 越界输入交给主题归一化处理，而不是把非法值写进站点设计。
    expect(installCustomization('zh-CN', 99).theme.body_size).toBe(20);
    expect(installCustomization('zh-CN', 1).theme.body_size).toBe(14);
    // 不传时保持内置主题原值，和既有安装契约一致。
    expect(installCustomization('zh-CN').theme.body_size).toBe(
      builtinThemeBundle(INSTALL_DEFAULT_THEME_ID)!.theme.body_size,
    );
    expect(normalizeThemeSettings(installCustomization('zh-CN', 19.5).theme).body_size).toBe(19.5);
  });
});
