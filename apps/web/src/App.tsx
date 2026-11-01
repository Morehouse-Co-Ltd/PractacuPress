import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import type { WebConfig } from './types';
import { BackendProvider, createBackend, clearConfig, isDemo, loadConfig, saveConfig, verifyInstall, INSTALL_RESET_KEY } from './lib/backend';
import { accessController, isPreviewFrame, readAccess } from './lib/access';
import { configurePerformance, readPerformance } from './lib/performance';
import { readCustomization } from './lib/customize';
import { setLocale, useT } from './lib/i18n';
import { AuthProvider } from './lib/session';
import { ToastProvider } from './lib/toast';
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
import { CustomizationLayer } from './components/CustomizationLayer';
import { SiteSettingsLayer } from './components/SiteSettingsLayer';
import { DomainGuard } from './components/DomainGuard';
import { ProtectionLayer } from './components/ProtectionLayer';
import { LoadingLayer } from './components/LoadingLayer';
import { AnalyticsTracker } from './components/AnalyticsTracker';
import { RequireAuth } from './components/Guards';
import { HomePage } from './pages/site/Home';
import { ArchivePage } from './pages/site/Archive';
import { ContentDetailPage } from './pages/site/ContentDetail';
import { SearchPage } from './pages/site/SearchPage';
import { ProfilePage } from './pages/site/Profile';
import { NotificationsPage } from './pages/site/Notifications';
import { MessagesPage } from './pages/site/Messages';
import { AuthPage } from './pages/site/Auth';
import { ForgotPasswordPage, ResetPasswordPage } from './pages/site/PasswordReset';
import { NotFoundPage } from './pages/NotFound';
import { DashboardPage } from './pages/admin/Dashboard';
import { ContentListPage } from './pages/admin/ContentList';
import { EditorPage } from './pages/admin/Editor';
import { ReviewPage } from './pages/admin/Review';
import { MembersPage } from './pages/admin/Members';
import { PermissionsPage } from './pages/admin/Permissions';
import { CommentsPage } from './pages/admin/Comments';
import { SettingsPage } from './pages/admin/Settings';
import { LoginSettingsPage } from './pages/admin/LoginSettings';
import { AccessDomainsPage } from './pages/admin/AccessDomains';
import { PerformancePage } from './pages/admin/Performance';
import { StoragePage } from './pages/admin/Storage';
import { VerificationPage } from './pages/admin/Verification';
import { LoadingPage } from './pages/admin/Loading';
import { TaxonomyPage } from './pages/admin/Taxonomy';
import { MediaPage } from './pages/admin/Media';
import { ActivityPage } from './pages/admin/Activity';
import { DocsPage } from './pages/admin/Docs';
import { PagesPage } from './pages/admin/Pages';
import { PageEditorPage } from './pages/admin/PageEditor';
import { AppearancePage } from './pages/admin/Appearance';
import { ThemesPage } from './pages/admin/Themes';
import { ExtensionsPage } from './pages/admin/Extensions';
import { SeoPage } from './pages/admin/Seo';
import { CustomPage } from './pages/site/CustomPage';
import { PageLoading } from './components/ui';

// 页面编排按需加载：它只在后台打开时下载，不进首屏 bundle。
const ThemeBuilderPage = lazy(() =>
  import('./pages/admin/ThemeBuilder').then((module) => ({ default: module.ThemeBuilderPage })),
);

export default function App() {
  const t = useT();
  const [config, setConfig] = useState<WebConfig | null>(() => loadConfig());

  // 页面编排器在父窗口写配置，预览 iframe 通过 storage 事件即时更新，
  // 不需要刷新即可看到主题/区块变化。
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== 'pp.web.config.v1') return;
      const next = loadConfig();
      if (next) setConfig(next);
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const forceLive =
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).get('mode') === 'live';
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

  const applyConfig = useCallback((patch: Partial<WebConfig>) => {
    setConfig((prev) => {
      if (!prev) return prev;
      const next = { ...prev, ...patch };
      saveConfig(next);
      return next;
    });
    // 落在 customization 上的改动才需要回写服务端；防抖会把连续编辑合并成一次 PUT。
    // 保存时从 localStorage 取原始对象，所以这里只负责“叫一声”，不传数据。
    if (patch.customization !== undefined) saveRef.current?.handle();
  }, []);

  // 个人博客下演示后端也按最高权限处理；真实后端由站点设置里的角色提升完成。
  const siteKind = config?.site_kind;
  const adminPath = (config?.admin_path?.trim() || '/admin').replace(/\/+$/, '') || '/admin';
  useEffect(() => {
    if (backend && isDemo(backend) && siteKind) backend.setSiteKind(siteKindOf({ site_kind: siteKind }));
  }, [backend, siteKind]);

  // 设置保存后立刻同步给不在 React 树里的请求层与访问限制控制器。
  useLayoutEffect(() => {
    if (!config) return;
    accessController.configure(readAccess(config), config.admin_path);
    configurePerformance(readPerformance(config));
  }, [config]);

  // 站点语言也跟着站点设计走：安装完成、服务端水合、后台切换三条路径都会落到
  // 这里，所以只需要在 config 变化时同步一次。放 layout effect 是为了在浏览器
  // 绘制之前就定下语言，避免英文站点闪一帧中文。
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
  const installKey = config ? `${config.mode}|${config.api_base}|${config.site_id}` : '';
  useEffect(() => {
    if (!installKey) return;
    // 预览 iframe 与父窗口共用同一份配置：由父窗口负责判定与跳转。
    if (isPreviewFrame()) return;
    const current = loadConfig();
    if (!current || current.mode !== 'live') return;

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
    });
    return () => {
      alive = false;
    };
    // installKey 已包含模式与 API 地址；backend / applyConfig 只是随它一起变化，
    // 列出来是为了不让闭包抓到旧实例。
  }, [installKey, backend, applyConfig]);

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
        <AuthProvider config={config} backend={backend} onConfigChange={applyConfig}>
          <SiteSettingsLayer>
          <CustomizationLayer>
          <BrowserRouter>
            <DomainGuard>
            <ProtectionLayer>
            <LoadingLayer>
            <AnalyticsTracker demo={config.mode === 'demo'} />
            <Routes>
              <Route path="/setup" element={<SetupPage forceLive={forceLive} />} />
              {adminPath !== '/admin' ? (
                <Route path={adminPath} element={<Navigate to="/admin" replace />} />
              ) : null}

              <Route element={<SiteChrome />}>
                <Route index element={<HomePage />} />
                <Route path="articles" element={<ArchivePage kind="article" />} />
                <Route path="posts" element={<ArchivePage kind="post" />} />
                <Route path="a/:id" element={<ContentDetailPage kind="article" />} />
                <Route path="p/:id" element={<ContentDetailPage kind="post" />} />
                <Route path="search" element={<SearchPage />} />
                <Route path="u/:id" element={<ProfilePage />} />
                <Route path="login" element={<AuthPage mode="login" />} />
                <Route path="register" element={<AuthPage mode="register" />} />
                <Route path="forgot-password" element={<ForgotPasswordPage />} />
                <Route path="reset-password" element={<ResetPasswordPage />} />
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
                <Route path=":slug" element={<CustomPage />} />
                <Route path="*" element={<NotFoundPage />} />
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
                <Route path="content" element={<ContentListPage />} />
                <Route path="content/new/:kind" element={<EditorPage />} />
                <Route path="content/:kind/:id" element={<EditorPage />} />
                <Route path="taxonomy" element={<TaxonomyPage />} />
                <Route path="review" element={<ReviewPage />} />
                <Route path="comments" element={<CommentsPage />} />
                <Route path="media" element={<MediaPage />} />
                <Route path="pages" element={<PagesPage />} />
                <Route path="pages/new" element={<PageEditorPage />} />
                <Route path="pages/:id" element={<PageEditorPage />} />
                <Route path="themes" element={<ThemesPage />} />
                <Route path="appearance" element={<AppearancePage />} />
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
                <Route path="members" element={<MembersPage />} />
                <Route path="users" element={<MembersPage />} />
                <Route path="permissions" element={<PermissionsPage />} />
                <Route path="settings" element={<SettingsPage />} />
                <Route path="login-settings" element={<LoginSettingsPage />} />
                <Route path="access" element={<AccessDomainsPage />} />
                <Route path="domains" element={<Navigate to="/admin/access" replace />} />
                <Route path="performance" element={<PerformancePage />} />
                <Route path="storage" element={<StoragePage />} />
                <Route path="verification" element={<VerificationPage />} />
                <Route path="loading" element={<LoadingPage />} />
                <Route path="activity" element={<ActivityPage />} />
                <Route path="docs" element={<DocsPage />} />
                <Route path="*" element={<NotFoundPage />} />
              </Route>
            </Routes>
            </LoadingLayer>
            </ProtectionLayer>
            </DomainGuard>
          </BrowserRouter>
          </CustomizationLayer>
          </SiteSettingsLayer>
        </AuthProvider>
      </BackendProvider>
    </ToastProvider>
  );
}
