import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/admin/Permissions.tsx` */
const fragment: Dictionary = {
  用户组: 'Groups',
  管理员: 'Administrator',
  用户管理: 'Users',
  恢复默认: 'Restore defaults',
  能力矩阵: 'Capability matrix',
  能力: 'Capability',
  分组说明: 'What each group means',
  用户组映射: 'Group mapping',
  进入管理后台: 'Dashboard access',
  切换后台入口: 'Toggle dashboard access',
  改动立即生效: 'Changes apply immediately',
  个人博客固定全开: 'Always fully enabled on a personal blog',
  '游客能否阅读由「站点设置 → 访客模式」决定。':
    'Whether guests can read is decided by “Site settings → Visitor mode”.',
  '游客没有账户，只能阅读公开内容。': 'Guests have no account and can only read public content.',
  '最高管理员固定拥有全部权限，避免把自己锁在门外。':
    'Super admins always keep every capability, so you cannot lock yourself out.',
  '只有管理员与最高管理员可以配置权限组。':
    'Only admins and super admins can configure permission groups.',
  '当前站点形态：{kind}。': 'Current site type: {kind}.',
  '能力矩阵决定前台按钮与后台入口，':
    'The capability matrix decides which buttons and dashboard entry points appear,',
  '服务端仍按固定用户组强制校验。':
    'and the server still enforces permissions by the fixed groups.',
  '个人博客：所有账户都是最高管理员': 'Personal blog: every account is a super admin',
  '个人博客不区分用户组。站长在「用户管理」里创建的账户都可以登录后台，并拥有下面':
    'A personal blog has no groups. Every account the site owner creates in “Users” can sign in to the dashboard and has the',
  '「最高管理员」的全部能力。切回社区站点后，这份能力矩阵会重新生效，账户与文章都会保留。':
    'full abilities of “Super admin”. After switching back to a community site this matrix applies again, and accounts and articles are kept.',
  '用户组是角色之上的表达层': 'Groups are a layer above roles',
  '服务端仍然只有四级固定角色（成员 / 编辑 / 站点管理员 / 平台管理员），下面的用户组把角色映射成':
    'The server still has only four fixed roles (member / editor / site admin / platform admin); the groups below map those roles to',
  '更容易理解的名称，并允许你逐项关闭前台与后台入口。关闭某项能力不会删除数据。':
    'names that are easier to understand, and let you switch individual site and dashboard entry points off. Turning a capability off never deletes data.',
  '点按单元格切换。当前账户落在「{group}」组。':
    'Tap a cell to toggle it. This account is in the “{group}” group.',
  '关闭 {group}的「{capability}」': 'Turn off “{capability}” for {group}',
  '开启 {group}的「{capability}」': 'Turn on “{capability}” for {group}',
  '关闭后该组只能在站点前台活动。': 'When off, this group can only use the public site.',
  '游客没有账户，无法登录。': 'Guests have no account and cannot sign in.',
  '最高管理员始终可以进入后台。': 'Super admins can always open the dashboard.',
  '{group} 进入管理后台': '{group}: dashboard access',
  '从游客到最高管理员，五组覆盖前台的每一种身份。':
    'From guest to super admin, the five groups cover every identity on the public site.',
  ' · 对应角色 {role}': ' · Server role: {role}',
  '把用户组改成对应的服务端角色，权限就会跟着能力矩阵走。':
    'Point a group at the matching server role and permissions follow the capability matrix.',
  '前端策略与服务端授权': 'Interface policy and server-side authorization',
  '能力矩阵保存在本地安装配置，只在界面层生效。连接真实后端时，审核、改角色与删评论仍由服务端按角色授权；':
    'The capability matrix is stored in the local install configuration and only affects the interface. With a real backend, review, role changes, and comment deletion are still authorized by role on the server;',
  '关闭这里的「审核内容」不会撤销服务端编辑权限。':
    'turning “Review content” off here does not revoke editor rights on the server.',
  '用户组映射：成员 → 成员，编辑 → 审核员，站点管理员 → 管理员，平台管理员 → 最高管理员。':
    'Group mapping: member → member, editor → reviewer, site admin → admin, platform admin → super admin.',
  '用户组在「用户管理」页调整。': 'Groups are changed on the “Users” page.',
  '恢复默认权限？': 'Restore default permissions?',
  '能力矩阵会回到出厂设置，用户组、账户与内容都不受影响。':
    'The capability matrix returns to factory settings; groups, accounts, and content are unaffected.',
  '权限已恢复默认': 'Permissions restored to defaults',
  '默认值：游客只读；成员可以评论与投稿；审核员处理内容与评论；管理员管理成员与站点；':
    'Defaults: guests can only read; members comment and submit; reviewers handle content and comments; admins manage members and the site;',
  '最高管理员拥有全部能力。': 'super admins have every capability.',
};

export default fragment;
