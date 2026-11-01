import { useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/session';
import { useBackend } from '../lib/backend';
import { ROLE_LABEL } from '../lib/format';
import { usePermissions } from '../lib/usePermissions';
import { useT } from '../lib/i18n';
import { Avatar } from './ui';
import { Icon, type IconName } from './Icon';

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  end?: boolean;
  badge?: number;
}

export function AdminShell() {
  const t = useT();
  const { me, site, logout, config } = useAuth();
  const { can, personal } = usePermissions();
  const backend = useBackend();
  const navigate = useNavigate();
  const location = useLocation();
  // 只写稿的成员（例如开放发布的社区站点）也能进后台，但不给管理与站点级页面。
  const adminOnly =
    can('moderate_content') || can('manage_member') || can('manage_site') || can('view_log');
  const authorOnly = !adminOnly && can('write_content');
  const [pending, setPending] = useState(0);
  const [pendingComments, setPendingComments] = useState(0);
  // 左侧导航可整体收起，状态记在本地。
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('pp.admin.side.collapsed') === '1';
    } catch {
      return false;
    }
  });

  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('pp.admin.side.collapsed', next ? '1' : '0');
      } catch {
        /* 本地存储不可用不影响收起 */
      }
      return next;
    });
  };

  // 后台固定纸白浅色，不跟随前台暗色主题；主题令牌只在站点前台生效。
  useEffect(() => {
    document.documentElement.dataset.surface = 'admin';
    return () => {
      delete document.documentElement.dataset.surface;
    };
  }, []);

  useEffect(() => {
    if (!can('moderate_content')) return;
    let alive = true;
    Promise.all([
      backend.listContent('article', { limit: 100 }),
      backend.listContent('post', { limit: 100 }),
    ])
      .then(([articles, posts]) => {
        if (!alive) return;
        const all = [...articles.items, ...posts.items];
        setPending(all.filter((c) => c.status === 'pending_review').length);
      })
      .catch(() => {
        /* 徽标失败不影响导航 */
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, location.pathname]);

  useEffect(() => {
    if (!can('moderate_comment')) return;
    let alive = true;
    backend
      .allComments({ status: 'pending_review', limit: 1 })
      .then((page) => {
        if (alive) setPendingComments(page.counts?.pending_review ?? page.items.length);
      })
      .catch(() => {
        /* 评论徽标失败不影响导航 */
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, location.pathname]);

  const themeItems: NavItem[] = can('manage_site')
    ? ([
        { to: '/admin/themes', label: t('主题设置'), icon: 'palette' },
        { to: '/admin/appearance', label: t('外观'), icon: 'image' },
        { to: '/admin/extensions', label: t('扩展'), icon: 'grid' },
      ] as NavItem[])
    : [];

  const siteItems: NavItem[] = [
    ...(can('manage_site')
      ? ([{ to: '/admin/settings', label: t('站点设置'), icon: 'settings' }] as NavItem[])
      : []),
    ...(can('manage_site')
      ? ([{ to: '/admin/login-settings', label: t('登录设置'), icon: 'lock' }] as NavItem[])
      : []),
    ...(can('view_log') ? ([{ to: '/admin/activity', label: t('网站日志'), icon: 'clock' }] as NavItem[]) : []),
  ];

  // 站点设置内部的二级页：访问限制与域名绑定合并为一个界面。
  const siteSettingsRoutes = [
    '/admin/settings',
    '/admin/access',
    '/admin/seo',
    '/admin/performance',
    '/admin/storage',
    '/admin/verification',
  ];
  const inSiteSettings = siteSettingsRoutes.some(
    (path) => location.pathname === path || location.pathname.startsWith(`${path}/`),
  );
  const siteSubItems: NavItem[] = can('manage_site')
    ? ([
        { to: '/admin/settings', label: t('基本信息'), icon: 'settings' },
        { to: '/admin/access', label: t('访问与域名'), icon: 'shield' },
        { to: '/admin/verification', label: t('人机验证'), icon: 'lock' },
        { to: '/admin/seo', label: 'SEO', icon: 'search' },
        { to: '/admin/performance', label: t('性能优化'), icon: 'server' },
        { to: '/admin/storage', label: t('存储策略'), icon: 'database' },
      ] as NavItem[])
    : [];

  const contentItems: NavItem[] = [
    ...(can('write_content') || can('moderate_content')
      ? ([{ to: '/admin/content', label: t('内容库'), icon: 'file' }] as NavItem[])
      : []),
    ...(can('manage_site') ? ([{ to: '/admin/pages', label: t('页面'), icon: 'layers' }] as NavItem[]) : []),
    ...(can('write_content') || can('moderate_content')
      ? ([{ to: '/admin/taxonomy', label: t('分类与标签'), icon: 'tag' }] as NavItem[])
      : []),
    ...(can('moderate_content')
      ? ([{ to: '/admin/review', label: t('审核队列'), icon: 'shield', badge: pending }] as NavItem[])
      : []),
    ...(can('moderate_comment')
      ? ([
          {
            to: '/admin/comments',
            label: t('评论与审核'),
            icon: 'message',
            badge: pendingComments,
          },
        ] as NavItem[])
      : []),
    ...(can('write_content') ? ([{ to: '/admin/media', label: t('媒体库'), icon: 'image' }] as NavItem[]) : []),
  ];

  const userItems: NavItem[] = [
    ...(can('manage_member') ? ([{ to: '/admin/users', label: t('用户管理'), icon: 'users' }] as NavItem[]) : []),
    ...(can('manage_permission')
      ? ([{ to: '/admin/permissions', label: t('用户组'), icon: 'shield' }] as NavItem[])
      : []),
  ];

  const groups: { label: string; items: NavItem[] }[] = [
    ...(adminOnly
      ? ([
          {
            label: t('概览'),
            items: [{ to: '/admin', label: t('仪表盘'), icon: 'home', end: true }],
          },
        ] as { label: string; items: NavItem[] }[])
      : []),
    ...(contentItems.length ? [{ label: t('内容'), items: contentItems }] : []),
    ...(userItems.length ? [{ label: t('用户'), items: userItems }] : []),
    ...(themeItems.length ? [{ label: t('主题设置'), items: themeItems }] : []),
    ...(siteItems.length ? [{ label: t('站点'), items: siteItems }] : []),
    {
      label: t('系统'),
      items: [
        { to: '/admin/docs', label: t('调用接口'), icon: 'code' },
      ],
    },
  ];

  const titles: { match: RegExp; title: string }[] = [
    { match: /^\/admin\/content\/new/, title: t('新建内容') },
    { match: /^\/admin\/content\/[^/]+/, title: t('编辑内容') },
    { match: /^\/admin\/content$/, title: t('内容库') },
    { match: /^\/admin\/taxonomy/, title: t('分类与标签') },
    { match: /^\/admin\/review/, title: t('审核队列') },
    { match: /^\/admin\/comments/, title: t('评论与审核') },
    { match: /^\/admin\/pages\/new/, title: t('新建页面') },
    { match: /^\/admin\/pages\/[^/]+/, title: t('编辑页面') },
    { match: /^\/admin\/pages/, title: t('页面') },
    { match: /^\/admin\/themes/, title: t('主题设置') },
    { match: /^\/admin\/appearance/, title: t('外观') },
    { match: /^\/admin\/loading/, title: t('加载动画') },
    { match: /^\/admin\/theme/, title: t('页面编排') },
    { match: /^\/admin\/extensions/, title: t('扩展') },
    { match: /^\/admin\/access/, title: t('访问与域名') },
    { match: /^\/admin\/domains/, title: t('访问与域名') },
    { match: /^\/admin\/verification/, title: t('人机验证') },
    { match: /^\/admin\/performance/, title: t('性能优化') },
    { match: /^\/admin\/storage/, title: t('存储策略') },
    { match: /^\/admin\/(members|users)/, title: t('用户管理') },
    { match: /^\/admin\/permissions/, title: t('用户组') },
    { match: /^\/admin\/settings/, title: t('站点设置') },
    { match: /^\/admin\/login-settings/, title: t('登录设置') },
    { match: /^\/admin\/media/, title: t('媒体库') },
    { match: /^\/admin\/activity/, title: t('网站日志') },
    { match: /^\/admin\/docs/, title: t('调用接口') },
    { match: /^\/admin$/, title: t('仪表盘') },
  ];
  const section = titles.find((item) => item.match.test(location.pathname))?.title ?? t('管理后台');
  const isContentEditor = /^\/admin\/content\/(new\/)?[^/]+(?:\/[^/]+)?$/.test(location.pathname);
  const isWideEditor = isContentEditor || /^\/admin\/theme(?:\/|$)/.test(location.pathname);

  const handleLogout = async () => {
    await logout();
    navigate('/');
  };

  // 成员没有仪表盘权限：直接落到内容库，避免请求站点级统计。
  if (authorOnly && location.pathname === '/admin') {
    return <Navigate to="/admin/content" replace />;
  }

  return (
    <div
      className={`admin-shell${inSiteSettings ? ' has-subnav' : ''}${
        collapsed ? ' is-side-collapsed' : ''
      }`}
    >
      <aside className="admin-side">
        <button
          type="button"
          className="admin-side-collapse"
          onClick={toggleCollapsed}
          aria-label={t('收起侧边栏')}
          title={t('收起侧边栏')}
        >
          <Icon name="chevron-left" size={15} />
        </button>
        <Link to="/admin" className="admin-brand">
          <span className="brand-mark">{Array.from(site?.name ?? 'P')[0]}</span>
          <span className="admin-brand-text">
            Practacu Press
            <small>Admin</small>
          </span>
        </Link>

        <div className="admin-site">
          <strong>{site?.name ?? t('站点')}</strong>
          <span>{site?.domain || 'press.local'}</span>
        </div>

        <nav className="admin-nav" aria-label={t('后台导航')}>
          {groups.map((group) => (
            <div key={group.label} style={{ display: 'contents' }}>
              <p className="admin-nav-label">{group.label}</p>
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) =>
                    `admin-nav-link${
                      isActive || (item.to === '/admin/settings' && inSiteSettings) ? ' is-active' : ''
                    }`
                  }
                >
                  <Icon name={item.icon} size={15} />
                  <span>{item.label}</span>
                  {item.badge ? <span className="admin-nav-badge">{item.badge}</span> : null}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="admin-side-foot">
          <Link to="/">
            <Icon name="arrow-left" size={14} /> {t('返回站点')}
          </Link>
          {config.mode === 'demo' ? (
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', fontSize: 12, color: 'var(--muted)' }}>
              <Icon name="database" size={14} /> {t('演示数据（浏览器本地）')}
            </span>
          ) : (
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', fontSize: 12, color: 'var(--muted)' }}>
              <Icon name="server" size={14} /> {backend.origin || window.location.origin}
            </span>
          )}
          <button type="button" onClick={handleLogout}>
            <Icon name="logout" size={14} /> {t('退出登录')}
          </button>
        </div>
      </aside>

      {collapsed ? (
        <button
          type="button"
          className="admin-side-expand"
          onClick={toggleCollapsed}
          aria-label={t('展开侧边栏')}
          title={t('展开侧边栏')}
        >
          <Icon name="chevron-right" size={15} />
        </button>
      ) : null}

      {inSiteSettings ? (
        <aside className="admin-subnav" aria-label={t('站点设置导航')}>
          <p className="admin-subnav-label">{t('站点设置')}</p>
          {siteSubItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `admin-subnav-link${isActive ? ' is-active' : ''}`}
            >
              <Icon name={item.icon} size={14} />
              <span>{item.label}</span>
            </NavLink>
          ))}
        </aside>
      ) : null}

      <div className="admin-main">
        <div className="admin-topbar">
          <div>
            <p className="crumb">{t('管理后台')} / {section}</p>
            <h1>{section}</h1>
          </div>
          <div className="admin-topbar-actions">
            {can('write_content') ? (
              <Link to="/admin/content/new/article" className="btn btn-secondary btn-sm">
                <Icon name="edit" size={14} /> {t('写新稿')}
              </Link>
            ) : null}
            <Link to="/" className="btn btn-ghost btn-sm admin-hide-sm">
              <Icon name="eye" size={14} /> {t('查看站点')}
            </Link>
            <span className="chip admin-hide-sm">
              {personal ? t('最高管理员') : me ? ROLE_LABEL[me.role] : '—'}
            </span>
            <Avatar name={me?.user.display_name} size={28} />
          </div>
        </div>

        <div className={`admin-content fade-up${isWideEditor ? ' admin-content-wide' : ''}`}>
          <Outlet />
        </div>
      </div>
    </div>
  );
}
