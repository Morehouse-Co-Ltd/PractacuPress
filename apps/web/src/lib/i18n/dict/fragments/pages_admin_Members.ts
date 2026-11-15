import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/admin/Members.tsx` */
const fragment: Dictionary = {
  '媒体额度（MB）': 'Media quota (MB)',
  '媒体额度单位为 MB（1 MB = 1024 × 1024 字节）；留空继承部署默认，0 表示无限。':
    'Media quota is set in MB (1 MB = 1024 × 1024 bytes); leave it blank to inherit the deployment default, or enter 0 for unlimited.',
  '{name} 的媒体额度（MB）': 'Media quota (MB) for {name}',
  '保存{name}的媒体额度': 'Save media quota for {name}',
  成员媒体额度已更新: 'Member media quota updated',
  无法更新成员媒体额度: 'Could not update member media quota',
  '修改成员媒体额度': 'Change member media quota',
  '媒体额度必须是非负整数或小数（MB），且不能超过可存储上限。':
    'Enter a non-negative whole number or decimal in MB, within the supported storage limit.',
  // ---- 页面标题与用户组说明 ----
  '用户管理': 'Users',
  '评论、投稿与互动': 'Comment, submit, and interact',
  '审核内容与评论': 'Review content and comments',
  '管理用户与站点设置': 'Manage users and site settings',
  '平台级全部权限': 'Full platform-wide permissions',
  '管理员': 'Administrator',
  '用户组': 'Groups',
  '用户': 'Users',
  '邮箱': 'Email',
  '用户 ID': 'User ID',
  '账户操作': 'Account actions',
  '全部用户': 'All users',
  '{name} 的用户组': 'Group for {name}',
  '原用户组 {role}': 'Previous group: {role}',
  '最高管理员': 'Super admin',
  '注册该站的账号，用户组固定': 'Registered this site; the group is fixed',
  '最高管理员（个人博客）': 'Super admin (personal blog)',
  '个人博客': 'Personal blog',
  '按用户组授权': 'Permissions by group',
  '邮箱登录': 'Sign in with email',
  '正常': 'Active',
  '邀请中': 'Invited',
  '已停用': 'Suspended',
  ' （你）': ' (you)',
  '。': '.',

  // ---- 用户组变更 ----
  '用户组已更新': 'Group updated',
  '{name} 现在在「{group}」组': '{name} is now in the “{group}” group',
  '自定义能力组会按矩阵立即生效，并写入操作日志。':
    'A custom capability group applies its matrix immediately and is written to the activity log.',
  '自定义能力组，基础角色为{role}。': 'Custom capability group with the base role {role}.',
  '当前后端不支持分配自定义能力组。':
    'This backend does not support assigning custom capability groups.',
  '当前后端不支持自定义能力组': 'This backend does not support custom capability groups',
  '用户组能做什么': 'What each group can do',
  '无法修改用户组': 'Could not change the group',
  '将 {name} 改为{role}？': 'Change {name} to {role}?',
  '确认变更': 'Confirm change',
  '变更立即生效，并写入操作日志。': 'The change takes effect immediately and is written to the activity log.',

  // ---- 新建用户 ----
  '新增用户': 'Add user',
  '用户已创建': 'User created',
  '{account} 现在可以登录；请通过安全渠道把初始密码交给对方。':
    '{account} can sign in now; share the initial password through a secure channel.',
  '创建失败。': 'Could not create the user.',
  '创建用户失败': 'Could not create the user',
  '请填写显示名称。': 'Enter a display name.',
  '请填写有效的邮箱地址。': 'Enter a valid email address.',
  '密码至少 12 位。': 'The password must be at least 12 characters.',
  '创建用户': 'Create user',
  '新用户': 'New user',
  '个人博客下新用户直接拥有最高权限，可以登录后台。':
    'On a personal blog a new user immediately has full permissions and can sign in to the dashboard.',
  '填写基本信息，并选择用户组。用户立即生效。':
    'Fill in the basics and choose a group. The user is active immediately.',
  '显示名称': 'Display name',
  '例如：周宛': 'For example: Wan Zhou',
  '登录账号，必须全站唯一。': 'The sign-in account; must be unique across the site.',
  '初始密码': 'Initial password',
  '至少 12 位。创建后请通过安全渠道交给对方。':
    'At least 12 characters. Share it through a secure channel after creating the user.',
  '例如：一句好记的长口令': 'For example: a long passphrase you can remember',
  '个人博客固定最高权限': 'Personal blogs always use full permissions',
  '不需要选择用户组；切回社区站点后，这个用户会以「管理员」身份继续使用。':
    'No group choice is needed; after switching back to a community site this user continues as an administrator.',
  '决定后台入口与可用能力': 'Determines dashboard access and available capabilities',

  // ---- 编辑账户资料 ----
  '编辑 {name}': 'Edit {name}',
  '编辑显示名称与邮箱': 'Edit display name and email',
  '账户资料已更新': 'Account details updated',
  '保存失败。': 'Save failed.',
  '无法保存账户资料': 'Could not save the account details',
  '显示名称不能为空。': 'The display name cannot be empty.',
  '平台管理员可以修改更低等级成员的显示名称与登录邮箱；变更会写入网站日志。':
    'Platform admins can change the display name and sign-in email of lower-ranked members; changes are written to the site log.',
  '登录邮箱': 'Sign-in email',
  '必须全站唯一；修改后对方下次用新邮箱登录。':
    'Must be unique across the site; the person signs in with the new email next time.',
  '当前用户组：{role} · 账户状态：{status}': 'Current group: {role} · Account status: {status}',

  // ---- 启用与删除 ----
  '账户已启用': 'Account enabled',
  '账户已停用': 'Account disabled',
  '{name} 可以重新登录。': '{name} can sign in again.',
  '{name} 将无法登录。': '{name} will no longer be able to sign in.',
  '无法修改账户状态': 'Could not change the account status',
  '账户已删除': 'Account deleted',
  '{name} 已从站点移除。': '{name} was removed from this site.',
  '无法删除账户': 'Could not delete the account',
  '删除 {name}？': 'Delete {name}?',
  '删除账户': 'Delete account',
  '账户会从站点移除，无法再登录；已发布的文章与评论保留。':
    'The account is removed from the site and can no longer sign in; published articles and comments are kept.',
  '这个操作会写入网站日志': 'This action is written to the site log',
  '删除后对方无法再登录本站；内容不会被删除，但账户资料与个人主页会消失。':
    'After deletion the person can no longer sign in here; content is not deleted, but the account details and profile disappear.',
  '如果只是想暂时阻止登录，请改用「禁用」。':
    'If you only want to block sign-in temporarily, use Disable instead.',

  // ---- 页面说明卡片 ----
  '个人博客下所有用户都能登录后台并拥有最高权限；用户组原样保留，切回社区站点后恢复。':
    'On a personal blog every user can sign in to the dashboard with full permissions; groups are kept as they are and restored when you switch back to a community site.',
  '按用户组管理成员。最高管理员的用户组固定，其余变更会写入操作日志，并立即影响服务端授权。':
    'Manage members by group. The super admin group is fixed; other changes are written to the activity log and affect server-side authorization immediately.',
  '个人博客：用户即管理员': 'Personal blog: every user is an admin',
  '站内自助注册已关闭。你创建的每个用户都能登录后台并拥有全部能力，不需要再分配用户组。':
    'Self sign-up is closed. Every user you create can sign in to the dashboard with all capabilities, so there is no need to assign groups.',
  '如果以后切回社区站点，这些用户会按保存的用户组重新分组，文章与评论保持不变。':
    'If you switch back to a community site later, these users return to their saved groups; articles and comments stay unchanged.',
  '查看用户组': 'View groups',
  '用户组边界': 'Group boundaries',
  '平台管理员管理站点与全局策略；站点管理员管理本站用户与规则；编辑 / 审核员处理内容审核；':
    'Platform admins manage sites and global policy; site admins manage users and rules on this site; editors review content;',
  '成员可以发布与互动。最高管理员固定为注册该站的账号，其他账户不能被提升为该用户组。逐项能力见':
    'members publish and interact. The super admin is always the account that registered the site; no other account can be promoted into that group. See the capability list in',
  '没有用户': 'No users',
  '创建用户或开放注册后，用户会出现在这里。': 'Users appear here once you create one or open sign-up.',
  '这个用户组里还没有用户。': 'This group has no users yet.',
  '正在载入用户': 'Loading users',
  '个人博客的用户规则': 'User rules on a personal blog',
  '四种用户组能做什么': 'What each of the four groups can do',
  '登录': 'Sign-in',
  '所有账户都能登录，前台不再提供注册入口。新账户由站长在上方创建。':
    'Every account can sign in, and the public site no longer offers sign-up. The site owner creates new accounts above.',
  '权限': 'Permissions',
  '统一按最高管理员处理：写稿、审核、评论管理、站点设置、外观与成员管理全部开放。':
    'Everyone is treated as a super admin: writing, review, comment moderation, site settings, appearance, and member management are all open.',
  '切回社区': 'Back to community',
  '角色记录仍然保留，切回后按成员 / 审核员 / 管理员重新生效。':
    'Role records are kept and apply again as member / editor / admin after switching back.',
  '新增与停用': 'Creation and suspension',
  '用户由站长创建，密码当面或通过安全渠道交付。':
    'The site owner creates users and hands over the password in person or through a secure channel.',
  '管理员可以直接创建用户，也可以让访客自助注册。':
    'Admins can create users directly, or let visitors sign up themselves.',
  '个人博客关闭自助注册后，创建用户是唯一入口。创建后对方用邮箱与初始密码登录，建议提醒对方尽快修改密码。':
    'With sign-up closed on a personal blog, creating a user is the only way in. The person then signs in with their email and initial password; remind them to change it soon.',
  '新访客通过注册成为普通成员；管理员也可以在「新增用户」里直接指定用户组，省去后续调整。':
    'New visitors become regular members by signing up; admins can also pick the group directly in Add user, which saves a later change.',
  '当前身份：{identity}。': 'Signed in as: {identity}.',
  '站点形态：{kind}。': 'Site type: {kind}.',
  '12–128 位，且至少包含两类字符（小写、大写、数字、符号），不能是常见弱口令。创建后请通过安全渠道交给对方。':
    '12–128 characters combining at least two of lowercase, uppercase, digits and symbols; common passwords are refused. Hand the initial password over through a safe channel.',
  '最高管理员固定为注册该站的账号；新增用户不能设为该用户组。':
    'The super admin is always the account that registered the site; a new user cannot be given that group.',
};

export default fragment;
