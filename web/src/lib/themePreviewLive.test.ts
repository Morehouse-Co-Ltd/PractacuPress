import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SiteTheme, WebConfig } from '../types';
import { readCustomization } from './customize';
import { DEFAULT_THEME } from './theme';
import {
  THEME_PREVIEW_PARAM,
  clearThemePreview,
  documentPreviewTheme,
  publishThemePreview,
  resetThemePreviewDocumentCache,
  themePreviewUrl,
} from './themePreviewLive';

function bundle(overrides: Partial<SiteTheme> = {}): SiteTheme {
  return {
    id: 'aurora',
    name: 'Aurora',
    note: '极光。',
    variant: 'bento',
    theme: {
      ...DEFAULT_THEME,
      mode: 'dark',
      background: '#010203',
      ink: '#f4f5ff',
      accent: '#0a0b0c',
      preset: 'night',
    },
    ...overrides,
  };
}

/** 和真实站点一样的最小配置：只看主题部分。 */
const siteConfig = {
  customization: { theme: { ...DEFAULT_THEME }, layout: { variant: 'classic' } },
} as unknown as WebConfig;

function enterPreview(token: string | null): void {
  window.history.replaceState(null, '', themePreviewUrl(token));
  resetThemePreviewDocumentCache();
}

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, '', '/');
  resetThemePreviewDocumentCache();
});

afterEach(() => {
  clearThemePreview();
  resetThemePreviewDocumentCache();
  window.history.replaceState(null, '', '/');
});

describe('真实前台主题预览的交接', () => {
  it('没有预览参数时，后台窗口不会认领任何主题', () => {
    publishThemePreview(bundle());
    expect(documentPreviewTheme()).toBeNull();
  });

  it('参数令牌与会话里的交接令牌一致时才认领主题', () => {
    const token = publishThemePreview(bundle());
    expect(token).toBeTruthy();
    enterPreview(token);
    expect(documentPreviewTheme()?.id).toBe('aurora');
  });

  it('令牌对不上（例如上一次预览的旧链接）时忽略交接数据', () => {
    const token = publishThemePreview(bundle());
    window.history.replaceState(
      null,
      '',
      themePreviewUrl(token ? `${token}x` : 'other'),
    );
    resetThemePreviewDocumentCache();
    expect(documentPreviewTheme()).toBeNull();
  });

  it('交接数据被清掉后，预览文档退回普通站点', () => {
    const token = publishThemePreview(bundle());
    enterPreview(token);
    expect(documentPreviewTheme()).not.toBeNull();
    clearThemePreview();
    resetThemePreviewDocumentCache();
    expect(documentPreviewTheme()).toBeNull();
  });

  it('预览地址带上参数，路径与参数一起保留', () => {
    expect(themePreviewUrl('abc', '/articles')).toBe('/articles?pp_theme_preview=abc');
    expect(themePreviewUrl('a b', '/')).toContain(`${THEME_PREVIEW_PARAM}=a%20b`);
    expect(themePreviewUrl(null, '/')).toBe('/');
  });
});

describe('预览主题叠加到站点设计', () => {
  it('在预览文档里，读取到的主题、版式与 active_theme 都是被预览的那套', () => {
    const token = publishThemePreview(bundle());
    enterPreview(token);
    const customization = readCustomization(siteConfig);
    expect(customization.theme.background).toBe('#010203');
    expect(customization.theme.ink).toBe('#f4f5ff');
    expect(customization.layout.variant).toBe('bento');
    expect(customization.active_theme).toBe('aurora');
  });

  it('普通文档（没有预览参数）读到原配置', () => {
    const customization = readCustomization(siteConfig);
    expect(customization.theme.background).toBe(DEFAULT_THEME.background);
    expect(customization.active_theme).not.toBe('aurora');
  });

  it('空白主题也能预览，渲染回落到默认主题与单栏', () => {
    const token = publishThemePreview({ id: 'blank', name: '空白', note: '' });
    enterPreview(token);
    const customization = readCustomization(siteConfig);
    expect(customization.active_theme).toBe('blank');
    expect(customization.layout.variant).toBe('classic');
    expect(customization.theme).toEqual(DEFAULT_THEME);
  });

  it('站点还没有自定义设计时，预览也照样套用主题', () => {
    const token = publishThemePreview(bundle());
    enterPreview(token);
    const customization = readCustomization({} as WebConfig);
    expect(customization.theme.background).toBe('#010203');
    expect(customization.layout.variant).toBe('bento');
  });

  it('预览只读：叠加不会写回传入的配置对象', () => {
    const token = publishThemePreview(bundle());
    enterPreview(token);
    const before = JSON.stringify(siteConfig);
    readCustomization(siteConfig);
    expect(JSON.stringify(siteConfig)).toBe(before);
  });
});
