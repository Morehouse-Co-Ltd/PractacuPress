import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useT } from '../lib/i18n';
import { useTitle } from '../lib/hooks';
import { useAdminPages, type AdminPageEntry } from '../lib/plugins/adminRegistry';
import { Callout } from './ui';
import { Icon } from './Icon';

/**
 * 扩展注册的后台页面路由：`/admin/ext/:pageId`。
 *
 * 注册表里找得到就渲染扩展的 `render()`，找不到显示 404（旧的 `/admin/system`
 * 已重定向到 `/admin/ext/system`，所以老书签不会掉进这里）。
 *
 * 页面渲染包在独立错误边界里：一个扩展页面把 React 树抛穿，不该拖垮整个管理后台。
 */
export function AdminExtensionPage() {
  const t = useT();
  const { pageId = '' } = useParams();
  const pages = useAdminPages();
  const entry = findPage(pages, pageId);
  useTitle(entry ? entry.page.label : t('扩展页面不存在'));

  if (!entry) {
    return (
      <>
        <div className="admin-page-head">
          <div>
            <h1>{t('扩展页面不存在')}</h1>
            <p>
              {t('没有扩展注册路径为 /admin/ext/{slug} 的页面，它可能已被停用或卸载。', {
                slug: pageId || '—',
              })}
            </p>
          </div>
          <div className="admin-page-actions">
            <Link to="/admin" className="btn btn-secondary btn-sm">
              <Icon name="arrow-left" size={14} />
              <span>{t('返回管理后台')}</span>
            </Link>
          </div>
        </div>
        <Callout tone="warn" icon="alert" title={t('扩展页面不存在')}>
          {t('页面地址只对当前已注册的扩展有效；扩展重新启用后刷新即可恢复。')}
        </Callout>
      </>
    );
  }

  return (
    <div className="admin-ext-page" data-pp-admin-plugin={entry.pluginID}>
      <AdminPageBoundary
        key={`${entry.pluginID}:${entry.page.id}`}
        pluginID={entry.pluginID}
        fallback={
          <Callout tone="danger" icon="alert" title={t('扩展页面渲染失败')}>
            {t('扩展 {id} 的页面在渲染时出错，管理后台的其它页面不受影响。', {
              id: entry.pluginID,
            })}
          </Callout>
        }
      >
        <AdminPageContribution render={entry.page.render} />
      </AdminPageBoundary>
    </div>
  );
}

function findPage(pages: AdminPageEntry[], slug: string): AdminPageEntry | undefined {
  if (!slug) return undefined;
  return pages.find((entry) => entry.page.path === slug);
}

/**
 * 在错误边界内部调用 `render()`。
 *
 * 若在 AdminExtensionPage 的 JSX 里直接写 `entry.page.render()`，调用发生在边界
 * 之外，抛错会带走整个后台；所以延后到边界子树里的这个小组件中执行。
 */
function AdminPageContribution({ render }: { render: () => ReactNode }) {
  return <>{render()}</>;
}

class AdminPageBoundary extends Component<
  { pluginID: string; fallback: ReactNode; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[pp plugin ${this.props.pluginID}] admin page failed`, error, info);
  }

  render(): ReactNode {
    if (this.state.failed) return <div className="admin-ext-fallback">{this.props.fallback}</div>;
    return this.props.children;
  }
}
