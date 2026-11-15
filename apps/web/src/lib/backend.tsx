import {
  createContext,
  useContext,
  type ReactNode,
} from 'react';
import type {
  AppEvent,
  Asset,
  AuditLogPage,
  AuditLogQuery,
  AuthProviderId,
  BackupArtifact,
  BackendMode,
  CaptchaScene,
  CaptchaStatus,
  ChangePasswordInput,
  CommentModerationAction,
  CommentPage,
  CommentQuery,
  CommentsResult,
  Content,
  ContentAction,
  ContentKind,
  ContentPage,
  ContentRevision,
  ContentRevisionPage,
  Conversation,
  CreateSiteInput,
  CreatedSite,
  DraftInput,
  ExtensionSummary,
  FollowEntry,
  ImportConflictStrategy,
  InteractionEntry,
  LocalCaptchaAnswer,
  LocalCaptchaChallenge,
  LocalCaptchaSolution,
  Me,
  Member,
  MediaQuotaBytes,
  Message,
  NewMemberInput,
  Notification,
  NotificationPreferences,
  Page,
  PasswordLoginResult,
  PasswordResetPolicy,
  PasswordResetTicket,
  PermissionGroupConfig,
  PermissionGroupInput,
  PlatformAccountPage,
  PlatformAccountQuery,
  PlatformAuditQuery,
  PlatformOverview,
  PlatformSite,
  PlatformSiteDetail,
  PlatformSiteEntry,
  ProbeResult,
  ProfileInput,
  PublicProfile,
  ReadingHistoryEntry,
  Role,
  SafetyPolicy,
  SafetyRateLimit,
  SensitiveWord,
  SensitiveWordMode,
  Session,
  Site,
  SiteDomainVerification,
  SiteDomainVerificationResult,
  SiteImportReport,
  SiteIPRule,
  SystemMetrics,
  StepUpSettings,
  StepUpSettingsUpdate,
  StepUpVerifyResult,
  TaxonomySettings,
  TaxonomyTerm,
  TaxonomyTermInput,
  ToggleResult,
  TwoFactorEnrollment,
  TwoFactorRecoveryCodes,
  TwoFactorStatus,
  User,
  WebConfig,
} from '../types';
import type { AnalyticsRange, BackendAnalytics, VisitSurface } from './analytics';
import { accessController, AccessBlockedError, isPreviewFrame, readAccess } from './access';
import { HttpBackend, ApiError, fallbackProblem } from './api';
import type { SiteCustomizationSaved, SiteCustomizationSnapshot, ContentListOptions } from './api';
import type { SiteConfigSaved, SiteConfigSnapshot } from './siteConfig';
import type { ContactPayload } from './contactForm';
import { DemoBackend } from './demo';
import { t, useT } from './i18n';
import { configurePerformance, readPerformance } from './performance';
import { readDemoStepUpSettings, saveDemoStepUpSettings } from './stepUp';

export const CONFIG_KEY = 'pp.web.config.v1';

export interface Backend {
  mode: BackendMode;
  origin: string;
  probe(): Promise<ProbeResult>;
  register(input: {
    email: string;
    password: string;
    display_name: string;
    captcha_token?: string;
  }): Promise<Session>;
  /**
   * 密码登录。开启了两步验证的账户不会直接拿到会话，而是返回第二步挑战
   * （FSD F-04）；调用方随后用 `loginTwoFactor` 兑换。
   */
  login(input: {
    identifier: string;
    password: string;
    captcha_token?: string;
  }): Promise<PasswordLoginResult>;
  /** 兑换 2FA 挑战：6 位验证码或一次性恢复码。成功后与普通登录一样建立会话。 */
  loginTwoFactor(challengeToken: string, code: string): Promise<Session>;
  /** 自己的两步验证状态（是否开启、恢复码剩余数、绑定时间）。 */
  twoFactorStatus(): Promise<TwoFactorStatus>;
  /** 开始绑定两步验证；需要当前密码。 */
  beginTwoFactorEnrollment(password: string): Promise<TwoFactorEnrollment>;
  /** 确认绑定；恢复码一次性返回。 */
  confirmTwoFactor(code: string): Promise<TwoFactorRecoveryCodes>;
  /** 关闭两步验证；需要当前密码 + 一次有效验证码或恢复码。 */
  disableTwoFactor(input: { password: string; code: string }): Promise<void>;
  /** 重新生成恢复码；旧码全部作废。 */
  regenerateTwoFactorRecoveryCodes(input: {
    password: string;
    code: string;
  }): Promise<TwoFactorRecoveryCodes>;
  /** 平台管理员重置某个成员的两步验证（丢失设备时使用）。 */
  resetMemberTwoFactor(siteId: string, userId: string): Promise<void>;
  /**
   * 站点的高威胁操作保护设置（`GET /sites/{siteID}/step-up`）。
   *
   * 演示后端把开关存在浏览器本地；验证动作不可用时会明确报错。
   */
  stepUpSettings(siteId: string): Promise<StepUpSettings>;
  /** 保存保护设置；已配置过之后再改，调用方需要先 `ensureStepUp()`。 */
  saveStepUpSettings(siteId: string, input: StepUpSettingsUpdate): Promise<StepUpSettings>;
  /** 用密码换取短时二次验证令牌；失败为 403（`step_up_password_rejected`）。 */
  verifyStepUp(password: string): Promise<StepUpVerifyResult>;
  /** 服务端是否已配置 SMTP：决定登录页是否提供找回密码。 */
  passwordResetPolicy(): Promise<PasswordResetPolicy>;
  /** 请求重置链接。无论邮箱是否存在，返回都一样。 */
  requestPasswordReset(email: string, captchaToken?: string): Promise<PasswordResetTicket>;
  /** 用链接里的令牌设置新密码。 */
  resetPassword(input: { token: string; password: string }): Promise<void>;
  /**
   * 人机验证的真实状态：表单据此决定是否渲染组件，设置页据此显示服务端状态。
   *
   * 可选：演示后端与旧后端没有这个端点，调用方按「未启用」处理即可。
   */
  captchaStatus?(): Promise<CaptchaStatus>;
  /**
   * 本地（自托管）人机验证：取一道图形题（滑块 / 点击 / 选择图形）。
   *
   * 可选：只有真实后端实现了本地验证，旧后端与演示后端没有这些端点。
   */
  captchaLocalChallenge?(scene: CaptchaScene): Promise<LocalCaptchaChallenge>;
  /** 本地（自托管）人机验证：提交答案，换一个一次性 token。 */
  captchaLocalVerify?(input: {
    challenge_id: string;
    answer: LocalCaptchaAnswer;
    scene: CaptchaScene;
  }): Promise<LocalCaptchaSolution>;
  /** 仅演示后端：模拟手机 / 第三方登录，以站点管理员身份进入。 */
  demoProviderLogin?(provider: AuthProviderId): Promise<Session>;
  refresh(): Promise<Session>;
  logout(): Promise<void>;
  me(): Promise<Me>;
  /** 登录态自助资料编辑：昵称、简介、头像；头像必须是本人上传的已通过检查的图片。 */
  updateProfile(input: ProfileInput): Promise<User>;
  /** 登录态改密；成功后服务端吊销其它设备的刷新会话，当前会话保留。 */
  changePassword(input: ChangePasswordInput): Promise<void>;
  /** 重新发送邮箱验证邮件；已验证时 already_verified=true。 */
  requestEmailVerification(): Promise<{
    status: 'accepted' | 'already_verified';
    delivery: 'email';
    expires_in: number;
    already_verified: boolean;
  }>;
  /** 兑换邮箱验证链接（公开端点，不需要登录）。 */
  verifyEmail(token: string): Promise<void>;
  /** 后台网站日志：服务端审计查询（时间、操作人、动作、目标、分页）。 */
  auditLogs(siteId: string, query?: AuditLogQuery): Promise<AuditLogPage>;
  site(siteId: string): Promise<Site>;
  updateSite(
    siteId: string,
    patch: Partial<{
      name: string;
      description: string;
      visibility_mode: Site['visibility_mode'];
      publish_mode: Site['publish_mode'];
      domain: string;
      /** O-3：关闭后注册接口返回 403 registration_closed。 */
      registration_open: boolean;
      /** 站点级评论开关；服务端强制执行。 */
      comments_enabled: boolean;
      /** 先审后发；新评论进入待审核队列。 */
      comments_require_review: boolean;
      /** 站点媒体额度；null 表示继承部署默认。 */
      media_quota_bytes: MediaQuotaBytes;
    }>,
  ): Promise<void>;
  /**
   * 内容安全策略：敏感词、IP 黑白名单与评论频率限制。
   *
   * 仅真实后端实现；演示后端没有这些端点，界面只在连接真实后端时展示对应面板。
   */
  safetyPolicy?(siteId: string): Promise<SafetyPolicy>;
  updateSafetyRateLimit?(siteId: string, patch: Partial<SafetyRateLimit>): Promise<SafetyRateLimit>;
  createSensitiveWord?(
    siteId: string,
    input: { word: string; mode: SensitiveWordMode; replacement?: string; enabled?: boolean },
  ): Promise<SensitiveWord>;
  updateSensitiveWord?(
    siteId: string,
    wordId: string,
    patch: Partial<{ mode: SensitiveWordMode; replacement: string; enabled: boolean }>,
  ): Promise<SensitiveWord>;
  deleteSensitiveWord?(siteId: string, wordId: string): Promise<void>;
  createSiteIPRule?(
    siteId: string,
    input: { kind: 'allow' | 'deny'; value: string; note?: string },
  ): Promise<SiteIPRule>;
  deleteSiteIPRule?(siteId: string, ruleId: string): Promise<void>;
  /** 设置主域名；空字符串表示清除域名。保存后进入「待验证」状态。 */
  setSiteDomain(siteId: string, domain: string): Promise<void>;
  /** 读取主域名与 TXT 归属验证信息（V-12）。 */
  siteDomain(siteId: string): Promise<SiteDomainVerification>;
  /** 立即验证主域名归属；失败抛 ApiError（problem.details.reason 说明原因）。 */
  verifySiteDomain(siteId: string): Promise<SiteDomainVerificationResult>;
  /**
   * 平台控制台：列出部署内全部站点。
   *
   * 仅平台管理员（当前站点上的 platform_admin）可用；演示后端只有单站点。
   */
  platformSites(): Promise<PlatformSite[]>;
  /** 平台控制台：新建站点，同时创建默认设计文档与第一个管理员。 */
  createPlatformSite(input: CreateSiteInput): Promise<CreatedSite>;
  /** 平台控制台：读取某个站点（平台管理员或该站点管理员）。 */
  platformSite(siteId: string): Promise<PlatformSiteDetail>;
  /** 平台控制台：兑换主域名 TXT 挑战（新建站点在验证前无法通过主机名访问）。 */
  verifyPlatformSiteDomain(siteId: string): Promise<SiteDomainVerification>;
  /**
   * 平台控制台：申请进入某个站点。
   *
   * 返回交接令牌；当前站点直接可进，其它站点需把令牌交给目标源兑换会话。
   */
  enterPlatformSite(siteId: string): Promise<PlatformSiteEntry>;
  /** 平台总览：部署级计数、异常信号、每站一个快照与最近的跨站审计行。 */
  platformOverview(windowDays?: number): Promise<PlatformOverview>;
  /** 跨站审计：`site_id` 省略表示全部站点，游标分页。 */
  platformAuditLogs(query?: PlatformAuditQuery): Promise<AuditLogPage>;
  /** 平台用户目录：全部署账户或某个站点的成员（只读，不含任何密钥）。 */
  platformAccounts(query?: PlatformAccountQuery): Promise<PlatformAccountPage>;
  /**
   * 在目标站点源兑换交接令牌。成功后与密码登录一样建立会话（HttpOnly 刷新
   * Cookie + 内存访问令牌），前端随后按 `/me` 重新水合。
   */
  claimSiteSwitch(switchToken: string): Promise<Session>;
  /**
   * 站点设计（主题、页面、扩展、SEO）的服务端副本。
   * 404 视为“远端还没有设计”，返回 null；401 / 403 由调用方吞掉。
   */
  siteCustomization(siteId: string): Promise<SiteCustomizationSnapshot | null>;
  /** 保存站点设计；`revision` 是最后看到的版本，省略表示无条件写入。409 表示版本冲突。 */
  saveSiteCustomization(
    siteId: string,
    customization: unknown,
    revision?: number,
  ): Promise<SiteCustomizationSaved>;
  /**
   * 站点级配置（访问限制、域名、性能、加载动画、登录方式）的服务端副本。
   * 404 视为“远端还没有配置”，返回 null；访客拿到公开子集，管理员拿到完整文档。
   */
  siteConfig(siteId: string): Promise<SiteConfigSnapshot | null>;
  /** 保存站点配置；`revision` 省略表示无条件写入。409 表示版本冲突。 */
  saveSiteConfig(
    siteId: string,
    config: unknown,
    revision?: number,
  ): Promise<SiteConfigSaved>;
  members(siteId: string): Promise<Member[]>;
  /** 能力组列表。演示后端与旧后端没有这个端点，调用方回退到本地镜像。 */
  permissionGroups?(siteId: string): Promise<PermissionGroupConfig[]>;
  /** 新建或整组更新一个能力组；成功返回服务端规范化后的值。 */
  savePermissionGroup?(
    siteId: string,
    key: string,
    input: PermissionGroupInput,
  ): Promise<PermissionGroupConfig>;
  /** 把成员移入能力组；服务端同时更新组标识与基础角色。 */
  assignMemberGroup?(siteId: string, userId: string, groupKey: string): Promise<void>;
  /** 创建账户。个人博客下 role 固定为 site_admin。 */
  createMember(siteId: string, input: NewMemberInput): Promise<Member>;
  setMemberRole(siteId: string, userId: string, role: Role): Promise<void>;
  /** 设置成员媒体额度；null 表示继承站点或部署默认。 */
  setMemberQuota(siteId: string, userId: string, mediaQuotaBytes: MediaQuotaBytes): Promise<Member>;
  /** 平台管理员编辑更低等级成员的基础资料。 */
  updateMember(
    siteId: string,
    userId: string,
    patch: { display_name?: string; email?: string },
  ): Promise<Member>;
  /** 平台管理员停用 / 启用更低等级成员。 */
  setMemberStatus(
    siteId: string,
    userId: string,
    status: 'active' | 'suspended',
  ): Promise<Member>;
  /** 平台管理员删除更低等级成员。 */
  deleteMember(siteId: string, userId: string): Promise<void>;
  /** 作者归档：公开作者资料（不包含邮箱）。 */
  publicUser(userId: string): Promise<PublicProfile>;
  listContent(
    kind: ContentKind,
    options?: ContentListOptions,
  ): Promise<ContentPage>;
  getContent(kind: ContentKind, id: string): Promise<Content>;
  /**
   * 热门内容：服务端按阅读量 + 时间衰减排序的已发布公开内容（FSD A-16）。
   *
   * 侧栏「热门 Top5」、仪表盘热门文章与内容区块的热门模式都用它，而不是本地访问
   * 记录：本地记录只覆盖当前浏览器，用它排序会把「我看过的」当成「大家看过的」。
   */
  popularContent(
    options?: import('./api').PopularContentOptions,
  ): Promise<import('../types').PopularContentPage>;
  /** 密码文章解锁（C-18）；成功后服务端写入 HttpOnly Cookie。 */
  unlockContent(
    kind: ContentKind,
    id: string,
    password: string,
  ): Promise<import('../types').ContentUnlockResult>;
  createDraft(kind: ContentKind, input: DraftInput): Promise<Content>;
  updateDraft(kind: ContentKind, id: string, input: DraftInput): Promise<Content>;
  contentAction(
    kind: ContentKind,
    id: string,
    action: ContentAction,
    reason?: string,
  ): Promise<Content>;
  /** 版本历史列表（服务端保留最新 20 版）。 */
  contentRevisions(kind: ContentKind, id: string): Promise<ContentRevisionPage>;
  /** 单个版本的完整快照，包含源文。 */
  contentRevision(kind: ContentKind, id: string, revisionId: string): Promise<ContentRevision>;
  /** 回滚到指定版本；服务端先备份当前版本，回滚不改变发布状态。 */
  restoreContentRevision(kind: ContentKind, id: string, revisionId: string): Promise<Content>;
  /**
   * 全文检索：相关度排序 + 真实游标分页 + 服务端筛选。
   *
   * 返回 total（全量命中数）与 next_cursor；筛选条件不合法时服务端返回 400，
   * 而不是忽略它。
   */
  search(q: string, options?: import('../types').SearchQuery): Promise<import('../types').SearchResult>;
  comments(targetType: string, targetId: string): Promise<CommentsResult>;
  /** 后台评论列表：状态筛选、搜索与分页。 */
  allComments(query?: CommentQuery): Promise<CommentPage>;
  /** 审核动作：通过 / 驳回 / 隐藏 / 删除。 */
  moderateComment(id: string, action: CommentModerationAction): Promise<void>;
  /** 举报内容或账户。 */
  report(input: import('../types').ReportInput): Promise<import('../types').Report>;
  /** 后台举报队列。 */
  reports(): Promise<import('../types').Report[]>;
  assignReport(id: string): Promise<import('../types').Report>;
  resolveReport(
    id: string,
    action: import('../types').ReportAction,
    note?: string,
  ): Promise<import('../types').Report>;
  createComment(
    input: {
      target_type: 'article' | 'post' | 'comment' | 'page';
      target_id: string;
      parent_id?: string;
      body: string;
      /** 站点开启评论人机验证时，表单提交上来的 token。 */
      captcha_token?: string;
    },
    /**
     * 站点评论策略。演示后端据此决定是否先审后发；真实后端以服务端策略为准，
     * 会忽略这个提示。
     */
    policy?: { require_review?: boolean },
  ): Promise<import('../types').Comment>;
  updateComment(id: string, body: string): Promise<import('../types').Comment>;
  deleteComment(id: string): Promise<void>;
  toggleReaction(
    targetType: 'article' | 'post' | 'comment',
    targetId: string,
    kind?: 'like' | 'love' | 'insightful',
    active?: boolean,
  ): Promise<ToggleResult>;
  toggleBookmark(
    targetType: 'article' | 'post',
    targetId: string,
    active?: boolean,
  ): Promise<ToggleResult>;
  toggleFollow(userId: string, active?: boolean): Promise<ToggleResult>;
  stateFor(
    targetType: string,
    targetId: string,
    userId?: string,
  ): Promise<{ liked: boolean; bookmarked: boolean; following: boolean }>;
  /** 列表批量状态：已赞 / 已收藏 / 已关注。 */
  interactionStates(
    targetType: string,
    targetIds: string[],
    authorIds?: string[],
  ): Promise<import('../types').InteractionStates>;
  /** 我的收藏。 */
  bookmarks(options?: import('./api').InteractionListOptions): Promise<Page<InteractionEntry>>;
  /** 我的点赞。 */
  likes(options?: import('./api').InteractionListOptions): Promise<Page<InteractionEntry>>;
  /** 阅读历史。 */
  readingHistory(
    options?: import('./api').InteractionListOptions,
  ): Promise<Page<ReadingHistoryEntry>>;
  /** 记录一次阅读；失败不影响正文展示。 */
  recordReading(targetType: 'article' | 'post', targetId: string): Promise<void>;
  /** 我关注的人。 */
  following(options?: import('./api').InteractionListOptions): Promise<Page<FollowEntry>>;
  /** 关注我的人。 */
  followers(options?: import('./api').InteractionListOptions): Promise<Page<FollowEntry>>;
  /** 仅登录可见的成员目录。 */
  memberDirectory(
    options?: import('./api').MemberDirectoryOptions,
  ): Promise<PublicProfile[]>;
  upload(
    file: File,
    purpose: 'content' | 'avatar' | 'attachment' | 'site',
    onProgress?: (percent: number) => void,
  ): Promise<Asset>;
  listAssets(): Promise<Asset[]>;
  /**
   * 取一个可以直接放进 `<img src>` 的媒体展示地址。
   *
   * 站内媒体读取端点对 content 素材要求登录，而 `<img>` 带不上 Authorization：
   * 真实后端先带令牌取字节再换成 blob: 地址；演示模式与 data:/外链原样返回。
   */
  assetSrc(url: string): Promise<string>;
  conversations(): Promise<Conversation[]>;
  /** 发起私信或群聊；调用者一定是成员。 */
  createConversation(memberIds: string[]): Promise<Conversation>;
  messages(conversationId: string, limit?: number): Promise<Message[]>;
  sendMessage(conversationId: string, body: string): Promise<Message>;
  markConversationRead(conversationId: string, messageId: string): Promise<{ advanced: boolean }>;
  notifications(): Promise<{ items: Notification[]; unread: number }>;
  markNotificationRead(id: string): Promise<Notification>;
  markAllNotificationsRead(): Promise<number>;
  notificationPreferences(): Promise<NotificationPreferences>;
  updateNotificationPreferences(input: NotificationPreferences): Promise<NotificationPreferences>;
  /**
   * 联系表单：匿名提交一次留言。
   *
   * 服务端把它变成站长信箱里的一条通知，除此之外不存任何东西。演示模式不发请求
   * （渲染器直接进入成功态），这里只是为了接口完整。
   */
  contactSite(siteId: string, input: ContactPayload): Promise<void>;
  /** 记录一次站点访问；真实后端落库，演示模式由本地分析记录。 */
  recordVisit(input: {
    path: string;
    title: string;
    referrer: string;
    session: string;
    surface: VisitSurface;
  }): Promise<void>;
  /** 真实后端统计；端点不可用时返回 null，仪表盘回退到本地统计。 */
  analytics(siteId: string, range: AnalyticsRange): Promise<BackendAnalytics | null>;
  /** 真实后端分类/标签；端点不可用时返回 null。 */
  taxonomy(siteId: string): Promise<TaxonomySettings | null>;
  createTaxonomyTerm(siteId: string, input: TaxonomyTermInput): Promise<TaxonomyTerm>;
  updateTaxonomyTerm(siteId: string, termId: string, input: TaxonomyTermInput): Promise<TaxonomyTerm>;
  deleteTaxonomyTerm(siteId: string, termId: string): Promise<void>;
  docsUrl(): string;
  /**
   * 实时通道：申请一张一次性 WebSocket 票据。
   *
   * 只有真实后端实现（`HttpBackend`），演示后端没有；前端据方法是否存在决定
   * 是否建立长连接，不存在时退回 45 秒轮询。
   */
  wsTicket?(): Promise<{ ticket: string; expires_at: string; url: string }>;
  /** 断线补偿：按事件 id 拉取之后的事件；同样只有真实后端实现。 */
  events?(afterId?: string, limit?: number): Promise<Page<AppEvent>>;
  /** 实例备份：只有真实后端实现，且服务端要求平台管理员。 */
  createBackup?(): Promise<BackupArtifact>;
  backups?(): Promise<BackupArtifact[]>;
  downloadBackup?(id: string): Promise<{ blob: Blob; filename: string }>;
  /** 全站内容导出；演示后端没有真实文件可导。 */
  exportSite?(
    siteId: string,
    options?: { publishedOnly?: boolean },
  ): Promise<{ blob: Blob; filename: string }>;
  /** 全站导入；返回逐条报告。 */
  importSite?(
    siteId: string,
    file: File,
    options?: { conflict?: ImportConflictStrategy },
  ): Promise<SiteImportReport>;
  /**
   * 性能面板：本机与服务端进程的资源快照。
   *
   * 可选模块：部署关掉后端路由时请求会 404，页面据此提示模块未启用；演示模式没有
   * 服务端可采样，演示后端明确报错，不伪造数字。
   */
  systemMetrics(): Promise<SystemMetrics>;
  /**
   * 服务器扩展管理（安装包扩展）。
   *
   * 全部可选：演示模式没有服务端安装目录，旧后端也还没有这些端点，页面据此显示
   * 「演示模式没有服务器扩展」或「接口未就绪」，而不是崩溃或伪造列表。
   * 只有平台管理员可调用；站点管理员看到只读说明。
   */
  listExtensions?(): Promise<ExtensionSummary[]>;
  /** 导入一个 zip 扩展包；坏包由服务端返回 400 problem。 */
  importExtension?(file: File): Promise<ExtensionSummary>;
  /** 启用 / 禁用；是否真正运行仍由后端启动清单决定，页面只提示刷新生效。 */
  setExtensionEnabled?(id: string, enabled: boolean): Promise<ExtensionSummary>;
  /** 删除已安装的扩展包。 */
  deleteExtension?(id: string): Promise<void>;
}

export function loadConfig(): WebConfig | null {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as WebConfig;
    if (parsed?.version !== 1 || !parsed.setup_complete) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveConfig(config: WebConfig) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(config));
}

export function clearConfig() {
  localStorage.removeItem(CONFIG_KEY);
}

/** 安装配置与服务端对不上时写给安装引导的提示；安装完成后清掉。 */
export const INSTALL_RESET_KEY = 'pp.setup.reset';

export type InstallVerdict = 'ok' | 'stale' | 'unknown';

/** `/api/v1/setup/status` 的公开响应；安装校验与匿名访客引导（O-1）共用。 */
export interface SetupStatus {
  installed?: boolean;
  has_admin?: boolean;
  reason?: string;
  site_id?: string;
  site_name?: string;
  /** O-3：站点是否开放自助注册；旧后端不返回时按开放处理。 */
  registration_open?: boolean;
}

export interface ProbeSetupStatusOptions {
  /** 注入 fetch 便于测试；默认全局 fetch。 */
  fetchImpl?: typeof fetch;
  /** 请求超时（毫秒）。 */
  timeoutMs?: number;
}

/**
 * 读取服务端公开的安装状态。
 *
 * `base` 为空时按同源相对地址请求（开发代理与启动器都走同源）。网络错误、非 2xx、
 * 响应不是对象一律返回 null：安装校验与匿名访客引导各自决定回退策略（前者保留
 * 本地配置，后者回退安装引导）。
 */
export async function probeSetupStatus(
  base: string,
  options: ProbeSetupStatusOptions = {},
): Promise<SetupStatus | null> {
  const { fetchImpl = fetch, timeoutMs = 3000 } = options;
  const normalized = base.trim().replace(/\/+$/, '');
  try {
    const res = await fetchImpl(`${normalized}/api/v1/setup/status`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      credentials: 'include',
      signal:
        typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(timeoutMs)
          : undefined,
    });
    if (!res.ok) return null;
    const status = (await res.json()) as unknown;
    return status && typeof status === 'object' ? (status as SetupStatus) : null;
  } catch {
    return null;
  }
}

/**
 * 检查本地记着的这次安装，服务端是否还认得。
 *
 * 安装状态存在两处：服务端的 data 目录，以及浏览器的 localStorage。删掉 data、
 * 或者换了一份数据目录时，服务端已经是全新站点，但浏览器仍然认为装好了——页面会
 * 直接渲染一个空站点，安装引导再也进不去。
 *
 * 只有服务端给出明确答复才判 stale：断网、老版本 API、临时故障一律 unknown，
 * 保留用户配置。误清一次配置等于让用户重装，代价远高于多渲染一次空站点。
 */
export async function verifyInstall(config: WebConfig): Promise<InstallVerdict> {
  if (config.mode !== 'live') return 'ok';

  const status = await probeSetupStatus(config.api_base);
  if (!status) return 'unknown';

  // 站点在，只是这个域名没通过验证：重装解决不了，也不能清配置。
  if (status.reason === 'domain_unverified') return 'ok';
  if (status.installed === false) return 'stale';
  if (typeof status.site_id === 'string' && status.site_id !== config.site_id) return 'stale';
  // has_admin 只作为排查信息：服务端部署的首个账户本来就是普通成员，
  // 用它触发重置会让向导反复重来。安装引导在注册步骤另有角色校验。
  return 'ok';
}

/**
 * 演示后端的高威胁操作保护。
 *
 * 演示数据只存在浏览器里，没有服务端守卫：开关存本地并如实展示；专用密码不保存
 * （不把明文或伪哈希落盘），验证动作明确报错，而不是伪造一次“校验通过”。
 */
class DemoStepUpBackend extends DemoBackend {
  async stepUpSettings(_siteId: string): Promise<StepUpSettings> {
    return readDemoStepUpSettings();
  }

  async saveStepUpSettings(
    _siteId: string,
    input: StepUpSettingsUpdate,
  ): Promise<StepUpSettings> {
    if (input.password) {
      throw new ApiError({
        ...fallbackProblem(400),
        code: 'validation_failed',
        title: t('演示模式不保存专用密码'),
        message: t('演示模式不保存专用密码；连接真实后端后再设置，或直接使用账户登录密码。'),
      });
    }
    return saveDemoStepUpSettings(input);
  }

  async verifyStepUp(_password: string): Promise<StepUpVerifyResult> {
    throw new ApiError({
      ...fallbackProblem(403),
      code: 'permission_denied',
      title: t('演示模式不校验二次密码'),
      message: t('演示模式没有服务端安全校验，无法验证密码；连接真实后端后才会真正校验。'),
      details: { reason: 'demo_mode' },
    });
  }
}

/** 这些方法不发出请求，不能被包装成 Promise，也不能计入请求限制。 */
const NON_REQUEST_METHODS = new Set<string>([
  'docsUrl',
  'setSiteKind',
  'applySession',
  'clearSession',
]);

/**
 * 在 Backend 外面套一层请求限制。
 *
 * 演示后端也会经过这里，所以访问限制在演示模式同样可以复现。管理后台、安装向导
 * 与编排预览 iframe 由 AccessController 直接放行，站长始终能回到后台关闭保护。
 */
function withAccessGuard(backend: Backend): Backend {
  return new Proxy(backend, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (typeof prop !== 'string' || NON_REQUEST_METHODS.has(prop)) {
        return value.bind(target);
      }
      return (...args: unknown[]): Promise<unknown> => {
        if (isPreviewFrame()) {
          return (value as (...inner: unknown[]) => Promise<unknown>).apply(target, args);
        }
        const pathname =
          typeof window !== 'undefined' ? window.location.pathname : '/';
        const decision = accessController.beforeRequest(pathname);
        if (!decision.allowed) {
          return Promise.reject(new AccessBlockedError(decision));
        }
        return (value as (...inner: unknown[]) => Promise<unknown>).apply(target, args);
      };
    },
  }) as Backend;
}

export function createBackend(config: WebConfig, onExpired: () => void): Backend {
  accessController.configure(readAccess(config), config.admin_path);
  configurePerformance(readPerformance(config));
  const backend =
    config.mode === 'demo'
      ? new DemoStepUpBackend()
      : new HttpBackend({ base: config.api_base, onExpired });
  return withAccessGuard(backend);
}

export function isDemo(backend: Backend): backend is DemoStepUpBackend {
  return backend instanceof DemoBackend;
}

const BackendContext = createContext<Backend | null>(null);

export function BackendProvider({ backend, children }: { backend: Backend; children: ReactNode }) {
  return <BackendContext.Provider value={backend}>{children}</BackendContext.Provider>;
}

export function useBackend(): Backend {
  const t = useT();
  const value = useContext(BackendContext);
  if (!value) throw new Error(t('useBackend 必须在 BackendProvider 内使用'));
  return value;
}
