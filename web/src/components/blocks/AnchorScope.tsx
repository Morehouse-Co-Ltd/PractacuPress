import { createContext, useContext, useMemo, type ReactNode } from 'react';
import type { BlockInstance } from '../../types';
import { anchorIds, anchorTargets, type AnchorTarget } from '../../lib/anchorNav';

/**
 * 本页的锚点分配结果。
 *
 * 为什么要一层 context 而不是让区块自己读 `block.anchor`：**去重需要看见整页**。
 * 「重复锚点只有第一个生效」是一个跨区块的判断，单个 `BlockView` 只知道自己，
 * 它既不知道前面有没有人先用过这个锚点，也不知道自己排第几。所以整页在
 * `ScreenRenderer` 里算一趟（`anchorIds` / `anchorTargets`，见 `lib/anchorNav.ts`），
 * 再往下发：
 *
 * - `ids`：区块 id → 锚点，区块外壳据此决定自己要不要画 `id`；
 * - `targets`：目录区块要列的目标（文档顺序、已去重）。
 *
 * 两者出自同一趟遍历，所以目录里列出来的链接一定能在页面上找到对应的 `id`——
 * 不会出现「目录里有、点过去没反应」的死链。
 *
 * 默认值（没有 provider）是空的：单独预览一个区块时不该凭空冒出一个 `id`，
 * 那会和真实页面上的分配结果打架。
 */
export interface AnchorScope {
  ids: Map<string, string>;
  targets: AnchorTarget[];
}

const EMPTY: AnchorScope = { ids: new Map(), targets: [] };

const AnchorScopeContext = createContext<AnchorScope>(EMPTY);

export function AnchorScopeProvider({
  blocks,
  children,
}: {
  blocks: BlockInstance[];
  children: ReactNode;
}) {
  const value = useMemo<AnchorScope>(
    () => ({ ids: anchorIds(blocks), targets: anchorTargets(blocks) }),
    [blocks],
  );
  return <AnchorScopeContext.Provider value={value}>{children}</AnchorScopeContext.Provider>;
}

export function useAnchorScope(): AnchorScope {
  return useContext(AnchorScopeContext);
}
