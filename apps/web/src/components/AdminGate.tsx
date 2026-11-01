import { Link, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/session';
import { ROLE_LABEL } from '../lib/format';
import { usePermissions } from '../lib/usePermissions';
import { useT } from '../lib/i18n';
import { AdminShell } from './AdminShell';
import { Forbidden } from './Guards';
import { PageLoading } from './ui';
import { Icon } from './Icon';

function AdminDenied() {
  const t = useT();
  const { me, site } = useAuth();
  return (
    <div className="site">
      <header className="site-header">
        <div className="shell header-inner">
          <Link to="/" className="brand">
            <span className="brand-mark">{Array.from(site?.name ?? 'P')[0]}</span>
            <span>
              <span className="brand-text">{site?.name ?? 'Practacu Press'}</span>
              <span className="brand-sub">Admin</span>
            </span>
          </Link>
          <div className="header-actions">
            <span className="chip">{me ? ROLE_LABEL[me.role] : t('访客')}</span>
            <Link to="/" className="btn btn-secondary btn-sm">
              <Icon name="arrow-left" size={14} /> {t('返回站点')}
            </Link>
          </div>
        </div>
      </header>
      <main className="shell shell-narrow">
        <div style={{ paddingTop: 48 }}>
          <Forbidden need={t('编辑')} />
        </div>
      </main>
    </div>
  );
}

export function AdminGate() {
  const t = useT();
  const { status, me } = useAuth();
  const { can } = usePermissions();
  const location = useLocation();
  if (status === 'loading') return <PageLoading label={t('正在确认权限')} />;
  if (!me) {
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  }
  const adminAccess =
    can('moderate_content') || can('manage_member') || can('manage_site') || can('view_log');
  // 社区站点允许成员登录后写稿：只有写稿能力的成员也能进入后台的内容区，
  // 但看不到仪表盘、用户与站点设置（AdminShell 会把他们落到内容库）。
  const authorAccess = can('write_content');
  if (!adminAccess && !authorAccess) return <AdminDenied />;
  return <AdminShell />;
}
