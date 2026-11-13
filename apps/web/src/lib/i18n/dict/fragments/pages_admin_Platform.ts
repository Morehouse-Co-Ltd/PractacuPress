import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/admin/Platform.tsx` 与后台导航中的平台入口。 */
const fragment: Dictionary = {
  // ---- 平台站点列表 ----
  '站点平台': 'Site platform',
  '管理部署内的所有站点：新建、查看状态、进入某个站点的管理后台。':
    'Manage every site in this deployment: create one, inspect its state, or enter a site’s admin area.',
  '新建站点': 'New site',
  '返回站点列表': 'Back to site list',
  '演示模式只运行一个站点，无法新建或跨站进入；连接真实后端后可用。':
    'Demo mode runs a single site, so creating or entering another site is unavailable; connect a real backend to use it.',
  '加载站点失败': 'Could not load sites',
  '部署站点': 'Deployed sites',
  '按创建时间排序': 'Sorted by creation time',
  '成员总数': 'Total members',
  '含暂停的成员': 'Suspended members included',
  '管理员总数': 'Total administrators',
  '可进入后台的账户': 'Accounts that can open the admin area',
  '全部站点': 'All sites',
  '平台管理员可以查看每个站点的域名验证状态、可见性与成员规模。':
    'Platform administrators can review each site’s domain verification, visibility and member count.',
  '还没有站点': 'No sites yet',
  '新建站点后，它会立即出现在这里，并带有默认站点设计与第一位管理员。':
    'A new site appears here immediately with a default design and its first administrator.',
  '可见性': 'Visibility',
  '创建时间': 'Created',
  '进入管理': 'Enter admin',
  '正在进入…': 'Entering…',
  '返回本站后台': 'Back to this site’s admin',
  '未绑定域名': 'No domain',
  '待验证': 'Pending verification',
  '已验证': 'Verified',
  '公开浏览': 'Public',
  '仅成员': 'Members only',
  '开放发布': 'Open publishing',
  '审核发布': 'Review before publishing',
  '按角色发布': 'Role based publishing',

  // ---- 进入站点的原因 ----
  '目标站点还没有绑定主域名。': 'The target site has no primary domain yet.',
  '目标站点的主域名尚未通过验证，请先完成 TXT 验证。':
    'The target site’s primary domain has not passed verification; finish the TXT check first.',
  '目标站点已停用。': 'The target site is disabled.',
  '目标站点暂时无法进入。': 'The target site cannot be entered right now.',

  // ---- 新建站点 ----
  '站点创建后会生成默认站点设计，并创建第一位站点管理员。':
    'Creating a site initialises a default design and the first site administrator.',
  '站点信息': 'Site information',
  '名称与标识创建后仍可在站点设置里修改；主域名需要完成 TXT 归属验证。':
    'The name and slug stay editable in site settings; the primary domain needs the TXT ownership check.',
  '站点名称': 'Site name',
  '例如：产品周刊': 'For example: Product Weekly',
  '站点标识（slug）': 'Site slug',
  '只允许小写字母、数字与连字符，用于 URL 与内部识别。':
    'Lowercase letters, digits and hyphens only; used in URLs and internal identifiers.',
  '站点简介': 'Site description',
  '可留空，之后也能在站点设置里补充。': 'Optional; you can add it later in site settings.',
  '主域名': 'Primary domain',
  '必填。创建后需发布 DNS TXT 记录完成归属验证，验证前该域名不会提供站点。':
    'Required. After creation you publish a DNS TXT record to prove ownership; the hostname serves nothing until then.',
  '站点可见性': 'Site visibility',
  '公开：访客可以浏览': 'Public: anyone can browse',
  '仅成员：登录后可见': 'Members only: visible after signing in',
  '发布模式': 'Publishing mode',
  '初始管理员': 'Initial administrator',
  '这是新站点的第一位站点管理员，拥有该站点的全部管理权限。':
    'This is the first site administrator, with full control of the new site.',
  '管理员邮箱': 'Administrator email',
  '管理员显示名': 'Administrator display name',
  '初始密码': 'Initial password',
  '至少 8 位，并包含至少两类字符。请通过安全渠道交给该管理员。':
    'At least 8 characters with two character classes. Deliver it to the administrator over a secure channel.',
  '正在创建…': 'Creating…',
  '创建站点': 'Create site',
  '站点已创建，默认设计已初始化。': 'Site created and its default design initialised.',
  '请填写站点名称。': 'Enter a site name.',
  '站点标识只能包含小写字母、数字与连字符。': 'The slug may contain lowercase letters, digits and hyphens only.',
  '请填写主域名，例如 press.example.com。': 'Enter the primary domain, for example press.example.com.',
  '请填写初始管理员邮箱。': 'Enter the initial administrator email.',
  '请填写初始管理员显示名。': 'Enter the initial administrator display name.',
  '请填写初始管理员密码。': 'Enter the initial administrator password.',
  '请先为当前站点配置并验证主域名，再创建其他站点，否则当前站点会失去访问入口。':
    'Configure and verify a primary domain for this site before creating another one; otherwise this site loses its entry point.',

  // ---- 站点详情 ----
  '站点详情': 'Site details',
  '站点不存在，或你无权查看。': 'The site does not exist, or you cannot view it.',
  '无法进入': 'Cannot enter',
  '该站点尚未绑定主域名，暂时无法进入。':
    'This site has no primary domain yet, so it cannot be entered.',
  '主域名尚未验证': 'Primary domain not verified yet',
  '主域名归属验证': 'Domain ownership verification',
  '请把下面的 TXT 记录添加到域名 DNS，然后点击「立即验证」。':
    'Add the TXT record below to the domain’s DNS, then click Verify now.',
  '记录类型': 'Record type',
  '记录名': 'Record name',
  '记录值': 'Record value',
  '立即验证': 'Verify now',
  '正在验证…': 'Verifying…',
  '主域名已验证，可以进入该站点的管理后台。':
    'The primary domain is verified; you can enter the site’s admin area.',
  '请在目标站点的「站点设置 → 访问与域名」完成 TXT 验证后再进入。':
    'Complete the TXT verification under Site settings → Access and domain on the target site, then enter.',
  '成员数': 'Members',
  '管理员数': 'Administrators',
  '站点状态': 'Site status',
  '已停用': 'Disabled',
  '运行中': 'Running',
  '来自平台接口的只读快照；修改站点设置请先进入该站点。':
    'A read-only snapshot from the platform API; enter the site to change its settings.',
  '标识': 'Slug',
  '最后更新': 'Last updated',
  '当前账户角色': 'Your role',
  '平台管理员': 'Platform administrator',
  '站点管理员': 'Site administrator',
};

export default fragment;
