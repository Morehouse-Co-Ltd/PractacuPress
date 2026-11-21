import { describe, expect, it } from 'vitest';
import type { CapabilityId } from '../types';
import {
  CUSTOM_GROUP_KEY_PATTERN,
  DEFAULT_PERMISSION_GROUPS,
  allowedCapabilitiesForRole,
  groupConfigLabel,
  groupsToSettings,
  normalizeGroupConfig,
  normalizePermissionGroupConfigs,
  permissionGroupCan,
  permissionGroupSelfLocked,
} from './permissions';
import { t } from './i18n';

describe('能力组配置', () => {
  it('非平台管理员只能改名自己的组，平台管理员豁免', () => {
    expect(permissionGroupSelfLocked('admin', 'admin', 'site_admin')).toBe(true);
    // 组标识缺失时按角色回退到内置组。
    expect(permissionGroupSelfLocked('admin', undefined, 'site_admin')).toBe(true);
    expect(permissionGroupSelfLocked('moderator', 'admin', 'site_admin')).toBe(false);
    expect(permissionGroupSelfLocked('admin', 'admin', 'platform_admin')).toBe(false);
    expect(permissionGroupSelfLocked('owner', 'owner', 'platform_admin')).toBe(false);
    expect(permissionGroupSelfLocked('member', 'member', 'member')).toBe(true);
  });

  it('补齐五个内置组并强制 owner / guest 的不变量', () => {
    const groups = normalizePermissionGroupConfigs([
      {
        key: 'owner',
        name: '',
        base_role: 'platform_admin',
        capabilities: { read_content: false },
        admin_access: false,
        builtin: true,
      },
      {
        key: 'guest',
        name: '',
        base_role: null,
        capabilities: { read_content: false, write_content: true },
        admin_access: true,
        builtin: true,
      },
    ]);
    expect(groups.map((group) => group.key)).toEqual([
      'guest',
      'member',
      'moderator',
      'admin',
      'owner',
    ]);

    const guest = groups.find((group) => group.key === 'guest')!;
    expect(guest.capabilities.read_content).toBe(true);
    expect(guest.capabilities.write_content).toBe(false);
    expect(guest.admin_access).toBe(false);

    const owner = groups.find((group) => group.key === 'owner')!;
    expect(owner.capabilities.manage_permission).toBe(true);
    expect(owner.capabilities.read_content).toBe(true);
    expect(owner.admin_access).toBe(true);
  });

  it('内置组可以改名，但角色映射保持不变', () => {
    const renamed = normalizeGroupConfig({
      ...DEFAULT_PERMISSION_GROUPS.find((group) => group.key === 'admin')!,
      name: '运营组',
      base_role: 'member',
    });
    expect(renamed.name).toBe('运营组');
    expect(renamed.base_role).toBe('site_admin');
    expect(groupConfigLabel(renamed)).toBe('运营组');
  });

  it('自定义组收窄基础角色能力，且永远不能持有配置权限组', () => {
    const group = normalizeGroupConfig({
      key: 'reviewer',
      name: '审稿人',
      base_role: 'editor',
      capabilities: {
        read_content: true,
        comment: true,
        moderate_content: true,
        manage_site: true,
        manage_permission: true,
      } as Record<CapabilityId, boolean>,
      admin_access: true,
      builtin: false,
    });
    expect(group.base_role).toBe('editor');
    expect(group.capabilities.moderate_content).toBe(true);
    expect(group.capabilities.write_content).toBe(false);
    expect(group.capabilities.manage_site).toBe(false);
    expect(group.capabilities.manage_permission).toBe(false);
    expect(allowedCapabilitiesForRole('editor').has('manage_site')).toBe(false);
  });

  it('内置组可以像服务端一样开启出厂默认之外的能力', () => {
    const member = DEFAULT_PERMISSION_GROUPS.find((group) => group.key === 'member')!;
    const raised = normalizeGroupConfig({
      ...member,
      capabilities: { ...member.capabilities, manage_site: true, view_log: true },
    });
    expect(raised.capabilities.manage_site).toBe(true);
    expect(raised.capabilities.view_log).toBe(true);

    const moderator = DEFAULT_PERMISSION_GROUPS.find((group) => group.key === 'moderator')!;
    const promoted = normalizeGroupConfig({
      ...moderator,
      capabilities: { ...moderator.capabilities, manage_member: true, manage_permission: true },
    });
    expect(promoted.capabilities.manage_member).toBe(true);
    expect(promoted.capabilities.manage_permission).toBe(false);
  });

  it('自定义组的基础角色越界时回退到成员', () => {
    const group = normalizeGroupConfig({
      key: 'odd',
      name: 'Odd',
      base_role: 'platform_admin',
      capabilities: { read_content: true } as Record<CapabilityId, boolean>,
      admin_access: false,
      builtin: false,
    });
    expect(group.base_role).toBe('member');
  });

  it('内置组名称随界面语言回退', () => {
    const member = DEFAULT_PERMISSION_GROUPS.find((group) => group.key === 'member')!;
    expect(groupConfigLabel(member)).toBe(t('成员'));
  });

  it('旧的四级组视图与能力组保持一致', () => {
    const groups = normalizePermissionGroupConfigs([]);
    const settings = groupsToSettings(groups);
    expect(settings.member.capabilities.write_content).toBe(true);
    expect(settings.owner.capabilities.manage_permission).toBe(true);
    expect(settings.guest.capabilities.read_content).toBe(true);
  });

  it('旧 permissions 对象会迁移成能力组而不是回落到默认值', () => {
    const groups = normalizePermissionGroupConfigs({
      member: {
        admin_access: false,
        capabilities: { read_content: true, comment: false, write_content: false },
      },
      admin: {
        admin_access: true,
        capabilities: { manage_member: true, manage_site: false },
      },
    });
    const member = groups.find((group) => group.key === 'member')!;
    expect(member.capabilities.write_content).toBe(false);
    expect(member.capabilities.read_content).toBe(true);
    const admin = groups.find((group) => group.key === 'admin')!;
    expect(admin.capabilities.manage_member).toBe(true);
    expect(admin.capabilities.manage_site).toBe(false);
    // The legacy object has no custom groups; the five built-ins are still present.
    expect(groups.map((group) => group.key)).toEqual([
      'guest',
      'member',
      'moderator',
      'admin',
      'owner',
    ]);
  });

  it('组标识上限与审计目标列一致', () => {
    expect(CUSTOM_GROUP_KEY_PATTERN.test('g' + 'x'.repeat(35))).toBe(true);
    expect(CUSTOM_GROUP_KEY_PATTERN.test('g' + 'x'.repeat(36))).toBe(false);
  });

  it('游客只在公开站点能读', () => {
    const groups = normalizePermissionGroupConfigs([]);
    const guest = groups.find((group) => group.key === 'guest')!;
    expect(permissionGroupCan(guest, 'read_content', { visibility: 'members_only' })).toBe(false);
    expect(permissionGroupCan(guest, 'read_content', { visibility: 'public' })).toBe(true);
  });
});
