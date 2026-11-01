import { createContext, useContext, type ReactNode } from 'react';

/**
 * 当前正在渲染的界面。
 *
 * 留言箱这类需要“知道自己在哪个页面”的区块，靠它拿到稳定的 target_id：
 * 首页用 `home`，自定义页面用页面 id。这样同一份编排复用到多个页面时，
 * 留言不会串在一起。
 */
export interface ScreenScope {
  type: 'home' | 'page';
  id: string;
  /** 供区块展示的界面名称，例如页面标题。 */
  title?: string;
}

const DEFAULT_SCOPE: ScreenScope = { type: 'home', id: 'home' };

const ScreenScopeContext = createContext<ScreenScope>(DEFAULT_SCOPE);

export function ScreenScopeProvider({
  scope,
  children,
}: {
  scope: ScreenScope;
  children: ReactNode;
}) {
  return <ScreenScopeContext.Provider value={scope}>{children}</ScreenScopeContext.Provider>;
}

export function useScreenScope(): ScreenScope {
  return useContext(ScreenScopeContext);
}
