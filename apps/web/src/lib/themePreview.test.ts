import { describe, expect, it } from 'vitest';
import type { SiteTheme } from '../types';
import { DEFAULT_THEME } from './theme';
import {
  THEME_PREVIEW_LIMITS,
  cloneThemePreview,
  defaultThemePreview,
  normalizeThemePreview,
  resolveThemePreview,
} from './themePreview';

function bundle(overrides: Partial<SiteTheme> = {}): SiteTheme {
  return {
    id: 'aurora',
    name: 'Aurora',
    note: '极光。',
    variant: 'classic',
    theme: DEFAULT_THEME,
    ...overrides,
  };
}

describe('主题自带预览的归一化', () => {
  it('非对象与空对象都视为没有自带预览', () => {
    expect(normalizeThemePreview(undefined)).toBeUndefined();
    expect(normalizeThemePreview('preview')).toBeUndefined();
    expect(normalizeThemePreview([])).toBeUndefined();
    expect(normalizeThemePreview({})).toBeUndefined();
    expect(normalizeThemePreview({ nav: [], blocks: [] })).toBeUndefined();
  });

  it('压缩空白、截断文本并去掉空串', () => {
    const preview = normalizeThemePreview({
      brand: '  AURORA   STUDIO  ',
      kicker: '  ',
      title: '把光留在页面上',
      subtitle: 'x'.repeat(200),
    });
    expect(preview?.brand).toBe('AURORA STUDIO');
    expect(preview?.kicker).toBeUndefined();
    expect(preview?.title).toBe('把光留在页面上');
    expect(preview?.subtitle).toHaveLength(THEME_PREVIEW_LIMITS.subtitle);
  });

  it('导航最多 5 项，空项跳过', () => {
    const preview = normalizeThemePreview({
      nav: ['首页', ' ', '文章', '专题', '关于', '社区', '联系'],
    });
    expect(preview?.nav).toEqual(['首页', '文章', '专题', '关于', '社区']);
  });

  it('只保留合法块类型，weight 取整并夹在 1–3', () => {
    const preview = normalizeThemePreview({
      blocks: [
        { type: 'grid', weight: 9 },
        { type: 'unknown', text: 'x' },
        { type: 'text', weight: -2, text: '正文' },
        { type: 'media', text: '媒体块不接收文字' },
        { type: 'quote', text: ' 一句话 ' },
      ],
    });
    expect(preview?.blocks).toEqual([
      { type: 'grid', weight: 3 },
      { type: 'text', weight: 1, text: '正文' },
      { type: 'media' },
      { type: 'quote', text: '一句话' },
    ]);
  });

  it('块数量截断到上限', () => {
    const blocks = Array.from({ length: 20 }, () => ({ type: 'text' }));
    const preview = normalizeThemePreview({ blocks });
    expect(preview?.blocks).toHaveLength(THEME_PREVIEW_LIMITS.blocks);
  });

  it('配色只接受十六进制，非法值丢弃', () => {
    const preview = normalizeThemePreview({
      palette: {
        background: '#0B0F18',
        ink: 'color-mix(in srgb, #fff 50%, #000)',
        accent: 'var(--accent)',
        extra: '#ffffff',
      },
    });
    expect(preview?.palette).toEqual({ background: '#0b0f18' });
  });
});

describe('预览兜底与配色', () => {
  it('没有自带预览时按版式生成结构预览', () => {
    expect(defaultThemePreview('classic').blocks?.map((item) => item.type)).toEqual([
      'media',
      'text',
      'text',
    ]);
    expect(defaultThemePreview('bento').blocks?.[0].type).toBe('grid');
    expect(defaultThemePreview('daylight').blocks?.[0].type).toBe('grid');
  });

  it('自带预览优先，配色可以从 palette 覆盖', () => {
    const authored = normalizeThemePreview({
      title: '把光留在页面上',
      palette: { background: '#0b0f18', accent: '#7aa2ff' },
    });
    const resolved = resolveThemePreview(bundle({ preview: authored }));
    expect(resolved.authored).toBe(true);
    expect(resolved.spec.title).toBe('把光留在页面上');
    expect(resolved.palette.background).toBe('#0b0f18');
    expect(resolved.palette.ink).toBe(DEFAULT_THEME.ink);
    expect(resolved.palette.accent).toBe('#7aa2ff');
    // 只写标题 / 配色时，内容块按版式补全。
    expect(resolved.spec.blocks?.length).toBeGreaterThan(0);
  });

  it('没有自带预览时 authored 为 false，配色取主题令牌', () => {
    const resolved = resolveThemePreview(bundle({ variant: 'bento' }));
    expect(resolved.authored).toBe(false);
    expect(resolved.palette).toEqual({
      background: DEFAULT_THEME.background,
      ink: DEFAULT_THEME.ink,
      accent: DEFAULT_THEME.accent,
    });
  });

  it('克隆后修改嵌套字段不会影响原预览', () => {
    const preview = normalizeThemePreview({
      nav: ['首页'],
      blocks: [{ type: 'text' }],
      palette: { accent: '#123456' },
    })!;
    const copy = cloneThemePreview(preview);
    copy.nav!.push('文章');
    copy.blocks![0].text = '改过';
    copy.palette!.accent = '#000000';
    expect(preview.nav).toEqual(['首页']);
    expect(preview.blocks?.[0].text).toBeUndefined();
    expect(preview.palette?.accent).toBe('#123456');
  });
});
