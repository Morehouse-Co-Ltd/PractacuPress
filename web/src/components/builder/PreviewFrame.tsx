import { useEffect, useRef, useState } from 'react';
import { useT } from '../../lib/i18n';
import { staysOnPreviewPage } from '../../lib/previewNav';
import type { BuilderDevice } from '../../types';
import { Button } from '../ui';

export type PreviewDevice = BuilderDevice;

const DEVICES: { key: PreviewDevice; width: string }[] = [
  { key: 'desktop', width: '100%' },
  { key: 'tablet', width: '768px' },
  { key: 'mobile', width: '390px' },
];

/**
 * 真实前台 iframe 预览。
 *
 * 编排器写配置后 iframe 通过 storage 事件更新自身；选中区块通过 postMessage
 * 让预览高亮，双击组件时再让预览平滑移动到它；预览里的点击/双击回传给编排器。
 *
 * 预览只显示正在编排的那一页：站内跳转由 `PreviewBridge` 拦下，程序化跳转由
 * `PreviewRouteLock` 退回，整页跳转（表单、脚本改 location）由这里的 load 兜底
 * 重新挂回 `url`。三处都会让编排器提示一次「不能跳转」。
 *
 * P1 §5.3 起这里不再有「不同设备分割」开关：设备差异写在区块的 `at` 覆盖层里，
 * 编辑器不应再生成三棵独立的树。旧文档里的 `device_split` 仍然能读、能渲染。
 */
export function PreviewFrame({
  url,
  selectedId,
  onSelect,
  onLocate,
  locate,
  animationPreview,
  device,
  onDeviceChange,
  onBlockedNavigation,
}: {
  url: string;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** 预览里双击组件时回传，交给编排器统一定位。 */
  onLocate?: (id: string) => void;
  /** 编排器请求预览平滑移动到某个区块。 */
  locate?: { blockId: string; nonce: number } | null;
  animationPreview?: { blockId: string; animation: string; nonce: number } | null;
  /** 受控设备；不传时组件自己维护（兼容旧调用）。 */
  device?: PreviewDevice;
  onDeviceChange?: (device: PreviewDevice) => void;
  /** 预览里有跳转被拦下时调用，由编排器决定怎么提示。 */
  onBlockedNavigation?: () => void;
}) {
  const t = useT();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [ownDevice, setOwnDevice] = useState<PreviewDevice>('desktop');
  const activeDevice = device ?? ownDevice;
  const chooseDevice = (next: PreviewDevice) => {
    if (onDeviceChange) onDeviceChange(next);
    else setOwnDevice(next);
  };
  const [nonce, setNonce] = useState(0);
  const width = DEVICES.find((item) => item.key === activeDevice)?.width ?? '100%';
  const deviceLabels: Record<PreviewDevice, string> = {
    desktop: t('桌面'),
    tablet: t('平板'),
    mobile: t('手机'),
  };
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  /** 上次把 iframe 拉回预览页的时间：防止和重新挂载互相触发。 */
  const resetGuardRef = useRef(0);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      const data = event.data as { type?: string; blockId?: string } | null;
      if (data?.type === 'pp:preview-select') {
        onSelect(data.blockId ?? null);
        return;
      }
      if (data?.type === 'pp:preview-locate-request' && data.blockId) {
        onLocate?.(data.blockId);
        return;
      }
      if (data?.type === 'pp:preview-nav-blocked') {
        onBlockedNavigation?.();
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onSelect, onLocate, onBlockedNavigation]);

  /**
   * 整页跳转的兜底。
   *
   * 表单原生提交、脚本改 `location`、外链都会让 iframe 整页加载，不经过预览桥
   * 的点击拦截与路由锁。加载完发现它已经不在正在编排的那一页，就重新挂回 `url`。
   */
  const keepOnPreviewPage = (): boolean => {
    const frame = frameRef.current;
    if (!frame) return false;
    let current = '';
    try {
      current = frame.contentWindow?.location.href ?? '';
    } catch {
      // 跨源：同源策略连地址都读不到，肯定已经不是预览页了。
      current = '';
    }
    // 初始 about:blank 文档不算一次跳转。
    if (current.startsWith('about:')) return true;
    if (current && staysOnPreviewPage(url, current, origin)) return true;
    const now = Date.now();
    if (now - resetGuardRef.current < 1000) return false;
    resetGuardRef.current = now;
    setNonce((value) => value + 1);
    onBlockedNavigation?.();
    return false;
  };

  const onFrameLoad = () => {
    if (!keepOnPreviewPage()) return;
    if (!selectedId) return;
    frameRef.current?.contentWindow?.postMessage(
      { type: 'pp:preview-focus', blockId: selectedId },
      origin,
    );
  };

  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage(
      { type: 'pp:preview-focus', blockId: selectedId ?? '' },
      origin,
    );
  }, [origin, selectedId, nonce]);

  useEffect(() => {
    if (!locate) return;
    frameRef.current?.contentWindow?.postMessage(
      { type: 'pp:preview-locate', blockId: locate.blockId },
      origin,
    );
  }, [locate, origin]);

  useEffect(() => {
    if (!animationPreview) return;
    frameRef.current?.contentWindow?.postMessage(
      {
        type: 'pp:preview-animation',
        blockId: animationPreview.blockId,
        animation: animationPreview.animation,
      },
      origin,
    );
  }, [animationPreview, origin]);

  return (
    <div className="builder-preview panel">
      <div className="builder-preview-toolbar">
        <div className="row gap-4" role="group" aria-label={t('预览宽度')}>
          {DEVICES.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`chip${activeDevice === item.key ? ' is-active' : ''}`}
              onClick={() => chooseDevice(item.key)}
              aria-pressed={activeDevice === item.key}
            >
              {deviceLabels[item.key]}
            </button>
          ))}
        </div>
        <div className="row gap-4">
          <Button variant="ghost" size="sm" icon="refresh" onClick={() => setNonce((value) => value + 1)}>
            {t('刷新')}
          </Button>
          <Button variant="ghost" size="sm" icon="external" onClick={() => window.open(url, '_blank', 'noopener')}>
            {t('新窗口')}
          </Button>
        </div>
      </div>
      <div className={`builder-preview-frame is-${activeDevice}`} data-active-device={activeDevice}>
        <iframe
          key={nonce}
          ref={frameRef}
          title={t('真实前台预览')}
          src={url}
          style={{ maxWidth: width }}
          onLoad={onFrameLoad}
        />
      </div>
      <p className="builder-preview-hint">
        {t(
          '预览只显示正在编排的这一页：点链接、按按钮都不会离开；双击组件才会聚焦它，并把右侧属性面板打开。',
        )}
      </p>
    </div>
  );
}
