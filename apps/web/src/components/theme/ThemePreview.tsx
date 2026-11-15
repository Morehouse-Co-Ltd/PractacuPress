import type { CSSProperties } from 'react';
import type { SiteTheme, ThemePreviewBlock } from '../../types';
import { resolveThemePreview } from '../../lib/themePreview';

/**
 * 主题预览画面。
 *
 * 主题可以在 `theme.json` 里写 `preview`（品牌、导航、标题、内容块与配色覆盖），
 * 这里把它画成一张迷你页面；没写时按版式给一张结构预览。所有文字都作为
 * React 文本节点渲染，主题数据里不存在 HTML 注入面。
 */

/** 强调色底上的按钮文字：只处理十六进制；其它写法回退白字。 */
function readableInk(color: string): string {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return '#ffffff';
  const raw =
    match[1].length === 3
      ? match[1]
          .split('')
          .map((item) => item + item)
          .join('')
      : match[1];
  const channel = (offset: number) => parseInt(raw.slice(offset, offset + 2), 16) / 255;
  const linear = (value: number) =>
    value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  const luminance =
    0.2126 * linear(channel(0)) + 0.7152 * linear(channel(2)) + 0.0722 * linear(channel(4));
  return luminance > 0.55 ? '#151515' : '#ffffff';
}

function BlockView({ block, accent }: { block: ThemePreviewBlock; accent: string }) {
  const weight = block.weight ?? 1;
  const grow = { flexGrow: weight } as CSSProperties;
  const className = `theme-preview-block is-${block.type}`;

  if (block.type === 'media') {
    return <span className={`${className} theme-preview-media`} style={grow} aria-hidden />;
  }
  if (block.type === 'grid') {
    return (
      <span className={`${className} theme-preview-grid`} style={grow} aria-hidden>
        <i />
        <i />
        <i />
        <i />
      </span>
    );
  }
  if (block.type === 'divider') {
    return <span className={`${className} theme-preview-divider`} aria-hidden />;
  }
  if (block.type === 'button') {
    return (
      <span className={`${className} theme-preview-button`}>
        <span style={{ background: accent, color: readableInk(accent) }}>{block.text || ''}</span>
      </span>
    );
  }
  if (block.type === 'quote') {
    return (
      <span className={`${className} theme-preview-quote`} style={{ borderLeftColor: accent }}>
        {block.text ? (
          block.text
        ) : (
          <>
            <i />
            <i />
          </>
        )}
      </span>
    );
  }
  if (block.type === 'heading') {
    return (
      <span className={`${className} theme-preview-block-heading`}>
        {block.text || <i style={{ background: accent }} />}
      </span>
    );
  }
  return (
    <span className={`${className} theme-preview-text is-w${weight}`}>
      {block.text ? (
        block.text
      ) : (
        <>
          <i />
          <i />
          <i />
        </>
      )}
    </span>
  );
}

export function ThemePreview({
  bundle,
  large = false,
  className = '',
}: {
  bundle: SiteTheme;
  large?: boolean;
  className?: string;
}) {
  const { spec, authored, palette } = resolveThemePreview(bundle);
  const style = {
    background: palette.background,
    color: palette.ink,
    '--pp-preview-accent': palette.accent,
  } as CSSProperties;
  const nav = spec.nav ?? [];
  const blocks = spec.blocks ?? [];

  return (
    <span
      className={`theme-bundle-preview is-${bundle.variant}${large ? ' is-large' : ''}${
        authored ? ' is-authored' : ''
      }${className ? ` ${className}` : ''}`}
      style={style}
      aria-hidden
    >
      <span className="theme-preview-page">
        <span className="theme-preview-top">
          <span className="theme-preview-brand">{spec.brand || bundle.name}</span>
          <span className="theme-preview-nav">
            {nav.length
              ? nav.map((label, index) => (
                  <span key={`${index}-${label}`} className={index === 0 ? 'is-active' : ''}>
                    {label}
                  </span>
                ))
              : [0, 1, 2].map((index) => <i key={index} />)}
          </span>
        </span>

        <span className="theme-preview-hero">
          {spec.kicker ? <span className="theme-preview-kicker">{spec.kicker}</span> : null}
          {spec.title ? (
            <span className="theme-preview-headline">{spec.title}</span>
          ) : (
            <span className="theme-preview-headline is-placeholder" />
          )}
          {spec.subtitle ? <span className="theme-preview-subtitle">{spec.subtitle}</span> : null}
        </span>

        <span className="theme-preview-blocks">
          {blocks.map((block, index) => (
            <BlockView key={`${index}-${block.type}`} block={block} accent={palette.accent} />
          ))}
        </span>
      </span>
    </span>
  );
}
