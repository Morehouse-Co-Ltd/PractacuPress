import type { CSSProperties } from 'react';
import type { LoadingPalette } from '../lib/loading';
import type { LoadingPreset, LoadingSettings } from '../types';

/** 只负责图形与文案，供全屏加载层和后台预览共用。 */
export function LoadingMark({ preset }: { preset: LoadingPreset }) {
  return (
    <div className={`pp-loading-mark pp-loading-${preset}`} aria-hidden>
      {preset === 'dots' || preset === 'orbit' ? (
        <>
          <i />
          <i />
          <i />
        </>
      ) : (
        <span />
      )}
    </div>
  );
}

export function LoadingScene({
  settings,
  palette,
  className,
  style,
}: {
  settings: LoadingSettings;
  palette: LoadingPalette;
  className?: string;
  style?: CSSProperties;
}) {
  const variables = {
    '--pp-loading-size': `${settings.size}px`,
    '--pp-loading-accent': palette.accent,
    '--pp-loading-bg': palette.background,
    '--pp-loading-ink': palette.ink,
    ...style,
  } as CSSProperties;

  return (
    <div className={`pp-loading-scene${className ? ` ${className}` : ''}`} style={variables}>
      <LoadingMark preset={settings.preset} />
      {settings.text.trim() ? <p className="pp-loading-text">{settings.text}</p> : null}
    </div>
  );
}
