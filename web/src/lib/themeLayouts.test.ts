import { describe, expect, it } from 'vitest';
import type { SiteCustomization, ThemeLayoutEntry } from '../types';
import {
  projectThemeLayouts,
  themeLayoutFor,
  withThemeLayout,
  withoutThemeLayout,
} from './themeLayouts';

/**
 * 按主题保存的编排。
 *
 * 这里只钉纯计算：投影、增加/删除、当前主题的解析。配置的归一化与 `update`
 * 路由由 `customize.test.ts` 覆盖。
 */

function customization(
  overrides: Partial<SiteCustomization> = {},
): SiteCustomization {
  return {
    theme: {
      preset: 'paper',
      mode: 'light',
      background: '#ffffff',
      ink: '#14140f',
      accent: '#1f5c4a',
      heading_font: 'serif',
      body_size: 17.5,
      content_width: 880,
      radius: 6,
      soften: {
        enabled: false,
        strength: 45,
        transition_ms: 240,
        gradient: true,
        blend_components: true,
        blur: 8,
      },
    },
    layout: { variant: 'classic' },
    active_theme: 'theme_a',
    home: { blocks: [{ id: 'legacy-home', type: 'text', props: {} }] },
    article: { blocks: [] },
    pages: [],
    ...overrides,
  } as SiteCustomization;
}

describe('按主题的编排', () => {
  it('读取当前主题的条目；没有条目时 undefined', () => {
    const withEntry = customization({
      theme_layouts: { theme_a: { home: { blocks: [] } } },
    });
    expect(themeLayoutFor(withEntry)).toEqual({ home: { blocks: [] } });
    expect(themeLayoutFor(withEntry, 'theme_b')).toBeUndefined();
    expect(themeLayoutFor(customization())).toBeUndefined();
  });

  it('投影只覆盖有条目的那一类，显式空白保留', () => {
    const base = customization({
      theme_layouts: {
        theme_a: {
          home: { blocks: [] },
          article: {
            blocks: [
              { id: 'a-art', type: 'text', title: '文章页', props: {}, animation: 'none', hidden: false },
            ],
          },
        },
      },
    });
    const projected = projectThemeLayouts(base);
    expect(projected.home.blocks).toHaveLength(0);
    expect(projected.article?.blocks[0]?.id).toBe('a-art');
  });

  it('没有当前主题条目时原样返回', () => {
    const base = customization();
    expect(projectThemeLayouts(base)).toBe(base);
  });

  it('写入不修改入参，并保留另一类编排', () => {
    const layouts: Record<string, ThemeLayoutEntry> = {
      theme_a: {
        article: {
          blocks: [
            { id: 'art', type: 'text', title: '文章页', props: {}, animation: 'none', hidden: false },
          ],
        },
      },
    };
    const next = withThemeLayout(layouts, 'theme_a', 'home', { blocks: [] });
    expect(layouts.theme_a.home).toBeUndefined();
    expect(next.theme_a.home).toEqual({ blocks: [] });
    expect(next.theme_a.article?.blocks[0]?.id).toBe('art');
  });

  it('删除主题时只移除该主题的条目', () => {
    const layouts = {
      theme_a: { home: { blocks: [] } },
      theme_b: { home: { blocks: [] } },
    };
    const next = withoutThemeLayout(layouts, 'theme_a');
    expect(next.theme_a).toBeUndefined();
    expect(next.theme_b).toBeDefined();
    expect(layouts.theme_a).toBeDefined();
    expect(withoutThemeLayout(undefined, 'theme_a')).toEqual({});
  });
});
