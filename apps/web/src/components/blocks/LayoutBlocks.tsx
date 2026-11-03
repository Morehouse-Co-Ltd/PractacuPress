import type { CSSProperties, ReactNode } from 'react';
import type { BlockInstance } from '../../types';
import { blockProp, gridCellVars, gridTemplate, sectionLayout } from '../../lib/blocks';
import { columnCount } from '../../lib/blockTree';

export function ContainerBlock({ children }: { children: ReactNode }) {
  return <div className="pp-stack">{children}</div>;
}

/**
 * 分栏容器：把子区块按 column 分成 2–4 列。
 *
 * 渲染器不自己递归，而是由 blocks/index.tsx 传入 renderChild，保证每一层都
 * 复用同一套 BlockView（动画、data-pp-block、隐藏过滤都在那里处理）。
 *
 * `block.children` 到这里已经过 hidden 与条件显示（`isVisibleAt`）的过滤：
 * 分栏只负责落位，不再自己判断谁能看——两处各写一遍多半会漏掉一处。
 */
export function ColumnsBlock({
  block,
  renderChild,
}: {
  block: BlockInstance;
  renderChild: (child: BlockInstance) => ReactNode;
}) {
  const count = columnCount(block);
  const children = block.children ?? [];
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

/**
 * 12 栏栅格：子区块按 span / offset 落位。
 *
 * 单元格里只写三档自定义属性（`--pp-span-base|md|sm`、`--pp-offset-base|md|sm`），
 * 具体哪一档生效由 `styles.css` 的**媒体查询**决定：预览是真实 iframe，它的宽度
 * 就是自己的视口，作者切设备档时浏览器按 768 / 1024 两个阈值自己重排。渲染器不参与，
 * `device` 也就没有用武之地——栅格档位与 `at` 覆盖层从此同看视口宽度，"我是哪台设备"
 * 只有一种答案。
 *
 * 三个档位的取值与「offset + span 不超过栏数」的夹取都在 `gridCellVars` 里算好，
 * 这里只负责把它们放到正确的元素上。
 */
export function GridBlock({
  block,
  renderChild,
}: {
  block: BlockInstance;
  renderChild: (child: BlockInstance) => ReactNode;
}) {
  const { columns, gap } = gridTemplate(block);
  const children = (block.children ?? []).filter((child) => !child.hidden);
  return (
    <div
      className="pp-grid"
      data-pp-grid={columns}
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, gap }}
    >
      {children.map((child) => (
        <div
          key={child.id}
          className="pp-grid-cell"
          data-pp-align={child.align}
          style={gridCellVars(child, columns) as CSSProperties}
        >
          {renderChild(child)}
        </div>
      ))}
    </div>
  );
}

/**
 * 分节：限宽 + 上下留白 + 可选底色与上下分隔线。
 *
 * 取宽 / 留白 / 颜色的取值与回落都在 `sectionLayout` 里，这里只负责摆 DOM：
 * 外层铺底色与留白（要通栏铺满），内层按档位限宽并居中。
 * 子区块由 `blocks/index.tsx` 过滤好再传进来，渲染器不自己递归。
 */
export function SectionBlock({
  block,
  children,
}: {
  block: BlockInstance;
  children: ReactNode;
}) {
  const { maxWidth, paddingY, background, divider } = sectionLayout(block);
  return (
    <section
      className={`pp-section${divider ? ' pp-section-divided' : ''}`}
      style={{
        paddingTop: paddingY,
        paddingBottom: paddingY,
        background: background ?? undefined,
      }}
    >
      <div className="pp-section-inner" style={{ maxWidth: maxWidth ? `${maxWidth}px` : undefined }}>
        {children}
      </div>
    </section>
  );
}
