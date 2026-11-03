import { describe, expect, it } from 'vitest';
import type { BlockInstance } from '../types';
import {
  BREAKPOINT_LG,
  BREAKPOINT_MD,
  BREAKPOINT_SM,
  SPACING_SCALE,
  applyDisplayOverrides,
  overlayAt,
  spacingPx,
} from './layout';

function mk(id: string, extra: Partial<BlockInstance> = {}): BlockInstance {
  return { id, type: 'text', title: id, props: {}, animation: 'none', hidden: false, ...extra };
}

describe('断点', () => {
  it('三档从小到大且与文档一致', () => {
    expect([BREAKPOINT_SM, BREAKPOINT_MD, BREAKPOINT_LG]).toEqual([480, 768, 1024]);
  });
});

describe('spacingPx', () => {
  it('按档位下标取值', () => {
    expect(spacingPx(0)).toBe(0);
    expect(spacingPx(9)).toBe(96);
  });
  it('越界、非整数、非数字一律 undefined', () => {
    expect(spacingPx(-1)).toBeUndefined();
    expect(spacingPx(99)).toBeUndefined();
    expect(spacingPx(1.5)).toBeUndefined();
    expect(spacingPx('3')).toBeUndefined();
  });
  it('标尺是只读常量且单调递增', () => {
    expect(SPACING_SCALE).toEqual([0, 4, 8, 12, 16, 24, 32, 48, 64, 96]);
  });
});

describe('overlayAt', () => {
  it('手机覆盖隐藏时只影响手机', () => {
    const block = mk('a', { at: { mobile: { hidden: true } } });
    expect(overlayAt(block, 'mobile').hidden).toBe(true);
    expect(overlayAt(block, 'desktop').hidden).toBe(false);
  });

  it('外观对象按字段合并，不整块替换', () => {
    const block = mk('a', {
      appearance: { radius: 'md', padding: 12 },
      at: { tablet: { appearance: { radius: 'xl' } } },
    });
    expect(overlayAt(block, 'tablet').appearance).toEqual({ radius: 'xl', padding: 12 });
  });

  it('递归进子区块', () => {
    const child = mk('c', { at: { mobile: { hidden: true } } });
    const parent = mk('p', { children: [child] });
    const mobile = overlayAt(parent, 'mobile');
    expect(mobile.children?.[0].hidden).toBe(true);
    expect(overlayAt(parent, 'desktop').children?.[0].hidden).toBe(false);
  });

  it('不修改入参', () => {
    const block = mk('a', { at: { mobile: { span: { base: 6 } } } });
    overlayAt(block, 'mobile');
    expect(block.span).toBeUndefined();
  });
});

describe('applyDisplayOverrides', () => {
  it('桌面原样返回（desktop 没有覆盖层）', () => {
    const blocks = [mk('a', { at: { mobile: { hidden: true } } })];
    expect(applyDisplayOverrides(blocks, 'desktop')[0].hidden).toBe(false);
  });
  it('批量应用手机覆盖', () => {
    const blocks = [mk('a', { at: { mobile: { hidden: true } } }), mk('b')];
    expect(applyDisplayOverrides(blocks, 'mobile').map((b) => b.hidden)).toEqual([true, false]);
  });
});
