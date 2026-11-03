import { describe, expect, it } from 'vitest';
import type { BlockInstance } from '../types';
import type { BlockPlacementPatch } from './layout';
import {
  BREAKPOINT_LG,
  BREAKPOINT_MD,
  BREAKPOINT_SM,
  SPACING_SCALE,
  applyDisplayOverrides,
  clampGridPlacement,
  overlayAt,
  spacingPx,
  writeOverride,
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

describe('writeOverride', () => {
  it('手机上改外观写进 at.mobile，不动基础外观', () => {
    const block = mk('a', { appearance: { radius: 'md' } });
    const next = writeOverride(block, 'mobile', { appearance: { radius: 'xl' } });
    expect(next.appearance).toEqual({ radius: 'md' });
    expect(next.at?.mobile?.appearance).toEqual({ radius: 'xl' });
  });

  it('桌面上改外观写回基础字段', () => {
    const block = mk('a', { appearance: { radius: 'md' } });
    const next = writeOverride(block, 'desktop', { appearance: { radius: 'xl' } });
    expect(next.appearance).toEqual({ radius: 'xl' });
    // desktop 没有覆盖层：类型上就不存在这个键，这里守住「实现也别偷偷造一层」。
    expect((next.at as Record<string, unknown> | undefined)?.desktop).toBeUndefined();
  });

  it('恢复继承：传空 patch 时删掉该设备的覆盖', () => {
    const block = mk('a', { at: { mobile: { hidden: true } } });
    const next = writeOverride(block, 'mobile', {});
    expect(next.at?.mobile).toBeUndefined();
  });

  it('写覆盖不修改入参，也不把覆盖泄漏进基础字段', () => {
    const block = mk('a', { appearance: { radius: 'md' }, at: { mobile: { hidden: true } } });
    const next = writeOverride(block, 'mobile', { appearance: { radius: 'xl' }, hidden: false });
    // 入参原封不动：调用方还要拿它比较、撤销。
    expect(block.appearance).toEqual({ radius: 'md' });
    expect(block.at).toEqual({ mobile: { hidden: true } });
    expect(next).not.toBe(block);
    // 覆盖层与已有字段合并，而不是整层替换。
    expect(next.at?.mobile).toEqual({ hidden: false, appearance: { radius: 'xl' } });
  });

  it('外观按字段合并，显式 undefined 恢复单项继承', () => {
    const block = mk('a', { at: { mobile: { appearance: { radius: 'xl', shadow: 'lg' } } } });
    const next = writeOverride(block, 'mobile', { appearance: { radius: undefined } });
    expect(next.at?.mobile).toEqual({ appearance: { shadow: 'lg' } });
  });

  it('覆盖层清空后 at 整键消失，不留下空对象', () => {
    const block = mk('a', { at: { mobile: { appearance: { radius: 'xl' } }, tablet: { hidden: true } } });
    const next = writeOverride(block, 'mobile', { appearance: { radius: undefined } });
    expect(next.at).toEqual({ tablet: { hidden: true } });
    expect(writeOverride(next, 'tablet', {})).not.toHaveProperty('at');
  });
});

describe('clampGridPlacement', () => {
  it('合法取值原样返回', () => {
    expect(clampGridPlacement(6, 3, 12)).toEqual({ span: 6, offset: 3 });
    expect(clampGridPlacement(1, 0, 12)).toEqual({ span: 1, offset: 0 });
    expect(clampGridPlacement(12, 0, 12)).toEqual({ span: 12, offset: 0 });
  });

  it('span 夹进 1–12', () => {
    expect(clampGridPlacement(0, 0, 12)).toEqual({ span: 1, offset: 0 });
    expect(clampGridPlacement(-5, 0, 12)).toEqual({ span: 1, offset: 0 });
    expect(clampGridPlacement(99, 0, 12)).toEqual({ span: 12, offset: 0 });
  });

  it('offset 夹进 0–11', () => {
    expect(clampGridPlacement(1, -3, 12)).toEqual({ span: 1, offset: 0 });
    expect(clampGridPlacement(1, 99, 12)).toEqual({ span: 1, offset: 11 });
  });

  it('offset + span 超出栏数时只退 offset，栏数原样保住', () => {
    expect(clampGridPlacement(8, 9, 12)).toEqual({ span: 8, offset: 4 });
    expect(clampGridPlacement(12, 1, 12)).toEqual({ span: 12, offset: 0 });
  });

  it('容器比 span 还窄时 span 收窄到栏数、offset 归零', () => {
    expect(clampGridPlacement(12, 3, 4)).toEqual({ span: 4, offset: 0 });
    expect(clampGridPlacement(6, 2, 1)).toEqual({ span: 1, offset: 0 });
  });

  it('非有限输入回落到整行、不偏移', () => {
    expect(clampGridPlacement(Number.NaN, 3, 6)).toEqual({ span: 6, offset: 0 });
    expect(clampGridPlacement(4, Number.POSITIVE_INFINITY, 6)).toEqual({ span: 6, offset: 0 });
  });
});

describe('栅格位移按设备分层', () => {
  it('手机上的 offset 落进 at.mobile，桌面写回基础字段', () => {
    const block = mk('a');
    const mobile = writeOverride(block, 'mobile', { offset: { base: 2 } });
    expect(mobile.offset).toBeUndefined();
    expect(mobile.at?.mobile).toEqual({ offset: { base: 2 } });
    expect(block.at).toBeUndefined();

    const desktop = writeOverride(block, 'desktop', { offset: { base: 2 } });
    expect(desktop.offset).toEqual({ base: 2 });
    expect(desktop.at).toBeUndefined();
  });

  it('overlayAt 叠上 at[device].offset；清掉覆盖后回到基础偏移', () => {
    const tablet: BlockPlacementPatch = { offset: { base: 4 } };
    const block = mk('a', { offset: { base: 1 }, at: { tablet } });
    expect(overlayAt(block, 'tablet').offset).toEqual({ base: 4 });
    expect(overlayAt(block, 'desktop').offset).toEqual({ base: 1 });
    expect(overlayAt(writeOverride(block, 'tablet', { offset: undefined }), 'tablet').offset).toEqual({
      base: 1,
    });
  });
});

describe('逻辑条件提示与断点表同步', () => {
  it('is_mobile / is_desktop 的提示数字跟随 BREAKPOINT_MD', () => {
    // 提示文案是字面量（i18n 闸门要求），所以这里守住「改断点别忘了改文案」。
    expect(STEP_DEFS.is_mobile.hint).toContain(`< ${BREAKPOINT_MD}px`);
    expect(STEP_DEFS.is_desktop.hint).toContain(`≥ ${BREAKPOINT_MD}px`);
  });
});
