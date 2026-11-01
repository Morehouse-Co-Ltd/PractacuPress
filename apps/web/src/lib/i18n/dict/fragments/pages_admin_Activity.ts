import type { Dictionary } from '../../plural';

/** 来源：`apps/web/src/pages/admin/Activity.tsx` */
const fragment: Dictionary = {
  网站日志: 'Site log',
  '演示后端记录的站点操作与本浏览器登录记录。真实后端把审计写入 audit_logs，但 v0.1.0 没有对外查询端点。':
    'Site actions recorded by the demo backend plus sign-in records from this browser. The real backend writes audits to audit_logs, but v0.1.0 exposes no query endpoint.',
  '真实后端没有审计查询端点；这里记录的是本浏览器内执行的管理操作与登录。':
    'The real backend has no audit query endpoint; this records the admin actions and sign-ins performed in this browser.',
  '导出 CSV': 'Export CSV',
  '这不是服务端审计日志': 'This is not a server-side audit log',
  '设计文档要求所有管理操作、权限失败与安全事件写入 audit_logs，并在服务端保留。当前 OpenAPI 没有暴露审计查询接口，因此本页只能展示：演示数据的种子记录，或此浏览器执行操作时留下的本地记录。':
    'The design document requires every admin action, permission failure, and security event to be written to audit_logs and kept on the server. The current OpenAPI exposes no audit query endpoint, so this page can only show seeded demo records or the local records left by actions performed in this browser.',
  '它不能替代合规审计。': 'It cannot replace a compliance audit.',
  '搜索操作者、动作或对象': 'Search actor, action, or target',
  搜索操作日志: 'Search activity log',
  '{count} 条': { one: '1 entry', other: '{count} entries' },
  清空本地记录: 'Clear local records',
  正在载入操作日志: 'Loading activity log',
  还没有操作日志: 'No activity log yet',
  '发布内容、修改站点设置或调整用户组后，记录会出现在这里。':
    'Records appear here after you publish content, change site settings, or adjust user groups.',
  '记录保存在浏览器 localStorage，上限 120 条；清除浏览器数据会一并清空。服务端审计以数据库为准。':
    'Records are kept in this browser’s localStorage, up to 120 entries; clearing browser data clears them too. Server-side auditing is authoritative in the database.',
  '清空本地操作日志？': 'Clear the local activity log?',
  '只会删除这个浏览器里的记录，不影响服务端数据。':
    'Only the records in this browser are deleted; server data is not affected.',
  清空: 'Clear',
  '已导出 CSV': 'CSV exported',
  本地记录已清空: 'Local records cleared',
};

export default fragment;
