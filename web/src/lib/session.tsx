import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  AuthProviderId,
  Me,
  PasswordLoginResult,
  PermissionGroupConfig,
  Session,
  Site,
  SessionState,
  WebConfig,
} from '../types';
import { isDemo, type Backend } from './backend';
import { providerStartsOAuth } from './authProviders';
import { useT } from './i18n';
import { REALTIME_FALLBACK_POLL_MS, readRealtimeStatus } from './realtimeCore';
import { broadcastSessionSignal, subscribeSessionSignals } from './sessionSync';

interface AuthValue extends SessionState {
  config: WebConfig;
  /** 更新本地安装配置（站点形态等），会写回 localStorage。 */
  updateConfig(patch: Partial<WebConfig>): void;
  /**
   * 密码登录。`captchaToken` 来自登录表单的人机验证组件；站点未启用时留空。
   */
  login(email: string, password: string, captchaToken?: string): Promise<PasswordLoginResult>;
  /** 兑换 2FA 挑战；成功后与密码登录一样建立会话。 */
  verifyTwoFactor(challengeToken: string, code: string): Promise<Session>;
  /**
   * 演示模式下的手机 / 第三方登录模拟。
   *
   * 真实后端没有这个端点（第三方登录由 `oauthStart` 整页跳转完成），调用会抛错。
   */
  providerLogin(provider: AuthProviderId): Promise<void>;
  /**
   * 第三方登录：整页跳到后端的 `/api/v1/auth/oauth/{provider}/start`。
   *
   * `redirect` 只接受站内相对路径（以 `/` 开头且不以 `//` 开头），与登录页 `next`
   * 同一套规则；不合法或省略时后端落到站点首页。登录成功后的回跳由后端 `landingURL`
   * 负责，前端不再跳一次。演示模式不会跳转，仍然走 `providerLogin`。
   */
  oauthStart(provider: AuthProviderId, redirect?: string): void;
  register(input: {
    email: string;
    password: string;
    display_name: string;
    captcha_token?: string;
    /** 用户已确认使用弱密码。 */
    confirm_weak_password?: boolean;
  }): Promise<void>;
  logout(): Promise<void>;
  reload(): Promise<void>;
  applySite(site: Site): void;
  unread: number;
  refreshUnread(): Promise<void>;
  /**
   * 服务端能力组。null 表示当前后端没有组端点（演示模式或旧后端），界面回退到
   * 本地 customization.permission_groups。
   */
  permissionGroups: PermissionGroupConfig[] | null;
  /** 保存能力组之后重新拉取，让导航与下拉立即使用新名称。 */
  refreshPermissionGroups(): Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

/**
 * 匿名访客的站点标识来自启动探测（`config.visitor_site_name`）。
 *
 * 真实的 Site 对象要登录之后才拿得到，但页头品牌、SEO 站点名与 404 文案在访客视角
 * 也需要真实站点名，否则站点设计加载了、品牌名却还是默认值。
 */
function visitorSiteOf(config: WebConfig): Site | null {
  if (!config.visitor || !config.site_id) return null;
  return {
    id: config.site_id,
    slug: '',
    name: config.visitor_site_name?.trim() || 'Practacu Press',
    domain: '',
    visibility_mode: 'public',
    publish_mode: 'review',
    disabled: false,
    // O-3：访客引导从 setup/status 拿到注册开关；缺省表示旧后端，按开放处理。
    ...(typeof config.visitor_registration_open === 'boolean'
      ? { registration_open: config.visitor_registration_open }
      : {}),
  };
}

/**
 * 读取平台控制台投递过来的站点交接令牌。
 *
 * 令牌优先放在 URL 片段里（`#pp_switch=...`）：片段不会随请求或第三方资源的
 * Referer 发出去，比查询参数更适合承载一次性的会话交接凭证。同时兼容查询参数，
 * 方便手工联调。只读取，不在这里删除；兑换成功之后再调用 `stripSwitchParam`，
 * 否则一次失败的兑换会把参数抹掉，刷新时失去重试机会。
 */
function readSwitchToken(): string {
  if (typeof window === 'undefined') return '';
  const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('pp_switch');
  if (fromHash) return fromHash;
  return new URLSearchParams(window.location.search).get('pp_switch') ?? '';
}

/** 兑换成功后从地址栏移除交接令牌，避免刷新时重复使用同一个短期令牌。 */
function stripSwitchParam(): void {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    let changed = false;
    if (url.searchParams.has('pp_switch')) {
      url.searchParams.delete('pp_switch');
      changed = true;
    }
    const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
    if (hash.has('pp_switch')) {
      hash.delete('pp_switch');
      url.hash = hash.toString();
      changed = true;
    }
    if (changed) window.history.replaceState(window.history.state, '', url.toString());
  } catch {
    /* 地址栏不可写不影响已经建立的会话 */
  }
}

/**
 * 只保留站内相对路径。
 *
 * 与登录页 `next` 参数、后端 `sanitizeOAuthRedirect` 同一套规则：必须以 `/` 开头且不能
 * 以 `//` 开头（协议相对地址会把浏览器带到别人的站点）。另外拒绝反斜杠、制表符与换行，
 * 浏览器和代理会把它们规范化成 `/`，`/\evil.com` 这类输入就能绕过前缀检查。不合法的
 * 输入返回空串，调用方直接把 `redirect` 参数省掉，而不是拒绝整次登录。
 */
export function inSitePath(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (!value.startsWith('/') || value.startsWith('//')) return '';
  if (/[\\\t\r\n]/.test(value)) return '';
  return value;
}

export function AuthProvider({
  config,
  backend,
  onConfigChange,
  children,
}: {
  config: WebConfig;
  backend: Backend;
  onConfigChange?: (patch: Partial<WebConfig>) => void;
  children: ReactNode;
}) {
  const t = useT();
  /**
   * 匿名访客的站点标识。
   *
   * 只按它真正读到的几个字段记忆：登录设置这类站点级配置每存一次都会换一个新的
   * `config` 对象，如果这里跟着重建站点对象，下面的水合 effect 就会重跑一遍，
   * 已经登录的页面被打回「正在确认登录状态」，还得再刷一次才能恢复。
   */
  const visitorSite = useMemo(
    () => visitorSiteOf(config),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [config.visitor, config.site_id, config.visitor_site_name, config.visitor_registration_open],
  );
  const [state, setState] = useState<SessionState>({
    status: 'loading',
    session: null,
    me: null,
    site: visitorSite,
  });
  const [unread, setUnread] = useState(0);
  const [permissionGroups, setPermissionGroups] = useState<PermissionGroupConfig[] | null>(null);
  const aliveRef = useRef(true);
  /** 开屏水合用的访客站点：放到 ref 里，避免配置对象变化把整段水合重跑一次。 */
  const visitorSiteRef = useRef(visitorSite);
  useEffect(() => {
    visitorSiteRef.current = visitorSite;
  }, [visitorSite]);
  /** 跨标签页信号处理器要读「当前」会话，不能抓闭包里的旧 state。 */
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  /** 组件是否还挂着：异步收尾时用它决定要不要写状态。 */
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // 交接令牌只在挂载时读取一次：StrictMode 的双次渲染不能把地址参数读丢。
  const switchTokenRef = useRef<string | null>(null);
  if (switchTokenRef.current === null) {
    switchTokenRef.current = readSwitchToken();
  }

  const loadSite = useCallback(
    async (me: Me): Promise<Site | null> => {
      try {
        return await backend.site(me.site_id);
      } catch {
        return null;
      }
    },
    [backend],
  );

  const loadPermissionGroups = useCallback(
    async (me: Me): Promise<PermissionGroupConfig[] | null> => {
      if (!backend.permissionGroups) return null;
      try {
        return await backend.permissionGroups(me.site_id);
      } catch {
        // 组端点失败不应该阻塞登录：本地镜像仍然可以渲染，服务端也照常强制校验。
        return null;
      }
    },
    [backend],
  );

  /**
   * 访客配置升级为站长配置。
   *
   * 全新浏览器打开已装好的站点时，App 会先用 O-1 访客引导构造一份只读配置
   * （`visitor: true`）：不写 localStorage、不水合、不安装设计写回。站长在这台
   * 浏览器上登录之后必须立刻把这面旗翻成 owner，否则：
   * - `applyConfig` 继续跳过 `saveConfig`，配置永远进不了 localStorage；
   * - App 的安装 effect 因为 `current.visitor` 提前返回，设计水合与写回句柄都不会
   *   安装；
   * - 页面编排的预览 iframe 是独立文档，它读不到内存里的配置，只认 localStorage
   *   与 storage 事件，于是「改区块 → 预览不变、刷新丢失、访客也看不到」。
   *
   * 只在当前确实是访客配置时升级，并且一个挂载周期只升级一次；重复调用会多写
   * 一次 localStorage，没有意义。
   */
  const visitorConfigRef = useRef(config.visitor === true);
  visitorConfigRef.current = config.visitor === true;
  const visitorUpgradedRef = useRef(false);
  const upgradeVisitorConfig = useCallback(() => {
    if (visitorUpgradedRef.current || !visitorConfigRef.current) return;
    visitorUpgradedRef.current = true;
    onConfigChange?.({ visitor: false });
  }, [onConfigChange]);

  const hydrate = useCallback(
    async (session: Session): Promise<Me> => {
      const me = await backend.me();
      const [site, groups] = await Promise.all([loadSite(me), loadPermissionGroups(me)]);
      // 登录 / 注册 / 2FA / 第三方登录都走这里：会话一旦建立，访客配置就该转正。
      upgradeVisitorConfig();
      if (aliveRef.current) {
        setPermissionGroups(groups);
        setState({ status: 'ready', session, me, site });
      }
      return me;
    },
    [backend, loadSite, loadPermissionGroups, upgradeVisitorConfig],
  );

  useEffect(() => {
    const onExpired = () => {
      setPermissionGroups(null);
      setState({ status: 'anonymous', session: null, me: null, site: visitorSite });
      setUnread(0);
      // 会话是真的没了：别的标签页不用等它们各自的请求撞上 401 才退出登录界面。
      broadcastSessionSignal('logout');
    };
    window.addEventListener('pp:session-expired', onExpired);
    return () => window.removeEventListener('pp:session-expired', onExpired);
  }, [visitorSite]);

  /**
   * 开屏水合。
   *
   * 依赖里**没有** `visitorSite`：站点对象会在每次保存站点级配置（登录设置、访问
   * 限制、加载动画……）时重建，把它列进依赖会让每次保存都重跑一遍开屏水合——页面
   * 被打回「正在确认登录状态」，运气不好刷新失败还会掉回登录页。这里只按后端实例
   * 与稳定的回调重新水合，访客站点从 ref 读当前值。
   */
  useEffect(() => {
    aliveRef.current = true;
    let cancelled = false;
    const fallbackSite = visitorSiteRef.current;
    setState({ status: 'loading', session: null, me: null, site: fallbackSite });
    (async () => {
      // 平台控制台把管理员交接给目标站点的源：先用短期令牌兑换一次正常会话，再按
      // 常规路径水合。兑换失败不阻塞已有会话，回退到 refresh 即可。
      let session: Session | null = null;
      const switchToken = switchTokenRef.current ?? '';
      if (switchToken) {
        try {
          session = await backend.claimSiteSwitch(switchToken);
          stripSwitchParam();
          switchTokenRef.current = '';
        } catch {
          session = null;
        }
      }
      try {
        if (!session) session = await backend.refresh();
        const me = await backend.me();
        const [site, groups] = await Promise.all([loadSite(me), loadPermissionGroups(me)]);
        // 已有会话的老站长在全新浏览器里也要从访客配置转正（见 upgradeVisitorConfig）。
        upgradeVisitorConfig();
        if (cancelled) return;
        setPermissionGroups(groups);
        setState({ status: 'ready', session, me, site });
      } catch {
        if (cancelled) return;
        setPermissionGroups(null);
        setState({ status: 'anonymous', session: null, me: null, site: fallbackSite });
      }
    })();
    return () => {
      cancelled = true;
      aliveRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backend, loadSite, loadPermissionGroups, onConfigChange, upgradeVisitorConfig]);

  const login = useCallback(
    // `identifier` is an email or a username (display name); the server decides.
    async (identifier: string, password: string, captchaToken?: string): Promise<PasswordLoginResult> => {
      const result = await backend.login(
        captchaToken
          ? { identifier, password, captcha_token: captchaToken }
          : { identifier, password },
      );
      // A 2FA protected account is not signed in yet: the caller shows the second
      // step and only then calls verifyTwoFactor.
      if (result.status === 'session') {
        const me = await hydrate(result.session);
        broadcastSessionSignal('login', me.user.id);
      }
      return result;
    },
    [backend, hydrate],
  );

  const verifyTwoFactor = useCallback(
    async (challengeToken: string, code: string): Promise<Session> => {
      const session = await backend.loginTwoFactor(challengeToken, code);
      const me = await hydrate(session);
      broadcastSessionSignal('login', me.user.id);
      return session;
    },
    [backend, hydrate],
  );

  const providerLogin = useCallback(
    async (provider: AuthProviderId) => {
      if (!backend.demoProviderLogin) {
        throw new Error(t('当前后端还没有实现这种登录方式。'));
      }
      const session = await backend.demoProviderLogin(provider);
      const me = await hydrate(session);
      broadcastSessionSignal('login', me.user.id);
    },
    [backend, hydrate, t],
  );

  /**
   * 第三方登录的唯一入口。
   *
   * 授权页在提供商那边，必须整页跳转：`fetch` 既到不了对方的登录页，回调种下的
   * HttpOnly Cookie 也不是 SPA 能用脚本处理的。所以这里只做两件事——拼出后端地址、
   * 交给浏览器。后端 302 到提供方，回调时换码、种会话 Cookie，再按 `landingURL` 把
   * 浏览器送回 `redirect` 指向的站内页面；回到站内后开屏水合会用刷新 Cookie 接上会话
   * （见上面的 `backend.refresh()`），前端不需要也不应该再跳一次。
   *
   * 演示模式没有 `/start` 端点，跳过去只会 404，因此沿用原来的本地模拟。
   */
  const oauthStart = useCallback(
    (provider: AuthProviderId, redirect?: string) => {
      if (isDemo(backend)) {
        // 演示后端用本地模拟，任何方式都能「登录成功」；失败由登录页自己提示。
        providerLogin(provider).catch(() => undefined);
        return;
      }
      // 后端没有实现的方式不发出去：跳过去只会看到一页 problem+json（404）。
      if (!providerStartsOAuth(provider)) {
        throw new Error(t('当前后端还没有实现这种登录方式。'));
      }
      const target = inSitePath(redirect);
      const query = target ? `?redirect=${encodeURIComponent(target)}` : '';
      window.location.assign(
        `${backend.origin}/api/v1/auth/oauth/${encodeURIComponent(provider)}/start${query}`,
      );
    },
    [backend, providerLogin, t],
  );

  const register = useCallback(
    async (input: {
      email: string;
      password: string;
      display_name: string;
      captcha_token?: string;
    }) => {
      const session = await backend.register(input);
      const me = await hydrate(session);
      broadcastSessionSignal('login', me.user.id);
    },
    [backend, hydrate],
  );

  const logout = useCallback(async () => {
    await backend.logout();
    setPermissionGroups(null);
    setState({ status: 'anonymous', session: null, me: null, site: visitorSite });
    setUnread(0);
    // 其它标签页立刻退出登录界面，不用等下一次请求撞上 401。
    broadcastSessionSignal('logout');
  }, [backend, visitorSite]);

  const refreshPermissionGroups = useCallback(async () => {
    const me = stateRef.current.me;
    if (!me) {
      setPermissionGroups(null);
      return;
    }
    // A failed refresh must not throw the last known matrix away: the optimistic
    // row the permissions page just wrote is still what the server accepted, and
    // dropping the context would make the page snap back to a stale copy.
    const groups = await loadPermissionGroups(me);
    if (groups) setPermissionGroups(groups);
  }, [loadPermissionGroups]);

  const reload = useCallback(async () => {
    if (!state.session) {
      setState({ status: 'anonymous', session: null, me: null, site: visitorSite });
      return;
    }
    await hydrate(state.session);
  }, [hydrate, state.session, visitorSite]);

  const applySite = useCallback((site: Site) => {
    setState((prev) => ({ ...prev, site }));
  }, []);

  /**
   * 跟上其它标签页的登录态。
   *
   * 令牌只存在内存里，所以收到「登录」信号的一方要自己换一张：用浏览器共享的
   * HttpOnly 刷新 Cookie 走一次正常刷新，再把 `/me` 与站点补上；收到「退出」直接
   * 清空。失败时只有在原本就没登录的情况下才落到匿名——已经登录的标签页不能因为
   * 一次网络抖动被踢回登录页。
   */
  const adoptExternalSession = useCallback(async () => {
    const wasReady = stateRef.current.status === 'ready';
    try {
      const session = await backend.refresh();
      const me = await backend.me();
      const [site, groups] = await Promise.all([loadSite(me), loadPermissionGroups(me)]);
      // 别的标签页登录成功：本标签页如果是访客配置，同样要转正，否则这套预览/写回
      // 逻辑会继续按只读访客路径走。
      upgradeVisitorConfig();
      if (!mountedRef.current) return;
      setPermissionGroups(groups);
      setState({ status: 'ready', session, me, site });
    } catch {
      if (!mountedRef.current || wasReady) return;
      setPermissionGroups(null);
      setState({ status: 'anonymous', session: null, me: null, site: visitorSite });
      setUnread(0);
    }
  }, [backend, loadSite, loadPermissionGroups, upgradeVisitorConfig, visitorSite]);

  useEffect(
    () =>
      subscribeSessionSignals((signal) => {
        if (signal.kind === 'logout') {
          setPermissionGroups(null);
          setState({ status: 'anonymous', session: null, me: null, site: visitorSite });
          setUnread(0);
          return;
        }
        const current = stateRef.current;
        // 同一个账户已经在线的标签页不必再换一次令牌（也就不用再轮换一次刷新令牌）。
        if (
          current.status === 'ready' &&
          current.me &&
          signal.userId &&
          current.me.user.id === signal.userId
        ) {
          return;
        }
        void adoptExternalSession();
      }),
    [adoptExternalSession, visitorSite],
  );

  const updateConfig = useCallback(
    (patch: Partial<WebConfig>) => {
      onConfigChange?.(patch);
    },
    [onConfigChange],
  );

  const refreshUnread = useCallback(async () => {
    if (!state.me) return;
    try {
      const inbox = await backend.notifications();
      // 服务端给的 unread 是完整计数；列表只有前 50 条，按列表过滤会少算。
      setUnread(
        typeof inbox.unread === 'number'
          ? inbox.unread
          : inbox.items.filter((n) => !n.read).length,
      );
    } catch {
      /* 通知轮询失败不打扰用户 */
    }
  }, [backend, state.me]);

  useEffect(() => {
    if (state.status !== 'ready' || !state.me) {
      setUnread(0);
      return;
    }
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      // 实时连接在线时由推送触发 refreshUnread；只有不可用 / 断线时才轮询。
      if (readRealtimeStatus() === 'live') return;
      void refreshUnread();
    };
    tick();
    const timer = window.setInterval(tick, REALTIME_FALLBACK_POLL_MS);
    const onFocus = () => tick();
    window.addEventListener('focus', onFocus);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [state.status, state.me, refreshUnread]);

  /**
   * 会话状态变化后广播一次 `pp:session-ready`。
   *
   * App 在 AuthProvider 之外（它负责安装校验与站点配置水合），拿不到会话上下文：
   * 开屏那次 `GET /site-config` 往往还没登录，只拿到公开子集；登录 / 刷新会话之后
   * 需要再拉一次才能拿到管理员专属字段（证书路径、CORS、登录方式参数）。
   * `canManageSite` 与服务端 `ActionManageSite` 同一判据：站点管理员或平台管理员。
   */
  useEffect(() => {
    if (state.status === 'loading') return;
    const role = state.me?.role;
    window.dispatchEvent(
      new CustomEvent('pp:session-ready', {
        detail: {
          authenticated: !!state.me,
          canManageSite: role === 'site_admin' || role === 'platform_admin',
        },
      }),
    );
  }, [state.status, state.me]);

  const value = useMemo<AuthValue>(
    () => ({
      ...state,
      config,
      updateConfig,
      login,
      verifyTwoFactor,
      providerLogin,
      oauthStart,
      register,
      logout,
      reload,
      applySite,
      unread,
      refreshUnread,
      permissionGroups,
      refreshPermissionGroups,
    }),
    [
      state,
      config,
      updateConfig,
      login,
      verifyTwoFactor,
      providerLogin,
      oauthStart,
      register,
      logout,
      reload,
      applySite,
      unread,
      refreshUnread,
      permissionGroups,
      refreshPermissionGroups,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const t = useT();
  const value = useContext(AuthContext);
  if (!value) throw new Error(t('useAuth 必须在 AuthProvider 内使用'));
  return value;
}
