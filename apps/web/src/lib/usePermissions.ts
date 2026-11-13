import { useCallback, useMemo } from 'react';
import type {
  CapabilityId,
  PermissionGroupConfig,
  PermissionGroupId,
  PermissionSettings,
  Role,
} from '../types';
import { useAuth } from './session';
import { useCustomization } from './customize';
import { siteKindOf } from './site';
import { hasAdminCapability } from './adminAccess';
import {
  DEFAULT_PERMISSION_GROUPS,
  ROLE_CAPABILITY,
  effectiveGroup,
  groupConfigFor,
  groupIdForRole,
  groupsToSettings,
  normalizePermissionGroupConfigs,
  permissionGroupCan,
} from './permissions';

/**
 * 当前账户的权限视图。
 *
 * 个人博客：登录即最高权限（owner 组），游客只能阅读。
 * 社区站点：账户落在服务端分配的组（未分配时按角色映射到内置组），能力矩阵由
 * 服务端下发；后端没有组端点时退回本地镜像，界面与服务端使用同一套能力 id。
 */
export function usePermissions(): {
  personal: boolean;
  group: string;
  groups: PermissionGroupConfig[];
  groupConfig: PermissionGroupConfig | undefined;
  settings: PermissionSettings;
  can: (capability: CapabilityId) => boolean;
  canRole: (min: Role) => boolean;
  groupHas: (groupId: string, capability: CapabilityId) => boolean;
  /** 保存能力组到本地镜像（演示模式或离线回退）。 */
  updateGroups: (next: PermissionGroupConfig[]) => void;
  /** 兼容旧调用方：只更新四级组的矩阵。 */
  updatePermissions: (next: PermissionSettings) => void;
  /** 能否进入管理后台：后台能力 + 该组已开启的「进入管理后台」。 */
  adminEntry: boolean;
} {
  const { config, me, site, permissionGroups } = useAuth();
  const { customization, update } = useCustomization();
  const kind = siteKindOf(config);
  const visibility = site?.visibility_mode ?? 'public';
  const role = me?.role;
  const loggedIn = !!me;

  const groups = useMemo(
    () => normalizePermissionGroupConfigs(
      permissionGroups ?? customization.permission_groups ?? DEFAULT_PERMISSION_GROUPS,
    ),
    [permissionGroups, customization.permission_groups],
  );

  const group = useMemo(() => {
    if (!loggedIn) return 'guest';
    if (kind === 'personal') return 'owner';
    const assigned = me?.group_key;
    if (assigned && groupConfigFor(groups, assigned)) return assigned;
    return effectiveGroup({ kind, visibility, role, loggedIn });
  }, [groups, kind, loggedIn, me?.group_key, role, visibility]);

  const groupConfig = groupConfigFor(groups, group);
  const settings = useMemo(() => groupsToSettings(groups), [groups]);

  const can = useCallback(
    (capability: CapabilityId) => permissionGroupCan(groupConfig, capability, { visibility }),
    [groupConfig, visibility],
  );

  const groupHas = useCallback(
    (groupId: string, capability: CapabilityId) =>
      permissionGroupCan(groupConfigFor(groups, groupId), capability, { visibility }),
    [groups, visibility],
  );

  const updateGroups = useCallback(
    (next: PermissionGroupConfig[]) => {
      update({
        permission_groups: normalizePermissionGroupConfigs(next),
        // 旧页面只读取 permissions 时也能看到内置组的新矩阵。
        permissions: groupsToSettings(next),
      });
    },
    [update],
  );

  return useMemo(
    () => ({
      personal: kind === 'personal',
      group,
      groups,
      groupConfig,
      settings,
      can,
      canRole: (min: Role) => permissionGroupCan(groupConfig, ROLE_CAPABILITY[min], { visibility }),
      groupHas,
      updateGroups,
      updatePermissions: (next: PermissionSettings) => update({ permissions: next }),
      adminEntry:
        !!groupConfig?.admin_access && hasAdminCapability(can),
    }),
    [kind, group, groups, groupConfig, settings, can, groupHas, visibility, updateGroups, update],
  );
}

/** 角色 → 内置组 key；其它模块需要显示分组名称时共用这一处映射。 */
export function defaultGroupForRole(role?: Role | null): PermissionGroupId {
  return groupIdForRole(role);
}
