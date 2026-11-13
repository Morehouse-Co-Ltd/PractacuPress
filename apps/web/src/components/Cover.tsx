import type { CSSProperties } from 'react';
import { coverAlt, coverFrameStyle, coverImageStyle, useArticleCover, useCoverHidden } from '../lib/covers';

const PALETTES = [
  { bg: '#2f3a34', ink: '#efeee6', line: 'rgba(239,238,230,.16)' },
  { bg: '#3c3a34', ink: '#f0ede3', line: 'rgba(240,237,227,.16)' },
  { bg: '#403a3a', ink: '#f1eae6', line: 'rgba(241,234,230,.16)' },
  { bg: '#313843', ink: '#e9eef2', line: 'rgba(233,238,242,.16)' },
  { bg: '#3f3b45', ink: '#eeebf2', line: 'rgba(238,235,242,.16)' },
  { bg: '#3a3f3b', ink: '#e9efe9', line: 'rgba(233,239,233,.16)' },
];

function hash(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i += 1) {
    h = (h * 31 + input.charCodeAt(i)) % 1_000_003;
  }
  return h;
}

function mark(label: string): string {
  const chars = Array.from(label.replace(/\s+/g, ''));
  return chars[0] ?? '·';
}

export function Cover({
  seed,
  label,
  className,
  ratio = '16 / 9',
  accent = false,
  plain = false,
}: {
  seed: string;
  label: string;
  className?: string;
  ratio?: string;
  /** 跟随站点主色的封面（夜航用），避免占位色和主题打架。 */
  accent?: boolean;
  /** 只画底纹、不画文字：文章页把真实标题压在这层封面上时用，避免两层标题打架。 */
  plain?: boolean;
}) {
  const h = hash(seed);
  const palette = PALETTES[h % PALETTES.length];
  const variant = h % 3;
  const text = mark(label);
  const ink = accent ? 'currentColor' : palette.ink;
  const line = accent ? 'currentColor' : palette.line;

  return (
    <div
      className={`cover ${className ?? ''}`}
      data-cover={accent ? 'accent' : undefined}
      data-shape={variant}
      data-plain={plain ? 'true' : undefined}
      style={
        accent
          ? ({ aspectRatio: ratio, color: 'var(--ink)', '--cover-hue': h % 360 } as CSSProperties)
          : { background: palette.bg, aspectRatio: ratio }
      }
      aria-hidden="true"
    >
      <svg viewBox="0 0 480 300" preserveAspectRatio="xMidYMid slice" role="presentation">
        <g stroke={line} strokeWidth="1" opacity={accent ? 0.18 : 1}>
          {Array.from({ length: 9 }, (_, i) => (
            <line key={`v${i}`} x1={(i + 1) * 48} y1="0" x2={(i + 1) * 48} y2="300" />
          ))}
          {Array.from({ length: 6 }, (_, i) => (
            <line key={`h${i}`} x1="0" y1={(i + 1) * 44} x2="480" y2={(i + 1) * 44} />
          ))}
        </g>
        {variant === 0 ? (
          <>
            <circle cx="352" cy="96" r="62" fill="none" stroke={line} strokeWidth="1.5" />
            <circle cx="352" cy="96" r="44" fill={ink} opacity="0.1" />
            <path d="M40 240h400" stroke={line} strokeWidth="1" />
          </>
        ) : variant === 1 ? (
          <>
            <rect x="286" y="42" width="132" height="132" fill="none" stroke={line} strokeWidth="1.5" />
            <rect x="316" y="72" width="72" height="72" fill={ink} opacity="0.08" />
            <path d="M0 218 480 148" stroke={line} strokeWidth="1" />
          </>
        ) : (
          <>
            <path d="M250 0v300M480 60H0" stroke={line} strokeWidth="1" />
            <circle cx="120" cy="210" r="78" fill={ink} opacity="0.07" />
            <path d="M300 300 480 120" stroke={line} strokeWidth="1" />
          </>
        )}
        <text
          x="34"
          y="246"
          fill={ink}
          fontFamily="'Songti SC','Noto Serif SC',Georgia,serif"
          fontSize={74}
          letterSpacing="2"
          opacity="0.92"
        >
          {text}
        </text>
        <text
          x="36"
          y="272"
          fill={ink}
          fontFamily="'Segoe UI',system-ui,sans-serif"
          fontSize="9"
          letterSpacing="3"
          opacity="0.55"
        >
          PRACTACU PRESS
        </text>
      </svg>
    </div>
  );
}

/**
 * 内容封面：先查自定义封面配置，命中就用图片，否则回退到程序化封面。
 *
 * 把「查配置」收在这个组件里，卡片在 `map` 里也能安全渲染——每个实例自己调用
 * `useArticleCover`，不会在循环里调用 hook。比例与布局类名沿用调用方的约定。
 * 作者勾了「隐藏封面」时整块不渲染（返回 null），不回退程序化封面。
 */
export function ContentCover({
  id,
  label,
  className,
  ratio = '16 / 9',
  accent = false,
}: {
  /** 内容 id；为空（例如未保存的草稿）时直接用程序化封面。 */
  id: string | undefined;
  label: string;
  className?: string;
  ratio?: string;
  /** 跟随站点主色的程序化封面（夜航用）。 */
  accent?: boolean;
}) {
  const cover = useArticleCover(id);
  const hidden = useCoverHidden(id);
  if (hidden) return null;
  if (cover) {
    return (
      <div
        className={`cover cover-custom${className ? ` ${className}` : ''}`}
        style={coverFrameStyle(ratio)}
      >
        <img
          src={cover.url}
          alt={coverAlt(cover, label)}
          loading="lazy"
          style={coverImageStyle(cover)}
        />
      </div>
    );
  }
  return (
    <Cover seed={id || label || 'cover'} label={label} className={className} ratio={ratio} accent={accent} />
  );
}
