import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DEFAULT_THEME } from '../../lib/theme';
import type { SiteTheme } from '../../types';
import { ThemePreview } from './ThemePreview';

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

function render(theme: SiteTheme, large = false): string {
  return renderToStaticMarkup(createElement(ThemePreview, { bundle: theme, large }));
}

describe('ThemePreview 渲染', () => {
  it('没有自带预览时用主题名作为品牌字，并画出结构块', () => {
    const html = render(bundle(), true);
    expect(html).toContain('Aurora');
    expect(html).toContain('theme-preview-media');
    expect(html).toContain('theme-preview-text');
  });

  it('渲染主题作者写的标题、导航与内容块', () => {
    const html = render(
      bundle({
        preview: {
          brand: 'AURORA',
          nav: ['首页', '文章'],
          kicker: '极光专题',
          title: '把光留在页面上',
          subtitle: '摄影与专题。',
          blocks: [
            { type: 'grid', weight: 2 },
            { type: 'quote', text: '慢慢读完。' },
            { type: 'button', text: '开始阅读' },
          ],
        },
      }),
      true,
    );
    expect(html).toContain('AURORA');
    expect(html).toContain('把光留在页面上');
    expect(html).toContain('慢慢读完。');
    expect(html).toContain('开始阅读');
  });

  it('预览文字按文本渲染，不会变成 HTML', () => {
    const html = render(
      bundle({
        preview: {
          title: '<script>alert(1)</script>',
          blocks: [{ type: 'text', text: '<img src=x onerror=alert(2)>' }],
        },
      }),
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;script&gt;');
  });

  it('palette 覆盖只影响这张预览，不改主题令牌', () => {
    const theme = bundle().theme;
    const html = render(
      bundle({ preview: { palette: { background: '#010203', accent: '#0a0b0c' } } }),
      true,
    );
    expect(html).toContain('background:#010203');
    expect(theme.background).toBe(DEFAULT_THEME.background);
  });
});
