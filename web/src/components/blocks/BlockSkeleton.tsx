import type { BlockInstance } from '../../types';
import type { SkeletonShape } from '../../lib/loading';
import { blockProp } from '../../lib/blocks';
import { SkeletonCard, SkeletonGrid, SkeletonLine, SkeletonPanel, SkeletonRow } from '../ui';

/**
 * 页面编排的区块骨架。
 *
 * 由 `BlockView` 在骨架模式 + 内容加载中时接管：外壳（宽度、最小高度、外观、
 * 自定义 CSS、data 属性）仍是真实区块的，只有内部换成与最终版式同形状的占位，
 * 数据到达后原地替换，位置不跳。
 *
 * 行数/列数从区块属性读取并 clamp：坏数据回退默认值，避免站长填一个极端值后
 * 骨架比真实内容高出一大截。
 */

/** 数字属性：`Number()` 后取整并夹到 [min, max]；非法值回退默认。 */
function countProp(
  block: BlockInstance,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const value = Number(blockProp(block, key, fallback));
  const safe = Number.isFinite(value) ? Math.round(value) : fallback;
  return Math.min(max, Math.max(min, safe));
}

/** 标题行：给骨架一个和真实区块小标题相同的起点。 */
function TitleLine() {
  return <SkeletonLine width="42%" />;
}

export function BlockSkeleton({ block, shape }: { block: BlockInstance; shape: SkeletonShape }) {
  switch (shape) {
    // 内容流：左主栏三张卡 + 右侧两个小面板，对应 feed 的「主栏 / 侧栏」版式。
    case 'feed':
      return (
        <div className="pp-skel-feed">
          <div className="pp-skel-feed-main">
            <TitleLine />
            {Array.from({ length: 3 }, (_, index) => (
              <SkeletonCard key={index} />
            ))}
          </div>
          <div className="pp-skel-feed-side">
            <SkeletonPanel lines={4} />
            <SkeletonPanel lines={3} />
          </div>
        </div>
      );

    // 列表：标题行 + limit 条列表行，与归档/最近内容的一行一条对齐。
    case 'list': {
      const rows = countProp(block, 'limit', 4, 2, 8);
      return (
        <div className="pp-skel-list">
          <TitleLine />
          {Array.from({ length: rows }, (_, index) => (
            <SkeletonRow key={index} />
          ))}
        </div>
      );
    }

    // 网格：列数 2–4，卡片数 2–8；标题行下留出与网格相同的间距。
    case 'grid': {
      const columns = countProp(block, 'columns', 2, 2, 4);
      const cards = countProp(block, 'limit', 4, 2, 8);
      return (
        <div className="pp-skel-list">
          <TitleLine />
          <SkeletonGrid columns={columns} count={cards} />
        </div>
      );
    }

    // 精选大卡：一块封面 + 三行标题/摘要。
    case 'feature':
      return <SkeletonCard lines={3} />;

    // 聚光：三张卡，第一张由 CSS 自动占满整行（一大两小）。
    case 'mosaic':
      return (
        <div className="pp-skel-mosaic">
          {Array.from({ length: 3 }, (_, index) => (
            <SkeletonCard key={index} />
          ))}
        </div>
      );

    // 侧栏/小卡：一个标题行 + 3–5 条短行。
    case 'aside':
      return <SkeletonPanel lines={countProp(block, 'limit', 3, 3, 5)} />;
  }
}
