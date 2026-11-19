import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT, readCustomization } from './customize';
import { footerBrand, parseFooterTags } from './navigation';

describe('页脚品牌区', () => {
  it('留空时回退到站点名称、品牌副标题与站点简介', () => {
    const brand = footerBrand(DEFAULT_LAYOUT, '纸房子', '一间编辑部。');
    expect(brand.name).toBe('纸房子');
    expect(brand.sub).toBe(DEFAULT_LAYOUT.brand_sub);
    expect(brand.description).toBe('一间编辑部。');
    expect(brand.tags).toEqual([]);
    expect(brand.showTags).toBe(true);
  });

  it('自定义内容优先于站点信息', () => {
    const brand = footerBrand(
      {
        ...DEFAULT_LAYOUT,
        footer_brand_name: '夜航编辑部',
        footer_brand_sub: 'NIGHT FLIGHT',
        footer_brand_desc: '写给夜里写作的人。',
        footer_show_tags: false,
      },
      '纸房子',
      '一间编辑部。',
    );
    expect(brand.name).toBe('夜航编辑部');
    expect(brand.sub).toBe('NIGHT FLIGHT');
    expect(brand.description).toBe('写给夜里写作的人。');
    expect(brand.showTags).toBe(false);
  });

  it('自定义标签支持中英文逗号与顿号，去重且最多 4 个', () => {
    expect(parseFooterTags('独立出版，写作、社区, 独立出版')).toEqual(['独立出版', '写作', '社区']);
    expect(parseFooterTags('a,b,c,d,e')).toEqual(['a', 'b', 'c', 'd']);
    expect(parseFooterTags('  ')).toEqual([]);
  });

  it('readCustomization 保留页脚自定义字段，并兼容旧配置', () => {
    const next = readCustomization({
      customization: {
        layout: {
          footer_brand_name: '页脚名',
          footer_brand_sub: '页脚副标题',
          footer_brand_desc: '页脚简介',
          footer_show_tags: false,
          footer_tags: '写作、社区',
          footer_note: '',
        },
      },
    } as never);
    expect(next.layout.footer_brand_name).toBe('页脚名');
    expect(next.layout.footer_brand_sub).toBe('页脚副标题');
    expect(next.layout.footer_brand_desc).toBe('页脚简介');
    expect(next.layout.footer_show_tags).toBe(false);
    expect(next.layout.footer_tags).toBe('写作、社区');
    // 显式清空底部说明要保留，不能回退成默认文案。
    expect(next.layout.footer_note).toBe('');

    const legacy = readCustomization({ customization: {} } as never);
    expect(legacy.layout.footer_note).toBe('前端 v0.1 · React');
    expect(legacy.layout.footer_show_tags).toBe(true);
    expect(legacy.layout.footer_brand_name).toBe('');
  });
});
