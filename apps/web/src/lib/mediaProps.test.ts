import { describe, expect, it } from 'vitest';
import { normalizeBlockProps, normalizeMediaUrl } from './customize';

describe('normalizeMediaUrl', () => {
  it('接受站内媒体地址、绝对 http(s) 与站内路径', () => {
    expect(normalizeMediaUrl('/api/v1/media/abc')).toBe('/api/v1/media/abc');
    expect(normalizeMediaUrl('https://cdn.example.com/a.png')).toBe('https://cdn.example.com/a.png');
    expect(normalizeMediaUrl('/img/a.png')).toBe('/img/a.png');
  });

  it('拒绝 data URL、javascript 与相对路径', () => {
    expect(normalizeMediaUrl('data:image/png;base64,AAAA')).toBeUndefined();
    expect(normalizeMediaUrl('javascript:alert(1)')).toBeUndefined();
    expect(normalizeMediaUrl('img/a.png')).toBeUndefined();
    expect(normalizeMediaUrl('')).toBeUndefined();
  });
});

describe('image 区块的 src', () => {
  it('走 media 白名单', () => {
    const props = normalizeBlockProps('image', { src: 'data:image/png;base64,AAAA', alt: '图' });
    expect(props.src).toBeUndefined();
    expect(props.alt).toBe('图');
  });

  // 新建图片区块的默认 src 是空串。空串不是可展示的媒体地址，但它必须留在
  // props 里：否则同一份默认值读一次就少一个键，表单与导出都会抖动。
  it('空 src 读入后仍然保留', () => {
    const props = normalizeBlockProps('image', { src: '   ', alt: '' });
    expect(props.src).toBe('');
  });
});
