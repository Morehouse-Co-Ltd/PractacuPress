import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Member, Role } from '../../types';
import { useAuth } from '../../lib/session';
import { useBackend } from '../../lib/backend';
import { useAsync, useTitle } from '../../lib/hooks';
import { noteActivity } from '../../lib/activity';
import { passwordProblem, passwordProblemText } from '../../lib/passwordPolicy';
import { ROLE_HINT, ROLE_LABEL } from '../../lib/format';
import { groupConfigLabel, groupIdForRole } from '../../lib/permissions';
import { SITE_KIND_LABEL, siteKindOf } from '../../lib/site';
import { usePermissions } from '../../lib/usePermissions';
import { errorText, useT } from '../../lib/i18n';
import { parseMediaQuotaInput } from '../../lib/mediaQuota';
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
import { useStepUp } from '../../lib/stepUp';
import { useToast } from '../../lib/toast';

const ROLES: Role[] = ['member', 'editor', 'site_admin', 'platform_admin'];

const GROUP_META: Record<Role, { icon: 'user' | 'edit' | 'shield' | 'sparkle' }> = {
  member: { icon: 'user' },
  editor: { icon: 'edit' },
  site_admin: { icon: 'shield' },
  platform_admin: { icon: 'sparkle' },
};

interface Draft {
  display_name: string;
  email: string;
  password: string;
  role: Role;
}

const EMPTY_DRAFT: Draft = { display_name: '', email: '', password: '', role: 'member' };

export function MembersPage() {
  const t = useT();
  const { me, config } = useAuth();
  const backend = useBackend();
  const toast = useToast();
  const { ensureStepUp } = useStepUp();
  const { can, groups } = usePermissions();
  const personal = siteKindOf(config) === 'personal';
  const [pending, setPending] = useState<{ member: Member; groupKey: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [formError, setFormError] = useState('');
  const [groupFilter, setGroupFilter] = useState<string>('all');
  const [editTarget, setEditTarget] = useState<Member | null>(null);
  const [editDraft, setEditDraft] = useState({ display_name: '', email: '' });
  const [editError, setEditError] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Member | null>(null);
  /** 正在重置两步验证的成员 id：期间禁用按钮，避免重复点击。 */
  const [resettingTwoFactor, setResettingTwoFactor] = useState('');
  const [quotaDrafts, setQuotaDrafts] = useState<Record<string, string>>({});
  const [quotaErrors, setQuotaErrors] = useState<Record<string, string>>({});
  useTitle(t('用户管理'));

  const data = useAsync(async () => (me ? backend.members(me.site_id) : []), [backend, me]);
  const members = data.data ?? [];
  const assignableGroups = groups.filter((item) => item.key !== 'guest');

  /** 成员实际落在哪个组：显式分配优先，否则按角色映射到内置组。 */
  const memberGroupKey = (member: Member): string =>
    member.group_key || groupIdForRole(member.role);

  const groupLabel = (key: string): string => {
    const found = groups.find((item) => item.key === key);
    return found ? groupConfigLabel(found) : ROLE_LABEL[(memberRoleForKey(key) ?? 'member') as Role];
  };

  const memberRoleForKey = (key: string): Role | null =>
    groups.find((item) => item.key === key)?.base_role ?? null;

  /** 内置组的显示名称：站长改过名称后，角色下拉与筛选项都用新名称。 */
  const labelForRole = (role: Role): string => {
    const builtin = groups.find((item) => item.builtin && item.base_role === role);
    return builtin ? groupConfigLabel(builtin) : ROLE_LABEL[role];
  };

  const filteredMembers =
    groupFilter === 'all'
      ? members
      : members.filter((member) => memberGroupKey(member) === groupFilter);
  const groupCounts = assignableGroups.reduce(
    (acc, item) => ({
      ...acc,
      [item.key]: members.filter((member) => memberGroupKey(member) === item.key).length,
    }),
    {} as Record<string, number>,
  );

  /** 用户组的一句话说明：在渲染时取当前语言，避免模块加载时就固定下来。 */
  const groupNote = (role: Role): string =>
    role === 'member'
      ? t('评论、投稿与互动')
      : role === 'editor'
        ? t('审核内容与评论')
        : role === 'site_admin'
          ? t('管理用户与站点设置')
          : t('平台级全部权限');

  const changeGroup = async () => {
    if (!pending || !me) return;
    const targetGroup = groups.find((item) => item.key === pending.groupKey);
    if (!targetGroup) return;
    // 修改别人的用户组属于高威胁操作：二次验证取消或失败就不执行。
    const ok = await ensureStepUp(t('调整成员用户组'));
    if (!ok) return;
    setBusy(true);
    try {
      if (backend.assignMemberGroup) {
        await backend.assignMemberGroup(me.site_id, pending.member.user_id, targetGroup.key);
      } else if (targetGroup.builtin && targetGroup.base_role) {
        // Demo backend and older APIs only know the four roles. Built-in groups
        // still work because the server derives the group from the role.
        await backend.setMemberRole(me.site_id, pending.member.user_id, targetGroup.base_role);
      } else {
        throw new Error(t('当前后端不支持分配自定义能力组。'));
      }
      noteActivity(
        backend,
        me.user.display_name,
        '调整用户组',
        pending.member.display_name,
        `${groupLabel(memberGroupKey(pending.member))} → ${groupConfigLabel(targetGroup)}`,
      );
      toast.push(
        'ok',
        t('用户组已更新'),
        t('{name} 现在在「{group}」组', {
          name: pending.member.display_name,
          group: groupConfigLabel(targetGroup),
        }),
      );
      setPending(null);
      data.reload();
    } catch (err) {
      toast.push('error', t('无法修改用户组'), err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const createMember = async () => {
    if (!me) return;
    setFormError('');
    if (!draft.display_name.trim()) {
      setFormError(t('请填写显示名称。'));
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(draft.email.trim())) {
      setFormError(t('请填写有效的邮箱地址。'));
      return;
    }
    // 与后端同一套密码策略（8–128 位、至少两类字符），否则提交后只会拿到一句
    // 笼统的「请求参数不符合要求」，管理员根本不知道密码缺什么。
    const passwordIssue = passwordProblem(draft.password);
    if (passwordIssue) {
      setFormError(t(passwordProblemText(passwordIssue, t)));
      return;
    }
    // 创建账户会写权限，同样先过二次验证；取消则不创建。
    const ok = await ensureStepUp(t('创建成员账户'));
    if (!ok) return;
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
        `${created.email ?? ''} · ${personal ? '最高管理员（个人博客）' : labelForRole(role)}`,
      );
      toast.push(
        'ok',
        t('用户已创建'),
        t('{account} 现在可以登录；请通过安全渠道把初始密码交给对方。', {
          account: created.email ?? created.display_name,
        }),
      );
      setCreateOpen(false);
      setDraft(EMPTY_DRAFT);
      data.reload();
    } catch (err) {
      const text = err instanceof Error ? err.message : t('创建失败。');
      setFormError(text);
      toast.push('error', t('创建用户失败'), text);
    } finally {
      setBusy(false);
    }
  };

  const canCreate = can('manage_member');
  // 平台管理员可以管理等级更低的账户：编辑资料、停用 / 启用与删除。
  const canManageLower = me?.role === 'platform_admin';
  const pendingGroup = pending ? groups.find((item) => item.key === pending.groupKey) : undefined;

  const openEdit = (member: Member) => {
    setEditTarget(member);
    setEditDraft({ display_name: member.display_name, email: member.email ?? '' });
    setEditError('');
  };

  const saveEdit = async () => {
    if (!editTarget || !me) return;
    if (!editDraft.display_name.trim()) {
      setEditError(t('显示名称不能为空。'));
      return;
    }
    const ok = await ensureStepUp(t('编辑成员资料'));
    if (!ok) return;
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
      toast.push('ok', t('账户资料已更新'), updated.display_name);
      setEditTarget(null);
      data.reload();
    } catch (err) {
      const text = err instanceof Error ? err.message : t('保存失败。');
      setEditError(text);
      toast.push('error', t('无法保存账户资料'), text);
    } finally {
      setBusy(false);
    }
  };

  const saveMemberQuota = async (member: Member, value: string) => {
    if (!me) return;
    const parsed = parseMediaQuotaInput(value);
    if (!parsed.valid) {
      setQuotaErrors((current) => ({
        ...current,
        [member.user_id]: t('媒体额度必须是非负整数，且不能超过可存储上限。'),
      }));
      return;
    }

    setQuotaErrors((current) => ({ ...current, [member.user_id]: '' }));
    const ok = await ensureStepUp(t('修改成员媒体额度'));
    if (!ok) return;
    setBusy(true);
    try {
      const updated = await backend.setMemberQuota(me.site_id, member.user_id, parsed.value);
      noteActivity(
        backend,
        me.user.display_name,
        '修改成员媒体额度',
        updated.display_name,
        parsed.value === null ? '继承部署默认' : parsed.value === 0 ? '无限' : `${parsed.value} 字节`,
      );
      toast.push('ok', t('成员媒体额度已更新'), updated.display_name);
      setQuotaDrafts((current) => {
        const next = { ...current };
        delete next[member.user_id];
        return next;
      });
      data.reload();
    } catch (err) {
      toast.push('error', t('无法更新成员媒体额度'), err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const toggleStatus = async (member: Member) => {
    if (!me) return;
    const next = member.status === 'active' ? 'suspended' : 'active';
    const ok = await ensureStepUp(t('修改成员状态'));
    if (!ok) return;
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
        next === 'active' ? t('账户已启用') : t('账户已停用'),
        next === 'active'
          ? t('{name} 可以重新登录。', { name: member.display_name })
          : t('{name} 将无法登录。', { name: member.display_name }),
      );
      data.reload();
    } catch (err) {
      toast.push('error', t('无法修改账户状态'), err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  /**
   * 点「删除」时先弹二次验证，再进入删除确认。
   *
   * 这样密码框与「是否真的删除」是两个独立确认；验证取消时连确认框都不会打开，
   * 高危操作一步都不会执行。
   */
  const requestDelete = async (member: Member) => {
    const ok = await ensureStepUp(t('删除成员账户'));
    if (!ok) return;
    setDeleteTarget(member);
  };

  const resetMemberTwoFactor = async (member: Member) => {
    if (!me) return;
    const ok = await ensureStepUp(t('重置成员两步验证'));
    if (!ok) return;
    setResettingTwoFactor(member.user_id);
    try {
      await backend.resetMemberTwoFactor(me.site_id, member.user_id);
      noteActivity(backend, me.user.display_name, '重置成员两步验证', member.display_name);
      toast.push(
        'ok',
        t('已重置两步验证'),
        t('{name} 下次登录时不再需要两步验证码。', { name: member.display_name }),
      );
      data.reload();
    } catch (err) {
      toast.push('error', t('无法重置两步验证'), errorText(err));
    } finally {
      setResettingTwoFactor('');
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget || !me) return;
    setBusy(true);
    try {
      await backend.deleteMember(me.site_id, deleteTarget.user_id);
      noteActivity(backend, me.user.display_name, '删除成员账户', deleteTarget.display_name);
      toast.push('ok', t('账户已删除'), t('{name} 已从站点移除。', { name: deleteTarget.display_name }));
      setDeleteTarget(null);
      data.reload();
    } catch (err) {
      toast.push('error', t('无法删除账户'), err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <RoleGate capability="manage_member" need={t('管理员')}>
      <div className="admin-page-head">
        <div>
          <h1>{t('用户管理')}</h1>
          <p>
            {personal
              ? t('个人博客下所有用户都能登录后台并拥有最高权限；用户组原样保留，切回社区站点后恢复。')
              : t('按用户组管理成员。用户组变更会写入操作日志，并立即影响服务端授权。')}
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
              {t('新增用户')}
            </Button>
          ) : null}
          <Button variant="ghost" size="sm" icon="refresh" onClick={data.reload}>
            {t('刷新')}
          </Button>
        </div>
      </div>

      {personal ? (
        <Callout tone="info" icon="user" title={t('个人博客：用户即管理员')}>
          {t('站内自助注册已关闭。你创建的每个用户都能登录后台并拥有全部能力，不需要再分配用户组。')}{' '}
          {t('如果以后切回社区站点，这些用户会按保存的用户组重新分组，文章与评论保持不变。')}
          <span style={{ display: 'block', marginTop: 8 }}>
            <Link to="/admin/permissions" className="text-link">
              {t('查看用户组')}
            </Link>
          </span>
        </Callout>
      ) : (
        <Callout tone="info" icon="shield" title={t('用户组边界')}>
          {t('平台管理员管理站点与全局策略；站点管理员管理本站用户与规则；编辑 / 审核员处理内容审核；')}{' '}
          {t('成员可以发布与互动。只有平台管理员可以授予或撤销平台管理员。逐项能力见')}
          <Link to="/admin/permissions" className="text-link">
            {' '}
            {t('用户组')}{' '}
          </Link>
          {t('。')}
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
            <em>{t('全部用户')}</em>
          </span>
        </button>
        {assignableGroups.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`group-stat${groupFilter === item.key ? ' is-on' : ''}`}
            onClick={() => setGroupFilter(item.key)}
          >
            <span className="group-stat-icon">
              <Icon
                name={GROUP_META[(item.base_role ?? 'member') as Role].icon}
                size={17}
              />
            </span>
            <span>
              <strong>{groupCounts[item.key] ?? 0}</strong>
              <em>{groupConfigLabel(item)}</em>
            </span>
          </button>
        ))}
      </div>

      <div className="panel mt-20">
        <p className="small muted" style={{ padding: '12px 16px 0' }}>
          {t('媒体额度单位为字节；留空继承部署默认，0 表示无限。')}
        </p>
        {data.loading ? (
          <div className="panel-body">
            <PageLoading label={t('正在载入用户')} />
          </div>
        ) : filteredMembers.length === 0 ? (
          <div className="panel-body">
            <EmptyState
              icon="users"
              title={t('没有用户')}
              body={
                groupFilter === 'all'
                  ? t('创建用户或开放注册后，用户会出现在这里。')
                  : t('这个用户组里还没有用户。')
              }
            />
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('用户')}</th>
                  <th>{t('邮箱')}</th>
                  <th>{t('状态')}</th>
                  <th>{t('媒体额度（字节）')}</th>
                  <th>{t('用户组')}</th>
                  <th>{t('用户 ID')}</th>
                  {canManageLower ? <th>{t('账户操作')}</th> : null}
                </tr>
              </thead>
              <tbody>
                {filteredMembers.map((member) => {
                  const isSelf = member.user_id === me?.user.id;
                  const platformLocked = member.role === 'platform_admin' && me?.role !== 'platform_admin';
                  const quotaValue = quotaDrafts[member.user_id] ??
                    (member.media_quota_bytes == null ? '' : String(member.media_quota_bytes));
                  const savedQuotaValue = member.media_quota_bytes == null ? '' : String(member.media_quota_bytes);
                  return (
                    <tr key={member.user_id}>
                      <td>
                        <div className="row gap-10">
                          <Avatar name={member.display_name} size={30} />
                          <span className="cell-title">
                            {member.display_name}
                            {isSelf ? <span className="tiny faint">{t(' （你）')}</span> : null}
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
                          {member.status === 'active'
                            ? t('正常')
                            : member.status === 'invited'
                              ? t('邀请中')
                              : t('已停用')}
                        </Badge>
                      </td>
                      <td style={{ minWidth: 250 }}>
                        <div className="row gap-8">
                          <Input
                            type="text"
                            inputMode="numeric"
                            pattern="[0-9]*"
                            value={quotaValue}
                            aria-label={t('{name} 的媒体额度（字节）', { name: member.display_name })}
                            aria-invalid={!!quotaErrors[member.user_id]}
                            onChange={(event) => {
                              const value = event.target.value;
                              setQuotaDrafts((current) => ({ ...current, [member.user_id]: value }));
                              setQuotaErrors((current) => ({ ...current, [member.user_id]: '' }));
                            }}
                          />
                          <Button
                            size="sm"
                            variant="secondary"
                            icon="check"
                            aria-label={t('保存{name}的媒体额度', { name: member.display_name })}
                            disabled={busy || quotaValue === savedQuotaValue}
                            onClick={() => void saveMemberQuota(member, quotaValue)}
                          >
                            {t('保存')}
                          </Button>
                        </div>
                        {quotaErrors[member.user_id] ? (
                          <p className="field-error" role="alert">{quotaErrors[member.user_id]}</p>
                        ) : null}
                      </td>
                      <td style={{ minWidth: 190 }}>
                        {personal ? (
                          <div>
                            <Badge tone="accent" dot>
                              {t('最高管理员')}
                            </Badge>
                            <p className="tiny faint" style={{ marginTop: 4 }}>
                              {t('原用户组 {role}', {
                                role: labelForRole(
                                  config.role_snapshot?.[member.user_id] ?? member.role,
                                ),
                              })}
                            </p>
                          </div>
                        ) : (
                          <Select
                            className="group-select"
                            value={memberGroupKey(member)}
                            disabled={platformLocked || busy}
                            onChange={(e) => {
                              const groupKey = e.target.value;
                              if (groupKey !== memberGroupKey(member)) setPending({ member, groupKey });
                            }}
                            aria-label={t('{name} 的用户组', { name: member.display_name })}
                          >
                            {assignableGroups.map((item) => {
                              const needsPlatform =
                                item.base_role === 'platform_admin' &&
                                me?.role !== 'platform_admin' &&
                                member.role !== 'platform_admin';
                              const unsupported =
                                !backend.assignMemberGroup && !item.builtin;
                              return (
                                <option
                                  key={item.key}
                                  value={item.key}
                                  disabled={needsPlatform || unsupported}
                                  title={unsupported ? t('当前后端不支持自定义能力组') : undefined}
                                >
                                  {groupConfigLabel(item)}
                                </option>
                              );
                            })}
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
                                title={t('编辑显示名称与邮箱')}
                              >
                                {t('编辑')}
                              </button>
                              <button
                                type="button"
                                className={`link-btn${member.status === 'active' ? ' is-warn' : ''}`}
                                onClick={() => void toggleStatus(member)}
                                disabled={busy}
                              >
                                {member.status === 'active' ? t('禁用') : t('启用')}
                              </button>
                              <button
                                type="button"
                                className="link-btn"
                                onClick={() => void resetMemberTwoFactor(member)}
                                disabled={busy || resettingTwoFactor === member.user_id}
                                title={t('清除该成员的两步验证，方便丢失设备后重新绑定')}
                              >
                                {t('重置两步验证')}
                              </button>
                              <button
                                type="button"
                                className="link-btn is-danger"
                                onClick={() => void requestDelete(member)}
                                disabled={busy}
                              >
                                {t('删除')}
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
              <h3>{personal ? t('个人博客的用户规则') : t('用户组能做什么')}</h3>
            </div>
          </div>
          <div className="panel-body" style={{ paddingTop: 6 }}>
            {personal ? (
              <div className="mini-list">
                <div className="mini-row" style={{ alignItems: 'flex-start' }}>
                  <span className="mini-label" style={{ minWidth: 96 }}>
                    {t('登录')}
                  </span>
                  <span className="mini-value" style={{ fontWeight: 400, color: 'var(--muted)', textAlign: 'left' }}>
                    {t('所有账户都能登录，前台不再提供注册入口。新账户由站长在上方创建。')}
                  </span>
                </div>
                <div className="mini-row" style={{ alignItems: 'flex-start' }}>
                  <span className="mini-label" style={{ minWidth: 96 }}>
                    {t('权限')}
                  </span>
                  <span className="mini-value" style={{ fontWeight: 400, color: 'var(--muted)', textAlign: 'left' }}>
                    {t('统一按最高管理员处理：写稿、审核、评论管理、站点设置、外观与成员管理全部开放。')}
                  </span>
                </div>
                <div className="mini-row" style={{ alignItems: 'flex-start' }}>
                  <span className="mini-label" style={{ minWidth: 96 }}>
                    {t('切回社区')}
                  </span>
                  <span className="mini-value" style={{ fontWeight: 400, color: 'var(--muted)', textAlign: 'left' }}>
                    {t('角色记录仍然保留，切回后按成员 / 审核员 / 管理员重新生效。')}
                  </span>
                </div>
              </div>
            ) : (
              <div className="mini-list">
                {assignableGroups
                  .slice()
                  .reverse()
                  .map((item) => (
                    <div className="mini-row" key={item.key} style={{ alignItems: 'flex-start' }}>
                      <span className="mini-label" style={{ minWidth: 96 }}>
                        {groupConfigLabel(item)}
                      </span>
                      <span className="mini-value" style={{ fontWeight: 400, color: 'var(--muted)', textAlign: 'left' }}>
                        {item.builtin
                          ? ROLE_HINT[(item.base_role ?? 'member') as Role]
                          : t('自定义能力组，基础角色为{role}。', {
                              role: ROLE_LABEL[(item.base_role ?? 'member') as Role],
                            })}
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
              <h3>{t('新增与停用')}</h3>
              <p>
                {personal
                  ? t('用户由站长创建，密码当面或通过安全渠道交付。')
                  : t('管理员可以直接创建用户，也可以让访客自助注册。')}
              </p>
            </div>
          </div>
          <div className="panel-body">
            <p className="small muted" style={{ lineHeight: 1.8 }}>
              {personal
                ? t('个人博客关闭自助注册后，创建用户是唯一入口。创建后对方用邮箱与初始密码登录，建议提醒对方尽快修改密码。')
                : t('新访客通过注册成为普通成员；管理员也可以在「新增用户」里直接指定用户组，省去后续调整。')}
            </p>
            {canCreate ? (
              <Button variant="secondary" size="sm" className="mt-12" icon="plus" onClick={() => setCreateOpen(true)}>
                {t('新增用户')}
              </Button>
            ) : null}
            <p className="tiny faint mt-12">
              {t('当前身份：{identity}。', {
                identity: personal ? t('最高管理员（个人博客）') : me ? labelForRole(me.role) : '—',
              })}{' '}
              {t('站点形态：{kind}。', { kind: SITE_KIND_LABEL[siteKindOf(config)] })}
            </p>
          </div>
        </section>
      </div>

      <Modal
        open={!!pending}
        title={
          pending
            ? t('将 {name} 改为{role}？', {
                name: pending.member.display_name,
                role: pendingGroup ? groupConfigLabel(pendingGroup) : pending.groupKey,
              })
            : ''
        }
        description={
          pending
            ? pendingGroup?.builtin
              ? ROLE_HINT[(pendingGroup.base_role ?? 'member') as Role]
              : t('自定义能力组会按矩阵立即生效，并写入操作日志。')
            : ''
        }
        onClose={() => setPending(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setPending(null)}>
              {t('取消')}
            </Button>
            <Button loading={busy} onClick={changeGroup}>
              {t('确认变更')}
            </Button>
          </>
        }
      >
        {pendingGroup?.base_role === 'platform_admin' ? (
          <Callout tone="warn" icon="alert" title={t('平台管理员拥有全部权限')}>
            {t('该用户组可以管理所有站点与全局安全策略。请确认这也是你想要的。')}
          </Callout>
        ) : (
          <p className="small muted">{t('变更立即生效，并写入操作日志。')}</p>
        )}
        <p className="tiny faint mt-12">
          <Icon name="lock" size={11} /> {t('不能撤销最后一个平台管理员。')}
        </p>
      </Modal>

      <Modal
        open={createOpen}
        title={t('新增用户')}
        description={
          personal
            ? t('个人博客下新用户直接拥有最高权限，可以登录后台。')
            : t('填写基本信息，并选择用户组。用户立即生效。')
        }
        onClose={() => setCreateOpen(false)}
        width={780}
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>
              {t('取消')}
            </Button>
            <Button loading={busy} onClick={createMember} icon="plus">
              {t('创建用户')}
            </Button>
          </>
        }
      >
        <div className="user-create-shell">
          <aside className={`user-preview${draft.display_name ? ' is-filled' : ''}`}>
            <span className="user-preview-kicker">New user</span>
            <Avatar name={draft.display_name || '?'} size={64} />
            <strong>{draft.display_name.trim() || t('新用户')}</strong>
            <p>{draft.email.trim() || 'name@example.com'}</p>
            <Badge tone="accent">{personal ? t('最高管理员') : labelForRole(draft.role)}</Badge>
            <div className="user-preview-meta">
              <span>
                <Icon name="mail" size={12} /> {t('邮箱登录')}
              </span>
              <span>
                <Icon name="shield" size={12} /> {personal ? t('个人博客') : t('按用户组授权')}
              </span>
            </div>
          </aside>

          <div className="user-create-form form-stack">
            <div className="form-grid">
              <Field label={t('显示名称')} htmlFor="member-name">
                <Input
                  id="member-name"
                  value={draft.display_name}
                  maxLength={120}
                  placeholder={t('例如：周宛')}
                  autoFocus
                  onChange={(event) => setDraft({ ...draft, display_name: event.target.value })}
                />
              </Field>
              <Field label={t('邮箱')} htmlFor="member-email" hint={t('登录账号，必须全站唯一。')}>
                <Input
                  id="member-email"
                  type="email"
                  value={draft.email}
                  placeholder="name@example.com"
                  onChange={(event) => setDraft({ ...draft, email: event.target.value })}
                />
              </Field>
            </div>
            <Field
              label={t('初始密码')}
              htmlFor="member-password"
              hint={t('8–128 位，且至少包含两类字符（小写、大写、数字、符号）。创建后请通过安全渠道交给对方。')}
            >
              <Input
                id="member-password"
                type="text"
                value={draft.password}
                placeholder={t('例如：一句好记的长口令')}
                onChange={(event) => setDraft({ ...draft, password: event.target.value })}
              />
            </Field>

            {personal ? (
              <Callout tone="info" icon="user" title={t('个人博客固定最高权限')}>
                {t('不需要选择用户组；切回社区站点后，这个用户会以「管理员」身份继续使用。')}
              </Callout>
            ) : (
              <div>
                <div className="field-head">
                  <span className="field-label">{t('用户组')}</span>
                  <span className="field-aside">{t('决定后台入口与可用能力')}</span>
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
                          <strong>{labelForRole(role)}</strong>
                          <em>{groupNote(role)}</em>
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
        title={editTarget ? t('编辑 {name}', { name: editTarget.display_name }) : ''}
        description={t('平台管理员可以修改更低等级成员的显示名称与登录邮箱；变更会写入网站日志。')}
        onClose={() => setEditTarget(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditTarget(null)}>
              {t('取消')}
            </Button>
            <Button loading={busy} onClick={saveEdit} icon="check">
              {t('保存修改')}
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
          <Field label={t('显示名称')} htmlFor="member-edit-name">
            <Input
              id="member-edit-name"
              value={editDraft.display_name}
              maxLength={120}
              onChange={(event) => setEditDraft({ ...editDraft, display_name: event.target.value })}
            />
          </Field>
          <Field
            label={t('登录邮箱')}
            htmlFor="member-edit-email"
            hint={t('必须全站唯一；修改后对方下次用新邮箱登录。')}
          >
            <Input
              id="member-edit-email"
              type="email"
              value={editDraft.email}
              onChange={(event) => setEditDraft({ ...editDraft, email: event.target.value })}
            />
          </Field>
          {editTarget ? (
            <p className="tiny faint">
              {t('当前用户组：{role} · 账户状态：{status}', {
                role: labelForRole(editTarget.role),
                status: editTarget.status === 'active' ? t('正常') : t('已停用'),
              })}
            </p>
          ) : null}
        </div>
      </Modal>

      <Modal
        open={!!deleteTarget}
        title={deleteTarget ? t('删除 {name}？', { name: deleteTarget.display_name }) : ''}
        description={t('账户会从站点移除，无法再登录；已发布的文章与评论保留。')}
        onClose={() => setDeleteTarget(null)}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteTarget(null)}>
              {t('取消')}
            </Button>
            <Button variant="danger" loading={busy} onClick={confirmDelete} icon="trash">
              {t('删除账户')}
            </Button>
          </>
        }
      >
        <Callout tone="warn" icon="alert" title={t('这个操作会写入网站日志')}>
          {t('删除后对方无法再登录本站；内容不会被删除，但账户资料与个人主页会消失。')}{' '}
          {t('如果只是想暂时阻止登录，请改用「禁用」。')}
        </Callout>
      </Modal>
    </RoleGate>
  );
}
