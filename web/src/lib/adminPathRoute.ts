import type { HistoryRouterProps } from 'react-router-dom';
import { DEFAULT_ADMIN_PATH, normalizeAdminPath } from './siteConfig';

/**
 * 后台入口地址的真实路由。
 *
 * 站长的后台入口是站点级配置（`admin_path`，默认 `/admin`）。改到 `/manage` 之后，
 * `/manage` 必须真的打开后台，`/admin` 必须真的打不开——否则「自定义入口」只是一句
 * 安慰话，任何人打 `/admin` 都能绕过。
 *
 * 难点在于后台源码里有 200 多处写死的 `/admin/...` 链接（导航、跳转、面包屑）。
 * 与其逐处改写，这里在历史记录层做一次路径翻译：
 *
 * - App 内部始终看到规范路径 `/admin/...`，所有既有路由、`NavLink` 高亮、
 *   `location.pathname` 判断都不用改；
 * - 地址栏显示的是配置后的入口（`/manage/...`）；
 * - 直接打开 `/admin`（入口已改）时，内部路径会被改写成一个不匹配任何后台路由的
 *   哨兵路径，于是渲染的是站点自己的 404，后台不会被绕过。
 *
 * 判定的关键差别是「谁在导航」：App 内部 push 的 `/admin/...` 一定是后台（那是代码
 * 里写死的规范路径），浏览器地址栏送来的 `/admin/...` 只有在它就是配置入口时才算后台。
 */

/** 后台在 App 内部使用的规范路径。 */
export const ADMIN_ROUTE = '/admin';

/**
 * 入口已改时，直接访问 `/admin` 落到的内部路径。
 *
 * 两段路径不会命中 `:slug`（那会去请求一个不存在的自定义页面），会落到前台的通配
 * 路由，渲染站点自己的 404：既不是后台，也不是「页面加载失败」。
 */
export const BLOCKED_ADMIN_ROUTE = '/__pp/unmatched-admin';

export type PathSource = 'app' | 'browser';

function isUnder(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

/** 配置里的入口；空值 / 非法值一律回退默认。 */
export function configuredAdminPath(value: unknown): string {
  const normalized = normalizeAdminPath(value);
  if (!normalized || normalized === '/') return DEFAULT_ADMIN_PATH;
  if (!normalized.startsWith('/') || /\s/.test(normalized)) return DEFAULT_ADMIN_PATH;
  return normalized;
}

/**
 * 把一条路径翻译成 App 内部使用的路径。
 *
 * `app` 来源是 `navigate('/admin/content')` 这类代码内部导航，`browser` 来源是地址栏
 * 或刷新后 `window.location` 给出的路径。
 */
export function toInternalPath(
  pathname: string,
  adminPath: string,
  source: PathSource,
): string {
  const admin = configuredAdminPath(adminPath);
  if (!pathname.startsWith('/')) return pathname;

  if (source === 'app') {
    if (isUnder(pathname, ADMIN_ROUTE)) return pathname;
    // 页面可能直接拿配置里的入口当链接（例如登录页的「进入管理后台」）。
    if (admin !== ADMIN_ROUTE && isUnder(pathname, admin)) {
      return ADMIN_ROUTE + pathname.slice(admin.length);
    }
    return pathname;
  }

  // 地址栏：只有配置的入口能进后台。
  if (isUnder(pathname, admin)) return ADMIN_ROUTE + pathname.slice(admin.length);
  if (admin !== ADMIN_ROUTE && isUnder(pathname, ADMIN_ROUTE)) return BLOCKED_ADMIN_ROUTE;
  return pathname;
}

/** 把 App 内部路径翻译成地址栏里应该出现的路径。 */
export function toBrowserPath(internalPathname: string, adminPath: string): string {
  const admin = configuredAdminPath(adminPath);
  if (!internalPathname.startsWith('/')) return internalPathname;
  if (isUnder(internalPathname, ADMIN_ROUTE)) {
    return admin + internalPathname.slice(ADMIN_ROUTE.length);
  }
  return internalPathname;
}

/* ------------------------------------------------------------------ *
 * 历史记录
 * ------------------------------------------------------------------ */

/** react-router v7 的 `<Router navigator>` 用到的最小形状。 */
export interface AdminHistoryLocation {
  pathname: string;
  search: string;
  hash: string;
  state: unknown;
  key: string;
}

export type AdminHistoryAction = 'POP' | 'PUSH' | 'REPLACE';

export interface AdminHistoryListenerArgs {
  action: AdminHistoryAction;
  location: AdminHistoryLocation;
}

export interface AdminHistoryTo {
  pathname?: string;
  search?: string;
  hash?: string;
}

export interface AdminHistory {
  action: AdminHistoryAction;
  location: AdminHistoryLocation;
  listen(listener: (args: AdminHistoryListenerArgs) => void): () => void;
  push(to: string | AdminHistoryTo, state?: unknown): void;
  replace(to: string | AdminHistoryTo, state?: unknown): void;
  go(delta: number): void;
  createHref(to: string | AdminHistoryTo): string;
  createURL(to: string | AdminHistoryTo): URL;
  encodeLocation(to: string | AdminHistoryTo): { pathname: string; search: string; hash: string };
  /** 配置里的入口变化之后重新对齐地址栏与内部路径。 */
  setAdminPath(next: string): void;
  /** 当前配置的入口（默认 `/admin`）。 */
  adminPath(): string;
}

interface ResolvedTarget {
  pathname: string;
  search: string;
  hash: string;
}

let keySeed = 0;

function nextKey(): string {
  keySeed += 1;
  return `pp-${Date.now().toString(36)}-${keySeed}`;
}

/** 拆分 `push('/admin/x?y=1#z')` 或 `{ pathname, search, hash }`。 */
export function resolveTarget(to: string | AdminHistoryTo, base?: AdminHistoryLocation): ResolvedTarget {
  if (typeof to === 'string') {
    let rest = to;
    let hash = '';
    const hashIndex = rest.indexOf('#');
    if (hashIndex >= 0) {
      hash = rest.slice(hashIndex);
      rest = rest.slice(0, hashIndex);
    }
    let search = '';
    const searchIndex = rest.indexOf('?');
    if (searchIndex >= 0) {
      search = rest.slice(searchIndex);
      rest = rest.slice(0, searchIndex);
    }
    return { pathname: rest || (base?.pathname ?? '/'), search, hash };
  }
  const pathname = to.pathname ?? base?.pathname ?? '/';
  const search = to.search ?? (to.pathname === undefined ? (base?.search ?? '') : '');
  const hash = to.hash ?? (to.pathname === undefined ? (base?.hash ?? '') : '');
  const normalizedSearch = search && !search.startsWith('?') ? `?${search}` : search;
  const normalizedHash = hash && !hash.startsWith('#') ? `#${hash}` : hash;
  return { pathname, search: normalizedSearch, hash: normalizedHash };
}

function readState(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return null;
  const stored = raw as { ppState?: unknown };
  return stored.ppState ?? null;
}

/**
 * 创建一条「地址栏显示配置入口、App 内部看到 /admin」的历史记录。
 *
 * 只在浏览器里调用；测试可以直接构造并断言翻译结果。
 */
export function createAdminHistory(
  initialAdminPath: string = DEFAULT_ADMIN_PATH,
  win: Window = window,
): AdminHistory {
  let admin = configuredAdminPath(initialAdminPath);
  const listeners = new Set<(args: AdminHistoryListenerArgs) => void>();

  const locationFromWindow = (): AdminHistoryLocation => ({
    pathname: toInternalPath(win.location.pathname, admin, 'browser'),
    search: win.location.search,
    hash: win.location.hash,
    state: readState(win.history.state),
    key: nextKey(),
  });

  let location = locationFromWindow();
  let action: AdminHistoryAction = 'POP';

  const emit = (nextAction: AdminHistoryAction) => {
    action = nextAction;
    for (const listener of Array.from(listeners)) {
      listener({ action, location });
    }
  };

  const urlOf = (target: ResolvedTarget, browserPathname: string): string =>
    `${browserPathname}${target.search}${target.hash}`;

  const navigate = (
    to: string | AdminHistoryTo,
    state: unknown,
    mode: 'push' | 'replace',
  ): void => {
    const target = resolveTarget(to, location);
    // 内部路径先归一，再换成地址栏里的写法：代码里的 /admin 与配置入口都通。
    const internal = toInternalPath(target.pathname, admin, 'app');
    const browserPathname = toBrowserPath(internal, admin);
    const url = urlOf(target, browserPathname);
    const historyState = { ppState: state ?? null, ppKey: nextKey() };
    try {
      if (mode === 'push') {
        win.history.pushState(historyState, '', url);
      } else {
        win.history.replaceState(historyState, '', url);
      }
    } catch {
      /* 地址栏不可写时仍然切换内部路由，页面之间照常导航 */
    }
    location = {
      pathname: internal,
      search: target.search,
      hash: target.hash,
      state: state ?? null,
      key: historyState.ppKey,
    };
    emit(mode === 'push' ? 'PUSH' : 'REPLACE');
  };

  const onPopState = () => {
    location = locationFromWindow();
    emit('POP');
  };
  win.addEventListener('popstate', onPopState);

  return {
    get action() {
      return action;
    },
    get location() {
      return location;
    },
    listen(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    push(to, state) {
      navigate(to, state, 'push');
    },
    replace(to, state) {
      navigate(to, state, 'replace');
    },
    go(delta) {
      if (delta !== 0) win.history.go(delta);
    },
    createHref(to) {
      const target = resolveTarget(to, location);
      const internal = toInternalPath(target.pathname, admin, 'app');
      return urlOf(target, toBrowserPath(internal, admin));
    },
    createURL(to) {
      const href = this.createHref(to);
      try {
        return new URL(href, win.location.href);
      } catch {
        return new URL(href, 'http://localhost');
      }
    },
    encodeLocation(to) {
      const target = resolveTarget(to, location);
      const internal = toInternalPath(target.pathname, admin, 'app');
      return {
        pathname: toBrowserPath(internal, admin),
        search: target.search,
        hash: target.hash,
      };
    },
    setAdminPath(next) {
      const value = configuredAdminPath(next);
      if (value === admin) return;
      admin = value;
      const showingAdmin = isUnder(location.pathname, ADMIN_ROUTE);
      const derived = toInternalPath(win.location.pathname, admin, 'browser');
      if (showingAdmin && !isUnder(derived, ADMIN_ROUTE)) {
        // 站长正在后台里改入口：地址栏换成新入口，页面不动（否则刚保存完就被踢出后台）。
        const url = `${toBrowserPath(location.pathname, admin)}${location.search}${location.hash}`;
        try {
          win.history.replaceState(win.history.state, '', url);
        } catch {
          /* 地址栏不可写时下一次导航会自然纠正 */
        }
        return;
      }
      if (derived === location.pathname) {
        // 路径没变，但地址栏可能还不符合新入口（例如刷新后配置才到）。
        const url = `${toBrowserPath(location.pathname, admin)}${location.search}${location.hash}`;
        try {
          win.history.replaceState(win.history.state, '', url);
        } catch {
          /* 同上 */
        }
        return;
      }
      location = { ...location, pathname: derived, key: nextKey() };
      try {
        win.history.replaceState(
          win.history.state,
          '',
          `${toBrowserPath(derived, admin)}${location.search}${location.hash}`,
        );
      } catch {
        /* 同上 */
      }
      emit('REPLACE');
    },
    adminPath() {
      return admin;
    },
  };
}

let singleton: AdminHistory | null = null;
/**
 * App 唯一的实例：StrictMode 双次渲染下也不能换掉历史记录对象。
 *
 * 首次创建时用本机缓存的入口决定初始映射，避免刷新后先闪一下 404；之后的入口变化
 * 由 `setAdminPath` 跟进。
 */
export function adminHistory(initialAdminPath?: string): AdminHistory {
  if (!singleton) singleton = createAdminHistory(initialAdminPath ?? DEFAULT_ADMIN_PATH);
  return singleton;
}

/**
 * 交给 `<unstable_HistoryRouter>` 用。
 *
 * react-router 的 `History` 接口把 `action` 声明成它自己的字符串枚举，而枚举类型
 * 没有导出给使用方；运行时的值就是 `'POP' | 'PUSH' | 'REPLACE'` 三个字符串，所以这里
 * 只做一次类型层面的收窄。
 */
export function asRouterHistory(history: AdminHistory): HistoryRouterProps['history'] {
  return history as unknown as HistoryRouterProps['history'];
}
