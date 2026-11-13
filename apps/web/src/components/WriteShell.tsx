import { useEffect } from 'react';
import { Link, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/session';
import { usePermissions } from '../lib/usePermissions';
import { adminEditorPath, adminTargetForWritePath } from '../lib/adminAccess';
import { ROLE_LABEL } from '../lib/format';
import { navigateWithTransition } from '../lib/themeTransition';
import { useT } from '../lib/i18n';
import { Avatar, PageLoading } from './ui';
import { Icon } from './Icon';
import { DeniedPage } from './DeniedPage';

/**
 * 写作台（`/write/...`）。
 *
 * 普通成员写稿时只该看到编辑器：没有侧边导航、没有内容库、没有仪表盘，更没有
 * 「调用接口」这类给站长的开发文档。后台（`/admin`）仍然只属于管理员，两者用
 * 不同的路由与外壳彻底分开。
 *
 * 管理员误入 `/write/...` 时送回后台编辑器：他们需要内容库、审核队列与站点导航，
 * 写作台只服务「能写稿但不是管理员」的账户。
 */
export function WriteGate() {
  const t = useT();
  const { status, me } = useAuth();
  const { can, adminEntry } = usePermissions();
  const location = useLocation();

  if (status === 'loading') return <PageLoading label={t('正在确认权限')} />;
  if (!me) {
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  if (!can('write_content')) return <DeniedPage need={t('写稿')} badge={t('写作台')} />;
  if (adminEntry) {
    return (
      <Navigate to={adminTargetForWritePath(location.pathname) ?? adminEditorPath('article')} replace />
    );
  }
  return <WriteShell />;
}

export function WriteShell() {
  const t = useT();
  const { me, site, logout } = useAuth();
  const navigate = useNavigate();

  // 写作台与后台编辑器共用纸白令牌：编辑器的字号、表格与表单都是按它调的。
  useEffect(() => {
    document.documentElement.dataset.surface = 'admin';
    return () => {
      delete document.documentElement.dataset.surface;
    };
  }, []);

  const handleLogout = async () => {
    await logout();
    navigateWithTransition(() => navigate('/'));
  };

  return (
    <div className="write-shell">
      <header className="write-topbar">
        <Link to="/" className="write-brand">
          <span className="brand-mark">{Array.from(site?.name ?? 'P')[0]}</span>
          <span className="write-brand-text">
            {site?.name ?? 'Practacu Press'}
            <small>{t('写作台')}</small>
          </span>
        </Link>
        <div className="write-topbar-actions">
          <span className="chip write-hide-sm">{me ? ROLE_LABEL[me.role] : '—'}</span>
          <Avatar name={me?.user.display_name} size={26} />
          <Link to="/" className="btn btn-secondary btn-sm">
            <Icon name="arrow-left" size={14} /> {t('返回站点')}
          </Link>
          <button type="button" className="write-signout" onClick={() => void handleLogout()}>
            <Icon name="logout" size={14} /> {t('退出登录')}
          </button>
        </div>
      </header>
      <main className="write-main">
        <div className="write-content">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
