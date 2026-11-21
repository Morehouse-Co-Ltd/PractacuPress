/**
 * Practacu Press 前端类型。
 *
 * 全部来自 `packages/contracts/openapi/openapi.yaml`（v0.1.0）。
 * 带 `?` 的前端扩展字段只会在演示数据层出现；连接真实后端时按缺失处理，
 * 界面不得依赖它们完成权限或安全判断。
 */

import type { Locale } from './lib/i18n/locales';

export type Role = 'platform_admin' | 'site_admin' | 'editor' | 'member';
export type VisibilityMode = 'public' | 'members_only';
/**
 * 站点形态。
 * - community：访客可以自助注册，登录后评论、收藏与投稿；权限按权限组划分。
 * - personal：个人博客，关闭自助注册；站长可以在后台创建账户，所有账户都能进入后台。
 */
export type SiteKind = 'community' | 'personal';
export type PublishMode = 'open' | 'review' | 'role_based';
export type TargetType = 'article' | 'post' | 'comment' | 'user' | 'page';
export type ContentKind = 'article' | 'post';
export type SourceFormat = 'markdown' | 'html' | 'plain';
/** 内容级访问权限：公开 / 密码 / 仅登录（C-18）。 */
export type ContentAccessMode = 'public' | 'password' | 'members';
/** 单篇评论策略：跟随站点 / 开启 / 关闭 / 先审后发（C-19）。 */
export type ContentCommentPolicy = 'inherit' | 'open' | 'disabled' | 'review';
export type ContentStatus =
  | 'draft'
  | 'pending_review'
  | 'published'
  | 'rejected'
  | 'archived'
  | 'pending_security_check';
export type ContentAction =
  | 'submit'
  | 'publish'
  | 'reject'
  | 'archive'
  | 'restore'
  | 'security-retry'
  /** 回收站里的内容恢复为正常内容（Beta 1.2）。 */
  | 'undelete'
  /** 从回收站彻底删除，不可恢复（Beta 1.2）。 */
  | 'purge'
  /**
   * 撤销发布（Beta 1.2，契约 I 节）：published → draft，清空 `published_at`。
   * 需要发布权（作者或编辑及以上），返回内容本身。
   */
  | 'unpublish';
export type CommentStatus = 'visible' | 'hidden' | 'deleted' | 'pending_review';
export type ScanStatus = 'pending' | 'clean' | 'rejected' | 'needs_manual_review';
export type UploadStatus = 'pending' | 'uploaded' | 'completed' | 'expired';
/** Byte count from JSON; large int64 values stay decimal strings to preserve precision. */
export type MediaQuotaBytes = number | string | null;

export interface User {
  id: string;
  display_name: string;
  locale: string;
  status: 'active' | 'disabled';
  created_at: string;
  /** 账户自己的邮箱；公开资料不会返回。 */
  email?: string;
  /** 邮箱身份是否已经通过验证链接证明过归属。 */
  email_verified?: boolean;
  bio?: string;
  avatar_media_id?: string;
}

/** 自助资料编辑；省略的字段保持不变，空字符串清空简介 / 头像。 */
export interface ProfileInput {
  display_name?: string;
  bio?: string | null;
  avatar_media_id?: string | null;
}

/** 修改密码；必须重新提供当前密码。 */
export interface ChangePasswordInput {
  current_password: string;
  new_password: string;
  /** 用户已在弱密码弹窗中确认继续使用当前弱密码。 */
  confirm_weak_password?: boolean;
}

export interface Session {
  user: User;
  token_type: 'Bearer';
  access_token: string;
  access_expires_at: string;
  refresh_expires_at: string;
  csrf_token: string;
}

/**
 * Second step challenge (FSD F-04).
 *
 * A password login of an account with TOTP enabled returns this instead of a
 * Session: no access token is issued until the code (or a recovery code) is
 * redeemed. The token is short lived, single use and cannot be used as an access
 * token.
 */
export interface TwoFactorChallenge {
  two_factor_required: true;
  challenge_token: string;
  expires_in: number;
  expires_at: string;
}

/** What a password login can answer: a session, or the second step. */
export type PasswordLoginResult =
  | { status: 'session'; session: Session }
  | { status: 'two_factor_required'; challenge: TwoFactorChallenge };

/** The caller's own two-factor state. Secrets and codes are never included. */
export interface TwoFactorStatus {
  enabled: boolean;
  recovery_codes_remaining: number;
  confirmed_at?: string;
}

/** A started enrollment: the secret is shown once, as a QR payload and manually. */
export interface TwoFactorEnrollment {
  secret: string;
  otpauth_uri: string;
  qr_content: string;
  expires_in: number;
}

/** One-time recovery code set. Plaintext only exists in this response. */
export interface TwoFactorRecoveryCodes {
  recovery_codes: string[];
}

/* ---------- 高威胁操作二次验证（step-up） ---------- */

/**
 * 站点级的高威胁操作保护设置（`GET/PUT /sites/{siteID}/step-up`）。
 *
 * 服务端只返回 `password_set`，绝不返回专用密码或其哈希。
 */
export interface StepUpSettings {
  /** 保护总开关；关闭后受保护的路由直通。 */
  enabled: boolean;
  /** 是否设置了“专用安全密码”；false 时验证使用账户登录密码。 */
  password_set: boolean;
  /** 服务端允许的最长有效期（秒）；真正的范围是一次浏览器会话（sessionStorage）。 */
  window_seconds: number;
}

/** 保存保护设置：三个字段都是可选的补丁，而不是整份文档。 */
export interface StepUpSettingsUpdate {
  enabled?: boolean;
  /** 专用安全密码；留空同时也不选择清除时表示保持原值。 */
  password?: string;
  /** 清除专用密码，恢复为使用账户登录密码验证。 */
  clear_password?: boolean;
}

/** `POST /auth/step-up` 的响应：会话级令牌，请求受保护路由时放进 `X-PP-Step-Up`。 */
export interface StepUpVerifyResult {
  token: string;
  expires_in: number;
}

/* ---------- 短信登录（Beta 1.2，契约 A 节） ---------- */

/**
 * 短信登录是否可用（`GET /auth/phone/policy`，公开端点）。
 *
 * `enabled` 是服务端真正能发短信的判定（`SMS_PROVIDER` 不是 `off`），页面据此决定
 * 是否显示「短信验证码登录」入口；`registration_open` 决定不存在的手机号能否自动建号。
 */
export interface PhonePolicy {
  enabled: boolean;
  provider: 'off' | 'log' | 'http';
  registration_open: boolean;
}

/** 短信验证码的请求目的；登录与注册分开限流。 */
export type PhoneCodePurpose = 'login' | 'register';

/**
 * 请求短信验证码的结果（`POST /auth/phone/codes`，202）。
 *
 * `dev_code` 只在服务端开启 `SMS_DEV_MODE` 时出现（演示模式同样给出），生产环境永远没有。
 */
export interface PhoneCodeResult {
  expires_at: string;
  resend_after_seconds: number;
  dev_code?: string;
}

export interface Me {
  user: User;
  role: Role;
  site_id: string;
  /** 服务端分配的能力组；旧后端不返回时按角色映射。 */
  group_key?: string;
}

export interface Site {
  id: string;
  slug: string;
  name: string;
  domain: string;
  created_at?: string;
  visibility_mode: VisibilityMode;
  publish_mode: PublishMode;
  disabled: boolean;
  /** 设置接口接受 description，但 Site 响应未声明；连接真实后端时可能缺失。 */
  description?: string;
  /**
   * 站点是否开放自助注册（O-3）。
   *
   * 缺失时按开放处理：旧后端与升级前保存的配置都不带这个字段，误关注册比多显示
   * 一个注册入口代价大得多。
   */
  registration_open?: boolean;
  /** 站点级评论开关（服务端强制）；缺失按开启处理。 */
  comments_enabled?: boolean;
  /** 新评论是否进入待审核队列；缺失按直接发布处理。 */
  comments_require_review?: boolean;
  /** 站点媒体额度，null 表示继承部署默认。 */
  media_quota_bytes?: MediaQuotaBytes;
}

/* ---------- 平台站点控制台 ---------- */

/**
 * 平台控制台里的一个站点。
 *
 * 与前台 `Site` 的区别：这里是跨站点运维视角，带成员计数与创建时间，不包含评论、
 * 注册开关等单站点设置字段。字段来自 `GET /platform/sites`。
 */
export interface PlatformSite {
  id: string;
  slug: string;
  name: string;
  description: string;
  domain: string;
  domain_verified: boolean;
  visibility_mode: VisibilityMode;
  publish_mode: PublishMode;
  disabled: boolean;
  member_count: number;
  admin_count: number;
  created_at: string;
  updated_at: string;
}

/** 新站点的第一个管理员账户（始终是站点管理员）。 */
export interface CreateSiteOwnerInput {
  email: string;
  display_name: string;
  password: string;
  /** 用户已在弱密码弹窗中确认继续使用当前弱密码。 */
  confirm_weak_password?: boolean;
}

/** 新建站点。主域名必填，创建后仍需完成 TXT 归属验证。 */
export interface CreateSiteInput {
  name: string;
  slug: string;
  description?: string;
  domain: string;
  visibility_mode?: VisibilityMode;
  publish_mode?: PublishMode;
  owner: CreateSiteOwnerInput;
}

/** 建站结果：站点与它的第一个管理员。 */
export interface CreatedSite {
  site: PlatformSite;
  owner: {
    user_id: string;
    display_name: string;
    role: Role;
  };
}

/** 单站点详情：站点快照、调用者角色与主域名挑战状态。 */
export interface PlatformSiteDetail {
  site: PlatformSite;
  role: Role;
  /** 新建站点在域名验证前无法通过主机名访问，控制台在这里展示并兑换 TXT 挑战。 */
  domain_status: SiteDomainVerification;
}

/**
 * 「进入站点」的结果。
 *
 * `switchable` 为 false 时 `reason` 说明原因（domain_missing / domain_unverified /
 * site_disabled）；为 true 且目标不是本站时，`switch_token` 是投递给目标站点源的
 * 短期交接令牌，由目标源兑换成正常会话。
 */
export interface PlatformSiteEntry {
  site: PlatformSite;
  role: Role;
  switchable: boolean;
  reason?: string;
  switch_token?: string;
  expires_at?: string;
}

/* ---------- 平台总览 / 跨站审计 / 平台用户 ---------- */

/**
 * 部署级总览的合计列（`GET /platform/overview` 的 `totals`）。
 *
 * 库存类计数（站点、成员、内容、评论、账户）是「现在」的总量；只有每站的近期活动与
 * 故障计数受 `window_days` 影响。字段与后端 `overviewTotalsResponse` 一一对应。
 */
export interface PlatformOverviewTotals {
  sites: number;
  disabled_sites: number;
  unverified_sites: number;
  members: number;
  active_members: number;
  admins: number;
  content: number;
  published_content: number;
  pending_content: number;
  comments: number;
  pending_comments: number;
  accounts: number;
  verified_accounts: number;
  two_factor_accounts: number;
}

/** 「先看这里」的信号列；每个数字都能在现有页面里处理掉。 */
export interface PlatformOverviewSignals {
  open_reports: number;
  pending_comments: number;
  failed_actions: number;
  disabled_sites: number;
  unverified_sites: number;
  unverified_emails: number;
  quiet_sites: number;
}

/** 总览表里的一行：站点状态 + 计数。 */
export interface PlatformOverviewSite {
  id: string;
  slug: string;
  name: string;
  domain: string;
  domain_verified: boolean;
  visibility_mode: VisibilityMode;
  publish_mode: PublishMode;
  disabled: boolean;
  member_count: number;
  active_member_count: number;
  admin_count: number;
  content_count: number;
  published_content_count: number;
  pending_content_count: number;
  draft_count: number;
  comment_count: number;
  pending_comment_count: number;
  open_report_count: number;
  recent_activity_count: number;
  recent_failure_count: number;
  created_at: string;
}

/** 总览里的一条跨站审计行：审计行 + 所属站点名。 */
export interface PlatformActivityRow extends AuditLog {
  site_name?: string;
}

/** `GET /platform/overview` 的完整响应。 */
export interface PlatformOverview {
  generated_at: string;
  window_days: number;
  window_start: string;
  totals: PlatformOverviewTotals;
  signals: PlatformOverviewSignals;
  sites: PlatformOverviewSite[];
  recent_activity: PlatformActivityRow[];
}

/** 跨站审计查询：与站点内审计相同，多了可选的 `site_id`（省略 = 全部站点）。 */
export interface PlatformAuditQuery extends AuditLogQuery {
  site_id?: string;
}

/** 平台用户目录里的一条成员关系。 */
export interface PlatformAccountMembership {
  site_id: string;
  site_name: string;
  site_slug: string;
  role: Role;
  status: string;
}

/**
 * 平台用户目录里的一行。
 *
 * 只读视图：邮箱验证与两步验证都是布尔值，响应里没有密码哈希、密钥或令牌。
 */
export interface PlatformAccount {
  user_id: string;
  display_name: string;
  email: string;
  email_verified: boolean;
  two_factor_enabled: boolean;
  status: string;
  created_at: string;
  memberships: PlatformAccountMembership[];
}

/** 平台用户目录查询；`site_id` 省略时是全部署账户。 */
export interface PlatformAccountQuery {
  site_id?: string;
  q?: string;
  limit?: number;
  cursor?: string;
}

export interface PlatformAccountPage {
  items: PlatformAccount[];
  next_cursor?: string;
}

/* ---------- 社区举报 ---------- */

export type ReportTargetType = 'article' | 'post' | 'comment' | 'user';
export type ReportReason = 'spam' | 'abuse' | 'illegal' | 'other';
export type ReportStatus = 'open' | 'assigned' | 'resolved' | 'dismissed';
/** 处理动作：忽略、下架内容、封禁目标账户。 */
export type ReportAction = 'ignore' | 'takedown' | 'ban';

export interface Report {
  id: string;
  reporter_id: string;
  target_type: ReportTargetType;
  target_id: string;
  reason: ReportReason;
  note?: string;
  status: ReportStatus;
  assignee_id?: string;
  created_at: string;
  updated_at: string;
}

export interface ReportInput {
  target_type: ReportTargetType;
  target_id: string;
  reason: ReportReason;
  note?: string;
}

/** 主域名的 TXT 归属验证信息（V-12）。 */
export interface SiteDomainVerification {
  domain: string;
  verified: boolean;
  verification_token: string;
  /** TXT 记录名，例如 _practacu-verify.press.example.com。 */
  record_name: string;
  /** 记录类型，后端固定返回 TXT。 */
  record_type: string;
}

/** 立即验证主域名归属的结果。 */
export interface SiteDomainVerificationResult {
  verified: boolean;
  domain: string;
}

export interface Member {
  user_id: string;
  display_name: string;
  role: Role;
  status: 'active' | 'invited' | 'suspended';
  email?: string;
  /** 成员媒体额度，null 表示继承站点或部署默认。 */
  media_quota_bytes?: MediaQuotaBytes;
  /** 能力组标识；未分配时是角色对应的内置组。 */
  group_key?: string;
  /** 自定义组名；内置组未改名时为空，界面回退到 i18n 名称。 */
  group_name?: string;
}

/**
 * 公开作者资料：作者归档（/u/{id}）用。
 *
 * 只包含公开主页需要的信息，不返回邮箱、在线状态或私有设置。
 */
export interface PublicProfile {
  user_id: string;
  display_name: string;
  bio?: string;
  avatar_media_id?: string;
  role: Role;
  created_at: string;
}

/** 服务端审计行；字段与 audit_logs 列一一对应。 */
export interface AuditLog {
  id: string;
  site_id?: string;
  actor_id?: string;
  actor_name?: string;
  action: string;
  target_type?: string;
  target_id?: string;
  target_name?: string;
  request_id?: string;
  outcome: string;
  detail?: Record<string, unknown>;
  created_at: string;
}

export interface AuditLogPage {
  items: AuditLog[];
  next_cursor?: string;
}

/** 审计查询；空字段表示不筛选，from / to 都是包含边界。 */
export interface AuditLogQuery {
  from?: string;
  to?: string;
  actor_id?: string;
  action?: string;
  target_type?: string;
  target_id?: string;
  outcome?: string;
  limit?: number;
  cursor?: string;
}

/**
 * 仪表盘「最近操作」的一行（Beta 1.2，契约 C 节：`GET /sites/{siteID}/activity`）。
 *
 * 数据来自服务端 `audit_logs`，不读浏览器存储；`detail` 是服务端拼好的一句说明，
 * 与 `AuditLog.detail` 的结构化对象不同。
 */
export interface SiteActivityItem {
  id: string;
  /** 服务端动作码，例如 `content.publish`。 */
  action: string;
  actor_id: string;
  actor_name: string;
  target_type: string;
  target_id: string;
  /** `success` / `failure` 等与 audit_logs 相同的取值。 */
  outcome: string;
  detail: string;
  created_at: string;
}

/** 管理员创建账户。 */
export interface NewMemberInput {
  email: string;
  display_name: string;
  password: string;
  /** 管理员已在弱密码弹窗中确认继续使用当前弱密码。 */
  confirm_weak_password?: boolean;
  /** 个人博客忽略该字段：所有账户都是最高管理员。 */
  role?: Role;
}

export interface Content {
  id: string;
  kind: ContentKind;
  status: ContentStatus;
  title: string;
  slug: string;
  summary?: string;
  source_format: SourceFormat;
  rendered_html: string;
  policy_version: string;
  published_at?: string;
  /** 预约发布时间（C-17）；已发布或取消预约后为空。 */
  publish_at?: string;
  /** 访问权限（C-18）。不返回密码或哈希。 */
  access_mode?: ContentAccessMode;
  /** 是否已设置访问密码。 */
  has_access_password?: boolean;
  /** 单篇评论策略（C-19）。 */
  comment_policy?: ContentCommentPolicy;
  /**
   * 单篇阅读量（FSD A-16）：服务端去重后的真实阅读次数。
   *
   * 列表与详情都会返回；作者与编辑自己的访问不计入，同一读者 30 分钟内只算一次。
   * 旧后端没有这个字段时按 undefined 处理，界面据此隐藏。
   */
  view_count?: number;
  created_at: string;
  updated_at: string;
  actions: ContentAction[];
  /** 演示数据扩展：契约 v0.1.0 的 Content 不含作者字段。 */
  author_id?: string;
  author_name?: string;
  /** 当前版本号；配合 revision 接口做历史查看与回滚。 */
  revision?: number;
  /** 作者或编辑可见的源文；公开读者只会拿到 rendered_html。 */
  source_body?: string;
  category_id?: string;
  /** 文章标签以名称保存；主题与后台都按名称展示。 */
  tags?: string[];
  /**
   * 回收站标记（Beta 1.2）。
   *
   * 有值表示这篇内容已被软删除。它不出现在任何公开列表、搜索、feed 与 sitemap 里，
   * 只有作者与编辑能通过 `trashed=true` 的列表看到并恢复。
   */
  deleted_at?: string;
  /** 单篇 SEO 覆盖（Beta 1.2）。空字符串表示继承站点模板。 */
  seo_title?: string;
  seo_description?: string;
  seo_keywords?: string;
  /** 规范链接；为空时以本站该内容的地址为准。 */
  canonical_url?: string;
  /** 社交分享图；接受 data URL，因此长度不设上限。 */
  og_image?: string;
  /** 爬虫指令；空表示继承站点开关，`noindex` 会把内容排除出 sitemap。 */
  robots?: '' | 'index' | 'noindex';
  /** 封面（Beta 1.2 从站点外观配置迁入内容模型）。 */
  cover_url?: string;
  cover_alt?: string;
  cover_position?: 'top' | 'center' | 'bottom';
  cover_hidden?: boolean;
  /**
   * 审核风险分（Beta 1.2）。
   *
   * 只在**具备审核权限的调用者**读取**待审内容**（`pending_review` /
   * `pending_security_check`）且服务端能拿到正文时才出现；它是读时计算的规则评分，
   * 不落库，公开读者、作者本人与已发布内容一律没有这两个字段。
   */
  risk_score?: number;
  /** 评分依据的英文标识，前端负责翻译成提示语。 */
  risk_flags?: string[];
}

/** 内容版本历史中的一个不可变快照。 */
export interface ContentRevision {
  id: string;
  content_id: string;
  /** 从 1 开始的版本号。 */
  version: number;
  editor_id: string;
  editor_name?: string;
  action: 'created' | 'updated' | 'rollback_backup' | 'rollback';
  status: ContentStatus;
  title: string;
  slug: string;
  summary?: string;
  source_format: SourceFormat;
  category_id?: string;
  tags?: string[];
  created_at: string;
  /** 只有读取单个版本的接口会返回源文。 */
  source_body?: string;
  rendered_html?: string;
  policy_version?: string;
}

export interface ContentRevisionPage {
  items: ContentRevision[];
}

/* ---------- 版本 diff（Beta 1.2，契约 E 节） ---------- */

/** 行级差异的一段操作。 */
export type DiffOp = 'equal' | 'insert' | 'delete';

/**
 * 一段行级差异。
 *
 * `from_line` / `to_line` 是 1 起始的行号；`insert` 的 `from_line` 为前一条已消费的源行
 * 行号（开头为 0），`delete` 的 `to_line` 为前一条已消费的目标行行号（开头为 0）。
 */
export interface ContentDiffHunk {
  op: DiffOp;
  from_line: number;
  to_line: number;
  text: string;
}

/**
 * `GET /{articles|posts}/{contentID}/diff?from=&to=` 的行级差异。
 *
 * `to` 可以是版本号或 `current`；正文超过 20000 行时只比较前 20000 行并置 `truncated`。
 */
export interface ContentDiff {
  from_version: number;
  to_version: number;
  stats: { added: number; removed: number };
  hunks: ContentDiffHunk[];
  truncated?: boolean;
}

/* ---------- 批量操作（Beta 1.2，契约 G 节） ---------- */

/**
 * 批量动作。
 *
 * 与单条 `ContentAction` 不完全同形：回收站用 `trash`（对应 `DELETE /{kind}s/{id}`），
 * 没有单条的 `reject` / `restore` / `security-retry`。`ids` 一次最多 100 条。
 */
export type BulkAction =
  | 'submit'
  | 'publish'
  | 'archive'
  | 'unpublish'
  | 'trash'
  | 'undelete'
  | 'purge';

/** 批量操作里的一条结果；单条失败不影响其它条目。 */
export interface BulkResultItem {
  id: string;
  ok: boolean;
  /** 失败原因（服务端 problem.message）；成功时为空串。 */
  error: string;
}

/** `POST /{articles|posts}/bulk` 的响应：逐条结果 + 成功 / 失败计数。 */
export interface BulkResult {
  results: BulkResultItem[];
  succeeded: number;
  failed: number;
}

/* ---------- 草稿预览（Beta 1.2，契约 H 节） ---------- */

/**
 * 一次预览授权（`POST /{articles|posts}/{contentID}/preview`）。
 *
 * `token` 是 HMAC 签名令牌，只对那一篇内容、默认 30 分钟内有效；
 * `path` 是可直接打开或分享的站点内路径，已带 `preview_token` 查询串。
 */
export interface PreviewGrant {
  token: string;
  expires_at: string;
  path: string;
}

/* ---------- 永久链接、slug 与重定向（Beta 1.2，契约 J 节） ---------- */

/** 重定向规则的来源：站长手工创建，或服务端在已发布内容改 slug 时自动记录。 */
export type RedirectSource = 'manual' | 'slug_change';

/** 重定向规则允许的状态码。 */
export type RedirectStatusCode = 301 | 302 | 308;

/**
 * 一条重定向规则（`GET /sites/{siteID}/redirects`）。
 *
 * `from_path` 由服务端规范化为以 `/` 开头、不含查询串；重复时创建 / 修改返回 409。
 */
export interface RedirectRule {
  id: string;
  from_path: string;
  to_path: string;
  status_code: RedirectStatusCode;
  source: RedirectSource;
  /** 这条规则被解析命中的次数。 */
  hit_count: number;
  created_at: string;
  updated_at: string;
}

/** 公开路径解析的三种结果（`GET /resolve?path=`，公开端点）。 */
export type ResolveKind = 'content' | 'redirect' | 'missing';

/**
 * 公开路径解析结果，供静态服务器决定 301 / 200 / 404。
 *
 * - `kind=content`：id 形式且存在时 `status=301` 并给出 slug 形式的 `canonical_path`；
 *   已是 slug 形式且存在时 `status=200`；
 * - `kind=redirect`：命中重定向表，`canonical_path` 是目标路径，`status` 是规则状态码；
 * - `kind=missing`：都不存在，`status=404`。
 */
export interface ResolveResult {
  kind: ResolveKind;
  canonical_path: string;
  status: number;
  content_id?: string;
  slug?: string;
  title?: string;
}

export interface ContentPage {
  items: Content[];
  next_cursor: string;
  has_more: boolean;
}

/** 热门内容的排序窗口：既是参评范围，也是时间衰减的尺度。 */
export type PopularWindow = '7d' | '30d' | '90d';

/**
 * 一页热门内容（`GET /content/popular`）。
 *
 * 服务端按「阅读量 / (发布小时数 + 2)^1.5」排序：只统计窗口内发布的已发布公开
 * 内容，所以一条旧的热门文章会逐步让位给新内容。没有阅读数据时按发布时间倒序。
 */
export interface PopularContentPage {
  items: Content[];
  /** 服务端实际使用的窗口。 */
  window: PopularWindow;
}

/** 一条搜索结果：内容本身加上服务端给出的纯文本摘要片段。 */
export interface SearchHit extends Content {
  /** 首个命中附近的纯文本片段，永远不含 HTML；高亮由前端自己做。 */
  snippet?: string;
}

/** GET /search 的可选筛选与分页参数；省略即不筛选。 */
export interface SearchQuery {
  kind?: ContentKind;
  category_id?: string;
  tag?: string;
  author_id?: string;
  /** RFC 3339 时间下界，包含边界。 */
  since?: string;
  /** RFC 3339 时间上界，包含边界。 */
  until?: string;
  /** 上一页返回的 next_cursor；空串表示第一页。 */
  cursor?: string;
  limit?: number;
  /** 服务端默认开启；传 false 表示只要内容不要片段。 */
  highlight?: boolean;
}

/**
 * 一页搜索结果。
 *
 * total 是全量命中数，不是本页条数：分页时用 next_cursor，显示总数时用 total。
 * degraded 为 true 表示服务端全文索引不可用、退回了 LIKE 兜底，此时结果是按时间
 * 排序而不是相关度，界面应当说明这一点。
 */
export interface SearchResult {
  items: SearchHit[];
  total: number;
  next_cursor: string;
  has_more: boolean;
  degraded?: boolean;
}

export interface DraftInput {
  title: string;
  slug?: string;
  summary?: string;
  source_format?: SourceFormat;
  source_body: string;
  category_id?: string;
  tags?: string[];
  /** RFC 3339 预约发布时刻；省略或空串取消预约。 */
  publish_at?: string | null;
  access_mode?: ContentAccessMode;
  /** 只写字段；留空保持原密码，切换为公开/仅登录时服务端清除。 */
  access_password?: string;
  comment_policy?: ContentCommentPolicy;
  /** 单篇 SEO 覆盖（Beta 1.2）；空串表示继承站点模板。 */
  seo_title?: string;
  seo_description?: string;
  seo_keywords?: string;
  canonical_url?: string;
  og_image?: string;
  robots?: '' | 'index' | 'noindex';
  /** 封面（Beta 1.2 起随内容一起保存）。 */
  cover_url?: string;
  cover_alt?: string;
  cover_position?: 'top' | 'center' | 'bottom';
  cover_hidden?: boolean;
  /**
   * 乐观并发控制（Beta 1.2，契约 F 节）：编辑时带上最后读到的版本号。
   *
   * 只有 PATCH 使用；提供且与服务端当前版本不一致时返回 409
   * `content_version_conflict`（`details.current_revision` 是服务端当前版本）。
   * 省略时保持原行为（后写覆盖）。
   */
  revision?: number;
}

/** 密码文章解锁成功的结果；授权本身保存在 HttpOnly Cookie 里。 */
export interface ContentUnlockResult {
  unlocked: boolean;
  expires_at: string;
}

export interface Comment {
  id: string;
  target_type: TargetType;
  target_id: string;
  parent_id?: string;
  depth: number;
  body: string;
  status: CommentStatus;
  /** 演示数据扩展：契约不返回评论作者。 */
  author_id?: string;
  author_name?: string;
  created_at?: string;
  /**
   * 服务端风险评分 0–100（Beta 1.2）。
   *
   * 只有管理侧接口返回；公开读者的评论列表永远不带这两个字段，因此它们是可选的。
   * 评分在评论写入时由服务端计算并落库，不再依赖浏览器。
   */
  risk_score?: number;
  /** 评分依据的英文标识，前端负责翻译成提示语。 */
  risk_flags?: string[];
}

export interface ToggleResult {
  active: boolean;
}

/** 当前登录用户对一条内容的互动状态。匿名请求在公开站点上返回全 false。 */
export interface InteractionState {
  liked: boolean;
  bookmarked: boolean;
  following: boolean;
}

/** 批量状态查询里的单条目标状态。 */
export interface InteractionStateItem {
  target_id: string;
  liked: boolean;
  bookmarked: boolean;
}

export interface FollowStateItem {
  user_id: string;
  following: boolean;
}

export interface InteractionStates {
  items: InteractionStateItem[];
  follows: FollowStateItem[];
}

/**
 * 我的收藏 / 我的点赞列表项。
 *
 * 标题、类型与作者是服务端联表补的只读展示字段；目标被归档或删除后
 * `available` 为 false，页面应以墓碑样式展示而不是给出打不开的链接。
 */
export interface InteractionEntry {
  target_type: TargetType;
  target_id: string;
  /** 收藏 / 点赞发生的时间。 */
  created_at: string;
  title?: string;
  summary?: string;
  kind?: ContentKind;
  author_id?: string;
  author_name?: string;
  published_at?: string;
  available: boolean;
}

/** 阅读历史项：同一用户与同一目标只保留一行，重复访问只更新时间与次数。 */
export interface ReadingHistoryEntry {
  target_type: TargetType;
  target_id: string;
  last_viewed_at: string;
  view_count: number;
  title?: string;
  summary?: string;
  kind?: ContentKind;
  author_id?: string;
  author_name?: string;
  published_at?: string;
  available: boolean;
}

/** 关注 / 粉丝列表里的成员。 */
export interface FollowEntry {
  user_id: string;
  display_name: string;
  bio?: string;
  avatar_media_id?: string;
  /** 关注关系建立的时间。 */
  since: string;
}

export interface Upload {
  id: string;
  file_name: string;
  storage_key: string;
  status: UploadStatus;
  expires_at: string;
}

export interface Asset {
  id: string;
  storage_key: string;
  mime_type: string;
  size: number;
  scan_status: ScanStatus;
  scan_reason?: string;
  /** 展示地址：`/api/v1/media/{id}`。 */
  url?: string;
  file_name?: string;
  /** `GET /media` 返回：上传用途；早期数据可能没有这个字段。 */
  purpose?: StorageScope;
  /** `GET /media` 返回：上传时间。 */
  created_at?: string;
}

export interface Conversation {
  id: string;
  kind: 'direct' | 'group';
  created_by: string;
  members: string[];
  /** 演示数据扩展：契约不返回会话标题与最后一条消息。 */
  title?: string;
  last_message?: string;
  updated_at?: string;
  unread?: number;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  created_at: string;
  sender_name?: string;
}

export interface Notification {
  id: string;
  type: string;
  /** 演示数据扩展：契约按当前用户过滤，不返回收件人字段。 */
  recipient_id?: string;
  actor_id?: string;
  subject_id?: string;
  payload: Record<string, string>;
  read: boolean;
  read_at?: string;
  created_at: string;
}

/** 一个通知渠道（站内 / 邮件）的总开关与分类开关。 */
export interface NotificationChannelPreferences {
  enabled: boolean;
  comments: boolean;
  reactions: boolean;
  follows: boolean;
  moderation: boolean;
}

/** 通知偏好；服务端对从未保存过的账户返回默认值（站内全开、邮件关闭）。 */
export interface NotificationPreferences {
  in_app: NotificationChannelPreferences;
  email: NotificationChannelPreferences;
  /** 部署是否配置了 SMTP；false 时邮件开关暂时没有效果。 */
  email_configured: boolean;
}

export interface AppEvent {
  id: string;
  type: string;
  occurred_at?: string;
  site_id: string;
  payload: Record<string, unknown>;
}

export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  code: string;
  message: string;
  details: Record<string, unknown>;
  request_id: string;
}

export interface Page<T> {
  items: T[];
  next_cursor: string;
  has_more: boolean;
}

export interface ProbeResult {
  health: 'ok' | 'fail';
  ready: 'ready' | 'unready' | 'fail';
  openapi: boolean;
  detail?: string;
}

export interface CommentsResult {
  items: Comment[];
  /**
   * v0.1.0 契约只提供评论的创建 / 编辑 / 删除，没有列表端点。
   * 演示模式为 true；真实后端在补齐 `GET /comments` 之前为 false，界面需要明确告知。
   */
  supported: boolean;
}

/** 后台评论查询。 */
export interface CommentQuery {
  target_type?: TargetType;
  target_id?: string;
  status?: CommentStatus | 'all';
  /** 按正文与作者搜索。 */
  q?: string;
  limit?: number;
  cursor?: string;
}

/** 后台评论列表：比前台多出状态统计与服务端支持标记。 */
export interface CommentPage {
  items: Comment[];
  next_cursor: string;
  has_more: boolean;
  supported: boolean;
  counts?: Partial<Record<CommentStatus | 'all', number>>;
}

export type CommentModerationAction = 'approve' | 'hide' | 'reject' | 'delete';

export interface SessionState {
  status: 'loading' | 'ready' | 'anonymous';
  session: Session | null;
  me: Me | null;
  site: Site | null;
}

export type BackendMode = 'live' | 'demo';

export type HeadingFont = 'serif' | 'sans';

/** 明暗模式。夜航主题深色优先，纸白主题浅色优先；切换只换令牌不改结构。 */
export type ThemeMode = 'light' | 'dark';

/** 主题令牌键。完整令牌可由主题工坊逐项覆盖。 */
export type ThemeTokenKey =
  | 'background'
  | 'ink'
  | 'accent'
  | 'bg_subtle'
  | 'bg_sunken'
  | 'ink_soft'
  | 'muted'
  | 'faint'
  | 'line'
  | 'line_strong'
  | 'accent_soft'
  | 'accent_ink'
  | 'prose';

/** 布局变体：classic 编辑排版风（纸白），bento 杂志网格风（夜航），daylight 卡片化现代编辑风（白昼）。 */
export type LayoutVariant = 'classic' | 'bento' | 'daylight';

/**
 * 夜航首页文章卡的外观。
 *
 * - `cover`：封面在上、文字在下，是夜航一直以来的卡片；
 * - `blur`：封面铺满整张卡片并高斯模糊，标题、简介与元信息压在图上。
 *
 * 只影响展示，不改内容、排序或区块结构。
 */
export type ArticleCardStyle = 'cover' | 'blur';

/** 区块入场动画。全部走 CSS 类，reduce 动效时自动降级。 */
export type BlockAnimation = 'none' | 'fade' | 'fade-up' | 'slide-left' | 'slide-right' | 'zoom';

/** 主题的柔化与过渡效果。 */
export interface ThemeSoftenSettings {
  /** 总开关；关闭时所有柔化变量归零。 */
  enabled: boolean;
  /** 强度 0–100：越大，背景光晕与组件混色越明显。 */
  strength: number;
  /** 背景与组件颜色过渡时长（毫秒）。 */
  transition_ms: number;
  /** 背景叠加柔光渐变。 */
  gradient: boolean;
  /** 卡片、面板与页头等组件混入主题色，削弱硬边界。 */
  blend_components: boolean;
  /** 柔化模糊半径（px），主要用于页头/浮层。 */
  blur: number;
}

export interface ThemeSettings {
  preset: string;
  mode: ThemeMode;
  background: string;
  ink: string;
  accent: string;
  /** 完整令牌覆盖（主题工坊的高级自定义）。键为 ThemeTokenKey。 */
  tokens?: Partial<Record<ThemeTokenKey, string>>;
  heading_font: HeadingFont;
  /** 正文（文章页）字号，14–20 px。 */
  body_size: number;
  /** 正文栏宽，840–1120 px。 */
  content_width: number;
  /** 圆角基准，0–12 px。 */
  radius: number;
  /** 柔化与过渡；旧主题缺省时按关闭处理。 */
  soften: ThemeSoftenSettings;
}

/**
 * 外观分区：主题可以声明自己需要哪些外观设置。
 *
 * 外观页只渲染主题声明过的分区；没声明的分区隐藏，站长仍然可以通过
 * 「主题设置 → 导航与页脚」等入口改数据，只是不在外观页出现。
 */
export type AppearanceSectionId =
  | 'hero'
  | 'branding'
  | 'announcement'
  | 'custom_css';

/** 主题绑定的外观功能。缺省表示支持全部内置分区。 */
export interface ThemeAppearance {
  sections: AppearanceSectionId[];
}

/**
 * 主题自带预览里的一个内容块。
 *
 * 预览是**声明式**的：主题只给类型、文字与视觉权重，渲染器负责把它画成一张
 * 迷你页面。这里没有 HTML / CSS / 脚本入口，导入主题不会往后台注入标记。
 */
export type ThemePreviewBlockType =
  | 'heading'
  | 'text'
  | 'media'
  | 'quote'
  | 'button'
  | 'grid'
  | 'divider';

export interface ThemePreviewBlock {
  type: ThemePreviewBlockType;
  /** 块内文字（heading / text / quote / button 会显示）；渲染为纯文本。 */
  text?: string;
  /** 视觉权重 1–3：影响媒体块高度与文字行数。 */
  weight?: number;
}

/**
 * 主题作者自己写的预览画面。
 *
 * 主题可以只声明标题与副标题，也可以加导航、内容块与配色覆盖；缺省字段由渲染器
 * 按主题令牌与版式补齐。字段级限制见 `docs/themes/06-preview.md`。
 */
export interface ThemePreviewSpec {
  /** 预览顶栏的品牌字，缺省用主题名。 */
  brand?: string;
  /** 顶栏导航文字，最多 5 个；缺省画成三条占位短线。 */
  nav?: string[];
  /** 开屏眉题。 */
  kicker?: string;
  /** 开屏主标题。 */
  title?: string;
  /** 开屏副标题。 */
  subtitle?: string;
  /** 内容块，最多 12 个；缺省按版式生成。 */
  blocks?: ThemePreviewBlock[];
  /** 预览配色覆盖；缺省取主题令牌。只接受十六进制颜色。 */
  palette?: { background?: string; ink?: string; accent?: string };
}

/**
 * 一套“大主题”：完整配色与排版 + 布局变体。
 *
 * 原版（classic 单栏）、白昼（daylight 卡片）与夜航（bento 双栏）是内置主题；导入、创建或另存的主题
 * 保存在 `SiteCustomization.themes`，选中 id 保存在 `active_theme`。
 */
export interface SiteTheme {
  id: string;
  name: string;
  note: string;
  /**
   * 版式变体。空白主题不写这个字段，渲染时回落到内置「原版」的单栏版式。
   * 内置主题与导入/另存的主题始终带完整值。
   */
  variant?: LayoutVariant;
  /**
   * 主题令牌。空白主题不写这个字段，渲染时回落到内置「原版」主题的组件样式；
   * 读取时不要用默认值把它填满，否则「未设置」会被伪装成一套显式配置。
   */
  theme?: ThemeSettings;
  /** 主题制作者声明的外观功能；缺省时按内置全集处理。 */
  appearance?: ThemeAppearance;
  /** 主题作者自己写的预览；缺省时按版式画一张通用预览。 */
  preview?: ThemePreviewSpec;
  /**
   * 主题自带的主题设置（来自主题包 `admin/tabs.json`）。
   *
   * 有这份声明时，主题设置页会渲染主题自己的字段；`replace_default` 为 true 表示
   * 主题放弃内置的配色/排版微调，用自己的设置接口取代那部分界面。
   */
  settings?: ThemeSettingsSchema;
}

/**
 * 一套主题自己的页面编排。
 *
 * 首页与文章页跟着主题走：切换主题时整套切换，切回来能恢复；自定义页面、导航与
 * 页脚仍然是站点级的。字段缺失表示「这套主题没有自己的编排，沿用站点级旧值」，
 * 显式的 `{ blocks: [] }` 才是「空白画布」。
 */
export interface ThemeLayoutEntry {
  home?: ScreenLayout;
  article?: ScreenLayout;
}

/** 主题自定义设置里的一个字段。 */
export type ThemeSettingFieldType = 'text' | 'textarea' | 'toggle' | 'select' | 'color' | 'number';

export interface ThemeSettingField {
  key: string;
  label: string;
  type: ThemeSettingFieldType;
  default?: string | number | boolean;
  hint?: string;
  options?: { value: string; label: string }[];
  maxLength?: number;
  min?: number;
  max?: number;
}

export interface ThemeSettingTab {
  id: string;
  label: string;
  description?: string;
  fields: ThemeSettingField[];
}

export interface ThemeSettingsSchema {
  tabs: ThemeSettingTab[];
  /** true 时主题放弃默认的主题设置界面，使用这里声明的字段。 */
  replace_default: boolean;
}

export type ExtensionId =
  | 'reading_progress'
  | 'toc'
  | 'code_copy'
  | 'share'
  | 'announcement'
  | 'back_to_top';

/* ------------------------------------------------------------------ *
 * 创作者扩展（沙箱运行）
 *
 * 内置扩展是随前端发布的能力开关；这里描述的是站长 / 创作者自己制作、
 * 通过清单导入的扩展。扩展只能声明挂载位置与受限能力，HTML / CSS / JS
 * 一律跑在 sandbox iframe 里，不接触主站 DOM 与登录态。
 * ------------------------------------------------------------------ */

/** 扩展在站点前台出现的位置。 */
export type ExtensionSlot =
  | 'site_header'
  | 'site_footer'
  | 'home_top'
  | 'home_bottom'
  | 'article_top'
  | 'article_bottom'
  | 'article_side'
  | 'floating';

/** 扩展声明自己适用于哪些页面；缺省是 all。 */
export type ExtensionPageScope = 'all' | 'home' | 'article' | 'list' | 'search';

/** 扩展可以申请的受限能力；没申请的能力在沙箱桥里直接拒绝。 */
export type ExtensionPermission =
  | 'notify'
  | 'open_link'
  | 'navigate'
  | 'clipboard'
  | 'theme'
  | 'storage';

/** 一个创作者扩展的完整清单。 */
export interface CustomExtension {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  /** 扩展管理页显示的单字符图标，留空用名称首字。 */
  icon?: string;
  enabled: boolean;
  slots: ExtensionSlot[];
  pages: ExtensionPageScope[];
  permissions: ExtensionPermission[];
  /** 沙箱正文 HTML，只在这个扩展自己的 iframe 里渲染。 */
  html: string;
  /** 沙箱样式，注入 iframe。 */
  css: string;
  /** 沙箱脚本，注入 iframe；可使用受限的 window.PP 桥。 */
  js: string;
  created_at: string;
  updated_at: string;
}

/** 扩展导入 / 导出文件的外层结构（`.ppext.json`）。 */
export interface ExtensionManifestFile {
  format: 'practacu-extension';
  version: 1;
  exported_at?: string;
  extension: CustomExtension;
}

/**
 * 文章自定义封面。
 *
 * 契约没有封面字段，而封面又是纯展示层的东西：这里按内容 id 存一份覆盖配置，
 * 列表卡片与详情页渲染时优先使用它，没有配置就继续用程序化封面。随
 * 「外观 → 导出配置」一起迁移。
 */
export interface ArticleCover {
  /** 内容 id（Content.id）。 */
  id: string;
  /** http(s) 地址、站内路径或以 data:image/ 开头的内联图片。 */
  url: string;
  alt?: string;
  /** 图片裁剪焦点，竖图通常需要顶部。 */
  position?: 'center' | 'top' | 'bottom';
  /** 勾选后列表与详情页都不显示封面（保留配置，可随时恢复）。 */
  hidden?: boolean;
}

export interface BlockSpan {
  base: number; // 1–12
  md?: number;  // ≥768
  sm?: number;  // ≥480
}

/**
 * 只覆盖展示层的补丁：与基准区块逐字段比较后的差异，未出现的键表示沿用基础值。
 * 因此这里必须整体 `Partial`——`hidden` / `animation` 在 `BlockInstance` 上是必填的，
 * `Pick` 之后仍然必填，会让「只改了宽度」这类补丁无法表达。
 */
export type BlockDisplayOverride = Partial<
  Pick<BlockInstance, 'span' | 'appearance' | 'animation' | 'hidden' | 'custom_css' | 'width' | 'height'>
> & {
  /** 分设备的栅格起始列偏移；与 `span` 同形，取值 0–11。 */
  offset?: BlockSpan;
  align?: 'left' | 'center' | 'right';
  gap_scale?: number;
  mt?: number;
  mb?: number;
};

export interface BlockVisibility {
  devices?: BuilderDevice[];
  roles?: ('guest' | 'member' | 'admin')[];
  /** ISO 日期，含首尾。 */
  from?: string;
  to?: string;
}

/** 站点自定义页面。契约 v0.1.0 没有页面端点，页面存在本地安装配置里。 */
export interface SitePage {
  id: string;
  title: string;
  slug: string;
  summary?: string;
  /**
   * 旧版页面的 Markdown 正文。
   *
   * 页面内容现在只由「页面编排」的区块（layout.blocks）承载；这个字段仅用于
   * 读取旧数据时迁移成一个「文本」区块，保存页面时会被清空，前台不再渲染。
   */
  body: string;
  status: 'draft' | 'published';
  show_in_nav: boolean;
  created_at: string;
  updated_at: string;
  /** 页面模板（关于页 Bento / 友链墙 / 时间线 / 空白）。 */
  template?: string;
  /** 页面内容的组件编排；页面内容全部来自这里。 */
  layout?: ScreenLayout;
}

/** 首页精选网格里一格占几列几行。 */
export type TileSpan = '1x1' | '2x1' | '1x2' | '2x2';

/**
 * 置顶到首页的文章。
 *
 * 契约没有置顶端点，置顶名单和主题、页面一样只存在本地安装配置里（可随导出的 JSON 迁移）。
 * 只存 id 与占格，标题、封面、摘要渲染时从内容流里实时取，文章改了标题首页跟着变。
 */
export interface HomePin {
  id: string;
  span: TileSpan;
}

export interface ThemeSettings {
  preset: string;
  background: string;
  ink: string;
  accent: string;
  heading_font: HeadingFont;
  /** 正文（文章页）字号，14–20 px。 */
  body_size: number;
  /** 正文栏宽，840–1120 px。 */
  content_width: number;
  /** 圆角基准，0–12 px。 */
  radius: number;
}

/** 首页首屏文案。留空表示使用站点默认值。 */
export interface HeroSettings {
  kicker: string;
  /** 支持换行；用 *文字* 标记斜体强调。 */
  title: string;
  lede: string;
}

/** 顶部导航里的二级入口。 */
export interface NavChild {
  id: string;
  label: string;
  /** 站内路径或 http(s) 外链；留空表示只显示文字。 */
  href: string;
  /** 内置图标名；留空不显示。 */
  icon?: string;
}

/** 二级导航的展示方式：横排胶囊栏，或下拉菜单。 */
export type NavSubStyle = 'bar' | 'dropdown';

/** 顶部导航图标相对文字的位置。 */
export type NavIconPosition = 'left' | 'right' | 'none';

/**
 * 顶部导航的一个 Tab。
 *
 * `href` 可以是站内路径（`/about`）或 http(s) 外链；留空时该 Tab 不可点击，
 * 用来做分组标题。文字、图标、二级入口与展示方式都由站长自己定。
 */
export interface NavTab {
  id: string;
  label: string;
  href: string;
  /** 内置图标名（见 navigation.ts 的 NAV_ICON_CHOICES）；留空不显示。 */
  icon?: string;
  /** 图标位置；缺省沿用 layout.nav_icon_position。 */
  icon_position?: NavIconPosition;
  /** 二级入口；有子项时可按 layout.nav_sub_style 渲染成二级栏或下拉菜单。 */
  children?: NavChild[];
  /** 该 Tab 的二级入口展示方式；缺省沿用 layout.nav_sub_style。 */
  sub_style?: NavSubStyle;
}

/** 页脚里的一个条目：文字 + 可选链接。 */
export interface FooterLink {
  id: string;
  label: string;
  /** 站内路径、http(s) 外链；留空表示只显示文字。 */
  href: string;
}

/** 软件 / 社交快捷链接的图标来源。 */
export type SocialPlatform =
  | 'github'
  | 'x'
  | 'mastodon'
  | 'rss'
  | 'email'
  | 'website'
  | 'custom';

/** 页头左上角或页脚底栏上方的一条快捷链接。 */
export interface SocialLink {
  id: string;
  platform: SocialPlatform;
  /** 显示文字；图标链接在页头只用作 aria-label/title。 */
  label: string;
  /** http(s) 外链、mailto: 或站内路径。 */
  url: string;
}

/** 页脚的一栏：标题 + 若干条目。 */
export interface FooterColumn {
  id: string;
  title: string;
  links: FooterLink[];
}

/**
 * 页头（最上方 Tab 栏）的样式变体。
 * - classic：整条吸顶，滚动后加一点阴影；
 * - transparent：页面顶部透明，向下滚动后恢复底色；
 * - float：滚动后收缩成一条悬浮圆角胶囊，可配高斯模糊。
 */
export type HeaderStyle = 'classic' | 'transparent' | 'float';

export interface LayoutSettings {
  brand_sub: string;
  show_articles: boolean;
  show_posts: boolean;
  show_search: boolean;
  /** 页头样式；缺省按经典吸顶。 */
  header_style?: HeaderStyle;
  /** 页头背景是否高斯模糊；缺省开启（与旧版观感一致）。 */
  header_blur?: boolean;
  /** 高斯模糊强度（px），4–24。 */
  header_blur_amount?: number;
  /** 向下滚动多少像素后切换到「滚动后」样式。 */
  header_threshold?: number;
  /**
   * 夜航首页文章卡外观；缺省 `cover`（封面在上、文字在下）。
   * `blur` 会把封面铺满卡片并高斯模糊，标题与简介压在图上。
   */
  article_card_style?: ArticleCardStyle;
  footer_text: string;
  /**
   * 顶部导航 Tab。
   * - 缺省（undefined）：自动模式，按 show_* 与「加入站点导航」的页面生成；
   * - 数组（可以为空）：完全按这里的条目渲染。
   */
  nav_tabs?: NavTab[];
  /** 顶部导航整体对齐方式；缺省或旧配置按左侧。 */
  nav_align?: 'left' | 'center' | 'right';
  /** 图标默认在文字左侧还是右侧；单个 Tab 可以覆盖。 */
  nav_icon_position?: NavIconPosition;
  /** 有二级入口时默认的展示方式：二级胶囊栏或下拉菜单。 */
  nav_sub_style?: NavSubStyle;
  /** 二级栏是否展示图标；下拉菜单始终展示已配置的图标。 */
  nav_sub_show_icons?: boolean;
  /**
   * 软件 / 社交快捷链接。
   * 夜航主题会显示在页头左上角品牌旁；所有主题都会在页脚最下方底栏上方显示。
   */
  social_links: SocialLink[];
  /** 页脚栏目。空数组表示页脚只保留品牌块与版权行。 */
  footer_columns: FooterColumn[];
  /** 页脚品牌区标题；留空使用站点名称。 */
  footer_brand_name: string;
  /** 页脚品牌区副标题；留空沿用品牌副标题（brand_sub）。 */
  footer_brand_sub: string;
  /** 页脚品牌区简介；留空使用站点简介。 */
  footer_brand_desc: string;
  /** 是否在页脚品牌区显示站点状态标签（公开浏览 / 审核发布等）。 */
  footer_show_tags: boolean;
  /** 自定义状态标签，用逗号或「、」分隔；留空时显示站点真实状态。 */
  footer_tags: string;
  /** 页脚最下方右侧的说明文字；留空隐藏。 */
  footer_note: string;
  /** 工信部 ICP 备案号，例如「京 ICP 备 00000000 号」。 */
  icp: string;
  /** 公安网备号，例如「京公网安备 11010502030123 号」。 */
  police: string;
  /** 公安网备图标地址；留空使用内置盾牌图标。 */
  police_icon?: string;
  /** 是否在页脚展示中国内地备案信息；海外站点可以保持关闭。 */
  show_filing: boolean;
  /** 站点图标（favicon）地址；留空使用内置图标。 */
  site_icon?: string;
  announcement: string;
  announcement_link: string;
  hero: HeroSettings;
  /** 布局变体。bento 与 daylight 下右栏常驻，侧栏开关被忽略。 */
  variant: LayoutVariant;
}

/* ---------- 人机验证 ---------- */

/**
 * 人机验证（CAPTCHA）设置。
 *
 * 这里保存的是站点侧的配置意图：是否启用、用哪家服务与要保护哪些表单。
 * 服务端从同一份设计文档读出意图，但只有它自己持有 Secret 时才会真正执行；
 * 组件是否显示以 `GET /captcha/status` 的 `effective` 为准，不能只看这里的开关。
 * Secret 只存在于服务端环境变量，不写入任何前端数据。
 */
export type HumanVerificationProvider = 'turnstile' | 'hcaptcha' | 'local';

export interface HumanVerificationSettings {
  enabled: boolean;
  provider: HumanVerificationProvider;
  /** 前端可见的 Site Key；仅第三方服务商使用，本地验证不需要。 */
  site_key: string;
  /** 要保护的表单场景。 */
  on_login: boolean;
  on_register: boolean;
  on_comment: boolean;
  /** 找回密码「发送重置链接」一步。 */
  on_password_reset: boolean;
}

/** 受保护的表单场景。值同时是组件 action 与本地验证 token 绑定的场景。 */
export type CaptchaScene = 'login' | 'register' | 'password_reset' | 'comment';

/**
 * 服务端真正执行的验证规则（`GET /captcha/status`）。
 *
 * `effective` 是唯一可以据此渲染组件的字段：站点开关打开但服务端没有密钥时，
 * 服务端会以「未启用」处理并记警告，组件不该显示出来骗人。
 */
export interface CaptchaStatus {
  enabled: boolean;
  provider: HumanVerificationProvider;
  site_key: string;
  scenes: Record<CaptchaScene, boolean>;
  server_configured: boolean;
  effective: boolean;
  checked_at: string;
}

/**
 * 本地（自托管）验证的题型。三种交互轮流出现，答案都在服务端校验：
 * - `slider`：拖动圆形拼图，把它放进图里的缺口；
 * - `click`：点中图里所有星星（旁边混着干扰图形）；
 * - `select`：在九宫格里选出所有包含圆形的格子。
 */
export type LocalCaptchaKind = 'slider' | 'click' | 'select';

/** 图片坐标系里的一个点；与图片的原始像素尺寸对应，不受 CSS 缩放影响。 */
export interface LocalCaptchaPoint {
  x: number;
  y: number;
}

/**
 * 本地（自托管）验证的一道题（`GET /captcha/local/challenge`）。
 *
 * 题目与答案都由本站服务端生成与校验，不需要 Site Key 或环境变量；前端拿到的只有
 * 图形与几何信息，答案只存在服务端内存里。挑战一次性、短时有效。
 *
 * `kind` 决定该读哪些字段：`slider` 用 `background` / `piece`，`click` 与 `select`
 * 用 `image`；`target_count` 是星星或格子数量，`rows` / `cols` 描述选择题的网格。
 */
export interface LocalCaptchaChallenge {
  challenge_id: string;
  kind: LocalCaptchaKind;
  prompt: string;
  expires_at: string;
  width: number;
  height: number;
  image?: string;
  background?: string;
  piece?: string;
  piece_size?: number;
  piece_top?: number;
  max_offset?: number;
  target_count?: number;
  rows?: number;
  cols?: number;
}

/**
 * 本地验证的答案。按题型只填其中一项：
 * - 滑块：`x` 是拼图左边缘在图片里的像素位置；
 * - 点击：`points` 是点击坐标，顺序不限；
 * - 选择：`tiles` 是选中的格子序号（按行优先）。
 */
export interface LocalCaptchaAnswer {
  x?: number;
  points?: LocalCaptchaPoint[];
  tiles?: number[];
}

/**
 * 本地验证答对后换到的 token（`POST /captcha/local/verify`）。
 *
 * 和第三方服务商的 token 一样提交给受保护接口，一次性、有效期约五分钟。
 */
export interface LocalCaptchaSolution {
  token: string;
  expires_at: string;
}

/* ---------- 评论 ---------- */

/**
 * 评论设置。契约 v0.1.0 没有站点级评论配置端点，因此和主题一样保存在本地安装配置里。
 * `require_review` 为真时，新评论进入 pending_review，需要通过后台「评论管理」放行。
 */
export interface CommentSettings {
  enabled: boolean;
  require_review: boolean;
  /** 评论须知，显示在评论框上方；留空则不显示。 */
  notice: string;
  /** AI 审核辅助设置。 */
  ai: AiModerationSettings;
}

/**
 * AI 审核辅助：本地启发式评分，不上传文章或评论正文到外部服务。
 *
 * `scopes` 决定 AI 参与哪条审核流水线；`auto` 是权限开关。关闭时 AI 只在队列里
 * 标记风险、给审核员建议；开启时按当前策略自动处理：
 * - 开启「先审后发」：低风险的待审评论自动通过；待审文章风险低时自动发布；
 * - 未开启「先审后发」：高风险评论由 AI 直接删除；待审文章仍可自动发布。
 */
export interface AiModerationSettings {
  enabled: boolean;
  /** 审核范围：文章与评论可以分别开启。 */
  scopes: { article: boolean; comment: boolean };
  /** 自动审核权限；`false` 表示只给建议，不代替审核员处理。 */
  auto: boolean;
  sensitivity: 'low' | 'medium' | 'high';
  /** 自定义高风险词，逗号分隔；留空时只用内置规则。 */
  blocked_terms: string[];
}

/* ---------- 内容安全 ---------- */

/** 敏感词命中后的动作：拒绝 / 替换占位符 / 标记待审。 */
export type SensitiveWordMode = 'reject' | 'replace' | 'review';

/** 站点级敏感词。服务端存储时已去空白并小写化。 */
export interface SensitiveWord {
  id: string;
  word: string;
  mode: SensitiveWordMode;
  replacement: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

/** 站点级 IP 白名单 / 黑名单条目，value 为单个地址或 CIDR。 */
export interface SiteIPRule {
  id: string;
  kind: 'allow' | 'deny';
  value: string;
  note?: string;
  created_at: string;
}

/** 评论频率限制：每用户、每 IP 的窗口阈值；0 表示停用该计数器。 */
export interface SafetyRateLimit {
  user_per_window: number;
  ip_per_window: number;
  window_seconds: number;
}

/** GET /sites/{id}/safety 的完整安全策略。 */
export interface SafetyPolicy {
  rate_limit: SafetyRateLimit;
  words: SensitiveWord[];
  ip_rules: SiteIPRule[];
}

/* ---------- 权限组 ---------- */

/**
 * 权限组。个人博客固定只有 owner；社区站点分五组：
 * 游客（未登录）、成员、审核员、管理员、最高管理员。
 */
export type PermissionGroupId = 'guest' | 'member' | 'moderator' | 'admin' | 'owner';

/** 权限能力。界面上的按钮、导航与页面访问统一按能力判断。 */
export type CapabilityId =
  | 'read_content'
  | 'comment'
  | 'write_content'
  | 'moderate_content'
  | 'moderate_comment'
  | 'manage_member'
  | 'manage_site'
  | 'manage_permission'
  | 'view_log';

export interface PermissionGroup {
  /** 该组账户可以进入管理后台。游客没有账户，此字段恒为 false。 */
  admin_access: boolean;
  capabilities: Record<CapabilityId, boolean>;
}

export type PermissionSettings = Record<PermissionGroupId, PermissionGroup>;

/**
 * 服务端可配置的能力组。
 *
 * `key` 是稳定标识：内置组（guest/member/moderator/admin/owner）永不改名，因此
 * 重命名只更新 `name`，不会移动成员或改变角色映射。自定义组从 `member` / `editor` /
 * `site_admin` 中选一个基础角色，能力只能是该角色的子集。
 */
export interface PermissionGroupConfig {
  key: string;
  /** 空字符串表示使用界面语言里的内置名称。 */
  name: string;
  /** 游客组没有账户，为 null。 */
  base_role: Role | null;
  capabilities: Record<CapabilityId, boolean>;
  admin_access: boolean;
  /** 四个内置组为 true；自定义组为 false。 */
  builtin: boolean;
}

/** 保存一个能力组的请求体；PUT 是整组替换。 */
export interface PermissionGroupInput {
  name: string;
  base_role: Role | null;
  capabilities: Record<CapabilityId, boolean>;
  admin_access: boolean;
}


/** 组件通用外观：圆角档位。 */
export type BlockRadius = 'none' | 'sm' | 'md' | 'lg' | 'xl' | 'full';

/** 组件通用外观：阴影档位。 */
export type BlockShadow = 'none' | 'sm' | 'md' | 'lg' | 'glow';

/**
 * 组件通用外观：裁剪方式。
 * `clip` 只裁掉溢出内容；比例值额外设置 aspect-ratio，相当于一个相框。
 */
export type BlockCrop = 'none' | 'clip' | '16:9' | '4:3' | '3:2' | '1:1' | '2:1';

/**
 * 组件通用外观。
 *
 * 全部字段都是受限枚举或标量，随区块一起 JSON 序列化；渲染时只变成最外层
 * `<section class="pp-block">` 上的内联样式，不生成全局样式表，因此不会影响
 * 其他区块，也仍然允许 `custom_css` 覆盖。
 */
export interface BlockAppearance {
  radius?: BlockRadius;
  shadow?: BlockShadow;
  crop?: BlockCrop;
  /** `#rgb` / `#rrggbb` / `#rrggbbaa`；空表示透明。 */
  background?: string;
  /** 0–64 px；0 表示不额外留白。 */
  padding?: number;
  /** 用主题细分割线描一圈边框。 */
  border?: boolean;
}

/** 一个 repeater 条目：只允许标量与字符串。 */
export type BlockPropRecord = Record<string, string | number | boolean>;

/** 区块属性值：标量或 repeater 的条目数组。 */
export type BlockPropValue = string | number | boolean | BlockPropRecord[];

export type BlockProps = Record<string, BlockPropValue>;

/**
 * 无代码区块实例：一个默认组件 + 自己的命名、属性覆盖与入场动画。
 * 属性值只允许标量或 repeater 的条目数组，保证配置可 JSON 序列化、可导入导出。
 */
export interface BlockInstance {
  id: string;
  type: string;
  /** 后台里的显示名，方便在长编排里认出它。 */
  title: string;
  props: BlockProps;
  animation: BlockAnimation;
  hidden: boolean;
  /**
   * 在夜航双栏布局里的位置：整幅（横跨两栏）/ 主栏 / 侧栏。
   * 缺省时按区块类型的默认值决定（见 lib/blocks.ts 的 resolveArea）。
   */
  area?: BlockArea;
  /** 容器类区块的子区块。没有该字段就是普通平铺区块。 */
  children?: BlockInstance[];
  /** 在分栏容器里的列号，从 1 开始；根级区块忽略。 */
  column?: number;
  /** 编排器里直接拖拽调整的宽度（px）；缺省表示撑满可用宽度。 */
  width?: number;
  /** 编排器里直接拖拽调整的最小高度（px）。 */
  height?: number;
  /** 组件级 CSS 声明，只作用于这个区块本身。 */
  custom_css?: string;
  /** 通用外观（圆角、阴影、裁剪、背景、内边距、描边）；缺省表示出厂观感。 */
  appearance?: BlockAppearance;
  /**
   * 归一化时无法识别的区块类型：保留原样、不渲染、保存时写回。
   * 这样从更新版本导出的设计不会因为本版本不认识而在下一次保存时永久消失。
   */
  unsupported?: boolean;
  /** 只覆盖展示层，不覆盖 props；缺省表示沿用基础值。 */
  at?: { tablet?: BlockDisplayOverride; mobile?: BlockDisplayOverride };
  /** 内置条件显示；渲染期求值，刷新后仍然生效。 */
  visible?: BlockVisibility;
  /** 目录 / 跳转锚点。 */
  anchor?: string;
  /** 栅格占位；与 width 同时存在时 span 优先。 */
  span?: BlockSpan;
  /** 栅格起始列偏移。 */
  offset?: BlockSpan;
  /** 子区块在栅格里的水平对齐（P1）。 */
  align?: 'left' | 'center' | 'right';
  /** 栅格间距档位（P1，作用于 grid 容器）。 */
  gap_scale?: number;
  /** 上外边距档位（P1，间距标尺的下标）。 */
  mt?: number;
  /** 下外边距档位（P1，间距标尺的下标）。 */
  mb?: number;
}

/** 夜航双栏布局的落位。 */
export type BlockArea = 'full' | 'main' | 'side';

/** 页面编排里可单独设置的设备。 */
export type BuilderDevice = 'desktop' | 'tablet' | 'mobile';

/** 一个界面的组件编排。 */
export interface ScreenLayout {
  blocks: BlockInstance[];
  /**
   * 开启「不同设备分割」后为 true：桌面 / 平板 / 手机各有一份独立编排。
   * 关闭或不存在的旧配置继续共用 blocks。
   */
  device_split?: boolean;
  /** 各设备的独立编排；缺失的设备回退到桌面，再回退到 blocks。 */
  devices?: Partial<Record<BuilderDevice, { blocks: BlockInstance[] }>>;
}

/* ---------- 思维链（无代码逻辑） ---------- */

export type LogicTriggerType =
  | 'page_load'
  | 'scroll_depth'
  | 'idle'
  | 'click_block'
  | 'hover_block'
  | 'dark_on'
  | 'dark_off'
  | 'always';

export type LogicConditionType =
  | 'is_mobile'
  | 'is_desktop'
  | 'is_logged_in'
  | 'is_anonymous'
  | 'is_personal'
  | 'is_dark'
  | 'is_light'
  | 'is_home';

export type LogicActionType =
  | 'show_block'
  | 'hide_block'
  | 'pulse_block'
  | 'animate_block'
  | 'scroll_to_block'
  | 'switch_mode'
  | 'open_search'
  | 'open_command';

export interface LogicStep {
  id: string;
  kind: 'trigger' | 'condition' | 'action';
  type: string;
  config: Record<string, string | number | boolean>;
}

/** 一条思维链：触发 → 若干条件 → 若干动作，全部满足才执行。 */
export interface LogicChain {
  id: string;
  name: string;
  enabled: boolean;
  steps: LogicStep[];
}

export interface LogicSettings {
  chains: LogicChain[];
}

export type AuthProviderId =
  | 'phone'
  | 'google'
  | 'github'
  | 'wechat'
  | 'qq'
  | 'authenticator';

/**
 * 一种额外的登录方式。client_id / redirect_uri / scope / note 都是非机密配置，
 * 会随安装配置保存在浏览器；Client Secret、短信密钥只应存在于服务端。
 */
export interface AuthProviderSettings {
  enabled: boolean;
  /** 手机：短信签名；OAuth：Client ID / AppID。 */
  client_id: string;
  /** OAuth 回调地址；手机验证码留空。 */
  redirect_uri: string;
  /** 手机：模板编号；OAuth：scope。 */
  extra: string;
  /** 备注：短信服务商、公众号类型等，只用于显示。 */
  note: string;
}

export type AuthSettings = Record<AuthProviderId, AuthProviderSettings>

/**
 * 服务端邮件（SMTP）配置的非机密部分。
 *
 * 与登录方式一样，密码只用于生成 .env 片段，不写入浏览器配置；这里存的是站长填过的
 * 主机、端口、加密方式与发件人，方便下次打开后台时还原表单。
 */
export interface MailSettings {
  /** 站长的意愿：是否开放找回密码。真实能否发信仍由服务端 SMTP 决定。 */
  enabled: boolean;
  host: string;
  port: string;
  encryption: MailEncryption;
  username: string;
  from: string;
  from_name: string;
  /** 对外站点地址，用于重置链接；留空表示使用请求来源。 */
  public_base_url: string;
}

export type MailEncryption = 'starttls' | 'ssl' | 'none';

/** 服务端是否具备找回密码能力。来自 GET /auth/password-reset/policy。 */
export interface PasswordResetPolicy {
  enabled: boolean;
  delivery: 'email';
  /** 重置链接有效期（秒）。 */
  expires_in: number;
  /** 同一账户两次请求之间的最小间隔（秒）。 */
  cooldown: number;
}

export interface PasswordResetTicket {
  status: 'accepted';
  delivery: 'email';
  expires_in: number;
  /**
   * 仅演示模式返回：没有真实邮件服务时，前端直接把令牌交回给用户，
   * 让「忘记密码」流程在本地也能完整走通。
   */
  token?: string;
}

export interface SiteCustomization {
  /**
   * 站点语言：`zh-CN` 或 `en`。
   *
   * 站点级设置，不是访客级偏好；旧配置没有这个字段，`readCustomization`
   * 会归一化成简体中文。它随站点设计一起存到服务端，所以换浏览器、换设备
   * 看到的语言是一致的。
   */
  language?: Locale;
  /** 设计文档的结构版本；缺省按 1 处理，读入时由 migrate.ts 升级到 2。 */
  schema_version?: number;
  theme: ThemeSettings;
  layout: LayoutSettings;
  /** 当前选中的大主题 id：default、night 或自定义主题 id。 */
  active_theme?: string;
  /** 导入或另存的自定义大主题。 */
  themes?: SiteTheme[];
  /**
   * 按主题 id 保存的首页 / 文章页编排。
   *
   * 读取时会把当前主题的条目投影到 `home` / `article`；没有条目的主题沿用站点级
   * 旧值（兼容 Beta 1.2 之前的设计文档，不需要迁移）。
   */
  theme_layouts?: Record<string, ThemeLayoutEntry>;
  /** 首页组件编排。空数组表示按布局变体使用默认编排。 */
  home: ScreenLayout;
  /** 文章详情页附加区块编排；在文章正文之后、评论区之前渲染。 */
  article?: ScreenLayout;
  pages: SitePage[];
  /** 置顶到首页的文章（按数组顺序排版），在「内容库」里勾选。 */
  pins: HomePin[];
  /** 文章自定义封面：按内容 id 覆盖程序化封面。 */
  covers: ArticleCover[];
  /** 内置扩展开关。 */
  extensions: Record<ExtensionId, boolean>;
  /** 创作者制作 / 导入的沙箱扩展。 */
  custom_extensions: CustomExtension[];
  /** 思维链（无代码逻辑）。 */
  logic: LogicSettings;
  /** 站点设置 · 人机验证（CAPTCHA）意图配置。 */
  verification: HumanVerificationSettings;
  /**
   * 主题自定义设置的值：`theme_settings[themeId][tabId][fieldKey]`。
   *
   * 由主题包 `admin/tabs.json` 声明的字段，站长在「主题设置 → 主题自定义」里填写；
   * 跟着站点设计一起同步到服务端。
   */
  theme_settings?: Record<string, Record<string, Record<string, string | number | boolean>>>;
  /** 评论开关、先审后发与评论须知。 */
  comments: CommentSettings;
  /** 分类与标签；契约 v0.1.0 没有分类端点，因此与外观一起保存在本地配置。 */
  taxonomy: TaxonomySettings;
  /** 社区站点的权限组配置；个人博客忽略这份配置，所有账户都是最高权限。 */
  permissions: PermissionSettings;
  /**
   * 服务端能力组的本地镜像。连接真实后端时以 `GET /permission-groups` 为准，
   * 这里保存最近一次看到的值，离线或演示模式仍能渲染同一套名称与矩阵。
   */
  permission_groups?: PermissionGroupConfig[];
  /** 搜索引擎与分享卡片的站点级设置。 */
  seo: SeoSettings;
  /** RSS / Atom 订阅源的开关、条数与全文设置。 */
  feed: FeedSettings;
  custom_css: string;
}

/** 分类或标签。两者结构相同，只是用途不同。 */
export interface TaxonomyTerm {
  id: string;
  name: string;
  slug: string;
  description?: string;
  /** 只有分类使用颜色，用来在列表和卡片上区分。 */
  color?: string;
}

export interface TaxonomySettings {
  categories: TaxonomyTerm[];
  tags: TaxonomyTerm[];
}

export type TaxonomyKind = 'category' | 'tag';

export interface TaxonomyTermInput {
  kind: TaxonomyKind;
  name: string;
  slug: string;
  description?: string;
  color?: string;
}

/**
 * 站点级 SEO 设置。
 *
 * 单页应用没有服务端模板，这些值由前端在渲染时写入 <head>：爬虫执行 JS 时能读到，
 * 社交平台的抓取器大多不执行 JS，所以分享卡片的最终效果仍取决于托管方是否预渲染。
 */
export interface SeoSettings {
  /** 标题模板，支持 {title} 与 {site}。 */
  title_template: string;
  /** 站点默认描述，文章没有摘要时使用。 */
  default_description: string;
  keywords: string;
  /** 默认分享图，支持绝对地址与站内路径。 */
  share_image: string;
  /** Twitter / X 账号，带不带 @ 都可以。 */
  twitter: string;
  /** 是否允许搜索引擎收录；关闭时全站输出 noindex。 */
  indexable: boolean;
  /** 生成 canonical 与 sitemap 时使用的站点地址；留空取当前访问地址。 */
  canonical_base: string;
  /** 发布者名称，写入结构化数据。 */
  publisher: string;
  permalinks: PermalinkSettings;
  verification: {
    google: string;
    baidu: string;
    bing: string;
  };
}

export type PermalinkStructure =
  | 'legacy'
  | 'date_name'
  | 'month_name'
  | 'numeric'
  | 'post_name'
  | 'custom';

export interface PermalinkSettings {
  article_structure: PermalinkStructure;
  article_custom: string;
  article_aliases?: PermalinkPattern[];
  posts_follow_articles: boolean;
  post_structure: PermalinkStructure;
  post_custom: string;
  post_aliases?: PermalinkPattern[];
}

export interface PermalinkPattern {
  structure: PermalinkStructure;
  custom?: string;
}

/**
 * RSS / Atom 订阅源设置。
 *
 * 这些字段随站点设计一起保存，由服务端读取：`/rss.xml`、`/atom.xml` 与
 * `/category/{slug}/…`、`/tag/{slug}/…` 是否可用、输出全文还是摘要、每个源最多
 * 多少条，都在这里控制。关闭后服务端返回 404，前端也不再声明 autodiscovery。
 */
export interface FeedSettings {
  /** 总开关。关闭时所有订阅源返回 404。 */
  enabled: boolean;
  /** 输出清洗后的正文；关闭时只输出摘要。 */
  full_text: boolean;
  /** 每个源最多包含多少条。 */
  limit: number;
  /** 是否提供分类 / 标签订阅源。 */
  include_taxonomy: boolean;
}

/* ---------- 访问限制 / 域名绑定 / 性能优化 / 加载动画 ---------- */

/**
 * 一条访问限制规则。
 *
 * 浏览器端按滑动窗口统计；真正的 IP 级限制仍由反向代理或 API 的
 * `RATE_LIMIT_PER_MINUTE` 执行，后台会生成对应的配置片段。
 */
export interface RateRule {
  enabled: boolean;
  /** 一个窗口内允许的次数。 */
  limit: number;
  /** 滑动窗口长度（秒）。 */
  window_seconds: number;
  /** 触发后临时拒绝访问的时长（秒）。 */
  block_seconds: number;
}

export type AccessReason = 'page_switch' | 'request' | 'tabs';

/** 访问限制（浏览器端保护 + 网关配置生成）。 */
export interface AccessSettings {
  /** 总开关。关闭时三条浏览器端规则都不生效。 */
  enabled: boolean;
  /** 限制一段时间内切换页面的次数。 */
  page_switch: RateRule;
  /** 限制页面脚本发起的后端请求次数。 */
  requests: RateRule;
  /** 同一浏览器同时打开的站点标签页数量；网关里对应每 IP 并发连接。 */
  tabs: { enabled: boolean; limit: number };
  /** 触发限制时给访客看的提示。 */
  message: string;
}

/** TLS 证书配置；只保存部署意图与服务器上的证书路径，不保存私钥内容。 */
export interface TlsSettings {
  /** off：只用 HTTP；letsencrypt：certbot 自动签发；manual：已有证书文件。 */
  mode: 'off' | 'letsencrypt' | 'manual';
  /** Let's Encrypt 通知邮箱。 */
  email: string;
  /** 手动证书的 fullchain 路径（服务器上）。 */
  cert_path: string;
  /** 手动证书的私钥路径（服务器上）。 */
  key_path: string;
  /** 生成网关配置时附加 HSTS。 */
  hsts: boolean;
}

/** 域名绑定白名单与网关配置。 */
export interface DomainSettings {
  enabled: boolean;
  /** 主域名快照；真实主域名以 Site.domain 为准，可在「访问与域名」直接设置。 */
  primary: string;
  /** 额外允许的域名，支持 `*.example.com`。 */
  aliases: string[];
  /** 把 `www.example.com` 视为主域名的别名。 */
  allow_www: boolean;
  /** 本地开发时允许 localhost / 127.0.0.1。 */
  allow_localhost: boolean;
  /** 允许直接通过 IP 访问。 */
  allow_ip: boolean;
  /** 生成网关配置时把别名域名 301 到主域名。 */
  redirect_primary: boolean;
  /** 生成网关配置时强制 HTTPS。 */
  https_only: boolean;
  /** TLS 证书配置。 */
  tls: TlsSettings;
  /** 允许跨域调用 API 的浏览器来源；留空时由绑定域名推导。 */
  cors_origins: string[];
  /** 站点 Cookie 作用域，例如 `.example.com`；留空表示仅当前主机。 */
  cookie_domain: string;
  /** 反向代理地址/CIDR；用于 API 识别真实客户端 IP。 */
  trusted_proxies: string[];
}

/**
 * 性能优化。
 *
 * 重点不是“看起来更快”，而是减少 API、数据库和静态资源的压力：限制首屏读取量、
 * 合并重复请求、懒加载媒体，并把网关/API 的超时、缓存与连接池参数生成到可部署的
 * 配置片段里。服务器参数仍需部署方应用（写进 .env 或 Nginx 后重启）。
 */
export interface PerformanceSettings {
  /** 首页与模板页一次读取的内容条数。 */
  feed_limit: number;
  /** 归档页每页条数。 */
  archive_limit: number;
  /** 对 GET 请求做去重与短缓存，减少重复请求和服务端查询。 */
  request_cache: boolean;
  /** 短缓存时间（秒）。 */
  cache_ttl: number;
  /** 视频、嵌入站点与图片的懒加载；减少首屏带宽。 */
  lazy_media: boolean;
  /** 关闭前台入场动画、过渡与平滑滚动。 */
  disable_animations: boolean;
  /** 需要提前建立连接的外部来源，例如字体或图床地址。 */
  preconnect: string[];
  /** 生成网关配置时开启 gzip。 */
  gzip: boolean;
  /** 带 hash 静态资源的缓存天数。 */
  static_cache_days: number;
  /** 网关 keepalive 秒数。 */
  keepalive_timeout: number;
  /** 网关允许的请求体上限（MB）；过小会影响上传，过大会占内存。 */
  client_max_body_size_mb: number;
  /** 网关读超时（秒），避免慢请求长期占用连接。 */
  proxy_read_timeout: number;
  /** API 读超时（秒）。 */
  api_read_timeout: number;
  /** API 空闲连接超时（秒）。 */
  api_idle_timeout: number;
  /** 数据库最大打开连接数；0 表示按驱动默认。 */
  db_max_open_conns: number;
  /** 数据库最大空闲连接数；0 表示按驱动默认。 */
  db_max_idle_conns: number;
  /** 数据库连接最长生命周期（秒）。 */
  db_conn_max_lifetime: number;
}

export type StorageDriver = 'local' | 's3';

/** 存储用途：文章媒体、站点图片、用户头像、用户数据/附件。 */
export type StorageScope = 'content' | 'site' | 'avatar' | 'attachment';

/** 单个用途的分配方式：一套策略，或多套按容量切换。 */
export type StorageAllocationMode = 'single' | 'quota';

/** 当前策略达到容量上限后的行为。 */
export type StorageOverflowPolicy = 'switch' | 'stop';

/**
 * 一个用途里的一套策略分配。
 *
 * `quota_gb` 是这一套策略在该用途下的容量上限（GB），0 表示不限。
 * 容量按用途分别记录：同一套策略可以被不同用途分配成不同的上限。
 */
export interface StorageAllocationEntry {
  /** 引用 `StorageStrategy.id`。 */
  strategy_id: string;
  /** 该策略在这个用途下的容量上限（GB）；0 表示不限。 */
  quota_gb: number;
}

/**
 * 一个用途的完整分配：单策略或多策略、策略顺序与容量上限。
 *
 * `entries` 的顺序就是写入顺序：第一套是主策略，只有前面一套达到上限后才会
 * 使用下一套。单策略模式只读取第一项，但保留其余项，方便随时切回多策略。
 */
export interface StorageScopeAllocation {
  mode: StorageAllocationMode;
  entries: StorageAllocationEntry[];
  overflow: StorageOverflowPolicy;
}

/**
 * 一套命名的储存策略。
 *
 * 平台管理员在后台保存后会立即应用：API 把设置写进 `data/storage-settings.json`
 * 并马上换用，无需重启；这个文件优先于 `.env` 里的 `STORAGE_*` 变量。没有运行期
 * 应用权限（或旧后端）时，后台仍能把「策略 + 用途分配」翻译成可粘贴的 `.env`
 * 片段，但需要部署方自己重启。已有文件不会自动搬家。云对象存储兼容任何 S3 实现
 * （AWS S3、MinIO、阿里云 OSS、腾讯云 COS 等）；公开读权限与防盗链由桶策略
 * 或 CDN 决定。
 */
export interface StorageStrategy {
  /** 稳定 id，只允许小写字母、数字、下划线与连字符；用途用它引用策略。 */
  id: string;
  /** 展示名，必填且唯一，最多 40 个字符。 */
  name: string;
  /** 本地存储或 S3 兼容云对象存储。 */
  driver: StorageDriver;
  /** driver=local 时的本地目录；相对路径基于 API 进程的工作目录。 */
  local_dir: string;
  /** driver=s3 时的桶名；云策略必填。 */
  s3_bucket: string;
  /** driver=s3 时的对象键前缀，同一桶多站点时用来隔离。 */
  s3_prefix: string;
  /** S3 兼容端点；AWS 留空，MinIO / OSS / COS 填各自地址。 */
  s3_endpoint: string;
  /** 区域；SDK 对 MinIO 也要求一个值，留空时按 us-east-1 处理。 */
  s3_region: string;
  /**
   * 访问密钥 ID。可以保存在本地安装配置里，也会随「立即应用」请求提交；
   * 密钥（secret）不保存：只存在于页面的组件状态，用于一次应用请求或生成
   * `.env` 片段，应用成功后立即清空，也不会回显。
   */
  s3_access_key: string;
  /**
   * 期望的公开访问前缀（例如 CDN 域名）。
   *
   * 仅用于前端记录与排查，API 不读取这个值；公开读权限由桶策略或 CDN 决定。
   */
  s3_public_base_url: string;
}

/**
 * 媒体储存设置。
 *
 * `strategies` 是用户自己增删改的命名策略；`scopes` 把四个用途各自指向一套
 * 策略的 id。旧版配置（全局 driver + 分用途覆盖）由 `normalizeStorage()`
 * 迁移成这个形状，因此页面永远只需要处理这里的一种模型。
 */
export interface StorageSettings {
  /** 至少一套，最多 8 套。 */
  strategies: StorageStrategy[];
  /**
   * 每个用途的主策略 id（多策略时就是第一套）。
   *
   * 保留这个字段是兼容旧配置与部署片段：真正完整的分配在 `allocations` 里。
   */
  scopes: Record<StorageScope, string>;
  /** 每个用途的完整分配；旧配置缺省时由 `scopes` 迁移成单策略。 */
  allocations?: Record<StorageScope, StorageScopeAllocation>;
  /** 仅前端提示：期望的单文件上限（MB）。真正的上限由 API 决定。 */
  max_upload_mb: number;
}

/**
 * 服务端返回的一套策略的运行时状态（`GET /system/storage`）。
 *
 * 只说明「有没有保存 Access Key / 密钥」，永远不回传密钥值本身；页面上的密钥
 * 输入框只存在于组件状态里。
 */
export interface StorageRuntimeStrategy {
  id: string;
  name: string;
  driver: StorageDriver;
  local_dir: string;
  s3_bucket: string;
  s3_prefix: string;
  s3_endpoint: string;
  s3_region: string;
  has_access_key: boolean;
  has_secret: boolean;
}

/**
 * 服务端某个用途里的一套策略分配。
 *
 * `used_bytes` 是服务端统计到的已用容量（页面只展示，不参与判断）；
 * `current` 标记当前写入实际落在这套策略上（写满后会按 `overflow` 移动）。
 */
export interface StorageRuntimeAllocationEntry {
  strategy_id: string;
  quota_gb: number;
  used_bytes: number;
  current: boolean;
}

/** 服务端某个用途的完整分配：模式、写入顺序与服务端实测用量。 */
export interface StorageRuntimeAllocation {
  mode: StorageAllocationMode;
  entries: StorageRuntimeAllocationEntry[];
  overflow: StorageOverflowPolicy;
}

/**
 * `GET /system/storage` 的响应。
 *
 * `live` 表示后台保存的策略是否已经在当前 API 进程里生效；`source` 说明生效值
 * 来自运行期保存（`saved`，优先于 `.env`）还是部署环境变量（`env`）。旧后端
 * 不返回这个端点，页面会退回 `/system/effective-config`。响应里没有任何密钥。
 */
export interface StorageStatus {
  live: boolean;
  source: 'env' | 'saved';
  /** 最近一次把后台设置应用到进程的时间（RFC 3339）；`env` 来源时为 null。 */
  updated_at?: string | null;
  /** 被最多用途使用的那套策略 id（部署片段里的全局策略）。 */
  global_strategy_id: string;
  strategies: StorageRuntimeStrategy[];
  scopes: Record<string, string>;
  /** 每个用途的服务端分配与实测用量；旧后端缺省。 */
  allocations?: Record<string, StorageRuntimeAllocation>;
  /** 当前进程实际生效的位置：`global` 一行 + 四个用途各一行。 */
  effective: EffectiveStorageScope[];
}

/** 应用储存设置时提交的一套策略；`s3_secret_key` 只在本次输入了新密钥时出现。 */
export interface StorageApplyStrategy {
  id: string;
  name: string;
  driver: StorageDriver;
  local_dir: string;
  s3_bucket: string;
  s3_prefix: string;
  s3_endpoint: string;
  s3_region: string;
  s3_access_key: string;
  s3_secret_key?: string;
}

/**
 * `PUT /system/storage` 的请求体（平台管理员）。
 *
 * `allocations` 必须包含全部四个用途：服务端按它执行容量切换，配额、顺序与
 * `overflow` 都在写入时真正生效，不再只是页面上的计划。
 */
export interface StorageApplyRequest {
  global_strategy_id: string;
  strategies: StorageApplyStrategy[];
  scopes: Record<string, string>;
  allocations: Record<StorageScope, StorageScopeAllocation>;
}

export type LoadingPreset =
  | 'spinner'
  | 'dots'
  | 'pulse'
  | 'bar'
  | 'orbit'
  | 'skeleton'
  | 'shimmer'
  | 'skeleton-shimmer';

/** 站点前台加载动画。 */
export interface LoadingSettings {
  enabled: boolean;
  preset: LoadingPreset;
  text: string;
  /** 强调色跟随主题，或使用自定义颜色。 */
  accent_mode: 'theme' | 'custom';
  accent: string;
  /** 背景跟随主题，或使用自定义颜色。 */
  background_mode: 'theme' | 'custom';
  background: string;
  /** 动画图形尺寸（px）。 */
  size: number;
  /** 最短展示时长（ms），避免一闪而过。 */
  min_duration_ms: number;
  /** 首次打开站点时显示。 */
  show_on_first_load: boolean;
  /** 站点内切换页面时显示。 */
  show_on_navigation: boolean;
  /** 只作用于加载画面的附加 CSS。 */
  custom_css: string;
}

export interface WebConfig {
  version: 1;
  setup_complete: boolean;
  mode: BackendMode;
  api_base: string;
  site_id: string;
  database: 'sqlite' | 'mysql' | 'postgres';
  created_at: string;
  docs_url: string;
  /** 旧配置没有这个字段，按社区站点处理。 */
  site_kind?: SiteKind;
  /** 站长登录邮箱：只用于个人博客的登录提示与前端校验，不是凭据。 */
  owner_email?: string;
  /** 后台入口地址别名，例如 /manage；缺省为 /admin。 */
  admin_path?: string;
  /**
   * 管理后台界面字号倍率（0.8–1.2，100% = 默认）。
   *
   * 这是设备级显示偏好，保存在本机安装配置里，不进站点设计文档；安装向导会给出初始值。
   */
  admin_font_scale?: number;
  /**
   * 匿名访客的只读配置：由启动探测（`lib/visitorBootstrap.ts`）构造，只存在内存里。
   *
   * 带这个标记的配置不写回 localStorage，也不参与「安装校验 / 设计水合 / 设计回写」，
   * 避免把访客浏览器误当成一次真实安装。
   */
  visitor?: boolean;
  /** 匿名访客的站点名：真实 Site 对象要登录后才能拿到，访客用 setup/status 的结果。 */
  visitor_site_name?: string;
  /**
   * 匿名访客看到的注册开关（来自 setup/status 的 registration_open）。
   *
   * 缺省表示旧后端：按开放处理；false 时前台隐藏注册入口、注册页显示关闭提示。
   */
  visitor_registration_open?: boolean;
  /** 主题、页面与扩展。旧配置缺省时按默认外观处理。 */
  customization?: SiteCustomization;
  /** 邮箱之外的登录方式。旧配置缺省时全部关闭。 */
  auth?: AuthSettings;
  /** 服务端邮件（SMTP）的非机密配置；密码不在这里。 */
  mail?: MailSettings;
  /** 访问限制（浏览器端）与网关配置生成。旧配置缺省时关闭保护。 */
  access?: AccessSettings;
  /** 域名绑定白名单。旧配置缺省时不做域名校验。 */
  domains?: DomainSettings;
  /** 前端性能优化开关。旧配置缺省时使用稳妥默认值。 */
  performance?: PerformanceSettings;
  /** 媒体存储策略（本地目录 / S3 兼容）；旧配置缺省时使用本地目录。 */
  storage?: StorageSettings;
  /** 站点前台加载动画。旧配置缺省时关闭。 */
  loading?: LoadingSettings;
  /**
   * 站点更新设置。更新源从预置下拉项里选（见 `lib/siteUpdate.ts` 的
   * `UPDATE_SERVERS`），没有单独的端口：所有更新源都是标准 HTTPS 或本站相对路径。
   * 旧配置里的 `auto_update` / `server_port` 会在读取时迁移或丢弃。
   */
  update?: SiteUpdateSettings;
  /**
   * 切到个人博客前的角色快照。个人博客会把所有账户提升为站点管理员，
   * 这里记住原角色，切回社区站点时逐一恢复。
   */
  role_snapshot?: Record<string, Role>;
}

/** 更新通道：稳定版 / 测试版。 */
export type SiteUpdateChannel = 'stable' | 'beta';

/** 自动检查更新的时机；手动更新模式下不使用。 */
export type SiteUpdateFrequency = 'startup' | 'daily' | 'weekly';

/** 更新方式：手动（点了「检查更新」才查询）或自动（后台按频率查询）。 */
export type SiteUpdateMode = 'manual' | 'auto';

/**
 * 版本清单里的 `style`：这份版本属于哪个发布渠道。
 *
 * - `beta`：仓库 main 分支上的测试版；
 * - `stable`：正式发布的稳定版；
 * - `local`：本机自行构建 / 二次打包的版本，不对应任何发布渠道。
 */
export type SiteUpdateStyle = 'stable' | 'beta' | 'local';

/**
 * 版本清单（仓库里的 `web/public/version.json`）。
 *
 * 新清单写 `version`、`channel` 与整数 `version_code`；`style` 只为读取旧清单保留。
 * `version_code` 是比较的唯一依据；任何字段与版本号不自洽都按「清单无效」处理。
 */
export interface SiteUpdateManifest {
  title: string;
  describe: string;
  version: string;
  /** 新清单必填；旧清单缺失时由版本号推断。 */
  channel?: SiteUpdateChannel;
  /** 新清单必填；旧清单缺失时由版本号计算。 */
  version_code?: number;
  /** @deprecated 仅用于读取旧清单与现有页面展示。 */
  style?: SiteUpdateStyle;
}

/**
 * 站点更新设置。
 *
 * 没有「更新服务端端口」这一项：下拉里的更新源都是标准地址，端口由协议决定。
 * `server_url` 可以是预置项，也可以是指向本站的 `/version.json`（本地构建自检用）。
 */
export interface SiteUpdateSettings {
  /** 更新方式：手动更新 / 自动更新。 */
  mode: SiteUpdateMode;
  channel: SiteUpdateChannel;
  frequency: SiteUpdateFrequency;
  /** 更新源地址；来自下拉项，空字符串表示不检查更新。 */
  server_url: string;
  /** 最近一次检查时间（ISO 字符串）；从未检查时缺省。 */
  last_checked_at?: string;
  /** 最近一次在服务端看到的版本号，用于判断「是否有新版本」；从未检查时缺省。 */
  last_remote_version?: string;
}

export interface ActivityEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  target: string;
  detail?: string;
}

/** 数据与备份：一个已生成的实例备份包。 */
export interface BackupArtifact {
  id: string;
  file_name: string;
  size: number;
  sha256: string;
  created_at: string;
  driver: string;
  dialect: string;
  includes_media: boolean;
  warnings?: string[];
}

/** 数据与备份：页面内在线恢复的结果。 */
export interface RestoreBackupResult {
  safety_backup_id: string;
  database_path: string;
  media_files: number;
  sites: number;
  users: number;
  content: number;
  schema_version: string;
  migrated: boolean;
  warnings?: string[];
}

/** 导入时 slug 冲突的处理策略。 */
export type ImportConflictStrategy = 'rename' | 'skip' | 'fail' | 'overwrite';

/** 导入报告里的单条结果。 */
export interface SiteImportItem {
  file: string;
  title: string;
  slug: string;
  kind: string;
  original_status?: string;
  action: 'imported' | 'overwritten' | 'skipped' | 'failed';
  content_id?: string;
  status?: string;
  reason?: string;
}

/** 全站导入的逐条报告。 */
export interface SiteImportReport {
  format: string;
  format_version: number;
  site_id: string;
  imported: number;
  overwritten: number;
  skipped: number;
  failed: number;
  media_imported: number;
  media_reused: number;
  items: SiteImportItem[];
  warnings?: string[];
}

/* ------------------------------------------------------------------ *
 * 性能面板（可选模块）：本机与服务端进程的资源占用
 * ------------------------------------------------------------------ */

/** 本软件的一个进程。CPU 是占整机算力的比例（与主机 CPU 同一口径）。 */
export interface SystemProcess {
  pid: number;
  name: string;
  /** api / web / app；由服务端按进程名与安装目录识别。 */
  role: string;
  cpu_percent: number;
  memory_bytes: number;
}

/** 其他软件按可执行文件聚合后的行。 */
export interface SystemAggregateProcess {
  name: string;
  processes: number;
  cpu_percent: number;
  memory_bytes: number;
}

/** 本软件自己的磁盘占用（数据目录内部拆分）。 */
export interface SystemStorageFootprint {
  data_dir: string;
  total_bytes: number;
  database_bytes: number;
  media_bytes: number;
  backup_bytes: number;
  other_bytes: number;
}

/** `GET /api/v1/system/metrics` 的一份缓存采样。 */
export interface SystemMetrics {
  sampled_at: string;
  platform: {
    os: string;
    arch: string;
    hostname: string;
    uptime_seconds: number;
  };
  cpu: {
    usage_percent: number;
    cores: number;
    model: string;
  };
  memory: {
    total_bytes: number;
    used_bytes: number;
    free_bytes: number;
    usage_percent: number;
  };
  disk: {
    path: string;
    total_bytes: number;
    used_bytes: number;
    free_bytes: number;
    usage_percent: number;
  };
  app: {
    processes: SystemProcess[];
    cpu_percent: number;
    memory_bytes: number;
    storage: SystemStorageFootprint;
    /** 本次 API 进程启动至今的秒数；旧后端没有这个字段。 */
    uptime_seconds?: number;
    /** 跨启停累计的软件运行秒数（含本次会话）；旧后端没有这个字段。 */
    total_uptime_seconds?: number;
  };
  others: {
    cpu_percent: number;
    memory_bytes: number;
    process_count: number;
    top_processes: SystemAggregateProcess[];
  };
}

/* ------------------------------------------------------------------ *
 * 系统日志查看器 / 队列监控 / 自动备份（Beta 1.2，契约 K–L 节）
 * ------------------------------------------------------------------ */

/**
 * 请求日志的一条元数据（`GET /system/logs`）。
 *
 * 服务端只在进程内环形缓冲里保存最近 500 条，只记录元数据，不记请求体、请求头或查询串。
 */
export interface SystemLogEntry {
  time: string;
  request_id: string;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  site_id: string;
  user_id: string;
}

/** 自动备份产物（`GET /system/backup-schedule` 的 `artifacts`）。 */
export interface BackupScheduleArtifact {
  name: string;
  size: number;
  created_at: string;
}

/**
 * 自动备份计划（`GET /system/backup-schedule`，平台管理员）。
 *
 * 计划来自 `BACKUP_AUTO_*` 环境变量；到点创建备份、保留最近 `keep` 份，每次运行写审计。
 */
export interface BackupSchedule {
  enabled: boolean;
  /** 每天几点运行（0–23）。 */
  hour: number;
  /** 保留最近几份。 */
  keep: number;
  last_run_at?: string;
  /** 最近一次运行结果：`success` / `failed` 等；从未运行时为 undefined。 */
  last_status?: string;
  last_error?: string;
  next_run_at?: string;
  artifacts: BackupScheduleArtifact[];
}

/* ------------------------------------------------------------------ *
 * 来源 / 设备 / 引荐 / 留存统计（Beta 1.2，契约 M 节）
 * ------------------------------------------------------------------ */

/** 来源分类；由服务端从 Referer 派生。 */
export type AnalyticsSourceKind = 'direct' | 'internal' | 'search' | 'social' | 'referral';

/** 设备分类；由服务端从 User-Agent 派生。 */
export type AnalyticsDeviceKind = 'bot' | 'mobile' | 'tablet' | 'desktop' | 'unknown';

export interface AnalyticsSourcePoint {
  source: AnalyticsSourceKind;
  visits: number;
  sessions: number;
}

export interface AnalyticsDevicePoint {
  device: AnalyticsDeviceKind;
  visits: number;
  sessions: number;
}

export interface AnalyticsReferrerPoint {
  host: string;
  visits: number;
}

/** 每日留存：当天首次出现的 session 数，与当天出现且此前已出现过的 session 数。 */
export interface AnalyticsRetentionPoint {
  date: string;
  new_sessions: number;
  returning_sessions: number;
}

/**
 * `GET /sites/{siteID}/analytics` 响应新增的四个维度（旧后端不返回时按空数组处理）。
 *
 * 定义在 `types.ts` 而不是 `lib/analytics.ts`：后者只承载浏览器本地统计；
 * 服务端响应类型在 `lib/api.ts` 里与既有 `BackendAnalytics` 合并成 `SiteAnalytics`。
 */
export interface AnalyticsBreakdown {
  sources: AnalyticsSourcePoint[];
  devices: AnalyticsDevicePoint[];
  top_referrers: AnalyticsReferrerPoint[];
  retention: AnalyticsRetentionPoint[];
}

/* ------------------------------------------------------------------ *
 * 邮件订阅与 Newsletter（Beta 1.2，契约 N 节）
 * ------------------------------------------------------------------ */

/**
 * 订阅者状态。
 *
 * 契约 N 节只点名 pending / confirmed / unsubscribed 三态；服务端还会把硬退信标成
 * `bounced`（不会自动删除订阅记录），所以类型里一并列出，页面需要把它显示成
 * 「投递失败」而不是沿用未知状态。
 */
export type SubscriberStatus = 'pending' | 'confirmed' | 'unsubscribed' | 'bounced';

/**
 * 订阅 / 确认 / 退订三个公开端点的返回状态（契约 N1）。
 *
 * 与 `SubscriberStatus` 分开：这三个端点只会答 pending / confirmed / unsubscribed，
 * `bounced` 只出现在管理端订阅名单的行里。
 */
export type NewsletterSubscriptionStatus = 'pending' | 'confirmed' | 'unsubscribed';

/** 一条订阅记录（`GET /sites/{siteID}/subscribers`）。 */
export interface Subscriber {
  id: string;
  email: string;
  status: SubscriberStatus;
  /** 订阅来源：站点表单 / 登录账户等由服务端记录。 */
  source: string;
  /** 关联的登录账户；匿名订阅为空。 */
  user_id?: string;
  confirmed_at?: string;
  unsubscribed_at?: string;
  last_sent_at?: string;
  created_at: string;
}

/** 订阅名单统计（`GET /sites/{siteID}/newsletter-stats`）。 */
export interface NewsletterStats {
  confirmed: number;
  pending: number;
  unsubscribed: number;
  sent_7d: number;
  failed_7d: number;
}

/**
 * 一封可编辑的邮件模板（`GET /sites/{siteID}/email-templates`）。
 *
 * 内置 key：`subscriber_confirm`、`subscriber_welcome`、`newsletter_post`、
 * `password_reset`、`email_verify`。
 */
export interface EmailTemplate {
  key: string;
  name: string;
  subject: string;
  body_html: string;
  body_text: string;
  enabled: boolean;
  /** 内置模板为 true；被站长改写过仍是内置模板，`updated_at` 表示上次改动时间。 */
  builtin: boolean;
  /**
   * 上次被改写的时间；使用内置默认值（从未改写过）时服务端返回 null，
   * 旧后端缺失这个键时按 undefined 处理。
   */
  updated_at?: string | null;
}

/** 邮件发送日志（`GET /sites/{siteID}/email-logs`）。 */
export interface EmailLog {
  id: string;
  to_email: string;
  /** 邮件种类，例如 `newsletter` / `confirm`。 */
  kind: string;
  /** 使用的模板 key；无模板的事务邮件为空。 */
  template_key?: string;
  subject: string;
  status: 'queued' | 'sent' | 'failed';
  error?: string;
  sent_at?: string;
  created_at: string;
}

/** 发送一次 newsletter 的结果（`POST /sites/{siteID}/newsletters`）。 */
export interface NewsletterSendResult {
  /** 本次入队的收件人数；没有 confirmed 订阅者时为 0。 */
  queued: number;
}

/**
 * 当前登录账户自己的订阅状态（`GET /me/newsletter`）。
 *
 * 与 `Subscriber` 不同：这里只暴露当前账户的邮箱与状态，不返回订阅 id 或时间线。
 */
export interface MyNewsletterPreference {
  subscribed: boolean;
  email: string;
  status: SubscriberStatus;
}

/* ------------------------------------------------------------------ *
 * 服务器扩展（安装包扩展）
 *
 * 与「内置扩展」（随前端发布）和「创作者扩展」（站点级 HTML/CSS/JS）都不同：
 * 这里描述的是以 zip 扩展包形式安装到服务端的扩展，由后端启动清单决定是否运行。
 * 字段与 `GET /api/v1/extensions` 的 Extension DTO 一一对应（JSON snake_case）。
 * ------------------------------------------------------------------ */

/** 服务器扩展的安装状态。 */
export type ServerExtensionState = 'installed' | 'enabled' | 'disabled' | 'failed';

/** 前端扩展声明的一个区块类型。 */
export interface ExtensionFrontendBlock {
  type: string;
  name?: string;
}

/** 前端扩展能力：入口脚本、样式、挂载槽位与区块类型。 */
export interface ExtensionFrontendInfo {
  /** 入口脚本的站点内路径（由后端给出，例如 /plugins/{id}/{version}/index.js）。 */
  entry: string;
  styles: string[];
  slots: string[];
  blocks: ExtensionFrontendBlock[];
}

/** 后端扩展声明的一条 HTTP 路由。 */
export interface ExtensionBackendRoute {
  method: string;
  path: string;
  /** 路由要求的授权方式；缺省表示与扩展宿主一致。 */
  auth?: string;
}

/** 后端扩展能力：WASM 宿主路由、钩子与资源限制。 */
export interface ExtensionBackendInfo {
  wasm: boolean;
  routes: ExtensionBackendRoute[];
  hooks?: string[];
  timeout_ms?: number;
  max_memory_mb?: number;
}

/**
 * 一个已安装的服务器扩展。
 *
 * 页面只读这些字段做展示与操作；是否运行由后端启动清单决定，页面不做热加载。
 */
export interface ExtensionSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  author?: string;
  license?: string;
  /** 扩展主页（http/https）。 */
  homepage?: string;
  state: ServerExtensionState;
  enabled: boolean;
  /** 运行时标识，例如 `wasm` / `node` / `none`。 */
  runtime: string;
  /** 扩展申请的权限标识，后端不做本地化。 */
  permissions: string[];
  frontend: ExtensionFrontendInfo | null;
  backend: ExtensionBackendInfo | null;
  /** 安装或启用失败时的最近一次错误。 */
  last_error?: string;
  installed_at?: string;
  enabled_at?: string;
  /**
   * 清单文件的 SHA-256（Beta 1.2，契约 D 节）：安装 / 升级时计算并写入侧车文件。
   * 旧后端不返回，前端按 undefined 处理。
   */
  manifest_hash?: string;
  /**
   * 完整性校验结果（Beta 1.2）：`verified` / `unsigned` / `mismatch`。
   * `mismatch` 时服务端拒绝启用并记录审计，页面应禁用启用开关。
   */
  integrity?: 'verified' | 'unsigned' | 'mismatch';
  /** 最近一次完整性校验通过的时间（RFC 3339）。 */
  verified_at?: string;
}

/**
 * 服务端「真实生效」的部署配置快照（Beta 1.2）。
 *
 * 对访问/域名这类只能部署时决定的配置，生效值来自 API 进程启动时读到的环境变量；
 * 储存策略则可能来自运行期保存并立即应用的值（`storage_source`）。这个结构让页面
 * 能同时显示「计划值」与「生效值」。任何密钥都不在这里出现。
 */
export interface EffectiveStorageScope {
  /** `global` 或四个用途之一。 */
  scope: string;
  driver: string;
  local_dir?: string;
  s3_bucket?: string;
  s3_region?: string;
  s3_prefix?: string;
}

export interface EffectiveConfig {
  storage: EffectiveStorageScope[];
  cors: { allowed_origins: string[]; allow_credentials: boolean };
  domains: { https_only: boolean; public_base_url: string; trusted_proxies: string[] };
  mail: { configured: boolean; encryption?: string; from?: string };
  /** 进程内的生效值与站点配置里的计划值不一致时为 true。 */
  restart_required: boolean;
  /**
   * 储存设置是否已经在当前进程生效（Beta 1.2 运行期应用）。
   *
   * 旧后端不返回这三个字段，页面把 `undefined` 当作「无法判断」处理。
   */
  storage_live?: boolean;
  /** 储存生效值的来源：后台保存的 `data/storage-settings.json`，或部署环境变量。 */
  storage_source?: 'env' | 'saved';
  /** 最近一次应用储存设置的时间（RFC 3339）；来自环境变量时为 null。 */
  storage_updated_at?: string | null;
  captured_at: string;
}
