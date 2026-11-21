import type {
  ActivityEntry,
  Asset,
  AuditLog,
  AuditLogPage,
  AuditLogQuery,
  AuthProviderId,
  BackupSchedule,
  BulkAction,
  BulkResult,
  BulkResultItem,
  CaptchaStatus,
  ChangePasswordInput,
  CommentModerationAction,
  CommentPage,
  CommentQuery,
  CommentsResult,
  Content,
  ContentAction,
  ContentDiff,
  ContentDiffHunk,
  ContentKind,
  ContentPage,
  ContentRevision,
  ContentRevisionPage,
  Conversation,
  CreateSiteInput,
  CreatedSite,
  DiffOp,
  DraftInput,
  EmailLog,
  EmailTemplate,
  FollowEntry,
  InteractionEntry,
  InteractionStates,
  Me,
  Member,
  MediaQuotaBytes,
  Message,
  MyNewsletterPreference,
  NewMemberInput,
  NewsletterSendResult,
  NewsletterStats,
  NewsletterSubscriptionStatus,
  Notification,
  NotificationPreferences,
  Page,
  PasswordLoginResult,
  PasswordResetPolicy,
  PasswordResetTicket,
  PhoneCodeResult,
  PhonePolicy,
  PlatformAccountPage,
  PlatformAccountQuery,
  PlatformActivityRow,
  PlatformAuditQuery,
  PlatformOverview,
  PlatformSite,
  PlatformSiteDetail,
  PlatformSiteEntry,
  PreviewGrant,
  ProbeResult,
  ProfileInput,
  PublicProfile,
  ReadingHistoryEntry,
  RedirectRule,
  Report,
  ReportAction,
  ReportInput,
  ResolveResult,
  Role,
  SearchQuery,
  SearchResult,
  Session,
  Site,
  SiteActivityItem,
  SiteDomainVerification,
  SiteDomainVerificationResult,
  Subscriber,
  SubscriberStatus,
  SystemLogEntry,
  SystemMetrics,
  StorageApplyRequest,
  StorageRuntimeAllocation,
  StorageStatus,
  EffectiveConfig,
  TaxonomySettings,
  TaxonomyTerm,
  TaxonomyTermInput,
  ToggleResult,
  TwoFactorEnrollment,
  TwoFactorRecoveryCodes,
  TwoFactorStatus,
  User,
} from '../types';
import type { AnalyticsRange, VisitSurface } from './analytics';
import { ApiError, fallbackProblem, uuid } from './api';
import type {
  SiteAnalytics,
  SiteCustomizationSaved,
  SiteCustomizationSnapshot,
} from './api';
import type { SiteConfigSaved, SiteConfigSnapshot } from './siteConfig';
import type { ContactPayload } from './contactForm';
import { readCaptchaStatus } from './captcha';
import { canReview, ROLE_RANK } from './format';
import { contentSlugFromTitle, isValidContentSlug } from './contentSlug';
import { passwordCreationProblem, passwordProblemText } from './passwordPolicy';
import { htmlToText, renderSource } from './markdown';
import {
  applyDemoTaxonomy,
  createSeed,
  roleOf,
  toMember,
  toPublicUser,
  type DemoComment,
  type DemoContent,
  type DemoRevision,
  type DemoState,
  type DemoUser,
} from './demoSeed';

const STATE_KEY = 'pp.demo.state.v1';
const CURRENT_KEY = 'pp.demo.current.v1';
const RESET_KEY = 'pp.demo.reset.v1';
const RESET_TTL_MS = 30 * 60 * 1000;

/**
 * 演示活动日志只有中文标签，没有真实的 audit_logs 动作码。
 *
 * 后台「网站日志」统一按服务端动作码筛选，所以演示模式在这里把常见标签映射回
 * 与真实后端一致的动作码；映射不到的历史记录保留原标签，仍可被显示与搜索。
 */
const DEMO_ACTION_CODES: Record<string, string> = {
  注册账户: 'auth.registered',
  登录: 'auth.login',
  退出登录: 'auth.logout',
  重置密码: 'auth.password_changed',
  请求重置密码: 'auth.password_changed',
  修改站点设置: 'site.settings.updated',
  修改访问限制: 'site.settings.updated',
  验证主域名: 'site.domain.verified',
  调整成员角色: 'site.member.role_changed',
  编辑成员资料: 'site.member.profile_updated',
  停用成员账户: 'site.member.status_changed',
  启用成员账户: 'site.member.status_changed',
  删除成员账户: 'site.member.removed',
  修改成员媒体额度: 'site.member.media_quota_updated',
  创建草稿: 'content.created',
  更新草稿: 'content.updated',
  发布: 'content.published',
  撤销发布: 'content.unpublished',
  退回: 'content.rejected',
  归档: 'content.archived',
  恢复: 'content.restored',
  提交审核: 'content.submitted',
  重试安全检查: 'content.published',
  回滚版本: 'content.rollback',
  发表评论: 'community.comment.created',
  提交评论待审: 'community.comment.created',
  编辑评论: 'community.comment.edited',
  删除评论: 'community.comment.deleted',
  通过评论: 'community.comment.moderated',
  隐藏评论: 'community.comment.moderated',
  提交举报: 'moderation.report.created',
  忽略举报: 'moderation.report.ignored',
  举报下架内容: 'moderation.report.takedown',
  举报封禁账户: 'moderation.report.ban',
  创建账户: 'site.member.created',
  上传媒体: 'media.uploaded',
  模拟第三方登录: 'auth.login',
};

/** 演示模式的重置票据：令牌 -> 账户与过期时间。真实环境由服务端存储哈希。*/
type DemoTicket = Record<string, { user_id: string; expires_at: number }>;

function demoTargetType(action: string): string {
  if (action.startsWith('auth.')) return 'user';
  if (action.startsWith('site.member.')) return 'site_member';
  if (action.startsWith('site.settings.') || action.startsWith('site.domain.')) return 'site';
  if (action.startsWith('site.customization.')) return 'site_customization';
  if (action.startsWith('content.')) return 'article';
  if (action.startsWith('community.comment.')) return 'comment';
  if (action.startsWith('moderation.report.')) return 'moderation_report';
  if (action.startsWith('platform.site.')) return 'site';
  return '';
}

function loadTickets(): DemoTicket {
  try {
    const raw = localStorage.getItem(RESET_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as DemoTicket;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

const MIME_ALLOWED = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
  'text/plain',
];

const DEMO_UPLOAD_LIMIT = 2 * 1024 * 1024;

function wait(ms = 140): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 演示后端的纯文本片段。
 *
 * 与真实后端一致：只看正文纯文本，在首个命中附近取一段，省略号表示被截断。
 * 输出里不会出。HTML —。高亮由页面自己按查询词切片，所以片段必须是纯文本。
 */
const DEMO_SNIPPET_RUNES = 160;

function demoSnippet(item: DemoContent, term: string): string {
  const body = htmlToText(item.rendered_html ?? '');
  const text = body || item.summary || '';
  if (!text) return '';
  const runes = Array.from(text);
  if (runes.length <= DEMO_SNIPPET_RUNES) return text;

  const lower = text.toLowerCase();
  const hit = term ? lower.indexOf(term) : -1;
  let start = 0;
  if (hit >= 0) {
    // 命中的字符位置换算成码点位置，避免截断代理对。
    start = Array.from(lower.slice(0, hit)).length - Math.floor(DEMO_SNIPPET_RUNES / 3);
    if (start < 0) start = 0;
  }
  const end = Math.min(runes.length, start + DEMO_SNIPPET_RUNES);
  const slice = runes.slice(start, end).join('').trim();
  return `${start > 0 ? '…' : ''}${slice}${end < runes.length ? '…' : ''}`;
}

function loadState(): DemoState | null {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as DemoState;
    return parsed?.version === 1 ? parsed : null;
  } catch {
    return null;
  }
}

export interface DemoConfigureInput {
  admin: { email: string; display_name: string; password: string };
  site: {
    name: string;
    domain: string;
    description: string;
    visibility_mode: Site['visibility_mode'];
    publish_mode: Site['publish_mode'];
    /** O-3：演示模式同样支。关闭注册"，缺省按开放处理。*/
    registration_open?: boolean;
  };
}

/** 演示模式固定。6 位验证码：任何账户开启两步验证后用它完成第二步。*/
const DEMO_TOTP_CODE = '123456';
const DEMO_TOTP_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** 演示。base32 串：真实后端。crypto/rand 生成，这里只要看起来与手动录入一致。*/
function demoBase32(length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += DEMO_TOTP_ALPHABET[Math.floor(Math.random() * DEMO_TOTP_ALPHABET.length)];
  }
  return out;
}

/** 演示用恢复码。2 位一组，展示。XXXXXX-XXXXXX。*/
function demoRecoveryCode(): string {
  const raw = demoBase32(12);
  return `${raw.slice(0, 6)}-${raw.slice(6)}`;
}

/** 本地演示后端：语义与 OpenAPI 契约一致，数据保存在浏览器。*/
/**
 * 演示用的阅读量：按内容 id 稳定生成一个可读的数字。
 *
 * 演示数据没有服务端计数，用 id 派生才能保证刷新前后一致。真实后端返回的
 * `view_count` 是服务端去重后的真实值，这里的数字只服务于演示模式。
 */
function demoViewCount(id: string): number {
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) {
    hash = (hash * 31 + id.charCodeAt(index)) % 100_000;
  }
  return 18 + (hash % 1400);
}

/** 演示用的热门得分：与服务端同一条公式，阅读量除以发布小时数 + 2 的 1.5 次方。 */
function demoPopularScore(item: Content): number {
  const published = new Date(item.published_at ?? item.created_at).getTime();
  const hours = Number.isNaN(published) ? 0 : Math.max(0, (Date.now() - published) / 3_600_000);
  return (item.view_count ?? 0) / (hours + 2) ** 1.5;
}

/* ------------------ Beta 1.2 演示数据辅助 ------------------ */

/** 演示模式的短信验证码：与登录页提示保持一致，固定六位。 */
const DEMO_SMS_CODE = '246810';

/** 短信验证码有效期（秒），与契约默认值一致。 */
const DEMO_SMS_TTL_SECONDS = 300;

/** 预览令牌有效期（毫秒）：契约默认 30 分钟。 */
const DEMO_PREVIEW_TTL_MS = 30 * 60 * 1000;

/** diff 最多比较的行数：契约把超长文本截断到前 20000 行。 */
const DEMO_DIFF_MAX_LINES = 20_000;

/**
 * 演示用的行级 diff。
 *
 * 先用最长公共子序列求出两边的行序列，再按契约的 hunk 形状输出：`from_line` /
 * `to_line` 是 1 起始行号，insert / delete 的另一侧取前一条已消费的行号（开头为 0）。
 * 行数乘积过大时 LCS 的二次开销不可接受，退化成「整段先删后插」——形状仍然合法，
 * 演示数据也不会走到那里。
 */
function demoLineDiff(fromLines: string[], toLines: string[]): ContentDiffHunk[] {
  const a = fromLines.slice(0, DEMO_DIFF_MAX_LINES);
  const b = toLines.slice(0, DEMO_DIFF_MAX_LINES);
  const rows = a.length;
  const cols = b.length;
  const hunks: ContentDiffHunk[] = [];
  let fromLine = 0;
  let toLine = 0;

  if (rows * cols > 1_000_000) {
    for (const text of a) {
      fromLine += 1;
      hunks.push({ op: 'delete', from_line: fromLine, to_line: toLine, text });
    }
    for (const text of b) {
      toLine += 1;
      hunks.push({ op: 'insert', from_line: fromLine, to_line: toLine, text });
    }
    return hunks;
  }

  const lcs: number[][] = Array.from({ length: rows + 1 }, () =>
    new Array<number>(cols + 1).fill(0),
  );
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      lcs[i][j] =
        a[i] === b[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  let i = 0;
  let j = 0;
  const push = (op: DiffOp, text: string, from: number, to: number) =>
    hunks.push({ op, from_line: from, to_line: to, text });
  while (i < rows && j < cols) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
      fromLine = i;
      toLine = j;
      push('equal', a[i - 1], fromLine, toLine);
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      i += 1;
      fromLine = i;
      push('delete', a[i - 1], fromLine, toLine);
    } else {
      j += 1;
      toLine = j;
      push('insert', b[j - 1], fromLine, toLine);
    }
  }
  while (i < rows) {
    i += 1;
    fromLine = i;
    push('delete', a[i - 1], fromLine, toLine);
  }
  while (j < cols) {
    j += 1;
    toLine = j;
    push('insert', b[j - 1], fromLine, toLine);
  }
  return hunks;
}

/** 演示模式的重定向规则：一条 slug 变更自动规则 + 一条手写规则。 */
function demoSeedRedirects(): RedirectRule[] {
  const now = new Date().toISOString();
  return [
    {
      id: 'redir_demo_1',
      from_path: '/a/old-house',
      to_path: '/a/cnt_house',
      status_code: 301,
      source: 'slug_change',
      hit_count: 12,
      created_at: now,
      updated_at: now,
    },
    {
      id: 'redir_demo_2',
      from_path: '/archive',
      to_path: '/articles',
      status_code: 302,
      source: 'manual',
      hit_count: 3,
      created_at: now,
      updated_at: now,
    },
  ];
}

/** 演示模式的五个内置邮件模板（与契约 N4 的内置 key 一致）。 */
const DEMO_EMAIL_TEMPLATES: {
  key: string;
  name: string;
  subject: string;
  body_text: string;
}[] = [
  {
    key: 'subscriber_confirm',
    name: '订阅确认',
    subject: '确认订阅 Practacu Press',
    body_text: '点击链接确认订阅：{link}',
  },
  {
    key: 'subscriber_welcome',
    name: '欢迎订阅',
    subject: '欢迎成为读者',
    body_text: '谢谢你订阅 Practacu Press。',
  },
  {
    key: 'newsletter_post',
    name: '文章推荐',
    subject: '新文章：{title}',
    body_text: '{summary}\n{url}',
  },
  {
    key: 'password_reset',
    name: '重置密码',
    subject: '重置你的密码',
    body_text: '点击链接重置密码：{link}',
  },
  {
    key: 'email_verify',
    name: '邮箱验证',
    subject: '验证你的邮箱',
    body_text: '点击链接完成验证：{link}',
  },
];

/** 演示模式的四个储存用途；与 `lib/storage.ts` 的 `STORAGE_SCOPES` 顺序一致。 */
const DEMO_STORAGE_SCOPES = ['content', 'site', 'avatar', 'attachment'] as const;

/** 演示模式默认的那套本地策略 id；与 `DEFAULT_STRATEGY_ID` 保持一致。 */
const DEMO_STORAGE_STRATEGY_ID = 'local';

/**
 * 构造演示模式的储存状态。
 *
 * 没有 `request` 时是默认的一套本地策略（来源 = 部署环境变量）；有 `request`
 * 时按刚提交的设置回显。演示模式没有服务端计量，`used_bytes` 一律为 0；
 * `current` 标在写入顺序的第一套上（单策略只有一套，多策略从第一套开始写）。
 */
function demoStorageStatus(
  source: StorageStatus['source'],
  request?: StorageApplyRequest,
): StorageStatus {
  const strategies = request
    ? request.strategies.map((strategy) => ({
        id: strategy.id,
        name: strategy.name,
        driver: strategy.driver,
        local_dir: strategy.local_dir,
        s3_bucket: strategy.s3_bucket,
        s3_prefix: strategy.s3_prefix,
        s3_endpoint: strategy.s3_endpoint,
        s3_region: strategy.s3_region,
        has_access_key: strategy.s3_access_key.trim() !== '',
        has_secret: Boolean(strategy.s3_secret_key?.trim()),
      }))
    : [
        {
          id: DEMO_STORAGE_STRATEGY_ID,
          name: '本地储存',
          driver: 'local' as const,
          local_dir: './data/media',
          s3_bucket: '',
          s3_prefix: '',
          s3_endpoint: '',
          s3_region: 'us-east-1',
          has_access_key: false,
          has_secret: false,
        },
      ];

  const scopes: Record<string, string> = request
    ? { ...request.scopes }
    : Object.fromEntries(DEMO_STORAGE_SCOPES.map((scope) => [scope, DEMO_STORAGE_STRATEGY_ID]));

  const allocations: Record<string, StorageRuntimeAllocation> = {};
  for (const scope of DEMO_STORAGE_SCOPES) {
    const allocation = request?.allocations?.[scope];
    const entries =
      allocation && allocation.entries.length
        ? allocation.entries
        : [
            {
              strategy_id: scopes[scope] ?? strategies[0].id,
              quota_gb: 0,
            },
          ];
    allocations[scope] = {
      mode: allocation?.mode === 'quota' ? 'quota' : 'single',
      overflow: allocation?.overflow === 'stop' ? 'stop' : 'switch',
      entries: entries.map((entry, index) => ({
        strategy_id: entry.strategy_id,
        quota_gb: entry.quota_gb,
        used_bytes: 0,
        current: index === 0,
      })),
    };
  }

  const rowOf = (scope: string, strategy: (typeof strategies)[number]) => ({
    scope,
    driver: strategy.driver,
    local_dir: strategy.local_dir,
    s3_bucket: strategy.s3_bucket,
    s3_region: strategy.s3_region,
    s3_prefix: strategy.s3_prefix,
  });
  const strategyById = (id: string | undefined) =>
    strategies.find((strategy) => strategy.id === id) ?? strategies[0];

  return {
    live: true,
    source,
    updated_at: source === 'saved' ? new Date().toISOString() : null,
    max_content_chars: request?.max_content_chars ?? 1_000_000,
    global_strategy_id: request?.global_strategy_id ?? DEMO_STORAGE_STRATEGY_ID,
    strategies,
    scopes,
    allocations,
    effective: [
      rowOf('global', strategyById(request?.global_strategy_id)),
      ...DEMO_STORAGE_SCOPES.map((scope) =>
        rowOf(scope, strategyById(scopes[scope])),
      ),
    ],
  };
}

export class DemoBackend {
  readonly mode = 'demo' as const;
  readonly origin = 'demo://local';
  private state: DemoState;
  private currentId: string | null;
  /** 个人博客下所有账户都按最高权限处理，与服务端侧的提权结果保持一致。*/
  private siteKind: 'community' | 'personal' = 'community';
  private tickets: DemoTicket;
  /**
   * 待完成的 2FA 挑战：令。-> 账户 id。与真实后端一样只存在内存里、一次有效；
   * 刷新页面等于放弃这次挑战，需要重新输密码。
   */
  private pendingTwoFactor: Record<string, string> = {};
  /** 演示模式用内存记录已解锁的密码文章；真实后端使用 HttpOnly Cookie。*/
  private unlockedContent = new Set<string>();
  /** 演示模式没有 SMTP：邮件开关保留但显示为未配置，内存里记住本次选择。*/
  private notificationPrefs: NotificationPreferences = {
    in_app: { enabled: true, comments: true, reactions: true, follows: true, moderation: true },
    email: { enabled: false, comments: true, reactions: true, follows: true, moderation: true },
    email_configured: false,
  };
  /** 短信登录：演示模式的手机号 → 账户 id；只存在内存里。 */
  private phoneAccounts = new Map<string, string>();
  /** 草稿预览令牌：只存在内存，30 分钟后过期（与契约默认有效期一致）。 */
  private previewTokens = new Map<string, { kind: ContentKind; id: string; expires_at: number }>();
  /** 重定向规则：内存数组；演示模式不落库。 */
  private redirects: RedirectRule[] = demoSeedRedirects();
  /** 订阅名单（内存）；首次使用时按现有成员生成一段演示数据。 */
  private subscribers: Subscriber[] | null = null;
  /** 订阅确认 / 退订令牌：token → email。 */
  private newsletterTokens = new Map<string, string>();
  /** 邮件模板的站长改写（内存）；不在表里时使用内置默认。 */
  private emailTemplateOverrides = new Map<string, EmailTemplate>();
  /** 邮件发送日志（内存）；首次使用时生成一段演示历史。 */
  private emailLogs: EmailLog[] | null = null;
  /**
   * 运行期储存状态（内存）。
   *
   * 演示模式只在本页内存里模拟「保存后立即应用」；刷新页面就回到部署环境变量
   * 的值，不伪装成真的切过存储，也不写任何文件。
   */
  private storageRuntime: StorageStatus | null = null;

  constructor() {
    const existing = loadState();
    this.state =
      existing ??
      createSeed({
        admin: { email: 'admin@practacu.local', display_name: '林知远', password: 'practacu' },
        site: {
          name: 'Practacu Press',
          domain: 'press.local',
          description: '一间小而安静的编辑部。写作者拥有自己的稿子，读者被当作邻居。',
          visibility_mode: 'public',
          publish_mode: 'review',
        },
      });
    if (!existing) this.persist();
    this.currentId = localStorage.getItem(CURRENT_KEY);
    this.tickets = loadTickets();
    // 早期演示数据没有收件人字段：种子通知都属于安装时创建的管理员。
    let migrated = false;
    for (const item of this.state.notifications) {
      if (!item.recipient_id && item.id.startsWith('ntf_')) {
        item.recipient_id = 'usr_admin';
        migrated = true;
      }
    }
    if (migrated) this.persist();
    // 早期演示内容没有分类与标签：补一组初始引用，旧浏览器也能看到新页面。
    if (applyDemoTaxonomy(this.state.contents)) this.persist();
  }

  configure(input: DemoConfigureInput) {
    this.state = createSeed(input);
    this.currentId = 'usr_admin';
    localStorage.setItem(CURRENT_KEY, this.currentId);
    this.persist();
  }

  reset() {
    localStorage.removeItem(STATE_KEY);
    localStorage.removeItem(CURRENT_KEY);
    localStorage.removeItem(RESET_KEY);
    window.location.reload();
  }

  private persistTickets() {
    try {
      localStorage.setItem(RESET_KEY, JSON.stringify(this.tickets));
    } catch {
      /* 演示票据写不进去只影响刷新后的演示流。*/
    }
  }

  private persist() {
    try {
      localStorage.setItem(STATE_KEY, JSON.stringify(this.state));
    } catch (err) {
      console.warn('演示数据无法写入 localStorage', err);
    }
  }

  private saveCurrent() {
    if (this.currentId) localStorage.setItem(CURRENT_KEY, this.currentId);
    else localStorage.removeItem(CURRENT_KEY);
  }

  private fail(status: number, code: string, message: string, details: Record<string, unknown> = {}): never {
    throw new ApiError({
      ...fallbackProblem(status),
      status,
      code,
      title: message,
      message,
      details,
      request_id: `demo_${Math.random().toString(16).slice(2, 10)}`,
    });
  }

  /** 站点形态变化时。App 同步；只影响演示模式的角色判断。*/
  setSiteKind(kind: 'community' | 'personal') {
    this.siteKind = kind;
  }

  private elevate(user: DemoUser | null): DemoUser | null {
    if (!user) return null;
    return this.siteKind === 'personal' ? { ...user, role: 'platform_admin' } : user;
  }

  private user(): DemoUser {
    const found = this.state.users.find((u) => u.id === this.currentId);
    if (!found) this.fail(401, 'unauthenticated', '请先登录。');
    if (found.status === 'disabled') this.fail(403, 'permission_denied', '该账户已被停用。');
    return this.elevate(found)!;
  }

  private optionalUser(): DemoUser | null {
    return this.elevate(this.state.users.find((u) => u.id === this.currentId) ?? null);
  }

  private requireRole(min: Role): DemoUser {
    const user = this.user();
    if (ROLE_RANK[user.role] < ROLE_RANK[min]) {
      this.fail(403, 'permission_denied', '当前账户没有执行此操作的权限。');
    }
    return user;
  }

  private session(user: DemoUser): Session {
    return {
      user: toPublicUser(user),
      token_type: 'Bearer',
      access_token: `demo.${user.id}.${uuid()}`,
      access_expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
      refresh_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      csrf_token: `demo-csrf-${user.id}`,
    };
  }

  private log(action: string, target: string, detail?: string) {
    const actor = this.optionalUser()?.display_name ?? '系统';
    const entry: ActivityEntry = {
      id: `act_${uuid().slice(0, 8)}`,
      at: new Date().toISOString(),
      actor,
      action,
      target,
      detail,
    };
    this.state.activity.unshift(entry);
    this.state.activity = this.state.activity.slice(0, 80);
  }

  private notify(input: Omit<Notification, 'id' | 'read' | 'created_at'> & { user_id?: string }) {
    const { user_id, ...rest } = input;
    if (!user_id || user_id === this.currentId) return;
    this.state.notifications.unshift({
      ...rest,
      recipient_id: user_id,
      id: `ntf_${uuid().slice(0, 8)}`,
      read: false,
      created_at: new Date().toISOString(),
    });
  }

  private actionsFor(content: Content, viewer: DemoUser | null): ContentAction[] {
    if (!viewer) return [];
    const role = viewer.role;
    const isAuthor = content.author_id === viewer.id;
    const reviewer = canReview(role);
    const owner = isAuthor || role === 'site_admin' || role === 'platform_admin';
    const mode = this.state.site.publish_mode;

    switch (content.status) {
      case 'draft': {
        if (!owner) return [];
        const canPublish = reviewer || mode === 'open';
        return canPublish ? ['submit', 'publish'] : ['submit'];
      }
      case 'pending_review':
        return reviewer && !isAuthor ? ['publish', 'reject'] : [];
      case 'rejected':
        return owner ? ['restore'] : [];
      case 'archived':
        return reviewer ? ['restore'] : [];
      case 'published': {
        const actions: ContentAction[] = [];
        if (reviewer) actions.push('archive');
        // 撤销发布（Beta 1.2）：发布权（作者或编辑及以上）即可。
        if (reviewer || owner) actions.push('unpublish');
        return actions;
      }
      case 'pending_security_check':
        return owner || reviewer ? ['security-retry'] : [];
      default:
        return [];
    }
  }

  private decorate(content: Content, viewer = this.optionalUser()): Content {
    const canEditSource = !!viewer && (content.author_id === viewer.id || canReview(viewer.role));
    if (canEditSource) {
      return { ...content, view_count: demoViewCount(content.id), actions: this.actionsFor(content, viewer) };
    }
    const publicFields: Content = { ...content };
    delete publicFields.source_body;
    return { ...publicFields, view_count: demoViewCount(content.id), actions: this.actionsFor(content, viewer) };
  }

  /** 版本历史按内容分组保存在演示 state 中；缺失时按需补一。v1。*/
  private revisionsFor(contentId: string): DemoRevision[] {
    return (this.state.revisions ?? [])
      .filter((revision) => revision.content_id === contentId)
      .sort((a, b) => b.version - a.version);
  }

  private ensureRevisions(content: DemoContent): DemoRevision[] {
    if (!this.state.revisions) this.state.revisions = [];
    let list = this.revisionsFor(content.id);
    if (!list.length) {
      const revision = this.revisionFrom(
        content,
        1,
        content.author_id,
        'created',
        content.created_at,
      );
      this.state.revisions.push(revision);
      list = [revision];
    }
    return list;
  }

  private revisionFrom(
    content: DemoContent,
    version: number,
    editorId: string,
    action: ContentRevision['action'],
    at: string,
  ): DemoRevision {
    const editor = this.state.users.find((user) => user.id === editorId);
    return {
      id: `rev_${uuid().slice(0, 8)}`,
      content_id: content.id,
      version,
      editor_id: editorId,
      editor_name: editor?.display_name,
      action,
      status: content.status,
      title: content.title,
      slug: content.slug,
      summary: content.summary,
      source_format: content.source_format,
      source_body: content.source_body,
      rendered_html: content.rendered_html,
      policy_version: content.policy_version,
      category_id: content.category_id,
      tags: [...(content.tags ?? [])],
      created_at: at,
    };
  }

  /** 每次保存追加一个版本，并按保留上限裁掉最旧的。*/
  private pushRevision(
    content: DemoContent,
    editorId: string,
    action: ContentRevision['action'],
    at: string,
  ): DemoRevision {
    const history = this.ensureRevisions(content);
    const next: number = history.reduce((max, revision) => Math.max(max, revision.version), 0) + 1;
    const revision = this.revisionFrom(content, next, editorId, action, at);
    const revisions = [...(this.state.revisions ?? []), revision];
    const all = revisions
      .filter((entry) => entry.content_id === content.id)
      .sort((a, b) => b.version - a.version);
    const keep = new Set(all.slice(0, 20).map((entry) => entry.id));
    this.state.revisions = revisions.filter(
      (entry) => entry.content_id !== content.id || keep.has(entry.id),
    );
    return revision;
  }

  private canEditContent(content: DemoContent, user: DemoUser): boolean {
    return content.author_id === user.id || canReview(user.role);
  }

  private tags(content: Content) {
    return content.kind === 'article' ? '文章' : '帖子';
  }

  private findContent(kind: ContentKind, id: string) {
    const found = this.state.contents.find((c) => c.kind === kind && c.id === id);
    if (!found) this.fail(404, 'not_found', '内容不存在，或不在当前站点内。');
    return found;
  }

  /** 按 `key` 读内容（Beta 1.2，契约 J1）：先按 id 查，查不到再按 slug 查。 */
  private findContentByKey(kind: ContentKind, key: string) {
    const byId = this.state.contents.find((c) => c.kind === kind && c.id === key);
    if (byId) return byId;
    const bySlug = this.state.contents.find((c) => c.kind === kind && c.slug === key);
    if (!bySlug) this.fail(404, 'not_found', '内容不存在，或不在当前站点内。');
    return bySlug;
  }

  /** 预览令牌是否对这一次读取有效（内容、类型都对得上且未过期）。 */
  private previewValid(kind: ContentKind, key: string, token?: string): boolean {
    if (!token) return false;
    const record = this.previewTokens.get(token);
    if (!record || record.expires_at < Date.now() || record.kind !== kind) return false;
    const content = this.state.contents.find((item) => item.kind === kind && item.id === record.id);
    return !!content && (content.id === key || content.slug === key);
  }

  /** 把路径规范化为以 `/` 开头、不含查询串与锚点的形式。 */
  private cleanPath(value: string): string {
    const trimmed = (value ?? '').trim();
    if (!trimmed) return '/';
    const withoutQuery = trimmed.split(/[?#]/, 1)[0] ?? '';
    if (!withoutQuery) return '/';
    return withoutQuery.startsWith('/') ? withoutQuery : `/${withoutQuery}`;
  }

  private canSee(content: Content, viewer: DemoUser | null): boolean {
    if (content.status === 'published') {
      return this.state.site.visibility_mode === 'public' || !!viewer;
    }
    if (!viewer) return false;
    return content.author_id === viewer.id || canReview(viewer.role);
  }

  async probe(): Promise<ProbeResult> {
    return { health: 'ok', ready: 'ready', openapi: true, detail: '浏览器本地存。' };
  }

  /**
   * 演示后端没有服务。Secret，人机验证永远不生效。
   *
   * 这和真实后端「站点打开了开关但没配密钥」时的回答一致：前端据此不渲染组件，
   * 而不是画一个演示里不会校验的假组件。
   */
  async captchaStatus(): Promise<CaptchaStatus> {
    await wait(40);
    return readCaptchaStatus({
      enabled: false,
      provider: 'turnstile',
      site_key: '',
      scenes: {},
      server_configured: false,
      effective: false,
      checked_at: new Date().toISOString(),
    });
  }

  async register(input: {
    email: string;
    password: string;
    display_name: string;
    confirm_weak_password?: boolean;
  }): Promise<Session> {
    await wait();
    if (this.state.site.registration_open === false) {
      this.fail(403, 'permission_denied', '本站暂未开放注册。', { reason: 'registration_closed' });
    }
    const email = input.email.trim().toLowerCase();
    if (this.state.users.some((u) => u.email.toLowerCase() === email)) {
      this.fail(409, 'conflict', '该邮箱已经注册。');
    }
    const problem = passwordCreationProblem(input.password, !!input.confirm_weak_password);
    if (problem) this.fail(400, 'validation_failed', passwordProblemText(problem, (key) => key));
    const user: DemoUser = {
      id: `usr_${uuid().slice(0, 8)}`,
      display_name: input.display_name.trim() || email.split('@')[0],
      email,
      password: input.password,
      role: 'member',
      locale: 'zh-CN',
      status: 'active',
      created_at: new Date().toISOString(),
    };
    this.state.users.push(user);
    this.currentId = user.id;
    this.log('注册账户', user.display_name, email);
    this.persist();
    this.saveCurrent();
    return this.session(user);
  }

  async login(input: { identifier: string; password: string }): Promise<PasswordLoginResult> {
    await wait();
    // 与真实后端一致：邮箱或显示名称都可以登录；显示名称重名时拒绝（用邮箱登录）。
    const identifier = input.identifier.trim().toLowerCase();
    const matches = this.state.users.filter(
      (user) =>
        user.email.toLowerCase() === identifier ||
        user.display_name.trim().toLowerCase() === identifier,
    );
    const user = matches.length === 1 ? matches[0] : undefined;
    if (!user || user.password !== input.password) {
      this.fail(401, 'unauthenticated', '邮箱/用户名或密码不正确。');
    }
    if (user.status === 'disabled') {
      this.fail(403, 'permission_denied', '该账户已被停用，请联系站点管理员。');
    }
    // FSD F-04：开启两步验证后，密码只完成第一步；会话在第二步之后才建立。
    if (user.two_factor?.enabled) {
      const token = `demo-2fa-${uuid()}`;
      this.pendingTwoFactor[token] = user.id;
      return {
        status: 'two_factor_required',
        challenge: {
          two_factor_required: true,
          challenge_token: token,
          expires_in: 300,
          expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        },
      };
    }
    this.currentId = user.id;
    this.saveCurrent();
    return { status: 'session', session: this.session(user) };
  }

  /**
   * 演示模式的第二步：固定验证码 123456，或任一未使用的恢复码。
   *
   * 真实后端由服务端校验 RFC 6238，并且同一时间步只能成功一次；演示模式不做
   * 时间步重放判断，但恢复码同样一次性作废。
   */
  async loginTwoFactor(challengeToken: string, code: string): Promise<Session> {
    await wait();
    const userId = this.pendingTwoFactor[challengeToken];
    const user = this.state.users.find((u) => u.id === userId);
    if (!user || !user.two_factor?.enabled) {
      this.fail(401, 'unauthenticated', '验证已过期，请重新登录。', {
        reason: 'two_factor_challenge_invalid',
      });
    }
    if (!this.acceptTwoFactorCode(user, code)) {
      this.fail(400, 'validation_failed', '验证码不正确。', {
        field: 'code',
        reason: 'invalid_two_factor_code',
      });
    }
    delete this.pendingTwoFactor[challengeToken];
    this.currentId = user.id;
    this.saveCurrent();
    this.persist();
    this.log('登录', user.display_name, '邮箱 + 两步验证');
    return this.session(user);
  }

  async twoFactorStatus(): Promise<TwoFactorStatus> {
    const user = this.currentUser();
    const enabled = user.two_factor?.enabled ?? false;
    return {
      enabled,
      recovery_codes_remaining: enabled
        ? (user.two_factor?.recovery_codes ?? []).filter((item) => !item.used).length
        : 0,
      ...(enabled && user.two_factor?.confirmed_at
        ? { confirmed_at: user.two_factor.confirmed_at }
        : {}),
    };
  }

  async beginTwoFactorEnrollment(password: string): Promise<TwoFactorEnrollment> {
    await wait();
    const user = this.currentUser();
    this.requireDemoPassword(user, password);
    if (user.two_factor?.enabled) {
      this.fail(409, 'conflict', '两步验证已经开启。', { reason: 'two_factor_already_enabled' });
    }
    const secret = demoBase32(32);
    user.two_factor = { enabled: false, secret, recovery_codes: [] };
    this.persist();
    const label = encodeURIComponent(`Practacu Press:${user.email}`);
    const uri =
      `otpauth://totp/${label}?secret=${secret}` +
      '&issuer=Practacu%20Press&algorithm=SHA1&digits=6&period=30';
    return { secret, otpauth_uri: uri, qr_content: uri, expires_in: 900 };
  }

  async confirmTwoFactor(code: string): Promise<TwoFactorRecoveryCodes> {
    await wait();
    const user = this.currentUser();
    if (!user.two_factor || user.two_factor.enabled) {
      this.fail(400, 'validation_failed', '没有待确认的绑定。', {
        reason: 'two_factor_not_enrolled',
      });
    }
    if (code.trim() !== DEMO_TOTP_CODE) {
      this.fail(400, 'validation_failed', '验证码不正确。', {
        field: 'code',
        reason: 'invalid_two_factor_code',
      });
    }
    const recoveryCodes = Array.from({ length: 10 }, () => demoRecoveryCode());
    user.two_factor = {
      enabled: true,
      secret: user.two_factor.secret,
      confirmed_at: new Date().toISOString(),
      recovery_codes: recoveryCodes.map((item) => ({ code: item, used: false })),
    };
    this.persist();
    this.log('开启两步验。', user.display_name);
    return { recovery_codes: recoveryCodes };
  }

  async disableTwoFactor(input: { password: string; code: string }): Promise<void> {
    await wait();
    const user = this.currentUser();
    this.requireDemoPassword(user, input.password);
    if (!user.two_factor?.enabled) {
      this.fail(409, 'conflict', '两步验证还没有开启。', { reason: 'two_factor_not_enabled' });
    }
    if (!this.acceptTwoFactorCode(user, input.code)) {
      this.fail(400, 'validation_failed', '验证码不正确。', {
        field: 'code',
        reason: 'invalid_two_factor_code',
      });
    }
    delete user.two_factor;
    this.persist();
    this.log('关闭两步验证', user.display_name);
  }

  async regenerateTwoFactorRecoveryCodes(input: {
    password: string;
    code: string;
  }): Promise<TwoFactorRecoveryCodes> {
    await wait();
    const user = this.currentUser();
    this.requireDemoPassword(user, input.password);
    if (!user.two_factor?.enabled) {
      this.fail(409, 'conflict', '两步验证还没有开启。', { reason: 'two_factor_not_enabled' });
    }
    if (!this.acceptTwoFactorCode(user, input.code)) {
      this.fail(400, 'validation_failed', '验证码不正确。', {
        field: 'code',
        reason: 'invalid_two_factor_code',
      });
    }
    const recoveryCodes = Array.from({ length: 10 }, () => demoRecoveryCode());
    user.two_factor.recovery_codes = recoveryCodes.map((item) => ({ code: item, used: false }));
    this.persist();
    this.log('重新生成恢复。', user.display_name);
    return { recovery_codes: recoveryCodes };
  }

  async resetMemberTwoFactor(_siteId: string, userId: string): Promise<void> {
    await wait();
    const actor = this.requireRole('platform_admin');
    // 与真实后端一致：管理员不能通过重置端点清掉自己的第二因素。
    if (actor.id === userId) {
      this.fail(403, 'permission_denied', '不能重置自己的两步验证。', {
        reason: 'role_too_low',
      });
    }
    const target = this.state.users.find((item) => item.id === userId);
    if (!target) this.fail(404, 'not_found', '成员不存在。');
    delete target.two_factor;
    this.persist();
    this.log('重置两步验证', target.display_name);
  }

  /** 演示模式的当前账户原始记录：user() 会做提权复制，不能用来写回。*/
  private currentUser(): DemoUser {
    const found = this.state.users.find((user) => user.id === this.currentId);
    if (!found) this.fail(401, 'unauthenticated', '请先登录。');
    if (found.status === 'disabled') this.fail(403, 'permission_denied', '该账户已被停用。');
    return found;
  }

  private requireDemoPassword(user: DemoUser, password: string) {
    if (user.password !== password) {
      this.fail(400, 'validation_failed', '当前密码不正确。', {
        field: 'current_password',
        rule: 'invalid',
      });
    }
  }

  /** 固定验证码或一次性恢复码；恢复码用掉即作废，与真实后端一致。*/
  private acceptTwoFactorCode(user: DemoUser, code: string): boolean {
    const trimmed = code.trim();
    if (trimmed === DEMO_TOTP_CODE) return true;
    const normalized = trimmed.replace(/[\s-]/g, '').toUpperCase();
    const match = user.two_factor?.recovery_codes.find(
      (item) => !item.used && item.code.replace('-', '').toUpperCase() === normalized,
    );
    if (!match) return false;
    match.used = true;
    return true;
  }

  /**
   * 演示模式：模拟手机验证码 / OAuth 登录。
   * 真实后端必须由服务端校验验证码或授权码，前端不伪造这些端点。
   */
  async demoProviderLogin(provider: AuthProviderId): Promise<Session> {
    await wait(260);
    const owner =
      this.state.users.find((u) => u.role === 'site_admin' && u.status === 'active') ??
      this.state.users[0];
    if (!owner) this.fail(404, 'not_found', '演示数据里没有可登录的账户。');
    this.currentId = owner.id;
    this.saveCurrent();
    this.log('模拟第三方登。', owner.display_name, provider);
    return this.session(owner);
  }

  async refresh(): Promise<Session> {
    // 演示模式的「会话」就是 localStorage 里的当前用户：另一个标签页刚登录 / 退出时
    // 这里要重新读一次，否则这个标签页会一直拿着挂载时的那份旧状态。
    this.currentId = localStorage.getItem(CURRENT_KEY);
    const user = this.optionalUser();
    if (!user) this.fail(401, 'unauthenticated', '登录状态已失效。');
    return this.session(user);
  }

  async passwordResetPolicy(): Promise<PasswordResetPolicy> {
    return { enabled: true, delivery: 'email', expires_in: RESET_TTL_MS / 1000, cooldown: 60 };
  }

  /**
   * 演示模式没有邮件服务，所以把令牌直接返回给页面。
   * 真实后端只回答「已受理」，令牌只出现在邮件里。
   */
  async requestPasswordReset(email: string): Promise<PasswordResetTicket> {
    await wait(220);
    const normalized = email.trim().toLowerCase();
    const user = this.state.users.find(
      (u) => u.email.toLowerCase() === normalized && u.status === 'active',
    );
    if (!user) {
      return { status: 'accepted', delivery: 'email', expires_in: RESET_TTL_MS / 1000 };
    }

    // 新链接生效时旧链接作废，和真实后端一致。
    for (const [key, ticket] of Object.entries(this.tickets)) {
      if (ticket.user_id === user.id) delete this.tickets[key];
    }
    const token = uuid().replace(/-/g, '');
    this.tickets[token] = { user_id: user.id, expires_at: Date.now() + RESET_TTL_MS };
    this.persistTickets();
    this.log('请求重置密码', user.display_name, normalized);
    return {
      status: 'accepted',
      delivery: 'email',
      expires_in: RESET_TTL_MS / 1000,
      token,
    };
  }

  async resetPassword(input: {
    token: string;
    password: string;
    confirm_weak_password?: boolean;
  }): Promise<void> {
    await wait(220);
    const problem = passwordCreationProblem(input.password, !!input.confirm_weak_password);
    if (problem) this.fail(400, 'validation_failed', passwordProblemText(problem, (key) => key));
    const ticket = this.tickets[input.token];
    if (!ticket || ticket.expires_at < Date.now()) {
      this.fail(400, 'validation_failed', '重置链接无效或已过期，请重新获取。');
    }
    const user = this.state.users.find((u) => u.id === ticket.user_id);
    if (!user) this.fail(404, 'not_found', '账户不存在。');

    user.password = input.password;
    delete this.tickets[input.token];
    this.persistTickets();
    this.persist();
    // 与真实后端一致：改密码会吊销该账户所有会话，包括当前这一个。
    if (this.currentId === user.id) {
      this.currentId = null;
      this.saveCurrent();
    }
    this.log('重置密码', user.display_name, user.email);
  }

  async logout(): Promise<void> {
    this.currentId = null;
    this.saveCurrent();
  }

  async me(): Promise<Me> {
    await wait(60);
    const user = this.user();
    return { user: toPublicUser(user), role: user.role, site_id: this.state.site.id };
  }

  async updateProfile(input: ProfileInput): Promise<User> {
    await wait(120);
    const user = this.user();

    if (input.display_name !== undefined) {
      const name = input.display_name.trim();
      if (!name) this.fail(400, 'validation_failed', '昵称不能为空。');
      if ([...name].length > 120) this.fail(400, 'validation_failed', '昵称最多 120 个字符。');
      user.display_name = name;
    }
    if (input.bio !== undefined) {
      const bio = (input.bio ?? '').trim();
      if ([...bio].length > 2000) this.fail(400, 'validation_failed', '简介最多 2000 个字符。');
      user.bio = bio || undefined;
    }
    if (input.avatar_media_id !== undefined) {
      const avatar = input.avatar_media_id || undefined;
      if (avatar && !this.state.assets.some((asset) => asset.id === avatar && asset.purpose === 'avatar')) {
        this.fail(400, 'validation_failed', '头像必须是本人上传的图片素材。');
      }
      user.avatar_media_id = avatar;
    }
    this.log('编辑个人资料', user.display_name, '昵称 / 简介 / 头像');
    this.persist();
    return toPublicUser(user);
  }

  async changePassword(input: ChangePasswordInput): Promise<void> {
    await wait(160);
    const user = this.user();
    if (user.password !== input.current_password) {
      this.fail(400, 'validation_failed', '当前密码不正确。');
    }
    const problem = passwordCreationProblem(input.new_password, !!input.confirm_weak_password);
    if (problem) this.fail(400, 'validation_failed', passwordProblemText(problem, (text) => text));
    if (input.current_password === input.new_password) {
      this.fail(400, 'validation_failed', '新密码不能与当前密码相同。');
    }
    user.password = input.new_password;
    this.log('修改密码', user.display_name, '其它设备已下。');
    this.persist();
  }

  async requestEmailVerification(): Promise<{
    status: 'accepted' | 'already_verified';
    delivery: 'email';
    expires_in: number;
    already_verified: boolean;
  }> {
    await wait(120);
    const user = this.user();
    if (user.email_verified) {
      return { status: 'already_verified', delivery: 'email', expires_in: 86400, already_verified: true };
    }
    this.log('请求验证邮箱', user.email, '演示模式不会真的发信');
    this.persist();
    return { status: 'accepted', delivery: 'email', expires_in: 86400, already_verified: false };
  }

  async verifyEmail(_token: string): Promise<void> {
    await wait(120);
    const user = this.optionalUser();
    // The real endpoint is public: a verification link opened in a fresh browser
    // works without a session. The demo simply succeeds when nobody is signed in.
    if (!user) return;
    user.email_verified = true;
    this.log('验证邮箱', user.email);
    this.persist();
  }

  async auditLogs(siteId: string, query: AuditLogQuery = {}): Promise<AuditLogPage> {
    await wait(80);
    this.requireRole('site_admin');
    if (siteId !== this.state.site.id) this.fail(404, 'site_not_found', '站点不存在。');

    const users = this.state.users;
    const all: AuditLog[] = this.state.activity.map((entry) => {
      const action = DEMO_ACTION_CODES[entry.action] ?? entry.action;
      const actorUser = users.find((user) => user.display_name === entry.actor);
      return {
        id: entry.id,
        site_id: this.state.site.id,
        actor_id: actorUser?.id,
        actor_name: entry.actor,
        action,
        target_type: demoTargetType(action),
        target_name: entry.target,
        outcome: 'success',
        detail: entry.detail ? { summary: entry.detail } : undefined,
        created_at: entry.at,
      };
    });

    const from = query.from ? new Date(query.from).getTime() : null;
    const to = query.to ? new Date(query.to).getTime() : null;
    const filtered = all
      .filter((entry) => {
        if (from !== null && new Date(entry.created_at).getTime() < from) return false;
        if (to !== null && new Date(entry.created_at).getTime() > to) return false;
        if (query.actor_id && entry.actor_id !== query.actor_id) return false;
        if (query.action && entry.action !== query.action) return false;
        if (query.target_type && entry.target_type !== query.target_type) return false;
        if (query.target_id && entry.id !== query.target_id) return false;
        if (query.outcome && entry.outcome !== query.outcome) return false;
        return true;
      })
      .sort((a, b) => b.created_at.localeCompare(a.created_at));

    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    const offset = Number(query.cursor ?? '0') || 0;
    const page = filtered.slice(offset, offset + limit);
    const next = offset + limit < filtered.length ? String(offset + limit) : '';
    return { items: page, next_cursor: next || undefined };
  }

  async site(siteId: string): Promise<Site> {
    await wait(60);
    if (siteId !== this.state.site.id) this.fail(404, 'site_not_found', '站点不存在。');
    // 早期演示数据没有 registration_open：按开放处理，避免升级后意外关注册。
    return {
      ...this.state.site,
      registration_open: this.state.site.registration_open !== false,
      media_quota_bytes: this.state.site.media_quota_bytes ?? null,
    };
  }

  async updateSite(
    siteId: string,
    patch: Partial<{
      name: string;
      description: string;
      visibility_mode: Site['visibility_mode'];
      publish_mode: Site['publish_mode'];
      domain: string;
      registration_open: boolean;
      media_quota_bytes: MediaQuotaBytes;
    }>,
  ): Promise<void> {
    await wait();
    this.requireRole('site_admin');
    if (siteId !== this.state.site.id) this.fail(404, 'site_not_found', '站点不存在。');
    if (patch.name !== undefined) {
      if (!patch.name.trim() || patch.name.length > 160) {
        this.fail(400, 'validation_failed', '站点名称不能为空，且不超过 160 个字符。');
      }
      this.state.site.name = patch.name.trim();
    }
    if (patch.description !== undefined) this.state.site.description = patch.description.slice(0, 2000);
    if (patch.visibility_mode) this.state.site.visibility_mode = patch.visibility_mode;
    if (patch.publish_mode) this.state.site.publish_mode = patch.publish_mode;
    if (patch.registration_open !== undefined) {
      this.state.site.registration_open = patch.registration_open;
    }
    if (patch.media_quota_bytes !== undefined) {
      this.assertValidMediaQuota(patch.media_quota_bytes);
      this.state.site.media_quota_bytes = patch.media_quota_bytes;
    }
    if (patch.domain !== undefined) this.state.site.domain = patch.domain.trim();
    this.log('修改站点设置', this.state.site.name);
    this.persist();
  }

  async setSiteDomain(siteId: string, domain: string): Promise<void> {    const next = domain.trim().toLowerCase();
    const changed = next !== this.state.site.domain;
    await this.updateSite(siteId, { domain: next });
    if (changed) {
      // 改域名相当于换绑：演示模式也要走一遍「待验证 。立即验证」。
      this.state.domain_verified = false;
      this.persist();
    }
  }

  /** V-12：演示后端用确定。token 模拟 TXT 验证，改域名后进入待验证。*/
  async siteDomain(siteId: string): Promise<SiteDomainVerification> {
    await wait(60);
    this.requireRole('site_admin');
    if (siteId !== this.state.site.id) this.fail(404, 'site_not_found', '站点不存在。');
    const domain = this.state.site.domain;
    if (!domain) {
      return { domain: '', verified: false, verification_token: '', record_name: '', record_type: 'TXT' };
    }
    return {
      domain,
      // 早期演示数据没有验证状态：按已验证处理；只有明。false 才算待验证。
      verified: this.state.domain_verified !== false,
      verification_token: `pp_verify_${domain.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`,
      record_name: `_practacu-verify.${domain}`,
      record_type: 'TXT',
    };
  }

  async verifySiteDomain(siteId: string): Promise<SiteDomainVerificationResult> {
    await wait(240);
    this.requireRole('site_admin');
    if (siteId !== this.state.site.id) this.fail(404, 'site_not_found', '站点不存在。');
    const domain = this.state.site.domain;
    if (!domain) {
      this.fail(400, 'validation_failed', '请先填写主域名。', { reason: 'validation_failed' });
    }
    // 演示模式没有真实 DNS：直接当。TXT 记录已生效。
    this.state.domain_verified = true;
    this.log('验证主域。', domain);
    this.persist();
    return { verified: true, domain };
  }

  /**
   * 平台控制台在演示模式下只有当前站点。
   *
   * 演示状态（`pp.demo.state.v1`）是单站点快照，容器、成员与内容都挂在这一个站点上。
   * 在浏览器里模拟多站点会让"站点隔离"看起来成立而实际没有隔离，所以这里只读，
   * 新建与跨站进入都明确拒绝，由页面提示连接真实后端。
   */
  private platformSiteView(): PlatformSite {
    const site = this.state.site;
    const now = new Date().toISOString();
    const admins = this.state.users.filter(
      (user) => ROLE_RANK[this.elevate(user)?.role ?? user.role] >= ROLE_RANK.site_admin,
    ).length;
    return {
      id: site.id,
      slug: site.slug,
      name: site.name,
      description: site.description ?? '',
      domain: site.domain,
      domain_verified: this.state.domain_verified !== false,
      visibility_mode: site.visibility_mode,
      publish_mode: site.publish_mode,
      disabled: site.disabled,
      member_count: this.state.users.length,
      admin_count: admins,
      created_at: now,
      updated_at: now,
    };
  }

  async platformSites(): Promise<PlatformSite[]> {
    await wait(80);
    this.requireRole('platform_admin');
    return [this.platformSiteView()];
  }

  /**
   * 演示模式的总览：只有当前站点。
   *
   * 计数从演示快照现算，形状与 `GET /platform/overview` 一致；「部署」在这里就是
   * 这一个站点，页面上的跨站表格因此只有一行。多站点只是数据模型上的能力，在浏览器
   * 里伪造第二座站点会让「站点隔离」看起来成立而实际没有隔离。
   */
  async platformOverview(windowDays = 7): Promise<PlatformOverview> {
    await wait(80);
    this.requireRole('platform_admin');
    const now = new Date();
    const window = Math.min(Math.max(windowDays || 7, 1), 30);
    const sinceMs = now.getTime() - window * 86_400_000;
    const view = this.platformSiteView();
    const contents = this.state.contents;
    const comments = this.state.comments;
    const reports = this.state.reports ?? [];

    const published = contents.filter((item) => item.status === 'published').length;
    const pending = contents.filter(
      (item) => item.status === 'pending_review' || item.status === 'pending_security_check',
    ).length;
    const drafts = contents.filter((item) => item.status === 'draft').length;
    const pendingComments = comments.filter((item) => item.status === 'pending_review').length;
    const openReports = reports.filter(
      (item) => item.status === 'open' || item.status === 'assigned',
    ).length;
    const recent = this.state.activity
      .filter((entry) => new Date(entry.at).getTime() >= sinceMs)
      .sort((left, right) => right.at.localeCompare(left.at));
    const failures = recent.filter((entry) => /失败|failed/i.test(entry.action)).length;
    const verifiedAccounts = this.state.users.filter((user) => user.email_verified).length;
    const twoFactorAccounts = this.state.users.filter((user) => user.two_factor?.enabled).length;

    const recentRows: PlatformActivityRow[] = recent.slice(0, 12).map((entry) => {
      const action = DEMO_ACTION_CODES[entry.action] ?? entry.action;
      const actor = this.state.users.find((user) => user.display_name === entry.actor);
      return {
        id: entry.id,
        site_id: view.id,
        site_name: view.name,
        actor_id: actor?.id,
        actor_name: entry.actor,
        action,
        target_type: demoTargetType(action),
        target_name: entry.target,
        outcome: /失败|failed/i.test(entry.action) ? 'failure' : 'success',
        detail: entry.detail ? { summary: entry.detail } : undefined,
        created_at: entry.at,
      };
    });

    return {
      generated_at: now.toISOString(),
      window_days: window,
      window_start: new Date(sinceMs).toISOString(),
      totals: {
        sites: 1,
        disabled_sites: view.disabled ? 1 : 0,
        unverified_sites: view.domain_verified ? 0 : 1,
        members: view.member_count,
        active_members: this.state.users.filter((user) => user.status === 'active').length,
        admins: view.admin_count,
        content: contents.length,
        published_content: published,
        pending_content: pending,
        comments: comments.length,
        pending_comments: pendingComments,
        accounts: this.state.users.length,
        verified_accounts: verifiedAccounts,
        two_factor_accounts: twoFactorAccounts,
      },
      signals: {
        open_reports: openReports,
        pending_comments: pendingComments,
        failed_actions: failures,
        disabled_sites: view.disabled ? 1 : 0,
        unverified_sites: view.domain_verified ? 0 : 1,
        unverified_emails: this.state.users.length - verifiedAccounts,
        quiet_sites: view.disabled || recent.length ? 0 : 1,
      },
      sites: [
        {
          id: view.id,
          slug: view.slug,
          name: view.name,
          domain: view.domain,
          domain_verified: view.domain_verified,
          visibility_mode: view.visibility_mode,
          publish_mode: view.publish_mode,
          disabled: view.disabled,
          member_count: view.member_count,
          active_member_count: this.state.users.filter((user) => user.status === 'active').length,
          admin_count: view.admin_count,
          content_count: contents.length,
          published_content_count: published,
          pending_content_count: pending,
          draft_count: drafts,
          comment_count: comments.length,
          pending_comment_count: pendingComments,
          open_report_count: openReports,
          recent_activity_count: recent.length,
          recent_failure_count: failures,
          created_at: view.created_at,
        },
      ],
      recent_activity: recentRows,
    };
  }

  /** 演示模式的跨站审计：只有当前站点，站点过滤落空时返回空页。 */
  async platformAuditLogs(query: PlatformAuditQuery = {}): Promise<AuditLogPage> {
    await wait(60);
    this.requireRole('platform_admin');
    if (query.site_id && query.site_id !== this.state.site.id) {
      return { items: [] };
    }
    const rest: PlatformAuditQuery = { ...query };
    delete rest.site_id;
    return this.auditLogs(this.state.site.id, rest);
  }

  /** 演示模式的平台用户目录：只读，两步验证只给布尔值。 */
  async platformAccounts(query: PlatformAccountQuery = {}): Promise<PlatformAccountPage> {
    await wait(60);
    this.requireRole('platform_admin');
    const site = this.state.site;
    if (query.site_id && query.site_id !== site.id) {
      return { items: [] };
    }
    const term = (query.q ?? '').trim().toLowerCase();
    const users = this.state.users.filter(
      (user) =>
        !term ||
        user.display_name.toLowerCase().includes(term) ||
        user.email.toLowerCase().includes(term),
    );
    const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
    const offset = Number(query.cursor ?? '0') || 0;
    const page = users.slice(offset, offset + limit);
    const next = offset + limit < users.length ? String(offset + limit) : '';
    return {
      items: page.map((user) => ({
        user_id: user.id,
        display_name: user.display_name,
        email: user.email,
        email_verified: Boolean(user.email_verified),
        two_factor_enabled: Boolean(user.two_factor?.enabled),
        status: user.status,
        created_at: user.created_at,
        memberships: [
          {
            site_id: site.id,
            site_name: site.name,
            site_slug: site.slug,
            role: user.role,
            status: user.status === 'active' ? 'active' : 'suspended',
          },
        ],
      })),
      next_cursor: next || undefined,
    };
  }

  async createPlatformSite(_input: CreateSiteInput): Promise<CreatedSite> {
    await wait(80);
    this.requireRole('platform_admin');
    this.fail(
      400,
      'validation_failed',
      '演示模式只运行一个站点，无法新建站点；连接真实后端后可使用平台控制台。',
      { reason: 'demo_single_site' },
    );
  }

  async platformSite(siteId: string): Promise<PlatformSiteDetail> {
    await wait(60);
    const user = this.requireRole('site_admin');
    if (siteId !== this.state.site.id) this.fail(404, 'site_not_found', '站点不存在。');
    const verified = this.state.domain_verified !== false;
    return {
      site: this.platformSiteView(),
      role: user.role,
      domain_status: {
        domain: this.state.site.domain,
        verified,
        verification_token:
          this.state.site.domain && !verified
            ? `pp_verify_${this.state.site.domain.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`
            : '',
        record_name: this.state.site.domain ? `_practacu-verify.${this.state.site.domain}` : '',
        record_type: 'TXT',
      },
    };
  }

  async verifyPlatformSiteDomain(siteId: string): Promise<SiteDomainVerification> {
    await wait(120);
    this.requireRole('site_admin');
    if (siteId !== this.state.site.id) this.fail(404, 'site_not_found', '站点不存在。');
    if (!this.state.site.domain) {
      this.fail(400, 'validation_failed', '请先填写主域名。');
    }
    this.state.domain_verified = true;
    this.persist();
    return {
      domain: this.state.site.domain,
      verified: true,
      verification_token: '',
      record_name: `_practacu-verify.${this.state.site.domain}`,
      record_type: 'TXT',
    };
  }

  async enterPlatformSite(siteId: string): Promise<PlatformSiteEntry> {
    await wait(60);
    const user = this.requireRole('site_admin');
    if (siteId !== this.state.site.id) this.fail(404, 'site_not_found', '站点不存在。');
    return { site: this.platformSiteView(), role: user.role, switchable: true };
  }

  async claimSiteSwitch(_switchToken: string): Promise<Session> {
    await wait(60);
    this.fail(
      400,
      'validation_failed',
      '演示模式没有跨站点会话交接。',
      { reason: 'demo_single_site' },
    );
  }

  async members(): Promise<Member[]> {
    await wait();
    this.requireRole('site_admin');
    return this.state.users.map(toMember);
  }

  async createMember(_siteId: string, input: NewMemberInput): Promise<Member> {
    await wait(240);
    this.requireRole('site_admin');
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      this.fail(400, 'validation_failed', '请填写有效的邮箱地址。');
    }
    if (!input.display_name.trim()) this.fail(400, 'validation_failed', '请填写显示名称。');
    // 与真实服务端同一套密码策略，否则演示模式能建的账户，线上建不了。
    const passwordIssue = passwordCreationProblem(input.password, !!input.confirm_weak_password);
    if (passwordIssue) {
      this.fail(400, 'validation_failed', passwordProblemText(passwordIssue, (key) => key));
    }
    if (this.state.users.some((u) => u.email.toLowerCase() === email)) {
      this.fail(409, 'conflict', '该邮箱已经注册。');
    }
    const role: Role = input.role ?? 'member';
    if (role === 'platform_admin') {
      // 与真实服务端一致：最高管理员只能是注册该站点的那一个账号。
      this.fail(403, 'permission_denied', '最高管理员是注册该站的账号，不能用新增用户创建。', {
        reason: 'platform_admin_locked',
      });
    }
    const user: DemoUser = {
      id: `usr_${uuid().slice(0, 8)}`,
      display_name: input.display_name.trim(),
      email,
      password: input.password,
      role,
      locale: 'zh-CN',
      status: 'active',
      created_at: new Date().toISOString(),
    };
    this.state.users.push(user);
    this.log('创建账户', user.display_name, `${email} · ${role}`);
    this.persist();
    return toMember(user);
  }

  async setMemberRole(_siteId: string, userId: string, role: Role): Promise<void> {
    await wait();
    this.requireRole('site_admin');
    const target = this.state.users.find((u) => u.id === userId);
    if (!target) this.fail(404, 'not_found', '成员不存在。');
    // 与真实服务端一致：最高管理员席位固定给注册该站点的账号，既不能授予别人，
    // 也不能撤销。
    if ((role === 'platform_admin') !== (target.role === 'platform_admin')) {
      this.fail(403, 'permission_denied', '最高管理员是注册该账号的人，用户组固定，不能在这里更改。', {
        reason: 'platform_admin_locked',
      });
    }
    target.role = role;
    this.log('调整成员角色', target.display_name, role);
    this.persist();
  }

  async setMemberQuota(siteId: string, userId: string, mediaQuotaBytes: MediaQuotaBytes): Promise<Member> {
    await wait();
    this.requireRole('site_admin');
    if (siteId !== this.state.site.id) this.fail(404, 'site_not_found', '站点不存在。');
    this.assertValidMediaQuota(mediaQuotaBytes);
    const target = this.state.users.find((user) => user.id === userId);
    if (!target) this.fail(404, 'not_found', '成员不存在。');
    target.media_quota_bytes = mediaQuotaBytes;
    this.log('修改成员媒体额度', target.display_name);
    this.persist();
    return toMember(target);
  }

  private assertValidMediaQuota(value: MediaQuotaBytes): void {
    if (value === null) return;
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return;
    if (
      typeof value === 'string' &&
      /^\d+$/.test(value) &&
      BigInt(value) <= 9_223_372_036_854_775_807n
    ) {
      return;
    }
    this.fail(400, 'validation_failed', '媒体额度必须是非负 int64 整数或空值。');
  }

  async updateMember(
    _siteId: string,
    userId: string,
    patch: { display_name?: string; email?: string },
  ): Promise<Member> {
    await wait();
    const actor = this.requirePlatformAdmin();
    const target = this.lowerMember(actor, userId);
    if (patch.display_name !== undefined) {
      const name = patch.display_name.trim();
      if (!name) this.fail(400, 'validation_failed', '请填写显示名称。');
      target.display_name = name.slice(0, 120);
    }
    if (patch.email !== undefined) {
      const email = patch.email.trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        this.fail(400, 'validation_failed', '请填写有效的邮箱地址。');
      }
      if (
        target.email.toLowerCase() !== email &&
        this.state.users.some((u) => u.email.toLowerCase() === email)
      ) {
        this.fail(409, 'conflict', '该邮箱已经被其他账户使用。');
      }
      target.email = email;
    }
    this.log('编辑成员资料', target.display_name, target.email);
    this.persist();
    return toMember(target);
  }

  async setMemberStatus(
    _siteId: string,
    userId: string,
    status: 'active' | 'suspended',
  ): Promise<Member> {
    await wait();
    const actor = this.requirePlatformAdmin();
    const target = this.lowerMember(actor, userId);
    if (status !== 'active' && status !== 'suspended') {
      this.fail(400, 'validation_failed', '状态只能是 active 或 suspended。');
    }
    target.status = status === 'active' ? 'active' : 'disabled';
    this.log(status === 'active' ? '启用成员账户' : '停用成员账户', target.display_name);
    this.persist();
    return toMember(target);
  }

  async deleteMember(_siteId: string, userId: string): Promise<void> {
    await wait();
    const actor = this.requirePlatformAdmin();
    const target = this.lowerMember(actor, userId);
    this.state.users = this.state.users.filter((u) => u.id !== target.id);
    this.log('删除成员账户', target.display_name, target.email);
    this.persist();
  }

  private requirePlatformAdmin(): DemoUser {
    const user = this.requireRole('site_admin');
    if (user.role !== 'platform_admin') {
      this.fail(403, 'permission_denied', '只有平台管理员可以管理其他账户。');
    }
    return user;
  }

  /** 只能操作等级更低的成员：不能操作自己，也不能操作其他平台管理员。*/
  private lowerMember(actor: DemoUser, userId: string): DemoUser {
    const target = this.state.users.find((u) => u.id === userId);
    if (!target) this.fail(404, 'not_found', '成员不存在。');
    if (target.id === actor.id) {
      this.fail(403, 'permission_denied', '不能对自己执行这个操作。');
    }
    if (target.role === 'platform_admin') {
      this.fail(403, 'permission_denied', '只能管理等级更低的用户。');
    }
    return target;
  }

  async listContent(
    kind: ContentKind,
    options: { limit?: number; cursor?: string; authorId?: string; trashed?: boolean } = {},
  ): Promise<ContentPage> {
    await wait(160);
    const viewer = this.optionalUser();
    if (this.state.site.visibility_mode === 'members_only' && !viewer) {
      this.fail(401, 'unauthenticated', '该站点仅对成员开放，请先登录。');
    }
    if (options.trashed && !viewer) this.fail(401, 'unauthenticated', '回收站只对登录成员开放。');
    const limit = Math.min(100, Math.max(1, options.limit ?? 20));
    const offset = options.cursor ? Number(options.cursor.replace(/^o:/, '')) : 0;
    const all = this.state.contents
      .filter((c) => c.kind === kind)
      // 回收站是互斥视图：默认隐藏已删除，打开回收站时只看已删除。
      .filter((c) => (options.trashed ? Boolean(c.deleted_at) : !c.deleted_at))
      .filter((c) => !options.authorId || c.author_id === options.authorId)
      .filter((c) => this.canSee(c, viewer))
      // 密码 / 仅登录内容不进公开列表；编辑与站长在后台仍能看到。
      .filter((c) => (c.access_mode ?? 'public') === 'public' || canReview(viewer?.role))
      .sort((a, b) => {
        const da = a.published_at ?? a.created_at;
        const db = b.published_at ?? b.created_at;
        return db.localeCompare(da);
      });
    const slice = all.slice(offset, offset + limit);
    const next = offset + limit;
    return {
      items: slice.map((c) => this.decorate(c, viewer)),
      next_cursor: next < all.length ? `o:${next}` : '',
      has_more: next < all.length,
    };
  }

  /**
   * 热门内容（FSD A-16）：演示模式没有服务端计数，用 id 派生的稳定阅读量跑与服务端
   * 相同的衰减公式，让「热门」排序在演示里也是按阅读量而不是按发布时间。
   */
  async popularContent(
    options: {
      kind?: ContentKind;
      categoryId?: string;
      tag?: string;
      window?: '7d' | '30d' | '90d';
      limit?: number;
    } = {},
  ): Promise<import('../types').PopularContentPage> {
    await wait(120);
    const viewer = this.optionalUser();
    const days = options.window === '7d' ? 7 : options.window === '90d' ? 90 : 30;
    const since = Date.now() - days * 86_400_000;
    const limit = Math.min(50, Math.max(1, options.limit ?? 8));
    const items = this.state.contents
      .filter((item) => item.status === 'published')
      // 密码 / 仅登录内容不进榜单：与服务端的可见性规则一致。
      .filter((item) => (item.access_mode ?? 'public') === 'public')
      .filter((item) => this.canSee(item, viewer))
      .filter((item) => !options.kind || item.kind === options.kind)
      .filter((item) => !options.categoryId || item.category_id === options.categoryId)
      .filter((item) => !options.tag || (item.tags ?? []).includes(options.tag))
      .filter((item) => new Date(item.published_at ?? item.created_at).getTime() >= since)
      .map((item) => this.decorate(item, viewer))
      .sort((a, b) => demoPopularScore(b) - demoPopularScore(a))
      .slice(0, limit);
    return { items, window: options.window ?? '30d' };
  }
  async getContent(kind: ContentKind, key: string, previewToken?: string): Promise<Content> {
    await wait(120);
    const viewer = this.optionalUser();
    const content = this.findContentByKey(kind, key);
    // 预览令牌（Beta 1.2）：只对签发时那一篇内容有效，有效时未发布内容也返回 200。
    if (this.previewValid(kind, key, previewToken)) return this.decorate(content, viewer);
    const privileged = !!viewer && (content.author_id === viewer.id || canReview(viewer.role));
    // 回收站里的内容对读者等同于不存在；作者与编辑仍可打开，方便就地恢复。
    if (content.deleted_at && !privileged) {
      this.fail(404, 'not_found', '内容不存在。');
    }
    if ((content.access_mode ?? 'public') === 'password' && !privileged && !this.unlockedContent.has(content.id)) {
      this.fail(403, 'permission_denied', '这篇内容需要访问密码。', { reason: 'password_required' });
    }
    if ((content.access_mode ?? 'public') === 'members' && !viewer && !privileged) {
      this.fail(401, 'unauthenticated', '这篇内容仅登录读者可读。', { reason: 'members_only' });
    }
    if (!this.canSee(content, viewer) && !privileged) {
      this.fail(content.status === 'published' ? 401 : 404, content.status === 'published' ? 'unauthenticated' : 'not_found', '内容不可见。');
    }
    return this.decorate(content, viewer);
  }

  /** 演示模式的解锁：任何非空密码都通过，并只在当前标签页会话内记住。*/
  async unlockContent(
    kind: ContentKind,
    id: string,
    password: string,
  ): Promise<import('../types').ContentUnlockResult> {
    await wait(150);
    const content = this.findContent(kind, id);
    if ((content.access_mode ?? 'public') !== 'password') {
      this.fail(400, 'validation_failed', '这篇内容没有设置访问密码。');
    }
    if (!password.trim()) {
      this.fail(403, 'permission_denied', '访问密码不正确。', { reason: 'invalid_password' });
    }
    this.unlockedContent.add(content.id);
    return {
      unlocked: true,
      expires_at: new Date(Date.now() + 12 * 60 * 60 * 1000).toISOString(),
    };
  }

  async createDraft(kind: ContentKind, input: DraftInput): Promise<Content> {
    await wait(220);
    const user = this.user();
    if (!input.title.trim()) this.fail(400, 'validation_failed', '标题不能为空。');
    if (input.title.length > 200) this.fail(400, 'validation_failed', '标题不能超过 200 个字符。');
    if (!input.source_body.trim()) this.fail(400, 'validation_failed', '正文不能为空。');
    if (Array.from(input.source_body).length > 1_000_000) {
      this.fail(400, 'validation_failed', '正文不能超过 1000000 个字符。');
    }
    if (input.slug?.trim() && !isValidContentSlug(input.slug)) {
      this.fail(400, 'validation_failed', '路径只能使用文字、数字和连字符。');
    }
    const now = new Date().toISOString();
    const content: Content & { source_body: string; author_id: string; author_name: string } = {
      id: `${kind === 'article' ? 'cnt' : 'pst'}_${uuid().slice(0, 8)}`,
      kind,
      status: 'draft',
      title: input.title.trim(),
      slug: input.slug?.trim() || contentSlugFromTitle(input.title) || `draft-${uuid().slice(0, 6)}`,
      summary: input.summary?.slice(0, 500),
      source_format: input.source_format ?? 'markdown',
      source_body: input.source_body,
      rendered_html: renderSource(input.source_format ?? 'markdown', input.source_body),
      policy_version: 'policy-2026.10',
      created_at: now,
      updated_at: now,
      actions: [],
      author_id: user.id,
      author_name: user.display_name,
      category_id: input.category_id,
      tags: input.tags?.slice(0, 12) ?? [],
      publish_at: input.publish_at ?? undefined,
      access_mode: input.access_mode ?? 'public',
      has_access_password: !!input.access_password,
      comment_policy: input.comment_policy ?? 'inherit',
      // Beta 1.2：单篇 SEO 与封面是内容字段，演示后端也要落下来，否则演示模式下
      // 保存后刷新就丢，看起来像功能没做。
      seo_title: input.seo_title ?? '',
      seo_description: input.seo_description ?? '',
      seo_keywords: input.seo_keywords ?? '',
      canonical_url: input.canonical_url ?? '',
      og_image: input.og_image ?? '',
      robots: input.robots ?? '',
      cover_url: input.cover_url ?? '',
      cover_alt: input.cover_alt ?? '',
      cover_position: input.cover_position ?? 'center',
      cover_hidden: input.cover_hidden ?? false,
    };
    this.state.contents.unshift(content);
    this.ensureRevisions(content);
    this.log('创建草稿', content.title, this.tags(content));
    this.persist();
    return this.decorate(content, user);
  }

  async updateDraft(kind: ContentKind, id: string, input: DraftInput): Promise<Content> {
    await wait(200);
    const user = this.user();
    const content = this.findContent(kind, id);
    if (!this.canEditContent(content, user)) {
      this.fail(403, 'permission_denied', '只能编辑自己的草稿。');
    }
    if (
      content.status !== 'draft' &&
      content.status !== 'rejected' &&
      content.status !== 'pending_security_check' &&
      content.status !== 'published'
    ) {
      this.fail(409, 'content_state_invalid', '当前状态不能编辑。');
    }
    if (!input.title.trim()) this.fail(400, 'validation_failed', '标题不能为空。');
    // 首次修订前先把旧状态补。v1，之后每次保存都追加一个版本。
    this.ensureRevisions(content);
    content.title = input.title.trim();
    // 与服务端 UpdateDraft 一致：地址留空时按文章名重新生成，而不是保留旧地址。
    content.slug = input.slug?.trim() || contentSlugFromTitle(content.title);
    content.summary = input.summary?.slice(0, 500);
    content.source_format = input.source_format ?? content.source_format;
    content.source_body = input.source_body;
    content.category_id = input.category_id;
    content.tags = input.tags?.slice(0, 12) ?? [];
    if (input.publish_at !== undefined) content.publish_at = input.publish_at ?? undefined;
    if (input.access_mode) content.access_mode = input.access_mode;
    if (input.access_password) content.has_access_password = true;
    if (input.comment_policy) content.comment_policy = input.comment_policy;
    // Beta 1.2：编辑器每次保存都提交全量字段，空串表示"继承站点设置"，
    // 所以这里无条件赋值，与服务端 PATCH 的 replace 语义保持一致。
    content.seo_title = input.seo_title ?? '';
    content.seo_description = input.seo_description ?? '';
    content.seo_keywords = input.seo_keywords ?? '';
    content.canonical_url = input.canonical_url ?? '';
    content.og_image = input.og_image ?? '';
    content.robots = input.robots ?? '';
    content.cover_url = input.cover_url ?? '';
    content.cover_alt = input.cover_alt ?? '';
    content.cover_position = input.cover_position ?? 'center';
    content.cover_hidden = input.cover_hidden ?? false;
    content.rendered_html = renderSource(content.source_format, input.source_body);
    content.updated_at = new Date().toISOString();
    this.pushRevision(content, user.id, 'updated', content.updated_at);
    this.log('更新草稿', content.title);
    this.persist();
    return this.decorate(content, user);
  }

  async contentRevisions(kind: ContentKind, id: string): Promise<ContentRevisionPage> {
    await wait(120);
    const user = this.user();
    const content = this.findContent(kind, id);
    if (!this.canEditContent(content, user)) {
      this.fail(404, 'not_found', '内容不存在，或不在当前站点内。');
    }
    const items = this.ensureRevisions(content).map((revision) => this.revisionSummary(revision));
    return { items };
  }

  async contentRevision(
    kind: ContentKind,
    id: string,
    revisionId: string,
  ): Promise<ContentRevision> {
    await wait(120);
    const user = this.user();
    const content = this.findContent(kind, id);
    if (!this.canEditContent(content, user)) {
      this.fail(404, 'not_found', '内容不存在，或不在当前站点内。');
    }
    const revision = this.ensureRevisions(content).find((entry) => entry.id === revisionId);
    if (!revision) this.fail(404, 'not_found', '版本不存在。');
    return { ...revision };
  }

  async restoreContentRevision(
    kind: ContentKind,
    id: string,
    revisionId: string,
  ): Promise<Content> {
    await wait(200);
    const user = this.user();
    const content = this.findContent(kind, id);
    if (!this.canEditContent(content, user)) {
      this.fail(404, 'not_found', '内容不存在，或不在当前站点内。');
    }
    if (
      content.status !== 'draft' &&
      content.status !== 'rejected' &&
      content.status !== 'pending_security_check' &&
      content.status !== 'published'
    ) {
      this.fail(409, 'content_state_invalid', '当前状态不能回滚。');
    }
    const target = this.ensureRevisions(content).find((entry) => entry.id === revisionId);
    if (!target) this.fail(404, 'not_found', '版本不存在。');

    const now = new Date().toISOString();
    // 回滚前备份当前状态，回滚本身也可以撤销。
    this.pushRevision(content, user.id, 'rollback_backup', now);

    content.title = target.title;
    content.slug = target.slug;
    content.summary = target.summary;
    content.source_format = target.source_format;
    content.source_body = target.source_body;
    content.category_id = target.category_id;
    content.tags = [...(target.tags ?? [])];
    content.rendered_html = renderSource(target.source_format, target.source_body);
    content.updated_at = now;

    this.pushRevision(content, user.id, 'rollback', now);
    this.log('回滚版本', content.title, `v${target.version}`);
    this.persist();
    return this.decorate(content, user);
  }

  private revisionSummary(revision: DemoRevision): ContentRevision {
    const summary: ContentRevision = { ...revision };
    delete summary.source_body;
    delete summary.rendered_html;
    delete summary.policy_version;
    return summary;
  }

  async contentAction(
    kind: ContentKind,
    id: string,
    action: ContentAction,
    reason?: string,
  ): Promise<Content> {
    await wait(200);
    const user = this.user();
    const content = this.findContent(kind, id);
    const isAuthor = content.author_id === user.id;
    const reviewer = canReview(user.role);
    const owner = isAuthor || user.role === 'site_admin' || user.role === 'platform_admin';

    if (action === 'submit') {
      if (content.status !== 'draft' || !owner) this.fail(409, 'content_state_invalid', '当前状态不能提交审核。');
      content.status = 'pending_review';
      content.updated_at = new Date().toISOString();
      this.log('提交审核', content.title);
    } else if (action === 'publish') {
      const mode = this.state.site.publish_mode;
      if (content.status === 'draft') {
        if (!owner) this.fail(403, 'permission_denied', '只能发布自己的内容。');
        if (!reviewer && mode !== 'open') {
          this.fail(403, 'permission_denied', '当前站点的发布模式要求先提交审核。');
        }
      } else if (content.status === 'pending_review') {
        if (!reviewer) this.fail(403, 'permission_denied', '只有编辑或管理员可以审核。');
        if (isAuthor) this.fail(403, 'permission_denied', '作者不能审核自己的内容。');
      } else {
        this.fail(409, 'content_state_invalid', '当前状态不能直接发布。');
      }
      content.status = 'published';
      content.published_at = content.published_at ?? new Date().toISOString();
      content.updated_at = new Date().toISOString();
      this.log('发布', content.title);
      this.notify({
        user_id: content.author_id,
        type: 'moderation.updated',
        payload: { title: content.title, excerpt: '你的内容已发布。', kind: content.kind, target_id: content.id },
      });
    } else if (action === 'reject') {
      if (content.status !== 'pending_review' || !reviewer) {
        this.fail(409, 'content_state_invalid', '当前状态不能退回。');
      }
      if (isAuthor) this.fail(403, 'permission_denied', '作者不能审核自己的内容。');
      content.status = 'rejected';
      content.updated_at = new Date().toISOString();
      this.log('退。', content.title, reason || '未填写理。');
      this.notify({
        user_id: content.author_id,
        type: 'moderation.updated',
        payload: {
          title: content.title,
          excerpt: reason ? `退回理由：${reason}` : '内容被退回，请修改后重新提交。',
          kind: content.kind,
          target_id: content.id,
        },
      });
    } else if (action === 'archive') {
      if (content.status !== 'published' || !reviewer) {
        this.fail(409, 'content_state_invalid', '当前状态不能归档。');
      }
      content.status = 'archived';
      content.updated_at = new Date().toISOString();
      this.log('归档', content.title);
    } else if (action === 'unpublish') {
      // 撤销发布（Beta 1.2，契约 I 节）：published → draft，并清空 published_at。
      if (content.status !== 'published') {
        this.fail(409, 'content_state_invalid', '只有已发布内容可以撤销发布。');
      }
      if (!owner && !reviewer) this.fail(403, 'permission_denied', '没有撤销发布的权限。');
      content.status = 'draft';
      delete content.published_at;
      content.updated_at = new Date().toISOString();
      this.log('撤销发布', content.title);
    } else if (action === 'restore') {
      if (!owner && !reviewer) this.fail(403, 'permission_denied', '没有恢复权限。');
      if (content.status === 'rejected') content.status = 'draft';
      else if (content.status === 'archived') {
        content.status = 'published';
        content.published_at = content.published_at ?? new Date().toISOString();
      } else {
        this.fail(409, 'content_state_invalid', '当前状态不能恢复。');
      }
      content.updated_at = new Date().toISOString();
      this.log('恢复', content.title, content.status);
    } else if (action === 'undelete') {
      // 回收站恢复只清 deleted_at，状态保持删除前的样子。
      if (!owner && !reviewer) this.fail(403, 'permission_denied', '没有恢复权限。');
      if (!content.deleted_at) this.fail(409, 'content_state_invalid', '这条内容不在回收站里。');
      delete content.deleted_at;
      content.updated_at = new Date().toISOString();
      this.log('恢复内容', content.title);
    } else if (action === 'purge') {
      if (!owner && !reviewer) this.fail(403, 'permission_denied', '没有彻底删除权限。');
      if (!content.deleted_at) this.fail(409, 'content_state_invalid', '只有回收站里的内容可以彻底删除。');
      this.state.contents = this.state.contents.filter((item) => item.id !== content.id);
      this.log('彻底删除', content.title);
      this.persist();
      return this.decorate(content, user);
    } else if (action === 'security-retry') {
      if (content.status !== 'pending_security_check' || (!owner && !reviewer)) {
        this.fail(409, 'content_state_invalid', '当前状态不能重试安全检查。');
      }
      content.status = 'published';
      content.published_at = content.published_at ?? new Date().toISOString();
      content.updated_at = new Date().toISOString();
      this.log('重试安全检。', content.title, '通过');
    } else {
      this.fail(400, 'validation_failed', '未知的流程动作。');
    }
    this.persist();
    return this.decorate(content, user);
  }

  /**
   * 移入回收站（Beta 1.2）。
   *
   * 演示模式与服务端保持同一套语义：软删除、可恢复、彻底删除才真正移除。
   * 早期版本的演示后端允许 `restore` 直接救回被驳回的内容，真实后端不允许，
   * 于是"被驳回后重新提交"在演示里能过、在真实站点报错——这个差异在这里一并修掉。
   */
  async deleteContent(kind: ContentKind, id: string): Promise<Content> {
    await wait(160);
    const user = this.user();
    const content = this.findContent(kind, id);
    const owner =
      content.author_id === user.id || user.role === 'site_admin' || user.role === 'platform_admin';
    if (!owner && !canReview(user.role)) this.fail(403, 'permission_denied', '没有删除权限。');
    content.deleted_at = content.deleted_at ?? new Date().toISOString();
    content.updated_at = new Date().toISOString();
    this.log('移入回收站', content.title);
    this.persist();
    return this.decorate(content, user);
  }

  /** 从回收站彻底删除；只剩这一条路径会真正移除内容。 */
  async purgeContent(kind: ContentKind, id: string): Promise<void> {
    await wait(160);
    const user = this.user();
    const content = this.findContent(kind, id);
    const owner =
      content.author_id === user.id || user.role === 'site_admin' || user.role === 'platform_admin';
    if (!owner && !canReview(user.role)) this.fail(403, 'permission_denied', '没有彻底删除权限。');
    if (!content.deleted_at) this.fail(409, 'content_state_invalid', '只有回收站里的内容可以彻底删除。');
    this.state.contents = this.state.contents.filter((item) => item.id !== content.id);
    this.log('彻底删除', content.title);
    this.persist();
  }

  /**
   * 演示用全文检索。
   *
   * 没有 FTS 引擎，但接口形状与真实后端一致：相关度排序（标题命中优先，其次按时间）。
   * 真实游标（把 next_cursor 传回 cursor 取下一页）、全。total 与纯文本片段。
   * 筛选条件与服务端相同，密码 / 仅登录内容一律不进结果。
   */
  async search(q: string, options: SearchQuery = {}): Promise<SearchResult> {
    await wait(160);
    if (q.trim().length < 2) this.fail(400, 'validation_failed', '搜索词至少 2 个字符。');
    const viewer = this.optionalUser();
    if (this.state.site.visibility_mode === 'members_only' && !viewer) {
      this.fail(401, 'unauthenticated', '该站点仅对成员开放，请先登录。');
    }

    const term = q.trim().toLowerCase();
    const limit = Math.min(100, Math.max(1, options.limit ?? 20));
    const offset = options.cursor ? Number(options.cursor.replace(/^s:/, '')) : 0;
    if (!Number.isInteger(offset) || offset < 0) {
      this.fail(400, 'invalid_cursor', '分页游标无效。');
    }

    const matches = this.state.contents
      .filter((c) => c.status === 'published')
      .filter((c) => (c.access_mode ?? 'public') === 'public')
      .filter((c) => this.canSee(c, viewer))
      .filter((c) => !options.kind || c.kind === options.kind)
      .filter((c) => !options.category_id || c.category_id === options.category_id)
      .filter((c) => !options.tag || (c.tags ?? []).includes(options.tag))
      .filter((c) => !options.author_id || c.author_id === options.author_id)
      .filter((c) => !options.since || (c.created_at ?? '') >= options.since)
      .filter((c) => !options.until || (c.created_at ?? '') <= options.until)
      .filter((c) => {
        const haystack = `${c.title} ${c.summary ?? ''} ${htmlToText(c.rendered_html ?? '')}`;
        return haystack.toLowerCase().includes(term);
      })
      .sort((a, b) => {
        const titleHit =
          Number(b.title.toLowerCase().includes(term)) -
          Number(a.title.toLowerCase().includes(term));
        if (titleHit !== 0) return titleHit;
        return (b.published_at ?? b.created_at).localeCompare(a.published_at ?? a.created_at);
      });

    const slice = matches.slice(offset, offset + limit);
    const next = offset + slice.length;
    return {
      items: slice.map((c) => ({
        ...this.decorate(c, viewer),
        ...(options.highlight === false ? {} : { snippet: demoSnippet(c, term) }),
      })),
      total: matches.length,
      next_cursor: next < matches.length ? `s:${next}` : '',
      has_more: next < matches.length,
    };
  }

  async comments(targetType: string, targetId: string): Promise<CommentsResult> {
    await wait(120);
    const viewer = this.optionalUser();
    const moderator = !!viewer && canReview(viewer.role);
    const items = this.state.comments
      .filter((c) => c.target_type === targetType && c.target_id === targetId)
      .filter((c) => {
        if (c.status === 'visible') return true;
        if (c.status === 'pending_review') {
          // 待审核评论只对作者本人与审核员可见，避免先审后发时提前曝光。
          return moderator || c.author_id === viewer?.id;
        }
        return false;
      })
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    return { items, supported: true };
  }

  async allComments(query: CommentQuery = {}): Promise<CommentPage> {
    await wait(140);
    this.requireRole('editor');
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const offset = query.cursor ? Number(query.cursor.replace(/^o:/, '')) : 0;
    const term = query.q?.trim().toLowerCase() ?? '';

    const scoped = this.state.comments.filter((c) => {
      if (query.target_type && c.target_type !== query.target_type) return false;
      if (query.target_id && c.target_id !== query.target_id) return false;
      return true;
    });

    const counts: Record<string, number> = { all: scoped.length };
    for (const status of ['visible', 'pending_review', 'hidden', 'deleted'] as const) {
      counts[status] = scoped.filter((c) => c.status === status).length;
    }

    const filtered = scoped
      .filter((c) => !query.status || query.status === 'all' || c.status === query.status)
      .filter((c) => !term || `${c.author_name ?? ''} ${c.body}`.toLowerCase().includes(term))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));

    const slice = filtered.slice(offset, offset + limit);
    const next = offset + limit;
    return {
      items: slice,
      next_cursor: next < filtered.length ? `o:${next}` : '',
      has_more: next < filtered.length,
      supported: true,
      counts,
    };
  }

  async moderateComment(id: string, action: CommentModerationAction): Promise<void> {
    await wait(160);
    const actor = this.requireRole('editor');
    const comment = this.state.comments.find((c) => c.id === id);
    if (!comment) this.fail(404, 'not_found', '评论不存在。');
    const status = action === 'approve' ? 'visible' : action === 'hide' ? 'hidden' : 'deleted';
    comment.status = status;
    const label = action === 'approve' ? '通过评论' : action === 'hide' ? '隐藏评论' : '删除评论';
    this.log(label, comment.body.slice(0, 24), comment.author_name);
    if (comment.author_id !== actor.id && action !== 'delete') {
      this.notify({
        user_id: comment.author_id,
        type: 'moderation.updated',
        subject_id: comment.id,
        payload: {
          excerpt: action === 'approve' ? '你的评论已通过审核。' : '你的评论已被隐藏。',
          kind: comment.target_type,
          target_id: comment.target_id,
        },
      });
    }
    this.persist();
  }

  async report(input: ReportInput): Promise<Report> {
    await wait(120);
    const user = this.user();
    if (!input.target_id.trim()) this.fail(400, 'validation_failed', '举报目标不能为空。');
    const targetAuthor = this.reportTargetAuthor(input.target_type, input.target_id);
    if (targetAuthor === user.id) this.fail(400, 'validation_failed', '不能举报自己的内容。');
    const reports = this.state.reports ?? [];
    if (
      reports.some(
        (item) =>
          item.reporter_id === user.id &&
          item.target_type === input.target_type &&
          item.target_id === input.target_id,
      )
    ) {
      this.fail(409, 'conflict', '你已经举报过这条内容。');
    }
    const now = new Date().toISOString();
    const report: Report = {
      id: `rpt_${uuid().slice(0, 8)}`,
      reporter_id: user.id,
      target_type: input.target_type,
      target_id: input.target_id,
      reason: input.reason,
      note: input.note?.trim() ?? '',
      status: 'open',
      created_at: now,
      updated_at: now,
    };
    this.state.reports = [...reports, report];
    this.log('提交举报', `${input.target_type}:${input.target_id}`);
    this.persist();
    return report;
  }

  async reports(): Promise<Report[]> {
    await wait(100);
    this.requireRole('editor');
    return (this.state.reports ?? [])
      .filter((item) => item.status === 'open' || item.status === 'assigned')
      .slice()
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async assignReport(id: string): Promise<Report> {
    await wait(100);
    const actor = this.requireRole('editor');
    const report = (this.state.reports ?? []).find((item) => item.id === id);
    if (!report) this.fail(404, 'not_found', '举报不存在。');
    if (report.status !== 'open' && report.status !== 'assigned') {
      this.fail(409, 'conflict', '这条举报已经处理。');
    }
    report.status = 'assigned';
    report.assignee_id = actor.id;
    report.updated_at = new Date().toISOString();
    this.persist();
    return report;
  }

  async resolveReport(id: string, action: ReportAction, note = ''): Promise<Report> {
    await wait(140);
    const actor = this.requireRole('editor');
    const report = (this.state.reports ?? []).find((item) => item.id === id);
    if (!report) this.fail(404, 'not_found', '举报不存在。');
    if (report.status === 'resolved' || report.status === 'dismissed') {
      this.fail(409, 'conflict', '这条举报已经处理。');
    }
    const targetAuthor = this.reportTargetAuthor(report.target_type, report.target_id);
    if (action === 'takedown') {
      if (report.target_type === 'article' || report.target_type === 'post') {
        const content = this.state.contents.find((item) => item.id === report.target_id);
        if (content) content.status = 'archived';
      } else if (report.target_type === 'comment') {
        const comment = this.state.comments.find((item) => item.id === report.target_id);
        if (comment) comment.status = 'hidden';
      } else {
        this.fail(400, 'validation_failed', '账户类举报请使用封禁动作。');
      }
    } else if (action === 'ban') {
      const target = this.state.users.find((item) => item.id === targetAuthor);
      if (!target) this.fail(404, 'not_found', '目标账户不存在。');
      target.status = 'disabled';
    }
    report.status = action === 'ignore' ? 'dismissed' : 'resolved';
    report.assignee_id = report.assignee_id ?? actor.id;
    report.note = note.trim() || report.note;
    report.updated_at = new Date().toISOString();
    if (report.reporter_id !== actor.id) {
      this.notify({
        user_id: report.reporter_id,
        type: 'moderation.updated',
        actor_id: actor.id,
        subject_id: report.id,
        payload: {
          report_id: report.id,
          target_type: report.target_type,
          target_id: report.target_id,
          action,
          status: report.status,
        },
      });
    }
    if (targetAuthor && targetAuthor !== actor.id && targetAuthor !== report.reporter_id) {
      this.notify({
        user_id: targetAuthor,
        type: 'moderation.updated',
        actor_id: actor.id,
        subject_id: report.id,
        payload: {
          report_id: report.id,
          target_type: report.target_type,
          target_id: report.target_id,
          action,
          status: report.status,
        },
      });
    }
    this.log(action === 'ignore' ? '忽略举报' : action === 'takedown' ? '举报下架内容' : '举报封禁账户', report.target_id);
    this.persist();
    return report;
  }

  /** 举报目标作者：内容。author_id，评论查作者，账户就是目标本身。*/
  private reportTargetAuthor(targetType: Report['target_type'], targetId: string): string {
    if (targetType === 'article' || targetType === 'post') {
      const content = this.state.contents.find((item) => item.id === targetId);
      if (!content) this.fail(404, 'not_found', '举报目标不存在。');
      return content.author_id;
    }
    if (targetType === 'comment') {
      const comment = this.state.comments.find((item) => item.id === targetId);
      if (!comment) this.fail(404, 'not_found', '举报目标不存在。');
      return comment.author_id;
    }
    const target = this.state.users.find((item) => item.id === targetId);
    if (!target) this.fail(404, 'not_found', '举报目标不存在。');
    return target.id;
  }

  async createComment(
    input: {
      target_type: 'article' | 'post' | 'comment' | 'page';
      target_id: string;
      parent_id?: string;
      body: string;
    },
    policy?: { require_review?: boolean },
  ) {
    await wait(180);
    const user = this.user();
    if (!input.body.trim()) this.fail(400, 'validation_failed', '评论不能为空。');
    if (input.body.length > 5000) this.fail(400, 'validation_failed', '评论不能超过 5000 个字符。');
    if (input.target_type === 'article' || input.target_type === 'post') {
      this.findContent(input.target_type, input.target_id);
    }
    let depth = 0;
    if (input.parent_id) {
      const parent = this.state.comments.find((c) => c.id === input.parent_id);
      if (!parent) this.fail(404, 'not_found', '父评论不存在。');
      depth = parent.depth + 1;
      if (depth > 2) this.fail(400, 'validation_failed', '回复层级最多三层。');
    }
    const pending = policy?.require_review === true;
    const comment: DemoComment = {
      id: `cmt_${uuid().slice(0, 8)}`,
      target_type: input.target_type,
      target_id: input.target_id,
      parent_id: input.parent_id,
      depth,
      body: input.body.trim(),
      status: pending ? 'pending_review' : 'visible',
      author_id: user.id,
      author_name: user.display_name,
      created_at: new Date().toISOString(),
    };
    this.state.comments.push(comment);
    const target = this.state.contents.find((c) => c.id === input.target_id);
    if (target && !pending) {
      this.notify({
        user_id: target.author_id,
        type: 'comment.created',
        actor_id: user.id,
        subject_id: comment.id,
        payload: {
          actor_name: user.display_name,
          title: target.title,
          excerpt: comment.body.slice(0, 60),
          kind: target.kind,
          target_id: target.id,
        },
      });
    }
    this.log(pending ? '提交评论待审' : '发表评论', target?.title ?? input.target_id);
    this.persist();
    return comment;
  }

  async updateComment(id: string, body: string) {
    await wait(160);
    const user = this.user();
    const comment = this.state.comments.find((c) => c.id === id);
    if (!comment) this.fail(404, 'not_found', '评论不存在。');
    if (comment.author_id !== user.id) this.fail(403, 'permission_denied', '只能编辑自己的评论。');
    if (!body.trim()) this.fail(400, 'validation_failed', '评论不能为空。');
    comment.body = body.trim();
    this.persist();
    return comment;
  }

  async deleteComment(id: string): Promise<void> {
    await wait(160);
    const user = this.user();
    const comment = this.state.comments.find((c) => c.id === id);
    if (!comment) this.fail(404, 'not_found', '评论不存在。');
    if (comment.author_id !== user.id && !canReview(user.role)) {
      this.fail(403, 'permission_denied', '没有删除该评论的权限。');
    }
    comment.status = 'deleted';
    this.log('删除评论', comment.body.slice(0, 24));
    this.persist();
  }

  async toggleReaction(
    targetType: 'article' | 'post' | 'comment',
    targetId: string,
    kind: 'like' | 'love' | 'insightful' = 'like',
    active?: boolean,
  ): Promise<ToggleResult> {
    await wait(100);
    const user = this.user();
    const index = this.state.reactions.findIndex(
      (r) => r.user_id === user.id && r.target_type === targetType && r.target_id === targetId && r.kind === kind,
    );
    const next = active ?? index < 0;
    if (next && index < 0) {
      this.state.reactions.push({ user_id: user.id, target_type: targetType, target_id: targetId, kind });
    } else if (!next && index >= 0) {
      this.state.reactions.splice(index, 1);
    }
    this.persist();
    return { active: next };
  }

  async toggleBookmark(
    targetType: 'article' | 'post',
    targetId: string,
    active?: boolean,
  ): Promise<ToggleResult> {
    await wait(100);
    const user = this.user();
    const index = this.state.bookmarks.findIndex(
      (b) => b.user_id === user.id && b.target_type === targetType && b.target_id === targetId,
    );
    const next = active ?? index < 0;
    if (next && index < 0) {
      this.state.bookmarks.push({ user_id: user.id, target_type: targetType, target_id: targetId });
    } else if (!next && index >= 0) {
      this.state.bookmarks.splice(index, 1);
    }
    this.persist();
    return { active: next };
  }

  async toggleFollow(userId: string, active?: boolean): Promise<ToggleResult> {
    await wait(100);
    const user = this.user();
    if (userId === user.id) this.fail(400, 'validation_failed', '不能关注自己。');
    if (!this.state.users.some((u) => u.id === userId)) this.fail(404, 'not_found', '用户不存在。');
    const index = this.state.follows.findIndex(
      (f) => f.follower_id === user.id && f.followee_id === userId,
    );
    const next = active ?? index < 0;
    if (next && index < 0) this.state.follows.push({ follower_id: user.id, followee_id: userId });
    else if (!next && index >= 0) this.state.follows.splice(index, 1);
    this.persist();
    return { active: next };
  }

  async stateFor(
    targetType: string,
    targetId: string,
    userId?: string,
  ): Promise<{ liked: boolean; bookmarked: boolean; following: boolean }> {
    const me = this.currentId;
    return {
      liked: this.state.reactions.some(
        (r) => r.user_id === me && r.target_type === targetType && r.target_id === targetId && r.kind === 'like',
      ),
      bookmarked: this.state.bookmarks.some(
        (b) => b.user_id === me && b.target_type === targetType && b.target_id === targetId,
      ),
      following: !!userId && this.state.follows.some((f) => f.follower_id === me && f.followee_id === userId),
    };
  }

  async interactionStates(
    targetType: string,
    targetIds: string[],
    authorIds: string[] = [],
  ): Promise<InteractionStates> {
    const me = this.currentId;
    return {
      items: targetIds.map((id) => ({
        target_id: id,
        liked: this.state.reactions.some(
          (r) => r.user_id === me && r.target_type === targetType && r.target_id === id && r.kind === 'like',
        ),
        bookmarked: this.state.bookmarks.some(
          (b) => b.user_id === me && b.target_type === targetType && b.target_id === id,
        ),
      })),
      follows: authorIds.map((id) => ({
        user_id: id,
        following: this.state.follows.some((f) => f.follower_id === me && f.followee_id === id),
      })),
    };
  }

  private interactionEntry(
    targetType: string,
    targetId: string,
    createdAt: string,
  ): InteractionEntry {
    const content = this.state.contents.find(
      (item) => item.id === targetId && item.kind === targetType,
    );
    return {
      target_type: targetType as InteractionEntry['target_type'],
      target_id: targetId,
      created_at: createdAt,
      title: content?.title,
      summary: content?.summary,
      kind: content?.kind,
      author_id: content?.author_id,
      author_name: content?.author_name,
      published_at: content?.published_at,
      available: content?.status === 'published',
    };
  }

  async bookmarks(options: { limit?: number; cursor?: string; targetType?: string } = {}): Promise<
    Page<InteractionEntry>
  > {
    await wait(80);
    const me = this.currentId;
    const items = this.state.bookmarks
      .filter((b) => b.user_id === me && (!options.targetType || b.target_type === options.targetType))
      .map((b) => this.interactionEntry(b.target_type, b.target_id, new Date().toISOString()))
      .slice(0, options.limit ?? 30);
    return { items, next_cursor: '', has_more: false };
  }

  async likes(options: { limit?: number; cursor?: string; targetType?: string; kind?: string } = {}): Promise<
    Page<InteractionEntry>
  > {
    await wait(80);
    const me = this.currentId;
    const kind = options.kind ?? 'like';
    const items = this.state.reactions
      .filter(
        (r) =>
          r.user_id === me &&
          r.kind === kind &&
          (!options.targetType || r.target_type === options.targetType),
      )
      .map((r) => this.interactionEntry(r.target_type, r.target_id, new Date().toISOString()))
      .slice(0, options.limit ?? 30);
    return { items, next_cursor: '', has_more: false };
  }

  async readingHistory(options: { limit?: number; cursor?: string; targetType?: string } = {}): Promise<
    Page<ReadingHistoryEntry>
  > {
    await wait(80);
    const me = this.currentId;
    const items = (this.state.reading_history ?? [])
      .filter((row) => row.user_id === me && (!options.targetType || row.target_type === options.targetType))
      .sort((a, b) => b.last_viewed_at.localeCompare(a.last_viewed_at))
      .map((row) => {
        const entry = this.interactionEntry(row.target_type, row.target_id, row.last_viewed_at);
        return {
          ...entry,
          last_viewed_at: row.last_viewed_at,
          view_count: row.view_count,
        } as ReadingHistoryEntry;
      })
      .slice(0, options.limit ?? 30);
    return { items, next_cursor: '', has_more: false };
  }

  async recordReading(targetType: 'article' | 'post', targetId: string): Promise<void> {
    if (!this.currentId) return;
    const me = this.currentId;
    if (!this.state.reading_history) this.state.reading_history = [];
    const at = new Date().toISOString();
    const existing = this.state.reading_history.find(
      (row) => row.user_id === me && row.target_type === targetType && row.target_id === targetId,
    );
    if (existing) {
      existing.last_viewed_at = at;
      existing.view_count += 1;
    } else {
      this.state.reading_history.push({
        user_id: me,
        target_type: targetType,
        target_id: targetId,
        last_viewed_at: at,
        view_count: 1,
      });
    }
    this.persist();
  }

  private followEntries(ids: string[]): FollowEntry[] {
    return ids
      .map((id) => this.state.users.find((user) => user.id === id))
      .filter((user): user is NonNullable<typeof user> => !!user)
      .map((user) => ({
        user_id: user.id,
        display_name: user.display_name,
        bio: user.bio,
        avatar_media_id: user.avatar_media_id,
        since: user.created_at,
      }));
  }

  async following(options: { limit?: number } = {}): Promise<Page<FollowEntry>> {
    await wait(80);
    const me = this.currentId;
    const ids = this.state.follows
      .filter((f) => f.follower_id === me)
      .map((f) => f.followee_id)
      .slice(0, options.limit ?? 30);
    return { items: this.followEntries(ids), next_cursor: '', has_more: false };
  }

  async followers(options: { limit?: number } = {}): Promise<Page<FollowEntry>> {
    await wait(80);
    const me = this.currentId;
    const ids = this.state.follows
      .filter((f) => f.followee_id === me)
      .map((f) => f.follower_id)
      .slice(0, options.limit ?? 30);
    return { items: this.followEntries(ids), next_cursor: '', has_more: false };
  }

  async memberDirectory(options: { query?: string; limit?: number } = {}): Promise<PublicProfile[]> {
    await wait(80);
    const query = (options.query ?? '').trim().toLowerCase();
    return this.state.users
      .filter((user) => !query || user.display_name.toLowerCase().includes(query))
      .slice(0, options.limit ?? 100)
      .map((user) => ({
        user_id: user.id,
        display_name: user.display_name,
        bio: user.bio,
        avatar_media_id: user.avatar_media_id,
        role: user.role,
        created_at: user.created_at,
      }));
  }

  async upload(
    file: File,
    purpose: 'content' | 'avatar' | 'attachment' | 'site',
    onProgress?: (percent: number) => void,
  ): Promise<Asset> {
    this.user();
    if (!MIME_ALLOWED.includes(file.type)) {
      this.fail(400, 'validation_failed', '不支持的文件类型。');
    }
    if (file.size > DEMO_UPLOAD_LIMIT) {
      this.fail(400, 'validation_failed', '演示模式单文件上限 2 MB。');
    }
    onProgress?.(25);
    await wait(200);
    onProgress?.(70);
    const url = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('read failed'));
      reader.readAsDataURL(file);
    });
    onProgress?.(100);
    const asset: Asset = {
      id: `ast_${uuid().slice(0, 8)}`,
      storage_key: `demo/${uuid()}/${file.name}`,
      mime_type: file.type,
      size: file.size,
      scan_status: 'clean',
      file_name: file.name,
      url,
    };
    this.state.assets.unshift(asset);
    this.log('上传媒体', file.name, `${purpose} · 检查通过`);
    this.persist();
    return asset;
  }

  async listAssets(): Promise<Asset[]> {
    await wait(80);
    return this.state.assets;
  }

  /** 删除一份媒体（Beta 1.2）。演示里没有引用计数，直接移除。 */
  async deleteAsset(id: string): Promise<void> {
    await wait(80);
    this.user();
    if (!this.state.assets.some((asset) => asset.id === id)) {
      this.fail(404, 'not_found', '素材不存在。');
    }
    this.state.assets = this.state.assets.filter((asset) => asset.id !== id);
    this.persist();
  }

  /**
   * 演示模式的素材本来就存成 data URL，`<img>` 直接能显示；
   * 真实后端需要带鉴权取字节，。HttpBackend.assetSrc。
   */
  async assetSrc(url: string): Promise<string> {
    return url;
  }

  async conversations(): Promise<Conversation[]> {
    await wait(140);
    const user = this.user();
    return this.state.conversations
      .filter((c) => c.members.includes(user.id))
      .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
  }

  async createConversation(memberIds: string[]): Promise<Conversation> {
    await wait(160);
    const user = this.user();
    const others = [...new Set(memberIds.filter((id) => id !== user.id))];
    if (!others.length) this.fail(400, 'validation_failed', '至少选择一位成员。');
    const conv: Conversation = {
      id: `cnv_${uuid().slice(0, 8)}`,
      kind: others.length === 1 ? 'direct' : 'group',
      created_by: user.id,
      members: [user.id, ...others],
      title:
        others.length === 1
          ? this.state.users.find((u) => u.id === others[0])?.display_name
          : `新会。· ${others.length + 1} 人`,
      last_message: '',
      updated_at: new Date().toISOString(),
      unread: 0,
    };
    this.state.conversations.unshift(conv);
    this.persist();
    return conv;
  }

  async messages(conversationId: string): Promise<Message[]> {
    await wait(120);
    const user = this.user();
    const conv = this.state.conversations.find((c) => c.id === conversationId);
    if (!conv || !conv.members.includes(user.id)) this.fail(404, 'not_found', '会话不存在。');
    return this.state.messages
      .filter((m) => m.conversation_id === conversationId)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
  }

  async sendMessage(conversationId: string, body: string): Promise<Message> {
    await wait(160);
    const user = this.user();
    const conv = this.state.conversations.find((c) => c.id === conversationId);
    if (!conv || !conv.members.includes(user.id)) this.fail(404, 'not_found', '会话不存在。');
    if (!body.trim()) this.fail(400, 'validation_failed', '消息不能为空。');
    const message: Message = {
      id: `msg_${uuid().slice(0, 8)}`,
      conversation_id: conversationId,
      sender_id: user.id,
      sender_name: user.display_name,
      body: body.trim().slice(0, 5000),
      created_at: new Date().toISOString(),
    };
    this.state.messages.push(message);
    conv.last_message = message.body;
    conv.updated_at = message.created_at;
    this.persist();
    return message;
  }

  async markConversationRead(conversationId: string, _messageId: string): Promise<{ advanced: boolean }> {
    const conv = this.state.conversations.find((c) => c.id === conversationId);
    if (conv) {
      conv.unread = 0;
      this.persist();
    }
    return { advanced: true };
  }

  async notifications(): Promise<{ items: Notification[]; unread: number }> {
    await wait(80);
    if (!this.currentId) this.fail(401, 'unauthenticated', '请先登录。');
    const items = this.state.notifications
      .filter((n) => !n.recipient_id || n.recipient_id === this.currentId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    return { items, unread: items.filter((n) => !n.read).length };
  }

  async markNotificationRead(id: string): Promise<Notification> {
    await wait(80);
    const item = this.state.notifications.find((n) => n.id === id);
    if (!item || (item.recipient_id && item.recipient_id !== this.currentId)) {
      this.fail(404, 'not_found', '通知不存在。');
    }
    if (!item.read) {
      item.read = true;
      item.read_at = new Date().toISOString();
      this.persist();
    }
    return item;
  }

  /**
   * 联系表单。
   *
   * 演示模式不该碰网络：渲染器在演示模式下直接进入成功态，**根本不会调用这里**。
   * 这个方法只是接口的完整实现，返回成功即可——演示数据里没有站长信箱可写。
   */
  async contactSite(_siteId: string, _input: ContactPayload): Promise<void> {
    await wait(120);
  }

  async markAllNotificationsRead(): Promise<number> {
    await wait(120);
    let updated = 0;
    for (const n of this.state.notifications) {
      if (n.recipient_id && n.recipient_id !== this.currentId) continue;
      if (!n.read) {
        n.read = true;
        n.read_at = new Date().toISOString();
        updated += 1;
      }
    }
    this.persist();
    return updated;
  }

  async notificationPreferences(): Promise<NotificationPreferences> {
    await wait(60);
    this.user();
    return this.notificationPrefs;
  }

  async updateNotificationPreferences(
    input: NotificationPreferences,
  ): Promise<NotificationPreferences> {
    await wait(120);
    this.user();
    // 演示模式无法真的发邮件，email_configured 始终。false。
    this.notificationPrefs = { ...input, email_configured: false };
    return this.notificationPrefs;
  }

  async activity(): Promise<ActivityEntry[]> {
    return this.state.activity;
  }

  async demoMembers(): Promise<DemoUser[]> {
    return this.state.users;
  }

  async demoUser(id: string): Promise<DemoUser | null> {
    return this.state.users.find((u) => u.id === id) ?? null;
  }

  async publicUser(userId: string): Promise<PublicProfile> {
    await wait(60);
    const user = this.state.users.find((item) => item.id === userId);
    if (!user) this.fail(404, 'not_found', '这位成员不在当前站点里。');
    return {
      user_id: user.id,
      display_name: user.display_name,
      role: user.role,
      created_at: user.created_at,
    };
  }

  async demoFollowing(): Promise<string[]> {
    if (!this.currentId) return [];
    return this.state.follows.filter((f) => f.follower_id === this.currentId).map((f) => f.followee_id);
  }

  async demoCommentsCount(): Promise<number> {
    return this.state.comments.filter((c) => c.status === 'visible').length;
  }

  currentRole(): Role {
    return roleOf(this.state, this.currentId);
  }

  async recordVisit(_input: {
    path: string;
    title: string;
    referrer: string;
    session: string;
    surface: VisitSurface;
  }): Promise<void> {
    // 演示数据没有服务端；访问记录。lib/analytics 的本地存储负责。
  }

  /**
   * 演示统计（Beta 1.2，契约 M 节）。
   *
   * 演示模式没有服务端计数，用确定性公式生成一份形状完整的响应：既有 totals /
   * series / top_pages / top_content / recent，也有来源 / 设备 / 引荐 / 留存四个
   * 新维度。数字随 range 与日期变化，但同一输入始终一致。
   */
  async analytics(_siteId: string, range: AnalyticsRange): Promise<SiteAnalytics | null> {
    await wait(80);
    const days = range === '24h' ? 1 : range === '7d' ? 7 : 30;
    const buckets = range === '24h' ? 24 : days;
    const now = new Date();
    const series = Array.from({ length: buckets }, (_, index) => {
      const count = 6 + ((index * 13 + days * 5) % 23);
      if (range === '24h') {
        const hour = new Date(now.getTime() - (buckets - 1 - index) * 3_600_000);
        return { label: `${String(hour.getHours()).padStart(2, '0')}:00`, count };
      }
      const day = new Date(now.getTime() - (buckets - 1 - index) * 86_400_000);
      return { label: `${day.getMonth() + 1}/${day.getDate()}`, count };
    });
    const views = series.reduce((sum, point) => sum + point.count, 0);
    const sessions = Math.max(1, Math.round(views * 0.68));

    const published = this.state.contents.filter((item) => item.status === 'published');
    const topContent = published.slice(0, 5).map((item, index) => ({
      id: item.id,
      count: Math.max(1, 24 - index * 4),
    }));
    // 站点内路径前缀由内容类型决定：文章 /a/，帖子 /p/。
    const pathOf = (id: string): string => {
      const item = this.state.contents.find((content) => content.id === id);
      const prefix = item?.kind === 'post' ? 'p' : 'a';
      return `/${prefix}/${item?.slug || id}`;
    };
    const recent = topContent.slice(0, 6).map((item, index) => {
      const target = this.state.contents.find((content) => content.id === item.id);
      return {
        path: pathOf(item.id),
        title: target?.title ?? '',
        referrer: index % 3 === 0 ? 'https://www.google.com/' : index % 3 === 1 ? '' : '/',
        session: `vs_seed_${index}`,
        created_at: new Date(now.getTime() - (index + 1) * 17 * 60_000).toISOString(),
      };
    });

    const sources = [
      { source: 'direct' as const, visits: Math.round(views * 0.38), sessions: Math.round(sessions * 0.38) },
      { source: 'search' as const, visits: Math.round(views * 0.31), sessions: Math.round(sessions * 0.3) },
      { source: 'social' as const, visits: Math.round(views * 0.16), sessions: Math.round(sessions * 0.17) },
      { source: 'internal' as const, visits: Math.round(views * 0.1), sessions: Math.round(sessions * 0.1) },
      { source: 'referral' as const, visits: Math.round(views * 0.05), sessions: Math.round(sessions * 0.05) },
    ];
    const devices = [
      { device: 'mobile' as const, visits: Math.round(views * 0.52), sessions: Math.round(sessions * 0.5) },
      { device: 'desktop' as const, visits: Math.round(views * 0.39), sessions: Math.round(sessions * 0.4) },
      { device: 'tablet' as const, visits: Math.round(views * 0.05), sessions: Math.round(sessions * 0.05) },
      { device: 'bot' as const, visits: Math.round(views * 0.03), sessions: Math.round(sessions * 0.04) },
      { device: 'unknown' as const, visits: Math.round(views * 0.01), sessions: Math.round(sessions * 0.01) },
    ];
    const topReferrers = [
      { host: 'google.com', visits: Math.round(views * 0.22) },
      { host: 'x.com', visits: Math.round(views * 0.09) },
      { host: 'baidu.com', visits: Math.round(views * 0.05) },
      { host: 'weibo.com', visits: Math.round(views * 0.03) },
    ];
    const retentionDays = Math.min(range === '24h' ? 7 : days, 7);
    const retention = Array.from({ length: retentionDays }, (_, index) => {
      const date = new Date(now.getTime() - (retentionDays - 1 - index) * 86_400_000);
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
      return {
        date: key,
        new_sessions: 3 + ((index * 7 + days) % 11),
        returning_sessions: 1 + ((index * 5 + days) % 7),
      };
    });

    return {
      range,
      totals: { views, sessions, online: 3 },
      series,
      top_pages: [
        { path: '/', count: Math.round(views * 0.31) },
        { path: '/articles', count: Math.round(views * 0.18) },
        ...topContent.slice(0, 3).map((item) => ({ path: pathOf(item.id), count: item.count })),
      ],
      top_content: topContent,
      recent,
      sources,
      devices,
      top_referrers: topReferrers,
      retention,
    };
  }

  async taxonomy(_siteId: string): Promise<TaxonomySettings | null> {
    return null;
  }

  async siteCustomization(_siteId: string): Promise<SiteCustomizationSnapshot | null> {
    // 演示模式没有服务端存储：按“远端从未保存过设计”处理，调用方继续用本地缓存。
    return null;
  }

  async saveSiteCustomization(
    _siteId: string,
    _customization: unknown,
    revision?: number,
  ): Promise<SiteCustomizationSaved> {
    // 演示模式的设计只。localStorage：回显输入，不产生任何远端状态。
    return { revision: revision ?? 1, updated_at: new Date().toISOString() };
  }

  async siteConfig(_siteId: string): Promise<SiteConfigSnapshot | null> {
    // 演示模式没有服务端存储：按“远端从未保存过配置”处理，调用方继续用本地缓存。
    return null;
  }

  async saveSiteConfig(
    _siteId: string,
    _config: unknown,
    revision?: number,
  ): Promise<SiteConfigSaved> {
    // 演示模式的站点配置只。localStorage：回显输入，不产生任何远端状态。
    return { revision: revision ?? 1, updated_at: new Date().toISOString() };
  }

  async createTaxonomyTerm(_siteId: string, _input: TaxonomyTermInput): Promise<TaxonomyTerm> {
    this.fail(503, 'service_unavailable', '演示模式使用本地分类配置。');
  }

  async updateTaxonomyTerm(
    _siteId: string,
    _termId: string,
    _input: TaxonomyTermInput,
  ): Promise<TaxonomyTerm> {
    this.fail(503, 'service_unavailable', '演示模式使用本地分类配置。');
  }

  async deleteTaxonomyTerm(_siteId: string, _termId: string): Promise<void> {
    this.fail(503, 'service_unavailable', '演示模式使用本地分类配置。');
  }

  /**
   * 性能面板在演示模式没有服务端可采样。
   *
   * 演示后端跑在浏览器里，看不到宿主机的 CPU / 内存 / 磁盘；与其编一组假数字，
   * 不如明确报错，让页面显示「演示模式没有服务器指标」。
   */
  async systemMetrics(): Promise<SystemMetrics> {
    this.fail(404, 'not_found', '演示模式没有服务器指标。');
  }

  /**
   * 演示模式的「生效配置」是固定值。
   *
   * 它不需要真实，只需要形状对：页面的「生效值」面板在演示模式下也要能渲染，
   * 否则那两块界面在本地预览里就是空白。
   */
  async effectiveConfig(): Promise<EffectiveConfig> {
    await wait(60);
    return {
      storage: [
        { scope: 'global', driver: 'local', local_dir: './data/media' },
        { scope: 'content', driver: 'local', local_dir: './data/media' },
        { scope: 'site', driver: 'local', local_dir: './data/media' },
        { scope: 'avatar', driver: 'local', local_dir: './data/media' },
        { scope: 'attachment', driver: 'local', local_dir: './data/media' },
      ],
      cors: { allowed_origins: [], allow_credentials: false },
      domains: { https_only: false, public_base_url: '', trusted_proxies: [] },
      mail: { configured: false },
      restart_required: false,
      captured_at: new Date().toISOString(),
      storage_live: true,
      storage_source: 'env',
      storage_updated_at: null,
    };
  }

  /**
   * 运行期储存状态（内存）。
   *
   * 默认是「部署环境变量」的一套本地策略；调用 `applyStorage` 之后变成
   * 「后台设置」。刷新页面就回到默认值——演示模式不写文件，也不真的换存储。
   */
  async storageStatus(): Promise<StorageStatus> {
    await wait(60);
    this.requireRole('site_admin');
    return this.storageRuntime ?? demoStorageStatus('env');
  }

  /**
   * 立即应用储存设置（内存）。
   *
   * 只更新本页内存里的状态：演示模式没有服务端写入器，配额与多策略切换不会真的
   * 执行；`used_bytes` 固定为 0，避免伪造服务端计量。
   */
  async applyStorage(request: StorageApplyRequest): Promise<StorageStatus> {
    await wait(120);
    this.requireRole('platform_admin');
    const status = demoStorageStatus('saved', request);
    this.storageRuntime = status;
    return status;
  }

  /* ------------------------------------------------------------------ *
   * Beta 1.2 扩展包（契约 A–N 节）：以下都是演示后端的内存实现。
   * 演示模式没有真实短信 / 邮件 / 队列，返回值只为让页面走通，并在结果里
   * 明确标注固定的演示值，不伪造安全判断。
   * ------------------------------------------------------------------ */

  /* ---------- A. 短信登录 ---------- */

  async phonePolicy(): Promise<PhonePolicy> {
    await wait(40);
    return {
      enabled: true,
      provider: 'log',
      registration_open: this.state.site.registration_open !== false,
    };
  }

  async requestPhoneCode(
    phone: string,
    _purpose: 'login' | 'register',
  ): Promise<PhoneCodeResult> {
    await wait(120);
    if (!phone.trim()) this.fail(400, 'validation_failed', '请填写手机号。');
    return {
      expires_at: new Date(Date.now() + DEMO_SMS_TTL_SECONDS * 1000).toISOString(),
      resend_after_seconds: 60,
      // 演示模式固定验证码，登录页的提示与这里保持一致。
      dev_code: DEMO_SMS_CODE,
    };
  }

  async phoneLogin(input: {
    phone: string;
    code: string;
    display_name?: string;
  }): Promise<PasswordLoginResult> {
    await wait(200);
    const phone = input.phone.trim();
    if (!phone) this.fail(400, 'validation_failed', '请填写手机号。');
    if (input.code.trim() !== DEMO_SMS_CODE) {
      this.fail(401, 'invalid_code', '验证码不正确。');
    }
    let userId = this.phoneAccounts.get(phone);
    if (!userId) {
      if (this.state.site.registration_open === false) {
        this.fail(403, 'registration_closed', '本站暂未开放注册。');
      }
      // 演示数据没有手机号身份：第一个登录的号码使用演示管理员账户。
      const owner =
        this.state.users.find((user) => user.role === 'site_admin') ?? this.state.users[0];
      if (!owner) this.fail(404, 'not_found', '演示数据里没有可登录的账户。');
      userId = owner.id;
      this.phoneAccounts.set(phone, userId);
    }
    const user = this.state.users.find(
      (item) => item.id === userId && item.status === 'active',
    );
    if (!user) this.fail(401, 'invalid_code', '验证码不正确。');
    this.currentId = user.id;
    this.saveCurrent();
    this.log('登录', user.display_name, '手机验证码');
    this.persist();
    return { status: 'session', session: this.session(user) };
  }

  /* ---------- C. 仪表盘「最近操作」 ---------- */

  async siteActivity(_siteId: string, limit = 20): Promise<SiteActivityItem[]> {
    await wait(80);
    this.requireRole('site_admin');
    const max = Math.min(100, Math.max(1, limit));
    return this.state.activity.slice(0, max).map((entry) => {
      const action = DEMO_ACTION_CODES[entry.action] ?? entry.action;
      const actor = this.state.users.find((user) => user.display_name === entry.actor);
      return {
        id: entry.id,
        action,
        actor_id: actor?.id ?? '',
        actor_name: entry.actor,
        target_type: demoTargetType(action),
        target_id: '',
        outcome: 'success',
        detail: entry.detail ?? '',
        created_at: entry.at,
      };
    });
  }

  /* ---------- E. 版本 diff ---------- */

  async contentDiff(
    kind: ContentKind,
    id: string,
    from: number,
    to: number | 'current' = 'current',
  ): Promise<ContentDiff> {
    await wait(160);
    const user = this.user();
    const content = this.findContentByKey(kind, id);
    if (!this.canEditContent(content, user)) {
      this.fail(404, 'not_found', '内容不存在，或不在当前站点内。');
    }
    const revisions = this.ensureRevisions(content);
    const fromRevision = revisions.find((revision) => revision.version === from);
    if (!fromRevision) this.fail(404, 'not_found', '源版本不存在。');
    const fromLines = (fromRevision.source_body ?? '').split('\n');
    let toLines: string[];
    let toVersion: number;
    if (to === 'current') {
      toLines = (content.source_body ?? '').split('\n');
      toVersion = revisions.reduce((max, revision) => Math.max(max, revision.version), 1);
    } else {
      const toRevision = revisions.find((revision) => revision.version === to);
      if (!toRevision) this.fail(404, 'not_found', '目标版本不存在。');
      toLines = (toRevision.source_body ?? '').split('\n');
      toVersion = to;
    }
    const truncated =
      fromLines.length > DEMO_DIFF_MAX_LINES || toLines.length > DEMO_DIFF_MAX_LINES;
    const hunks = demoLineDiff(fromLines, toLines);
    return {
      from_version: from,
      to_version: toVersion,
      stats: {
        added: hunks.filter((hunk) => hunk.op === 'insert').length,
        removed: hunks.filter((hunk) => hunk.op === 'delete').length,
      },
      hunks,
      ...(truncated ? { truncated: true } : {}),
    };
  }

  /* ---------- G. 批量操作 ---------- */

  async bulkContentAction(
    kind: ContentKind,
    ids: string[],
    action: BulkAction,
  ): Promise<BulkResult> {
    await wait(140);
    this.requireRole('editor');
    const unique = [...new Set(ids)].slice(0, 100);
    // 逐条独立执行：单条失败只记录在它的结果里，不影响其它条目（契约 G 节）。
    const results: BulkResultItem[] = await Promise.all(
      unique.map(async (id): Promise<BulkResultItem> => {
        try {
          if (action === 'trash') {
            await this.deleteContent(kind, id);
          } else {
            await this.contentAction(kind, id, action);
          }
          return { id, ok: true, error: '' };
        } catch (err) {
          return {
            id,
            ok: false,
            error: err instanceof ApiError ? err.message : String(err),
          };
        }
      }),
    );
    const succeeded = results.filter((item) => item.ok).length;
    return { results, succeeded, failed: results.length - succeeded };
  }

  /* ---------- H. 草稿预览 ---------- */

  async issueContentPreview(kind: ContentKind, id: string): Promise<PreviewGrant> {
    await wait(120);
    const user = this.user();
    const content = this.findContent(kind, id);
    if (!this.canEditContent(content, user)) {
      this.fail(403, 'permission_denied', '只有作者与编辑可以预览这篇内容。');
    }
    const token = `v1.demo.${uuid().replace(/-/g, '')}`;
    const expiresAt = Date.now() + DEMO_PREVIEW_TTL_MS;
    this.previewTokens.set(token, { kind, id: content.id, expires_at: expiresAt });
    const prefix = kind === 'article' ? '/a' : '/p';
    return {
      token,
      expires_at: new Date(expiresAt).toISOString(),
      path: `${prefix}/${content.slug || content.id}?preview_token=${token}`,
    };
  }

  /* ---------- J. 公开路径解析与重定向 ---------- */

  async resolvePath(path: string): Promise<ResolveResult> {
    await wait(60);
    const cleaned = this.cleanPath(path);
    const match = /^\/([ap])\/([^/]+)$/.exec(cleaned);
    if (match) {
      const kind: ContentKind = match[1] === 'a' ? 'article' : 'post';
      const prefix = match[1] === 'a' ? '/a' : '/p';
      const key = decodeURIComponent(match[2]);
      const content = this.state.contents.find(
        (item) =>
          item.kind === kind &&
          !item.deleted_at &&
          item.status === 'published' &&
          (item.id === key || item.slug === key),
      );
      if (content) {
        return {
          kind: 'content',
          canonical_path: `${prefix}/${content.slug || content.id}`,
          status: content.id === key ? 301 : 200,
          content_id: content.id,
          slug: content.slug,
          title: content.title,
        };
      }
    }
    const redirect = this.redirects.find((rule) => rule.from_path === cleaned);
    if (redirect) {
      redirect.hit_count += 1;
      return {
        kind: 'redirect',
        canonical_path: redirect.to_path,
        status: redirect.status_code,
      };
    }
    return { kind: 'missing', canonical_path: '', status: 404 };
  }

  async listRedirects(
    siteId: string,
    query: { limit?: number; cursor?: string; q?: string } = {},
  ): Promise<Page<RedirectRule>> {
    await wait(80);
    this.requireRole('site_admin');
    if (siteId !== this.state.site.id) this.fail(404, 'site_not_found', '站点不存在。');
    const term = query.q?.trim().toLowerCase() ?? '';
    const filtered = this.redirects
      .filter((rule) => !term || rule.from_path.includes(term) || rule.to_path.includes(term))
      .slice()
      .sort(
        (a, b) =>
          b.created_at.localeCompare(a.created_at) ||
          a.from_path.localeCompare(b.from_path),
      );
    const limit = Math.min(100, Math.max(1, query.limit ?? 50));
    const offset = Number((query.cursor ?? '').replace(/^o:/, '')) || 0;
    const page = filtered.slice(offset, offset + limit);
    const next = offset + page.length;
    return {
      items: page,
      next_cursor: next < filtered.length ? `o:${next}` : '',
      has_more: next < filtered.length,
    };
  }

  async createRedirect(
    siteId: string,
    input: {
      from_path: string;
      to_path: string;
      status_code?: RedirectRule['status_code'];
    },
  ): Promise<RedirectRule> {
    await wait(120);
    this.requireRole('site_admin');
    if (siteId !== this.state.site.id) this.fail(404, 'site_not_found', '站点不存在。');
    const fromPath = this.normalizeRedirectPath(input.from_path, 'from_path');
    const toPath = this.normalizeRedirectPath(input.to_path, 'to_path');
    if (this.redirects.some((rule) => rule.from_path === fromPath)) {
      this.fail(409, 'conflict', '这条路径已经存在重定向规则。');
    }
    const status = input.status_code ?? 301;
    if (status !== 301 && status !== 302 && status !== 308) {
      this.fail(400, 'validation_failed', '状态码只能是 301、302 或 308。');
    }
    const now = new Date().toISOString();
    const rule: RedirectRule = {
      id: `redir_${uuid().slice(0, 8)}`,
      from_path: fromPath,
      to_path: toPath,
      status_code: status,
      source: 'manual',
      hit_count: 0,
      created_at: now,
      updated_at: now,
    };
    this.redirects.unshift(rule);
    this.log('新建重定向', `${fromPath} → ${toPath}`);
    return rule;
  }

  async updateRedirect(
    siteId: string,
    redirectId: string,
    patch: Partial<{
      from_path: string;
      to_path: string;
      status_code: RedirectRule['status_code'];
    }>,
  ): Promise<RedirectRule> {
    await wait(120);
    this.requireRole('site_admin');
    if (siteId !== this.state.site.id) this.fail(404, 'site_not_found', '站点不存在。');
    const rule = this.redirects.find((item) => item.id === redirectId);
    if (!rule) this.fail(404, 'not_found', '重定向规则不存在。');
    if (patch.from_path !== undefined) {
      const fromPath = this.normalizeRedirectPath(patch.from_path, 'from_path');
      if (this.redirects.some((item) => item.id !== rule.id && item.from_path === fromPath)) {
        this.fail(409, 'conflict', '这条路径已经存在重定向规则。');
      }
      rule.from_path = fromPath;
    }
    if (patch.to_path !== undefined) {
      rule.to_path = this.normalizeRedirectPath(patch.to_path, 'to_path');
    }
    if (patch.status_code !== undefined) {
      if (
        patch.status_code !== 301 &&
        patch.status_code !== 302 &&
        patch.status_code !== 308
      ) {
        this.fail(400, 'validation_failed', '状态码只能是 301、302 或 308。');
      }
      rule.status_code = patch.status_code;
    }
    rule.updated_at = new Date().toISOString();
    this.log('修改重定向', rule.from_path);
    return rule;
  }

  async deleteRedirect(siteId: string, redirectId: string): Promise<void> {
    await wait(120);
    this.requireRole('site_admin');
    if (siteId !== this.state.site.id) this.fail(404, 'site_not_found', '站点不存在。');
    const index = this.redirects.findIndex((item) => item.id === redirectId);
    if (index < 0) this.fail(404, 'not_found', '重定向规则不存在。');
    const [removed] = this.redirects.splice(index, 1);
    this.log('删除重定向', removed.from_path);
  }

  /** 规范化重定向路径：以 `/` 开头、无查询串；空值按校验失败处理。 */
  private normalizeRedirectPath(value: string, field: string): string {
    if (!value.trim()) this.fail(400, 'validation_failed', `${field} 不能为空。`);
    return this.cleanPath(value);
  }

  /* ---------- K. 请求日志查看器 ---------- */

  async systemLogs(
    query: { limit?: number; status?: number; path?: string; method?: string } = {},
  ): Promise<SystemLogEntry[]> {
    await wait(80);
    this.requireRole('site_admin');
    const limit = Math.min(500, Math.max(1, query.limit ?? 100));
    const status = query.status !== undefined ? String(query.status) : '';
    const method = query.method?.toUpperCase() ?? '';
    const path = query.path?.trim() ?? '';
    return this.demoSystemLogs()
      .filter((entry) => !status || String(entry.status) === status)
      .filter((entry) => !method || entry.method.toUpperCase() === method)
      .filter((entry) => !path || entry.path.includes(path))
      .slice(0, limit);
  }

  /* ---------- L. 自动备份 ---------- */

  async backupSchedule(): Promise<BackupSchedule> {
    await wait(60);
    // 演示模式只有一个站点，站点管理员也能看到这份计划（真实后端要求平台管理员）。
    this.requireRole('site_admin');
    const now = new Date();
    const next = new Date(now);
    next.setHours(3, 0, 0, 0);
    if (next.getTime() <= now.getTime()) next.setDate(next.getDate() + 1);
    return {
      enabled: false,
      hour: 3,
      keep: 7,
      last_run_at: new Date(now.getTime() - 86_400_000).toISOString(),
      last_status: 'success',
      last_error: '',
      next_run_at: next.toISOString(),
      artifacts: [
        {
          name: 'practacu-backup-demo-1.tar.gz',
          size: 48_211_968,
          created_at: new Date(now.getTime() - 86_400_000).toISOString(),
        },
        {
          name: 'practacu-backup-demo-2.tar.gz',
          size: 48_003_072,
          created_at: new Date(now.getTime() - 2 * 86_400_000).toISOString(),
        },
      ],
    };
  }

  /* ---------- N. 邮件订阅与 Newsletter ---------- */

  async subscribeNewsletter(input: {
    email: string;
    source?: string;
  }): Promise<{ status: NewsletterSubscriptionStatus }> {
    await wait(140);
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      this.fail(400, 'validation_failed', '邮箱格式不正确。');
    }
    const list = this.subscriberList();
    const existing = list.find((item) => item.email === email);
    if (existing) {
      if (existing.status === 'confirmed') return { status: 'confirmed' };
      // 待确认或已退订：重发确认信，状态回到 pending（契约 N1）。
      existing.status = 'pending';
      delete existing.unsubscribed_at;
      this.issueNewsletterToken(email);
      return { status: 'pending' };
    }
    const now = new Date().toISOString();
    list.push({
      id: `sub_${uuid().slice(0, 8)}`,
      email,
      status: 'pending',
      source: input.source?.trim() || 'site',
      created_at: now,
    });
    this.issueNewsletterToken(email);
    return { status: 'pending' };
  }

  async confirmNewsletter(token: string): Promise<{ status: NewsletterSubscriptionStatus }> {
    await wait(120);
    const email = this.newsletterTokens.get(token);
    const subscriber = email
      ? this.subscriberList().find((item) => item.email === email)
      : undefined;
    if (!subscriber) this.fail(404, 'not_found', '确认链接无效或已过期。');
    subscriber.status = 'confirmed';
    subscriber.confirmed_at = new Date().toISOString();
    delete subscriber.unsubscribed_at;
    this.newsletterTokens.delete(token);
    return { status: 'confirmed' };
  }

  async unsubscribeNewsletter(token: string): Promise<{ status: NewsletterSubscriptionStatus }> {
    await wait(120);
    const email = this.newsletterTokens.get(token);
    const subscriber = email
      ? this.subscriberList().find((item) => item.email === email)
      : undefined;
    if (!subscriber) this.fail(404, 'not_found', '退订链接无效或已过期。');
    subscriber.status = 'unsubscribed';
    subscriber.unsubscribed_at = new Date().toISOString();
    this.newsletterTokens.delete(token);
    return { status: 'unsubscribed' };
  }

  async myNewsletter(): Promise<MyNewsletterPreference> {
    await wait(60);
    const user = this.user();
    const subscriber = this.subscriberList().find(
      (item) => item.email.toLowerCase() === user.email.toLowerCase(),
    );
    const status: SubscriberStatus = subscriber?.status ?? 'unsubscribed';
    return { subscribed: status === 'confirmed', email: user.email, status };
  }

  async setMyNewsletter(enabled: boolean): Promise<MyNewsletterPreference> {
    await wait(120);
    const user = this.user();
    const list = this.subscriberList();
    const email = user.email.toLowerCase();
    const now = new Date().toISOString();
    const existing = list.find((item) => item.email === email);
    if (enabled) {
      if (existing) {
        existing.status = 'confirmed';
        existing.confirmed_at = existing.confirmed_at ?? now;
        existing.source = 'account';
        existing.user_id = user.id;
        delete existing.unsubscribed_at;
      } else {
        list.push({
          id: `sub_${uuid().slice(0, 8)}`,
          email,
          status: 'confirmed',
          source: 'account',
          user_id: user.id,
          confirmed_at: now,
          created_at: now,
        });
      }
      this.log('订阅邮件', user.email);
    } else if (existing) {
      existing.status = 'unsubscribed';
      existing.unsubscribed_at = now;
      this.log('退订邮件', user.email);
    }
    return {
      subscribed: enabled,
      email: user.email,
      status: enabled ? 'confirmed' : 'unsubscribed',
    };
  }

  async listSubscribers(
    siteId: string,
    query: { status?: string; q?: string; limit?: number; cursor?: string } = {},
  ): Promise<Page<Subscriber>> {
    await wait(80);
    this.requireRole('site_admin');
    if (siteId !== this.state.site.id) this.fail(404, 'site_not_found', '站点不存在。');
    const term = query.q?.trim().toLowerCase() ?? '';
    const status = query.status?.trim() ?? '';
    const filtered = this.subscriberList()
      .filter((item) => !status || item.status === status)
      .filter((item) => !term || item.email.includes(term))
      .slice()
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    const limit = Math.min(100, Math.max(1, query.limit ?? 50));
    const offset = Number((query.cursor ?? '').replace(/^o:/, '')) || 0;
    const page = filtered.slice(offset, offset + limit);
    const next = offset + page.length;
    return {
      items: page.map((item) => ({ ...item })),
      next_cursor: next < filtered.length ? `o:${next}` : '',
      has_more: next < filtered.length,
    };
  }

  async deleteSubscriber(siteId: string, subscriberId: string): Promise<void> {
    await wait(120);
    this.requireRole('site_admin');
    if (siteId !== this.state.site.id) this.fail(404, 'site_not_found', '站点不存在。');
    const list = this.subscriberList();
    const index = list.findIndex((item) => item.id === subscriberId);
    if (index < 0) this.fail(404, 'not_found', '订阅者不存在。');
    list.splice(index, 1);
    this.log('删除订阅者', subscriberId);
  }

  async newsletterStats(siteId: string): Promise<NewsletterStats> {
    await wait(60);
    this.requireRole('site_admin');
    if (siteId !== this.state.site.id) this.fail(404, 'site_not_found', '站点不存在。');
    const list = this.subscriberList();
    const since = Date.now() - 7 * 86_400_000;
    const recent = this.emailLogList().filter(
      (log) => new Date(log.created_at).getTime() >= since,
    );
    return {
      confirmed: list.filter((item) => item.status === 'confirmed').length,
      pending: list.filter((item) => item.status === 'pending').length,
      unsubscribed: list.filter((item) => item.status === 'unsubscribed').length,
      sent_7d: recent.filter((log) => log.status === 'sent').length,
      failed_7d: recent.filter((log) => log.status === 'failed').length,
    };
  }

  async listEmailTemplates(siteId: string): Promise<EmailTemplate[]> {
    await wait(60);
    this.requireRole('site_admin');
    if (siteId !== this.state.site.id) this.fail(404, 'site_not_found', '站点不存在。');
    return this.templateList();
  }

  async saveEmailTemplate(
    siteId: string,
    key: string,
    input: {
      name?: string;
      subject?: string;
      body_html?: string;
      body_text?: string;
      enabled?: boolean;
    },
  ): Promise<EmailTemplate> {
    await wait(120);
    this.requireRole('site_admin');
    if (siteId !== this.state.site.id) this.fail(404, 'site_not_found', '站点不存在。');
    const template = this.templateList().find((item) => item.key === key);
    if (!template) this.fail(404, 'not_found', '模板不存在。');
    const next: EmailTemplate = {
      ...template,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.subject !== undefined ? { subject: input.subject } : {}),
      ...(input.body_html !== undefined ? { body_html: input.body_html } : {}),
      ...(input.body_text !== undefined ? { body_text: input.body_text } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      builtin: true,
      updated_at: new Date().toISOString(),
    };
    this.emailTemplateOverrides.set(key, next);
    this.log('保存邮件模板', key);
    return { ...next };
  }

  async resetEmailTemplate(siteId: string, key: string): Promise<void> {
    await wait(120);
    this.requireRole('site_admin');
    if (siteId !== this.state.site.id) this.fail(404, 'site_not_found', '站点不存在。');
    if (!DEMO_EMAIL_TEMPLATES.some((template) => template.key === key)) {
      this.fail(404, 'not_found', '模板不存在。');
    }
    this.emailTemplateOverrides.delete(key);
    this.log('恢复默认邮件模板', key);
  }

  async listEmailLogs(
    siteId: string,
    query: { status?: string; kind?: string; limit?: number; cursor?: string } = {},
  ): Promise<Page<EmailLog>> {
    await wait(80);
    this.requireRole('site_admin');
    if (siteId !== this.state.site.id) this.fail(404, 'site_not_found', '站点不存在。');
    const status = query.status?.trim() ?? '';
    const kind = query.kind?.trim() ?? '';
    const filtered = this.emailLogList()
      .filter((log) => !status || log.status === status)
      .filter((log) => !kind || log.kind === kind)
      .slice()
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    const limit = Math.min(100, Math.max(1, query.limit ?? 50));
    const offset = Number((query.cursor ?? '').replace(/^o:/, '')) || 0;
    const page = filtered.slice(offset, offset + limit);
    const next = offset + page.length;
    return {
      items: page.map((log) => ({ ...log })),
      next_cursor: next < filtered.length ? `o:${next}` : '',
      has_more: next < filtered.length,
    };
  }

  async sendNewsletter(
    siteId: string,
    input: {
      subject: string;
      body_html: string;
      body_text: string;
      content_id?: string;
    },
  ): Promise<NewsletterSendResult> {
    await wait(200);
    this.requireRole('site_admin');
    if (siteId !== this.state.site.id) this.fail(404, 'site_not_found', '站点不存在。');
    if (!input.subject.trim()) this.fail(400, 'validation_failed', '主题不能为空。');
    if (input.content_id && !this.state.contents.some((item) => item.id === input.content_id)) {
      this.fail(404, 'not_found', '选择的内容不存在。');
    }
    const confirmed = this.subscriberList().filter((item) => item.status === 'confirmed');
    const now = new Date().toISOString();
    for (const subscriber of confirmed) {
      this.emailLogList().unshift({
        id: `mail_${uuid().slice(0, 8)}`,
        to_email: subscriber.email,
        kind: 'newsletter',
        template_key: 'newsletter_post',
        subject: input.subject.trim(),
        status: 'queued',
        created_at: now,
      });
      subscriber.last_sent_at = now;
    }
    this.log('发送刊物', input.subject.trim(), `${confirmed.length} 位订阅者`);
    return { queued: confirmed.length };
  }

  /** 演示模式的请求日志：固定元数据，时间按「第几条」向前推。 */
  private demoSystemLogs(): SystemLogEntry[] {
    const now = Date.now();
    const rows: { method: string; path: string; status: number; ms: number }[] = [
      { method: 'GET', path: '/api/v1/articles', status: 200, ms: 42 },
      { method: 'GET', path: '/api/v1/articles/cnt_house', status: 200, ms: 18 },
      { method: 'GET', path: '/api/v1/posts', status: 200, ms: 33 },
      { method: 'POST', path: '/api/v1/articles/cnt_house/publish', status: 200, ms: 96 },
      { method: 'GET', path: '/api/v1/sites/site_demo/analytics', status: 200, ms: 27 },
      { method: 'POST', path: '/api/v1/auth/login/password', status: 200, ms: 121 },
      { method: 'GET', path: '/api/v1/me', status: 401, ms: 8 },
      { method: 'GET', path: '/api/v1/comments', status: 200, ms: 24 },
      { method: 'POST', path: '/api/v1/comments', status: 201, ms: 55 },
      { method: 'GET', path: '/api/v1/notifications', status: 200, ms: 14 },
      { method: 'GET', path: '/api/v1/media', status: 200, ms: 21 },
      { method: 'POST', path: '/api/v1/media/uploads', status: 202, ms: 64 },
      { method: 'GET', path: '/api/v1/system/queue', status: 200, ms: 11 },
      { method: 'POST', path: '/api/v1/system/queue/retry', status: 200, ms: 73 },
      { method: 'GET', path: '/api/v1/sites/site_demo/redirects', status: 200, ms: 16 },
      { method: 'POST', path: '/api/v1/articles/cnt_house/preview', status: 200, ms: 19 },
      { method: 'GET', path: '/api/v1/articles/cnt_house/diff', status: 200, ms: 38 },
      { method: 'GET', path: '/api/v1/resolve', status: 404, ms: 6 },
    ];
    const siteId = this.state.site.id;
    const adminId = this.state.users[0]?.id ?? '';
    return rows.map((row, index) => ({
      time: new Date(now - index * 37_000).toISOString(),
      request_id: `req_demo_${String(index + 1).padStart(4, '0')}`,
      method: row.method,
      path: row.path,
      status: row.status,
      duration_ms: row.ms,
      site_id: siteId,
      user_id: index % 4 === 0 ? adminId : '',
    }));
  }

  /** 演示订阅名单：首次使用时生成，之后在内存里增删改。 */
  private subscriberList(): Subscriber[] {
    if (!this.subscribers) {
      const now = new Date().toISOString();
      const primary = this.state.users[0];
      this.subscribers = [
        {
          id: 'sub_demo_1',
          email: (primary?.email ?? 'admin@practacu.local').toLowerCase(),
          status: 'confirmed',
          source: 'account',
          user_id: primary?.id,
          confirmed_at: now,
          created_at: now,
        },
        {
          id: 'sub_demo_2',
          email: 'reader@example.com',
          status: 'pending',
          source: 'site',
          created_at: now,
        },
        {
          id: 'sub_demo_3',
          email: 'weekly@example.com',
          status: 'unsubscribed',
          source: 'site',
          unsubscribed_at: now,
          created_at: now,
        },
      ];
    }
    return this.subscribers;
  }

  /** 演示邮件日志：首次使用时生成一段历史，发送 newsletter 时继续追加。 */
  private emailLogList(): EmailLog[] {
    if (!this.emailLogs) {
      const now = Date.now();
      this.emailLogs = [
        {
          id: 'mail_demo_1',
          to_email: 'reader@example.com',
          kind: 'newsletter',
          template_key: 'newsletter_post',
          subject: '本周新文章',
          status: 'sent',
          sent_at: new Date(now - 3_600_000).toISOString(),
          created_at: new Date(now - 3_700_000).toISOString(),
        },
        {
          id: 'mail_demo_2',
          to_email: 'admin@practacu.local',
          kind: 'confirm',
          template_key: 'subscriber_confirm',
          subject: '确认订阅 Practacu Press',
          status: 'queued',
          created_at: new Date(now - 600_000).toISOString(),
        },
        {
          id: 'mail_demo_3',
          to_email: 'weekly@example.com',
          kind: 'newsletter',
          template_key: 'newsletter_post',
          subject: '上周回顾',
          status: 'failed',
          error: 'smtp timeout',
          created_at: new Date(now - 86_400_000).toISOString(),
        },
      ];
    }
    return this.emailLogs;
  }

  /** 内置邮件模板 + 站长改写后的覆盖。 */
  private templateList(): EmailTemplate[] {
    return DEMO_EMAIL_TEMPLATES.map((template) => {
      const override = this.emailTemplateOverrides.get(template.key);
      if (override) return { ...override };
      return {
        key: template.key,
        name: template.name,
        subject: template.subject,
        body_html: `<p>${template.body_text}</p>`,
        body_text: template.body_text,
        enabled: true,
        builtin: true,
      };
    });
  }

  /** 发一张订阅确认 / 退订令牌；演示模式只存在内存里。 */
  private issueNewsletterToken(email: string): string {
    const token = `nl.demo.${uuid().replace(/-/g, '')}`;
    this.newsletterTokens.set(token, email);
    return token;
  }

  docsUrl(): string {
    return '#';
  }
}

