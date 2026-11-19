import type { Dictionary } from '../../plural';

/** 来源：`web/src/pages/admin/PlatformOps.tsx`（总览 / 跨站审计 / 平台用户）。 */
const fragment: Dictionary = {
  // ---- 总览 ----
  '平台总览': 'Platform overview',
  '整个部署的运行快照：站点状态、内容与账户规模、需要处理的信号以及最近的跨站活动。':
    'A whole-deployment snapshot: site state, content and account size, the signals that need work and the latest cross-site activity.',
  '活动窗口': 'Activity window',
  '最近 1 天': 'Last 1 day',
  '最近 7 天': 'Last 7 days',
  '最近 30 天': 'Last 30 days',
  '演示模式只有当前站点，跨站数字只反映这一个站点的演示数据；连接真实后端后可用。':
    'Demo mode has only the current site, so the cross-site numbers reflect one site; connect a real backend to use this.',
  '加载总览失败': 'Could not load the overview',
  '正在汇总部署数据': 'Aggregating deployment data',
  '站点': 'Site',
  '停用 {disabled} · 未验证域名 {unverified}':
    'Disabled {disabled} · unverified domains {unverified}',
  '账户': 'Accounts',
  '已验证 {verified} · 两步验证 {twoFactor}': 'Verified {verified} · two-factor {twoFactor}',
  '成员': 'Members',
  '活跃 {active} · 管理员 {admins}': 'Active {active} · admins {admins}',
  '内容': 'Content',
  '已发布 {published} · 待审 {pending}': 'Published {published} · pending {pending}',
  '需要关注': 'Needs attention',
  '每个信号都能在现有页面里处理掉；计数来自最近 {days} 天的窗口。':
    'Every signal is actionable on an existing screen; the counts cover the last {days} days.',
  '待处理举报': 'Open reports',
  '举报队列里仍待裁决的条目。': 'Reports still waiting for a decision.',
  '待审核评论': 'Pending comments',
  '被先审后发或敏感词拦下的评论。': 'Comments held back by pre-moderation or a sensitive word.',
  '窗口内失败动作': 'Failed actions in the window',
  '例如人机验证失败；窗口内写入的拒绝记录。':
    'For example failed human verification; refusals recorded inside the window.',
  '已停用站点': 'Disabled sites',
  '停用站点对访客不可见。': 'Disabled sites are invisible to visitors.',
  '未验证域名的站点': 'Sites with an unverified domain',
  '域名验证完成前无法通过主机名访问。':
    'The hostname serves nothing until the domain is verified.',
  '未验证邮箱的账户': 'Accounts with an unverified email',
  '这些账户无法通过邮件找回密码。': 'These accounts cannot recover a password by email.',
  '窗口内无活动的站点': 'Sites with no activity in the window',
  '运行中却没有任何审计记录，值得看一眼。': 'Running but without any audit row: worth a look.',
  '各站点快照': 'Per-site snapshot',
  '库存计数是当前总量；活动与失败数只统计窗口内的审计记录。':
    'Inventory counters are current totals; activity and failure counts cover audit rows inside the window only.',
  '还没有站点': 'No sites yet',
  '新建站点后，它会出现在这里。': 'A new site appears here.',
  '新建站点': 'New site',
  '状态': 'Status',
  '运行中': 'Running',
  '已停用': 'Disabled',
  '域名已验证': 'Domain verified',
  '域名待验证': 'Domain pending verification',
  '未绑定域名': 'No domain',
  '管理员': 'Admins',
  '待审 {count}': '{count} pending',
  '窗口内活动': 'Activity in window',
  '失败': 'Failure',
  '操作': 'Actions',
  '详情': 'Details',
  '最近的跨站活动': 'Recent cross-site activity',
  '窗口内最新的一批审计记录；完整检索请到「跨站审计」。':
    'The latest audit rows inside the window; use the cross-site audit page for the full search.',
  '打开跨站审计': 'Open cross-site audit',
  '窗口内没有活动': 'No activity inside the window',
  '把窗口放宽，或等待站点产生新的审计记录。':
    'Widen the window or wait for new audit rows.',
  '时间': 'Time',
  '操作人': 'Actor',
  '动作': 'Action',
  '目标': 'Target',
  '结果': 'Outcome',
  '系统': 'System',
  '成功': 'Success',
  '生成于 {time}，活动窗口自 {start} 起。总览只返回计数、状态与布尔值，不含任何密钥或令牌。':
    'Generated at {time}; the activity window starts at {start}. The overview returns counters, statuses and booleans only, never a secret or token.',

  // ---- 跨站审计 ----
  '跨站审计': 'Cross-site audit',
  '一次查询整个部署的审计记录：按站点、时间、操作人、动作、目标与结果筛选。':
    'Query the audit trail of the whole deployment by site, time, actor, action, target and outcome.',
  '导出 CSV': 'Export CSV',
  '刷新': 'Refresh',
  '演示模式只有当前站点，跨站审计里也只有这一个站点；连接真实后端后可用。':
    'Demo mode has only the current site, so the cross-site trail holds one site; connect a real backend to use this.',
  '这次读取本身会被审计': 'This read is itself audited',
  '每次跨站查询都会写入一条 platform.audit.queried 记录；写不进审计时查询会失败，不会留下未记录的披露。':
    'Every cross-site query writes a platform.audit.queried row; if that row cannot be written the query fails instead of leaving an unrecorded disclosure.',
  '全部站点': 'All sites',
  '时间范围': 'Time range',
  '最近 24 小时': 'Last 24 hours',
  '全部时间': 'All time',
  '全部动作': 'All actions',
  '全部目标': 'All targets',
  '全部结果': 'All outcomes',
  '{count} 条': { one: '1 record', other: '{count} records' },
  '操作人 ID': 'Actor ID',
  '目标 ID': 'Target ID',
  '目标类型': 'Target type',
  '应用筛选': 'Apply filters',
  '查询跨站审计失败': 'Cross-site audit query failed',
  '正在查询跨站审计': 'Querying the cross-site audit trail',
  '没有匹配的审计记录': 'No matching audit rows',
  '放宽时间窗口或清空筛选后再试。': 'Widen the time window or clear the filters and try again.',
  '加载更多': 'Load more',
  '加载更多失败': 'Could not load more',
  '已导出 CSV': 'CSV exported',
  '记录按时间倒序、游标分页；导出 CSV 只包含当前筛选已加载的记录。':
    'Rows are newest first and cursor paginated; the CSV export contains only the rows the current filter has loaded.',

  // ---- 平台用户 ----
  '平台用户': 'Platform users',
  '部署内的账户与站点成员概览：邮箱验证状态、两步验证开关与所属站点。只读。':
    'Accounts and site members across the deployment: email verification, the two-factor switch and site membership. Read only.',
  '演示模式只有当前站点与它的演示账户；连接真实后端后可用。':
    'Demo mode has only the current site and its demo accounts; connect a real backend to use this.',
  '只读目录': 'Read-only directory',
  '这里只用于查看：角色与状态变更仍在站点管理里完成。响应不会返回密码哈希、两步验证密钥或任何令牌。':
    'Read only: change roles and statuses in site administration. The response never carries a password hash, a two-factor secret or any token.',
  '全部账户': 'All accounts',
  '站点成员：{name}': 'Site members: {name}',
  '搜索显示名或邮箱': 'Search display name or email',
  '搜索': 'Search',
  '{count} 个账户': { one: '1 account', other: '{count} accounts' },
  '加载平台用户失败': 'Could not load platform users',
  '正在加载平台用户': 'Loading platform users',
  '没有匹配的账户': 'No matching accounts',
  '清空搜索词或换一个站点再看。': 'Clear the search term or try another site.',
  '邮箱': 'Email',
  '邮箱验证': 'Email verified',
  '两步验证': 'Two-factor',
  '已验证': 'Verified',
  '未验证': 'Unverified',
  '已开启': 'Enabled',
  '未开启': 'Off',
  '正常': 'Active',
  '创建时间': 'Created',
  '所属站点与角色': 'Sites and roles',
  '未加入任何站点': 'Not a member of any site',
  '查看站点详情': 'Open site details',
  '账户不带站点过滤时按创建时间倒序；选择站点后列出该站点的成员关系。导出 CSV 只包含已加载的行。':
    'Without a site filter accounts are newest first; with one the page lists that site’s memberships. The CSV export contains only the loaded rows.',
  '平台管理员': 'Platform administrator',
  '演示模式': 'Demo mode',
};

export default fragment;
