import { NavLink } from 'react-router-dom';
import { useT } from '../lib/i18n';

/**
 * 平台控制台的页签条。
 *
 * 部署级能力有三块：总览（整装快照）、站点（站点生命周期）与跨站审计 / 平台用户。
 * 它们是同一个控制台的子页而不是后台导航里的四个入口，所以用路由页签串起来：
 * 刷新、直达链接与浏览器后退都还能落在正确的子页上。
 */
const TABS: { to: string; label: string; end?: boolean }[] = [
  { to: '/admin/platform/overview', label: '总览' },
  { to: '/admin/platform', label: '站点', end: true },
  { to: '/admin/platform/audit', label: '跨站审计' },
  { to: '/admin/platform/users', label: '平台用户' },
];

export function PlatformTabs() {
  const t = useT();
  return (
    <nav className="tabs" aria-label={t('平台控制台页签')}>
      {TABS.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.end}
          className={({ isActive }) => (isActive ? 'tab is-active' : 'tab')}
        >
          {t(tab.label)}
        </NavLink>
      ))}
    </nav>
  );
}
