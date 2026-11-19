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
  it('grid 里的直接子区块被换成 span 并清掉 width', () => {
    const blocks = [
      mk('g', { type: 'grid', children: [mk('a', { width: 600 }), mk('b')] }),
    ];
    const next = migrateWidthsToSpan(blocks, 1200);
    expect(next[0].children?.[0].span).toEqual({ base: 6 });
    expect(next[0].children?.[0].width).toBeUndefined();
    expect(next[0].children?.[1].span).toBeUndefined();
  });

  it('grid 之外的区块保留 width、不生成 span', () => {
    // `span` 只有 GridBlock 消费，BlockView 仍然按 width 画宽度。把 grid 外的
    // width 折掉，v1 里设过像素宽的区块读一次就变满宽。
    const blocks = [
      mk('root', { width: 600 }),
      mk('box', { type: 'container', children: [mk('kid', { width: 480 })] }),
    ];
    const next = migrateWidthsToSpan(blocks, 1200);
    expect(next[0].width).toBe(600);
    expect(next[0].span).toBeUndefined();
    expect(next[1].children?.[0].width).toBe(480);
    expect(next[1].children?.[0].span).toBeUndefined();
  });

  it('已经有 span 的栅格子区块不动', () => {
    const block = mk('a', { width: 600, span: { base: 3 } });
    const blocks = [mk('g', { type: 'grid', children: [block] })];
    expect(migrateWidthsToSpan(blocks, 1200)[0].children?.[0]).toEqual(block);
  });

  it('递归进子区块且不修改入参；grid 里面再套容器则不再折算', () => {
    const grandchild = mk('c', { width: 600 });
    const child = mk('a', { width: 600, children: [grandchild] });
    const blocks = [mk('g', { type: 'grid', children: [child] })];
    const next = migrateWidthsToSpan(blocks, 1200);
    expect(next[0].children?.[0].span).toEqual({ base: 6 });
    // 只有 grid 的直接子区块才是格子，更深的区块宽度语义照旧。
    expect(next[0].children?.[0].children?.[0].span).toBeUndefined();
    expect(next[0].children?.[0].children?.[0].width).toBe(600);
    expect(blocks[0].children?.[0].span).toBeUndefined();
  });
});

describe('读取路径的折算是唯一一次', () => {
  it('grid 内的 width 折成 span 并清掉 width', () => {
    const layout = normalizeScreenLayout({
      blocks: [
        {
          id: 'g',
          type: 'grid',
          title: 'g',
          props: {},
          children: [{ id: 'a', type: 'text', title: 'a', props: {}, width: 600 }],
        },
      ],
    });
    expect(layout.blocks[0].children?.[0].span).toEqual({ base: 6 });
    expect(layout.blocks[0].children?.[0].width).toBeUndefined();
  });

  it('顶层（不在 grid 里）的 width 原样保留', () => {
    const layout = normalizeScreenLayout({
      blocks: [{ id: 'a', type: 'text', title: 'a', props: {}, width: 600 }],
    });
    expect(layout.blocks[0].width).toBe(600);
    expect(layout.blocks[0].span).toBeUndefined();
  });

  it('各设备的列表同样只折算 grid 内的区块', () => {
    const layout = normalizeScreenLayout({
      blocks: [],
      device_split: true,
      devices: {
        mobile: {
          blocks: [
            {
              id: 'g',
              type: 'grid',
              title: 'g',
              props: {},
              children: [{ id: 'm', type: 'text', title: 'm', props: {}, width: 300 }],
            },
          ],
        },
      },
    });
    expect(layout.devices?.mobile?.blocks[0].children?.[0].span).toEqual({ base: 3 });
    expect(layout.devices?.mobile?.blocks[0].children?.[0].width).toBeUndefined();
  });

  it('不动 at 里的各设备覆盖（那是 Task 1 的分档出口）', () => {
    const layout = normalizeScreenLayout({
      blocks: [
        {
          id: 'g',
          type: 'grid',
          title: 'g',
          props: {},
          children: [
            {
              id: 'a',
              type: 'text',
              title: 'a',
              props: {},
              width: 600,
              at: { mobile: { width: 500 } },
            },
          ],
        },
      ],
    });
    expect(layout.blocks[0].children?.[0].span).toEqual({ base: 6 });
    expect(layout.blocks[0].children?.[0].at?.mobile?.width).toBe(500);
  });
});
