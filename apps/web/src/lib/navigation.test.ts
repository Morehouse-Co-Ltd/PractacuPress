import { describe, expect, it } from 'vitest';
import { readCustomization, DEFAULT_CUSTOMIZATION } from './customize';
import {
  MAX_FOOTER_COLUMNS,
  MAX_FOOTER_LINKS,
  MAX_NAV_CHILDREN,
  MAX_NAV_TABS,
  MAX_SOCIAL_LINKS,
  autoNavTabs,
  defaultFooterColumns,
  navIconName,
  navIconPositionOf,
  navSubStyleOf,
  navTabActive,
  navTabGroupActive,
  normalizeFooterColumns,
  normalizeNavTabs,
  normalizeSocialLinks,
  safeHref,
  siteNavTabs,
  socialIconName,
} from './navigation';

const pages = [
  { id: 'p1', title: '关于本站', slug: 'about', status: 'published', show_in_nav: true, created_at: '1' },
  { id: 'p2', title: '草稿页', slug: 'draft', status: 'draft', show_in_nav: true, created_at: '2' },
] as never[];

describe('导航 Tab', () => {
  it('自动模式用内置入口加已发布页面', () => {
    const tabs = autoNavTabs(DEFAULT_CUSTOMIZATION.layout, pages);
    expect(tabs.map((tab) => tab.label)).toEqual(['首页', '文章', '帖子', '搜索', '关于本站']);
  });

  it('自动模式遵守 show_* 开关', () => {
    const tabs = autoNavTabs({ ...DEFAULT_CUSTOMIZATION.layout, show_posts: false }, []);
    expect(tabs.some((tab) => tab.href === '/articles')).toBe(true);
    expect(tabs.some((tab) => tab.href === '/posts')).toBe(false);
  });

  it('配置过就完全按条目渲染，空数组即没有 Tab', () => {
    const layout = {
      ...DEFAULT_CUSTOMIZATION.layout,
      nav_tabs: [{ id: 't1', label: '首页', href: '/' }],
    };
    const state = siteNavTabs(layout, pages);
    expect(state.auto).toBe(false);
    expect(state.tabs).toHaveLength(1);
    expect(siteNavTabs({ ...layout, nav_tabs: [] }, pages).tabs).toHaveLength(0);
  });

  it('归一化丢弃空标题、改写重复 id 并限制数量', () => {
    const tabs = normalizeNavTabs([
      { id: 'dup', label: '', href: '/' },
      { id: 'dup', label: '一', href: '/a' },
      { id: 'dup', label: '二', href: '/b' },
      ...Array.from({ length: 20 }, (_, i) => ({ label: `T${i}`, href: `/t${i}` })),
    ]);
    expect(tabs).toBeTruthy();
    expect(tabs!.length).toBe(MAX_NAV_TABS);
    expect(new Set(tabs!.map((tab) => tab.id)).size).toBe(tabs!.length);
    expect(normalizeNavTabs(undefined)).toBeUndefined();
  });

  it('safeHref 只放行站内路径、锚点与 http(s)/mailto', () => {
    expect(safeHref('/about')).toBe('/about');
    expect(safeHref('https://example.com')).toBe('https://example.com');
    expect(safeHref('mailto:hi@example.com')).toBe('mailto:hi@example.com');
    expect(safeHref('#top')).toBe('#top');
    expect(safeHref('javascript:alert(1)')).toBe('');
    expect(safeHref('//evil.com')).toBe('');
    expect(safeHref('data:text/html,x')).toBe('');
  });

  it('高亮规则覆盖详情页且不做宽松前缀匹配', () => {
    expect(navTabActive('/a/a1', '/articles')).toBe(true);
    expect(navTabActive('/p/p1', '/posts')).toBe(true);
    expect(navTabActive('/about/team', '/about')).toBe(true);
    expect(navTabActive('/about-us', '/about')).toBe(false);
    expect(navTabActive('/', '/')).toBe(true);
    expect(navTabActive('/about', '/')).toBe(false);
  });

  it('二级入口命中时父 Tab 一起高亮', () => {
    const tab = {
      id: 't1',
      label: '文库',
      href: '/library',
      children: [
        { id: 'c1', label: '全部文章', href: '/articles' },
        { id: 'c2', label: '分类', href: '/categories' },
      ],
    };
    expect(navTabGroupActive('/library', tab)).toBe(true);
    expect(navTabGroupActive('/articles', tab)).toBe(true);
    expect(navTabGroupActive('/categories/news', tab)).toBe(true);
    expect(navTabGroupActive('/posts', tab)).toBe(false);
  });

  it('归一化图标、图标位置、二级入口与展示方式', () => {
    const tabs = normalizeNavTabs([
      {
        id: 't1',
        label: '文库',
        href: '/library',
        icon: 'file',
        icon_position: 'right',
        sub_style: 'dropdown',
        children: [
          { id: 'c1', label: '全部文章', href: '/articles', icon: 'layers' },
          { id: 'c2', label: '', href: '/bad' },
          ...Array.from({ length: 20 }, (_, i) => ({ label: `C${i}`, href: `/c${i}` })),
        ],
      },
      { id: 't2', label: '未知图标', href: '/x', icon: 'not-an-icon', icon_position: 'top' as never },
    ]);
    expect(tabs).toBeTruthy();
    const [first, second] = tabs!;
    expect(first.icon).toBe('file');
    expect(first.icon_position).toBe('right');
    expect(first.sub_style).toBe('dropdown');
    expect(first.children).toHaveLength(MAX_NAV_CHILDREN);
    expect(first.children![0].icon).toBe('layers');
    expect(second.icon).toBeUndefined();
    expect(second.icon_position).toBeUndefined();
    expect(navIconName('home')).toBe('home');
    expect(navIconName('nope')).toBeUndefined();
  });

  it('图标位置与二级样式回落到布局默认值', () => {
    const layout = { nav_icon_position: 'right' as const, nav_sub_style: 'dropdown' as const };
    expect(navIconPositionOf({ id: 'a', label: 'A', href: '/' }, layout)).toBe('right');
    expect(navSubStyleOf({ id: 'a', label: 'A', href: '/' }, layout)).toBe('dropdown');
    expect(
      navIconPositionOf({ id: 'a', label: 'A', href: '/', icon_position: 'none' }, layout),
    ).toBe('none');
    expect(navSubStyleOf({ id: 'a', label: 'A', href: '/', sub_style: 'bar' }, layout)).toBe('bar');
  });
});

describe('快捷链接', () => {
  it('归一化平台、文字并限制数量', () => {
    const links = normalizeSocialLinks([
      { id: 'g', platform: 'github', label: 'GitHub', url: 'https://github.com/me' },
      { platform: 'unknown', label: '', url: 'mailto:hi@example.com' },
      { platform: 'x', label: 'X', url: '' },
      ...Array.from({ length: 20 }, (_, i) => ({
        platform: 'website',
        label: `站点${i}`,
        url: `https://example.com/${i}`,
      })),
    ]);
    expect(links).toHaveLength(MAX_SOCIAL_LINKS);
    expect(links[0].platform).toBe('github');
    expect(links[1].platform).toBe('custom');
    expect(links[1].label).toBeTruthy();
    expect(links.some((link) => link.url === '')).toBe(false);
    expect(normalizeSocialLinks(undefined)).toEqual([]);
    expect(socialIconName('github')).toBe('github');
    expect(socialIconName('custom')).toBe('link');
  });
});

describe('页脚栏目', () => {
  it('默认两栏且可渲染', () => {
    const columns = defaultFooterColumns();
    expect(columns).toHaveLength(2);
    expect(columns[0].links.length).toBeGreaterThan(1);
  });

  it('坏配置回落到默认', () => {
    expect(normalizeFooterColumns('nope')).toHaveLength(2);
  });

  it('栏数与条目数都有上限', () => {
    const columns = normalizeFooterColumns(
      Array.from({ length: 9 }, (_, i) => ({
        title: `栏${i}`,
        links: Array.from({ length: 12 }, (_, j) => ({ label: `L${j}`, href: `/l${j}` })),
      })),
    );
    expect(columns).toHaveLength(MAX_FOOTER_COLUMNS);
    expect(columns.every((column) => column.links.length === MAX_FOOTER_LINKS)).toBe(true);
  });
});

describe('readCustomization 保留导航与页脚', () => {
  it('旧配置自动补默认页脚', () => {
    const customization = readCustomization({ customization: { theme: undefined } as never });
    expect(customization.layout.footer_columns.length).toBe(2);
    expect(customization.layout.nav_tabs).toBeUndefined();
  });

  it('自定义导航与页脚可往返', () => {
    const customization = readCustomization({
      customization: {
        layout: {
          nav_tabs: [{ id: 't1', label: '首页', href: '/' }],
          footer_columns: [{ id: 'c1', title: '关于', links: [{ id: 'l1', label: '写信', href: '/contact' }] }],
        },
      } as never,
    });
    expect(customization.layout.nav_tabs).toHaveLength(1);
    expect(customization.layout.footer_columns[0].links[0].label).toBe('写信');
  });
});
