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
import type { AuthProviderId, Me, Session, Site, SessionState, WebConfig } from '../types';
import type { Backend } from './backend';
import { useT } from './i18n';

interface AuthValue extends SessionState {
  config: WebConfig;
  /** 更新本地安装配置（站点形态等），会写回 localStorage。 */
  updateConfig(patch: Partial<WebConfig>): void;
  login(email: string, password: string): Promise<void>;
  /** 演示模式下的手机 / 第三方登录模拟；真实后端未实现时会抛错。 */
  providerLogin(provider: AuthProviderId): Promise<void>;
  register(input: { email: string; password: string; display_name: string }): Promise<void>;
  logout(): Promise<void>;
  reload(): Promise<void>;
  applySite(site: Site): void;
  unread: number;
  refreshUnread(): Promise<void>;
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
  const visitorSite = useMemo(() => visitorSiteOf(config), [config]);
  const [state, setState] = useState<SessionState>({
    status: 'loading',
    session: null,
    me: null,
    site: visitorSite,
  });
  const [unread, setUnread] = useState(0);
  const aliveRef = useRef(true);

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

  const hydrate = useCallback(
    async (session: Session) => {
      const me = await backend.me();
      const site = await loadSite(me);
      if (!aliveRef.current) return;
      setState({ status: 'ready', session, me, site });
    },
    [backend, loadSite],
  );

  useEffect(() => {
    const onExpired = () => {
      setState({ status: 'anonymous', session: null, me: null, site: visitorSite });
      setUnread(0);
    };
    window.addEventListener('pp:session-expired', onExpired);
    return () => window.removeEventListener('pp:session-expired', onExpired);
  }, [visitorSite]);

  useEffect(() => {
    aliveRef.current = true;
    let cancelled = false;
    setState({ status: 'loading', session: null, me: null, site: visitorSite });
    (async () => {
      try {
        const session = await backend.refresh();
        const me = await backend.me();
        const site = await loadSite(me);
        if (cancelled) return;
        setState({ status: 'ready', session, me, site });
      } catch {
        if (cancelled) return;
        setState({ status: 'anonymous', session: null, me: null, site: visitorSite });
      }
    })();
    return () => {
      cancelled = true;
      aliveRef.current = false;
    };
  }, [backend, loadSite, visitorSite]);

  const login = useCallback(
    async (email: string, password: string) => {
      const session = await backend.login({ email, password });
      await hydrate(session);
    },
    [backend, hydrate],
  );

  const providerLogin = useCallback(
    async (provider: AuthProviderId) => {
      if (!backend.demoProviderLogin) {
        throw new Error(t('当前后端还没有实现这种登录方式。'));
      }
      const session = await backend.demoProviderLogin(provider);
      await hydrate(session);
    },
    [backend, hydrate, t],
  );

  const register = useCallback(
    async (input: { email: string; password: string; display_name: string }) => {
      const session = await backend.register(input);
      await hydrate(session);
    },
    [backend, hydrate],
  );

  const logout = useCallback(async () => {
    await backend.logout();
    setState({ status: 'anonymous', session: null, me: null, site: visitorSite });
    setUnread(0);
  }, [backend, visitorSite]);

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
      setUnread(inbox.items.filter((n) => !n.read).length);
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
      if (!stopped) void refreshUnread();
    };
    tick();
    const timer = window.setInterval(tick, 45_000);
    const onFocus = () => tick();
    window.addEventListener('focus', onFocus);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [state.status, state.me, refreshUnread]);

  const value = useMemo<AuthValue>(
    () => ({
      ...state,
      config,
      updateConfig,
      login,
      providerLogin,
      register,
      logout,
      reload,
      applySite,
      unread,
      refreshUnread,
    }),
    [
      state,
      config,
      updateConfig,
      login,
      providerLogin,
      register,
      logout,
      reload,
      applySite,
      unread,
      refreshUnread,
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
