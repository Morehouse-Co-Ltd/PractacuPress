import { describe, expect, it } from 'vitest';
import { previewNavVerdict, staysOnPreviewPage } from './previewNav';

const origin = 'http://127.0.0.1:5173';

describe('previewNavVerdict', () => {
  it('放行页内锚点与空链接', () => {
    expect(previewNavVerdict('#team', { baseUrl: `${origin}/about` })).toBe('allow');
    expect(previewNavVerdict('', { baseUrl: `${origin}/about` })).toBe('allow');
    expect(previewNavVerdict('   ', { baseUrl: `${origin}/about` })).toBe('allow');
  });

  it('拦下站内跳转：导航 Tab、页脚、文章卡片都算离开', () => {
    expect(previewNavVerdict('/', { baseUrl: `${origin}/about` })).toBe('block');
    expect(previewNavVerdict('/articles', { baseUrl: `${origin}/` })).toBe('block');
    expect(previewNavVerdict('/a/42', { baseUrl: `${origin}/` })).toBe('block');
    expect(previewNavVerdict('/admin/theme', { baseUrl: `${origin}/` })).toBe('block');
    expect(previewNavVerdict('/search?q=hi', { baseUrl: `${origin}/` })).toBe('block');
  });

  it('把不同路径的外链也拦下：替换预览文档就等于离开了页面', () => {
    expect(previewNavVerdict('https://example.com', { baseUrl: `${origin}/` })).toBe('block');
  });

  it('同一路径算同一页：锚点与查询串变化都放行', () => {
    expect(previewNavVerdict('/about#team', { baseUrl: `${origin}/about` })).toBe('allow');
    expect(previewNavVerdict('/about?from=nav', { baseUrl: `${origin}/about` })).toBe('allow');
    expect(
      previewNavVerdict('http://127.0.0.1:5173/about', { baseUrl: `${origin}/about` }),
    ).toBe('allow');
  });

  it('新窗口、命名窗口与下载不替换预览文档，放行', () => {
    expect(
      previewNavVerdict('https://example.com', { baseUrl: `${origin}/`, target: '_blank' }),
    ).toBe('allow');
    expect(
      previewNavVerdict('https://example.com', { baseUrl: `${origin}/`, target: 'share' }),
    ).toBe('allow');
    expect(
      previewNavVerdict('/media/site.pdf', { baseUrl: `${origin}/`, download: true }),
    ).toBe('allow');
  });

  it('_self / _parent / _top 仍按普通跳转处理', () => {
    expect(previewNavVerdict('/articles', { baseUrl: `${origin}/`, target: '_self' })).toBe('block');
    expect(previewNavVerdict('/articles', { baseUrl: `${origin}/`, target: '_parent' })).toBe('block');
    expect(previewNavVerdict('/articles', { baseUrl: `${origin}/`, target: '_top' })).toBe('block');
  });

  it('邮件 / 电话协议交给系统处理，放行；脚本协议拦下', () => {
    expect(previewNavVerdict('mailto:a@example.com', { baseUrl: `${origin}/` })).toBe('allow');
    expect(previewNavVerdict('tel:10086', { baseUrl: `${origin}/` })).toBe('allow');
    expect(previewNavVerdict('javascript:alert(1)', { baseUrl: `${origin}/` })).toBe('block');
    expect(previewNavVerdict('data:text/html,<b>x</b>', { baseUrl: `${origin}/` })).toBe('block');
  });
});

describe('staysOnPreviewPage', () => {
  it('同一页的查询串与锚点变化不算离开', () => {
    expect(staysOnPreviewPage('/about', `${origin}/about`, origin)).toBe(true);
    expect(staysOnPreviewPage('/about', `${origin}/about#team`, origin)).toBe(true);
    expect(staysOnPreviewPage('/about', `${origin}/about?from=nav`, origin)).toBe(true);
    expect(staysOnPreviewPage('/', `${origin}/`, origin)).toBe(true);
  });

  it('换了路径或换了源都算离开', () => {
    expect(staysOnPreviewPage('/', `${origin}/articles`, origin)).toBe(false);
    expect(staysOnPreviewPage('/', 'https://example.com/', origin)).toBe(false);
    expect(staysOnPreviewPage('/about', 'about:blank', origin)).toBe(false);
  });
});
