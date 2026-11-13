import type { WebConfig } from '../types';
import type { SiteConfigSaved, SiteConfigScope, SiteConfigSnapshot } from './siteConfig';
import { buildSiteConfigDocument, readSiteConfig } from './siteConfig';
import {
  createRevisionStore,
  statusOfError,
  type RevisionStore,
  type SyncEventHost,
  type SyncVisibilityHost,
} from './customizationSync';

/**
 * 站点级配置的服务端同步。
 *
 * 与 `customizationSync` 同一套形状：localStorage 继续作为首屏缓存，服务端才是
 * 跨设备、跨访客的事实来源。区别在于这里保存的是**行为开关**（访问限制、加载动画、
 * 性能、域名白名单、后台入口），一份过期的本地副本会直接表现为「站长看到生效、
 * 访客拿到的还是默认值」——正是这次要修的问题。
 *
 * - `hydrateSiteConfig`：开屏拉一次；访客拿到公开子集，管理员拿到完整文档。
 * - `scheduleSiteConfigSave`：编辑之后尾随防抖写回，带 revision 做乐观并发。
 *
 * 模块不依赖 React：读、写、网络与定时器全部注入，方便单测。
 */

export const SITE_CONFIG_SAVE_DEBOUNCE_MS = 600;

export interface SiteConfigSyncLogger {
  warn(message: string, detail?: unknown): void;
}

export const consoleSiteConfigLogger: SiteConfigSyncLogger = {
  warn(message, detail) {
    if (typeof console === 'undefined') return;
    if (detail === undefined) console.warn(`[站点配置] ${message}`);
    else console.warn(`[站点配置] ${message}`, detail);
  },
};

/** 同步只用到这两个后端方法；测试里注入假实现。 */
export interface SiteConfigApi {
  siteConfig(siteId: string): Promise<SiteConfigSnapshot | null>;
  saveSiteConfig(siteId: string, config: unknown, revision?: number): Promise<SiteConfigSaved>;
}

export type SiteConfigHydrationStatus =
  /** 远端有配置，已归一化写回本地。 */
  | 'applied'
  /** 404：远端还没有配置，本地继续用；管理员下一次保存会建立远端副本。 */
  | 'absent'
  /** 401：站点仅成员可见且未登录。 */
  | 'unauthorized'
  /** 403：当前路径不是这个站点，或没有管理权限。 */
  | 'forbidden'
  /** 断网、5xx 或远端内容无法识别。 */
  | 'unavailable';

export interface SiteConfigHydrationResult {
  status: SiteConfigHydrationStatus;
  /** 远端版本号；`absent` 时为 null。 */
  revision: number | null;
  /** 实际收到的可见范围；没有应用远端内容时为 null。 */
  scope: SiteConfigScope | null;
}

export interface HydrateSiteConfigOptions {
  read: () => WebConfig | null;
  write: (patch: Partial<WebConfig>) => void;
  api: SiteConfigApi;
  siteId: string;
  revisions?: RevisionStore;
  logger?: SiteConfigSyncLogger;
}

/**
 * 拉取远端配置并写回本地缓存。
 *
 * 永远不抛错、永远不阻塞开屏：任何失败都只是「这次没能拿到远端配置」，本地缓存照常
 * 渲染。只有拿到可识别的对象时才覆盖本地。
 */
export async function hydrateSiteConfig(
  options: HydrateSiteConfigOptions,
): Promise<SiteConfigHydrationResult> {
  const { read, write, api, siteId } = options;
  const revisions = options.revisions ?? createRevisionStore();
  const logger = options.logger ?? consoleSiteConfigLogger;
  const local = read();
  if (!local) {
    return { status: 'unavailable', revision: revisions.get(), scope: null };
  }

  let remote: SiteConfigSnapshot | null;
  try {
    remote = await api.siteConfig(siteId);
  } catch (error) {
    const status = statusOfError(error);
    if (status === 401 || status === 403) {
      logger.warn('读取站点配置被拒绝，继续使用本地缓存。', status);
      return {
        status: status === 401 ? 'unauthorized' : 'forbidden',
        revision: revisions.get(),
        scope: null,
      };
    }
    logger.warn('读取站点配置失败，继续使用本地缓存。', error);
    return { status: 'unavailable', revision: revisions.get(), scope: null };
  }

  if (!remote) {
    return { status: 'absent', revision: null, scope: null };
  }

  if (!remote.config || typeof remote.config !== 'object' || Array.isArray(remote.config)) {
    revisions.set(typeof remote.revision === 'number' ? remote.revision : null);
    logger.warn('远端站点配置格式无法识别，保留本地缓存。');
    return { status: 'unavailable', revision: revisions.get(), scope: null };
  }

  const scope: SiteConfigScope = remote.scope === 'admin' ? 'admin' : 'public';
  const revision = typeof remote.revision === 'number' ? remote.revision : null;
  revisions.set(revision);
  try {
    write(readSiteConfig(remote.config, scope, local));
  } catch (error) {
    logger.warn('远端站点配置写回本地缓存失败。', error);
    return { status: 'unavailable', revision, scope };
  }
  return { status: 'applied', revision, scope };
}

/* ------------------------------------------------------------------ *
 * 编辑之后的写回
 * ------------------------------------------------------------------ */

export interface SiteConfigSaveOptions {
  /** 读取当前本地配置；保存时从里面构造完整文档。 */
  read: () => WebConfig | null;
  api: SiteConfigApi;
  siteId: string;
  revisions?: RevisionStore;
  delay?: number;
  logger?: SiteConfigSyncLogger;
  window?: SyncEventHost | null;
  document?: SyncVisibilityHost | null;
}

export interface SiteConfigSaveHandle {
  (): void;
  flush(): Promise<void>;
  /** 立刻把当前配置写回服务端，不管有没有排队的防抖写入。 */
  save(): Promise<void>;
  dispose(): void;
  pending(): boolean;
  revision(): number | null;
}

/**
 * 编辑之后把配置写回远端。
 *
 * 写的是 `buildSiteConfigDocument` 的结果（本地归一化之后的完整文档），与设计文档
 * 不同：这里每个字段都由前端写入、由服务端校验，没有「用户手写、原样保留」的内容。
 */
export function scheduleSiteConfigSave(options: SiteConfigSaveOptions): SiteConfigSaveHandle {
  const revisions = options.revisions ?? createRevisionStore();
  const delay = Math.max(0, options.delay ?? SITE_CONFIG_SAVE_DEBOUNCE_MS);
  const logger = options.logger ?? consoleSiteConfigLogger;
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
  /** 400 / 403 / 422 之后不再重试：再试也是同样的结果，只会刷日志。 */
  let blocked = false;
  /** 最近一次失败，供页面在保存后判断是否需要提示。 */
  let lastError: unknown = null;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const readDocument = (): Record<string, unknown> | null => {
    const config = options.read();
    if (!config) return null;
    return buildSiteConfigDocument(config) as Record<string, unknown>;
  };

  const blockedReason = (status: number) =>
    status === 403
      ? '当前账户没有管理这个站点，站点配置只保存在本地。'
      : status === 400 || status === 422
        ? '站点配置没有通过服务端校验，已停止自动保存。'
        : '站点配置保存被服务端拒绝，已停止自动保存。';

  const send = async (): Promise<void> => {
    if (disposed || blocked) return;
    const document = readDocument();
    if (!document) return;
    try {
      const saved = await options.api.saveSiteConfig(
        options.siteId,
        document,
        revisions.get() ?? undefined,
      );
      if (typeof saved?.revision === 'number') revisions.set(saved.revision);
      lastError = null;
    } catch (error) {
      const status = statusOfError(error);
      if (status === 409) {
        // 另一台设备先写了一步：取回当前版本再试一次，仍冲突就保留本地，等下一次编辑。
        let nextRevision: number | null = null;
        try {
          const remote = await options.api.siteConfig(options.siteId);
          nextRevision = remote && typeof remote.revision === 'number' ? remote.revision : null;
        } catch {
          lastError = error;
          logger.warn('站点配置版本冲突后无法读取服务端版本。', error);
          return;
        }
        revisions.set(nextRevision);
        try {
          const saved = await options.api.saveSiteConfig(
            options.siteId,
            readDocument() ?? document,
            nextRevision ?? undefined,
          );
          if (typeof saved?.revision === 'number') revisions.set(saved.revision);
          lastError = null;
        } catch (retryError) {
          lastError = retryError;
          const retryStatus = statusOfError(retryError);
          if (retryStatus === 400 || retryStatus === 403 || retryStatus === 422) {
            blocked = true;
            logger.warn(blockedReason(retryStatus), retryStatus);
            return;
          }
          logger.warn('站点配置再次冲突，等待下一次编辑。', retryError);
        }
        return;
      }
      lastError = error;
      if (status === 400 || status === 403 || status === 422) {
        blocked = true;
        logger.warn(blockedReason(status), status);
        return;
      }
      logger.warn('站点配置保存失败，稍后重试。', error);
    }
  };

  const run = () => {
    if (disposed || blocked) return;
    if (inFlight) {
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
        /* send 自己吞掉错误 */
      }
    }
    if (pending && !disposed && !blocked) await send();
    if (lastError && !disposed) {
      const error = lastError;
      lastError = null;
      throw error;
    }
  };

  /**
   * 无条件写一次。
   *
   * `flush` 只兑现已经排队的防抖写入；这里用于「远端还没有配置，把本机已有的设置
   * 整体搬上去」这种没有人触发过编辑的场合。失败同样抛错，调用方决定怎么提示。
   */
  const save = async (): Promise<void> => {
    if (disposed) return;
    clearTimer();
    if (inFlight) {
      try {
        await inFlight;
      } catch {
        /* 同上 */
      }
    }
    if (blocked) return;
    await send();
    if (lastError) {
      const error = lastError;
      lastError = null;
      throw error;
    }
  };

  const onPageHide = () => {
    void flush().catch(() => undefined);
  };
  const onVisibilityChange = () => {
    if (doc && doc.visibilityState === 'hidden') void flush().catch(() => undefined);
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
    save,
    dispose,
    pending: () => timer !== null,
    revision: () => revisions.get(),
  });
}

/* ------------------------------------------------------------------ *
 * 当前安装的保存句柄
 * ------------------------------------------------------------------ */

/**
 * 页面只知道「保存」，不需要知道 App 什么时候建好句柄。
 *
 * `useSaveSiteConfig` 的显式保存要等这次写入被服务端接受才提示成功，所以需要一个
 * 模块级入口找到当前安装的句柄；没有安装（访客 / 演示模式 / 还没水合完）时返回 null。
 */
let activeSaver: SiteConfigSaveHandle | null = null;

export function setActiveSiteConfigSaver(handle: SiteConfigSaveHandle | null): void {
  activeSaver = handle;
}

export function activeSiteConfigSaver(): SiteConfigSaveHandle | null {
  return activeSaver;
}

/** 立即把当前配置写回服务端；没有活动句柄时抛错，让页面提示「稍后重试」。 */
export async function flushSiteConfigSave(): Promise<void> {
  const saver = activeSaver;
  if (!saver) throw new Error('站点配置同步还没有就绪，请稍后重试');
  await saver.flush();
}
