import { describe, expect, it } from 'vitest';
import type { BlockInstance } from '../types';
import { moveBlock, stepTarget } from './blockTree';

function mk(id: string, children: BlockInstance[] = []): BlockInstance {
  return {
    id,
    type: 'text',
    title: id,
    props: {},
    animation: 'none',
    hidden: false,
    ...(children.length ? { children } : {}),
  };
}

function ids(blocks: BlockInstance[]): string[] {
  return blocks.map((block) => block.id);
}

describe('moveBlock 同一父级内的下标补偿', () => {
  it('根级把 A 拖到 B 之后得到 [B,A,C]', () => {
    const next = moveBlock([mk('a'), mk('b'), mk('c')], 'a', { parentId: null, index: 2 });
    expect(ids(next)).toEqual(['b', 'a', 'c']);
  });

  it('根级向上拖动仍然正确', () => {
    const next = moveBlock([mk('a'), mk('b'), mk('c')], 'c', { parentId: null, index: 0 });
    expect(ids(next)).toEqual(['c', 'a', 'b']);
  });

  it('容器内向下拖动同样补偿', () => {
    const blocks = [mk('box', [mk('a'), mk('b'), mk('c')])];
    const next = moveBlock(blocks, 'a', { parentId: 'box', index: 2 });
    expect(ids(next[0].children ?? [])).toEqual(['b', 'a', 'c']);
  });

  it('拖到自身子孙里仍然被拒绝', () => {
    const blocks = [mk('box', [mk('inner')])];
    const next = moveBlock(blocks, 'box', { parentId: 'inner', index: 0 });
    expect(next).toBe(blocks);
  });
});

describe('stepTarget 与上下移动按钮', () => {
  it('向下移动一格得到 [b,a,c]', () => {
    const blocks = [mk('a'), mk('b'), mk('c')];
    const next = moveBlock(blocks, 'a', stepTarget({ parent: null, index: 0 }, 1));
    expect(next.map((b) => b.id)).toEqual(['b', 'a', 'c']);
  });

  it('向上移动一格得到 [a,c,b]', () => {
    const blocks = [mk('a'), mk('b'), mk('c')];
    const next = moveBlock(blocks, 'c', stepTarget({ parent: null, index: 2 }, -1));
    expect(next.map((b) => b.id)).toEqual(['a', 'c', 'b']);
  });

  it('容器内向下移动一格', () => {
    const blocks = [mk('box', [mk('a'), mk('b')])];
    const parent = blocks[0];
    const next = moveBlock(blocks, 'a', stepTarget({ parent, index: 0 }, 1));
    expect((next[0].children ?? []).map((b) => b.id)).toEqual(['b', 'a']);
  });
});
