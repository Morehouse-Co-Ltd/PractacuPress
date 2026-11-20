/**
 * 网站日志的动作码 → 人话动作名。
 *
 * audit_logs.action 是给服务端用的点分标识（`auth.login` 之类），直接印在后台
 * 表格与筛选器里对站长毫无意义。这里只做中文动词短语的映射：日志行已经单独展示
 * 操作人，所以文案里不再重复主语（例如「管理员 · 登录账户」而不是「管理员 · 管理员登录」）。
 *
 * 英文由 i18n 片段（`dict/fragments/pages_admin_Activity.ts`）按这些中文键翻译。
 * 新增后端动作码时，在这里补一条并同步英文片段；没有收录的动作码会走可读兜底，
 * 不会让界面出现空白。
 */
export const ACTION_LABELS: Record<string, string> = {
  'auth.registered': '注册账户',
  'auth.login': '登录账户',
  'auth.logout': '退出账户',
  'auth.password_changed': '更改账户密码',
  'auth.profile_updated': '更新个人资料',
  'auth.email_verification_requested': '请求验证邮箱',
  'auth.email_verified': '完成邮箱验证',
  'content.created': '起草新内容',
  'content.updated': '更新内容',
  'content.submitted': '提交审核',
  'content.published': '发布内容',
  'content.rejected': '退回内容',
  'content.archived': '归档内容',
  'content.restored': '恢复内容',
  'content.rollback': '回滚版本',
  'site.settings.updated': '修改站点设置',
  'site.domain.updated': '更新主域名',
  'site.domain.verified': '验证主域名',
  'site.customization.updated': '修改外观设置',
  'site.member.created': '添加成员',
  'site.member.role_changed': '调整成员角色',
  'site.member.profile_updated': '更新成员资料',
  'site.member.status_changed': '更改成员状态',
  'site.member.media_quota_updated': '调整成员媒体额度',
  'site.member.removed': '移除站点成员',
  'site.member.group_changed': '更改成员用户组',
  'site.permission_group.saved': '保存权限组',
  'community.comment.created': '发布评论',
  'community.comment.edited': '编辑评论',
  'community.comment.moderated': '审核评论',
  'community.comment.deleted': '移除评论',
  'moderation.report.created': '发起举报',
  'moderation.report.assigned': '指派举报',
  'moderation.report.resolved': '处理举报',
  'moderation.report.ignored': '忽略这条举报',
  'moderation.report.takedown': '下架被举报内容',
  'moderation.report.ban': '封禁被举报账户',
  'platform.site.created': '创建新站点',
  'platform.site.entered': '进入站点',
  // Beta 1.2：平台管理员在储存页应用了新策略。
  'system.storage.updated': '修改储存策略',
  // 演示模式的上传动作（真实后端暂未写入这条审计码）。
  'media.uploaded': '上传媒体',
};

type Translate = (text: string) => string;

/**
 * 动作码 → 可读文案。
 *
 * 已知动作按映射翻译；未知动作把点号与下划线换成空格，至少给出可读的短语，
 * 而不是空字符串——旧数据或新后端动作码也不会让 Badge / 筛选器出现空白项。
 */
export function activityActionLabel(action: string, t: Translate): string {
  const label = ACTION_LABELS[action];
  if (label) return t(label);
  const readable = action
    .split('.')
    .map((part) => part.replace(/_/g, ' ').trim())
    .filter(Boolean)
    .join(' · ');
  return readable || action || '—';
}
