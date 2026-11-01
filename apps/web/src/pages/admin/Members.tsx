import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Member, Role } from '../../types';
import { useAuth } from '../../lib/session';
import { useBackend } from '../../lib/backend';
import { useAsync, useTitle } from '../../lib/hooks';
import { noteActivity } from '../../lib/activity';
import { ROLE_HINT, ROLE_LABEL } from '../../lib/format';
import { SITE_KIND_LABEL, siteKindOf } from '../../lib/site';
import { usePermissions } from '../../lib/usePermissions';
import {
  Avatar,
  Badge,
  Button,
  Callout,
  EmptyState,
  Field,
  Input,
  Modal,
  PageLoading,
  Select,
} from '../../components/ui';
import { Icon } from '../../components/Icon';
import { RoleGate } from '../../components/Guards';
import { useToast } from '../../lib/toast';

const ROLES: Role[] = ['member', 'editor', 'site_admin', 'platform_admin'];

const GROUP_META: Record<Role, { icon: 'user' | 'edit' | 'shield' | 'sparkle'; note: string }> = {
  member: { icon: 'user', note: '评论、投稿与互动' },
  editor: { icon: 'edit', note: '审核内容与评论' },
  site_admin: { icon: 'shield', note: '管理用户与站点设置' },
  platform_admin: { icon: 'sparkle', note: '平台级全部权限' },
};

interface Draft {
  display_name: string;
  email: string;
  password: string;
  role: Role;
}

const EMPTY_DRAFT: Draft = { display_name: '', email: '', password: '', role: 'member' };

export function MembersPage() {
  const { me, config } = useAuth();
  const backend = useBackend();
  const toast = useToast();
  const { can } = usePermissions();
  const personal = siteKindOf(config) === 'personal';
  const [pending, setPending] = useState<{ member: Member; role: Role } | null>(null);
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [formError, setFormError] = useState('');
  const [groupFilter, setGroupFilter] = useState<Role | 'all'>('all');
  const [editTarget, setEditTarget] = useState<Member | null>(null);
  const [editDraft, setEditDraft] = useState({ display_name: '', email: '' });
  const [editError, setEditError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Member | null>(null);
  useTitle('用户管理');

  const data = useAsync(async () => (me ? backend.members(me.site_id) : []), [backend, me]);
  const members = data.data ?? [];
  const filteredMembers = groupFilter === 'all' ? members : members.filter((member) => member.role === groupFilter);
  const groupCounts = ROLES.reduce(
    (acc, role) => ({ ...acc, [role]: members.filter((member) => member.role === role).length }),
    {} as Record<Role, number>,
  );

  const changeRole = async () => {
    if (!pending || !me) return;
    setBusy(true);
    try {
      await backend.setMemberRole(me.site_id, pending.member.user_id, pending.role);
      noteActivity(
        backend,
        me.user.display_name,
        '调整用户组',
        pending.member.display_name,
        `${ROLE_LABEL[pending.member.role]} → ${ROLE_LABEL[pending.role]}`,
      );
      toast.push('ok', '用户组已更新', `${pending.member.display_name} 现在是${ROLE_LABEL[pending.role]}`);
      setPending(null);
      data.reload();
    } catch (err) {
      toast.push('error', '无法修改用户组', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const createMember = async () => {
    if (!me) return;
    setFormError('');
    if (!draft.display_name.trim()) {
      setFormError('请填写显示名称。');
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim())) {
      setFormError('请填写有效的邮箱地址。');
      return;
    }
    if (draft.password.length < 8) {
      setFormError('密码至少 8 位。');
      return;
    }
    setBusy(true);
    try {
      const role: Role = personal ? 'site_admin' : draft.role;
      const created = await backend.createMember(me.site_id, {
        display_name: draft.display_name.trim(),
        email: draft.email.trim(),
        password: draft.password,
        role,
      });
      noteActivity(
        backend,
        me.user.display_name,
        '创建用户',
        created.display_name,
        `${created.email ?? ''} · ${personal ? '最高管理员（个人博客）' : ROLE_LABEL[role]}`,
      );
      toast.push(
        'ok',
        '用户已创建',
        `${created.email ?? created.display_name} 现在可以登录；请通过安全渠道把初始密码交给对方。`,
      );
      setCreateOpen(false);
      setDraft(EMPTY_DRAFT);
      data.reload();
    } catch (err) {
      const text = err instanceof Error ? err.message : '创建失败。';
      setFormError(text);
      toast.push('error', '创建用户失败', text);
    } finally {
      setBusy(false);
    }
  };

  const canCreate = can('manage_member');
  // 平台管理员可以管理等级更低的账户：编辑资料、停用 / 启用与删除。
  const canManageLower = me?.role === 'platform_admin';

  const openEdit = (member: Member) => {
    setEditTarget(member);
    setEditDraft({ display_name: member.display_name, email: member.email ?? '' });
    setEditError('');
  };

  const saveEdit = async () => {
    if (!editTarget || !me) return;
    if (!editDraft.display_name.trim()) {
      setEditError('显示名称不能为空。');
      return;
    }
    setBusy(true);
    try {
      const updated = await backend.updateMember(me.site_id, editTarget.user_id, {
        display_name: editDraft.display_name.trim(),
        email: editDraft.email.trim() || undefined,
      });
      noteActivity(
        backend,
        me.user.display_name,
        '编辑成员资料',
        updated.display_name,
        updated.email ?? '',
      );
      toast.push('ok', '账户资料已更新', updated.display_name);
      setEditTarget(null);
      data.reload();
    } catch (err) {
      const text = err instanceof Error ? err.message : '保存失败。';
      setEditError(text);
      toast.push('error', '无法保存账户资料', text);
    } finally {
      setBusy(false);
    }
  };

  const toggleStatus = async (member: Member) => {
    if (!me) return;
    const next = member.status === 'active' ? 'suspended' : 'active';
    setBusy(true);
    try {
      await backend.setMemberStatus(me.site_id, member.user_id, next);
      noteActivity(
        backend,
        me.user.display_name,
        next === 'active' ? '启用成员账户' : '停用成员账户',
        member.display_name,
      );
      toast.push(
        'ok',
        next === 'active' ? '账户已启用' : '账户已停用',
        next === 'active' ? `${member.display_name} 可以重新登录。` : `${member.display_name} 将无法登录。`,
      );
      data.reload();
    } catch (err) {
      toast.push('error', '无法修改账户状态', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget || !me) return;
    setBusy(true);
    try {
      await backend.deleteMember(me.site_id, deleteTarget.user_id);
      noteActivity(backend, me.user.display_name, '删除成员账户', deleteTarget.display_name);
      toast.push('ok', '账户已删除', `${deleteTarget.display_name} 已从站点移除。`);
      setDeleteTarget(null);
      data.reload();
    } catch (err) {
      toast.push('error', '无法删除账户', err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <RoleGate capability="manage_member" need="管理员">
      <div className="admin-page-head">
        <div>
          <h1>用户管理</h1>
          <p>
            {personal
              ? '个人博客下所有用户都能登录后台并拥有最高权限；用户组原样保留，切回社区站点后恢复。'
              : '按用户组管理成员。用户组变更会写入操作日志，并立即影响服务端授权。'}
          </p>
        </div>
        <div className="admin-page-actions">
          {canCreate ? (
            <Button
              size="sm"
              icon="plus"
              onClick={() => {
                setDraft(EMPTY_DRAFT);
                setFormError('');
                setCreateOpen(true);
              }}
            >
              新增用户
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" icon="refresh" onClick={data.reload}>
            刷新
          </Button>
        </div>
      </div>

      {personal ? (
        <Callout tone="info" icon="user" title="个人博客：用户即管理员">
          站内自助注册已关闭。你创建的每个用户都能登录后台并拥有全部能力，不需要再分配用户组。
          如果以后切回社区站点，这些用户会按保存的用户组重新分组，文章与评论保持不变。
          <span style={{ display: 'block', marginTop: 8 }}>
            <Link to="/admin/permissions" className="text-link">
              查看用户组
            </Link>
          </span>
        </Callout>
      ) : (
        <Callout tone="info" icon="shield" title="用户组边界">
          平台管理员管理站点与全局策略；站点管理员管理本站用户与规则；编辑 / 审核员处理内容审核；
          成员可以发布与互动。只有平台管理员可以授予或撤销平台管理员。逐项能力见
          <Link to="/admin/permissions" className="text-link">
            {' '}
            用户组{' '}
          </Link>
          。
        </Callout>
      )}

      <div className="group-strip">
        <button
          type="button"
          className={`group-stat${groupFilter === 'all' ? ' is-on' : ''}`}
          onClick={() => setGroupFilter('all')}
        >
          <span className="group-stat-icon">
            <Icon name="users" size={17} />
          </span>
          <span>
            <strong>{members.length}</strong>
            <em>全部用户</em>
          </span>
        </button>
        {ROLES.map((role) => (
          <button
            key={role}
            type="button"
            className={`group-stat${groupFilter === role ? ' is-on' : ''}`}
            onClick={() => setGroupFilter(role)}
          >
            <span className="group-stat-icon">
              <Icon name={GROUP_META[role].icon} size={17} />
            </span>
            <span>
              <strong>{groupCounts[role]}</strong>
              <em>{ROLE_LABEL[role]}</em>
            </span>
          </button>
        ))}
      </div>

      <div className="panel mt-20">
        {data.loading ? (
          <div className="panel-body">
            <PageLoading label="正在载入用户" />
          </div>
        ) : filteredMembers.length === 0 ? (
          <div className="panel-body">
            <EmptyState
              icon="users"
              title="没有用户"
              body={groupFilter === 'all' ? '创建用户或开放注册后，用户会出现在这里。' : '这个用户组里还没有用户。'}
            />
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>用户</th>
                  <th>邮箱</th>
                  <th>状态</th>
                  <th>用户组</th>
                  <th>用户 ID</th>
                  {canManageLower ? <th>账户操作</th> : null}
                </tr>
              </thead>
              <tbody>
                {filteredMembers.map((member) => {
                  const isSelf = member.user_id === me?.user.id;
                  const platformLocked = member.role === 'platform_admin' && me?.role !== 'platform_admin';
                  return (
                    <tr key={member.user_id}>
                      <td>
                        <div className="row gap-10">
                          <Avatar name={member.display_name} size={30} />
                          <span className="cell-title">
                            {member.display_name}
                            {isSelf ? <span className="tiny faint"> （你）</span> : null}
                          </span>
                        </div>
                      </td>
                      <td className="tiny muted">{member.email ?? '—'}</td>
                      <td>
                        <Badge
                          tone={
                            member.status === 'active' ? 'ok' : member.status === 'invited' ? 'warn' : 'danger'
                          }
                          dot
                        >
                          {member.status === 'active' ? '正常' : member.status === 'invited' ? '邀请中' : '已停用'}
                        </Badge>
                      </td>
                      <td style={{ minWidth: 190 }}>
                        {personal ? (
                          <div>
                            <Badge tone="accent" dot>
                              最高管理员
                            </Badge>
                            <p className="tiny faint" style={{ marginTop: 4 }}>
                              原用户组 {ROLE_LABEL[config.role_snapshot?.[member.user_id] ?? member.role]}
                            </p>
                          </div>
                        ) : (
                          <Select
                            className="group-select"
                            value={member.role}
                            disabled={platformLocked || busy}
                            onChange={(e) => {
                              const role = e.target.value as Role;
                              if (role !== member.role) setPending({ member, role });
                            }}
                            aria-label={`${member.display_name} 的用户组`}
                          >
                            {ROLES.map((role) => (
                              <option
                                key={role}
                                value={role}
                                disabled={
                                  role === 'platform_admin' &&
                                  me?.role !== 'platform_admin' &&
                                  member.role !== 'platform_admin'
                                }
                              >
                                {ROLE_LABEL[role]}
                              </option>
                            ))}
                          </Select>
                        )}
                      </td>
                      <td className="tiny mono muted">{member.user_id}</td>
                      {canManageLower ? (
                        <td>
                          {member.role !== 'platform_admin' && !isSelf ? (
                            <div className="table-actions">
                              <button
                                type="button"
                                className="link-btn"
                                onClick={() => openEdit(member)}
                                title="编辑显示名称与邮箱"
                              >
                                编辑
                              </button>
                              <button
                                type="button"
                                className={`link-btn${member.status === 'active' ? ' is-warn' : ''}`}
                                onClick={() => void toggleStatus(member)}
                                disabled={busy}
                              >
                                {member.status === 'active' ? '禁用' : '启用'}
                              </button>
                              <button
                                type="button"
                                className="link-btn is-danger"
                                onClick={() => setDeleteTarget(member)}
                                disabled={busy}
                              >
                                删除
                              </button>
                            </div>
                          ) : (
                            <span className="tiny faint">—</span>
                          )}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="dash-grid">
        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>{personal ? '个人博客的用户规则' : '四种用户组能做什么'}</h3>
              <p>权限由服务端执行，界面只负责表达。</p>
            </div>
          </div>
          <div className="panel-body" style={{ paddingTop: 6 }}>
            {personal ? (
              <div className="mini-list">
                <div className="mini-row" style={{ alignItems: 'flex-start' }}>
                  <span className="mini-label" style={{ minWidth: 96 }}>
                    登录
                  </span>
                  <span className="mini-value" style={{ fontWeight: 400, color: 'var(--muted)', textAlign: 'left' }}>
                    所有账户都能登录，前台不再提供注册入口。新账户由站长在上方创建。
                  </span>
                </div>
                <div className="mini-row" style={{ alignItems: 'flex-start' }}>
                  <span className="mini-label" style={{ minWidth: 96 }}>
                    权限
                  </span>
                  <span className="mini-value" style={{ fontWeight: 400, color: 'var(--muted)', textAlign: 'left' }}>
                    统一按最高管理员处理：写稿、审核、评论管理、站点设置、外观与成员管理全部开放。
                  </span>
                </div>
                <div className="mini-row" style={{ alignItems: 'flex-start' }}>
                  <span className="mini-label" style={{ minWidth: 96 }}>
                    切回社区
                  </span>
                  <span className="mini-value" style={{ fontWeight: 400, color: 'var(--muted)', textAlign: 'left' }}>
                    角色记录仍然保留，切回后按成员 / 审核员 / 管理员重新生效。
                  </span>
                </div>
              </div>
            ) : (
              <div className="mini-list">
                {ROLES.slice()
                  .reverse()
                  .map((role) => (
                    <div className="mini-row" key={role} style={{ alignItems: 'flex-start' }}>
                      <span className="mini-label" style={{ minWidth: 96 }}>
                        {ROLE_LABEL[role]}
                      </span>
                      <span className="mini-value" style={{ fontWeight: 400, color: 'var(--muted)', textAlign: 'left' }}>
                        {ROLE_HINT[role]}
                      </span>
                    </div>
                  ))}
              </div>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>新增与停用</h3>
              <p>{personal ? '用户由站长创建，密码当面或通过安全渠道交付。' : '管理员可以直接创建用户，也可以让访客自助注册。'}</p>
            </div>
          </div>
          <div className="panel-body">
            <p className="small muted" style={{ lineHeight: 1.8 }}>
              {personal
                ? '个人博客关闭自助注册后，创建用户是唯一入口。创建后对方用邮箱与初始密码登录，建议提醒对方尽快修改密码。'
                : '新访客通过注册成为普通成员；管理员也可以在「新增用户」里直接指定用户组，省去后续调整。'}
            </p>
            {canCreate ? (
              <Button variant="secondary" size="sm" className="mt-12" icon="plus" onClick={() => setCreateOpen(true)}>
                新增用户
              </Button>
            ) : null}
            <p className="tiny faint mt-12">
              当前身份：{personal ? '最高管理员（个人博客）' : me ? ROLE_LABEL[me.role] : '—'}。
              站点形态：{SITE_KIND_LABEL[siteKindOf(config)]}。
            </p>
          </div>
        </section>
      </div>

      <Modal
        open={!!pending}
        title={pending ? `将 ${pending.member.display_name} 改为${ROLE_LABEL[pending.role]}？` : ''}
        description={pending ? ROLE_HINT[pending.role] : ''}
        onClose={() => setPending(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPending(null)}>
              取消
            </Button>
            <Button loading={busy} onClick={changeRole}>
              确认变更
            </Button>
          </>
        }
      >
        {pending?.role === 'platform_admin' ? (
          <Callout tone="warn" icon="alert" title="平台管理员拥有全部权限">
            该用户组可以管理所有站点与全局安全策略。请确认这也是你想要的。
          </Callout>
        ) : (
          <p className="small muted">变更立即生效，并写入操作日志。</p>
        )}
        <p className="tiny faint mt-12">
          <Icon name="lock" size={11} /> 不能撤销最后一个平台管理员。
        </p>
      </Modal>

      <Modal
        open={createOpen}
        title="新增用户"
        description={
          personal
            ? '个人博客下新用户直接拥有最高权限，可以登录后台。'
            : '填写基本信息，并选择用户组。用户立即生效。'
        }
        onClose={() => setCreateOpen(false)}
        width={780}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button loading={busy} onClick={createMember} icon="plus">
              创建用户
            </Button>
          </>
        }
      >
        <div className="user-create-shell">
          <aside className={`user-preview${draft.display_name ? ' is-filled' : ''}`}>
            <span className="user-preview-kicker">New user</span>
            <Avatar name={draft.display_name || '?'} size={64} />
            <strong>{draft.display_name.trim() || '新用户'}</strong>
            <p>{draft.email.trim() || 'name@example.com'}</p>
            <Badge tone="accent">{personal ? '最高管理员' : ROLE_LABEL[draft.role]}</Badge>
            <div className="user-preview-meta">
              <span>
                <Icon name="mail" size={12} /> 邮箱登录
              </span>
              <span>
                <Icon name="shield" size={12} /> {personal ? '个人博客' : '按用户组授权'}
              </span>
            </div>
          </aside>

          <div className="user-create-form form-stack">
            <div className="form-grid">
              <Field label="显示名称" htmlFor="member-name">
                <Input
                  id="member-name"
                  value={draft.display_name}
                  maxLength={120}
                  placeholder="例如：周宛"
                  autoFocus
                  onChange={(event) => setDraft({ ...draft, display_name: event.target.value })}
                />
              </Field>
              <Field label="邮箱" htmlFor="member-email" hint="登录账号，必须全站唯一。">
                <Input
                  id="member-email"
                  type="email"
                  value={draft.email}
                  placeholder="name@example.com"
                  onChange={(event) => setDraft({ ...draft, email: event.target.value })}
                />
              </Field>
            </div>
            <Field label="初始密码" htmlFor="member-password" hint="至少 8 位。创建后请通过安全渠道交给对方。">
              <Input
                id="member-password"
                type="text"
                value={draft.password}
                placeholder="例如：一句好记的长口令"
                onChange={(event) => setDraft({ ...draft, password: event.target.value })}
              />
            </Field>

            {personal ? (
              <Callout tone="info" icon="user" title="个人博客固定最高权限">
                不需要选择用户组；切回社区站点后，这个用户会以「管理员」身份继续使用。
              </Callout>
            ) : (
              <div>
                <div className="field-head">
                  <span className="field-label">用户组</span>
                  <span className="field-aside">决定后台入口与可用能力</span>
                </div>
                <div className="group-choice-grid">
                  {ROLES.map((role) => {
                    const disabled = role === 'platform_admin' && me?.role !== 'platform_admin';
                    return (
                      <button
                        key={role}
                        type="button"
                        className={`group-choice${draft.role === role ? ' is-on' : ''}`}
                        disabled={disabled}
                        onClick={() => setDraft({ ...draft, role })}
                      >
                        <span className="group-choice-icon">
                          <Icon name={GROUP_META[role].icon} size={16} />
                        </span>
                        <span className="group-choice-body">
                          <strong>{ROLE_LABEL[role]}</strong>
                          <em>{GROUP_META[role].note}</em>
                        </span>
                        {draft.role === role ? <Icon name="check-circle" size={15} /> : null}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {formError ? (
              <Callout tone="danger" icon="alert">
                {formError}
              </Callout>
            ) : null}
          </div>
        </div>
      </Modal>
      <Modal
        open={!!editTarget}
        title={editTarget ? `编辑 ${editTarget.display_name}` : ''}
        description="平台管理员可以修改更低等级成员的显示名称与登录邮箱；变更会写入网站日志。"
        onClose={() => setEditTarget(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditTarget(null)}>
              取消
            </Button>
            <Button loading={busy} onClick={saveEdit} icon="check">
              保存修改
            </Button>
          </>
        }
      >
        <div className="form-stack">
          {editError ? (
            <Callout tone="danger" icon="alert">
              {editError}
            </Callout>
          ) : null}
          <Field label="显示名称" htmlFor="member-edit-name">
            <Input
              id="member-edit-name"
              value={editDraft.display_name}
              maxLength={120}
              onChange={(event) => setEditDraft({ ...editDraft, display_name: event.target.value })}
            />
          </Field>
          <Field label="登录邮箱" htmlFor="member-edit-email" hint="必须全站唯一；修改后对方下次用新邮箱登录。">
            <Input
              id="member-edit-email"
              type="email"
              value={editDraft.email}
              onChange={(event) => setEditDraft({ ...editDraft, email: event.target.value })}
            />
          </Field>
          {editTarget ? (
            <p className="tiny faint">
              当前用户组：{ROLE_LABEL[editTarget.role]} · 账户状态：
              {editTarget.status === 'active' ? '正常' : '已停用'}
            </p>
          ) : null}
        </div>
      </Modal>

      <Modal
        open={!!deleteTarget}
        title={deleteTarget ? `删除 ${deleteTarget.display_name}？` : ''}
        description="账户会从站点移除，无法再登录；已发布的文章与评论保留。"
        onClose={() => setDeleteTarget(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button variant="danger" loading={busy} onClick={confirmDelete} icon="trash">
              删除账户
            </Button>
          </>
        }
      >
        <Callout tone="warn" icon="alert" title="这个操作会写入网站日志">
          删除后对方无法再登录本站；内容不会被删除，但账户资料与个人主页会消失。
          如果只是想暂时阻止登录，请改用「禁用」。
        </Callout>
      </Modal>
    </RoleGate>
  );
}
