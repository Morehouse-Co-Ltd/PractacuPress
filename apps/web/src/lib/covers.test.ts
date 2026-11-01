import { describe, expect, it } from 'vitest';
import type { ArticleCover } from '../types';
import {
  MAX_COVER_DATA_URL_CHARS,
  coverUrlError,
  normalizeCoverUrl,
} from './customize';
import {
  coverAlt,
  coverFor,
  coverFrameStyle,
  coverImageStyle,
  isCoverHidden,
  visibleCoverFor,
} from './covers';

const covers: ArticleCover[] = [
  { id: 'c1', url: 'https://example.com/cover.jpg', position: 'top' },
  { id: 'c2', url: '/uploads/local.webp', hidden: true },
  { id: 'c3', url: '' },
  { id: 'c4', url: 'data:image/png;base64,iVBORw0KGgo=' },
];

const customization = { covers };

describe('coverFor', () => {
  it('按内容 id 取出配置', () => {
    expect(coverFor(customization, 'c1')?.url).toBe('https://example.com/cover.jpg');
  });

  it('未知 id 与空 id 都返回 undefined', () => {
    expect(coverFor(customization, 'missing')).toBeUndefined();
    expect(coverFor(customization, undefined)).toBeUndefined();
  });
});

describe('visibleCoverFor', () => {
  it('正常配置可以直接显示', () => {
    expect(visibleCoverFor(customization, 'c1')?.id).toBe('c1');
  });

  it('隐藏的封面不显示', () => {
    expect(coverFor(customization, 'c2')?.hidden).toBe(true);
    expect(visibleCoverFor(customization, 'c2')).toBeUndefined();
  });

  it('没有地址的封面不显示', () => {
    expect(visibleCoverFor(customization, 'c3')).toBeUndefined();
  });

  it('data URL 封面仍然可以显示', () => {
    expect(visibleCoverFor(customization, 'c4')?.id).toBe('c4');
  });
});

describe('isCoverHidden', () => {
  it('只有明确勾选隐藏时才为真', () => {
    expect(isCoverHidden(customization, 'c2')).toBe(true);
    expect(isCoverHidden(customization, 'c1')).toBe(false);
    expect(isCoverHidden(customization, 'c3')).toBe(false);
  });

  it('未知 id 与空 id 都按未隐藏处理', () => {
    expect(isCoverHidden(customization, 'missing')).toBe(false);
    expect(isCoverHidden(customization, undefined)).toBe(false);
  });
});

describe('normalizeCoverUrl', () => {
  it('接受 http(s) 地址并去掉首尾空白', () => {
    expect(normalizeCoverUrl('  https://example.com/a.png  ')).toBe('https://example.com/a.png');
    expect(normalizeCoverUrl('http://example.com/a.png')).toBe('http://example.com/a.png');
  });

  it('接受以 / 开头的站内路径', () => {
    expect(normalizeCoverUrl('/uploads/cover.png')).toBe('/uploads/cover.png');
    expect(normalizeCoverUrl(' /covers/2026.jpg ')).toBe('/covers/2026.jpg');
  });

  it('接受体积较小的 base64 图片', () => {
    const small = 'data:image/png;base64,iVBORw0KGgo=';
    expect(normalizeCoverUrl(small)).toBe(small);
    expect(normalizeCoverUrl('data:image/jpeg;base64,/9j/4AAQ')).toBe('data:image/jpeg;base64,/9j/4AAQ');
  });

  it('拒绝 javascript: 与 data:text/html', () => {
    expect(normalizeCoverUrl('javascript:alert(1)')).toBe('');
    expect(normalizeCoverUrl('data:text/html;base64,PHNjcmlwdD4=')).toBe('');
  });

  it('接受 SVG 的 base64 与 percent-encode 写法', () => {
    const base64 = 'data:image/svg+xml;base64,PHN2Zy8+';
    expect(normalizeCoverUrl(base64)).toBe(base64);
    const encoded = 'data:image/svg+xml,%3Csvg%20xmlns=%22http://www.w3.org/2000/svg%22%3E%3C/svg%3E';
    expect(normalizeCoverUrl(encoded)).toBe(encoded);
  });

  it('拒绝把标签直接写进 SVG data URL', () => {
    expect(normalizeCoverUrl('data:image/svg+xml,<svg onload=alert(1)>')).toBe('');
  });

  it('拒绝协议相对地址与普通相对路径', () => {
    expect(normalizeCoverUrl('//evil.example/cover.png')).toBe('');
    expect(normalizeCoverUrl('covers/cover.png')).toBe('');
    expect(normalizeCoverUrl('ftp://example.com/cover.png')).toBe('');
  });

  it('拒绝超过上限的 data URL，而不是截断', () => {
    const tooLong = `data:image/png;base64,${'A'.repeat(MAX_COVER_DATA_URL_CHARS)}`;
    expect(tooLong.length).toBeGreaterThan(MAX_COVER_DATA_URL_CHARS);
    expect(normalizeCoverUrl(tooLong)).toBe('');
  });

  it('空值与非法类型返回空字符串', () => {
    expect(normalizeCoverUrl('')).toBe('');
    expect(normalizeCoverUrl('   ')).toBe('');
    expect(normalizeCoverUrl(undefined)).toBe('');
    expect(normalizeCoverUrl(42)).toBe('');
  });
});

describe('coverUrlError', () => {
  it('合法地址与空输入没有错误', () => {
    expect(coverUrlError('')).toBe('');
    expect(coverUrlError('https://example.com/a.png')).toBe('');
    expect(coverUrlError('/uploads/cover.png')).toBe('');
    expect(coverUrlError('data:image/png;base64,iVBORw0KGgo=')).toBe('');
    expect(coverUrlError('data:image/svg+xml;base64,PHN2Zy8+')).toBe('');
  });

  it('javascript: 给出可操作的提示', () => {
    expect(coverUrlError('javascript:alert(1)')).toContain('http');
  });

  it('非图片 data URL 提示支持的格式', () => {
    expect(coverUrlError('data:text/html;base64,PHNjcmlwdD4=')).toContain('svg');
  });

  it('超长图片提示 600 KB 以内', () => {
    const tooLong = `data:image/png;base64,${'A'.repeat(MAX_COVER_DATA_URL_CHARS)}`;
    expect(coverUrlError(tooLong)).toContain('600 KB');
  });
});

describe('coverImageStyle', () => {
  it('按焦点位置输出 objectPosition', () => {
    expect(coverImageStyle({ id: 'a', url: '/a.png', position: 'top' })).toMatchObject({
      objectFit: 'cover',
      objectPosition: '50% 0%',
    });
    expect(coverImageStyle({ id: 'a', url: '/a.png', position: 'bottom' })).toMatchObject({
      objectPosition: '50% 100%',
    });
    expect(coverImageStyle({ id: 'a', url: '/a.png', position: 'center' })).toMatchObject({
      objectPosition: '50% 50%',
    });
    expect(coverImageStyle({ id: 'a', url: '/a.png' })).toMatchObject({
      objectPosition: '50% 50%',
    });
  });

  it('传入比例时一并输出 aspectRatio', () => {
    expect(coverImageStyle({ id: 'a', url: '/a.png' }, '4 / 3')).toMatchObject({
      aspectRatio: '4 / 3',
    });
    expect(coverImageStyle({ id: 'a', url: '/a.png' })).not.toHaveProperty('aspectRatio');
  });
});

describe('coverFrameStyle', () => {
  it('只包装比例', () => {
    expect(coverFrameStyle('16 / 9')).toEqual({ aspectRatio: '16 / 9' });
    expect(coverFrameStyle()).toEqual({});
  });
});

describe('coverAlt', () => {
  it('优先使用配置里的 alt，留空时回退到标题', () => {
    expect(coverAlt({ id: 'a', url: '/a.png', alt: '封面说明' }, '文章标题')).toBe('封面说明');
    expect(coverAlt({ id: 'a', url: '/a.png', alt: '   ' }, '文章标题')).toBe('文章标题');
    expect(coverAlt({ id: 'a', url: '/a.png' }, '文章标题')).toBe('文章标题');
  });
});
