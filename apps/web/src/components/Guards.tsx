import { Link, Navigate, useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../lib/session';
import { ROLE_LABEL } from '../lib/format';
import { usePermissions } from '../lib/usePermissions';
import type { Role } from '../types';
import { PageLoading } from './ui';
import { Icon } from './Icon';

export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <PageLoading label="正在确认登录状态" />;
  if (status === 'anonymous') {
    const next = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  return <>{children}</>;
}

export function Forbidden({ need = '编辑' }: { need?: string }) {
  const { me, site } = useAuth();
  const { can } = usePermissions();
  return (
    <div className="empty" style={{ marginTop: 40 }}>
      <span className="empty-icon">
        <Icon name="lock" size={22} />
      </span>
      <h3>需要{need}权限</h3>
      <p>
        当前账户在「{site?.name ?? '本站'}」的角色是
        {me ? `「${ROLE_LABEL[me.role]}」` : '未登录'}，无法访问这个页面。权限由服务端强制校验，
        界面隐藏不能替代授权。站长可以在「用户组」里调整这一项。
      </p>
      <div className="empty-action" style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
        <Link to="/" className="btn btn-secondary btn-sm">
          返回站点
        </Link>
        {can('moderate_content') ? (
          <Link to="/admin" className="btn btn-secondary btn-sm">
            回到后台
          </Link>
        ) : null}
      </div>
    </div>
  );
}

export function RoleGate({
  min = 'editor',
  need,
  capability,
  children,
}: {
  min?: Role;
  /** 直接按能力判断；设置后忽略 min。 */
  capability?: import('../types').CapabilityId;
  need?: string;
  children: ReactNode;
}) {
  const { status } = useAuth();
  const { can, canRole } = usePermissions();
  if (status === 'loading') return <PageLoading />;
  const allowed = capability ? can(capability) : canRole(min);
  if (!allowed) return <Forbidden need={need} />;
  return <>{children}</>;
}
