# Task 1 review package

## Commits

3c6a6b3 fix(web): make the tree panel move-down button use the corrected drop index
8614641 fix(web): compensate the drop index when a block moves down inside one parent
4e3906b docs: spec and plan for the editor markdown affordances

## Diff (task files only)

diff --git a/apps/web/src/components/builder/BlockTreeEditor.tsx b/apps/web/src/components/builder/BlockTreeEditor.tsx
index 3676073..c1859bb 100644
--- a/apps/web/src/components/builder/BlockTreeEditor.tsx
+++ b/apps/web/src/components/builder/BlockTreeEditor.tsx
@@ -3,20 +3,21 @@ import type { BlockInstance, LayoutVariant } from '../../types';
 import { availableBlocks, createBlock, type BlockDefinition } from '../../lib/blocks';
 import {
   MAX_BLOCKS,
   appendChild,
   columnCount,
   countBlocks,
   findBlock,
   insertBlock,
   moveBlock,
   removeBlock,
+  stepTarget,
   updateBlock,
 } from '../../lib/blockTree';
 import { useT } from '../../lib/i18n';
 import { Badge, Button } from '../ui';
 
 /**
  * 递归区块树编辑器。
  *
  * 所有增删移动都落到 lib/blockTree 的纯函数上；这里只负责：
  * - 组件库点击/拖入；
@@ -31,21 +32,29 @@ const MIME_BLOCK = 'application/x-pp-block';
 const MIME_NEW = 'application/x-pp-new';
 
 interface AddTarget {
   parentId: string | null;
   column?: number;
 }
 
 function groupOf(type: string): 'layout' | 'media' | 'data' | 'content' {
   if (type === 'columns' || type === 'text') return 'layout';
   if (type === 'image' || type === 'video' || type === 'website' || type === 'slideshow') return 'media';
-  if (type === 'stats' || type === 'chart' || type === 'list' || type === 'articles' || type === 'code') return 'data';
+  if (
+    type === 'stats' ||
+    type === 'chart' ||
+    type === 'list' ||
+    type === 'articles' ||
+    type === 'code'
+  ) {
+    return 'data';
+  }
   return 'content';
 }
 
 const GROUP_ORDER = ['layout', 'media', 'data', 'content'] as const;
 
 function Palette({
   variant,
   onAdd,
   onDragStart,
 }: {
@@ -202,27 +211,21 @@ export function BlockTreeEditor({
     }
     addAt({ parentId: null }, def.type);
   };
 
   const move = (id: string, direction: -1 | 1) => {
     const location = findBlock(blocks, id);
     if (!location) return;
     const siblings = location.parent?.children ?? blocks;
     const index = location.index + direction;
     if (index < 0 || index >= siblings.length) return;
-    onChange(
-      moveBlock(blocks, id, {
-        parentId: location.parent?.id ?? null,
-        column: location.column,
-        index,
-      }),
-    );
+    onChange(moveBlock(blocks, id, stepTarget(location, direction)));
   };
 
   const remove = (id: string) => {
     onChange(removeBlock(blocks, id));
     if (selectedId === id) onSelect(null);
   };
 
   const toggleHidden = (block: BlockInstance) => {
     onChange(updateBlock(blocks, block.id, { hidden: !block.hidden }));
   };
diff --git a/apps/web/src/lib/blockTree.test.ts b/apps/web/src/lib/blockTree.test.ts
index 69900e1..573dfc8 100644
--- a/apps/web/src/lib/blockTree.test.ts
+++ b/apps/web/src/lib/blockTree.test.ts
@@ -32,21 +32,22 @@ describe('blockTree', () => {
     expect(findBlock(removeBlock(inserted, image.id), image.id)).toBeNull();
   });
 
   it('moves a block between columns and reorders siblings', () => {
     const first = createBlock('text');
     const second = createBlock('text');
     const container = columns([first, second]);
     const moved = moveBlock([container], first.id, {
       parentId: container.id,
       column: 2,
-      index: 1,
+      // 落点是“放到 second 之后”的边界下标（移除前的兄弟数组），移入后要减一位。
+      index: 2,
     });
     expect(findBlock(moved, first.id)?.column).toBe(2);
     expect(moved[0].children?.map((block) => block.id)).toEqual([second.id, first.id]);
   });
 
   it('updates a nested block without mutating the original', () => {
     const text = createBlock('text');
     const tree = [columns([text])];
     const next = updateBlock(tree, text.id, { title: '新标题' });
     expect(findBlock(next, text.id)?.block.title).toBe('新标题');
diff --git a/apps/web/src/lib/blockTree.ts b/apps/web/src/lib/blockTree.ts
index 1cd80b7..a943850 100644
--- a/apps/web/src/lib/blockTree.ts
+++ b/apps/web/src/lib/blockTree.ts
@@ -2,20 +2,22 @@ import type { BlockInstance } from '../types';
 
 /**
  * 递归区块树的纯函数操作。
  *
  * 编排器、归一化和渲染都只通过这里改树，避免「拖拽一套逻辑、按钮另一套逻辑」。
  * 所有函数返回新数组，不修改调用方传入的区块或子区块。
  */
 
 export const MAX_BLOCK_DEPTH = 8;
 export const MAX_BLOCKS = 200;
+/** 单个容器下的直接子区块上限；与深度、总数构成本项目仅有的三条树约束。 */
+export const MAX_CHILDREN_PER_CONTAINER = 80;
 
 export interface BlockLocation {
   block: BlockInstance;
   parent: BlockInstance | null;
   /** 在兄弟数组里的下标。 */
   index: number;
   column?: number;
   depth: number;
 }
 
@@ -123,34 +125,52 @@ export function moveBlock(
 
   // 不能把容器放进自己的子孙里，否则会形成环。
   if (
     target.parentId &&
     (target.parentId === id || findBlock(found.block.children ?? [], target.parentId))
   ) {
     return blocks;
   }
 
   const without = removeBlock(blocks, id);
-  // target.index 是移除后目标兄弟数组里的插入下标；编辑器在生成投放位置时
-  // 已经按“放到某一行之后”换算过，这里不再对同一父级做二次偏移。
-  let index = target.index;
+  // 同一父级内向下移动时，移除本节点会让目标下标前移一位；编辑器给的
+  // target.index 是「插到某一项之后」，所以先补偿，再夹到合法范围。
+  const sameParent = (found.parent?.id ?? null) === (target.parentId ?? null);
+  let index = sameParent && found.index < target.index ? target.index - 1 : target.index;
   if (target.parentId) {
     const parent = findBlock(without, target.parentId)?.block;
     if (!parent) return blocks;
     const max = parent.children?.length ?? 0;
-    index = Math.min(index, max);
+    index = Math.min(Math.max(index, 0), max);
   } else {
-    index = Math.min(index, without.length);
+    index = Math.min(Math.max(index, 0), without.length);
   }
   return insertBlock(without, { ...target, index }, found.block);
 }
 
+/**
+ * 「上移 / 下移一格」按钮对应的投放目标。
+ *
+ * `moveBlock` 的 `target.index` 是「移除前的边界下标」，所以向下移动一格要多加一：
+ * 想落到原下标 `i + 1` 的元素之后，边界下标就是 `i + 2`。
+ */
+export function stepTarget(
+  location: Pick<BlockLocation, 'parent' | 'index' | 'column'>,
+  direction: 1 | -1,
+): DropTarget {
+  return {
+    parentId: location.parent?.id ?? null,
+    ...(location.parent ? { column: location.column } : {}),
+    index: location.index + direction + (direction > 0 ? 1 : 0),
+  };
+}
+
 /** 从根级或容器里移除并返回被移除的区块。 */
 export function extractBlock(
   blocks: BlockInstance[],
   id: string,
 ): { blocks: BlockInstance[]; block: BlockInstance | null } {
   const found = findBlock(blocks, id);
   if (!found) return { blocks, block: null };
   return { blocks: removeBlock(blocks, id), block: found.block };
 }
 
diff --git a/apps/web/src/lib/blockTreeMove.test.ts b/apps/web/src/lib/blockTreeMove.test.ts
new file mode 100644
index 0000000..24ba7eb
--- /dev/null
+++ b/apps/web/src/lib/blockTreeMove.test.ts
@@ -0,0 +1,64 @@
+import { describe, expect, it } from 'vitest';
+import type { BlockInstance } from '../types';
+import { moveBlock, stepTarget } from './blockTree';
+
+function mk(id: string, children: BlockInstance[] = []): BlockInstance {
+  return {
+    id,
+    type: 'text',
+    title: id,
+    props: {},
+    animation: 'none',
+    hidden: false,
+    ...(children.length ? { children } : {}),
+  };
+}
+
+function ids(blocks: BlockInstance[]): string[] {
+  return blocks.map((block) => block.id);
+}
+
+describe('moveBlock 同一父级内的下标补偿', () => {
+  it('根级把 A 拖到 B 之后得到 [B,A,C]', () => {
+    const next = moveBlock([mk('a'), mk('b'), mk('c')], 'a', { parentId: null, index: 2 });
+    expect(ids(next)).toEqual(['b', 'a', 'c']);
+  });
+
+  it('根级向上拖动仍然正确', () => {
+    const next = moveBlock([mk('a'), mk('b'), mk('c')], 'c', { parentId: null, index: 0 });
+    expect(ids(next)).toEqual(['c', 'a', 'b']);
+  });
+
+  it('容器内向下拖动同样补偿', () => {
+    const blocks = [mk('box', [mk('a'), mk('b'), mk('c')])];
+    const next = moveBlock(blocks, 'a', { parentId: 'box', index: 2 });
+    expect(ids(next[0].children ?? [])).toEqual(['b', 'a', 'c']);
+  });
+
+  it('拖到自身子孙里仍然被拒绝', () => {
+    const blocks = [mk('box', [mk('inner')])];
+    const next = moveBlock(blocks, 'box', { parentId: 'inner', index: 0 });
+    expect(next).toBe(blocks);
+  });
+});
+
+describe('stepTarget 与上下移动按钮', () => {
+  it('向下移动一格得到 [b,a,c]', () => {
+    const blocks = [mk('a'), mk('b'), mk('c')];
+    const next = moveBlock(blocks, 'a', stepTarget({ parent: null, index: 0 }, 1));
+    expect(next.map((b) => b.id)).toEqual(['b', 'a', 'c']);
+  });
+
+  it('向上移动一格得到 [a,c,b]', () => {
+    const blocks = [mk('a'), mk('b'), mk('c')];
+    const next = moveBlock(blocks, 'c', stepTarget({ parent: null, index: 2 }, -1));
+    expect(next.map((b) => b.id)).toEqual(['a', 'c', 'b']);
+  });
+
+  it('容器内向下移动一格', () => {
+    const blocks = [mk('box', [mk('a'), mk('b')])];
+    const parent = blocks[0];
+    const next = moveBlock(blocks, 'a', stepTarget({ parent, index: 0 }, 1));
+    expect((next[0].children ?? []).map((b) => b.id)).toEqual(['b', 'a']);
+  });
+});
