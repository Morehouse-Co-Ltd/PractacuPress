import type {
  AnalyticsBreakdown,
  Asset,
  AuditLogPage,
  AuditLogQuery,
  BackupArtifact,
  BackupSchedule,
  BackendMode,
  BulkAction,
  BulkResult,
  CaptchaScene,
  CaptchaStatus,
  ChangePasswordInput,
  CommentModerationAction,
  CommentPage,
  CommentQuery,
  CommentsResult,
  Content,
  ContentAction,
  ContentDiff,
  ContentKind,
  ContentPage,
  ContentRevision,
  ContentRevisionPage,
  ContentUnlockResult,
  Conversation,
  CreateSiteInput,
  CreatedSite,
  DraftInput,
  EmailLog,
  EmailTemplate,
  ExtensionSummary,
  FollowEntry,
  InteractionEntry,
  InteractionState,
  InteractionStates,
  LocalCaptchaAnswer,
  LocalCaptchaChallenge,
  LocalCaptchaSolution,
  ImportConflictStrategy,
  Me,
  MyNewsletterPreference,
  NewsletterSendResult,
  NewsletterStats,
  NewsletterSubscriptionStatus,
  PhoneCodeResult,
  PhoneCodePurpose,
  PhonePolicy,
  PreviewGrant,
  ReadingHistoryEntry,
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
  PopularContentPage,
  ProbeResult,
  ProblemBody,
  ProfileInput,
  PublicProfile,
  QueueStatus,
  RedirectRule,
  Report,
  ReportAction,
  ReportInput,
  ResolveResult,
  SafetyPolicy,
  SafetyRateLimit,
  SensitiveWord,
  SensitiveWordMode,
  SiteActivityItem,
  SiteIPRule,
  Role,
  SearchQuery,
  SearchResult,
  Session,
  Site,
  SiteDomainVerification,
  SiteDomainVerificationResult,
  SiteImportReport,
  Subscriber,
  SystemLogEntry,
  SystemMetrics,
  EffectiveConfig,
  StepUpSettings,
  StepUpSettingsUpdate,
  StepUpVerifyResult,
  TaxonomySettings,
  TaxonomyTerm,
  TaxonomyTermInput,
  ToggleResult,
  TwoFactorChallenge,
  TwoFactorEnrollment,
  TwoFactorRecoveryCodes,
  TwoFactorStatus,
  User,
  Upload,
} from '../types';
import { mediaQuotaExceedsSafeInteger, normalizeMediaQuotaDecimal } from './mediaQuota';
import type { AnalyticsRange, BackendAnalytics, VisitSurface } from './analytics';
import { clientSessionId } from './analytics';
import { readCaptchaStatus, readLocalCaptchaChallenge } from './captcha';
import type { ContactPayload } from './contactForm';
import { t } from './i18n';
import { currentPerformance } from './performance';
import { RequestCache } from './requestCache';
import { withRefreshLock } from './sessionSync';
import type { SiteConfigSaved, SiteConfigSnapshot } from './siteConfig';
import { clearStepUpToken, getStepUpToken, STEP_UP_HEADER } from './stepUp';

export class ApiError extends Error {
  readonly problem: ProblemBody;

  constructor(problem: ProblemBody) {
    super(problem.message || problem.title || t('请求失败'));
    this.name = 'ApiError';
    this.problem = problem;
  }

  get code(): string {
    return this.problem.code;
  }

  get requestId(): string {
    return this.problem.request_id;
  }
}

/** 兜底文案按错误码存放，取值时才翻译，语言切换后依然正确。 */
const FALLBACK_MESSAGE: Record<number, { code: string; message: () => string }> = {
  400: { code: 'validation_failed', message: () => t('请求没有通过校验。') },
  401: { code: 'unauthenticated', message: () => t('登录状态已失效，请重新登录。') },
  403: { code: 'permission_denied', message: () => t('当前账户没有执行此操作的权限。') },
  404: { code: 'not_found', message: () => t('资源不存在，或不在当前站点内。') },
  409: { code: 'conflict', message: () => t('资源状态已变化，请刷新后重试。') },
  429: { code: 'rate_limited', message: () => t('操作过于频繁，请稍后再试。') },
  503: { code: 'security_unavailable', message: () => t('安全服务暂不可用，操作已被暂存。') },
};

export function fallbackProblem(status: number): ProblemBody {
  const known = FALLBACK_MESSAGE[status] ?? {
    code: 'internal',
    message: () => t('服务暂时不可用。'),
  };
  const message = known.message();
  return {
    type: `https://docs.practacu.press/errors/${known.code}`,
    title: message,
    status,
    code: known.code,
    message,
    details: {},
    request_id: '',
  };
}

export async function problemFromResponse(res: Response): Promise<ProblemBody> {
  try {
    const body = (await res.json()) as Partial<ProblemBody>;
    if (body && typeof body.code === 'string') {
      return {
        type: body.type ?? '',
        title: body.title ?? body.message ?? t('请求失败'),
        status: body.status ?? res.status,
        code: body.code,
        message: body.message ?? body.title ?? t('请求失败'),
        details: body.details ?? {},
        request_id: body.request_id ?? '',
      };
    }
  } catch {
    /* 非 JSON 错误体，走兜底 */
  }
  return fallbackProblem(res.status);
}

/**
 * 这次失败是否等于「会话没了」。
 *
 * 只有服务端回 401 才是真退出：403（CSRF 双提交竞态）、0（断网）与 5xx 都可能是
 * 一时的，把界面切到未登录只会让用户以为掉线了。
 */
export function isSessionGoneError(error: unknown): boolean {
  return error instanceof ApiError && error.problem.status === 401;
}

/**
 * 这次失败是不是「根本连不上后端」。
 *
 * fetch 抛错（断网、服务没启动、地址写错）统一包装成 status 0；页面据此把提示
 * 说成连接失败，而不是登录失效或内容不存在。服务端返回的 5xx 仍然是有效响应，
 * 不能混为一谈。
 */
export function isBackendOffline(error: unknown): boolean {
  return error instanceof ApiError && error.problem.status === 0;
}

export function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function readCookie(name: string): string {
  if (typeof document === 'undefined') return '';
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : '';
}

export function normalizeOrigin(base: string): string {
  const trimmed = base.trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  return trimmed.replace(/\/api\/v1$/, '');
}

export function apiRootOf(base: string): string {
  return `${normalizeOrigin(base)}/api/v1`;
}

/** 从 Content-Disposition 里取文件名；没有时给一个安全的默认名。 */
export function filenameFromDisposition(value: string | null, fallback = 'practacu-export.zip'): string {
  if (!value) return fallback;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(value);
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1].trim());
    } catch {
      return fallback;
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(value);
  return plain?.[1]?.trim() || fallback;
}

export function docsUrlOf(base: string): string {
  const origin = normalizeOrigin(base) || window.location.origin;
  return `${origin}/api/v1/docs`;
}

/**
 * 判断地址是否指向本站的媒体读取端点。
 *
 * 这条路由是 optionalAuth：`purpose=content` 的素材匿名读取会被当成不存在
 * （见 internal/media/service.go 的 authorizeSharedAsset），而 `<img src>`
 * 带不上 Authorization。真实后端要先自己取字节；data:/blob:/外链不需要走这一步。
 */
export function isMediaApiUrl(value: string): boolean {
  const url = (value ?? '').trim();
  if (!url) return false;
  // 浏览器本地资源不需要再请求一次。
  if (/^(?:data|blob|file):/i.test(url)) return false;
  try {
    const base =
      typeof window !== 'undefined' && window.location
        ? window.location.href
        : 'http://localhost/';
    return new URL(url, base).pathname.startsWith('/api/v1/media/');
  } catch {
    // 解析失败（老浏览器或异常地址）时退回字符串判断，宁可漏判也别把明显外链发出去。
    return /\/api\/v1\/media\//.test(url);
  }
}

/** 站点设计的服务端副本。404 表示这个站点从未保存过设计，不是错误。 */
export interface SiteCustomizationSnapshot {
  customization: unknown;
  revision: number;
  updated_at: string;
}

/** 保存站点设计之后的版本号。下一次写入要带上它做乐观并发控制。 */
export interface SiteCustomizationSaved {
  revision: number;
  updated_at: string;
}

/** 站点级配置的读取与保存类型；定义在 `siteConfig.ts`，避免两处形状漂移。 */
export type { SiteConfigSaved, SiteConfigSnapshot } from './siteConfig';

/** 把个人列表的查询参数拼成 URLSearchParams；空值不上线。 */
function interactionQuery(options: InteractionListOptions): string {
  const params = new URLSearchParams();
  params.set('limit', String(options.limit ?? 30));
  if (options.cursor) params.set('cursor', options.cursor);
  if (options.targetType) params.set('target_type', options.targetType);
  if (options.kind) params.set('kind', options.kind);
  return params.toString();
}

function quotaPatchBody(patch: object): string {
  const values = patch as Record<string, unknown>;
  const quota = values.media_quota_bytes;
  if (quota === undefined || quota === null) return JSON.stringify(patch);
  if (typeof quota === 'number') {
    if (!Number.isSafeInteger(quota) || quota < 0) {
      throw new RangeError('media_quota_bytes must be a non-negative exact integer');
    }
    return JSON.stringify(patch);
  }
  if (typeof quota !== 'string') throw new RangeError('media_quota_bytes must be an integer');
  const normalized = normalizeMediaQuotaDecimal(quota);
  if (normalized === null) {
    throw new RangeError('media_quota_bytes must be a non-negative int64');
  }
  const rest = { ...values };
  delete rest.media_quota_bytes;
  const body = JSON.stringify(rest);
  const separator = Object.keys(rest).length ? ',' : '';
  return `${body.slice(0, -1)}${separator}"media_quota_bytes":${normalized}}`;
}

async function readResponseJson<T>(response: Response): Promise<T> {
  if (typeof response.text !== 'function') return response.json() as Promise<T>;
  const text = await response.text();
  const preserved = text.replace(
    /((?:^|[{,]\s*)[\"]media_quota_bytes[\"]\s*:\s*)(\d+)(?=\s*[,}])/g,
    (_match, prefix: string, digits: string) =>
      mediaQuotaExceedsSafeInteger(digits) ? `${prefix}\"${digits}\"` : _match,
  );
  return JSON.parse(preserved) as T;
}

/**
 * 内容列表（`GET /articles`、`GET /posts`）的查询参数。
 *
 * P3 起服务端支持四个筛选参数（见 `internal/content/handler.go`）：
 * - `category_id`：按分类 id 筛选；
 * - `tag`：按标签名筛选；
 * - `since`：只取这个时刻之后发布的内容，RFC3339；
 * - `sort`：`newest`（缺省）或 `oldest`。
 *
 * 全部是可选的：查询块只把用户真正填了的那几个放进去，空值不上线（空串会被服务端
 * 当成"筛选一个空分类"，结果永远为空）。
 */
export interface ContentListOptions {
  limit?: number;
  cursor?: string;
  authorId?: string;
  categoryId?: string;
  tag?: string;
  /** RFC3339 时间点；只保留此刻之后发布的内容。 */
  since?: string;
  sort?: 'newest' | 'oldest';
  /**
   * 只列出回收站里的内容（Beta 1.2）。
   *
   * 缺省与 `false` 都表示"排除已删除"；只有作者与编辑能打开这个视图。
   */
  trashed?: boolean;
}

/**
 * 热门内容查询（`GET /content/popular`）。
 *
 * `window` 既是参评范围也是时间衰减的尺度：窗口外的旧内容不参与排序，窗口内的
 * 内容按阅读量与发布时长一起算分。
 */
export interface PopularContentOptions {
  kind?: ContentKind;
  categoryId?: string;
  tag?: string;
  window?: import('../types').PopularWindow;
  limit?: number;
}

/** 我的收藏 / 点赞 / 阅读历史列表的查询参数。 */
export interface InteractionListOptions {  targetType?: string;
  kind?: 'like' | 'love' | 'insightful';
  limit?: number;
  cursor?: string;
}

/** 成员目录查询；`q` 按昵称模糊匹配。 */
export interface MemberDirectoryOptions {
  query?: string;
  limit?: number;
  cursor?: string;
}

/**
 * `GET /sites/{siteID}/analytics` 的完整响应（Beta 1.2，契约 M 节）。
 *
 * 既有的 `BackendAnalytics`（`lib/analytics.ts`，服务端统计的客户端镜像）加上来源 /
 * 设备 / 引荐 / 留存四个新维度。旧后端不返回这四个数组时，`HttpBackend.analytics`
 * 会补成空数组，调用方不需要自己判空。
 */
export type SiteAnalytics = BackendAnalytics & AnalyticsBreakdown;

interface HttpBackendOptions {
  base: string;
  onExpired: () => void;
}

/** 浏览器端 API 客户端：只在内存保存 access token，刷新依赖 HttpOnly Cookie + CSRF 双提交。 */
export class HttpBackend {
  readonly mode: BackendMode = 'live';
  readonly origin: string;
  private readonly root: string;
  private token: string | null = null;
  private csrf: string | null = null;
  private refreshPromise: Promise<Session> | null = null;
  /**
   * 会话代号：每次 applySession / clearSession 自增。
   *
   * 用来识别「这个 401 说的是哪一代会话」——匿名期间发出的请求可能在登录成功之后
   * 才回来一个 401，那不能把刚建立的会话打掉。
   */
  private sessionEpoch = 0;
  private onExpired: () => void;
  /** GET 去重与短缓存；登录态变化和写入后清空。 */
  private readonly requestCache = new RequestCache();

  constructor(options: HttpBackendOptions) {
    this.origin = normalizeOrigin(options.base);
    this.root = `${this.origin}/api/v1`;
    this.onExpired = options.onExpired;
  }

  applySession(session: Session) {
    this.token = session.access_token;
    this.csrf = session.csrf_token || readCookie('pp_csrf');
    this.sessionEpoch += 1;
    this.requestCache.clear();
  }

  clearSession() {
    this.token = null;
    this.csrf = null;
    this.sessionEpoch += 1;
    this.requestCache.clear();
    // 二次验证令牌绑定「当前用户 + 站点」，登出后必须一起丢掉。
    clearStepUpToken();
  }

  /**
   * 双提交用的 CSRF 令牌。
   *
   * 以浏览器 Cookie 为准：它由服务端在每次刷新轮换时一起改写，**所有标签页共享**。
   * 内存里那份只在登录那一刻与服务端同步，另一个标签页刷新过之后它就是过期值；
   * 拿过期值去双提交会被判 `csrf_mismatch`，刷新跟着失败，界面就被误判成「未登录」。
   */
  private csrfToken(): string {
    return readCookie('pp_csrf') || this.csrf || '';
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    retry = true,
  ): Promise<T> {
    const method = (init.method ?? 'GET').toUpperCase();
    const performance = currentPerformance();
    if (method === 'GET' && retry && performance.request_cache) {
      return this.requestCache.load(`GET ${path}`, performance.cache_ttl * 1000, () =>
        this.performRequest<T>(path, init, retry),
      );
    }
    return this.performRequest<T>(path, init, retry);
  }

  private async performRequest<T>(
    path: string,
    init: RequestInit = {},
    retry = true,
  ): Promise<T> {
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    headers.set('Accept', 'application/json');
    headers.set('X-Request-ID', uuid());
    /** 这一枪打出去的令牌与会话代号：回来时要判断 401 属于哪一代会话。 */
    const epoch = this.sessionEpoch;
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
    // 高威胁操作：令牌还在有效期内就自动带上，调用方不需要每次自己拼请求头。
    const stepUpToken = getStepUpToken();
    if (stepUpToken) headers.set(STEP_UP_HEADER, stepUpToken);
    if (typeof init.body === 'string') headers.set('Content-Type', 'application/json');

    let res: Response;
    try {
      res = await fetch(`${this.root}${path}`, {
        ...init,
        headers,
        credentials: 'include',
      });
    } catch {
      throw new ApiError({
        ...fallbackProblem(0),
        code: 'internal',
        title: t('无法连接 API'),
        message: t('无法连接 {origin}，请确认服务已启动。', {
          origin: this.origin || window.location.origin,
        }),
      });
    }

    if (res.status === 401 && retry && this.token && !path.startsWith('/auth/')) {
      // 会话在请求飞行途中换过（刚登录 / 另一个标签页刷新过）：直接拿新令牌重放，
      // 不要再去刷新——多余的刷新会消耗一次性刷新令牌，反而把会话撞死。
      if (epoch !== this.sessionEpoch) return this.performRequest<T>(path, init, false);
      try {
        await this.refresh();
      } catch (refreshError) {
        // 只有服务端明确说「这个会话已经不存在」才算退出登录。CSRF 竞态、断网、
        // 5xx 都只是这一次请求没成功，界面必须保持登录态，否则用户会莫名其妙
        // 被踢回登录页——刷新一下页面又好了。
        if (isSessionGoneError(refreshError)) {
          this.clearSession();
          this.onExpired();
          throw new ApiError(await problemFromResponse(res));
        }
        throw refreshError;
      }
      return this.performRequest<T>(path, init, false);
    }

    if (!res.ok) {
      const problem = await problemFromResponse(res);
      // 服务端说「需要二次验证」：本地令牌已经失效（过期 / 换了账户 / 保护刚被
      // 打开），清掉它，下一次操作才会重新弹密码框，而不是反复拿废令牌重试。
      if (problem.status === 403 && problem.details?.reason === 'step_up_required') {
        clearStepUpToken();
      }
      // 同上：匿名期间发出、登录之后才回来的 401 不能清掉新会话。匿名请求本身
      // 没有会话可过期（例如成员站点的公开子集接口按设计返回 401），广播一次退出
      // 会把同一浏览器的其他标签页误伤。
      if (res.status === 401 && epoch === this.sessionEpoch && this.token !== null) {
        this.clearSession();
        this.onExpired();
      }
      throw new ApiError(problem);
    }

    // 写入之后不能再读旧缓存；读取请求本身不需要清空。
    if (method !== 'GET') this.requestCache.clear();
    if (res.status === 204) return undefined as T;
    if (res.status === 202) return readResponseJson<T>(res);
    return readResponseJson<T>(res);
  }

  async probe(): Promise<ProbeResult> {
    // 不能只看 HTTP 200：SPA 的 fallback 对所有路径都返回 index.html，
    // 必须校验 JSON 形状，否则“没有后端”会被误判为健康。
    const readJson = async (res: Response): Promise<Record<string, unknown> | null> => {
      try {
        return await readResponseJson<Record<string, unknown>>(res);
      } catch {
        return null;
      }
    };
    const call = (url: string) =>
      fetch(url, {
        headers: { Accept: 'application/json' },
        credentials: 'include',
        // 自动发现后端时不能无限等待：某些主机会接受连接却不响应。
        signal:
          typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
            ? AbortSignal.timeout(3000)
            : undefined,
      });
    try {
      const [healthRes, readyRes] = await Promise.all([
        call(`${this.origin}/api/healthz`),
        call(`${this.origin}/api/readyz`),
      ]);
      const healthBody = await readJson(healthRes);
      const readyBody = await readJson(readyRes);
      const health = healthRes.ok && healthBody?.status === 'ok' ? 'ok' : 'fail';
      const ready =
        readyBody?.status === 'ready' ? 'ready' : readyBody?.status === 'unready' ? 'unready' : 'fail';
      let openapi = false;
      try {
        const docRes = await call(`${this.root}/openapi.json`);
        const doc = await readJson(docRes);
        openapi = !!doc && typeof doc.openapi === 'string';
      } catch {
        openapi = false;
      }
      return {
        health,
        ready,
        openapi,
        detail: `${this.origin || window.location.origin}/api/v1`,
      };
    } catch (err) {
      return {
        health: 'fail',
        ready: 'fail',
        openapi: false,
        detail: err instanceof Error ? err.message : t('连接失败'),
      };
    }
  }

  async register(input: {
    email: string;
    password: string;
    display_name: string;
    captcha_token?: string;
  }): Promise<Session> {
    const session = await this.request<Session>('/auth/register/email', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    this.applySession(session);
    return session;
  }

  async login(input: {
    identifier: string;
    password: string;
    captcha_token?: string;
  }): Promise<PasswordLoginResult> {
    const result = await this.request<Session | TwoFactorChallenge>('/auth/login/password', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    // FSD F-04: an account with TOTP enabled gets a challenge and no session. Do not
    // touch the stored token: the second step is what mints it.
    if ('two_factor_required' in result && result.two_factor_required) {
      return { status: 'two_factor_required', challenge: result };
    }
    const session = result as Session;
    this.applySession(session);
    return { status: 'session', session };
  }

  /** 兑换密码登录返回的 2FA 挑战；成功后与普通登录一样建立会话。 */
  async loginTwoFactor(challengeToken: string, code: string): Promise<Session> {
    const session = await this.request<Session>('/auth/login/2fa', {
      method: 'POST',
      body: JSON.stringify({ challenge_token: challengeToken, code }),
    });
    this.applySession(session);
    return session;
  }

  /* ------------------------- 短信登录（Beta 1.2） ------------------------- */

  /**
   * 短信登录是否可用（`GET /auth/phone/policy`，公开）。
   *
   * 页面据此决定是否显示验证码登录入口；`provider=off` 时服务端发码返回 503
   * `sms_not_configured`。
   */
  async phonePolicy(): Promise<PhonePolicy> {
    return this.performRequest<PhonePolicy>('/auth/phone/policy');
  }

  /**
   * 请求一条短信验证码（`POST /auth/phone/codes`，202）。
   *
   * 同手机号 5 次/小时、同 IP 20 次/小时；超限 429。开发模式（`SMS_DEV_MODE`）下
   * 响应会带 `dev_code`。
   */
  async requestPhoneCode(
    phone: string,
    purpose: PhoneCodePurpose,
  ): Promise<PhoneCodeResult> {
    return this.request<PhoneCodeResult>('/auth/phone/codes', {
      method: 'POST',
      body: JSON.stringify({ phone, purpose }),
    });
  }

  /**
   * 用手机号 + 验证码登录（`POST /auth/phone/login`）。
   *
   * 返回形状与密码登录**完全一致**（`PasswordLoginResult`）：账号启用了 TOTP 时
   * 服务端只回一个挑战、不签发会话，所以这里绝不能无条件 `applySession`——否则会把
   * 挑战体当成会话写进存储，令牌变成 undefined。不存在的手机号在开放注册时自动建号，
   * 关闭注册时服务端返回 403 `registration_closed`。
   */
  async phoneLogin(input: {
    phone: string;
    code: string;
    display_name?: string;
  }): Promise<PasswordLoginResult> {
    const result = await this.request<Session | TwoFactorChallenge>('/auth/phone/login', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    if ('two_factor_required' in result && result.two_factor_required) {
      return { status: 'two_factor_required', challenge: result };
    }
    // Same narrowing the password endpoint uses: an account with TOTP enabled gets a
    // challenge and no session, so only a real session may reach the token store.
    const session = result as Session;
    this.applySession(session);
    return { status: 'session', session };
  }

  /** 自己的两步验证状态：是否开启、恢复码剩余数量、绑定时间。 */
  async twoFactorStatus(): Promise<TwoFactorStatus> {
    return this.performRequest<TwoFactorStatus>('/me/2fa');
  }

  /** 开始绑定：服务端返回 otpauth URI、base32 密钥与二维码内容。 */
  async beginTwoFactorEnrollment(password: string): Promise<TwoFactorEnrollment> {
    return this.request<TwoFactorEnrollment>('/me/2fa/enroll', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
  }

  /** 确认绑定；恢复码只在这里返回一次。 */
  async confirmTwoFactor(code: string): Promise<TwoFactorRecoveryCodes> {
    return this.request<TwoFactorRecoveryCodes>('/me/2fa/confirm', {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
  }

  /** 关闭两步验证：需要当前密码 + 一次有效验证码或恢复码。 */
  async disableTwoFactor(input: { password: string; code: string }): Promise<void> {
    await this.request<void>('/me/2fa/disable', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  /** 重新生成恢复码；旧恢复码全部作废。 */
  async regenerateTwoFactorRecoveryCodes(input: {
    password: string;
    code: string;
  }): Promise<TwoFactorRecoveryCodes> {
    return this.request<TwoFactorRecoveryCodes>('/me/2fa/recovery-codes', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  /** 平台管理员重置某个成员的两步验证（丢失设备）。 */
  async resetMemberTwoFactor(siteId: string, userId: string): Promise<void> {
    await this.request<void>(`/sites/${siteId}/members/${userId}/2fa/reset`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  /**
   * 站点的高威胁操作保护设置（开关、是否设了专用密码、令牌窗口）。
   *
   * 只读接口；服务端不返回专用密码或其哈希。
   */
  async stepUpSettings(siteId: string): Promise<StepUpSettings> {
    return this.request<StepUpSettings>(`/sites/${siteId}/step-up`);
  }

  /**
   * 保存保护设置。三个字段都是补丁：省略 `password` / `clear_password` 表示保持原值。
   *
   * 首次设置（当前未启用且未设专用密码）允许直接写入；之后再改需要 `X-PP-Step-Up`
   * 有效令牌，由 `ensureStepUp()` 在调用前拿到。
   */
  async saveStepUpSettings(
    siteId: string,
    input: StepUpSettingsUpdate,
  ): Promise<StepUpSettings> {
    return this.request<StepUpSettings>(`/sites/${siteId}/step-up`, {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  }

  /**
   * 用密码换一张短时二次验证令牌。
   *
   * 密码可以是账户登录密码；站点设置了专用安全密码时只接受专用密码（由服务端判定）。
   * 失败为 403，`details.reason = step_up_password_rejected`。
   */
  async verifyStepUp(password: string): Promise<StepUpVerifyResult> {
    return this.request<StepUpVerifyResult>('/auth/step-up', {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
  }

  /**
   * 用 HttpOnly 刷新 Cookie 换一张新的访问令牌。
   *
   * 两个容易踩的点：
   * 1. 双提交令牌必须取浏览器 Cookie 里那一份（见 `csrfToken`），不能信内存里的旧值；
   * 2. 刷新令牌是一次性的，同一浏览器的多个标签页必须排队刷新（`withRefreshLock`），
   *    否则先到的一枚被轮换、后到的被判定为重放，服务端会撤销整个会话家族。
   */
  async refresh(): Promise<Session> {
    if (!this.refreshPromise) {
      this.refreshPromise = withRefreshLock(() => this.performRefresh()).finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  private async performRefresh(): Promise<Session> {
    for (let attempt = 0; ; attempt += 1) {
      let res: Response;
      try {
        res = await fetch(`${this.root}/auth/token/refresh`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            Accept: 'application/json',
            'X-CSRF-Token': this.csrfToken(),
            'X-Request-ID': uuid(),
          },
        });
      } catch {
        throw new ApiError({
          ...fallbackProblem(0),
          code: 'internal',
          title: t('无法连接 API'),
          message: t('无法连接 {origin}，请确认服务已启动。', {
            origin: this.origin || window.location.origin,
          }),
        });
      }
      if (res.ok) {
        const session = await readResponseJson<Session>(res);
        this.applySession(session);
        return session;
      }
      const problem = await problemFromResponse(res);
      // 另一个标签页可能恰好在这一刻轮换了 CSRF Cookie：丢掉内存副本、重新读一次
      // Cookie 再试。这不绕过双提交校验——服务端仍然要求令牌与刷新令牌匹配。
      const racedCsrf =
        res.status === 403 && problem.details?.reason === 'csrf_mismatch' && attempt === 0;
      if (racedCsrf) {
        this.csrf = null;
        continue;
      }
      throw new ApiError(problem);
    }
  }

  async logout(): Promise<void> {
    try {
      // 服务端把登出也纳入 CSRF 派生绑定：没有双提交令牌会 403，HttpOnly refresh
      // cookie 清不掉，下次挂载 refresh() 会把用户静默登回来。令牌同样以 Cookie 为准：
      // 内存里那份可能已经被别的标签页刷新换掉了。
      await this.request<void>('/auth/logout', {
        method: 'POST',
        headers: { 'X-CSRF-Token': this.csrfToken() },
      });
    } catch {
      /* 登出失败不阻塞本地清理 */
    } finally {
      this.clearSession();
    }
  }

  async me(): Promise<Me> {
    // Always fresh: profile edits, password changes and email verification all
    // change the payload, and a cached /me would leave the UI on the old state.
    return this.performRequest<Me>('/me');
  }

  /** 登录态自助资料编辑。 */
  async updateProfile(input: ProfileInput): Promise<User> {
    return this.request<User>('/me/profile', {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  }

  /** 登录态改密；成功后其它设备被下线，当前会话保留。 */
  async changePassword(input: ChangePasswordInput): Promise<void> {
    await this.request<void>('/auth/password/change', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  /** 重新发送邮箱验证邮件。 */
  async requestEmailVerification(): Promise<{
    status: 'accepted' | 'already_verified';
    delivery: 'email';
    expires_in: number;
    already_verified: boolean;
  }> {
    return this.request('/me/email/verification', { method: 'POST' });
  }

  /** 兑换邮箱验证链接；公开端点，不需要登录。 */
  async verifyEmail(token: string): Promise<void> {
    await this.request<void>('/auth/email/verify', {
      method: 'POST',
      body: JSON.stringify({ token }),
    });
  }

  /** 后台网站日志：服务端审计查询。 */
  async auditLogs(siteId: string, query: AuditLogQuery = {}): Promise<AuditLogPage> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      params.set(key, String(value));
    }
    const suffix = params.toString();
    return this.performRequest<AuditLogPage>(
      `/sites/${siteId}/audit-logs${suffix ? `?${suffix}` : ''}`,
    );
  }

  /**
   * 仪表盘「最近操作」（Beta 1.2，契约 C 节：`GET /sites/{siteID}/activity`）。
   *
   * 数据源是服务端 `audit_logs`，不是浏览器本地记录。响应只有 `items`，没有游标；
   * `limit` 省略时服务端按 20 条返回。
   */
  async siteActivity(siteId: string, limit = 20): Promise<SiteActivityItem[]> {
    const params = new URLSearchParams({ limit: String(limit) });
    const res = await this.performRequest<{ items: SiteActivityItem[] }>(
      `/sites/${siteId}/activity?${params.toString()}`,
    );
    return res.items ?? [];
  }

  async passwordResetPolicy(): Promise<PasswordResetPolicy> {
    return this.request<PasswordResetPolicy>('/auth/password-reset/policy');
  }

  /**
   * 人机验证的真实状态。
   *
   * 这是表单是否渲染组件、设置页状态卡是否显示「生效」的唯一依据：站点设置里的
   * 开关只是意图，服务端没有 Secret 时不会校验。旧后端没有该路由时按未启用处理。
   */
  async captchaStatus(): Promise<CaptchaStatus> {
    try {
      return readCaptchaStatus(await this.request<unknown>('/captcha/status'));
    } catch (err) {
      if (err instanceof ApiError && (err.problem.status === 404 || err.problem.status === 405)) {
        return readCaptchaStatus(null);
      }
      throw err;
    }
  }

  /**
   * 本地（自托管）人机验证：取一道题。
   *
   * 题目与答案都在本站服务端，前端只拿到图形与几何信息与一次性的 challenge_id；
   * 答对后 `captchaLocalVerify` 换到的 token 和第三方服务商的 token 一样提交给
   * 受保护接口。题型（滑块 / 点击 / 选择图形）由服务端轮换。
   */
  async captchaLocalChallenge(scene: CaptchaScene): Promise<LocalCaptchaChallenge> {
    // 题目必须每次都新取：走 `request` 的 GET 缓存会复用同一个 challenge_id，
    // 而服务端一次答题就作废它。第三个参数关掉重试（公共 GET 没有 401 可重试），
    // 同时也绕过请求缓存。
    const raw = await this.request<unknown>(
      `/captcha/local/challenge?scene=${encodeURIComponent(scene)}`,
      {},
      false,
    );
    return readLocalCaptchaChallenge(raw);
  }

  /** 本地（自托管）人机验证：提交答案，换一次性 token。 */
  async captchaLocalVerify(input: {
    challenge_id: string;
    answer: LocalCaptchaAnswer;
    scene: CaptchaScene;
  }): Promise<LocalCaptchaSolution> {
    return this.request<LocalCaptchaSolution>('/captcha/local/verify', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async requestPasswordReset(email: string, captchaToken?: string): Promise<PasswordResetTicket> {
    return this.request<PasswordResetTicket>('/auth/password-reset/request', {
      method: 'POST',
      body: JSON.stringify(captchaToken ? { email, captcha_token: captchaToken } : { email }),
    });
  }

  async resetPassword(input: { token: string; password: string }): Promise<void> {
    await this.request<void>('/auth/password-reset/confirm', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async site(siteId: string): Promise<Site> {
    return this.request<Site>(`/sites/${siteId}`);
  }

  async updateSite(
    siteId: string,
    patch: Partial<{
      name: string;
      description: string;
      visibility_mode: Site['visibility_mode'];
      publish_mode: Site['publish_mode'];
      domain: string;
      /** O-3：关闭后注册接口返回 403 registration_closed。 */
      registration_open: boolean;
      /** 站点级评论开关：关闭后 POST /comments 返回 403 comments_closed。 */
      comments_enabled: boolean;
      /** 先审后发：新评论进入 pending_review。 */
      comments_require_review: boolean;
      /** 省略表示不修改，null 表示继承部署默认，0 表示无限。 */
      media_quota_bytes: MediaQuotaBytes;
    }>,
  ): Promise<void> {
    await this.request<void>(`/sites/${siteId}/settings`, {
      method: 'PATCH',
      body: quotaPatchBody(patch),
    });
  }

  /** 站点内容安全策略：敏感词、IP 黑白名单与评论频率限制。 */
  async safetyPolicy(siteId: string): Promise<SafetyPolicy> {
    return this.request<SafetyPolicy>(`/sites/${siteId}/safety`);
  }

  /** 更新评论频率阈值；省略的字段保持不变。 */
  async updateSafetyRateLimit(
    siteId: string,
    patch: Partial<SafetyRateLimit>,
  ): Promise<SafetyRateLimit> {
    return this.request<SafetyRateLimit>(`/sites/${siteId}/safety`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  /** 新增敏感词；mode 决定拒绝、替换还是标记待审。 */
  async createSensitiveWord(
    siteId: string,
    input: {
      word: string;
      mode: SensitiveWordMode;
      replacement?: string;
      enabled?: boolean;
    },
  ): Promise<SensitiveWord> {
    return this.request<SensitiveWord>(`/sites/${siteId}/safety/words`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  /** 调整敏感词的动作、占位符或启用状态；词本身不可改名。 */
  async updateSensitiveWord(
    siteId: string,
    wordId: string,
    patch: Partial<{ mode: SensitiveWordMode; replacement: string; enabled: boolean }>,
  ): Promise<SensitiveWord> {
    return this.request<SensitiveWord>(`/sites/${siteId}/safety/words/${wordId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  async deleteSensitiveWord(siteId: string, wordId: string): Promise<void> {
    await this.request<void>(`/sites/${siteId}/safety/words/${wordId}`, { method: 'DELETE' });
  }

  /** 新增 IP 白名单 / 黑名单条目；value 为地址或 CIDR。 */
  async createSiteIPRule(
    siteId: string,
    input: { kind: 'allow' | 'deny'; value: string; note?: string },
  ): Promise<SiteIPRule> {
    return this.request<SiteIPRule>(`/sites/${siteId}/safety/ip-rules`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async deleteSiteIPRule(siteId: string, ruleId: string): Promise<void> {
    await this.request<void>(`/sites/${siteId}/safety/ip-rules/${ruleId}`, {
      method: 'DELETE',
    });
  }

  /** 设置主域名；空字符串表示清除（生产环境将回退到只允许公网 IP）。 */
  async setSiteDomain(siteId: string, domain: string): Promise<void> {    await this.request<void>(`/sites/${siteId}/domain`, {
      method: 'PUT',
      body: JSON.stringify({ domain }),
    });
  }

  /**
   * 读取主域名与其 TXT 归属验证信息（V-12）。
   *
   * 保存域名后服务端进入「待验证」：响应里带 verification_token 与 record_name，
   * 站长把 TXT 记录加到 DNS 后再调用 verifySiteDomain 立即验证。
   */
  async siteDomain(siteId: string): Promise<SiteDomainVerification> {
    return this.request<SiteDomainVerification>(`/sites/${siteId}/domain`);
  }

  /** 立即验证主域名归属；失败抛 ApiError（details.reason 说明原因）。 */
  async verifySiteDomain(siteId: string): Promise<SiteDomainVerificationResult> {
    return this.request<SiteDomainVerificationResult>(`/sites/${siteId}/domain/verify`, {
      method: 'POST',
    });
  }

  /* ------------------------- 重定向与公开路径解析（Beta 1.2） ------------------------- */

  /**
   * 公开路径解析（`GET /resolve?path=`，公开端点，契约 J2）。
   *
   * 供静态服务器与前端路由决定 301 / 200 / 404：id 形式且存在 → 301 到 slug 形式；
   * 已是 slug 形式且存在 → 200；命中重定向表 → 规则的 301 / 302 / 308；否则 404。
   * 走 `performRequest` 而不是 `request`：路径解析结果会随 slug 变化，不能吃 GET 短缓存。
   */
  async resolvePath(path: string): Promise<ResolveResult> {
    return this.performRequest<ResolveResult>(`/resolve?path=${encodeURIComponent(path)}`);
  }

  /**
   * 重定向规则列表（`GET /sites/{siteID}/redirects`，需要 `manage_site`）。
   *
   * `q` 按 `from_path` / `to_path` 搜索；游标分页，形状与其它列表一致。
   */
  async listRedirects(
    siteId: string,
    query: { limit?: number; cursor?: string; q?: string } = {},
  ): Promise<Page<RedirectRule>> {
    const params = new URLSearchParams();
    params.set('limit', String(query.limit ?? 50));
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.q) params.set('q', query.q);
    return this.request<Page<RedirectRule>>(
      `/sites/${siteId}/redirects?${params.toString()}`,
    );
  }

  /** 新建重定向规则（契约 J3）；`from_path` 重复时服务端返回 409。 */
  async createRedirect(
    siteId: string,
    input: {
      from_path: string;
      to_path: string;
      status_code?: RedirectRule['status_code'];
    },
  ): Promise<RedirectRule> {
    return this.request<RedirectRule>(`/sites/${siteId}/redirects`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  /** 修改重定向规则；省略的字段保持不变。 */
  async updateRedirect(
    siteId: string,
    redirectId: string,
    patch: Partial<{
      from_path: string;
      to_path: string;
      status_code: RedirectRule['status_code'];
    }>,
  ): Promise<RedirectRule> {
    return this.request<RedirectRule>(
      `/sites/${siteId}/redirects/${encodeURIComponent(redirectId)}`,
      { method: 'PATCH', body: JSON.stringify(patch) },
    );
  }

  /** 删除重定向规则；成功是 204。 */
  async deleteRedirect(siteId: string, redirectId: string): Promise<void> {
    await this.request<void>(
      `/sites/${siteId}/redirects/${encodeURIComponent(redirectId)}`,
      { method: 'DELETE' },
    );
  }

  /** 平台控制台：部署内全部站点（仅平台管理员）。 */
  async platformSites(): Promise<PlatformSite[]> {
    const res = await this.request<{ items: PlatformSite[] }>('/platform/sites');
    return res.items;
  }

  /** 平台控制台：新建站点、默认设计与第一个管理员。 */
  async createPlatformSite(input: CreateSiteInput): Promise<CreatedSite> {
    return this.request<CreatedSite>('/platform/sites', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  /** 平台控制台：读取单个站点（平台管理员或该站点管理员）。 */
  async platformSite(siteId: string): Promise<PlatformSiteDetail> {
    return this.request<PlatformSiteDetail>(`/platform/sites/${siteId}`);
  }

  /** 平台控制台：兑换目标站点的主域名 TXT 挑战。 */
  async verifyPlatformSiteDomain(siteId: string): Promise<SiteDomainVerification> {
    return this.request<SiteDomainVerification>(`/platform/sites/${siteId}/domain/verify`, {
      method: 'POST',
    });
  }

  /** 平台控制台：申请进入站点，拿到目标源的交接令牌。 */
  async enterPlatformSite(siteId: string): Promise<PlatformSiteEntry> {
    return this.request<PlatformSiteEntry>(`/platform/sites/${siteId}/enter`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  /**
   * 平台总览：部署级计数、异常信号、每站一行与最近的跨站审计行。
   *
   * 只对平台管理员开放；`windowDays` 省略时服务端按 7 天统计活动。
   */
  async platformOverview(windowDays?: number): Promise<PlatformOverview> {
    const suffix = windowDays ? `?window_days=${windowDays}` : '';
    return this.request<PlatformOverview>(`/platform/overview${suffix}`);
  }

  /**
   * 跨站审计查询：与站点内审计相同的筛选词，`site_id` 省略表示全部站点。
   *
   * 服务端会为这次读取本身写一条 `platform.audit.queried` 审计行。
   */
  async platformAuditLogs(query: PlatformAuditQuery = {}): Promise<AuditLogPage> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      params.set(key, String(value));
    }
    const suffix = params.toString();
    return this.performRequest<AuditLogPage>(
      `/platform/audit-logs${suffix ? `?${suffix}` : ''}`,
    );
  }

  /** 平台用户目录：全部署账户，或某个站点的成员（只读）。 */
  async platformAccounts(query: PlatformAccountQuery = {}): Promise<PlatformAccountPage> {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      params.set(key, String(value));
    }
    const suffix = params.toString();
    return this.performRequest<PlatformAccountPage>(
      `/platform/users${suffix ? `?${suffix}` : ''}`,
    );
  }

  /**
   * 在目标站点源兑换交接令牌。
   *
   * 不经过 GET 缓存，也会在成功后换上新的访问令牌与 CSRF；刷新 Cookie 由服务端写入。
   */
  async claimSiteSwitch(switchToken: string): Promise<Session> {
    const session = await this.performRequest<Session>('/platform/enter/claim', {
      method: 'POST',
      body: JSON.stringify({ switch_token: switchToken }),
    });
    this.applySession(session);
    return session;
  }

  /**
   * 站点设计（主题、页面、扩展、SEO）的服务端副本。
   *
   * 404 表示这个站点还没有保存过设计：返回 null，由调用方继续使用本地缓存。
   * 设计必须尽量新（冲突重试要用最新 revision），所以这里绕过 GET 短缓存。
   */
  async siteCustomization(siteId: string): Promise<SiteCustomizationSnapshot | null> {
    try {
      return await this.performRequest<SiteCustomizationSnapshot>(
        `/sites/${siteId}/customization`,
      );
    } catch (err) {
      if (err instanceof ApiError && err.problem.status === 404) return null;
      throw err;
    }
  }

  /**
   * 保存站点设计。
   *
   * `revision` 是客户端最后看到的版本：带上它做乐观并发控制，省略表示无条件覆盖。
   * 版本落后时服务端返回 409，由 customizationSync 处理重试。
   */
  async saveSiteCustomization(
    siteId: string,
    customization: unknown,
    revision?: number,
  ): Promise<SiteCustomizationSaved> {
    return this.request<SiteCustomizationSaved>(`/sites/${siteId}/customization`, {
      method: 'PUT',
      body: JSON.stringify(revision === undefined ? { customization } : { customization, revision }),
    });
  }

  /**
   * 站点级配置（访问限制、域名、性能、加载动画、登录方式）。
   *
   * 404 表示这个站点还没有保存过配置：返回 null，由调用方继续使用本地缓存。
   * 访客拿到公开子集，站点管理员拿到完整文档（`scope: admin`）。这里必须绕过
   * GET 短缓存：冲突重试要用最新的 revision。
   */
  async siteConfig(siteId: string): Promise<SiteConfigSnapshot | null> {
    try {
      return await this.performRequest<SiteConfigSnapshot>(`/sites/${siteId}/site-config`);
    } catch (err) {
      if (err instanceof ApiError && err.problem.status === 404) return null;
      throw err;
    }
  }

  /** 保存站点配置；`revision` 省略表示无条件写入（首次保存）。 */
  async saveSiteConfig(
    siteId: string,
    config: unknown,
    revision?: number,
  ): Promise<SiteConfigSaved> {
    return this.request<SiteConfigSaved>(`/sites/${siteId}/site-config`, {
      method: 'PUT',
      body: JSON.stringify(revision === undefined ? { config } : { config, revision }),
    });
  }

  /**
   * 性能面板：本机资源快照。
   *
   * 可选模块；部署关掉 `PP_SYSTEM_METRICS` 时路由不存在（404），页面会提示模块未启用。
   * 只有平台管理员能读，因为响应里包含主机名、路径与进程名。
   */
  async systemMetrics(): Promise<SystemMetrics> {
    return this.performRequest<SystemMetrics>('/system/metrics');
  }

  /**
   * 读取服务端真实生效的部署配置（Beta 1.2）。
   *
   * 与 `systemMetrics` 分开是因为它面向站点管理员而不是平台管理员：储存与访问设置
   * 是站长会去改的东西，他们需要看到自己改的到底有没有生效。响应里没有任何密钥。
   */
  async effectiveConfig(): Promise<EffectiveConfig> {
    return this.performRequest<EffectiveConfig>('/system/effective-config');
  }

  /* ------------------------- 日志查看器 / 队列监控 / 自动备份（Beta 1.2） ------------------------- */

  /**
   * 请求日志查看器（`GET /system/logs`，site_admin，契约 K 节）。
   *
   * 服务端只有进程内环形缓冲（最近 500 条），只记元数据；筛选与 `limit` 都在服务端做。
   * 走 `performRequest` 而不是 `request`：日志页不该看到短缓存里的旧记录。
   */
  async systemLogs(
    query: { limit?: number; status?: number; path?: string; method?: string } = {},
  ): Promise<SystemLogEntry[]> {
    const params = new URLSearchParams();
    params.set('limit', String(query.limit ?? 100));
    if (query.status !== undefined) params.set('status', String(query.status));
    if (query.path) params.set('path', query.path);
    if (query.method) params.set('method', query.method);
    const res = await this.performRequest<{ items: SystemLogEntry[] }>(
      `/system/logs?${params.toString()}`,
    );
    return res.items ?? [];
  }

  /** 队列监控（`GET /system/queue`，site_admin）：outbox 积压、最近事件与邮件队列。 */
  async systemQueue(): Promise<QueueStatus> {
    return this.performRequest<QueueStatus>('/system/queue');
  }

  /**
   * 重试 outbox 投递（`POST /system/queue/retry`，site_admin）。
   *
   * `eventIds` 为空表示重试最近 50 条失败事件；返回实际重试的条数。
   */
  async retryQueue(eventIds: string[] = []): Promise<{ retried: number }> {
    return this.request<{ retried: number }>('/system/queue/retry', {
      method: 'POST',
      body: JSON.stringify({ event_ids: eventIds }),
    });
  }

  /** 自动备份计划（`GET /system/backup-schedule`，platform_admin，契约 L 节）。 */
  async backupSchedule(): Promise<BackupSchedule> {
    return this.performRequest<BackupSchedule>('/system/backup-schedule');
  }

  /* ------------------------- 服务器扩展管理 ------------------------- */

  /**
   * 已安装的服务器扩展清单。
   *
   * 走 `performRequest` 而不是 `request`：扩展安装状态变化频繁，不适合短缓存；
   * 且 401 刷新、problem JSON 解析与其它写请求保持一致。
   */
  async listExtensions(): Promise<ExtensionSummary[]> {
    const res = await this.performRequest<{ items: ExtensionSummary[] }>('/extensions');
    return res.items;
  }

  /**
   * 导入一个 zip 扩展包。
   *
   * 直接把 `FormData` 交给 `performRequest`：它只在 body 是字符串时手写
   * `Content-Type`，因此 multipart 的 boundary 由浏览器自动生成，不会被覆盖。
   */
  async importExtension(file: File): Promise<ExtensionSummary> {
    const form = new FormData();
    form.append('package', file, file.name);
    const res = await this.request<{ extension: ExtensionSummary }>('/extensions/import', {
      method: 'POST',
      body: form,
    });
    return res.extension;
  }

  /** 启用 / 禁用；服务端返回规范化后的扩展快照。 */
  async setExtensionEnabled(id: string, enabled: boolean): Promise<ExtensionSummary> {
    const res = await this.request<{ extension: ExtensionSummary }>(
      `/extensions/${encodeURIComponent(id)}`,
      { method: 'PATCH', body: JSON.stringify({ enabled }) },
    );
    return res.extension;
  }

  /** 删除已安装的扩展包；成功是 204。 */
  async deleteExtension(id: string): Promise<void> {
    await this.request<void>(`/extensions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  async members(siteId: string): Promise<Member[]> {
    const res = await this.request<{ items: Member[] }>(`/sites/${siteId}/members`);
    return res.items;
  }

  /** 能力组列表（内置 + 自定义）。 */
  async permissionGroups(siteId: string): Promise<PermissionGroupConfig[]> {
    const res = await this.request<{ items: PermissionGroupConfig[] }>(
      `/sites/${siteId}/permission-groups`,
    );
    return res.items;
  }

  /** 新建或整组更新能力组。PUT 是整组替换，调用方要发送完整的矩阵。 */
  async savePermissionGroup(
    siteId: string,
    key: string,
    input: PermissionGroupInput,
  ): Promise<PermissionGroupConfig> {
    return this.request<PermissionGroupConfig>(
      `/sites/${siteId}/permission-groups/${encodeURIComponent(key)}`,
      {
        method: 'PUT',
        body: JSON.stringify(input),
      },
    );
  }

  /** 把成员移入能力组；服务端同时把基础角色写回成员。 */
  async assignMemberGroup(siteId: string, userId: string, groupKey: string): Promise<void> {
    await this.request<void>(`/sites/${siteId}/members/${userId}/group`, {
      method: 'PATCH',
      body: JSON.stringify({ group_key: groupKey }),
    });
  }

  async createMember(siteId: string, input: NewMemberInput): Promise<Member> {
    return this.request<Member>(`/sites/${siteId}/members`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async setMemberRole(siteId: string, userId: string, role: Role): Promise<void> {
    await this.request<void>(`/sites/${siteId}/members/${userId}/role`, {
      method: 'PATCH',
      body: JSON.stringify({ role }),
    });
  }

  /** 设置单个成员的媒体额度；null 清除覆盖值并继承默认额度。 */
  async setMemberQuota(
    siteId: string,
    userId: string,
    mediaQuotaBytes: MediaQuotaBytes,
  ): Promise<Member> {
    return this.request<Member>(`/sites/${siteId}/members/${userId}/quota`, {
      method: 'PATCH',
      body: quotaPatchBody({ media_quota_bytes: mediaQuotaBytes }),
    });
  }

  async updateMember(
    siteId: string,
    userId: string,
    patch: { display_name?: string; email?: string },
  ): Promise<Member> {
    return this.request<Member>(`/sites/${siteId}/members/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  async setMemberStatus(
    siteId: string,
    userId: string,
    status: 'active' | 'suspended',
  ): Promise<Member> {
    return this.request<Member>(`/sites/${siteId}/members/${userId}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status }),
    });
  }

  async deleteMember(siteId: string, userId: string): Promise<void> {
    await this.request<void>(`/sites/${siteId}/members/${userId}`, { method: 'DELETE' });
  }

  async publicUser(userId: string): Promise<PublicProfile> {
    return this.request<PublicProfile>(`/users/${userId}`);
  }

  async listContent(
    kind: ContentKind,
    options: ContentListOptions = {},
  ): Promise<ContentPage> {
    const params = new URLSearchParams();
    params.set('limit', String(options.limit ?? 20));
    if (options.cursor) params.set('cursor', options.cursor);
    if (options.authorId) params.set('author_id', options.authorId);
    // P3 的四个筛选参数：空值不上线，服务端会当成"筛选空条件"。
    if (options.categoryId) params.set('category_id', options.categoryId);
    if (options.tag) params.set('tag', options.tag);
    if (options.since) params.set('since', options.since);
    if (options.sort) params.set('sort', options.sort);
    if (options.trashed) params.set('trashed', 'true');
    return this.request<ContentPage>(`/${kind}s?${params.toString()}`);
  }

  /**
   * 读取一篇内容（`GET /{kind}s/{key}`）。
   *
   * `key` 先按 id 查，查不到再按 slug 查（契约 J1），所以 `/a/:key` 与 `/p/:key` 两种
   * 路由都能打开。带 `previewToken` 时以预览身份读取：未发布内容也返回 200，
   * 令牌无效 / 过期仍是 404。
   */
  async getContent(kind: ContentKind, key: string, previewToken?: string): Promise<Content> {
    // 详情读取是服务端累加阅读量的地方（FSD A-16）。带上匿名会话，让同一浏览器
    // 在短窗口内的刷新、前进后退只算一次；没有会话时服务端退回账号或来源地址。
    const suffix = previewToken
      ? `?preview_token=${encodeURIComponent(previewToken)}`
      : '';
    return this.request<Content>(`/${kind}s/${encodeURIComponent(key)}${suffix}`, {
      headers: { 'X-Visit-Session': clientSessionId() },
    });
  }

  /**
   * 热门内容：按阅读量 + 时间衰减排序的已发布公开内容。
   *
   * 与列表分开是因为排序发生在服务端：前端拿不到全站阅读量，本地访问记录只覆盖
   * 当前浏览器，用它对排序会把「我看过的」当成「大家看过的」。
   */
  async popularContent(options: PopularContentOptions = {}): Promise<PopularContentPage> {
    const params = new URLSearchParams();
    params.set('limit', String(options.limit ?? 8));
    if (options.kind) params.set('kind', options.kind);
    if (options.categoryId) params.set('category_id', options.categoryId);
    if (options.tag) params.set('tag', options.tag);
    if (options.window) params.set('window', options.window);
    return this.request<PopularContentPage>(`/content/popular?${params.toString()}`);
  }

  /**
   * 解锁密码文章（C-18）。
   *
   * 成功时服务端会写一个 HttpOnly Cookie，后续 getContent 自动带上；这里的返回值只
   * 用于确认与提示，前端不得依赖它做权限判断。
   */
  async unlockContent(
    kind: ContentKind,
    id: string,
    password: string,
  ): Promise<ContentUnlockResult> {
    return this.request<ContentUnlockResult>(`/${kind}s/${id}/unlock`, {
      method: 'POST',
      body: JSON.stringify({ password }),
    });
  }

  async createDraft(kind: ContentKind, input: DraftInput): Promise<Content> {
    return this.request<Content>(`/${kind}s`, {
      method: 'POST',
      headers: { 'Idempotency-Key': uuid() },
      body: JSON.stringify(input),
    });
  }

  async updateDraft(kind: ContentKind, id: string, input: DraftInput): Promise<Content> {
    return this.request<Content>(`/${kind}s/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  }

  async contentAction(
    kind: ContentKind,
    id: string,
    action: ContentAction,
    reason?: string,
  ): Promise<Content> {
    return this.request<Content>(`/${kind}s/${id}/${action}`, {
      method: 'POST',
      headers: { 'Idempotency-Key': uuid() },
      body: JSON.stringify(reason ? { reason } : {}),
    });
  }

  /**
   * 把内容移入回收站（Beta 1.2）。
   *
   * 服务端只做软删除：行还在，revisions、评论与媒体引用都保持可解析，所以恢复是
   * 无损的。返回的 `deleted_at` 有值，界面据此切换到"已删除"态。
   */
  async deleteContent(kind: ContentKind, id: string): Promise<Content> {
    return this.request<Content>(`/${kind}s/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'Idempotency-Key': uuid() },
    });
  }

  /** 从回收站彻底删除。不可恢复；成功没有响应体。 */
  async purgeContent(kind: ContentKind, id: string): Promise<void> {
    await this.request<void>(`/${kind}s/${encodeURIComponent(id)}/purge`, {
      method: 'POST',
      headers: { 'Idempotency-Key': uuid() },
      body: JSON.stringify({}),
    });
  }

  /** 版本历史列表（最新 20 版）；只有作者与编辑可以读取。 */
  async contentRevisions(kind: ContentKind, id: string): Promise<ContentRevisionPage> {
    return this.request<ContentRevisionPage>(`/${kind}s/${id}/revisions`);
  }

  /** 单个版本的完整内容，包含源文，用于查看与回滚前确认。 */
  async contentRevision(
    kind: ContentKind,
    id: string,
    revisionId: string,
  ): Promise<ContentRevision> {
    return this.request<ContentRevision>(`/${kind}s/${id}/revisions/${revisionId}`);
  }

  /** 回滚到指定版本；服务端会先备份当前版本。 */
  async restoreContentRevision(
    kind: ContentKind,
    id: string,
    revisionId: string,
  ): Promise<Content> {
    return this.request<Content>(`/${kind}s/${id}/revisions/${revisionId}/restore`, {
      method: 'POST',
      headers: { 'Idempotency-Key': uuid() },
      body: JSON.stringify({}),
    });
  }

  /**
   * 两个版本的行级差异（Beta 1.2，契约 E 节）。
   *
   * `to` 可以是版本号或 `current`；超长正文由服务端截断到前 20000 行并置
   * `truncated: true`。只有作者与编辑可以读取。
   */
  async contentDiff(
    kind: ContentKind,
    id: string,
    from: number,
    to: number | 'current' = 'current',
  ): Promise<ContentDiff> {
    const params = new URLSearchParams({ from: String(from), to: String(to) });
    return this.request<ContentDiff>(
      `/${kind}s/${encodeURIComponent(id)}/diff?${params.toString()}`,
    );
  }

  /**
   * 批量执行内容动作（Beta 1.2，契约 G 节：`POST /{articles|posts}/bulk`）。
   *
   * 逐条独立判定权限与状态并返回逐条结果，所以部分成功是正常结果而不是错误；
   * `ids` 一次最多 100 条，单条失败不会让整个请求 500。
   */
  async bulkContentAction(
    kind: ContentKind,
    ids: string[],
    action: BulkAction,
  ): Promise<BulkResult> {
    return this.request<BulkResult>(`/${kind}s/bulk`, {
      method: 'POST',
      headers: { 'Idempotency-Key': uuid() },
      body: JSON.stringify({ ids, action }),
    });
  }

  /**
   * 为草稿 / 未发布内容签发一次性预览授权（Beta 1.2，契约 H 节）。
   *
   * 令牌为 HMAC 签名，默认 30 分钟有效且只对这篇内容有效；`path` 可以直接打开或
   * 分享。预览读取使用 `getContent(kind, key, token)`。
   */
  async issueContentPreview(kind: ContentKind, id: string): Promise<PreviewGrant> {
    return this.request<PreviewGrant>(`/${kind}s/${encodeURIComponent(id)}/preview`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
  }

  /**
   * 全文检索。
   *
   * 服务端按相关度排序并返回真实游标：把 `next_cursor` 原样传回 `cursor` 取下一页，
   * 用 `total` 显示全量命中数。筛选条件全部在服务端完成，非法值会得到 400 而不是
   * 被静默忽略（被忽略的筛选会把结果集悄悄放大）。
   */
  async search(q: string, options: SearchQuery = {}): Promise<SearchResult> {
    const params = new URLSearchParams({ q, limit: String(options.limit ?? 20) });
    if (options.kind) params.set('kind', options.kind);
    if (options.category_id) params.set('category_id', options.category_id);
    if (options.tag) params.set('tag', options.tag);
    if (options.author_id) params.set('author_id', options.author_id);
    if (options.since) params.set('since', options.since);
    if (options.until) params.set('until', options.until);
    if (options.cursor) params.set('cursor', options.cursor);
    // 服务端默认给片段；只有显式关闭才发参数。
    if (options.highlight === false) params.set('highlight', 'false');
    return this.request<SearchResult>(`/search?${params.toString()}`);
  }

  async comments(targetType: string, targetId: string): Promise<CommentsResult> {
    const params = new URLSearchParams({ target_type: targetType, target_id: targetId, limit: '100' });
    try {
      const res = await this.request<Omit<CommentPage, 'supported'>>(`/comments?${params.toString()}`);
      return { items: res.items, supported: true };
    } catch (err) {
      // 老版本服务端还没有 GET /comments：前台照常展示“评论可以写入但读不回来”。
      if (err instanceof ApiError && (err.code === 'not_found' || err.problem.status === 404)) {
        return { items: [], supported: false };
      }
      throw err;
    }
  }

  async allComments(query: CommentQuery = {}): Promise<CommentPage> {
    const params = new URLSearchParams();
    if (query.target_type) params.set('target_type', query.target_type);
    if (query.target_id) params.set('target_id', query.target_id);
    if (query.status) params.set('status', query.status);
    if (query.q) params.set('q', query.q);
    params.set('limit', String(query.limit ?? 20));
    if (query.cursor) params.set('cursor', query.cursor);
    const res = await this.request<Omit<CommentPage, 'supported'>>(`/comments?${params.toString()}`);
    return { ...res, supported: true };
  }

  async moderateComment(id: string, action: CommentModerationAction): Promise<void> {
    if (action === 'delete') {
      await this.request<void>(`/comments/${id}`, { method: 'DELETE' });
      return;
    }
    if (action === 'approve') {
      await this.request<import('../types').Comment>(`/comments/${id}/approve`, { method: 'POST' });
      return;
    }
    if (action === 'reject') {
      await this.request<import('../types').Comment>(`/comments/${id}/reject`, { method: 'POST' });
      return;
    }
    await this.request<import('../types').Comment>(`/comments/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'hidden' }),
    });
  }

  /** 举报一篇内容、一条评论或一个账户。 */
  async report(input: ReportInput): Promise<Report> {
    return this.request<Report>('/reports', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  /** 后台举报队列（编辑及以上）。 */
  async reports(): Promise<Report[]> {
    const res = await this.request<{ items: Report[] }>('/reports');
    return res.items;
  }

  /** 认领举报，之后才能由本人处理。 */
  async assignReport(id: string): Promise<Report> {
    return this.request<Report>(`/reports/${id}/assign`, { method: 'POST' });
  }

  /** 处理举报：忽略 / 下架内容 / 封禁目标。 */
  async resolveReport(id: string, action: ReportAction, note = ''): Promise<Report> {
    return this.request<Report>(`/reports/${id}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ action, note }),
    });
  }

  async createComment(
    input: {
      target_type: 'article' | 'post' | 'comment' | 'page';
      target_id: string;
      parent_id?: string;
      body: string;
      captcha_token?: string;
    },
    _policy?: { require_review?: boolean },
  ) {
    // 是否先审后发由服务端策略决定，请求里不携带前端开关。
    return this.request<import('../types').Comment>('/comments', {
      method: 'POST',
      headers: { 'Idempotency-Key': uuid() },
      body: JSON.stringify(input),
    });
  }

  async updateComment(id: string, body: string) {
    return this.request<import('../types').Comment>(`/comments/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ body }),
    });
  }

  async deleteComment(id: string): Promise<void> {
    await this.request<void>(`/comments/${id}`, { method: 'DELETE' });
  }

  async toggleReaction(
    targetType: 'article' | 'post' | 'comment',
    targetId: string,
    kind: 'like' | 'love' | 'insightful' = 'like',
    active?: boolean,
  ): Promise<ToggleResult> {
    return this.request<ToggleResult>(`/reactions/${targetType}/${targetId}?kind=${kind}`, {
      method: 'POST',
      body: JSON.stringify(active === undefined ? {} : { active }),
    });
  }

  async toggleBookmark(
    targetType: 'article' | 'post',
    targetId: string,
    active?: boolean,
  ): Promise<ToggleResult> {
    return this.request<ToggleResult>(`/bookmarks/${targetType}/${targetId}`, {
      method: 'POST',
      body: JSON.stringify(active === undefined ? {} : { active }),
    });
  }

  async toggleFollow(userId: string, active?: boolean): Promise<ToggleResult> {
    return this.request<ToggleResult>(`/follows/${userId}`, {
      method: 'POST',
      body: JSON.stringify(active === undefined ? {} : { active }),
    });
  }

  /**
   * 读取当前登录用户对一条内容的互动状态。
   *
   * 刷新后必须靠它恢复已赞 / 已收藏 / 已关注：切换端点在不带 `active` 时是
   * “翻转”，若前端把已点赞的内容当成未选中，用户第一次点击反而会取消点赞。
   * 旧后端没有这个路由时返回全 false，保持降级而不是让页面报错。
   */
  async stateFor(
    targetType: string,
    targetId: string,
    userId?: string,
  ): Promise<InteractionState> {
    const params = new URLSearchParams({ target_type: targetType, target_id: targetId });
    if (userId) params.set('author_id', userId);
    try {
      return await this.request<InteractionState>(`/interactions/state?${params.toString()}`);
    } catch (err) {
      if (err instanceof ApiError && (err.problem.status === 404 || err.problem.status === 405)) {
        return { liked: false, bookmarked: false, following: false };
      }
      throw err;
    }
  }

  /** 列表批量状态：归档网格用它一次取回一页卡片的已赞 / 已收藏 / 已关注。 */
  async interactionStates(
    targetType: string,
    targetIds: string[],
    authorIds: string[] = [],
  ): Promise<InteractionStates> {
    const params = new URLSearchParams({ target_type: targetType });
    if (targetIds.length) params.set('target_ids', targetIds.join(','));
    if (authorIds.length) params.set('author_ids', authorIds.join(','));
    try {
      return await this.request<InteractionStates>(`/interactions/states?${params.toString()}`);
    } catch (err) {
      if (err instanceof ApiError && (err.problem.status === 404 || err.problem.status === 405)) {
        return {
          items: targetIds.map((id) => ({ target_id: id, liked: false, bookmarked: false })),
          follows: authorIds.map((id) => ({ user_id: id, following: false })),
        };
      }
      throw err;
    }
  }

  /** 我的收藏，新到旧；条目已带标题与作者，不需要逐条再请求。 */
  async bookmarks(options: InteractionListOptions = {}): Promise<Page<InteractionEntry>> {
    return this.request<Page<InteractionEntry>>(`/me/bookmarks?${interactionQuery(options)}`);
  }

  /** 我的点赞，默认只看 like。 */
  async likes(options: InteractionListOptions = {}): Promise<Page<InteractionEntry>> {
    return this.request<Page<InteractionEntry>>(`/me/likes?${interactionQuery(options)}`);
  }

  /** 阅读历史，按最后访问时间排序。 */
  async readingHistory(options: InteractionListOptions = {}): Promise<Page<ReadingHistoryEntry>> {
    return this.request<Page<ReadingHistoryEntry>>(`/me/reading-history?${interactionQuery(options)}`);
  }

  /** 记录一次阅读；失败不影响正文展示。 */
  async recordReading(targetType: 'article' | 'post', targetId: string): Promise<void> {
    await this.request<void>('/me/reading-history', {
      method: 'POST',
      body: JSON.stringify({ target_type: targetType, target_id: targetId }),
    });
  }

  /** 我关注的人。 */
  async following(options: InteractionListOptions = {}): Promise<Page<FollowEntry>> {
    return this.request<Page<FollowEntry>>(`/me/following?${interactionQuery(options)}`);
  }

  /** 关注我的人。 */
  async followers(options: InteractionListOptions = {}): Promise<Page<FollowEntry>> {
    return this.request<Page<FollowEntry>>(`/me/followers?${interactionQuery(options)}`);
  }

  /** 仅登录可见的成员目录；返回公开资料投影。 */
  async memberDirectory(options: MemberDirectoryOptions = {}): Promise<PublicProfile[]> {
    const params = new URLSearchParams({ limit: String(options.limit ?? 100) });
    if (options.query) params.set('q', options.query);
    if (options.cursor) params.set('cursor', options.cursor);
    const page = await this.request<{ items: PublicProfile[] }>(
      `/members?${params.toString()}`,
    );
    return page.items;
  }

  /** 发起私信（一位其他成员）或群聊（多位成员）。 */
  async createConversation(memberIds: string[]): Promise<Conversation> {
    return this.request<Conversation>('/conversations', {
      method: 'POST',
      body: JSON.stringify({ members: memberIds }),
    });
  }

  async upload(
    file: File,
    purpose: 'content' | 'avatar' | 'attachment' | 'site',
    onProgress?: (percent: number) => void,
  ): Promise<Asset> {
    const upload = await this.request<Upload>('/media/uploads', {
      method: 'POST',
      body: JSON.stringify({
        file_name: file.name,
        mime_type: file.type,
        size: file.size,
        purpose,
      }),
    });
    await this.putBytes(upload.id, file, onProgress);
    return this.request<Asset>(`/media/uploads/${upload.id}/complete`, { method: 'POST' });
  }

  private putBytes(uploadId: string, file: File, onProgress?: (percent: number) => void): Promise<Upload> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${this.root}/media/uploads/${uploadId}/content`);
      xhr.withCredentials = true;
      if (this.token) xhr.setRequestHeader('Authorization', `Bearer ${this.token}`);
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.setRequestHeader('X-Request-ID', uuid());
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onerror = () =>
        reject(
          new ApiError({
            ...fallbackProblem(0),
            code: 'internal',
            message: t('上传过程中断，请重试。'),
          }),
        );
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText) as Upload);
          } catch {
            reject(new ApiError(fallbackProblem(xhr.status)));
          }
        } else {
          let problem = fallbackProblem(xhr.status);
          try {
            const body = JSON.parse(xhr.responseText) as ProblemBody;
            if (body.code) problem = { ...problem, ...body };
          } catch {
            /* ignore */
          }
          reject(new ApiError(problem));
        }
      };
      const form = new FormData();
      form.append('file', file);
      xhr.send(form);
    });
  }

  async listAssets(): Promise<Asset[]> {
    // 媒体列表按上传时间倒序、游标分页；管理页一次取 100 条，不做无限滚动。
    // `url` 是契约给的相对地址，页面直接当作展示地址，不在这里拼绝对地址。
    const page = await this.request<{ items: Asset[]; next_cursor: string; has_more: boolean }>(
      '/media?limit=100',
    );
    return page.items;
  }

  /**
   * 删除一份媒体（Beta 1.2）。
   *
   * 服务端会先清掉所有尺寸变体再删原对象；素材仍被内容引用时请求会被拒绝，
   * 错误按常规 ApiError 抛给页面展示，调用方不要吞掉。
   */
  async deleteAsset(id: string): Promise<void> {
    await this.request<void>(`/media/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  /**
   * 取一份能直接放进 `<img src>` 的媒体地址。
   *
   * 媒体读取端点对 content 素材要求登录，而 `<img>` 不会带 Authorization，匿名
   * 请求只会拿到 404。这里用带令牌的 fetch 取字节，换成 blob: 地址交给图片元素；
   * data:/blob:/外链原样返回（浏览器自己就能显示）。任何失败也回退原地址，让
   * 调用方决定是显示占位还是留空，预览失败不该冒泡成页面错误。
   */
  async assetSrc(url: string): Promise<string> {
    const raw = (url ?? '').trim();
    if (!raw || !isMediaApiUrl(raw)) return raw;
    const target = this.assetRequestUrl(raw);
    if (!target) return raw;
    try {
      const headers = new Headers();
      if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
      const res = await fetch(target, { headers, credentials: 'include' });
      if (!res.ok) return raw;
      const blob = await res.blob();
      // 测试环境或极老的浏览器可能没有 createObjectURL：退回原地址，由 <img> 自己试。
      if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return raw;
      return URL.createObjectURL(blob);
    } catch {
      return raw;
    }
  }

  /**
   * 把媒体展示地址补成可请求的绝对地址。
   *
   * `api_base` 可能为空（同源相对）或只到源站；列表返回的 `url` 是
   * `/api/v1/media/{id}`，这里只拼 origin，不能再补一次 `/api/v1`。
   * 指向别的站点的绝对地址返回 null：本站令牌不该发给外链。
   */
  private assetRequestUrl(raw: string): string | null {
    if (raw.startsWith('/') && !raw.startsWith('//')) return `${this.origin}${raw}`;
    if (!/^https?:\/\//i.test(raw)) return null;
    const own =
      this.origin || (typeof window !== 'undefined' ? window.location.origin : '');
    if (!own) return null;
    return raw.startsWith(`${own}/`) ? raw : null;
  }

  async conversations(): Promise<Conversation[]> {
    const res = await this.request<{ items: Conversation[] }>('/conversations');
    return res.items;
  }

  async messages(conversationId: string, limit = 100): Promise<Message[]> {
    const res = await this.request<{ items: Message[] }>(
      `/conversations/${conversationId}/messages?limit=${limit}`,
    );
    return res.items;
  }

  async sendMessage(conversationId: string, body: string): Promise<Message> {
    return this.request<Message>(`/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: { 'Idempotency-Key': uuid() },
      body: JSON.stringify({ body }),
    });
  }

  async markConversationRead(
    conversationId: string,
    messageId: string,
  ): Promise<{ advanced: boolean }> {
    return this.request<{ advanced: boolean }>(`/conversations/${conversationId}/read`, {
      method: 'POST',
      body: JSON.stringify({ message_id: messageId }),
    });
  }

  async notifications(): Promise<{ items: Notification[]; unread: number }> {
    return this.request<{ items: Notification[]; unread: number }>('/notifications?limit=50');
  }

  async markNotificationRead(id: string): Promise<Notification> {
    return this.request<Notification>(`/notifications/${id}/read`, { method: 'POST' });
  }

  async markAllNotificationsRead(): Promise<number> {
    const res = await this.request<{ updated: number }>('/notifications/read-all', {
      method: 'POST',
    });
    return res.updated ?? 0;
  }

  async notificationPreferences(): Promise<NotificationPreferences> {
    return this.request<NotificationPreferences>('/notifications/preferences');
  }

  async updateNotificationPreferences(
    input: NotificationPreferences,
  ): Promise<NotificationPreferences> {
    return this.request<NotificationPreferences>('/notifications/preferences', {
      method: 'PUT',
      body: JSON.stringify(input),
    });
  }

  /* ------------------------- 邮件订阅与 Newsletter（Beta 1.2，契约 N 节） ------------------------- */

  /**
   * 公开订阅（`POST /newsletter/subscribe`，契约 N1）。
   *
   * 双确认：新订阅返回 `pending` 并发确认信；已确认返回 `confirmed`；已退订时重发
   * 确认信。同 IP 每小时 10 次，超限 429。
   */
  async subscribeNewsletter(input: {
    email: string;
    source?: string;
  }): Promise<{ status: NewsletterSubscriptionStatus }> {
    return this.request<{ status: NewsletterSubscriptionStatus }>('/newsletter/subscribe', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  /** 兑换订阅确认链接（`GET /newsletter/confirm?token=`，公开）；无效令牌 404。 */
  async confirmNewsletter(token: string): Promise<{ status: NewsletterSubscriptionStatus }> {
    return this.performRequest<{ status: NewsletterSubscriptionStatus }>(
      `/newsletter/confirm?token=${encodeURIComponent(token)}`,
    );
  }

  /** 兑换退订链接（`GET /newsletter/unsubscribe?token=`，公开）；无效令牌 404。 */
  async unsubscribeNewsletter(
    token: string,
  ): Promise<{ status: NewsletterSubscriptionStatus }> {
    return this.performRequest<{ status: NewsletterSubscriptionStatus }>(
      `/newsletter/unsubscribe?token=${encodeURIComponent(token)}`,
    );
  }

  /** 当前登录账户自己的订阅状态（`GET /me/newsletter`，契约 N2）。 */
  async myNewsletter(): Promise<MyNewsletterPreference> {
    return this.performRequest<MyNewsletterPreference>('/me/newsletter');
  }

  /** 订阅 / 退订当前账户邮箱（`PUT /me/newsletter`，服务端记 `source=account`）。 */
  async setMyNewsletter(enabled: boolean): Promise<MyNewsletterPreference> {
    return this.request<MyNewsletterPreference>('/me/newsletter', {
      method: 'PUT',
      body: JSON.stringify({ enabled }),
    });
  }

  /**
   * 管理端订阅名单（`GET /sites/{siteID}/subscribers`，`manage_site`）。
   *
   * 游标分页形状与其它列表一致；`status` 与 `q` 都是可选筛选。
   */
  async listSubscribers(
    siteId: string,
    query: { status?: string; q?: string; limit?: number; cursor?: string } = {},
  ): Promise<Page<Subscriber>> {
    const params = new URLSearchParams();
    params.set('limit', String(query.limit ?? 50));
    if (query.status) params.set('status', query.status);
    if (query.q) params.set('q', query.q);
    if (query.cursor) params.set('cursor', query.cursor);
    return this.request<Page<Subscriber>>(
      `/sites/${siteId}/subscribers?${params.toString()}`,
    );
  }

  /** 删除一个订阅者（`DELETE /sites/{siteID}/subscribers/{subscriberID}`，204）。 */
  async deleteSubscriber(siteId: string, subscriberId: string): Promise<void> {
    await this.request<void>(
      `/sites/${siteId}/subscribers/${encodeURIComponent(subscriberId)}`,
      { method: 'DELETE' },
    );
  }

  /** 订阅名单统计（`GET /sites/{siteID}/newsletter-stats`）。 */
  async newsletterStats(siteId: string): Promise<NewsletterStats> {
    return this.request<NewsletterStats>(`/sites/${siteId}/newsletter-stats`);
  }

  /**
   * 邮件模板列表（`GET /sites/{siteID}/email-templates`，`manage_site`）。
   *
   * 服务端返回内置默认与站长改写后的模板；这里同时兼容 `{items:[...]}` 与裸数组。
   */
  async listEmailTemplates(siteId: string): Promise<EmailTemplate[]> {
    const res = await this.performRequest<
      { items?: EmailTemplate[] } | EmailTemplate[]
    >(`/sites/${siteId}/email-templates`);
    return Array.isArray(res) ? res : res.items ?? [];
  }

  /** 保存一封邮件模板（`PUT /sites/{siteID}/email-templates/{key}`）；返回规范化后的模板。 */
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
    return this.request<EmailTemplate>(
      `/sites/${siteId}/email-templates/${encodeURIComponent(key)}`,
      { method: 'PUT', body: JSON.stringify(input) },
    );
  }

  /** 恢复内置默认模板（`DELETE /sites/{siteID}/email-templates/{key}`，204）。 */
  async resetEmailTemplate(siteId: string, key: string): Promise<void> {
    await this.request<void>(
      `/sites/${siteId}/email-templates/${encodeURIComponent(key)}`,
      { method: 'DELETE' },
    );
  }

  /** 邮件发送日志（`GET /sites/{siteID}/email-logs`）；`status` / `kind` 可选筛选。 */
  async listEmailLogs(
    siteId: string,
    query: { status?: string; kind?: string; limit?: number; cursor?: string } = {},
  ): Promise<Page<EmailLog>> {
    const params = new URLSearchParams();
    params.set('limit', String(query.limit ?? 50));
    if (query.status) params.set('status', query.status);
    if (query.kind) params.set('kind', query.kind);
    if (query.cursor) params.set('cursor', query.cursor);
    return this.request<Page<EmailLog>>(
      `/sites/${siteId}/email-logs?${params.toString()}`,
    );
  }

  /**
   * 发送一次 newsletter（`POST /sites/{siteID}/newsletters`，`manage_site`）。
   *
   * 服务端为每个 `confirmed` 订阅者写一条 `queued` 邮件日志并返回入队数；
   * `content_id` 非空时用该内容渲染正文，`body_html` 作为附加说明。
   */
  async sendNewsletter(
    siteId: string,
    input: {
      subject: string;
      body_html: string;
      body_text: string;
      content_id?: string;
    },
  ): Promise<NewsletterSendResult> {
    return this.request<NewsletterSendResult>(`/sites/${siteId}/newsletters`, {
      method: 'POST',
      headers: { 'Idempotency-Key': uuid() },
      body: JSON.stringify(input),
    });
  }

  async recordVisit(input: {
    path: string;
    title: string;
    referrer: string;
    session: string;
    surface: VisitSurface;
  }): Promise<void> {
    await this.request<void>('/analytics/visits', {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  /**
   * 联系表单：匿名提交一次留言。
   *
   * 服务端答 202（或 429 冷却），没有返回体内容值得读，所以这里不解析。
   */
  async contactSite(siteId: string, input: ContactPayload): Promise<void> {
    await this.request<{ status?: string }>(`/sites/${siteId}/contact`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  /**
   * 站点统计（`GET /sites/{siteID}/analytics`，契约 M 节）。
   *
   * Beta 1.2 起响应多了来源 / 设备 / 引荐 / 留存四个维度；旧后端没有时补空数组，
   * 页面照常渲染既有图表。端点不可用（404 / 503）时返回 null，仪表盘回退到本地统计。
   */
  async analytics(siteId: string, range: AnalyticsRange): Promise<SiteAnalytics | null> {
    const offset = -new Date().getTimezoneOffset();
    try {
      const data = await this.request<BackendAnalytics & Partial<AnalyticsBreakdown>>(
        `/sites/${siteId}/analytics?range=${range}&tz_offset=${offset}`,
      );
      return {
        ...data,
        sources: data.sources ?? [],
        devices: data.devices ?? [],
        top_referrers: data.top_referrers ?? [],
        retention: data.retention ?? [],
      };
    } catch (err) {
      if (err instanceof ApiError && (err.problem.status === 404 || err.problem.status === 503)) {
        return null;
      }
      throw err;
    }
  }

  async taxonomy(siteId: string): Promise<TaxonomySettings | null> {
    try {
      return await this.request<TaxonomySettings>(`/sites/${siteId}/taxonomy`);
    } catch (err) {
      if (err instanceof ApiError && (err.problem.status === 404 || err.problem.status === 503)) {
        return null;
      }
      throw err;
    }
  }

  async createTaxonomyTerm(siteId: string, input: TaxonomyTermInput): Promise<TaxonomyTerm> {
    return this.request<TaxonomyTerm>(`/sites/${siteId}/taxonomy`, {
      method: 'POST',
      body: JSON.stringify(input),
    });
  }

  async updateTaxonomyTerm(
    siteId: string,
    termId: string,
    input: TaxonomyTermInput,
  ): Promise<TaxonomyTerm> {
    return this.request<TaxonomyTerm>(`/sites/${siteId}/taxonomy/${termId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    });
  }

  async deleteTaxonomyTerm(siteId: string, termId: string): Promise<void> {
    await this.request<void>(`/sites/${siteId}/taxonomy/${termId}`, { method: 'DELETE' });
  }

  /**
   * 管理员触发一次整站备份。
   *
   * 备份包含数据库全量、媒体与站点设计，因此服务端只允许平台管理员调用；
   * 站点管理员会在 403 里拿到普通的 permission_denied。
   */
  async createBackup(): Promise<BackupArtifact> {
    return this.request<BackupArtifact>('/platform/backups', { method: 'POST' });
  }

  async backups(): Promise<BackupArtifact[]> {
    const result = await this.request<{ items: BackupArtifact[] }>('/platform/backups');
    return result.items ?? [];
  }

  async downloadBackup(id: string): Promise<{ blob: Blob; filename: string }> {
    return this.download(`/platform/backups/${encodeURIComponent(id)}/download`);
  }

  /** 全站导出：默认包含草稿，publishedOnly 为真时只导出已发布内容。 */
  async exportSite(
    siteId: string,
    options: { publishedOnly?: boolean } = {},
  ): Promise<{ blob: Blob; filename: string }> {
    const suffix = options.publishedOnly ? '?published_only=true' : '';
    return this.download(`/sites/${encodeURIComponent(siteId)}/export${suffix}`);
  }

  /** 从导出包导入；每个条目独立落库并逐条报告。 */
  async importSite(
    siteId: string,
    file: File,
    options: { conflict?: ImportConflictStrategy } = {},
  ): Promise<SiteImportReport> {
    const body = new FormData();
    body.append('file', file, file.name);
    body.append('conflict', options.conflict ?? 'rename');
    return this.request<SiteImportReport>(`/sites/${encodeURIComponent(siteId)}/import`, {
      method: 'POST',
      body,
    });
  }

  /**
   * 下载一个二进制响应。
   *
   * 不能复用 request()：它固定按 JSON 解析，导出包是 zip。鉴权、401 刷新和
   * problem+json 错误仍与 JSON 请求保持一致，否则大文件下载会退化成另一套登录态。
   */
  private async download(path: string): Promise<{ blob: Blob; filename: string }> {
    const perform = async (retry: boolean): Promise<Response> => {
      const headers = new Headers();
      headers.set('Accept', 'application/zip, application/octet-stream, application/json');
      headers.set('X-Request-ID', uuid());
      /** 与 performRequest 一样：回来时要判断这个 401 属于哪一代会话。 */
      const epoch = this.sessionEpoch;
      if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
      let response: Response;
      try {
        response = await fetch(`${this.root}${path}`, { headers, credentials: 'include' });
      } catch {
        throw new ApiError({
          ...fallbackProblem(0),
          code: 'internal',
          title: t('无法连接 API'),
          message: t('无法连接 {origin}，请确认服务已启动。', {
            origin: this.origin || window.location.origin,
          }),
        });
      }
      if (response.status === 401 && retry && this.token) {
        if (epoch !== this.sessionEpoch) return perform(false);
        try {
          await this.refresh();
        } catch (refreshError) {
          // 与 performRequest 同一套判据：只有 401 才算会话结束。
          if (isSessionGoneError(refreshError)) {
            this.clearSession();
            this.onExpired();
            throw new ApiError(await problemFromResponse(response));
          }
          throw refreshError;
        }
        return perform(false);
      }
      if (!response.ok) {
        const problem = await problemFromResponse(response);
        if (response.status === 401 && epoch === this.sessionEpoch) {
          this.clearSession();
          this.onExpired();
        }
        throw new ApiError(problem);
      }
      return response;
    };
    const response = await perform(true);
    const blob = await response.blob();
    return { blob, filename: filenameFromDisposition(response.headers.get('Content-Disposition')) };
  }

  docsUrl(): string {
    return `${this.origin || window.location.origin}/api/v1/docs`;
  }

  async events(afterId = '', limit = 100): Promise<import('../types').Page<import('../types').AppEvent>> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (afterId) params.set('after_id', afterId);
    return this.request(`/events?${params.toString()}`);
  }

  async wsTicket(): Promise<{ ticket: string; expires_at: string; url: string }> {
    return this.request('/auth/ws-ticket', { method: 'POST' });
  }
}
