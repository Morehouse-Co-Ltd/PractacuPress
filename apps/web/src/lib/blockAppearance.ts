import type { CSSProperties } from 'react';
import type {
  BlockAppearance,
  BlockCrop,
  BlockRadius,
  BlockShadow,
} from '../types';
import { t } from './i18n';
import { liveCatalog } from './i18n/live';

/**
 * 组件通用外观（圆角 / 阴影 / 裁剪 / 背景 / 内边距 / 描边）。
 *
 * 这里只做三件事：
 * 1. 给出可选项目录（中文原文作键，`liveCatalog` 让它在切换语言时实时翻译）；
 * 2. 把不可信的持久化值收敛成白名单枚举或受限标量；
 * 3. 把收敛后的外观映射成最外层区块的内联样式。
 *
 * 之所以不生成 `<style>`：区块样式只作用于自己，写入配置可导入导出，
 * 也不会出现「一个区块的 CSS 泄漏到全站」的经典事故。
 */

const RAW_RADIUS_OPTIONS: { value: BlockRadius; label: string }[] = [
  { value: 'none', label: t('直角（0）') },
  { value: 'sm', label: t('小圆角（8px）') },
  { value: 'md', label: t('中圆角（12px）') },
  { value: 'lg', label: t('大圆角（16px）') },
  { value: 'xl', label: t('超大圆角（24px）') },
  { value: 'full', label: t('胶囊（999px）') },
];

const RAW_SHADOW_OPTIONS: { value: BlockShadow; label: string }[] = [
  { value: 'none', label: t('无阴影') },
  { value: 'sm', label: t('轻阴影') },
  { value: 'md', label: t('常规阴影') },
  { value: 'lg', label: t('大阴影') },
  { value: 'glow', label: t('强调光晕') },
];

const RAW_CROP_OPTIONS: { value: BlockCrop; label: string }[] = [
  { value: 'none', label: t('不裁剪') },
  { value: 'clip', label: t('裁剪溢出内容') },
  { value: '16:9', label: t('16:9 相框') },
  { value: '4:3', label: t('4:3 相框') },
  { value: '3:2', label: t('3:2 相框') },
  { value: '1:1', label: t('1:1 相框') },
  { value: '2:1', label: t('2:1 相框') },
];

/** 选项目录在读取时翻译，切换语言后属性面板立即跟着变。 */
export const BLOCK_RADIUS_OPTIONS = liveCatalog(RAW_RADIUS_OPTIONS);
export const BLOCK_SHADOW_OPTIONS = liveCatalog(RAW_SHADOW_OPTIONS);
export const BLOCK_CROP_OPTIONS = liveCatalog(RAW_CROP_OPTIONS);

/**
 * 内边距滑块/数字框的范围；对外暴露，检查器与归一化共用同一份。
 *
 * 上限 96 与 `SPACING_SCALE` 的最大值对齐（P1 §5.1）：外观内边距与栏距 / 留白
 * 走同一个标尺，站长不必记两套上限。语义仍是 px。
 */
export const BLOCK_PADDING_RANGE = { min: 0, max: 96, step: 4 } as const;

/** 色板默认值：`<input type="color">` 必须有一个合法值。 */
export const BLOCK_BACKGROUND_FALLBACK = '#ffffff';

const RADIUS_PX: Record<Exclude<BlockRadius, 'none'>, string> = {
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '24px',
  full: '999px',
};

/**
 * 阴影用 `var(--ink)` / `var(--accent)` 调透明度：同一份配置在纸白与夜航
 * 两套主题、明暗两种模式下都成立，不需要为暗色另写一套。
 */
const SHADOW_CSS: Record<Exclude<BlockShadow, 'none'>, string> = {
  sm: '0 1px 2px color-mix(in srgb, var(--ink) 6%, transparent), 0 2px 8px color-mix(in srgb, var(--ink) 5%, transparent)',
  md: '0 4px 16px color-mix(in srgb, var(--ink) 8%, transparent), 0 1px 3px color-mix(in srgb, var(--ink) 6%, transparent)',
  lg: '0 18px 48px color-mix(in srgb, var(--ink) 14%, transparent), 0 4px 12px color-mix(in srgb, var(--ink) 8%, transparent)',
  glow: '0 0 0 1px color-mix(in srgb, var(--accent) 28%, transparent), 0 18px 44px color-mix(in srgb, var(--accent) 26%, transparent)',
};

/** 比例裁剪的 aspect-ratio 值；`clip` 不设比例，只裁溢出。 */
const CROP_RATIO: Partial<Record<BlockCrop, string>> = {
  '16:9': '16 / 9',
  '4:3': '4 / 3',
  '3:2': '3 / 2',
  '1:1': '1 / 1',
  '2:1': '2 / 1',
};

const RADIUS_SET = new Set<string>(BLOCK_RADIUS_OPTIONS.map((option) => option.value));
const SHADOW_SET = new Set<string>(BLOCK_SHADOW_OPTIONS.map((option) => option.value));
const CROP_SET = new Set<string>(BLOCK_CROP_OPTIONS.map((option) => option.value));

/** 只接受十六进制颜色：`#rgb`、`#rrggbb`、`#rrggbbaa`。 */
const BACKGROUND = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

function pickRadius(value: unknown): BlockRadius | undefined {
  return typeof value === 'string' && RADIUS_SET.has(value) ? (value as BlockRadius) : undefined;
}

function pickShadow(value: unknown): BlockShadow | undefined {
  return typeof value === 'string' && SHADOW_SET.has(value) ? (value as BlockShadow) : undefined;
}

function pickCrop(value: unknown): BlockCrop | undefined {
  return typeof value === 'string' && CROP_SET.has(value) ? (value as BlockCrop) : undefined;
}

function pickBackground(value: unknown): string | undefined {
  return typeof value === 'string' && BACKGROUND.test(value) ? value.toLowerCase() : undefined;
}

function pickPadding(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const next = Math.min(BLOCK_PADDING_RANGE.max, Math.max(BLOCK_PADDING_RANGE.min, Math.round(value)));
  // 0 与「没设置」等价，不写进配置，避免每份配置都多一个空字段。
  return next > 0 ? next : undefined;
}

/**
 * 把不可信输入（旧配置、导入文件、手改 localStorage）收敛成合法外观。
 *
 * 未知枚举、坏色值、越界数值一律丢弃，不抛错——页面编排的兼容性原则是
 * 「能显示就显示，坏字段当作没设置」，绝不能因为一个字段让整页白屏。
 */
export function normalizeBlockAppearance(value: unknown): BlockAppearance | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const appearance: BlockAppearance = {};
  const radius = pickRadius(raw.radius);
  if (radius) appearance.radius = radius;
  const shadow = pickShadow(raw.shadow);
  if (shadow) appearance.shadow = shadow;
  const crop = pickCrop(raw.crop);
  if (crop) appearance.crop = crop;
  const background = pickBackground(raw.background);
  if (background) appearance.background = background;
  const padding = pickPadding(raw.padding);
  if (padding !== undefined) appearance.padding = padding;
  if (raw.border === true) appearance.border = true;
  return Object.keys(appearance).length ? appearance : undefined;
}

/** 是否设置了任何会改变观感的外观值（`none` 档位不算）。 */
export function hasBlockAppearance(appearance: BlockAppearance | undefined): boolean {
  if (!appearance) return false;
  return Boolean(
    (appearance.radius && appearance.radius !== 'none') ||
      (appearance.shadow && appearance.shadow !== 'none') ||
      (appearance.crop && appearance.crop !== 'none') ||
      appearance.background ||
      appearance.padding ||
      appearance.border,
  );
}

/**
 * 外观 → 内联样式。
 *
 * 调用方必须把它放在 `custom_css` 之前展开：站长手写的声明永远是最后一层，
 * 这样既保留「高级用户可以覆盖预设」的出口，也不会让面板看起来失灵。
 */
export function blockAppearanceCss(appearance: BlockAppearance | undefined): CSSProperties {
  if (!appearance) return {};
  const style: CSSProperties = {};
  if (appearance.radius && appearance.radius !== 'none') {
    style.borderRadius = RADIUS_PX[appearance.radius];
  }
  if (appearance.shadow && appearance.shadow !== 'none') {
    style.boxShadow = SHADOW_CSS[appearance.shadow];
  }
  if (appearance.crop && appearance.crop !== 'none') {
    // 裁剪必须先裁掉溢出，否则圆角只作用在空盒子边缘，图片会盖住圆角。
    style.overflow = 'hidden';
    const ratio = CROP_RATIO[appearance.crop];
    if (ratio) style.aspectRatio = ratio;
  }
  if (appearance.background) style.backgroundColor = appearance.background;
  if (appearance.padding) style.padding = `${appearance.padding}px`;
  if (appearance.border) style.border = '1px solid var(--line)';
  return style;
}
