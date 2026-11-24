import type {
  CapabilityId,
  PermissionGroup,
  PermissionGroupConfig,
  PermissionGroupId,
  PermissionSettings,
  Role,
  SiteKind,
  VisibilityMode,
} from '../types';
import { t } from './i18n';
import { liveCatalog } from './i18n/live';

/**
 * 权限组与能力矩阵。
 *
 * 权限组由服务端持久化（/permission-groups），后台路由由能力守卫按 manage_site /
 * view_log 等能力放行，服务端用例再按同一能力复核。因此：
 * - 能力矩阵是授权来源；未保存矩阵时回退角色默认能力（见服务端 DefaultCapabilities）；
 * - 这里的映射负责把能力翻译成前台与后台入口，并允许站长逐项调整；
 * 界面隐藏不能替代服务端授权，本文件只用于产品策略与导航。
 */

export interface CapabilityDef {
  id: CapabilityId;
  label: string;
  hint: string;
}

const RAW_CAPABILITY_DEFS: CapabilityDef[] = [
  { id: 'read_content', label: t('阅读内容'), hint: t('查看已发布的文章与帖子。') },
  { id: 'comment', label: t('发表评论'), hint: t('在文章与帖子下参与讨论、回复他人。') },
  { id: 'write_content', label: t('创建内容'), hint: t('写文章、发帖子，进入内容库。') },
  { id: 'moderate_content', label: t('审核内容'), hint: t('处理审核队列，发布、退回与归档。') },
  { id: 'moderate_comment', label: t('管理评论'), hint: t('通过、隐藏与删除评论。') },
  { id: 'manage_member', label: t('管理成员'), hint: t('创建账户、调整角色。') },
  { id: 'manage_site', label: t('管理站点'), hint: t('站点设置、外观、主题、页面与扩展。') },
  { id: 'view_log', label: t('查看操作日志'), hint: t('阅读后台的操作记录。') },
  { id: 'manage_permission', label: t('配置权限组'), hint: t('修改这份能力矩阵。') },
];

/** 目录中文在读取时翻译，切换语言后立即生效（见 i18n/live.ts）。 */
export const CAPABILITY_DEFS = liveCatalog(RAW_CAPABILITY_DEFS);

export interface PermissionGroupDef {
  id: PermissionGroupId;
  label: string;
  /** 对应的服务端角色；游客没有账户。 */
  role: Role | null;
  hint: string;
}

const RAW_PERMISSION_GROUPS: PermissionGroupDef[] = [
  { id: 'guest', label: t('游客'), role: null, hint: t('未登录访客，只能阅读公开内容。') },
  { id: 'member', label: t('成员'), role: 'member', hint: t('自助注册或由管理员创建，可以评论与投稿。') },
  { id: 'moderator', label: t('审核员'), role: 'editor', hint: t('处理内容与评论审核，可以直接发布。') },
  { id: 'admin', label: t('管理员'), role: 'site_admin', hint: t('管理成员、站点设置与外观。') },
  { id: 'owner', label: t('最高管理员'), role: 'platform_admin', hint: t('拥有全部权限，包括配置权限组。') },
];

/** 目录中文在读取时翻译，切换语言后立即生效（见 i18n/live.ts）。 */
export const PERMISSION_GROUPS = liveCatalog(RAW_PERMISSION_GROUPS);

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

/**
 * 初始能力组：四个内置组的矩阵来自 DEFAULT_PERMISSIONS。
 *
 * 内置组的 `name` 为空：界面读取时回退到当前语言的内置名称，所以英文界面不会
 * 显示站长只改过中文名的旧值。
 */
export const DEFAULT_PERMISSION_GROUPS: PermissionGroupConfig[] = PERMISSION_GROUPS.map((item) => ({
  key: item.id,
  name: '',
  base_role: item.role,
  capabilities: { ...DEFAULT_PERMISSIONS[item.id].capabilities },
  admin_access: DEFAULT_PERMISSIONS[item.id].admin_access,
  builtin: true,
}));

/** 自定义组标识：小写字母开头，允许数字、连字符与下划线；上限与审计目标列一致。 */
export const CUSTOM_GROUP_KEY_PATTERN = /^[a-z][a-z0-9_-]{1,35}$/;

/** 自定义组可以选的基础角色；平台管理员只属于内置 owner 组。 */
export const CUSTOM_GROUP_BASE_ROLES: Role[] = ['member', 'editor', 'site_admin'];

/** 某个基础角色允许自定义组持有的能力上限（不含配置权限组）。 */
export function allowedCapabilitiesForRole(role: Role | null): Set<CapabilityId> {
  switch (role) {
    case 'platform_admin':
      return new Set(ALL_CAPABILITIES);
    case 'site_admin':
      return new Set<CapabilityId>([
        'read_content',
        'comment',
        'write_content',
        'moderate_content',
        'moderate_comment',
        'manage_member',
        'manage_site',
        'view_log',
      ]);
    case 'editor':
      return new Set<CapabilityId>([
        'read_content',
        'comment',
        'write_content',
        'moderate_content',
        'moderate_comment',
      ]);
    case 'member':
      return new Set<CapabilityId>(['read_content', 'comment', 'write_content']);
    default:
      return new Set<CapabilityId>();
  }
}

/** 某个内置组的显示名称：站长改过就用改后的，否则用当前语言的内置名称。 */
export function groupConfigLabel(group: PermissionGroupConfig): string {
  const custom = group.name.trim();
  if (custom) return custom;
  const builtin = PERMISSION_GROUPS.find((item) => item.id === group.key);
  return builtin?.label ?? group.key;
}

/** 按 key 找组。 */
export function groupConfigFor(
  groups: PermissionGroupConfig[],
  key: string | null | undefined,
): PermissionGroupConfig | undefined {
  if (!key) return undefined;
  return groups.find((group) => group.key === key);
}

/** 角色对应的内置组 key。 */
export function builtinGroupKeyForRole(role?: Role | null): PermissionGroupId {
  return groupIdForRole(role);
}

/** 把服务端或本地保存的任意值收敛成完整的能力组列表。 */
export function normalizePermissionGroupConfigs(value: unknown): PermissionGroupConfig[] {
  // Older design documents stored the matrix as one object keyed by group id
  // (`permissions: { member: { capabilities… } }`). Import it instead of falling
  // back to factory defaults, otherwise an upgraded installation would silently
  // lose the operator's existing matrix until the server seeds its own copy.
  if (!Array.isArray(value) && value && typeof value === 'object') {
    const legacy = normalizePermissions(value);
    return DEFAULT_PERMISSION_GROUPS.map((builtin) => {
      const settings = legacy[builtin.key as PermissionGroupId];
      return normalizeGroupConfig({
        ...builtin,
        capabilities: { ...settings.capabilities },
        admin_access: settings.admin_access,
        builtin: true,
      });
    });
  }

  const raw = Array.isArray(value) ? value : [];
  const byKey = new Map<string, Partial<PermissionGroupConfig>>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Partial<PermissionGroupConfig>;
    if (typeof candidate.key !== 'string' || !candidate.key) continue;
    byKey.set(candidate.key, candidate);
  }

  const out: PermissionGroupConfig[] = [];
  for (const builtin of DEFAULT_PERMISSION_GROUPS) {
    const candidate = byKey.get(builtin.key);
    out.push(normalizeGroupConfig({ ...builtin, ...candidate, key: builtin.key, builtin: true }));
  }
  for (const [key, candidate] of byKey) {
    if (DEFAULT_PERMISSION_GROUPS.some((groupDef) => groupDef.key === key)) continue;
    out.push(
      normalizeGroupConfig({
        key,
        name: typeof candidate.name === 'string' ? candidate.name : '',
        base_role: candidate.base_role ?? 'member',
        capabilities: candidate.capabilities ?? emptyCapabilities(),
        admin_access: candidate.admin_access === true,
        builtin: false,
      }),
    );
  }
  return out;
}

/** 单组合法化；内置组强制角色映射，自定义组限制在基础角色能力之内。 */
export function normalizeGroupConfig(value: PermissionGroupConfig): PermissionGroupConfig {
  const key = value.key;
  const builtin = DEFAULT_PERMISSION_GROUPS.find((groupDef) => groupDef.key === key);
  const capabilities = emptyCapabilities();
  for (const capability of ALL_CAPABILITIES) {
    capabilities[capability] = value.capabilities?.[capability] === true;
  }

  if (builtin) {
    // The server lets an operator turn any capability of a built-in group on or
    // off (except the guest / owner invariants and manage_permission for member and
    // moderator). Masking with the factory defaults here would silently discard a
    // capability the server accepted, and the dashboard would then disagree with
    // the authorization decision it is trying to preview.
    if (key === 'guest') {
      capabilities.read_content = true;
      for (const capability of ALL_CAPABILITIES) {
        if (capability !== 'read_content') capabilities[capability] = false;
      }
    }
    if (key === 'owner') {
      for (const capability of ALL_CAPABILITIES) capabilities[capability] = true;
    }
    if (key === 'member' || key === 'moderator') capabilities.manage_permission = false;
    return {
      key,
      name: typeof value.name === 'string' ? value.name.slice(0, 60) : '',
      base_role: builtin.base_role,
      capabilities,
      admin_access: key === 'guest' ? false : key === 'owner' ? true : !!value.admin_access,
      builtin: true,
    };
  }

  const baseRole = CUSTOM_GROUP_BASE_ROLES.find((role) => role === value.base_role) ?? 'member';
  const allowed = allowedCapabilitiesForRole(baseRole);
  for (const capability of ALL_CAPABILITIES) {
    capabilities[capability] = capabilities[capability] && allowed.has(capability);
  }
  capabilities.manage_permission = false;
  const adminAccess =
    !!value.admin_access &&
    ALL_CAPABILITIES.some(
      (capability) => capability !== 'read_content' && capability !== 'comment' && capabilities[capability],
    );
  return {
    key,
    name: (typeof value.name === 'string' ? value.name : '').slice(0, 60),
    base_role: baseRole,
    capabilities,
    admin_access: adminAccess,
    builtin: false,
  };
}

/** 内置组矩阵 → 旧的 PermissionSettings（供只认识四级组的旧调用方使用）。 */
export function groupsToSettings(groups: PermissionGroupConfig[]): PermissionSettings {
  const settings = {} as PermissionSettings;
  for (const groupDef of PERMISSION_GROUPS) {
    const found = groups.find((group) => group.key === groupDef.id);
    settings[groupDef.id] = found
      ? { admin_access: found.admin_access, capabilities: { ...found.capabilities } }
      : { admin_access: DEFAULT_PERMISSIONS[groupDef.id].admin_access, capabilities: { ...DEFAULT_PERMISSIONS[groupDef.id].capabilities } };
  }
  return settings;
}

/** 某一组在给定访客模式下的能力判断。 */
export function permissionGroupCan(
  group: PermissionGroupConfig | undefined,
  capability: CapabilityId,
  ctx: Pick<PermissionContext, 'visibility'>,
): boolean {
  if (!group) return false;
  if (group.key === 'guest' && capability === 'read_content') {
    return ctx.visibility === 'public' && group.capabilities.read_content;
  }
  return group.capabilities[capability];
}

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

/**
 * 能力 → 名称。
 *
 * 不用一次性 reduce 生成快照：`CAPABILITY_DEFS` 里的 label 是读取时翻译的，
 * 这里也用 getter 转发，切到英文后权限矩阵会跟着变。
 */
export const CAPABILITY_LABEL: Record<CapabilityId, string> = CAPABILITY_DEFS.reduce(
  (acc, item) => {
    Object.defineProperty(acc, item.id, { enumerable: true, get: () => item.label });
    return acc;
  },
  {} as Record<CapabilityId, string>,
);
