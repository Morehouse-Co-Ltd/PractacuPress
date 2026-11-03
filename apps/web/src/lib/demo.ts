import type {
  ActivityEntry,
  Asset,
  AuthProviderId,
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
} from '../types';
import type { AnalyticsRange, BackendAnalytics, VisitSurface } from './analytics';
import { ApiError, fallbackProblem, uuid } from './api';
import type { SiteCustomizationSaved, SiteCustomizationSnapshot } from './api';
import type { ContactPayload } from './contactForm';
import { canReview, ROLE_RANK, slugify } from './format';
import { renderSource } from './markdown';
import {
  applyDemoTaxonomy,
  createSeed,
  roleOf,
  toMember,
  toPublicUser,
  type DemoComment,
  type DemoState,
  type DemoUser,
} from './demoSeed';

const STATE_KEY = 'pp.demo.state.v1';
const CURRENT_KEY = 'pp.demo.current.v1';
const RESET_KEY = 'pp.demo.reset.v1';
const RESET_TTL_MS = 30 * 60 * 1000;

/** 演示模式的重置票据：令牌 -> 账户与过期时间。真实环境由服务端存储哈希。 */
type DemoTicket = Record<string, { user_id: string; expires_at: number }>;

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
  };
}

/** 本地演示后端：语义与 OpenAPI 契约一致，数据保存在浏览器。 */
export class DemoBackend {
  readonly mode = 'demo' as const;
  readonly origin = 'demo://local';
  private state: DemoState;
  private currentId: string | null;
  /** 个人博客下所有账户都按最高权限处理，与服务端侧的提权结果保持一致。 */
  private siteKind: 'community' | 'personal' = 'community';
  private tickets: DemoTicket;

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
      /* 演示票据写不进去只影响刷新后的演示流程 */
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

  /** 站点形态变化时由 App 同步；只影响演示模式的角色判断。 */
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
      case 'published':
        return reviewer ? ['archive'] : [];
      case 'pending_security_check':
        return owner || reviewer ? ['security-retry'] : [];
      default:
        return [];
    }
  }

  private decorate(content: Content, viewer = this.optionalUser()): Content {
    return { ...content, actions: this.actionsFor(content, viewer) };
  }

  private tags(content: Content) {
    return content.kind === 'article' ? '文章' : '帖子';
  }

  private findContent(kind: ContentKind, id: string) {
    const found = this.state.contents.find((c) => c.kind === kind && c.id === id);
    if (!found) this.fail(404, 'not_found', '内容不存在，或不在当前站点内。');
    return found;
  }

  private canSee(content: Content, viewer: DemoUser | null): boolean {
    if (content.status === 'published') {
      return this.state.site.visibility_mode === 'public' || !!viewer;
    }
    if (!viewer) return false;
    return content.author_id === viewer.id || canReview(viewer.role);
  }

  async probe(): Promise<ProbeResult> {
    return { health: 'ok', ready: 'ready', openapi: true, detail: '浏览器本地存储' };
  }

  async register(input: { email: string; password: string; display_name: string }): Promise<Session> {
    await wait();
    const email = input.email.trim().toLowerCase();
    if (this.state.users.some((u) => u.email.toLowerCase() === email)) {
      this.fail(409, 'conflict', '该邮箱已经注册。');
    }
    if (input.password.length < 8) this.fail(400, 'validation_failed', '密码至少 8 位。');
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

  async login(input: { email: string; password: string }): Promise<Session> {
    await wait();
    const email = input.email.trim().toLowerCase();
    const user = this.state.users.find((u) => u.email.toLowerCase() === email);
    if (!user || user.password !== input.password) {
      this.fail(401, 'unauthenticated', '邮箱或密码不正确。');
    }
    if (user.status === 'disabled') {
      this.fail(403, 'permission_denied', '该账户已被停用，请联系站点管理员。');
    }
    this.currentId = user.id;
    this.saveCurrent();
    return this.session(user);
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
    this.log('模拟第三方登录', owner.display_name, provider);
    return this.session(owner);
  }

  async refresh(): Promise<Session> {
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

  async resetPassword(input: { token: string; password: string }): Promise<void> {
    await wait(220);
    if (input.password.length < 8) this.fail(400, 'validation_failed', '密码至少 8 位。');
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

  async site(siteId: string): Promise<Site> {
    await wait(60);
    if (siteId !== this.state.site.id) this.fail(404, 'site_not_found', '站点不存在。');
    return { ...this.state.site };
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
    if (patch.domain !== undefined) this.state.site.domain = patch.domain.trim();
    this.log('修改站点设置', this.state.site.name);
    this.persist();
  }

  async setSiteDomain(siteId: string, domain: string): Promise<void> {
    await this.updateSite(siteId, { domain: domain.trim().toLowerCase() });
  }

  async members(): Promise<Member[]> {
    await wait();
    this.requireRole('site_admin');
    return this.state.users.map(toMember);
  }

  async createMember(_siteId: string, input: NewMemberInput): Promise<Member> {
    await wait(240);
    const actor = this.requireRole('site_admin');
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      this.fail(400, 'validation_failed', '请填写有效的邮箱地址。');
    }
    if (!input.display_name.trim()) this.fail(400, 'validation_failed', '请填写显示名称。');
    if (input.password.length < 8) this.fail(400, 'validation_failed', '密码至少 8 位。');
    if (this.state.users.some((u) => u.email.toLowerCase() === email)) {
      this.fail(409, 'conflict', '该邮箱已经注册。');
    }
    const role: Role = input.role ?? 'member';
    if (role === 'platform_admin' && actor.role !== 'platform_admin') {
      this.fail(403, 'permission_denied', '只有平台管理员可以创建平台管理员账户。');
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
    const actor = this.requireRole('site_admin');
    const target = this.state.users.find((u) => u.id === userId);
    if (!target) this.fail(404, 'not_found', '成员不存在。');
    if ((role === 'platform_admin' || target.role === 'platform_admin') && actor.role !== 'platform_admin') {
      this.fail(403, 'permission_denied', '只有平台管理员可以授予或撤销平台管理员角色。');
    }
    if (target.role === 'platform_admin' && role !== 'platform_admin') {
      const admins = this.state.users.filter((u) => u.role === 'platform_admin');
      if (admins.length <= 1) {
        this.fail(403, 'permission_denied', '不能撤销最后一个平台管理员。');
      }
    }
    target.role = role;
    this.log('调整成员角色', target.display_name, role);
    this.persist();
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

  /** 只能操作等级更低的成员：不能操作自己，也不能操作其他平台管理员。 */
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
    options: { limit?: number; cursor?: string; authorId?: string } = {},
  ): Promise<ContentPage> {
    await wait(160);
    const viewer = this.optionalUser();
    if (this.state.site.visibility_mode === 'members_only' && !viewer) {
      this.fail(401, 'unauthenticated', '该站点仅对成员开放，请先登录。');
    }
    const limit = Math.min(100, Math.max(1, options.limit ?? 20));
    const offset = options.cursor ? Number(options.cursor.replace(/^o:/, '')) : 0;
    const all = this.state.contents
      .filter((c) => c.kind === kind)
      .filter((c) => !options.authorId || c.author_id === options.authorId)
      .filter((c) => this.canSee(c, viewer))
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

  async getContent(kind: ContentKind, id: string): Promise<Content> {
    await wait(120);
    const viewer = this.optionalUser();
    const content = this.findContent(kind, id);
    if (!this.canSee(content, viewer)) {
      this.fail(content.status === 'published' ? 401 : 404, content.status === 'published' ? 'unauthenticated' : 'not_found', '内容不可见。');
    }
    return this.decorate(content, viewer);
  }

  async createDraft(kind: ContentKind, input: DraftInput): Promise<Content> {
    await wait(220);
    const user = this.user();
    if (!input.title.trim()) this.fail(400, 'validation_failed', '标题不能为空。');
    if (input.title.length > 200) this.fail(400, 'validation_failed', '标题不能超过 200 个字符。');
    if (!input.source_body.trim()) this.fail(400, 'validation_failed', '正文不能为空。');
    if (input.source_body.length > 200_000) this.fail(400, 'validation_failed', '正文不能超过 200000 个字符。');
    if (input.slug && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(input.slug)) {
      this.fail(400, 'validation_failed', '路径只能使用小写字母、数字和连字符。');
    }
    const now = new Date().toISOString();
    const content: Content & { source_body: string; author_id: string; author_name: string } = {
      id: `${kind === 'article' ? 'cnt' : 'pst'}_${uuid().slice(0, 8)}`,
      kind,
      status: 'draft',
      title: input.title.trim(),
      slug: input.slug || slugify(input.title) || `draft-${uuid().slice(0, 6)}`,
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
    };
    this.state.contents.unshift(content);
    this.log('创建草稿', content.title, this.tags(content));
    this.persist();
    return this.decorate(content, user);
  }

  async updateDraft(kind: ContentKind, id: string, input: DraftInput): Promise<Content> {
    await wait(200);
    const user = this.user();
    const content = this.findContent(kind, id);
    if (content.author_id !== user.id && !canReview(user.role)) {
      this.fail(403, 'permission_denied', '只能编辑自己的草稿。');
    }
    if (content.status !== 'draft' && content.status !== 'rejected') {
      this.fail(409, 'content_state_invalid', '已发布内容不可直接修改，请走审核流程。');
    }
    if (!input.title.trim()) this.fail(400, 'validation_failed', '标题不能为空。');
    content.title = input.title.trim();
    if (input.slug) content.slug = input.slug;
    content.summary = input.summary?.slice(0, 500);
    content.source_format = input.source_format ?? content.source_format;
    content.source_body = input.source_body;
    content.category_id = input.category_id;
    content.tags = input.tags?.slice(0, 12) ?? [];
    content.rendered_html = renderSource(content.source_format, input.source_body);
    content.updated_at = new Date().toISOString();
    this.log('更新草稿', content.title);
    this.persist();
    return this.decorate(content, user);
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
      this.log('退回', content.title, reason || '未填写理由');
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
    } else if (action === 'security-retry') {
      if (content.status !== 'pending_security_check' || (!owner && !reviewer)) {
        this.fail(409, 'content_state_invalid', '当前状态不能重试安全检查。');
      }
      content.status = 'published';
      content.published_at = content.published_at ?? new Date().toISOString();
      content.updated_at = new Date().toISOString();
      this.log('重试安全检查', content.title, '通过');
    } else {
      this.fail(400, 'validation_failed', '未知的流程动作。');
    }
    this.persist();
    return this.decorate(content, user);
  }

  async search(q: string, kind?: ContentKind, limit = 20): Promise<ContentPage> {
    await wait(160);
    if (q.trim().length < 2) this.fail(400, 'validation_failed', '搜索词至少 2 个字符。');
    const viewer = this.optionalUser();
    if (this.state.site.visibility_mode === 'members_only' && !viewer) {
      this.fail(401, 'unauthenticated', '该站点仅对成员开放，请先登录。');
    }
    const term = q.trim().toLowerCase();
    const items = this.state.contents
      .filter((c) => c.status === 'published')
      .filter((c) => !kind || c.kind === kind)
      .filter((c) => `${c.title} ${c.summary ?? ''}`.toLowerCase().includes(term))
      .sort((a, b) => (b.published_at ?? '').localeCompare(a.published_at ?? ''))
      .slice(0, limit)
      .map((c) => this.decorate(c, viewer));
    return { items, next_cursor: '', has_more: false };
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
          : `新会话 · ${others.length + 1} 人`,
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
    // 演示数据没有服务端；访问记录由 lib/analytics 的本地存储负责。
  }

  async analytics(_siteId: string, _range: AnalyticsRange): Promise<BackendAnalytics | null> {
    return null;
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
    // 演示模式的设计只写 localStorage：回显输入，不产生任何远端状态。
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

  docsUrl(): string {
    return '#';
  }
}
