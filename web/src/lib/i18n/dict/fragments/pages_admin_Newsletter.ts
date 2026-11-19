import type { Dictionary } from '../../plural';

/** 来源：`web/src/pages/admin/Newsletter.tsx` */
const fragment: Dictionary = {
  // ---- 页面标题与分区 ----
  '邮件订阅': 'Newsletter',
  '管理订阅名单、确认与退订邮件模板、发送记录，并向已确认订阅者发送刊物。':
    'Manage subscribers, confirmation and unsubscribe templates, the delivery log, and send newsletters to confirmed subscribers.',
  '刷新': 'Refresh',
  '邮件订阅的工作方式': 'How newsletter delivery works',
  '读者提交邮箱后会收到一封确认邮件，只有点过确认链接的地址才算「已确认」，也才会收到刊物。':
    'Readers get a confirmation email after signing up. Only addresses that clicked the confirmation link count as confirmed, and only those receive newsletters.',
  '订阅名单': 'Subscribers',
  '邮件模板': 'Templates',
  '发送日志': 'Delivery log',
  '发送': 'Send',
  '站点管理员权限': 'Site administrator permission',

  // ---- 统计卡 ----
  '已确认订阅': 'Confirmed',
  '会收到刊物': 'Receives newsletters',
  '待确认': 'Pending',
  '等待点确认链接': 'Waiting for the confirmation click',
  '已退订': 'Unsubscribed',
  '不再接收邮件': 'No longer receives email',
  '近 7 天发送': 'Sent in 7 days',
  '失败 {count} 封': '{count} failed',
  '无法读取订阅统计': 'Could not load subscriber statistics',
  '读取失败，请重试。': 'Could not load; please try again.',
  '重试': 'Retry',

  // ---- 名单筛选与表格 ----
  '订阅状态': 'Subscription status',
  '全部状态': 'All statuses',
  '搜索邮箱，回车确认': 'Search by email, press Enter',
  '搜索订阅者邮箱': 'Search subscriber emails',
  '清除搜索': 'Clear search',
  '共 {count} 位订阅者': { one: '1 subscriber', other: '{count} subscribers' },
  '无法读取订阅名单': 'Could not load the subscriber list',
  '没有匹配的订阅者': 'No matching subscribers',
  '换一个关键词或筛选条件，或清除筛选。': 'Try another keyword or filter, or clear them.',
  '还没有订阅者': 'No subscribers yet',
  '读者在页脚或登录页订阅后，邮箱会出现在这里。':
    'Emails show up here after readers subscribe from the footer or the sign-in page.',
  '邮箱': 'Email',
  '状态': 'Status',
  '来源': 'Source',
  '确认时间': 'Confirmed at',
  '最近发送': 'Last sent',
  '操作': 'Actions',
  '删除订阅者': 'Remove subscriber',
  '加载更多': 'Load more',
  '加载更多订阅者失败': 'Could not load more subscribers',
  '订阅者已删除': 'Subscriber removed',
  '无法删除订阅者': 'Could not remove the subscriber',
  '删除订阅者 {email}？': 'Remove {email}?',
  '删除后这个邮箱不会出现在名单里，也不会再收到刊物；对方之后可以重新订阅。':
    'The address disappears from the list and stops receiving newsletters; it can subscribe again later.',
  '这个操作无法撤销': 'This cannot be undone',
  '如果只是想暂停发信，可以把状态筛选到「已退订」查看对方是否自己退订了。':
    'To pause sending only, filter the status by "Unsubscribed" to see who opted out themselves.',
  '站点表单': 'Site form',
  '登录账户': 'Signed-in account',
  '投递失败': 'Delivery failed',
  '已确认': 'Confirmed',

  // ---- 模板 ----
  '无法读取邮件模板': 'Could not load email templates',
  '还没有邮件模板': 'No email templates yet',
  '服务端会提供内置模板；如果这里为空，请先确认后端版本。':
    'Templates come from the server; if this list is empty, check the backend version first.',
  '内置': 'Built-in',
  '模板已停用': 'Template disabled',
  '上次修改：{time}': 'Last edited: {time}',
  '编辑模板': 'Edit template',
  '编辑模板：{name}': 'Edit template: {name}',
  '支持的占位符由模板决定，例如 {link}、{title}、{url}；请保留原样。':
    'Supported placeholders depend on the template, for example {link}, {title} and {url}; keep them as they are.',
  '模板名称': 'Template name',
  '可以包含占位符，例如「新文章：{title}」。':
    'May contain placeholders, for example "New article: {title}".',
  'HTML 正文': 'HTML body',
  '纯文本正文': 'Plain-text body',
  '纯文本用于不支持 HTML 的邮件客户端。':
    'Plain text is used by mail clients that cannot render HTML.',
  '纯文本用于不支持 HTML 的邮件客户端；留空时由 HTML 自动生成。':
    'Plain text is for mail clients that cannot render HTML; leave it empty to derive it from the HTML.',
  '启用这个模板': 'Enable this template',
  '停用后服务端不会用它发信，但模板内容会保留。':
    'When disabled the server stops sending with it, but the content is kept.',
  '恢复默认': 'Restore defaults',
  '恢复内置默认？': 'Restore the built-in default?',
  '当前保存的主题与正文会被丢弃，无法撤销。':
    'The saved subject and body will be discarded, and this cannot be undone.',
  '确认恢复默认': 'Restore the default',
  '保存模板': 'Save template',
  '模板已保存': 'Template saved',
  '已恢复内置默认模板': 'Built-in default restored',
  '主题不能为空。': 'The subject cannot be empty.',
  '保存失败。': 'Save failed.',
  '恢复默认失败。': 'Could not restore the default.',
  '取消': 'Cancel',

  // ---- 发送日志 ----
  '发送状态': 'Delivery status',
  '全部发送状态': 'All delivery statuses',
  '邮件类型': 'Email kind',
  '全部邮件类型': 'All email kinds',
  '第 {page} 页': 'Page {page}',
  '排队中': 'Queued',
  '已发送': 'Sent',
  '未送达': 'Not delivered',
  '已跳过': 'Skipped',
  '刊物': 'Newsletter',
  '订阅确认': 'Subscription confirmation',
  '欢迎邮件': 'Welcome email',
  '重置密码': 'Reset password',
  '验证邮件': 'Verification email',
  '无法读取发送日志': 'Could not load the delivery log',
  '还没有发送记录': 'No delivery records yet',
  '确认邮件、刊物与找回密码邮件发出后都会留下记录。':
    'Confirmation, newsletter and password-reset emails are recorded here once they are sent.',
  '收件人': 'Recipient',
  '类型': 'Type',
  '错误': 'Error',
  '时间': 'Time',
  '上一页': 'Previous',
  '下一页': 'Next',

  // ---- 发送 ----
  '发送前请确认': 'Check before sending',
  '刊物只发给「已确认」的订阅者；未配置 SMTP 时，入队的邮件不会真正发出，会在发送日志里被记为 skipped。':
    'Newsletters only go to confirmed subscribers. Without SMTP configured, queued emails are not really sent and are logged as skipped.',
  '配置 SMTP': 'Configure SMTP',
  '邮件主题': 'Email subject',
  '例如：本周新文章': 'For example: New articles this week',
  '可以用富文本编辑器写好后粘贴 HTML；留空时只发纯文本。':
    'Write in the rich-text editor first and paste the HTML here; leave it empty to send plain text only.',
  '关联内容 ID（可选）': 'Linked content ID (optional)',
  '填写内容 ID 后，服务端会把该内容渲染进邮件模板。':
    'When set, the server renders that content into the email template.',
  '预计触达 {count} 封（已确认订阅者）':
    'Estimated reach: {count} emails (confirmed subscribers)',
  '发送刊物': 'Send newsletter',
  '发送前会再确认一次。': 'You will be asked to confirm once more before sending.',
  '请填写邮件主题。': 'Please enter an email subject.',
  '请填写正文（HTML 或纯文本至少一项）。':
    'Please add a body: at least one of HTML or plain text.',
  '已入队 {count} 封': { one: 'Queued 1 email', other: 'Queued {count} emails' },
  '无法发送刊物': 'Could not send the newsletter',
  '发送失败。': 'Sending failed.',
  '确认发送这封刊物？': 'Send this newsletter?',
  '确认发送': 'Send now',
  '发送后无法撤回；每一封的入队记录都会出现在「发送日志」里。':
    'Sending cannot be undone; every queued email is recorded in the delivery log.',
  '邮件主题：{subject}': 'Email subject: {subject}',
};

export default fragment;
