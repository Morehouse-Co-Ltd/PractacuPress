import type {
  LayoutVariant,
  SiteTheme,
  ThemePreviewBlock,
  ThemePreviewBlockType,
  ThemePreviewSpec,
} from '../types';
import { DEFAULT_THEME } from './theme';

/**
 * 主题自带预览：归一化与兜底。
 *
 * 预览是主题作者在 `theme.json` 里写的一小段声明式数据，渲染成「选择主题」页里的
 * 迷你页面。它不接收 HTML / CSS / 脚本，只接收短文本、块类型与十六进制颜色，
 * 因此导入任何主题都不会把标记注入后台。字段说明见 `docs/themes/06-preview.md`。
 */

export const THEME_PREVIEW_LIMITS = {
  brand: 28,
  navItems: 5,
  navLabel: 10,
  kicker: 40,
  title: 60,
  subtitle: 120,
  blocks: 12,
  blockText: 80,
} as const;

const BLOCK_TYPES: ThemePreviewBlockType[] = [
  'heading',
  'text',
  'media',
  'quote',
  'button',
  'grid',
  'divider',
];

const BLOCK_TYPE_SET = new Set<string>(BLOCK_TYPES);

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function color(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return HEX_COLOR.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

function normalizeBlock(value: unknown): ThemePreviewBlock | null {
  const raw = object(value);
  if (!raw) return null;
  const type = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : '';
  if (!BLOCK_TYPE_SET.has(type)) return null;
  const block: ThemePreviewBlock = { type: type as ThemePreviewBlockType };
  // media / grid / divider 是纯图形块，不接收文字。
  if (type !== 'media' && type !== 'grid' && type !== 'divider') {
    const label = text(raw.text, THEME_PREVIEW_LIMITS.blockText);
    if (label) block.text = label;
  }
  const weight = Number(raw.weight);
  if (Number.isFinite(weight)) {
    block.weight = Math.min(3, Math.max(1, Math.round(weight)));
  }
  return block;
}

/**
 * 把主题文件里的 `preview` 收敛成合法结构。
 *
 * 返回 undefined 表示这套主题没有自带预览（渲染器回退到按版式生成的通用预览）；
 * 非法字段逐项丢弃，不因为一段坏预览就拒绝整份主题。
 */
export function normalizeThemePreview(value: unknown): ThemePreviewSpec | undefined {
  const raw = object(value);
  if (!raw) return undefined;
  const spec: ThemePreviewSpec = {};

  const brand = text(raw.brand, THEME_PREVIEW_LIMITS.brand);
  if (brand) spec.brand = brand;

  if (Array.isArray(raw.nav)) {
    const nav: string[] = [];
    for (const item of raw.nav) {
      const label = text(item, THEME_PREVIEW_LIMITS.navLabel);
      if (!label) continue;
      nav.push(label);
      if (nav.length >= THEME_PREVIEW_LIMITS.navItems) break;
    }
    if (nav.length) spec.nav = nav;
  }

  const kicker = text(raw.kicker, THEME_PREVIEW_LIMITS.kicker);
  if (kicker) spec.kicker = kicker;
  const title = text(raw.title, THEME_PREVIEW_LIMITS.title);
  if (title) spec.title = title;
  const subtitle = text(raw.subtitle, THEME_PREVIEW_LIMITS.subtitle);
  if (subtitle) spec.subtitle = subtitle;

  if (Array.isArray(raw.blocks)) {
    const blocks: ThemePreviewBlock[] = [];
    for (const item of raw.blocks) {
      const block = normalizeBlock(item);
      if (!block) continue;
      blocks.push(block);
      if (blocks.length >= THEME_PREVIEW_LIMITS.blocks) break;
    }
    if (blocks.length) spec.blocks = blocks;
  }

  const rawPalette = object(raw.palette);
  if (rawPalette) {
    const palette: NonNullable<ThemePreviewSpec['palette']> = {};
    const background = color(rawPalette.background);
    if (background) palette.background = background;
    const ink = color(rawPalette.ink);
    if (ink) palette.ink = ink;
    const accent = color(rawPalette.accent);
    if (accent) palette.accent = accent;
    if (Object.keys(palette).length) spec.palette = palette;
  }

  return Object.keys(spec).length ? spec : undefined;
}

/** 复制一份预览，避免把主题库里的引用写回配置。 */
export function cloneThemePreview(spec: ThemePreviewSpec): ThemePreviewSpec {
  return {
    ...spec,
    ...(spec.nav ? { nav: [...spec.nav] } : {}),
    ...(spec.blocks ? { blocks: spec.blocks.map((block) => ({ ...block })) } : {}),
    ...(spec.palette ? { palette: { ...spec.palette } } : {}),
  };
}

/** 没有自带预览时，按版式给一张结构预览（不含文案）。 */
export function defaultThemePreview(variant: LayoutVariant): ThemePreviewSpec {
  if (variant === 'bento') {
    return {
      blocks: [
        { type: 'grid', weight: 2 },
        { type: 'text' },
        { type: 'text', weight: 2 },
      ],
    };
  }
  if (variant === 'daylight') {
    return {
      blocks: [
        { type: 'grid' },
        { type: 'text' },
      ],
    };
  }
  return {
    blocks: [
      { type: 'media', weight: 2 },
      { type: 'text' },
      { type: 'text' },
    ],
  };
}

export interface ResolvedThemePreview {
  /** 最终用于渲染的预览；有自带预览时就是它。 */
  spec: ThemePreviewSpec;
  /** 这套预览是否来自主题作者，而不是版式兜底。 */
  authored: boolean;
  /** 预览实际使用的三种颜色：自带覆盖优先，否则取主题令牌。 */
  palette: { background: string; ink: string; accent: string };
}

export function resolveThemePreview(bundle: SiteTheme): ResolvedThemePreview {
  // 空白主题没有令牌/版式：预览按默认主题与单栏兜底。这里不 import themes.ts，
  // 否则会与 themes.ts 对本模块的依赖形成循环。
  const settings = bundle.theme ?? DEFAULT_THEME;
  const variant = bundle.variant ?? 'classic';
  const authored = !!bundle.preview;
  const fallback = defaultThemePreview(variant);
  // 主题只写了标题 / 配色时，内容块仍然按版式补全，避免封面下半截空着。
  const spec: ThemePreviewSpec = bundle.preview
    ? {
        ...bundle.preview,
        ...(bundle.preview.blocks?.length ? {} : { blocks: fallback.blocks }),
      }
    : fallback;
  return {
    spec,
    authored,
    palette: {
      background: spec.palette?.background ?? settings.background,
      ink: spec.palette?.ink ?? settings.ink,
      accent: spec.palette?.accent ?? settings.accent,
    },
  };
}
