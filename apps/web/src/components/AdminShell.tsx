import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/session';
import { useBackend } from '../lib/backend';
import { useAdminTheme } from '../lib/adminTheme';
import { ROLE_LABEL } from '../lib/format';
import { usePermissions } from '../lib/usePermissions';
import { navigateWithTransition } from '../lib/themeTransition';
import { useT } from '../lib/i18n';
import {
  adminPageGroup,
  adminPageIcon,
  useAdminPages,
  type AdminPageEntry,
} from '../lib/plugins/adminRegistry';
import { Avatar } from './ui';
import { useMediaSrc } from '../lib/assetUrl';
import { Icon, type IconName } from './Icon';

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  end?: boolean;
  badge?: number;
}

/**
 * 侧栏身份卡上的头像：管理员设置过头像时读媒体库，否则退回姓名首字。
 *
 * 站内媒体要带鉴权的 blob URL，统一走 `useMediaSrc`；失败时仍然显示首字，
 * 不让侧栏出现一个空白框。
 */
function AdminAvatar({
  name,
  assetId,
  size,
}: {
  name?: string;
  assetId?: string | null;
  size: number;
}) {
  const { src } = useMediaSrc(assetId ? `/api/v1/media/${assetId}` : '');
  if (!src) return <Avatar name={name} size={size} />;
  return (
    <img
      className="admin-identity-img"
      src={src}
      alt={name ?? ''}
      width={size}
      height={size}
    />
  );
}

/** 快捷键只在不输入文字时生效：在搜索框里按 Shift+D 应该输入大写 D。 */
function isTypingTarget(): boolean {
  const el = typeof document === 'undefined' ? null : document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return (el as HTMLElement).isContentEditable === true;
}

export function AdminShell() {
  const t = useT();
  const { me, site, logout, config } = useAuth();
  const { can, personal } = usePermissions();
  const backend = useBackend();
  // 扩展注册的后台页面：subscribe 到注册表，注册/清理后侧栏与标题实时更新。
  // overview 组排在仪表盘之后，只有平台管理员看到（性能面板里的数据也要求这个角色）；
  // extensions 组在下面单独成「扩展页面」。
  const adminPages = useAdminPages();
  const overviewPages =
    me?.role === 'platform_admin'
      ? adminPages.filter((entry) => adminPageGroup(entry.page) === 'overview')
      : [];
  const extensionPages = adminPages.filter((entry) => adminPageGroup(entry.page) === 'extensions');
  const navigate = useNavigate();
  const location = useLocation();
  // 后台的明暗偏好与站点主题解耦：默认亮色，切换后写 localStorage，刷新仍保持。
  const { mode: adminTheme, setMode: setAdminTheme, toggle: toggleAdminTheme } = useAdminTheme();
  // 后台只服务管理员：普通成员写稿走 `/write`，不会渲染这个外壳。
  const adminOnly =
    can('moderate_content') || can('manage_member') || can('manage_site') || can('view_log');
  const [pending, setPending] = useState(0);
  const [pendingComments, setPendingComments] = useState(0);
  const [pendingReports, setPendingReports] = useState(0);
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

  // 侧栏不再 display:none，而是 200ms 内滑出/淡出；收起后原按钮不可见，
  // 把焦点交给「展开」按钮，键盘用户不会丢失当前位置。
  const expandRef = useRef<HTMLButtonElement>(null);
  const collapseRef = useRef<HTMLButtonElement>(null);
  const toggledOnce = useRef(false);
  useEffect(() => {
    if (!toggledOnce.current) {
      toggledOnce.current = true;
      return;
    }
    (collapsed ? expandRef : collapseRef).current?.focus({ preventScroll: true });
  }, [collapsed]);

  // 后台有自己的明暗模式：固定 data-surface=admin 隔离站点主题，data-admin-theme
  // 交给 themeCss 里的后台深色令牌。用 layout effect 在绘制前落属性，避免闪白。
  useLayoutEffect(() => {
    const root = document.documentElement;
    const previousColorScheme = root.style.colorScheme;
    root.dataset.surface = 'admin';
    root.dataset.adminTheme = adminTheme;
    root.style.colorScheme = adminTheme;
    return () => {
      delete root.dataset.surface;
      delete root.dataset.adminTheme;
      root.style.colorScheme = previousColorScheme;
    };
  }, [adminTheme]);

  // 站点前台有全局 Shift+D；后台不在 CommandLayer 里，所以单独挂一个同款快捷键。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key !== 'D' && event.key !== 'd') return;
      if (isTypingTarget()) return;
      event.preventDefault();
      toggleAdminTheme();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleAdminTheme]);

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

  useEffect(() => {
    if (!can('moderate_content')) return;
    let alive = true;
    backend
      .reports()
      .then((items) => {
        if (alive) setPendingReports(items.length);
      })
      .catch(() => {
        /* 举报徽标失败不影响导航 */
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, location.pathname]);

  const themeItems: NavItem[] = can('manage_site')
    ? ([
        { to: '/admin/themes/choose', label: t('选择主题'), icon: 'grid' },
        { to: '/admin/themes', label: t('主题设置'), icon: 'palette', end: true },
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
    // 「站点更新」排在「登录设置」之后：安装 / 登录相关入口在前，更新属于维护动作。
    ...(can('manage_site')
      ? ([{ to: '/admin/update', label: t('站点更新'), icon: 'refresh' }] as NavItem[])
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
    '/admin/data',
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
        { to: '/admin/storage', label: t('储存策略'), icon: 'database' },
        { to: '/admin/data', label: t('数据与备份'), icon: 'download' },
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
      ? ([
          { to: '/admin/review', label: t('审核队列'), icon: 'shield', badge: pending },
          { to: '/admin/reports', label: t('举报队列'), icon: 'alert', badge: pendingReports },
        ] as NavItem[])
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

  // 接口契约只对能改站点的人有用，也只该给他们看：调用接口页列出全部端点、
  // 鉴权方式与错误码结构，普通成员没有任何理由看到这份后台地图。
  const systemItems: NavItem[] = [
    ...(me?.role === 'platform_admin' && config.mode !== 'demo'
      ? ([{ to: '/admin/platform', label: t('站点平台'), icon: 'server' }] as NavItem[])
      : []),
    ...(can('manage_site')
      ? ([{ to: '/admin/docs', label: t('调用接口'), icon: 'code' }] as NavItem[])
      : []),
  ];

  /** 扩展注册的后台页面 → 侧栏项（`/admin/ext/{slug}`，未知图标回退 grid）。 */
  const pageNavItem = (entry: AdminPageEntry): NavItem => ({
    to: `/admin/ext/${entry.page.path}`,
    label: entry.page.label,
    icon: adminPageIcon(entry.page),
  });

  const groups: { label: string; items: NavItem[] }[] = [
    ...(adminOnly
      ? ([
          {
            label: t('概览'),
            items: [
              { to: '/admin', label: t('仪表盘'), icon: 'home', end: true },
              // 性能面板等 overview 组扩展页：紧贴仪表盘，位置与原写死的入口一致。
              // 入口只在平台管理员角色下出现（页面内部还会再校验一次数据权限）。
              ...overviewPages.map(pageNavItem),
            ],
          },
        ] as { label: string; items: NavItem[] }[])
      : []),
    ...(contentItems.length ? [{ label: t('内容'), items: contentItems }] : []),
    ...(userItems.length ? [{ label: t('用户'), items: userItems }] : []),
    ...(themeItems.length ? [{ label: t('主题设置'), items: themeItems }] : []),
    ...(siteItems.length ? [{ label: t('站点'), items: siteItems }] : []),
    ...(systemItems.length ? [{ label: t('系统'), items: systemItems }] : []),
    // 其它扩展页（group 缺省按 extensions 处理）单独成组，避免和核心导航混在一起。
    ...(adminOnly && extensionPages.length
      ? [{ label: t('扩展页面'), items: extensionPages.map(pageNavItem) }]
      : []),
  ];

  const titles: { match: RegExp; title: string }[] = [
    { match: /^\/admin\/content\/new/, title: t('新建内容') },
    { match: /^\/admin\/content\/[^/]+/, title: t('编辑内容') },
    { match: /^\/admin\/content$/, title: t('内容库') },
    { match: /^\/admin\/taxonomy/, title: t('分类与标签') },
    { match: /^\/admin\/review/, title: t('审核队列') },
    { match: /^\/admin\/comments/, title: t('评论与审核') },
    { match: /^\/admin\/reports/, title: t('举报队列') },
    { match: /^\/admin\/pages\/new/, title: t('新建页面') },
    { match: /^\/admin\/pages\/[^/]+/, title: t('编辑页面') },
    { match: /^\/admin\/pages/, title: t('页面') },
    { match: /^\/admin\/themes\/choose/, title: t('选择主题') },
    { match: /^\/admin\/themes/, title: t('主题设置') },
    { match: /^\/admin\/appearance/, title: t('外观') },
    { match: /^\/admin\/loading/, title: t('加载动画') },
    { match: /^\/admin\/theme/, title: t('页面编排') },
    { match: /^\/admin\/platform\/overview/, title: t('平台总览') },
    { match: /^\/admin\/platform\/audit/, title: t('跨站审计') },
    { match: /^\/admin\/platform\/users/, title: t('平台用户') },
    { match: /^\/admin\/platform\/new/, title: t('新建站点') },
    { match: /^\/admin\/platform\/[^/]+/, title: t('站点详情') },
    { match: /^\/admin\/platform/, title: t('站点平台') },
    { match: /^\/admin\/extensions/, title: t('扩展') },
    { match: /^\/admin\/access/, title: t('访问与域名') },
    { match: /^\/admin\/domains/, title: t('访问与域名') },
    { match: /^\/admin\/verification/, title: t('人机验证') },
    { match: /^\/admin\/performance/, title: t('性能优化') },
    { match: /^\/admin\/storage/, title: t('储存策略') },
    { match: /^\/admin\/data/, title: t('数据与备份') },
    { match: /^\/admin\/(members|users)/, title: t('用户管理') },
    { match: /^\/admin\/permissions/, title: t('用户组') },
    { match: /^\/admin\/settings/, title: t('站点设置') },
    { match: /^\/admin\/update/, title: t('站点更新') },
    { match: /^\/admin\/login-settings/, title: t('登录设置') },
    { match: /^\/admin\/media/, title: t('媒体库') },
    { match: /^\/admin\/activity/, title: t('网站日志') },
    { match: /^\/admin\/docs/, title: t('调用接口') },
    { match: /^\/admin$/, title: t('仪表盘') },
  ];
  // 扩展页面的标题取注册表里的 label（性能面板的中文/英文名不再写死在这里）。
  const extensionSlug = /^\/admin\/ext\/([^/]+)/.exec(location.pathname)?.[1];
  const extensionPage = extensionSlug ? adminPages.find((entry) => entry.page.path === extensionSlug) : undefined;
  const section =
    extensionPage?.page.label ?? titles.find((item) => item.match.test(location.pathname))?.title ?? t('管理后台');
  const isContentEditor = /^\/admin\/content\/(new\/)?[^/]+(?:\/[^/]+)?$/.test(location.pathname);
  const isWideEditor = isContentEditor || /^\/admin\/theme(?:\/|$)/.test(location.pathname);

  const handleLogout = async () => {
    await logout();
    navigateWithTransition(() => navigate('/'));
  };

  return (
    <div
      className={`admin-shell${collapsed ? ' is-side-collapsed' : ''}`}
    >
      <aside className="admin-side" id="admin-sidebar">
        <button
          ref={collapseRef}
          type="button"
          className="admin-side-collapse"
          onClick={toggleCollapsed}
          aria-label={t('收起侧边栏')}
          aria-controls="admin-sidebar"
          aria-expanded={!collapsed}
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

        <Link
          to="/me"
          className="admin-identity"
          title={t('查看账户资料')}
          aria-label={t('当前管理员：{name}', { name: me?.user.display_name ?? t('管理员') })}
        >
          <span className="admin-identity-avatar">
            <AdminAvatar
              name={me?.user.display_name}
              assetId={me?.user.avatar_media_id}
              size={42}
            />
            {/* 已登录才会渲染后台外壳：这个绿点表示当前会话在线。 */}
            <span className="admin-identity-online" aria-hidden="true" />
          </span>
          <span className="admin-identity-body">
            <strong className="admin-identity-name">{me?.user.display_name ?? t('管理员')}</strong>
            {me?.user.email ? (
              <span className="admin-identity-email">{me.user.email}</span>
            ) : (
              <span className="admin-identity-email">{site?.name ?? t('站点')}</span>
            )}
          </span>
        </Link>

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
          ref={expandRef}
          type="button"
          className="admin-side-expand"
          onClick={toggleCollapsed}
          aria-label={t('展开侧边栏')}
          aria-controls="admin-sidebar"
          title={t('展开侧边栏')}
        >
          <Icon name="chevron-right" size={15} />
        </button>
      ) : null}

      <div className="admin-main">
        <div className="admin-topbar">
          <div>
            <p className="crumb">{t('管理后台')} / {section}</p>
            <h1>{section}</h1>
          </div>
          <div className="admin-topbar-actions">
            <div
              className="admin-theme-switch"
              role="group"
              aria-label={t('后台明暗模式')}
            >
              <button
                type="button"
                className={adminTheme === 'light' ? 'is-active' : undefined}
                aria-pressed={adminTheme === 'light'}
                aria-label={t('亮色模式')}
                title={t('亮色模式')}
                onClick={() => setAdminTheme('light')}
              >
                <Icon name="sun" size={14} />
                <span>{t('亮色')}</span>
              </button>
              <button
                type="button"
                className={adminTheme === 'dark' ? 'is-active' : undefined}
                aria-pressed={adminTheme === 'dark'}
                aria-label={t('暗色模式')}
                title={t('暗色模式（Shift+D）')}
                onClick={() => setAdminTheme('dark')}
              >
                <Icon name="moon" size={14} />
                <span>{t('暗色')}</span>
              </button>
            </div>
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

        {inSiteSettings ? (
          <nav className="admin-subnav" aria-label={t('站点设置导航')}>
            <span className="admin-subnav-label">{t('站点设置')}</span>
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
          </nav>
        ) : null}

        <div className={`admin-content fade-up${isWideEditor ? ' admin-content-wide' : ''}`}>
          <div
            className="route-transition"
            key={location.pathname}
          >
            <Outlet />
          </div>
        </div>
      </div>
    </div>
  );
}
