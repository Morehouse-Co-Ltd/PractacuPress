import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { CapabilityId, PermissionGroupId } from '../../types';
import { useTitle } from '../../lib/hooks';
import { usePermissions } from '../../lib/usePermissions';
import {
  CAPABILITY_DEFS,
  DEFAULT_PERMISSIONS,
  PERMISSION_GROUPS,
  normalizePermissions,
} from '../../lib/permissions';
import { SITE_KIND_LABEL, siteKindOf } from '../../lib/site';
import { useAuth } from '../../lib/session';
import { Badge, Button, Callout, Modal, cx } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { RoleGate } from '../../components/Guards';
import { useToast } from '../../lib/toast';
import { useT } from '../../lib/i18n';

const GROUP_LABEL: Record<PermissionGroupId, string> = PERMISSION_GROUPS.reduce(
  (acc, item) => ({ ...acc, [item.id]: item.label }),
  {} as Record<PermissionGroupId, string>,
);

export function PermissionsPage() {
  const t = useT();
  const { config } = useAuth();
  const { settings, group, personal, updatePermissions, groupHas } = usePermissions();
  const toast = useToast();
  const [resetOpen, setResetOpen] = useState(false);
  useTitle(t('用户组'));

  const kind = siteKindOf(config);

  const toggle = (groupId: PermissionGroupId, capability: CapabilityId) => {
    const current = settings[groupId];
    const next = {
      ...settings,
      [groupId]: {
        ...current,
        capabilities: { ...current.capabilities, [capability]: !current.capabilities[capability] },
      },
    };
    updatePermissions(normalizePermissions(next));
  };

  const toggleAdmin = (groupId: PermissionGroupId) => {
    const current = settings[groupId];
    updatePermissions(
      normalizePermissions({
        ...settings,
        [groupId]: { ...current, admin_access: !current.admin_access },
      }),
    );
  };

  const locked = (groupId: PermissionGroupId, capability: CapabilityId): string => {
    if (groupId === 'guest') {
      return capability === 'read_content'
        ? t('游客能否阅读由「站点设置 → 访客模式」决定。')
        : t('游客没有账户，只能阅读公开内容。');
    }
    if (groupId === 'owner') return t('最高管理员固定拥有全部权限，避免把自己锁在门外。');
    if (capability === 'manage_permission' && (groupId === 'member' || groupId === 'moderator')) {
      return t('只有管理员与最高管理员可以配置权限组。');
    }
    return '';
  };

  return (
    <RoleGate capability="manage_permission" need={t('管理员')}>
      <div className="admin-page-head">
        <div>
          <h1>{t('用户组')}</h1>
          <p>
            {t('当前站点形态：{kind}。', { kind: SITE_KIND_LABEL[kind] })}
            {t('能力矩阵决定前台按钮与后台入口，')}{' '}
            {t('服务端仍按固定用户组强制校验。')}
          </p>
        </div>
        <div className="admin-page-actions">
          <Button variant="ghost" size="sm" icon="refresh" onClick={() => setResetOpen(true)}>
            {t('恢复默认')}
          </Button>
          <Link to="/admin/users" className="btn btn-secondary btn-sm">
            <Icon name="users" size={14} /> {t('用户管理')}
          </Link>
        </div>
      </div>

      {personal ? (
        <Callout tone="info" icon="user" title={t('个人博客：所有账户都是最高管理员')}>
          {t('个人博客不区分用户组。站长在「用户管理」里创建的账户都可以登录后台，并拥有下面')}{' '}
          {t('「最高管理员」的全部能力。切回社区站点后，这份能力矩阵会重新生效，账户与文章都会保留。')}
        </Callout>
      ) : (
          <Callout tone="info" icon="shield" title={t('用户组是角色之上的表达层')}>
            {t('服务端仍然只有四级固定角色（成员 / 编辑 / 站点管理员 / 平台管理员），下面的用户组把角色映射成')}{' '}
            {t('更容易理解的名称，并允许你逐项关闭前台与后台入口。关闭某项能力不会删除数据。')}
          </Callout>
      )}

      <div className="panel mt-20">
        <div className="panel-head">
          <div>
            <h3>{t('能力矩阵')}</h3>
            <p>{t('点按单元格切换。当前账户落在「{group}」组。', { group: GROUP_LABEL[group] })}</p>
          </div>
          <Badge tone="accent">{personal ? t('个人博客固定全开') : t('改动立即生效')}</Badge>
        </div>
        <div className="table-wrap">
          <table className="table perm-table">
            <thead>
              <tr>
                <th style={{ minWidth: 220 }}>{t('能力')}</th>
                {PERMISSION_GROUPS.map((item) => (
                  <th key={item.id} style={{ textAlign: 'center', minWidth: 92 }}>
                    {item.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {CAPABILITY_DEFS.map((cap) => (
                <tr key={cap.id}>
                  <td>
                    <span className="cell-title">{cap.label}</span>
                    <p className="tiny faint" style={{ marginTop: 2 }}>
                      {cap.hint}
                    </p>
                  </td>
                  {PERMISSION_GROUPS.map((item) => {
                    const on =
                      item.id === 'guest' && cap.id === 'read_content'
                        ? groupHas('guest', 'read_content')
                        : settings[item.id].capabilities[cap.id];
                    const reason = locked(item.id, cap.id);
                    return (
                      <td key={item.id} style={{ textAlign: 'center' }}>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={on}
                          aria-label={`${item.label} · ${cap.label}`}
                          title={
                            reason ||
                            (on
                              ? t('关闭 {group}的「{capability}」', {
                                  group: item.label,
                                  capability: cap.label,
                                })
                              : t('开启 {group}的「{capability}」', {
                                  group: item.label,
                                  capability: cap.label,
                                }))
                          }
                          className={cx('perm-cell', on && 'is-on')}
                          disabled={!!reason || personal}
                          onClick={() => toggle(item.id, cap.id)}
                        >
                          <Icon name={on ? 'check' : 'minus'} size={12} />
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
              <tr>
                <td>
                  <span className="cell-title">{t('进入管理后台')}</span>
                  <p className="tiny faint" style={{ marginTop: 2 }}>
                    {t('关闭后该组只能在站点前台活动。')}
                  </p>
                </td>
                {PERMISSION_GROUPS.map((item) => {
                  const on = settings[item.id].admin_access;
                  const reason =
                    item.id === 'guest'
                      ? t('游客没有账户，无法登录。')
                      : item.id === 'owner'
                        ? t('最高管理员始终可以进入后台。')
                        : '';
                  return (
                    <td key={item.id} style={{ textAlign: 'center' }}>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={on}
                        aria-label={t('{group} 进入管理后台', { group: item.label })}
                        title={reason || t('切换后台入口')}
                        className={cx('perm-cell', on && 'is-on')}
                        disabled={!!reason || personal}
                        onClick={() => toggleAdmin(item.id)}
                      >
                        <Icon name={on ? 'check' : 'minus'} size={12} />
                      </button>
                    </td>
                  );
                })}
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="dash-grid mt-20">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>{t('分组说明')}</h3>
            </div>
          </div>
          <div className="panel-body" style={{ paddingTop: 6 }}>
            <div className="mini-list">
              {PERMISSION_GROUPS.map((item) => (
                <div className="mini-row" key={item.id} style={{ alignItems: 'flex-start' }}>
                  <span className="mini-label" style={{ minWidth: 88 }}>
                    {item.label}
                  </span>
                  <span className="mini-value" style={{ fontWeight: 400, color: 'var(--muted)', textAlign: 'left' }}>
                    {item.hint}
                    {item.role ? (
                      <span className="tiny faint">{t(' · 对应角色 {role}', { role: item.role })}</span>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>{t('用户组映射')}</h3>
              <p>{t('把用户组改成对应的服务端角色，权限就会跟着能力矩阵走。')}</p>
            </div>
          </div>
          <div className="panel-body">
            <Callout tone="warn" icon="alert" title={t('前端策略与服务端授权')}>
              {t('能力矩阵保存在本地安装配置，只在界面层生效。连接真实后端时，审核、改角色与删评论仍由服务端按角色授权；')}{' '}
              {t('关闭这里的「审核内容」不会撤销服务端编辑权限。')}
            </Callout>
            <p className="small muted mt-12" style={{ lineHeight: 1.8 }}>
              {t('用户组映射：成员 → 成员，编辑 → 审核员，站点管理员 → 管理员，平台管理员 → 最高管理员。')}{' '}
              {t('用户组在「用户管理」页调整。')}
            </p>
          </div>
        </section>
      </div>

      <Modal
        open={resetOpen}
        title={t('恢复默认权限？')}
        description={t('能力矩阵会回到出厂设置，用户组、账户与内容都不受影响。')}
        onClose={() => setResetOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setResetOpen(false)}>
              {t('取消')}
            </Button>
            <Button
              onClick={() => {
                updatePermissions(normalizePermissions(DEFAULT_PERMISSIONS));
                setResetOpen(false);
                toast.push('ok', t('权限已恢复默认'));
              }}
            >
              {t('恢复默认')}
            </Button>
          </>
        }
      >
        <p className="small muted" style={{ lineHeight: 1.8 }}>
          {t('默认值：游客只读；成员可以评论与投稿；审核员处理内容与评论；管理员管理成员与站点；')}{' '}
          {t('最高管理员拥有全部能力。')}
        </p>
      </Modal>
    </RoleGate>
  );
}
