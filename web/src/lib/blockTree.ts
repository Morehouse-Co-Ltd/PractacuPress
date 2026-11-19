import type { BlockInstance } from '../types';

/**
 * 递归区块树的纯函数操作。
 *
 * 编排器、归一化和渲染都只通过这里改树，避免「拖拽一套逻辑、按钮另一套逻辑」。
 * 所有函数返回新数组，不修改调用方传入的区块或子区块。
 */

export const MAX_BLOCK_DEPTH = 8;
export const MAX_BLOCKS = 200;
/** 单个容器下的直接子区块上限；与深度、总数构成本项目仅有的三条树约束。 */
export const MAX_CHILDREN_PER_CONTAINER = 80;

export interface BlockLocation {
  block: BlockInstance;
  parent: BlockInstance | null;
  /** 在兄弟数组里的下标。 */
  index: number;
  column?: number;
  depth: number;
}

export interface DropTarget {
  parentId: string | null;
  column?: number;
  index: number;
}

/** 深度优先查找区块；返回父区块、兄弟下标和当前列号。 */
export function findBlock(blocks: BlockInstance[], id: string): BlockLocation | null {
  const walk = (
    list: BlockInstance[],
    parent: BlockInstance | null,
    depth: number,
  ): BlockLocation | null => {
    for (let index = 0; index < list.length; index += 1) {
      const block = list[index];
      if (block.id === id) return { block, parent, index, column: block.column, depth };
      const nested = walk(block.children ?? [], block, depth + 1);
      if (nested) return nested;
    }
    return null;
  };
  return walk(blocks, null, 0);
}

/** 按 id 找父区块；根级返回 null。 */
export function findParent(blocks: BlockInstance[], id: string): BlockInstance | null {
  return findBlock(blocks, id)?.parent ?? null;
}

/** 整棵树里的区块数量。 */
export function countBlocks(blocks: BlockInstance[]): number {
  return blocks.reduce((total, block) => total + 1 + countBlocks(block.children ?? []), 0);
}

/** 返回某个区块的深度；找不到返回 -1。 */
export function depthOf(blocks: BlockInstance[], id: string): number {
  return findBlock(blocks, id)?.depth ?? -1;
}

/** 更新一个区块的字段；容器会递归更新子区块。 */
export function updateBlock(
  blocks: BlockInstance[],
  id: string,
  patch: Partial<BlockInstance>,
): BlockInstance[] {
  return blocks.map((block) => {
    if (block.id === id) return { ...block, ...patch };
    if (!block.children?.length) return block;
    const children = updateBlock(block.children, id, patch);
    return children === block.children ? block : { ...block, children };
  });
}

/** 从树里删除一个区块，返回新树。 */
export function removeBlock(blocks: BlockInstance[], id: string): BlockInstance[] {
  return blocks
    .filter((block) => block.id !== id)
    .map((block) => {
      if (!block.children?.length) return block;
      const children = removeBlock(block.children, id);
      return children === block.children ? block : { ...block, children };
    });
}

/** 在指定父区块/列/下标插入区块；parentId 为 null 时插入根级。 */
export function insertBlock(
  blocks: BlockInstance[],
  target: DropTarget,
  block: BlockInstance,
): BlockInstance[] {
  if (!target.parentId) {
    const next = [...blocks];
    const index = Math.max(0, Math.min(target.index, next.length));
    next.splice(index, 0, block);
    return next;
  }

  return blocks.map((item) => {
    if (item.id === target.parentId) {
      const children = [...(item.children ?? [])];
      const index = Math.max(0, Math.min(target.index, children.length));
      children.splice(index, 0, {
        ...block,
        column: clampColumn(target.column ?? block.column ?? 1),
      });
      return { ...item, children };
    }
    if (!item.children?.length) return item;
    const children = insertBlock(item.children, target, block);
    return children === item.children ? item : { ...item, children };
  });
}

/** 把区块移动到目标位置；返回原树表示移动无效。 */
export function moveBlock(
  blocks: BlockInstance[],
  id: string,
  target: DropTarget,
): BlockInstance[] {
  const found = findBlock(blocks, id);
  if (!found) return blocks;

  // 不能把容器放进自己的子孙里，否则会形成环。
  if (
    target.parentId &&
    (target.parentId === id || findBlock(found.block.children ?? [], target.parentId))
  ) {
    return blocks;
  }

  const without = removeBlock(blocks, id);
  // 同一父级内向下移动时，移除本节点会让目标下标前移一位；编辑器给的
  // target.index 是「插到某一项之后」，所以先补偿，再夹到合法范围。
  const sameParent = (found.parent?.id ?? null) === (target.parentId ?? null);
  let index = sameParent && found.index < target.index ? target.index - 1 : target.index;
  if (target.parentId) {
    const parent = findBlock(without, target.parentId)?.block;
    if (!parent) return blocks;
    const max = parent.children?.length ?? 0;
    index = Math.min(Math.max(index, 0), max);
  } else {
    index = Math.min(Math.max(index, 0), without.length);
  }
  return insertBlock(without, { ...target, index }, found.block);
}

/**
 * 「上移 / 下移一格」按钮对应的投放目标。
 *
 * `moveBlock` 的 `target.index` 是「移除前的边界下标」，所以向下移动一格要多加一：
 * 想落到原下标 `i + 1` 的元素之后，边界下标就是 `i + 2`。
 */
export function stepTarget(
  location: Pick<BlockLocation, 'parent' | 'index' | 'column'>,
  direction: 1 | -1,
): DropTarget {
  return {
    parentId: location.parent?.id ?? null,
    ...(location.parent ? { column: location.column } : {}),
    index: location.index + direction + (direction > 0 ? 1 : 0),
  };
}

/** 从根级或容器里移除并返回被移除的区块。 */
export function extractBlock(
  blocks: BlockInstance[],
  id: string,
): { blocks: BlockInstance[]; block: BlockInstance | null } {
  const found = findBlock(blocks, id);
  if (!found) return { blocks, block: null };
  return { blocks: removeBlock(blocks, id), block: found.block };
}

/** 把新节点附加到指定父区块的某一列，主要用于“添加子区块”按钮。 */
export function appendChild(
  blocks: BlockInstance[],
  parentId: string,
  column: number,
  block: BlockInstance,
): BlockInstance[] {
  const parent = findBlock(blocks, parentId)?.block;
  const index = parent?.children?.length ?? 0;
  return insertBlock(blocks, { parentId, column, index }, block);
}

/** 复制子树并重新生成所有 id，用于“复制区块”。 */
export function cloneBlockTree(
  block: BlockInstance,
  makeId: () => string,
): BlockInstance {
  return {
    ...block,
    id: makeId(),
    children: block.children?.map((child) => cloneBlockTree(child, makeId)),
  };
}

export function clampColumn(value: number): number {
  return Math.min(4, Math.max(1, Math.round(value) || 1));
}

/** 判断某个 id 是否在树里（用于思维链目标校验）。 */
export function hasBlock(blocks: BlockInstance[], id: string): boolean {
  return findBlock(blocks, id) !== null;
}

/** 遍历整棵树（含容器本身）。 */
export function walkBlocks(
  blocks: BlockInstance[],
  visit: (block: BlockInstance, depth: number) => void,
  depth = 0,
): void {
  for (const block of blocks) {
    visit(block, depth);
    if (block.children?.length) walkBlocks(block.children, visit, depth + 1);
  }
}

/** 供拖拽失焦时使用的简单定位：返回目标父区块的列数。 */
export function columnCount(block: BlockInstance | null): number {
  if (!block || block.type !== 'columns') return 1;
  const raw = Number(block.props.columns);
  return Number.isFinite(raw) ? clampColumn(raw) : 2;
}
