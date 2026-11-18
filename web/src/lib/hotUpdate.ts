import type { SiteUpdateSettings } from '../types';
import type { UpdateCheck } from './updateClient';

/**
 * 不停机更新的浏览器端基础代码。
 *
 * 背景：站点更新分两半——服务端把新构建换上去，浏览器把已经打开的这个页面换过去。
 * 服务端那一半（自动下载、校验、原子切换）还没实现，`POST /__pp/update/apply` 目前
 * 只接受本机已经解压好的构建目录；但**“换过去”这一半现在就可以用**，也就是这里：
 *
 * 1. 先预取新构建里页面要用的资源，预取失败就不换，旧页面继续正常工作；
 * 2. 记录滚动位置（以及“正在换版”的标记），让换版不像一次崩溃；
 * 3. 只在标签页空闲、用户没在输入时切换，绝不在编辑到一半时把人踢出去；
 * 4. 切换用普通刷新完成——服务端换版时没有停过进程，其他设备/访客的请求不受影响。
 *
 * 这里不依赖 React，所有副作用（存储、文档、刷新）都可注入，便于单测覆盖。
 */

/** 换版前保存的交接状态：滚动位置与目标版本。 */
export const HOT_SWAP_STATE_KEY = 'pp.hotUpdate.swap';

/** 已经切换到的构建版本，用于页面提示“已是最新”和排查。 */
export const HOT_BUILD_KEY = 'pp.hotUpdate.build';

export interface HotSwapState {
  /** 切换到的目标版本。 */
  version: string;
  /** 切换前的滚动位置（像素）。 */
  scrollY: number;
  /** 记录时间（毫秒时间戳）。 */
  at: number;
}

export interface HotSwapResult {
  status: 'swapped' | 'blocked' | 'failed';
  /** 预取失败或被拦下的原因（中文键，调用方套 `t()`）。 */
  reason?: string;
  /** 预取失败的资源地址。 */
  failed?: string[];
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type DocumentLike = Pick<Document, 'activeElement' | 'visibilityState' | 'defaultView'>;

const EDITABLE_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * 当前焦点是不是“用户正在写东西”的位置。
 *
 * 编辑器正文是 contenteditable，搜索框、表单字段是 input/textarea：只要焦点落在
 * 这些地方，换版就必须等一等，否则未保存的半句话会消失。
 */
export function isEditingElement(element: Element | null | undefined): boolean {
  if (!element) return false;
  const tag = (element.tagName ?? '').toUpperCase();
  if (EDITABLE_TAGS.has(tag)) return true;
  const editable = element as HTMLElement;
  if (editable.isContentEditable) return true;
  return typeof editable.closest === 'function'
    ? editable.closest('[contenteditable="true"]') !== null
    : false;
}

/**
 * 现在能不能切换版本。
 *
 * 三个条件：标签页可见（隐藏时刷新等于让用户回来看到一个不认识的页面）、没有正在
 * 输入的元素、调用方没有别的忙状态（例如正在上传）。
 */
export function canSwapNow(input: {
  doc?: DocumentLike | null;
  busy?: boolean;
} = {}): boolean {
  if (input.busy) return false;
  const doc = input.doc;
  if (!doc) return true;
  if (doc.visibilityState === 'hidden') return false;
  return !isEditingElement(doc.activeElement);
}

function safeStorage(storage: StorageLike | undefined | null): StorageLike | null {
  if (!storage) return null;
  try {
    const probe = '__pp_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    // 无痕模式或禁用存储：换版照常进行，只是不恢复滚动位置。
    return null;
  }
}

/**
 * 没显式给存储时用浏览器的 localStorage：换版交接状态要跨一次刷新，所以不能放内存。
 * 显式传 `null` 表示「这次不要碰存储」（测试或隐私场景）。
 */
function resolveStorage(storage: StorageLike | null | undefined): StorageLike | null {
  if (storage === null) return null;
  if (storage) return safeStorage(storage);
  if (typeof window === 'undefined') return null;
  try {
    return safeStorage(window.localStorage);
  } catch {
    return null;
  }
}

/** 记住换版前的滚动位置，切换后由 `restoreAfterSwap` 用。 */
export function captureSwapState(
  version: string,
  options: { storage?: StorageLike | null; scrollY?: number; now?: () => number } = {},
): HotSwapState {
  const scrollY =
    typeof options.scrollY === 'number'
      ? options.scrollY
      : typeof window !== 'undefined'
        ? window.scrollY
        : 0;
  const state: HotSwapState = {
    version,
    scrollY: Number.isFinite(scrollY) ? Math.max(0, Math.round(scrollY)) : 0,
    at: (options.now ?? Date.now)(),
  };
  const storage = resolveStorage(options.storage);
  if (storage) {
    try {
      storage.setItem(HOT_SWAP_STATE_KEY, JSON.stringify(state));
    } catch {
      /* 写不进去就只丢失滚动位置，不影响换版 */
    }
  }
  return state;
}

/** 读取并清除换版交接状态；没有或已损坏时返回 null。 */
export function takeSwapState(storage?: StorageLike | null): HotSwapState | null {
  const target = resolveStorage(storage);
  if (!target) return null;
  let raw: string | null = null;
  try {
    raw = target.getItem(HOT_SWAP_STATE_KEY);
    target.removeItem(HOT_SWAP_STATE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<HotSwapState>;
    if (typeof parsed?.version !== 'string' || !parsed.version) return null;
    const scrollY = typeof parsed.scrollY === 'number' && parsed.scrollY > 0 ? parsed.scrollY : 0;
    const at = typeof parsed.at === 'number' ? parsed.at : 0;
    return { version: parsed.version, scrollY, at };
  } catch {
    return null;
  }
}

/** 记下当前实际运行的构建版本，用来判断“是不是已经换过来了”。 */
export function rememberBuild(version: string, storage?: StorageLike | null): void {
  const target = resolveStorage(storage);
  if (!target) return;
  try {
    target.setItem(HOT_BUILD_KEY, version);
  } catch {
    /* 忽略 */
  }
}

/** 上一次记录到的构建版本；没有记录时返回空串。 */
export function currentBuild(storage?: StorageLike | null): string {
  const target = resolveStorage(storage);
  if (!target) return '';
  try {
    return target.getItem(HOT_BUILD_KEY) ?? '';
  } catch {
    return '';
  }
}

/**
 * 页面加载后恢复滚动位置。
 *
 * 换版本身是一次刷新，如果不恢复，用户会从文章顶部重新开始。只在交接状态里的版本
 * 与当前构建一致时恢复，避免把上一次失败尝试的位置套到另一次更新上。
 */
export function restoreAfterSwap(options: {
  currentVersion: string;
  storage?: StorageLike | null;
  win?: Pick<Window, 'scrollTo'> | null;
}): HotSwapState | null {
  const state = takeSwapState(options.storage);
  if (!state) return null;
  if (options.currentVersion && state.version !== options.currentVersion) return null;
  const win = options.win ?? (typeof window !== 'undefined' ? window : null);
  if (win && state.scrollY > 0) {
    try {
      win.scrollTo({ top: state.scrollY, behavior: 'auto' });
    } catch {
      /* 某些环境不支持带参数的 scrollTo，忽略即可 */
    }
  }
  return state;
}

/**
 * 预取新构建要用的资源。
 *
 * 用 `cache: 'reload'` 让浏览器真的去拿新文件（旧构建里同名资源可能已被缓存）；
 * 任何一个失败都不阻断其它请求，最终由调用方决定是否换版。失败的地址全部返回，
 * 页面可以据此提示“网络不稳，稍后再试”，而不是把用户带到一个半新半旧的页面。
 */
export async function prefetchUpdateAssets(
  assets: string[],
  options: { fetchImpl?: typeof fetch } = {},
): Promise<{ ok: string[]; failed: string[] }> {
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const ok: string[] = [];
  const failed: string[] = [];
  await Promise.all(
    uniqueAssets(assets).map(async (url) => {
      try {
        const res = await doFetch(url, { cache: 'reload', credentials: 'same-origin' });
        if (res.ok) ok.push(url);
        else failed.push(url);
      } catch {
        failed.push(url);
      }
    }),
  );
  return { ok, failed };
}

function uniqueAssets(assets: string[]): string[] {
  const seen = new Set<string>();
  const list: string[] = [];
  for (const asset of assets) {
    const value = typeof asset === 'string' ? asset.trim() : '';
    // 只接受同源相对路径：换版预取不该被清单带去抓第三方地址。
    if (!value || !value.startsWith('/') || value.startsWith('//')) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    list.push(value);
  }
  return list;
}

/**
 * 把已经打开的这个页面切到新构建。
 *
 * 流程：空闲检查 → 预取资源 → 记录滚动位置 → 刷新。任何一步不满足都不刷新，旧页面
 * 保持可用（这是“不停机”的底线：宁可晚一点换，也不要换到一半）。
 *
 * `assets` 来自服务端将来自动更新时给出的资源清单；现在手动切换只需刷新，传空数组。
 */
export async function applyHotUpdate(
  version: string,
  options: {
    assets?: string[];
    busy?: boolean;
    doc?: DocumentLike | null;
    storage?: StorageLike | null;
    fetchImpl?: typeof fetch;
    reload?: () => void;
  } = {},
): Promise<HotSwapResult> {
  const doc = options.doc ?? (typeof document !== 'undefined' ? document : null);
  if (!canSwapNow({ doc, busy: options.busy })) {
    return { status: 'blocked', reason: '当前正在输入或页面不可见，稍后再切换。' };
  }

  const assets = uniqueAssets(options.assets ?? []);
  if (assets.length > 0) {
    const { failed } = await prefetchUpdateAssets(assets, { fetchImpl: options.fetchImpl });
    if (failed.length > 0) {
      return { status: 'failed', failed, reason: '新版本的资源没有取全，已保持旧版本继续运行。' };
    }
  }

  captureSwapState(version, { storage: options.storage });
  rememberBuild(version, options.storage);
  const reload =
    options.reload ??
    (() => {
      if (typeof window !== 'undefined') window.location.reload();
    });
  reload();
  return { status: 'swapped' };
}

/**
 * 自动检查的调度间隔（毫秒）：来自设置里的「检查频率」。
 *
 * `startup` 返回 0，表示这一种只在打开后台时查一次，不排常驻定时器。
 */
export function autoCheckInterval(
  settings: Pick<SiteUpdateSettings, 'mode' | 'frequency' | 'channel'>,
  intervalFor: (frequency: SiteUpdateSettings['frequency']) => number,
): number {
  if (settings.mode !== 'auto') return 0;
  return intervalFor(settings.frequency);
}

/**
 * 判断一次检查结果是否需要提示用户。
 *
 * 已经提示过的同一个版本不重复打扰（`lastSeen` 来自设置里保存的远端版本），
 * 自动更新模式下发现新版本也只提示，不自动刷新页面。
 */
export function shouldAnnounce(
  check: UpdateCheck,
  localVersion: string,
  lastSeen?: string,
): boolean {
  if (!check.remote.version) return false;
  if (check.remote.version === localVersion) return false;
  if (lastSeen && lastSeen === check.remote.version) return false;
  return true;
}
