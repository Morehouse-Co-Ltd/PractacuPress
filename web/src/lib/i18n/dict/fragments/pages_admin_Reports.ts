import type { Dictionary } from '../../plural';

/** 来源：`web/src/pages/admin/Reports.tsx` */
const fragment: Dictionary = {
  '举报队列': 'Report queue',
  '举报队列加载失败。': 'Could not load the report queue.',
  '正在载入举报': 'Loading reports',
  '暂无待处理举报': 'No reports waiting',
  '内容页上的“举报”按钮提交后会出现在这里。':
    'Reports filed with the “Report” button on a content page show up here.',
  '读者举报的内容与账户会进入这里。处理动作会写入审计日志并通知相关作者。':
    'Content and accounts reported by readers land here. Every decision is audited and notifies the affected author.',

  '目标': 'Target',
  '原因': 'Reason',
  '说明': 'Details',
  '举报人': 'Reporter',
  '认领': 'Claim',
  '忽略': 'Ignore',
  '下架': 'Take down',
  '封禁': 'Suspend',
  '已认领举报': 'Report claimed',
  '举报已处理': 'Report resolved',
  '举报已提交': 'Report submitted',
  '举报失败': 'Could not submit the report',
  '站长会尽快处理，感谢你的反馈。': 'The site owner will look into it. Thanks for the feedback.',

  '待处理': 'Open',
  '处理中': 'In progress',
  '已处理': 'Resolved',
  '已忽略': 'Dismissed',

  '忽略举报': 'Ignore report',
  '下架内容': 'Take down content',
  '封禁账户': 'Suspend account',
  '垃圾广告': 'Spam',
  '辱骂与骚扰': 'Abuse or harassment',
  '违法或侵权': 'Illegal or infringing',
  '其他': 'Other',

  '桌面演示模式把举报保存在浏览器；连接真实后端时使用':
    'Demo mode keeps reports in the browser; a real backend uses',
  '演示数据不会写回服务端。': 'Demo data is never written back to the server.',
  '处理结果会通知举报人和被处理的作者，且无法在界面上撤销。':
    'The outcome notifies the reporter and the affected author and cannot be undone from this screen.',
  '处理备注': 'Decision note',
  '可选：记录判断依据，写入审计日志。':
    'Optional: record the reasoning; it is written to the audit log.',
};

export default fragment;
