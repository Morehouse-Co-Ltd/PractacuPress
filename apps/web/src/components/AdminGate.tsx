import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/session';
import { usePermissions } from '../lib/usePermissions';
import { writeTargetForAdminPath } from '../lib/adminAccess';
import { useT } from '../lib/i18n';
import { AdminShell } from './AdminShell';
import { DeniedPage } from './DeniedPage';
import { PageLoading } from './ui';

export function AdminGate() {
  const t = useT();
  const { status, me } = useAuth();
  const { can, adminEntry } = usePermissions();
  const location = useLocation();
  if (status === 'loading') return <PageLoading label={t('正在确认权限')} />;
  if (!me) {
    return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  }
  if (!adminEntry) {
    // 普通成员不该被挡在后台里再看到一堆「没有权限」：写稿的人直接落到写作台，
    // 其它后台地址则整页拒绝，且不提供后台导航。
    const writing = writeTargetForAdminPath(location.pathname);
    if (writing && can('write_content')) return <Navigate to={writing} replace />;
    return <DeniedPage need={t('管理后台')} badge="Admin" />;
  }
  return <AdminShell />;
}
