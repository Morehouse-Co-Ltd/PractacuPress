import { describe, expect, it } from 'vitest';
import {
  BLOCK_CROP_OPTIONS,
  BLOCK_PADDING_RANGE,
  BLOCK_RADIUS_OPTIONS,
  BLOCK_SHADOW_OPTIONS,
  blockAppearanceCss,
  hasBlockAppearance,
  normalizeBlockAppearance,
} from './blockAppearance';

describe('blockAppearance 归一化', () => {
  it('接受白名单内的完整外观', () => {
    expect(
      normalizeBlockAppearance({
        radius: 'lg',
        shadow: 'glow',
        crop: '16:9',
        background: '#EEF3EF',
        padding: 16,
        border: true,
      }),
    ).toEqual({
      radius: 'lg',
      shadow: 'glow',
      crop: '16:9',
      background: '#eef3ef',
      padding: 16,
      border: true,
    });
  });

  it('丢弃未知枚举与坏色值，而不是抛错', () => {
    expect(
      normalizeBlockAppearance({
        radius: 'huge',
        shadow: 'dark',
        crop: '9:16',
        background: 'red',
        padding: '24px',
        border: 'yes',
      }),
    ).toBeUndefined();
  });

  it('非对象输入收敛成 undefined', () => {
    expect(normalizeBlockAppearance(undefined)).toBeUndefined();
    expect(normalizeBlockAppearance(null)).toBeUndefined();
    expect(normalizeBlockAppearance('lg')).toBeUndefined();
    expect(normalizeBlockAppearance([])).toBeUndefined();
    expect(normalizeBlockAppearance({})).toBeUndefined();
  });

  it('内边距夹在 0–64 并取整；0 不写进配置', () => {
    expect(normalizeBlockAppearance({ padding: -8 })).toBeUndefined();
    expect(normalizeBlockAppearance({ padding: 0 })).toBeUndefined();
    expect(normalizeBlockAppearance({ padding: 12.6 })?.padding).toBe(13);
    expect(normalizeBlockAppearance({ padding: 999 })?.padding).toBe(BLOCK_PADDING_RANGE.max);
    expect(normalizeBlockAppearance({ padding: Number.NaN })).toBeUndefined();
  });

  it('只认 3/6/8 位十六进制背景色', () => {
    expect(normalizeBlockAppearance({ background: '#abc' })?.background).toBe('#abc');
    expect(normalizeBlockAppearance({ background: '#aabbcc' })?.background).toBe('#aabbcc');
    expect(normalizeBlockAppearance({ background: '#aabbccdd' })?.background).toBe('#aabbccdd');
    expect(normalizeBlockAppearance({ background: '#ab' })).toBeUndefined();
    expect(normalizeBlockAppearance({ background: 'rgb(0 0 0)' })).toBeUndefined();
  });
});

describe('blockAppearance 样式映射', () => {
  it('无外观时返回空对象', () => {
    expect(blockAppearanceCss(undefined)).toEqual({});
    expect(blockAppearanceCss({})).toEqual({});
  });

  it('圆角换算成像素与胶囊', () => {
    expect(blockAppearanceCss({ radius: 'sm' }).borderRadius).toBe('8px');
    expect(blockAppearanceCss({ radius: 'xl' }).borderRadius).toBe('24px');
    expect(blockAppearanceCss({ radius: 'full' }).borderRadius).toBe('999px');
    expect(blockAppearanceCss({ radius: 'none' }).borderRadius).toBeUndefined();
  });

  it('阴影用主题令牌的 color-mix 字符串', () => {
    const shadow = blockAppearanceCss({ shadow: 'md' }).boxShadow;
    expect(typeof shadow).toBe('string');
    expect(shadow).toContain('var(--ink)');
    expect(blockAppearanceCss({ shadow: 'glow' }).boxShadow).toContain('var(--accent)');
    expect(blockAppearanceCss({ shadow: 'none' }).boxShadow).toBeUndefined();
  });

  it('裁剪：clip 只裁溢出，比例档位额外设置 aspect-ratio', () => {
    expect(blockAppearanceCss({ crop: 'clip' })).toEqual({ overflow: 'hidden' });
    expect(blockAppearanceCss({ crop: '16:9' })).toEqual({
      overflow: 'hidden',
      aspectRatio: '16 / 9',
    });
    expect(blockAppearanceCss({ crop: '4:3' }).aspectRatio).toBe('4 / 3');
    expect(blockAppearanceCss({ crop: 'none' })).toEqual({});
  });

  it('背景、内边距与描边', () => {
    expect(blockAppearanceCss({ background: '#112233' }).backgroundColor).toBe('#112233');
    expect(blockAppearanceCss({ padding: 20 }).padding).toBe('20px');
    expect(blockAppearanceCss({ border: true }).border).toBe('1px solid var(--line)');
    expect(blockAppearanceCss({ border: false }).border).toBeUndefined();
  });

  it('hasBlockAppearance 把 none/空值当作未设置', () => {
    expect(hasBlockAppearance(undefined)).toBe(false);
    expect(hasBlockAppearance({})).toBe(false);
    expect(hasBlockAppearance({ radius: 'none' })).toBe(false);
    expect(hasBlockAppearance({ radius: 'lg' })).toBe(true);
    expect(hasBlockAppearance({ crop: 'clip' })).toBe(true);
    expect(hasBlockAppearance({ border: true })).toBe(true);
  });
});

describe('blockAppearance 选项目录', () => {
  it('每个档位的 value 唯一且在 CSS 映射里有落点', () => {
    for (const options of [BLOCK_RADIUS_OPTIONS, BLOCK_SHADOW_OPTIONS, BLOCK_CROP_OPTIONS]) {
      const values = options.map((option) => option.value);
      expect(new Set(values).size).toBe(values.length);
      expect(options[0].value).toBe('none');
    }
  });
});
