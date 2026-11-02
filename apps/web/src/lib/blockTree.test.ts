import { describe, expect, it } from 'vitest';
import { createBlock } from './blocks';
import {
  countBlocks,
  findBlock,
  insertBlock,
  moveBlock,
  removeBlock,
  updateBlock,
} from './blockTree';

const columns = (children: ReturnType<typeof createBlock>[] = []) => ({
  ...createBlock('columns'),
  children,
});

describe('blockTree', () => {
  it('finds nested blocks with parent and column', () => {
    const text = createBlock('text');
    const tree = [columns([{ ...text, column: 2 }])];
    const found = findBlock(tree, text.id);
    expect(found?.parent?.type).toBe('columns');
    expect(found?.column).toBe(2);
  });

  it('inserts and removes a nested block', () => {
    const container = columns();
    const image = createBlock('image');
    const inserted = insertBlock([container], { parentId: container.id, column: 2, index: 0 }, image);
    expect(countBlocks(inserted)).toBe(2);
    expect(findBlock(inserted, image.id)?.column).toBe(2);
    expect(findBlock(removeBlock(inserted, image.id), image.id)).toBeNull();
  });

  it('moves a block between columns and reorders siblings', () => {
    const first = createBlock('text');
    const second = createBlock('text');
    const container = columns([first, second]);
    const moved = moveBlock([container], first.id, {
      parentId: container.id,
      column: 2,
      // 落点是“放到 second 之后”的边界下标（移除前的兄弟数组），移入后要减一位。
      index: 2,
    });
    expect(findBlock(moved, first.id)?.column).toBe(2);
    expect(moved[0].children?.map((block) => block.id)).toEqual([second.id, first.id]);
  });

  it('updates a nested block without mutating the original', () => {
    const text = createBlock('text');
    const tree = [columns([text])];
    const next = updateBlock(tree, text.id, { title: '新标题' });
    expect(findBlock(next, text.id)?.block.title).toBe('新标题');
    expect(findBlock(tree, text.id)?.block.title).not.toBe('新标题');
  });

  it('refuses to move a container into its own descendant', () => {
    const nested = columns();
    const outer = columns([nested]);
    const moved = moveBlock([outer], outer.id, { parentId: nested.id, column: 1, index: 0 });
    expect(findBlock(moved, outer.id)?.parent).toBeNull();
  });
});
