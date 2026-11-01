import { useMemo } from 'react';
import type { CapabilityId, PermissionGroupId, PermissionSettings, Role } from '../types';
import { useAuth } from './session';
import { useCustomization } from './customize';
import { siteKindOf } from './site';
import { ROLE_CAPABILITY, effectiveGroup, groupCan } from './permissions';

/**
 * 当前账户的权限视图。
 *
 * 个人博客：登录即最高权限（owner 组），游客只能阅读。
 * 社区站点：角色映射到权限组，再按站长配置的能力矩阵判断。
 */
export function usePermissions(): {
  personal: boolean;
  group: PermissionGroupId;
  settings: PermissionSettings;
  can: (capability: CapabilityId) => boolean;
  canRole: (min: Role) => boolean;
  groupHas: (groupId: PermissionGroupId, capability: CapabilityId) => boolean;
  updatePermissions: (next: PermissionSettings) => void;
} {
  const { config, me, site } = useAuth();
  const { customization, update } = useCustomization();
  const kind = siteKindOf(config);
  const settings = customization.permissions;
  const visibility = site?.visibility_mode ?? 'public';
  const role = me?.role;
  const loggedIn = !!me;
  const group = effectiveGroup({ kind, visibility, role, loggedIn });

  return useMemo(
    () => ({
      personal: kind === 'personal',
      group,
      settings,
      can: (capability: CapabilityId) => groupCan(settings, group, capability, { visibility }),
      canRole: (min: Role) => groupCan(settings, group, ROLE_CAPABILITY[min], { visibility }),
      groupHas: (groupId: PermissionGroupId, capability: CapabilityId) =>
        groupCan(settings, groupId, capability, { visibility }),
      updatePermissions: (next: PermissionSettings) => update({ permissions: next }),
    }),
    [kind, group, settings, visibility, update],
  );
}
