import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/admin/Permissions.tsx` */
const fragment: Dictionary = {
  '用户组': 'Groups',
  '管理员': 'Administrator',
  '用户管理': 'Users',
  '恢复默认': 'Restore defaults',
  '能力矩阵': 'Capability matrix',
  '能力': 'Capability',
  '分组说明': 'What each group means',
  '进入管理后台': 'Dashboard access',
  '切换后台入口': 'Toggle dashboard access',
  '改动立即生效': 'Changes apply immediately',
  '个人博客固定全开': 'Always fully enabled on a personal blog',
  '新增能力组': 'Add capability group',
  '创建能力组': 'Create capability group',
  '能力组名称': 'Capability group name',
  '例如：审稿人': 'For example: Reviewer',
  '组标识': 'Group key',
  '基础角色': 'Base role',
  '创建后仍可在矩阵里调整': 'Can still be adjusted in the matrix after creation',
  '基础角色不支持这项能力': 'The base role does not support this capability',
  '能力组已创建': 'Capability group created',
  '能力组保存失败': 'Could not save the capability group',
  '保存名称': 'Save name',
  '取消重命名': 'Cancel rename',
  '取消': 'Cancel',
  '无账户': 'No account',

  '请稍后重试，页面不会丢失当前查看位置。':
    'Try again later; the page keeps your current position.',
  '个人博客固定全开。': 'Always fully enabled on a personal blog.',
  '游客能否阅读由「站点设置 → 访客模式」决定。':
    'Whether guests can read is decided by “Site settings → Visitor mode”.',
  '游客没有账户，只能阅读公开内容。': 'Guests have no account and can only read public content.',
  '最高管理员固定拥有全部权限，避免把自己锁在门外。':
    'Super admins always keep every capability, so you cannot lock yourself out.',
  '只有内置组可以配置权限组；自定义组不能持有这项能力。':
    'Only built-in groups can configure permission groups; a custom group cannot hold this capability.',
  '这项能力超出该组基础角色的上限。':
    'This capability is above the ceiling of the group’s base role.',
  '游客没有账户，无法登录。': 'Guests have no account and cannot sign in.',
  '先在矩阵里开启至少一项后台能力。':
    'Enable at least one dashboard capability in the matrix first.',
  '最高管理员始终可以进入后台。': 'Super admins can always open the dashboard.',
  '请填写能力组名称。': 'Enter a name for the capability group.',
  '组标识必须以小写字母开头，只含小写字母、数字、连字符或下划线。':
    'The group key must start with a lowercase letter and contain only lowercase letters, digits, hyphens or underscores.',
  '这个组标识已经存在。': 'That group key already exists.',
  '权限已恢复默认': 'Permissions restored to defaults',
  '当前站点形态：{kind}。': 'Current site type: {kind}.',
  '能力矩阵由服务端保存并强制校验；改名与勾选都在原地生效。':
    'The capability matrix is stored and enforced by the server; renaming and toggling take effect in place.',
  '个人博客：所有账户都是最高管理员': 'Personal blog: every account is a super admin',
  '个人博客不区分用户组。站长在「用户管理」里创建的账户都可以登录后台，并拥有下面':
    'A personal blog has no groups. Every account the site owner creates in “Users” can sign in to the dashboard and has the',
  '「最高管理员」的全部能力。切回社区站点后，这份能力矩阵会重新生效，账户与文章都会保留。':
    'full abilities of “Super admin”. After switching back to a community site this matrix applies again, and accounts and articles are kept.',
  '用户组是角色之上的表达层': 'Groups are a layer above roles',
  '服务端有四级固定角色（成员 / 编辑 / 站点管理员 / 平台管理员）。内置组把角色映射成更容易理解的名称，':
    'The server has four fixed roles (member / editor / site admin / platform admin). Built-in groups map those roles to easier names,',
  '自定义组在同一角色之上收窄能力；保存后服务端立即按新矩阵放行或拒绝请求，不需要刷新页面。':
    'custom groups narrow capabilities on top of the same role, and the server allows or refuses requests by the new matrix immediately, with no page refresh.',
  '点按单元格切换。当前账户落在「{group}」组。':
    'Tap a cell to toggle it. This account is in the “{group}” group.',
  '重命名 {group}': 'Rename {group}',
  '自定义 · {role}': 'Custom · {role}',
  '关闭 {group}的「{capability}」': 'Turn off “{capability}” for {group}',
  '开启 {group}的「{capability}」': 'Turn on “{capability}” for {group}',
  '关闭后该组只能在站点前台活动；开启后仍需至少一项后台能力。':
    'When off, this group can only use the public site; when on, the group still needs at least one dashboard capability.',
  '{group} 进入管理后台': '{group}: dashboard access',
  '内置组，角色固定为{role}。': 'Built-in group; the role is always {role}.',
  '未登录访客，只能阅读公开内容。': 'Signed-out visitors; they can only read public content.',
  '自定义能力组，基础角色为{role}。': 'Custom capability group with the base role {role}.',
  ' · 对应角色 {role}': ' · Server role: {role}',
  '服务端授权边界': 'Server-side authorization boundaries',
  '组名可以改，角色映射与授权边界不能改。':
    'The label can change; the role mapping and authorization boundaries cannot.',
  '哪些能力只允许内置组持有': 'Which capabilities only built-in groups may hold',
  '「配置权限组」只属于内置组；自定义组最多映射到站点管理员，且能力必须是基础角色的子集。':
    '“Configure permission groups” belongs to built-in groups only; a custom group maps at most to site admin, and its capabilities must be a subset of the base role.',
  '最高管理员固定全开，游客只读，避免把站点锁在门外。':
    'The owner group is always fully enabled and guests are read-only, so the site cannot be locked out.',
  '保存后服务端立即按新矩阵校验：关闭「管理成员」后，该组成员调用成员接口会被拒绝，':
    'The server checks the new matrix immediately: with “Manage members” off, a member of that group is refused by the member API,',
  '即使页面仍然开着也一样。改名只影响显示名称，成员与授权不会移动。':
    'even if the page is still open. Renaming only changes the label; members and authorization do not move.',
  '在现有角色之上新增一个更窄的能力组；创建后会立即出现在矩阵里。':
    'Add a narrower capability group on top of an existing role; it appears in the matrix immediately.',
  '用于接口与成员绑定，创建后不可修改。':
    'Used by the API and member assignment; it cannot be changed after creation.',
  '组的能力只能是这个服务端角色的子集。':
    'The group’s capabilities must be a subset of this server role.',
  '恢复默认权限？': 'Restore default permissions?',
  '能力矩阵会回到出厂设置，用户组、账户与内容都不受影响。':
    'The capability matrix returns to factory settings; groups, accounts, and content are unaffected.',
  '默认值：游客只读；成员可以评论与投稿；审核员处理内容与评论；管理员管理成员与站点；':
    'Defaults: guests can only read; members comment and submit; reviewers handle content and comments; admins manage members and the site;',
  '最高管理员拥有全部能力。自定义组会保留，但名称与矩阵需要你自行调整。':
    'super admins have every capability. Custom groups are kept, but you should review their names and matrices.',
};

export default fragment;
