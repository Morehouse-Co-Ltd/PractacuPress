import { useCallback } from 'react';
import type { WebConfig } from '../types';
import { useT } from './i18n';
import { useAuth } from './session';
import { flushSiteConfigSave } from './siteConfigSync';
import { useToast } from './toast';

/**
 * 保存站点级配置并等待服务端确认。
 *
 * 页面上的「保存修改」不能再只是 `updateConfig`：那样只改了本机 `localStorage`，
 * 提示「已保存」却可能一个访客都没拿到。这里先写入本地（界面立即更新），再把整份
 * 配置 PUT 到服务端；只有服务端接受才返回 true，页面据此决定是否提示成功。
 *
 * 演示模式没有服务端（App 不会为演示安装建立同步），设置本来就只有本机一份，
 * 因此按成功处理。
 */
export function useSaveSiteConfig(): (patch: Partial<WebConfig>) => Promise<boolean> {
  const { config, updateConfig } = useAuth();
  const toast = useToast();
  const t = useT();
  const demo = config.mode === 'demo';

  return useCallback(
    async (patch: Partial<WebConfig>) => {
      updateConfig(patch);
      if (demo) return true;
      try {
        await flushSiteConfigSave();
        return true;
      } catch (error) {
        // 401 / 409 重试失败 / 网络失败都会走到这里。本地已更新，提示必须诚实说明
        // 服务端没有接受，并告诉站长刷新会回到服务端版本。
        toast.push(
          'error',
          t('设置没有保存到服务端'),
          error instanceof Error && error.message
            ? t('本机已更新，但服务端拒绝或暂时不可用（{reason}）。刷新页面会回到服务端保存的版本。', {
                reason: error.message,
              })
            : t('本机已更新，但服务端拒绝或暂时不可用。刷新页面会回到服务端保存的版本。'),
        );
        return false;
      }
    },
    [demo, updateConfig, toast, t],
  );
}
