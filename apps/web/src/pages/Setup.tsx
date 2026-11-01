import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AuthProviderId,
  AuthSettings,
  LayoutVariant,
  ProbeResult,
  Role,
  Site,
  SiteCustomization,
  SiteKind,
  ThemeMode,
  WebConfig,
} from '../types';
import { HttpBackend, ApiError, normalizeOrigin } from '../lib/api';
import { DemoBackend } from '../lib/demo';
import { INSTALL_RESET_KEY, saveConfig } from '../lib/backend';
import { SITE_KIND_LABEL } from '../lib/site';
import { createCustomizationWithPages } from '../lib/customize';
import { DEFAULT_THEME, applyMode, applyPreset } from '../lib/theme';
import { inferActiveTheme, themeLibrary } from '../lib/themes';
import { defaultHomeLayout } from '../lib/blocks';
import {
  AUTH_PROVIDER_IDS,
  DEFAULT_AUTH,
  PROVIDER_BY_ID,
  providerReady,
} from '../lib/authProviders';
import { AuthProvidersEditor } from '../components/AuthProviders';
import { errorText, useTitle } from '../lib/hooks';
import { LOCALES, normalizeLocale, setLocale, useT, type Locale } from '../lib/i18n';
import { currentPort, readRuntime, type RuntimeInfo } from '../lib/runtime';
import { PUBLISH_LABEL, ROLE_LABEL, VISIBILITY_LABEL, slugify } from '../lib/format';
import {
  Badge,
  Button,
  Callout,
  CopyButton,
  Field,
  Input,
  Textarea,
} from '../components/ui';
import { Icon, type IconName } from '../components/Icon';

type Database = 'sqlite' | 'mysql' | 'postgres';

interface Draft {
  mode: 'demo' | 'live';
  apiBase: string;
  database: Database;
  /** 站点语言：先决定界面语言，完成时写进站点设计。 */
  language: Locale;
  db: { host: string; port: string; name: string; user: string; password: string };
  admin: { email: string; display_name: string; password: string; confirm: string };
  site: {
    name: string;
    domain: string;
    description: string;
    kind: SiteKind;
    visibility_mode: Site['visibility_mode'];
    publish_mode: Site['publish_mode'];
  };
  auth: AuthSettings;
  /** 安装时选一套大主题；之后在「主题设置」里随时改。 */
  theme: { preset: string; mode: ThemeMode; variant: LayoutVariant };
}

function cloneAuth(source: AuthSettings): AuthSettings {
  return {
    phone: { ...source.phone },
    google: { ...source.google },
    github: { ...source.github },
    wechat: { ...source.wechat },
  };
}

/** 把安装时选的大主题与语言写成一份完整配置（含默认页面）。 */
function setupCustomization(theme: Draft['theme'], language: Locale): SiteCustomization {
  const base = createCustomizationWithPages();
  const themed = applyMode(applyPreset(DEFAULT_THEME, theme.preset), theme.mode);
  return {
    ...base,
    language,
    theme: themed,
    layout: { ...base.layout, variant: theme.variant },
    active_theme: inferActiveTheme(themed, theme.variant),
    home: defaultHomeLayout(theme.variant),
  };
}

const DRAFT_KEY = 'pp.setup.draft.v1';

const STEPS = ['welcome', 'mode', 'database', 'admin', 'site', 'providers', 'checks'] as const;

type StepKey = (typeof STEPS)[number];

function defaultDraft(mode: Draft['mode'] = 'demo'): Draft {
  return {
    mode,
    apiBase: '',
    database: 'sqlite',
    language: 'zh-CN',
    db: { host: '127.0.0.1', port: '3306', name: 'practacu', user: 'practacu', password: '' },
    admin: { email: '', display_name: '', password: '', confirm: '' },
    site: {
      name: 'Practacu Press',
      domain: typeof window === 'undefined' ? 'press.local' : window.location.host,
      description: '一间小而安静的编辑部。写作者拥有自己的稿子，读者被当作邻居。',
      kind: 'community',
      visibility_mode: 'public',
      publish_mode: 'review',
    },
    auth: cloneAuth(DEFAULT_AUTH),
    theme: { preset: 'paper', mode: 'light', variant: 'classic' },
  };
}

function loadDraft(forceLive: boolean): Draft {
  const base = defaultDraft(forceLive ? 'live' : 'demo');
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<Draft>;
    const site = { ...base.site, ...saved.site };
    if (site.kind === 'personal') {
      site.visibility_mode = 'public';
      site.publish_mode = 'open';
    }
    const auth = cloneAuth(base.auth);
    for (const id of AUTH_PROVIDER_IDS) {
      auth[id] = { ...auth[id], ...(saved.auth?.[id] ?? {}) };
    }
    const merged: Draft = {
      ...base,
      ...saved,
      // 语言只认两个值：草稿被手改过或来自旧版本时回退简体中文。
      language: normalizeLocale(saved.language),
      db: { ...base.db, ...saved.db, password: '' },
      admin: { ...base.admin, ...saved.admin, password: '', confirm: '' },
      site,
      auth,
      theme: { ...base.theme, ...(saved.theme ?? {}) },
    };
    if (forceLive) {
      // 一键启动必须进入真实环境：忽略之前保存在草稿里的演示模式选择。
      merged.mode = 'live';
      merged.apiBase = '';
    }
    return merged;
  } catch {
    return base;
  }
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

type CheckStatus = 'ok' | 'warn' | 'fail' | 'wait';
interface CheckItem {
  key: string;
  label: string;
  detail: string;
  status: CheckStatus;
}

const DB_LABEL: Record<Database, string> = {
  sqlite: 'SQLite',
  mysql: 'MySQL',
  postgres: 'PostgreSQL',
};

export function SetupPage({ forceLive = false }: { forceLive?: boolean } = {}) {
  const t = useT();
  useTitle(t('安装引导'));
  const [step, setStep] = useState(forceLive ? 1 : 0);
  const [draft, setDraft] = useState<Draft>(() => loadDraft(forceLive));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [probe, setProbe] = useState<{ state: 'idle' | 'checking' | 'done' | 'fail'; result?: ProbeResult; message?: string }>({
    state: 'idle',
  });
  const [liveMe, setLiveMe] = useState<{ user_id: string; display_name: string; role: Role; site_id: string } | null>(null);
  const [liveSite, setLiveSite] = useState<Site | null>(null);
  // 密钥不进入 draft / localStorage，只用于拼接 .env 片段。
  const [secrets, setSecrets] = useState<Partial<Record<AuthProviderId, string>>>({});
  const [showExisting, setShowExisting] = useState(false);
  const [existing, setExisting] = useState({ email: '', password: '' });
  const [checks, setChecks] = useState<CheckItem[]>([
    { key: 'ready', label: t('服务就绪'), detail: t('等待检查'), status: 'wait' },
    { key: 'data', label: t('数据存储'), detail: t('等待检查'), status: 'wait' },
    { key: 'security', label: t('安全服务'), detail: t('等待检查'), status: 'wait' },
    { key: 'site', label: t('站点可访问'), detail: t('等待检查'), status: 'wait' },
    { key: 'openapi', label: t('OpenAPI 文档'), detail: t('等待检查'), status: 'wait' },
  ]);
  const [done, setDone] = useState(false);
  // 上一次安装的配置被判定失效后由 App 写入：告诉用户为什么又回到了安装引导。
  const [resetNotice] = useState(() => {
    try {
      return sessionStorage.getItem(INSTALL_RESET_KEY) === '1';
    } catch {
      return false;
    }
  });
  const liveRef = useRef<HttpBackend | null>(null);
  const autoTriedRef = useRef(false);
  const probingRef = useRef(false);
  const [manualOpen, setManualOpen] = useState(false);
  // 启动器托管的本机 API 信息；开发服务器与 npm start 没有这个接口，读不到就是 null。
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);

  useEffect(() => {
    let alive = true;
    void readRuntime().then((info) => {
      if (alive) setRuntime(info);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 引导自身的界面语言跟着草稿走：第 0 步切换后立刻生效，而不是等到安装完成。
  // 完成安装时同一个值会写进站点设计（见 setupCustomization）。
  useEffect(() => {
    setLocale(draft.language);
  }, [draft.language]);

  const launcherApi = runtime?.api;
  const launcherLive = runtime?.runtime_mode === 'live' && !!launcherApi?.managed;

  useEffect(() => {
    const safe: Draft = {
      ...draft,
      db: { ...draft.db, password: '' },
      admin: { ...draft.admin, password: '', confirm: '' },
    };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(safe));
  }, [draft]);

  useEffect(() => {
    if (step === 6) void runChecks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const updateSite = (patch: Partial<Draft['site']>) =>
    setDraft((prev) => ({ ...prev, site: { ...prev.site, ...patch } }));

  const updateAdmin = (patch: Partial<Draft['admin']>) =>
    setDraft((prev) => ({ ...prev, admin: { ...prev.admin, ...patch } }));

  const updateDb = (patch: Partial<Draft['db']>) =>
    setDraft((prev) => ({ ...prev, db: { ...prev.db, ...patch } }));

  const updateTheme = (patch: Partial<Draft['theme']>) =>
    setDraft((prev) => ({ ...prev, theme: { ...prev.theme, ...patch } }));

  /**
   * 真实环境不能把「当前地址」默认写成站点域名：服务端只信任完成验证的域名，
   * 写进去会让站点随后解析不到自己。留空表示单站点自动匹配任意本机地址。
   */
  const clearAutoDomain = () => {
    const current = draft.site.domain.trim().toLowerCase();
    if (!current) return;
    const auto = [window.location.host, window.location.hostname].map((value) => value.toLowerCase());
    if (auto.includes(current)) updateSite({ domain: '' });
  };

  const continueWithDemo = () => {
    update('mode', 'demo');
    resetLive();
    setManualOpen(false);
    setError('');
    if (!draft.site.domain.trim()) updateSite({ domain: window.location.host });
    go(2);
  };

  const resetLive = () => {
    liveRef.current = null;
    autoTriedRef.current = false;
    setLiveMe(null);
    setLiveSite(null);
    setProbe({ state: 'idle' });
  };

  const go = (next: number) => {
    setError('');
    setStep(next);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const displayBase = (base: string) =>
    normalizeOrigin(base) || (typeof window === 'undefined' ? t('同源') : window.location.origin);

  /** 真实环境默认尝试：同源 → 本地 8080，不需要用户输入地址。 */
  const candidateBases = (): string[] => {
    const manual = normalizeOrigin(draft.apiBase);
    if (manual) return [manual];
    const list = [''];
    if (typeof window !== 'undefined') {
      const host = window.location.hostname;
      if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') {
        list.push('http://127.0.0.1:8080', 'http://localhost:8080');
      }
    }
    return Array.from(new Set(list));
  };

  const connectLive = async (bases?: string[]): Promise<boolean> => {
    if (probingRef.current) return false;
    probingRef.current = true;
    setError('');
    setProbe({ state: 'checking' });
    const list = (bases ?? candidateBases()).map((item) => normalizeOrigin(item));
    const tried = Array.from(new Set(list));
    try {
      for (const base of tried) {
        const backend = new HttpBackend({ base, onExpired: () => undefined });
        const result = await backend.probe();
        if (result.health === 'ok' && result.ready === 'ready') {
          liveRef.current = backend;
          update('apiBase', base);
          setProbe({ state: 'done', result });
          return true;
        }
        if (result.health === 'ok') {
          // 找到了 API，但数据库未就绪：换地址没有意义，直接给出原因。
          liveRef.current = backend;
          update('apiBase', base);
          setProbe({
            state: 'fail',
            result,
            message: t('已找到 API（{base}），但依赖未就绪（readyz {ready}）。请先执行迁移与 seed。', {
              base: displayBase(base),
              ready: result.ready,
            }),
          });
          return false;
        }
      }
      liveRef.current = null;
      setProbe({
        state: 'fail',
        message: t('没有发现可用的后端。已尝试：{bases}。', {
          bases: tried.map(displayBase).join(t('、')),
        }),
      });
      return false;
    } finally {
      probingRef.current = false;
    }
  };

  // 进入“运行方式”且已选真实环境时自动连接，不用点“检测连接”。
  useEffect(() => {
    if (step !== 1 || draft.mode !== 'live' || autoTriedRef.current) return;
    autoTriedRef.current = true;
    void connectLive();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, draft.mode]);

  const dsn = useMemo(() => {
    if (draft.database === 'sqlite') return 'file:./data/practacu.db';
    const scheme = draft.database === 'mysql' ? 'mysql' : 'postgres';
    const port = draft.db.port || (draft.database === 'mysql' ? '3306' : '5432');
    return `${scheme}://${draft.db.user || 'user'}:${draft.db.password || 'password'}@${draft.db.host || '127.0.0.1'}:${port}/${draft.db.name || 'practacu'}`;
  }, [draft.database, draft.db]);

  const envSnippet = `DATABASE_DRIVER=${draft.database}\nDATABASE_DSN=${dsn}`;

  const registerAdmin = async () => {
    setError('');
    if (draft.mode === 'demo') {
      const message = validate(3);
      if (message) {
        setError(message);
        return;
      }
      setLiveMe({
        user_id: 'usr_admin',
        display_name: draft.admin.display_name,
        role: 'platform_admin',
        site_id: 'site_main',
      });
      return;
    }
    setBusy(true);
    try {
      const backend = liveRef.current ?? new HttpBackend({ base: draft.apiBase, onExpired: () => undefined });
      liveRef.current = backend;
      await backend.register({
        email: draft.admin.email.trim(),
        password: draft.admin.password,
        display_name: draft.admin.display_name.trim(),
      });
      const me = await backend.me();
      const site = await backend.site(me.site_id).catch(() => null);
      setLiveMe({ user_id: me.user.id, display_name: me.user.display_name, role: me.role, site_id: me.site_id });
      setLiveSite(site);
      if (me.role !== 'site_admin' && me.role !== 'platform_admin') {
        setError(t('该账户不是站点管理员，无法完成站点配置。请使用安装时创建的管理员账户，或让平台管理员提升权限。'));
        return;
      }
      if (site) {
        updateSite({
          name: site.name,
          domain: site.domain,
          visibility_mode: site.visibility_mode,
          publish_mode: site.publish_mode,
          description: site.description ?? draft.site.description,
        });
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'conflict') {
        setShowExisting(true);
        setError(t('该邮箱已经注册。请改用「使用已有管理员账户登录」。'));
      } else {
        setError(errorText(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const loginExisting = async () => {
    setError('');
    setBusy(true);
    try {
      const backend = liveRef.current ?? new HttpBackend({ base: draft.apiBase, onExpired: () => undefined });
      liveRef.current = backend;
      await backend.login(existing);
      const me = await backend.me();
      if (me.role !== 'site_admin' && me.role !== 'platform_admin') {
        setError(t('该账户不是站点管理员，无法完成站点配置。'));
        return;
      }
      const site = await backend.site(me.site_id).catch(() => null);
      setLiveMe({ user_id: me.user.id, display_name: me.user.display_name, role: me.role, site_id: me.site_id });
      setLiveSite(site);
      if (site) {
        updateSite({
          name: site.name,
          domain: site.domain,
          visibility_mode: site.visibility_mode,
          publish_mode: site.publish_mode,
          description: site.description ?? draft.site.description,
        });
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const saveLiveSite = async () => {
    if (!liveRef.current || !liveMe) throw new Error(t('没有可用的登录会话，请返回上一步重新登录。'));
    const personal = draft.site.kind === 'personal';
    const visibility_mode = personal ? 'public' : draft.site.visibility_mode;
    const publish_mode = personal ? 'open' : draft.site.publish_mode;
    await liveRef.current.updateSite(liveMe.site_id, {
      name: draft.site.name.trim(),
      description: draft.site.description.trim(),
      domain: draft.site.domain.trim(),
      visibility_mode,
      publish_mode,
    });
    setLiveSite((prev) =>
      prev
        ? { ...prev, ...draft.site, visibility_mode, publish_mode }
        : {
            id: liveMe.site_id,
            slug: slugify(draft.site.name),
            disabled: false,
            ...draft.site,
            visibility_mode,
            publish_mode,
          },
    );
  };

  const validate = (index: number): string => {
    // 运行方式不需要手填地址：下一步会先用同源/本地 8080 自动连接。
    if (index === 1) return '';
    if (index === 2 && draft.database !== 'sqlite') {
      if (!draft.db.host.trim()) return t('请填写数据库主机。');
      if (!draft.db.name.trim()) return t('请填写数据库名称。');
      if (!draft.db.user.trim()) return t('请填写数据库用户。');
      return '';
    }
    if (index === 3) {
      if (liveMe) return '';
      if (draft.mode === 'live' && showExisting) {
        if (!isEmail(existing.email)) return t('请填写管理员邮箱。');
        if (!existing.password) return t('请填写密码。');
        return '';
      }
      if (!isEmail(draft.admin.email)) return t('请填写有效的邮箱地址。');
      if (!draft.admin.display_name.trim()) return t('请填写显示名称。');
      if (draft.admin.display_name.length > 120) return t('显示名称不能超过 120 个字符。');
      if (draft.admin.password.length < 8) return t('密码至少 8 位。');
      if (draft.admin.password.length > 128) return t('密码不能超过 128 位。');
      if (draft.admin.password !== draft.admin.confirm) return t('两次输入的密码不一致。');
      return '';
    }
    if (index === 4) {
      if (!draft.site.name.trim()) return t('站点名称不能为空。');
      if (draft.site.name.length > 160) return t('站点名称不能超过 160 个字符。');
      // 真实环境留空表示单站点自动匹配任意本机地址；填了未验证的域名，站点会解析不到自己。
      if (draft.mode !== 'live' && !draft.site.domain.trim()) return t('请填写访问域名。');
      if (draft.site.description.length > 2000) return t('站点简介不能超过 2000 个字符。');
      return '';
    }
    if (index === 5) {
      const incomplete = AUTH_PROVIDER_IDS.filter(
        (id) => draft.auth[id].enabled && !providerReady(id, draft.auth[id]),
      );
      if (incomplete.length) {
        return t('请补齐{providers}的必填项，或者先关闭该方式。', {
          providers: incomplete.map((id) => PROVIDER_BY_ID[id].name).join(t('、')),
        });
      }
      return '';
    }
    return '';
  };

  const next = async () => {
    const message = validate(step);
    if (message) {
      setError(message);
      return;
    }
    setError('');
    if (step === 1) {
      if (draft.mode === 'live') {
        const ok = probe.state === 'done' || (await connectLive());
        // 连接失败时由连接卡片说明原因；这里停在当前步骤，避免进入注册才报错。
        if (!ok) return;
        // 数据库由后端配置，真实环境不再询问 DSN。
        go(3);
        return;
      }
      go(2);
      return;
    }
    if (step === 3 && draft.mode === 'live' && !liveMe) {
      if (showExisting) await loginExisting();
      else await registerAdmin();
      return;
    }
    if (step === 4 && draft.mode === 'live') {
      setBusy(true);
      try {
        await saveLiveSite();
      } catch (err) {
        setError(errorText(err));
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    if (step === 6) {
      await complete();
      return;
    }
    go(step + 1);
  };

  const prev = () => {
    // 真实环境跳过了数据库步骤，上一步直接回到运行方式。
    if (draft.mode === 'live' && step === 3) {
      go(1);
      return;
    }
    go(Math.max(0, step - 1));
  };

  const runChecks = async () => {
    const openapiUrl = `${normalizeOrigin(draft.apiBase)}/api/v1/openapi.json`;
    const nextChecks: CheckItem[] = [];
    if (draft.mode === 'demo') {
      let storageOk = true;
      try {
        localStorage.setItem('pp.setup.probe', String(Date.now()));
        localStorage.removeItem('pp.setup.probe');
      } catch {
        storageOk = false;
      }
      nextChecks.push({
        key: 'ready',
        label: t('本地演示环境'),
        detail: storageOk
          ? t('不需要后端服务，数据写入浏览器 localStorage。')
          : t('浏览器禁用了 localStorage。'),
        status: storageOk ? 'ok' : 'fail',
      });
      nextChecks.push({
        key: 'data',
        label: t('数据存储'),
        detail: storageOk ? t('演示数据可以持久化到本机。') : t('无法持久化，刷新后会丢失。'),
        status: storageOk ? 'ok' : 'fail',
      });
      nextChecks.push({
        key: 'security',
        label: t('安全服务'),
        detail: t('演示模式不调用 Rust 安全服务；真实发布与上传需要它可用。'),
        status: 'warn',
      });
      nextChecks.push({
        key: 'site',
        label: t('站点可访问'),
        detail: t('演示站点将在此浏览器内立即生效。'),
        status: 'ok',
      });
      nextChecks.push({
        key: 'openapi',
        label: t('OpenAPI 文档'),
        detail: t('接口契约版本 0.1.0（演示模式不提供在线文档）。'),
        status: 'warn',
      });
      setChecks(nextChecks);
      return;
    }

    const backend = liveRef.current ?? new HttpBackend({ base: draft.apiBase, onExpired: () => undefined });
    liveRef.current = backend;
    const result = await backend.probe().catch(() => null);
    nextChecks.push({
      key: 'ready',
      label: t('服务就绪'),
      detail: result ? `/healthz ${result.health} · /readyz ${result.ready}` : t('无法连接'),
      status: result?.ready === 'ready' ? 'ok' : 'fail',
    });
    nextChecks.push({
      key: 'data',
      label: t('数据库与迁移'),
      detail:
        result?.ready === 'ready'
          ? t('就绪检查覆盖数据库连接；迁移由安装脚本执行。')
          : t('依赖未就绪，请先执行迁移。'),
      status: result?.ready === 'ready' ? 'ok' : 'fail',
    });
    nextChecks.push({
      key: 'security',
      label: t('安全服务'),
      detail: t('没有独立的健康端点；发布与上传会 fail-closed，安全检查不可用时返回 503。'),
      status: 'warn',
    });
    try {
      const res = await fetch(`${normalizeOrigin(draft.apiBase)}/api/v1/articles?limit=1`, {
        headers: { Accept: 'application/json' },
        credentials: 'include',
      });
      const type = res.headers.get('content-type') ?? '';
      const isJson = type.includes('application/json') || type.includes('problem+json');
      nextChecks.push({
        key: 'site',
        label: t('站点可访问'),
        detail:
          res.status === 401
            ? t('站点为「登录后浏览」，匿名请求被正确拒绝（401）。')
            : !isJson
              ? t('返回的不是 JSON，可能被前端或反向代理的 fallback 接管。')
              : res.ok
                ? t('匿名读取返回 200。')
                : t('返回 {status}。', { status: res.status }),
        status: res.status < 500 && isJson ? 'ok' : 'fail',
      });
    } catch {
      nextChecks.push({ key: 'site', label: t('站点可访问'), detail: t('请求失败。'), status: 'fail' });
    }
    nextChecks.push({
      key: 'openapi',
      label: t('OpenAPI 文档'),
      detail: result?.openapi
        ? t('{url} 可读取。', { url: openapiUrl })
        : t('未取到 openapi.json。'),
      status: result?.openapi ? 'ok' : 'warn',
    });
    setChecks(nextChecks);
  };

  const complete = async () => {
    setBusy(true);
    setError('');
    try {
      let config: WebConfig;
      if (draft.mode === 'demo') {
        const backend = new DemoBackend();
        backend.configure({
          admin: {
            email: draft.admin.email || 'admin@practacu.local',
            display_name: draft.admin.display_name || '林知远',
            password: draft.admin.password || 'practacu',
          },
          site: {
            ...draft.site,
            visibility_mode: draft.site.kind === 'personal' ? 'public' : draft.site.visibility_mode,
            publish_mode: draft.site.kind === 'personal' ? 'open' : draft.site.publish_mode,
          },
        });
        config = {
          version: 1,
          setup_complete: true,
          mode: 'demo',
          api_base: '',
          site_id: 'site_main',
          database: draft.database,
          created_at: new Date().toISOString(),
          docs_url: '',
          site_kind: draft.site.kind,
          owner_email: (draft.admin.email || 'admin@practacu.local').trim().toLowerCase(),
          customization: setupCustomization(draft.theme, draft.language),
          auth: cloneAuth(draft.auth),
        };
      } else {
        if (!liveMe) throw new Error(t('尚未完成管理员登录。'));
        config = {
          version: 1,
          setup_complete: true,
          mode: 'live',
          api_base: normalizeOrigin(draft.apiBase),
          site_id: liveMe.site_id,
          database: draft.database,
          created_at: new Date().toISOString(),
          docs_url: `${normalizeOrigin(draft.apiBase) || window.location.origin}/api/v1/docs`,
          site_kind: draft.site.kind,
          owner_email: (showExisting ? existing.email : draft.admin.email).trim().toLowerCase(),
          customization: setupCustomization(draft.theme, draft.language),
          auth: cloneAuth(draft.auth),
        };
      }
      localStorage.removeItem(DRAFT_KEY);
      try {
        sessionStorage.removeItem(INSTALL_RESET_KEY);
      } catch {
        /* 无痕模式：没有可清理的提示 */
      }
      saveConfig(config);
      setDone(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const origin = draft.mode === 'demo' ? window.location.origin : normalizeOrigin(draft.apiBase) || window.location.origin;

  if (done) {
    return (
      <div className="wiz">
        <div className="wiz-top">
          <div className="shell">
            <div className="brand">
              <span className="brand-mark">P</span>
              <span>
                <span className="brand-text">Practacu Press</span>
                <span className="brand-sub">Installation complete</span>
              </span>
            </div>
            <span className="wiz-progress-text">{t('安装完成')}</span>
          </div>
        </div>
        <div className="wiz-body" style={{ gridTemplateColumns: 'minmax(0, 1fr)', maxWidth: 780 }}>
          <div className="wiz-main" style={{ maxWidth: 720 }}>
            <div className="wiz-finish">
              <span className="finish-mark">
                <Icon name="check" size={26} />
              </span>
              <h1>{t('{name} 已经准备好了', { name: draft.site.name })}</h1>
              <p>
                {draft.mode === 'demo'
                  ? t('演示数据已写入此浏览器。你可以随时在「站点设置」里重新运行安装引导或重置数据。')
                  : t('管理员账户与站点规则已写入服务端。下面的地址可以用来访问站点和接口文档。')}
                {draft.site.kind === 'personal'
                  ? ` ${t('个人博客不开放注册，访客无需账户即可阅读全部已发布内容。')}`
                  : ''}
              </p>

              <div className="address-grid">
                <div className="address-card">
                  <span>{t('站点前台')}</span>
                  <code>{origin}/</code>
                </div>
                <div className="address-card">
                  <span>{t('管理后台')}</span>
                  <code>{origin}/admin</code>
                </div>
                <div className="address-card">
                  <span>{t('API 根路径')}</span>
                  <code>{draft.mode === 'demo' ? t('演示模式 · 无远程 API') : `${origin}/api/v1`}</code>
                </div>
                <div className="address-card">
                  <span>{t('OpenAPI 文档')}</span>
                  <code>{draft.mode === 'demo' ? t('契约 0.1.0 · 演示模式') : `${origin}/api/v1/docs`}</code>
                </div>
              </div>

              <div className="mini-list mt-32" style={{ textAlign: 'left' }}>
                <div className="mini-row">
                  <span className="mini-label">{t('管理员')}</span>
                  <span className="mini-value">
                    {draft.admin.display_name || (liveMe?.display_name ?? '林知远')} ·{' '}
                    {draft.admin.email || 'admin@practacu.local'}
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('数据库')}</span>
                  <span className="mini-value">
                    {draft.mode === 'live' ? t('由后端配置') : DB_LABEL[draft.database]}
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('站点形态')}</span>
                  <span className="mini-value">
                    {SITE_KIND_LABEL[draft.site.kind]}
                    {draft.site.kind === 'personal' ? ` · ${t('仅站长可登录')}` : ` · ${t('开放注册')}`}
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('站点规则')}</span>
                  <span className="mini-value">
                    {VISIBILITY_LABEL[draft.site.visibility_mode]} · {PUBLISH_LABEL[draft.site.publish_mode]}
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('登录方式')}</span>
                  <span className="mini-value">
                    {[
                      t('邮箱密码'),
                      ...AUTH_PROVIDER_IDS.filter((id) => draft.auth[id].enabled).map(
                        (id) => PROVIDER_BY_ID[id].name,
                      ),
                    ].join(' · ')}
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('访问端口')}</span>
                  <span className="mini-value mono">
                    {currentPort()}
                    {currentPort() === 80 ? ` · ${t('默认')}` : ''}
                    {t('（可在站点设置修改）')}
                  </span>
                </div>
              </div>

              <div className="wiz-finish-actions">
                <a href="/admin" className="btn btn-primary btn-lg">
                  {t('进入管理后台')} <Icon name="arrow-right" size={16} />
                </a>
                <a href="/" className="btn btn-secondary btn-lg">
                  {t('查看站点')}
                </a>
                {draft.mode === 'live' ? (
                  <a
                    href={`${origin}/api/v1/docs`}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-ghost btn-lg"
                  >
                    {t('OpenAPI 文档')} <Icon name="external" size={14} />
                  </a>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const stepLabel: Record<StepKey, string> = {
    welcome: t('欢迎'),
    mode: t('运行方式'),
    database: t('数据库'),
    admin: t('管理员'),
    site: t('默认站点'),
    providers: t('登录方式'),
    checks: t('检查与完成'),
  };
  const stepHint: Record<StepKey, string> = {
    welcome: t('从这里开始'),
    mode: t('连接后端或演示'),
    database: 'SQLite / MySQL / PostgreSQL',
    admin: t('第一个账户'),
    site: t('名称、域名与规则'),
    providers: t('邮箱、手机、OAuth'),
    checks: t('迁移、健康检查'),
  };
  const currentKey = STEPS[step];
  const isLast = step === STEPS.length - 1;
  const healthReady = checks.find((c) => c.key === 'ready')?.status === 'ok';
  const canFinish = checks.every((c) => c.status !== 'fail') && healthReady;

  return (
    <div className="wiz">
      <div className="wiz-top">
        <div className="shell">
          <div className="brand">
            <span className="brand-mark">P</span>
            <span>
              <span className="brand-text">Practacu Press</span>
              <span className="brand-sub">First run setup</span>
            </span>
          </div>
          <div className="wiz-top-right">
            <span className="wiz-progress-text">
              {t('第')} <b>{step + 1}</b> / {STEPS.length} {t('步 ·')} {stepLabel[currentKey]}
            </span>
            <div className="wiz-lang" role="group" aria-label={t('安装语言 / Setup language')}>
              {LOCALES.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`wiz-lang-btn${draft.language === item.id ? ' is-active' : ''}`}
                  aria-pressed={draft.language === item.id}
                  onClick={() => update('language', item.id)}
                >
                  {item.native}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="wiz-body">
        <aside className="wiz-rail">
          <div className="wiz-rail-inner">
            <p className="wiz-rail-label">{t('安装进度')}</p>
            <ol className="wiz-steps">
              {STEPS.map((key, index) => (
                <li
                  key={key}
                  className={`wiz-step${index === step ? ' is-current' : ''}${index < step ? ' is-done' : ''}`}
                >
                  <span className="wiz-step-num">
                    {index < step ? <Icon name="check" size={11} /> : index + 1}
                  </span>
                  <span className="wiz-step-text">
                    <strong>{stepLabel[key]}</strong>
                    <span>
                      {key === 'database' && draft.mode === 'live'
                        ? t('由后端配置 · 已跳过')
                        : stepHint[key]}
                    </span>
                  </span>
                </li>
              ))}
            </ol>
            <p className="wiz-rail-note">
              {t('引导只写入必要的站点配置。Client Secret、短信密钥与数据库连接留在服务端，不会进入浏览器。')}
            </p>
          </div>
        </aside>

        <div className="wiz-main">
          {resetNotice ? (
            <div className="mb-24">
              <Callout tone="warn" icon="alert" title={t('服务端的站点已经不在了')}>
                {t('这台机器的 data 目录被删除或重建过，浏览器里记着的安装配置已经对不上， 所以重新打开了安装引导。已有的内容需要从备份的 data 目录恢复。')}
              </Callout>
            </div>
          ) : null}
          {step === 0 ? (
            <div className="wiz-welcome">
              <div>
                <p className="wiz-eyebrow">Welcome</p>
                <h1>
                  {t('先给这间编辑部')}
                  <br />
                  {t('盖一座房子。')}
                </h1>
                <p>
                  {t('接下来六步会创建第一个管理员、一个默认站点和它的发布规则。所有选项之后都能在管理后台修改。')}
                </p>
                <div className="wiz-features">
                  <div className="wiz-feature">
                    <Icon name="check" size={15} /> {t('一个平台管理员账户，以及一条可解释的角色边界。')}
                  </div>
                  <div className="wiz-feature">
                    <Icon name="check" size={15} /> {t('一个默认站点：名称、域名、站点形态（个人博客或社区）与发布规则。')}
                  </div>
                  <div className="wiz-feature">
                    <Icon name="check" size={15} /> {t('一次健康检查，确认数据库、站点与契约文档都可达。')}
                  </div>
                </div>
                <div className="wiz-stat">
                  <div>
                    <span>{t('角色')}</span>
                    <b>{t('4 级')}</b>
                  </div>
                  <div>
                    <span>{t('阶段')}</span>
                    <b>{t('6 步')}</b>
                  </div>
                  <div>
                    <span>{t('契约')}</span>
                    <b>0.1.0</b>
                  </div>
                </div>

                <div className="wiz-theme">
                  <p className="wiz-theme-label">
                    <Icon name="palette" size={14} />{' '}
                    {t('先选一套大主题：配色、排版和单栏 / 双栏版式会一起切换。 之后可在「主题设置」里微调、导入或删除自定义主题。')}
                  </p>
                  <div className="builtin-theme-grid">
                    {themeLibrary().map((bundle) => {
                      const selected =
                        draft.theme.preset === bundle.theme.preset &&
                        draft.theme.variant === bundle.variant;
                      return (
                        <button
                          key={bundle.id}
                          type="button"
                          className={`builtin-theme-card${selected ? ' is-selected' : ''}`}
                          onClick={() =>
                            updateTheme({
                              preset: bundle.theme.preset,
                              mode: bundle.theme.mode,
                              variant: bundle.variant,
                            })
                          }
                          aria-pressed={selected}
                        >
                          <span
                            className="builtin-theme-preview"
                            style={{
                              background: bundle.theme.background,
                              color: bundle.theme.ink,
                            }}
                          >
                            <span style={{ background: bundle.theme.accent }} />
                            Aa
                          </span>
                          <span>
                            <strong>{bundle.name}</strong>
                            <span>
                              {bundle.note} · {bundle.variant === 'bento' ? t('双栏') : t('单栏')}
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="field-hint mt-8">
                    {t('当前：{theme}· {mode}。页面编排与主题微调在后台「主题设置」里。', {
                      theme:
                        themeLibrary().find(
                          (bundle) =>
                            bundle.theme.preset === draft.theme.preset &&
                            bundle.variant === draft.theme.variant,
                        )?.name ?? t('自定义'),
                      mode: draft.theme.mode === 'dark' ? t('深色') : t('浅色'),
                    })}
                  </p>
                </div>
              </div>
              <div className="wiz-art" aria-hidden>
                <svg viewBox="0 0 300 400">
                  <g stroke="#e2e2da" strokeWidth="1">
                    {Array.from({ length: 6 }, (_, i) => (
                      <line key={i} x1="0" y1={(i + 1) * 60} x2="300" y2={(i + 1) * 60} />
                    ))}
                    <line x1="150" y1="0" x2="150" y2="400" />
                  </g>
                  <circle cx="150" cy="170" r="86" fill="none" stroke="#c9d8d0" strokeWidth="1" />
                  <text
                    x="150"
                    y="205"
                    textAnchor="middle"
                    fontFamily="Georgia, 'Songti SC', serif"
                    fontSize="118"
                    fill="#14140f"
                  >
                    P
                  </text>
                  <text
                    x="150"
                    y="330"
                    textAnchor="middle"
                    fontFamily="'Segoe UI', sans-serif"
                    fontSize="9"
                    letterSpacing="4"
                    fill="#83837a"
                  >
                    EST. 2026
                  </text>
                </svg>
              </div>
            </div>
          ) : null}

          {step === 1 ? (
            <>
              <p className="wiz-eyebrow">Runtime</p>
              <h1 className="wiz-title">{t('先决定这间房子接在哪里。')}</h1>
              <p className="wiz-lede">
                {t('连接真实后端时，所有写入都会经过 Go API 与 Rust 安全服务；演示模式不需要启动任何服务，数据只保存在此浏览器。')}
              </p>

              <div className="wiz-content">
                <div className="option-grid">
                  <button
                    type="button"
                    className={`option${draft.mode === 'demo' ? ' is-selected' : ''}`}
                    onClick={() => {
                      update('mode', 'demo');
                      resetLive();
                      setManualOpen(false);
                    }}
                    aria-pressed={draft.mode === 'demo'}
                  >
                    <span className="option-icon">
                      <Icon name="database" size={17} />
                    </span>
                    <span className="option-body">
                      <strong>{t('演示数据（本地）')}</strong>
                      <p>{t('无需后端。内置一组文章、成员、评论与通知，适合先看完整界面和审核流程。')}</p>
                      <span className="option-tag">{t('推荐 · 立即可用')}</span>
                    </span>
                    <span className="option-radio" />
                  </button>

                  <button
                    type="button"
                    className={`option${draft.mode === 'live' ? ' is-selected' : ''}`}
                    onClick={() => {
                      update('mode', 'live');
                      resetLive();
                      setManualOpen(false);
                      clearAutoDomain();
                    }}
                    aria-pressed={draft.mode === 'live'}
                  >
                    <span className="option-icon">
                      <Icon name="server" size={17} />
                    </span>
                    <span className="option-body">
                      <strong>{t('真实环境')}</strong>
                      <p>
                        {launcherLive
                          ? t('启动器已经在本机跑起 Go API 与 SQLite，直接连接同源接口，不需要填写地址。')
                          : t('自动连接同源接口或本机 8080 的 Go API，不需要填写地址。')}
                      </p>
                      <span className="option-tag">
                        {launcherLive ? t('本机 API 已就绪 · 零配置') : t('零配置 · 自动检测')}
                      </span>
                    </span>
                    <span className="option-radio" />
                  </button>
                </div>

                {draft.mode === 'live' ? (
                  <div className="mt-24">
                    <div className={`connect-card is-${probe.state}`}>
                      <span className="connect-mark">
                        <Icon
                          name={
                            probe.state === 'done'
                              ? 'check-circle'
                              : probe.state === 'fail'
                                ? 'x-circle'
                                : probe.state === 'checking'
                                  ? 'clock'
                                  : 'server'
                          }
                          size={18}
                        />
                      </span>
                      <div className="connect-body">
                        <strong>
                          {probe.state === 'checking'
                            ? t('正在自动寻找后端…')
                            : probe.state === 'done'
                              ? t('已连接到后端')
                              : probe.state === 'fail'
                                ? t('没有发现可用的后端')
                                : t('等待自动连接')}
                        </strong>
                        <p>
                          {probe.state === 'checking'
                            ? t('依次尝试同源接口与本机 127.0.0.1:8080，不需要填写地址。')
                            : probe.state === 'done'
                              ? `${displayBase(draft.apiBase)} · healthz ${probe.result?.health} · readyz ${probe.result?.ready}`
                              : probe.state === 'fail'
                                ? probe.message ?? t('连接失败。')
                                : t('选中真实环境后会自动连接，不需要手动检测。')}
                        </p>
                      </div>
                      <div className="connect-actions">
                        {probe.state === 'done' ? (
                          <>
                            <button type="button" className="link-btn" onClick={() => void connectLive()}>
                              {t('重新检测')}
                            </button>
                            <button type="button" className="link-btn" onClick={() => setManualOpen(true)}>
                              {t('更换地址')}
                            </button>
                          </>
                        ) : probe.state === 'fail' ? (
                          <Button size="sm" variant="secondary" onClick={() => void connectLive()} icon="refresh">
                            {t('重试')}
                          </Button>
                        ) : probe.state === 'idle' ? (
                          <Button size="sm" variant="secondary" onClick={() => void connectLive()} icon="refresh">
                            {t('连接')}
                          </Button>
                        ) : null}
                      </div>
                    </div>

                    {probe.state === 'fail' ? (
                      <div className="mt-16">
                        {launcherLive ? (
                          <Callout tone="warn" icon="alert" title={t('本机 API 没有通过就绪检查')}>
                            {t('启动器已经把 API 拉起来了，但接口还没准备好。启动器窗口里有退出原因，完整日志在')}
                            <code className="mono"> {launcherApi?.log ?? 'data/api.err.log'}</code>
                            {t('。')}
                            {launcherApi?.error ? (
                              <pre className="connect-commands">{launcherApi.error}</pre>
                            ) : null}
                          </Callout>
                        ) : runtime ? (
                          <Callout tone="warn" icon="alert" title={t('这个启动器没有运行本机 API')}>
                            {launcherApi?.error
                              ? t('启动器尝试启动本机 API 失败了，原因如下：')
                              : t('启动器以静态方式运行，没有找到 PractacuPressAPI.exe，所以同源与 8080 都没有后端。')}
                            {launcherApi?.error ? (
                              <pre className="connect-commands">{launcherApi.error}</pre>
                            ) : (
                              <p>
                                {t('请使用完整的 Windows 压缩包重新解压（里面应同时有')}
                                <code className="mono"> PractacuPress.exe </code>
                                {t('与')}
                                <code className="mono"> PractacuPressAPI.exe</code>
                                {t('），或按下面的命令手动启动 Go API。')}
                              </p>
                            )}
                            {launcherApi?.error ? null : (
                              <pre className="connect-commands">{`go run ./apps/api/cmd/migrate
go run ./apps/api/cmd/seed -driver sqlite -dsn ./data/practacu.db
go run ./apps/api/cmd/server`}</pre>
                            )}
                          </Callout>
                        ) : (
                          <Callout tone="warn" icon="alert" title={t('不用填地址，但后端需要先启动')}>
                            {t('前端会自动尝试同源与')} <code className="mono">http://127.0.0.1:8080</code>
                            {t('。在仓库根目录启动 Go API 后点「重试」即可；如果只是想先看界面，可以直接切到演示数据。 后端已启动仍失败时，多半是跨域限制：开发时用')}{' '}
                            <code className="mono">npm run dev</code>
                            {t('（')}
                            <code className="mono">/api</code>{' '}
                            {t('会代理到 8080），生产用同域反向代理。')}
                            <pre className="connect-commands">{`go run ./apps/api/cmd/migrate
go run ./apps/api/cmd/seed -driver sqlite -dsn ./data/practacu.db
go run ./apps/api/cmd/server`}</pre>
                          </Callout>
                        )}
                        <div className="row gap-8 mt-12" style={{ flexWrap: 'wrap' }}>
                          <Button size="sm" icon="arrow-right" onClick={continueWithDemo}>
                            {t('先以演示数据继续')}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            icon="refresh"
                            onClick={() => void connectLive()}
                          >
                            {t('重试连接')}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            icon="settings"
                            onClick={() => setManualOpen((value) => !value)}
                          >
                            {manualOpen ? t('收起手动设置') : t('手动指定地址')}
                          </Button>
                        </div>
                      </div>
                    ) : null}

                    {manualOpen ? (
                      <div className="connect-manual">
                        <Field
                          label={t('API 地址')}
                          hint={t('只有后端不在同源、也不在本机 8080 时才需要填写。')}
                          htmlFor="api-base"
                        >
                          <div className="row gap-8">
                            <Input
                              id="api-base"
                              value={draft.apiBase}
                              placeholder="https://press.example.com"
                              onChange={(e) => {
                                update('apiBase', e.target.value);
                                resetLive();
                              }}
                              autoComplete="off"
                            />
                            <Button
                              variant="secondary"
                              onClick={() => void connectLive([normalizeOrigin(draft.apiBase)])}
                              disabled={!normalizeOrigin(draft.apiBase)}
                            >
                              {t('使用这个地址')}
                            </Button>
                          </div>
                        </Field>
                        <p className="field-hint mt-8">
                          {t('跨域部署需要在服务端设置')} <code className="mono">CORS_ALLOWED_ORIGINS</code>{' '}
                          {t('并允许凭据； 推荐把前端与 API 放在同一域名下由反向代理转发。')}
                        </p>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <Callout tone="info" icon="info" title={t('演示模式写入哪里？')}>
                    {t('站点、文章、评论与上传的图片都保存在')} <code className="mono">localStorage</code>
                    {t('。清除浏览器数据会一并清空； 可在「站点设置 → 重新运行安装引导」里重置。')}
                  </Callout>
                )}
              </div>
            </>
          ) : null}

          {step === 2 ? (
            <>
              <p className="wiz-eyebrow">Database</p>
              <h1 className="wiz-title">{t('选一个装得下稿子的柜子。')}</h1>
              <p className="wiz-lede">
                {t('后端支持 SQLite、MySQL 与 PostgreSQL。浏览器不能修改服务端进程的环境变量，这里选择的方案会生成一份可直接粘贴的配置片段。')}
              </p>

              <div className="wiz-content">
                <div className="option-grid">
                  {(
                    [
                      {
                        key: 'sqlite' as Database,
                        icon: 'database' as IconName,
                        title: 'SQLite',
                        desc: t('单机、演示与小规模部署的默认选择。无需额外进程，备份就是一个文件。'),
                        tag: t('默认 · Windows 本地安装'),
                      },
                      {
                        key: 'mysql' as Database,
                        icon: 'server' as IconName,
                        title: 'MySQL',
                        desc: t('已有 MySQL 基础设施的团队。需要提供连接串与账号权限。'),
                      },
                      {
                        key: 'postgres' as Database,
                        icon: 'server' as IconName,
                        title: 'PostgreSQL',
                        desc: t('SaaS 多站点生产的推荐选择。事务与并发场景更稳。'),
                        tag: t('推荐 · 生产'),
                      },
                    ] as const
                  ).map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      className={`option${draft.database === option.key ? ' is-selected' : ''}`}
                      onClick={() => {
                        update('database', option.key);
                        if (option.key !== 'sqlite') {
                          updateDb({ port: option.key === 'mysql' ? '3306' : '5432' });
                        }
                      }}
                      aria-pressed={draft.database === option.key}
                    >
                      <span className="option-icon">
                        <Icon name={option.icon} size={17} />
                      </span>
                      <span className="option-body">
                        <strong>{option.title}</strong>
                        <p>{option.desc}</p>
                        {'tag' in option && option.tag ? <span className="option-tag">{option.tag}</span> : null}
                      </span>
                      <span className="option-radio" />
                    </button>
                  ))}
                </div>

                {draft.database !== 'sqlite' ? (
                  <div className="form-grid mt-24">
                    <Field label={t('主机')} htmlFor="db-host">
                      <Input
                        id="db-host"
                        value={draft.db.host}
                        onChange={(e) => updateDb({ host: e.target.value })}
                        autoComplete="off"
                      />
                    </Field>
                    <Field label={t('端口')} htmlFor="db-port">
                      <Input
                        id="db-port"
                        value={draft.db.port}
                        onChange={(e) => updateDb({ port: e.target.value })}
                        inputMode="numeric"
                      />
                    </Field>
                    <Field label={t('数据库名')} htmlFor="db-name">
                      <Input
                        id="db-name"
                        value={draft.db.name}
                        onChange={(e) => updateDb({ name: e.target.value })}
                        autoComplete="off"
                      />
                    </Field>
                    <Field label={t('用户名')} htmlFor="db-user">
                      <Input
                        id="db-user"
                        value={draft.db.user}
                        onChange={(e) => updateDb({ user: e.target.value })}
                        autoComplete="off"
                      />
                    </Field>
                    <Field
                      label={t('密码')}
                      htmlFor="db-pass"
                      hint={t('只用于生成本地配置片段，不会发送到任何地方。')}
                    >
                      <Input
                        id="db-pass"
                        type="password"
                        value={draft.db.password}
                        onChange={(e) => updateDb({ password: e.target.value })}
                        autoComplete="new-password"
                      />
                    </Field>
                    <Field label={t('字符集 / 时区')} hint={t('所有时间以 UTC 存储，API 以 ISO 8601 返回。')}>
                      <Input value="utf8mb4 · UTC" readOnly disabled />
                    </Field>
                  </div>
                ) : null}

                <div className="mt-24">
                  <div className="code-block-head">
                    <span>{t('服务端配置片段')}</span>
                    <CopyButton value={envSnippet} label={t('复制 .env')} />
                  </div>
                  <pre className="code-block">{envSnippet}</pre>
                  <p className="field-hint mt-8">
                    {t('把这两行写入服务端的')} <code className="mono">.env</code>{' '}
                    {t('或环境变量，然后执行')}
                    <code className="mono"> go run ./apps/api/cmd/migrate</code>
                    {t('。')}
                    {draft.mode === 'demo' ? ` ${t('演示模式不会真正连接数据库。')}` : ''}
                  </p>
                </div>
              </div>
            </>
          ) : null}

          {step === 3 ? (
            <>
              <p className="wiz-eyebrow">Administrator</p>
              <h1 className="wiz-title">{t('第一个账户，拥有全部权限。')}</h1>
              <p className="wiz-lede">
                {t('平台管理员可以管理站点、成员、全局安全策略与审计。至少保留一个可用的平台管理员账户。')}
              </p>

              <div className="wiz-content">
                {liveMe ? (
                  <div className="status-line is-ok">
                    <Icon name="check-circle" size={15} />
                    <span>
                      {t('已登录为 {name}（{role}）。可以继续下一步。', {
                        name: liveMe.display_name,
                        role: ROLE_LABEL[liveMe.role],
                      })}
                    </span>
                  </div>
                ) : (
                  <>
                    {draft.mode === 'live' && showExisting ? (
                      <div className="form-stack">
                        <Field label={t('管理员邮箱')} htmlFor="exist-email">
                          <Input
                            id="exist-email"
                            type="email"
                            value={existing.email}
                            onChange={(e) => setExisting({ ...existing, email: e.target.value })}
                            autoComplete="username"
                          />
                        </Field>
                        <Field label={t('密码')} htmlFor="exist-pass">
                          <Input
                            id="exist-pass"
                            type="password"
                            value={existing.password}
                            onChange={(e) => setExisting({ ...existing, password: e.target.value })}
                            autoComplete="current-password"
                          />
                        </Field>
                        <div className="row gap-8">
                          <Button variant="secondary" onClick={loginExisting} loading={busy}>
                            {t('登录并继续')}
                          </Button>
                          <Button variant="quiet" onClick={() => setShowExisting(false)}>
                            {t('返回创建新账户')}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="form-stack">
                        <div className="form-grid">
                          <Field
                            label={t('显示名称')}
                            htmlFor="admin-name"
                            hint={t('会出现在文章署名和成员列表里。')}
                          >
                            <Input
                              id="admin-name"
                              value={draft.admin.display_name}
                              onChange={(e) => updateAdmin({ display_name: e.target.value })}
                              maxLength={120}
                              placeholder={t('例如：林知远')}
                              autoComplete="name"
                            />
                          </Field>
                          <Field label={t('邮箱')} htmlFor="admin-email" hint={t('登录凭据，也用于身份绑定。')}>
                            <Input
                              id="admin-email"
                              type="email"
                              value={draft.admin.email}
                              onChange={(e) => updateAdmin({ email: e.target.value })}
                              maxLength={320}
                              placeholder="you@example.com"
                              autoComplete="email"
                            />
                          </Field>
                          <Field label={t('密码')} htmlFor="admin-pass" hint={t('8–128 位。建议使用长口令。')}>
                            <Input
                              id="admin-pass"
                              type="password"
                              value={draft.admin.password}
                              onChange={(e) => updateAdmin({ password: e.target.value })}
                              autoComplete="new-password"
                            />
                          </Field>
                          <Field label={t('确认密码')} htmlFor="admin-confirm">
                            <Input
                              id="admin-confirm"
                              type="password"
                              value={draft.admin.confirm}
                              onChange={(e) => updateAdmin({ confirm: e.target.value })}
                              autoComplete="new-password"
                            />
                          </Field>
                        </div>
                        <div className="form-hint-row">
                          <span>
                            {draft.mode === 'demo'
                              ? t('演示模式：账户只保存在此浏览器，密码不会上传。')
                              : t('创建后会立即建立会话，并写入 Refresh Cookie。')}
                          </span>
                          {draft.mode === 'live' ? (
                            <button type="button" className="link-btn" onClick={() => setShowExisting(true)}>
                              {t('已有管理员账户？')}
                            </button>
                          ) : null}
                        </div>
                        <div>
                          <Button variant="secondary" onClick={registerAdmin} loading={busy}>
                            {draft.mode === 'demo' ? t('记录管理员账户') : t('创建管理员并继续')}
                          </Button>
                        </div>
                      </div>
                    )}
                  </>
                )}

                <Callout tone="info" icon="shield" title={t('权限在服务端强制校验')}>
                  {t('角色一旦建立，所有查询与写入都会检查站点、身份、资源所有权和角色。前端隐藏按钮只改善体验，不构成安全边界。')}
                </Callout>
              </div>
            </>
          ) : null}

          {step === 4 ? (
            <>
              <p className="wiz-eyebrow">Default site</p>
              <h1 className="wiz-title">{t('给站点起一个名字，然后开门。')}</h1>
              <p className="wiz-lede">
                {t('单站点模式下，访客不会看到「租户」或「站点选择」；这里创建的就是他们唯一会看到的网站。')}
              </p>

              <div className="wiz-content">
                <div className="form-stack">
                  <div className="form-grid">
                    <Field label={t('站点名称')} htmlFor="site-name" aside={`${draft.site.name.length}/160`}>
                      <Input
                        id="site-name"
                        value={draft.site.name}
                        onChange={(e) => updateSite({ name: e.target.value })}
                        maxLength={160}
                      />
                    </Field>
                    <Field
                      label={draft.mode === 'live' ? t('访问域名（选填）') : t('访问域名')}
                      htmlFor="site-domain"
                      hint={
                        draft.mode === 'live'
                          ? t('留空即可：单站点安装会自动匹配所有本机地址。填写自定义域名需要先完成域名验证，当前版本请留空。')
                          : t('公开访问时按域名解析站点，例如 press.example.com。')
                      }
                    >
                      <Input
                        id="site-domain"
                        value={draft.site.domain}
                        onChange={(e) => updateSite({ domain: e.target.value })}
                        placeholder={draft.mode === 'live' ? t('留空 = 自动') : 'press.example.com'}
                      />
                    </Field>
                  </div>

                  <Field
                    label={t('站点简介')}
                    htmlFor="site-desc"
                    aside={`${draft.site.description.length}/2000`}
                    hint={t('出现在首页与页脚。留空也可以。')}
                  >
                    <Textarea
                      id="site-desc"
                      value={draft.site.description}
                      onChange={(e) => updateSite({ description: e.target.value })}
                      maxLength={2000}
                      style={{ minHeight: 88 }}
                    />
                  </Field>

                  <Field label={t('站点路径（slug）')} hint={t('由安装时创建，创建后不可在此修改。')}>
                    <Input value={liveSite?.slug ?? (slugify(draft.site.name) || 'practacu')} readOnly disabled />
                  </Field>

                  <div>
                    <p className="field-label mb-8">{t('站点形态')}</p>
                    <div className="option-grid two">
                      {(['personal', 'community'] as const).map((kind) => (
                        <button
                          key={kind}
                          type="button"
                          className={`option${draft.site.kind === kind ? ' is-selected' : ''}`}
                          onClick={() =>
                            updateSite(
                              kind === 'personal'
                                ? { kind, visibility_mode: 'public', publish_mode: 'open' }
                                : { kind },
                            )
                          }
                          aria-pressed={draft.site.kind === kind}
                        >
                          <span className="option-icon">
                            <Icon name={kind === 'personal' ? 'user' : 'users'} size={16} />
                          </span>
                          <span className="option-body">
                            <strong>{SITE_KIND_LABEL[kind]}</strong>
                            <p>
                              {kind === 'personal'
                                ? t('只有站长一个账户。访客可以直接阅读，注册与登录入口关闭。')
                                : t('访客可以自助注册，登录后评论、收藏与投稿。')}
                            </p>
                          </span>
                          <span className="option-radio" />
                        </button>
                      ))}
                    </div>
                    {draft.site.kind === 'personal' ? (
                      <p className="field-hint mt-8">
                        {t('个人博客固定为公开阅读、直接发布：唯一作者无法审核自己的稿件，所以没有审核队列。')}
                      </p>
                    ) : null}
                  </div>

                  {draft.site.kind === 'community' ? (
                    <>
                      <div>
                        <p className="field-label mb-8">{t('访客模式')}</p>
                        <div className="option-grid two">
                          {(['public', 'members_only'] as const).map((mode) => (
                            <button
                              key={mode}
                              type="button"
                              className={`option${draft.site.visibility_mode === mode ? ' is-selected' : ''}`}
                              onClick={() => updateSite({ visibility_mode: mode })}
                              aria-pressed={draft.site.visibility_mode === mode}
                            >
                              <span className="option-icon">
                                <Icon name={mode === 'public' ? 'globe' : 'lock'} size={16} />
                              </span>
                              <span className="option-body">
                                <strong>{VISIBILITY_LABEL[mode]}</strong>
                                <p>
                                  {mode === 'public'
                                    ? t('未登录访客可以读已发布内容；草稿与审核队列仍然不可见。')
                                    : t('所有内容都要求登录。匿名请求会收到 401。')}
                                </p>
                              </span>
                              <span className="option-radio" />
                            </button>
                          ))}
                        </div>
                      </div>

                      <div>
                        <p className="field-label mb-8">{t('发布模式')}</p>
                        <div className="option-grid">
                          {(['open', 'review', 'role_based'] as const).map((mode) => (
                            <label
                              key={mode}
                              className={`setting-option${draft.site.publish_mode === mode ? ' is-selected' : ''}`}
                            >
                              <input
                                type="radio"
                                name="publish-mode"
                                checked={draft.site.publish_mode === mode}
                                onChange={() => updateSite({ publish_mode: mode })}
                              />
                              <span>
                                <strong>{PUBLISH_LABEL[mode]}</strong>
                                <p>
                                  {mode === 'open'
                                    ? t('成员可以直接发布，适合彼此信任的小团队。')
                                    : mode === 'review'
                                      ? t('成员提交后进入待审核，由编辑或管理员发布。')
                                      : t('普通成员需要审核；编辑与管理员可直接发布。')}
                                </p>
                              </span>
                            </label>
                          ))}
                        </div>
                      </div>
                    </>
                  ) : (
                    <div className="mini-list">
                      <div className="mini-row">
                        <span className="mini-label">{t('访客')}</span>
                        <span className="mini-value">{t('公开阅读 · 无需账户')}</span>
                      </div>
                      <div className="mini-row">
                        <span className="mini-label">{t('账户')}</span>
                        <span className="mini-value">{t('仅站长可登录 · 注册关闭')}</span>
                      </div>
                      <div className="mini-row">
                        <span className="mini-label">{t('发布')}</span>
                        <span className="mini-value">{t('直接发布 · 无审核队列')}</span>
                      </div>
                    </div>
                  )}
                </div>

                {draft.site.kind === 'personal' ? (
                  <Callout tone="info" icon="user" title={t('个人博客只保留一个账户')}>
                    {t('安装时创建的管理员就是站长。前台不再显示注册与登录按钮，注册页会直接关闭，登录页只接受站长邮箱。 连接真实后端时，注册端点由服务端控制；要彻底关闭，需要在网关或服务端禁止')}
                    <code className="mono"> POST /api/v1/register</code>
                    {t('。')}
                  </Callout>
                ) : (
                  <Callout tone="info" icon="info">
                    {t('这些规则保存后会立即生效。之后可以在「站点设置」里修改，所有变更都会写入审计记录。')}
                  </Callout>
                )}

              </div>
            </>
          ) : null}

          {step === 5 ? (
            <>
              <p className="wiz-eyebrow">Sign-in</p>
              <h1 className="wiz-title">{t('开门的方式，由你决定。')}</h1>
              <p className="wiz-lede">
                {draft.site.kind === 'personal'
                  ? t('个人博客只保留一个账户：注册关闭，邮箱与密码用于站长登录后台。手机验证码与第三方登录可以在这里打开，但登录页仍只接受站长账户。')
                  : t('邮箱与密码始终可用。手机验证码与第三方登录可以在这里直接选择并填写参数；密钥只写进服务端环境变量，不会保存在浏览器。')}
              </p>

              <div className="wiz-content">
                <div className="panel">
                  <div className="panel-body" style={{ paddingTop: 6, paddingBottom: 6 }}>
                    <div className="provider-row">
                      <span className="provider-icon">
                        <Icon name="mail" size={17} />
                      </span>
                      <span className="provider-body">
                        <strong>{t('邮箱与密码')}</strong>
                        <p>{t('Ed25519 JWT + HttpOnly Refresh Cookie + CSRF 双提交。')}</p>
                      </span>
                      <Badge tone="ok" dot>
                        {t('已启用')}
                      </Badge>
                    </div>

                    <AuthProvidersEditor
                      value={draft.auth}
                      onChange={(auth) => update('auth', auth)}
                      secrets={secrets}
                      onSecretChange={(id, secret) => setSecrets((prev) => ({ ...prev, [id]: secret }))}
                      idPrefix="setup-auth"
                      demo={draft.mode === 'demo'}
                    />
                  </div>
                </div>

                <Callout tone="info" icon="info" title={t('配置完成后会出现在登录页')}>
                  {t('填写完整的方式会显示在')} <code className="mono">/login</code>{' '}
                  {t('的邮箱表单下方。演示模式可以模拟这些入口； 连接真实后端时，需要服务端实现对应的短信或 OAuth 端点——契约 v0.1.0 尚未包含它们。')}
                </Callout>
              </div>
            </>
          ) : null}

          {step === 6 ? (
            <>
              <p className="wiz-eyebrow">Checks</p>
              <h1 className="wiz-title">{t('在开门之前，先绕房子走一圈。')}</h1>
              <p className="wiz-lede">
                {t('检查只读取健康端点与公开接口，不会修改数据。安全服务没有独立探针，它由发布与上传流程 fail-closed 验证。')}
              </p>

              <div className="wiz-content">
                <div className="check-list">
                  {checks.map((item) => (
                    <div
                      key={item.key}
                      className={`check-item ${item.status === 'ok' ? 'is-ok' : item.status === 'warn' ? 'is-warn' : item.status === 'fail' ? 'is-fail' : ''}`}
                    >
                      <span className="check-mark">
                        <Icon
                          name={
                            item.status === 'ok'
                              ? 'check'
                              : item.status === 'warn'
                                ? 'alert'
                                : item.status === 'fail'
                                  ? 'close'
                                  : 'clock'
                          }
                          size={12}
                        />
                      </span>
                      <span>
                        <strong>{item.label}</strong>
                        <p>{item.detail}</p>
                      </span>
                    </div>
                  ))}
                </div>

                <div className="row gap-8 mt-16">
                  <Button variant="secondary" onClick={() => void runChecks()} icon="refresh">
                    {t('重新检查')}
                  </Button>
                  <span className="field-hint">
                    {draft.mode === 'demo' ? t('演示模式') : normalizeOrigin(draft.apiBase) || window.location.origin}
                  </span>
                </div>

                {!canFinish ? (
                  <Callout tone="danger" icon="alert" title={t('还有会阻塞安装的检查')}>
                    {t('服务就绪或数据存储未通过。请先启动后端、执行迁移，或改用演示模式。')}
                  </Callout>
                ) : (
                  <Callout tone="ok" icon="check-circle" title={t('可以完成安装')}>
                    {t('完成后会写入站点配置并跳转到管理后台。管理员账户、站点规则与安装时间都会保留。')}
                  </Callout>
                )}

                <div className="mini-list mt-24">
                  <div className="mini-row">
                    <span className="mini-label">{t('管理员')}</span>
                    <span className="mini-value">
                      {draft.admin.display_name || liveMe?.display_name || '林知远'} ·{' '}
                      {draft.admin.email || 'admin@practacu.local'}
                    </span>
                  </div>
                  <div className="mini-row">
                    <span className="mini-label">{t('站点')}</span>
                    <span className="mini-value">{draft.site.name}</span>
                  </div>
                  <div className="mini-row">
                    <span className="mini-label">{t('数据库（记录）')}</span>
                    <span className="mini-value">
                      {draft.mode === 'live' ? t('由后端配置') : DB_LABEL[draft.database]}
                    </span>
                  </div>
                  <div className="mini-row">
                    <span className="mini-label">{t('模式')}</span>
                    <span className="mini-value">{draft.mode === 'demo' ? t('演示数据') : t('真实环境')}</span>
                  </div>
                </div>
              </div>
            </>
          ) : null}

          {error ? (
            <div className="mt-20">
              <Callout tone="danger" icon="alert" title={t('无法继续')}>
                {error}
              </Callout>
            </div>
          ) : null}

          <div className="wiz-foot">
            <span className="wiz-foot-note">
              {step === 0
                ? t('所有设置都可以在安装后修改。')
                : draft.mode === 'live' && step >= 3
                  ? t('第 {step} 步，共 {total} 步 · 数据库由后端配置', { step: step + 1, total: STEPS.length })
                  : t('第 {step} 步，共 {total} 步', { step: step + 1, total: STEPS.length })}
            </span>
            <div className="wiz-actions">
              {step > 0 ? (
                <Button variant="ghost" onClick={prev} icon="arrow-left" disabled={busy}>
                  {t('上一步')}
                </Button>
              ) : null}
              {step === 0 ? (
                <Button size="lg" onClick={() => go(1)} iconRight="arrow-right">
                  {t('开始配置')}
                </Button>
              ) : isLast ? (
                <Button size="lg" onClick={() => void next()} loading={busy} disabled={!canFinish} iconRight="check">
                  {t('完成安装')}
                </Button>
              ) : (
                <Button
                  size="lg"
                  onClick={() => void next()}
                  loading={busy}
                  disabled={draft.mode === 'live' && step === 1 && probe.state !== 'done'}
                  iconRight="arrow-right"
                >
                  {step === 3 && draft.mode === 'live' && !liveMe
                    ? showExisting
                      ? t('登录')
                      : t('创建管理员')
                    : t('继续')}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
