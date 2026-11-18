import { createContext, useContext, type ReactNode } from 'react';
import type { SkeletonMotion } from '../lib/loading';

/**
 * 原位骨架模式。
 *
 * `null` 表示当前不在骨架模式（关闭加载、全屏预设、后台、安装向导、编排预览）。
 * 站点内容里的区块骨架据此决定要不要接管；具体 CSS 动效由 `<html data-pp-skeleton>`
 * 驱动，React 只负责“是否开启”。
 */
const PageSkeletonContext = createContext<SkeletonMotion | null>(null);

export function PageSkeletonProvider({
  motion,
  children,
}: {
  motion: SkeletonMotion | null;
  children: ReactNode;
}) {
  return (
    <PageSkeletonContext.Provider value={motion}>{children}</PageSkeletonContext.Provider>
  );
}

export function usePageSkeleton(): SkeletonMotion | null {
  return useContext(PageSkeletonContext);
}
