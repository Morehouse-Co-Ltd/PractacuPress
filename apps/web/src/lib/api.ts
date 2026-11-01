import type {
  Asset,
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
  ProblemBody,
  PublicProfile,
  Role,
  Session,
  Site,
  TaxonomySettings,
  TaxonomyTerm,
  TaxonomyTermInput,
  ToggleResult,
  Upload,
} from '../types';
import type { AnalyticsRange, BackendAnalytics, VisitSurface } from './analytics';
import { t } from './i18n';
import { currentPerformance } from './performance';
import { RequestCache } from './requestCache';

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

export function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function readCookie(name: string): string {
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

export function docsUrlOf(base: string): string {
  const origin = normalizeOrigin(base) || window.location.origin;
  return `${origin}/api/v1/docs`;
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
    this.requestCache.clear();
  }

  clearSession() {
    this.token = null;
    this.csrf = null;
    this.requestCache.clear();
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
    if (this.token) headers.set('Authorization', `Bearer ${this.token}`);
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
      try {
        await this.refresh();
      } catch {
        this.clearSession();
        this.onExpired();
        throw new ApiError(await problemFromResponse(res));
      }
      return this.performRequest<T>(path, init, false);
    }

    if (!res.ok) {
      const problem = await problemFromResponse(res);
      if (res.status === 401) {
        this.clearSession();
        this.onExpired();
      }
      throw new ApiError(problem);
    }

    // 写入之后不能再读旧缓存；读取请求本身不需要清空。
    if (method !== 'GET') this.requestCache.clear();
    if (res.status === 204) return undefined as T;
    if (res.status === 202) return (await res.json()) as T;
    return (await res.json()) as T;
  }

  async probe(): Promise<ProbeResult> {
    // 不能只看 HTTP 200：SPA 的 fallback 对所有路径都返回 index.html，
    // 必须校验 JSON 形状，否则“没有后端”会被误判为健康。
    const readJson = async (res: Response): Promise<Record<string, unknown> | null> => {
      try {
        return (await res.json()) as Record<string, unknown>;
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
        call(`${this.origin}/healthz`),
        call(`${this.origin}/readyz`),
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

  async register(input: { email: string; password: string; display_name: string }): Promise<Session> {
    const session = await this.request<Session>('/auth/register/email', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    this.applySession(session);
    return session;
  }

  async login(input: { email: string; password: string }): Promise<Session> {
    const session = await this.request<Session>('/auth/login/password', {
      method: 'POST',
      body: JSON.stringify(input),
    });
    this.applySession(session);
    return session;
  }

  async refresh(): Promise<Session> {
    if (!this.refreshPromise) {
      this.refreshPromise = (async () => {
        const csrf = this.csrf || readCookie('pp_csrf');
        const res = await fetch(`${this.root}/auth/token/refresh`, {
          method: 'POST',
          credentials: 'include',
          headers: {
            Accept: 'application/json',
            'X-CSRF-Token': csrf,
            'X-Request-ID': uuid(),
          },
        });
        if (!res.ok) throw new ApiError(await problemFromResponse(res));
        const session = (await res.json()) as Session;
        this.applySession(session);
        return session;
      })().finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  async logout(): Promise<void> {
    try {
      await this.request<void>('/auth/logout', { method: 'POST' });
    } catch {
      /* 登出失败不阻塞本地清理 */
    } finally {
      this.clearSession();
    }
  }

  async me(): Promise<Me> {
    return this.request<Me>('/me');
  }

  async passwordResetPolicy(): Promise<PasswordResetPolicy> {
    return this.request<PasswordResetPolicy>('/auth/password-reset/policy');
  }

  async requestPasswordReset(email: string): Promise<PasswordResetTicket> {
    return this.request<PasswordResetTicket>('/auth/password-reset/request', {
      method: 'POST',
      body: JSON.stringify({ email }),
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
    }>,
  ): Promise<void> {
    await this.request<void>(`/sites/${siteId}/settings`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }

  /** 设置主域名；空字符串表示清除（生产环境将回退到只允许公网 IP）。 */
  async setSiteDomain(siteId: string, domain: string): Promise<void> {
    await this.request<void>(`/sites/${siteId}/domain`, {
      method: 'PUT',
      body: JSON.stringify({ domain }),
    });
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

  async members(siteId: string): Promise<Member[]> {
    const res = await this.request<{ items: Member[] }>(`/sites/${siteId}/members`);
    return res.items;
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
    options: { limit?: number; cursor?: string; authorId?: string } = {},
  ): Promise<ContentPage> {
    const params = new URLSearchParams();
    params.set('limit', String(options.limit ?? 20));
    if (options.cursor) params.set('cursor', options.cursor);
    if (options.authorId) params.set('author_id', options.authorId);
    return this.request<ContentPage>(`/${kind}s?${params.toString()}`);
  }

  async getContent(kind: ContentKind, id: string): Promise<Content> {
    return this.request<Content>(`/${kind}s/${id}`);
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

  async search(q: string, kind?: ContentKind, limit = 20): Promise<ContentPage> {
    const params = new URLSearchParams({ q, limit: String(limit) });
    if (kind) params.set('kind', kind);
    return this.request<ContentPage>(`/search?${params.toString()}`);
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
    await this.request<import('../types').Comment>(`/comments/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status: action === 'approve' ? 'visible' : 'hidden' }),
    });
  }

  async createComment(
    input: {
      target_type: 'article' | 'post' | 'comment' | 'page';
      target_id: string;
      parent_id?: string;
      body: string;
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

  async stateFor(): Promise<{ liked: boolean; bookmarked: boolean; following: boolean }> {
    // 契约只提供切换结果，不提供批量查询；刷新后回到未选中态。
    return { liked: false, bookmarked: false, following: false };
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

  async analytics(siteId: string, range: AnalyticsRange): Promise<BackendAnalytics | null> {
    const offset = -new Date().getTimezoneOffset();
    try {
      return await this.request<BackendAnalytics>(
        `/sites/${siteId}/analytics?range=${range}&tz_offset=${offset}`,
      );
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
