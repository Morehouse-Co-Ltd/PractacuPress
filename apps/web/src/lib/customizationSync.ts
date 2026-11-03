import type { SiteCustomization, WebConfig } from '../types';
import type { SiteCustomizationSaved, SiteCustomizationSnapshot } from './api';
import { readCustomization, sanitizeCustomCss } from './customize';

/**
 * 站点设计的服务端同步。
 *
 * 设计（主题、布局、页面、区块、自定义 CSS、置顶、封面、SEO）原本只存在浏览器
 * localStorage 的 `pp.web.config.v1.customization` 里，换一个浏览器或换一个访客就
 * 会退回内置默认外观，页面编排出来的页面还会 404。这里把 localStorage 当作“首屏
 * 立即绘制的离线缓存”，服务端副本才是跨设备、跨访客的事实来源：
 *
 * - `hydrateCustomization`：开屏拉一次远端设计，用 `readCustomization` 归一化后写回
 *   本地缓存；404 / 401 / 403 / 断网一律静默失败，继续用本地缓存，绝不阻塞开屏。
 * - `scheduleCustomizationSave`：编辑之后尾随防抖写回远端，携带最后看到的 revision
 *   做乐观并发控制；冲突、越权、超限都不能把错误抛到界面上。
 *
 * 这个模块不依赖 React：读、写、网络与定时器全部从参数注入，方便单测。
 */

/** 尾随防抖窗口：一次编辑常连着几次写入（拖动滑块、改色值、连续调区块）。 */
export const SAVE_DEBOUNCE_MS = 800;

export interface CustomizationSyncLogger {
  warn(message: string, detail?: unknown): void;
}

/** 服务端存档的静默失败只写控制台，不弹提示：设计没同步不等于用户操作失败。 */
export const consoleSyncLogger: CustomizationSyncLogger = {
  warn(message, detail) {
    if (typeof console === 'undefined') return;
    if (detail === undefined) console.warn(`[站点设计] ${message}`);
    else console.warn(`[站点设计] ${message}`, detail);
  },
};

/** 同步只用到这两个后端方法；测试里注入假实现，不接触真实网络。 */
export interface CustomizationApi {
  siteCustomization(siteId: string): Promise<SiteCustomizationSnapshot | null>;
  saveSiteCustomization(
    siteId: string,
    customization: unknown,
    revision?: number,
  ): Promise<SiteCustomizationSaved>;
}

/* ------------------------------------------------------------------ *
 * revision 单元
 * ------------------------------------------------------------------ */

/**
 * 最后看到的服务端版本号。
 *
 * 拉取与保存是两个入口，必须共享同一份版本号：否则保存要么漏带 revision
 * （无条件覆盖别人的修改），要么永远带着开屏时的旧版本（不停 409）。
 */
export interface RevisionStore {
  get(): number | null;
  set(revision: number | null): void;
}

export function createRevisionStore(initial: number | null = null): RevisionStore {
  let value = initial;
  return {
    get: () => value,
    set: (next) => {
      value = next;
    },
  };
}

/**
 * 从后端错误里取 HTTP 状态码。
 *
 * 真实客户端抛的是 `ApiError`（状态在 `problem.status` 上），测试或未来的客户端
 * 可能直接挂 `status`；两者都认，取不到就当作网络失败（0）。
 */
export function statusOfError(error: unknown): number {
  if (!error || typeof error !== 'object') return 0;
  const problem = (error as { problem?: unknown }).problem;
  if (problem && typeof problem === 'object') {
    const status = (problem as { status?: unknown }).status;
    if (typeof status === 'number') return status;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/* ------------------------------------------------------------------ *
 * 开屏水合
 * ------------------------------------------------------------------ */

export type HydrationStatus =
  /** 远端有设计，已归一化写回本地。 */
  | 'applied'
  /** 404：远端还没有设计，本地继续用。 */
  | 'absent'
  /** 401：站点仅成员可见且未登录。 */
  | 'unauthorized'
  /** 403：当前路径不是这个站点，或没有管理权限。 */
  | 'forbidden'
  /** 断网、5xx 或远端内容无法识别。 */
  | 'unavailable';

export interface HydrationResult {
  status: HydrationStatus;
  /** 远端版本号；`absent` 时为 null。 */
  revision: number | null;
  /** 实际写回本地的设计；没有应用远端内容时为 null（本地保持不变）。 */
  customization: SiteCustomization | null;
}

export interface HydrateCustomizationOptions {
  /** 读取当前本地配置（离线缓存）。 */
  read: () => WebConfig | null;
  /** 把远端设计写回本地配置；由调用方合并并持久化。 */
  write: (patch: Partial<WebConfig>) => void;
  api: CustomizationApi;
  siteId: string;
  /** 当前内存里的配置文档；省略时用 `read()` 取。 */
  doc?: WebConfig | null;
  /** 与 `scheduleCustomizationSave` 共享的版本号单元。 */
  revisions?: RevisionStore;
  logger?: CustomizationSyncLogger;
}

/**
 * 拉取远端设计并写回本地缓存。
 *
 * 永远不抛错、永远不阻塞开屏：任何失败都只是“这次没能拿到远端设计”，本地缓存
 * 照常渲染。只有拿到可识别的远端文档时才覆盖本地——远端存了坏数据时宁可显示
 * 本地设计，也不能把站点清成默认外观。
 */
export async function hydrateCustomization(
  options: HydrateCustomizationOptions,
): Promise<HydrationResult> {
  const { read, write, api, siteId } = options;
  const revisions = options.revisions ?? createRevisionStore();
  const logger = options.logger ?? consoleSyncLogger;
  const local = options.doc ?? read();
  // 配置已经被清掉（安装重置 / 换安装）时不要写回，否则会把旧设计带到新站点上。
  if (!local) return { status: 'unavailable', revision: revisions.get(), customization: null };

  let remote: SiteCustomizationSnapshot | null;
  try {
    remote = await api.siteCustomization(siteId);
  } catch (error) {
    const status = statusOfError(error);
    if (status === 401 || status === 403) {
      // 成员站点未登录、或域名解析到别的站点：静默用本地缓存，不打扰访客。
      logger.warn('读取站点设计被拒绝，继续使用本地缓存。', status);
      return {
        status: status === 401 ? 'unauthorized' : 'forbidden',
        revision: revisions.get(),
        customization: null,
      };
    }
    logger.warn('读取站点设计失败，继续使用本地缓存。', error);
    return { status: 'unavailable', revision: revisions.get(), customization: null };
  }

  if (!remote) {
    // 404：远端从未保存过设计。本地缓存不动，下一次编辑会建立远端副本。
    return { status: 'absent', revision: null, customization: null };
  }

  if (!isPlainObject(remote.customization)) {
    // 远端存了一个非对象：不覆盖本地，但记下版本号，下一次保存可以正常覆盖它。
    revisions.set(typeof remote.revision === 'number' ? remote.revision : null);
    logger.warn('远端站点设计格式无法识别，保留本地缓存。');
    return { status: 'unavailable', revision: revisions.get(), customization: null };
  }

  // 必须走既有的归一化器：旧版本配置、缺字段、枚举越界、超限区块都在这里收敛。
  const customization = readCustomization({
    customization: remote.customization as unknown as SiteCustomization,
  });
  const revision = typeof remote.revision === 'number' ? remote.revision : null;
  revisions.set(revision);
  try {
    write({ customization });
  } catch (error) {
    logger.warn('远端设计写回本地缓存失败。', error);
    return { status: 'unavailable', revision, customization: null };
  }
  return { status: 'applied', revision, customization };
}

/* ------------------------------------------------------------------ *
 * 编辑之后的写回
 * ------------------------------------------------------------------ */

export interface SyncEventHost {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface SyncVisibilityHost extends SyncEventHost {
  readonly visibilityState?: string;
}

export interface CustomizationSaveOptions {
  /** 读取当前本地配置；保存时从里面取**原始** customization。 */
  read: () => WebConfig | null;
  api: CustomizationApi;
  siteId: string;
  /** 与 `hydrateCustomization` 共享的版本号单元。 */
  revisions?: RevisionStore;
  /** 尾随防抖窗口，默认 800ms。 */
  delay?: number;
  logger?: CustomizationSyncLogger;
  /** 页面退出兜底；默认 `window`，测试可注入假对象或 null。 */
  window?: SyncEventHost | null;
  /** 标签页可见性兜底；默认 `document`。 */
  document?: SyncVisibilityHost | null;
}

export interface CustomizationSaveHandle {
  /** 请求一次保存：连续调用会被合并成一次 PUT。 */
  (): void;
  /** 立即发送（页面隐藏 / 卸载时的兜底）。 */
  flush(): Promise<void>;
  /** 拆掉定时器与事件监听；之后不再发送。 */
  dispose(): void;
  /** 是否还有等待中的保存。 */
  pending(): boolean;
  /** 当前记录的版本号。 */
  revision(): number | null;
}

/**
 * 编辑之后把设计写回远端。
 *
 * 写的是 `config.customization` 的**原始对象**，不是 `readCustomization` 的结果：
 * 归一化会补默认值、截断字符串、丢弃未知字段，用它回写等于悄悄改用户的设计。
 *
 * 返回的句柄可以直接当函数调用（触发防抖保存），另外带 flush / dispose 等控制方法。
 */
export function scheduleCustomizationSave(
  options: CustomizationSaveOptions,
): CustomizationSaveHandle {
  const revisions = options.revisions ?? createRevisionStore();
  const delay = Math.max(0, options.delay ?? SAVE_DEBOUNCE_MS);
  const logger = options.logger ?? consoleSyncLogger;
  const host =
    options.window === undefined ? (typeof window !== 'undefined' ? window : null) : options.window;
  const doc =
    options.document === undefined
      ? typeof document !== 'undefined'
        ? document
        : null
      : options.document;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let queued = false;
  let disposed = false;
  /** 403 / 422 之后不再重试：再试也是同样的结果，只会刷日志。 */
  let blocked = false;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  /** 取原始设计：空对象也算有效内容（用户可能清空了所有字段）。 */
  const readRaw = (): Record<string, unknown> | null => {
    const config = options.read();
    const customization = config?.customization;
    if (!isPlainObject(customization)) return null;
    // 服务端会拒绝含高危构造的自定义 CSS。旧配置或手改过的本地缓存可能还带着它：
    // 写回前先用读入时的同一套规则剔掉，免得整份设计反复保存失败、一直停在旧版本。
    // 干净的样式原样透传（连对象身份都不变），其余字段仍然按原始对象写回。
    const customCss = sanitizeCustomCss((customization as { custom_css?: unknown }).custom_css);
    if (customCss === (customization as { custom_css?: unknown }).custom_css) return customization;
    return { ...customization, custom_css: customCss };
  };

  const blockedReason = (status: number) =>
    status === 403
      ? '当前账户没有管理这个站点，站点设计只保存在本地。'
      : status === 400 || status === 422
        ? '站点设计没有通过服务端校验（只接受 JSON 对象，且不超过 1 MiB），已停止自动保存。'
        : '站点设计保存被服务端拒绝，已停止自动保存。';

  /** 409：别人先写了一步。取回服务端当前版本再试一次，仍冲突就保留本地。 */
  const retryAfterConflict = async (raw: Record<string, unknown>): Promise<void> => {
    let nextRevision: number | null = null;
    try {
      const remote = await options.api.siteCustomization(options.siteId);
      nextRevision = remote && typeof remote.revision === 'number' ? remote.revision : null;
    } catch (error) {
      const status = statusOfError(error);
      if (status === 400 || status === 403 || status === 422) {
        blocked = true;
        logger.warn(blockedReason(status), status);
        return;
      }
      logger.warn('设计版本冲突后无法读取服务端版本，保留本地设计。', error);
      return;
    }
    revisions.set(nextRevision);
    try {
      const saved = await options.api.saveSiteCustomization(
        options.siteId,
        raw,
        nextRevision ?? undefined,
      );
      if (typeof saved?.revision === 'number') revisions.set(saved.revision);
    } catch (error) {
      const status = statusOfError(error);
      if (status === 409) {
        logger.warn('站点设计再次冲突，保留本地版本，等待下一次编辑。');
        return;
      }
      if (status === 400 || status === 403 || status === 422) {
        blocked = true;
        logger.warn(blockedReason(status), status);
        return;
      }
      logger.warn('站点设计保存失败，稍后重试。', error);
    }
  };

  const send = async (): Promise<void> => {
    if (disposed || blocked) return;
    const raw = readRaw();
    if (!raw) return;
    try {
      const saved = await options.api.saveSiteCustomization(
        options.siteId,
        raw,
        revisions.get() ?? undefined,
      );
      if (typeof saved?.revision === 'number') revisions.set(saved.revision);
    } catch (error) {
      const status = statusOfError(error);
      if (status === 409) {
        await retryAfterConflict(raw);
        return;
      }
      if (status === 400 || status === 403 || status === 422) {
        blocked = true;
        logger.warn(blockedReason(status), status);
        return;
      }
      // 断网 / 5xx：本地缓存就是答案，下次编辑再试。
      logger.warn('站点设计保存失败，稍后重试。', error);
    }
  };

  const run = () => {
    if (disposed || blocked) return;
    if (inFlight) {
      // 上一笔还没回来：结束后再用最新的本地内容发一次，避免丢改动。
      queued = true;
      return;
    }
    inFlight = send().finally(() => {
      inFlight = null;
      if (queued && !disposed && !blocked) {
        queued = false;
        run();
      }
    });
  };

  const schedule = () => {
    if (disposed || blocked) return;
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      run();
    }, delay);
  };

  const flush = async (): Promise<void> => {
    if (disposed) return;
    const pending = timer !== null;
    clearTimer();
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        /* send 自己吞掉错误；这里只等它结束 */
      }
    }
    if (pending && !disposed && !blocked) await send();
  };

  const onPageHide = () => {
    void flush();
  };
  const onVisibilityChange = () => {
    if (doc && doc.visibilityState === 'hidden') void flush();
  };
  host?.addEventListener('pagehide', onPageHide);
  doc?.addEventListener('visibilitychange', onVisibilityChange);

  const dispose = () => {
    disposed = true;
    clearTimer();
    queued = false;
    host?.removeEventListener('pagehide', onPageHide);
    doc?.removeEventListener('visibilitychange', onVisibilityChange);
  };

  return Object.assign(schedule, {
    flush,
    dispose,
    pending: () => timer !== null,
    revision: () => revisions.get(),
  });
}
