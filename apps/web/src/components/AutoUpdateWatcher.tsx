import { useEffect, useRef } from 'react';
import type { SiteUpdateSettings } from '../types';
import { APP_VERSION } from '../lib/appVersion';
import { shouldAnnounce } from '../lib/hotUpdate';
import { useT } from '../lib/i18n';
import { useAuth } from '../lib/session';
import { evaluateUpdate, readUpdateSettings, updateIntervalMs, versionLabel } from '../lib/siteUpdate';
import { useOptionalToast } from '../lib/toast';
import { checkForUpdate } from '../lib/updateClient';

/**
 * 自动更新的后台检查器。
 *
 * 只在管理后台里挂载：更新的受众是站点管理员，访客没有任何理由定时请求更新源。
 * 它做三件事，并且**只做这三件事**：
 *
 * 1. 按设置里的频率（每次启动 / 每天 / 每周）让服务端读一次版本清单；
 * 2. 发现新版本时提示一次，并记下远端版本，避免同一个版本反复打扰；
 * 3. 什么都不刷新、什么都不替换——自动更新承诺“不停机”，刷新或换版的时机永远
 *    由人决定（或者等将来服务端支持资源清单后再走 `applyHotUpdate`）。
 *
 * 标签页隐藏时不检查，回到前台时补一次；定时器与监听在卸载时清理。
 */

export function AutoUpdateWatcher() {
  const { config, updateConfig } = useAuth();
  const toast = useOptionalToast();
  const t = useT();

  const settings: SiteUpdateSettings = readUpdateSettings(config.update);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const updateConfigRef = useRef(updateConfig);
  updateConfigRef.current = updateConfig;
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const tRef = useRef(t);
  tRef.current = t;

  /** 每次打开后台最多提示一次“正在检查”；`startup` 频率靠它避免每个页面都查一次。 */
  const checkedRef = useRef(false);
  const runningRef = useRef(false);

  useEffect(() => {
    if (settings.mode !== 'auto') return;
    if (config.mode === 'demo') return;

    let cancelled = false;
    const interval = updateIntervalMs(settings.frequency);

    const run = async () => {
      if (cancelled || runningRef.current) return;
      const current = settingsRef.current;
      if (current.mode !== 'auto') return;
      // 每次启动只查一次；按天/按周的频率看上次检查时间，不到点不查。
      if (current.frequency === 'startup' && checkedRef.current) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      if (interval > 0 && current.last_checked_at) {
        const last = Date.parse(current.last_checked_at);
        if (Number.isFinite(last) && Date.now() - last < interval) return;
      }

      runningRef.current = true;
      try {
        const check = await checkForUpdate(current);
        if (cancelled) return;
        const verdict = evaluateUpdate({
          localVersion: APP_VERSION,
          remote: check.remote,
          channel: current.channel,
        });
        if (
          toastRef.current &&
          verdict.available &&
          shouldAnnounce(check, APP_VERSION, current.last_remote_version)
        ) {
          const label = versionLabel(check.remote.version);
          toastRef.current.push(
            'info',
            tRef.current('发现新版本 {version}', { version: label }),
            tRef.current('到「站点更新」页可以手动切换；后台只在旁边提示，不会打断你。'),
          );
        }
        updateConfigRef.current({
          update: readUpdateSettings({
            ...current,
            last_checked_at: check.checked_at,
            last_remote_version: check.remote.version,
          }),
        });
      } catch {
        // 自动检查失败保持安静：离线、被墙、GitHub 抽风都不该在后台弹错误。
      } finally {
        runningRef.current = false;
        checkedRef.current = true;
      }
    };

    void run();

    const timer = interval > 0 ? window.setInterval(() => void run(), interval) : null;
    const onVisible = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible') void run();
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      if (timer !== null) window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // 只在这些设置变化时重排定时器；检查时间戳的变化由 run() 自己判断。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.mode, settings.server_url, settings.channel, settings.frequency, config.mode]);

  return null;
}
