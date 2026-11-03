import { describe, expect, it } from 'vitest';
import { isExternalUrl, safeUrl } from './safeUrl';

describe('safeUrl', () => {
  it('放行 http(s) 与站内绝对路径', () => {
    expect(safeUrl('https://example.com/a')).toBe('https://example.com/a');
    expect(safeUrl('http://example.com')).toBe('http://example.com');
    expect(safeUrl('/articles')).toBe('/articles');
    expect(safeUrl('  /media/x.png  ')).toBe('/media/x.png');
  });

  it('拒绝脚本协议、data URL、协议相对地址与相对片段', () => {
    expect(safeUrl('javascript:alert(1)')).toBe('');
    expect(safeUrl('JavaScript:alert(1)')).toBe('');
    expect(safeUrl('data:text/html,<script>')).toBe('');
    expect(safeUrl('//evil.example.com')).toBe('');
    expect(safeUrl('mailto:a@example.com')).toBe('');
    expect(safeUrl('foo/bar')).toBe('');
    expect(safeUrl('')).toBe('');
    expect(safeUrl(undefined)).toBe('');
    expect(safeUrl(42)).toBe('');
  });

  it('只把 http(s) 当作外部地址', () => {
    expect(isExternalUrl('https://example.com')).toBe(true);
    expect(isExternalUrl('/articles')).toBe(false);
    expect(isExternalUrl('')).toBe(false);
  });
});
