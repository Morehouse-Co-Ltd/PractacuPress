import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type {
  AuthSettings,
  ProbeResult,
  Role,
  Site,
  SiteKind,
  WebConfig,
} from '../types';
import { HttpBackend, ApiError, normalizeOrigin } from '../lib/api';
import { INSTALL_RESET_KEY, saveConfig } from '../lib/backend';
import { SITE_KIND_LABEL } from '../lib/site';
import { passwordProblem, passwordProblemText } from '../lib/passwordPolicy';
import { installCustomization } from '../lib/customize';
import { DEFAULT_THEME } from '../lib/theme';
import {
  ADMIN_FONT_SCALE_MAX,
  ADMIN_FONT_SCALE_MIN,
  ADMIN_FONT_SCALE_STEP,
  DEFAULT_ADMIN_FONT_SCALE,
  adminFontPercent,
  normalizeAdminFontScale,
} from '../lib/adminFont';
import { DEFAULT_AUTH } from '../lib/authProviders';
import { errorText, useTitle } from '../lib/hooks';
import { LOCALES, normalizeLocale, setLocale, useT, type Locale } from '../lib/i18n';
import { currentPort, readRuntime, type RuntimeInfo } from '../lib/runtime';
import { PUBLISH_LABEL, ROLE_LABEL, VISIBILITY_LABEL, slugify } from '../lib/format';
import {
  Button,
  Callout,
  CopyButton,
  Field,
  Input,
  Textarea,
  Toggle,
} from '../components/ui';
import { Icon, type IconName } from '../components/Icon';

type Database = 'sqlite' | 'mysql' | 'postgres';

interface Draft {
  apiBase: string;
  database: Database;
  /** 站点语言：先决定界面语言，完成时写进站点设计。 */
  language: Locale;
  db: { host: string; port: string; name: string; user: string; password: string };
  admin: { email: string; display_name: string; password: string; confirm: string };
  /**
   * 高威胁操作保护：开关 + 可选的专用安全密码。
   *
   * 密码只在内存里走到保存请求；草稿持久化时会清空（和数据库/管理员密码一样），
   * 不会把口令写进 localStorage。
   */
  safety: { enabled: boolean; password: string; confirm: string };
  site: {
    name: string;
    domain: string;
    description: string;
    kind: SiteKind;
    visibility_mode: Site['visibility_mode'];
    publish_mode: Site['publish_mode'];
  };
  /**
   * 安装时顺手定的两套字号：后台界面倍率与前台正文字号。
   *
   * 后台倍率写进这台设备的安装配置（不进站点设计），前台字号写进站点主题的
   * `body_size`，之后都可以在后台继续调整。
   */
  fonts: { adminScale: number; siteBodySize: number };
}

function cloneAuth(source: AuthSettings): AuthSettings {
  return {
    phone: { ...source.phone },
    google: { ...source.google },
    github: { ...source.github },
    wechat: { ...source.wechat },
    qq: { ...source.qq },
    authenticator: { ...source.authenticator },
  };
}

const DRAFT_KEY = 'pp.setup.draft.v1';

/**
 * 安装阶段。首次运行只有真实环境：先等后端连上，再确定数据库、管理员、高威胁操作
 * 保护与站点规则。「连接后端」不是一个可跳过的选项，而是安装链路的第一段，所以它在
 * 进度里占一格。
 */
const STEPS = ['welcome', 'connect', 'database', 'admin', 'safety', 'site', 'fonts', 'checks'] as const;

type StepKey = (typeof STEPS)[number];

function defaultDraft(): Draft {
  return {
    apiBase: '',
    database: 'sqlite',
    language: 'zh-CN',
    db: { host: '127.0.0.1', port: '3306', name: 'practacu', user: 'practacu', password: '' },
    admin: { email: '', display_name: '', password: '', confirm: '' },
    safety: { enabled: true, password: '', confirm: '' },
    site: {
      name: 'Practacu Press',
      // 单站点安装默认留空：服务端会自动匹配本机地址；预填 localhost 反而会解析不到自己。
      domain: '',
      description: '一间小而安静的编辑部。写作者拥有自己的稿子，读者被当作邻居。',
      kind: 'community',
      visibility_mode: 'public',
      publish_mode: 'review',
    },
    fonts: {
      adminScale: DEFAULT_ADMIN_FONT_SCALE,
      siteBodySize: DEFAULT_THEME.body_size,
    },
  };
}

/** 前台正文字号的边界与步进，与「主题设置 → 正文栏宽」旁的滑杆保持一致。 */
const SITE_BODY_SIZE_MIN = 14;
const SITE_BODY_SIZE_MAX = 20;
const SITE_BODY_SIZE_STEP = 0.5;

/** 旧草稿没有字号字段、或手改越界时收敛到滑杆能表示的值。 */
function normalizeSiteBodySize(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_THEME.body_size;
  const clamped = Math.min(SITE_BODY_SIZE_MAX, Math.max(SITE_BODY_SIZE_MIN, numeric));
  return Math.round(clamped / SITE_BODY_SIZE_STEP) * SITE_BODY_SIZE_STEP;
}

function loadDraft(): Draft {
  const base = defaultDraft();
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return base;
    const saved = JSON.parse(raw) as Partial<Draft>;
    const site = { ...base.site, ...saved.site };
    // 旧草稿可能把安装时访问的 localhost 写了进去。真实环境只信任验证过的域名，
    // 这里清掉“当前地址”，让单站点安装走自动匹配。
    if (typeof window !== 'undefined') {
      const auto = [window.location.host, window.location.hostname].map((value) =>
        value.toLowerCase(),
      );
      if (site.domain && auto.includes(site.domain.trim().toLowerCase())) site.domain = '';
    }
    if (site.kind === 'personal') {
      site.visibility_mode = 'public';
      site.publish_mode = 'open';
    }
    return {
      ...base,
      ...saved,
      // 语言只认两个值：草稿被手改过或来自旧版本时回退简体中文。
      language: normalizeLocale(saved.language),
      db: { ...base.db, ...saved.db, password: '' },
      admin: { ...base.admin, ...saved.admin, password: '', confirm: '' },
      safety: { ...base.safety, ...saved.safety, password: '', confirm: '' },
      site,
      fonts: {
        adminScale: normalizeAdminFontScale(saved.fonts?.adminScale),
        siteBodySize: normalizeSiteBodySize(saved.fonts?.siteBodySize),
      },
    };
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
  // 安装向导固定是一张浅色纸面：浏览器里可能还留着上一次安装的深色主题变量，
  // 而向导里的语言切换、选项卡和检查项有硬编码的白底。给 <html> 打上 setup
  // 标记，让 theme.ts 输出一组固定的浅色令牌，避免白底上的浅色字。
  // 用 layout effect：标记必须在第一帧绘制前落下，否则会先闪一帧深色。
  useLayoutEffect(() => {
    const root = document.documentElement;
    const previous = root.dataset.surface;
    root.dataset.surface = 'setup';
    return () => {
      // 只在向导仍持有这个属性时还原。完成安装后跳转后台时，后台外壳已经接管了
      // data-surface；把 previous（可能是 site）写回去会让整个后台套上站点主题。
      if (root.dataset.surface !== 'setup') return;
      if (previous) root.dataset.surface = previous;
      else delete root.dataset.surface;
    };
  }, []);
  // 一键启动直接落在连接阶段；普通首次运行从欢迎页开始。
  // 一键启动直接落在连接阶段；普通首次运行从欢迎页开始。
  const [step, setStep] = useState(forceLive ? 1 : 0);
  const [draft, setDraft] = useState<Draft>(loadDraft);
  const [publicBaseURLConfigured, setPublicBaseURLConfigured] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // 创建管理员时用一块不可关闭的遮罩说明“正在写入”，避免慢请求看起来像没反应。
  const [creating, setCreating] = useState(false);
  // 阶段切换的方向决定卡片从下方还是上方滑入。
  const [direction, setDirection] = useState<'forward' | 'back'>('forward');
  const [probe, setProbe] = useState<{ state: 'idle' | 'checking' | 'done' | 'fail'; result?: ProbeResult; message?: string }>({
    state: 'idle',
  });
  // 自动等待后端时累计尝试次数：超过一轮才展开故障排查提示，避免一进来就吓人。
  const [attempts, setAttempts] = useState(0);
  const [liveMe, setLiveMe] = useState<{ user_id: string; display_name: string; role: Role; site_id: string } | null>(null);
  const [liveSite, setLiveSite] = useState<Site | null>(null);
  const [showExisting, setShowExisting] = useState(false);
  const [existing, setExisting] = useState({ email: '', password: '' });
  // 安装向导里的密码默认隐藏；每个输入区各有一个「查看密码 / 隐藏密码」开关，
  // 避免把已经输入的口令留在屏幕上。
  const [showAdminPassword, setShowAdminPassword] = useState(false);
  const [showExistingPassword, setShowExistingPassword] = useState(false);
  const [showDbPassword, setShowDbPassword] = useState(false);
  const [checks, setChecks] = useState<CheckItem[]>([
    { key: 'ready', label: t('服务就绪'), detail: t('等待检查'), status: 'wait' },
    { key: 'data', label: t('数据存储'), detail: t('等待检查'), status: 'wait' },
    { key: 'security', label: t('内置安全检查'), detail: t('等待检查'), status: 'wait' },
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
  /** 高威胁操作保护保存失败时允许跳过：安装不能被一个可选的安全设置卡死。 */
  const [safetySaveFailed, setSafetySaveFailed] = useState(false);
  /** 保护设置是否已经写入服务端；跳过之后完成安装时再做一次尽力而为的写入。 */
  const safetySavedRef = useRef(false);
  /** 已写入内容的指纹：来回翻页但没改动时不必再写一次（重复写入需要二次验证令牌）。 */
  const safetyFingerprintRef = useRef('');
  const liveRef = useRef<HttpBackend | null>(null);
  const probingRef = useRef(false);
  const errorRef = useRef<HTMLDivElement>(null);
  const [manualOpen, setManualOpen] = useState(false);
  // 程序托管的本机 API 信息；开发服务器与 npm start 没有这个接口，读不到就是 null。
  const [runtime, setRuntime] = useState<RuntimeInfo | null>(null);
  /**
   * 阶段卡片滚动区的真实状态。
   *
   * 底部渐隐只在「内容确实超过卡片高度」且「还没滚到底」时出现：内容是固定高度卡片里
   * 的一屏，最后一行不应该被白色渐变吃掉（第 4 步的提交说明、第 7 步的检查清单都中招
   * 过）。窄屏是整页滚动，此时滚动容器高度等于内容高度，不会误报。
   */
  const paneScrollRef = useRef<HTMLDivElement>(null);
  const [paneScroll, setPaneScroll] = useState({ scrollable: false, atBottom: true });

  useLayoutEffect(() => {
    const el = paneScrollRef.current;
    if (!el) return;
    const sync = () => {
      const scrollable = el.scrollHeight > el.clientHeight + 1;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 2;
      setPaneScroll((prev) =>
        prev.scrollable === scrollable && prev.atBottom === atBottom
          ? prev
          : { scrollable, atBottom },
      );
    };
    sync();
    el.addEventListener('scroll', sync, { passive: true });
    // 语言切换、展开故障排查、错误提示出现都会改变内容高度：两种观察者一起兜住。
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(sync);
    resize?.observe(el);
    const mutation = typeof MutationObserver === 'undefined' ? null : new MutationObserver(sync);
    mutation?.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      el.removeEventListener('scroll', sync);
      resize?.disconnect();
      mutation?.disconnect();
    };
  }, [step]);


  useEffect(() => {
    let alive = true;
    void readRuntime().then((info) => {
      if (alive) setRuntime(info);
    });
    return () => {
      alive = false;
    };
  }, []);

  // 服务端已配置 PUBLIC_BASE_URL 时不再显示“需要重启”的提示。
  useEffect(() => {
    let alive = true;
    const base = normalizeOrigin(draft.apiBase);
    fetch(`${base}/api/v1/setup/status`, {
      headers: { Accept: 'application/json' },
      credentials: 'include',
    })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { public_base_url_configured?: boolean } | null) => {
        if (alive) setPublicBaseURLConfigured(body?.public_base_url_configured === true);
      })
      .catch(() => {
        /* The warning is informational; a failed probe must not block setup. */
      });
    return () => {
      alive = false;
    };
  }, [draft.apiBase]);

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
      safety: { ...draft.safety, password: '', confirm: '' },
    };
    localStorage.setItem(DRAFT_KEY, JSON.stringify(safe));
  }, [draft]);

  useEffect(() => {
    if (step === STEPS.indexOf('checks')) void runChecks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  // 错误提示在卡片滚动区底部：出现时把它带进视野，避免用户以为按钮没反应。
  useEffect(() => {
    if (!error) return;
    errorRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [error]);

  const update = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((prev) => ({ ...prev, [key]: value }));

  const updateSite = (patch: Partial<Draft['site']>) =>
    setDraft((prev) => ({ ...prev, site: { ...prev.site, ...patch } }));

  const updateFonts = (patch: Partial<Draft['fonts']>) =>
    setDraft((prev) => ({
      ...prev,
      fonts: {
        adminScale: normalizeAdminFontScale(patch.adminScale ?? prev.fonts.adminScale),
        siteBodySize: normalizeSiteBodySize(patch.siteBodySize ?? prev.fonts.siteBodySize),
      },
    }));

  const updateAdmin = (patch: Partial<Draft['admin']>) =>
    setDraft((prev) => ({ ...prev, admin: { ...prev.admin, ...patch } }));

  const updateSafety = (patch: Partial<Draft['safety']>) =>
    setDraft((prev) => ({ ...prev, safety: { ...prev.safety, ...patch } }));

  const updateDb = (patch: Partial<Draft['db']>) =>
    setDraft((prev) => ({ ...prev, db: { ...prev.db, ...patch } }));

  const resetLive = () => {
    liveRef.current = null;
    setLiveMe(null);
    setLiveSite(null);
    setProbe({ state: 'idle' });
  };

  const go = (next: number) => {
    setError('');
    setDirection(next >= step ? 'forward' : 'back');
    setStep(next);
    // 窄屏是整页滚动：换阶段后回到卡片顶部，避免停在上一步的底部。
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

  /**
   * 连接阶段：没有找到后端时不报死，而是停在加载界面持续等待。
   * 同源与 127.0.0.1:8080 交替探测，成功一次就自动进入数据库设置。
   */
  useEffect(() => {
    if (step !== 1 || probe.state === 'done') return;
    let alive = true;
    let timer: number | undefined;
    const loop = async () => {
      if (!alive) return;
      const ok = await connectLive();
      if (!alive) return;
      setAttempts((count) => count + 1);
      if (ok) {
        go(2);
        return;
      }
      timer = window.setTimeout(loop, 3200);
    };
    void loop();
    return () => {
      alive = false;
      if (timer) window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const retryConnect = () => {
    void connectLive().then((ok) => {
      if (ok) go(2);
    });
  };

  const dsn = useMemo(() => {
    if (draft.database === 'sqlite') return 'file:./data/practacu.db';
    const scheme = draft.database === 'mysql' ? 'mysql' : 'postgres';
    const port = draft.db.port || (draft.database === 'mysql' ? '3306' : '5432');
    return `${scheme}://${draft.db.user || 'user'}:${draft.db.password || 'password'}@${draft.db.host || '127.0.0.1'}:${port}/${draft.db.name || 'practacu'}`;
  }, [draft.database, draft.db]);

  const envSnippet = `DATABASE_DRIVER=${draft.database}\nDATABASE_DSN=${dsn}`;

  const registerAdmin = async () => {
    setError('');
    const message = validate(3);
    if (message) {
      setError(message);
      return;
    }
    // 慢请求必须给出可见反馈：遮罩 + 旋转图标一直显示到服务端返回。
    setCreating(true);
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
      // 创建成功即进入站点设置，不再需要再点一次「继续」。
      go(4);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'conflict') {
        setShowExisting(true);
        setError(t('该邮箱已经注册。请改用「使用已有管理员账户登录」。'));
      } else {
        setError(errorText(err));
      }
    } finally {
      setBusy(false);
      setCreating(false);
    }
  };

  const loginExisting = async () => {
    setError('');
    const message = validate(3);
    if (message) {
      setError(message);
      return;
    }
    setCreating(true);
    setBusy(true);
    try {
      const backend = liveRef.current ?? new HttpBackend({ base: draft.apiBase, onExpired: () => undefined });
      liveRef.current = backend;
      await backend.login({ identifier: existing.email, password: existing.password });
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
      go(4);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
      setCreating(false);
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

  /**
   * 把高威胁操作保护写入服务端。
   *
   * 安装时是「首次配置」，后端允许免二次验证写入；保存失败不能阻塞安装：如实报错，
   * 用户可以重试，也可以跳过，稍后在站点设置里补上。
   */
  const safetyFingerprint = (): string =>
    JSON.stringify({ enabled: draft.safety.enabled, password: draft.safety.password });

  const saveSafety = async (): Promise<boolean> => {
    const backend = liveRef.current;
    if (!backend || !liveMe) return false;
    setBusy(true);
    setError('');
    try {
      await backend.saveStepUpSettings(liveMe.site_id, {
        enabled: draft.safety.enabled,
        ...(draft.safety.enabled && draft.safety.password
          ? { password: draft.safety.password }
          : {}),
      });
      safetySavedRef.current = true;
      safetyFingerprintRef.current = safetyFingerprint();
      setSafetySaveFailed(false);
      return true;
    } catch (err) {
      setSafetySaveFailed(true);
      setError(errorText(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  /** 安全设置是可选增强：保存失败时允许跳过，不阻塞完成安装。 */
  const skipSafety = () => {
    setSafetySaveFailed(false);
    setError('');
    go(5);
  };

  const validate = (index: number): string => {
    // 连接阶段由自动探测负责，没有需要手填的字段。
    if (index === 1) return '';
    if (index === 2 && draft.database !== 'sqlite') {
      if (!draft.db.host.trim()) return t('请填写数据库主机。');
      if (!draft.db.name.trim()) return t('请填写数据库名称。');
      if (!draft.db.user.trim()) return t('请填写数据库用户。');
      return '';
    }
    if (index === 3) {
      if (liveMe) return '';
      if (showExisting) {
        if (!isEmail(existing.email)) return t('请填写管理员邮箱。');
        if (!existing.password) return t('请填写密码。');
        return '';
      }
      if (!isEmail(draft.admin.email)) return t('请填写有效的邮箱地址。');
      if (!draft.admin.display_name.trim()) return t('请填写显示名称。');
      if (draft.admin.display_name.length > 120) return t('显示名称不能超过 120 个字符。');
      // 与后端同一套策略（12–128 位、至少两类字符、拒绝常见弱口令）；只查长度会让用户拿到一句
      // 笼统的「请求参数不符合要求」。
      const passwordIssue = passwordProblem(draft.admin.password);
      if (passwordIssue) return t(passwordProblemText(passwordIssue, t));
      if (draft.admin.password !== draft.admin.confirm) return t('两次输入的密码不一致。');
      return '';
    }
    if (index === 4) {
      // 专用安全密码是可选的：留空表示验证时使用账户登录密码。
      if (!draft.safety.enabled || !draft.safety.password) return '';
      if (draft.safety.password.length < 12) return t('专用安全密码至少 12 位。');
      if (draft.safety.password !== draft.safety.confirm) {
        return t('两次输入的安全密码不一致。');
      }
      return '';
    }
    if (index === 5) {
      if (!draft.site.name.trim()) return t('站点名称不能为空。');
      if (draft.site.name.length > 160) return t('站点名称不能超过 160 个字符。');
      if (draft.site.description.length > 2000) return t('站点简介不能超过 2000 个字符。');
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
      if (probe.state === 'done') {
        go(2);
        return;
      }
      // 连接阶段没有「继续」按钮；这里只处理手动点重试的情况。
      retryConnect();
      return;
    }
    if (step === 3 && !liveMe) {
      if (showExisting) await loginExisting();
      else await registerAdmin();
      return;
    }
    if (step === 4) {
      // 已经保存过且内容没变：直接前进，避免重复写入触发服务端的二次验证要求。
      if (
        safetySavedRef.current &&
        safetyFingerprintRef.current === safetyFingerprint()
      ) {
        go(5);
        return;
      }
      // 保存失败时停在安全检查页：错误提示里可以重试或跳过，不阻塞后续步骤。
      if (!(await saveSafety())) return;
      go(5);
      return;
    }
    if (step === 5) {
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
    if (step === STEPS.indexOf('checks')) {
      await complete();
      return;
    }
    go(step + 1);
  };

  const prev = () => {
    go(Math.max(0, step - 1));
  };

  const runChecks = async () => {
    const openapiUrl = `${normalizeOrigin(draft.apiBase)}/api/v1/openapi.json`;
    const nextChecks: CheckItem[] = [];
    const backend = liveRef.current ?? new HttpBackend({ base: draft.apiBase, onExpired: () => undefined });
    liveRef.current = backend;
    const result = await backend.probe().catch(() => null);
    nextChecks.push({
      key: 'ready',
      label: t('服务就绪'),
      detail: result ? `/api/healthz ${result.health} · /api/readyz ${result.ready}` : t('无法连接'),
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
      label: t('内置安全检查'),
      detail: t('安全检查已编译进 API 进程；发布与上传失败时按设计 fail-closed。'),
      status: 'ok',
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
      if (!liveMe) throw new Error(t('尚未完成管理员登录。'));
      // 用户在安全检查页选择「跳过」时，完成安装前再尽力写一次；失败不阻塞安装，
      // 也不会把用户困在向导里（站点设置里可以随时重新配置）。
      if (!safetySavedRef.current && liveRef.current) {
        try {
          await liveRef.current.saveStepUpSettings(liveMe.site_id, {
            enabled: draft.safety.enabled,
            ...(draft.safety.enabled && draft.safety.password
              ? { password: draft.safety.password }
              : {}),
          });
          safetySavedRef.current = true;
        } catch {
          /* 可选的安全设置写入失败时，安装照常完成。 */
        }
      }
      const config: WebConfig = {
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
        customization: installCustomization(draft.language, draft.fonts.siteBodySize),
        admin_font_scale: normalizeAdminFontScale(draft.fonts.adminScale),
        auth: cloneAuth(DEFAULT_AUTH),
      };
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

  const origin = normalizeOrigin(draft.apiBase) || window.location.origin;
  // 桌面 / localhost 用 http 访问时，服务端对绝对链接的默认假设（https）不成立。
  // PUBLIC_BASE_URL 指向站点前台的地址，所以取浏览器当前 origin；引导不能写服务端
  // 环境变量，因此把需要粘贴的那一行直接给出。
  const httpPublicBaseURL = (() => {
    if (typeof window === 'undefined') return '';
    if (window.location.protocol !== 'http:') return '';
    if (publicBaseURLConfigured) return '';
    return `PUBLIC_BASE_URL=${window.location.origin}`;
  })();

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
                {t('管理员账户与站点规则已写入服务端。下面的地址可以用来访问站点和接口文档。')}
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
                  <code>{`${origin}/api/v1`}</code>
                </div>
                <div className="address-card">
                  <span>{t('OpenAPI 文档')}</span>
                  <code>{`${origin}/api/v1/docs`}</code>
                </div>
              </div>

              <div className="mini-list mt-32" style={{ textAlign: 'left' }}>
                <div className="mini-row">
                  <span className="mini-label">{t('管理员')}</span>
                  <span className="mini-value">
                    {draft.admin.display_name || (liveMe?.display_name ?? '林知远')} ·{' '}
                    {showExisting ? existing.email : draft.admin.email || 'admin@practacu.local'}
                  </span>
                </div>
                <div className="mini-row">
                  <span className="mini-label">{t('数据库')}</span>
                  <span className="mini-value">{DB_LABEL[draft.database]}</span>
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
                  <span className="mini-label">{t('字号')}</span>
                  <span className="mini-value">
                    {t('后台 {admin} · 前台正文 {site} px', {
                      admin: `${adminFontPercent(draft.fonts.adminScale)}%`,
                      site: draft.fonts.siteBodySize,
                    })}
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
                <a
                  href={`${origin}/api/v1/docs`}
                  target="_blank"
                  rel="noreferrer"
                  className="btn btn-ghost btn-lg"
                >
                  {t('OpenAPI 文档')} <Icon name="external" size={14} />
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const stepLabel: Record<StepKey, string> = {
    welcome: t('欢迎'),
    connect: t('连接后端'),
    database: t('数据库'),
    admin: t('管理员'),
    safety: t('安全'),
    site: t('默认站点'),
    fonts: t('字体大小'),
    checks: t('检查与完成'),
  };
  const stepHint: Record<StepKey, string> = {
    welcome: t('从这里开始'),
    connect: t('等待本机 API'),
    database: 'SQLite / MySQL / PostgreSQL',
    admin: t('第一个账户'),
    safety: t('高威胁操作保护'),
    site: t('名称、域名与规则'),
    fonts: t('后台与前台字号'),
    checks: t('迁移、健康检查'),
  };
  const currentKey = STEPS[step];
  const prevKey = step > 0 ? STEPS[step - 1] : null;
  const nextKey = step < STEPS.length - 1 ? STEPS[step + 1] : null;
  const isLast = step === STEPS.length - 1;
  const connected = probe.state === 'done';
  const healthReady = checks.find((c) => c.key === 'ready')?.status === 'ok';
  const canFinish = checks.every((c) => c.status !== 'fail') && healthReady;

  return (
    <div className="wiz is-stage-page">
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
              {t('第 {step} 步，共 {total} 步', { step: step + 1, total: STEPS.length })}
              <span className="wiz-progress-sep" aria-hidden="true">
                {' · '}
              </span>
              <b>{stepLabel[currentKey]}</b>
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

      <div className="wiz-body is-stage">
        <aside className="wiz-rail">
          <div className="wiz-rail-inner">
            <p className="wiz-rail-label">{t('安装进度')}</p>
            <ol
              className="wiz-steps"
              style={{ '--wiz-ratio': step / (STEPS.length - 1) } as CSSProperties}
            >
              {STEPS.map((key, index) => (
                <li
                  key={key}
                  className={`wiz-step${index === step ? ' is-current' : ''}${index < step ? ' is-done' : ''}`}
                  aria-current={index === step ? 'step' : undefined}
                >
                  <span className="wiz-step-num">
                    {index < step ? <Icon name="check" size={11} /> : index + 1}
                  </span>
                  <span className="wiz-step-text">
                    <strong>{stepLabel[key]}</strong>
                    <span>{stepHint[key]}</span>
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
          <div className="wiz-stage">
            <div
              className={`wiz-peek is-prev${prevKey ? '' : ' is-empty'}${
                direction === 'back' ? ' is-back' : ''
              }`}
              aria-hidden="true"
            >
              {prevKey ? (
                <>
                  <span className="wiz-peek-arrow" aria-hidden="true">
                    <Icon name="arrow-up" size={12} />
                  </span>
                  <span className="wiz-peek-label">{stepLabel[prevKey]}</span>
                  <span className="wiz-peek-hint">{stepHint[prevKey]}</span>
                </>
              ) : null}
            </div>
            <div
              className={`wiz-pane is-${direction}`}
              key={step}
              role="group"
              aria-label={stepLabel[currentKey]}
            >
              <div
                className={`wiz-pane-scroll${paneScroll.scrollable && !paneScroll.atBottom ? ' is-more-below' : ''}`}
                ref={paneScrollRef}
              >
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
                  {t('接下来几步会连上后端、创建第一个管理员、设置高威胁操作保护，再创建默认站点和发布规则。所有选项之后都能在管理后台修改。')}
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
                    <b>{t('{count} 步', { count: STEPS.length })}</b>
                  </div>
                  <div>
                    <span>{t('契约')}</span>
                    <b>0.1.0</b>
                  </div>
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
            <div className="wiz-connect">
              <div className="wiz-connect-hero">
                <span className={`wiz-connect-orb${connected ? ' is-done' : ''}`}>
                  {connected ? <Icon name="check" size={24} /> : <span className="spinner" aria-hidden />}
                </span>
                <p className="wiz-eyebrow">Connection</p>
                <h1 className="wiz-title">{connected ? t('后端已经连上。') : t('正在等待后端链接')}</h1>
                <p className="wiz-lede">
                  {connected
                    ? t('健康检查已经通过，正在进入数据库设置。')
                    : t('正在尝试同源接口与本机 8080。启动后端后会自动继续，不需要手动操作。')}
                </p>
              </div>

              <div className="wiz-connect-body">
                <div className={`connect-card is-${probe.state}`}>
                  <span className="connect-mark">
                    {probe.state === 'checking' ? (
                      <span className="spinner" aria-hidden />
                    ) : (
                      <Icon
                        name={
                          probe.state === 'done'
                            ? 'check-circle'
                            : probe.state === 'fail'
                              ? 'x-circle'
                              : 'server'
                        }
                        size={18}
                      />
                    )}
                  </span>
                  <div className="connect-body">
                    <strong>
                      {probe.state === 'checking'
                        ? t('正在检测后端')
                        : probe.state === 'done'
                          ? t('已连接到后端')
                          : probe.state === 'fail'
                            ? probe.result?.health === 'ok'
                              ? t('后端已找到，等待数据库就绪')
                              : t('暂时没有找到后端')
                            : t('准备连接')}
                    </strong>
                    <p>
                      {probe.state === 'checking'
                        ? t('正在依次探测同源接口与本机 127.0.0.1:8080。')
                        : probe.state === 'done'
                          ? `${displayBase(draft.apiBase)} · healthz ${probe.result?.health} · readyz ${probe.result?.ready}`
                          : probe.state === 'fail'
                            ? probe.message ?? t('连接失败。')
                            : t('后端一旦可用，这里会自动继续。')}
                    </p>
                  </div>
                  <div className="connect-actions">
                    {connected ? (
                      <Button size="sm" onClick={() => go(2)} iconRight="arrow-right">
                        {t('继续')}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={retryConnect}
                        loading={probe.state === 'checking'}
                        icon="refresh"
                      >
                        {t('立即重试')}
                      </Button>
                    )}
                  </div>
                </div>

                {!connected ? (
                  <div className="wiz-wait-line">
                    <span className="spinner spinner-sm" aria-hidden />
                    <span>{t('已自动尝试 {count} 次，后端启动后会自动继续。', { count: attempts })}</span>
                  </div>
                ) : null}

                {!connected && attempts >= 2 ? (
                  <div className="mt-16">
                    {launcherLive ? (
                      <Callout tone="warn" icon="alert" title={t('本机 API 没有通过就绪检查')}>
                        {t('程序已经把 API 拉起来了，但接口还没准备好。程序窗口里有退出原因，完整日志在')}
                        <code className="mono"> {launcherApi?.log ?? 'data/api.err.log'}</code>
                        {t('。')}
                        {launcherApi?.error ? (
                          <pre className="connect-commands">{launcherApi.error}</pre>
                        ) : null}
                      </Callout>
                    ) : runtime ? (
                      <Callout tone="warn" icon="alert" title={t('这个程序没有运行本机 API')}>
                        {launcherApi?.error
                          ? t('程序尝试启动本机 API 失败了，原因如下：')
                          : t('程序以静态方式运行，没有找到 PractacuPress.exe，所以同源与 8080 都没有后端。')}
                        {launcherApi?.error ? (
                          <pre className="connect-commands">{launcherApi.error}</pre>
                        ) : (
                          <p>
                            {t('请使用完整的 Windows 压缩包重新解压（里面应同时有')}
                            <code className="mono"> PractacuPress.exe </code>
                            {t('与')}
                            <code className="mono"> PractacuPress.exe</code>
                            {t('），或按下面的命令手动启动 Go API。')}
                          </p>
                        )}
                        {launcherApi?.error ? null : (
                          <pre className="connect-commands">{`go run ./cmd/migrate
go run ./cmd/seed -driver sqlite -dsn ./data/practacu.db
go run ./cmd/server`}</pre>
                        )}
                      </Callout>
                    ) : (
                      <Callout tone="warn" icon="alert" title={t('后端还没有启动')}>
                        {t('前端会自动尝试同源与')} <code className="mono">http://127.0.0.1:8080</code>
                        {t('。在仓库根目录启动 Go API 后会自动连上；开发时用')}{' '}
                        <code className="mono">npm run dev</code>
                        {t('（')}
                        <code className="mono">/api</code>{' '}
                        {t('会代理到 8080），生产用同域反向代理。')}
                        <pre className="connect-commands">{`go run ./cmd/migrate
go run ./cmd/seed -driver sqlite -dsn ./data/practacu.db
go run ./cmd/server`}</pre>
                      </Callout>
                    )}
                  </div>
                ) : null}

                {!connected ? (
                  <div className="wiz-connect-tools">
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="settings"
                      onClick={() => setManualOpen((value) => !value)}
                    >
                      {manualOpen ? t('收起手动设置') : t('手动指定地址')}
                    </Button>
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
                          onClick={() => {
                            void connectLive([normalizeOrigin(draft.apiBase)]).then((ok) => {
                              if (ok) go(2);
                            });
                          }}
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
            </div>
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
                      aside={
                        <button
                          type="button"
                          className="link-btn"
                          aria-pressed={showDbPassword}
                          aria-controls="db-pass"
                          onClick={() => setShowDbPassword((value) => !value)}
                        >
                          {showDbPassword ? t('隐藏密码') : t('查看密码')}
                        </button>
                      }
                    >
                      <Input
                        id="db-pass"
                        type={showDbPassword ? 'text' : 'password'}
                        value={draft.db.password}
                        onChange={(e) => updateDb({ password: e.target.value })}
                        autoComplete="new-password"
                      />
                    </Field>
                    <Field label={t('字符集 / 时区')}>
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
                    <code className="mono"> go run ./cmd/migrate</code>
                    {t('。这段配置要重启 API 才会生效；安装引导只记录你的选择。')}
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
                    {showExisting ? (
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
                        <Field
                          label={t('密码')}
                          htmlFor="exist-pass"
                          aside={
                            <button
                              type="button"
                              className="link-btn"
                              aria-pressed={showExistingPassword}
                              aria-controls="exist-pass"
                              onClick={() => setShowExistingPassword((value) => !value)}
                            >
                              {showExistingPassword ? t('隐藏密码') : t('查看密码')}
                            </button>
                          }
                        >
                          <Input
                            id="exist-pass"
                            type={showExistingPassword ? 'text' : 'password'}
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
                          <Field
                            label={t('密码')}
                            htmlFor="admin-pass"
                            hint={t('12–128 位，且至少包含两类字符（小写、大写、数字、符号），不能是常见弱口令。建议使用长口令。')}
                            aside={
                              <button
                                type="button"
                                className="link-btn"
                                aria-pressed={showAdminPassword}
                                aria-controls="admin-pass admin-confirm"
                                onClick={() => setShowAdminPassword((value) => !value)}
                              >
                                {showAdminPassword ? t('隐藏密码') : t('查看密码')}
                              </button>
                            }
                          >
                            <Input
                              id="admin-pass"
                              type={showAdminPassword ? 'text' : 'password'}
                              value={draft.admin.password}
                              onChange={(e) => updateAdmin({ password: e.target.value })}
                              autoComplete="new-password"
                            />
                          </Field>
                          <Field label={t('确认密码')} htmlFor="admin-confirm">
                            <Input
                              id="admin-confirm"
                              type={showAdminPassword ? 'text' : 'password'}
                              value={draft.admin.confirm}
                              onChange={(e) => updateAdmin({ confirm: e.target.value })}
                              autoComplete="new-password"
                            />
                          </Field>
                        </div>
                        <div className="form-hint-row">
                          <span>{t('创建后会立即建立会话，并写入 Refresh Cookie。')}</span>
                          <button type="button" className="link-btn" onClick={() => setShowExisting(true)}>
                            {t('已有管理员账户？')}
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}

                {!liveMe ? (
                  <p className="wiz-submit-note">
                    {showExisting
                      ? t('填写已有的管理员账户后点「登录」，验证通过会自动进入下一步。')
                      : t('填好上面的信息后，点右下角「创建管理员」即可；创建过程会显示进度，完成后自动进入下一步。')}
                  </p>
                ) : null}
              </div>
            </>
          ) : null}

          {step === 4 ? (
            <>
              <p className="wiz-eyebrow">Safety</p>
              <h1 className="wiz-title">{t('给高危操作加一道门。')}</h1>
              <p className="wiz-lede">
                {t('删除用户、修改别人的账户、覆盖导入这类操作一旦点错就很难挽回。开启保护后，执行前需要再输入一次密码。')}
              </p>

              <div className="wiz-content">
                <div className="form-stack">
                  <Toggle
                    checked={draft.safety.enabled}
                    onChange={(next) => updateSafety({ enabled: next })}
                    label={t('开启高威胁操作保护')}
                    description={t('默认开启。关闭后，高危操作会直接执行，不再要求二次验证。')}
                  />
                  {draft.safety.enabled ? (
                    <>
                      <Field
                        label={t('专用安全密码（可选）')}
                        htmlFor="safety-password"
                        hint={t('留空则使用你的账户登录密码。设置后验证只接受这个专用密码；至少 12 位。')}
                      >
                        <Input
                          id="safety-password"
                          type="password"
                          value={draft.safety.password}
                          autoComplete="new-password"
                          onChange={(event) => updateSafety({ password: event.target.value })}
                        />
                      </Field>
                      <Field label={t('确认专用安全密码')} htmlFor="safety-password-confirm">
                        <Input
                          id="safety-password-confirm"
                          type="password"
                          value={draft.safety.confirm}
                          autoComplete="new-password"
                          onChange={(event) => updateSafety({ confirm: event.target.value })}
                        />
                      </Field>
                    </>
                  ) : null}
                </div>

                <Callout tone="info" icon="shield" title={t('这个设置之后可以修改')}>
                  {t('安装完成后，可以在「站点设置 → 高威胁操作保护」里开关保护、设置或清除专用密码。')}
                </Callout>

                {safetySaveFailed ? (
                  <div className="mt-16">
                    <Callout tone="warn" icon="alert" title={t('保护设置没有保存成功')}>
                      {t('可以重试；也可以先跳过这一步完成安装，之后在站点设置里重新配置。')}
                    </Callout>
                    <Button className="mt-12" variant="secondary" size="sm" onClick={skipSafety}>
                      {t('跳过这一步，稍后配置')}
                    </Button>
                  </div>
                ) : null}
              </div>
            </>
          ) : null}

          {step === 5 ? (
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
                      label={t('访问域名（选填）')}
                      htmlFor="site-domain"
                      hint={t('留空即可：单站点安装会自动匹配所有本机地址。填写自定义域名需要先完成域名验证，当前版本请留空。')}
                    >
                      <Input
                        id="site-domain"
                        value={draft.site.domain}
                        onChange={(e) => updateSite({ domain: e.target.value })}
                        placeholder={t('留空 = 自动')}
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
                        <div className="option-grid three">
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

          {step === 6 ? (
            <>
              <p className="wiz-eyebrow">Typography</p>
              <h1 className="wiz-title">{t('把字号调到看着舒服。')}</h1>
              <p className="wiz-lede">
                {t(
                  '后台是每天工作的地方，前台是读者阅读的地方：两套字号分开调整，互不影响。之后都可以在后台继续修改。',
                )}
              </p>

              <div className="wiz-content">
                <div className="wiz-font-grid">
                  <section className="wiz-font-card">
                    <div className="wiz-font-head">
                      <div>
                        <strong>{t('后台界面字号')}</strong>
                        <span>{t('管理后台的菜单、表单与列表')}</span>
                      </div>
                      <output>{adminFontPercent(draft.fonts.adminScale)}%</output>
                    </div>
                    <div className="wiz-font-preview is-admin">
                      <span
                        className="wiz-font-preview-strong"
                        style={{ fontSize: `${14 * draft.fonts.adminScale}px` }}
                      >
                        {t('媒体库')}
                      </span>
                      <span style={{ fontSize: `${11.5 * draft.fonts.adminScale}px` }}>
                        {t('仪表盘 · 内容库 · 媒体库 · 站点设置')}
                      </span>
                      <span style={{ fontSize: `${12 * draft.fonts.adminScale}px` }}>
                        {t('两步上传：先开会话，再传字节，最后由内置安全检查。')}
                      </span>
                    </div>
                    <input
                      className="wiz-font-range"
                      type="range"
                      min={ADMIN_FONT_SCALE_MIN * 100}
                      max={ADMIN_FONT_SCALE_MAX * 100}
                      step={ADMIN_FONT_SCALE_STEP * 100}
                      value={adminFontPercent(draft.fonts.adminScale)}
                      aria-label={t('后台界面字号')}
                      onChange={(event) =>
                        updateFonts({ adminScale: Number(event.target.value) / 100 })
                      }
                    />
                    <p className="field-hint">
                      {t('只影响这台电脑上的管理后台，不影响访客看到的页面。')}
                    </p>
                  </section>

                  <section className="wiz-font-card">
                    <div className="wiz-font-head">
                      <div>
                        <strong>{t('前台正文字号')}</strong>
                        <span>{t('文章与自定义页面的正文大小')}</span>
                      </div>
                      <output>{draft.fonts.siteBodySize} px</output>
                    </div>
                    <div className="wiz-font-preview is-article">
                      <span className="wiz-font-preview-strong">{t('独立出版的账本')}</span>
                      <p style={{ fontSize: `${draft.fonts.siteBodySize}px` }}>
                        {t('独立出版最浪漫的部分是「独立」，最不浪漫的部分是「出版」。')}
                      </p>
                      <span className="wiz-font-preview-meta">{t('约 3 分钟阅读')}</span>
                    </div>
                    <input
                      className="wiz-font-range"
                      type="range"
                      min={SITE_BODY_SIZE_MIN}
                      max={SITE_BODY_SIZE_MAX}
                      step={SITE_BODY_SIZE_STEP}
                      value={draft.fonts.siteBodySize}
                      aria-label={t('前台正文字号')}
                      onChange={(event) =>
                        updateFonts({ siteBodySize: Number(event.target.value) })
                      }
                    />
                    <p className="field-hint">
                      {t('影响文章与自定义页面的正文；之后可以在「主题设置 → 主题与版式」里继续调整。')}
                    </p>
                  </section>
                </div>

                <div className="mt-20">
                  <Callout tone="info" icon="info" title={t('两处字号互相独立')}>
                    {t('把后台调大一点更好点按；把前台调大一点更适合长文阅读。访客仍然可以用文章页右侧工具栏临时缩放。')}
                  </Callout>
                </div>
              </div>
            </>
          ) : null}

          {step === 7 ? (
            <>
              <h1 className="wiz-title">{t('在开门之前，先绕房子走一圈。')}</h1>
              <p className="wiz-lede">
                {t('检查只读取健康端点与公开接口，不会修改数据。安全检查已编译进 API 进程，发布与上传流程会验证它。')}
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
                    {normalizeOrigin(draft.apiBase) || window.location.origin}
                  </span>
                </div>

                {httpPublicBaseURL ? (
                  <div className="mt-20">
                    <Callout tone="warn" icon="alert" title={t('http 访问要显式设置 PUBLIC_BASE_URL')}>
                      {t('未设置时服务端会按 https 推导第三方登录回调等绝对链接；通知邮件里的站内地址也依赖它。当前站点通过 http 访问，请把这一行加进 API 的环境变量后重启：')}
                      <pre className="code-block mt-12">{httpPublicBaseURL}</pre>
                      <div className="row gap-8 mt-8">
                        <CopyButton value={httpPublicBaseURL} label={t('复制')} />
                      </div>
                    </Callout>
                  </div>
                ) : null}

                {!canFinish ? (
                  <Callout tone="danger" icon="alert" title={t('还有会阻塞安装的检查')}>
                    {t('服务就绪或数据存储未通过。请先启动后端并执行迁移，然后重新检查。')}
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
                      {showExisting ? existing.email : draft.admin.email || 'admin@practacu.local'}
                    </span>
                  </div>
                  <div className="mini-row">
                    <span className="mini-label">{t('站点')}</span>
                    <span className="mini-value">{draft.site.name}</span>
                  </div>
                  <div className="mini-row">
                    <span className="mini-label">{t('字号')}</span>
                    <span className="mini-value">
                      {t('后台 {admin} · 前台正文 {site} px', {
                        admin: `${adminFontPercent(draft.fonts.adminScale)}%`,
                        site: draft.fonts.siteBodySize,
                      })}
                    </span>
                  </div>
                  <div className="mini-row">
                    <span className="mini-label">{t('高威胁操作保护')}</span>
                    <span className="mini-value">
                      {draft.safety.enabled
                        ? safetySavedRef.current
                          ? draft.safety.password
                            ? t('已开启（专用安全密码）')
                            : t('已开启（账户登录密码）')
                          : t('已开启（稍后写入）')
                        : t('已关闭')}
                    </span>
                  </div>
                  <div className="mini-row">
                    <span className="mini-label">{t('数据库（记录）')}</span>
                    <span className="mini-value">{DB_LABEL[draft.database]}</span>
                  </div>
                </div>
              </div>
            </>
          ) : null}

          {error ? (
            <div className="mt-20" ref={errorRef}>
              <Callout tone="danger" icon="alert" title={t('无法继续')}>
                {error}
              </Callout>
            </div>
          ) : null}
              </div>

          {creating
            ? createPortal(
                <div
                  className="wiz-busy-layer"
                  role="dialog"
                  aria-modal="true"
                  aria-live="polite"
                  aria-label={showExisting ? t('正在登录管理员账户') : t('正在创建管理员')}
                >
                  <div className="wiz-busy-card">
                    <span className="spinner" aria-hidden />
                    <strong>{showExisting ? t('正在登录管理员账户') : t('正在创建管理员')}</strong>
                    <p>
                      {showExisting
                        ? t('正在验证账户并建立会话，请稍候。')
                        : t('正在写入账户与站点权限，请稍候。')}
                    </p>
                  </div>
                </div>,
                document.body,
              )
            : null}

          <div className="wiz-foot">
            <span className="wiz-foot-note">
              {step === 0
                ? t('所有设置都可以在安装后修改。')
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
              ) : step === 1 ? (
                connected ? (
                  <Button size="lg" onClick={() => go(2)} iconRight="arrow-right">
                    {t('继续')}
                  </Button>
                ) : null
              ) : isLast ? (
                <Button size="lg" onClick={() => void next()} loading={busy} disabled={!canFinish} iconRight="check">
                  {t('完成安装')}
                </Button>
              ) : (
                <Button size="lg" onClick={() => void next()} loading={busy} iconRight="arrow-right">
                  {step === 3 && !liveMe
                    ? showExisting
                      ? t('登录')
                      : t('创建管理员')
                    : t('继续')}
                </Button>
              )}
            </div>
          </div>
            </div>
            <div
              className={`wiz-peek is-next${nextKey ? '' : ' is-empty'}${
                direction === 'back' ? ' is-back' : ''
              }`}
              aria-hidden="true"
            >
              {nextKey ? (
                <>
                  <span className="wiz-peek-arrow" aria-hidden="true">
                    <Icon name="arrow-up" size={12} />
                  </span>
                  <span className="wiz-peek-label">{stepLabel[nextKey]}</span>
                  <span className="wiz-peek-hint">{stepHint[nextKey]}</span>
                </>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
