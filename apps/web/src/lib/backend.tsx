import {
  createContext,
  useContext,
  type ReactNode,
} from 'react';
import type {
  Asset,
  AuthProviderId,
  BackendMode,
  CommentModerationAction,
  CommentPage,
  CommentQuery,
  CommentsResult,
  Content,
  ContentAction,
  ContentKind,
  ContentPage,
  Conversation,
  DraftInput,
  Me,
  Member,
  Message,
  NewMemberInput,
  Notification,
  PasswordResetPolicy,
  PasswordResetTicket,
  ProbeResult,
  PublicProfile,
  Role,
  Session,
  Site,
  TaxonomySettings,
  TaxonomyTerm,
  TaxonomyTermInput,
  ToggleResult,
  WebConfig,
} from '../types';
import type { AnalyticsRange, BackendAnalytics, VisitSurface } from './analytics';
import { accessController, AccessBlockedError, isPreviewFrame, readAccess } from './access';
import { HttpBackend } from './api';
import type { SiteCustomizationSaved, SiteCustomizationSnapshot } from './api';
import { DemoBackend } from './demo';
import { configurePerformance, readPerformance } from './performance';

export const CONFIG_KEY = 'pp.web.config.v1';

export interface Backend {
  mode: BackendMode;
  origin: string;
  probe(): Promise<ProbeResult>;
  register(input: { email: string; password: string; display_name: string }): Promise<Session>;
  login(input: { email: string; password: string }): Promise<Session>;
  /** 服务端是否已配置 SMTP：决定登录页是否提供找回密码。 */
  passwordResetPolicy(): Promise<PasswordResetPolicy>;
  /** 请求重置链接。无论邮箱是否存在，返回都一样。 */
  requestPasswordReset(email: string): Promise<PasswordResetTicket>;
  /** 用链接里的令牌设置新密码。 */
  resetPassword(input: { token: string; password: string }): Promise<void>;
  /** 仅演示后端：模拟手机 / 第三方登录，以站点管理员身份进入。 */
  demoProviderLogin?(provider: AuthProviderId): Promise<Session>;
  refresh(): Promise<Session>;
  logout(): Promise<void>;
  me(): Promise<Me>;
  site(siteId: string): Promise<Site>;
  updateSite(
    siteId: string,
    patch: Partial<{
      name: string;
      description: string;
      visibility_mode: Site['visibility_mode'];
      publish_mode: Site['publish_mode'];
      domain: string;
    }>,
  ): Promise<void>;
  /** 设置主域名；空字符串表示清除域名。 */
  setSiteDomain(siteId: string, domain: string): Promise<void>;
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
  members(siteId: string): Promise<Member[]>;
  /** 创建账户。个人博客下 role 固定为 site_admin。 */
  createMember(siteId: string, input: NewMemberInput): Promise<Member>;
  setMemberRole(siteId: string, userId: string, role: Role): Promise<void>;
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
    options?: { limit?: number; cursor?: string; authorId?: string },
  ): Promise<ContentPage>;
  getContent(kind: ContentKind, id: string): Promise<Content>;
  createDraft(kind: ContentKind, input: DraftInput): Promise<Content>;
  updateDraft(kind: ContentKind, id: string, input: DraftInput): Promise<Content>;
  contentAction(
    kind: ContentKind,
    id: string,
    action: ContentAction,
    reason?: string,
  ): Promise<Content>;
  search(q: string, kind?: ContentKind, limit?: number): Promise<ContentPage>;
  comments(targetType: string, targetId: string): Promise<CommentsResult>;
  /** 后台评论列表：状态筛选、搜索与分页。 */
  allComments(query?: CommentQuery): Promise<CommentPage>;
  /** 审核动作：通过 / 隐藏 / 删除。 */
  moderateComment(id: string, action: CommentModerationAction): Promise<void>;
  createComment(
    input: {
      target_type: 'article' | 'post' | 'comment' | 'page';
      target_id: string;
      parent_id?: string;
      body: string;
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
  upload(
    file: File,
    purpose: 'content' | 'avatar' | 'attachment' | 'site',
    onProgress?: (percent: number) => void,
  ): Promise<Asset>;
  listAssets(): Promise<Asset[]>;
  conversations(): Promise<Conversation[]>;
  messages(conversationId: string, limit?: number): Promise<Message[]>;
  sendMessage(conversationId: string, body: string): Promise<Message>;
  markConversationRead(conversationId: string, messageId: string): Promise<{ advanced: boolean }>;
  notifications(): Promise<{ items: Notification[]; unread: number }>;
  markNotificationRead(id: string): Promise<Notification>;
  markAllNotificationsRead(): Promise<number>;
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

interface SetupStatus {
  installed?: boolean;
  has_admin?: boolean;
  reason?: string;
  site_id?: string;
  site_name?: string;
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

  const base = config.api_base.replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/api/v1/setup/status`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      credentials: 'include',
      signal:
        typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(3000)
          : undefined,
    });
    if (!res.ok) return 'unknown';
    const status = (await res.json()) as SetupStatus;

    // 站点在，只是这个域名没通过验证：重装解决不了，也不能清配置。
    if (status.reason === 'domain_unverified') return 'ok';
    if (status.installed === false) return 'stale';
    if (typeof status.site_id === 'string' && status.site_id !== config.site_id) return 'stale';
    // has_admin 只作为排查信息：服务端部署的首个账户本来就是普通成员，
    // 用它触发重置会让向导反复重来。安装引导在注册步骤另有角色校验。
    return 'ok';
  } catch {
    return 'unknown';
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
    config.mode === 'demo' ? new DemoBackend() : new HttpBackend({ base: config.api_base, onExpired });
  return withAccessGuard(backend);
}

export function isDemo(backend: Backend): backend is DemoBackend {
  return backend instanceof DemoBackend;
}

const BackendContext = createContext<Backend | null>(null);

export function BackendProvider({ backend, children }: { backend: Backend; children: ReactNode }) {
  return <BackendContext.Provider value={backend}>{children}</BackendContext.Provider>;
}

export function useBackend(): Backend {
  const value = useContext(BackendContext);
  if (!value) throw new Error('useBackend 必须在 BackendProvider 内使用');
  return value;
}
