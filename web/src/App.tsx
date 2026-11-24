import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import { unstable_HistoryRouter as HistoryRouter, Navigate, Route, Routes } from 'react-router-dom';
import type { WebConfig } from './types';
import { BackendProvider, createBackend, clearConfig, isDemo, loadConfig, saveConfig, verifyInstall, INSTALL_RESET_KEY, type Backend } from './lib/backend';
import { bootstrapVisitorConfig } from './lib/visitorBootstrap';
import { accessController, isPreviewFrame, readAccess } from './lib/access';
import { configurePerformance, readPerformance } from './lib/performance';
import { adminPathOf, hasSiteConfigPatch } from './lib/siteConfig';
import {
  hydrateSiteConfig,
  scheduleSiteConfigSave,
  setActiveSiteConfigSaver,
  type SiteConfigHydrationResult,
  type SiteConfigSaveHandle,
} from './lib/siteConfigSync';
import { adminHistory, asRouterHistory } from './lib/adminPathRoute';
import { readCustomization } from './lib/customize';
import { setLocale, useT } from './lib/i18n';
import { AuthProvider } from './lib/session';
import { RealtimeProvider } from './lib/realtime';
import { ToastProvider } from './lib/toast';
import { StepUpProvider } from './components/StepUpModal';
import { siteKindOf } from './lib/site';
import {
  createRevisionStore,
  hydrateCustomization,
  scheduleCustomizationSave,
  type CustomizationSaveHandle,
  type HydrationResult,
  type RevisionStore,
} from './lib/customizationSync';
import { SetupPage } from './pages/Setup';
import { SiteChrome } from './components/SiteChrome';
import { AdminGate } from './components/AdminGate';
import { WriteGate } from './components/WriteShell';
import { CustomizationLayer } from './components/CustomizationLayer';
import { SiteSettingsLayer } from './components/SiteSettingsLayer';
import { DomainGuard } from './components/DomainGuard';
import { ProtectionLayer } from './components/ProtectionLayer';
import { LoadingLayer } from './components/LoadingLayer';
import { PjaxBridge } from './components/PjaxBridge';
import { AnalyticsTracker } from './components/AnalyticsTracker';
import { RequireAuth } from './components/Guards';
import { HomePage } from './pages/site/Home';
import { ArchivePage } from './pages/site/Archive';
import { CategoriesPage, CategoryPage, TagsPage, TagPage } from './pages/site/Taxonomy';
import { PublicPathRoute } from './pages/site/PublicPathRoute';
import { SearchPage } from './pages/site/SearchPage';
import { ProfilePage } from './pages/site/Profile';
import { MePage } from './pages/site/Me';
import { NotificationsPage } from './pages/site/Notifications';
import { MessagesPage } from './pages/site/Messages';
import { AuthPage } from './pages/site/Auth';
import { ForgotPasswordPage, ResetPasswordPage } from './pages/site/PasswordReset';
import { VerifyEmailPage } from './pages/site/VerifyEmail';
import { NewsletterActionPage } from './pages/site/NewsletterAction';
import { NotFoundPage } from './pages/NotFound';
import { DashboardPage } from './pages/admin/Dashboard';
import { ContentListPage } from './pages/admin/ContentList';
import { EditorPage } from './pages/admin/Editor';
import { SecurityPage } from './pages/admin/Security';
import { MembersPage } from './pages/admin/Members';
import { PermissionsPage } from './pages/admin/Permissions';
import { SettingsPage } from './pages/admin/Settings';
import { SiteUpdatePage } from './pages/admin/SiteUpdate';
import { LoginSettingsPage } from './pages/admin/LoginSettings';
import { AccessDomainsPage } from './pages/admin/AccessDomains';
import { PerformancePage } from './pages/admin/Performance';
import { StoragePage } from './pages/admin/Storage';
import { DataPage } from './pages/admin/Data';
import { PlatformSitesPage, PlatformSiteNewPage, PlatformSiteDetailPage } from './pages/admin/Platform';
import {
  PlatformAccountsPage,
  PlatformAuditPage,
  PlatformOverviewPage,
} from './pages/admin/PlatformOps';
import { VerificationPage } from './pages/admin/Verification';
import { LoadingPage } from './pages/admin/Loading';
import { TaxonomyPage } from './pages/admin/Taxonomy';
import { MediaPage } from './pages/admin/Media';
import { ActivityPage } from './pages/admin/Activity';
import { DocsPage } from './pages/admin/Docs';
import { RedirectsPage } from './pages/admin/Redirects';
import { NewsletterPage } from './pages/admin/Newsletter';
import { PagesPage } from './pages/admin/Pages';
import { PageEditorPage } from './pages/admin/PageEditor';
import { ThemesPage } from './pages/admin/Themes';
import { ChooseThemePage } from './pages/admin/ChooseTheme';
import { ExtensionsPage } from './pages/admin/Extensions';
import { SeoPage } from './pages/admin/Seo';
import { PageLoading } from './components/ui';
import { ExtensionBoot } from './components/ExtensionBoot';
import { AdminExtensionPage } from './components/AdminExtensionPage';
import { PreviewRouteLock } from './components/PreviewRouteLock';
import { ThemePreviewParamKeeper } from './components/ThemePreviewParamKeeper';
// 内置扩展（当前是性能面板）：导入即向 adminPageRegistry 注册后台页面，始终启用。
import './lib/extensions/builtin';

// 页面编排按需加载：它只在后台打开时下载，不进首屏 bundle。
const ThemeBuilderPage = lazy(() =>
  import('./pages/admin/ThemeBuilder').then((module) => ({ default: module.ThemeBuilderPage })),
);

export default function App() {
  const t = useT();
  // 一键启动带 ?mode=live：已有真实安装直接进入站点；否则强制走真实环境安装引导。
  // 这个判定要在初始化访客探测之前算出来：?mode=live 是站长的安装入口，不能被
  // 匿名访客引导接管。
  const forceLive =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('mode') === 'live';
  const [config, setConfig] = useState<WebConfig | null>(() => loadConfig());
  /**
   * O-1 匿名访客引导状态。
   *
   * 没有本地安装配置时先探测服务端（`/api/v1/setup/status`）：已安装且已有管理员
   * 就用服务端站点设计直接渲染站点，只有未安装 / 无管理员才进入 7 步安装引导。
   * 探测期间渲染加载页，避免已装站点对新访客闪一下安装引导。
   */
  const [visitorBoot, setVisitorBoot] = useState<'probing' | 'done'>(() =>
    loadConfig() || forceLive ? 'done' : 'probing',
  );

  // 页面编排器在父窗口写配置，预览 iframe 通过 storage 事件即时更新，
  // 不需要刷新即可看到主题/区块变化。
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== 'pp.web.config.v1') return;
      const next = loadConfig();
      if (next) {
        configRef.current = next;
        setConfig(next);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // O-1：本地没有安装配置（且不是 ?mode=live 安装回退）时，问一次服务端这台站点
  // 是否已经装好。探测与设计拉取都在 bootstrapVisitorConfig 里完成，失败返回 null，
  // 由下面的渲染分支回退到安装引导。
  useEffect(() => {
    if (visitorBoot !== 'probing') return;
    let alive = true;
    void bootstrapVisitorConfig()
      .catch(() => null)
      .then((boot) => {
        if (!alive) return;
        if (boot) {
          configRef.current = boot.config;
          setConfig(boot.config);
        }
        setVisitorBoot('done');
      });
    return () => {
      alive = false;
    };
  }, [visitorBoot]);

  // 一键启动带 ?mode=live：已有真实安装直接进入站点；否则强制走真实环境安装引导。
  const needsLiveSetup =
    forceLive && (!config || config.mode !== 'live' || !config.setup_complete);

  // 站点形态之类的本地配置变化不应重建后端实例：只按连接方式与地址取依赖。
  const mode = config?.mode;
  const apiBase = config?.api_base;
  const backend = useMemo(
    () => {
      if (!config) return null;
      const created = createBackend(config, () =>
        window.dispatchEvent(new CustomEvent('pp:session-expired')),
      );
      // 演示后端的角色判断需要知道站点形态；个人博客下所有账户按最高权限处理。
      if (isDemo(created)) created.setSiteKind(siteKindOf(config));
      return created;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, apiBase],
  );

  /**
   * 站点设计的跨设备同步状态。
   *
   * `syncBootRef` 记住这次安装的水合结果（StrictMode 下 effect 会跑两次，只能拉一次）；
   * `saveRef` 是编辑之后写回远端的防抖句柄。两者共享同一个 revision 单元。
   */
  const syncBootRef = useRef<{
    key: string;
    revisions: RevisionStore;
    hydration: Promise<HydrationResult>;
  } | null>(null);
  const saveRef = useRef<{ key: string; handle: CustomizationSaveHandle } | null>(null);

  /**
   * 站点级配置的跨设备同步状态。
   *
   * 与设计文档共享同一套 revision 单元的思路，但配置的「谁是读者」更重要：开屏那次
   * GET 可能早于会话恢复，拿到的只是公开子集；`pp:session-ready` 到达后要再拉一次，
   * 才能把登录方式、证书路径这些管理员字段换进来。
   */
  const siteConfigBootRef = useRef<{
    key: string;
    revisions: RevisionStore;
    hydration: Promise<SiteConfigHydrationResult | null>;
  } | null>(null);
  const siteConfigSaveRef = useRef<{ key: string; handle: SiteConfigSaveHandle } | null>(null);
  /** 水合写回期间不触发保存，否则刚拿到的远端内容会被原样写回去。 */
  const hydratingSiteConfigRef = useRef(false);
  /** 会话恢复后是不是站点管理员：决定要不要把本机设置首次搬到服务端。 */
  const canManageSiteRef = useRef(false);
  /** 已经做过一次「本机 → 服务端」的搬迁，避免每次刷新都重写。 */
  const siteConfigMigratedRef = useRef('');
  /** 会话就绪后的刷新入口；安装 effect 的回调通过它调用，避免依赖顺序问题。 */
  const refreshSiteConfigRef = useRef<(() => void) | null>(null);

  /**
   * 当前配置的同步副本。
   *
   * `applyConfig` 必须同步写 `localStorage`：保存句柄在防抖结束时从 `loadConfig()`
   * 读取最新值，等待 React 渲染再落盘会让「保存」读到上一版。
   */
  const configRef = useRef<WebConfig | null>(config);
  useEffect(() => {
    configRef.current = config;
  }, [config]);

  const applyConfig = useCallback((patch: Partial<WebConfig>) => {
    const prev = configRef.current;
    if (!prev) return;
    const next = { ...prev, ...patch };
    configRef.current = next;
    // 匿名访客的配置是探测出来的只读视图：不写回 localStorage，否则浏览器会把
    // 访客误当成"已安装"，后续刷新会走已安装浏览器的水合与回写路径。
    if (!next.visitor) saveConfig(next);
    setConfig(next);
    // 落在 customization 上的改动才需要回写服务端；防抖会把连续编辑合并成一次 PUT。
    // 保存时从 localStorage 取原始对象，所以这里只负责“叫一声”，不传数据。
    if (!hydratingSiteConfigRef.current) {
      if (patch.customization !== undefined) saveRef.current?.handle();
      // 访问限制 / 域名 / 性能 / 加载动画 / 登录方式 / 后台入口都是站点级配置，
      // 同样写回服务端；只写 localStorage 就是这次要修的「只有站长自己看到生效」。
      if (hasSiteConfigPatch(patch)) siteConfigSaveRef.current?.handle();
    }
  }, []);

  /** 水合写回：合并到本地缓存，但不回声保存。 */
  const writeSiteConfigPatch = useCallback(
    (patch: Partial<WebConfig>) => {
      hydratingSiteConfigRef.current = true;
      try {
        applyConfig(patch);
      } finally {
        hydratingSiteConfigRef.current = false;
      }
    },
    [applyConfig],
  );

  /**
   * 装上站点配置的写回句柄。
   *
   * localStorage 继续作为首屏缓存，服务端才是访客真正读到的事实来源。句柄装好之后
   * `applyConfig` 里任何 `access` / `domains` / `performance` / `loading` / `auth` /
   * `admin_path` 的改动都会被防抖写回服务端。
   */
  const installSiteConfigSaver = useCallback(
    (
      key: string,
      api: Backend,
      siteId: string,
      revisions: RevisionStore,
    ): SiteConfigSaveHandle => {
      const existing = siteConfigSaveRef.current;
      if (existing && existing.key === key) return existing.handle;
      existing?.handle.dispose();
      const handle = scheduleSiteConfigSave({
        read: loadConfig,
        api,
        siteId,
        revisions,
      });
      siteConfigSaveRef.current = { key, handle };
      setActiveSiteConfigSaver(handle);
      return handle;
    },
    [],
  );

  /** 远端还没有配置时，把本机已有的设置整体搬上去（只有站点管理员做）。 */
  const migrateLocalSiteConfig = useCallback(
    async (key: string, handle: SiteConfigSaveHandle) => {
      if (!canManageSiteRef.current) return;
      if (siteConfigMigratedRef.current === key) return;
      siteConfigMigratedRef.current = key;
      try {
        await handle.save();
      } catch {
        // 403（其实没有管理权限）/ 400（本机旧值已经越界）/ 断网都会走到这里。
        // 搬迁失败不该打扰站长：下一次在设置页保存时会再试一次。
        siteConfigMigratedRef.current = '';
      }
    },
    [],
  );

  // 个人博客下演示后端也按最高权限处理；真实后端由站点设置里的角色提升完成。
  const siteKind = config?.site_kind;
  const adminPath = adminPathOf(config ?? {});
  /**
   * 地址栏入口 ↔ 内部 `/admin` 的翻译层。
   *
   * 首次渲染时按本机缓存的入口决定初始映射（避免刷新后先闪一下 404），之后由
   * 下面的 layout effect 跟进服务端水合出来的入口变化。StrictMode 下取到的是同一个
   * 单例，不会换掉历史记录对象。
   */
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const history = useMemo(() => adminHistory(adminPath), []);
  useEffect(() => {
    if (backend && isDemo(backend) && siteKind) backend.setSiteKind(siteKindOf({ site_kind: siteKind }));
  }, [backend, siteKind]);

  // 后台入口是站点级配置：地址栏里的写法由历史记录翻译过去，内部路由永远是 /admin。
  // 放在 layout effect 里，保证「保存新入口」这一帧之后地址栏就跟着变。
  useLayoutEffect(() => {
    adminHistory().setAdminPath(adminPath);
  }, [adminPath]);

  // 设置保存后立刻同步给不在 React 树里的请求层与访问限制控制器。
  useLayoutEffect(() => {
    if (!config) return;
    accessController.configure(readAccess(config), config.admin_path);
    configurePerformance(readPerformance(config));
  }, [config]);

  // 站点语言也跟着站点设计走：安装引导完成、服务端水合两条路径都会落到这里，
  // 所以只需要在 config 变化时同步一次。放 layout effect 是为了在浏览器绘制之前
  // 就定下语言，避免英文站点闪一帧中文。
  useLayoutEffect(() => {
    if (!config) return;
    setLocale(readCustomization(config).language);
  }, [config]);

  // 本地配置说「装好了」，服务端却可能已经不认：data 目录被删、换了一份数据目录、
  // 或者数据库重建过。这时继续渲染站点只会得到一个空站点，安装引导再也进不去，
  // 所以先向服务端核实，确认失效就清配置、回到安装引导。
  //
  // 只按安装身份重新核实（模式 / 地址 / 站点），后台改设置不会重复发请求；
  // 只用 loadConfig() 取最新值，避免把整个 config 放进依赖。
  //
  // visitor 也进 key：平台控制台的站点交接会在目标源把一份匿名访客配置升级成
  // 站长配置（见 AuthProvider 的 pp_switch 处理）。站点 id 不变，但这一位变化必须
  // 触发本 effect，否则设计水合与写回永远不会开始。
  const installKey = config
    ? `${config.mode}|${config.api_base}|${config.site_id}|${config.visitor ? 'visitor' : 'owner'}`
    : '';
  useEffect(() => {
    if (!installKey) return;
    // 预览 iframe 与父窗口共用同一份配置：由父窗口负责判定与跳转。
    if (isPreviewFrame()) return;
    const current = loadConfig();
    if (!current || current.mode !== 'live') return;
    // 匿名访客的只读配置只存在内存里，不是一次安装：不校验、不水合、不回写。
    if (current.visitor) return;

    let alive = true;
    void verifyInstall(current).then((verdict) => {
      if (!alive) return;
      if (verdict === 'stale') {
        clearConfig();
        try {
          sessionStorage.setItem(INSTALL_RESET_KEY, '1');
        } catch {
          /* 无痕模式下提示丢失，不影响进入安装引导 */
        }
        // 整页重载而不是 setConfig(null)：路径、后端实例与主题都要按全新安装重新初始化。
        window.location.replace('/?mode=live');
        return;
      }
      if (!backend) return;

      // 安装校验通过：先取一次服务端设计（localStorage 继续作为首屏缓存），
      // 再把之后的每次编辑防抖写回去。演示模式永远不会走到这里。
      let boot = syncBootRef.current;
      if (!boot || boot.key !== installKey) {
        const revisions = createRevisionStore();
        boot = {
          key: installKey,
          revisions,
          hydration: hydrateCustomization({
            read: loadConfig,
            write: applyConfig,
            api: backend,
            siteId: current.site_id,
            revisions,
          }),
        };
        syncBootRef.current = boot;
      }
      const booted = boot;
      // hydrateCustomization 自己不会抛错；真抛了也不能挡住之后的保存。
      void booted.hydration
        .catch(() => null)
        .then(() => {
          if (syncBootRef.current !== booted) return;
          if (saveRef.current?.key === installKey) return;
          // 水合本身也走 applyConfig：等它落地之后再开写回，否则刚拿到的远端内容
          // 会被原样 PUT 回去，白白多一次写入和一次版本变化。
          saveRef.current?.handle.dispose();
          saveRef.current = {
            key: installKey,
            handle: scheduleCustomizationSave({
              read: loadConfig,
              api: backend,
              siteId: current.site_id,
              revisions: booted.revisions,
            }),
          };
        });

      // 站点级配置（访问限制 / 域名 / 性能 / 加载动画 / 登录方式 / 后台入口）同样先
      // 取一次服务端文档：管理员拿到完整文档，未登录时只有公开子集，会话恢复后再拉
      // 第二次（见下面的 `pp:session-ready`）。
      let siteBoot = siteConfigBootRef.current;
      if (!siteBoot || siteBoot.key !== installKey) {
        const revisions = createRevisionStore();
        siteBoot = {
          key: installKey,
          revisions,
          // 水合写回走 applyConfig 的「静默」入口：不回声保存，否则刚拿到的远端内容
          // 会被原样 PUT 回去，白白多一次写入和一次版本变化。
          hydration: hydrateSiteConfig({
            read: loadConfig,
            write: writeSiteConfigPatch,
            api: backend,
            siteId: current.site_id,
            revisions,
          }).catch(() => null),
        };
        siteConfigBootRef.current = siteBoot;
      }
      const siteBooted = siteBoot;
      void siteBooted.hydration.then((result) => {
        if (!alive || siteConfigBootRef.current !== siteBooted) return;
        const handle = installSiteConfigSaver(
          installKey,
          backend,
          current.site_id,
          siteBooted.revisions,
        );
        // 服务端还没有这份配置：把本机已有的设置整体搬上去，之后访客才读得到。
        // 只有确认是站点管理员才写，否则每次访客刷新都会收到一个 403。
        if (result?.status === 'absent') {
          void migrateLocalSiteConfig(installKey, handle);
        } else if (result?.scope === 'public' && canManageSiteRef.current) {
          // 会话比这次水合更早恢复：再拉一次，换成管理员范围。
          refreshSiteConfigRef.current?.();
        }
      });
    });
    return () => {
      alive = false;
      // 换站点 / 卸载时必须摘掉写回句柄，否则旧安装的编辑会写到新站点上。主题与
      // 站点配置各自持有一个防抖句柄；只清理其中一个，另一个仍会在 pagehide 或
      // 防抖到期时把新站点的内容写进旧站点。
      saveRef.current?.handle.dispose();
      saveRef.current = null;
      siteConfigSaveRef.current?.handle.dispose();
      siteConfigSaveRef.current = null;
      setActiveSiteConfigSaver(null);
    };
    // installKey 已包含模式与 API 地址；backend / applyConfig 只是随它一起变化，
    // 列出来是为了不让闭包抓到旧实例。
  }, [
    installKey,
    backend,
    applyConfig,
    writeSiteConfigPatch,
    installSiteConfigSaver,
    migrateLocalSiteConfig,
  ]);

  /**
   * 会话恢复之后再拉一次站点配置。
   *
   * 开屏那次 GET 往往还没登录，服务端只能给公开子集；管理员自己的浏览器需要完整
   * 文档（证书路径、CORS、网关参数、登录方式的 Client ID），否则设置页会显示默认值，
   * 一次「保存」就会把服务端的参数覆盖成空。
   */
  const refreshSiteConfigForSession = useCallback(() => {
    if (!installKey || !backend) return;
    const boot = siteConfigBootRef.current;
    if (!boot || boot.key !== installKey) return;
    const current = loadConfig();
    if (!current || current.mode !== 'live' || current.visitor) return;
    const revisions = boot.revisions;
    const hydration = hydrateSiteConfig({
      read: loadConfig,
      write: writeSiteConfigPatch,
      api: backend,
      siteId: current.site_id,
      revisions,
    }).catch(() => null);
    siteConfigBootRef.current = { key: installKey, revisions, hydration };
    void hydration.then((result) => {
      if (siteConfigBootRef.current?.hydration !== hydration) return;
      const handle = installSiteConfigSaver(installKey, backend, current.site_id, revisions);
      if (result?.status === 'absent') void migrateLocalSiteConfig(installKey, handle);
    });
  }, [installKey, backend, writeSiteConfigPatch, installSiteConfigSaver, migrateLocalSiteConfig]);

  // 供上面的安装 effect 回调使用：那时这个常量还没在源码里出现（依赖顺序）。
  useEffect(() => {
    refreshSiteConfigRef.current = refreshSiteConfigForSession;
  }, [refreshSiteConfigForSession]);

  useEffect(() => {
    const onSessionReady = (event: Event) => {
      const detail = (event as CustomEvent<{ authenticated?: boolean; canManageSite?: boolean }>)
        .detail;
      canManageSiteRef.current = detail?.canManageSite === true;
      if (detail?.authenticated !== true) return;
      refreshSiteConfigForSession();
    };
    window.addEventListener('pp:session-ready', onSessionReady);
    return () => window.removeEventListener('pp:session-ready', onSessionReady);
  }, [refreshSiteConfigForSession]);

  // 匿名访客引导还在探测服务端：先显示加载页，等结果再决定渲染站点还是安装引导。
  if (visitorBoot === 'probing') {
    return <PageLoading label={t('正在加载站点')} />;
  }

  if (!config || !backend || needsLiveSetup) {
    return (
      <ToastProvider>
        <SetupPage forceLive={forceLive} />
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <BackendProvider backend={backend}>
        {/* 扩展运行时：只启动一次，预览 iframe 跳过，失败不影响前台。 */}
        <ExtensionBoot />
        <AuthProvider config={config} backend={backend} onConfigChange={applyConfig}>
          {/* 高威胁操作二次验证：Provider 放在会话之内，弹窗按需覆盖当前页面。 */}
          <StepUpProvider>
          <RealtimeProvider>
          <SiteSettingsLayer>
          <CustomizationLayer>
          <HistoryRouter history={asRouterHistory(history)}>
            {/* 页面编排预览 iframe 的路由锁：预览只允许停在正在编排的那一页。 */}
            <PreviewRouteLock />
            {/* 主题真实预览：站内跳转后把预览令牌写回地址，刷新也不丢主题。 */}
            <ThemePreviewParamKeeper />
            <PjaxBridge />
            <DomainGuard>
            <ProtectionLayer>
            <LoadingLayer>
            <AnalyticsTracker demo={config.mode === 'demo'} />
            <Routes>
              <Route path="/setup" element={<SetupPage forceLive={forceLive} />} />

              <Route element={<SiteChrome />}>
                <Route index element={<HomePage />} />
                <Route path="articles" element={<ArchivePage kind="article" />} />
                <Route path="posts" element={<ArchivePage kind="post" />} />
                <Route path="categories" element={<CategoriesPage />} />
                <Route path="category/:slug" element={<CategoryPage />} />
                <Route path="tags" element={<TagsPage />} />
                <Route path="tag/:slug" element={<TagPage />} />
                <Route path="a/:id" element={<PublicPathRoute />} />
                <Route path="p/:id" element={<PublicPathRoute />} />
                <Route path="search" element={<SearchPage />} />
                <Route path="u/:id" element={<ProfilePage />} />
                <Route
                  path="me"
                  element={
                    <RequireAuth>
                      <MePage />
                    </RequireAuth>
                  }
                />
                <Route
                  path="me/:tab"
                  element={
                    <RequireAuth>
                      <MePage />
                    </RequireAuth>
                  }
                />
                <Route path="login" element={<AuthPage mode="login" />} />
                <Route path="register" element={<AuthPage mode="register" />} />
                <Route path="forgot-password" element={<ForgotPasswordPage />} />
                <Route path="reset-password" element={<ResetPasswordPage />} />
                <Route path="verify-email" element={<VerifyEmailPage />} />
                {/*
                  Beta 1.2：邮件订阅的双确认与退订链接落地页。两页都是公开的，
                  令牌从 query 读，所以不需要登录就能完成。
                */}
                <Route path="newsletter/confirm" element={<NewsletterActionPage mode="confirm" />} />
                <Route
                  path="newsletter/unsubscribe"
                  element={<NewsletterActionPage mode="unsubscribe" />}
                />
                <Route
                  path="notifications"
                  element={
                    <RequireAuth>
                      <NotificationsPage />
                    </RequireAuth>
                  }
                />
                <Route
                  path="messages"
                  element={
                    <RequireAuth>
                      <MessagesPage />
                    </RequireAuth>
                  }
                />
                <Route
                  path="messages/:id"
                  element={
                    <RequireAuth>
                      <MessagesPage />
                    </RequireAuth>
                  }
                />
                <Route path=":slug" element={<PublicPathRoute />} />
                <Route path="*" element={<PublicPathRoute />} />
              </Route>

              {/* 写作台：普通成员写稿的独立页面，不带任何后台导航。 */}
              <Route
                path="/write"
                element={
                  <RequireAuth>
                    <WriteGate />
                  </RequireAuth>
                }
              >
                <Route index element={<Navigate to="/write/new/article" replace />} />
                <Route path="new/:kind" element={<EditorPage />} />
                <Route path=":kind/:id" element={<EditorPage />} />
                <Route path="*" element={<Navigate to="/write/new/article" replace />} />
              </Route>

              <Route
                path="/admin"
                element={
                  <RequireAuth>
                    <AdminGate />
                  </RequireAuth>
                }
              >
                <Route index element={<DashboardPage />} />
                {/*
                  扩展注册的后台页面：内置性能面板与导入扩展共用这一条路由。
                  旧的 /admin/system 保留重定向，老书签/文档链接不会 404。
                */}
                <Route path="ext/:pageId" element={<AdminExtensionPage />} />
                <Route path="system" element={<Navigate to="/admin/ext/system" replace />} />
                <Route path="content" element={<ContentListPage />} />
                <Route path="content/new/:kind" element={<EditorPage />} />
                <Route path="content/:kind/:id" element={<EditorPage />} />
                <Route path="taxonomy" element={<TaxonomyPage />} />
                {/* 审核 / 举报 / 评论审核合并为信息安全中心；旧地址保留重定向。 */}
                <Route path="security" element={<SecurityPage />} />
                <Route path="review" element={<Navigate to="/admin/security?tab=review" replace />} />
                <Route path="comments" element={<Navigate to="/admin/security?tab=comments" replace />} />
                <Route path="reports" element={<Navigate to="/admin/security?tab=reports" replace />} />
                <Route path="media" element={<MediaPage />} />
                <Route path="pages" element={<PagesPage />} />
                <Route path="pages/new" element={<PageEditorPage />} />
                <Route path="pages/:id" element={<PageEditorPage />} />
                <Route path="themes" element={<ThemesPage />} />
                <Route path="themes/choose" element={<ChooseThemePage />} />
                {/* 外观并入「主题设置」，旧入口重定向到对应分区。 */}
                <Route path="appearance" element={<Navigate to="/admin/themes?tab=appearance" replace />} />
                <Route path="seo" element={<SeoPage />} />
                <Route
                  path="theme"
                  element={
                    <Suspense fallback={<PageLoading label={t('正在打开页面编排')} />}>
                      <ThemeBuilderPage />
                    </Suspense>
                  }
                />
                <Route path="extensions" element={<ExtensionsPage />} />
                <Route path="platform" element={<PlatformSitesPage />} />
                <Route path="platform/overview" element={<PlatformOverviewPage />} />
                <Route path="platform/audit" element={<PlatformAuditPage />} />
                <Route path="platform/users" element={<PlatformAccountsPage />} />
                <Route path="platform/new" element={<PlatformSiteNewPage />} />
                <Route path="platform/:siteId" element={<PlatformSiteDetailPage />} />
                <Route path="members" element={<MembersPage />} />
                <Route path="users" element={<MembersPage />} />
                <Route path="permissions" element={<PermissionsPage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="update" element={<SiteUpdatePage />} />
                <Route path="login-settings" element={<LoginSettingsPage />} />
                <Route path="access" element={<AccessDomainsPage />} />
                <Route path="domains" element={<Navigate to="/admin/access" replace />} />
                <Route path="performance" element={<PerformancePage />} />
                <Route path="storage" element={<StoragePage />} />
                <Route path="data" element={<DataPage />} />
                <Route path="verification" element={<VerificationPage />} />
                <Route path="loading" element={<LoadingPage />} />
                <Route path="activity" element={<ActivityPage />} />
                <Route path="docs" element={<DocsPage />} />
                {/* Beta 1.2 第二批：永久链接规则；访问洞察已并入仪表盘“访问记录”的弹窗。 */}
                <Route path="redirects" element={<RedirectsPage />} />
                <Route path="insights" element={<Navigate to="/admin?insights=1" replace />} />
                {/* 邮件订阅：名单、模板、投递日志与群发。 */}
                <Route path="newsletter" element={<NewsletterPage />} />
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Routes>
            </LoadingLayer>
            </ProtectionLayer>
            </DomainGuard>
          </HistoryRouter>
          </CustomizationLayer>
          </SiteSettingsLayer>
          </RealtimeProvider>
          </StepUpProvider>
        </AuthProvider>
      </BackendProvider>
    </ToastProvider>
  );
}
