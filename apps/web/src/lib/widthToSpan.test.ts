import { describe, expect, it } from 'vitest';
import type { BlockInstance } from '../types';
import { migrateWidthsToSpan, widthToSpan } from './blocks';
import { normalizeScreenLayout } from './customize';

function mk(id: string, extra: Partial<BlockInstance> = {}): BlockInstance {
  return { id, type: 'text', title: id, props: {}, animation: 'none', hidden: false, ...extra };
}

describe('widthToSpan', () => {
  it('半宽换算成 6 栏', () => {
    expect(widthToSpan(600, 1200, 12)).toBe(6);
  });
  it('向上取整，避免窄块算出 0 栏', () => {
    expect(widthToSpan(10, 1200, 12)).toBe(1);
  });
  it('超过容器宽挤到满栏', () => {
    expect(widthToSpan(5000, 1200, 12)).toBe(12);
  });
  it('坏输入返回满栏', () => {
    expect(widthToSpan(Number.NaN, 1200, 12)).toBe(12);
    expect(widthToSpan(600, 0, 12)).toBe(12);
  });
});

describe('migrateWidthsToSpan', () => {
  it('有 width 的区块被换成 span 并清掉 width', () => {
    const blocks = [mk('a', { width: 600 }), mk('b')];
    const next = migrateWidthsToSpan(blocks, 1200);
    expect(next[0].span).toEqual({ base: 6 });
    expect(next[0].width).toBeUndefined();
    expect(next[1].span).toBeUndefined();
  });
  it('已经有 span 的区块不动', () => {
    const blocks = [mk('a', { width: 600, span: { base: 3 } })];
    expect(migrateWidthsToSpan(blocks, 1200)[0]).toEqual(blocks[0]);
  });
  it('递归进子区块且不修改入参', () => {
    const child = mk('c', { width: 600 });
    const blocks = [mk('p', { children: [child] })];
    const next = migrateWidthsToSpan(blocks, 1200);
    expect(next[0].children?.[0].span).toEqual({ base: 6 });
    expect(blocks[0].children?.[0].span).toBeUndefined();
  });
});

describe('读取路径的折算是唯一一次', () => {
  it('归一化把 width 折成 span 并清掉 width', () => {
    const layout = normalizeScreenLayout({
      blocks: [{ id: 'a', type: 'text', title: 'a', props: {}, width: 600 }],
    });
    expect(layout.blocks[0].span).toEqual({ base: 6 });
    expect(layout.blocks[0].width).toBeUndefined();
  });

  it('各设备的列表同样折算', () => {
    const layout = normalizeScreenLayout({
      blocks: [],
      device_split: true,
      devices: {
        mobile: { blocks: [{ id: 'm', type: 'text', title: 'm', props: {}, width: 300 }] },
      },
    });
    expect(layout.devices?.mobile?.blocks[0].span).toEqual({ base: 3 });
    expect(layout.devices?.mobile?.blocks[0].width).toBeUndefined();
  });

  it('不动 at 里的各设备覆盖（那是 Task 1 的分档出口）', () => {
    const layout = normalizeScreenLayout({
      blocks: [
        {
          id: 'a',
          type: 'text',
          title: 'a',
          props: {},
          width: 600,
          at: { mobile: { width: 500 } },
        },
      ],
    });
    expect(layout.blocks[0].span).toEqual({ base: 6 });
    expect(layout.blocks[0].at?.mobile?.width).toBe(500);
  });
});
