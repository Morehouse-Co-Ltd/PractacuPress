import type { ReactNode } from 'react';
import type { BlockInstance } from '../../types';
import { blockProp } from '../../lib/blocks';
import { columnCount } from '../../lib/blockTree';

export function ContainerBlock({ children }: { children: ReactNode }) {
  return <div className="pp-stack">{children}</div>;
}

/**
 * 分栏容器：把子区块按 column 分成 2–4 列。
 *
 * 渲染器不自己递归，而是由 blocks/index.tsx 传入 renderChild，保证每一层都
 * 复用同一套 BlockView（动画、data-pp-block、隐藏过滤都在那里处理）。
 */
export function ColumnsBlock({
  block,
  renderChild,
}: {
  block: BlockInstance;
  renderChild: (child: BlockInstance) => ReactNode;
}) {
  const count = columnCount(block);
  const children = (block.children ?? []).filter((child) => !child.hidden);
  const gap = String(blockProp(block, 'gap', 'normal'));
  return (
    <div className={`pp-columns pp-columns-${count} pp-columns-gap-${gap}`} data-pp-columns={count}>
      {Array.from({ length: count }, (_, index) => {
        const column = index + 1;
        const items = children.filter((child) => (child.column ?? 1) === column);
        return (
          <div className="pp-column" key={column} data-pp-column={column}>
            {items.map((child) => renderChild(child))}
          </div>
        );
      })}
    </div>
  );
}
