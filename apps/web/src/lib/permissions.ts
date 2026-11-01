import type {
  CapabilityId,
  PermissionGroup,
  PermissionGroupId,
  PermissionSettings,
  Role,
  SiteKind,
  VisibilityMode,
} from '../types';

/**
 * 权限组与能力矩阵。
 *
 * 契约 v0.1.0 只定义四级固定角色，没有权限组端点。因此：
 * - 角色仍然决定服务端授权（member / editor / site_admin / platform_admin）；
 * - 这里的权限组是站点自己的表达层：把角色映射成「游客 / 成员 / 审核员 / 管理员 /
 *   最高管理员」，并允许站长逐项调整前台与后台入口。
 * 界面隐藏不能替代服务端授权，本文件只用于产品策略与导航。
 */

export interface CapabilityDef {
  id: CapabilityId;
  label: string;
  hint: string;
}

export const CAPABILITY_DEFS: CapabilityDef[] = [
  { id: 'read_content', label: '阅读内容', hint: '查看已发布的文章与帖子。' },
  { id: 'comment', label: '发表评论', hint: '在文章与帖子下参与讨论、回复他人。' },
  { id: 'write_content', label: '创建内容', hint: '写文章、发帖子，进入内容库。' },
  { id: 'moderate_content', label: '审核内容', hint: '处理审核队列，发布、退回与归档。' },
  { id: 'moderate_comment', label: '管理评论', hint: '通过、隐藏与删除评论。' },
  { id: 'manage_member', label: '管理成员', hint: '创建账户、调整角色。' },
  { id: 'manage_site', label: '管理站点', hint: '站点设置、外观、主题、页面与扩展。' },
  { id: 'view_log', label: '查看操作日志', hint: '阅读后台的操作记录。' },
  { id: 'manage_permission', label: '配置权限组', hint: '修改这份能力矩阵。' },
];

export interface PermissionGroupDef {
  id: PermissionGroupId;
  label: string;
  /** 对应的服务端角色；游客没有账户。 */
  role: Role | null;
  hint: string;
}

export const PERMISSION_GROUPS: PermissionGroupDef[] = [
  { id: 'guest', label: '游客', role: null, hint: '未登录访客，只能阅读公开内容。' },
  { id: 'member', label: '成员', role: 'member', hint: '自助注册或由管理员创建，可以评论与投稿。' },
  { id: 'moderator', label: '审核员', role: 'editor', hint: '处理内容与评论审核，可以直接发布。' },
  { id: 'admin', label: '管理员', role: 'site_admin', hint: '管理成员、站点设置与外观。' },
  { id: 'owner', label: '最高管理员', role: 'platform_admin', hint: '拥有全部权限，包括配置权限组。' },
];

const ALL_CAPABILITIES: CapabilityId[] = CAPABILITY_DEFS.map((item) => item.id);

function emptyCapabilities(): Record<CapabilityId, boolean> {
  const out = {} as Record<CapabilityId, boolean>;
  for (const id of ALL_CAPABILITIES) out[id] = false;
  return out;
}

/** 生成一组权限：列出的能力为真，其余为假。 */
export function group(enabled: CapabilityId[], adminAccess = false): PermissionGroup {
  const capabilities = emptyCapabilities();
  for (const id of enabled) capabilities[id] = true;
  return { admin_access: adminAccess, capabilities };
}

export const DEFAULT_PERMISSIONS: PermissionSettings = {
  guest: group(['read_content']),
  member: group(['read_content', 'comment', 'write_content']),
  moderator: group(['read_content', 'comment', 'write_content', 'moderate_content', 'moderate_comment'], true),
  admin: group(
    [
      'read_content',
      'comment',
      'write_content',
      'moderate_content',
      'moderate_comment',
      'manage_member',
      'manage_site',
      'manage_permission',
      'view_log',
    ],
    true,
  ),
  owner: group(ALL_CAPABILITIES, true),
};

const GROUP_IDS = PERMISSION_GROUPS.map((item) => item.id);

/**
 * 把任意（旧版本或导入的）权限配置收敛成合法结构。
 *
 * 规则：
 * - 游客不能进入后台，也不能持有后台能力；
 * - 最高管理员始终拥有全部能力，避免把自己锁在门外；
 * - 任何后台能力都隐含「阅读内容」。
 */
export function normalizePermissions(value: unknown): PermissionSettings {
  const raw = (value ?? {}) as Partial<Record<PermissionGroupId, Partial<PermissionGroup>>>;
  const out = {} as PermissionSettings;
  for (const id of GROUP_IDS) {
    const candidate = raw[id];
    const capabilities = emptyCapabilities();
    for (const cap of ALL_CAPABILITIES) {
      const fallback = DEFAULT_PERMISSIONS[id].capabilities[cap];
      const next = candidate?.capabilities?.[cap];
      capabilities[cap] = typeof next === 'boolean' ? next : fallback;
    }
    if (typeof candidate?.admin_access === 'boolean') {
      out[id] = { admin_access: candidate.admin_access, capabilities };
    } else {
      out[id] = { admin_access: DEFAULT_PERMISSIONS[id].admin_access, capabilities };
    }
  }

  for (const cap of ALL_CAPABILITIES) out.guest.capabilities[cap] = false;
  out.guest.capabilities.read_content = true;
  out.guest.admin_access = false;

  for (const cap of ALL_CAPABILITIES) out.owner.capabilities[cap] = true;
  out.owner.admin_access = true;

  for (const id of GROUP_IDS) {
    if (id === 'guest' || id === 'owner') continue;
    const caps = out[id].capabilities;
    // 权限组配置是管理动作：普通成员与审核员不能持有。
    if (id === 'member' || id === 'moderator') caps.manage_permission = false;
    caps.read_content = caps.read_content || hasAnyCapability(caps);
  }
  return out;
}

function hasAnyCapability(caps: Record<CapabilityId, boolean>): boolean {
  return ALL_CAPABILITIES.some((id) => id !== 'read_content' && caps[id]);
}

/** 角色 → 权限组。个人博客在 effectiveGroup 里统一落到最高管理员。 */
export function groupIdForRole(role?: Role | null): PermissionGroupId {
  switch (role) {
    case 'platform_admin':
      return 'owner';
    case 'site_admin':
      return 'admin';
    case 'editor':
      return 'moderator';
    case 'member':
      return 'member';
    default:
      return 'guest';
  }
}

/** 权限组 → 服务端角色。游客返回 null。 */
export function roleForGroup(id: PermissionGroupId): Role | null {
  return PERMISSION_GROUPS.find((item) => item.id === id)?.role ?? null;
}

export interface PermissionContext {
  kind: SiteKind;
  visibility: VisibilityMode;
  role?: Role | null;
  loggedIn: boolean;
}

/**
 * 当前账户实际落在哪个权限组。
 *
 * 个人博客的规则是「所有账户都是最高管理员」：站长在后台创建的账户不需要再分配角色，
 * 都可以登录后台并拥有全部能力。社区站点按角色映射到权限组。
 */
export function effectiveGroup(ctx: PermissionContext): PermissionGroupId {
  if (!ctx.loggedIn) return 'guest';
  if (ctx.kind === 'personal') return 'owner';
  return groupIdForRole(ctx.role);
}

/** 判断某个权限组是否具备能力。游客阅读受站点访客模式约束。 */
export function groupCan(
  settings: PermissionSettings,
  groupId: PermissionGroupId,
  capability: CapabilityId,
  ctx: Pick<PermissionContext, 'visibility'>,
): boolean {
  if (!settings[groupId]) return false;
  if (groupId === 'guest' && capability === 'read_content') {
    return ctx.visibility === 'public' && settings.guest.capabilities.read_content;
  }
  if (groupId === 'guest' && !settings.guest.capabilities[capability]) return false;
  return settings[groupId].capabilities[capability];
}

/** 角色等级门槛（RoleGate 的 min）→ 能力。 */
export const ROLE_CAPABILITY: Record<Role, CapabilityId> = {
  member: 'comment',
  editor: 'moderate_content',
  site_admin: 'manage_site',
  platform_admin: 'manage_permission',
};

export const CAPABILITY_LABEL: Record<CapabilityId, string> = CAPABILITY_DEFS.reduce(
  (acc, item) => ({ ...acc, [item.id]: item.label }),
  {} as Record<CapabilityId, string>,
);
