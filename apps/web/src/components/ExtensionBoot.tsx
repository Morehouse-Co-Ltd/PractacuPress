import { useEffect } from 'react';
import { isPreviewFrame } from '../lib/access';
import { defaultPluginRuntime } from '../lib/plugins/runtime';

/**
 * 前端扩展运行时的启动接线。
 *
 * `defaultPluginRuntime.start()` 会拉 `GET /api/v1/plugins` 并逐个激活已启用的扩展
 * （其中就包括注册后台页面的内置/导入扩展）。它此前全仓库无人调用，于是扩展永远
 * 不会真正加载；这里在 App 挂载时补上这一次调用。
 *
 * 三条约束：
 * - 只启动一次：模块级 WeakMap 记住每个运行时的启动 Promise，StrictMode 的二次
 *   effect 与重复挂载都不会重复拉清单；
 * - 编排预览 iframe 里跳过：预览只该看到编辑中的设计，不重复加载扩展；
 * - 失败只 console.warn：扩展是增强项，后端没实现 / 插件包坏了都不能影响前台。
 */

/** 只依赖 start()，测试可以注入一个假运行时。 */
export interface BootableRuntime {
  start(): Promise<void>;
}

const booted = new WeakMap<BootableRuntime, Promise<void>>();

/**
 * Starts a runtime at most once (per runtime instance).
 *
 * Returns `null` when inside a preview iframe; otherwise resolves after the boot
 * attempt settles, so callers can await it in tests.
 */
export function bootRuntimeOnce(
  runtime: BootableRuntime,
  options: { preview?: boolean } = {},
): Promise<void> | null {
  if (options.preview ?? isPreviewFrame()) return null;
  const existing = booted.get(runtime);
  if (existing) return existing;
  // Promise.resolve().then(...) keeps a synchronously-throwing start() from
  // escaping as an effect error.
  const pending = Promise.resolve()
    .then(() => runtime.start())
    .catch((error: unknown) => {
      console.warn('[pp plugin] boot failed', error);
      // Do not cache a failed attempt: the next mount (for example after the API
      // comes back) must be able to retry instead of staying broken until reload.
      booted.delete(runtime);
    });
  booted.set(runtime, pending);
  return pending;
}

/** Invisible mount point that boots the default plugin runtime once. */
export function ExtensionBoot({ runtime = defaultPluginRuntime }: { runtime?: BootableRuntime }) {
  useEffect(() => {
    void bootRuntimeOnce(runtime);
    // bootRuntimeOnce de-duplicates per runtime, so re-running this effect is safe.
  }, [runtime]);
  return null;
}
