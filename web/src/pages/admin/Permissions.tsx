import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CapabilityId, PermissionGroupConfig, Role } from '../../types';
import { useTitle } from '../../lib/hooks';
import { usePermissions } from '../../lib/usePermissions';
import {
  CAPABILITY_DEFS,
  CUSTOM_GROUP_BASE_ROLES,
  CUSTOM_GROUP_KEY_PATTERN,
  DEFAULT_PERMISSION_GROUPS,
  allowedCapabilitiesForRole,
  groupConfigLabel,
  normalizeGroupConfig,
  permissionGroupSelfLocked,
} from '../../lib/permissions';
import { ROLE_LABEL } from '../../lib/format';
import { hasAdminCapability } from '../../lib/adminAccess';
import { SITE_KIND_LABEL, siteKindOf } from '../../lib/site';
import { useAuth } from '../../lib/session';
import { useBackend } from '../../lib/backend';
import { Badge, Button, Callout, Field, Input, Modal, Select, cx } from '../../components/ui';
import { Icon } from '../../components/Icon';
import { RoleGate } from '../../components/Guards';
import { useToast } from '../../lib/toast';
import { useT } from '../../lib/i18n';

interface NewGroupDraft {
  name: string;
  key: string;
  base_role: Role;
  capabilities: Record<CapabilityId, boolean>;
  admin_access: boolean;
}

function blankCapabilities(): Record<CapabilityId, boolean> {
  const out = {} as Record<CapabilityId, boolean>;
  for (const cap of CAPABILITY_DEFS) out[cap.id] = false;
  out.read_content = true;
  return out;
}

function newGroupDraft(): NewGroupDraft {
  return {
    name: '',
    key: `group_${Date.now().toString(36).slice(-5)}`,
    base_role: 'member',
    capabilities: blankCapabilities(),
    admin_access: false,
  };
}

/** 把一组写回列表：已有就替换，没有就追加（新建组的乐观更新）。 */
function upsertGroup(
  groups: PermissionGroupConfig[],
  group: PermissionGroupConfig,
): PermissionGroupConfig[] {
  const exists = groups.some((entry) => entry.key === group.key);
  return exists
    ? groups.map((entry) => (entry.key === group.key ? group : entry))
    : [...groups, group];
}

export function PermissionsPage() {
  const t = useT();
  const { config, me, refreshPermissionGroups } = useAuth();
  const backend = useBackend();
  const { groups, group, personal, updateGroups } = usePermissions();
  const toast = useToast();
  const [draft, setDraft] = useState<PermissionGroupConfig[]>(groups);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [resetOpen, setResetOpen] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [newDraftState, setNewDraftState] = useState<NewGroupDraft>(newGroupDraft);
  const [newError, setNewError] = useState('');
  const [creating, setCreating] = useState(false);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useTitle(t('用户组'));

  const kind = siteKindOf(config);
  const byKey = useMemo(() => new Map(draft.map((item) => [item.key, item])), [draft]);
  const current = byKey.get(group);
  /** 自己的组只能改名：服务端会拒绝策略字段的修改，界面提前禁用。 */
  const selfLocked = (item: PermissionGroupConfig) =>
    permissionGroupSelfLocked(item.key, group, me?.role);

  // The server is the source of truth: when the context refreshes (first load or a
  // save from another tab), mirror it without remounting the page.
  useEffect(() => {
    setDraft(groups);
  }, [groups]);

  const inputOf = (item: PermissionGroupConfig) => ({
    name: item.name,
    base_role: item.base_role,
    capabilities: item.capabilities,
    admin_access: item.admin_access,
  });

  /**
   * Apply one group locally, then persist it.
   *
   * The local update happens first so a toggle feels instant; a failed write rolls
   * the row back and reports it through a toast. Nothing here navigates or reloads
   * the document, so scroll position and the open group stay where they were.
   */
  const persist = async (
    next: PermissionGroupConfig,
    previous: PermissionGroupConfig | null,
  ): Promise<boolean> => {
    const apply = (item: PermissionGroupConfig) =>
      setDraft((currentDraft) => {
        const exists = currentDraft.some((entry) => entry.key === item.key);
        return exists
          ? currentDraft.map((entry) => (entry.key === item.key ? item : entry))
          : [...currentDraft, item];
      });
    apply(next);
    if (!backend.savePermissionGroup || !me) {
      updateGroups(upsertGroup(draftRef.current, next));
      return true;
    }

    setSaving((state) => ({ ...state, [next.key]: true }));
    try {
      const stored = await backend.savePermissionGroup(me.site_id, next.key, inputOf(next));
      const normalized = normalizeGroupConfig(stored);
      apply(normalized);
      // The server row is now the source of truth. Do not mirror it into the design
      // document: that would rewrite the whole site customisation (and its revision)
      // just because one checkbox moved. The shared context is refreshed below, and
      // older offline callers keep the local mirror only when there is no server.
      // Refresh the shared context so the navigation, member dropdowns and audit
      // copy pick up a renamed group immediately.
      void refreshPermissionGroups();
      return true;
    } catch (err) {
      if (previous) apply(previous);
      else setDraft((currentDraft) => currentDraft.filter((entry) => entry.key !== next.key));
      toast.push(
        'error',
        t('能力组保存失败'),
        err instanceof Error ? err.message : t('请稍后重试，页面不会丢失当前查看位置。'),
      );
      return false;
    } finally {
      setSaving((state) => {
        const nextState = { ...state };
        delete nextState[next.key];
        return nextState;
      });
    }
  };

  const toggle = (item: PermissionGroupConfig, capability: CapabilityId) => {
    // Read from the ref, not the render prop: two quick clicks can land before the
    // optimistic state has been committed, and the second request must not undo the
    // first one.
    const latest = draftRef.current.find((entry) => entry.key === item.key) ?? item;
    const next = normalizeGroupConfig({
      ...latest,
      capabilities: { ...latest.capabilities, [capability]: !latest.capabilities[capability] },
    });
    void persist(next, latest);
  };

  const toggleAdmin = (item: PermissionGroupConfig) => {
    const latest = draftRef.current.find((entry) => entry.key === item.key) ?? item;
    const next = normalizeGroupConfig({ ...latest, admin_access: !latest.admin_access });
    void persist(next, latest);
  };

  const startRename = (item: PermissionGroupConfig) => {
    setEditingKey(item.key);
    setEditingName(item.name);
  };

  const commitRename = async (item: PermissionGroupConfig) => {
    if (editingKey !== item.key) return;
    // 保存中重复按 Enter 不应再发一次写请求；按钮本身也已禁用。
    if (saving[item.key]) return;
    const latest = draftRef.current.find((entry) => entry.key === item.key) ?? item;
    const next = normalizeGroupConfig({ ...latest, name: editingName.trim().slice(0, 60) });
    const ok = await persist(next, latest);
    if (ok) setEditingKey(null);
  };

  const locked = (item: PermissionGroupConfig, capability: CapabilityId): string => {
    if (personal) return t('个人博客固定全开。');
    if (item.key === 'guest') {
      return capability === 'read_content'
        ? t('游客能否阅读由「站点设置 → 访客模式」决定。')
        : t('游客没有账户，只能阅读公开内容。');
    }
    if (item.key === 'owner') return t('最高管理员固定拥有全部权限，避免把自己锁在门外。');
    if (selfLocked(item)) {
      return t('不能修改自己所在组的能力，避免给自己提权或把自己锁在门外；可以改名。');
    }
    if (capability === 'manage_permission' && (!item.builtin || item.key === 'member' || item.key === 'moderator')) {
      return t('只有内置组可以配置权限组；自定义组不能持有这项能力。');
    }
    if (!item.builtin && !allowedCapabilitiesForRole(item.base_role).has(capability)) {
      return t('这项能力超出该组基础角色的上限。');
    }
    return '';
  };

  const adminLocked = (item: PermissionGroupConfig): string => {
    if (item.key === 'guest') return t('游客没有账户，无法登录。');
    if (item.key === 'owner') return t('最高管理员始终可以进入后台。');
    if (selfLocked(item)) {
      return t('不能切换自己所在组的后台入口，避免把自己锁在门外；可以改名。');
    }
    // A custom group with no dashboard capability would open an empty dashboard, so
    // the server drops the switch. Disable it here too instead of letting the click
    // silently revert.
    if (
      !item.builtin &&
      !item.admin_access &&
      !hasAdminCapability((capability) => item.capabilities[capability] === true)
    ) {
      return t('先在矩阵里开启至少一项后台能力。');
    }
    return '';
  };

  const createGroup = async () => {
    setNewError('');
    const name = newDraftState.name.trim();
    if (!name) {
      setNewError(t('请填写能力组名称。'));
      return;
    }
    if (!CUSTOM_GROUP_KEY_PATTERN.test(newDraftState.key)) {
      setNewError(t('组标识必须以小写字母开头，只含小写字母、数字、连字符或下划线。'));
      return;
    }
    if (byKey.has(newDraftState.key)) {
      setNewError(t('这个组标识已经存在。'));
      return;
    }
    setCreating(true);
    const next = normalizeGroupConfig({
      key: newDraftState.key,
      name,
      base_role: newDraftState.base_role,
      capabilities: newDraftState.capabilities,
      admin_access: newDraftState.admin_access,
      builtin: false,
    });
    const ok = await persist(next, null);
    if (ok) {
      setNewOpen(false);
      setNewDraftState(newGroupDraft());
      toast.push('ok', t('能力组已创建'), name);
    }
    setCreating(false);
  };

  const restoreDefaults = async () => {
    let ok = true;
    for (const builtin of DEFAULT_PERMISSION_GROUPS) {
      const currentGroup = draftRef.current.find((item) => item.key === builtin.key);
      if (!currentGroup) continue;
      // 自己的组由服务端拒绝策略修改；跳过它，其余组照常恢复，不因一项失败中断。
      if (selfLocked(currentGroup)) continue;
      const next = normalizeGroupConfig({
        ...builtin,
        capabilities: { ...builtin.capabilities },
      });
      ok = (await persist(next, currentGroup)) && ok;
    }
    if (ok) toast.push('ok', t('权限已恢复默认'));
    setResetOpen(false);
  };

  const newAllowed = allowedCapabilitiesForRole(newDraftState.base_role);

  return (
    <RoleGate capability="manage_permission" need={t('管理员')}>
      <div className="admin-page-head">
        <div>
          <h1>{t('用户组')}</h1>
          <p>
            {t('当前站点形态：{kind}。', { kind: SITE_KIND_LABEL[kind] })}
            {t('能力矩阵由服务端保存并强制校验；改名与勾选都在原地生效。')}
          </p>
        </div>
        <div className="admin-page-actions">
          {!personal ? (
            <Button
              size="sm"
              icon="plus"
              onClick={() => {
                setNewDraftState(newGroupDraft());
                setNewError('');
                setNewOpen(true);
              }}
            >
              {t('新增能力组')}
            </Button>
          ) : null}
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
          {t('服务端有四级固定角色（成员 / 编辑 / 站点管理员 / 平台管理员）。内置组把角色映射成更容易理解的名称，')}{' '}
          {t('自定义组在同一角色之上收窄能力；保存后服务端立即按新矩阵放行或拒绝请求，不需要刷新页面。')}
        </Callout>
      )}

      {!personal && me?.role !== 'platform_admin' && current ? (
        <Callout tone="warn" icon="lock" title={t('不能修改自己的组')}>
          {t('你可以给自己的组改名，但能力、后台入口与基础角色是锁定的：持有「配置权限组」不能变成给自己提权或把自己锁在门外的通道。需要调整时请让平台管理员操作。')}
        </Callout>
      ) : null}

      <div className="panel mt-20">
        <div className="panel-head">
          <div>
            <h3>{t('能力矩阵')}</h3>
            <p>{t('点按单元格切换。当前账户落在「{group}」组。', { group: groupConfigLabel(current ?? draft[0]) })}</p>
          </div>
          <Badge tone="accent">{personal ? t('个人博客固定全开') : t('改动立即生效')}</Badge>
        </div>
        <div className="table-wrap">
          <table className="table perm-table">
            <thead>
              <tr>
                <th style={{ minWidth: 220 }}>{t('能力')}</th>
                {draft.map((item) => {
                  const label = groupConfigLabel(item);
                  const busy = !!saving[item.key];
                  return (
                    <th key={item.key} style={{ textAlign: 'center', minWidth: 116 }}>
                      {editingKey === item.key ? (
                        // 紧凑的内联编辑卡片：标签 + 自适应输入框 + 保存 / 取消。
                        // 保存中整张卡片进入 disabled 态（按钮禁用、输入框只读展示）。
                        <div className={cx('perm-rename', busy && 'is-busy')} aria-busy={busy}>
                          <span className="perm-rename-label">
                            <Icon name="edit" size={11} />
                            <span>{t('名称')}</span>
                          </span>
                          <Input
                            className="perm-rename-input"
                            value={editingName}
                            maxLength={60}
                            autoFocus
                            readOnly={busy}
                            aria-label={t('重命名 {group}', { group: label })}
                            placeholder={label}
                            onChange={(event) => setEditingName(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                void commitRename(item);
                              }
                              if (event.key === 'Escape') setEditingKey(null);
                            }}
                          />
                          <div className="perm-rename-actions">
                            <button
                              type="button"
                              className={cx('perm-rename-btn', 'perm-rename-save', busy && 'is-busy')}
                              aria-label={t('保存名称')}
                              title={t('保存名称')}
                              disabled={busy}
                              onClick={() => void commitRename(item)}
                            >
                              {busy ? (
                                <span className="spinner spinner-sm" aria-hidden />
                              ) : (
                                <Icon name="check" size={11} />
                              )}
                              <span>{busy ? t('保存中') : t('保存')}</span>
                            </button>
                            <button
                              type="button"
                              className="perm-rename-btn perm-rename-cancel"
                              aria-label={t('取消重命名')}
                              title={t('取消重命名')}
                              disabled={busy}
                              onClick={() => setEditingKey(null)}
                            >
                              <Icon name="x" size={11} />
                              <span>{t('取消')}</span>
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <button
                            type="button"
                            className={cx('perm-group-name', busy && 'is-busy')}
                            title={t('重命名 {group}', { group: label })}
                            disabled={personal}
                            onClick={() => startRename(item)}
                          >
                            <span>{label}</span>
                            <Icon name={busy ? 'refresh' : 'edit'} size={12} />
                          </button>
                          <span className="tiny faint" style={{ display: 'block', marginTop: 2 }}>
                            {item.builtin
                              ? item.base_role
                                ? ROLE_LABEL[item.base_role]
                                : t('无账户')
                              : t('自定义 · {role}', { role: ROLE_LABEL[item.base_role ?? 'member'] })}
                          </span>
                        </>
                      )}
                    </th>
                  );
                })}
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
                  {draft.map((item) => {
                    const on = item.capabilities[cap.id];
                    const reason = locked(item, cap.id);
                    return (
                      <td key={item.key} style={{ textAlign: 'center' }}>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={on}
                          aria-label={`${groupConfigLabel(item)} · ${cap.label}`}
                          title={
                            reason ||
                            (on
                              ? t('关闭 {group}的「{capability}」', {
                                  group: groupConfigLabel(item),
                                  capability: cap.label,
                                })
                              : t('开启 {group}的「{capability}」', {
                                  group: groupConfigLabel(item),
                                  capability: cap.label,
                                }))
                          }
                          className={cx('perm-cell', on && 'is-on')}
                          disabled={!!reason || personal || !!saving[item.key]}
                          onClick={() => toggle(item, cap.id)}
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
                    {t('关闭后该组只能在站点前台活动；开启后仍需至少一项后台能力。')}
                  </p>
                </td>
                {draft.map((item) => {
                  const on = item.admin_access;
                  const reason = adminLocked(item);
                  return (
                    <td key={item.key} style={{ textAlign: 'center' }}>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={on}
                        aria-label={t('{group} 进入管理后台', { group: groupConfigLabel(item) })}
                        title={reason || t('切换后台入口')}
                        className={cx('perm-cell', on && 'is-on')}
                        disabled={!!reason || personal || !!saving[item.key]}
                        onClick={() => toggleAdmin(item)}
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
              {draft.map((item) => {
                const builtinHint =
                  item.builtin && item.key !== 'guest'
                    ? t('内置组，角色固定为{role}。', { role: ROLE_LABEL[item.base_role ?? 'member'] })
                    : item.key === 'guest'
                      ? t('未登录访客，只能阅读公开内容。')
                      : t('自定义能力组，基础角色为{role}。', { role: ROLE_LABEL[item.base_role ?? 'member'] });
                return (
                  <div className="mini-row" key={item.key} style={{ alignItems: 'flex-start' }}>
                    <span className="mini-label" style={{ minWidth: 96 }}>
                      {groupConfigLabel(item)}
                    </span>
                    <span
                      className="mini-value"
                      style={{ fontWeight: 400, color: 'var(--muted)', textAlign: 'left' }}
                    >
                      {builtinHint}
                      {item.key === 'owner' ? (
                        <span className="tiny faint">{t(' · 对应角色 {role}', { role: ROLE_LABEL.platform_admin })}</span>
                      ) : null}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <div>
              <h3>{t('服务端授权边界')}</h3>
              <p>{t('组名可以改，角色映射与授权边界不能改。')}</p>
            </div>
          </div>
          <div className="panel-body">
            <Callout tone="warn" icon="alert" title={t('哪些能力只允许内置组持有')}>
              {t('「配置权限组」只属于内置组；自定义组最多映射到站点管理员，且能力必须是基础角色的子集。')}{' '}
              {t('最高管理员固定全开，游客只读，避免把站点锁在门外。')}
            </Callout>
            <p className="small muted mt-12" style={{ lineHeight: 1.8 }}>
              {t('保存后服务端立即按新矩阵校验：关闭「管理成员」后，该组成员调用成员接口会被拒绝，')}{' '}
              {t('即使页面仍然开着也一样。改名只影响显示名称，成员与授权不会移动。')}
            </p>
          </div>
        </section>
      </div>

      <Modal
        open={newOpen}
        title={t('新增能力组')}
        description={t('在现有角色之上新增一个更窄的能力组；创建后会立即出现在矩阵里。')}
        onClose={() => setNewOpen(false)}
        width={720}
        footer={
          <>
            <Button variant="ghost" onClick={() => setNewOpen(false)}>
              {t('取消')}
            </Button>
            <Button loading={creating} onClick={() => void createGroup()} icon="plus">
              {t('创建能力组')}
            </Button>
          </>
        }
      >
        <div className="form-stack">
          <div className="form-grid">
            <Field label={t('能力组名称')} htmlFor="group-name">
              <Input
                id="group-name"
                value={newDraftState.name}
                maxLength={60}
                autoFocus
                placeholder={t('例如：审稿人')}
                onChange={(event) => setNewDraftState({ ...newDraftState, name: event.target.value })}
              />
            </Field>
            <Field
              label={t('组标识')}
              htmlFor="group-key"
              hint={t('用于接口与成员绑定，创建后不可修改。')}
            >
              <Input
                id="group-key"
                value={newDraftState.key}
                maxLength={36}
                onChange={(event) =>
                  setNewDraftState({ ...newDraftState, key: event.target.value.toLowerCase() })
                }
              />
            </Field>
          </div>
          <Field
            label={t('基础角色')}
            htmlFor="group-role"
            hint={t('组的能力只能是这个服务端角色的子集。')}
          >
            <Select
              id="group-role"
              value={newDraftState.base_role}
              onChange={(event) => {
                const baseRole = event.target.value as Role;
                const allowed = allowedCapabilitiesForRole(baseRole);
                const capabilities = { ...newDraftState.capabilities };
                for (const cap of CAPABILITY_DEFS) {
                  capabilities[cap.id] = capabilities[cap.id] && allowed.has(cap.id);
                }
                setNewDraftState({ ...newDraftState, base_role: baseRole, capabilities });
              }}
            >
              {CUSTOM_GROUP_BASE_ROLES.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABEL[role]}
                </option>
              ))}
            </Select>
          </Field>
          <div>
            <div className="field-head">
              <span className="field-label">{t('能力')}</span>
              <span className="field-aside">{t('创建后仍可在矩阵里调整')}</span>
            </div>
            <div className="group-choice-grid">
              {CAPABILITY_DEFS.map((cap) => {
                const allowed = newAllowed.has(cap.id);
                const on = newDraftState.capabilities[cap.id] && allowed;
                return (
                  <button
                    key={cap.id}
                    type="button"
                    className={`group-choice${on ? ' is-on' : ''}`}
                    disabled={!allowed}
                    onClick={() =>
                      setNewDraftState({
                        ...newDraftState,
                        capabilities: {
                          ...newDraftState.capabilities,
                          [cap.id]: !newDraftState.capabilities[cap.id],
                        },
                      })
                    }
                  >
                    <span className="group-choice-body">
                      <strong>{cap.label}</strong>
                      <em>{allowed ? cap.hint : t('基础角色不支持这项能力')}</em>
                    </span>
                    {on ? <Icon name="check-circle" size={15} /> : null}
                  </button>
                );
              })}
            </div>
          </div>
          {newError ? (
            <Callout tone="danger" icon="alert">
              {newError}
            </Callout>
          ) : null}
        </div>
      </Modal>

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
            <Button onClick={() => void restoreDefaults()}>{t('恢复默认')}</Button>
          </>
        }
      >
        <p className="small muted" style={{ lineHeight: 1.8 }}>
          {t('默认值：游客只读；成员可以评论与投稿；审核员处理内容与评论；管理员管理成员与站点；')}{' '}
          {t('最高管理员拥有全部能力。自定义组会保留，但名称与矩阵需要你自行调整。')}
        </p>
      </Modal>
    </RoleGate>
  );
}
