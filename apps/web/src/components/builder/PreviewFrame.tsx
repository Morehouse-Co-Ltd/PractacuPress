import { useEffect, useRef, useState } from 'react';
import { useT } from '../../lib/i18n';
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
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onSelect, onLocate]);

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
          onLoad={() => {
            if (!selectedId) return;
            frameRef.current?.contentWindow?.postMessage(
              { type: 'pp:preview-focus', blockId: selectedId },
              origin,
            );
          }}
        />
      </div>
      <p className="builder-preview-hint">
        {t(
          '预览就是真实前台：单击可以直接点链接、按按钮；只有双击组件才会聚焦它，并把右侧属性面板打开。',
        )}
      </p>
    </div>
  );
}
