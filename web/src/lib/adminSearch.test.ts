import { describe, expect, it } from 'vitest';
import {
  isPaletteShortcut,
  moveActiveIndex,
  searchAdminEntries,
  type AdminSearchEntry,
} from './adminSearch';

/**
 * 后台命令面板的纯逻辑测试。
 *
 * 数据刻意混着中英两种语言：「英文界面 + 中文原文关键词」是最容易漏掉的组合，
 * 而中文界面下 label 与关键词恰好相同，不能因为「恰好能搜到」就放过英文场景。
 */
const ENTRIES: AdminSearchEntry[] = [
  { id: 'dashboard', label: '仪表盘', group: '概览', to: '/admin', icon: 'home' },
  {
    id: 'content',
    label: 'Content library',
    group: 'Content',
    to: '/admin/content',
    icon: 'file',
    keywords: ['内容库'],
  },
  {
    id: 'media',
    label: 'Media library',
    group: 'Content',
    to: '/admin/media',
    icon: 'image',
    keywords: ['媒体库'],
  },
  {
    id: 'settings',
    label: 'Site settings',
    group: 'Site',
    to: '/admin/settings',
    icon: 'settings',
    keywords: ['站点设置'],
  },
  {
    id: 'pages',
    label: 'Pages',
    group: 'Content',
    to: '/admin/pages',
    icon: 'layers',
    keywords: ['页面'],
  },
  {
    id: 'ext-system',
    label: 'Performance panel',
    group: 'Extensions',
    to: '/admin/ext/system',
    icon: 'activity',
    keywords: ['性能面板'],
  },
];

function ids(entries: AdminSearchEntry[]): string[] {
  return entries.map((entry) => entry.id);
}

describe('searchAdminEntries', () => {
  it('空查询与纯空白查询返回全部条目且保持原顺序', () => {
    expect(searchAdminEntries(ENTRIES, '')).toEqual(ENTRIES);
    expect(searchAdminEntries(ENTRIES, '   ')).toEqual(ENTRIES);
    expect(ids(searchAdminEntries(ENTRIES, ''))).toEqual(ENTRIES.map((entry) => entry.id));
  });

  it('空目录加任意查询都返回空数组（面板据此渲染空态）', () => {
    expect(searchAdminEntries([], 'content')).toEqual([]);
    expect(searchAdminEntries([], '')).toEqual([]);
  });

  it('按当前语言 label 匹配，大小写不敏感', () => {
    expect(ids(searchAdminEntries(ENTRIES, 'MEDIA'))).toEqual(['media']);
    expect(ids(searchAdminEntries(ENTRIES, 'mEdIa LiBrArY'))).toEqual(['media']);
    expect(ids(searchAdminEntries(ENTRIES, '  site settings  '))).toEqual(['settings']);
    // 中文没有大小写，按 label 原样命中。
    expect(ids(searchAdminEntries(ENTRIES, '仪表盘'))).toEqual(['dashboard']);
  });

  it('英文界面下也能用中文原文关键词命中', () => {
    expect(ids(searchAdminEntries(ENTRIES, '媒体'))).toEqual(['media']);
    expect(ids(searchAdminEntries(ENTRIES, '内容库'))).toEqual(['content']);
    expect(ids(searchAdminEntries(ENTRIES, '性能面板'))).toEqual(['ext-system']);
  });

  it('按路由匹配，扩展页 /admin/ext/:pageId 也能搜到', () => {
    expect(ids(searchAdminEntries(ENTRIES, '/admin/ext/system'))).toEqual(['ext-system']);
    expect(ids(searchAdminEntries(ENTRIES, '/admin/media'))).toEqual(['media']);
    // 路由前缀命中：更长的具体路径优先于它的父路径。
    const pages: AdminSearchEntry[] = [
      { id: 'new-page', label: 'New page', group: 'Content', to: '/admin/pages/new' },
      { id: 'pages', label: 'Pages', group: 'Content', to: '/admin/pages' },
    ];
    expect(ids(searchAdminEntries(pages, '/admin/pages/new'))).toEqual(['new-page']);
  });

  it('前缀命中排前、包含命中排后，且不改变同等级的原顺序', () => {
    const entries: AdminSearchEntry[] = [
      // 先给出「包含命中」，排序后应当排在「前缀命中」后面。
      { id: 'new-page', label: 'Create new page', group: 'Content', to: '/admin/pages/new' },
      { id: 'page-list', label: 'Pages', group: 'Content', to: '/admin/pages' },
      { id: 'page-templates', label: 'Page templates', group: 'Content', to: '/admin/templates' },
      { id: 'unrelated', label: 'Users', group: 'Users', to: '/admin/users' },
    ];
    expect(ids(searchAdminEntries(entries, 'page'))).toEqual([
      'page-list',
      'page-templates',
      'new-page',
    ]);
  });

  it('关键词命中也能排序，路由命中排在最后', () => {
    const entries: AdminSearchEntry[] = [
      // 路由包含 query，只能算最后一级命中。
      { id: 'by-route', label: 'Backups', group: 'Site', to: '/admin/data/site-copy' },
      // 当前语言的 label 以 query 开头，排最前。
      { id: 'by-label', label: 'Copy settings', group: 'Site', to: '/admin/settings-copy' },
      // 中文原文关键词前缀命中，排在 label 之后、路由之前。
      { id: 'by-keyword', label: 'Mirror', group: 'Site', to: '/admin/mirror', keywords: ['站点复制'] },
    ];
    expect(ids(searchAdminEntries(entries, '站点复制'))).toEqual(['by-keyword']);
    expect(ids(searchAdminEntries(entries, 'copy'))).toEqual(['by-label', 'by-route']);
  });

  it('无命中返回空数组', () => {
    expect(searchAdminEntries(ENTRIES, 'zzz-not-a-feature')).toEqual([]);
  });

  it('一条查询可以同时命中多条，且结果按排序等级分组', () => {
    const entries: AdminSearchEntry[] = [
      { id: 'contains', label: 'Insert image', group: 'Content', to: '/admin/insert' },
      { id: 'prefix', label: 'Image library', group: 'Content', to: '/admin/media' },
      { id: 'route', label: 'Uploads', group: 'Content', to: '/admin/image-copy' },
    ];
    expect(ids(searchAdminEntries(entries, 'image'))).toEqual(['prefix', 'contains', 'route']);
  });
});

describe('moveActiveIndex', () => {
  it('在列表范围内上下移动', () => {
    expect(moveActiveIndex(0, 3, 1)).toBe(1);
    expect(moveActiveIndex(2, 3, -1)).toBe(1);
  });

  it('到两端停住，不循环', () => {
    expect(moveActiveIndex(0, 3, -1)).toBe(0);
    expect(moveActiveIndex(2, 3, 1)).toBe(2);
  });

  it('空列表永远返回 0', () => {
    expect(moveActiveIndex(0, 0, 1)).toBe(0);
    expect(moveActiveIndex(5, 0, -1)).toBe(0);
  });
});

describe('isPaletteShortcut', () => {
  it('识别 Ctrl+K 与 Cmd+K（大小写都认）', () => {
    expect(isPaletteShortcut({ key: 'k', ctrlKey: true })).toBe(true);
    expect(isPaletteShortcut({ key: 'K', ctrlKey: true })).toBe(true);
    expect(isPaletteShortcut({ key: 'k', metaKey: true })).toBe(true);
  });

  it('普通输入与其它组合键不劫持', () => {
    expect(isPaletteShortcut({ key: 'k' })).toBe(false);
    expect(isPaletteShortcut({ key: 'a', ctrlKey: true })).toBe(false);
    expect(isPaletteShortcut({ key: 'k', ctrlKey: true, altKey: true })).toBe(false);
    expect(isPaletteShortcut({ key: 'k', ctrlKey: true, shiftKey: true })).toBe(false);
    expect(isPaletteShortcut({ key: 'K', shiftKey: true })).toBe(false);
  });
});
