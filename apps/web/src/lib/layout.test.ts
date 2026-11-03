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
import { STEP_DEFS } from './logic';

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

describe('overlayAt 的边界（护栏）', () => {
  it('绝不把 props 合进结果——内容永远只有一份来源', () => {
    const block = mk('a', { props: { body: 'base' } });
    // 故意构造一个带 props 的非法覆盖层，模拟坏实现会用的写法
    const poisoned = { ...block, at: { mobile: { props: { body: 'hacked' } } } } as unknown as BlockInstance;
    expect(overlayAt(poisoned, 'mobile').props).toEqual({ body: 'base' });
  });

  it('桌面返回原数组本身（短路，不复制）', () => {
    const blocks = [mk('a')];
    expect(applyDisplayOverrides(blocks, 'desktop')).toBe(blocks);
  });

  it('显式 hidden:false 能把基础隐藏反隐藏', () => {
    const block = mk('a', { hidden: true, at: { mobile: { hidden: false } } });
    expect(overlayAt(block, 'mobile').hidden).toBe(false);
  });

  it('深层子区块同样不被修改', () => {
    const grandchild = mk('g', { at: { mobile: { hidden: true } } });
    const child = mk('c', { children: [grandchild] });
    const blocks = [mk('p', { children: [child] })];
    applyDisplayOverrides(blocks, 'mobile');
    expect(blocks[0].children?.[0].children?.[0].hidden).toBe(false);
  });
});

describe('逻辑条件提示与断点表同步', () => {
  it('is_mobile / is_desktop 的提示数字跟随 BREAKPOINT_MD', () => {
    // 提示文案是字面量（i18n 闸门要求），所以这里守住「改断点别忘了改文案」。
    expect(STEP_DEFS.is_mobile.hint).toContain(`< ${BREAKPOINT_MD}px`);
    expect(STEP_DEFS.is_desktop.hint).toContain(`≥ ${BREAKPOINT_MD}px`);
  });
});
