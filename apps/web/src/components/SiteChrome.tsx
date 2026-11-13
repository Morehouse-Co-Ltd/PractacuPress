import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import type { NavChild, NavTab, SocialLink } from '../types';
import { useAuth } from '../lib/session';
import { useBackend, isDemo } from '../lib/backend';
import { ROLE_LABEL, VISIBILITY_LABEL, PUBLISH_LABEL } from '../lib/format';
import { useClickOutside } from '../lib/hooks';
import { useT } from '../lib/i18n';
import { isPersonalSite } from '../lib/site';
import { navPages, useCustomization, useThemeMode } from '../lib/customize';
import {
  footerBrand,
  footerColumnsForReader,
  navAlignOf,
  navHrefKind,
  navIconName,
  navIconPositionOf,
  navSubStyleOf,
  navTabActive,
  navTabGroupActive,
  navTabsForReader,
  safeHref,
  siteNavTabs,
  socialIconName,
} from '../lib/navigation';
import { usePermissions } from '../lib/usePermissions';
import { writingEntryPath } from '../lib/adminAccess';
import { adminPathOf } from '../lib/siteConfig';
import { navigateWithTransition } from '../lib/themeTransition';
import { BackToTop } from './ArticleTools';
import { CommandLayer } from './CommandLayer';
import { ExtensionRuntime } from './ExtensionRuntime';
import { FilingLinks } from './Filings';
import { LogicRuntime } from './LogicRuntime';
import { PreviewBridge } from './PreviewBridge';
import { SiteSearch } from './SiteSearch';
import { Avatar } from './ui';
import { Icon } from './Icon';

function isNavActive(pathname: string, key: string): boolean {
  return navTabActive(pathname, key);
}

/**
 * 认证流程（登录、注册、找回密码）使用极简外壳：只保留品牌与主题切换。
 *
 * 这几种页面本身就是整屏布局，顶部的主导航与「登录 / 开始使用」按钮在这里没有
 * 去处：点「登录」会跳回当前页，点「注册」会打断正在进行的找回流程。
 */
const AUTH_ROUTES = ['/login', '/register', '/forgot-password', '/reset-password'];

export function SiteChrome() {
  const t = useT();
  const { me, site, status, unread, logout, config } = useAuth();
  const { customization } = useCustomization();
  const { can, adminEntry } = usePermissions();
  const backend = useBackend();
  const demo = isDemo(backend);
  const personal = isPersonalSite(config);
  // O-3：站点关闭自助注册时不再显示注册入口；服务端仍会拒绝注册请求。
  const registrationClosed = site?.registration_open === false;
  // 管理员回后台编辑器，普通成员去写作台：后者不该为了写一篇稿子走进后台。
  const writeHref = writingEntryPath('article', adminEntry);
  // 站点可能把后台入口改成了 /manage 之类的别名；导航与页脚过滤后台链接时要用它。
  const adminPath = adminPathOf(config);
  const layout = customization.layout;
  const extensions = customization.extensions;
  const navigate = useNavigate();
  const location = useLocation();
  const bare = AUTH_ROUTES.includes(location.pathname);
  const [userOpen, setUserOpen] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const userRef = useRef<HTMLDivElement>(null);

  // 页头（最上方 Tab 栏）样式：经典 / 顶部透明 / 悬浮胶囊，滚动后切换状态。
  const headerStyle = layout.header_style ?? 'classic';
  const headerBlur = layout.header_blur !== false;
  const headerBlurAmount = layout.header_blur_amount ?? 10;
  const headerThreshold = layout.header_threshold ?? 8;
  const [scrolled, setScrolled] = useState(false);

  useClickOutside(userRef, () => setUserOpen(false), userOpen);

  useEffect(() => {
    document.documentElement.dataset.surface = 'site';
    return () => {
      delete document.documentElement.dataset.surface;
    };
  }, []);

  // 样式变体挂在 <html> 上，CSS 与子组件都能读到；离开站点外壳时清掉。
  useEffect(() => {
    document.documentElement.dataset.headerStyle = headerStyle;
    return () => {
      delete document.documentElement.dataset.headerStyle;
    };
  }, [headerStyle]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > headerThreshold);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
    // 路由切换后页面会滚回顶部，需要重新判断一次。
  }, [headerThreshold, location.pathname]);

  useEffect(() => {
    setUserOpen(false);
    setMobileOpen(false);
    window.scrollTo({ top: 0 });
  }, [location.pathname]);

  const navItems = (() => {
    const tabs = siteNavTabs(layout, navPages(customization)).tabs;
    // 能进后台的人保留站长配置的「管理后台」入口；普通读者看到的导航里不该有它。
    return adminEntry ? tabs : navTabsForReader(tabs, adminPath);
  })();
  // 页脚同为站长可编辑内容：旧安装的默认页脚带着一条「管理后台」，这里按身份过滤。
  const footerColumns = adminEntry
    ? layout.footer_columns
    : footerColumnsForReader(layout.footer_columns, adminPath);
  const activeTopTab = navItems.find((tab) => navTabGroupActive(location.pathname, tab));
  const activeSubStyle = activeTopTab ? navSubStyleOf(activeTopTab, layout) : layout.nav_sub_style;
  const socialLinks = layout.social_links ?? [];
  // 夜航（暗色双栏）把快捷链接放在左上角品牌旁；其它主题只在页脚出现。
  const showHeaderShortcuts =
    customization.active_theme === 'night' || customization.theme.preset === 'night';

  /** 快捷链接：页头紧凑图标，页脚图标 + 文字。 */
  const renderSocialLink = (link: SocialLink, compact: boolean) => {
    const href = safeHref(link.url);
    if (!href) return null;
    const external = /^https?:\/\//i.test(href);
    return (
      <a
        key={link.id}
        className={`shortcut-link${compact ? ' is-compact' : ''}`}
        href={href}
        aria-label={link.label}
        title={link.label}
        {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
      >
        <Icon name={socialIconName(link.platform)} size={compact ? 15 : 14} />
        {compact ? null : <span>{link.label}</span>}
      </a>
    );
  };

  const navIcon = (name: string | undefined) => {
    const icon = navIconName(name);
    return icon ? <Icon name={icon} size={14} className="nav-item-icon" /> : null;
  };

  /** Tab 内部：图标（左/右）+ 文字 + 下拉箭头。 */
  const renderNavLabel = (item: NavTab) => {
    const position = navIconPositionOf(item, layout);
    const showCaret = !!item.children?.length && navSubStyleOf(item, layout) === 'dropdown';
    return (
      <>
        {position === 'left' ? navIcon(item.icon) : null}
        <span>{item.label}</span>
        {position === 'right' ? navIcon(item.icon) : null}
        {showCaret ? <Icon name="chevron-down" size={12} className="nav-caret" /> : null}
      </>
    );
  };

  /** 二级入口：站内 / 外链 / 纯文字，三种与顶部 Tab 一致。 */
  const renderSubnavChild = (child: NavChild, showIcon = true) => {
    const active = isNavActive(location.pathname, child.href);
    const kind = navHrefKind(child.href);
    const content = (
      <>
        {showIcon ? navIcon(child.icon) : null}
        <span>{child.label}</span>
      </>
    );
    if (kind === 'plain') {
      return (
        <span key={child.id} className="subnav-plain">
          {content}
        </span>
      );
    }
    if (kind === 'external') {
      return (
        <a key={child.id} href={child.href} target="_blank" rel="noreferrer" className={active ? 'is-active' : undefined}>
          {content}
          <Icon name="external" size={10} className="subnav-external" />
        </a>
      );
    }
    return (
      <Link key={child.id} to={child.href} className={active ? 'is-active' : undefined}>
        {content}
      </Link>
    );
  };

  /**
   * 顶部 Tab 的三种形态：站内链接、外链、纯文字分组。
   * 有二级入口且选择下拉菜单时，外面再包一层可悬停/聚焦触发的菜单。
   */
  const renderNavItem = (item: NavTab) => {
    const active = navTabGroupActive(location.pathname, item);
    const kind = navHrefKind(item.href);
    const withDropdown = !!item.children?.length && navSubStyleOf(item, layout) === 'dropdown';
    const label = renderNavLabel(item);
    let link;
    if (kind === 'plain') {
      link = <span className="nav-plain">{label}</span>;
    } else if (kind === 'external') {
      link = (
        <a href={item.href} target="_blank" rel="noreferrer" className={active ? 'is-active' : undefined}>
          {label}
          <Icon name="external" size={11} className="nav-external" />
        </a>
      );
    } else {
      link = (
        <Link to={item.href} className={active ? 'is-active' : undefined}>
          {label}
        </Link>
      );
    }
    if (!withDropdown) return <span key={item.id} className="nav-item">{link}</span>;
    return (
      <div key={item.id} className={`nav-dropdown${active ? ' is-active' : ''}`}>
        {link}
        <div className="nav-dropdown-menu" role="menu">
          {(item.children ?? []).map((child) => renderSubnavChild(child))}
        </div>
      </div>
    );
  };

  const announceText = extensions.announcement ? layout.announcement.trim() : '';
  const announceLink = layout.announcement_link.trim();
  const announceHref = /^https?:\/\//.test(announceLink)
    ? announceLink
    : announceLink.startsWith('/') && !announceLink.startsWith('//')
      ? announceLink
      : '';
  const [closedAnnounce, setClosedAnnounce] = useState(() => {
    try {
      return localStorage.getItem('pp.announce.closed') ?? '';
    } catch {
      return '';
    }
  });
  const showAnnounce = !!announceText && closedAnnounce !== announceText;
  const dismissAnnounce = () => {
    try {
      localStorage.setItem('pp.announce.closed', announceText);
    } catch {
      /* 忽略存储失败 */
    }
    setClosedAnnounce(announceText);
  };

  const siteName = site?.name ?? 'Practacu Press';
  // 页脚品牌区：每一项都能被站长覆盖，留空时回退到站点信息。
  const footer = footerBrand(layout, siteName, site?.description ?? '');
  const { mode: themeMode, toggle: toggleThemeMode } = useThemeMode();

  const handleLogout = async () => {
    await logout();
    navigateWithTransition(() => navigate('/'));
  };

  return (
    <div className="site">
      <header
        className={`site-header${scrolled ? ' is-scrolled' : ''}${headerBlur ? ' has-blur' : ''}`}
        data-blur={headerBlur ? 'on' : 'off'}
        data-header-style={headerStyle}
        style={{ '--header-blur': `${headerBlurAmount}px` } as CSSProperties}
      >
        <div className="shell header-inner">
          <Link to="/" className="brand" aria-label={t('{site} 首页', { site: siteName })}>
            <span className="brand-mark">{Array.from(siteName)[0] ?? 'P'}</span>
            <span>
              <span className="brand-text">{siteName}</span>
              <span className="brand-sub">{layout.brand_sub || 'Independent publishing'}</span>
            </span>
          </Link>

          {!bare && showHeaderShortcuts && socialLinks.length ? (
            <div className="brand-shortcuts" aria-label={t('快捷链接')}>
              {socialLinks.map((link) => renderSocialLink(link, true))}
            </div>
          ) : null}

          {bare ? null : (
            <nav className={`site-nav nav-align-${navAlignOf(layout)}`} aria-label={t('主导航')}>
              {navItems.map(renderNavItem)}
            </nav>
          )}

          <div className="header-actions">
            {bare ? (
              <Link to="/" className="btn btn-ghost btn-sm">
                <Icon name="arrow-left" size={14} /> {t('返回首页')}
              </Link>
            ) : layout.show_search ? (
              <>
                <SiteSearch />
                <Link to="/search" className="icon-btn search-mobile" aria-label={t('搜索')}>
                  <Icon name="search" size={17} />
                </Link>
              </>
            ) : null}
            {bare ? null : status === 'ready' && me ? (
              <>
                {can('write_content') ? (
                  <Link to={writeHref} className="btn btn-primary btn-sm header-write">
                    {t('写文章')}
                  </Link>
                ) : null}
                <Link
                  to="/notifications"
                  className="icon-btn bell-wrap"
                  aria-label={unread ? t('通知，{count} 条未读', { count: unread }) : t('通知')}
                >
                  <Icon name="bell" size={18} />
                  {unread > 0 ? <span className="bell-dot" /> : null}
                </Link>
                {personal ? null : (
                  <Link to="/messages" className="icon-btn header-mail" aria-label={t('私信')}>
                    <Icon name="mail" size={18} />
                  </Link>
                )}
                <div className="header-user" ref={userRef}>
                  <button
                    type="button"
                    className="user-trigger"
                    aria-haspopup="menu"
                    aria-expanded={userOpen}
                    onClick={() => setUserOpen((open) => !open)}
                  >
                    <Avatar name={me.user.display_name} size={28} />
                    <span className="user-name">{me.user.display_name}</span>
                    <Icon name="chevron-down" size={13} className="user-caret" />
                  </button>
                  {userOpen ? (
                    <div className="menu-pop" role="menu">
                      <div className="menu-head">
                        <strong>{me.user.display_name}</strong>
                        <span>
                          {ROLE_LABEL[me.role]}
                          {demo ? ` · ${t('演示数据')}` : ''}
                        </span>
                      </div>
                      <Link to={`/u/${me.user.id}`} className="menu-item" role="menuitem">
                        <Icon name="user" size={15} /> {t('个人主页')}
                      </Link>
                      <Link to="/me/bookmarks" className="menu-item" role="menuitem">
                        <Icon name="bookmark" size={15} /> {t('我的互动')}
                      </Link>
                      {can('write_content') ? (
                        <Link to={writeHref} className="menu-item" role="menuitem">
                          <Icon name="edit" size={15} /> {t('新建文章')}
                        </Link>
                      ) : null}
                      <Link to="/notifications" className="menu-item" role="menuitem">
                        <Icon name="bell" size={15} /> {t('通知')}
                        {unread > 0 ? <span className="admin-nav-badge">{unread}</span> : null}
                      </Link>
                      {personal ? null : (
                        <Link to="/messages" className="menu-item" role="menuitem">
                          <Icon name="mail" size={15} /> {t('私信')}
                        </Link>
                      )}
                      {adminEntry ? (
                        <Link to="/admin" className="menu-item" role="menuitem">
                          <Icon name="grid" size={15} /> {t('管理后台')}
                        </Link>
                      ) : null}
                      <div className="menu-sep" />
                      <button type="button" className="menu-item" role="menuitem" onClick={handleLogout}>
                        <Icon name="logout" size={15} /> {t('退出登录')}
                      </button>
                    </div>
                  ) : null}
                </div>
              </>
            ) : status === 'anonymous' ? (
              personal ? (
                <Link to="/login" className="btn btn-ghost btn-sm">
                  {t('管理员登录')}
                </Link>
              ) : (
                <>
                  <Link to="/login" className="btn btn-ghost btn-sm">
                    {t('登录')}
                  </Link>
                  {registrationClosed ? null : (
                    <Link to="/register" className="btn btn-primary btn-sm">
                      {t('开始使用')}
                    </Link>
                  )}
                </>
              )
            ) : (
              <span className="spinner spinner-sm" aria-label={t('载入中')} />
            )}

            <button
              type="button"
              className="icon-btn mode-toggle"
              aria-label={themeMode === 'dark' ? t('切换到浅色模式') : t('切换到深色模式')}
              title={themeMode === 'dark' ? t('浅色模式（Shift+D）') : t('深色模式（Shift+D）')}
              onClick={toggleThemeMode}
            >
              <Icon name={themeMode === 'dark' ? 'sun' : 'moon'} size={17} />
            </button>

            {bare ? null : (
              <button
                type="button"
                className="icon-btn mobile-only"
                aria-label={t('打开菜单')}
                aria-expanded={mobileOpen}
                onClick={() => setMobileOpen((open) => !open)}
              >
                <Icon name={mobileOpen ? 'close' : 'menu'} size={18} />
              </button>
            )}
          </div>
        </div>

        {!bare && mobileOpen ? (
          <div className="mobile-menu">
            <div className="shell">
              {navItems.map((item) => {
                const kind = navHrefKind(item.href);
                return (
                  <div key={item.id} className="mobile-nav-group">
                    {kind === 'internal' ? (
                      <Link
                        to={item.href}
                        className={navTabGroupActive(location.pathname, item) ? 'is-active' : undefined}
                      >
                        {item.label}
                      </Link>
                    ) : kind === 'external' ? (
                      <a href={item.href} target="_blank" rel="noreferrer">
                        {item.label}
                        <Icon name="external" size={11} className="nav-external" />
                      </a>
                    ) : (
                      <span className="mobile-nav-plain">{item.label}</span>
                    )}
                    {item.children?.length ? (
                      <div className="mobile-subnav">
                        {item.children.map((child) => {
                          const childKind = navHrefKind(child.href);
                          if (childKind === 'internal') {
                            return (
                              <Link
                                key={child.id}
                                to={child.href}
                                className={navTabActive(location.pathname, child.href) ? 'is-active' : undefined}
                              >
                                {child.label}
                              </Link>
                            );
                          }
                          if (childKind === 'external') {
                            return (
                              <a key={child.id} href={child.href} target="_blank" rel="noreferrer">
                                {child.label}
                              </a>
                            );
                          }
                          return (
                            <span key={child.id} className="mobile-subnav-plain">
                              {child.label}
                            </span>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {me ? (
                <>
                  <Link to={`/u/${me.user.id}`}>{t('个人主页')}</Link>
                  <Link to="/notifications">
                    {t('通知')}
                    {unread > 0 ? t('（{count}）', { count: unread }) : ''}
                  </Link>
                  {personal ? null : <Link to="/messages">{t('私信')}</Link>}
                  {adminEntry ? <Link to="/admin">{t('管理后台')}</Link> : null}
                  {can('write_content') ? <Link to={writeHref}>{t('写文章')}</Link> : null}
                </>
              ) : personal ? (
                <Link to="/login">{t('管理员登录')}</Link>
              ) : (
                <>
                  <Link to="/login">{t('登录')}</Link>
                  {registrationClosed ? null : <Link to="/register">{t('注册')}</Link>}
                </>
              )}
            </div>
          </div>
        ) : null}
      </header>

      {!bare && activeTopTab?.children?.length && activeSubStyle === 'bar' ? (
        <div className="site-subnav">
          <div className="shell">
            <nav className="subnav-pill" aria-label={t('{name} 二级导航', { name: activeTopTab.label })}>
              {activeTopTab.children.map((child) =>
                renderSubnavChild(child, layout.nav_sub_show_icons),
              )}
            </nav>
          </div>
        </div>
      ) : null}

      {!bare && showAnnounce ? (
        <div className="announce">
          <div className="shell announce-inner">
            <Icon name="info" size={14} />
            <p>
              {announceHref ? (
                announceHref.startsWith('/') ? (
                  <Link to={announceHref}>{announceText}</Link>
                ) : (
                  <a href={announceHref} target="_blank" rel="noreferrer">
                    {announceText}
                  </a>
                )
              ) : (
                announceText
              )}
            </p>
            <button type="button" className="announce-close" onClick={dismissAnnounce} aria-label={t('关闭公告')}>
              <Icon name="close" size={14} />
            </button>
          </div>
        </div>
      ) : null}

      <main id="main">
        <div
          className="route-transition"
          key={location.pathname}
        >
          <Outlet />
        </div>
      </main>

      {/* 创作者扩展：按路由页面类型与槽位挂载沙箱 iframe；预览 iframe 里自动跳过。 */}
      <ExtensionRuntime />

      {customization.custom_css ? <style>{customization.custom_css}</style> : null}
      {!bare && extensions.back_to_top ? <BackToTop /> : null}
      <LogicRuntime />
      <CommandLayer />
      <PreviewBridge />

      {bare ? null : (
        <footer className="site-footer">
          <div className="shell">
            <div
              className={`footer-inner${footerColumns.length ? '' : ' is-brand-only'}`}
              style={
                footerColumns.length
                  ? ({ '--footer-cols': String(footerColumns.length) } as CSSProperties)
                  : undefined
              }
            >
              <div className="footer-brand">
                <Link to="/" className="brand">
                  <span className="brand-mark">{Array.from(footer.name)[0] ?? 'P'}</span>
                  <span>
                    <span className="brand-text">{footer.name}</span>
                    <span className="brand-sub">{footer.sub}</span>
                  </span>
                </Link>
                <p>{footer.description}</p>
                {footer.showTags ? (
                  <div className="row gap-6 mt-16" style={{ flexWrap: 'wrap' }}>
                    {footer.tags.length ? (
                      footer.tags.map((tag) => (
                        <span className="chip" key={tag}>
                          {tag}
                        </span>
                      ))
                    ) : (
                      <>
                        <span className="chip">
                          {site ? VISIBILITY_LABEL[site.visibility_mode] : t('公开浏览')}
                        </span>
                        <span className="chip">
                          {site ? PUBLISH_LABEL[site.publish_mode] : t('审核发布')}
                        </span>
                        {personal ? <span className="chip">{t('个人博客')}</span> : null}
                        {demo ? <span className="chip">{t('演示数据')}</span> : null}
                      </>
                    )}
                  </div>
                ) : null}
              </div>

              {footerColumns.map((column) => (
                <div className="footer-col" key={column.id}>
                  <h4>{column.title}</h4>
                  {column.links.map((link) => {
                    const href = safeHref(link.href);
                    if (!href) {
                      return <span key={link.id}>{link.label}</span>;
                    }
                    if (href.startsWith('/')) {
                      return (
                        <Link key={link.id} to={href}>
                          {link.label}
                        </Link>
                      );
                    }
                    return (
                      <a
                        key={link.id}
                        href={href}
                        {...(href.startsWith('#') ? {} : { target: '_blank', rel: 'noreferrer' })}
                      >
                        {link.label}
                      </a>
                    );
                  })}
                  {column.links.length ? null : <span className="faint">{t('（还没有条目）')}</span>}
                </div>
              ))}
            </div>

            {socialLinks.length ? (
              <div className="footer-shortcuts" aria-label={t('快捷链接')}>
                {socialLinks.map((link) => renderSocialLink(link, false))}
              </div>
            ) : null}

            <div className="footer-bottom">
              <span>
                {layout.footer_text
                  ? layout.footer_text
                      .replace(/\{year\}/g, String(new Date().getFullYear()))
                      .replace(/\{site\}/g, siteName)
                  : t('© {year} {site}. 由写作者与读者共同维护。', {
                      year: new Date().getFullYear(),
                      site: siteName,
                    })}
              </span>
              <span className="row gap-10" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
                {layout.show_filing ? (
                  <FilingLinks icp={layout.icp} police={layout.police} icon={layout.police_icon} />
                ) : null}
                {layout.footer_note ? <span>{layout.footer_note}</span> : null}
              </span>
            </div>
          </div>
        </footer>
      )}
    </div>
  );
}
